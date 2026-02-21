import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { GarminAuthError, GarminTokenExpiredError } from "garmin-connect";
import { getClient } from "../garmin.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

async function withAuth(fn: () => Promise<unknown>): Promise<ToolResult> {
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
      content: [{ type: "text", text: JSON.stringify(data) }],
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
  workoutId: z.string().describe("Garmin workout ID"),
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
      description: "List saved workouts from Garmin Connect",
      inputSchema: {
        start: z.number().optional().describe("Start index (default 0)"),
        limit: z.number().optional().describe("Max results (default 20)"),
      },
      _meta: { ui: { resourceUri } },
    },
    async ({ start, limit }) => withAuth(() => getClient().getWorkouts(start ?? 0, limit ?? 20)),
  );

  registerAppTool(
    server,
    "get-workout",
    {
      title: "Get Workout",
      description: "Get workout details by ID from Garmin Connect",
      inputSchema: workoutIdSchema,
      _meta: { ui: { resourceUri } },
    },
    async ({ workoutId }) => withAuth(() => getClient().getWorkout(workoutId)),
  );

  registerAppTool(
    server,
    "create-workout",
    {
      title: "Create Workout",
      description:
        'Create a structured workout on Garmin Connect. The workout object must include workoutName, sportType ({sportTypeId, sportTypeKey}), and workoutSegments array. Each segment contains workoutSteps — use type "ExecutableStepDTO" for steps (warmup/interval/recovery/cooldown) and "RepeatGroupDTO" for repeat groups. Steps need stepType, endCondition (time in seconds, distance in meters, or lap.button), and optionally targetType with target values for pace/HR zones.',
      inputSchema: workoutBodySchema,
      _meta: { ui: { resourceUri } },
    },
    async ({ workout }) =>
      withAuth(() => getClient().createWorkout(workout as Record<string, unknown>)),
  );

  registerAppTool(
    server,
    "update-workout",
    {
      title: "Update Workout",
      description: "Update an existing workout on Garmin Connect",
      inputSchema: { ...workoutIdSchema, ...workoutBodySchema },
      _meta: { ui: { resourceUri } },
    },
    async ({ workoutId, workout }) =>
      withAuth(() => getClient().updateWorkout(workoutId, workout as Record<string, unknown>)),
  );

  registerAppTool(
    server,
    "delete-workout",
    {
      title: "Delete Workout",
      description: "Delete a workout from Garmin Connect",
      inputSchema: workoutIdSchema,
      _meta: { ui: { resourceUri } },
    },
    async ({ workoutId }) => withAuth(() => getClient().deleteWorkout(workoutId)),
  );

  registerAppTool(
    server,
    "schedule-workout",
    {
      title: "Schedule Workout",
      description: "Schedule a workout on a specific calendar date in Garmin Connect",
      inputSchema: {
        ...workoutIdSchema,
        date: z.string().describe("Date to schedule the workout (YYYY-MM-DD)"),
      },
      _meta: { ui: { resourceUri } },
    },
    async ({ workoutId, date }) => withAuth(() => getClient().scheduleWorkout(workoutId, date)),
  );
}
