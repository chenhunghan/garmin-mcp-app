import { useCallback, useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { parseDate } from "@/lib/dates.ts";
import type { ToolArgs } from "@/lib/tool-args.ts";

type CallTool = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<Record<string, unknown> | null>;

interface WorkoutSummary {
  workoutId: number;
  workoutName: string;
  sportType?: { sportTypeKey?: string };
  estimatedDurationInSecs?: number | null;
  estimatedDistanceInMeters?: number | null;
  updateDate?: string;
}

interface WorkoutStep {
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

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.round(secs % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function sportLabel(key: string | undefined): string | undefined {
  if (!key) return undefined;
  const words = key.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function formatDistance(meters: number): string {
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

function stepTarget(step: WorkoutStep): string {
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

function Steps({ steps }: { steps: WorkoutStep[] }) {
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

function actionMessage(args: ToolArgs | undefined, name: string | undefined): string | null {
  const what = name ? `“${name}”` : "Workout";
  switch (args?.action) {
    case "created":
      return `${what} created`;
    case "updated":
      return `${what} updated`;
    case "deleted":
      return "Workout deleted";
    case "scheduled":
      return args.date
        ? `${what} scheduled for ${parseDate(args.date).toLocaleDateString(undefined, {
            weekday: "long",
            month: "short",
            day: "numeric",
          })}`
        : `${what} scheduled`;
    default:
      return null;
  }
}

export function WorkoutsView({
  callTool,
  args,
}: {
  callTool: CallTool;
  /** The workout the tool call was about (highlighted and expanded) and what happened to it */
  args?: ToolArgs;
}) {
  const [workouts, setWorkouts] = useState<WorkoutSummary[]>([]);
  const [expanded, setExpanded] = useState<number | null>(
    args?.workoutId !== undefined ? Number(args.workoutId) : null,
  );
  const [steps, setSteps] = useState<Record<number, WorkoutStep[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchWorkouts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await callTool("list-workouts", { start: 0, limit: 20 });
      setWorkouts(Array.isArray(result) ? (result as unknown as WorkoutSummary[]) : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workouts");
    } finally {
      setLoading(false);
    }
  }, [callTool]);

  const fetchSteps = useCallback(
    async (workoutId: number) => {
      if (steps[workoutId]) return;
      try {
        const result = await callTool("get-workout", { workoutId });
        const segments = (result?.workoutSegments as { workoutSteps?: WorkoutStep[] }[]) ?? [];
        setSteps((prev) => ({
          ...prev,
          [workoutId]: segments.flatMap((s) => s.workoutSteps ?? []),
        }));
      } catch {
        setSteps((prev) => ({ ...prev, [workoutId]: [] }));
      }
    },
    [callTool, steps],
  );

  useEffect(() => {
    fetchWorkouts();
  }, [fetchWorkouts]);

  useEffect(() => {
    if (expanded !== null) fetchSteps(expanded);
  }, [expanded, fetchSteps]);

  const highlighted = args?.workoutId !== undefined ? Number(args.workoutId) : null;
  const message = actionMessage(
    args,
    workouts.find((w) => w.workoutId === highlighted)?.workoutName,
  );

  return (
    <Card className="border-border/50 shadow-none">
      <CardHeader>
        <CardTitle>Workouts</CardTitle>
        <CardDescription>Saved workouts in Garmin Connect</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {message && (
          <div className="flex items-center gap-2 rounded-md border border-border/50 px-3 py-2 text-sm">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: "var(--success)" }} />
            {message}
          </div>
        )}
        {error && <div className="text-sm text-destructive">{error}</div>}
        {loading && workouts.length === 0 && (
          <div className="text-sm text-muted-foreground">Loading workouts…</div>
        )}
        {!loading && !error && workouts.length === 0 && (
          <div className="text-sm text-muted-foreground">No saved workouts yet.</div>
        )}
        <ul className="flex flex-col gap-2">
          {workouts.map((w) => {
            const isOpen = expanded === w.workoutId;
            const isHighlighted = highlighted === w.workoutId;
            return (
              <li
                key={w.workoutId}
                className={`rounded-lg border ${isHighlighted ? "border-primary" : "border-border/50"}`}
              >
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-3 py-2 text-left"
                  onClick={() => setExpanded(isOpen ? null : w.workoutId)}
                  aria-expanded={isOpen}
                >
                  <span className="flex-1">
                    <span className="block text-sm font-medium">{w.workoutName}</span>
                    <span className="block text-xs text-muted-foreground">
                      {[
                        sportLabel(w.sportType?.sportTypeKey),
                        w.estimatedDurationInSecs && formatDuration(w.estimatedDurationInSecs),
                        w.estimatedDistanceInMeters && formatDistance(w.estimatedDistanceInMeters),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">{isOpen ? "Hide" : "Steps"}</span>
                </button>
                {isOpen && (
                  <div className="px-3 pb-3">
                    {steps[w.workoutId] ? (
                      steps[w.workoutId]!.length ? (
                        <Steps steps={steps[w.workoutId]!} />
                      ) : (
                        <div className="text-sm text-muted-foreground">No steps.</div>
                      )
                    ) : (
                      <div className="text-sm text-muted-foreground">Loading steps…</div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
