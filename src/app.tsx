import { useApp } from "@modelcontextprotocol/ext-apps/react";
import "./app.css";

export function GarminApp() {
  const { isConnected, error } = useApp({
    appInfo: { name: "garmin-mcp", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (app) => {
      app.ontoolinput = (_input) => {
        // handle tool input
      };
    },
  });

  if (error) return <div className="center">Error: {error.message}</div>;
  if (!isConnected) return <div className="center">Connecting...</div>;

  return (
    <div className="center">
      <h1>Garmin App</h1>
    </div>
  );
}
