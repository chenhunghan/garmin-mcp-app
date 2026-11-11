/**
 * Server side of the replay's asset pack: a file is read from the local cache
 * (~/.cache/run-coach/replay-assets), else downloaded once from the pack's
 * GitHub release; either way it must match the manifest's SHA-256. The view
 * never fetches anything itself.
 *
 * RUN_COACH_ASSETS=off disables downloading (only cached files are served);
 * RUN_COACH_ASSETS_URL points at another copy of the release.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ASSET_RELEASE, assetFile } from "./replay-assets.js";
import { USER_AGENT } from "./geo/request.js";

export function assetDir() {
  return join(
    process.env.RUN_COACH_CACHE ?? join(homedir(), ".cache", "run-coach"),
    "replay-assets",
  );
}

function releaseUrl() {
  return (
    process.env.RUN_COACH_ASSETS_URL ??
    `https://github.com/chenhunghan/garmin-mcp-app/releases/download/${ASSET_RELEASE}/`
  );
}

const sha256 = (buf: Uint8Array) => createHash("sha256").update(buf).digest("hex");

/** Downloads in flight, so parallel requests for one file share it */
const pending = new Map<string, Promise<Uint8Array>>();

export async function readAsset(
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  const f = assetFile(name);
  if (!f) throw new Error(`Unknown asset ${name}`);
  const path = join(assetDir(), name);
  try {
    const buf = new Uint8Array(await readFile(path));
    if (sha256(buf) === f.sha256) return buf;
  } catch {
    // Not cached yet
  }
  if (process.env.RUN_COACH_ASSETS === "off") throw new Error("Asset downloads are off");
  let p = pending.get(name);
  if (!p) {
    p = (async () => {
      const res = await fetchImpl(new URL(name, releaseUrl()).toString(), {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`Asset download failed: ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (sha256(buf) !== f.sha256) throw new Error(`Asset ${name} failed its checksum`);
      try {
        await mkdir(assetDir(), { recursive: true });
        await writeFile(path + ".part", buf);
        await rename(path + ".part", path);
      } catch {
        // Caching is best-effort
      }
      return buf;
    })().finally(() => pending.delete(name));
    pending.set(name, p);
  }
  return p;
}
