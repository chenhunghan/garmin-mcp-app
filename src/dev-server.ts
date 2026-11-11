/**
 * Boots the real MCP server and an in-memory MCP client within the Vite dev
 * server process. The client is lazy-initialized on first request and reused
 * for all subsequent tool calls.
 *
 * InMemoryTransport.createLinkedPair() creates a paired transport so the
 * client and server communicate directly without stdio or network.
 *
 * Important: the server must connect before the client — client.connect()
 * sends an `initialize` request and blocks until the server responds.
 */
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "./server.js";
import { localDeps } from "./local-deps.js";
import { APP_HOST_CAPABILITIES } from "./tools/view.js";

let client: Client | null = null;

export async function getDevClient(): Promise<Client> {
  if (client) return client;

  // `npm run dev:ui:demo`: answer Garmin with the fictional demo athlete.
  // Imported only here, so nothing demo-related reaches the production build.
  if (process.env.GARMIN_DEMO === "1") {
    const { startDemoMode } = await import("./demo/server.ts");
    startDemoMode();
  }

  const server = createServer("dev", localDeps());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  // Server must listen before client connects, otherwise the client's
  // initialize request has no listener and times out after 60s.
  await server.connect(serverTransport);

  // The dev UI renders the app, so it announces that like a real host does
  client = new Client(
    { name: "dev-client", version: "0.0.0" },
    { capabilities: APP_HOST_CAPABILITIES },
  );
  await client.connect(clientTransport);

  return client;
}
