/**
 * Daily briefing: today's Garmin numbers framed against the user's own
 * baselines. Pure functions only (no I/O), shared by the server tool
 * (src/tools/briefing.ts) and the view (src/briefing-view.tsx).
 *
 * Every metric has the same shape — value · unit · named baseline · delta ·
 * neutral status — so Claude can read it without knowing Garmin's raw JSON.
 * Statuses come from Garmin's own status fields where it has one, otherwise
 * from the baseline band. No advice here: Claude writes the suggestions.
 */

export type StatusLevel = "good" | "warning" | "critical";

export interface MetricStatus {
  /** Garmin's key (e.g. "BALANCED") or a baseline-derived key ("ABOVE_BASELINE") */
  key: string;
  label: string;
  level: StatusLevel | null;
  /** "garmin" = Garmin's own status field; "baseline" = derived from the baseline band */
  source: "garmin" | "baseline";
}

export interface Baseline {
  /** What the value is compared against, e.g. "7-day avg", "Garmin's optimal sleep" */
  name: string;
  value?: number;
  low?: number;
  high?: number;
}

export interface Metric {
  value: number | null;
  unit: string;
  baseline: Baseline | null;
  /** value − baseline (for a band: distance outside it, 0 inside) */
  delta: number | null;
  status: MetricStatus | null;
  /** Why the value is missing (only when value is null) */
  missing?: string;
  /** Recent history for context, oldest first */
  trend?: { date: string; value: number | null }[];
  details?: Record<string, unknown>;
}

export interface ReadinessFactor {
  name: string;
  /** Garmin's feedback, e.g. "GOOD", "MODERATE" */
  feedback: string | null;
  /** Garmin's contribution percent (100 = not holding readiness back) */
  percent: number | null;
  level: StatusLevel | null;
}

export interface LastActivity {
  activityId: number | string | null;
  name: string | null;
  type: string | null;
  startTimeLocal: string;
  daysAgo: number;
  distanceKm: number | null;
  durationMin: number | null;
  aerobicTrainingEffect: number | null;
  anaerobicTrainingEffect: number | null;
  trainingEffectLabel: string | null;
  trainingLoad: number | null;
}

export interface Briefing {
  date: string;
  isToday: boolean;
  metrics: {
    trainingReadiness: Metric;
    sleepScore: Metric;
    sleepDuration: Metric;
    hrv: Metric;
    bodyBattery: Metric;
    restingHeartRate: Metric;
    stress: Metric;
    steps: Metric;
  };
  trainingStatus: {
    key: string;
    label: string;
    level: StatusLevel | null;
    acwrStatus: string | null;
  } | null;
  lastActivity: LastActivity | null;
  /** Activities in the 7 days ending on `date` (from the 20 most recent) */
  last7Days: {
    activities: number;
    distanceKm: number;
    durationMin: number;
    trainingLoad: number;
  } | null;
  /** Data sources that failed to load (network/API errors), by name */
  failed: string[];
}

/** Raw responses; null when the request failed. */
export interface BriefingSources {
  readiness: unknown;
  sleep: unknown;
  hrv: unknown;
  summary: unknown;
  activities: unknown;
  trainingStatus: unknown;
}

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const round = (v: number, digits = 0) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/** "READY_FOR_THE_DAY" → "Ready for the day"; "MAINTAINING_2" → "Maintaining" */
export function humanize(key: string): string {
  const words = key.replace(/_\d+$/, "").toLowerCase().split("_").filter(Boolean).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Whole days from `from` to `to` (YYYY-MM-DD, calendar days). */
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) /
      86_400_000,
  );
}

/** YYYY-MM-DD `n` days before `date` (calendar arithmetic, time-zone safe). */
export function shiftDate(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
}

/** Distance of `value` outside [low, high]; 0 inside. */
export function deltaFromBand(value: number, low: number, high: number): number {
  if (value < low) return value - low;
  if (value > high) return value - high;
  return 0;
}

export function bandPosition(value: number, low: number, high: number) {
  return value < low ? "below" : value > high ? "above" : "within";
}

// Garmin status keys → neutral levels (Garmin's own colour bands)
const READINESS_LEVELS: Record<string, StatusLevel> = {
  PRIME: "good",
  HIGH: "good",
  MODERATE: "good",
  LOW: "warning",
  POOR: "critical",
};
const HRV_LEVELS: Record<string, StatusLevel> = {
  BALANCED: "good",
  UNBALANCED: "warning",
  LOW: "warning",
  POOR: "critical",
};
const QUALIFIER_LEVELS: Record<string, StatusLevel> = {
  EXCELLENT: "good",
  GOOD: "good",
  FAIR: "warning",
  POOR: "critical",
};
const STRESS_LEVELS: Record<string, StatusLevel> = {
  CALM: "good",
  BALANCED: "good",
  STRESSFUL: "warning",
  VERY_STRESSFUL: "critical",
};
const FACTOR_LEVELS: Record<string, StatusLevel> = {
  EXCELLENT: "good",
  VERY_GOOD: "good",
  GOOD: "good",
  MODERATE: "warning",
  POOR: "critical",
  VERY_POOR: "critical",
};
const TRAINING_STATUS_LEVELS: Record<string, StatusLevel> = {
  PEAKING: "good",
  PRODUCTIVE: "good",
  MAINTAINING: "good",
  RECOVERY: "good",
  UNPRODUCTIVE: "warning",
  DETRAINING: "warning",
  OVERREACHING: "critical",
  STRAINED: "critical",
};

/** Status from a Garmin key; unknown keys keep their label with no level. */
export function garminStatus(
  key: unknown,
  levels: Record<string, StatusLevel>,
): MetricStatus | null {
  const k = str(key);
  if (!k || k === "NONE" || k === "UNKNOWN" || k === "NO_STATUS") return null;
  const base = k.replace(/_\d+$/, "");
  return { key: k, label: humanize(k), level: levels[base] ?? null, source: "garmin" };
}

/**
 * Resting HR vs its 7-day average: within ±tolerance is typical; above is
 * flagged (a raised resting HR is a common sign of incomplete recovery).
 */
export function restingHrStatus(delta: number, tolerance = 3): MetricStatus {
  if (delta >= tolerance)
    return {
      key: "ABOVE_BASELINE",
      label: "Above 7-day avg",
      level: "warning",
      source: "baseline",
    };
  if (delta <= -tolerance)
    return { key: "BELOW_BASELINE", label: "Below 7-day avg", level: "good", source: "baseline" };
  return { key: "TYPICAL", label: "Typical", level: "good", source: "baseline" };
}

/** Garmin's stress scale: rest 0–25, low 26–50, medium 51–75, high 76–100. */
export function stressRange(value: number): Baseline {
  if (value <= 25) return { name: "Garmin rest range", low: 0, high: 25 };
  if (value <= 50) return { name: "Garmin low range", low: 26, high: 50 };
  if (value <= 75) return { name: "Garmin medium range", low: 51, high: 75 };
  return { name: "Garmin high range", low: 76, high: 100 };
}

const missing = (unit: string, reason: string): Metric => ({
  value: null,
  unit,
  baseline: null,
  delta: null,
  status: null,
  missing: reason,
});

const FAILED = "Couldn't load from Garmin";

// ── Per-metric builders ──────────────────────────────

const FACTORS: [string, string][] = [
  ["sleepScore", "Sleep score"],
  ["sleepHistory", "Sleep history"],
  ["recoveryTime", "Recovery time"],
  ["hrv", "HRV status"],
  ["acwr", "Acute load"],
  ["stressHistory", "Stress history"],
];

const FEEDBACK_RANK: Record<string, number> = {
  VERY_POOR: 0,
  POOR: 1,
  MODERATE: 2,
  GOOD: 3,
  VERY_GOOD: 4,
  EXCELLENT: 5,
};

export function readinessMetric(raw: unknown, date: string): Metric {
  if (raw === null) return missing("", FAILED);
  const entries = (Array.isArray(raw) ? raw : [raw]).filter(isRec);
  // Garmin can return several readings a day (on waking, after activities): use the latest
  const forDay = entries.filter((e) => !e.calendarDate || e.calendarDate === date);
  const latest = forDay.sort((a, b) =>
    String(b.timestampLocal ?? "").localeCompare(String(a.timestampLocal ?? "")),
  )[0];
  const score = num(latest?.score);
  if (!latest || score === null)
    return missing(
      "",
      "No training readiness for this date (needs a compatible watch worn overnight)",
    );

  const factors: ReadinessFactor[] = FACTORS.map(([key, name]) => {
    const feedback = str(latest[`${key}FactorFeedback`]);
    return {
      name,
      feedback,
      percent: num(latest[`${key}FactorPercent`]),
      level: feedback ? (FACTOR_LEVELS[feedback] ?? null) : null,
    };
  })
    .filter((f) => f.feedback !== null || f.percent !== null)
    // Weakest first: by Garmin's feedback, then by contribution percent
    .sort(
      (a, b) =>
        (FEEDBACK_RANK[a.feedback ?? ""] ?? 9) - (FEEDBACK_RANK[b.feedback ?? ""] ?? 9) ||
        (a.percent ?? 999) - (b.percent ?? 999),
    );

  const recoveryMin = num(latest.recoveryTime);
  return {
    value: score,
    unit: "/100",
    baseline: null,
    delta: null,
    status: garminStatus(latest.level, READINESS_LEVELS),
    details: {
      garminFeedback: str(latest.feedbackShort) ? humanize(String(latest.feedbackShort)) : null,
      recoveryHours: recoveryMin === null ? null : round(recoveryMin / 60, 1),
      factorsWeakestFirst: factors,
    },
  };
}

export function sleepMetrics(raw: unknown): { score: Metric; duration: Metric } {
  if (raw === null) return { score: missing("/100", FAILED), duration: missing("h", FAILED) };
  const dto = isRec(raw) && isRec(raw.dailySleepDTO) ? raw.dailySleepDTO : null;
  const seconds = num(dto?.sleepTimeSeconds);
  if (!dto || !seconds) {
    const reason = "No sleep recorded for last night";
    return { score: missing("/100", reason), duration: missing("h", reason) };
  }
  const scores = isRec(dto.sleepScores) ? dto.sleepScores : {};
  const overall = isRec(scores.overall) ? scores.overall : {};
  const total = isRec(scores.totalDuration) ? scores.totalDuration : {};

  const stage = (k: string) => {
    const s = num(dto[k]) ?? 0;
    return { hours: round(s / 3600, 2), percent: round((s / seconds) * 100) };
  };
  const stages = {
    deep: stage("deepSleepSeconds"),
    light: stage("lightSleepSeconds"),
    rem: stage("remSleepSeconds"),
    awake: stage("awakeSleepSeconds"),
  };

  const scoreValue = num(overall.value);
  const score: Metric =
    scoreValue === null
      ? missing("/100", "Garmin gave no sleep score for this night")
      : {
          value: scoreValue,
          unit: "/100",
          baseline: null,
          delta: null,
          status: garminStatus(overall.qualifierKey, QUALIFIER_LEVELS),
          details: {
            stages,
            avgSleepStress: num(dto.avgSleepStress),
            awakeCount: num(dto.awakeCount),
          },
        };

  const hours = round(seconds / 3600, 2);
  const optLow = num(total.optimalStart);
  const optHigh = num(total.optimalEnd) ?? optLow;
  const baseline: Baseline | null =
    optLow !== null && optHigh !== null
      ? {
          name: "Garmin's optimal sleep",
          low: round(optLow / 3600, 2),
          high: round(optHigh / 3600, 2),
        }
      : null;
  return {
    score,
    duration: {
      value: hours,
      unit: "h",
      baseline,
      delta: baseline ? round(deltaFromBand(hours, baseline.low!, baseline.high!), 2) : null,
      status: garminStatus(total.qualifierKey, QUALIFIER_LEVELS),
      details: { stages },
    },
  };
}

export function hrvMetric(raw: unknown, date: string): Metric {
  if (raw === null) return missing("ms", FAILED);
  const summaries = (isRec(raw) && Array.isArray(raw.hrvSummaries) ? raw.hrvSummaries : []).filter(
    isRec,
  );
  const sorted = [...summaries].sort((a, b) =>
    String(a.calendarDate).localeCompare(String(b.calendarDate)),
  );
  const trend = sorted.map((s) => ({ date: String(s.calendarDate), value: num(s.lastNightAvg) }));
  const today = sorted.find((s) => s.calendarDate === date);
  const value = num(today?.lastNightAvg);
  if (!today || value === null) {
    return {
      ...missing("ms", "No HRV reading for last night"),
      ...(trend.length ? { trend } : {}),
    };
  }
  const weeklyAvg = num(today.weeklyAvg);
  const b = isRec(today.baseline) ? today.baseline : {};
  const lo = num(b.balancedLow);
  const hi = num(b.balancedUpper);
  return {
    value,
    unit: "ms",
    baseline: weeklyAvg !== null ? { name: "7-night avg", value: weeklyAvg } : null,
    delta: weeklyAvg !== null ? value - weeklyAvg : null,
    status: garminStatus(today.status, HRV_LEVELS),
    trend,
    details: {
      balancedRange: lo !== null && hi !== null ? { low: lo, high: hi } : null,
      lastNightVsBalancedRange: lo !== null && hi !== null ? bandPosition(value, lo, hi) : null,
      weeklyAvgVsBalancedRange:
        lo !== null && hi !== null && weeklyAvg !== null ? bandPosition(weeklyAvg, lo, hi) : null,
    },
  };
}

export function summaryMetrics(
  raw: unknown,
  sleepRaw: unknown,
): { bodyBattery: Metric; restingHeartRate: Metric; stress: Metric; steps: Metric } {
  if (raw === null || !isRec(raw)) {
    const reason = raw === null ? FAILED : "No daily summary for this date";
    return {
      bodyBattery: missing("", reason),
      restingHeartRate: missing("bpm", reason),
      stress: missing("", reason),
      steps: missing("steps", reason),
    };
  }
  const sleepDto =
    isRec(sleepRaw) && isRec(sleepRaw.dailySleepDTO) ? sleepRaw.dailySleepDTO : undefined;

  // Body battery: most recent reading vs where it started the day
  const bb = num(raw.bodyBatteryMostRecentValue);
  const atWake = num(raw.bodyBatteryAtWakeTime);
  const bodyBattery: Metric =
    bb === null
      ? missing("", "No body battery readings for this date")
      : {
          value: bb,
          unit: "",
          baseline: atWake !== null ? { name: "at wake", value: atWake } : null,
          delta: atWake !== null ? bb - atWake : null,
          status: null,
          details: {
            high: num(raw.bodyBatteryHighestValue),
            low: num(raw.bodyBatteryLowestValue),
            charged: num(raw.bodyBatteryChargedValue),
            drained: num(raw.bodyBatteryDrainedValue),
            chargedDuringSleep: num(isRec(sleepRaw) ? sleepRaw.bodyBatteryChange : null),
          },
        };

  const rhr = num(raw.restingHeartRate) ?? num(sleepDto?.restingHeartRate);
  const rhr7 = num(raw.lastSevenDaysAvgRestingHeartRate);
  const restingHeartRate: Metric =
    rhr === null
      ? missing("bpm", "No resting heart rate for this date")
      : {
          value: rhr,
          unit: "bpm",
          baseline: rhr7 !== null ? { name: "7-day avg", value: rhr7 } : null,
          delta: rhr7 !== null ? rhr - rhr7 : null,
          status: rhr7 !== null ? restingHrStatus(rhr - rhr7) : null,
        };

  // Garmin uses negative values for "not enough data"
  const stressAvg = num(raw.averageStressLevel);
  const stress: Metric =
    stressAvg === null || stressAvg < 0
      ? missing("", "Not enough stress data for this date")
      : {
          value: stressAvg,
          unit: "",
          baseline: stressRange(stressAvg),
          delta: null,
          status: garminStatus(raw.stressQualifier, STRESS_LEVELS),
          details: {
            restMinutes: secsToMin(raw.restStressDuration),
            highStressMinutes: secsToMin(raw.highStressDuration),
          },
        };

  const stepCount = num(raw.totalSteps);
  const goal = num(raw.dailyStepGoal);
  const steps: Metric =
    stepCount === null
      ? missing("steps", "No step data for this date")
      : {
          value: stepCount,
          unit: "steps",
          baseline: goal ? { name: "daily goal", value: goal } : null,
          delta: goal ? stepCount - goal : null,
          status:
            goal && stepCount >= goal
              ? { key: "GOAL_MET", label: "Goal met", level: "good", source: "baseline" }
              : null,
          details: { percentOfGoal: goal ? round((stepCount / goal) * 100) : null },
        };

  return { bodyBattery, restingHeartRate, stress, steps };
}

function secsToMin(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.round(n / 60);
}

export function trainingStatusSummary(raw: unknown): Briefing["trainingStatus"] {
  if (!isRec(raw)) return null;
  const mrts = isRec(raw.mostRecentTrainingStatus) ? raw.mostRecentTrainingStatus : {};
  const payload = isRec(mrts.payload) ? mrts.payload : {};
  const byDevice = isRec(payload.latestTrainingStatusData) ? payload.latestTrainingStatusData : {};
  const entries = Object.values(byDevice).filter(isRec);
  const entry = entries.find((e) => e.primaryTrainingDevice === true) ?? entries[0];
  const status = garminStatus(entry?.trainingStatusFeedbackPhrase, TRAINING_STATUS_LEVELS);
  if (!entry || !status) return null;
  const acute = isRec(entry.acuteTrainingLoadDTO) ? entry.acuteTrainingLoadDTO : {};
  return {
    key: status.key,
    label: status.label,
    level: status.level,
    acwrStatus: str(acute.acwrStatus) ? humanize(String(acute.acwrStatus)) : null,
  };
}

export function activitySummary(
  raw: unknown,
  date: string,
): { lastActivity: LastActivity | null; last7Days: Briefing["last7Days"] } {
  if (!Array.isArray(raw)) return { lastActivity: null, last7Days: null };
  // On or before the briefing date (startTimeLocal is "YYYY-MM-DD HH:mm:ss" wall-clock)
  const acts = raw
    .filter(isRec)
    .filter((a) => typeof a.startTimeLocal === "string" && a.startTimeLocal.slice(0, 10) <= date)
    .sort((a, b) => String(b.startTimeLocal).localeCompare(String(a.startTimeLocal)));

  const weekStart = shiftDate(date, 6);
  const week = acts.filter((a) => String(a.startTimeLocal).slice(0, 10) >= weekStart);
  const sum = (k: string) => week.reduce((s, a) => s + (num(a[k]) ?? 0), 0);
  const last7Days = {
    activities: week.length,
    distanceKm: round(sum("distance") / 1000, 1),
    durationMin: Math.round(sum("duration") / 60),
    trainingLoad: Math.round(sum("activityTrainingLoad")),
  };

  const a = acts[0];
  if (!a) return { lastActivity: null, last7Days };
  const type = isRec(a.activityType) ? str(a.activityType.typeKey) : null;
  const distance = num(a.distance);
  const duration = num(a.duration);
  const aerobic = num(a.aerobicTrainingEffect);
  const anaerobic = num(a.anaerobicTrainingEffect);
  const id = a.activityId;
  return {
    lastActivity: {
      activityId: typeof id === "number" || typeof id === "string" ? id : null,
      name: str(a.activityName),
      type,
      startTimeLocal: String(a.startTimeLocal),
      daysAgo: daysBetween(String(a.startTimeLocal), date),
      distanceKm: distance ? round(distance / 1000, 2) : null,
      durationMin: duration !== null ? round(duration / 60, 1) : null,
      aerobicTrainingEffect: aerobic !== null ? round(aerobic, 1) : null,
      anaerobicTrainingEffect: anaerobic !== null ? round(anaerobic, 1) : null,
      trainingEffectLabel: str(a.trainingEffectLabel)
        ? humanize(String(a.trainingEffectLabel))
        : null,
      trainingLoad:
        num(a.activityTrainingLoad) !== null ? Math.round(num(a.activityTrainingLoad)!) : null,
    },
    last7Days,
  };
}

const SOURCE_NAMES: Record<keyof BriefingSources, string> = {
  readiness: "training readiness",
  sleep: "sleep",
  hrv: "HRV",
  summary: "daily summary",
  activities: "activities",
  trainingStatus: "training status",
};

/** Assemble the briefing. `sources` values are null for requests that failed. */
export function buildBriefing(date: string, today: string, sources: BriefingSources): Briefing {
  const sleep = sleepMetrics(sources.sleep);
  const summary = summaryMetrics(sources.summary, sources.sleep);
  return {
    date,
    isToday: date === today,
    metrics: {
      trainingReadiness: readinessMetric(sources.readiness, date),
      sleepScore: sleep.score,
      sleepDuration: sleep.duration,
      hrv: hrvMetric(sources.hrv, date),
      ...summary,
    },
    trainingStatus: trainingStatusSummary(sources.trainingStatus),
    ...activitySummary(sources.activities, date),
    failed: (Object.keys(sources) as (keyof BriefingSources)[])
      .filter((k) => sources[k] === null)
      .map((k) => SOURCE_NAMES[k]),
  };
}

// ── Text for Claude (shareContext) and suggested questions ──

function dayLabel(b: Briefing): string {
  return b.isToday ? "today" : `on ${b.date}`;
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const signed = (n: number, unit = "") =>
  `${n > 0 ? "+" : n < 0 ? "−" : "±"}${fmt(Math.abs(n))}${unit}`;

export function formatHours(h: number): string {
  const total = Math.round(h * 60);
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return hh ? (mm ? `${hh}h ${mm}m` : `${hh}h`) : `${mm}m`;
}

/** One plain-text paragraph of what the briefing view shows. */
export function briefingSummary(b: Briefing): string {
  const m = b.metrics;
  const parts: string[] = [];
  const st = (x: Metric) => (x.status ? ` (${x.status.label.toLowerCase()})` : "");
  if (m.trainingReadiness.value !== null)
    parts.push(`training readiness ${m.trainingReadiness.value}/100${st(m.trainingReadiness)}`);
  if (m.sleepScore.value !== null || m.sleepDuration.value !== null) {
    const bits = [
      m.sleepScore.value !== null ? `score ${m.sleepScore.value}${st(m.sleepScore)}` : null,
      m.sleepDuration.value !== null ? formatHours(m.sleepDuration.value) : null,
    ].filter(Boolean);
    parts.push(`sleep ${bits.join(", ")}`);
  }
  if (m.hrv.value !== null) {
    const base =
      m.hrv.baseline?.value !== undefined ? ` vs 7-night avg ${m.hrv.baseline.value}` : "";
    parts.push(`HRV ${m.hrv.value} ms${base}${st(m.hrv)}`);
  }
  if (m.bodyBattery.value !== null) {
    const wake = m.bodyBattery.baseline?.value;
    parts.push(
      `body battery ${m.bodyBattery.value}${wake !== undefined ? ` (${wake} at wake)` : ""}`,
    );
  }
  if (m.restingHeartRate.value !== null) {
    const avg = m.restingHeartRate.baseline?.value;
    parts.push(
      `resting HR ${m.restingHeartRate.value} bpm${avg !== undefined ? ` vs 7-day avg ${avg}` : ""}`,
    );
  }
  if (m.stress.value !== null) parts.push(`avg stress ${m.stress.value}${st(m.stress)}`);
  if (m.steps.value !== null) {
    const goal = m.steps.baseline?.value;
    parts.push(`${m.steps.value} steps${goal !== undefined ? ` of ${goal} goal` : ""}`);
  }
  if (b.trainingStatus) parts.push(`training status ${b.trainingStatus.label.toLowerCase()}`);
  let text = `Daily briefing ${dayLabel(b)} (${b.date}): ${parts.length ? parts.join("; ") : "no data available"}.`;
  const a = b.lastActivity;
  if (a) {
    const what = [a.name ?? (a.type ? humanize(a.type) : "activity")];
    if (a.distanceKm) what.push(`${a.distanceKm} km`);
    if (a.durationMin) what.push(`${Math.round(a.durationMin)} min`);
    if (a.aerobicTrainingEffect !== null) what.push(`aerobic TE ${a.aerobicTrainingEffect}`);
    text += ` Last activity: ${what.join(", ")} on ${a.startTimeLocal.slice(0, 10)}.`;
  }
  const missingNames = Object.entries(m)
    .filter(([, x]) => x.value === null)
    .map(([k]) => k);
  if (missingNames.length) text += ` Not available: ${missingNames.join(", ")}.`;
  return text;
}

/** 2–3 self-contained questions built from the numbers on screen. */
export function briefingQuestions(b: Briefing): string[] {
  const m = b.metrics;
  const when = b.isToday ? "today" : `on ${b.date}`;
  const night = b.isToday ? "last night" : `the night before ${b.date}`;
  const qs: string[] = [];

  const readiness = m.trainingReadiness.value;
  const hrv = m.hrv.value;
  if (readiness !== null || hrv !== null) {
    const given = [
      readiness !== null ? `training readiness of ${readiness}` : null,
      hrv !== null ? `HRV of ${hrv} ms` : null,
    ]
      .filter(Boolean)
      .join(" and ");
    qs.push(`Should I train hard ${when} given my ${given}?`);
  }
  if (m.sleepScore.value !== null) {
    qs.push(`Why was my sleep score ${m.sleepScore.value} ${night}, and what would improve it?`);
  } else if (m.sleepDuration.value !== null) {
    qs.push(`How did ${formatHours(m.sleepDuration.value)} of sleep ${night} affect my recovery?`);
  }
  const rhr = m.restingHeartRate;
  if (rhr.value !== null && rhr.delta !== null && Math.abs(rhr.delta) >= 3) {
    qs.push(
      `My resting heart rate ${when} is ${rhr.value} bpm, ${signed(rhr.delta, " bpm")} vs my 7-day average. What could explain that?`,
    );
  } else if (b.lastActivity) {
    const a = b.lastActivity;
    const name = a.name ?? (a.type ? humanize(a.type) : "activity");
    qs.push(
      `Am I recovered from my ${name} on ${a.startTimeLocal.slice(0, 10)}${a.distanceKm ? ` (${a.distanceKm} km)` : ""}?`,
    );
  }
  if (qs.length === 0) qs.push(`What does my Garmin data say about how I'm doing ${when}?`);
  return qs.slice(0, 3);
}
