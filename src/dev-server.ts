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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";

let client: Client | null = null;

export async function getDevClient(): Promise<Client> {
  if (client) return client;

  const server = createServer("dev");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  // Server must listen before client connects, otherwise the client's
  // initialize request has no listener and times out after 60s.
  await server.connect(serverTransport);

  client = new Client({ name: "dev-client", version: "0.0.0" });
  await client.connect(clientTransport);

  return client;
}
