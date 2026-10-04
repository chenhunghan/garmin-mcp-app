/**
 * Turn raw captures in .live-capture/ into fixtures in tests/fixtures/: scrub
 * identity, then replace every value with synthetic data (see synthesize.ts).
 * Makes no network requests. Run after a live capture: npm run fixtures:update
 */
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assertClean, collectIdentity, sanitizeExchange, type Exchange } from "./sanitize.ts";
import { makeSynthesizer } from "./synthesize.ts";

const RAW = join(import.meta.dirname, "../../.live-capture");
const OUT = join(import.meta.dirname, "../fixtures");

const raw: Record<string, Exchange[]> = {};
for (const f of await readdir(RAW)) {
  if (f.endsWith(".json") && !f.startsWith("_")) {
    raw[f.slice(0, -5)] = JSON.parse(await readFile(join(RAW, f), "utf-8"));
  }
}
const identity = collectIdentity(raw);
const { ctx } = JSON.parse(await readFile(join(RAW, "_summary.json"), "utf-8"));

await mkdir(OUT, { recursive: true });
// One synthesizer for all fixtures, so a field is scaled the same everywhere.
// The sanitizer's fake IDs are kept: request URLs depend on them.
const fakeIds = new Set([...identity.values()].filter((v) => /^\d+$/.test(v)).map(Number));
const synthesize = makeSynthesizer(fakeIds, {
  from: Date.parse(`${ctx.monthAgo}T00:00:00Z`),
  to: Date.parse(`${ctx.date}T23:59:59Z`),
});
for (const [name, exchanges] of Object.entries(raw)) {
  const clean = exchanges
    .map((e) => sanitizeExchange(e, identity))
    .map((e) => ({ ...e, body: synthesize(e.body, name) }));
  assertClean(name, clean, identity);
  await writeFile(join(OUT, `${name}.json`), JSON.stringify(clean, null, 2) + "\n");
}
const fakeCtx = {
  ...ctx,
  activityId: ctx.activityId && Number(identity.get(String(ctx.activityId))),
  workoutId: ctx.workoutId && Number(identity.get(String(ctx.workoutId))),
};
assertClean("_context", fakeCtx, identity);
await writeFile(join(OUT, "_context.json"), JSON.stringify(fakeCtx, null, 2) + "\n");
console.log(`wrote ${Object.keys(raw).length} fixtures`);
