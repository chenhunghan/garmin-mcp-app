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
  }
  // Silently ignore notifications (ui/notifications/*)
});

createRoot(document.body).render(<GarminApp />);
