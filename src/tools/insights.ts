import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import type { GarminClient } from "garmin-connect";
import { getClient } from "../garmin.js";

/**
 * Data-only tools (no UI). They can't show the sign-in form, so when the user
 * isn't signed in they return an error pointing at garmin-check-auth instead of
 * waiting for a login that would never happen.
 */
async function plainResult(fn: (client: GarminClient) => Promise<unknown>) {
  const client = getClient();
  if (!client.isAuthenticated) {
    try {
      await client.resume();
    } catch {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: "Not signed in to Garmin Connect. Call garmin-check-auth to show the sign-in form.",
          },
        ],
      };
    }
  }
  const data = await fn(client);
  return { content: [{ type: "text" as const, text: JSON.stringify(data ?? null) }] };
}

const date = z.string().describe("Date in YYYY-MM-DD format");
const startDate = z.string().describe("Start date in YYYY-MM-DD format");
const endDate = z.string().describe("End date in YYYY-MM-DD format");
const activityId = z.union([z.string(), z.number()]).describe("Garmin activity ID");

export function registerInsightTools(server: McpServer) {
  function tool<S extends ZodRawShape>(
    name: string,
    title: string,
    description: string,
    inputSchema: S,
    run: (client: GarminClient, args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  ) {
    server.registerTool(name, { title, description, inputSchema }, (async (
      args: z.infer<z.ZodObject<S>>,
    ) => plainResult((client) => run(client, args))) as never);
  }

  // ── Daily wellness ──
  tool(
    "get-daily-summary",
    "Get Daily Summary",
    "Daily totals: steps, calories, distance, floors, intensity minutes, stress and body battery for a date",
    { date },
    (c, a) => c.getUserSummary(a.date),
  );
  tool(
    "get-respiration",
    "Get Respiration",
    "Breathing rate (breaths/min) through the day and during sleep for a date",
    { date },
    (c, a) => c.getRespiration(a.date),
  );
  tool(
    "get-spo2",
    "Get Pulse Ox",
    "Blood oxygen saturation (SpO2) readings for a date",
    { date },
    (c, a) => c.getSpo2(a.date),
  );
  tool(
    "get-intensity-minutes",
    "Get Intensity Minutes",
    "Moderate/vigorous intensity minutes for a date and the running weekly total vs goal",
    { date },
    (c, a) => c.getIntensityMinutes(a.date),
  );
  tool(
    "get-floors",
    "Get Floors",
    "Floors climbed and descended through the day for a date",
    { date },
    (c, a) => c.getFloors(a.date),
  );
  tool(
    "get-resting-heart-rate",
    "Get Resting Heart Rate",
    "Daily resting heart rate over a date range",
    { startDate, endDate: endDate.optional() },
    (c, a) => c.getRestingHeartRate(a.startDate, a.endDate),
  );
  tool(
    "get-body-battery-events",
    "Get Body Battery Events",
    "Events that charged or drained body battery (sleep, activities, stress) for a date",
    { date },
    (c, a) => c.getBodyBatteryEvents(a.date),
  );
  tool(
    "get-hydration",
    "Get Hydration",
    "Water intake vs goal and sweat loss for a date",
    { date },
    (c, a) => c.getHydrationData(a.date),
  );
  tool(
    "get-body-composition",
    "Get Body Composition",
    "Weight, BMI, body fat and muscle mass for a date",
    { date },
    (c, a) => c.getBodyComposition(a.date),
  );
  tool(
    "get-weigh-ins",
    "Get Weigh-ins",
    "All weigh-ins over a date range",
    { startDate, endDate },
    (c, a) => c.getWeighIns(a.startDate, a.endDate),
  );

  // ── Weekly trends ──
  const weeks = z.number().int().min(1).max(52).optional().describe("Number of weeks (default 12)");
  tool(
    "get-weekly-steps",
    "Get Weekly Steps",
    "Weekly step totals for the weeks ending at a date",
    { endDate, weeks },
    (c, a) => c.getWeeklySteps(a.endDate, a.weeks),
  );
  tool(
    "get-weekly-stress",
    "Get Weekly Stress",
    "Weekly average stress for the weeks ending at a date",
    { endDate, weeks },
    (c, a) => c.getWeeklyStress(a.endDate, a.weeks),
  );
  tool(
    "get-weekly-intensity-minutes",
    "Get Weekly Intensity Minutes",
    "Weekly intensity minutes vs goal over a date range",
    { startDate, endDate },
    (c, a) => c.getWeeklyIntensityMinutes(a.startDate, a.endDate),
  );

  // ── Performance ──
  tool(
    "get-endurance-score",
    "Get Endurance Score",
    "Endurance score for a date, or weekly stats when endDate is given (a single date often has no data)",
    { startDate, endDate: endDate.optional() },
    (c, a) => c.getEnduranceScore(a.startDate, a.endDate),
  );
  tool(
    "get-hill-score",
    "Get Hill Score",
    "Hill score (strength + endurance on climbs) for a date, or weekly stats when endDate is given",
    { startDate, endDate: endDate.optional() },
    (c, a) => c.getHillScore(a.startDate, a.endDate),
  );
  tool(
    "get-running-tolerance",
    "Get Running Tolerance",
    "Running load tolerance over a date range",
    { startDate, endDate, aggregation: z.enum(["daily", "weekly"]).optional() },
    (c, a) => c.getRunningTolerance(a.startDate, a.endDate, a.aggregation),
  );
  tool(
    "get-lactate-threshold",
    "Get Lactate Threshold",
    "The user's latest lactate threshold measurement (heart rate and pace), a physiological metric detected by the watch. Not a saved workout: for workouts named like 'LT' use list-workouts.",
    {},
    (c) => c.getLactateThreshold(),
  );
  tool(
    "get-cycling-ftp",
    "Get Cycling FTP",
    "Latest cycling functional threshold power (FTP)",
    {},
    (c) => c.getCyclingFtp(),
  );
  tool(
    "get-heart-rate-zones",
    "Get Heart Rate Zones",
    "Configured heart rate zones per sport",
    {},
    (c) => c.getHeartRateZones(),
  );
  tool(
    "get-fitness-age",
    "Get Fitness Age",
    "Fitness age vs chronological age and what drives it",
    { date },
    (c, a) => c.getFitnessAge(a.date),
  );
  tool(
    "get-personal-records",
    "Get Personal Records",
    "Personal records (fastest 1K/5K/10K, longest run, etc.)",
    {},
    (c) => c.getPersonalRecords(),
  );
  tool(
    "get-progress-summary",
    "Get Progress Summary",
    "Totals per activity type over a date range for a metric",
    {
      startDate,
      endDate,
      metric: z.enum(["distance", "duration", "elevationGain", "movingDuration"]).optional(),
    },
    (c, a) => c.getProgressSummary(a.startDate, a.endDate, a.metric),
  );

  // ── Activities ──
  tool(
    "get-activities-by-date",
    "Get Activities by Date",
    "Activities between two dates, optionally filtered by type (e.g. running, cycling)",
    {
      startDate,
      endDate: endDate.optional(),
      activityType: z.string().optional().describe("Activity type key, e.g. running"),
      start: z.number().int().optional(),
      limit: z.number().int().max(100).optional(),
    },
    (c, a) => c.getActivitiesByDate(a.startDate, a.endDate, a.activityType, a.start, a.limit),
  );
  tool(
    "get-activity-typed-splits",
    "Get Activity Typed Splits",
    "Run/walk/rest splits of an activity",
    { activityId },
    (c, a) => c.getActivityTypedSplits(a.activityId),
  );
  tool(
    "get-activity-weather",
    "Get Activity Weather",
    "Weather during an activity",
    { activityId },
    (c, a) => c.getActivityWeather(a.activityId),
  );
  tool(
    "get-activity-exercise-sets",
    "Get Activity Exercise Sets",
    "Strength-training sets, reps and weights of an activity",
    { activityId },
    (c, a) => c.getActivityExerciseSets(a.activityId),
  );
  tool(
    "get-activity-chart-data",
    "Get Activity Chart Data",
    "Time series (HR, pace, cadence, elevation...) of an activity, downsampled",
    {
      activityId,
      maxPoints: z
        .number()
        .int()
        .min(10)
        .max(2000)
        .optional()
        .describe("Max samples (default 200)"),
    },
    (c, a) => c.getActivityChartDetails(a.activityId, a.maxPoints ?? 200),
  );
  tool(
    "get-activity-gear",
    "Get Activity Gear",
    "Gear (e.g. shoes) used for an activity",
    { activityId },
    (c, a) => c.getActivityGear(a.activityId),
  );
  tool("get-activity-types", "Get Activity Types", "All Garmin activity type keys", {}, (c) =>
    c.getActivityTypes(),
  );

  // ── Devices, gear, plans ──
  // No profile tool on purpose: it would expose name, email and location to the LLM
  tool(
    "get-user-settings",
    "Get User Settings",
    "User settings: units, sleep schedule, physiological data (age, weight, height, HR zones, lactate threshold)",
    {},
    (c) => c.getUserSettings(),
  );
  tool("get-devices", "Get Devices", "Registered Garmin devices", {}, (c) => c.getDevices());
  tool(
    "get-primary-training-device",
    "Get Primary Training Device",
    "Device used as the source of training status and metrics",
    {},
    (c) => c.getPrimaryTrainingDevice(),
  );
  tool("get-last-used-device", "Get Last Used Device", "Most recently synced device", {}, (c) =>
    c.getDeviceLastUsed(),
  );
  tool("get-gear", "Get Gear", "All gear (shoes, bikes) with usage", {}, (c) => c.getGear());
  tool(
    "get-goals",
    "Get Goals",
    "Goals by status",
    { status: z.enum(["active", "future", "past"]).optional() },
    (c, a) => c.getGoals(a.status),
  );
  tool("get-training-plans", "Get Training Plans", "Available and active training plans", {}, (c) =>
    c.getTrainingPlans(),
  );
  tool(
    "get-calendar",
    "Get Calendar",
    "Calendar for a month: scheduled workouts, activities and events",
    { year: z.number().int(), month: z.number().int().min(1).max(12).describe("Month, 1-12") },
    (c, a) => c.getCalendar(a.year, a.month),
  );
}
