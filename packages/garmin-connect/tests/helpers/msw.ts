import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { Exchange } from "../live/sanitize.ts";
import type { LiveContext } from "../live/endpoints.ts";
import type { TokenStorage } from "../../src/index.ts";

const FIXTURES = join(import.meta.dirname, "../fixtures");

/** Method + URL with sorted query params, so param order doesn't matter. */
function key(method: string, url: string): string {
  const u = new URL(url);
  u.searchParams.sort();
  return `${method.toUpperCase()} ${u.origin}${u.pathname}?${u.searchParams}`;
}

export function loadFixtures(): Record<string, Exchange[]> {
  const out: Record<string, Exchange[]> = {};
  for (const f of readdirSync(FIXTURES)) {
    if (f.endsWith(".json") && !f.startsWith("_")) {
      out[f.slice(0, -5)] = JSON.parse(readFileSync(join(FIXTURES, f), "utf-8"));
    }
  }
  return out;
}

export function loadContext(): LiveContext {
  return JSON.parse(readFileSync(join(FIXTURES, "_context.json"), "utf-8"));
}

/** MSW server answering every captured Garmin request with its fixture. */
export function garminMockServer() {
  const byKey = new Map<string, Exchange>();
  for (const exchanges of Object.values(loadFixtures())) {
    for (const e of exchanges) byKey.set(key(e.method, e.url), e);
  }
  return setupServer(
    http.all("https://connectapi.garmin.com/*", ({ request }) => {
      const e = byKey.get(key(request.method, request.url));
      if (!e) {
        return HttpResponse.json(
          { error: `No fixture for ${request.method} ${request.url}` },
          { status: 501 },
        );
      }
      if (e.status === 204 || e.body === null) return new HttpResponse(null, { status: e.status });
      return HttpResponse.json(e.body as object, { status: e.status });
    }),
  );
}

/** Token storage with valid, non-expiring fake tokens. */
export function fakeTokenStorage(): TokenStorage {
  const far = Math.floor(Date.now() / 1000) + 365 * 86_400;
  return {
    load: async () => ({
      oauth1: { oauth_token: "t", oauth_token_secret: "s", domain: "garmin.com" },
      oauth2: {
        access_token: "fake-access-token",
        token_type: "Bearer",
        refresh_token: "r",
        expires_in: 3600,
        expires_at: far,
        refresh_token_expires_in: 3600,
        refresh_token_expires_at: far,
      },
    }),
    save: async () => {},
    clear: async () => {},
  };
}
