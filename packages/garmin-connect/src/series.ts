/**
 * Long-range metric series for trend views: one `{ date, value }[]` per
 * metric, daily for ranges up to 12 weeks and weekly beyond, fetched with as
 * few requests as each endpoint allows.
 *
 * Request plan per metric (E = end date):
 * - one request for any range: resting HR, HRV, VO2 max, training load,
 *   weight, intensity minutes (weekly endpoint), steps/stress in weekly mode
 * - 28-day pages, newest first, stopping at the first empty page: sleep,
 *   body battery, steps/stress in daily mode (Garmin answers 400 beyond 28 days)
 */
import type { GarminClient } from "./client.ts";
import {
  GarminAuthError,
  GarminNetworkError,
  GarminRateLimitError,
  GarminTokenExpiredError,
} from "./errors.ts";

export const METRIC_KEYS = [
  "restingHR",
  "hrv",
  "vo2max",
  "sleepScore",
  "sleepDuration",
  "steps",
  "stress",
  "bodyBattery",
  "intensityMinutes",
  "trainingLoad",
  "weight",
] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];
export type Granularity = "daily" | "weekly";

export interface SeriesPoint {
  /** YYYY-MM-DD; for weekly points, the first day of the week */
  date: string;
  value: number;
  /** Garmin's normal range for this day/week, when it defines one */
  low?: number;
  high?: number;
}

export interface MetricInfo {
  key: MetricKey;
  label: string;
  /** Short unit for axis/tooltip ("" when the value is a unitless score) */
  unit: string;
  decimals: number;
  /** What the low/high band means, when the metric has one */
  band?: string;
  /** How the value is defined, for Claude */
  definition: string;
}

export const METRICS: Record<MetricKey, MetricInfo> = {
  restingHR: {
    key: "restingHR",
    label: "Resting HR",
    unit: "bpm",
    decimals: 0,
    definition: "Daily resting heart rate",
  },
  hrv: {
    key: "hrv",
    label: "HRV",
    unit: "ms",
    decimals: 0,
    band: "HRV baseline (balanced range)",
    definition: "Nightly average HRV; band = Garmin's personal balanced baseline range",
  },
  vo2max: {
    key: "vo2max",
    label: "VO₂ max",
    unit: "ml/kg/min",
    decimals: 1,
    definition: "VO₂ max estimate (only on days Garmin updated it)",
  },
  sleepScore: {
    key: "sleepScore",
    label: "Sleep score",
    unit: "",
    decimals: 0,
    definition: "Nightly sleep score (0-100)",
  },
  sleepDuration: {
    key: "sleepDuration",
    label: "Sleep duration",
    unit: "h",
    decimals: 1,
    definition: "Total sleep per night in hours",
  },
  steps: {
    key: "steps",
    label: "Steps",
    unit: "steps/day",
    decimals: 0,
    definition: "Steps per day (weekly: average steps per day that week)",
  },
  stress: {
    key: "stress",
    label: "Stress",
    unit: "",
    decimals: 0,
    definition: "Average all-day stress level (0-100)",
  },
  bodyBattery: {
    key: "bodyBattery",
    label: "Body Battery high",
    unit: "",
    decimals: 0,
    definition: "Highest Body Battery level of the day (0-100)",
  },
  intensityMinutes: {
    key: "intensityMinutes",
    label: "Intensity minutes",
    unit: "min/week",
    decimals: 0,
    definition:
      "Weekly intensity minutes, vigorous counted double like Garmin's weekly goal; complete weeks only",
  },
  trainingLoad: {
    key: "trainingLoad",
    label: "Acute load",
    unit: "",
    decimals: 0,
    band: "Optimal acute load range",
    definition:
      "Acute training load (7-day weighted); band = Garmin's optimal range (0.8-1.5x chronic load)",
  },
  weight: {
    key: "weight",
    label: "Weight",
    unit: "kg",
    decimals: 1,
    definition: "Body weight on days with a weigh-in",
  },
};

export function isMetricKey(k: string): k is MetricKey {
  return (METRIC_KEYS as readonly string[]).includes(k);
}

// ── Dates (calendar days as YYYY-MM-DD, no time zone) ────────────────────

const DAY = 86_400_000;
const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const fromMs = (t: number) => new Date(t).toISOString().slice(0, 10);

export function addDays(date: string, n: number): string {
  return fromMs(toMs(date) + n * DAY);
}

/** Whole days from a to b (b - a). */
export function dayDiff(a: string, b: string): number {
  return Math.round((toMs(b) - toMs(a)) / DAY);
}

export interface SeriesRange {
  start: string;
  end: string;
  weeks: number;
  granularity: Granularity;
}

/** The `weeks` weeks ending on `end`: daily up to 12 weeks, weekly beyond. */
export function seriesRange(end: string, weeks: number): SeriesRange {
  return {
    start: addDays(end, -(weeks * 7 - 1)),
    end,
    weeks,
    granularity: weeks <= 12 ? "daily" : "weekly",
  };
}

/** [start, end] split into pages of `size` days, newest page first. */
export function pagesBackwards(
  start: string,
  end: string,
  size = 28,
): { start: string; end: string }[] {
  const pages: { start: string; end: string }[] = [];
  let pageEnd = end;
  while (dayDiff(start, pageEnd) >= 0) {
    const pageStart = addDays(pageEnd, -(size - 1));
    pages.push({ start: dayDiff(start, pageStart) < 0 ? start : pageStart, end: pageEnd });
    pageEnd = addDays(pageEnd, -size);
  }
  return pages;
}

// ── Normalizers: raw Garmin response → points ─────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const rows = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

function point(date: unknown, value: number | undefined, low?: number, high?: number) {
  if (typeof date !== "string" || value === undefined) return null;
  const p: SeriesPoint = { date: date.slice(0, 10), value };
  if (low !== undefined && high !== undefined) Object.assign(p, { low, high });
  return p;
}
const present = (p: SeriesPoint | null): p is SeriesPoint => p !== null;

export const normalize = {
  /** `/userstats-service/wellness/daily/{displayName}?metricId=60` */
  restingHR(raw: unknown): SeriesPoint[] {
    const map = isObj(raw) && isObj(raw.allMetrics) ? raw.allMetrics.metricsMap : undefined;
    const list = isObj(map) ? map.WELLNESS_RESTING_HEART_RATE : undefined;
    return rows(list)
      .map((r) => point(r.calendarDate, num(r.value)))
      .filter(present)
      .filter((p) => p.value > 0);
  },

  /** `/hrv-service/hrv/daily/{start}/{end}` */
  hrv(raw: unknown): SeriesPoint[] {
    return rows(isObj(raw) ? raw.hrvSummaries : undefined)
      .map((r) => {
        const b = isObj(r.baseline) ? r.baseline : {};
        return point(r.calendarDate, num(r.lastNightAvg), num(b.balancedLow), num(b.balancedUpper));
      })
      .filter(present);
  },

  /** `/metrics-service/metrics/maxmet/daily/{start}/{end}` */
  vo2max(raw: unknown): SeriesPoint[] {
    return rows(raw)
      .map((r) => {
        const g = isObj(r.generic) ? r.generic : {};
        return point(g.calendarDate, num(g.vo2MaxPreciseValue) ?? num(g.vo2MaxValue));
      })
      .filter(present);
  },

  /** `/sleep-service/stats/sleep/daily/{start}/{end}` */
  sleep(raw: unknown, field: "sleepScore" | "sleepDuration"): SeriesPoint[] {
    return rows(isObj(raw) ? raw.individualStats : undefined)
      .map((r) => {
        const v = isObj(r.values) ? r.values : {};
        const value =
          field === "sleepScore"
            ? num(v.sleepScore)
            : (() => {
                const s = num(v.totalSleepTimeInSeconds);
                return s ? s / 3600 : undefined;
              })();
        return point(r.calendarDate, value);
      })
      .filter(present);
  },

  /** `/usersummary-service/stats/steps/daily/{start}/{end}` */
  steps(raw: unknown): SeriesPoint[] {
    return rows(raw)
      .map((r) => point(r.calendarDate, num(r.totalSteps)))
      .filter(present);
  },

  /** `/usersummary-service/stats/steps/weekly/{end}/{weeks}`: average steps per day */
  weeklySteps(raw: unknown): SeriesPoint[] {
    return rows(raw)
      .map((r) => point(r.calendarDate, num(isObj(r.values) ? r.values.averageSteps : undefined)))
      .filter(present);
  },

  /** `/usersummary-service/stats/stress/daily/{start}/{end}` */
  stress(raw: unknown): SeriesPoint[] {
    return rows(raw)
      .map((r) =>
        point(r.calendarDate, num(isObj(r.values) ? r.values.overallStressLevel : undefined)),
      )
      .filter(present)
      .filter((p) => p.value >= 0);
  },

  /** `/usersummary-service/stats/stress/weekly/{end}/{weeks}` */
  weeklyStress(raw: unknown): SeriesPoint[] {
    return rows(raw)
      .map((r) => point(r.calendarDate, num(r.value)))
      .filter(present)
      .filter((p) => p.value >= 0);
  },

  /** `/wellness-service/wellness/bodyBattery/reports/daily`: the day's highest level */
  bodyBattery(raw: unknown): SeriesPoint[] {
    return rows(raw)
      .map((r) => {
        const levels = (Array.isArray(r.bodyBatteryValuesArray) ? r.bodyBatteryValuesArray : [])
          .map((s) => (Array.isArray(s) ? num(s[1]) : undefined))
          .filter((v): v is number => v !== undefined);
        return point(r.date, levels.length ? Math.max(...levels) : undefined);
      })
      .filter(present);
  },

  /**
   * `/usersummary-service/stats/im/weekly/{start}/{end}`: moderate + 2 × vigorous.
   * Only weeks that start on/after `start` and end on/before `end`, so a
   * partial current week doesn't read as a drop.
   */
  weeklyIntensityMinutes(raw: unknown, start: string, end: string): SeriesPoint[] {
    return rows(raw)
      .map((r) => {
        const mod = num(r.moderateValue);
        const vig = num(r.vigorousValue);
        return point(
          r.calendarDate,
          mod === undefined && vig === undefined ? undefined : (mod ?? 0) + 2 * (vig ?? 0),
        );
      })
      .filter(present)
      .filter((p) => dayDiff(start, p.date) >= 0 && dayDiff(addDays(p.date, 6), end) >= 0);
  },

  /**
   * `/mobile-gateway/usersummary/trainingstatus/weekly/{start}/{end}`: acute
   * load per day from the primary training device, with Garmin's optimal range.
   */
  trainingLoad(raw: unknown): SeriesPoint[] {
    const wts = isObj(raw) ? raw.weeklyTrainingStatus : undefined;
    const payload = isObj(wts) ? wts.payload : undefined;
    const report = isObj(payload) ? payload.reportData : undefined;
    if (!isObj(report)) return [];
    const devices = Object.values(report).map(rows);
    const device =
      devices.find((d) => d.some((r) => r.primaryTrainingDevice === true)) ?? devices[0] ?? [];
    return device
      .map((r) => {
        const a = isObj(r.acuteTrainingLoadDTO) ? r.acuteTrainingLoadDTO : {};
        return point(
          r.calendarDate,
          num(a.dailyTrainingLoadAcute),
          num(a.minTrainingLoadChronic),
          num(a.maxTrainingLoadChronic),
        );
      })
      .filter(present);
  },

  /** `/weight-service/weight/range/{start}/{end}`: latest weigh-in per day, kg */
  weight(raw: unknown): SeriesPoint[] {
    return rows(isObj(raw) ? raw.dailyWeightSummaries : undefined)
      .map((d) => {
        const latest = isObj(d.latestWeight)
          ? d.latestWeight
          : (rows(d.allWeightMetrics).at(-1) ?? {});
        const grams = num(latest.weight);
        return point(d.summaryDate ?? latest.calendarDate, grams ? grams / 1000 : undefined);
      })
      .filter(present);
  },
};

// ── Shaping: range filter, weekly buckets, rounding ──────────────────────

/** One point per date (last wins), sorted, within [start, end]. */
export function clean(points: SeriesPoint[], start: string, end: string): SeriesPoint[] {
  const byDate = new Map<string, SeriesPoint>();
  for (const p of points) {
    if (dayDiff(start, p.date) >= 0 && dayDiff(p.date, end) >= 0) byDate.set(p.date, p);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Daily points → weekly means, in 7-day weeks counted back from `end` (so the
 * latest week is always complete). Each point is dated by its week's first day.
 * Weeks with fewer than `minDays` days of data are dropped, so a week with one
 * stray reading (e.g. the first days of a new watch) doesn't pose as a weekly mean.
 */
export function toWeekly(points: SeriesPoint[], end: string, minDays = 1): SeriesPoint[] {
  const buckets = new Map<number, SeriesPoint[]>();
  for (const p of points) {
    const idx = Math.floor(dayDiff(p.date, end) / 7);
    if (idx < 0) continue;
    buckets.set(idx, [...(buckets.get(idx) ?? []), p]);
  }
  return [...buckets.entries()]
    .filter(([, ps]) => ps.length >= minDays)
    .sort((a, b) => b[0] - a[0])
    .map(([idx, ps]) => {
      const out: SeriesPoint = {
        date: addDays(end, -(idx * 7 + 6)),
        value: mean(ps.map((p) => p.value)),
      };
      const banded = ps.filter((p) => p.low !== undefined && p.high !== undefined);
      if (banded.length) {
        out.low = mean(banded.map((p) => p.low!));
        out.high = mean(banded.map((p) => p.high!));
      }
      return out;
    });
}

export function roundPoints(points: SeriesPoint[], decimals: number): SeriesPoint[] {
  const f = 10 ** decimals;
  const r = (v: number) => Math.round(v * f) / f;
  return points.map((p) => ({
    date: p.date,
    value: r(p.value),
    ...(p.low !== undefined && p.high !== undefined ? { low: r(p.low), high: r(p.high) } : {}),
  }));
}

// ── Summary for Claude and the stat headers ───────────────────────────────

export type TrendDirection = "up" | "down" | "flat" | "not enough data";

export interface SeriesSummary {
  points: number;
  latest?: SeriesPoint;
  /** Mean of the first 7 days of data (daily), or the first week (weekly) */
  start?: number;
  /** Current level: mean of the last 7 days of data (daily), or the latest week (weekly) */
  end?: number;
  min?: { date: string; value: number };
  max?: { date: string; value: number };
  /** Mean of every point in the range */
  mean?: number;
  /**
   * end − mean: the current level against the period's average. The headline
   * comparison — not end − start, because the first days/weeks of a range are
   * often unrepresentative (a new watch still learning, load ramping from 0).
   */
  vsMean?: number;
  /** vsMean / mean × 100; null when the mean is near zero relative to the values */
  vsMeanPct?: number | null;
  /**
   * Direction of the least-squares fit over the whole range; "flat" when the
   * fitted change is under 3% of the mean
   */
  trend: TrendDirection;
}

export function summarizeSeries(
  points: SeriesPoint[],
  granularity: Granularity,
  decimals = 1,
): SeriesSummary {
  if (points.length === 0) return { points: 0, trend: "not enough data" };
  // Averages get one more decimal than the metric's own values
  const f = 10 ** (decimals + 1);
  const r = (v: number) => Math.round(v * f) / f;
  const first = points[0]!;
  const last = points.at(-1)!;
  const values = points.map((p) => p.value);

  // Daily data is noisy: compare the first and last 7 days of data, not two single days
  const startVals =
    granularity === "daily"
      ? points.filter((p) => dayDiff(first.date, p.date) < 7).map((p) => p.value)
      : [first.value];
  const endVals =
    granularity === "daily"
      ? points.filter((p) => dayDiff(p.date, last.date) < 7).map((p) => p.value)
      : [last.value];
  const start = mean(startVals);
  const end = mean(endVals);

  let minP = first;
  let maxP = first;
  for (const p of points) {
    if (p.value < minP.value) minP = p;
    if (p.value > maxP.value) maxP = p;
  }
  const avg = mean(values);

  // Least-squares slope (per day) × span = fitted change over the range
  let trend: TrendDirection = "not enough data";
  const span = dayDiff(first.date, last.date);
  if (points.length >= 4 && span >= 14) {
    const xs = points.map((p) => dayDiff(first.date, p.date));
    const mx = mean(xs);
    let num = 0;
    let den = 0;
    xs.forEach((x, i) => {
      num += (x - mx) * (values[i]! - avg);
      den += (x - mx) ** 2;
    });
    const fitted = den ? (num / den) * span : 0;
    trend = Math.abs(fitted) < 0.03 * Math.abs(avg) ? "flat" : fitted > 0 ? "up" : "down";
  }

  return {
    points: points.length,
    latest: last,
    start: r(start),
    end: r(end),
    min: { date: minP.date, value: minP.value },
    max: { date: maxP.date, value: maxP.value },
    mean: r(avg),
    vsMean: r(end - avg),
    vsMeanPct:
      Math.abs(avg) < 0.1 * Math.max(Math.abs(minP.value), Math.abs(maxP.value)) || avg === 0
        ? null
        : Math.round(((end - avg) / Math.abs(avg)) * 1000) / 10,
    trend,
  };
}

// ── Fetching ───────────────────────────────────────────────────────────────

export interface MetricSeries {
  metric: MetricKey;
  label: string;
  unit: string;
  granularity: Granularity;
  band?: string;
  definition: string;
  points: SeriesPoint[];
  summary: SeriesSummary;
  /** Set when this metric couldn't be loaded (others still are) */
  error?: string;
}

/**
 * Memoizes identical client calls within one dashboard load (sleep score and
 * sleep duration share their pages) and counts the requests actually made.
 */
export class SeriesFetcher {
  requests = 0;
  private memo = new Map<string, Promise<unknown>>();
  readonly client: GarminClient;
  constructor(client: GarminClient) {
    this.client = client;
  }

  call<A extends unknown[]>(
    method: (...args: A) => Promise<unknown>,
    name: string,
    ...args: A
  ): Promise<unknown> {
    const key = `${name}(${args.join(",")})`;
    let p = this.memo.get(key);
    if (!p) {
      this.requests++;
      p = method.apply(this.client, args);
      this.memo.set(key, p);
    }
    return p;
  }

  /** 28-day pages newest first, stopping at the first page without data. */
  async paged(
    fetchPage: (start: string, end: string) => Promise<unknown>,
    toPoints: (raw: unknown) => SeriesPoint[],
    range: SeriesRange,
  ): Promise<SeriesPoint[]> {
    const out: SeriesPoint[] = [];
    for (const page of pagesBackwards(range.start, range.end)) {
      const pts = toPoints(await fetchPage(page.start, page.end));
      if (pts.length === 0) break;
      out.push(...pts);
    }
    return out;
  }
}

async function fetchPoints(
  f: SeriesFetcher,
  metric: MetricKey,
  r: SeriesRange,
): Promise<SeriesPoint[]> {
  const c = f.client;
  const weekly = r.granularity === "weekly";
  const sleepPage = (s: string, e: string) => f.call(c.getSleepStats, "sleep", s, e);
  switch (metric) {
    case "restingHR":
      return normalize.restingHR(await f.call(c.getRestingHeartRate, "rhr", r.start, r.end));
    case "hrv":
      return normalize.hrv(await f.call(c.getHrvData, "hrv", r.start, r.end));
    case "vo2max":
      return normalize.vo2max(await f.call(c.getVo2Max, "vo2", r.start, r.end));
    case "sleepScore":
    case "sleepDuration":
      return f.paged(sleepPage, (raw) => normalize.sleep(raw, metric), r);
    case "steps":
      return weekly
        ? normalize.weeklySteps(await f.call(c.getWeeklySteps, "wsteps", r.end, r.weeks))
        : f.paged((s, e) => f.call(c.getSteps, "steps", s, e), normalize.steps, r);
    case "stress":
      return weekly
        ? normalize.weeklyStress(await f.call(c.getWeeklyStress, "wstress", r.end, r.weeks))
        : f.paged((s, e) => f.call(c.getDailyStressStats, "stress", s, e), normalize.stress, r);
    case "bodyBattery":
      return f.paged((s, e) => f.call(c.getBodyBattery, "bb", s, e), normalize.bodyBattery, r);
    case "intensityMinutes":
      return normalize.weeklyIntensityMinutes(
        await f.call(c.getWeeklyIntensityMinutes, "wim", r.start, r.end),
        r.start,
        r.end,
      );
    case "trainingLoad":
      return normalize.trainingLoad(await f.call(c.getTrainingStatusRange, "ts", r.start, r.end));
    case "weight":
      return normalize.weight(await f.call(c.getWeighIns, "weight", r.start, r.end));
  }
}

/** Metrics measured only now and then: any reading makes a weekly point. */
const SPARSE = new Set<MetricKey>(["vo2max", "weight"]);

/** Metrics whose endpoint is already weekly (no daily → weekly aggregation). */
const NATIVE_WEEKLY = new Set<MetricKey>(["intensityMinutes"]);

/** Fetch and shape one metric. Auth/rate-limit/network errors propagate; others become `error`. */
export async function fetchMetricSeries(
  f: SeriesFetcher,
  metric: MetricKey,
  range: SeriesRange,
): Promise<MetricSeries> {
  const info = METRICS[metric];
  const base = {
    metric,
    label: info.label,
    unit: info.unit,
    granularity: NATIVE_WEEKLY.has(metric) ? ("weekly" as const) : range.granularity,
    ...(info.band ? { band: info.band } : {}),
    definition: info.definition,
  };
  let raw: SeriesPoint[];
  try {
    raw = await fetchPoints(f, metric, range);
  } catch (err) {
    if (
      err instanceof GarminAuthError ||
      err instanceof GarminTokenExpiredError ||
      err instanceof GarminRateLimitError ||
      err instanceof GarminNetworkError
    ) {
      throw err;
    }
    return {
      ...base,
      points: [],
      summary: summarizeSeries([], base.granularity),
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const weeklyFromWeeklyEndpoint =
    NATIVE_WEEKLY.has(metric) ||
    (range.granularity === "weekly" && (metric === "steps" || metric === "stress"));
  let points: SeriesPoint[];
  if (weeklyFromWeeklyEndpoint) {
    // Weekly endpoints date each week by its first day, which can precede the range
    points = clean(raw, addDays(range.start, -6), range.end);
  } else {
    points = clean(raw, range.start, range.end);
    if (range.granularity === "weekly") {
      points = toWeekly(points, range.end, SPARSE.has(metric) ? 1 : 3);
    }
  }
  // Weekly points are averages of daily values: one more decimal, or e.g. a
  // resting HR drifting 52 → 49 renders as a staircase of whole bpm
  points = roundPoints(points, info.decimals + (range.granularity === "weekly" ? 1 : 0));
  return { ...base, points, summary: summarizeSeries(points, base.granularity, info.decimals) };
}
