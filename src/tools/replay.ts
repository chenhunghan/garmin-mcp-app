import type { McpServer } from "@modelcontextprotocol/server";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import type { GarminClient } from "garmin-connect";
import type { ServerDeps } from "../deps.js";
import { buildRunMap } from "../geo/run-map.js";
import { authed } from "./data.js";
import {
  buildReplay,
  parseActivity,
  parseWeather,
  replaySummary,
  type ReplayData,
} from "../replay-model.js";

const activityIdInput = z
  .union([z.string(), z.number()])
  .optional()
  .describe("Garmin activity ID (default: the most recent run)");

/** Time series resolution: ~1 sample/second for an hour-long run. */
const DEFAULT_POINTS = 3600;

/**
 * Claude opens the replay, then the view asks for the time series: keep the
 * Garmin responses briefly so the view doesn't repeat Claude's requests.
 */
const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

function cached<T>(key: string, fetch: () => Promise<T>): Promise<T> {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at > CACHE_MS) cache.delete(k);
  const hit = cache.get(key);
  if (hit) return hit.value as Promise<T>;
  const value = fetch();
  cache.set(key, { at: now, value });
  // Don't keep failures: the next call retries
  value.catch(() => cache.delete(key));
  return value;
}

/** The requested activity, else the most recent run (else the most recent activity). */
async function resolveActivityId(
  client: GarminClient,
  activityId?: string | number,
): Promise<string | number> {
  if (activityId !== undefined && activityId !== "") return activityId;
  const list = (await cached("activities", () => client.getActivities(0, 20))) as Array<{
    activityId?: number;
    activityType?: { typeKey?: string };
  }> | null;
  const runs = (list ?? []).filter((a) => a.activityType?.typeKey?.includes("running"));
  const pick = runs[0] ?? list?.[0];
  if (!pick?.activityId) throw new Error("No activities found");
  return pick.activityId;
}

const details = (client: GarminClient, id: string | number) =>
  cached(`details:${id}`, () => client.getActivityDetails(id));
const weather = (client: GarminClient, id: string | number) =>
  cached(`weather:${id}`, () => client.getActivityWeather(id));

function loadReplay(
  client: GarminClient,
  activityId: string | number,
  maxPoints: number,
): Promise<ReplayData> {
  return cached(`replay:${activityId}:${maxPoints}`, () =>
    fetchReplay(client, activityId, maxPoints),
  );
}

async function fetchReplay(
  client: GarminClient,
  activityId: string | number,
  maxPoints: number,
): Promise<ReplayData> {
  const [d, chart, splits, w, zones, settings] = await Promise.allSettled([
    details(client, activityId),
    client.getActivityChartDetails(activityId, maxPoints),
    client.getActivitySplits(activityId),
    weather(client, activityId),
    client.getActivityHrZones(activityId),
    // Sex, height and weight shape the 3D runner
    cached("user-settings", () => client.getUserSettings()),
  ]);
  // The time series is the replay; everything else is optional context
  if (chart.status === "rejected") throw chart.reason;
  const val = (r: PromiseSettledResult<unknown>) => (r.status === "fulfilled" ? r.value : null);
  return buildReplay({
    activityId,
    details: val(d),
    chart: chart.value,
    splits: val(splits),
    weather: val(w),
    hrZones: val(zones),
    userSettings: val(settings),
  });
}

export function registerReplayTools(server: McpServer, resourceUri: string, deps: ServerDeps) {
  const withAuth = authed(deps);

  registerAppTool(
    server,
    "show-run-replay",
    {
      title: "Show Run Replay",
      description:
        "Open an interactive 3D replay of a run: a runner follows the GPS track over the terrain while pace, heart rate (zones), cadence, elevation/grade, power, running dynamics and weather play back over time, with pause, fast-forward and scrubbing. Use when the user wants to replay, relive, watch or review a run as a whole. Returns a short summary of the run; the view renders the time series.",
      inputSchema: z.object({ activityId: activityIdInput }),
      _meta: { ui: { resourceUri } },
    },
    async ({ activityId }) =>
      withAuth(
        async () => {
          const client = deps.getClient();
          const id = await resolveActivityId(client, activityId);
          const [d, w] = await Promise.allSettled([details(client, id), weather(client, id)]);
          const raw = d.status === "fulfilled" ? (d.value as Record<string, unknown> | null) : null;
          const hasPolyline = (raw?.metadataDTO as { hasPolyline?: boolean } | undefined)
            ?.hasPolyline;
          return replaySummary(
            parseActivity(id, raw),
            parseWeather(w.status === "fulfilled" ? w.value : null),
            typeof hasPolyline === "boolean" ? hasPolyline : null,
          );
        },
        "replay",
        { activityId },
      ),
  );

  registerAppTool(
    server,
    "garmin-get-run-replay",
    {
      title: "Get Run Replay Data",
      description:
        "Time series of an activity for the 3D replay view (GPS, elevation, HR, cadence, speed, power, running dynamics), plus laps, weather and HR zones",
      inputSchema: z.object({
        activityId: activityIdInput,
        maxPoints: z.number().int().min(100).max(10_000).optional(),
      }),
      _meta: { ui: { resourceUri, visibility: ["app"] } },
    },
    async ({ activityId, maxPoints }) =>
      withAuth(async () => {
        const client = deps.getClient();
        return loadReplay(
          client,
          await resolveActivityId(client, activityId),
          maxPoints ?? DEFAULT_POINTS,
        );
      }),
  );

  registerAppTool(
    server,
    "garmin-run-map-settings",
    {
      title: "Run Replay Map Settings",
      description:
        "Read or change whether the run replay fetches real elevation (AWS Terrain Tiles) and map data (OpenStreetMap) for the area around a run",
      inputSchema: z.object({ realMap: z.boolean().optional() }),
      _meta: { ui: { resourceUri, visibility: ["app"] } },
    },
    async ({ realMap }) => {
      const settings =
        realMap === undefined
          ? await deps.settings.read()
          : await deps.settings.update({ realMap });
      return { content: [{ type: "text" as const, text: JSON.stringify(settings) }] };
    },
  );

  registerAppTool(
    server,
    "garmin-get-run-map",
    {
      title: "Get Run Map",
      description:
        "Real elevation and OpenStreetMap features (roads, land cover, water, buildings) around an activity's GPS track, for the 3D replay. Only when the real map setting is on.",
      inputSchema: z.object({ activityId: activityIdInput }),
      _meta: { ui: { resourceUri, visibility: ["app"] } },
    },
    async ({ activityId }) =>
      withAuth(async () => {
        if (!(await deps.settings.read()).realMap) return { enabled: false };
        const client = deps.getClient();
        const replay = await loadReplay(
          client,
          await resolveActivityId(client, activityId),
          DEFAULT_POINTS,
        );
        const { lat, lon } = replay.channels;
        const map =
          lat && lon
            ? await cached(`map:${replay.activity.id}`, () => buildRunMap(lat, lon, deps.geoFetch))
            : null;
        return map ? { enabled: true, ...map } : { enabled: true, unavailable: "no GPS track" };
      }),
  );
  registerAppTool(
    server,
    "garmin-get-replay-asset",
    {
      title: "Get Replay Asset",
      description:
        "One file of the 3D replay's asset pack (scanned materials, sky light, models, running motion; CC0), base64-encoded. Served from a local cache, downloaded once from the app's GitHub release.",
      inputSchema: z.object({ file: z.string().max(200) }),
      _meta: { ui: { resourceUri, visibility: ["app"] } },
    },
    async ({ file }) => {
      try {
        const buf = await deps.readAsset(file);
        const data = Buffer.from(buf).toString("base64");
        return { content: [{ type: "text" as const, text: JSON.stringify({ file, data }) }] };
      } catch (e) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
        };
      }
    },
  );
}
