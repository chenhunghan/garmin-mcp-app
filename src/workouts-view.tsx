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
import {
  formatDistance,
  formatDuration,
  sportLabel,
  Steps,
  type WorkoutStep,
} from "@/components/workout-steps.tsx";

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
