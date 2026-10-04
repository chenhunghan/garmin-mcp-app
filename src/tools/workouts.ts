import type { McpServer } from "@modelcontextprotocol/server";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import {
  buildWorkout,
  GarminAuthError,
  GarminTokenExpiredError,
  type WorkoutSpec,
} from "garmin-connect";
import { getClient } from "../garmin.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * Run a workout call and open the workouts view. `args` (or `argsFrom` the
 * result, e.g. a newly created workout's ID) tell the view what to highlight.
 */
async function withAuth(
  fn: () => Promise<unknown>,
  args: Record<string, unknown> = {},
  argsFrom?: (data: unknown) => Record<string, unknown>,
): Promise<ToolResult> {
  const client = getClient();
  if (!client.isAuthenticated) {
    try {
      await client.resume();
    } catch {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              code: "not_authenticated",
              message: "Not authenticated with Garmin Connect",
            }),
          },
        ],
      };
    }
  }
  try {
    const data = await fn();
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? null) }],
      structuredContent: { view: "workouts", args: { ...args, ...argsFrom?.(data) } },
    };
  } catch (err) {
    if (err instanceof GarminAuthError || err instanceof GarminTokenExpiredError) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ code: "not_authenticated", message: err.message }),
          },
        ],
      };
    }
    throw err;
  }
}

const workoutIdSchema = {
  workoutId: z.union([z.string(), z.number()]).describe("Garmin workout ID"),
};

const workoutBodySchema = {
  workout: z
    .object({
      workoutName: z.string().describe("Name for the workout"),
      sportType: z
        .object({
          sportTypeId: z.number().describe("Sport type ID (1=running, 2=cycling, 3=swimming)"),
          sportTypeKey: z.string().describe("Sport type key (e.g. 'running')"),
        })
        .describe("Sport type"),
      workoutSegments: z
        .array(z.record(z.string(), z.unknown()))
        .describe(
          "Array of workout segments containing steps (warmup, intervals, cooldown). Each segment has sportType and workoutSteps array.",
        ),
      description: z.string().optional().describe("Optional workout description"),
    })
    .describe("Workout object following Garmin workout JSON structure"),
};

// ── Structured workout spec (built into Garmin JSON by buildWorkout) ──

const durationSchema = z
  .union([
    z.object({ seconds: z.number().positive().describe("Step length in seconds") }),
    z.object({ meters: z.number().positive().describe("Step length in meters") }),
    z.literal("lap.button"),
  ])
  .describe(
    'How the step ends: { seconds: 600 }, { meters: 1000 }, or "lap.button" (until the user presses lap). Default "lap.button".',
  );

const paceSchema = z
  .string()
  .regex(/^\d{1,2}:[0-5]\d$/, 'min:sec per km, e.g. "4:30"')
  .describe('Pace per km as min:sec, e.g. "4:30"');

const targetSchema = z
  .union([
    z.object({ hrZone: z.number().int().min(1).max(5).describe("Heart rate zone 1-5") }),
    z.object({
      pace: z
        .object({ fast: paceSchema, slow: paceSchema })
        .describe('Pace range per km, e.g. { fast: "4:30", slow: "4:50" }'),
    }),
  ])
  .describe("Optional intensity target: an HR zone or a pace range. Omit for no target.");

const simpleStepSchema = z.object({
  type: z
    .enum(["warmup", "run", "recovery", "rest", "cooldown", "other"])
    .describe(
      'Step kind. "run" is a work interval or the main set; "recovery" is an easy jog between reps.',
    ),
  duration: durationSchema.optional(),
  target: targetSchema.optional(),
  description: z.string().optional().describe("Optional note shown on the watch"),
});

// Repeats nest up to two levels (enough for ladders and sets), which keeps the
// JSON schema free of recursive $refs
const innerRepeatSchema = z.object({
  repeat: z.number().int().min(1).describe("Number of times to repeat the steps"),
  steps: z.array(simpleStepSchema).min(1),
});
const repeatSchema = z.object({
  repeat: z.number().int().min(1).describe("Number of times to repeat the steps"),
  steps: z
    .array(z.union([simpleStepSchema, innerRepeatSchema]))
    .min(1)
    .describe("Steps inside the repeat (e.g. a run and a recovery)"),
});

const structuredWorkoutSchema = {
  name: z.string().min(1).describe('Workout name, e.g. "Easy 45 min" or "5x1km @ 4:00"'),
  sport: z
    .enum([
      "running",
      "cycling",
      "swimming",
      "strength_training",
      "cardio_training",
      "yoga",
      "pilates",
      "hiit",
      "other",
    ])
    .describe("Sport"),
  description: z.string().optional().describe("Optional workout description"),
  steps: z
    .array(z.union([simpleStepSchema, repeatSchema]))
    .min(1)
    .describe(
      "Steps in order. A step is { type, duration?, target? }; a repeat is { repeat: n, steps: [...] }.",
    ),
  scheduleDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Optional YYYY-MM-DD: also put the workout on the user's Garmin calendar that day"),
};

export function registerWorkoutTools(server: McpServer, resourceUri: string) {
  registerAppTool(
    server,
    "list-workouts",
    {
      title: "List Workouts",
      description:
        "List the user's saved/custom workouts (structured workouts they created, e.g. 'LT', 'Tempo 5K', '4x1km'). Use this whenever the user refers to a workout by name, then get-workout for its steps.",
      inputSchema: z.object({
        name: z
          .string()
          .optional()
          .describe("Only workouts whose name contains this text (case-insensitive)"),
        start: z.number().optional().describe("Start index (default 0)"),
        limit: z.number().optional().describe("Max results (default 20)"),
      }),
      _meta: { ui: { resourceUri } },
    },
    async ({ name, start, limit }) =>
      withAuth(async () => {
        const workouts = await getClient().getWorkouts(start ?? 0, limit ?? 20);
        if (!name || !Array.isArray(workouts)) return workouts;
        const needle = name.toLowerCase();
        return workouts.filter((w: { workoutName?: string }) =>
          w.workoutName?.toLowerCase().includes(needle),
        );
      }),
  );

  registerAppTool(
    server,
    "get-workout",
    {
      title: "Get Workout",
      description:
        "Get a saved workout's steps (warm-up, intervals, targets) by ID. To find a workout by name, call list-workouts first.",
      inputSchema: z.object(workoutIdSchema),
      _meta: { ui: { resourceUri } },
    },
    async ({ workoutId }) => withAuth(() => getClient().getWorkout(workoutId), { workoutId }),
  );

  registerAppTool(
    server,
    "create-workout",
    {
      title: "Create Workout",
      description: `Create a workout from raw Garmin workout JSON. Prefer create-structured-workout, which builds this JSON from a simple step list and avoids format mistakes; use this only for something it can't express.

Workout structure:
- sportType: { sportTypeId: 1, sportTypeKey: 'running' } for running
- workoutSegments: array of segments, each with segmentOrder and workoutSteps
- Each step uses type "ExecutableStepDTO" for regular steps, "RepeatGroupDTO" for repeat groups
- Common step structure: { stepOrder, stepType, endCondition, endConditionValue, targetType, targetValueLow, targetValueHigh }

Step types: warmup, cooldown, interval, rest, recovery, repeat
End conditions: time (seconds), distance (meters), lap.button (manual lap)
Target types: heart.rate.zone (1-5), pace.zone, speed.zone, no.target

Example - 5x1000m intervals:
- Warmup: 15min easy (endCondition: time, endConditionValue: 900)
- Repeat group (numberOfIterations: 5):
  - Interval: 1000m (endCondition: distance, endConditionValue: 1000)
  - Recovery: 90s jog (endCondition: time, endConditionValue: 90)
- Cooldown: 10min easy (endCondition: time, endConditionValue: 600)`,
      inputSchema: z.object(workoutBodySchema),
      _meta: { ui: { resourceUri } },
    },
    async ({ workout }) =>
      withAuth(
        () => getClient().createWorkout(workout as Record<string, unknown>),
        { action: "created" },
        (data) => ({ workoutId: (data as { workoutId?: number } | null)?.workoutId }),
      ),
  );

  registerAppTool(
    server,
    "create-structured-workout",
    {
      title: "Create Structured Workout",
      description: `Create a workout on Garmin Connect from a simple step list, and optionally put it on the calendar (scheduleDate). Use this instead of create-workout. The app shows the new workout's steps.

Example: 5x1km intervals on a Tuesday
{ "name": "5x1km @ 4:00", "sport": "running", "scheduleDate": "2026-10-06",
  "steps": [
    { "type": "warmup", "duration": { "seconds": 900 }, "target": { "hrZone": 2 } },
    { "repeat": 5, "steps": [
      { "type": "run", "duration": { "meters": 1000 }, "target": { "pace": { "fast": "3:55", "slow": "4:05" } } },
      { "type": "recovery", "duration": { "seconds": 90 } } ] },
    { "type": "cooldown", "duration": { "seconds": 600 }, "target": { "hrZone": 1 } } ] }

An easy run is a single { "type": "run", "duration": { "seconds": 2700 }, "target": { "hrZone": 2 } } step. Base targets on the user's own zones and recent paces (get-training-context).`,
      inputSchema: z.object(structuredWorkoutSchema),
      _meta: { ui: { resourceUri } },
    },
    async ({ scheduleDate, ...spec }) => {
      let workout;
      try {
        workout = buildWorkout(spec as WorkoutSpec);
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Invalid workout: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
      return withAuth(
        async () => {
          const client = getClient();
          const created = (await client.createWorkout(
            workout as unknown as Record<string, unknown>,
          )) as {
            workoutId?: number;
            workoutName?: string;
            estimatedDurationInSecs?: number | null;
            estimatedDistanceInMeters?: number | null;
          } | null;
          const workoutId = created?.workoutId;
          // A compact answer for Claude; the app fetches the steps itself
          const result: Record<string, unknown> = {
            workoutId,
            workoutName: created?.workoutName ?? workout.workoutName,
            sport: spec.sport,
            estimatedDurationInSecs:
              created?.estimatedDurationInSecs ?? workout.estimatedDurationInSecs ?? null,
            estimatedDistanceInMeters:
              created?.estimatedDistanceInMeters ?? workout.estimatedDistanceInMeters ?? null,
          };
          if (scheduleDate && workoutId !== undefined) {
            const scheduled = (await client.scheduleWorkout(workoutId, scheduleDate)) as {
              workoutScheduleId?: number;
            } | null;
            result.scheduled = {
              date: scheduleDate,
              workoutScheduleId: scheduled?.workoutScheduleId ?? null,
            };
          }
          return result;
        },
        scheduleDate ? { action: "scheduled", date: scheduleDate } : { action: "created" },
        (data) => ({ workoutId: (data as { workoutId?: number } | null)?.workoutId }),
      );
    },
  );

  registerAppTool(
    server,
    "update-workout",
    {
      title: "Update Workout",
      description: "Update an existing workout on Garmin Connect",
      inputSchema: z.object({ ...workoutIdSchema, ...workoutBodySchema }),
      _meta: { ui: { resourceUri } },
    },
    async ({ workoutId, workout }) =>
      withAuth(() => getClient().updateWorkout(workoutId, workout as Record<string, unknown>), {
        workoutId,
        action: "updated",
      }),
  );

  registerAppTool(
    server,
    "delete-workout",
    {
      title: "Delete Workout",
      description: "Delete a workout from Garmin Connect",
      inputSchema: z.object(workoutIdSchema),
      _meta: { ui: { resourceUri } },
    },
    async ({ workoutId }) =>
      withAuth(() => getClient().deleteWorkout(workoutId), { action: "deleted" }),
  );

  registerAppTool(
    server,
    "schedule-workout",
    {
      title: "Schedule Workout",
      description: "Schedule a workout on a specific calendar date in Garmin Connect",
      inputSchema: z.object({
        ...workoutIdSchema,
        date: z.string().describe("Date to schedule the workout (YYYY-MM-DD)"),
      }),
      _meta: { ui: { resourceUri } },
    },
    async ({ workoutId, date }) =>
      withAuth(() => getClient().scheduleWorkout(workoutId, date), {
        workoutId,
        date,
        action: "scheduled",
      }),
  );
}
