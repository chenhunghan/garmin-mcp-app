/**
 * The Worker's stand-ins for the local disk caches (~/.cache/run-coach): the
 * Cache API of the data center serving the request. Best-effort: on a
 * workers.dev hostname the Cache API stores nothing, so every call fetches.
 */
import type { GeoFetchOptions } from "../deps.js";
import { geoRequest, USER_AGENT } from "../geo/request.js";
import { ASSET_RELEASE, assetFile } from "../replay-assets.js";

const ASSET_URL = `https://github.com/chenhunghan/garmin-mcp-app/releases/download/${ASSET_RELEASE}/`;

async function hex(algorithm: "SHA-1" | "SHA-256", data: Uint8Array | string) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = new Uint8Array(await crypto.subtle.digest(algorithm, bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function cached(
  key: string,
  maxAgeDays: number,
  load: () => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const req = new Request(`https://run-coach.cache/${key}`);
  const cache = await caches.open("run-coach");
  const hit = await cache.match(req);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const buf = await load();
  try {
    const age = Math.round(maxAgeDays * 86_400);
    await cache.put(req, new Response(buf, { headers: { "Cache-Control": `max-age=${age}` } }));
  } catch {
    // Caching is best-effort
  }
  return buf;
}

/** Map data (elevation tiles, Overpass), cached like the local disk cache. */
export async function cacheGeoFetch(url: string, opts: GeoFetchOptions = {}) {
  const key = await hex("SHA-1", `${url}\n${opts.body ?? ""}`);
  return cached(`geo/${key}`, opts.maxAgeDays ?? 365, () => geoRequest(url, opts));
}

/** One file of the replay's asset pack from its GitHub release, checked against the manifest. */
export async function cacheReadAsset(name: string): Promise<Uint8Array> {
  const f = assetFile(name);
  if (!f) throw new Error(`Unknown asset ${name}`);
  return cached(`asset/${f.sha256}`, 365, async () => {
    const res = await fetch(new URL(name, ASSET_URL), {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Asset download failed: ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if ((await hex("SHA-256", buf)) !== f.sha256) {
      throw new Error(`Asset ${name} failed its checksum`);
    }
    return buf;
  });
}
