import { McpServer } from "@modelcontextprotocol/server";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { registerAuthTools } from "./tools/auth.js";
import { registerDataTools } from "./tools/data.js";
import { registerWorkoutTools } from "./tools/workouts.js";
import { registerInsightTools } from "./tools/insights.js";
import { registerBriefingTools } from "./tools/briefing.js";
import { formatLocalDate, mondayOf, registerWeekTools } from "./tools/week.js";
import { registerDashboardTools } from "./tools/dashboard.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createServer(version: string) {
  const server = new McpServer({
    name: "garmin-mcp",
    version,
  });

  const resourceUri = "ui://garmin-mcp/app.html";

  registerAppResource(
    server,
    "Garmin App",
    resourceUri,
    { description: "Garmin MCP App UI" },
    async () => ({
      contents: [
        {
          uri: resourceUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: await readFile(resolve(__dirname, "app.html"), "utf-8"),
          _meta: {
            ui: {
              csp: {
                resourceDomains: ["https://esm.sh"],
                connectDomains: ["https://esm.sh"],
              },
            },
          },
        },
      ],
    }),
  );

  registerAuthTools(server, resourceUri);
  registerDataTools(server, resourceUri);
  registerWorkoutTools(server, resourceUri);
  registerInsightTools(server);
  registerBriefingTools(server, resourceUri);
  registerWeekTools(server, resourceUri);
  registerDashboardTools(server, resourceUri);

  // --- Prompts ---

  server.registerPrompt(
    "plan-next-run",
    {
      title: "Plan My Next Run",
      description:
        "Analyze your training data and plan your next run based on readiness, recovery, and goals",
      argsSchema: z.object({
        date: z.string().describe("Reference date (YYYY-MM-DD), defaults to today").optional(),
      }),
    },
    ({ date }) => {
      const resolvedDate = date || new Date().toISOString().split("T")[0];

      return {
        description: "Plan your next run",
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `You are an expert running coach analyzing my Garmin training data to plan my next run.

## Step 1: Collect Data
Call the "get-training-context" tool with date "${resolvedDate}" to get my comprehensive training context.

## Step 2: Analyze
After receiving the data, analyze these factors:
- **Training Readiness Score**: How recovered am I? (>70 = ready for hard effort, 50-70 = moderate, <50 = easy day)
- **Days Since Last Run**: Recovery time since last session
- **Weekly Volume**: Current training load (distance + number of runs)
- **HRV Trend**: Is it trending up (recovered) or down (fatigued)?
- **Body Battery**: Current energy level
- **Training Status**: Am I productive, maintaining, overreaching, or detraining?
- **Recent Run Patterns**: What types of runs have I been doing? Any missing variety?
- **Sleep Quality**: Recent sleep affecting recovery?

## Step 3: Present Summary & Ask Goals
Present a concise training context summary, then ask me:
1. What is your primary goal right now?
   - Build VO2max (high-intensity intervals)
   - Improve lactate threshold (tempo/threshold runs)
   - Build long run endurance
   - Improve speed/turnover (short fast reps)
   - Easy recovery run
   - Or describe your own goal
2. How much time do you have for this run? (optional)
3. Any constraints? (e.g., flat course only, treadmill, heat)

## Step 4: Design the Workout
Based on my data and goals, design a specific workout:
- Include warmup (10-15 min easy) and cooldown (5-10 min easy)
- Set appropriate pace/HR targets based on my recent training paces
- Adjust intensity based on readiness score and recovery status
- Follow the 80/20 rule: most runs should be easy unless readiness is high
- Don't increase weekly volume by more than 10%
- If readiness is low (<50), strongly recommend an easy run regardless of stated goal

## Step 5: Create & Schedule
After I confirm the plan:
1. Call "create-workout" with the structured workout
2. Ask if I want to schedule it for a specific date
3. If yes, call "schedule-workout"

## Important Training Principles
- Hard sessions need 48+ hours recovery
- Back-to-back hard days only if readiness >80 AND experienced runner
- Long runs should be ~25-30% of weekly volume
- Easy runs: conversational pace, HR Zone 1-2
- Tempo runs: comfortably hard, HR Zone 3-4
- Intervals: near max effort, HR Zone 4-5
- Always err on the side of too easy rather than too hard`,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "daily-briefing",
    {
      title: "Daily Briefing",
      description:
        "How am I today? A short morning briefing from your Garmin data, with suggestions",
      argsSchema: z.object({
        date: z.string().describe("Day to brief on (YYYY-MM-DD), defaults to today").optional(),
      }),
    },
    ({ date }) => ({
      description: "Morning briefing from Garmin data",
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Give me my morning briefing${date ? ` for ${date}` : ""}.

Call the "get-daily-briefing" tool${date ? ` with date "${date}"` : ""}, then reply in a few short, warm sentences — like a coach who knows my numbers:
- Lead with how I am today in one line, using the 1–2 numbers that matter most (e.g. readiness and HRV vs my baseline).
- Give 2–3 concrete suggestions for today grounded in my numbers (what kind of training, how long or how hard, sleep or recovery), referencing the specific values.
- Name one thing to watch (a metric drifting from my baseline, or a factor holding readiness back).
- Say briefly what you're unsure about if data is missing or a single night may be noise.
The app already shows every number, so don't list them all.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "plan-training-week",
    {
      title: "Plan My Training Week",
      description:
        "Design a week of training from your Garmin data, then create and schedule the workouts on your Garmin calendar",
      argsSchema: z.object({
        startDate: z
          .string()
          .describe("Any day of the week to plan (YYYY-MM-DD); defaults to the coming week")
          .optional(),
        goal: z
          .string()
          .describe("What you're training for, e.g. 'half marathon in 8 weeks', 'base building'")
          .optional(),
      }),
    },
    ({ startDate, goal }) => {
      // Default: this week if today is Monday, else the coming week
      const today = new Date();
      const todayStr = formatLocalDate(today);
      const weekStart = startDate
        ? mondayOf(startDate)
        : today.getDay() === 1
          ? todayStr
          : mondayOf(
              formatLocalDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7)),
            );

      return {
        description: "Plan your training week",
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `You are an expert endurance coach. Plan my training week starting Monday ${weekStart}, then put it on my Garmin calendar.

## Step 1: Collect data
Call "get-training-context" with date "${todayStr}" for my recent runs, weekly volume, readiness, HRV, training status, sleep and body battery. Call "show-training-week" with startDate "${weekStart}" if you need to see what's already scheduled or done that week.

## Step 2: Ask what you don't know
${goal ? `My goal: ${goal}.` : "Ask me for my goal (race and date, base building, getting back after a break, …)."}
Also ask, unless I already said: which days I can train and how long on each day, my preferred long-run day, and any constraints (injury, terrain, treadmill, other sports). Keep it to one short round of questions.

## Step 3: Design the week
- 80/20: about 80% of time easy (HR zone 1-2), at most two hard sessions (tempo/threshold/intervals)
- At least 48 hours between hard sessions; no hard session the day before the long run
- Long run about 25-30% of the weekly volume
- Weekly volume at most +10% over my recent weeks; hold or cut volume if readiness is low, HRV is below baseline or training status says overreaching/strained
- Rest or easy days where I can't train; respect my constraints
- Targets from my own data: HR zones, recent easy and race paces

## Step 4: Confirm
Present the week as a compact table (day, session, duration/distance, target) with one line on why it fits my data. Ask me to confirm or adjust. Don't create anything before I confirm.

## Step 5: Create and schedule
For each session, call "create-structured-workout" with its steps and scheduleDate set to its day. Use warmup / run / recovery / cooldown steps, HR-zone targets for easy running and pace targets for quality work.

## Step 6: Show the week
Finish with "show-training-week" (startDate "${weekStart}") so I can see the plan, and summarise it in two or three sentences.`,
            },
          },
        ],
      };
    },
  );

  return server;
}
