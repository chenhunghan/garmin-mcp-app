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
- API paths match Python [garth](https://github.com/matin/garth) library — use it as reference for new endpoints

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

**2. Custom colors: define in `app.css` under both `:root` and `[data-theme="dark"]`**

```css
:root {
  --aerobic: oklch(0.58 0.2 265); /* darker for light bg */
}
[data-theme="dark"] {
  --aerobic: oklch(0.65 0.18 265); /* lighter for dark bg */
}
```

Reference in components as `var(--aerobic)`. Use lighter/higher-lightness OKLCH values for dark mode so colors remain visible against dark backgrounds.

**3. ChartConfig + ChartStyle: avoid `--color-` prefix in CSS variable names**

shadcn's `ChartStyle` component auto-generates `--color-{key}: {config.color}` on the chart container. If your CSS variable is also named `--color-{key}`, this creates a circular reference:

```ts
// BAD — ChartStyle generates: --color-aerobic: var(--color-aerobic) → circular → black
const chartConfig = {
  aerobic: { color: "var(--color-aerobic)" },
};

// GOOD — ChartStyle generates: --color-aerobic: var(--aerobic) → resolves correctly
const chartConfig = {
  aerobic: { color: "var(--aerobic)" },
};
```

Name custom CSS variables without the `--color-` prefix (e.g. `--aerobic`, `--anaerobic`, `--success`) so ChartStyle can map them to `--color-aerobic` etc. without collision.

**4. SVG gradients and inline styles: use fallbacks**

SVG `<linearGradient>` elements inside `<ChartContainer>` can reference the ChartStyle-generated `--color-` variable, but add a fallback to the base variable for safety:

```tsx
<stop stopColor="var(--color-aerobic, var(--aerobic))" />
<Bar stroke="var(--color-aerobic, var(--aerobic))" />
```

For HTML elements outside `<ChartContainer>` (legend dots, status indicators), reference the base variable directly:

```tsx
<span style={{ backgroundColor: "var(--aerobic)" }} />
```

**5. Native form elements (`<select>`, `<input>`)**

Native elements like `<select>` have browser-default arrow/dropdown styling. Ensure:

- `text-foreground` is set so text adapts
- `[&>option]:bg-background [&>option]:text-foreground` forces dropdown items to use theme colors
- Do NOT use `appearance-none` unless you provide a custom arrow icon — it removes the native dropdown arrow which becomes invisible in dark mode

**6. Avoid Tailwind color utilities that don't map to CSS variables**

Tailwind utilities like `bg-green-500`, `text-gray-400` are static — they don't adapt to dark mode. Use CSS variables instead:

```tsx
// Bad — green-500 stays the same in dark mode
<span className="bg-green-500" />

// Good — adapts via CSS variable
<span style={{ backgroundColor: "var(--success)" }} />
```

**Quick reference: variable layers**

| Layer                | Example                    | Set by                                    | Scope              |
| -------------------- | -------------------------- | ----------------------------------------- | ------------------ |
| Host variables       | `--color-text-primary`     | `useHostStyles` at runtime                | `<html>`           |
| shadcn variables     | `--foreground`, `--border` | `app.css` `:root` / `[data-theme="dark"]` | `<html>`           |
| Tailwind theme       | `--color-foreground`       | `@theme inline` block                     | Tailwind utilities |
| Custom app variables | `--aerobic`, `--success`   | `app.css` `:root` / `[data-theme="dark"]` | Global             |
| ChartStyle variables | `--color-aerobic`          | `chart.tsx` `<ChartStyle>`                | `[data-chart=...]` |

### Recharts v3 + shadcn compatibility

shadcn's official chart component targets Recharts v2. Since we use Recharts v3, `chart.tsx` is a community-adapted version. Tracking issue and community patches:

- Issue: https://github.com/shadcn-ui/ui/issues/7669
- noxify's gist: https://gist.github.com/noxify/92bc410cc2d01109f4160002da9a61e5
- arolariu's PR-based version (latest): https://github.com/shadcn-ui/ui/pull/8486#issuecomment-3627835576

When shadcn officially ships Recharts v3 support, replace `chart.tsx` with the official version.

## View routing (tool → chart)

All tools share a single `ui://garmin-mcp/app.html` resource. The app uses `structuredContent.view` in tool responses to decide which chart to render.

### How it works

1. **Server** (`src/tools/data.ts`) — pass a `view` string to `withAuth()`:

   ```ts
   async ({ date, endDate }) => withAuth(() => getClient().getSteps(date, endDate), "steps"),
   ```

   This adds `structuredContent: { view: "steps" }` to the tool response.

2. **App** (`src/app.tsx`) — `ontoolresult` reads `structuredContent.view` and sets `visibleCharts`:

   ```ts
   app.ontoolresult = (params) => {
     const view = params.structuredContent?.view;
     if (typeof view === "string" && VALID_VIEWS.has(view)) {
       setVisibleCharts(new Set([view]));
     }
   };
   ```

3. **Render** — charts conditionally render based on `visibleCharts`:
   ```tsx
   {
     visibleCharts?.has("steps") && <StepsChart />;
   }
   {
     visibleCharts?.has("activities") && <ActivitiesChart />;
   }
   ```

### Adding a new chart

1. Create `src/my-chart.tsx` with `export function MyChart({ callTool })` (same prop pattern as `StepsChart`)
2. Add `"my-view"` to `VALID_VIEWS` in `src/app.tsx`
3. Add the conditional render: `{visibleCharts?.has("my-view") && <MyChart callTool={callTool} />}`
4. In `src/tools/data.ts`, pass `"my-view"` to `withAuth()` for the relevant tool
5. Add `src/my-chart.tsx` to `tsconfig.json` exclude list and `tsconfig.app.json` include list

### Dev UI vs Claude Desktop

The `__DEV_UI__` compile-time flag (set in `vite.config.dev.ts`) controls the default:

- **`npm run dev:ui`** → `__DEV_UI__ = true` → all charts shown immediately (no host tool calls)
- **Production build** → `__DEV_UI__ = false` → `visibleCharts` starts as `null`, waits for `ontoolresult`

Tools without a `view` tag don't change which charts are visible. If no `ontoolresult` with a view ever fires (e.g. tool has no view), no charts are shown in Claude Desktop.

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
