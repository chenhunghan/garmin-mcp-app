/**
 * Every MCP tool that opens a view works in demo mode (the data behind README
 * screenshots), with Garmin answered by the demo world.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDemoServer, writeDemoTokens } from "../src/demo/server.ts";
import { getWorld } from "../src/demo/world.ts";
import { addDays } from "../src/demo/time.ts";
import { createServer } from "../src/server.ts";
import type { TrainingWeek } from "../src/tools/week.ts";

const world = getWorld();
const today = world.today;
const latestRun = world.runs.at(-1)!;

/** Tools that change Garmin data or sign in: not part of the views. */
const NOT_VIEWS = new Set([
  "garmin-check-auth",
  "garmin-logout",
  "create-workout",
  "create-structured-workout",
  "update-workout",
  "delete-workout",
  "schedule-workout",
]);

const args: Record<string, Record<string, unknown>> = {
  "get-steps": { date: addDays(today, -6), endDate: today },
  "get-heart-rates": { date: today },
  "get-sleep": { date: addDays(today, -6), endDate: today },
  "get-stress": { date: today },
  "get-activities": { start: 0, limit: 20 },
  "get-training-readiness": { date: today },
  "get-training-status": { date: today },
  "get-hrv": { startDate: addDays(today, -13), endDate: today },
  "get-body-battery": { startDate: addDays(today, -6), endDate: today },
  "get-activity-details": { activityId: latestRun.plan.id },
  "get-activity-splits": { activityId: latestRun.plan.id },
  "get-activity-hr-zones": { activityId: latestRun.plan.id },
  "get-vo2-max": { startDate: addDays(today, -29), endDate: today },
  "get-race-predictions": {},
  "get-training-context": { date: today },
  "get-daily-briefing": {},
  "list-workouts": {},
  "get-workout": { workoutId: world.workouts[0]!.workoutId },
  "show-training-week": {},
  "show-performance-dashboard": {},
};

let client: Client;
const mock = createDemoServer();

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "garmin-demo-test-"));
  writeDemoTokens(dir);
  process.env.GARMIN_TOKEN_PATH = dir;
  mock.listen({ onUnhandledRequest: "error" });
  const server = createServer("test");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "demo-test", version: "0" });
  await client.connect(clientTransport);
});

afterAll(() => mock.close());

type Result = {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: { view?: string; args?: Record<string, unknown> };
};

async function call(name: string, a: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: a })) as Result;
  const text = result.content[0]?.text ?? "";
  expect(result.isError, `${name}: ${text.slice(0, 300)}`).toBeFalsy();
  return { result, data: JSON.parse(text) };
}

describe("demo mode: tools with a view", () => {
  it("every tool that opens a view has demo arguments", async () => {
    const { tools } = await client.listTools();
    const views = tools
      .filter((t) => (t._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri)
      .filter(
        (t) =>
          !(t._meta as { ui?: { visibility?: string[] } }).ui?.visibility?.every(
            (v) => v === "app",
          ),
      )
      .map((t) => t.name)
      .filter((n) => !NOT_VIEWS.has(n));
    expect(views.filter((n) => !(n in args))).toEqual([]);
  });

  for (const [name, a] of Object.entries(args)) {
    it(name, async () => {
      const { result } = await call(name, a);
      expect(result.structuredContent?.view, name).toBeTruthy();
    });
  }

  it("get-daily-briefing has every metric (no gaps on screen)", async () => {
    const { data } = await call("get-daily-briefing");
    expect(data.failed).toEqual([]);
    for (const [k, m] of Object.entries(data.metrics as Record<string, { value: unknown }>)) {
      expect(m.value, `briefing metric ${k}`).not.toBeNull();
    }
    expect(data.metrics.trainingReadiness.value).toBe(72);
    expect(data.metrics.sleepScore.value).toBe(81);
    expect(data.lastActivity.daysAgo).toBe(1);
    expect(data.trainingStatus.label).toBe("Productive");
    expect(data.metrics.hrv.status.key).toBe("BALANCED");
  });

  for (const range of ["12w", "52w"]) {
    it(`show-performance-dashboard ${range}`, async () => {
      const { data } = await call("show-performance-dashboard", {
        metrics: ["restingHR", "hrv", "vo2max", "sleepScore"],
        range,
      });
      for (const m of data.metrics) {
        expect(m.error, m.metric).toBeUndefined();
        // VO₂ max only updates on run days (~50 in 12 weeks, depending on where today
        // falls in the training cycle); the other metrics are daily
        const min = range === "52w" ? 45 : m.metric === "vo2max" ? 40 : 50;
        expect(m.points.length, m.metric).toBeGreaterThan(min);
      }
      const [rhr, hrv, vo2] = data.metrics;
      if (range === "52w") {
        expect(rhr.summary.trend).toBe("down");
        expect(hrv.summary.trend).toBe("up");
        expect(vo2.summary.trend).toBe("up");
      }
    });
  }

  it("show-performance-dashboard has every metric over a year", async () => {
    const { data } = await call("show-performance-dashboard", {
      metrics: ["steps", "stress", "bodyBattery", "intensityMinutes"],
      range: "52w",
    });
    for (const m of data.metrics) expect(m.points.length, m.metric).toBeGreaterThan(40);
    const { data: more } = await call("show-performance-dashboard", {
      metrics: ["trainingLoad", "weight", "sleepDuration"],
      range: "12w",
    });
    for (const m of more.metrics) expect(m.points.length, m.metric).toBeGreaterThan(5);
  });

  it("show-training-week has done and planned workouts", async () => {
    const { data } = await call("show-training-week");
    const week = data as TrainingWeek;
    const planned = week.days.flatMap((d) => d.planned);
    expect(planned.length).toBeGreaterThanOrEqual(4);
    expect(planned.every((p) => p.steps.length > 0)).toBe(true);
    const past = week.days.filter((d) => d.date < today);
    const future = week.days.filter((d) => d.date >= today);
    expect(past.flatMap((d) => d.planned).every((p) => p.completed)).toBe(true);
    expect(future.flatMap((d) => d.activities)).toEqual([]);
  });

  it("splits for the latest run (one lap) fall back to per-km splits that add up", async () => {
    const { data } = await call("get-activity-splits", { activityId: latestRun.plan.id });
    expect(data.lapDTOs).toHaveLength(1);
    const km = data.kmSplits as { distance: number; duration: number; averageSpeed: number }[];
    expect(km.length).toBeGreaterThanOrEqual(5);
    const total = km.reduce((s, k) => s + k.distance, 0);
    expect(Math.abs(total - latestRun.summary.distance)).toBeLessThan(50);
    const paces = km.filter((k) => k.distance >= 990).map((k) => 1000 / k.averageSpeed);
    // Negative split: the last full km is clearly faster than the first
    expect(paces[0]! - paces.at(-1)!).toBeGreaterThan(20);
  });

  it("older runs have recorded laps", async () => {
    const lapped = world.runs.slice(-12, -1).find((r) => r.summary.lapCount > 3)!;
    const { data } = await call("get-activity-splits", { activityId: lapped.plan.id });
    expect(data.lapDTOs.length).toBeGreaterThan(3);
    expect(data.kmSplits).toBeUndefined();
  });
});

describe("ChatGPT (openai/mcp-extensions) metadata", () => {
  it("entrypoint tools have a title and an icon, accept {} and open a view", async () => {
    const { tools } = await client.listTools();
    const entrypoints = tools.filter(
      (t) =>
        (t._meta as Record<string, { entrypoints?: unknown[] }> | undefined)?.["openai/ui"]
          ?.entrypoints,
    );
    expect(entrypoints.map((t) => t.name).sort()).toEqual([
      "get-daily-briefing",
      "show-performance-dashboard",
      "show-training-week",
    ]);
    for (const t of entrypoints) {
      expect(t.title, t.name).toBeTruthy();
      expect(t.icons?.[0]?.mimeType, t.name).toBe("image/svg+xml");
      expect(t.inputSchema.required ?? [], t.name).toEqual([]);
      const { result } = await call(t.name, {});
      expect(result.structuredContent?.view, t.name).toBeTruthy();
    }
  });

  it("the UI is self-contained and declares its display modes", async () => {
    const { contents } = await client.readResource({ uri: "ui://garmin-mcp/app.html" });
    const meta = contents[0]!._meta as Record<string, Record<string, unknown>>;
    expect(meta["openai/ui"]).toEqual({ availableDisplayModes: ["inline", "fullscreen"] });
    expect(meta.ui).toEqual({ csp: { resourceDomains: [], connectDomains: [] } });
  });
});
