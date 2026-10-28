/**
 * The server and its tools get everything that depends on where they run
 * (Garmin client, settings, caches, sign-in) from ServerDeps, so the same
 * code serves stdio and other runtimes. Only local-deps.ts wires the Node
 * implementations in.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const LOCAL_ONLY = [
  "garmin.js",
  "settings.js",
  "auth-gate.js",
  "login-key.js",
  "geo/fetch.js",
  "asset-store.js",
  "local-deps.js",
];

const src = new URL("../src/", import.meta.url).pathname;
const files = [
  "server.ts",
  ...readdirSync(join(src, "tools")).map((f) => `tools/${f}`),
  ...["run-map.ts", "dem.ts", "osm.ts", "png.ts", "request.ts"].map((f) => `geo/${f}`),
  // The Worker gets Node only through nodejs_compat; its own code uses none
  ...readdirSync(join(src, "worker")).map((f) => `worker/${f}`),
];

describe("ServerDeps", () => {
  for (const file of files) {
    it(`${file} imports nothing local-only`, () => {
      const imports = [...readFileSync(join(src, file), "utf-8").matchAll(/from "([^"]+)"/g)].map(
        (m) => m[1]!,
      );
      const bad = imports.filter(
        (i) => i.startsWith("node:") || LOCAL_ONLY.some((l) => i.endsWith(`/${l}`)),
      );
      expect(bad).toEqual([]);
    });
  }
});

describe("self-hosted Worker", () => {
  const worker = readdirSync(join(src, "worker"));

  // Health data: nothing the Worker handles may end up in logs
  for (const file of worker) {
    it(`worker/${file} doesn't log`, () => {
      expect(readFileSync(join(src, "worker", file), "utf-8")).not.toMatch(/\bconsole\./);
    });
  }

  it("is not part of the stdio build", async () => {
    const result = await build({
      entryPoints: [join(src, "index.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.some((f) => f.includes("src/server.ts"))).toBe(true);
    expect(inputs.filter((f) => f.includes("src/worker/"))).toEqual([]);
  });
});
