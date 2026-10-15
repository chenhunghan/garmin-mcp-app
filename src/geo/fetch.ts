/**
 * HTTP for public map services, with a disk cache (~/.cache/run-coach) so an
 * area is fetched once: elevation tiles never change, OSM data is kept 30 days.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const USER_AGENT = "RunCoach/1.0 (+https://github.com/chenhunghan/garmin-mcp-app)";

function cacheDir() {
  return process.env.RUN_COACH_CACHE ?? join(homedir(), ".cache", "run-coach");
}

export async function cachedFetch(
  url: string,
  opts: { body?: string; maxAgeDays?: number; timeoutMs?: number } = {},
): Promise<Uint8Array> {
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
  const buf = new Uint8Array(await res.arrayBuffer());
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, buf);
  } catch {
    // Caching is best-effort
  }
  return buf;
}
