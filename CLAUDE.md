# Garmin MCP App (Run Coach)

MCP App server with interactive React UI for Garmin Connect integration.

## Architecture

- **MCP Server** (`src/server.ts`) — Node.js server over stdio, registers tools + UI resource
- **React UI** (`src/app.tsx`) — Rendered in host's sandboxed iframe, communicates via `postMessage`
- **garmin-connect** (`packages/garmin-connect/`) — TypeScript client library for Garmin Connect OAuth + API

The host (e.g. Claude Desktop) brokers all communication: Server ←stdio→ Host ←postMessage→ App iframe.

## Key concepts

- `ui://` URIs are opaque identifiers, not real URLs — the host fetches them as MCP resources
- `vite-plugin-singlefile` inlines all app JS/CSS — including React, Recharts and `@modelcontextprotocol/ext-apps` — into one self-contained `dist/app.html` (no CDN, so it works in ChatGPT's stricter sandbox and offline)
- Tools declare `_meta.ui.resourceUri` to link a UI to a tool invocation
- App ↔ Server communication: `app.callServerTool()` (app-initiated) and `app.addEventListener("toolresult", …)` (server-pushed)
- SDK: `@modelcontextprotocol/ext-apps` 2.x on the split MCP SDK 2.x packages — `McpServer` / `StdioServerTransport` from `@modelcontextprotocol/server`, `Client` / `InMemoryTransport` from `@modelcontextprotocol/client` (the old `@modelcontextprotocol/sdk` package is not used). Tool `inputSchema` / prompt `argsSchema` are `z.object(...)` (raw shapes are deprecated, removed in 3.0). Node 20+.
- See: https://modelcontextprotocol.io/docs/extensions/apps

## Monorepo

npm workspaces (`packages/*`). Root scripts:

- `npm run dev` — watch-build server + UI
- `npm run dev:ui` — standalone UI dev wired to the MCP server (`dev:ui:demo`: with a fictional demo account, see below)
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

### Demo mode (`npm run dev:ui:demo`)

The dev UI with a **fully fictional** Garmin account ("Demo Runner", a recreational runner training for a half marathon) — for README screenshots and screencasts without anyone's personal data. `GARMIN_DEMO=1` makes `src/dev-server.ts` call `startDemoMode()` (`src/demo/server.ts`) before creating the MCP server: fake tokens in a temp dir (`GARMIN_TOKEN_PATH`, never `~/.garminconnect`) and an MSW server in the Vite process that answers every `connectapi.garmin.com` request from the demo world; any other `*.garmin.com` request (sign-in) fails as a network error, and unknown API paths return 404 with a `[demo] no demo data for …` warning. Nothing in `src/demo/` is imported by the production entry (`src/index.ts`).

- `src/demo/world.ts` — the athlete, simulated day by day for the 400 days up to today (seeded by date, so the same day always looks the same): runs in 3 build + 1 recovery week cycles, sleep, HRV + baseline, resting HR, stress, body battery, load, VO₂ max, readiness, weight, saved workouts and the calendar. "Today" is pinned for screenshots (readiness 72, sleep 81, yesterday's run recorded as one lap, data up to 10:30).
- `src/demo/run.ts` — each run is a 5-second time series from its plan; summary, laps, HR zones, training load/effect all derive from it. `src/demo/intraday.ts` — per-day HR, stress, body battery, sleep stages.
- `src/demo/garmin-api.ts` — one route per endpoint. Routes write the fields that matter; `fill()` adds every other key the response schema (`packages/garmin-connect/tests/schemas.ts`) requires, as null. Workout create/schedule/delete only change memory.
- Tests: `tests/demo-endpoints.test.ts` checks every endpoint in `tests/live/endpoints.ts` against its schema; `tests/demo-tools.test.ts` runs every view tool in demo mode.
- **New endpoint**: add a route in `garmin-api.ts` (with its `schema` key) — the endpoints test fails until the demo answers it. New view: add its tool's args in `tests/demo-tools.test.ts`.

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

# Workouts (list)
curl -H "Authorization: Bearer $TOKEN" "https://connectapi.garmin.com/workout-service/workouts?start=0&limit=5"

# Workout (get by ID)
curl -H "Authorization: Bearer $TOKEN" "https://connectapi.garmin.com/workout-service/workout/WORKOUT_ID"

# Workout (create) — POST with JSON body
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"workoutName":"Test Run","sportType":{"sportTypeId":1,"sportTypeKey":"running"},"workoutSegments":[]}' \
  "https://connectapi.garmin.com/workout-service/workout"

# Workout (delete) — returns 204 No Content
curl -X DELETE -H "Authorization: Bearer $TOKEN" "https://connectapi.garmin.com/workout-service/workout/WORKOUT_ID"

# Workout (schedule on date)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"date":"2026-02-25"}' \
  "https://connectapi.garmin.com/workout-service/schedule/WORKOUT_ID"
```

Key gotchas:

- Some endpoints use `?date=` query params (heart rate, sleep, summary); path params return 403
- Steps endpoint uses `/{start}/{end}` date range format
- Stress endpoint uses `/{date}` path param (works fine)
- Workout DELETE returns 204 No Content (no JSON body)
- Workout JSON: build it with `buildWorkout()` (`packages/garmin-connect/src/workout-builder.ts`, used by `create-structured-workout`) rather than by hand — it handles step/condition/target IDs, depth-first `stepOrder`, `childStepId`, and pace targets in m/s (`targetValueOne` = slower pace)
- Calendar (`getCalendar`) activity items: `duration` is in milliseconds, `distance` in centimeters; a month's response also includes the neighbouring days of its grid, so de-duplicate by item id when fetching two months
- Training effect (aerobic/anaerobic) is included in `get-activity-details` response under `summaryDTO.trainingEffect` and `summaryDTO.anaerobicTrainingEffect`
- API paths match Python [garth](https://github.com/matin/garth) library — use it as reference for new endpoints; [python-garminconnect](https://github.com/cyberjunky/python-garminconnect) has the broadest endpoint list
- Garmin **omits keys that don't apply** instead of sending null (e.g. no elevation/GPS keys on treadmill runs) — don't assume every activity has the same fields
- Some endpoints return **204 No Content** when there's no data for a date (endurance/hill score for a single day) — `connectapi` returns `undefined`
- IDs are numbers in most responses (`activityId`, `workoutId`) but `deviceId` is a string inside activity details — tool input schemas accept `string | number` for IDs
- `/device-service/deviceregistration/devices/usage` was retired (404); last-used device is `/device-service/deviceservice/mylastused`
- 429 → `GarminRateLimitError`; other non-2xx → `GarminApiError` with `.status`

## Testing

- `npm run test:lib` — library tests (SSO flow with mocked fetch + every endpoint against recorded fixtures)
- `npm test` — calls every MCP tool through an in-memory MCP client against the recorded fixtures
- Both run in CI and are fully offline: [MSW](https://mswjs.io) serves sanitized recordings from `packages/garmin-connect/tests/fixtures/`, matched by exact method + URL, so the tests also check that each method builds the right request

### Live API check (manual, before releases)

`npm run test:live` calls every read-only endpoint on the real Garmin API and validates the responses against the zod schemas in `packages/garmin-connect/tests/schemas.ts`. It is deliberately careful so it can't get an account blocked:

- uses saved tokens in `~/.garminconnect` only — **never signs in** (sign in through the app first)
- one request at a time, 2 s apart, read-only endpoints only
- stops on the first 429 or 403
- never runs in CI or on a schedule

Raw responses land in `packages/garmin-connect/.live-capture/` (gitignored, contains personal data — never commit it). To refresh the offline tests from a live run:

```bash
npm run test:live                                  # capture + validate
npm run schemas:generate -w packages/garmin-connect # only if Garmin changed a shape on purpose
npm run fixtures:update  -w packages/garmin-connect # sanitize captures into fixtures
```

`fixtures:update` scrubs identity (IDs, name, email, GUID, displayName — also inside URLs), GPS, place names (Garmin names activities after the location), device serials, birth date/height/weight, and trims time series to 20 samples; it fails if any identifying value survives. It then **replaces every value with synthetic data** (`tests/live/synthesize.ts`): per-field random scaling (forced ≥15% away from 1) plus noise for metrics, every timestamp replaced by a uniformly random instant in the capture window, independent of the real value (shifted timestamps leaked the time zone: Garmin repeats the same instant across many fields), fixed placeholder weight/height, generic device/gear/settings strings and health labels — so fixtures keep Garmin's structure and types but not the account's values. Randomness is unseeded on purpose, so each `fixtures:update` produces different values. **Still review the fixture diff before committing** — the check only knows the identity values it collected.

When a live schema check fails, decide whether Garmin changed (update the client/UI, then regenerate) or the schema was too strict for your data (e.g. a field only some activity types have).

### Adding an endpoint

1. Add the method to `packages/garmin-connect/src/client.ts`
2. Add a case to `packages/garmin-connect/tests/live/endpoints.ts`
3. Add a tool (data-only tools go in `src/tools/insights.ts`) and its args in `tests/tools.test.ts` — a test fails if a tool has neither args nor an exclusion reason
4. `npm run test:live`, then `schemas:generate` and `fixtures:update`, and review the fixture diff

## UI Stack

- **[shadcn/ui](https://ui.shadcn.com)** — component source files in `src/components/ui/` (copied, not imported as a package)
- **[Tailwind CSS v4](https://tailwindcss.com)** — styling via `@tailwindcss/vite`; theme configured inline in `src/app.css` using OKLCH CSS variables + `@theme` block
- **[Recharts v3](https://recharts.org)** — charting library, bundled into `dist/app.html`
- **[shadcn Chart component](https://ui.shadcn.com/docs/components/base/chart)** — `src/components/ui/chart.tsx`, adapted for Recharts v3 (official shadcn doesn't support v3 yet)

### Host theme integration

The app uses `useHostStyles` from `@modelcontextprotocol/ext-apps/react` to receive the host's theme and CSS variables at runtime. The host (e.g. Claude Desktop) sends `hostContext` during `ui/initialize` with:

- `theme` — `"light"` or `"dark"`, applied via `data-theme` attribute on `<html>`
- `styles.variables` — CSS variables like `--color-background-primary`, set on `<html>` via `style.setProperty()`

In `src/app.css`, shadcn variables are mapped to host variables with OKLCH fallbacks:

```css
--background: var(--color-background-primary, oklch(1 0 0));
--foreground: var(--color-text-primary, oklch(0.145 0 0));
```

This way all shadcn components automatically use the host's palette when embedded, and fall back to hardcoded values in standalone dev UI. The mapping table is documented in the CSS comment block in `src/app.css`.

Dark mode uses `[data-theme="dark"]` selector (not `.dark` class) to match what `applyDocumentTheme()` from ext-apps sets. The chart.tsx `THEMES` map is also updated to match.

Host variables use `light-dark()` CSS function (resolved via `color-scheme` set by `useHostStyles`). The body uses `background-color: transparent` so the host's actual background shows through the iframe. Card and popover backgrounds map to `--color-background-ghost` (transparent when embedded, solid in dev UI fallback) so `<Card>` wrappers blend seamlessly with the host. Card border uses `border-border/50` and no shadow for a subtle appearance when embedded.

### Dark mode guidelines

The host sets `data-theme="dark"` on `<html>` at runtime. All UI must adapt correctly.

**1. Use shadcn Tailwind classes wherever possible**

These automatically resolve to the correct light/dark values via CSS variables:

```tsx
// Good — adapts to dark mode automatically
<div className="bg-background text-foreground border-border/50" />
<span className="text-muted-foreground" />

// Bad — hardcoded color, invisible in dark mode
<div className="bg-white text-gray-900" />
<span style={{ color: "oklch(0.5 0 0)" }} />
```

**2. Chart colors: use the `--chart-1` through `--chart-5` palette**

All charts reference `var(--chart-N)` in their `chartConfig`. Do NOT create one-off CSS variables for individual chart series. The palette is defined in `app.css` with harmonized OKLCH values for both light and dark:

| Slot        | Light (hue)     | Dark (hue)        | Semantic use                         |
| ----------- | --------------- | ----------------- | ------------------------------------ |
| `--chart-1` | Orange (41)     | Blue-purple (264) | Steps, REM sleep, Training readiness |
| `--chart-2` | Teal (185)      | Green-cyan (162)  | Body battery, Light sleep, HRV, VO2  |
| `--chart-3` | Blue (265)      | Blue (265)        | Resting HR, Aerobic TE, REM sleep    |
| `--chart-4` | Purple (310)    | Purple (310)      | Deep sleep                           |
| `--chart-5` | Red-orange (25) | Red-orange (25)   | Anaerobic TE, Awake                  |

All values share the same lightness/chroma range (L 0.55-0.65 light, 0.65-0.72 dark; C 0.16-0.22) for visual harmony. Only `--success` exists as a utility variable for the "Connected" indicator dot.

**3. ChartConfig: reference `var(--chart-N)` directly**

shadcn's `ChartStyle` generates `--color-{key}: {config.color}` scoped to the chart container. Using `var(--chart-N)` avoids circular references:

```ts
// GOOD — ChartStyle generates: --color-restingHR: var(--chart-3)
const chartConfig = {
  restingHR: { color: "var(--chart-3)" },
};

// BAD — creates circular --color-foo: var(--color-foo) → black
const chartConfig = {
  foo: { color: "var(--color-foo)" },
};
```

**4. Inline styles and SVG gradients: add fallbacks**

Inside `<ChartContainer>`, ChartStyle provides `--color-{key}`. Add the base variable as fallback:

```tsx
<stop stopColor="var(--color-aerobic, var(--chart-3))" />
<span style={{ backgroundColor: "var(--color-restingHR, var(--chart-3))" }} />
```

**5. Avoid Tailwind color utilities that don't map to CSS variables**

Tailwind utilities like `bg-green-500` don't adapt to dark mode. Use CSS variables:

```tsx
// Bad
<span className="bg-green-500" />
// Good
<span style={{ backgroundColor: "var(--success)" }} />
```

**Quick reference: variable layers**

| Layer             | Example                         | Set by                                    | Scope              |
| ----------------- | ------------------------------- | ----------------------------------------- | ------------------ |
| Host variables    | `--color-text-primary`          | `useHostStyles` at runtime                | `<html>`           |
| shadcn variables  | `--foreground`, `--border`      | `app.css` `:root` / `[data-theme="dark"]` | `<html>`           |
| Tailwind theme    | `--color-foreground`            | `@theme inline` block                     | Tailwind utilities |
| Chart palette     | `--chart-1` through `--chart-5` | `app.css` `:root` / `[data-theme="dark"]` | Global             |
| ChartStyle scoped | `--color-restingHR`             | `chart.tsx` `<ChartStyle>`                | `[data-chart=...]` |

### Insight UI building blocks

Shared pieces for views that frame data and hand interpretation to Claude:

- **`useAppActions()`** (`src/lib/app-actions.tsx`) — `callTool`, plus `ask(text)` (sends `text` as the user's next message via `ui/message`) and `shareContext(text, data?)` (tells Claude what's on screen via `ui/update-model-context`; overwrites the previous one, sent with the next user message). Check `canAsk` / `canShareContext` — hosts may not support them; hide the control rather than show a dead one.
- **`<AskClaude questions={[...]} />`** (`src/components/ask-claude.tsx`) — suggested follow-up questions as chips. Questions land in the chat, away from the view, so make them self-contained (name the run/date/metric, not "this").
- **`<StatTile>` / `<StatusBadge>` / `<Sparkline>`** (`src/components/stat-tile.tsx`) — the stat-tile contract: label · value (+unit) · delta vs a named baseline · status · sparkline.
- **Status palette** — `--status-good` / `--status-warning` / `--status-critical` (Tailwind `bg-status-good` etc.), validated with the dataviz palette checks for light and dark. Only for marks (dots, meter fills), always with an icon + label; text uses text tokens.
- **The app suggests, Claude interprets.** Views show data, baselines and status; recommendations come from Claude (via tool descriptions/prompts and `AskClaude`), not hardcoded advice.

Dataviz rules for new charts (from the dataviz skill): pick the form before color; one y-axis per chart (two measures → small multiples, never dual axes); a single series needs no legend (the title names it); thin marks (2px lines, ≤24px bars with 4px rounded ends), solid hairline gridlines; text never wears the series color; a hover tooltip on every plotted chart and a table/values fallback; dark mode checked. The existing `--chart-1…5` palette fails the categorical checks for chart-3↔chart-4 and dark chart-1 contrast — for a single-series chart use `--chart-3` (passes contrast in both themes).

**Composite insight tools** (e.g. `get-daily-briefing` in `src/tools/briefing.ts`): fetch sources with `Promise.allSettled` (one failure leaves a gap, not an error), keep the pure framing (baselines, deltas, statuses, the `shareContext` summary, `AskClaude` questions) in a unit-tested module (`src/briefing-model.ts`, shared by server and view), and return each metric as `{ value, unit, baseline: { name, … }, delta, status, missing? }`. The view re-calls the tool to render, so the tool caches its result for 2 minutes to avoid doubling Garmin requests.

Dev UI: the mock host advertises `message` and `updateModelContext`; what views send is recorded on `window.__devHost.messages` / `.contexts` and logged as `[dev host]`.

### Recharts v3 + shadcn compatibility

shadcn's official chart component targets Recharts v2. Since we use Recharts v3, `chart.tsx` is a community-adapted version. Tracking issue and community patches:

- Issue: https://github.com/shadcn-ui/ui/issues/7669
- noxify's gist: https://gist.github.com/noxify/92bc410cc2d01109f4160002da9a61e5
- arolariu's PR-based version (latest): https://github.com/shadcn-ui/ui/pull/8486#issuecomment-3627835576

When shadcn officially ships Recharts v3 support, replace `chart.tsx` with the official version.

## View routing (tool → chart)

All tools share a single `ui://garmin-mcp/app.html` resource. The app uses `structuredContent.view` in tool responses to decide which chart to render, and `structuredContent.args` to show **what Claude asked for** (a specific date or activity) instead of today/latest.

### Which tools open the UI

- **Tool with a UI and a view** (`registerAppTool` + `_meta.ui.resourceUri`, view passed to `withAuth`) → Claude Desktop opens the panel and the app renders that chart.
- **Data-only tool** (plain `server.registerTool`, e.g. everything in `src/tools/insights.ts`) → no panel; Claude just gets the data. The app can still call it via `callServerTool` (MCP Apps visibility defaults to `["model", "app"]`).
- Never register a UI tool without a view: it opens an empty "Connected to Garmin" panel. `tests/tools.test.ts` fails if any UI tool returns no view.

### How it works

1. **Server** (`src/tools/data.ts`, `src/tools/workouts.ts`) — pass a view and the call's arguments to `withAuth()`:

   ```ts
   async ({ date }) => withAuth(() => getClient().getSleepData(date), "sleep", { date }),
   ```

   This adds `structuredContent: { view: "sleep", args: { date } }` to the tool response. Several tools can share a view (e.g. `get-hrv` and `get-training-status` → `training`; `get-body-battery` → `heart-rate`; `get-vo2-max` → `race-predictions`; all workout tools → `workouts`; `show-training-week` → `week`). Workout step rendering/formatting is shared in `src/components/workout-steps.tsx`.

2. **App** (`src/app.tsx`) — a `toolresult` listener (registered in `onAppCreated`, before connect) sets `visibleCharts` and `toolArgs`:

   ```ts
   app.addEventListener("toolresult", (params) => {
     const sc = params.structuredContent as Record<string, unknown> | undefined;
     if (typeof sc?.view === "string" && VALID_VIEWS.has(sc.view)) {
       setToolArgs(sc.args as ToolArgs);
       setVisibleCharts(new Set([sc.view]));
     }
   });
   ```

   Use `addEventListener`; the `app.ontoolresult = …` setters are deprecated (ext-apps 1.4+).

3. **Render** — charts get the args: `<SleepChart callTool={callTool} args={toolArgs} />`. Helpers in `src/lib/tool-args.ts`:
   - `anchorDate(args)` — last day a range chart shows (requested `endDate`/`date`, else today); range pickers count back from it
   - `anchorSuffix(args, "range" | "day")` / `rangeLabel(label, args)` — say which day is shown when it isn't today ("Sleep · to Sun 20 Sept", "7 days" instead of "Last 7 days")
   - `resolveActivity(callTool, args)` (`src/lib/activity.ts`) — the requested activity, else the latest; includes the date, since Garmin auto-names many activities identically

4. **Expensive views render the tool result itself** — `app.tsx` also parses the result's text into `toolData`; `DashboardView` gets it as `data` so opening the panel doesn't repeat Claude's Garmin requests, and only calls the tool again when the user changes the filters (missing metrics only, cached per range).

Long-range series (`packages/garmin-connect/src/series.ts`, used by `show-performance-dashboard`): `fetchMetricSeries` returns `{ date, value, low?, high? }[]` + a summary per metric, daily for ≤ 12 weeks and weekly beyond. Verified limits: HRV, resting HR, VO₂ max, training status and weight answer a whole year in one request; sleep stats, body battery, daily steps/stress need 28-day pages (Garmin answers 400 beyond); there is no weekly sleep endpoint.

Dates: use `formatDate`/`parseDate` from `src/lib/dates.ts` (local calendar days). Never `toISOString().slice(0, 10)` — it prints UTC and lands on the previous day east of UTC.

### Run replay (3D view)

`show-run-replay` opens a three.js replay of a run (view `replay`, `src/run-replay-view.tsx`). The tool returns only a short summary to the model; the view fetches the time series through the app-only `garmin-get-run-replay` (both share a 5-min cache of Garmin responses in `src/tools/replay.ts`). `src/replay-model.ts` (pure, unit-tested in `tests/replay-model.test.ts`) turns chart details + laps + weather + HR zones into columnar channels (`t`, `d`, `lat`/`lon`, `elev`, `hr`, `cad`, `speed`, `gap`, `power`, `temp`, stride/VO/GCT/VR, …) and has the playback helpers and sun position.

Every metric is shown at once in `src/metric-lanes.tsx` (`MetricPanels`): heads-up-display panels by group (Run on the left edge; Terrain, Form, Body on the right) with the value at the playhead and a sparkline of the whole run on its own 2–98 % range, so the middle of the scene stays clear. The bottom is one slim row: play/skip/speed, the timeline (elevation profile + route-color strip + laps; click or drag to jump) and the cameras; "HUD on/off" hides the panels. The pointer's time on the timeline or any sparkline is shared, so every panel reads that moment; clicking a colorable metric's name colors the route by it. Below `md` the panels sit under the view. Style primitives (`HudPanel`, `hudBox`, corner `Brackets`, orange `HUD_ACCENT`, mono uppercase labels) are in `src/replay-hud.tsx`, dark in both themes since they sit on the 3D view.

`src/replay/` (excluded from the server tsconfig, loaded with a dynamic import):

- `scene.ts` — `three/webgpu` `WebGPURenderer` (falls back to WebGL 2), sky/sun at the run's real time and GPS position, weather (clouds, fog, rain/snow, breath when cold), camera rig (OrbitControls + chase/side/front/drone/overview), playback clock. `window.__replay` exposes it in the dev UI.
- `track.ts` — GPS → local meters, smoothed; `dense` is the path resampled on a Catmull-Rom spline every 1.5 m, which the ribbon, terrain and runner all follow (Garmin samples can be 5–15 m apart).
- `terrain.ts` — fine grid over the route + coarse grid to the horizon; heights from the route elevation (path bed), its IDW trend, fBm hills and ridged mountains, using a continuous distance-to-route field (vector distance transform — a radius-limited splat made cliffs). Cut into 40-cell chunks (frustum-culled, resolution drops away from the route, skirts hide cracks); meadow color is baked per vertex and close-up relief/gravel comes from one tileable generated texture — per-pixel noise in the shader was the main frame-rate cost.
- Performance: the frame is mostly limited by draw work on the CPU, not pixels. `adaptQuality` steers a detail level (0.4–1, how far trees and balconies are drawn) from a smoothed frame time and lowers the pixel ratio (the screen's own up to 2, never below 1) only at the floor. Buildings and balconies are cut into 350 m tiles so the camera and the sun's 44 m shadow box cull them (as one mesh the shadow pass drew the whole city each frame). The shadow map has `autoUpdate` off and is redrawn only when the runner or the sun moved (`updateShadow`), its box snapped to whole texels. The environment map re-bakes at most every 3 s.
- Opens playing at 2× in the drone view (not with prefers-reduced-motion).
- Gait speed is the faster of Garmin's `speed` and the distance channel's rate (±2 samples): the smoothed speed reads 0 for the first ~30 s while the distance already grows. Cadence over 100 spm means running even at ~0 speed (before GPS lock): the pose runs, the planted foot only travels as far as the runner moves.
- `runner.ts` + `body.ts` — no assets: the body and clothes are SDFs meshed with surface nets and skinned to a `THREE.Skeleton` (clothes copy the nearest skin vertex's weights); legs use two-bone IK driven by cadence, GCT, vertical oscillation, speed and grade.
- Runner models: `src/replay/assets/runner-female.glb` and `runner-male.glb`, MakeHuman characters (CC0, running clothes CC BY: credited under the view as `RUNNER_CREDIT`) in a lean runner's build with one `heavy` morph target (rebuild and license notes: `scripts/runner-model/`), imported lazily with `?inline` (`assetsInclude: ["**/*.glb"]` in both Vite configs) and decoded without fetch. The replay data carries `athlete` (sex, height, weight from Garmin user settings, `parseAthlete`): "Me" (default) picks the sex, sets the morph from BMI (`heavyInfluence`: BMI 19 → 0, 34 → 3, extrapolated since MakeHuman's heaviest build is mild) and scales the runner to the height; F/M override it (remembered in localStorage). `Runner.attachModel` retargets: the procedural skeleton still runs the gait, each game-engine rig bone copies its driver bone's world rotation change from rest; `detachModel` swaps models live. If a model fails to load, the built-in body stays.
- Runner motion: with the asset pack, the trunk and arms play motion capture (CMU, `motion.jog`/`motion.fast`: per-phase curves of arm swing, abduction, elbow, pelvis yaw/roll, chest twist, trunk bounce, from left touchdown; `Runner.useMotion`), blended by the run's cadence; legs stay on cadence/GCT/VO.
- Lighting gotchas: the environment map (reflections + the sky's light) is baked by PMREM from a plain dome in the sky's own colors (`facadeLight.horizon/zenith`, zenith pulled halfway to the horizon) over a warm ground disc, at intensity ~0.2–0.35 — not from `SkyMesh`, whose physically scaled, strongly blue radiance (worst with its sun disc, blurred over the map) washed everything out or turned the shade blue. Keep the dome inside 100 m: PMREM's cube camera doesn't see beyond. The hemisphere light only fills in. Bloom on the HDR pass also washed out; `CSMShadowNode` rendered no shadows, so it's one 2048 shadow map following the runner. Pixel ratio goes up to the screen's own (2), lowered by `adaptQuality` only after the detail level.
- Asset pack (`scripts/assets/README.md`): CC0 scans (Poly Haven, ambientCG), sky photos, models and CMU motion, ~20 MB, not in `app.html`. The server serves each file via the app-only `garmin-get-replay-asset` (`src/asset-store.ts`: `~/.cache/run-coach/replay-assets`, else downloaded once from the GitHub release `replay-assets-v<n>`, SHA-256 checked against `src/replay-assets.json`, which a test also checks for allowed licenses); `npm run assets:build` builds and installs it locally, `assets:publish` uploads it. The view (`src/replay/assets.ts`, `AssetLibrary`) upgrades the generated look piece by piece as files arrive (`ReplayScene.loadAssets`) and credits what's on screen (`assetCredits`). Decoding never fetches a URL (a host's CSP may block blob:/data:): images via `createImageBitmap` from a Blob, read back unpremultiplied through an offscreen WebGL 2 context (a 2D canvas premultiplies alpha, and the packs keep height/AO there); GLB images via a GLTFLoader plugin doing the same.
- Surfaces (`src/replay/surfaces.ts`): texture arrays (`GROUND_IDS`, `WALL_IDS`, `BARK_IDS`) sampled at world meters, a second sample turned 90° and only 1.37× larger switched in by a large noise (much larger blurred close up; a 50/50 mix flattens contrast), layers meeting by height maps (`heightBlend`). Ground: the land cover's `surfaceIndex` raster picks each spot's layer (lawn on parks and grass, forest floor, soil on farmland…), rock on slopes, worn patches in green. Roads: OSM `surface` (else a default per class: footway → paving, path → dirt) per vertex. The run's trail takes the surface of the way `mapMatch` snapped it to, and isn't drawn on pavement. Scans' roughness is clamped up (some grass reads 0.27 and glared white toward a low sun).
- Buildings: facade/roof layer from OSM `building:material`/`roof:material`, colour from `building:colour`/`roof:colour`, else usual for the kind and region (`inEastAsia`: tiled facades); plain layers are gray detail tinted by the building color.
- Sky light (`src/replay/sky-light.ts`): the two best of seven sky photos for the sun elevation, Garmin's cloud cover and city/open country, the sun clipped out at build time, turned so their bright side faces the real sun, exposure matched to the dome's and white-balanced 60 % toward the drawn sky; their lower half mostly replaced by the warm ground color (a field's green lit balconies from below).
- Furniture and lamps (`src/replay/furniture.ts`): only what OSM maps (street lamps, signals, benches, bins, hydrants, fountains, bollards; `RunMap.furniture`) plus lamps every 28 m along ways tagged `lit=yes`; scanned models where the pack has them. At night lamps splat pools into a 256 m light map around the camera (`lampAt`, used by ground, roads, trail and grass) and their heads glow. Dev UI `?hour=21` replays a run as if it started at that hour.
- Grass and flowers: with the pack, blades are cut from a scanned atlas and flowering plants (`flowers.ts`) grow in clusters on mapped grass. Three.js frees every buffer a disposed geometry's draws used, the instance matrix included: replace an instanced mesh whole rather than swapping its geometry.
- Demo runs have GPS (`src/demo/route.ts`: a 400 m track for intervals, a seeded loop otherwise) and running dynamics.

**Real map (opt-in).** With `realMap` on (`run-coach-settings.json` next to the tokens; the view asks for consent first and toggles it through the app-only `garmin-run-map-settings`), the app-only `garmin-get-run-map` builds `RunMap` (`src/geo/`) on the server — the view itself never fetches anything:

- `dem.ts` — AWS Terrain Tiles (Terrarium PNGs, decoded by the zlib-only `png.ts`), resampled to two height grids in local meters around the first GPS fix (fine over the route at z≤14, coarse to the horizon at z≤11), sent as base64 Int16 decimeters.
- `osm.ts` — one Overpass query (roads/paths with surface, buildings with heights, land cover, water, rivers) → classified features in local meters; skipped above 120 km².
- `fetch.ts` — disk cache in `~/.cache/run-coach` (`RUN_COACH_CACHE`), elevation forever, OSM 30 days; polite User-Agent; a second Overpass endpoint as fallback.
- View: with a DEM, `buildTrack` takes the path's height from the real ground (the HUD keeps the watch's elevation), `buildTerrain` uses the DEM instead of generated hills, `map-layers.ts` drapes roads, lays lakes/rivers, extrudes buildings and rasterizes land cover into a texture the ground shader samples. Credits ("© OpenStreetMap contributors", elevation sources) are shown under the view whenever real data is on screen. Without the setting (or GPS), the landscape is generated and labelled illustrative.
- Tests: `tests/geo.test.ts` (PNG filters, Terrarium decoding, tile math, Overpass classification); the network tool is excluded from `tools.test.ts`.
- Overpass needs an explicit `Accept` header (406/500 without it); the query is a corridor (`around:`) along the simplified route, not a bounding box.
- With a real map: the path height comes from the DEM (barometric elevation drifts metres), the route is snapped onto OSM ways (`map-match.ts`: nearest way within 18 m, preferring foot paths and the previous way, offsets smoothed over ±12 m), and buildings the snapped route still crosses are dropped. The camera is a spring arm: if a fat sight line (±1.2 m) to the runner hits a building, it first rises over the roofs, then pulls in (`avoidBuildings`). The steered camera (`desired`: user drag + chase) is kept apart from the drawn one and collisions are measured from it; pushing the real camera and letting the chase ease back from there made it shake.
- Buildings (`src/replay/facade.ts`): one merged mesh, no textures. The server classifies each OSM building (`kind`: house/apartments/shop/office/industrial/civic/shed, from `building=*`, then `shop`/`office`/`amenity`, then height) and passes `building:levels`; walls run corner to corner (turns > 25°) with a whole number of window bays each, and the shader draws floors, framed windows, rooms behind the glass (interior mapping), weathering, shop fronts with sign bands, the sky in the glass (`facadeLight.horizon/zenith`) and lit rooms at night (`facadeLight.night`, set in `updateSun`; each room is lit from a lamp under its ceiling, by day from the window). Four-cornered footprints get gabled/hipped/pyramidal roofs from OSM `roof:shape`, or "pitched" for buildings mapped as houses (a small `building=yes` is often a flat-roofed block, so it isn't assumed). Buildings within 150 m of the route (`terrain.distanceAt`) may get balconies on their long walls, one instanced mesh capped at 20,000 (their windows become doors). Filter widths for the window pattern must come from continuous coordinates (`fwidth(v)`, not `fwidth(fract(…))`): the jump at each floor line leaked slivers of window light.
- Ground decals (worn trail, roads, water) use `drape()` (`src/replay/drape.ts`): vertices pulled toward the camera along the view ray (0.1–0.18 m + 0.25 % of distance), so they win the depth test over terrain bulges and far-away precision without moving on screen; the base offset sets the stacking order. No pull within ~1–2 m of the runner (`drapeKeepOut`): it put the decal in front of the feet standing on it. Don't enable `reversedDepthBuffer` — it broke terrain and shadows.
- The route isn't drawn on the ground (ribbons were cut by terrain and sank into it): behind the runner it's a glowing wake at hip height colored by the chosen metric, fading over 45 m with air streaks spiraling around it (`glow-trail.ts`), and from afar a line drawn over everything (no depth test). The runner never sinks: after posing, `Runner.soleDeficit` checks heels and toes against the drawn ground (+3.5 cm for road lift) and the scene lifts the runner by it; foot placement uses the drawn ground's slope, not the watch's barometric grade.
- Grass (`src/replay/grass.ts`): instanced tufts of curved blades around the camera only (55 m × quality), in world-fixed 10 m chunks generated on demand and cached (≤10 new per update), one draw. Where and how tall from `LandCover.kindAt` (a CPU raster of the OSM land kinds): turf 5–15 cm on parks/pitches, meadow 20–50 cm on grass and unmapped green, never above ~0.6 m; none under snow, on steep ground, or where `groundBlocker` (`map-match.ts`: run path ±1.15 m, roads/rivers by half width, building footprints) says built/worn. Shader: per-instance attributes (`aPos`, `aShape`), root→tip colors in two variants by noise patches, travelling gusts (`grassLight.wind` from the run's wind), normals tilted up, shrink-out at the radius edge. Doesn't cast shadows.
- Close trees are leaf-card crowns (`leafyBroadleaf`): limbs, a dark core and ~120 alpha-tested cards cut by a generated four-sprig leaf atlas, normals from the crown center. The atlas has an opaque corner the trunk and core sample — at the canvas's top right, since CanvasTexture flips Y on upload (at the bottom it cut the trunks away).
- Trees (`src/replay/trees.ts`): OSM `natural=tree` nodes and `tree_row` ways (a tree every 7 m), kind from `leaf_type`/genus (broadleaf, conifer, palm; a genus group rides in the kind value's upper bits, `TREE_GENUS`), height when mapped. Within ~60 m, with the pack, trees are grown by EZ-Tree (`ez-trees.ts`, MIT, vendored in `vendor/ez-tree` with imports on `three/webgpu` so three isn't bundled twice; its own textures aren't used) and dressed by genus (maple leaves on Acer, camphor bark on Cinnamomum…); trees within 1.6 m of the snapped path are dropped (`treesOffPath`). Procedural instanced shapes, near and far versions per kind (six draws), buffers refilled from precomputed matrices at most 4× a second; only near trees cast shadows. OSM tree coverage varies a lot by city (Taipei is sparse); Taipei's open street-tree reports are counts only, no positions.
- Cloud shadows (`src/replay/clouds.ts`): a generated tileable noise field drifting with the run's wind (in replay time), applied to every shadow-receiving material through `receivedShadowNode`, so it dims only the sunlight. Water (`waterMaterial` in `map-layers.ts`): ripples from the same noise, faded with distance, Fresnel sky reflection from `facadeLight`'s sky colors, sun glint from low roughness.
- Coarse terrain chunks: anything placed on the ground must use `heightAt` (it samples the triangles as drawn, `Grid.sampleDrawn`), not the full-resolution lattice, or it floats/sinks between chunk vertices.

### Adding a new chart

1. Create `src/my-chart.tsx` with `export function MyChart({ callTool, args })` (same prop pattern as `StepsChart`); anchor dates on `anchorDate(args)`
2. Add `"my-view"` to `VALID_VIEWS` in `src/app.tsx` (and to the dev UI's all-charts set)
3. Add the conditional render: `{visibleCharts?.has("my-view") && <MyChart callTool={callTool} args={toolArgs} />}`
4. In `src/tools/data.ts`, pass `"my-view"` and the arguments to `withAuth()` for the relevant tool
5. Add `src/my-chart.tsx` to `tsconfig.json` exclude list and `tsconfig.app.json` include list

### Dev UI vs Claude Desktop

The `__DEV_UI__` compile-time flag (set in `vite.config.dev.ts`) controls the default:

- **`npm run dev:ui`** → `__DEV_UI__ = true` → all charts shown immediately (no host tool calls)
- **`npm run dev:ui` with `?tool=<name>&args=<json>`** → simulates Claude calling that tool: the real tool runs and its result is delivered to the app like Claude Desktop does, so routing and args can be tested in a browser, e.g. `http://localhost:5173/?tool=get-activity-splits&args={"activityId":123}`
- **Production build** → `__DEV_UI__ = false` → `visibleCharts` starts as `null`, waits for the tool result

## MCP App in Claude Desktop

### Testing with Claude Desktop

`npm run dev` works with Claude Desktop — it watch-builds both `dist/app.html` (Vite) and `dist/index.js` (esbuild). After changes, use **Developer > Reload MCP Configuration** in Claude Desktop to restart the server process. To trigger the MCP App UI, ask Claude to use any Garmin tool (e.g. "show my steps").

### Debugging

**Server logs:** `~/Library/Logs/Claude/mcp-server-garmin-mcp.log` — shows all JSON-RPC messages between Claude Desktop and the MCP server. Key things to look for:

- `resources/read` response — verify `app.html` content has JS (64K+, not just 16K of CSS)
- `_meta.ui.csp` — verify CSP domains are included in the response
- `tools/call` from the app (e.g. `garmin-check-auth`) — confirms the React app connected via `useApp()`

**Client-side errors:** Enable Developer Mode (Help > Troubleshooting), then open DevTools (Cmd+Option+I). Check Console for:

- CSP violations (`connect-src`, `script-src`) — the app must not load anything external; the resource declares no CSP domains

### Build: Vite singlefile, fully bundled

`vite-plugin-singlefile` inlines all JS/CSS — React, Recharts and ext-apps included — into one self-contained `dist/app.html` (~1 MB). The `flattenAppHtml` Vite plugin moves `dist/src/app.html` → `dist/app.html` after each build (including watch mode).

**Gotchas:**

- Don't externalize dependencies to a CDN (esm.sh etc.): ChatGPT's sandbox is stricter, and the old esm.sh setup also caused `z.custom is not a function` Zod mismatches for ext-apps. If something external is ever unavoidable, declare its domain in the resource `_meta.ui.csp` (`resourceDomains` + `connectDomains`, see `src/server.ts`).

## Naming and trademarks

The user-facing product name is **Run Coach** (Claude extension `display_name`, ChatGPT marketplace name, MCP server `title`); the ChatGPT plugin itself is **Coach**, because its `displayName` is also the composer @-mention (`@Coach`) — never "Garmin" alone, which would imply an official Garmin product. Describing compatibility is fine ("Connected to Garmin", "for Garmin users"). Don't use Garmin's logo or artwork (the icon is an original generic watch). Keep the disclaimer in the README and plugin/extension descriptions: "Unofficial. Not affiliated with or endorsed by Garmin. Garmin is a trademark of Garmin Ltd." Internal IDs (`garmin-mcp`, plugin `garmin`, repo name) stay for compatibility.

## ChatGPT plugin (openai/mcp-extensions)

The same server and UI also run as a **local ChatGPT desktop plugin** (Codex plugin format). ChatGPT-specific metadata is additive and ignored by Claude Desktop; it lives in `src/tools/openai.ts`:

- **Entrypoints** (`_meta["openai/ui"].entrypoints`): `get-daily-briefing` and `show-performance-dashboard` are sidebar items (`global`, open fullscreen), `show-training-week` is a thread tab (`thread`). Entrypoint tools MUST accept `{}`, have a `title` (shown as the label) and `icons` (monochrome `currentColor` SVG, 20×20). `registerAppTool`'s config type lacks `icons`, but it forwards the config — spread `entrypointIcons`.
- **Display modes**: the UI resource declares `_meta["openai/ui"].availableDisplayModes: ["inline", "fullscreen"]`.
- **Host-neutral UI**: never hardcode "Claude" in user-visible text. `useAppActions().assistantName` comes from the host (`app.getHostVersion()`): "Claude", "ChatGPT", or null → plain "Ask". Preview in the dev UI with `?host=ChatGPT`.
- **Packaging**: `npm run pack:chatgpt` builds, assembles `build/chatgpt-plugin/` and validates it — a marketplace (`.agents/plugins/marketplace.json`, name `garmin-mcp`) with plugin `garmin` in the **root Agent Plugins format**: `plugin.json` (identity at the top level, ChatGPT presentation and `onboardingSkill` under `extensions["com.openai"]`), `mcp.json` (stdio server `node ./dist/index.js`, `cwd` must start with `./` or `${PLUGIN_ROOT}`), skills auto-discovered from `skills/`, icons from `plugin/assets`. `scripts/validate-chatgpt-plugin.mjs` checks both manifests against the vendored schemas in `scripts/schemas/` (also in CI). The older `.codex-plugin/plugin.json` layout is only a fallback — don't reintroduce it. Local MCP servers make it **Desktop only**. Users need Node 20+ on PATH (ChatGPT, unlike Claude Desktop's `.mcpb`, doesn't bundle Node).
- **Release**: the `chatgpt-plugin` job in `release-please.yml` publishes the packed folder to the `chatgpt-plugin` branch on each release.
- **Marketplace pointer on main**: `.agents/plugins/marketplace.json` (committed) lists plugin `garmin` with a git `url` source — `ref: "chatgpt-plugin"`, `path: "plugins/garmin"` — so users add just the repo (no ref) and get the latest _released_ build, while `main` holds no built files. (Verified with the Codex CLI: `url` sources honour `path` and `ref`; `github`/`git` source types list nothing.) `validate-chatgpt-plugin.mjs` fails if the pointer drifts from the packed layout. Until the first release publishes the branch, installing from the repo fails.
- **Install**: ChatGPT desktop → Settings → Plugins → **Add marketplace** (source `chenhunghan/garmin-mcp-app`, no ref), restart, install **Coach**; or `codex plugin marketplace add chenhunghan/garmin-mcp-app` + `codex plugin add garmin@garmin-mcp`. To test a local build: same dialog with source = the absolute path of `build/chatgpt-plugin`. Don't add a source branch as the marketplace ref — only `chatgpt-plugin` has the built `dist/`.
- Spec: https://github.com/openai/mcp-extensions/blob/main/docs/spec.md (v0.1, moving fast). We don't depend on `@openai/mcp-extensions` (it pins ext-apps 1.x / MCP SDK v1); the keys are hand-written.

### Reference implementation

[excalidraw/excalidraw-mcp](https://github.com/excalidraw/excalidraw-mcp) — well-maintained MCP App with a similar architecture (Vite singlefile). Useful to compare when debugging Claude Desktop rendering issues.
