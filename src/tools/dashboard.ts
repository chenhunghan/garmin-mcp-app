import type { McpServer } from "@modelcontextprotocol/server";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import {
  METRICS,
  METRIC_KEYS,
  SeriesFetcher,
  fetchMetricSeries,
  seriesRange,
  type MetricKey,
} from "garmin-connect";
import { getClient } from "../garmin.js";
import { withAuth } from "./data.js";
import { entrypointIcons, openaiEntrypoint } from "./openai.js";

export const RANGE_WEEKS = { "4w": 4, "12w": 12, "26w": 26, "52w": 52 } as const;
export type DashboardRange = keyof typeof RANGE_WEEKS;
export const DEFAULT_METRICS: MetricKey[] = ["restingHR", "hrv", "vo2max", "sleepScore"];

/** Today as the server's local calendar day. */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Series + summaries for up to 4 metrics over the range ending at endDate. */
export async function buildDashboard(metrics: MetricKey[], range: DashboardRange, endDate: string) {
  const r = seriesRange(endDate, RANGE_WEEKS[range]);
  const fetcher = new SeriesFetcher(getClient());
  const series = await Promise.all(metrics.map((m) => fetchMetricSeries(fetcher, m, r)));
  return {
    range,
    startDate: r.start,
    endDate: r.end,
    granularity: r.granularity,
    metrics: series,
    garminRequests: fetcher.requests,
    availableMetrics: METRIC_KEYS.map((k) => ({
      key: k,
      label: METRICS[k].label,
      unit: METRICS[k].unit,
    })),
  };
}

export function registerDashboardTools(server: McpServer, resourceUri: string) {
  registerAppTool(
    server,
    "show-performance-dashboard",
    {
      title: "Performance Dashboard",
      ...entrypointIcons,
      description: `Show how key health and fitness metrics trend over 4 weeks to 1 year, one small chart per metric on a shared time range. Use it for trends, progress and comparing metrics over time: "is my fitness improving?", "how has my HRV changed?", "why did my resting HR go up in March?" (pick a range/endDate that covers the period).

Metrics (max 4): restingHR, hrv (nightly avg, with Garmin's baseline band), vo2max, sleepScore, sleepDuration (h), steps (per day), stress (avg), bodyBattery (daily high), intensityMinutes (weekly, vigorous counted double), trainingLoad (acute load with Garmin's optimal range), weight (kg, only if the user weighs in). Points are daily for 4w/12w and weekly means for 26w/52w.

Each metric has a summary: end = current level (mean of the last 7 days, or the latest week), mean = the period's average, vsMean/vsMeanPct = current level vs that average (the headline comparison; % omitted when the average is near zero), min/max with dates, start = the first 7 days/week (often unrepresentative, e.g. a new watch still calibrating or load ramping up from zero, so don't quote start→end percentages), and trend (direction of a least-squares fit; "flat" = fitted change under 3% of the mean). The chart only shows the data: interpret it for the user — what changed, how the metrics relate (e.g. HRV vs resting HR vs training load vs sleep), and gaps in the data. Don't over-read small changes.`,
      inputSchema: z.object({
        metrics: z
          .array(z.enum(METRIC_KEYS))
          .min(1)
          .max(4)
          .optional()
          .describe(`Metrics to show (max 4), default ${DEFAULT_METRICS.join(", ")}`),
        range: z
          .enum(["4w", "12w", "26w", "52w"])
          .optional()
          .describe("Time range ending at endDate: 4, 12, 26 or 52 weeks (default 12w)"),
        endDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Last day shown, YYYY-MM-DD (default today)"),
      }),
      _meta: { ui: { resourceUri }, ...openaiEntrypoint("global") },
    },
    async ({ metrics, range, endDate }) => {
      const args = {
        metrics: [...new Set(metrics ?? DEFAULT_METRICS)],
        range: range ?? "12w",
        endDate: endDate ?? today(),
      };
      return withAuth(
        () => buildDashboard(args.metrics, args.range, args.endDate),
        "dashboard",
        args,
      );
    },
  );
}
