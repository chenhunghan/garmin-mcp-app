# Garmin MCP App

Connect your Garmin watch to Claude Desktop. Explore interactive charts.

![demo](https://github.com/user-attachments/assets/62b5ec61-a772-4502-b717-c32c4ea89195)

## Install

1. Download the latest `.mcpb` file from [Releases](https://github.com/chenhunghan/garmin-mcp-app/releases)
2. Drag it into Claude Desktop to install
3. Ask Claude anything about your Garmin data — it will prompt you to sign in on first use

## What you can do

Ask Claude about your health, training, and fitness — it reads your Garmin data and shows interactive charts right in the conversation.

- **Review your day** — steps, heart rate, sleep, stress, body battery, and HRV
- **Analyze your workouts** — activity details, pace splits, HR zones, and training effect
- **Track your fitness** — training readiness, training load, VO2 Max trends, and race predictions
- **Plan your training** — create structured workouts, schedule them on your Garmin calendar, or edit existing ones

<details>
<summary>Full list of supported Garmin Connect data</summary>

| Category     | Data                                                                  |
| ------------ | --------------------------------------------------------------------- |
| Daily health | Steps, heart rate, sleep stages, stress, body battery, HRV            |
| Activities   | Activity list, activity details, per-km/mile splits, HR time-in-zones |
| Training     | Training readiness, training status & load, VO2 Max, race predictions |
| Profile      | Age, weight, height, HR zones, lactate threshold                      |
| Workouts     | List, create, update, delete, and schedule workouts                   |

</details>

## Privacy & Security

**No data is stored or collected by this app.** Your data flows directly between your machine and the Garmin Connect API — there is no intermediate server.

<details>
<summary>Learn more</summary>

- **Your credentials stay private.** You sign in through a secure login form rendered inside Claude Desktop. The login and MFA tools are marked as app-only (`visibility: ["app"]`), meaning Claude (the LLM) cannot call them and **never sees your email, password, or MFA code**.
- **Claude doesn't know who you are.** The LLM only receives the health/fitness data you ask for (steps, sleep, etc.) — it has no access to your Garmin account credentials or OAuth tokens.
- **Tokens are stored locally.** OAuth tokens are saved on your machine at `~/.garminconnect/` with restrictive file permissions (`0600`). They are never sent anywhere other than the Garmin Connect API.
- **You can log out anytime.** Logging out clears all saved tokens from your machine.

</details>

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
