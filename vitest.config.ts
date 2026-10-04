import { defineConfig } from "vitest/config";

// MCP server tests. Library tests live in packages/garmin-connect.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
