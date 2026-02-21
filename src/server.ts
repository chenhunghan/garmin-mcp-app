import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createServer(version: string) {
  const server = new McpServer({
    name: "garmin-mcp",
    version,
  });

  const resourceUri = "ui://garmin-mcp/app.html";

  registerAppResource(
    server,
    "Garmin App",
    resourceUri,
    { description: "Garmin MCP App UI" },
    async () => ({
      contents: [
        {
          uri: resourceUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: await readFile(resolve(__dirname, "app.html"), "utf-8"),
        },
      ],
    }),
  );

  registerAppTool(
    server,
    "hello",
    {
      title: "Hello",
      description: "Say hello with an interactive UI",
      _meta: { ui: { resourceUri } },
    },
    async () => ({
      content: [{ type: "text" as const, text: "Hello from Garmin MCP!" }],
    }),
  );

  return server;
}
