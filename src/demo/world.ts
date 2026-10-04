/**
 * The demo athlete: a fictional recreational runner training for a half
 * marathon, simulated day by day for the ~400 days up to today.
 *
 * Over the year resting HR drifts 55 → 49, nightly HRV 45 → 58 ms, VO₂ max
 * 47 → 51 (with plateaus) and threshold pace 4:52 → 4:30/km, on 4–5 runs a
 * week in 3 build + 1 recovery week cycles. Everything is seeded by date, so
 * the same day always produces the same data.
 */
import { buildWorkout, type GarminWorkout, type WorkoutSpec } from "garmin-connect";
import { Rng, clamp, mean, round } from "./random.ts";
import {
  simulate,
  summarize,
  type Intensity,
  type RunKind,
  type RunPlan,
  type RunSummary,
  type Segment,
} from "./run.ts";
import { addDays, dayDiff, localMs, mondayOf, weekday } from "./time.ts";

export const PERSONA = {
  displayName: "demo-runner",
  fullName: "Demo Runner",
  userName: "demo-runner@example.com",
  profileId: 82_460_117,
  garminGUID: "8f0c1d2e-3a4b-4c5d-9e6f-0a1b2c3d4e5f",
  maxHr: 188,
  heightCm: 175,
  birthDate: "1990-04-12",
  age: 36,
  device: "Forerunner 265",
  deviceId: 3_486_204_117,
  deviceTypePk: 37_114,
};

/** Days of history, ending today. */
export const DAYS = 400;
/** Today's data stops at 10:30 (morning, so "today" reads as partway through). */
export const SNAPSHOT_SECS = 10.5 * 3600;

export interface Night {
  /** Sleep start / end, epoch ms (ends on the morning of the day) */
  start: number;
  end: number;
  sleepSecs: number;
  deepSecs: number;
  lightSecs: number;
  remSecs: number;
  awakeSecs: number;
  awakeCount: number;
  score: number;
  avgSleepStress: number;
  avgRespiration: number;
}

export interface DemoRun {
  plan: RunPlan;
  summary: RunSummary;
}

export interface ReadinessFactor {
  percent: number;
  feedback: string;
}

export interface DemoDay {
  date: string;
  index: number;
  /** 0 = a year+ ago … 1 = today */
  p: number;
  isToday: boolean;
  weeksAgo: number;
  rhr: number;
  rhr7: number;
  hrv: number;
  hrvWeekly: number;
  hrvBaseline: {
    lowUpper: number;
    balancedLow: number;
    balancedUpper: number;
    markerValue: number;
  };
  hrvStatus: "BALANCED" | "UNBALANCED" | "LOW";
  night: Night;
  runs: DemoRun[];
  steps: number;
  stepGoal: number;
  walkMeters: number;
  floors: number;
  stressAvg: number;
  stressMax: number;
  bb: {
    midnight: number;
    atWake: number;
    /** level when going to bed (null today) */
    bed: number | null;
    /** level at the end of the day (or at the snapshot today) */
    end: number;
    high: number;
    low: number;
    charged: number;
    drained: number;
    /** afternoon top-up */
    rech: number;
    drainPerHour: number;
  };
  load: number;
  acute: number;
  chronic: number;
  vo2: number | null;
  vo2Latest: number;
  weightKg: number | null;
  readiness: {
    score: number;
    level: string;
    feedbackShort: string;
    feedbackLong: string;
    recoveryTimeMin: number;
    factors: Record<
      "sleepScore" | "sleepHistory" | "recoveryTime" | "hrv" | "acwr" | "stressHistory",
      ReadinessFactor
    >;
  };
  trainingStatus: string;
  moderateMinutes: number;
  vigorousMinutes: number;
  walkingModerate: number;
  minHr: number;
  maxHr: number;
  respiration: number;
  spo2: number;
  tempC: number;
}

export interface SavedWorkout {
  workoutId: number;
  key: TemplateKey;
  workout: GarminWorkout;
  createdMs: number;
  updatedMs: number;
}

export interface ScheduledWorkout {
  scheduleId: number;
  workoutId: number;
  date: string;
}

export interface World {
  today: string;
  days: DemoDay[];
  byDate: Map<string, DemoDay>;
  runs: DemoRun[];
  runById: Map<number, DemoRun>;
  workouts: SavedWorkout[];
  schedule: ScheduledWorkout[];
  /** Goal race (calendar event) */
  race: { id: number; date: string; title: string };
  weighIns: { date: string; ms: number; kg: number }[];
}

// ── Fitness over the year ─────────────────────────────

const ease = (p: number) => 1 - (1 - p) ** 1.5;
export const thresholdPace = (p: number) => 292 - 22 * ease(p);
const easyPace = (thr: number) => thr * 1.21;
const longPace = (thr: number) => thr * 1.2;
const recoveryPace = (thr: number) => thr * 1.28;
const tempoPace = (thr: number) => thr * 1.03;
const repPace = (thr: number, meters: number) => thr * (meters <= 800 ? 0.945 : 0.965);
const jogPace = (thr: number) => thr * 1.45;

/** VO₂ max: 47 → 51 with plateaus (piecewise-linear progress curve). */
function vo2Trend(p: number): number {
  const pts: [number, number][] = [
    [0, 0],
    [0.1, 0.2],
    [0.32, 0.23],
    [0.42, 0.5],
    [0.6, 0.53],
    [0.7, 0.8],
    [0.86, 0.83],
    [1, 1],
  ];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    if (p <= x1) return 46.8 + 4.5 * (y0 + ((p - x0) / (x1 - x0)) * (y1 - y0));
  }
  return 51.3;
}

// ── Workout templates (saved workouts and the runs that follow them) ──

export type TemplateKey =
  | "easy40"
  | "recovery30"
  | "intervals800"
  | "intervals1000"
  | "tempo3x10"
  | "progression10"
  | "long16"
  | "long12";

const mmss = (secs: number) => {
  const s = Math.round(secs);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const paceRange = (center: number, spread: number) => ({
  fast: mmss(center - spread),
  slow: mmss(center + spread),
});

interface Template {
  kind: RunKind;
  name: string;
  spec: (thr: number) => WorkoutSpec;
  segments: (thr: number) => Segment[];
  laps: RunPlan["laps"];
}

const seg = (pace: number, intensity: Intensity, amount: { m?: number; s?: number }): Segment => ({
  pace,
  intensity,
  ...(amount.m !== undefined && { meters: amount.m }),
  ...(amount.s !== undefined && { seconds: amount.s }),
});

function repeatSegs(n: number, work: Segment, rest: Segment): Segment[] {
  return Array.from({ length: n }, () => [work, rest]).flat();
}

const TEMPLATES: Record<TemplateKey, Template> = {
  easy40: {
    kind: "easy",
    name: "Easy Run 40 min Z2",
    laps: "segments",
    spec: () => ({
      name: "Easy Run 40 min Z2",
      sport: "running",
      steps: [{ type: "run", duration: { seconds: 2400 }, target: { hrZone: 2 } }],
    }),
    segments: (thr) => [
      seg(easyPace(thr) + 10, "INTERVAL", { s: 600 }),
      seg(easyPace(thr), "INTERVAL", { s: 1800 }),
    ],
  },
  recovery30: {
    kind: "recovery",
    name: "Recovery Run 30 min",
    laps: "segments",
    spec: () => ({
      name: "Recovery Run 30 min",
      sport: "running",
      steps: [{ type: "run", duration: { seconds: 1800 }, target: { hrZone: 1 } }],
    }),
    segments: (thr) => [seg(recoveryPace(thr), "INTERVAL", { s: 1800 })],
  },
  intervals800: {
    kind: "intervals",
    name: "Track Intervals 6×800 m",
    laps: "segments",
    spec: (thr) => ({
      name: "Track Intervals 6×800 m",
      sport: "running",
      description: "800 m repeats at 5K effort, 90 s jog between",
      steps: [
        { type: "warmup", duration: { seconds: 900 }, target: { hrZone: 2 } },
        {
          repeat: 6,
          steps: [
            {
              type: "run",
              duration: { meters: 800 },
              target: { pace: paceRange(repPace(thr, 800), 4) },
            },
            { type: "recovery", duration: { seconds: 90 } },
          ],
        },
        { type: "cooldown", duration: { seconds: 600 }, target: { hrZone: 1 } },
      ],
    }),
    segments: (thr) => [
      seg(easyPace(thr) + 10, "WARMUP", { s: 900 }),
      ...repeatSegs(
        6,
        seg(repPace(thr, 800), "INTERVAL", { m: 800 }),
        seg(jogPace(thr), "RECOVERY", { s: 90 }),
      ),
      seg(easyPace(thr) + 20, "COOLDOWN", { s: 600 }),
    ],
  },
  intervals1000: {
    kind: "intervals",
    name: "Track Intervals 5×1000 m",
    laps: "segments",
    spec: (thr) => ({
      name: "Track Intervals 5×1000 m",
      sport: "running",
      description: "1 km repeats at 10K effort, 2 min jog between",
      steps: [
        { type: "warmup", duration: { seconds: 900 }, target: { hrZone: 2 } },
        {
          repeat: 5,
          steps: [
            {
              type: "run",
              duration: { meters: 1000 },
              target: { pace: paceRange(repPace(thr, 1000), 4) },
            },
            { type: "recovery", duration: { seconds: 120 } },
          ],
        },
        { type: "cooldown", duration: { seconds: 600 }, target: { hrZone: 1 } },
      ],
    }),
    segments: (thr) => [
      seg(easyPace(thr) + 10, "WARMUP", { s: 900 }),
      ...repeatSegs(
        5,
        seg(repPace(thr, 1000), "INTERVAL", { m: 1000 }),
        seg(jogPace(thr), "RECOVERY", { s: 120 }),
      ),
      seg(easyPace(thr) + 20, "COOLDOWN", { s: 600 }),
    ],
  },
  tempo3x10: {
    kind: "tempo",
    name: "Tempo 3×10 min",
    laps: "segments",
    spec: (thr) => ({
      name: "Tempo 3×10 min",
      sport: "running",
      description: "Comfortably hard: half-marathon to 10K effort",
      steps: [
        { type: "warmup", duration: { seconds: 900 }, target: { hrZone: 2 } },
        {
          repeat: 3,
          steps: [
            {
              type: "run",
              duration: { seconds: 600 },
              target: { pace: paceRange(tempoPace(thr), 5) },
            },
            { type: "recovery", duration: { seconds: 120 } },
          ],
        },
        { type: "cooldown", duration: { seconds: 600 }, target: { hrZone: 1 } },
      ],
    }),
    segments: (thr) => [
      seg(easyPace(thr) + 10, "WARMUP", { s: 900 }),
      ...repeatSegs(
        3,
        seg(tempoPace(thr), "INTERVAL", { s: 600 }),
        seg(jogPace(thr) - 20, "RECOVERY", { s: 120 }),
      ),
      seg(easyPace(thr) + 20, "COOLDOWN", { s: 600 }),
    ],
  },
  progression10: {
    kind: "progression",
    name: "Progression Run 10 km",
    laps: "segments",
    spec: (thr) => ({
      name: "Progression Run 10 km",
      sport: "running",
      steps: [
        { type: "run", duration: { meters: 4000 }, target: { pace: paceRange(easyPace(thr), 8) } },
        {
          type: "run",
          duration: { meters: 4000 },
          target: { pace: paceRange((easyPace(thr) + tempoPace(thr)) / 2, 6) },
        },
        { type: "run", duration: { meters: 2000 }, target: { pace: paceRange(tempoPace(thr), 5) } },
      ],
    }),
    segments: (thr) => [
      seg(easyPace(thr), "INTERVAL", { m: 4000 }),
      seg((easyPace(thr) + tempoPace(thr)) / 2, "INTERVAL", { m: 4000 }),
      seg(tempoPace(thr), "INTERVAL", { m: 2000 }),
    ],
  },
  long16: {
    kind: "long",
    name: "Long Run 16 km",
    laps: "auto",
    spec: (thr) => ({
      name: "Long Run 16 km",
      sport: "running",
      description: "Steady and conversational; last 2 km a little quicker if it feels good",
      steps: [
        {
          type: "run",
          duration: { meters: 16000 },
          target: { pace: paceRange(longPace(thr), 10) },
        },
      ],
    }),
    segments: (thr) => [
      seg(longPace(thr) + 10, "INTERVAL", { m: 1000 }),
      seg(longPace(thr), "INTERVAL", { m: 13000 }),
      seg(longPace(thr) - 15, "INTERVAL", { m: 2000 }),
    ],
  },
  long12: {
    kind: "long",
    name: "Long Run 12 km",
    laps: "auto",
    spec: (thr) => ({
      name: "Long Run 12 km",
      sport: "running",
      steps: [
        {
          type: "run",
          duration: { meters: 12000 },
          target: { pace: paceRange(longPace(thr), 10) },
        },
      ],
    }),
    segments: (thr) => [
      seg(longPace(thr) + 8, "INTERVAL", { m: 1000 }),
      seg(longPace(thr), "INTERVAL", { m: 11000 }),
    ],
  },
};

const TEMPLATE_ORDER: TemplateKey[] = [
  "easy40",
  "intervals800",
  "tempo3x10",
  "long16",
  "recovery30",
  "intervals1000",
  "progression10",
  "long12",
];

// ── Weekly structure ──────────────────────────────────

type Cycle = "build1" | "build2" | "build3" | "recovery";
const CYCLES: Cycle[] = ["build1", "recovery", "build3", "build2"];
const VOLUME: Record<Cycle, number> = { build1: 0.93, build2: 1.0, build3: 1.08, recovery: 0.72 };
const cycleOf = (weeksAgo: number) => CYCLES[((weeksAgo % 4) + 4) % 4]!;

/** Weeks with workouts on the calendar: last week, this week and next week. */
const SCHEDULED_WEEKS = [1, 0, -1];
/** The week the runner was ill (no running Tue–Sat, low HRV, raised RHR). */
const ILL_WEEK = 29;
/** Illness severity by day from its Tuesday start */
const ILLNESS = [0.4, 0.85, 1, 0.9, 0.7, 0.5, 0.35, 0.25, 0.15, 0.08];

/** Planned workout per weekday (0 = Sun) for a scheduled week. */
function weekTemplates(weeksAgo: number): Partial<Record<number, TemplateKey>> {
  if (cycleOf(weeksAgo) === "recovery") {
    return { 2: "easy40", 4: "easy40", 6: "recovery30", 0: "long12" };
  }
  return {
    2: weeksAgo % 2 === 0 ? "intervals800" : "intervals1000",
    3: "easy40",
    4: weeksAgo === 0 ? "tempo3x10" : "progression10",
    6: "recovery30",
    0: "long16",
  };
}

// ── Build ─────────────────────────────────────────────

function runName(kind: RunKind, startSecs: number, rng: Rng): string {
  switch (kind) {
    case "easy":
      if (startSecs > 15 * 3600) return "Evening Run";
      return rng.chance(0.35) ? "Morning Run" : "Easy Run";
    case "recovery":
      return "Recovery Run";
    case "long":
      return "Long Run";
    case "tempo":
      return "Tempo Run";
    case "progression":
      return "Progression Run";
    case "intervals":
      return "Track Intervals";
  }
}

function historySegments(
  kind: RunKind,
  thr: number,
  p: number,
  volume: number,
  weeksAgo: number,
  rng: Rng,
): { segments: Segment[]; laps: RunPlan["laps"] } {
  switch (kind) {
    case "easy": {
      const km = clamp(5.8 + 2.6 * ease(p) * volume + rng.normal(0, 0.5), 5.2, 10);
      const total = Math.round(km * 100) * 10;
      return {
        laps: "auto",
        segments: [
          seg(easyPace(thr) + 14 + rng.normal(0, 3), "ACTIVE", { m: 1000 }),
          seg(easyPace(thr) + rng.normal(0, 4), "ACTIVE", { m: total - 2500 }),
          seg(easyPace(thr) - 16 + rng.normal(0, 4), "ACTIVE", { m: 1500 }),
        ],
      };
    }
    case "recovery": {
      const total = Math.round(rng.range(5.0, 6.4) * 100) * 10;
      return {
        laps: "auto",
        segments: [
          seg(recoveryPace(thr) + 10, "ACTIVE", { m: 1000 }),
          seg(recoveryPace(thr) - 4 + rng.normal(0, 4), "ACTIVE", { m: total - 1000 }),
        ],
      };
    }
    case "long": {
      // Two weeks ago (peak week) was the half-marathon-distance rehearsal
      const km =
        weeksAgo === 2
          ? 21.15
          : clamp((12 + 6.5 * ease(p)) * volume + rng.normal(0, 0.6), 10.5, 19.5);
      const total = Math.round(km * 100) * 10;
      const fastFinish = rng.chance(0.5);
      return {
        laps: "auto",
        segments: [
          seg(longPace(thr) + 12, "ACTIVE", { m: 1000 }),
          seg(longPace(thr) + rng.normal(0, 4), "ACTIVE", { m: total - 4000 }),
          seg(longPace(thr) - (fastFinish ? 22 : 6), "ACTIVE", { m: 3000 }),
        ],
      };
    }
    case "tempo": {
      if (weeksAgo % 3 === 0)
        return { laps: "segments", segments: TEMPLATES.tempo3x10.segments(thr) };
      const minutes = Math.round(20 + 10 * ease(p));
      return {
        laps: "segments",
        segments: [
          seg(easyPace(thr) + 10, "WARMUP", { m: 2000 }),
          seg(tempoPace(thr) + 4 + rng.normal(0, 3), "INTERVAL", { s: minutes * 60 }),
          seg(easyPace(thr) + 22, "COOLDOWN", { m: 1500 }),
        ],
      };
    }
    case "progression":
      return { laps: "segments", segments: TEMPLATES.progression10.segments(thr) };
    case "intervals": {
      const meters = weeksAgo % 2 === 0 ? 800 : 1000;
      const reps = meters === 800 ? 5 + Math.round(1.4 * ease(p)) : 4 + Math.round(1.4 * ease(p));
      return {
        laps: "segments",
        segments: [
          seg(easyPace(thr) + 10, "WARMUP", { m: 2000 }),
          ...repeatSegs(
            reps,
            seg(repPace(thr, meters) + rng.normal(0, 2), "INTERVAL", { m: meters }),
            seg(jogPace(thr), "RECOVERY", { s: meters === 800 ? 90 : 120 }),
          ),
          seg(easyPace(thr) + 22, "COOLDOWN", { m: 1500 }),
        ],
      };
    }
  }
}

function activityId(index: number, k: number): number {
  return 20_100_000_000 + index * 3_210_000 + k * 1_000_000 + Rng.of("aid", index).int(0, 899_999);
}

/** Template with today's fitness, for saved workouts and their runs. */
function workoutFor(key: TemplateKey, thr: number): GarminWorkout {
  return buildWorkout(TEMPLATES[key].spec(thr));
}

export function buildWorld(today: string): World {
  const start = addDays(today, -(DAYS - 1));
  const todayMonday = mondayOf(today);
  const yesterday = addDays(today, -1);
  const thrToday = thresholdPace(1);
  const illStart = addDays(todayMonday, -7 * ILL_WEEK + 1);

  // Saved workouts and the calendar
  const workouts: SavedWorkout[] = TEMPLATE_ORDER.map((key, i) => {
    const created = localMs(addDays(today, -(120 - i * 11)), 20 * 3600 + i * 600);
    return {
      workoutId: 1_184_520_000 + i * 7_331,
      key,
      workout: workoutFor(key, thrToday),
      createdMs: created,
      updatedMs: created + (i % 3) * 86_400_000 * 9,
    };
  });
  const workoutIdOf = (key: TemplateKey) => workouts.find((w) => w.key === key)!.workoutId;
  const schedule: ScheduledWorkout[] = [];
  for (const w of SCHEDULED_WEEKS) {
    const monday = addDays(todayMonday, -7 * w);
    for (const [dow, key] of Object.entries(weekTemplates(w))) {
      const date = addDays(monday, (Number(dow) + 6) % 7);
      schedule.push({
        scheduleId: 1_650_330_000 + schedule.length * 1_017 + (w + 2) * 101,
        workoutId: workoutIdOf(key!),
        date,
      });
    }
  }
  schedule.sort((a, b) => a.date.localeCompare(b.date));

  const days: DemoDay[] = [];
  const runs: DemoRun[] = [];
  const nightsOf: Night[] = [];

  // Pass 1: runs
  const runsByDay: DemoRun[][] = [];
  for (let i = 0; i < DAYS; i++) {
    const date = addDays(start, i);
    const p = i / (DAYS - 1);
    const dow = weekday(date);
    const weeksAgo = Math.round(dayDiff(mondayOf(date), todayMonday) / 7);
    const cycle = cycleOf(weeksAgo);
    const rng = Rng.of("day-plan", date);
    const thr = thresholdPace(p) + rng.normal(0, 2);
    const volume = VOLUME[cycle];
    const scheduled = SCHEDULED_WEEKS.includes(weeksAgo) ? weekTemplates(weeksAgo) : null;
    const dayRuns: DemoRun[] = [];

    let kind: RunKind | null = null;
    let template: TemplateKey | null = null;
    if (date === today) {
      kind = null;
    } else if (scheduled) {
      template = scheduled[dow] ?? null;
      kind = template ? TEMPLATES[template].kind : null;
    } else if (weeksAgo === ILL_WEEK && dow >= 2 && dow <= 6) {
      kind = null;
    } else {
      const early = p < 0.22;
      switch (dow) {
        case 2:
          kind = cycle === "recovery" ? "easy" : "intervals";
          break;
        case 3:
          kind = rng.chance(early ? 0.45 : 0.78) ? "easy" : null;
          break;
        case 4:
          kind = cycle === "recovery" ? "easy" : weeksAgo % 3 === 2 ? "progression" : "tempo";
          break;
        case 6:
          kind = rng.chance(early ? 0.4 : 0.68) ? (rng.chance(0.5) ? "recovery" : "easy") : null;
          break;
        case 0:
          kind = weeksAgo === ILL_WEEK ? "easy" : "long";
          break;
        default:
          kind = dow === 5 && rng.chance(0.06) ? "recovery" : null;
      }
      if (kind && rng.chance(0.05) && date !== yesterday) kind = null;
    }
    if (date === yesterday && !kind) kind = "recovery";

    if (kind) {
      const startSecs =
        dow === 0
          ? rng.range(7.5, 8.3) * 3600
          : dow === 6
            ? rng.range(8.0, 9.0) * 3600
            : kind === "easy" && dow === 3 && rng.chance(0.3)
              ? rng.range(18.1, 18.7) * 3600
              : rng.range(6.2, 7.0) * 3600;
      let segments: Segment[];
      let laps: RunPlan["laps"];
      let workoutId: number | null = null;
      if (template && date < today) {
        segments = TEMPLATES[template].segments(thr);
        laps = TEMPLATES[template].laps;
        workoutId = workoutIdOf(template);
      } else {
        const h = historySegments(kind, thr, p, volume, weeksAgo, rng);
        segments = h.segments;
        laps = h.laps;
      }
      // The latest run was recorded as one lap (auto-lap off): the splits
      // view falls back to per-km splits computed from the time series
      if (date === yesterday) {
        laps = "single";
        workoutId = null;
        if (kind === "easy" || kind === "recovery") {
          // An easy run that finished quicker than it started (negative split)
          kind = "easy";
          const extra = Math.round(rng.range(80, 240) / 10) * 10;
          segments = [
            seg(easyPace(thr) + 20, "ACTIVE", { m: 1000 }),
            seg(easyPace(thr) + 6, "ACTIVE", { m: 4000 }),
            seg(easyPace(thr) - 6, "ACTIVE", { m: 1000 }),
            seg(easyPace(thr) - 16, "ACTIVE", { m: 1000 }),
            seg(easyPace(thr) - 26, "ACTIVE", { m: 1000 + extra }),
          ];
        } else {
          segments = historySegments(kind, thr, p, volume, weeksAgo, rng).segments;
        }
      }
      const dayOfYear = dayDiff(`${date.slice(0, 4)}-01-01`, date);
      const tempC = round(
        11 + 9 * Math.sin((2 * Math.PI * (dayOfYear - 110)) / 365) + rng.normal(0, 2.2),
        1,
      );
      const plan: RunPlan = {
        id: activityId(i, 0),
        date,
        kind,
        name: runName(kind, startSecs, rng),
        startMs: localMs(date, Math.round(startSecs)),
        seed: Rng.of("run", date).int(1, 2 ** 31),
        segments,
        laps,
        restHr: Math.round(55 - 6 * ease(p)),
        maxHr: PERSONA.maxHr,
        thresholdPace: thr,
        hills: kind === "intervals" ? 1.2 : kind === "long" ? rng.range(10, 16) : rng.range(5, 11),
        tempC,
        workoutId,
        weightKg: 68,
      };
      const run = { plan, summary: summarize(plan, simulate(plan)) };
      dayRuns.push(run);
      runs.push(run);
    }
    runsByDay.push(dayRuns);
  }

  // Pass 2: load
  const dayLoad = runsByDay.map((rs) => rs.reduce((s, r) => s + r.summary.trainingLoad, 0));
  const acute: number[] = [];
  const chronic: number[] = [];
  // Exponentially weighted: acute ≈ a week of load, chronic ≈ four weeks of acute.
  // Start from the habits of the first weeks (no ramp from zero).
  const kA = Math.exp(-1 / 7);
  const kC = Math.exp(-1 / 28);
  let a = 400;
  let c = 400;
  for (let i = 0; i < DAYS; i++) {
    a = a * kA + dayLoad[i]! * (1 - kA) * 7;
    c = c * kC + a * (1 - kC);
    acute.push(a);
    chronic.push(c);
  }

  // Pass 3: nights, HRV, resting HR, wellness
  const hrvs: number[] = [];
  const rhrs: number[] = [];
  let prevBed = 30;
  let latestVo2 = vo2Trend(0);
  let vo2Noise = 0;
  const recoveries: { endMs: number; hours: number }[] = [];
  const weighIns: World["weighIns"] = [];
  let nextWeighIn = 3;

  for (let i = 0; i < DAYS; i++) {
    const date = addDays(start, i);
    const p = i / (DAYS - 1);
    const dow = weekday(date);
    const isToday = date === today;
    const weeksAgo = Math.round(dayDiff(mondayOf(date), todayMonday) / 7);
    const rng = Rng.of("day", date);
    const sick = dayDiff(illStart, date);
    const ill = sick >= 0 && sick < ILLNESS.length ? ILLNESS[sick]! : 0;
    const prevLoad = dayLoad[i - 1] ?? 0;
    const hardYesterday = prevLoad > 140;

    // Night ending this morning
    const weekendNight = dow === 6 || dow === 0;
    const poor = !isToday && (rng.chance(0.035) || ill > 0.6);
    let sleepH = poor
      ? rng.range(5.4, 6.2)
      : clamp(7.25 + rng.normal(0, 0.38) + (weekendNight ? 0.3 : 0), 6.1, 8.6);
    if (isToday) sleepH = 7 + 20 / 60;
    const sleepSecs = Math.round((sleepH * 3600) / 60) * 60;
    let deepF = clamp(0.17 + rng.normal(0, 0.022) - (poor ? 0.04 : 0), 0.08, 0.25);
    let remF = clamp(0.22 + rng.normal(0, 0.022), 0.13, 0.29);
    let awakeSecs =
      Math.round(clamp(900 + rng.normal(0, 360) + (poor ? 1200 : 0), 240, 3000) / 60) * 60;
    if (isToday) {
      deepF = 0.18;
      remF = 0.23;
      awakeSecs = 1080;
    }
    let score = Math.round(
      clamp(
        80 +
          9 * (sleepH - 7.4) +
          70 * (deepF - 0.17) +
          40 * (remF - 0.22) -
          (awakeSecs - 900) / 180 +
          rng.normal(0, 3) -
          (poor ? 4 : 0),
        48,
        95,
      ),
    );
    if (isToday) score = 81;
    const bedSecs = (weekendNight ? 23.4 : 22.8) * 3600 + rng.normal(0, 1300);
    const nightStart = localMs(addDays(date, -1), Math.round(bedSecs / 60) * 60);
    const deepSecs = Math.round((sleepSecs * deepF) / 60) * 60;
    const remSecs = Math.round((sleepSecs * remF) / 60) * 60;
    const night: Night = {
      start: nightStart,
      end: nightStart + (sleepSecs + awakeSecs) * 1000,
      sleepSecs,
      deepSecs,
      remSecs,
      lightSecs: sleepSecs - deepSecs - remSecs,
      awakeSecs,
      awakeCount: rng.int(1, poor ? 5 : 3),
      score,
      avgSleepStress: Math.round(clamp(15 + rng.normal(0, 3) + (poor ? 8 : 0) + ill * 10, 8, 40)),
      avgRespiration: round(14.6 + rng.normal(0, 0.4) + ill * 1.5, 1),
    };
    nightsOf.push(night);

    // HRV (overnight) and resting HR
    const recoveryWeek = cycleOf(weeksAgo) === "recovery";
    let hrv = Math.round(
      45 +
        13 * ease(p) +
        rng.normal(0, 3) -
        (hardYesterday ? rng.range(3, 8) : 0) +
        (recoveryWeek ? 1.5 : 0) -
        ill * 17 -
        (poor ? 3 : 0),
    );
    if (isToday) {
      const prev6 = hrvs.slice(-6);
      hrv = Math.round(mean(prev6) + 4);
    }
    hrvs.push(hrv);
    let rhr = Math.round(
      55 -
        6 * ease(p) +
        0.7 * Math.sin((2 * Math.PI * i) / 97) +
        rng.normal(0, 0.9) +
        (hardYesterday ? 1.2 : 0) +
        ill * 5 +
        (poor ? 1 : 0),
    );
    if (isToday) rhr = Math.round(mean(rhrs.slice(-6))) - 1;
    rhrs.push(rhr);
    const rhr7 = Math.round(mean(rhrs.slice(-7)));
    const hrvWeekly = Math.round(mean(hrvs.slice(-7)));
    const base = mean(hrvs.slice(-21));
    const hrvBaseline = {
      lowUpper: Math.round(base * 0.82),
      balancedLow: Math.round(base * 0.9),
      balancedUpper: Math.round(base * 1.13),
      markerValue: round(clamp((hrvWeekly - base * 0.75) / (base * 0.5), 0, 1), 4),
    };
    const hrvStatus =
      hrvWeekly < hrvBaseline.lowUpper
        ? "LOW"
        : hrvWeekly < hrvBaseline.balancedLow || hrvWeekly > hrvBaseline.balancedUpper
          ? "UNBALANCED"
          : "BALANCED";

    // Runs today, VO₂ max, weight
    const dayRuns = runsByDay[i]!;
    let vo2: number | null = null;
    if (dayRuns.length) {
      // Garmin's estimate wanders a little around the trend and dips after illness
      vo2Noise = 0.7 * vo2Noise + rng.normal(0, 0.09);
      const afterIll = sick >= 0 && sick < 28 ? 0.7 * (1 - sick / 28) : 0;
      vo2 = round(vo2Trend(p) + vo2Noise - afterIll, 1);
      latestVo2 = vo2;
    }
    let weightKg: number | null = null;
    if (i === nextWeighIn) {
      weightKg = round(
        68.4 - 0.6 * ease(p) + 0.35 * Math.sin((2 * Math.PI * i) / 61) + rng.normal(0, 0.22),
        1,
      );
      const ms = localMs(date, 7 * 3600 + rng.int(0, 1800));
      weighIns.push({ date, ms, kg: weightKg });
      nextWeighIn = i + rng.int(5, 12);
    }

    // Steps
    const runSteps = dayRuns.reduce((s, r) => s + r.summary.steps, 0);
    let walk = dayRuns.length
      ? rng.range(2600, 4600)
      : rng.range(6800, 9800) + (dow === 6 || dow === 0 ? 900 : 0);
    if (ill) walk *= 0.55;
    let steps = Math.round(walk + runSteps);
    if (isToday) steps = 4_820;
    const walkMeters = Math.round((isToday ? steps : walk) * 0.76);

    // Stress
    let stressAvg = Math.round(
      clamp(
        31 -
          5 * ease(p) +
          rng.normal(0, 3.4) +
          (poor ? 5 : 0) +
          ill * 9 -
          (dow === 6 || dow === 0 ? 4 : 0),
        18,
        46,
      ),
    );
    if (isToday) stressAvg = 26;
    const stressMax = Math.round(clamp(stressAvg + 48 + rng.normal(0, 7), 62, 99));

    // Body battery: wake level from the night, drain while awake, runs cost extra
    let atWake = Math.round(
      clamp(70 + 1.1 * (score - 72) + rng.normal(0, 3.5) - ill * 12, 38, 100),
    );
    if (isToday) atWake = 85;
    const runDrain = dayRuns.reduce((s, r) => s + r.summary.trainingLoad / 6, 0);
    const drainPerHour = 1.5 + stressAvg / 38;
    const sleepHours = (night.end - night.start) / 3_600_000;
    const chargePerHour = (atWake - prevBed) / Math.max(sleepHours, 1);
    const midnightMs = localMs(date, 0);
    const midnight = Math.round(
      clamp(prevBed + chargePerHour * Math.max(0, (midnightMs - night.start) / 3_600_000), 5, 100),
    );
    // The previous day ends where this one starts
    if (days.length) {
      const prev = days[days.length - 1]!;
      prev.bb.end = midnight;
      prev.bb.charged += Math.max(0, midnight - (prev.bb.bed ?? midnight));
      prev.bb.low = Math.min(prev.bb.low, prev.bb.bed ?? prev.bb.low);
    }
    const rech = Math.round(rng.range(0, 6));
    let bed: number | null = null;
    let end: number;
    let drained: number;
    if (isToday) {
      const hoursAwake = (localMs(date, SNAPSHOT_SECS) - night.end) / 3_600_000;
      end = Math.round(atWake - drainPerHour * hoursAwake);
      drained = atWake - end;
    } else {
      // Bedtime is tomorrow night's sleep start (approximate with this day's)
      const bedMs = localMs(date, Math.round(bedSecs));
      const hoursAwake = (bedMs - night.end) / 3_600_000;
      bed = Math.round(clamp(atWake - drainPerHour * hoursAwake - runDrain + rech, 10, 60));
      drained = atWake + rech - bed;
      end = bed;
    }
    prevBed = bed ?? end;

    // Intensity minutes
    const moderateMinutes =
      dayRuns.reduce((s, r) => s + r.summary.moderateMinutes, 0) + (isToday ? 4 : rng.int(0, 14));
    const vigorousMinutes = dayRuns.reduce((s, r) => s + r.summary.vigorousMinutes, 0);

    // Training readiness (morning): sleep, HRV, recovery from recent runs, load, stress
    const wakeMs = night.end;
    const recoveryLeftH = recoveries.reduce(
      (m, r) => Math.max(m, r.hours - (wakeMs - r.endMs) / 3_600_000),
      0,
    );
    for (const r of dayRuns) {
      recoveries.push({
        endMs: r.plan.startMs + r.summary.elapsedDuration * 1000,
        hours: 6 + r.summary.trainingLoad / 6.5,
      });
    }
    const acwr = acute[i]! / Math.max(chronic[i]!, 1);
    const sleepHistory = mean(nightsOf.slice(-3).map((n) => n.score));
    const stress3 = mean([stressAvg, ...days.slice(-2).map((d) => d.stressAvg)]);
    const pct = {
      sleepScore: clamp(score + 4, 20, 100),
      sleepHistory: clamp(sleepHistory + 6, 20, 100),
      recoveryTime: clamp(100 - recoveryLeftH * 2.2, 15, 100),
      hrv: clamp(92 + (hrv - base) * 2 - Math.max(0, base - hrvWeekly) * 5, 25, 100),
      acwr: clamp(100 - Math.max(0, acwr - 1.2) * 150 - Math.max(0, 0.8 - acwr) * 60, 20, 100),
      stressHistory: clamp(100 - Math.max(0, stress3 - 24) * 2.2, 25, 100),
    };
    let readinessScore = Math.round(
      clamp(
        70 +
          0.9 * (score - 78) +
          1.1 * (hrv - base) -
          0.85 * recoveryLeftH -
          30 * Math.max(0, acwr - 1.3) -
          ill * 30 +
          rng.normal(0, 4),
        8,
        99,
      ),
    );
    const recoveryTimeMin = Math.round(recoveryLeftH * 60);
    if (isToday) {
      // Ready, held back a little by the last few nights' sleep
      readinessScore = 72;
      pct.sleepScore = 84;
      pct.sleepHistory = 66;
      pct.hrv = 92;
      pct.acwr = 90;
      pct.stressHistory = 88;
    }
    const factor = (v: number, key: string): ReadinessFactor => ({
      percent: Math.round(v),
      feedback:
        key === "sleepScore"
          ? score >= 80
            ? "GOOD"
            : score >= 60
              ? "MODERATE"
              : "POOR"
          : v >= 80
            ? "GOOD"
            : v >= 55
              ? "MODERATE"
              : v >= 35
                ? "POOR"
                : "VERY_POOR",
    });
    const level =
      readinessScore >= 95
        ? "PRIME"
        : readinessScore >= 75
          ? "HIGH"
          : readinessScore >= 50
            ? "MODERATE"
            : readinessScore >= 25
              ? "LOW"
              : "POOR";
    const feedback: Record<string, [string, string]> = {
      PRIME: ["READY_TO_GO", "READY_TO_GO_PRIME"],
      HIGH: ["WELL_RECOVERED", "HIGH_RECOVERED_GOOD_SLEEP"],
      MODERATE: ["READY_FOR_THE_DAY", "MODERATE_RECOVERY_SOME_LOAD"],
      LOW: ["TAKE_IT_EASY", "LOW_HIGH_LOAD_RECOVERY_NEEDED"],
      POOR: ["FOCUS_ON_RECOVERY", "POOR_SLEEP_RECOVERY_NEEDED"],
    };

    // Training status: productive while VO₂ max climbs on an optimal load
    const vo2Ago = vo2Trend(Math.max(0, p - 28 / DAYS));
    const trainingStatus =
      ill > 0 || acwr < 0.75
        ? "RECOVERY"
        : acwr > 1.5
          ? "OVERREACHING"
          : vo2Trend(p) - vo2Ago > 0.12
            ? "PRODUCTIVE"
            : "MAINTAINING";

    const runMaxHr = Math.max(0, ...dayRuns.map((r) => r.summary.maxHR));
    const day: DemoDay = {
      date,
      index: i,
      p,
      isToday,
      weeksAgo,
      rhr,
      rhr7,
      hrv,
      hrvWeekly,
      hrvBaseline,
      hrvStatus,
      night,
      runs: dayRuns,
      steps,
      stepGoal: 10_000,
      walkMeters,
      floors: isToday ? 4 : rng.int(5, 15),
      stressAvg,
      stressMax: isToday ? 64 : stressMax,
      bb: {
        midnight,
        atWake,
        bed,
        end,
        high: Math.max(atWake, midnight),
        low: Math.min(midnight, end),
        charged: Math.max(0, atWake - midnight) + rech,
        drained: Math.max(0, drained),
        rech,
        drainPerHour,
      },
      load: round(dayLoad[i]!, 1),
      acute: Math.round(acute[i]!),
      chronic: Math.round(chronic[i]!),
      vo2,
      vo2Latest: latestVo2,
      weightKg,
      readiness: {
        score: readinessScore,
        level,
        feedbackShort: feedback[level]![0],
        feedbackLong: feedback[level]![1],
        recoveryTimeMin,
        factors: {
          sleepScore: factor(pct.sleepScore, "sleepScore"),
          sleepHistory: factor(pct.sleepHistory, "sleepHistory"),
          recoveryTime: factor(pct.recoveryTime, "recoveryTime"),
          hrv: factor(pct.hrv, "hrv"),
          acwr: factor(pct.acwr, "acwr"),
          stressHistory: factor(pct.stressHistory, "stressHistory"),
        },
      },
      trainingStatus: isToday ? "PRODUCTIVE" : trainingStatus,
      moderateMinutes,
      vigorousMinutes,
      walkingModerate: moderateMinutes - dayRuns.reduce((s, r) => s + r.summary.moderateMinutes, 0),
      minHr: rhr - rng.int(3, 6),
      maxHr: runMaxHr || rng.int(102, 124),
      respiration: night.avgRespiration,
      spo2: Math.round(clamp(96 + rng.normal(0, 1), 92, 99)),
      tempC: dayRuns[0]?.plan.tempC ?? 12,
    };
    days.push(day);
  }

  const byDate = new Map(days.map((d) => [d.date, d]));
  const runById = new Map(runs.map((r) => [r.plan.id, r]));
  // Goal race: a half marathon on the Sunday six weeks after this one
  const raceDate = addDays(todayMonday, 6 + 42);
  return {
    today,
    days,
    byDate,
    runs,
    runById,
    workouts,
    schedule,
    race: { id: 1_720_004_412, date: raceDate, title: "Half Marathon" },
    weighIns,
  };
}

/** Today in the server's time zone. */
export function localToday(now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

let cached: World | null = null;

/** The world for today (rebuilt when the date changes). */
export function getWorld(today = localToday()): World {
  if (!cached || cached.today !== today) cached = buildWorld(today);
  return cached;
}
