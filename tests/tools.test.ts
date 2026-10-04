/**
 * Calls every MCP tool through a real MCP client, with Garmin answered by the
 * recorded fixtures (MSW). IDs are passed as numbers, the way Claude passes
 * them back from Garmin responses.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  fakeTokenStorage,
  garminMockServer,
  loadContext,
} from "../packages/garmin-connect/tests/helpers/msw.ts";
import { createServer } from "../src/server.ts";

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
