import { describe, expect, it } from "vitest";
import type { GarminClient } from "../src/client.ts";
import { GarminApiError, GarminAuthError } from "../src/errors.ts";
import {
  SeriesFetcher,
  addDays,
  clean,
  fetchMetricSeries,
  normalize,
  pagesBackwards,
  seriesRange,
  summarizeSeries,
  toWeekly,
  type MetricKey,
  type SeriesPoint,
} from "../src/series.ts";

const END = "2026-03-29";

/** n daily points ending at END: value = f(i), i = 0 for the first day. */
function daily(n: number, f: (i: number) => number, end = END): SeriesPoint[] {
  return Array.from({ length: n }, (_, i) => ({ date: addDays(end, i - n + 1), value: f(i) }));
}

describe("ranges and pages", () => {
  it("is daily up to 12 weeks and weekly beyond", () => {
    expect(seriesRange(END, 4)).toEqual({
      start: "2026-03-02",
      end: END,
      weeks: 4,
      granularity: "daily",
    });
    expect(seriesRange(END, 12).granularity).toBe("daily");
    expect(seriesRange(END, 26).granularity).toBe("weekly");
    expect(seriesRange(END, 52).start).toBe(addDays(END, -363));
  });

  it("pages 28 days at a time, newest first, clipping the oldest page", () => {
    expect(pagesBackwards("2026-03-02", END)).toEqual([{ start: "2026-03-02", end: END }]);
    const r12 = seriesRange(END, 12);
    expect(pagesBackwards(r12.start, r12.end)).toHaveLength(3);
    const r26 = seriesRange(END, 26);
    const p26 = pagesBackwards(r26.start, r26.end);
    expect(p26).toHaveLength(7);
    expect(p26.at(-1)).toEqual({ start: r26.start, end: addDays(r26.start, 13) });
    const r52 = seriesRange(END, 52);
    expect(pagesBackwards(r52.start, r52.end)).toHaveLength(13);
  });
});

describe("normalizers", () => {
  it("resting HR from the wellness metrics map, skipping zeros", () => {
    const raw = {
      allMetrics: {
        metricsMap: {
          WELLNESS_RESTING_HEART_RATE: [
            { calendarDate: "2026-03-01", value: 50 },
            { calendarDate: "2026-03-02", value: 0 },
            { calendarDate: "2026-03-03", value: null },
          ],
        },
      },
    };
    expect(normalize.restingHR(raw)).toEqual([{ date: "2026-03-01", value: 50 }]);
    expect(normalize.restingHR(null)).toEqual([]);
  });

  it("HRV nightly average with the balanced baseline as the band", () => {
    const raw = {
      hrvSummaries: [
        {
          calendarDate: "2026-03-01",
          lastNightAvg: 40,
          baseline: { lowUpper: 30, balancedLow: 35, balancedUpper: 50 },
        },
        { calendarDate: "2026-03-02", lastNightAvg: 42, baseline: null },
        { calendarDate: "2026-03-03", lastNightAvg: null },
      ],
    };
    expect(normalize.hrv(raw)).toEqual([
      { date: "2026-03-01", value: 40, low: 35, high: 50 },
      { date: "2026-03-02", value: 42 },
    ]);
  });

  it("VO2 max prefers the precise value", () => {
    const raw = [
      { generic: { calendarDate: "2026-03-01", vo2MaxPreciseValue: 50.25, vo2MaxValue: 50 } },
      { generic: { calendarDate: "2026-03-02", vo2MaxValue: 51 } },
      { generic: null },
    ];
    expect(normalize.vo2max(raw)).toEqual([
      { date: "2026-03-01", value: 50.25 },
      { date: "2026-03-02", value: 51 },
    ]);
  });

  it("sleep score and duration (hours) from sleep stats", () => {
    const raw = {
      individualStats: [
        { calendarDate: "2026-03-01", values: { sleepScore: 80, totalSleepTimeInSeconds: 27000 } },
        { calendarDate: "2026-03-02", values: { sleepScore: null, totalSleepTimeInSeconds: 0 } },
      ],
    };
    expect(normalize.sleep(raw, "sleepScore")).toEqual([{ date: "2026-03-01", value: 80 }]);
    expect(normalize.sleep(raw, "sleepDuration")).toEqual([{ date: "2026-03-01", value: 7.5 }]);
  });

  it("steps and stress, daily and weekly", () => {
    expect(normalize.steps([{ calendarDate: "2026-03-01", totalSteps: 10000 }])).toEqual([
      { date: "2026-03-01", value: 10000 },
    ]);
    expect(
      normalize.weeklySteps([
        { calendarDate: "2026-03-01", values: { totalSteps: 70000, averageSteps: 10000 } },
      ]),
    ).toEqual([{ date: "2026-03-01", value: 10000 }]);
    expect(
      normalize.stress([
        { calendarDate: "2026-03-01", values: { overallStressLevel: 30 } },
        { calendarDate: "2026-03-02", values: { overallStressLevel: -1 } },
      ]),
    ).toEqual([{ date: "2026-03-01", value: 30 }]);
    expect(normalize.weeklyStress([{ calendarDate: "2026-03-01", value: 25 }])).toEqual([
      { date: "2026-03-01", value: 25 },
    ]);
  });

  it("body battery daily high from the level samples", () => {
    const raw = [
      {
        date: "2026-03-01",
        bodyBatteryValuesArray: [
          [1, 20],
          [2, 90],
          [3, 40],
        ],
      },
      { date: "2026-03-02", bodyBatteryValuesArray: [] },
    ];
    expect(normalize.bodyBattery(raw)).toEqual([{ date: "2026-03-01", value: 90 }]);
  });

  it("weekly intensity minutes count vigorous double and keep complete weeks only", () => {
    const raw = [
      { calendarDate: "2026-02-23", moderateValue: 10, vigorousValue: 10 }, // starts before range
      { calendarDate: "2026-03-02", moderateValue: 60, vigorousValue: 20 },
      { calendarDate: "2026-03-23", moderateValue: 30, vigorousValue: 0 },
      { calendarDate: "2026-03-26", moderateValue: 5, vigorousValue: 0 }, // ends after END
    ];
    expect(normalize.weeklyIntensityMinutes(raw, "2026-03-02", END)).toEqual([
      { date: "2026-03-02", value: 100 },
      { date: "2026-03-23", value: 30 },
    ]);
  });

  it("acute load from the primary device, with the optimal range as the band", () => {
    const raw = {
      weeklyTrainingStatus: {
        payload: {
          reportData: {
            "1": [
              { calendarDate: "2026-03-01", acuteTrainingLoadDTO: { dailyTrainingLoadAcute: 1 } },
            ],
            "2": [
              {
                calendarDate: "2026-03-01",
                primaryTrainingDevice: true,
                acuteTrainingLoadDTO: {
                  dailyTrainingLoadAcute: 400,
                  minTrainingLoadChronic: 300,
                  maxTrainingLoadChronic: 600,
                },
              },
            ],
          },
        },
      },
    };
    expect(normalize.trainingLoad(raw)).toEqual([
      { date: "2026-03-01", value: 400, low: 300, high: 600 },
    ]);
    expect(normalize.trainingLoad({ weeklyTrainingStatus: null })).toEqual([]);
  });

  it("weight in kg from the latest weigh-in of each day", () => {
    const raw = {
      dailyWeightSummaries: [
        {
          summaryDate: "2026-03-01",
          latestWeight: { calendarDate: "2026-03-01", weight: 70500 },
          allWeightMetrics: [{ weight: 71000 }, { weight: 70500 }],
        },
      ],
    };
    expect(normalize.weight(raw)).toEqual([{ date: "2026-03-01", value: 70.5 }]);
    expect(normalize.weight({ dailyWeightSummaries: [] })).toEqual([]);
  });
});

describe("shaping", () => {
  it("clean() keeps one point per date inside the range, sorted", () => {
    const pts = [
      { date: "2026-03-03", value: 3 },
      { date: "2026-02-28", value: 0 },
      { date: "2026-03-01", value: 1 },
      { date: "2026-03-01", value: 2 },
    ];
    expect(clean(pts, "2026-03-01", "2026-03-03")).toEqual([
      { date: "2026-03-01", value: 2 },
      { date: "2026-03-03", value: 3 },
    ]);
  });

  it("toWeekly() averages 7-day weeks counted back from the end", () => {
    // 14 days: first week values 0..6 (mean 3), second week 10..16 (mean 13)
    const pts = daily(14, (i) => (i < 7 ? i : i + 3)).map((p, i) =>
      i === 13 ? { ...p, low: 10, high: 20 } : p,
    );
    expect(toWeekly(pts, END)).toEqual([
      { date: addDays(END, -13), value: 3 },
      { date: addDays(END, -6), value: 13, low: 10, high: 20 },
    ]);
  });

  it("toWeekly() drops weeks with too few days of data", () => {
    const pts = [...daily(2, () => 90, addDays(END, -7)), ...daily(7, () => 50)];
    expect(toWeekly(pts, END, 3)).toEqual([{ date: addDays(END, -6), value: 50 }]);
    expect(toWeekly(pts, END)).toHaveLength(2);
  });
});

describe("summarizeSeries", () => {
  it("compares the first and last 7 days of daily data", () => {
    // 28 days: first week all 50, last week all 45, decreasing in between
    const pts = daily(28, (i) => (i < 7 ? 50 : i >= 21 ? 45 : 48));
    const s = summarizeSeries(pts, "daily", 0);
    expect(s).toMatchObject({
      points: 28,
      start: 50,
      end: 45,
      change: -5,
      changePct: -10,
      mean: 47.8,
      min: { value: 45, date: addDays(END, -6) },
      max: { value: 50, date: addDays(END, -27) },
      trend: "down",
    });
    expect(s.latest).toEqual({ date: END, value: 45 });
  });

  it("uses first and last points for weekly data", () => {
    const pts = [
      { date: "2026-01-05", value: 40 },
      { date: "2026-01-12", value: 42 },
      { date: "2026-01-19", value: 44 },
      { date: "2026-01-26", value: 50 },
    ];
    expect(summarizeSeries(pts, "weekly")).toMatchObject({
      start: 40,
      end: 50,
      change: 10,
      changePct: 25,
      trend: "up",
    });
  });

  it("calls small fitted changes flat, and too little data not enough", () => {
    expect(
      summarizeSeries(
        daily(28, (i) => 50 + (i % 2)),
        "daily",
      ).trend,
    ).toBe("flat");
    expect(
      summarizeSeries(
        daily(3, () => 50),
        "daily",
      ).trend,
    ).toBe("not enough data");
    expect(summarizeSeries([], "daily")).toEqual({ points: 0, trend: "not enough data" });
  });

  it("reports a null percentage when the start is zero", () => {
    expect(
      summarizeSeries(
        daily(14, (i) => (i < 7 ? 0 : 10)),
        "daily",
      ).changePct,
    ).toBeNull();
  });
});

/** Client stub answering every range method with synthetic data, logging calls. */
function fakeClient(opts: { emptyBefore?: string; failing?: string; authFail?: boolean } = {}) {
  const calls: string[] = [];
  const days = (s: string, e: string) => {
    const out: string[] = [];
    for (let d = s; d <= e; d = addDays(d, 1)) {
      if (!opts.emptyBefore || d >= opts.emptyBefore) out.push(d);
    }
    return out;
  };
  const log = (name: string, ...args: unknown[]) => {
    calls.push(`${name} ${args.join(" ")}`);
    if (opts.authFail) throw new GarminAuthError("expired");
    if (opts.failing === name) throw new GarminApiError(400, "Bad Request");
  };
  const client = {
    async getRestingHeartRate(s: string, e: string) {
      log("rhr", s, e);
      const list = days(s, e).map((d, i) => ({ calendarDate: d, value: 50 + (i % 3) }));
      return { allMetrics: { metricsMap: { WELLNESS_RESTING_HEART_RATE: list } } };
    },
    async getHrvData(s: string, e: string) {
      log("hrv", s, e);
      return {
        hrvSummaries: days(s, e).map((d) => ({
          calendarDate: d,
          lastNightAvg: 45,
          baseline: { balancedLow: 40, balancedUpper: 55 },
        })),
      };
    },
    async getVo2Max(s: string, e: string) {
      log("vo2", s, e);
      return [{ generic: { calendarDate: e, vo2MaxPreciseValue: 50.04 } }];
    },
    async getSleepStats(s: string, e: string) {
      log("sleep", s, e);
      return {
        individualStats: days(s, e).map((d) => ({
          calendarDate: d,
          values: { sleepScore: 80, totalSleepTimeInSeconds: 28800 },
        })),
      };
    },
    async getSteps(s: string, e: string) {
      log("steps", s, e);
      return days(s, e).map((d) => ({ calendarDate: d, totalSteps: 10000 }));
    },
    async getWeeklySteps(e: string, w: number) {
      log("wsteps", e, w);
      return [{ calendarDate: addDays(e, -3), values: { averageSteps: 9000 } }];
    },
    async getDailyStressStats(s: string, e: string) {
      log("stress", s, e);
      return days(s, e).map((d) => ({ calendarDate: d, values: { overallStressLevel: 30 } }));
    },
    async getWeeklyStress(e: string, w: number) {
      log("wstress", e, w);
      return [{ calendarDate: addDays(e, -3), value: 30 }];
    },
    async getBodyBattery(s: string, e: string) {
      log("bb", s, e);
      return days(s, e).map((d) => ({ date: d, bodyBatteryValuesArray: [[0, 80]] }));
    },
    async getWeeklyIntensityMinutes(s: string, e: string) {
      log("wim", s, e);
      return [{ calendarDate: s, moderateValue: 100, vigorousValue: 25 }];
    },
    async getTrainingStatusRange(s: string, e: string) {
      log("ts", s, e);
      return { weeklyTrainingStatus: { payload: { reportData: {} } } };
    },
    async getWeighIns(s: string, e: string) {
      log("weight", s, e);
      return { dailyWeightSummaries: [] };
    },
  };
  return { client: client as unknown as GarminClient, calls };
}

async function load(metrics: MetricKey[], weeks: number, opts?: Parameters<typeof fakeClient>[0]) {
  const { client, calls } = fakeClient(opts);
  const f = new SeriesFetcher(client);
  const range = seriesRange(END, weeks);
  const series = await Promise.all(metrics.map((m) => fetchMetricSeries(f, m, range)));
  return { series, calls, requests: f.requests };
}

describe("fetchMetricSeries", () => {
  it("makes one request for single-call metrics at any range", async () => {
    for (const weeks of [4, 12, 26, 52]) {
      const { requests } = await load(["restingHR", "hrv", "vo2max", "trainingLoad"], weeks);
      expect(requests, `${weeks}w`).toBe(4);
    }
  });

  it("pages sleep 28 days at a time, shared by score and duration", async () => {
    const counts = [];
    for (const weeks of [4, 12, 26, 52]) {
      const { requests, series } = await load(["sleepScore", "sleepDuration"], weeks);
      counts.push(requests);
      expect(series[1]!.points.length).toBe(series[0]!.points.length);
    }
    expect(counts).toEqual([1, 3, 7, 13]);
  });

  it("stops paging at the first page without data", async () => {
    // Data starts 30 days before END: page 2 is partly filled, page 3 empty
    const { calls } = await load(["sleepScore"], 52, { emptyBefore: addDays(END, -30) });
    expect(calls).toHaveLength(3);
  });

  it("uses weekly endpoints for steps and stress beyond 12 weeks", async () => {
    const { calls, series } = await load(["steps", "stress"], 52);
    expect(calls).toEqual([`wsteps ${END} 52`, `wstress ${END} 52`]);
    expect(series.map((s) => s.granularity)).toEqual(["weekly", "weekly"]);
    const { calls: daily12 } = await load(["steps"], 12);
    expect(daily12).toHaveLength(3);
  });

  it("returns daily points for short ranges and weekly means for long ones", async () => {
    const short = await load(["restingHR"], 4);
    expect(short.series[0]!.points).toHaveLength(28);
    expect(short.series[0]!.granularity).toBe("daily");
    const long = await load(["hrv"], 52);
    const hrv = long.series[0]!;
    expect(hrv.points).toHaveLength(52);
    expect(hrv.points.at(-1)).toEqual({ date: addDays(END, -6), value: 45, low: 40, high: 55 });
    expect(hrv.summary.trend).toBe("flat");
  });

  it("rounds to the metric's precision", async () => {
    const { series } = await load(["vo2max"], 4);
    expect(series[0]!.points).toEqual([{ date: END, value: 50 }]);
  });

  it("keeps intensity minutes weekly even for short ranges", async () => {
    const { series } = await load(["intensityMinutes"], 4);
    expect(series[0]).toMatchObject({
      granularity: "weekly",
      unit: "min/week",
      points: [{ date: "2026-03-02", value: 150 }],
    });
  });

  it("isolates a failing metric but lets auth errors through", async () => {
    const { series } = await load(["hrv", "weight"], 4, { failing: "hrv" });
    expect(series[0]!.error).toMatch(/400/);
    expect(series[0]!.points).toEqual([]);
    expect(series[1]!.error).toBeUndefined();
    await expect(load(["hrv"], 4, { authFail: true })).rejects.toBeInstanceOf(GarminAuthError);
  });
});
