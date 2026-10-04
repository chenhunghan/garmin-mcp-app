/**
 * Live check against the real Garmin API: `npm run test:live`.
 *
 * Careful by design: uses saved tokens only (never signs in), one request at a
 * time with a pause, read-only endpoints, and stops everything on the first
 * 429/403. Raw responses go to .live-capture/ (gitignored); run
 * `npm run fixtures:update` afterwards to refresh the sanitized fixtures.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { GarminApiError, GarminClient, GarminRateLimitError } from "../../src/index.ts";
import { responseSchemas } from "../schemas.ts";
import { endpoints, makeContext, type LiveContext } from "./endpoints.ts";
import type { Exchange } from "./sanitize.ts";

const LIVE = process.env.GARMIN_LIVE === "1";
const OUT = join(import.meta.dirname, "../../.live-capture");
const DELAY_MS = 2000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!LIVE)("live Garmin API", () => {
  const exchanges: Exchange[] = [];
  const client = new GarminClient({
    storagePath: process.env.GARMIN_TOKEN_PATH ?? "~/.garminconnect",
  });
  let ctx: LiveContext;
  let stopped: string | null = null;

  beforeAll(async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const resp = await realFetch(input, init);
      const url = String(input);
      if (url.includes("connectapi.")) {
        const text = await resp.clone().text();
        let body: unknown = text || null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {}
        exchanges.push({ method: init?.method ?? "GET", url, status: resp.status, body });
      }
      return resp;
    };
    try {
      await client.resume();
    } catch {
      throw new Error(
        "No saved Garmin tokens. Sign in through the app first; this test never signs in.",
      );
    }
    ctx = makeContext();
    const acts = (await client.getActivities(0, 1)) as { activityId: number }[];
    ctx.activityId = acts[0]?.activityId;
    await sleep(DELAY_MS);
    const wks = (await client.getWorkouts(0, 1)) as { workoutId: number }[];
    ctx.workoutId = wks[0]?.workoutId;
    await mkdir(OUT, { recursive: true });
    await writeFile(join(OUT, "_summary.json"), JSON.stringify({ ctx }, null, 2));
  }, 30_000);

  for (const ep of endpoints) {
    it(
      ep.name,
      async ({ skip }) => {
        if (stopped) skip(`stopped after ${stopped}`);
        if (ep.needs && !ctx[ep.needs]) skip(`no ${ep.needs} on this account`);
        await sleep(DELAY_MS);
        const before = exchanges.length;
        let result: unknown;
        try {
          result = await ep.call(client, ctx);
        } catch (err) {
          if (
            err instanceof GarminRateLimitError ||
            (err instanceof GarminApiError && err.status === 403)
          ) {
            stopped = `${ep.name} (${(err as Error).message})`;
          }
          throw err;
        } finally {
          await writeFile(
            join(OUT, `${ep.name}.json`),
            JSON.stringify(exchanges.slice(before), null, 2),
          );
        }
        const schema = responseSchemas[ep.name];
        expect(schema, `no schema for ${ep.name}`).toBeDefined();
        schema!.parse(result ?? null);
      },
      30_000,
    );
  }
});
