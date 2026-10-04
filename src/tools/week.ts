import type { McpServer } from "@modelcontextprotocol/server";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import type { GarminClient } from "garmin-connect";
import { getClient } from "../garmin.js";
import { withAuth } from "./data.js";

// ── Dates (local calendar days, YYYY-MM-DD) ──

export function formatLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

function addDays(s: string, n: number): string {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return formatLocalDate(d);
}

/** Monday of the week containing `date` (default: today). */
export function mondayOf(date?: string, today = new Date()): string {
  const d = date
    ? parseYmd(date)
    : new Date(today.getFullYear(), today.getMonth(), today.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return formatLocalDate(d);
}

/** The months (year, 1-12) a week touches: one, or two across a month boundary. */
export function monthsOfWeek(start: string): { year: number; month: number }[] {
  const months = [start, addDays(start, 6)].map((s) => ({
    year: Number(s.slice(0, 4)),
    month: Number(s.slice(5, 7)),
  }));
  return months[0]!.month === months[1]!.month ? [months[0]!] : months;
}

// ── Calendar items → week ──

/** Fields of a calendar-service item this view uses. */
export interface CalendarItem {
  id: number;
  itemType: string;
  date: string;
  title?: string | null;
  workoutId?: number | null;
  activityTypeId?: number | null;
  sportTypeKey?: string | null;
  /** activities: milliseconds */
  duration?: number | null;
  /** activities: centimeters */
  distance?: number | null;
  startTimestampLocal?: string | null;
}

/** The parts of a workout step the UI renders (Garmin's DTOs carry much more). */
export interface WeekStep {
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
  workoutSteps?: WeekStep[];
}

export interface WorkoutDetails {
  workoutName?: string;
  sportType?: { sportTypeKey?: string };
  estimatedDurationInSecs?: number | null;
  estimatedDistanceInMeters?: number | null;
  workoutSegments?: { workoutSteps?: WeekStep[] }[];
}

export interface PlannedWorkout {
  scheduleId: number;
  workoutId: number | null;
  name: string;
  sport: string | null;
  estimatedDurationSecs: number | null;
  estimatedDistanceMeters: number | null;
  steps: WeekStep[];
  /** A completed activity that day came from this workout (or was paired with it) */
  completed: boolean;
}

export interface CompletedActivity {
  activityId: number;
  name: string;
  activityTypeId: number | null;
  durationSecs: number | null;
  distanceMeters: number | null;
  startTimeLocal: string | null;
  workoutId: number | null;
}

export interface WeekDay {
  date: string;
  weekday: string;
  planned: PlannedWorkout[];
  activities: CompletedActivity[];
  /** Other calendar entries (events, notes…) */
  other: { itemType: string; title: string }[];
}

export interface TrainingWeek {
  startDate: string;
  endDate: string;
  days: WeekDay[];
  summary: {
    plannedCount: number;
    plannedCompletedCount: number;
    activityCount: number;
    plannedDurationSecs: number;
    plannedDistanceMeters: number;
    /** Planned workouts with no duration/distance estimate (e.g. lap-button steps) */
    plannedWithoutEstimate: number;
    completedDurationSecs: number;
    completedDistanceMeters: number;
  };
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function slimSteps(steps: WeekStep[] | undefined): WeekStep[] {
  return (steps ?? []).map((s) => ({
    type: s.type,
    stepOrder: s.stepOrder,
    stepType: { stepTypeKey: s.stepType?.stepTypeKey },
    endCondition: { conditionTypeKey: s.endCondition?.conditionTypeKey },
    endConditionValue: s.endConditionValue ?? null,
    targetType: { workoutTargetTypeKey: s.targetType?.workoutTargetTypeKey },
    targetValueOne: s.targetValueOne ?? null,
    targetValueTwo: s.targetValueTwo ?? null,
    zoneNumber: s.zoneNumber ?? null,
    ...(s.type === "RepeatGroupDTO" && {
      numberOfIterations: s.numberOfIterations ?? null,
      workoutSteps: slimSteps(s.workoutSteps),
    }),
  }));
}

const positive = (n: number | null | undefined): number | null =>
  typeof n === "number" && n > 0 ? n : null;

/**
 * Group calendar items into the 7 days from `start`, with each scheduled
 * workout's details (by workoutId) and a weekly summary. Pure: the caller
 * fetches the calendar month(s) and workouts.
 */
export function buildTrainingWeek(
  start: string,
  items: CalendarItem[],
  workouts: Record<number, WorkoutDetails | null> = {},
): TrainingWeek {
  const end = addDays(start, 6);
  const seen = new Set<string>();
  const days: WeekDay[] = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(start, i);
    return {
      date,
      weekday: WEEKDAYS[parseYmd(date).getDay()]!,
      planned: [],
      activities: [],
      other: [],
    };
  });

  for (const item of items) {
    const key = `${item.itemType}:${item.id}`;
    if (seen.has(key) || !item.date || item.date < start || item.date > end) continue;
    seen.add(key);
    const day = days.find((d) => d.date === item.date)!;
    if (item.itemType === "workout") {
      const w = item.workoutId != null ? workouts[item.workoutId] : null;
      day.planned.push({
        scheduleId: item.id,
        workoutId: item.workoutId ?? null,
        name: w?.workoutName ?? item.title ?? "Workout",
        sport: w?.sportType?.sportTypeKey ?? item.sportTypeKey ?? null,
        estimatedDurationSecs: positive(w?.estimatedDurationInSecs),
        estimatedDistanceMeters: positive(w?.estimatedDistanceInMeters),
        steps: slimSteps(w?.workoutSegments?.flatMap((s) => s.workoutSteps ?? [])),
        completed: false,
      });
    } else if (item.itemType === "activity") {
      day.activities.push({
        activityId: item.id,
        name: item.title ?? "Activity",
        activityTypeId: item.activityTypeId ?? null,
        durationSecs: positive(item.duration) === null ? null : item.duration! / 1000,
        distanceMeters: positive(item.distance) === null ? null : item.distance! / 100,
        startTimeLocal: item.startTimestampLocal ?? null,
        workoutId: item.workoutId ?? null,
      });
    } else {
      day.other.push({ itemType: item.itemType, title: item.title ?? item.itemType });
    }
  }

  for (const day of days) {
    day.activities.sort((a, b) => (a.startTimeLocal ?? "").localeCompare(b.startTimeLocal ?? ""));
    // Pair activities with that day's planned workouts: same workout first,
    // then any remaining activity in order
    const unused = [...day.activities];
    for (const p of day.planned) {
      const i = unused.findIndex((a) => a.workoutId != null && a.workoutId === p.workoutId);
      if (i >= 0) {
        p.completed = true;
        unused.splice(i, 1);
      }
    }
    for (const p of day.planned) {
      if (!p.completed && unused.length) {
        p.completed = true;
        unused.shift();
      }
    }
  }

  const planned = days.flatMap((d) => d.planned);
  const activities = days.flatMap((d) => d.activities);
  const sum = (xs: (number | null)[]) => xs.reduce<number>((a, x) => a + (x ?? 0), 0);
  return {
    startDate: start,
    endDate: end,
    days,
    summary: {
      plannedCount: planned.length,
      plannedCompletedCount: planned.filter((p) => p.completed).length,
      activityCount: activities.length,
      plannedDurationSecs: Math.round(sum(planned.map((p) => p.estimatedDurationSecs))),
      plannedDistanceMeters: Math.round(sum(planned.map((p) => p.estimatedDistanceMeters))),
      plannedWithoutEstimate: planned.filter(
        (p) => p.estimatedDurationSecs === null && p.estimatedDistanceMeters === null,
      ).length,
      completedDurationSecs: Math.round(sum(activities.map((a) => a.durationSecs))),
      completedDistanceMeters: Math.round(sum(activities.map((a) => a.distanceMeters))),
    },
  };
}

/** Fetch the calendar month(s) of the week and each scheduled workout's steps. */
export async function fetchTrainingWeek(
  client: GarminClient,
  start: string,
): Promise<TrainingWeek> {
  const items: CalendarItem[] = [];
  // One request at a time: a week needs at most two months plus a few workouts
  for (const { year, month } of monthsOfWeek(start)) {
    const cal = (await client.getCalendar(year, month)) as {
      calendarItems?: CalendarItem[];
    } | null;
    items.push(...(cal?.calendarItems ?? []));
  }
  const week = buildTrainingWeek(start, items);
  const ids = [
    ...new Set(
      week.days.flatMap((d) => d.planned.map((p) => p.workoutId)).filter((id) => id != null),
    ),
  ] as number[];
  if (ids.length === 0) return week;
  const workouts: Record<number, WorkoutDetails | null> = {};
  for (const id of ids) {
    try {
      workouts[id] = (await client.getWorkout(id)) as WorkoutDetails;
    } catch {
      // A deleted workout can stay on the calendar; show what the calendar has
      workouts[id] = null;
    }
  }
  return buildTrainingWeek(start, items, workouts);
}

export function registerWeekTools(server: McpServer, resourceUri: string) {
  registerAppTool(
    server,
    "show-training-week",
    {
      title: "Show Training Week",
      description:
        "Show a Monday-Sunday training week: workouts scheduled on the Garmin calendar (with their steps and estimated duration/distance), activities completed, and a weekly summary (planned vs done, planned and completed volume). Call it after creating/scheduling a week of workouts to show the user the plan, or to review how a week went.",
      inputSchema: z.object({
        startDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe(
            "Any day of the week to show (YYYY-MM-DD); the week starts on its Monday. Default: this week.",
          ),
      }),
      _meta: { ui: { resourceUri } },
    },
    async ({ startDate }) => {
      const start = mondayOf(startDate);
      return withAuth(() => fetchTrainingWeek(getClient(), start), "week", { startDate: start });
    },
  );
}
