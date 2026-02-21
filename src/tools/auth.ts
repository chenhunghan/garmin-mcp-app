import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { getClient } from "../garmin.js";

export function registerAuthTools(server: McpServer, resourceUri: string) {
  registerAppTool(
    server,
    "garmin-check-auth",
    {
      title: "Check Garmin Auth",
      description: "Check if the user is authenticated with Garmin Connect",
      _meta: { ui: { resourceUri, visibility: ["app"] } },
    },
    async () => {
      const client = getClient();
      try {
        await client.resume();
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ authenticated: true }) }],
        };
      } catch {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ authenticated: false }) }],
        };
      }
    },
  );

  registerAppTool(
    server,
    "garmin-login",
    {
      title: "Garmin Login",
      description: "Log in to Garmin Connect with email and password",
      inputSchema: { email: z.string(), password: z.string() },
      _meta: { ui: { resourceUri, visibility: ["app"] } },
    },
    async ({ email, password }) => {
      const client = getClient();
      const result = await client.login(email, password);
      if (result.status === "needs_mfa") {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ status: "needs_mfa" }) }],
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ status: "success" }) }],
      };
    },
  );

  registerAppTool(
    server,
    "garmin-submit-mfa",
    {
      title: "Submit Garmin MFA",
      description: "Submit MFA verification code for Garmin Connect login",
      inputSchema: { code: z.string() },
      _meta: { ui: { resourceUri, visibility: ["app"] } },
    },
    async ({ code }) => {
      const client = getClient();
      await client.submitMfa(code);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ status: "success" }) }],
      };
    },
  );

  registerAppTool(
    server,
    "garmin-logout",
    {
      title: "Garmin Logout",
      description: "Log out of Garmin Connect and clear saved tokens",
      _meta: { ui: { resourceUri, visibility: ["app"] } },
    },
    async () => {
      const client = getClient();
      await client.logout();
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ status: "logged_out" }) }],
      };
    },
  );
}
