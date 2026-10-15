/**
 * The replay's asset pack: scanned materials, sky photos, models and motion
 * capture, all CC0 or freely redistributable (`scripts/assets/`). The pack
 * isn't in the app bundle: the server serves its files to the view through
 * an app-only tool, from a local cache filled from a pinned GitHub release.
 * Shared by server and view: the manifest says which files exist, their
 * checksums, and whom to credit.
 */
import pack from "./replay-assets.json" with { type: "json" };

export interface AssetFile {
  name: string;
  bytes: number;
  sha256: string;
}

export interface AssetCredit {
  title: string;
  author: string;
  license: string;
  url: string;
}

export interface AssetEntry {
  id: string;
  kind: "surface" | "atlas" | "sky" | "model" | "motion";
  files: AssetFile[];
  meta: Record<string, unknown>;
  credit: AssetCredit;
}

export interface AssetPack {
  version: number;
  bytes: number;
  assets: AssetEntry[];
}

export const ASSET_PACK = pack as AssetPack;

/** GitHub release the pack's files are published under */
export const ASSET_RELEASE = `replay-assets-v${ASSET_PACK.version}`;

/** Licenses an asset may have (a test checks every entry) */
export const ALLOWED_LICENSES: Record<string, string> = {
  "CC0-1.0": "CC0",
  // "may be copied, modified, or redistributed without permission" (mocap.cs.cmu.edu)
  "CMU-Mocap": "free use, CMU Graphics Lab",
};

const byId = new Map(ASSET_PACK.assets.map((a) => [a.id, a]));
const byFile = new Map(ASSET_PACK.assets.flatMap((a) => a.files.map((f) => [f.name, f] as const)));

export function assetEntry(id: string): AssetEntry | undefined {
  return byId.get(id);
}

export function assetFile(name: string): AssetFile | undefined {
  return byFile.get(name);
}

/** The runner models' clothes under CC BY (scripts/runner-model/README.md); the rest is CC0 */
export const RUNNER_CREDIT = "Runner clothes: Mindfront, punkduck (MakeHuman community, CC BY)";

/**
 * One line naming the sources of the assets on screen, e.g.
 * "Materials, models and sky light: Poly Haven, ambientCG (CC0) · Running motion: mocap.cs.cmu.edu (…)"
 */
export function assetCredits(ids: Iterable<string>): string {
  const sites = new Set<string>();
  let motion = false;
  for (const id of ids) {
    const a = byId.get(id);
    if (!a) continue;
    if (a.credit.license === "CMU-Mocap") motion = true;
    else if (a.credit.url.includes("polyhaven")) sites.add("Poly Haven");
    else if (a.credit.url.includes("ambientcg")) sites.add("ambientCG");
  }
  const parts: string[] = [];
  if (sites.size) parts.push(`Materials, models and sky light: ${[...sites].join(", ")} (CC0)`);
  // (as CMU asks: data from mocap.cs.cmu.edu, created with funding from NSF EIA-0196217)
  if (motion) parts.push("Running motion: mocap.cs.cmu.edu (CMU, NSF EIA-0196217)");
  return parts.join(" · ");
}
