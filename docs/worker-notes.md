# Self-hosted Worker: design notes

Run Coach also runs as a single-tenant Cloudflare Worker that each user deploys
to their own account (Deploy button → `wrangler.jsonc` at the repo root). It
serves the same `createServer()` as the stdio build, with `remoteDeps()` instead
of `localDeps()`. The stdio channels (`.mcpb`, ChatGPT desktop plugin, npm,
MCP Registry) are unchanged: `dist/` is still stdio-only and a test checks that
the stdio bundle contains nothing from `src/worker/`.

## Layout

| File | Role |
| --- | --- |
| `src/deps.ts` | `ServerDeps`: everything that depends on where the server runs. Tools never import a Garmin client, `node:*` or local-only modules (`tests/deps.test.ts`). |
| `src/local-deps.ts` | stdio: `~/.garminconnect`, `~/.cache/run-coach`, in-memory login key, `waitForAuth`. |
| `src/worker/index.ts` | `OAuthProvider` (per request origin) → `/mcp` (`createMcpHandler`, stateless), `/authorize`, `/signin`, `/`. |
| `src/worker/vault.ts`, `vault-do.ts` | All state in one SQLite Durable Object (`idFromName("owner")`), sealed with AES-GCM. Plain class + thin DO wrapper, so it's unit-tested in Node. |
| `src/worker/authorize.ts` | Passphrase → Garmin email/password → MFA; one-time `/signin` links reuse the Garmin steps. |
| `src/worker/signin.ts` | Signs in with in-memory tokens, checks the Garmin `profileId` against the recorded owner, only then saves to the vault. |
| `src/worker/deps.ts` | `remoteDeps()`: vault token storage, Cache API caches, app from `ASSETS`, request budget 40, time zone. |

## Decisions taken while implementing

- **OAuth provider 1.2 needs an absolute `resourceMetadata.resource`**, but every
  deployment has its own URL. The provider is built per request origin
  (`${origin}/mcp`), as its migration guide suggests for multi-hostname Workers.
- **Grant lifetime:** refresh tokens idle out after 60 days (`refreshTokenIdleTTL`),
  so a connector that's used never has to reconnect.
- **CIMD on** (`global_fetch_strictly_public` + `clientIdMetadataDocumentEnabled`)
  next to dynamic client registration.
- **The Garmin step is skipped** at `/authorize` when the vault already has
  tokens: connecting a second client (ChatGPT after Claude) needs only the passphrase.
- **Browser binding:** each sign-in is a vault record keyed by a random id in
  the form, plus a `__Host-` cookie whose SHA-256 is stored with it. The pages
  show the client's name and redirect host (from `describeConsent`); a
  registered client's name is marked "not verified" (only a CIMD domain is),
  and a redirect host other than Claude's or ChatGPT's gets a warning.
- **Nothing written for strangers:** before the passphrase is right (or, for a
  one-time link, the owner's Garmin sign-in succeeded) a visit only creates its
  10-minute sign-in record. The browser's time zone rides in that record and
  is saved when the sign-in finishes.
- **Rate limits in the vault, per IP (hashed):** wrong passphrases lock out the
  IP that sent them, not the owner (5 per 15 min); starting sign-ins (20 per
  10 min); client registrations (10 per hour per IP, 50 a day in all — each
  writes to KV, whose free plan allows 1,000 writes a day that token refreshes
  also need).
- **One-time links are used up by signing in, not by opening them:** link
  previews, scanners and reloads would otherwise spend them.
- **Switching the Garmin account:** the first account to sign in becomes the
  owner. On `/authorize` (passphrase already checked) signing in with another
  account offers to switch to it; a one-time link refuses it.
- **A changed TOKEN_ENCRYPTION_KEY** makes the sealed records unreadable: they're
  dropped (sign in to Garmin again), while a missing or short key fails loudly
  and the landing page says so.
- **`form-action` must include the client's redirect origin**: browsers apply it
  to the redirect after the last form POST, which goes to claude.ai/chatgpt.com.
- **Sign-in through the AuthAdapter.** `garmin-login`/`garmin-submit-mfa` call
  `deps.auth.login/submitMfa`; remotely the tokens must not reach the vault before
  the owner check, so the login can't go through the shared client.
- **Remote `waitForSignIn` throws `SignInRequiredError`**; `withAuth` turns it into
  the existing `not_authenticated` error (the app shows its form) with the
  one-time link in the text. Data-only tools and workout tools put the link in
  their message.
- **Token refresh is serialized in the vault:** `freshTokens()` refreshes an
  expiring OAuth2 token once for concurrent requests.
- **Time zone:** Workers run in UTC, so "today" (briefing, dashboard, training
  week) would be wrong for most users. The owner's browser time zone
  (`request.cf.timezone`) is recorded whenever they open `/authorize` or a
  sign-in link; MCP requests come from Claude's/OpenAI's servers, so they can't
  be used for this.
- **`resourceMeta` / Claude `ui.domain`: not sent.** The app makes no network
  requests and is fully self-contained, so it needs no dedicated origin; the
  resource keeps `resourceDomains: []`, `connectDomains: []`.
- **Free-plan limits:** the dashboard fetches the metrics whose worst-case
  requests fit in 40 (`metricRequests`: one per 28-day page for paged metrics,
  shared sleep pages counted once) and returns the rest in `deferred`, which the
  view requests next. `app.html` is decoded once per isolate. The replay's real map is off
  (`realMapUnavailable`): it fans out to dozens of tile requests and decodes them
  on the CPU. Moving it into the browser is future work (needs CSP `connectDomains`).
- **Cache API is best-effort:** on `*.workers.dev` it stores nothing, so map data
  and replay assets are fetched each time (assets from the GitHub release,
  SHA-256 checked).
- **Tests run in Vitest 5:** `@cloudflare/vitest-pool-workers` needs Vitest 4, so
  `tests/worker/` bundles the Worker with `wrangler deploy --dry-run` and runs it
  in Miniflare (via `convertV4MiniflareOptions`; wrangler 4.15x ships Miniflare 5
  beta) with a fake Garmin as `outboundService`.
- **Typecheck:** `tsconfig.worker.json` uses workers types plus Node types (the
  client's lazily imported file storage); the Worker's own code imports no
  `node:*` (guarded by `tests/deps.test.ts`).
- **OAuth1 signing** moved to WebCrypto (`signRequest`), byte-identical to the
  `createHmac` signatures (tested); `FileTokenStorage` is loaded lazily and
  exported from `garmin-connect/node`.

## Verified (agent)

- S2: `createMcpHandler` + `registerAppResource` in workerd: `tools/list`,
  `resources/read` (app.html from ASSETS) and tool calls over Streamable HTTP
  (`npm run test:worker`).
- S3: Worker script 392 KiB gzipped with `app.html` (6.5 MB) as a static asset;
  CI fails above 3 MB.

## Needs a person (before release)

- [ ] S1: Garmin sign-in (with MFA) works from Cloudflare (`npm run deploy:dev`, then connect).
- [ ] S4: Deploy button from the repo root on a free account without a card (npm workspaces, `npm run build`).
- [ ] S5: UI rendering on Claude web, Claude desktop (remote connector), Claude iOS/Android, ChatGPT web; text fallback everywhere.
- [ ] Wrong passphrase rejected, lockout, second Garmin account rejected (also covered by `test:worker`).
- [ ] Garmin token revoked → sign-in form where the UI renders, working one-time link elsewhere, no reconnect.
- [ ] No tool exceeds the free plan's CPU limit (replay data, briefing), nor
      `resources/read` of the 6.5 MB `app.html` (serializing it took 14–19 ms
      on a laptop; the test serves a stub).
- [ ] `.mcpb` and ChatGPT desktop plugin behave exactly as v0.10.0.
- [ ] Production Worker shows no stored logs; `run-coach-dev` does.
- [ ] Signing in remotely doesn't sign out local clients (separate tokens).

## Later

- Update delivery to deployed copies (manual merge documented in the README; a
  template "Update Run Coach" workflow or a landing-page notice are options).
  Keep `wrangler.jsonc` stable, migrations append-only, never rename bindings or
  `GarminVault`.
- Real map in the browser; hardening the sign-in pages against look-alike sites.
