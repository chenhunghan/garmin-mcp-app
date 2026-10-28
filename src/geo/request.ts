import type { GeoFetchOptions } from "../deps.js";

export const USER_AGENT = "RunCoach/1.0 (+https://github.com/chenhunghan/garmin-mcp-app)";

/** One request to a public map service, as both map caches send it. */
export async function geoRequest(url: string, opts: GeoFetchOptions = {}): Promise<Uint8Array> {
  const res = await fetch(url, {
    method: opts.body ? "POST" : "GET",
    headers: {
      "User-Agent": USER_AGENT,
      // Overpass rejects requests without an explicit Accept (406/500)
      Accept: "application/json, image/png;q=0.9, */*;q=0.5",
      ...(opts.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: opts.body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
