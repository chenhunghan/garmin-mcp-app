/**
 * Demo mode (`npm run dev:ui:demo`): the in-process MCP server talks to a
 * fictional Garmin account instead of the real one. MSW answers every request
 * to connectapi.garmin.com from the demo world; any other garmin.com request
 * fails as a network error, so nothing ever reaches Garmin. The client uses
 * fake tokens in a temporary directory, never ~/.garminconnect.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { handleDemoRequest } from "./garmin-api.ts";

const GARMIN_HOST = /^https?:\/\/([^/]+\.)?garmin\.com(:\d+)?\//;

export function demoHandlers() {
  return [
    http.all("https://connectapi.garmin.com/*", async ({ request }) => {
      const url = new URL(request.url);
      const body =
        request.method === "POST" || request.method === "PUT"
          ? await request.json().catch(() => null)
          : undefined;
      const res = handleDemoRequest(request.method, url, body);
      if (res.status === 404) {
        console.warn(`[demo] no demo data for ${request.method} ${url.pathname}${url.search}`);
      }
      if (res.body === undefined) return new HttpResponse(null, { status: res.status });
      return HttpResponse.json(res.body as object, { status: res.status });
    }),
    // Sign-in, token exchange and anything else on Garmin: never leaves the machine
    http.all(GARMIN_HOST, ({ request }) => {
      console.error(`[demo] blocked request to Garmin: ${request.method} ${request.url}`);
      return HttpResponse.error();
    }),
  ];
}

/** MSW server answering Garmin from the demo world. */
export function createDemoServer() {
  return setupServer(...demoHandlers());
}

/** Token files the client can resume from without signing in (never expire). */
export function writeDemoTokens(dir: string) {
  const far = Math.floor(Date.now() / 1000) + 10 * 365 * 86_400;
  writeFileSync(
    join(dir, "oauth1_token.json"),
    JSON.stringify({ oauth_token: "demo", oauth_token_secret: "demo", domain: "garmin.com" }),
  );
  writeFileSync(
    join(dir, "oauth2_token.json"),
    JSON.stringify({
      access_token: "demo-access-token",
      token_type: "Bearer",
      refresh_token: "demo-refresh-token",
      expires_in: 3600,
      expires_at: far,
      refresh_token_expires_in: 3600,
      refresh_token_expires_at: far,
    }),
  );
}

const state = globalThis as { __garminDemo?: { dir: string } };

/**
 * Start demo mode once per process (Vite may re-evaluate modules): fake
 * tokens in a temp dir, and Garmin answered by the demo world.
 */
export function startDemoMode(): void {
  if (state.__garminDemo) return;
  const dir = mkdtempSync(join(tmpdir(), "garmin-demo-"));
  writeDemoTokens(dir);
  // Read by getClient() on first use: the demo never touches ~/.garminconnect
  process.env.GARMIN_TOKEN_PATH = dir;
  createDemoServer().listen({
    onUnhandledRequest: (request, print) => {
      if (GARMIN_HOST.test(request.url)) print.error();
    },
  });
  state.__garminDemo = { dir };
  console.log(
    "[demo] Demo mode: Garmin is answered with a fictional athlete's data (no requests leave this machine)",
  );
}
