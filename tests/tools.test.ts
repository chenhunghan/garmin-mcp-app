/**
 * Calls every MCP tool through a real MCP client, with Garmin answered by the
 * recorded fixtures (MSW). IDs are passed as numbers, the way Claude passes
 * them back from Garmin responses.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  fakeTokenStorage,
  garminMockServer,
  loadContext,
} from "../packages/garmin-connect/tests/helpers/msw.ts";
import { createServer } from "../src/server.ts";
import type { TrainingWeek } from "../src/tools/week.ts";

const ctx = loadContext();
const [year, month] = ctx.date.split("-").map(Number);

/** Arguments per tool, matching the recorded requests. */
const toolArgs: Record<string, Record<string, unknown>> = {
  "garmin-check-auth": {},
  "get-steps": { date: ctx.weekAgo, endDate: ctx.date },
  "get-heart-rates": { date: ctx.date },
  "get-sleep": { date: ctx.date },
  "get-stress": { date: ctx.date },
  "get-activities": { start: 0, limit: 20 },
  "get-training-readiness": { date: ctx.date },
  "get-training-status": { date: ctx.date },
  "get-hrv": { startDate: ctx.twoWeeksAgo, endDate: ctx.date },
  "get-body-battery": { startDate: ctx.weekAgo, endDate: ctx.date },
  "get-activity-details": { activityId: ctx.activityId },
  "get-activity-splits": { activityId: ctx.activityId },
  "get-activity-hr-zones": { activityId: ctx.activityId },
  "get-vo2-max": { startDate: ctx.monthAgo, endDate: ctx.date },
  "get-race-predictions": {},
  "get-user-settings": {},
  "get-training-context": { date: ctx.date },
  "get-daily-briefing": { date: ctx.date },
  "list-workouts": { start: 0, limit: 5 },
  "get-workout": { workoutId: ctx.workoutId },
  "get-daily-summary": { date: ctx.date },
  "get-respiration": { date: ctx.date },
  "get-spo2": { date: ctx.date },
  "get-intensity-minutes": { date: ctx.date },
  "get-floors": { date: ctx.date },
  "get-resting-heart-rate": { startDate: ctx.weekAgo, endDate: ctx.date },
  "get-body-battery-events": { date: ctx.date },
  "get-hydration": { date: ctx.date },
  "get-body-composition": { date: ctx.date },
  "get-weigh-ins": { startDate: ctx.monthAgo, endDate: ctx.date },
  "get-weekly-steps": { endDate: ctx.date, weeks: 4 },
  "get-weekly-stress": { endDate: ctx.date, weeks: 4 },
  "get-weekly-intensity-minutes": { startDate: ctx.monthAgo, endDate: ctx.date },
  "get-endurance-score": { startDate: ctx.monthAgo, endDate: ctx.date },
  "get-hill-score": { startDate: ctx.monthAgo, endDate: ctx.date },
  "get-running-tolerance": { startDate: ctx.monthAgo, endDate: ctx.date },
  "get-lactate-threshold": {},
  "get-cycling-ftp": {},
  "get-heart-rate-zones": {},
  "get-fitness-age": { date: ctx.date },
  "get-personal-records": {},
  "get-progress-summary": { startDate: ctx.monthAgo, endDate: ctx.date },
  "get-activities-by-date": { startDate: ctx.weekAgo, endDate: ctx.date },
  "get-activity-typed-splits": { activityId: ctx.activityId },
  "get-activity-weather": { activityId: ctx.activityId },
  "get-activity-exercise-sets": { activityId: ctx.activityId },
  "get-activity-chart-data": { activityId: ctx.activityId, maxPoints: 100 },
  "get-activity-gear": { activityId: ctx.activityId },
  "get-activity-types": {},
  "get-devices": {},
  "get-primary-training-device": {},
  "get-last-used-device": {},
  "get-gear": {},
  "get-goals": {},
  "get-training-plans": {},
  "get-calendar": { year, month },
  // Synthetic fixtures: week-calendar.json, week-workouts.json
  "show-training-week": { startDate: ctx.date },
  "create-structured-workout": {
    name: "Test intervals",
    sport: "running",
    scheduleDate: "2026-10-05",
    steps: [
      { type: "warmup", duration: { seconds: 600 }, target: { hrZone: 2 } },
      {
        repeat: 4,
        steps: [
          { type: "run", duration: { meters: 1000 }, target: { pace: { fast: "4:30", slow: "4:40" } } },
          { type: "recovery", duration: { seconds: 90 } },
        ],
      },
      { type: "cooldown", duration: "lap.button" },
    ],
  },
};

/** Tools not exercised here, and why. */
const untested: Record<string, string> = {
  "garmin-get-login-key": "covered by the encrypted login round trip",
  "garmin-login": "needs SSO; covered by sso.test.ts",
  "garmin-submit-mfa": "needs SSO; covered by sso.test.ts",
  "garmin-logout": "clears tokens",
  "create-workout": "write operation, no recording",
  "update-workout": "write operation, no recording",
  "delete-workout": "write operation, no recording",
  "schedule-workout": "write operation, no recording",
};

const mock = garminMockServer();
let client: Client;

beforeAll(async () => {
  // Fake saved tokens, so the server's client resumes without signing in
  const dir = mkdtempSync(join(tmpdir(), "garmin-tokens-"));
  const tokens = await fakeTokenStorage().load();
  writeFileSync(join(dir, "oauth1_token.json"), JSON.stringify(tokens!.oauth1));
  writeFileSync(join(dir, "oauth2_token.json"), JSON.stringify(tokens!.oauth2));
  process.env.GARMIN_TOKEN_PATH = dir;

  mock.listen({ onUnhandledRequest: "error" });
  const server = createServer("test");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
});

afterAll(() => mock.close());

describe("MCP tools", () => {
  it("every tool is tested or explicitly excluded", async () => {
    const { tools } = await client.listTools();
    const missing = tools
      .map((t) => t.name)
      .filter((name) => !(name in toolArgs) && !(name in untested));
    expect(missing).toEqual([]);
  });

  for (const [name, args] of Object.entries(toolArgs)) {
    it(name, async () => {
      const result = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { type: string; text: string }[];
      };
      const text = result.content[0]?.text ?? "";
      expect(result.isError, text).toBeFalsy();
      expect(() => JSON.parse(text)).not.toThrow();
    });
  }

  it("get-training-context gets every sub-request from the recordings", async () => {
    const result = (await client.callTool({
      name: "get-training-context",
      arguments: { date: ctx.date },
    })) as { content: { text: string }[] };
    const data = JSON.parse(result.content[0]!.text);
    // allSettled swallows failures as null, so check each section is present
    for (const [k, v] of Object.entries(data)) {
      expect(v, `training context section ${k}`).not.toBeNull();
    }
  });

  it("get-daily-briefing gets every source from the recordings", async () => {
    const result = (await client.callTool({
      name: "get-daily-briefing",
      arguments: { date: ctx.date },
    })) as {
      content: { text: string }[];
      structuredContent?: { view?: string; args?: Record<string, unknown> };
    };
    expect(result.structuredContent).toEqual({ view: "briefing", args: { date: ctx.date } });
    const data = JSON.parse(result.content[0]!.text);
    // allSettled turns failed requests into a "failed" entry, so none should be listed
    expect(data.failed).toEqual([]);
    expect(data.date).toBe(ctx.date);
    for (const [k, m] of Object.entries(data.metrics as Record<string, { value: unknown }>)) {
      expect(m.value, `briefing metric ${k}`).not.toBeNull();
    }
    expect(data.lastActivity).not.toBeNull();
    expect(data.trainingStatus).not.toBeNull();
  });

  it("every tool that opens the app UI routes to a view (no empty panels)", async () => {
    const { tools } = await client.listTools();
    const authTools = new Set(["garmin-check-auth", "garmin-logout"]);
    const withUi = tools.filter(
      (t) =>
        (t._meta as { ui?: { resourceUri?: string; visibility?: string[] } } | undefined)?.ui
          ?.resourceUri &&
        // app-only tools never open a panel from the model side
        !(t._meta as { ui?: { visibility?: string[] } }).ui?.visibility?.every((v) => v === "app"),
    );
    const noView: string[] = [];
    for (const t of withUi) {
      if (authTools.has(t.name) || !(t.name in toolArgs)) continue;
      const result = (await client.callTool({ name: t.name, arguments: toolArgs[t.name] })) as {
        structuredContent?: { view?: string };
      };
      if (!result.structuredContent?.view) noView.push(t.name);
    }
    expect(noView).toEqual([]);
  });

  it("echoes the call's arguments so the chart shows what was asked for", async () => {
    const splits = (await client.callTool({
      name: "get-activity-splits",
      arguments: { activityId: ctx.activityId },
    })) as { structuredContent?: { view?: string; args?: Record<string, unknown> } };
    expect(splits.structuredContent).toEqual({
      view: "splits",
      args: { activityId: ctx.activityId },
    });

    const hrv = (await client.callTool({
      name: "get-hrv",
      arguments: { startDate: ctx.twoWeeksAgo, endDate: ctx.date },
    })) as { structuredContent?: { view?: string; args?: Record<string, unknown> } };
    expect(hrv.structuredContent).toEqual({ view: "training", args: { date: ctx.date } });

    const workout = (await client.callTool({
      name: "get-workout",
      arguments: { workoutId: ctx.workoutId },
    })) as { structuredContent?: { view?: string; args?: Record<string, unknown> } };
    expect(workout.structuredContent).toEqual({
      view: "workouts",
      args: { workoutId: ctx.workoutId },
    });
  });

  it("list-workouts finds a workout by name", async () => {
    const all = (await client.callTool({ name: "list-workouts", arguments: { limit: 5 } })) as {
      content: { text: string }[];
    };
    const [first] = JSON.parse(all.content[0]!.text) as { workoutName: string }[];
    const byName = (await client.callTool({
      name: "list-workouts",
      arguments: { name: first!.workoutName.slice(0, 3).toUpperCase(), limit: 5 },
    })) as { content: { text: string }[] };
    expect(JSON.parse(byName.content[0]!.text)).toEqual([first]);
    const none = (await client.callTool({
      name: "list-workouts",
      arguments: { name: "no such workout", limit: 5 },
    })) as { content: { text: string }[] };
    expect(JSON.parse(none.content[0]!.text)).toEqual([]);
  });

  it("show-training-week groups the calendar into Monday-Sunday with a summary", async () => {
    const result = (await client.callTool({
      name: "show-training-week",
      arguments: { startDate: ctx.date }, // a Saturday; the week spans September/October
    })) as {
      content: { text: string }[];
      structuredContent?: { view?: string; args?: Record<string, unknown> };
    };
    expect(result.structuredContent).toEqual({ view: "week", args: { startDate: "2026-09-28" } });
    const week = JSON.parse(result.content[0]!.text) as TrainingWeek;
    expect(week.startDate).toBe("2026-09-28");
    expect(week.endDate).toBe("2026-10-04");
    expect(week.days.map((d) => d.weekday)).toEqual([
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ]);

    const [mon, tue, wed] = week.days;
    // Planned workout with details from get-workout, done by the matching activity
    expect(mon!.planned).toHaveLength(1);
    expect(mon!.planned[0]).toMatchObject({
      workoutId: 2000000101,
      name: "Easy 45 min",
      sport: "running",
      estimatedDurationSecs: 2700,
      completed: true,
    });
    expect(mon!.planned[0]!.steps[0]).toMatchObject({ zoneNumber: 2, endConditionValue: 2700 });
    // Calendar units: ms → s, cm → m
    expect(mon!.activities).toEqual([
      expect.objectContaining({ activityId: 1000000101, durationSecs: 2700, distanceMeters: 8000 }),
    ]);
    // The same activity in both months' calendars counts once
    expect(tue!.activities.filter((a) => a.activityId === 1000000005)).toHaveLength(1);
    expect(tue!.other).toEqual([{ itemType: "event", title: "Test 10K" }]);
    expect(wed!.planned[0]).toMatchObject({ workoutId: Number(ctx.workoutId), completed: true });
    // Sunday before the week is left out
    expect(week.days.flatMap((d) => d.activities.map((a) => a.activityId))).not.toContain(
      1000000102,
    );

    expect(week.summary).toMatchObject({ plannedCount: 2, plannedCompletedCount: 2 });
    expect(week.summary.activityCount).toBe(week.days.flatMap((d) => d.activities).length);
    expect(week.summary.plannedDurationSecs).toBeGreaterThanOrEqual(2700);
  });

  it("create-structured-workout builds, creates and schedules the workout", async () => {
    const posted: unknown[] = [];
    const onRequest = async ({ request }: { request: Request }) => {
      if (request.method === "POST") posted.push(await request.clone().json());
    };
    mock.events.on("request:start", onRequest);
    try {
      const result = (await client.callTool({
        name: "create-structured-workout",
        arguments: toolArgs["create-structured-workout"],
      })) as {
        isError?: boolean;
        content: { text: string }[];
        structuredContent?: { view?: string; args?: Record<string, unknown> };
      };
      expect(result.isError, result.content[0]?.text).toBeFalsy();
      expect(result.structuredContent).toEqual({
        view: "workouts",
        args: { action: "scheduled", date: "2026-10-05", workoutId: 2000000201 },
      });
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({
        workoutId: 2000000201,
        scheduled: { date: "2026-10-05", workoutScheduleId: 3000000201 },
      });
    } finally {
      mock.events.removeListener("request:start", onRequest);
    }
    const [workout, schedule] = posted as [
      { workoutName: string; workoutSegments: { workoutSteps: { type: string }[] }[] },
      unknown,
    ];
    expect(workout.workoutName).toBe("Test intervals");
    expect(workout.workoutSegments[0]!.workoutSteps.map((s) => s.type)).toEqual([
      "ExecutableStepDTO",
      "RepeatGroupDTO",
      "ExecutableStepDTO",
    ]);
    expect(schedule).toEqual({ date: "2026-10-05" });
  });

  it("create-structured-workout rejects an invalid spec without calling Garmin", async () => {
    const result = (await client.callTool({
      name: "create-structured-workout",
      arguments: {
        name: "Bad",
        sport: "running",
        steps: [{ type: "run", target: { pace: { fast: "4:30", slow: "4:60" } } }],
      },
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it("data-only tools don't open the app UI", async () => {
    const { tools } = await client.listTools();
    const settings = tools.find((t) => t.name === "get-user-settings");
    expect((settings?._meta as { ui?: unknown } | undefined)?.ui).toBeUndefined();
  });

  it("rejects nothing for numeric IDs (regression: #19)", async () => {
    const result = await client.callTool({
      name: "get-activity-splits",
      arguments: { activityId: Number(ctx.activityId) },
    });
    expect(result.isError).toBeFalsy();
  });
});
