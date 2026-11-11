/**
 * HTTP for public map services, with a disk cache (~/.cache/run-coach) so an
 * area is fetched once: elevation tiles never change, OSM data is kept 30 days.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GeoFetchOptions } from "../deps.js";
import { geoRequest } from "./request.js";

function cacheDir() {
  return process.env.RUN_COACH_CACHE ?? join(homedir(), ".cache", "run-coach");
}

export async function cachedFetch(url: string, opts: GeoFetchOptions = {}): Promise<Uint8Array> {
  const key = createHash("sha1")
    .update(url)
    .update(opts.body ?? "")
    .digest("hex");
  const dir = cacheDir();
  const file = join(dir, key);
  try {
    const st = await stat(file);
    const ageDays = (Date.now() - st.mtimeMs) / 86_400_000;
    if (opts.maxAgeDays === undefined || ageDays < opts.maxAgeDays) {
      return new Uint8Array(await readFile(file));
    }
  } catch {
    // Not cached
  }
  const buf = await geoRequest(url, opts);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, buf);
  } catch {
    // Caching is best-effort
  }
  return buf;
}
