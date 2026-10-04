import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Button } from "@/components/ui/button.tsx";
import { AskAssistant } from "@/components/ask-assistant.tsx";
import { StatTile, StatusBadge } from "@/components/stat-tile.tsx";
import {
  formatDuration,
  intensityHint,
  sportLabel,
  Steps,
  type WorkoutStep,
} from "@/components/workout-steps.tsx";
import { useAppActions } from "@/lib/app-actions.tsx";
import { formatDate, parseDate } from "@/lib/dates.ts";
import type { ToolArgs } from "@/lib/tool-args.ts";

type CallTool = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<Record<string, unknown> | null>;

/** Shape returned by the show-training-week tool (src/tools/week.ts). */
interface PlannedWorkout {
  scheduleId: number;
  workoutId: number | null;
  name: string;
  sport: string | null;
  estimatedDurationSecs: number | null;
  estimatedDistanceMeters: number | null;
  steps: WorkoutStep[];
  completed: boolean;
}

interface CompletedActivity {
  activityId: number;
  name: string;
  durationSecs: number | null;
  distanceMeters: number | null;
}

interface WeekDay {
  date: string;
  weekday: string;
  planned: PlannedWorkout[];
  activities: CompletedActivity[];
  other: { itemType: string; title: string }[];
}

interface TrainingWeek {
  startDate: string;
  endDate: string;
  days: WeekDay[];
  summary: {
    plannedCount: number;
    plannedCompletedCount: number;
    activityCount: number;
    plannedDurationSecs: number;
    plannedDistanceMeters: number;
    plannedWithoutEstimate: number;
    completedDurationSecs: number;
    completedDistanceMeters: number;
  };
}

function mondayOf(d: Date): string {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return formatDate(m);
}

function shiftWeek(start: string, weeks: number): string {
  const d = parseDate(start);
  d.setDate(d.getDate() + weeks * 7);
  return formatDate(d);
}

/** "Oct 5–11" or "Sep 28–Oct 4" */
function weekLabel(start: string, end: string): string {
  const s = parseDate(start);
  const e = parseDate(end);
  const month = (d: Date) => d.toLocaleDateString(undefined, { month: "short" });
  return s.getMonth() === e.getMonth()
    ? `${month(s)} ${s.getDate()}–${e.getDate()}`
    : `${month(s)} ${s.getDate()}–${month(e)} ${e.getDate()}`;
}

/** "Mon, Sep 28 – Sun, Oct 4" */
function weekRange(start: string): string {
  const fmt = (s: string) =>
    parseDate(s).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  const end = parseDate(start);
  end.setDate(end.getDate() + 6);
  return `${fmt(start)} – ${fmt(formatDate(end))}`;
}

/** "45 min", "3 h 20 min" */
function formatHours(secs: number): string {
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function km(meters: number): string {
  return `${(meters / 1000).toFixed(1)} km`;
}

function volume(secs: number, meters: number): string {
  return [secs > 0 && formatHours(secs), meters > 0 && km(meters)].filter(Boolean).join(" · ");
}

/**
 * Planned volume, e.g. "3 h 55 min · 32.0 km". A total is only shown when
 * every planned workout has that estimate (a partial km sum would understate
 * the week); a duration total missing some workouts says "at least".
 */
function plannedVolume(week: TrainingWeek): string {
  const planned = week.days.flatMap((d) => d.planned);
  if (planned.length === 0) return "";
  const s = week.summary;
  const allDur = planned.every((p) => p.estimatedDurationSecs);
  const allDist = planned.every((p) => p.estimatedDistanceMeters);
  return [
    s.plannedDurationSecs > 0 &&
      (allDur
        ? formatHours(s.plannedDurationSecs)
        : `at least ${formatHours(s.plannedDurationSecs)}`),
    allDist && s.plannedDistanceMeters > 0 && km(s.plannedDistanceMeters),
  ]
    .filter(Boolean)
    .join(" · ");
}

function dayLabel(date: string): { weekday: string; day: string } {
  const d = parseDate(date);
  return {
    weekday: d.toLocaleDateString(undefined, { weekday: "short" }),
    day: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
  };
}

function plannedMeta(p: PlannedWorkout): string {
  return [
    sportLabel(p.sport),
    p.estimatedDurationSecs && formatDuration(p.estimatedDurationSecs),
    p.estimatedDistanceMeters && km(p.estimatedDistanceMeters),
    intensityHint(p.steps),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Plain-text summary of the week for Claude (shareContext). */
function weekContext(week: TrainingWeek, today: string): string {
  const s = week.summary;
  const lines = [
    `Training week ${week.startDate} to ${week.endDate} (Garmin calendar). Today is ${today}.`,
    `Planned: ${s.plannedCount} workouts${
      plannedVolume(week) ? ` (${plannedVolume(week)})` : ""
    }, ${s.plannedCompletedCount} completed. Done: ${s.activityCount} activities${
      volume(s.completedDurationSecs, s.completedDistanceMeters)
        ? ` (${volume(s.completedDurationSecs, s.completedDistanceMeters)})`
        : ""
    }.`,
  ];
  for (const d of week.days) {
    const parts = [
      ...d.planned.map(
        (p) =>
          `planned "${p.name}"${plannedMeta(p) ? ` (${plannedMeta(p)})` : ""}${p.completed ? ", completed" : ""}`,
      ),
      ...d.activities.map(
        (a) =>
          `done "${a.name}"${
            volume(a.durationSecs ?? 0, a.distanceMeters ?? 0)
              ? ` (${volume(a.durationSecs ?? 0, a.distanceMeters ?? 0)})`
              : ""
          }`,
      ),
      ...d.other.map((o) => `${o.itemType} "${o.title}"`),
    ];
    lines.push(`${d.weekday} ${d.date}: ${parts.length ? parts.join("; ") : "rest"}`);
  }
  return lines.join("\n");
}

/** Self-contained follow-up questions about this week (they land in the chat). */
function weekQuestions(week: TrainingWeek, today: string): string[] {
  const s = week.summary;
  const range = weekLabel(week.startDate, week.endDate);
  const questions: string[] = [];
  // Days left to plan (not just today)
  const hasFuture = week.endDate > today;
  if (s.plannedCount > 0) {
    const vol = plannedVolume(week);
    questions.push(
      `Is my training week of ${range} (${s.plannedCount} workouts${vol ? `, ${vol}` : ""} planned) balanced for my current readiness?`,
    );
    const nextPlanned = week.days.find((d) => d.date >= today && d.planned.length > 0);
    if (nextPlanned) {
      questions.push(
        `Adjust my plan for ${range} — I can't train on ${nextPlanned.weekday} ${dayLabel(nextPlanned.date).day}`,
      );
    }
  } else if (hasFuture) {
    questions.push(`Plan my training week of ${range} based on my recent training and readiness`);
  }
  if (s.activityCount > 0 && week.startDate <= today) {
    const done = s.completedDistanceMeters ? `, ${km(s.completedDistanceMeters)}` : "";
    questions.push(
      `How did my training week of ${range} go (${s.activityCount} activities${done} done)?`,
    );
  }
  return questions.slice(0, 3);
}

export function TrainingWeekView({
  callTool,
  args,
}: {
  callTool: CallTool;
  /** startDate: the Monday of the week Claude asked for */
  args?: ToolArgs;
}) {
  const { shareContext, canShareContext } = useAppActions();
  const today = formatDate(new Date());
  const [start, setStart] = useState(() =>
    args?.startDate ? mondayOf(parseDate(args.startDate)) : mondayOf(new Date()),
  );
  const [week, setWeek] = useState<TrainingWeek | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const fetchWeek = useCallback(
    async (startDate: string) => {
      setLoading(true);
      setError(null);
      try {
        const result = await callTool("show-training-week", { startDate });
        setWeek(result as unknown as TrainingWeek);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load the training week");
      } finally {
        setLoading(false);
      }
    },
    [callTool],
  );

  useEffect(() => {
    fetchWeek(start);
  }, [fetchWeek, start]);

  // Tell Claude which week the user is looking at
  useEffect(() => {
    if (!week || !canShareContext) return;
    shareContext(weekContext(week, today), {
      view: "week",
      startDate: week.startDate,
      endDate: week.endDate,
      summary: week.summary,
    }).catch(() => {});
  }, [week, canShareContext, shareContext, today]);

  const questions = useMemo(() => (week ? weekQuestions(week, today) : []), [week, today]);
  const thisWeek = mondayOf(new Date());
  const s = week?.summary;

  return (
    <Card className="border-border/50 shadow-none">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>Training week</CardTitle>
            <CardDescription>
              {weekRange(start)}
              {start === thisWeek && " · this week"}
            </CardDescription>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              aria-label="Previous week"
              onClick={() => setStart(shiftWeek(start, -1))}
            >
              ‹ Prev
            </Button>
            {start !== thisWeek && (
              <Button variant="outline" size="sm" onClick={() => setStart(thisWeek)}>
                This week
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              aria-label="Next week"
              onClick={() => setStart(shiftWeek(start, 1))}
            >
              Next ›
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <div className="text-sm text-destructive">{error}</div>}
        {!week && loading && (
          <div className="text-sm text-muted-foreground">Loading training week…</div>
        )}
        {week && s && (
          // Keep the previous week on screen (dimmed) while the next one loads
          <div
            className={`flex flex-col gap-4 transition-opacity ${loading ? "opacity-50" : ""}`}
            aria-busy={loading}
          >
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <StatTile
                label="Planned"
                value={s.plannedCount}
                unit={s.plannedCount === 1 ? "workout" : "workouts"}
                footnote={
                  [
                    plannedVolume(week),
                    s.plannedWithoutEstimate > 0 && `${s.plannedWithoutEstimate} without estimate`,
                  ]
                    .filter(Boolean)
                    .join(" · ") || undefined
                }
              />
              <StatTile
                label="Done"
                value={s.activityCount}
                unit={s.activityCount === 1 ? "activity" : "activities"}
                footnote={volume(s.completedDurationSecs, s.completedDistanceMeters) || undefined}
              />
              {s.plannedCount > 0 && (
                <StatTile
                  label="Plan completed"
                  value={`${s.plannedCompletedCount} of ${s.plannedCount}`}
                  footnote="planned workouts with an activity that day"
                />
              )}
            </div>

            <ol className="flex flex-col divide-y divide-border/50 rounded-lg border border-border/50">
              {week.days.map((day) => {
                const isToday = day.date === today;
                const isPast = day.date < today;
                const label = dayLabel(day.date);
                const empty =
                  day.planned.length === 0 && day.activities.length === 0 && day.other.length === 0;
                return (
                  <li
                    key={day.date}
                    // Narrow: the day label sits above its workouts (full width for
                    // the steps); rest days stay on one line
                    className={`flex gap-x-3 gap-y-1.5 px-3 py-2.5 ${
                      empty ? "" : "flex-col sm:flex-row"
                    } ${isToday ? "bg-muted/40" : ""}`}
                    aria-current={isToday ? "date" : undefined}
                  >
                    <div className="flex shrink-0 items-baseline gap-1.5 sm:block sm:w-14">
                      <div className={`text-sm ${isToday ? "font-semibold" : "font-medium"}`}>
                        {label.weekday}
                      </div>
                      <div className="text-xs text-muted-foreground">{label.day}</div>
                      {isToday && (
                        <div className="text-[10px] font-medium uppercase tracking-wide text-primary sm:mt-0.5">
                          Today
                        </div>
                      )}
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      {empty && <div className="py-0.5 text-sm text-muted-foreground">Rest</div>}
                      {day.planned.map((p) => {
                        const isOpen = expanded === p.scheduleId;
                        const meta = plannedMeta(p);
                        return (
                          <div key={p.scheduleId} className="rounded-md border border-border/50">
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
                              onClick={() => setExpanded(isOpen ? null : p.scheduleId)}
                              aria-expanded={isOpen}
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                  Planned
                                </span>
                                <span className="block truncate text-sm font-medium">{p.name}</span>
                                {meta && (
                                  <span className="block text-xs text-muted-foreground">
                                    {meta}
                                  </span>
                                )}
                              </span>
                              <span className="flex shrink-0 flex-col items-end gap-0.5">
                                {p.completed ? (
                                  <StatusBadge level="good" label="Done" />
                                ) : (
                                  isPast && (
                                    <span className="text-xs text-muted-foreground">Not done</span>
                                  )
                                )}
                                <span className="text-xs text-muted-foreground">
                                  {isOpen ? "Hide" : "Steps"}
                                </span>
                              </span>
                            </button>
                            {isOpen && (
                              <div className="px-2.5 pb-2.5">
                                {p.steps.length ? (
                                  <Steps steps={p.steps} />
                                ) : (
                                  <div className="text-sm text-muted-foreground">No steps.</div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {day.activities.map((a) => (
                        <div
                          key={a.activityId}
                          className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md bg-muted/40 px-2.5 py-1.5"
                        >
                          <StatusBadge level="good" label="Done" />
                          <span className="min-w-[8rem] flex-1 truncate text-sm">{a.name}</span>
                          <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                            {volume(a.durationSecs ?? 0, a.distanceMeters ?? 0)}
                          </span>
                        </div>
                      ))}
                      {day.other.map((o, i) => (
                        <div key={i} className="text-xs text-muted-foreground">
                          {sportLabel(o.itemType)}: {o.title}
                        </div>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ol>

            <AskAssistant questions={questions} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
