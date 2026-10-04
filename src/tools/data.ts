import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { GarminAuthError, GarminTokenExpiredError } from "garmin-connect";
import { getClient } from "../garmin.js";
import { waitForAuth } from "../auth-gate.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * Run a Garmin call, waiting for sign-in through the app UI if needed.
 * `view` picks the chart; `args` are echoed so the chart shows what was asked
 * for (a specific date or activity) rather than today/latest.
 */
async function withAuth(
  fn: () => Promise<unknown>,
  view?: string,
  args?: Record<string, unknown>,
): Promise<ToolResult> {
  const structured = view ? { structuredContent: { view, args: args ?? {} } } : {};
  const client = getClient();
  if (!client.isAuthenticated) {
    try {
      await client.resume();
    } catch {
      // Wait for the user to log in through the MCP App UI.
      // The tool stays "pending" while the iframe shows the login form.
      await waitForAuth();
    }
  }
  try {
    const data = await fn();
    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
      ...structured,
    };
  } catch (err) {
    if (err instanceof GarminAuthError || err instanceof GarminTokenExpiredError) {
      // Token expired mid-session — wait for re-auth through the UI
      await waitForAuth();
      const data = await fn();
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        ...structured,
      };
    }
    throw err;
  }
}

const dateSchema = { date: z.string().describe("Date in YYYY-MM-DD format") };
const dateRangeSchema = {
  startDate: z.string().describe("Start date in YYYY-MM-DD format"),
  endDate: z.string().describe("End date in YYYY-MM-DD format"),
};
const activityIdSchema = {
  activityId: z.union([z.string(), z.number()]).describe("Garmin activity ID"),
};

export function registerDataTools(server: McpServer, resourceUri: string) {
  registerAppTool(
    server,
    "get-steps",
    {
      title: "Get Steps",
      description:
        "Get step count data from Garmin Connect. Supports a single date or a date range.",
      inputSchema: {
        date: z.string().describe("Start date in YYYY-MM-DD format"),
        endDate: z.string().optional().describe("End date in YYYY-MM-DD format (defaults to date)"),
      },
      _meta: { ui: { resourceUri } },
    },
    async ({ date, endDate }) =>
      withAuth(() => getClient().getSteps(date, endDate), "steps", { date, endDate }),
  );

  registerAppTool(
    server,
    "get-heart-rates",
    {
      title: "Get Heart Rates",
      description: "Get heart rate data for a given date from Garmin Connect",
      inputSchema: dateSchema,
      _meta: { ui: { resourceUri } },
    },
    async ({ date }) => withAuth(() => getClient().getHeartRates(date), "heart-rate", { date }),
  );

  registerAppTool(
    server,
    "get-sleep",
    {
      title: "Get Sleep",
      description: "Get sleep data for a given date from Garmin Connect",
      inputSchema: dateSchema,
      _meta: { ui: { resourceUri } },
    },
    async ({ date }) => withAuth(() => getClient().getSleepData(date), "sleep", { date }),
  );

  registerAppTool(
    server,
    "get-stress",
    {
      title: "Get Stress",
      description: "Get stress data for a given date from Garmin Connect",
      inputSchema: dateSchema,
      _meta: { ui: { resourceUri } },
    },
    async ({ date }) => withAuth(() => getClient().getStressData(date), "stress", { date }),
  );

  registerAppTool(
    server,
    "get-activities",
    {
      title: "Get Activities",
      description: "Get recent activities from Garmin Connect",
      inputSchema: {
        start: z.number().optional().describe("Start index (default 0)"),
        limit: z.number().optional().describe("Max results (default 20)"),
      },
      _meta: { ui: { resourceUri } },
    },
    async ({ start, limit }) =>
      withAuth(() => getClient().getActivities(start ?? 0, limit ?? 20), "activities", { limit }),
  );

  // ── Recovery & Readiness ─────────────────────────────

  registerAppTool(
    server,
    "get-training-readiness",
    {
      title: "Get Training Readiness",
      description:
        "Get training readiness score (0-100) and breakdown (sleep, HRV, recovery, stress) for a given date",
      inputSchema: dateSchema,
      _meta: { ui: { resourceUri } },
    },
    async ({ date }) =>
      withAuth(() => getClient().getTrainingReadiness(date), "training", { date }),
  );

  registerAppTool(
    server,
    "get-training-status",
    {
      title: "Get Training Status",
      description:
        "Get training status including acute/chronic load, ACWR, and load status for a given date",
      inputSchema: dateSchema,
      _meta: { ui: { resourceUri } },
    },
    async ({ date }) => withAuth(() => getClient().getTrainingStatus(date), "training", { date }),
  );

  registerAppTool(
    server,
    "get-hrv",
    {
      title: "Get HRV",
      description:
        "Get heart rate variability data (nightly avg, weekly avg, baseline, status) for a date range",
      inputSchema: dateRangeSchema,
      _meta: { ui: { resourceUri } },
    },
    async ({ startDate, endDate }) =>
      withAuth(() => getClient().getHrvData(startDate, endDate), "training", { date: endDate }),
  );

  registerAppTool(
    server,
    "get-body-battery",
    {
      title: "Get Body Battery",
      description: "Get daily body battery charged/drained values for a date range",
      inputSchema: dateRangeSchema,
      _meta: { ui: { resourceUri } },
    },
    async ({ startDate, endDate }) =>
      withAuth(() => getClient().getBodyBattery(startDate, endDate), "heart-rate", {
        date: endDate,
      }),
  );

  // ── Activity Deep Dive ──────────────────────────────

  registerAppTool(
    server,
    "get-activity-details",
    {
      title: "Get Activity Details",
      description: "Get full details for a specific Garmin activity by ID",
      inputSchema: activityIdSchema,
      _meta: { ui: { resourceUri } },
    },
    async ({ activityId }) =>
      withAuth(() => getClient().getActivityDetails(activityId), "splits", { activityId }),
  );

  registerAppTool(
    server,
    "get-activity-splits",
    {
      title: "Get Activity Splits",
      description: "Get per-km/mile splits (pace, HR, cadence) for a specific activity",
      inputSchema: activityIdSchema,
      _meta: { ui: { resourceUri } },
    },
    async ({ activityId }) =>
      withAuth(() => getClient().getActivitySplits(activityId), "splits", { activityId }),
  );

  registerAppTool(
    server,
    "get-activity-hr-zones",
    {
      title: "Get Activity HR Zones",
      description: "Get heart rate time-in-zones breakdown for a specific activity",
      inputSchema: activityIdSchema,
      _meta: { ui: { resourceUri } },
    },
    async ({ activityId }) =>
      withAuth(() => getClient().getActivityHrZones(activityId), "hr-zones", { activityId }),
  );

  // ── Fitness Benchmarks ──────────────────────────────

  registerAppTool(
    server,
    "get-vo2-max",
    {
      title: "Get VO2 Max",
      description: "Get VO2 Max trend data for a date range",
      inputSchema: dateRangeSchema,
      _meta: { ui: { resourceUri } },
    },
    async ({ startDate, endDate }) =>
      withAuth(() => getClient().getVo2Max(startDate, endDate), "race-predictions", {
        date: endDate,
      }),
  );

  registerAppTool(
    server,
    "get-race-predictions",
    {
      title: "Get Race Predictions",
      description: "Get predicted race times for 5K, 10K, half marathon, and marathon",
      inputSchema: {},
      _meta: { ui: { resourceUri } },
    },
    async () => withAuth(() => getClient().getRacePredictions(), "race-predictions"),
  );

  // ── Composite: Training Context ───────────────────────

  registerAppTool(
    server,
    "get-training-context",
    {
      title: "Get Training Context",
      description:
        "Collects comprehensive training context for workout planning: recent running activities, sleep, HRV, training readiness, body battery, VO2 max, and training status. Use this before planning a workout.",
      inputSchema: {
        date: z.string().describe("Reference date (YYYY-MM-DD), typically today"),
      },
      _meta: { ui: { resourceUri } },
    },
    async ({ date }) =>
      withAuth(
        async () => {
          const client = getClient();

          // Compute relative dates in UTC: a local-midnight Date printed with
          // toISOString() lands on the previous day east of UTC
          const refDate = new Date(date + "T00:00:00Z");
          const daysAgo = (n: number) =>
            new Date(refDate.getTime() - n * 86_400_000).toISOString().slice(0, 10);
          const start7 = daysAgo(7);
          const start14 = daysAgo(14);
          const start30 = daysAgo(30);

          // Fetch all data in parallel
          const [
            activitiesResult,
            sleepResult,
            hrvResult,
            readinessResult,
            batteryResult,
            vo2Result,
            statusResult,
          ] = await Promise.allSettled([
            client.getActivities(0, 20),
            client.getSleepData(date),
            client.getHrvData(start14, date),
            client.getTrainingReadiness(date),
            client.getBodyBattery(start7, date),
            client.getVo2Max(start30, date),
            client.getTrainingStatus(date),
          ]);

          const val = <T>(r: PromiseSettledResult<T>): T | null =>
            r.status === "fulfilled" ? r.value : null;

          // Filter to running activities
          const allActivities = (val(activitiesResult) as Array<Record<string, unknown>>) ?? [];
          const runningActivities = allActivities.filter((a) => {
            const typeKey = (a.activityType as Record<string, unknown>)?.typeKey as
              | string
              | undefined;
            const sportTypeId = a.sportTypeId as number | undefined;
            return (typeKey && typeKey.includes("running")) || sportTypeId === 1;
          });
          const recentRuns = runningActivities.slice(0, 10);

          // Days since last run
          let daysSinceLastRun: number | null = null;
          if (recentRuns.length > 0) {
            const lastRunDay = (recentRuns[0].startTimeLocal as string).slice(0, 10);
            daysSinceLastRun = Math.round(
              (refDate.getTime() - new Date(lastRunDay + "T00:00:00Z").getTime()) / 86_400_000,
            );
          }

          // Weekly volume: runs in the last 7 days. startTimeLocal is wall-clock
          // time ("YYYY-MM-DD HH:mm:ss"), so compare its date part as a string
          const runsThisWeek = runningActivities.filter(
            (a) => (a.startTimeLocal as string).slice(0, 10) >= start7,
          );
          const weeklyVolume = {
            distanceKm: runsThisWeek.reduce(
              (sum, a) => sum + ((a.distance as number) ?? 0) / 1000,
              0,
            ),
            durationHours: runsThisWeek.reduce(
              (sum, a) => sum + ((a.duration as number) ?? 0) / 3600,
              0,
            ),
            count: runsThisWeek.length,
          };

          return {
            recentRuns,
            daysSinceLastRun,
            weeklyVolume,
            sleep: val(sleepResult),
            hrv: val(hrvResult),
            trainingReadiness: val(readinessResult),
            bodyBattery: val(batteryResult),
            vo2Max: val(vo2Result),
            trainingStatus: val(statusResult),
          };
        },
        "run-planner",
        { date },
      ),
  );
}
