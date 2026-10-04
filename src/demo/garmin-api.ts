/**
 * Garmin Connect API answered from the demo world: every read endpoint the
 * client uses (see packages/garmin-connect/tests/live/endpoints.ts), plus
 * workout writes, which only change in-memory state.
 *
 * Each route builds the fields that matter; `fill` adds the rest of the keys
 * Garmin's real responses have (as null), from the response schemas.
 */
import { responseSchemas } from "../../packages/garmin-connect/tests/schemas.ts";
import { fill } from "./fill.ts";
import {
  bodyBatteryValues,
  dayWindow,
  heartRateValues,
  respirationValues,
  sleepLevels,
  stressValues,
} from "./intraday.ts";
import { Rng, clamp, mean, round } from "./random.ts";
import { laps as runLaps, simulate, type LapStats, type Sample } from "./run.ts";
import {
  addDays,
  dayDiff,
  gmtIso,
  gmtSpace,
  localIso,
  localMs,
  localSpace,
  mondayOf,
  parseYmd,
  weekday,
} from "./time.ts";
import {
  PERSONA,
  getWorld,
  thresholdPace,
  type DemoDay,
  type DemoRun,
  type SavedWorkout,
  type World,
} from "./world.ts";

export interface DemoResponse {
  status: number;
  body?: unknown;
}

type Handler = (m: RegExpMatchArray, q: URLSearchParams, body: unknown) => unknown;

interface Route {
  method: string;
  path: RegExp;
  /** responseSchemas key used to shape the response */
  schema?: string | ((q: URLSearchParams) => string);
  handle: Handler;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ── State changed by writes (workouts) ────────────────

const created: SavedWorkout[] = [];
const deleted = new Set<number>();
const extraSchedule: { scheduleId: number; workoutId: number; date: string }[] = [];
let nextId = 1_184_900_000;

function workoutsOf(w: World): SavedWorkout[] {
  return [...w.workouts, ...created].filter((x) => !deleted.has(x.workoutId));
}

function scheduleOf(w: World) {
  return [...w.schedule, ...extraSchedule].filter((s) => !deleted.has(s.workoutId));
}

// ── Helpers ───────────────────────────────────────────

/** Garmin's "local" epoch: the local wall-clock time read as if it were UTC. */
const localEpoch = (ms: number) => ms - new Date(ms).getTimezoneOffset() * 60_000;

function datesBetween(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

function daysIn(w: World, start: string, end: string): DemoDay[] {
  return datesBetween(start, end)
    .map((d) => w.byDate.get(d))
    .filter((d): d is DemoDay => !!d);
}

/** Garmin answers 400 for sleep stats beyond 28 days. */
function maxRange(start: string, end: string, days = 28) {
  if (dayDiff(start, end) + 1 > days || dayDiff(start, end) < 0) {
    throw new HttpError(400, `Range ${start}..${end} exceeds ${days} days`);
  }
}

const OWNER = {
  ownerId: PERSONA.profileId,
  ownerDisplayName: PERSONA.displayName,
  ownerFullName: PERSONA.fullName,
  ownerProfileImageUrlSmall: null,
  ownerProfileImageUrlMedium: null,
  ownerProfileImageUrlLarge: null,
};

const RUNNING_TYPE = {
  typeId: 1,
  typeKey: "running",
  parentTypeId: 17,
  isHidden: false,
  restricted: false,
  trimmable: true,
};

const EVENT_TYPE = { typeId: 9, typeKey: "uncategorized", sortOrder: 10 };

const TE_MESSAGES: Record<string, string> = {
  RECOVERY: "RECOVERY_2",
  AEROBIC_BASE: "IMPROVING_AEROBIC_BASE_8",
  TEMPO: "IMPROVING_AEROBIC_ENDURANCE_10",
  LACTATE_THRESHOLD: "HIGHLY_IMPROVING_LACTATE_THRESHOLD_12",
  VO2MAX: "IMPROVING_VO2_MAX_15",
};

const anaerobicMessage = (te: number) =>
  te < 1
    ? "NO_ANAEROBIC_BENEFIT_0"
    : te < 2
      ? "SOME_ANAEROBIC_BENEFIT_3"
      : "IMPROVING_ANAEROBIC_CAPACITY_AND_ENDURANCE_7";

function runById(w: World, id: string): DemoRun {
  const run = w.runById.get(Number(id));
  if (!run) throw new HttpError(404, `No activity ${id}`);
  return run;
}

const memo = new Map<number, { samples: Sample[]; laps: LapStats[] }>();
function detailsOf(run: DemoRun) {
  let d = memo.get(run.plan.id);
  if (!d) {
    const samples = simulate(run.plan);
    d = { samples, laps: runLaps(run.plan, samples) };
    if (memo.size > 60) memo.delete(memo.keys().next().value!);
    memo.set(run.plan.id, d);
  }
  return d;
}

const toF = (c: number) => Math.round((c * 9) / 5 + 32);
const watchTemp = (run: DemoRun) => Math.round(run.plan.tempC + 7);

function activityListItem(w: World, run: DemoRun) {
  const { plan, summary: s } = run;
  const day = w.byDate.get(plan.date)!;
  const end = plan.startMs + s.elapsedDuration * 1000;
  return {
    activityId: plan.id,
    activityName: plan.name,
    startTimeLocal: localSpace(plan.startMs),
    startTimeGMT: gmtSpace(plan.startMs),
    activityType: RUNNING_TYPE,
    eventType: EVENT_TYPE,
    isFavorite: false,
    isPR: false,
    isAutoCalcCalories: false,
    isParent: false,
    distance: s.distance,
    duration: s.duration,
    elapsedDuration: s.elapsedDuration,
    movingDuration: s.movingDuration,
    elevationGain: s.elevationGain,
    elevationLoss: s.elevationLoss,
    averageSpeed: s.averageSpeed,
    maxSpeed: s.maxSpeed,
    hasPolyline: false,
    hasImages: false,
    ...OWNER,
    calories: s.calories,
    bmrCalories: s.bmrCalories,
    averageHR: s.averageHR,
    maxHR: s.maxHR,
    averageRunningCadenceInStepsPerMinute: s.averageCadence,
    maxRunningCadenceInStepsPerMinute: s.maxCadence,
    steps: s.steps,
    userRoles: ["SCOPE_ATP_READ", "SCOPE_CONNECT_READ", "SCOPE_CONNECT_WRITE"],
    privacy: { typeId: 2, typeKey: "private" },
    userPro: false,
    hasVideo: false,
    isPurposeful: false,
    timeZoneId: 124,
    beginTimestamp: plan.startMs,
    sportTypeId: 1,
    avgPower: s.averagePower,
    maxPower: s.maxPower,
    aerobicTrainingEffect: s.aerobicTE,
    anaerobicTrainingEffect: s.anaerobicTE,
    normPower: s.normPower,
    avgStrideLength: s.strideLength,
    vO2MaxValue: day.vo2 !== null ? Math.round(day.vo2) : null,
    deviceId: PERSONA.deviceId,
    minTemperature: watchTemp(run) - 2,
    maxTemperature: watchTemp(run) + 3,
    minElevation: s.minElevation,
    maxElevation: s.maxElevation,
    avgElevation: round((s.maxElevation + s.minElevation) / 2, 1),
    maxDoubleCadence: s.maxCadence,
    isElevationCorrected: false,
    isDecoDive: false,
    summarizedDiveInfo: { summarizedDiveGases: [] },
    maxVerticalSpeed: 0.6,
    manufacturer: "GARMIN",
    locationName: null,
    lapCount: s.lapCount,
    isAtpActivity: false,
    waterEstimated: Math.round(s.duration / 3.6),
    trainingEffectLabel: s.teLabel,
    activityTrainingLoad: s.trainingLoad,
    minActivityLapDuration: Math.min(...detailsLapDurations(run)),
    aerobicTrainingEffectMessage: TE_MESSAGES[s.teLabel] ?? "IMPROVING_AEROBIC_BASE_8",
    anaerobicTrainingEffectMessage: anaerobicMessage(s.anaerobicTE),
    splitSummaries: [splitSummary(run)],
    hasSplits: true,
    hasIntensityIntervals: plan.laps === "segments",
    isManualActivity: false,
    avgGradeAdjustedSpeed: s.averageSpeed,
    hasHeatMap: false,
    fastestSplit_1000: s.fastest1k,
    hrTimeInZone_1: s.zoneSecs[0],
    hrTimeInZone_2: s.zoneSecs[1],
    hrTimeInZone_3: s.zoneSecs[2],
    hrTimeInZone_4: s.zoneSecs[3],
    hrTimeInZone_5: s.zoneSecs[4],
    moderateIntensityMinutes: s.moderateMinutes,
    vigorousIntensityMinutes: s.vigorousMinutes,
    ...(plan.workoutId !== null && { workoutId: plan.workoutId }),
    endTimeGMT: gmtSpace(end),
    qualifyingDive: false,
    activityUUID: uuidOf(plan.id),
    pr: false,
    favorite: false,
    purposeful: false,
    parent: false,
    decoDive: false,
    manualActivity: false,
    autoCalcCalories: false,
    elevationCorrected: false,
    atpActivity: false,
  };
}

function detailsLapDurations(run: DemoRun): number[] {
  // Cheap approximation for the list (avoids simulating every listed run)
  return [run.summary.duration / Math.max(1, run.summary.lapCount)];
}

function splitSummary(run: DemoRun) {
  const s = run.summary;
  return {
    noOfSplits: 1,
    totalAscent: s.elevationGain,
    duration: s.duration,
    splitType: "RWD_RUN",
    maxElevationGain: s.elevationGain,
    averageElevationGain: s.elevationGain,
    maxDistance: Math.round(s.distance),
    maxDistanceWithPrecision: s.distance,
    distance: s.distance,
    averageSpeed: s.averageSpeed,
    maxSpeed: s.maxSpeed,
    elevationLoss: s.elevationLoss,
    avgStepFrequency: s.averageCadence,
  };
}

function uuidOf(id: number): string {
  const h = String(id).padStart(12, "0").slice(-12);
  return `5d2c${h.slice(0, 4)}-7a1b-4c3d-8e9f-${h}`;
}

function activityDetails(run: DemoRun) {
  const { plan, summary: s } = run;
  return {
    activityId: plan.id,
    activityUUID: { uuid: uuidOf(plan.id) },
    activityName: plan.name,
    userProfileId: PERSONA.profileId,
    isMultiSportParent: false,
    activityTypeDTO: RUNNING_TYPE,
    eventTypeDTO: EVENT_TYPE,
    accessControlRuleDTO: { typeId: 2, typeKey: "private" },
    timeZoneUnitDTO: null,
    metadataDTO: {
      isOriginal: true,
      deviceApplicationInstallationId: 1_040_877,
      agentApplicationInstallationId: null,
      agentString: null,
      fileFormat: { formatId: 7, formatKey: "fit" },
      associatedCourseId: null,
      lastUpdateDate: gmtIso(plan.startMs + (s.elapsedDuration + 600) * 1000),
      uploadedDate: gmtIso(plan.startMs + (s.elapsedDuration + 420) * 1000),
      videoUrl: null,
      hasPolyline: false,
      hasChartData: true,
      hasHrTimeInZones: true,
      hasPowerTimeInZones: true,
      userInfoDto: {
        userProfilePk: PERSONA.profileId,
        displayname: PERSONA.displayName,
        fullname: PERSONA.fullName,
        profileImageUrlLarge: null,
        profileImageUrlMedium: null,
        profileImageUrlSmall: null,
        userPro: false,
      },
      childIds: [],
      childActivityTypes: [],
      sensors: null,
      activityImages: [],
      manufacturer: "GARMIN",
      diveNumber: null,
      lapCount: s.lapCount,
      associatedWorkoutId: plan.workoutId,
      isAtpActivity: false,
      deviceMetaDataDTO: {
        deviceId: String(PERSONA.deviceId),
        deviceTypePk: PERSONA.deviceTypePk,
        deviceVersionPk: 1_204_455,
      },
      hasIntensityIntervals: plan.laps === "segments",
      hasSplits: true,
      hasRunPowerWindData: true,
      hasHeatMap: false,
      sessionResultType: "NONE",
      hasMultiDayActivities: false,
      personalRecord: false,
      gcj02: false,
      runPowerWindDataEnabled: true,
      manualActivity: false,
      trimmed: false,
      autoCalcCalories: false,
      favorite: false,
      elevationCorrected: false,
    },
    summaryDTO: {
      startTimeLocal: localIso(plan.startMs),
      startTimeGMT: gmtIso(plan.startMs),
      distance: s.distance,
      duration: s.duration,
      movingDuration: s.movingDuration,
      elapsedDuration: s.elapsedDuration,
      elevationGain: s.elevationGain,
      elevationLoss: s.elevationLoss,
      maxElevation: s.maxElevation,
      minElevation: s.minElevation,
      avgElevation: round((s.maxElevation + s.minElevation) / 2, 1),
      averageSpeed: s.averageSpeed,
      averageMovingSpeed: round(s.distance / s.movingDuration, 3),
      maxSpeed: s.maxSpeed,
      calories: s.calories,
      bmrCalories: s.bmrCalories,
      averageHR: s.averageHR,
      maxHR: s.maxHR,
      minHR: s.minHR,
      averageRunCadence: s.averageCadence,
      maxRunCadence: s.maxCadence,
      averageTemperature: watchTemp(run),
      maxTemperature: watchTemp(run) + 3,
      minTemperature: watchTemp(run) - 2,
      averagePower: s.averagePower,
      maxPower: s.maxPower,
      minPower: Math.round(s.averagePower * 0.4),
      normalizedPower: s.normPower,
      totalWork: Math.round((s.averagePower * s.duration) / 1000),
      strideLength: s.strideLength,
      trainingEffect: s.aerobicTE,
      anaerobicTrainingEffect: s.anaerobicTE,
      aerobicTrainingEffectMessage: TE_MESSAGES[s.teLabel] ?? "IMPROVING_AEROBIC_BASE_8",
      anaerobicTrainingEffectMessage: anaerobicMessage(s.anaerobicTE),
      maxVerticalSpeed: 0.6,
      waterEstimated: Math.round(s.duration / 3.6),
      trainingEffectLabel: s.teLabel,
      activityTrainingLoad: s.trainingLoad,
      minActivityLapDuration: Math.min(...detailsOf(run).laps.map((l) => l.duration)),
      steps: s.steps,
      avgGradeAdjustedSpeed: s.averageSpeed,
      moderateIntensityMinutes: s.moderateMinutes,
      vigorousIntensityMinutes: s.vigorousMinutes,
      differenceBodyBattery: -Math.round(s.trainingLoad / 6),
    },
    locationName: null,
    splitSummaries: [
      {
        ...splitSummary(run),
        movingDuration: s.movingDuration,
        elevationGain: s.elevationGain,
        averageMovingSpeed: round(s.distance / s.movingDuration, 3),
        calories: s.calories,
        bmrCalories: s.bmrCalories,
        averageHR: s.averageHR,
        maxHR: s.maxHR,
        averageRunCadence: s.averageCadence,
        maxRunCadence: s.maxCadence,
        averageTemperature: watchTemp(run),
        maxTemperature: watchTemp(run) + 3,
        minTemperature: watchTemp(run) - 2,
        averagePower: s.averagePower,
        maxPower: s.maxPower,
        normalizedPower: s.normPower,
        strideLength: s.strideLength,
        totalExerciseReps: 0,
        avgVerticalSpeed: 0,
        avgGradeAdjustedSpeed: s.averageSpeed,
      },
    ],
  };
}

function lapDTO(run: DemoRun, lap: LapStats, i: number) {
  return {
    startTimeGMT: gmtIso(lap.startMs),
    distance: lap.distance,
    duration: lap.duration,
    movingDuration: Math.round(lap.duration),
    elapsedDuration: lap.duration,
    elevationGain: lap.elevationGain,
    elevationLoss: lap.elevationLoss,
    maxElevation: lap.maxElevation,
    minElevation: lap.minElevation,
    averageSpeed: lap.averageSpeed,
    averageMovingSpeed: lap.averageSpeed,
    maxSpeed: lap.maxSpeed,
    calories: lap.calories,
    bmrCalories: Math.round((lap.duration / 86_400) * 1610),
    averageHR: lap.averageHR,
    maxHR: lap.maxHR,
    averageRunCadence: lap.averageRunCadence,
    maxRunCadence: lap.maxRunCadence,
    averageTemperature: watchTemp(run),
    maxTemperature: watchTemp(run) + 1,
    minTemperature: watchTemp(run) - 1,
    averagePower: lap.averagePower,
    maxPower: lap.maxPower,
    minPower: Math.round(lap.averagePower * 0.5),
    normalizedPower: lap.averagePower + 6,
    totalWork: Math.round((lap.averagePower * lap.duration) / 1000),
    strideLength: lap.strideLength,
    maxVerticalSpeed: 0.4,
    avgGradeAdjustedSpeed: lap.averageSpeed,
    lapIndex: lap.lapIndex,
    lengthDTOs: [],
    connectIQMeasurement: [],
    intensityType: lap.intensityType,
    messageIndex: i,
  };
}

const CHART_METRICS = [
  ["directTimestamp", 531, "gmt", 0],
  ["sumDistance", 2, "meter", 100],
  ["sumDuration", 40, "second", 1000],
  ["sumElapsedDuration", 40, "second", 1000],
  ["sumMovingDuration", 40, "second", 1000],
  ["directHeartRate", 100, "bpm", 1],
  ["directSpeed", 20, "mps", 0.1],
  ["directDoubleCadence", 108, "stepsPerMinute", 1],
  ["directRunCadence", 104, "stepsPerMinute", 1],
  ["directElevation", 3, "meter", 100],
  ["directPower", 13, "watt", 1],
  ["directGradeAdjustedSpeed", 20, "mps", 0.1],
] as const;

function chartDetails(run: DemoRun, maxSize: number) {
  const { samples } = detailsOf(run);
  let pick = samples;
  if (samples.length > maxSize) {
    pick = Array.from(
      { length: maxSize },
      (_, i) => samples[Math.round((i * (samples.length - 1)) / (maxSize - 1))]!,
    );
  }
  const pause = run.summary.elapsedDuration - run.summary.duration;
  return {
    activityId: run.plan.id,
    measurementCount: CHART_METRICS.length,
    metricsCount: pick.length,
    totalMetricsCount: samples.length,
    metricDescriptors: CHART_METRICS.map(([key, id, unit, factor], i) => ({
      metricsIndex: i,
      key,
      unit: { id, key: unit, factor },
    })),
    activityDetailMetrics: pick.map((s) => ({
      metrics: [
        run.plan.startMs + s.t * 1000,
        s.d,
        s.t,
        round(s.t + (pause * s.t) / run.summary.duration, 1),
        s.t,
        s.hr,
        s.speed,
        s.cad,
        round(s.cad / 2, 1),
        s.elev,
        s.power,
        s.speed,
      ],
    })),
    geoPolylineDTO: null,
    heartRateDTOs: null,
    pendingData: null,
    detailsAvailable: true,
  };
}

// ── Daily wellness ────────────────────────────────────

function dayOrNull(w: World, date: string): DemoDay | null {
  return w.byDate.get(date) ?? null;
}

const STRESS_QUALIFIER = (avg: number) =>
  avg <= 25 ? "CALM" : avg <= 50 ? "BALANCED" : avg <= 75 ? "STRESSFUL" : "VERY_STRESSFUL";

function timestamps(day: DemoDay) {
  const [from, to] = dayWindow(day);
  return {
    startTimestampGMT: gmtIso(from),
    endTimestampGMT: gmtIso(to),
    startTimestampLocal: localIso(from),
    endTimestampLocal: localIso(to),
  };
}

function userSummary(w: World, date: string) {
  const day = dayOrNull(w, date);
  if (!day)
    return { userProfileId: PERSONA.profileId, calendarDate: date, includesWellnessData: false };
  const runs = day.runs;
  const activeCal = runs.reduce((s, r) => s + r.summary.calories, 0) + Math.round(day.steps * 0.03);
  const bmr = day.isToday ? 690 : 1610;
  const sleepSecs = day.night.sleepSecs + day.night.awakeSecs;
  const runSecs = runs.reduce((s, r) => s + r.summary.duration, 0);
  const awake = (day.isToday ? 10.5 * 3600 - 6.5 * 3600 : 86_400 - sleepSecs) - runSecs;
  const stressTotal = awake * 0.92;
  const share = clamp((day.stressAvg - 15) / 40, 0.05, 0.9);
  const low = stressTotal * (0.32 + 0.25 * share);
  const medium = stressTotal * 0.12 * share * 1.6;
  const high = stressTotal * 0.03 * share;
  const rest = stressTotal - low - medium - high + sleepSecs * 0.9;
  const activity = runSecs + 1800;
  const uncategorized = Math.round(awake * 0.08);
  const total = rest + low + medium + high;
  const all = total + activity + uncategorized;
  const pct = (v: number) => round((v / all) * 100, 2);
  const [from, to] = dayWindow(day);
  return {
    userProfileId: PERSONA.profileId,
    totalKilocalories: bmr + activeCal,
    activeKilocalories: activeCal,
    bmrKilocalories: bmr,
    wellnessKilocalories: bmr + activeCal,
    burnedKilocalories: null,
    consumedKilocalories: null,
    remainingKilocalories: bmr + activeCal,
    totalSteps: day.steps,
    netCalorieGoal: null,
    totalDistanceMeters: Math.round(
      day.walkMeters + runs.reduce((s, r) => s + r.summary.distance, 0),
    ),
    wellnessDistanceMeters: Math.round(
      day.walkMeters + runs.reduce((s, r) => s + r.summary.distance, 0),
    ),
    wellnessActiveKilocalories: activeCal,
    netRemainingKilocalories: bmr + activeCal,
    userDailySummaryId: PERSONA.profileId,
    calendarDate: date,
    rule: { typeId: 3, typeKey: "subscribers" },
    uuid: `9a0b${date.replace(/-/g, "")}-1c2d-4e3f-8a9b-0c1d2e3f4a5b`,
    dailyStepGoal: day.stepGoal,
    wellnessStartTimeGmt: gmtIso(from),
    wellnessStartTimeLocal: localIso(from),
    wellnessEndTimeGmt: gmtIso(to),
    wellnessEndTimeLocal: localIso(to),
    durationInMilliseconds: to - from,
    wellnessDescription: null,
    highlyActiveSeconds: Math.round(runSecs + 900),
    activeSeconds: Math.round(day.steps * 0.45),
    sedentarySeconds: Math.round(Math.max(0, awake - day.steps * 0.45)),
    sleepingSeconds: day.night.sleepSecs,
    includesWellnessData: true,
    includesActivityData: runs.length > 0,
    includesCalorieConsumedData: false,
    privacyProtected: false,
    moderateIntensityMinutes: day.moderateMinutes,
    vigorousIntensityMinutes: day.vigorousMinutes,
    floorsAscendedInMeters: round(day.floors * 3.048, 3),
    floorsDescendedInMeters: round(day.floors * 3.048 * 0.95, 3),
    floorsAscended: day.floors,
    floorsDescended: round(day.floors * 0.95, 2),
    intensityMinutesGoal: 150,
    userFloorsAscendedGoal: 10,
    minHeartRate: day.minHr,
    maxHeartRate: day.maxHr,
    restingHeartRate: day.rhr,
    lastSevenDaysAvgRestingHeartRate: day.rhr7,
    source: "GARMIN",
    averageStressLevel: day.stressAvg,
    maxStressLevel: day.stressMax,
    stressDuration: Math.round(low + medium + high),
    restStressDuration: Math.round(rest),
    activityStressDuration: Math.round(activity),
    uncategorizedStressDuration: uncategorized,
    totalStressDuration: Math.round(total),
    lowStressDuration: Math.round(low),
    mediumStressDuration: Math.round(medium),
    highStressDuration: Math.round(high),
    stressPercentage: pct(low + medium + high),
    restStressPercentage: pct(rest),
    activityStressPercentage: pct(activity),
    uncategorizedStressPercentage: pct(uncategorized),
    lowStressPercentage: pct(low),
    mediumStressPercentage: pct(medium),
    highStressPercentage: pct(high),
    stressQualifier: STRESS_QUALIFIER(day.stressAvg),
    measurableAwakeDuration: Math.round(awake),
    measurableAsleepDuration: day.night.sleepSecs,
    lastSyncTimestampGMT: gmtIso(day.isToday ? to : localMs(date, 21 * 3600)),
    minAvgHeartRate: day.minHr + 1,
    maxAvgHeartRate: Math.max(day.maxHr - 4, day.minHr + 40),
    bodyBatteryChargedValue: day.bb.charged,
    bodyBatteryDrainedValue: day.bb.drained,
    bodyBatteryHighestValue: day.bb.high,
    bodyBatteryLowestValue: day.bb.low,
    bodyBatteryMostRecentValue: day.bb.end,
    bodyBatteryDuringSleep: day.bb.atWake - day.bb.midnight,
    bodyBatteryAtWakeTime: day.bb.atWake,
    bodyBatteryVersion: 3,
    abnormalHeartRateAlertsCount: null,
    averageSpo2: day.spo2,
    lowestSpo2: day.spo2 - 4,
    latestSpo2: day.spo2,
    avgWakingRespirationValue: 16,
    highestRespirationValue: 22,
    lowestRespirationValue: 11,
    latestRespirationValue: 15,
    latestRespirationTimeGMT: gmtIso(to - 120_000),
    respirationAlgorithmVersion: 200,
  };
}

function sleepData(w: World, date: string) {
  const day = dayOrNull(w, date);
  if (!day) return { dailySleepDTO: { userProfilePK: PERSONA.profileId, calendarDate: date } };
  const n = day.night;
  const pct = (v: number) => Math.round((v / n.sleepSecs) * 100);
  const q = (v: number, lo: number, hi: number) => (v >= lo && v <= hi ? "EXCELLENT" : "FAIR");
  const levels = sleepLevels(n, date);
  const hrRng = Rng.of("sleep-hr", date);
  const every = (stepMin: number, f: (ms: number, i: number) => number) => {
    const out: { value: number; startGMT: number }[] = [];
    for (let ms = n.start, i = 0; ms < n.end; ms += stepMin * 60_000, i++) {
      out.push({ value: f(ms, i), startGMT: ms });
    }
    return out;
  };
  const bbPrev = day.bb.atWake - (day.bb.atWake - day.bb.midnight) * 1.2;
  return {
    dailySleepDTO: {
      id: localEpoch(n.start),
      userProfilePK: PERSONA.profileId,
      calendarDate: date,
      sleepTimeSeconds: n.sleepSecs,
      napTimeSeconds: 0,
      sleepWindowConfirmed: true,
      sleepWindowConfirmationType: "enhanced_confirmed_final",
      sleepStartTimestampGMT: n.start,
      sleepEndTimestampGMT: n.end,
      sleepStartTimestampLocal: localEpoch(n.start),
      sleepEndTimestampLocal: localEpoch(n.end),
      autoSleepStartTimestampGMT: null,
      autoSleepEndTimestampGMT: null,
      sleepQualityTypePK: null,
      sleepResultTypePK: null,
      unmeasurableSleepSeconds: 0,
      deepSleepSeconds: n.deepSecs,
      lightSleepSeconds: n.lightSecs,
      remSleepSeconds: n.remSecs,
      awakeSleepSeconds: n.awakeSecs,
      deviceRemCapable: true,
      retro: false,
      sleepFromDevice: true,
      averageRespirationValue: n.avgRespiration,
      lowestRespirationValue: Math.round(n.avgRespiration - 3),
      highestRespirationValue: Math.round(n.avgRespiration + 4),
      awakeCount: n.awakeCount,
      avgSleepStress: n.avgSleepStress,
      ageGroup: "ADULT",
      sleepScoreFeedback:
        n.score >= 80
          ? "POSITIVE_RESTFUL_DAY"
          : n.score >= 60
            ? "NEGATIVE_LONG_BUT_NOT_RESTFUL"
            : "NEGATIVE_POOR_SLEEP",
      sleepScoreInsight: "NONE",
      sleepScorePersonalizedInsight: "NOT_AVAILABLE",
      sleepScores: {
        totalDuration: {
          qualifierKey:
            n.sleepSecs >= 27_000
              ? "EXCELLENT"
              : n.sleepSecs >= 24_300
                ? "GOOD"
                : n.sleepSecs >= 21_600
                  ? "FAIR"
                  : "POOR",
          optimalStart: 27_000,
          optimalEnd: 30_600,
        },
        stress: {
          qualifierKey: n.avgSleepStress <= 15 ? "EXCELLENT" : "GOOD",
          optimalStart: 0,
          optimalEnd: 15,
        },
        awakeCount: {
          qualifierKey: n.awakeCount <= 1 ? "EXCELLENT" : "GOOD",
          optimalStart: 0,
          optimalEnd: 1,
        },
        overall: {
          value: n.score,
          qualifierKey:
            n.score >= 90 ? "EXCELLENT" : n.score >= 80 ? "GOOD" : n.score >= 60 ? "FAIR" : "POOR",
        },
        remPercentage: {
          value: pct(n.remSecs),
          qualifierKey: q(pct(n.remSecs), 21, 31),
          optimalStart: 21,
          optimalEnd: 31,
          idealStartInSeconds: Math.round(n.sleepSecs * 0.21),
          idealEndInSeconds: Math.round(n.sleepSecs * 0.31),
        },
        restlessness: { qualifierKey: "GOOD", optimalStart: 0, optimalEnd: 5 },
        lightPercentage: {
          value: pct(n.lightSecs),
          qualifierKey: q(pct(n.lightSecs), 30, 64),
          optimalStart: 30,
          optimalEnd: 64,
          idealStartInSeconds: Math.round(n.sleepSecs * 0.3),
          idealEndInSeconds: Math.round(n.sleepSecs * 0.64),
        },
        deepPercentage: {
          value: pct(n.deepSecs),
          qualifierKey: q(pct(n.deepSecs), 16, 33),
          optimalStart: 16,
          optimalEnd: 33,
          idealStartInSeconds: Math.round(n.sleepSecs * 0.16),
          idealEndInSeconds: Math.round(n.sleepSecs * 0.33),
        },
      },
      sleepVersion: 2,
      sleepNeed: { calendarDate: date, baseline: 480, actual: 480, feedback: "NO_CHANGE_BALANCED" },
    },
    sleepMovement: [],
    remSleepData: true,
    sleepLevels: levels,
    sleepRestlessMoments: [],
    restlessMomentsCount: Math.round(10 + n.awakeCount * 6),
    wellnessEpochRespirationDataDTOList: [],
    wellnessEpochRespirationAveragesList: [],
    respirationVersion: 200,
    sleepHeartRate: every(2, (_, i) =>
      Math.round(
        day.rhr + 3 + 4 * Math.cos(i / 25) * Math.max(0, 1 - i / 240) + hrRng.normal(0, 1),
      ),
    ),
    sleepStress: every(3, () => Math.round(clamp(n.avgSleepStress + hrRng.normal(0, 4), 1, 60))),
    sleepBodyBattery: every(3, (ms) =>
      Math.round(bbPrev + ((day.bb.atWake - bbPrev) * (ms - n.start)) / (n.end - n.start)),
    ),
    skinTempDataExists: false,
    hrvData: [],
    avgOvernightHrv: day.hrv,
    hrvStatus: day.hrvStatus,
    bodyBatteryChange: day.bb.atWake - Math.round(bbPrev),
    restingHeartRate: day.rhr,
  };
}

function hrvSummary(day: DemoDay) {
  return {
    calendarDate: day.date,
    weeklyAvg: day.hrvWeekly,
    lastNightAvg: day.hrv,
    lastNight5MinHigh: day.hrv + Math.round(Rng.of("hrv5", day.date).range(10, 22)),
    baseline: day.hrvBaseline,
    status: day.hrvStatus,
    feedbackPhrase: `HRV_${day.hrvStatus}_${(day.index % 5) + 1}`,
    createTimeStamp: gmtIso(day.night.end + 300_000),
  };
}

function readiness(day: DemoDay) {
  const r = day.readiness;
  const f = r.factors;
  return {
    userProfilePK: PERSONA.profileId,
    calendarDate: day.date,
    timestamp: gmtIso(day.night.end + 600_000),
    timestampLocal: localIso(day.night.end + 600_000),
    deviceId: PERSONA.deviceId,
    level: r.level,
    feedbackLong: r.feedbackLong,
    feedbackShort: r.feedbackShort,
    score: r.score,
    sleepScore: day.night.score,
    sleepScoreFactorPercent: f.sleepScore.percent,
    sleepScoreFactorFeedback: f.sleepScore.feedback,
    recoveryTime: r.recoveryTimeMin,
    recoveryTimeFactorPercent: f.recoveryTime.percent,
    recoveryTimeFactorFeedback: f.recoveryTime.feedback,
    acwrFactorPercent: f.acwr.percent,
    acwrFactorFeedback: f.acwr.feedback,
    acuteLoad: day.acute,
    stressHistoryFactorPercent: f.stressHistory.percent,
    stressHistoryFactorFeedback: f.stressHistory.feedback,
    hrvFactorPercent: f.hrv.percent,
    hrvFactorFeedback: f.hrv.feedback,
    hrvWeeklyAverage: day.hrvWeekly,
    sleepHistoryFactorPercent: f.sleepHistory.percent,
    sleepHistoryFactorFeedback: f.sleepHistory.feedback,
    validSleep: true,
    inputContext: "UPDATE_REALTIME_VARIABLES",
    primaryActivityTracker: true,
    recoveryTimeChangePhrase: "NO_CHANGE_SLEEP",
  };
}

const ACWR_STATUS = (acwr: number) =>
  acwr < 0.8 ? "LOW" : acwr <= 1.5 ? "OPTIMAL" : acwr <= 2 ? "HIGH" : "VERY_HIGH";
const STATUS_CODES: Record<string, number> = {
  DETRAINING: 1,
  RECOVERY: 2,
  MAINTAINING: 4,
  PRODUCTIVE: 7,
  PEAKING: 8,
  OVERREACHING: 5,
  UNPRODUCTIVE: 3,
};

function trainingStatusEntry(day: DemoDay) {
  const acwr = day.acute / Math.max(1, day.chronic);
  return {
    calendarDate: day.date,
    sinceDate: addDays(day.date, -((day.index % 9) + 2)),
    weeklyTrainingLoad: null,
    trainingStatus: STATUS_CODES[day.trainingStatus] ?? 4,
    timestamp: day.night.end + 900_000,
    deviceId: PERSONA.deviceId,
    loadTunnelMin: null,
    loadTunnelMax: null,
    loadLevelTrend: null,
    sport: "RUNNING",
    subSport: "GENERIC",
    fitnessTrendSport: "RUNNING",
    fitnessTrend: day.trainingStatus === "PRODUCTIVE" ? 2 : 1,
    trainingStatusFeedbackPhrase: `${day.trainingStatus}_${(day.index % 3) + 1}`,
    trainingPaused: false,
    acuteTrainingLoadDTO: {
      acwrPercent: Math.round(clamp((acwr - 0.5) / 1.5, 0, 1) * 100),
      acwrStatus: ACWR_STATUS(acwr),
      acwrStatusFeedback: `FEEDBACK_${ACWR_STATUS(acwr)}`,
      dailyTrainingLoadAcute: day.acute,
      maxTrainingLoadChronic: Math.round(day.chronic * 1.5),
      minTrainingLoadChronic: Math.round(day.chronic * 0.8),
      dailyTrainingLoadChronic: day.chronic,
      dailyAcuteChronicWorkloadRatio: round(acwr, 1),
    },
    primaryTrainingDevice: true,
  };
}

const RECORDED_DEVICES = [
  { deviceId: PERSONA.deviceId, imageURL: null, deviceName: PERSONA.device, category: 0 },
];

function vo2Entry(day: DemoDay) {
  return {
    userId: PERSONA.profileId,
    generic: {
      calendarDate: day.date,
      vo2MaxPreciseValue: day.vo2,
      vo2MaxValue: Math.round(day.vo2!),
      fitnessAge: null,
      fitnessAgeDescription: null,
      maxMetCategory: 0,
    },
    cycling: null,
    heatAltitudeAcclimation: heatAcclimation(day),
  };
}

function heatAcclimation(day: DemoDay) {
  return {
    calendarDate: day.date,
    altitudeAcclimationDate: day.date,
    previousAltitudeAcclimationDate: day.date,
    heatAcclimationDate: day.date,
    previousHeatAcclimationDate: addDays(day.date, -1),
    altitudeAcclimation: 0,
    previousAltitudeAcclimation: 0,
    heatAcclimationPercentage: Math.round(clamp(day.tempC * 3, 0, 100)),
    previousHeatAcclimationPercentage: Math.round(clamp(day.tempC * 3 - 1, 0, 100)),
    heatTrend: "ACCLIMATIZED",
    altitudeTrend: null,
    currentAltitude: 40,
    previousAltitude: 40,
    acclimationPercentage: 0,
    previousAcclimationPercentage: 0,
    altitudeAcclimationLocalTimestamp: localIso(day.night.end),
  };
}

function trainingStatus(w: World, date: string) {
  const day = dayOrNull(w, date) ?? w.days.at(-1)!;
  const vo2Day = [...w.days].reverse().find((d) => d.date <= day.date && d.vo2 !== null) ?? day;
  const wrap = (url: string, payload: unknown) => ({
    requestUrl: url,
    statusCode: 200,
    headers: {},
    errorMessage: null,
    payload,
    successful: true,
  });
  const month = daysIn(w, addDays(day.date, -27), day.date);
  const runsOf = (pred: (r: DemoRun) => boolean) =>
    Math.round(
      month
        .flatMap((d) => d.runs)
        .filter(pred)
        .reduce((s, r) => s + r.summary.trainingLoad, 0),
    );
  return {
    mostRecentHeatAltitudeAcclimation: wrap(
      `/metrics-service/metrics/heataltitudeacclimation/latest/${date}`,
      heatAcclimation(day),
    ),
    mostRecentVO2Max: wrap(`/metrics-service/metrics/maxmet/latest/${date}`, vo2Entry(vo2Day)),
    mostRecentTrainingLoadBalance: wrap(
      `/metrics-service/metrics/trainingloadbalance/latest/${date}`,
      {
        userId: PERSONA.profileId,
        metricsTrainingLoadBalanceDTOMap: {
          [PERSONA.deviceId]: {
            calendarDate: day.date,
            deviceId: PERSONA.deviceId,
            monthlyLoadAerobicLow: runsOf(
              (r) => r.plan.kind === "easy" || r.plan.kind === "recovery" || r.plan.kind === "long",
            ),
            monthlyLoadAerobicHigh: runsOf(
              (r) => r.plan.kind === "tempo" || r.plan.kind === "progression",
            ),
            monthlyLoadAnaerobic: Math.round(runsOf((r) => r.plan.kind === "intervals") * 0.6),
            monthlyLoadAerobicLowTargetMin: 520,
            monthlyLoadAerobicLowTargetMax: 1140,
            monthlyLoadAerobicHighTargetMin: 520,
            monthlyLoadAerobicHighTargetMax: 1140,
            monthlyLoadAnaerobicTargetMin: 100,
            monthlyLoadAnaerobicTargetMax: 410,
            trainingBalanceFeedbackPhrase: "BALANCED",
            primaryTrainingDevice: true,
          },
        },
        recordedDevices: RECORDED_DEVICES,
      },
    ),
    mostRecentTrainingStatus: wrap(`/metrics-service/metrics/trainingstatus/daily/${date}`, {
      userId: PERSONA.profileId,
      latestTrainingStatusData: { [PERSONA.deviceId]: trainingStatusEntry(day) },
      recordedDevices: RECORDED_DEVICES,
      showSelector: false,
      lastPrimarySyncDate: day.date,
    }),
  };
}

function bodyBatteryReport(w: World, day: DemoDay) {
  const [from, to] = dayWindow(day);
  return {
    date: day.date,
    charged: day.bb.charged,
    drained: day.bb.drained,
    startTimestampGMT: gmtIso(from),
    endTimestampGMT: gmtIso(to),
    startTimestampLocal: localIso(from),
    endTimestampLocal: localIso(to),
    bodyBatteryValuesArray: bodyBatteryValues(w, day),
    bodyBatteryValueDescriptorDTOList: [
      { bodyBatteryValueDescriptorIndex: 0, bodyBatteryValueDescriptorKey: "timestamp" },
      { bodyBatteryValueDescriptorIndex: 1, bodyBatteryValueDescriptorKey: "bodyBatteryLevel" },
    ],
    bodyBatteryDynamicFeedbackEvent: null,
    endOfDayBodyBatteryDynamicFeedbackEvent: null,
  };
}

// ── Workouts, calendar, gear ───────────────────────────

function workoutSummary(w: SavedWorkout) {
  return {
    workoutId: w.workoutId,
    ownerId: PERSONA.profileId,
    workoutName: w.workout.workoutName,
    description: w.workout.description ?? null,
    updateDate: localIso(w.updatedMs),
    createdDate: localIso(w.createdMs),
    sportType: w.workout.sportType,
    trainingPlanId: null,
    author: {
      userProfilePk: PERSONA.profileId,
      displayName: PERSONA.displayName,
      fullName: PERSONA.fullName,
      profileImgNameLarge: null,
      profileImgNameMedium: null,
      profileImgNameSmall: null,
      userPro: false,
      vivokidUser: false,
    },
    estimatedDurationInSecs: w.workout.estimatedDurationInSecs ?? 0,
    estimatedDistanceInMeters: w.workout.estimatedDistanceInMeters ?? 0,
    estimateType: w.workout.estimatedDistanceInMeters ? "TIME_ESTIMATED" : "DISTANCE_ESTIMATED",
    estimatedDistanceUnit: { unitId: 2, unitKey: "kilometer", factor: 100000 },
    poolLength: 0,
    poolLengthUnit: { unitId: null, unitKey: null, factor: null },
    workoutProvider: null,
    workoutSourceId: null,
    consumer: null,
    atpPlanId: null,
    workoutNameI18nKey: null,
    descriptionI18nKey: null,
    workoutThumbnailUrl: null,
    shared: false,
    estimated: true,
  };
}

let stepIds = 21_402_000_000;
function withStepIds(steps: unknown[]): unknown[] {
  return steps.map((s) => {
    const step = s as Record<string, unknown>;
    return {
      ...step,
      stepId: stepIds++,
      preferredEndConditionUnit: null,
      endConditionCompare: null,
      targetValueUnit: null,
      secondaryTargetType: null,
      secondaryTargetValueOne: null,
      secondaryTargetValueTwo: null,
      secondaryTargetValueUnit: null,
      secondaryZoneNumber: null,
      endConditionZone: null,
      strokeType: { strokeTypeId: 0, strokeTypeKey: null, displayOrder: 0 },
      equipmentType: { equipmentTypeId: 0, equipmentTypeKey: null, displayOrder: 0 },
      category: null,
      exerciseName: null,
      workoutProvider: null,
      providerExerciseSourceId: null,
      weightValue: null,
      weightUnit: null,
      ...(Array.isArray(step.workoutSteps) && { workoutSteps: withStepIds(step.workoutSteps) }),
    };
  });
}

function workoutDetail(w: SavedWorkout) {
  const { workoutSegments, author: _author, ...rest } = w.workout;
  void _author;
  const sum = workoutSummary(w);
  return {
    ...sum,
    ...rest,
    updatedDate: sum.updateDate,
    subSportType: null,
    sharedWithUsers: null,
    workoutSegments: workoutSegments.map((seg) => ({
      ...seg,
      poolLengthUnit: null,
      poolLength: null,
      avgTrainingSpeed: null,
      estimatedDurationInSecs: null,
      estimatedDistanceInMeters: null,
      estimatedDistanceUnit: null,
      estimateType: null,
      description: null,
      workoutSteps: withStepIds(seg.workoutSteps),
    })),
    poolLength: null,
    poolLengthUnit: null,
    locale: null,
    uploadTimestamp: null,
    consumerName: null,
    consumerImageURL: null,
    consumerWebsiteURL: null,
    avgTrainingSpeed:
      w.workout.estimatedDistanceInMeters && w.workout.estimatedDurationInSecs
        ? round(w.workout.estimatedDistanceInMeters / w.workout.estimatedDurationInSecs, 3)
        : 2.9,
    isSessionTransitionEnabled: null,
  };
}

function findWorkout(w: World, id: string): SavedWorkout {
  const found = workoutsOf(w).find((x) => x.workoutId === Number(id));
  if (!found) throw new HttpError(404, `No workout ${id}`);
  return found;
}

function calendarMonth(w: World, year: number, month0: number) {
  const first = new Date(year, month0, 1);
  const days = new Date(year, month0 + 1, 0).getDate();
  const prevDays = new Date(year, month0, 0).getDate();
  const firstYmd = `${year}-${String(month0 + 1).padStart(2, "0")}-01`;
  // The month grid: from the Sunday on/before the 1st to the Saturday after the end
  const gridStart = addDays(firstYmd, -first.getDay());
  const gridEnd = addDays(addDays(firstYmd, days - 1), 6 - weekday(addDays(firstYmd, days - 1)));
  const items: Record<string, unknown>[] = [];
  for (const d of daysIn(w, gridStart, gridEnd)) {
    for (const run of d.runs) {
      const s = run.summary;
      items.push({
        id: run.plan.id,
        groupId: null,
        trainingPlanId: null,
        itemType: "activity",
        activityTypeId: 1,
        wellnessActivityUuid: null,
        title: run.plan.name,
        date: d.date,
        duration: Math.round(s.duration * 1000),
        distance: Math.round(s.distance * 100),
        calories: s.calories,
        floorsClimbed: null,
        avgRespirationRate: null,
        unitOfPoolLength: null,
        weight: null,
        difference: null,
        courseId: null,
        courseName: null,
        sportTypeKey: null,
        url: null,
        isStart: null,
        isRace: null,
        recurrenceId: null,
        isParent: false,
        parentId: null,
        startTimestampLocal: localIso(run.plan.startMs),
        eventTimeLocal: null,
        elapsedDuration: s.elapsedDuration,
        lapCount: s.lapCount,
        workoutId: run.plan.workoutId,
        protectedWorkoutSchedule: false,
        noOfSplits: 1,
        totalAscent: s.elevationGain,
        maxSpeed: s.maxSpeed,
        averageHR: s.averageHR,
        activeSplitSummaryDuration: s.duration,
        activeSplitSummaryDistance: s.distance,
        hasSplits: true,
        autoCalcCalories: false,
        decoDive: false,
        shareableEvent: false,
      });
    }
  }
  const byId = new Map(workoutsOf(w).map((x) => [x.workoutId, x]));
  for (const s of scheduleOf(w)) {
    if (s.date < gridStart || s.date > gridEnd) continue;
    const wk = byId.get(s.workoutId);
    items.push({
      id: s.scheduleId,
      itemType: "workout",
      title: wk?.workout.workoutName ?? "Workout",
      date: s.date,
      workoutId: s.workoutId,
      sportTypeKey: "running",
      duration: null,
      distance: null,
      calories: null,
      isParent: false,
      startTimestampLocal: null,
      elapsedDuration: null,
      lapCount: null,
      protectedWorkoutSchedule: false,
      maxSpeed: null,
      averageHR: null,
      hasSplits: null,
      autoCalcCalories: false,
      decoDive: false,
      shareableEvent: false,
    });
  }
  if (w.race.date >= gridStart && w.race.date <= gridEnd) {
    items.push({
      id: w.race.id,
      itemType: "event",
      title: w.race.title,
      date: w.race.date,
      isRace: true,
      eventTimeLocal: { startTimeHhMm: "08:30", timeZoneId: null },
      completionTarget: { value: 21_097.5, unit: "meter", unitType: "distance" },
      duration: null,
      distance: null,
      calories: null,
      isParent: false,
      startTimestampLocal: null,
      elapsedDuration: null,
      lapCount: null,
      protectedWorkoutSchedule: false,
      maxSpeed: null,
      averageHR: null,
      hasSplits: null,
      autoCalcCalories: false,
      decoDive: false,
      shareableEvent: false,
    });
  }
  items.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return {
    startDayOfMonth: first.getDay(),
    numOfDaysInMonth: days,
    numOfDaysInPrevMonth: prevDays,
    month: month0,
    year,
    calendarItems: items,
  };
}

const GEAR = [
  {
    gearPk: 41_220_871,
    displayName: "Daily Trainer",
    customMakeModel: "Daily Trainer",
    begin: 300,
    status: "active",
    maximumMeters: 800_000,
  },
  {
    gearPk: 41_220_933,
    displayName: "Race Shoe",
    customMakeModel: "Race Shoe",
    begin: 95,
    status: "active",
    maximumMeters: 500_000,
  },
  {
    gearPk: 39_104_512,
    displayName: "Old Daily Trainer",
    customMakeModel: "Daily Trainer",
    begin: 420,
    status: "retired",
    maximumMeters: 800_000,
  },
];

function gearItem(w: World, g: (typeof GEAR)[number]) {
  const begin = localMs(addDays(w.today, -g.begin), 12 * 3600);
  return {
    gearPk: g.gearPk,
    uuid: `0f1e2d3c-4b5a-4968-8776-${String(g.gearPk).padStart(12, "0")}`,
    userProfilePk: PERSONA.profileId,
    gearMakeName: "Other",
    gearModelName: "Unknown Shoes",
    gearTypeName: "Shoes",
    gearStatusName: g.status,
    displayName: g.displayName,
    customMakeModel: g.customMakeModel,
    imageNameLarge: null,
    imageNameMedium: null,
    imageNameSmall: null,
    dateBegin: gmtIso(begin),
    dateEnd: g.status === "retired" ? gmtIso(localMs(addDays(w.today, -300), 12 * 3600)) : null,
    maximumMeters: g.maximumMeters,
    notified: false,
    createDate: gmtIso(begin),
    updateDate: gmtIso(begin + 86_400_000 * 3),
  };
}

function gearForRun(w: World, run: DemoRun) {
  const daysAgo = dayDiff(run.plan.date, w.today);
  if (daysAgo > 300) return GEAR[2]!;
  const fast = run.plan.kind === "tempo" || run.plan.kind === "intervals";
  return fast && daysAgo <= 95 ? GEAR[1]! : GEAR[0]!;
}

// ── Devices ───────────────────────────────────────────

const DEVICE = {
  appSupport: true,
  applicationKey: "forerunner265",
  deviceTypePk: PERSONA.deviceTypePk,
  bestInClassVideoLink: null,
  bluetoothClassicDevice: false,
  bluetoothLowEnergyDevice: true,
  deviceCategories: ["FITNESS", "RUNNING", "WELLNESS"],
  deviceEmbedVideoLink: null,
  deviceSettingsFile: null,
  gcmSettingsFile: null,
  deviceVideoPageLink: null,
  displayOrder: 0,
  golfDisplayOrder: 0,
  hasOpticalHeartRate: true,
  highlighted: false,
  hybrid: true,
  imageUrl: null,
  minGCMAndroidVersion: 7646,
  minGCMWindowsVersion: 99999,
  minGCMiOSVersion: 105570,
  minGCMHarmonyVersion: 99999,
  minGolfAppiOSVersion: 0,
  minGolfAppAndroidVersion: 0,
  partNumber: "006-B4257-00",
  primary: true,
  productDisplayName: PERSONA.device,
  deviceTags: null,
  productSku: "010-02810-00",
  wasp: false,
  weightScale: false,
  wellness: false,
  wifi: true,
  hasPowerButton: true,
  deviceTypeSimpleName: PERSONA.device,
  unitId: PERSONA.deviceId,
  deviceId: PERSONA.deviceId,
  displayName: PERSONA.device,
  deviceStatus: "active",
  currentFirmwareVersion: "21.19",
  registeredDate: localMs("2025-06-14", 12 * 3600),
  actualProductSku: "010-02810-00",
};

// ── Personal records ──────────────────────────────────

function personalRecords(w: World) {
  const best = (pred: (r: DemoRun) => boolean, score: (r: DemoRun) => number, lower = true) =>
    w.runs.filter(pred).reduce<DemoRun | null>((b, r) => {
      if (!b) return r;
      return (lower ? score(r) < score(b) : score(r) > score(b)) ? r : b;
    }, null);
  const record = (typeId: number, run: DemoRun | null, value: number, idOffset: number) =>
    run && {
      id: 4_100_220_000 + idOffset,
      typeId,
      status: "ACCEPTED",
      activityId: run.plan.id,
      activityName: run.plan.name,
      activityType: "running",
      activityStartDateTimeInGMT: run.plan.startMs,
      actStartDateTimeInGMTFormatted: gmtIso(run.plan.startMs),
      activityStartDateTimeLocal: localEpoch(run.plan.startMs),
      activityStartDateTimeLocalFormatted: localIso(run.plan.startMs),
      value: round(value, 3),
      prStartTimeGmt: run.plan.startMs,
      prStartTimeGmtFormatted: gmtIso(run.plan.startMs),
      prStartTimeLocal: localEpoch(run.plan.startMs),
      prStartTimeLocalFormatted: localIso(run.plan.startMs),
      prTypeLabelKey: null,
      poolLengthUnit: null,
    };
  const fastest1k = best(
    (r) => r.summary.fastest1k !== null,
    (r) => r.summary.fastest1k!,
  );
  const pace = (r: DemoRun) => 1 / r.summary.averageSpeed;
  const best5k = best(
    (r) => r.summary.distance >= 5000 && r.plan.kind !== "long",
    (r) => pace(r),
  );
  const best10k = best(
    (r) => r.summary.distance >= 10_000,
    (r) => pace(r),
  );
  const bestHalf = best(
    (r) => r.summary.distance >= 21_097,
    (r) => pace(r),
  );
  const longest = best(
    () => true,
    (r) => r.summary.distance,
    false,
  );
  const stepsDay = w.days.reduce((b, d) => (d.steps > b.steps ? d : b), w.days[0]!);
  // Race-effort 5K/10K: a little quicker than any training average
  const v5 = best5k ? (5000 / best5k.summary.averageSpeed) * 0.93 : 0;
  const v10 = best10k ? (10_000 / best10k.summary.averageSpeed) * 0.95 : 0;
  return [
    record(1, fastest1k, fastest1k?.summary.fastest1k ?? 0, 1),
    record(2, fastest1k, (fastest1k?.summary.fastest1k ?? 0) * 1.64, 2),
    record(3, best5k, v5, 3),
    record(4, best10k, v10, 4),
    record(5, bestHalf, bestHalf ? 21_097.5 / bestHalf.summary.averageSpeed : 0, 5),
    record(7, longest, longest?.summary.distance ?? 0, 7),
    {
      ...record(
        12,
        w.runs.find((r) => r.plan.date === stepsDay.date) ?? longest,
        stepsDay.steps,
        12,
      ),
      activityId: null,
      activityName: null,
      activityType: null,
    },
  ].filter(Boolean);
}

// ── Race predictions (consistent with VO₂ max) ────────

function racePredictions(w: World) {
  const vo2 = w.days.at(-1)!.vo2Latest;
  const t5k = Math.round(1300 - (vo2 - 51) * 38);
  const riegel = (km: number) => Math.round(t5k * (km / 5) ** 1.06);
  return {
    userId: PERSONA.profileId,
    fromCalendarDate: null,
    toCalendarDate: null,
    calendarDate: w.today,
    time5K: t5k,
    time10K: riegel(10),
    timeHalfMarathon: riegel(21.0975),
    timeMarathon: riegel(42.195),
  };
}

// ── Routes ────────────────────────────────────────────

const q = (params: URLSearchParams, k: string) => {
  const v = params.get(k);
  if (v === null) throw new HttpError(400, `Missing ${k}`);
  return v;
};

function routes(): Route[] {
  const w = () => getWorld();
  return [
    {
      method: "GET",
      path: /^\/userprofile-service\/socialProfile$/,
      schema: "userProfile",
      handle: () => ({
        id: PERSONA.profileId,
        profileId: PERSONA.profileId,
        garminGUID: PERSONA.garminGUID,
        displayName: PERSONA.displayName,
        fullName: PERSONA.fullName,
        userName: PERSONA.userName,
        profileImageType: null,
        profileImageUrlLarge: null,
        profileImageUrlMedium: null,
        profileImageUrlSmall: null,
        hasPremiumSocialIcon: false,
        location: null,
        favoriteActivityTypes: ["running"],
        runningTrainingSpeed: round(1000 / thresholdPace(1), 3),
        cyclingTrainingSpeed: 0,
        favoriteCyclingActivityTypes: [],
        cyclingClassification: null,
        cyclingMaxAvgPower: 0,
        swimmingTrainingSpeed: 0,
        profileVisibility: "private",
        activityStartVisibility: "private",
        activityMapVisibility: "private",
        courseVisibility: "private",
        activityHeartRateVisibility: "private",
        activityPowerVisibility: "private",
        badgeVisibility: "private",
        showAge: false,
        showWeight: false,
        showHeight: false,
        showWeightClass: false,
        showAgeRange: false,
        showGender: false,
        showActivityClass: false,
        showVO2Max: false,
        showPersonalRecords: true,
        showLast12Months: true,
        showLifetimeTotals: true,
        showUpcomingEvents: true,
        showRecentFavorites: true,
        showRecentDevice: true,
        showRecentGear: false,
        showBadges: true,
        userRoles: ["SCOPE_ATP_READ", "SCOPE_CONNECT_READ", "SCOPE_CONNECT_WRITE"],
        nameApproved: true,
        userProfileFullName: PERSONA.fullName,
        makeGolfScorecardsPrivate: true,
        allowGolfLiveScoring: false,
        allowGolfScoringByConnections: true,
        userLevel: 4,
        userPoint: 412,
        levelUpdateDate: gmtIso(localMs(addDays(w().today, -60), 9 * 3600)),
        levelIsViewed: true,
        levelPointThreshold: 600,
        userPointOffset: 0,
        userPro: false,
      }),
    },
    {
      method: "GET",
      path: /^\/userprofile-service\/userprofile\/user-settings$/,
      schema: "userSettings",
      handle: () => {
        const last = w().weighIns.at(-1);
        return {
          id: PERSONA.profileId,
          userData: {
            gender: "MALE",
            weight: Math.round((last?.kg ?? 68) * 1000),
            height: PERSONA.heightCm,
            timeFormat: "time_twenty_four_hr",
            birthDate: PERSONA.birthDate,
            measurementSystem: "metric",
            activityLevel: null,
            handedness: "RIGHT",
            powerFormat: {
              formatId: 30,
              formatKey: "watt",
              minFraction: 0,
              maxFraction: 0,
              groupingUsed: true,
              displayFormat: null,
            },
            heartRateFormat: {
              formatId: 21,
              formatKey: "bpm",
              minFraction: 0,
              maxFraction: 0,
              groupingUsed: false,
              displayFormat: null,
            },
            firstDayOfWeek: { dayId: 2, dayName: "monday", sortOrder: 2, isPossibleFirstDay: true },
            vo2MaxRunning: Math.round(w().days.at(-1)!.vo2Latest),
            vo2MaxCycling: null,
            lactateThresholdSpeed: round(1000 / thresholdPace(1) / 10, 4),
            lactateThresholdHeartRate: 168,
            diveNumber: null,
            intensityMinutesCalcMethod: "AUTO",
            moderateIntensityMinutesHrZone: 3,
            vigorousIntensityMinutesHrZone: 4,
            hydrationMeasurementUnit: "milliliter",
            hydrationContainers: [],
            hydrationAutoGoalEnabled: true,
            firstbeatMaxStressScore: null,
            firstbeatCyclingLtTimestamp: null,
            firstbeatRunningLtTimestamp: null,
            thresholdHeartRateAutoDetected: true,
            ftpAutoDetected: null,
            trainingStatusPausedDate: null,
            weatherLocation: {
              useFixedLocation: false,
              latitude: null,
              longitude: null,
              locationName: null,
              isoCountryCode: null,
              postalCode: null,
            },
            golfDistanceUnit: "statute_us",
            golfElevationUnit: null,
            golfSpeedUnit: null,
            externalBottomTime: null,
            availableTrainingDays: [
              "MONDAY",
              "TUESDAY",
              "WEDNESDAY",
              "THURSDAY",
              "FRIDAY",
              "SATURDAY",
              "SUNDAY",
            ],
            preferredLongTrainingDays: ["SUNDAY"],
          },
          userSleep: {
            sleepTime: 82_800,
            defaultSleepTime: false,
            wakeTime: 23_400,
            defaultWakeTime: false,
          },
          connectDate: null,
          sourceType: null,
          userSleepWindows: [
            {
              sleepWindowFrequency: "DAILY",
              startSleepTimeSecondsFromMidnight: 82_800,
              endSleepTimeSecondsFromMidnight: 23_400,
            },
          ],
        };
      },
    },
    {
      method: "GET",
      path: /^\/usersummary-service\/usersummary\/daily$/,
      schema: "userSummary",
      handle: (_, params) => userSummary(w(), q(params, "calendarDate")),
    },
    {
      method: "GET",
      path: /^\/usersummary-service\/usersummary\/hydration\/daily\/(\d{4}-\d{2}-\d{2})$/,
      schema: "hydration",
      handle: ([, date]) => {
        const day = dayOrNull(w(), date!);
        const sweat = day
          ? Math.round(day.runs.reduce((s, r) => s + r.summary.duration / 3.6, 0))
          : null;
        return {
          userId: PERSONA.profileId,
          calendarDate: date,
          valueInML: null,
          goalInML: 2500 + (sweat ?? 0),
          dailyAverageinML: null,
          lastEntryTimestampLocal: null,
          sweatLossInML: sweat,
          activityIntakeInML: null,
        };
      },
    },
    {
      method: "GET",
      path: /^\/usersummary-service\/stats\/steps\/daily\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/,
      schema: "steps",
      handle: ([, s, e]) => {
        return daysIn(w(), s!, e!).map((d) => ({
          calendarDate: d.date,
          totalSteps: d.steps,
          totalDistance: Math.round(
            d.walkMeters + d.runs.reduce((x, r) => x + r.summary.distance, 0),
          ),
          stepGoal: d.stepGoal,
        }));
      },
    },
    {
      method: "GET",
      path: /^\/usersummary-service\/stats\/steps\/weekly\/(\d{4}-\d{2}-\d{2})\/(\d+)$/,
      schema: "weeklySteps",
      handle: ([, end, weeks]) =>
        Array.from({ length: Number(weeks) }, (_, k) => {
          const wkStart = addDays(end!, -7 * (Number(weeks) - k) + 1);
          const ds = daysIn(w(), wkStart, addDays(wkStart, 6));
          const total = ds.reduce((s, d) => s + d.steps, 0);
          const dist = ds.reduce(
            (s, d) => s + d.walkMeters + d.runs.reduce((x, r) => x + r.summary.distance, 0),
            0,
          );
          return {
            calendarDate: wkStart,
            values: {
              totalSteps: total,
              averageSteps: ds.length ? round(total / ds.length, 4) : 0,
              wellnessDataDaysCount: ds.length,
              averageDistance: ds.length ? round(dist / ds.length, 4) : 0,
              totalDistance: Math.round(dist),
            },
          };
        }).filter((x) => x.values.wellnessDataDaysCount > 0),
    },
    {
      method: "GET",
      path: /^\/usersummary-service\/stats\/stress\/weekly\/(\d{4}-\d{2}-\d{2})\/(\d+)$/,
      schema: "weeklyStress",
      handle: ([, end, weeks]) =>
        Array.from({ length: Number(weeks) }, (_, k) => {
          const wkStart = addDays(end!, -7 * (Number(weeks) - k) + 1);
          const ds = daysIn(w(), wkStart, addDays(wkStart, 6));
          return {
            calendarDate: wkStart,
            value: ds.length ? Math.round(mean(ds.map((d) => d.stressAvg))) : null,
          };
        }).filter((x) => x.value !== null),
    },
    {
      method: "GET",
      path: /^\/usersummary-service\/stats\/stress\/daily\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/,
      schema: "dailyStressStats",
      handle: ([, s, e]) => {
        return daysIn(w(), s!, e!).map((d) => {
          const u = userSummary(w(), d.date);
          return {
            calendarDate: d.date,
            values: {
              highStressDuration: u.highStressDuration,
              lowStressDuration: u.lowStressDuration,
              overallStressLevel: d.stressAvg,
              restStressDuration: u.restStressDuration,
              mediumStressDuration: u.mediumStressDuration,
            },
          };
        });
      },
    },
    {
      method: "GET",
      path: /^\/usersummary-service\/stats\/im\/weekly\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/,
      schema: "weeklyIntensityMinutes",
      handle: ([, s, e]) => {
        const out = [];
        for (let wk = mondayOf(s!); wk <= e!; wk = addDays(wk, 7)) {
          const ds = daysIn(w(), wk, addDays(wk, 6));
          if (!ds.length) continue;
          out.push({
            calendarDate: wk,
            weeklyGoal: 150,
            moderateValue: ds.reduce((x, d) => x + d.moderateMinutes, 0),
            vigorousValue: ds.reduce((x, d) => x + d.vigorousMinutes, 0),
          });
        }
        return out;
      },
    },
    {
      method: "GET",
      path: /^\/wellness-service\/wellness\/dailyHeartRate$/,
      schema: "heartRates",
      handle: (_, params) => {
        const date = q(params, "date");
        const day = dayOrNull(w(), date);
        if (!day)
          return { userProfilePK: PERSONA.profileId, calendarDate: date, heartRateValues: null };
        return {
          userProfilePK: PERSONA.profileId,
          calendarDate: date,
          ...timestamps(day),
          maxHeartRate: day.maxHr,
          minHeartRate: day.minHr,
          restingHeartRate: day.rhr,
          lastSevenDaysAvgRestingHeartRate: day.rhr7,
          heartRateValueDescriptors: [
            { index: 0, key: "timestamp" },
            { index: 1, key: "heartrate" },
          ],
          heartRateValues: heartRateValues(w(), day),
        };
      },
    },
    {
      method: "GET",
      path: /^\/wellness-service\/wellness\/dailySleepData$/,
      schema: "sleep",
      handle: (_, params) => sleepData(w(), q(params, "date")),
    },
    {
      method: "GET",
      path: /^\/wellness-service\/wellness\/dailyStress\/(\d{4}-\d{2}-\d{2})$/,
      schema: "stress",
      handle: ([, date]) => {
        const day = dayOrNull(w(), date!);
        if (!day)
          return { userProfilePK: PERSONA.profileId, calendarDate: date, stressValuesArray: null };
        return {
          userProfilePK: PERSONA.profileId,
          calendarDate: date,
          ...timestamps(day),
          maxStressLevel: day.stressMax,
          avgStressLevel: day.stressAvg,
          stressChartValueOffset: 1,
          stressChartYAxisOrigin: -1,
          stressValueDescriptorsDTOList: [
            { index: 0, key: "timestamp" },
            { index: 1, key: "stressLevel" },
          ],
          stressValuesArray: stressValues(w(), day),
          bodyBatteryValueDescriptorsDTOList: [
            { bodyBatteryValueDescriptorIndex: 0, bodyBatteryValueDescriptorKey: "timestamp" },
            {
              bodyBatteryValueDescriptorIndex: 1,
              bodyBatteryValueDescriptorKey: "bodyBatteryStatus",
            },
            {
              bodyBatteryValueDescriptorIndex: 2,
              bodyBatteryValueDescriptorKey: "bodyBatteryLevel",
            },
            {
              bodyBatteryValueDescriptorIndex: 3,
              bodyBatteryValueDescriptorKey: "bodyBatteryVersion",
            },
          ],
          bodyBatteryValuesArray: bodyBatteryValues(w(), day).map(([ms, v]) => [
            ms,
            "MEASURED",
            v,
            3,
          ]),
        };
      },
    },
    {
      method: "GET",
      path: /^\/wellness-service\/wellness\/bodyBattery\/reports\/daily$/,
      schema: "bodyBattery",
      handle: (_, params) => {
        const s = q(params, "startDate");
        const e = q(params, "endDate");
        return daysIn(w(), s, e).map((d) => bodyBatteryReport(w(), d));
      },
    },
    {
      method: "GET",
      path: /^\/wellness-service\/wellness\/bodyBattery\/events\/(\d{4}-\d{2}-\d{2})$/,
      schema: "bodyBatteryEvents",
      handle: ([, date]) => {
        const day = dayOrNull(w(), date!);
        if (!day) return [];
        const n = day.night;
        const event = (
          type: string,
          start: number,
          durMs: number,
          impact: number,
          feedback: string,
        ) => ({
          event: {
            eventType: type,
            eventStartTimeGmt: gmtIso(start),
            timezoneOffset: -new Date(start).getTimezoneOffset() * 60_000,
            durationInMilliseconds: durMs,
            bodyBatteryImpact: impact,
            feedbackType: feedback,
            shortFeedback: feedback,
          },
          activityName: null,
          activityType: null,
          activityId: null,
          averageStress: null,
          stressValuesArray: null,
          bodyBatteryValuesArray: null,
        });
        return [
          event(
            "SLEEP",
            n.start,
            n.end - n.start,
            day.bb.atWake - day.bb.midnight + 4,
            "SLEEP_RESTFUL",
          ),
          ...day.runs.map((r) => ({
            ...event(
              "ACTIVITY",
              r.plan.startMs,
              r.summary.elapsedDuration * 1000,
              -Math.round(r.summary.trainingLoad / 6),
              "EXERCISE_AEROBIC",
            ),
            activityName: r.plan.name,
            activityType: "running",
            activityId: r.plan.id,
          })),
        ];
      },
    },
    {
      method: "GET",
      path: /^\/wellness-service\/wellness\/daily\/respiration\/(\d{4}-\d{2}-\d{2})$/,
      schema: "respiration",
      handle: ([, date]) => {
        const day = dayOrNull(w(), date!);
        if (!day) return { userProfilePK: PERSONA.profileId, calendarDate: date };
        const values = respirationValues(w(), day);
        const next = w().byDate.get(addDays(date!, 1))?.night;
        const vs = values.map(([, v]) => v);
        return {
          userProfilePK: PERSONA.profileId,
          calendarDate: date,
          ...timestamps(day),
          sleepStartTimestampGMT: gmtIso(day.night.start),
          sleepEndTimestampGMT: gmtIso(day.night.end),
          sleepStartTimestampLocal: localIso(day.night.start),
          sleepEndTimestampLocal: localIso(day.night.end),
          tomorrowSleepStartTimestampGMT: next ? gmtIso(next.start) : null,
          tomorrowSleepEndTimestampGMT: next ? gmtIso(next.end) : null,
          tomorrowSleepStartTimestampLocal: next ? localIso(next.start) : null,
          tomorrowSleepEndTimestampLocal: next ? localIso(next.end) : null,
          lowestRespirationValue: Math.min(...vs),
          highestRespirationValue: Math.max(...vs),
          avgWakingRespirationValue: 16,
          avgSleepRespirationValue: Math.round(day.night.avgRespiration),
          avgTomorrowSleepRespirationValue: next ? Math.round(next.avgRespiration) : null,
          respirationValueDescriptorsDTOList: [
            { index: 0, key: "timestamp" },
            { index: 1, key: "respiration" },
          ],
          respirationValuesArray: values,
          respirationAveragesValueDescriptorDTOList: [
            {
              respirationAveragesValueDescriptorIndex: 0,
              respirationAveragesValueDescriptionKey: "timestamp",
            },
            {
              respirationAveragesValueDescriptorIndex: 1,
              respirationAveragesValueDescriptionKey: "averageRespirationValue",
            },
            {
              respirationAveragesValueDescriptorIndex: 2,
              respirationAveragesValueDescriptionKey: "highRespirationValue",
            },
            {
              respirationAveragesValueDescriptorIndex: 3,
              respirationAveragesValueDescriptionKey: "lowRespirationValue",
            },
          ],
          respirationAveragesValuesArray: Array.from(
            { length: Math.floor(values.length / 6) },
            (_, h) => {
              const hour = vs.slice(h * 6, h * 6 + 6);
              return [
                values[h * 6]![0],
                round(mean(hour), 1),
                Math.max(...hour),
                Math.min(...hour),
              ];
            },
          ),
          respirationVersion: 200,
        };
      },
    },
    {
      method: "GET",
      path: /^\/wellness-service\/wellness\/daily\/spo2\/(\d{4}-\d{2}-\d{2})$/,
      schema: "spo2",
      handle: ([, date]) => {
        const day = dayOrNull(w(), date!);
        if (!day) return { userProfilePK: PERSONA.profileId, calendarDate: date };
        const next = w().byDate.get(addDays(date!, 1))?.night;
        const week = daysIn(w(), addDays(date!, -6), date!);
        return {
          userProfilePK: PERSONA.profileId,
          calendarDate: date,
          ...timestamps(day),
          sleepStartTimestampGMT: gmtIso(day.night.start),
          sleepEndTimestampGMT: gmtIso(day.night.end),
          sleepStartTimestampLocal: localIso(day.night.start),
          sleepEndTimestampLocal: localIso(day.night.end),
          tomorrowSleepStartTimestampGMT: next ? gmtIso(next.start) : null,
          tomorrowSleepEndTimestampGMT: next ? gmtIso(next.end) : null,
          tomorrowSleepStartTimestampLocal: next ? localIso(next.start) : null,
          tomorrowSleepEndTimestampLocal: next ? localIso(next.end) : null,
          averageSpO2: day.spo2,
          lowestSpO2: day.spo2 - 4,
          lastSevenDaysAvgSpO2: round(mean(week.map((d) => d.spo2)), 1),
          latestSpO2: day.spo2,
          latestSpO2TimestampGMT: gmtIso(day.night.end),
          latestSpO2TimestampLocal: localIso(day.night.end),
          avgSleepSpO2: day.spo2,
          avgTomorrowSleepSpO2: null,
          spO2ValueDescriptorsDTOList: null,
          spO2SingleValues: null,
          continuousReadingDTOList: null,
          spO2HourlyAverages: null,
        };
      },
    },
    {
      method: "GET",
      path: /^\/wellness-service\/wellness\/daily\/im\/(\d{4}-\d{2}-\d{2})$/,
      schema: "intensityMinutes",
      handle: ([, date]) => {
        const day = dayOrNull(w(), date!);
        if (!day) return { userProfilePK: PERSONA.profileId, calendarDate: date };
        const week = daysIn(w(), mondayOf(date!), date!);
        const mod = week.reduce((s, d) => s + d.moderateMinutes, 0);
        const vig = week.reduce((s, d) => s + d.vigorousMinutes, 0);
        const before = week.slice(0, -1);
        const start = before.reduce((s, d) => s + d.moderateMinutes + 2 * d.vigorousMinutes, 0);
        return {
          userProfilePK: PERSONA.profileId,
          calendarDate: date,
          ...timestamps(day),
          weeklyModerate: mod,
          weeklyVigorous: vig,
          weeklyTotal: mod + 2 * vig,
          weekGoal: 150,
          dayOfGoalMet: null,
          startDayMinutes: start,
          endDayMinutes: mod + 2 * vig,
          moderateMinutes: day.moderateMinutes,
          vigorousMinutes: day.vigorousMinutes,
          imValueDescriptorsDTOList: null,
          imValuesArray: null,
        };
      },
    },
    {
      method: "GET",
      path: /^\/wellness-service\/wellness\/floorsChartData\/daily\/(\d{4}-\d{2}-\d{2})$/,
      schema: "floors",
      handle: ([, date]) => {
        const day = dayOrNull(w(), date!);
        if (!day) return { floorsValueDescriptorDTOList: [], floorValuesArray: [] };
        const rng = Rng.of("floors", date!);
        const [from, to] = dayWindow(day);
        const values: [string, string, number, number][] = [];
        let left = day.floors;
        for (let ms = from + 7 * 3_600_000; ms < to && left > 0; ms += 15 * 60_000) {
          if (!rng.chance(0.18)) continue;
          const up = Math.min(left, rng.int(1, 3));
          left -= up;
          values.push([gmtIso(ms), gmtIso(ms + 15 * 60_000), up, rng.int(0, up)]);
        }
        return {
          ...timestamps(day),
          floorsValueDescriptorDTOList: [
            { index: 0, key: "startTimeGMT" },
            { index: 1, key: "endTimeGMT" },
            { index: 2, key: "floorsAscended" },
            { index: 3, key: "floorsDescended" },
          ],
          floorValuesArray: values,
        };
      },
    },
    {
      method: "GET",
      path: /^\/userstats-service\/wellness\/daily\/([^/]+)$/,
      schema: "restingHeartRate",
      handle: ([, name], params) => {
        if (name !== PERSONA.displayName) throw new HttpError(403, "Not your profile");
        const s = q(params, "fromDate");
        const e = q(params, "untilDate");
        return {
          userProfileId: PERSONA.profileId,
          statisticsStartDate: s,
          statisticsEndDate: e,
          allMetrics: {
            metricsMap: {
              WELLNESS_RESTING_HEART_RATE: daysIn(w(), s, e).map((d) => ({
                value: d.rhr,
                calendarDate: d.date,
              })),
            },
          },
          groupedMetrics: null,
        };
      },
    },
    {
      method: "GET",
      path: /^\/weight-service\/weight\/dateRange$/,
      schema: "bodyComposition",
      handle: (_, params) => {
        const s = q(params, "startDate");
        const e = q(params, "endDate");
        const list = w()
          .weighIns.filter((x) => x.date >= s && x.date <= e)
          .map(weightEntry);
        return {
          startDate: s,
          endDate: e,
          dateWeightList: list,
          totalAverage: weightAverage(list, s, e),
        };
      },
    },
    {
      method: "GET",
      path: /^\/weight-service\/weight\/range\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/,
      schema: "weighIns",
      handle: ([, s, e]) => {
        const all = w().weighIns;
        const inRange = all.filter((x) => x.date >= s! && x.date <= e!);
        const before = [...all].reverse().find((x) => x.date < s!);
        const after = all.find((x) => x.date > e!);
        return {
          dailyWeightSummaries: [...inRange].reverse().map((x) => ({
            summaryDate: x.date,
            numOfWeightEntries: 1,
            minWeight: Math.round(x.kg * 1000),
            maxWeight: Math.round(x.kg * 1000),
            latestWeight: weightEntry(x),
            allWeightMetrics: [weightEntry(x)],
          })),
          totalAverage: weightAverage(inRange.map(weightEntry), s!, e!),
          previousDateWeight: before ? weightEntry(before) : null,
          nextDateWeight: after ? weightEntry(after) : null,
        };
      },
    },
    {
      method: "GET",
      path: /^\/activitylist-service\/activities\/search\/activities$/,
      schema: (params) => (params.has("startDate") ? "activitiesByDate" : "activities"),
      handle: (_, params) => {
        const start = Number(params.get("start") ?? 0);
        const limit = Number(params.get("limit") ?? 20);
        const s = params.get("startDate");
        const e = params.get("endDate");
        const type = params.get("activityType");
        let runs = [...w().runs].reverse();
        if (s) runs = runs.filter((r) => r.plan.date >= s);
        if (e) runs = runs.filter((r) => r.plan.date <= e);
        if (type && type !== "running") runs = [];
        return runs.slice(start, start + limit).map((r) => activityListItem(w(), r));
      },
    },
    {
      method: "GET",
      path: /^\/activity-service\/activity\/activityTypes$/,
      schema: "activityTypes",
      handle: () =>
        (
          [
            [1, "running", 17],
            [2, "cycling", 17],
            [3, "hiking", 17],
            [4, "other", 17],
            [5, "mountain_biking", 2],
            [6, "trail_running", 1],
            [7, "street_running", 1],
            [8, "track_running", 1],
            [9, "walking", 17],
            [10, "road_biking", 2],
            [13, "strength_training", 29],
            [17, "all", null],
            [18, "treadmill_running", 1],
            [25, "indoor_cycling", 2],
            [26, "swimming", 17],
            [27, "lap_swimming", 26],
            [28, "open_water_swimming", 26],
            [29, "fitness_equipment", 17],
            [30, "elliptical", 29],
            [43, "yoga", 29],
          ] as const
        ).map(([typeId, typeKey, parentTypeId]) => ({
          typeId,
          typeKey,
          parentTypeId,
          isHidden: false,
          restricted: false,
          trimmable: typeKey !== "all",
        })),
    },
    {
      method: "GET",
      path: /^\/activity-service\/activity\/(\d+)$/,
      schema: "activityDetails",
      handle: ([, id]) => activityDetails(runById(w(), id!)),
    },
    {
      method: "GET",
      path: /^\/activity-service\/activity\/(\d+)\/splits$/,
      schema: "activitySplits",
      handle: ([, id]) => {
        const run = runById(w(), id!);
        const { laps } = detailsOf(run);
        const end = run.plan.startMs + run.summary.elapsedDuration * 1000;
        return {
          activityId: run.plan.id,
          lapDTOs: laps.map((l, i) => lapDTO(run, l, i)),
          eventDTOs: [
            {
              startTimeGMT: gmtIso(run.plan.startMs),
              startTimeGMTDoubleValue: run.plan.startMs,
              sectionTypeDTO: { id: 1, key: "timerTrigger", sectionTypeKey: "timerTrigger" },
            },
            {
              startTimeGMT: gmtIso(end),
              startTimeGMTDoubleValue: end,
              sectionTypeDTO: { id: 2, key: "timerTrigger", sectionTypeKey: "timerTrigger" },
            },
          ],
        };
      },
    },
    {
      method: "GET",
      path: /^\/activity-service\/activity\/(\d+)\/typedsplits$/,
      schema: "activityTypedSplits",
      handle: ([, id]) => {
        const run = runById(w(), id!);
        const s = run.summary;
        return {
          activityId: run.plan.id,
          activityUUID: { uuid: uuidOf(run.plan.id) },
          splits: [
            {
              startTimeLocal: localIso(run.plan.startMs),
              startTimeGMT: gmtIso(run.plan.startMs),
              distance: s.distance,
              duration: s.duration,
              movingDuration: s.movingDuration,
              elapsedDuration: s.elapsedDuration,
              elevationGain: s.elevationGain,
              elevationLoss: s.elevationLoss,
              averageSpeed: s.averageSpeed,
              averageMovingSpeed: round(s.distance / s.movingDuration, 3),
              maxSpeed: s.maxSpeed,
              calories: s.calories,
              bmrCalories: s.bmrCalories,
              averageHR: s.averageHR,
              maxHR: s.maxHR,
              averageRunCadence: s.averageCadence,
              maxRunCadence: s.maxCadence,
              averageTemperature: watchTemp(run),
              maxTemperature: watchTemp(run) + 3,
              minTemperature: watchTemp(run) - 2,
              averagePower: s.averagePower,
              maxPower: s.maxPower,
              normalizedPower: s.normPower,
              strideLength: s.strideLength,
              totalExerciseReps: 0,
              avgVerticalSpeed: 0,
              avgGradeAdjustedSpeed: s.averageSpeed,
              avgElapsedDurationVerticalSpeed: 0,
              type: "RWD_RUN",
              messageIndex: 0,
              endTimeGMT: gmtIso(run.plan.startMs + s.elapsedDuration * 1000),
              startElevation: s.minElevation,
            },
          ],
        };
      },
    },
    {
      method: "GET",
      path: /^\/activity-service\/activity\/(\d+)\/hrTimeInZones$/,
      schema: "activityHrZones",
      handle: ([, id]) => {
        const run = runById(w(), id!);
        return run.summary.zoneSecs.map((secs, i) => ({
          zoneNumber: i + 1,
          secsInZone: secs,
          zoneLowBoundary: run.summary.zoneFloors[i],
        }));
      },
    },
    {
      method: "GET",
      path: /^\/activity-service\/activity\/(\d+)\/details$/,
      schema: "activityChartDetails",
      handle: ([, id], params) =>
        chartDetails(runById(w(), id!), Math.max(2, Number(params.get("maxChartSize") ?? 2000))),
    },
    {
      method: "GET",
      path: /^\/activity-service\/activity\/(\d+)\/weather$/,
      schema: "activityWeather",
      handle: ([, id]) => {
        const run = runById(w(), id!);
        const rng = Rng.of("weather", run.plan.id);
        const c = run.plan.tempC;
        const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
        const dir = rng.int(0, 7);
        return {
          issueDate: gmtIso(run.plan.startMs - 600_000).replace(/\.0$/, ".000+00:00"),
          temp: toF(c),
          apparentTemp: toF(c - 1.5),
          dewPoint: toF(c - rng.range(3, 8)),
          relativeHumidity: rng.int(55, 88),
          windDirection: dir * 45,
          windDirectionCompassPoint: dirs[dir]!.toLowerCase(),
          windSpeed: rng.int(2, 14),
          windGust: null,
          latitude: null,
          longitude: null,
          weatherStationDTO: null,
          weatherTypeDTO: {
            weatherTypePk: null,
            desc: rng.pick(["Partly Cloudy", "Mostly Cloudy", "Fair", "Cloudy"]),
            image: null,
          },
        };
      },
    },
    {
      method: "GET",
      path: /^\/activity-service\/activity\/(\d+)\/exerciseSets$/,
      schema: "activityExerciseSets",
      handle: ([, id]) => ({ activityId: runById(w(), id!).plan.id, exerciseSets: null }),
    },
    {
      method: "GET",
      path: /^\/gear-service\/gear\/filterGear$/,
      schema: "gear",
      handle: (_, params) => {
        const activityId = params.get("activityId");
        if (activityId) return [gearItem(w(), gearForRun(w(), runById(w(), activityId)))];
        if (Number(params.get("userProfilePk")) !== PERSONA.profileId) return [];
        return GEAR.map((g) => gearItem(w(), g));
      },
    },
    {
      method: "GET",
      path: /^\/metrics-service\/metrics\/trainingreadiness\/(\d{4}-\d{2}-\d{2})$/,
      schema: "trainingReadiness",
      handle: ([, date]) => {
        const day = dayOrNull(w(), date!);
        return day ? [readiness(day)] : [];
      },
    },
    {
      method: "GET",
      path: /^\/mobile-gateway\/usersummary\/trainingstatus\/latest\/(\d{4}-\d{2}-\d{2})$/,
      schema: "trainingStatus",
      handle: ([, date]) => trainingStatus(w(), date!),
    },
    {
      method: "GET",
      path: /^\/mobile-gateway\/usersummary\/trainingstatus\/weekly\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/,
      schema: "trainingStatusRange",
      handle: ([, s, e]) => {
        const ds = daysIn(w(), s!, e!);
        const wrap = (url: string, payload: unknown) => ({
          requestUrl: url,
          statusCode: 200,
          headers: {},
          errorMessage: null,
          payload,
          successful: true,
        });
        return {
          vo2MaxWeeklyStatistics: wrap(`/metrics-service/metrics/maxmet/weekly/${s}/${e}`, {
            userProfileId: PERSONA.profileId,
            statisticsStartDate: s,
            statisticsEndDate: e,
            allMetrics: {
              metricsMap: {
                METRIC_VO2_MAX: ds
                  .filter((d) => d.vo2 !== null)
                  .map((d) => ({ value: d.vo2, calendarDate: d.date })),
              },
            },
          }),
          weeklyTrainingStatus: wrap(`/metrics-service/metrics/trainingstatus/weekly/${s}/${e}`, {
            userId: PERSONA.profileId,
            fromCalendarDate: s,
            toCalendarDate: e,
            showSelector: false,
            recordedDevices: RECORDED_DEVICES,
            reportData: { [PERSONA.deviceId]: ds.map(trainingStatusEntry) },
          }),
        };
      },
    },
    {
      method: "GET",
      path: /^\/hrv-service\/hrv\/daily\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/,
      schema: "hrv",
      handle: ([, s, e]) => ({
        hrvSummaries: daysIn(w(), s!, e!).map(hrvSummary),
        userProfilePk: PERSONA.profileId,
      }),
    },
    {
      method: "GET",
      path: /^\/sleep-service\/stats\/sleep\/daily\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/,
      schema: "sleepStats",
      handle: ([, s, e]) => {
        maxRange(s!, e!);
        const ds = daysIn(w(), s!, e!);
        const secsOfDayLocal = (ms: number) => localEpoch(ms) % 86_400_000;
        return {
          overallStats: {
            averageLocalSleepStartTime: Math.round(
              mean(
                ds.map(
                  (d) => ((secsOfDayLocal(d.night.start) + 43_200_000) % 86_400_000) - 43_200_000,
                ),
              ),
            ),
            averageRespiration: round(mean(ds.map((d) => d.night.avgRespiration)), 1),
            averageBodyBatteryChange: Math.round(mean(ds.map((d) => d.bb.atWake - d.bb.midnight))),
            averageSleepScore: Math.round(mean(ds.map((d) => d.night.score))),
            averageLocalSleepEndTime: Math.round(mean(ds.map((d) => secsOfDayLocal(d.night.end)))),
            averageSleepSeconds: Math.round(mean(ds.map((d) => d.night.sleepSecs))),
            averageRestingHeartRate: Math.round(mean(ds.map((d) => d.rhr))),
          },
          individualStats: ds.map((d) => ({
            calendarDate: d.date,
            values: {
              remTime: d.night.remSecs,
              restingHeartRate: d.rhr,
              totalSleepTimeInSeconds: d.night.sleepSecs,
              respiration: d.night.avgRespiration,
              localSleepEndTimeInMillis: localEpoch(d.night.end),
              deepTime: d.night.deepSecs,
              awakeTime: d.night.awakeSecs,
              sleepScoreQuality:
                d.night.score >= 90
                  ? "EXCELLENT"
                  : d.night.score >= 80
                    ? "GOOD"
                    : d.night.score >= 60
                      ? "FAIR"
                      : "POOR",
              spO2: d.spo2,
              localSleepStartTimeInMillis: localEpoch(d.night.start),
              sleepNeed: 480,
              bodyBatteryChange: d.bb.atWake - d.bb.midnight,
              hrvStatus: d.hrvStatus,
              sleepScore: d.night.score,
              lightTime: d.night.lightSecs,
              hrv7dAverage: d.hrvWeekly,
            },
          })),
        };
      },
    },
    {
      method: "GET",
      path: /^\/metrics-service\/metrics\/maxmet\/daily\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/,
      schema: "vo2Max",
      handle: ([, s, e]) =>
        daysIn(w(), s!, e!)
          .filter((d) => d.vo2 !== null)
          .map(vo2Entry),
    },
    {
      method: "GET",
      path: /^\/metrics-service\/metrics\/racepredictions\/latest\/([^/]+)$/,
      schema: "racePredictions",
      handle: ([, name]) => {
        if (name !== PERSONA.displayName) throw new HttpError(403, "Not your profile");
        return racePredictions(w());
      },
    },
    {
      method: "GET",
      path: /^\/metrics-service\/metrics\/endurancescore$/,
      schema: "enduranceScore",
      handle: (_, params) => enduranceScore(w(), q(params, "calendarDate")),
    },
    {
      method: "GET",
      path: /^\/metrics-service\/metrics\/endurancescore\/stats$/,
      schema: "enduranceScoreRange",
      handle: (_, params) => {
        const s = q(params, "startDate");
        const e = q(params, "endDate");
        const groupMap: Record<string, unknown> = {};
        let max = 0;
        const all: number[] = [];
        for (let wk = addDays(s, -weekday(s)); wk <= e; wk = addDays(wk, 7)) {
          const scores = daysIn(w(), wk, addDays(wk, 6)).map((d) => enduranceValue(w(), d.date));
          if (!scores.length) continue;
          const avg = Math.round(mean(scores));
          max = Math.max(max, ...scores);
          all.push(...scores);
          groupMap[wk] = {
            groupAverage: avg,
            groupMax: Math.max(...scores),
            enduranceContributorDTOList: [
              { activityTypeId: null, group: 0, contribution: 92.4 },
              { activityTypeId: null, group: 8, contribution: 7.6 },
            ],
          };
        }
        return {
          userProfilePK: PERSONA.profileId,
          startDate: s,
          endDate: e,
          avg: all.length ? Math.round(mean(all)) : null,
          max: max || null,
          groupMap,
          enduranceScoreDTO: enduranceScore(w(), e),
        };
      },
    },
    {
      method: "GET",
      path: /^\/metrics-service\/metrics\/hillscore$/,
      schema: "hillScore",
      handle: (_, params) => hillScore(w(), q(params, "calendarDate")),
    },
    {
      method: "GET",
      path: /^\/metrics-service\/metrics\/hillscore\/stats$/,
      schema: "hillScoreRange",
      handle: (_, params) => {
        const s = q(params, "startDate");
        const e = q(params, "endDate");
        const periodAvgScore: Record<string, number | null> = {};
        const list = [];
        for (let wk = addDays(s, -weekday(s)); wk <= e; wk = addDays(wk, 7)) {
          const hs = hillScore(w(), addDays(wk, 6) > w().today ? w().today : addDays(wk, 6));
          periodAvgScore[wk] = hs?.overallScore ?? null;
          if (hs) list.push(hs);
        }
        return {
          userProfilePK: PERSONA.profileId,
          startDate: s,
          endDate: e,
          periodAvgScore,
          maxScore: Math.max(0, ...list.map((h) => h.overallScore)) || null,
          hillScoreDTOList: list,
        };
      },
    },
    {
      method: "GET",
      path: /^\/metrics-service\/metrics\/runningtolerance\/stats$/,
      schema: "runningTolerance",
      handle: () => [],
    },
    {
      method: "GET",
      path: /^\/biometric-service\/biometric\/latestLactateThreshold$/,
      schema: "lactateThreshold",
      handle: () => {
        const ms = localMs(addDays(w().today, -12), 7 * 3600);
        return [
          {
            userProfilePK: PERSONA.profileId,
            version: ms,
            calendarDate: localIso(ms).replace(/\.0$/, ".000"),
            sequence: ms,
            speed: round(1000 / thresholdPace(0.97) / 10, 6),
            hearRate: 168,
            heartRateCycling: null,
            rowSpeed: null,
            heartRateRowing: null,
          },
        ];
      },
    },
    {
      method: "GET",
      path: /^\/biometric-service\/biometric\/latestFunctionalThresholdPower\/CYCLING$/,
      schema: "cyclingFtp",
      handle: () => ({
        userProfilePK: PERSONA.profileId,
        version: null,
        calendarDate: null,
        isStale: true,
        sequence: null,
        sport: "CYCLING",
        functionalThresholdPower: null,
        biometricSourceType: null,
      }),
    },
    {
      method: "GET",
      path: /^\/biometric-service\/heartRateZones$/,
      schema: "heartRateZones",
      handle: () => {
        const rhr = w().days.at(-1)!.rhr7;
        const floors = [0.5, 0.6, 0.7, 0.8, 0.9].map((f) =>
          Math.round(rhr + f * (PERSONA.maxHr - rhr)),
        );
        return ["DEFAULT", "RUNNING"].map((sport) => ({
          trainingMethod: "HR_RESERVE",
          restingHeartRateUsed: rhr,
          lactateThresholdHeartRateUsed: 168,
          zone1Floor: floors[0],
          zone2Floor: floors[1],
          zone3Floor: floors[2],
          zone4Floor: floors[3],
          zone5Floor: floors[4],
          maxHeartRateUsed: PERSONA.maxHr,
          restingHrAutoUpdateUsed: true,
          sport,
          changeState: "UNCHANGED",
        }));
      },
    },
    {
      method: "GET",
      path: /^\/fitnessage-service\/fitnessage\/(\d{4}-\d{2}-\d{2})$/,
      schema: "fitnessAge",
      handle: ([, date]) => {
        const day = dayOrNull(w(), date!) ?? w().days.at(-1)!;
        const weeks = daysIn(w(), addDays(day.date, -27), day.date);
        const vigDays = weeks.filter((d) => d.vigorousMinutes >= 10).length / 4;
        const vigMin = weeks.reduce((s, d) => s + d.vigorousMinutes, 0) / 4;
        const fitnessAge = round(PERSONA.age - 6 - 3 * day.p - (54 - day.rhr) * 0.15, 4);
        return {
          chronologicalAge: PERSONA.age,
          fitnessAge,
          achievableFitnessAge: round(fitnessAge - 1.6, 4),
          previousFitnessAge: round(fitnessAge + 0.2, 4),
          components: {
            vigorousDaysAvg: {
              value: round(vigDays, 1),
              targetValue: 3,
              potentialAge: round(fitnessAge - 0.8, 4),
              priority: 2,
              stale: false,
              numOfWeeksForIm: 4,
            },
            rhr: { value: day.rhr7, stale: false },
            vigorousMinutesAvg: {
              value: round(vigMin, 1),
              targetValue: 75,
              potentialAge: round(fitnessAge - 0.6, 4),
              priority: 3,
              stale: false,
              numOfWeeksForIm: 4,
            },
            bmi: {
              value: 22.2,
              targetValue: 22.2,
              improvementValue: 0,
              potentialAge: fitnessAge,
              priority: 1,
              stale: false,
              lastMeasurementDate: w().weighIns.at(-1)?.date ?? null,
            },
          },
          lastUpdated: gmtIso(day.night.end),
        };
      },
    },
    {
      method: "GET",
      path: /^\/personalrecord-service\/personalrecord\/prs\/([^/]+)$/,
      schema: "personalRecords",
      handle: ([, name]) => {
        if (name !== PERSONA.displayName) throw new HttpError(403, "Not your profile");
        return personalRecords(w());
      },
    },
    {
      method: "GET",
      path: /^\/fitnessstats-service\/activity$/,
      schema: "progressSummary",
      handle: (_, params) => {
        const s = q(params, "startDate");
        const e = q(params, "endDate");
        const metric = params.get("metric") ?? "distance";
        const runs = w().runs.filter((r) => r.plan.date >= s && r.plan.date <= e);
        const value = (r: DemoRun) =>
          metric === "duration"
            ? r.summary.duration * 1000
            : metric === "elevationGain"
              ? r.summary.elevationGain * 100
              : metric === "calories"
                ? r.summary.calories
                : r.summary.distance * 100;
        const vs = runs.map(value);
        return [
          {
            date: addDays(e, 1),
            countOfActivities: runs.length,
            stats: {
              running: {
                [metric]: {
                  count: runs.length,
                  min: vs.length ? Math.min(...vs) : 0,
                  max: vs.length ? Math.max(...vs) : 0,
                  avg: vs.length ? round(mean(vs), 4) : 0,
                  sum: round(
                    vs.reduce((a, b) => a + b, 0),
                    4,
                  ),
                },
              },
            },
          },
        ];
      },
    },
    {
      method: "GET",
      path: /^\/device-service\/deviceregistration\/devices$/,
      schema: "devices",
      handle: () => [DEVICE],
    },
    {
      method: "GET",
      path: /^\/device-service\/deviceservice\/mylastused$/,
      schema: "deviceLastUsed",
      handle: () => ({
        userDeviceId: PERSONA.deviceId,
        userProfileNumber: PERSONA.profileId,
        applicationNumber: PERSONA.deviceTypePk,
        lastUsedDeviceApplicationKey: "forerunner265",
        lastUsedDeviceName: PERSONA.device,
        lastUsedDeviceUploadTime: localMs(w().today, 6.9 * 3600),
        imageUrl: null,
        released: true,
      }),
    },
    {
      method: "GET",
      path: /^\/web-gateway\/device-info\/primary-training-device$/,
      schema: "primaryTrainingDevice",
      handle: () => {
        const weight = {
          displayName: PERSONA.device,
          deviceId: PERSONA.deviceId,
          imageUrl: null,
          weight: 100,
          primaryTrainingCapable: true,
          lhaBackupCapable: true,
          primaryWearableDevice: true,
        };
        return {
          PrimaryTrainingDevice: { deviceId: PERSONA.deviceId },
          WearableDevices: { deviceWeights: [weight], wearableDeviceCount: 1 },
          TrainingStatusOnlyDevices: { deviceWeights: [] },
          PrimaryTrainingDevices: { deviceWeights: [weight], primaryTrainingDeviceCount: 1 },
          RegisteredDevices: [DEVICE],
        };
      },
    },
    {
      method: "GET",
      path: /^\/goal-service\/goal\/goals$/,
      schema: "goals",
      handle: () => [],
    },
    {
      method: "GET",
      path: /^\/trainingplan-service\/trainingplan\/plans$/,
      schema: "trainingPlans",
      handle: () => ({
        trainingPlanList: [],
        searchFilter: {
          ownerId: PERSONA.profileId,
          ownerDisplayName: null,
          trainingLevels: null,
          trainingStatusList: [],
          trainingTypes: null,
          trainingSubTypes: null,
          trainingVersions: null,
          allowedPrivacyList: null,
          locale: null,
          start: 0,
          limit: 25,
          planKey: false,
        },
      }),
    },
    {
      method: "GET",
      path: /^\/calendar-service\/year\/(\d{4})\/month\/(\d{1,2})$/,
      schema: "calendar",
      handle: ([, year, month]) => calendarMonth(w(), Number(year), Number(month)),
    },
    {
      method: "GET",
      path: /^\/workout-service\/workouts$/,
      schema: "workouts",
      handle: (_, params) => {
        const start = Number(params.get("start") ?? 0);
        const limit = Number(params.get("limit") ?? 20);
        return workoutsOf(w())
          .map(workoutSummary)
          .slice(start, start + limit);
      },
    },
    {
      method: "GET",
      path: /^\/workout-service\/workout\/(\d+)$/,
      schema: "workout",
      handle: ([, id]) => workoutDetail(findWorkout(w(), id!)),
    },
    {
      method: "POST",
      path: /^\/workout-service\/workout$/,
      schema: "workout",
      handle: (_, __, body) => {
        const now = Date.now();
        const workout = body as SavedWorkout["workout"];
        const saved: SavedWorkout = {
          workoutId: nextId++,
          key: "easy40",
          workout: { ...workout, author: {} },
          createdMs: now,
          updatedMs: now,
        };
        created.push(saved);
        return workoutDetail(saved);
      },
    },
    {
      method: "PUT",
      path: /^\/workout-service\/workout\/(\d+)$/,
      handle: ([, id], __, body) => {
        const saved = findWorkout(w(), id!);
        saved.workout = { ...saved.workout, ...(body as SavedWorkout["workout"]) };
        saved.updatedMs = Date.now();
        return undefined;
      },
    },
    {
      method: "DELETE",
      path: /^\/workout-service\/workout\/(\d+)$/,
      handle: ([, id]) => {
        findWorkout(w(), id!);
        deleted.add(Number(id));
        return undefined;
      },
    },
    {
      method: "POST",
      path: /^\/workout-service\/schedule\/(\d+)$/,
      handle: ([, id], __, body) => {
        const saved = findWorkout(w(), id!);
        const date = (body as { date?: string } | null)?.date;
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "Missing date");
        const scheduleId = 1_650_900_000 + extraSchedule.length;
        extraSchedule.push({ scheduleId, workoutId: saved.workoutId, date });
        return {
          workoutScheduleId: scheduleId,
          calendarDate: date,
          createdDate: localIso(Date.now()),
          ownerId: PERSONA.profileId,
          workout: workoutSummary(saved),
        };
      },
    },
  ];
}

function enduranceValue(w: World, date: string): number {
  const day = w.byDate.get(date);
  if (!day) return 0;
  const weeks = daysIn(w, addDays(date, -27), date);
  const km = weeks.flatMap((d) => d.runs).reduce((s, r) => s + r.summary.distance / 1000, 0);
  return Math.round(4800 + 600 * day.p + km * 4 + Rng.of("endurance", date).normal(0, 25));
}

function enduranceScore(w: World, date: string) {
  const day = w.byDate.get(date);
  if (!day) return null;
  const score = enduranceValue(w, date);
  return {
    userProfilePK: PERSONA.profileId,
    deviceId: PERSONA.deviceId,
    calendarDate: date,
    overallScore: score,
    classification: score >= 6500 ? 4 : score >= 5500 ? 3 : 2,
    feedbackPhrase: 32,
    primaryTrainingDevice: true,
    gaugeLowerLimit: 3570,
    classificationLowerLimitIntermediate: 5100,
    classificationLowerLimitTrained: 5800,
    classificationLowerLimitWellTrained: 6500,
    classificationLowerLimitExpert: 7200,
    classificationLowerLimitSuperior: 7900,
    classificationLowerLimitElite: 8600,
    gaugeUpperLimit: 10_100,
    contributors: [
      { activityTypeId: null, group: 0, contribution: 92.4 },
      { activityTypeId: null, group: 8, contribution: 7.6 },
    ],
  };
}

function hillScore(w: World, date: string) {
  const day = w.byDate.get(date);
  if (!day) return null;
  const strength = Math.round(38 + 14 * day.p);
  const endurance = Math.round(44 + 16 * day.p);
  return {
    userProfilePK: PERSONA.profileId,
    deviceId: PERSONA.deviceId,
    calendarDate: date,
    strengthScore: strength,
    enduranceScore: endurance,
    hillScoreClassificationId: 2,
    overallScore: Math.round((strength + endurance) / 2),
    hillScoreFeedbackPhraseId: 3,
    vo2Max: Math.round(day.vo2Latest),
    vo2MaxPreciseValue: day.vo2Latest,
    primaryTrainingDevice: true,
  };
}

function weightEntry(x: { date: string; ms: number; kg: number }) {
  const grams = Math.round(x.kg * 1000);
  return {
    samplePk: localEpoch(x.ms),
    date: localEpoch(x.ms),
    calendarDate: x.date,
    weight: grams,
    bmi: round(x.kg / (PERSONA.heightCm / 100) ** 2, 1),
    bodyFat: null,
    bodyWater: null,
    boneMass: null,
    muscleMass: null,
    physiqueRating: null,
    visceralFat: null,
    metabolicAge: null,
    sourceType: "MANUAL",
    timestampGMT: x.ms,
    weightDelta: null,
  };
}

function weightAverage(list: ReturnType<typeof weightEntry>[], s: string, e: string) {
  return {
    from: parseYmd(s).getTime(),
    until: parseYmd(e).getTime() + 86_399_999,
    weight: list.length ? Math.round(mean(list.map((x) => x.weight))) : null,
    bmi: list.length ? round(mean(list.map((x) => x.bmi)), 1) : null,
    bodyFat: null,
    bodyWater: null,
    boneMass: null,
    muscleMass: null,
    physiqueRating: null,
    visceralFat: null,
    metabolicAge: null,
  };
}

let table: Route[] | null = null;

/**
 * Answer one Garmin API request. Unknown paths are 404 so gaps are visible.
 * `path` is the URL path on connectapi.garmin.com (no host), with its query.
 */
export function handleDemoRequest(method: string, url: URL, body?: unknown): DemoResponse {
  table ??= routes();
  for (const route of table) {
    if (route.method !== method) continue;
    const m = url.pathname.match(route.path);
    if (!m) continue;
    try {
      const data = route.handle(m, url.searchParams, body);
      if (data === undefined) return { status: 204 };
      const schema =
        typeof route.schema === "function" ? route.schema(url.searchParams) : route.schema;
      return { status: 200, body: schema ? fill(responseSchemas[schema], data) : data };
    } catch (err) {
      if (err instanceof HttpError) return { status: err.status, body: { message: err.message } };
      throw err;
    }
  }
  return { status: 404, body: { message: `Demo mode has no data for ${method} ${url.pathname}` } };
}
