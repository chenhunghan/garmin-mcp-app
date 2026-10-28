/**
 * The server and its tools get everything that depends on where they run
 * (Garmin client, settings, caches, sign-in) from ServerDeps, so the same
 * code serves stdio and other runtimes. Only local-deps.ts wires the Node
 * implementations in.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  ...["run-map.ts", "dem.ts", "osm.ts"].map((f) => `geo/${f}`),
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
