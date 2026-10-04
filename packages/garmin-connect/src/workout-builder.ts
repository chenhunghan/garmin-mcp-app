/**
 * Builds Garmin workout JSON (POST /workout-service/workout) from a simple,
 * LLM-friendly spec. Garmin's format is verbose and easy to get subtly wrong
 * (step IDs, depth-first step numbering, pace targets as m/s with the slower
 * pace first), so callers describe the workout and this produces the DTOs.
 *
 * IDs follow python-garminconnect's workout module (pinned by its tests).
 */

export type WorkoutSport =
  | "running"
  | "cycling"
  | "other"
  | "swimming"
  | "strength_training"
  | "cardio_training"
  | "yoga"
  | "pilates"
  | "hiit";

export type StepKind = "warmup" | "run" | "recovery" | "rest" | "cooldown" | "other";

/** How a step ends: after a time, after a distance, or when the lap button is pressed. */
export type StepDuration = { seconds: number } | { meters: number } | "lap.button";

/** HR zone (1-5) or a pace range per km, e.g. { fast: "4:30", slow: "4:50" }. */
export type StepTarget = { hrZone: number } | { pace: { fast: string; slow: string } };

export interface SimpleStep {
  type: StepKind;
  /** Defaults to "lap.button" */
  duration?: StepDuration;
  target?: StepTarget;
  description?: string;
}

export interface RepeatStep {
  repeat: number;
  steps: WorkoutSpecStep[];
}

export type WorkoutSpecStep = SimpleStep | RepeatStep;

export interface WorkoutSpec {
  name: string;
  sport: WorkoutSport;
  description?: string;
  steps: WorkoutSpecStep[];
}

const SPORTS: Record<WorkoutSport, number> = {
  running: 1,
  cycling: 2,
  other: 3,
  swimming: 4,
  strength_training: 5,
  cardio_training: 6,
  yoga: 7,
  pilates: 8,
  hiit: 9,
};

const STEP_TYPES: Record<StepKind, { id: number; key: string }> = {
  warmup: { id: 1, key: "warmup" },
  cooldown: { id: 2, key: "cooldown" },
  run: { id: 3, key: "interval" },
  recovery: { id: 4, key: "recovery" },
  rest: { id: 5, key: "rest" },
  other: { id: 7, key: "other" },
};

const CONDITIONS = {
  "lap.button": 1,
  time: 2,
  distance: 3,
  iterations: 7,
} as const;

const TARGETS = {
  "no.target": 1,
  "heart.rate.zone": 4,
  "pace.zone": 6,
} as const;

function sportType(sport: WorkoutSport) {
  const id = SPORTS[sport];
  if (!id) throw new Error(`Unknown sport "${sport}"`);
  return { sportTypeId: id, sportTypeKey: sport, displayOrder: id };
}

function condition(key: keyof typeof CONDITIONS) {
  const id = CONDITIONS[key];
  return {
    conditionTypeId: id,
    conditionTypeKey: key,
    displayOrder: id,
    displayable: key !== "iterations",
  };
}

function targetType(key: keyof typeof TARGETS) {
  const id = TARGETS[key];
  return { workoutTargetTypeId: id, workoutTargetTypeKey: key, displayOrder: id };
}

/** "4:30" (min:sec per km) → seconds per km. */
export function parsePace(pace: string): number {
  const m = /^\s*(\d{1,2}):([0-5]\d)\s*$/.exec(pace);
  if (!m) throw new Error(`Invalid pace "${pace}" — use min:sec per km, e.g. "4:30"`);
  const secs = Number(m[1]) * 60 + Number(m[2]);
  if (secs <= 0) throw new Error(`Invalid pace "${pace}"`);
  return secs;
}

/** Pace (min:sec per km) → speed in m/s, as Garmin stores pace targets. */
export function paceToSpeed(pace: string): number {
  return 1000 / parsePace(pace);
}

export interface GarminExecutableStep {
  type: "ExecutableStepDTO";
  stepOrder: number;
  stepType: { stepTypeId: number; stepTypeKey: string; displayOrder: number };
  childStepId: number | null;
  description: string | null;
  endCondition: ReturnType<typeof condition>;
  endConditionValue: number | null;
  targetType: ReturnType<typeof targetType>;
  targetValueOne: number | null;
  targetValueTwo: number | null;
  zoneNumber: number | null;
}

export interface GarminRepeatGroup {
  type: "RepeatGroupDTO";
  stepOrder: number;
  stepType: { stepTypeId: 6; stepTypeKey: "repeat"; displayOrder: 6 };
  childStepId: number;
  numberOfIterations: number;
  smartRepeat: false;
  endCondition: ReturnType<typeof condition>;
  endConditionValue: number;
  workoutSteps: GarminStep[];
}

export type GarminStep = GarminExecutableStep | GarminRepeatGroup;

export interface GarminWorkout {
  workoutName: string;
  description?: string;
  sportType: ReturnType<typeof sportType>;
  estimatedDurationInSecs?: number;
  estimatedDistanceInMeters?: number;
  author: Record<string, never>;
  workoutSegments: {
    segmentOrder: number;
    sportType: ReturnType<typeof sportType>;
    workoutSteps: GarminStep[];
  }[];
}

function isRepeat(step: WorkoutSpecStep): step is RepeatStep {
  return "repeat" in step;
}

function executable(
  step: SimpleStep,
  stepOrder: number,
  childStepId: number | null,
): GarminExecutableStep {
  const kind = STEP_TYPES[step.type];
  if (!kind) throw new Error(`Unknown step type "${step.type}"`);
  const d = step.duration ?? "lap.button";

  let endCondition = condition("lap.button");
  let endConditionValue: number | null = null;
  if (d !== "lap.button") {
    if ("seconds" in d) {
      if (!(d.seconds > 0)) throw new Error("Step duration seconds must be > 0");
      endCondition = condition("time");
      endConditionValue = d.seconds;
    } else if ("meters" in d) {
      if (!(d.meters > 0)) throw new Error("Step duration meters must be > 0");
      endCondition = condition("distance");
      endConditionValue = d.meters;
    }
  }

  let target = targetType("no.target");
  let targetValueOne: number | null = null;
  let targetValueTwo: number | null = null;
  let zoneNumber: number | null = null;
  const t = step.target;
  if (t && "hrZone" in t) {
    if (!Number.isInteger(t.hrZone) || t.hrZone < 1 || t.hrZone > 5) {
      throw new Error(`HR zone must be 1-5, got ${t.hrZone}`);
    }
    // Zone targets carry the zone only, no value range
    target = targetType("heart.rate.zone");
    zoneNumber = t.hrZone;
  } else if (t && "pace" in t) {
    // Speeds in m/s: targetValueOne = the slower pace (lower speed)
    const speeds = [paceToSpeed(t.pace.fast), paceToSpeed(t.pace.slow)].sort((a, b) => a - b);
    target = targetType("pace.zone");
    targetValueOne = speeds[0]!;
    targetValueTwo = speeds[1]!;
  }

  return {
    type: "ExecutableStepDTO",
    stepOrder,
    stepType: { stepTypeId: kind.id, stepTypeKey: kind.key, displayOrder: kind.id },
    childStepId,
    description: step.description ?? null,
    endCondition,
    endConditionValue,
    targetType: target,
    targetValueOne,
    targetValueTwo,
    zoneNumber,
  };
}

/**
 * Number steps depth-first across the whole segment (a repeat group takes a
 * stepOrder before its children). Each repeat group gets the next childStepId
 * (1, 2, …) and its direct children carry it.
 */
function buildSteps(spec: WorkoutSpecStep[]): GarminStep[] {
  let order = 0;
  let groupId = 0;
  const walk = (steps: WorkoutSpecStep[], parentGroup: number | null): GarminStep[] =>
    steps.map((step) => {
      if (isRepeat(step)) {
        if (!Number.isInteger(step.repeat) || step.repeat < 1) {
          throw new Error(`Repeat count must be a positive integer, got ${step.repeat}`);
        }
        if (!step.steps?.length) throw new Error("A repeat needs at least one step");
        const stepOrder = ++order;
        const id = ++groupId;
        return {
          type: "RepeatGroupDTO",
          stepOrder,
          stepType: { stepTypeId: 6, stepTypeKey: "repeat", displayOrder: 6 },
          childStepId: id,
          numberOfIterations: step.repeat,
          smartRepeat: false,
          endCondition: condition("iterations"),
          endConditionValue: step.repeat,
          workoutSteps: walk(step.steps, id),
        } satisfies GarminRepeatGroup;
      }
      return executable(step, ++order, parentGroup);
    });
  return walk(spec, null);
}

/** Middle of a pace target's range, in m/s. */
function targetSpeed(step: SimpleStep): number | null {
  const t = step.target;
  if (!t || !("pace" in t)) return null;
  return (paceToSpeed(t.pace.fast) + paceToSpeed(t.pace.slow)) / 2;
}

/**
 * Estimated duration (s) and distance (m) of the steps, or null for a total
 * that can't be known (a lap-button step, or a distance step without a pace).
 */
export function estimateSteps(steps: WorkoutSpecStep[]): {
  seconds: number | null;
  meters: number | null;
} {
  let seconds: number | null = 0;
  let meters: number | null = 0;
  for (const step of steps) {
    let s: number | null = null;
    let m: number | null = null;
    if (isRepeat(step)) {
      const inner = estimateSteps(step.steps);
      s = inner.seconds === null ? null : inner.seconds * step.repeat;
      m = inner.meters === null ? null : inner.meters * step.repeat;
    } else {
      const d = step.duration ?? "lap.button";
      const speed = targetSpeed(step);
      if (d !== "lap.button" && "seconds" in d) {
        s = d.seconds;
        m = speed ? d.seconds * speed : null;
      } else if (d !== "lap.button" && "meters" in d) {
        m = d.meters;
        s = speed ? d.meters / speed : null;
      }
    }
    seconds = seconds === null || s === null ? null : seconds + s;
    meters = meters === null || m === null ? null : meters + m;
  }
  return { seconds, meters };
}

/** Garmin workout JSON for POST /workout-service/workout. */
export function buildWorkout(spec: WorkoutSpec): GarminWorkout {
  if (!spec.name?.trim()) throw new Error("Workout name is required");
  if (!spec.steps?.length) throw new Error("A workout needs at least one step");
  const sport = sportType(spec.sport);
  const workoutSteps = buildSteps(spec.steps);
  const estimate = estimateSteps(spec.steps);
  return {
    workoutName: spec.name.trim(),
    ...(spec.description && { description: spec.description }),
    sportType: sport,
    ...(estimate.seconds !== null && { estimatedDurationInSecs: Math.round(estimate.seconds) }),
    ...(estimate.meters !== null &&
      estimate.meters > 0 && { estimatedDistanceInMeters: Math.round(estimate.meters) }),
    author: {},
    workoutSegments: [{ segmentOrder: 1, sportType: sport, workoutSteps }],
  };
}
