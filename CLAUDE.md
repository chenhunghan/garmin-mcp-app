# Garmin MCP App

MCP App server with interactive React UI for Garmin Connect integration.

## Architecture

- **MCP Server** (`src/server.ts`) — Node.js server over stdio, registers tools + UI resource
- **React UI** (`src/app.tsx`) — Rendered in host's sandboxed iframe, communicates via `postMessage`
- **garmin-connect** (`packages/garmin-connect/`) — TypeScript client library for Garmin Connect OAuth + API

The host (e.g. Claude Desktop) brokers all communication: Server ←stdio→ Host ←postMessage→ App iframe.

## Key concepts

- `ui://` URIs are opaque identifiers, not real URLs — the host fetches them as MCP resources
- `vite-plugin-singlefile` inlines all app JS/CSS into `dist/app.html`; React + ext-apps loaded from `esm.sh` CDN at runtime
- Tools declare `_meta.ui.resourceUri` to link a UI to a tool invocation
- App ↔ Server communication: `app.callServerTool()` (app-initiated) and `app.ontoolresult` (server-pushed)
- See: https://modelcontextprotocol.io/docs/extensions/apps

## Monorepo

npm workspaces (`packages/*`). Root scripts:

- `npm run dev` — watch-build server + UI
- `npm run dev:ui` — standalone UI dev wired to the MCP server
- `npm run test:lib` — run garmin-connect tests
- `npm run pack` — build + package `.mcpb` bundle

### Dev UI (`npm run dev:ui`)

Runs the React UI standalone in a browser at `localhost:5173`, wired to the MCP server running in-process. This lets you test MCP app against the actual MCP server connecting to Garmin API without deploying to Claude Desktop.

**Debugging the dev UI with agent-browser:**

Use the `agent-browser` skill to inspect and interact with the dev UI:

```bash
agent-browser open http://localhost:5173/   # Open the dev UI
agent-browser snapshot                       # Full accessibility tree
agent-browser snapshot -i                    # Interactive elements only (forms, buttons)
agent-browser screenshot /tmp/dev-ui.png     # Take a screenshot
agent-browser console                        # Check browser console messages
agent-browser eval "document.body.innerHTML" # Inspect raw DOM
```

This is the preferred way to debug the MCP app UI during development — it can read elements, check auth state, interact with forms, and inspect console logs without needing a real browser window.

### garmin-connect library

- OAuth 1.0a → OAuth 2.0 token exchange flow with Garmin SSO
- `GarminClient` — main entry point
- `FileTokenStorage` — persists tokens to `~/.garminconnect/`
- Tests: `vitest` (`npm run test:lib`)

### Garmin Connect API

Base URL: `https://connectapi.garmin.com/`

In development, by default, tokens are saved at `~/.garminconnect/oauth2_token.json`. To test API endpoints directly with curl:

```bash
TOKEN=$(python3 -c "import json; print(json.load(open('$HOME/.garminconnect/oauth2_token.json'))['access_token'])")

# Profile
curl -H "Authorization: Bearer $TOKEN" "https://connectapi.garmin.com/userprofile-service/socialProfile"

# Daily summary (query param, not path param)
curl -H "Authorization: Bearer $TOKEN" "https://connectapi.garmin.com/usersummary-service/usersummary/daily?calendarDate=2026-02-20"

# Steps (start/end date range)
curl -H "Authorization: Bearer $TOKEN" "https://connectapi.garmin.com/usersummary-service/stats/steps/daily/2026-02-14/2026-02-21"

# Heart rate (query param)
curl -H "Authorization: Bearer $TOKEN" "https://connectapi.garmin.com/wellness-service/wellness/dailyHeartRate?date=2026-02-20"

# Sleep (query param)
curl -H "Authorization: Bearer $TOKEN" "https://connectapi.garmin.com/wellness-service/wellness/dailySleepData?date=2026-02-20"

# Stress (path param works)
curl -H "Authorization: Bearer $TOKEN" "https://connectapi.garmin.com/wellness-service/wellness/dailyStress/2026-02-20"

# Activities
curl -H "Authorization: Bearer $TOKEN" "https://connectapi.garmin.com/activitylist-service/activities/search/activities?start=0&limit=5"

# Training readiness (path param)
curl -H "Authorization: Bearer $TOKEN" "https://connectapi.garmin.com/metrics-service/metrics/trainingreadiness/2026-02-20"

# Training status (path param)
curl -H "Authorization: Bearer $TOKEN" "https://connectapi.garmin.com/mobile-gateway/usersummary/trainingstatus/latest/2026-02-20"

# HRV (start/end date range)
curl -H "Authorization: Bearer $TOKEN" "https://connectapi.garmin.com/hrv-service/hrv/daily/2026-02-14/2026-02-21"

# Body battery (query params)
curl -H "Authorization: Bearer $TOKEN" "https://connectapi.garmin.com/wellness-service/wellness/bodyBattery/reports/daily?startDate=2026-02-14&endDate=2026-02-21"

# Activity details
curl -H "Authorization: Bearer $TOKEN" "https://connectapi.garmin.com/activity-service/activity/ACTIVITY_ID"

# Activity splits
curl -H "Authorization: Bearer $TOKEN" "https://connectapi.garmin.com/activity-service/activity/ACTIVITY_ID/splits"

# Activity HR zones
curl -H "Authorization: Bearer $TOKEN" "https://connectapi.garmin.com/activity-service/activity/ACTIVITY_ID/hrTimeInZones"

# VO2 Max (start/end date range)
curl -H "Authorization: Bearer $TOKEN" "https://connectapi.garmin.com/metrics-service/metrics/maxmet/daily/2026-02-14/2026-02-21"

# Race predictions (needs displayName from profile)
curl -H "Authorization: Bearer $TOKEN" "https://connectapi.garmin.com/metrics-service/metrics/racepredictions/latest/DISPLAY_NAME"

# User settings
curl -H "Authorization: Bearer $TOKEN" "https://connectapi.garmin.com/userprofile-service/userprofile/user-settings"
```

Key gotchas:

- Some endpoints use `?date=` query params (heart rate, sleep, summary); path params return 403
- Steps endpoint uses `/{start}/{end}` date range format
- Stress endpoint uses `/{date}` path param (works fine)
- API paths match Python [garth](https://github.com/matin/garth) library — use it as reference for new endpoints
