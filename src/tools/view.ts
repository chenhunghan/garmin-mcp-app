import type { ClientCapabilities, McpServer } from "@modelcontextprotocol/server";
import {
  EXTENSION_ID,
  RESOURCE_MIME_TYPE,
  getUiCapability,
} from "@modelcontextprotocol/ext-apps/server";

/** What a client that renders the app announces (used by the dev UI and tests). */
export const APP_HOST_CAPABILITIES: ClientCapabilities = {
  extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } },
};

/**
 * Whether to send `structuredContent` (which view to open, and for what) with
 * a tool result. Only clients that render the app need it, and some that
 * don't (Claude Code) hand the model `structuredContent` instead of the text,
 * so it would see `{"view":…}` and none of the data.
 *
 * Unknown capabilities (a 2025-era request to the stateless remote server
 * carries none) count as an app host: that's what every remote host was until
 * clients started sending them with each request.
 */
export function rendersViews(server: McpServer): boolean {
  const capabilities = server.server.getClientCapabilities();
  if (!capabilities) return true;
  return getUiCapability(capabilities)?.mimeTypes?.includes(RESOURCE_MIME_TYPE) ?? false;
}

/** The `structuredContent` that routes a result to `view`, or nothing for clients without views. */
export function viewRouting(
  server: McpServer,
  view: string,
  args: Record<string, unknown> = {},
): { structuredContent?: { view: string; args: Record<string, unknown> } } {
  return rendersViews(server) ? { structuredContent: { view, args } } : {};
}
