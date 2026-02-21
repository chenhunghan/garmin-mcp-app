# Garmin MCP App

Connect your Garmin watch to Claude Desktop. Ask Claude about your health & fitness data and get interactive charts — all inside the conversation.

## Install

1. Download the latest `.mcpb` file from [Releases](https://github.com/chenhunghan/garmin-mcp-app/releases)
2. Drag it into Claude Desktop to install
3. Ask Claude anything about your Garmin data — it will prompt you to sign in on first use

## What you can do

### Health & Wellness

- **Steps** — daily step counts with trend chart
- **Heart Rate** — resting HR and daily heart rate data with chart
- **Sleep** — sleep stages (deep, light, REM, awake) with breakdown chart
- **Stress** — daily stress levels with chart
- **Body Battery** — charged/drained energy levels over a date range
- **HRV** — heart rate variability (nightly avg, weekly avg, baseline, status)

### Training & Performance

- **Activities** — recent activities list with interactive chart
- **Activity Details** — full details for any activity (distance, time, pace, elevation, training effect)
- **Activity Splits** — per-km/mile pace, HR, and cadence with chart
- **Activity HR Zones** — time-in-zone breakdown with chart
- **Training Readiness** — readiness score and breakdown (sleep, HRV, recovery, stress) with chart
- **Training Status** — acute/chronic load and load status
- **VO2 Max** — VO2 Max trend over a date range

### Fitness Benchmarks

- **Race Predictions** — predicted times for 5K, 10K, half marathon, and marathon with chart
- **User Settings** — profile info including age, weight, height, and HR zones

### Workout Management

- **List / View Workouts** — browse saved workouts
- **Create Workout** — build structured workouts (warmup, intervals, cooldown) and sync to Garmin
- **Update / Delete Workouts** — edit or remove saved workouts
- **Schedule Workout** — assign a workout to a calendar date

## Privacy & Security

**No data is stored or collected by this app.** Your data flows directly between your machine and the Garmin Connect API — there is no intermediate server.

- **Your credentials stay private.** You sign in through a secure login form rendered inside Claude Desktop. The login and MFA tools are marked as app-only (`visibility: ["app"]`), meaning Claude (the LLM) cannot call them and **never sees your email, password, or MFA code**.
- **Claude doesn't know who you are.** The LLM only receives the health/fitness data you ask for (steps, sleep, etc.) — it has no access to your Garmin account credentials or OAuth tokens.
- **Tokens are stored locally.** OAuth tokens are saved on your machine at `~/.garminconnect/` with restrictive file permissions (`0600`). They are never sent anywhere other than the Garmin Connect API.
- **You can log out anytime.** Logging out clears all saved tokens from your machine.

## Example prompts

- "Show me my steps for the past week"
- "How did I sleep last night?"
- "What's my training readiness today?"
- "Show my heart rate zones for my last run"
- "What are my predicted race times?"
- "Create a 5K interval workout with 4x800m repeats"
- "Schedule my tempo run for next Monday"

---

<details>
<summary>Developer / Contributor Guide</summary>

## Getting Started

```bash
git clone https://github.com/chenhunghan/garmin-mcp-app.git
cd garmin-mcp-app
npm install
```

`npm install` automatically sets up git hooks via [prek](https://github.com/j178/prek):

- **commit-msg** — enforces [Conventional Commits](https://www.conventionalcommits.org/) via commitlint
- **pre-push** — runs lint, format check, typecheck, and tests (same as CI)

### Troubleshooting: `core.hooksPath`

If `npm install` warns about `core.hooksPath`, prek cannot install git hooks. Fix it by unsetting the local config:

```bash
git config --unset-all --local core.hooksPath
npm run prepare
```

## Development

```bash
npm run dev        # watch-build server + UI
npm run dev:ui     # standalone UI dev at localhost:5173
npm run test:lib   # run garmin-connect tests
npm run pack       # build + package .mcpb bundle
```

`npm run dev:ui` opens `http://localhost:5173` with the React UI wired to the real MCP server in-process. You can test login, MFA, and logout against the actual Garmin API without deploying to Claude Desktop.

## Testing in Claude Desktop

Run `npm run build` (one-off) or `npm run dev` (watch mode for live rebuilds), then add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "garmin-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/garmin-mcp-app/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop. Ask Claude to check your Garmin auth — it will render the app UI in an iframe and run the real login/MFA flow.

## Architecture

- **MCP Server** (`src/server.ts`) — Node.js server over stdio, registers tools + UI resource
- **React UI** (`src/app.tsx`) — Rendered in host's sandboxed iframe, communicates via `postMessage`
- **garmin-connect** (`packages/garmin-connect/`) — TypeScript client library for Garmin Connect OAuth + API

## Commit Convention

Commits must follow the Conventional Commits format:

```
type(optional-scope): description
```

Allowed types: `feat`, `fix`, `chore`, `docs`, `ci`, `refactor`, `test`

</details>
