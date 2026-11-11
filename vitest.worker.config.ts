import { defineConfig } from "vitest/config";

// The self-hosted Worker in workerd (Miniflare), driven from Node: Vitest 5
// can't run @cloudflare/vitest-pool-workers (Vitest 4 only), so the tests
// bundle the Worker with wrangler and talk to it over dispatchFetch.
export default defineConfig({
  test: {
    include: ["tests/worker/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
