import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { registerAuthTools } from "./tools/auth.js";
import { registerDataTools } from "./tools/data.js";
import { registerWorkoutTools } from "./tools/workouts.js";

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

  // --- Prompts ---

  server.registerPrompt(
    "plan-next-run",
    {
      title: "Plan My Next Run",
      description:
        "Analyze your training data and plan your next run based on readiness, recovery, and goals",
      argsSchema: {
        date: z.string().describe("Reference date (YYYY-MM-DD), defaults to today").optional(),
      },
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

  return server;
}
