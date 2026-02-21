import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { registerAuthTools } from "./tools/auth.js";
import { registerDataTools } from "./tools/data.js";
import { registerWorkoutTools } from "./tools/workouts.js";

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
          _meta: {
            ui: {
              csp: {
                resourceDomains: ["https://esm.sh"],
                connectDomains: ["https://esm.sh"],
              },
            },
          },
        },
      ],
    }),
  );

  registerAuthTools(server, resourceUri);
  registerDataTools(server, resourceUri);
  registerWorkoutTools(server, resourceUri);

  return server;
}
