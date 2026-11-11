import type { ClientCapabilities, McpServer } from "@modelcontextprotocol/server";
import {
  EXTENSION_ID,
  RESOURCE_MIME_TYPE,
  getUiCapability,
} from "@modelcontextprotocol/ext-apps/server";

/** What a client that renders the app announces. */
export const APP_HOST_CAPABILITIES: ClientCapabilities = {
  extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } },
};

/**
 * Clients (by `clientInfo.name`) that hand the model `structuredContent`
 * instead of the text when a result has both, and don't render the app: with
 * the view routing they'd see `{"view":…}` and none of the data.
 */
const TEXT_ONLY_CLIENTS = new Set(["claude-code"]);

/**
 * Whether to send `structuredContent` (which view to open, and for what) with
 * a tool result. Every client gets it, as before, except a known text-only
 * client that doesn't announce the MCP Apps capability. Deliberately narrow:
 * a host that renders the app must never lose its routing, whatever it
 * announces.
 */
export function rendersViews(server: McpServer): boolean {
  const name = server.server.getClientVersion()?.name;
  if (!name || !TEXT_ONLY_CLIENTS.has(name)) return true;
  const ui = getUiCapability(server.server.getClientCapabilities());
  return ui?.mimeTypes?.includes(RESOURCE_MIME_TYPE) ?? false;
}

/** The `structuredContent` that routes a result to `view`; nothing for a text-only client. */
export function viewRouting(
  server: McpServer,
  view: string,
  args: Record<string, unknown> = {},
): { structuredContent?: { view: string; args: Record<string, unknown> } } {
  return rendersViews(server) ? { structuredContent: { view, args } } : {};
}
