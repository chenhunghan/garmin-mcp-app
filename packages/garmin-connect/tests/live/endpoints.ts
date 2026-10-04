import type { GarminClient } from "../../src/index.ts";

/** IDs and dates discovered at the start of a run, used by later calls. */
export interface LiveContext {
  date: string;
  weekAgo: string;
  twoWeeksAgo: string;
  monthAgo: string;
  activityId?: number;
  workoutId?: number;
}

export interface EndpointCase {
  name: string;
  call: (client: GarminClient, ctx: LiveContext) => Promise<unknown>;
  /** Skip when the context lacks what the call needs (e.g. no activities yet). */
  needs?: "activityId" | "workoutId";
}

/** Every read-only client method, in the order a live run calls them. */
export const endpoints: EndpointCase[] = [
  { name: "userProfile", call: (c) => c.getUserProfile() },
  { name: "userSettings", call: (c) => c.getUserSettings() },
  { name: "userSummary", call: (c, x) => c.getUserSummary(x.date) },
  { name: "steps", call: (c, x) => c.getSteps(x.weekAgo, x.date) },
  { name: "heartRates", call: (c, x) => c.getHeartRates(x.date) },
  { name: "sleep", call: (c, x) => c.getSleepData(x.date) },
  { name: "stress", call: (c, x) => c.getStressData(x.date) },
  { name: "bodyComposition", call: (c, x) => c.getBodyComposition(x.date) },
  { name: "hydration", call: (c, x) => c.getHydrationData(x.date) },
  { name: "respiration", call: (c, x) => c.getRespiration(x.date) },
  { name: "spo2", call: (c, x) => c.getSpo2(x.date) },
  { name: "intensityMinutes", call: (c, x) => c.getIntensityMinutes(x.date) },
  { name: "floors", call: (c, x) => c.getFloors(x.date) },
  { name: "restingHeartRate", call: (c, x) => c.getRestingHeartRate(x.weekAgo, x.date) },
  { name: "bodyBattery", call: (c, x) => c.getBodyBattery(x.weekAgo, x.date) },
  { name: "bodyBatteryEvents", call: (c, x) => c.getBodyBatteryEvents(x.date) },
  { name: "weighIns", call: (c, x) => c.getWeighIns(x.monthAgo, x.date) },
  { name: "weeklySteps", call: (c, x) => c.getWeeklySteps(x.date, 4) },
  { name: "weeklyStress", call: (c, x) => c.getWeeklyStress(x.date, 4) },
  {
    name: "weeklyIntensityMinutes",
    call: (c, x) => c.getWeeklyIntensityMinutes(x.monthAgo, x.date),
  },
  { name: "trainingReadiness", call: (c, x) => c.getTrainingReadiness(x.date) },
  { name: "trainingStatus", call: (c, x) => c.getTrainingStatus(x.date) },
  { name: "hrv", call: (c, x) => c.getHrvData(x.twoWeeksAgo, x.date) },
  { name: "vo2Max", call: (c, x) => c.getVo2Max(x.monthAgo, x.date) },
  { name: "racePredictions", call: (c) => c.getRacePredictions() },
  { name: "enduranceScore", call: (c, x) => c.getEnduranceScore(x.date) },
  { name: "enduranceScoreRange", call: (c, x) => c.getEnduranceScore(x.monthAgo, x.date) },
  { name: "hillScore", call: (c, x) => c.getHillScore(x.date) },
  { name: "hillScoreRange", call: (c, x) => c.getHillScore(x.monthAgo, x.date) },
  { name: "runningTolerance", call: (c, x) => c.getRunningTolerance(x.monthAgo, x.date) },
  { name: "lactateThreshold", call: (c) => c.getLactateThreshold() },
  { name: "cyclingFtp", call: (c) => c.getCyclingFtp() },
  { name: "heartRateZones", call: (c) => c.getHeartRateZones() },
  { name: "fitnessAge", call: (c, x) => c.getFitnessAge(x.date) },
  { name: "personalRecords", call: (c) => c.getPersonalRecords() },
  { name: "progressSummary", call: (c, x) => c.getProgressSummary(x.monthAgo, x.date) },
  { name: "activities", call: (c) => c.getActivities(0, 20) },
  { name: "activitiesByDate", call: (c, x) => c.getActivitiesByDate(x.weekAgo, x.date) },
  { name: "activityTypes", call: (c) => c.getActivityTypes() },
  {
    name: "activityDetails",
    call: (c, x) => c.getActivityDetails(x.activityId!),
    needs: "activityId",
  },
  {
    name: "activitySplits",
    call: (c, x) => c.getActivitySplits(x.activityId!),
    needs: "activityId",
  },
  {
    name: "activityTypedSplits",
    call: (c, x) => c.getActivityTypedSplits(x.activityId!),
    needs: "activityId",
  },
  {
    name: "activityHrZones",
    call: (c, x) => c.getActivityHrZones(x.activityId!),
    needs: "activityId",
  },
  {
    name: "activityChartDetails",
    call: (c, x) => c.getActivityChartDetails(x.activityId!, 100),
    needs: "activityId",
  },
  {
    name: "activityWeather",
    call: (c, x) => c.getActivityWeather(x.activityId!),
    needs: "activityId",
  },
  {
    name: "activityExerciseSets",
    call: (c, x) => c.getActivityExerciseSets(x.activityId!),
    needs: "activityId",
  },
  { name: "activityGear", call: (c, x) => c.getActivityGear(x.activityId!), needs: "activityId" },
  { name: "devices", call: (c) => c.getDevices() },
  { name: "deviceLastUsed", call: (c) => c.getDeviceLastUsed() },
  { name: "primaryTrainingDevice", call: (c) => c.getPrimaryTrainingDevice() },
  { name: "gear", call: (c) => c.getGear() },
  { name: "goals", call: (c) => c.getGoals() },
  { name: "trainingPlans", call: (c) => c.getTrainingPlans() },
  {
    name: "calendar",
    call: (c, x) => c.getCalendar(Number(x.date.slice(0, 4)), Number(x.date.slice(5, 7))),
  },
  { name: "workouts", call: (c) => c.getWorkouts(0, 5) },
  { name: "workout", call: (c, x) => c.getWorkout(x.workoutId!), needs: "workoutId" },
];

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function makeContext(now = new Date()): LiveContext {
  const day = 86_400_000;
  // `date` is yesterday (a complete day of data); the windows are 7/14/30 days
  // before it, matching get-training-context so its tool test is fully recorded
  return {
    date: isoDate(new Date(now.getTime() - day)),
    weekAgo: isoDate(new Date(now.getTime() - 8 * day)),
    twoWeeksAgo: isoDate(new Date(now.getTime() - 15 * day)),
    monthAgo: isoDate(new Date(now.getTime() - 31 * day)),
  };
}
