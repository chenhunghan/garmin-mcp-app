import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "../package.json" with { type: "json" };
import { createServer } from "./server.js";

const server = createServer(pkg.version);
const transport = new StdioServerTransport();
await server.connect(transport);

console.error(`garmin-mcp v${pkg.version} running on stdio`);
