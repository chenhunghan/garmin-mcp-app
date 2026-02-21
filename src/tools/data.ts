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

const dateSchema = { date: z.string().describe("Date in YYYY-MM-DD format") };

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
}
