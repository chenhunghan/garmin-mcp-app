import type { McpServer } from "@modelcontextprotocol/server";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { GarminAuthError, GarminTokenExpiredError } from "garmin-connect";
import { getClient } from "../garmin.js";
import { withAuth } from "./data.js";
import {
  buildBriefing,
  shiftDate,
  type Briefing,
  type BriefingSources,
} from "../briefing-model.js";

/** Local calendar day (YYYY-MM-DD) — toISOString() would print the UTC day. */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Six requests in parallel. The daily summary covers steps, resting HR (with
 * Garmin's 7-day average), stress and body battery in one call; HRV over 14
 * nights gives the baseline band and a trend; the 20 latest activities give
 * the last activity and the past week's volume.
 */
async function fetchBriefing(date: string): Promise<Briefing> {
  const client = getClient();
  const settled = await Promise.allSettled([
    client.getTrainingReadiness(date),
    client.getSleepData(date),
    client.getHrvData(shiftDate(date, 14), date),
    client.getUserSummary(date),
    client.getActivities(0, 20),
    client.getTrainingStatus(date),
  ]);
  // Expired sign-in: let withAuth show the sign-in form instead of an empty briefing
  const authError = settled.find(
    (r) =>
      r.status === "rejected" &&
      (r.reason instanceof GarminAuthError || r.reason instanceof GarminTokenExpiredError),
  );
  if (authError && settled.every((r) => r.status === "rejected")) {
    throw (authError as PromiseRejectedResult).reason;
  }
  const [readiness, sleep, hrv, summary, activities, trainingStatus] = settled.map((r) =>
    r.status === "fulfilled" ? (r.value ?? undefined) : null,
  );
  const sources: BriefingSources = { readiness, sleep, hrv, summary, activities, trainingStatus };
  return buildBriefing(date, localToday(), sources);
}

/**
 * Claude calls the tool, then the view calls it again to render: keep the
 * result briefly so that doesn't double the Garmin requests.
 */
const CACHE_MS = 2 * 60_000;
const cache = new Map<string, { at: number; briefing: Promise<Briefing> }>();

function cachedBriefing(date: string): Promise<Briefing> {
  const hit = cache.get(date);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.briefing;
  const briefing = fetchBriefing(date);
  cache.set(date, { at: Date.now(), briefing });
  // Don't keep failures, or briefings where every source failed
  briefing.then(
    (b) => {
      if (b.failed.length === 6) cache.delete(date);
    },
    () => cache.delete(date),
  );
  return briefing;
}

export function registerBriefingTools(server: McpServer, resourceUri: string) {
  registerAppTool(
    server,
    "get-daily-briefing",
    {
      title: "Get Daily Briefing",
      description: [
        "Morning briefing: how the user is today, framed against their own baselines.",
        "Use for 'how am I today', 'morning briefing', 'daily check-in', 'should I train today', 'am I recovered'.",
        "Returns training readiness (with its limiting factors), last night's sleep (score, duration vs Garmin's optimal, stages), HRV (vs 7-night avg and the balanced range), body battery (vs at wake), resting HR (vs 7-day avg), stress, steps vs goal, training status, the last activity and the past 7 days' volume.",
        "Each metric has value, unit, a named baseline, delta and a neutral status (from Garmin's own status fields where it has one); missing metrics carry a reason.",
        "After calling it: give a short, warm briefing that leads with the 1–2 numbers that matter most today, then 2–3 concrete, personal suggestions grounded in the numbers (e.g. intensity or duration of today's session, bedtime, recovery), and one thing to watch.",
        "Say what you're unsure about (missing metrics, a single bad night vs a trend). Don't restate every number: the app already shows them.",
      ].join(" "),
      inputSchema: z.object({
        date: z
          .string()
          .optional()
          .describe("Day to brief on (YYYY-MM-DD), defaults to today in the user's time zone"),
      }),
      _meta: { ui: { resourceUri } },
    },
    async ({ date }) => {
      const day = date || localToday();
      return withAuth(() => cachedBriefing(day), "briefing", { date: day });
    },
  );
}
