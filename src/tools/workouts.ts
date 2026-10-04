import type { McpServer } from "@modelcontextprotocol/server";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { GarminAuthError, GarminTokenExpiredError } from "garmin-connect";
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
      description: `Create a new workout on Garmin Connect.

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
