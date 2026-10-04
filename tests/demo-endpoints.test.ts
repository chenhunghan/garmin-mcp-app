/**
 * Demo mode must look exactly like Garmin to the client: every read endpoint,
 * called through a real GarminClient against the demo handlers, returns a
 * response that passes the schema generated from real Garmin responses.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GarminClient } from "garmin-connect";
import { endpoints, makeContext } from "../packages/garmin-connect/tests/live/endpoints.ts";
import { responseSchemas } from "../packages/garmin-connect/tests/schemas.ts";
import { fakeTokenStorage } from "../packages/garmin-connect/tests/helpers/msw.ts";
import { createDemoServer } from "../src/demo/server.ts";
import { getWorld } from "../src/demo/world.ts";

const server = createDemoServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

const world = getWorld();
const ctx = {
  ...makeContext(),
  activityId: world.runs.at(-1)!.plan.id,
  workoutId: world.workouts[0]!.workoutId,
};

async function client() {
  const c = new GarminClient({ storage: fakeTokenStorage() });
  await c.resume();
  return c;
}

const withSchema = endpoints.filter((ep) => responseSchemas[ep.name]);
const withoutSchema = endpoints.filter((ep) => !responseSchemas[ep.name]).map((ep) => ep.name);

describe("demo mode answers every endpoint like Garmin", () => {
  it("every endpoint has a response schema", () => {
    // Endpoints without a schema can't be checked here; list them if any appear
    expect(withoutSchema).toEqual([]);
  });

  for (const ep of withSchema) {
    it(ep.name, async () => {
      const result = await ep.call(await client(), ctx);
      const parsed = responseSchemas[ep.name]!.safeParse(result ?? null);
      expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 5))).toBe(true);
    });
  }

  it("has data, not just the right shape", async () => {
    const c = await client();
    const activities = (await c.getActivities(0, 20)) as { activityName: string }[];
    expect(activities).toHaveLength(20);
    const sleep = (await c.getSleepData(world.today)) as {
      dailySleepDTO: { sleepScores: { overall: { value: number } } };
    };
    expect(sleep.dailySleepDTO.sleepScores.overall.value).toBeGreaterThan(0);
    const hrv = (await c.getHrvData(ctx.monthAgo, ctx.date)) as { hrvSummaries: unknown[] };
    expect(hrv.hrvSummaries.length).toBeGreaterThan(25);
  });

  it("answers unknown Garmin paths with 404 and never reaches Garmin", async () => {
    const c = await client();
    await expect(c.connectapi("/no-such-service/thing")).rejects.toMatchObject({ status: 404 });
    await expect(fetch("https://sso.garmin.com/sso/signin")).rejects.toThrow();
    // Signing in would go to sso.garmin.com: blocked
    await expect(c.login("demo@example.com", "x")).rejects.toBeInstanceOf(Error);
  });

  it("rejects 28-day-limited ranges beyond 28 days, like Garmin", async () => {
    const c = await client();
    await expect(c.getSleepStats(ctx.monthAgo, ctx.date)).rejects.toMatchObject({ status: 400 });
  });

  it("keeps workout writes in memory", async () => {
    const c = await client();
    const created = (await c.createWorkout({
      workoutName: "Demo strides",
      sportType: { sportTypeId: 1, sportTypeKey: "running" },
      workoutSegments: [],
    })) as { workoutId: number };
    const scheduled = (await c.scheduleWorkout(created.workoutId, world.today)) as {
      workoutScheduleId: number;
    };
    expect(scheduled.workoutScheduleId).toBeGreaterThan(0);
    const list = (await c.getWorkouts(0, 50)) as { workoutId: number }[];
    expect(list.map((x) => x.workoutId)).toContain(created.workoutId);
    await c.deleteWorkout(created.workoutId);
    const after = (await c.getWorkouts(0, 50)) as { workoutId: number }[];
    expect(after.map((x) => x.workoutId)).not.toContain(created.workoutId);
  });
});
