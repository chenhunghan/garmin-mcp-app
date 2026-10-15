#!/usr/bin/env node
/**
 * Publishes the built asset pack (build/replay-assets, from build.mjs) as the
 * GitHub release the server downloads from (ASSET_RELEASE, e.g.
 * replay-assets-v1). Checks every file against the manifest first; uploads
 * only files the release doesn't have yet (names carry their hash), so it
 * can be re-run after adding assets.
 *
 *   node scripts/assets/publish.mjs [--dry-run]
 *
 * Needs `gh` signed in with permission to create releases on the repo.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIR = join(ROOT, "build", "replay-assets");
const pack = JSON.parse(readFileSync(join(ROOT, "src", "replay-assets.json"), "utf8"));
const tag = `replay-assets-v${pack.version}`;
const dry = process.argv.includes("--dry-run");
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" });

const files = pack.assets.flatMap((a) => a.files);
for (const f of files) {
  const path = join(DIR, f.name);
  if (!existsSync(path)) throw new Error(`${f.name} missing: run node scripts/assets/build.mjs`);
  const sha = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (sha !== f.sha256) throw new Error(`${f.name} doesn't match the manifest`);
}

let have = new Set();
try {
  have = new Set(JSON.parse(gh("release", "view", tag, "--json", "assets")).assets.map((a) => a.name));
} catch {
  console.log(`creating release ${tag}`);
  if (!dry)
    gh(
      "release",
      "create",
      tag,
      "--title",
      `Replay asset pack v${pack.version}`,
      "--notes",
      "Scanned materials, sky light, models and running motion for the 3D run replay, " +
        "served by the MCP server (see scripts/assets). Not an app release.\n\n" +
        "Sources: Poly Haven and ambientCG (CC0), CMU Graphics Lab Motion Capture Database.",
      "--latest=false",
    );
}
const todo = files.filter((f) => !have.has(f.name));
console.log(`${todo.length} of ${files.length} files to upload to ${tag}`);
for (let i = 0; i < todo.length; i += 10) {
  const batch = todo.slice(i, i + 10).map((f) => join(DIR, f.name));
  if (!dry) gh("release", "upload", tag, ...batch);
  console.log(`  ${Math.min(i + 10, todo.length)}/${todo.length}`);
}
