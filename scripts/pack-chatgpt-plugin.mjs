/**
 * Assemble a ChatGPT / Codex plugin marketplace from the normal build:
 *
 *   build/chatgpt-plugin/
 *     .agents/plugins/marketplace.json   ← marketplace "garmin-mcp"
 *     plugins/garmin/
 *       plugin.json                      ← plugin "garmin" (root Agent Plugins format)
 *       mcp.json                         ← runs the same dist/index.js over stdio
 *       dist/index.js, dist/app.html
 *       package.json                     ← {"type":"module"} so node loads the ESM bundle
 *       assets/, skills/
 *
 * The same server and UI as the Claude Desktop .mcpb; ChatGPT-only metadata is
 * additive (src/tools/openai.ts). Local MCP servers make the plugin Desktop-only.
 *
 * Install locally:  codex plugin marketplace add ./build/chatgpt-plugin
 *                   codex plugin add garmin@garmin-mcp
 * CI publishes this folder to the `chatgpt-plugin` branch, so users run:
 *                   codex plugin marketplace add chenhunghan/garmin-mcp-app@chatgpt-plugin
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "build/chatgpt-plugin");
const plugin = join(out, "plugins/garmin");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));

for (const f of ["dist/index.js", "dist/app.html"]) {
  if (!existsSync(join(root, f))) throw new Error(`${f} missing — run npm run build first`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, ".agents/plugins"), { recursive: true });
mkdirSync(join(plugin, "dist"), { recursive: true });
mkdirSync(join(plugin, "assets"), { recursive: true });

const json = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + "\n");

json(join(out, ".agents/plugins/marketplace.json"), {
  name: "garmin-mcp",
  interface: { displayName: "Garmin MCP" },
  plugins: [
    {
      name: "garmin",
      source: { source: "local", path: "./plugins/garmin" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    },
  ],
});

// Root plugin.json (Agent Plugins format): portable identity at the top level,
// ChatGPT presentation under extensions["com.openai"]. Skills are discovered
// from ./skills, MCP servers from ./mcp.json.
json(join(plugin, "plugin.json"), {
  $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  name: "garmin",
  version: pkg.version,
  description:
    "Your Garmin data with interactive views: daily briefing, performance trends, training week, splits and workouts.",
  author: { name: "Hung-Han (Henry) Chen", url: "https://github.com/chenhunghan" },
  homepage: "https://github.com/chenhunghan/garmin-mcp-app",
  repository: "https://github.com/chenhunghan/garmin-mcp-app",
  license: "MIT",
  keywords: ["garmin", "fitness", "running", "health", "training"],
  extensions: {
    "com.openai": {
      onboardingSkill: "./skills/onboarding/SKILL.md",
      interface: {
        displayName: "Garmin",
        shortDescription: "Daily briefing, trends and training plans from your Garmin",
        longDescription:
          "Connect your Garmin account to see a daily briefing against your own baselines, compare health and fitness trends over a year, plan and schedule a week of structured workouts, and analyze runs split by split. Runs locally: your password and data stay on your computer.",
        developerName: "Hung-Han (Henry) Chen",
        category: "Productivity",
        capabilities: ["Interactive", "Read", "Write"],
        websiteURL: "https://github.com/chenhunghan/garmin-mcp-app",
        defaultPrompt: ["@Garmin how am I today?", "@Garmin plan my training week"],
        brandColor: "#3E6FEF",
        composerIcon: "./assets/composer-icon.svg",
        logo: "./assets/icon.svg",
        logoDark: "./assets/icon-dark.svg",
      },
    },
  },
});

// Local stdio server: the same dist/index.js as the Claude Desktop .mcpb
json(join(plugin, "mcp.json"), {
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  mcpServers: {
    garmin: { type: "stdio", command: "node", args: ["./dist/index.js"], cwd: "./" },
  },
});
json(join(plugin, "package.json"), {
  name: "garmin-chatgpt-plugin",
  private: true,
  type: "module",
});

cpSync(join(root, "dist/index.js"), join(plugin, "dist/index.js"));
cpSync(join(root, "dist/app.html"), join(plugin, "dist/app.html"));
cpSync(join(root, "LICENSE"), join(plugin, "LICENSE"));
cpSync(join(root, "plugin/assets"), join(plugin, "assets"), { recursive: true });
cpSync(join(root, "plugin/skills"), join(plugin, "skills"), { recursive: true });

console.log(`ChatGPT plugin v${pkg.version} → ${out}`);
