import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { GarminAuthError, GarminTokenExpiredError } from "garmin-connect";
import { getClient } from "../garmin.js";
import { waitForAuth } from "../auth-gate.js";

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
      // Wait for the user to log in through the MCP App UI.
      // The tool stays "pending" while the iframe shows the login form.
      await waitForAuth();
    }
  }
  try {
    const data = await fn();
    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
    };
  } catch (err) {
    if (err instanceof GarminAuthError || err instanceof GarminTokenExpiredError) {
      // Token expired mid-session — wait for re-auth through the UI
      await waitForAuth();
      const data = await fn();
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
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
  activityId: z.string().describe("Garmin activity ID"),
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
    async ({ date, endDate }) => withAuth(() => getClient().getSteps(date, endDate)),
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
    async ({ date }) => withAuth(() => getClient().getHeartRates(date)),
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
    async ({ date }) => withAuth(() => getClient().getSleepData(date)),
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
    async ({ date }) => withAuth(() => getClient().getStressData(date)),
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
    async ({ start, limit }) => withAuth(() => getClient().getActivities(start ?? 0, limit ?? 20)),
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
    async ({ date }) => withAuth(() => getClient().getTrainingReadiness(date)),
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
    async ({ date }) => withAuth(() => getClient().getTrainingStatus(date)),
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
    async ({ startDate, endDate }) => withAuth(() => getClient().getHrvData(startDate, endDate)),
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
      withAuth(() => getClient().getBodyBattery(startDate, endDate)),
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
    async ({ activityId }) => withAuth(() => getClient().getActivityDetails(activityId)),
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
    async ({ activityId }) => withAuth(() => getClient().getActivitySplits(activityId)),
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
    async ({ activityId }) => withAuth(() => getClient().getActivityHrZones(activityId)),
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
    async ({ startDate, endDate }) => withAuth(() => getClient().getVo2Max(startDate, endDate)),
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
    async () => withAuth(() => getClient().getRacePredictions()),
  );

  registerAppTool(
    server,
    "get-user-settings",
    {
      title: "Get User Settings",
      description:
        "Get user profile settings including age, weight, height, and lactate threshold HR",
      inputSchema: {},
      _meta: { ui: { resourceUri } },
    },
    async () => withAuth(() => getClient().getUserSettings()),
  );
}
