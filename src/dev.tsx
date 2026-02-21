import { createRoot } from "react-dom/client";
import { GarminApp } from "./app.tsx";

// Mock the host's postMessage responses so useApp connects standalone
window.addEventListener("message", (e) => {
  if (e.data?.jsonrpc !== "2.0") return;

  if (e.data.method === "ui/initialize") {
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
    window.postMessage({ jsonrpc: "2.0", id: e.data.id, result: {} }, "*");
  } else if (e.data.method === "tools/call") {
    const { name, arguments: args } = e.data.params ?? {};
    let result: unknown;

    if (name === "garmin-check-auth") {
      result = {
        content: [{ type: "text", text: JSON.stringify({ authenticated: false }) }],
      };
    } else if (name === "garmin-login") {
      console.log("[dev-mock] garmin-login called with", args);
      result = {
        content: [{ type: "text", text: JSON.stringify({ status: "needs_mfa" }) }],
      };
    } else if (name === "garmin-submit-mfa") {
      console.log("[dev-mock] garmin-submit-mfa called with", args);
      result = {
        content: [{ type: "text", text: JSON.stringify({ status: "success" }) }],
      };
    } else {
      result = {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ code: "not_authenticated", message: "Not authenticated" }),
          },
        ],
      };
    }

    window.postMessage({ jsonrpc: "2.0", id: e.data.id, result }, "*");
  }
  // Silently ignore notifications (ui/notifications/*)
});

createRoot(document.body).render(<GarminApp />);
