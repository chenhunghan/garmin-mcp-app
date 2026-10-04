# Garmin MCP App

MCP App server with interactive React UI for Garmin Connect integration.

## Architecture

- **MCP Server** (`src/server.ts`) — Node.js server over stdio, registers tools + UI resource
- **React UI** (`src/app.tsx`) — Rendered in host's sandboxed iframe, communicates via `postMessage`
- **garmin-connect** (`packages/garmin-connect/`) — TypeScript client library for Garmin Connect OAuth + API

The host (e.g. Claude Desktop) brokers all communication: Server ←stdio→ Host ←postMessage→ App iframe.

## Key concepts

- `ui://` URIs are opaque identifiers, not real URLs — the host fetches them as MCP resources
- `vite-plugin-singlefile` inlines all app JS/CSS into `dist/app.html`; React + Recharts loaded from `esm.sh` CDN at runtime via import maps; `@modelcontextprotocol/ext-apps` is bundled (not CDN) to avoid Zod version mismatches
- Tools declare `_meta.ui.resourceUri` to link a UI to a tool invocation
- App ↔ Server communication: `app.callServerTool()` (app-initiated) and `app.addEventListener("toolresult", …)` (server-pushed)
- SDK: `@modelcontextprotocol/ext-apps` 2.x on the split MCP SDK 2.x packages — `McpServer` / `StdioServerTransport` from `@modelcontextprotocol/server`, `Client` / `InMemoryTransport` from `@modelcontextprotocol/client` (the old `@modelcontextprotocol/sdk` package is not used). Tool `inputSchema` / prompt `argsSchema` are `z.object(...)` (raw shapes are deprecated, removed in 3.0). Node 20+.
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
- **[Recharts v3](https://recharts.org)** — charting library, externalized to esm.sh CDN
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

   This adds `structuredContent: { view: "sleep", args: { date } }` to the tool response. Several tools can share a view (e.g. `get-hrv` and `get-training-status` → `training`; `get-body-battery` → `heart-rate`; `get-vo2-max` → `race-predictions`; all workout tools → `workouts`).

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

Dates: use `formatDate`/`parseDate` from `src/lib/dates.ts` (local calendar days). Never `toISOString().slice(0, 10)` — it prints UTC and lands on the previous day east of UTC.

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

- CSP violations (`connect-src`, `script-src`) — indicates missing CSP domains
- `Failed to resolve module specifier` — missing import map entry
- Runtime errors from esm.sh dependencies — may need to bundle instead of externalize

### Build: Vite singlefile + esm.sh externals

The app uses `vite-plugin-singlefile` to inline JS/CSS into `dist/app.html`. Heavy dependencies (React, Recharts) are externalized and loaded from `esm.sh` CDN at runtime via import maps in `src/app.html`. The `flattenAppHtml` Vite plugin moves `dist/src/app.html` → `dist/app.html` after each build (including watch mode).

**Gotchas:**

- `src/app.html` import map, `vite.config.ts` externals, and `vite.config.ts` output.paths must stay in sync
- DO NOT externalize `@modelcontextprotocol/ext-apps/react` to esm.sh — it pulls in Zod which causes `z.custom is not a function` errors due to version mismatches. Bundle it instead.
- Any CDN domain used in import maps must be declared in the resource `_meta.ui.csp` with both `resourceDomains` and `connectDomains` (see `src/server.ts`)

### Reference implementation

[excalidraw/excalidraw-mcp](https://github.com/excalidraw/excalidraw-mcp) — well-maintained MCP App with similar architecture (Vite singlefile + esm.sh externals). Useful to compare when debugging Claude Desktop rendering issues.
