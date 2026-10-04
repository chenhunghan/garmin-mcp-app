/**
 * Formatting and rendering of Garmin workout steps, shared by the workouts
 * view and the training week.
 */

export interface WorkoutStep {
  type?: string;
  stepOrder?: number;
  stepType?: { stepTypeKey?: string };
  endCondition?: { conditionTypeKey?: string };
  endConditionValue?: number | null;
  targetType?: { workoutTargetTypeKey?: string };
  targetValueOne?: number | null;
  targetValueTwo?: number | null;
  zoneNumber?: number | null;
  numberOfIterations?: number | null;
  workoutSteps?: WorkoutStep[];
}

const STEP_LABELS: Record<string, string> = {
  warmup: "Warm up",
  cooldown: "Cool down",
  interval: "Run",
  recovery: "Recover",
  rest: "Rest",
  repeat: "Repeat",
  other: "Other",
};

/** Colour per step type, from the shared chart palette (adapts to dark mode). */
const STEP_COLORS: Record<string, string> = {
  warmup: "var(--chart-2)",
  cooldown: "var(--chart-2)",
  interval: "var(--chart-5)",
  recovery: "var(--chart-3)",
  rest: "var(--chart-3)",
};

export function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.round(secs % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function sportLabel(key: string | undefined | null): string | undefined {
  if (!key) return undefined;
  const words = key.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
}

/** Garmin pace targets are speeds in m/s. */
function formatPace(speed: number): string {
  if (!speed) return "–";
  return `${formatDuration(1000 / speed)}/km`;
}

function stepEnd(step: WorkoutStep): string {
  const key = step.endCondition?.conditionTypeKey;
  const v = step.endConditionValue ?? 0;
  if (key === "time") return formatDuration(v);
  if (key === "distance") return formatDistance(v);
  if (key === "lap.button") return "Until lap button";
  return "";
}

export function stepTarget(step: WorkoutStep): string {
  const key = step.targetType?.workoutTargetTypeKey;
  if (key === "heart.rate.zone") {
    if (step.zoneNumber) return `HR zone ${step.zoneNumber}`;
    if (step.targetValueOne && step.targetValueTwo) {
      return `${Math.round(step.targetValueOne)}–${Math.round(step.targetValueTwo)} bpm`;
    }
  }
  if ((key === "pace.zone" || key === "speed.zone") && step.targetValueOne && step.targetValueTwo) {
    // The faster speed is the faster (smaller) pace
    const [slow, fast] = [step.targetValueOne, step.targetValueTwo].sort((a, b) => a - b);
    return `${formatPace(fast!)} – ${formatPace(slow!)}`;
  }
  return "";
}

/**
 * Intensity of a workout's main set, e.g. "HR zone 2" or "4×: 4:00/km – 4:10/km":
 * the targets of its run steps (warm-up/cool-down/recovery left out).
 */
export function intensityHint(steps: WorkoutStep[]): string {
  const targets: string[] = [];
  const walk = (list: WorkoutStep[], reps: number | null) => {
    for (const s of list) {
      if (s.type === "RepeatGroupDTO") {
        walk(s.workoutSteps ?? [], s.numberOfIterations ?? null);
        continue;
      }
      const key = s.stepType?.stepTypeKey;
      if (key !== "interval" && key !== "other") continue;
      const t = stepTarget(s);
      const label = t && reps && reps > 1 ? `${reps}× ${t}` : t;
      if (label && !targets.includes(label)) targets.push(label);
    }
  };
  walk(steps, null);
  return targets.slice(0, 2).join(" · ");
}

export function Steps({ steps }: { steps: WorkoutStep[] }) {
  return (
    <ol className="flex flex-col gap-1.5">
      {steps.map((step, i) => {
        const typeKey = step.stepType?.stepTypeKey ?? "other";
        if (step.type === "RepeatGroupDTO") {
          return (
            <li key={i} className="rounded-md border border-border/50 p-2">
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">
                Repeat {step.numberOfIterations ?? 1}×
              </div>
              <Steps steps={step.workoutSteps ?? []} />
            </li>
          );
        }
        const target = stepTarget(step);
        return (
          <li
            key={i}
            className="flex items-center gap-3 rounded-md bg-muted/40 px-3 py-1.5 text-sm"
          >
            <span
              className="h-6 w-1 shrink-0 rounded-full"
              style={{ backgroundColor: STEP_COLORS[typeKey] ?? "var(--muted-foreground)" }}
            />
            <span className="w-20 shrink-0 font-medium">{STEP_LABELS[typeKey] ?? typeKey}</span>
            <span className="tabular-nums">{stepEnd(step)}</span>
            {target && <span className="ml-auto text-muted-foreground">{target}</span>}
          </li>
        );
      })}
    </ol>
  );
}
