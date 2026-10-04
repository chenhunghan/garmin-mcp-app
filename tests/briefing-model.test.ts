/** Unit tests for the daily briefing computation, with small synthetic inputs. */
import { describe, expect, it } from "vitest";
import {
  activitySummary,
  briefingQuestions,
  briefingSummary,
  buildBriefing,
  deltaFromBand,
  formatHours,
  garminStatus,
  humanize,
  hrvMetric,
  readinessMetric,
  restingHrStatus,
  shiftDate,
  sleepMetrics,
  stressRange,
  summaryMetrics,
  trainingStatusSummary,
} from "../src/briefing-model.ts";

const DATE = "2026-01-10";

const readiness = [
  {
    calendarDate: DATE,
    timestampLocal: "2026-01-10T06:00:00.0",
    score: 40,
    level: "LOW",
  },
  {
    calendarDate: DATE,
    timestampLocal: "2026-01-10T07:00:00.0",
    score: 70,
    level: "MODERATE",
    feedbackShort: "READY_FOR_THE_DAY",
    recoveryTime: 120,
    sleepScoreFactorFeedback: "MODERATE",
    sleepScoreFactorPercent: 60,
    hrvFactorFeedback: "VERY_GOOD",
    hrvFactorPercent: 100,
    acwrFactorFeedback: "GOOD",
    acwrFactorPercent: 90,
    sleepHistoryFactorFeedback: "GOOD",
    sleepHistoryFactorPercent: 80,
  },
];

const sleep = {
  dailySleepDTO: {
    sleepTimeSeconds: 6 * 3600,
    deepSleepSeconds: 3600,
    lightSleepSeconds: 3 * 3600,
    remSleepSeconds: 1800 * 3,
    awakeSleepSeconds: 600,
    restingHeartRate: 50,
    sleepScores: {
      overall: { value: 64, qualifierKey: "FAIR" },
      totalDuration: { qualifierKey: "POOR", optimalStart: 28800, optimalEnd: 28800 },
    },
  },
  bodyBatteryChange: 40,
};

const hrv = {
  hrvSummaries: [
    { calendarDate: "2026-01-09", lastNightAvg: 50, weeklyAvg: 52 },
    {
      calendarDate: DATE,
      lastNightAvg: 45,
      weeklyAvg: 50,
      status: "UNBALANCED",
      baseline: { balancedLow: 48, balancedUpper: 60 },
    },
    { calendarDate: "2026-01-08", lastNightAvg: 55, weeklyAvg: 53 },
  ],
};

const summary = {
  totalSteps: 3000,
  dailyStepGoal: 10000,
  restingHeartRate: 55,
  lastSevenDaysAvgRestingHeartRate: 50,
  averageStressLevel: 30,
  stressQualifier: "BALANCED",
  bodyBatteryMostRecentValue: 60,
  bodyBatteryAtWakeTime: 80,
  bodyBatteryHighestValue: 80,
  bodyBatteryLowestValue: 20,
  bodyBatteryChargedValue: 60,
  bodyBatteryDrainedValue: 20,
};

const activities = [
  {
    activityId: 1000000001,
    activityName: "Test Run",
    activityType: { typeKey: "running" },
    startTimeLocal: "2026-01-08 07:00:00",
    distance: 10000,
    duration: 3000,
    aerobicTrainingEffect: 3.04,
    anaerobicTrainingEffect: 1,
    activityTrainingLoad: 100.4,
  },
  // After the briefing date: ignored
  { activityId: 1000000002, startTimeLocal: "2026-01-11 07:00:00", distance: 5000, duration: 1500 },
  // Older than 7 days: not in last7Days
  { activityId: 1000000003, startTimeLocal: "2026-01-01 07:00:00", distance: 5000, duration: 1500 },
  { activityId: 1000000004, startTimeLocal: "2026-01-05 07:00:00", distance: 5000, duration: 1200 },
];

const trainingStatus = {
  mostRecentTrainingStatus: {
    payload: {
      latestTrainingStatusData: {
        "1": { trainingStatusFeedbackPhrase: "DETRAINING_1", primaryTrainingDevice: false },
        "2": {
          trainingStatusFeedbackPhrase: "PRODUCTIVE_3",
          primaryTrainingDevice: true,
          acuteTrainingLoadDTO: { acwrStatus: "OPTIMAL" },
        },
      },
    },
  },
};

describe("helpers", () => {
  it("humanizes Garmin keys", () => {
    expect(humanize("READY_FOR_THE_DAY")).toBe("Ready for the day");
    expect(humanize("MAINTAINING_2")).toBe("Maintaining");
  });
  it("shifts dates by calendar days", () => {
    expect(shiftDate("2026-03-01", 1)).toBe("2026-02-28");
    expect(shiftDate("2026-10-03", 14)).toBe("2026-09-19");
  });
  it("measures distance outside a band", () => {
    expect(deltaFromBand(5, 7, 9)).toBe(-2);
    expect(deltaFromBand(8, 7, 9)).toBe(0);
    expect(deltaFromBand(10, 7, 9)).toBe(1);
  });
  it("maps Garmin statuses and ignores 'none'", () => {
    expect(garminStatus("BALANCED", { BALANCED: "good" })).toMatchObject({
      label: "Balanced",
      level: "good",
      source: "garmin",
    });
    expect(garminStatus("NONE", {})).toBeNull();
    expect(garminStatus("SOMETHING_NEW", {})?.level).toBeNull();
  });
  it("classifies resting HR against its 7-day average", () => {
    expect(restingHrStatus(4).key).toBe("ABOVE_BASELINE");
    expect(restingHrStatus(1).key).toBe("TYPICAL");
    expect(restingHrStatus(-3).key).toBe("BELOW_BASELINE");
  });
  it("names Garmin's stress range", () => {
    expect(stressRange(20).name).toBe("Garmin rest range");
    expect(stressRange(26)).toMatchObject({ low: 26, high: 50 });
    expect(stressRange(90).name).toBe("Garmin high range");
  });
  it("formats hours", () => {
    expect(formatHours(6.5)).toBe("6h 30m");
    expect(formatHours(8)).toBe("8h");
    expect(formatHours(0.25)).toBe("15m");
  });
});

describe("metrics", () => {
  it("uses the latest readiness reading and sorts factors weakest first", () => {
    const m = readinessMetric(readiness, DATE);
    expect(m.value).toBe(70);
    expect(m.status).toMatchObject({ key: "MODERATE", level: "good" });
    const d = m.details as {
      recoveryHours: number;
      garminFeedback: string;
      factorsWeakestFirst: { name: string }[];
    };
    expect(d.recoveryHours).toBe(2);
    expect(d.garminFeedback).toBe("Ready for the day");
    expect(d.factorsWeakestFirst.map((f) => f.name)).toEqual([
      "Sleep score",
      "Sleep history",
      "Acute load",
      "HRV status",
    ]);
  });

  it("says why readiness is missing", () => {
    expect(readinessMetric([], DATE).missing).toMatch(/No training readiness/);
    expect(readinessMetric(null, DATE).missing).toMatch(/Couldn't load/);
  });

  it("frames sleep against Garmin's optimal duration", () => {
    const { score, duration } = sleepMetrics(sleep);
    expect(score).toMatchObject({ value: 64, status: { label: "Fair", level: "warning" } });
    expect(duration).toMatchObject({
      value: 6,
      unit: "h",
      baseline: { name: "Garmin's optimal sleep", low: 8, high: 8 },
      delta: -2,
      status: { level: "critical" },
    });
    expect((duration.details as { stages: { deep: { percent: number } } }).stages.deep.percent).toBe(
      17,
    );
    expect(sleepMetrics({}).score.missing).toMatch(/No sleep/);
  });

  it("compares HRV with the 7-night average and the balanced range", () => {
    const m = hrvMetric(hrv, DATE);
    expect(m).toMatchObject({
      value: 45,
      baseline: { name: "7-night avg", value: 50 },
      delta: -5,
      status: { key: "UNBALANCED", level: "warning" },
      details: { balancedRange: { low: 48, high: 60 }, lastNightVsBalancedRange: "below" },
    });
    // Trend sorted oldest first
    expect(m.trend!.map((t) => t.value)).toEqual([55, 50, 45]);
    expect(hrvMetric(hrv, "2026-01-11").missing).toMatch(/No HRV/);
  });

  it("derives body battery, resting HR, stress and steps from the daily summary", () => {
    const s = summaryMetrics(summary, sleep);
    expect(s.bodyBattery).toMatchObject({
      value: 60,
      baseline: { name: "at wake", value: 80 },
      delta: -20,
      details: { chargedDuringSleep: 40 },
    });
    expect(s.restingHeartRate).toMatchObject({
      value: 55,
      delta: 5,
      status: { key: "ABOVE_BASELINE" },
    });
    expect(s.stress).toMatchObject({ value: 30, status: { label: "Balanced" } });
    expect(s.steps).toMatchObject({ value: 3000, delta: -7000, status: null });
    expect(s.steps.details).toEqual({ percentOfGoal: 30 });
  });

  it("treats Garmin's negative stress as missing", () => {
    expect(summaryMetrics({ averageStressLevel: -1 }, null).stress.value).toBeNull();
  });

  it("picks the primary device's training status", () => {
    expect(trainingStatusSummary(trainingStatus)).toEqual({
      key: "PRODUCTIVE_3",
      label: "Productive",
      level: "good",
      acwrStatus: "Optimal",
    });
    expect(trainingStatusSummary({})).toBeNull();
  });

  it("finds the last activity on or before the date and the week's volume", () => {
    const { lastActivity, last7Days } = activitySummary(activities, DATE);
    expect(lastActivity).toMatchObject({
      activityId: 1000000001,
      name: "Test Run",
      type: "running",
      daysAgo: 2,
      distanceKm: 10,
      durationMin: 50,
      aerobicTrainingEffect: 3,
      trainingLoad: 100,
    });
    expect(last7Days).toEqual({ activities: 2, distanceKm: 15, durationMin: 70, trainingLoad: 100 });
  });
});

describe("buildBriefing", () => {
  const b = buildBriefing(DATE, DATE, {
    readiness,
    sleep,
    hrv,
    summary,
    activities,
    trainingStatus,
  });

  it("assembles every metric", () => {
    expect(b.isToday).toBe(true);
    expect(b.failed).toEqual([]);
    for (const m of Object.values(b.metrics)) expect(m.value).not.toBeNull();
  });

  it("lists failed sources and keeps the rest", () => {
    const partial = buildBriefing(DATE, "2026-01-11", {
      readiness: null,
      sleep,
      hrv: null,
      summary,
      activities: null,
      trainingStatus: undefined,
    });
    expect(partial.isToday).toBe(false);
    expect(partial.failed).toEqual(["training readiness", "HRV", "activities"]);
    expect(partial.metrics.trainingReadiness.value).toBeNull();
    expect(partial.metrics.sleepScore.value).toBe(64);
    expect(partial.lastActivity).toBeNull();
    expect(partial.trainingStatus).toBeNull();
  });

  it("summarizes the screen in one paragraph", () => {
    const text = briefingSummary(b);
    expect(text).toContain("training readiness 70/100 (moderate)");
    expect(text).toContain("HRV 45 ms vs 7-night avg 50 (unbalanced)");
    expect(text).toContain("Last activity: Test Run, 10 km, 50 min, aerobic TE 3 on 2026-01-08.");
    expect(text).not.toContain("Not available");
  });

  it("builds self-contained questions from the numbers", () => {
    const qs = briefingQuestions(b);
    expect(qs).toHaveLength(3);
    expect(qs[0]).toBe("Should I train hard today given my training readiness of 70 and HRV of 45 ms?");
    expect(qs[1]).toContain("sleep score 64 last night");
    expect(qs[2]).toContain("55 bpm, +5 bpm vs my 7-day average");
    const past = briefingQuestions({ ...b, isToday: false });
    expect(past[0]).toContain(`on ${DATE}`);
    expect(past[1]).toContain(`the night before ${DATE}`);
  });
});
