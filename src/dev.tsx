/**
 * Browser entry point for `npm run dev:ui`.
 *
 * Stands in for the MCP host (e.g. Claude Desktop) by intercepting the App's
 * JSON-RPC postMessages and either mocking them (host protocol) or proxying
 * them to the real MCP server via the Vite dev server's /api/tools/call endpoint.
 *
 * Host protocol messages (ui/initialize, ping) are mocked locally — they are
 * part of the app ↔ host handshake and have no server-side equivalent.
 *
 * Tool calls (tools/call) are forwarded via fetch to /api/tools/call, which
 * the Vite plugin (dev-plugin.ts) routes to the real MCP server in-process.
 *
 * Simulating a tool call from Claude: `?tool=<name>&args=<json>` runs that tool
 * on the real server once the app has initialized, and delivers the result as a
 * `ui/notifications/tool-result`, like Claude Desktop does when Claude calls a
 * tool with a UI. Without `?tool`, all charts are shown.
 *
 * stopImmediatePropagation() is called on every handled message because in dev
 * mode window.parent === window, so postMessages echo back to the App's own
 * PostMessageTransport. Without stopping propagation, the transport receives
 * the echoed request, sends a "method not found" error with the same request
 * id, and prematurely resolves the App's pending promise before our real
 * response arrives.
 */
import { createRoot } from "react-dom/client";
import { GarminApp } from "./app.tsx";

function callServerTool(name: string, args: unknown) {
  return fetch("/api/tools/call", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, arguments: args }),
  }).then((r) => r.json());
}

/** `?tool=...&args=...`: deliver that tool's result like the host would. */
function simulateToolCall() {
  const params = new URLSearchParams(location.search);
  const tool = params.get("tool");
  if (!tool) return;
  const args = JSON.parse(params.get("args") ?? "{}");
  void callServerTool(tool, args).then((result) => {
    window.postMessage(
      { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result },
      "*",
    );
  });
}

window.addEventListener("message", (e) => {
  // In dev mode, window.parent === window so all postMessages echo back.
  // Filter out anything that isn't a JSON-RPC *request* (must have method).
  // This prevents the ext-apps PostMessageTransport from trying to parse
  // non-JSON-RPC messages (Vite HMR, extensions, etc.) and logging errors.
  if (e.data?.jsonrpc !== "2.0") {
    e.stopImmediatePropagation();
    return;
  }
  if (!e.data.method) {
    // JSON-RPC response (has result/error but no method) — let it through
    // to the transport so it can resolve pending promises.
    return;
  }

  if (e.data.method === "ui/initialize") {
    e.stopImmediatePropagation();
    window.postMessage(
      {
        jsonrpc: "2.0",
        id: e.data.id,
        result: {
          protocolVersion: "2026-01-26",
          capabilities: {},
          hostInfo: { name: "dev-mock", version: "0.0.0" },
          hostCapabilities: {},
          hostContext: { theme: "light" },
        },
      },
      "*",
    );
  } else if (e.data.method === "ping") {
    e.stopImmediatePropagation();
    window.postMessage({ jsonrpc: "2.0", id: e.data.id, result: {} }, "*");
  } else if (e.data.method === "ui/notifications/initialized") {
    e.stopImmediatePropagation();
    simulateToolCall();
  } else if (e.data.method === "tools/call") {
    e.stopImmediatePropagation();
    const { name, arguments: args } = e.data.params ?? {};
    callServerTool(name, args)
      .then((result) => {
        window.postMessage({ jsonrpc: "2.0", id: e.data.id, result }, "*");
      })
      .catch((err) => {
        window.postMessage(
          {
            jsonrpc: "2.0",
            id: e.data.id,
            result: {
              isError: true,
              content: [{ type: "text", text: String(err) }],
            },
          },
          "*",
        );
      });
  }
  // Silently ignore notifications (ui/notifications/*)
});

createRoot(document.body).render(<GarminApp />);
