import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { getClient } from "../garmin.js";
import { notifyAuth } from "../auth-gate.js";
import { decryptWithLoginKey, issueLoginKey } from "../login-key.js";

export function registerAuthTools(server: McpServer, resourceUri: string) {
  registerAppTool(
    server,
    "garmin-check-auth",
    {
      title: "Check Garmin Auth",
      description: "Check if the user is authenticated with Garmin Connect",
      _meta: { ui: { resourceUri } },
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
    "garmin-get-login-key",
    {
      title: "Get Garmin Login Key",
      description: "Issue a single-use public key for encrypting the Garmin password",
      _meta: { ui: { resourceUri, visibility: ["app"] } },
    },
    async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ publicKey: issueLoginKey() }) }],
    }),
  );

  registerAppTool(
    server,
    "garmin-login",
    {
      title: "Garmin Login",
      description: "Log in to Garmin Connect with email and an encrypted password",
      inputSchema: {
        email: z.string(),
        encryptedPassword: z
          .string()
          .describe("Password encrypted with the key from garmin-get-login-key"),
      },
      _meta: { ui: { resourceUri, visibility: ["app"] } },
    },
    async ({ email, encryptedPassword }) => {
      const client = getClient();
      const result = await client.login(email, decryptWithLoginKey(encryptedPassword));
      if (result.status === "needs_mfa") {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ status: "needs_mfa" }) }],
        };
      }
      notifyAuth();
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
      notifyAuth();
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
      _meta: { ui: { resourceUri } },
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
