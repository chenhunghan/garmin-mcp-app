#!/usr/bin/env node
/**
 * Builds the replay's asset pack (see sources.mjs):
 *
 *   node scripts/assets/build.mjs [id-prefix …]
 *
 * 1. downloads each source once into ~/.cache/run-coach/asset-sources
 * 2. processes it (ImageMagick for images, Blender for models) into
 *    build/replay-assets/, file names carrying a hash of their content
 * 3. writes src/replay-assets.json (the manifest: files, checksums, licenses,
 *    and what the view needs to know, e.g. a texture's real-world size)
 * 4. installs the files where the server looks for them
 *    (~/.cache/run-coach/replay-assets), so a local build works without the
 *    published pack
 *
 * Needs `magick` (ImageMagick 7), `cwebp`, `unzip`, and Blender for models
 * (BLENDER=/path/to/blender, default /Applications/Blender.app/…).
 */
import { createHash } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { LICENSES, SOURCES } from "./sources.mjs";
import { processMotion } from "./motion.mjs";
import { readRgbe, processSky } from "./sky.mjs";

const execFile = promisify(execFileCb);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE = process.env.RUN_COACH_CACHE ?? join(homedir(), ".cache", "run-coach");
const SRC_DIR = join(CACHE, "asset-sources");
const OUT_DIR = join(ROOT, "build", "replay-assets");
const INSTALL_DIR = join(CACHE, "replay-assets");
const MANIFEST = join(ROOT, "src", "replay-assets.json");
const BLENDER = process.env.BLENDER ?? "/Applications/Blender.app/Contents/MacOS/Blender";
const UA = "RunCoach-assets/1.0 (+https://github.com/chenhunghan/garmin-mcp-app)";

const run = async (cmd, args, opts = {}) => {
  try {
    return (await execFile(cmd, args, { maxBuffer: 1 << 28, ...opts })).stdout;
  } catch (e) {
    throw new Error(`${cmd} ${args.join(" ")}\n${e.stderr ?? e.message}`);
  }
};
const magick = (...args) => run("magick", args.flat());

async function download(url, file) {
  if (existsSync(file)) return file;
  await mkdir(dirname(file), { recursive: true });
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(file + ".part", buf);
  await run("mv", [file + ".part", file]);
  return file;
}

const json = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
};

// ── Sources ──

/** Poly Haven: the asset's info (name, authors, size) and its maps at 2K. */
async function polyhavenSurface(asset) {
  const [info, files] = await Promise.all([
    json(`https://api.polyhaven.com/info/${asset}`),
    json(`https://api.polyhaven.com/files/${asset}`),
  ]);
  const dir = join(SRC_DIR, "polyhaven", asset);
  const get = async (key) => {
    const f = files[key]?.["2k"]?.jpg ?? files[key]?.["2k"]?.png;
    return f ? download(f.url, join(dir, basename(f.url))) : null;
  };
  const maps = {
    color: await get("Diffuse"),
    normal: await get("nor_gl"),
    rough: await get("Rough"),
    ao: await get("AO"),
    height: await get("Displacement"),
    arm: files.AO ? null : await get("arm"),
  };
  return {
    maps,
    title: info.name,
    author: Object.keys(info.authors ?? {}).join(", "),
    tileMeters: info.dimensions ? info.dimensions[0] / 1000 : 2,
  };
}

/** ambientCG: the 2K JPG zip, unpacked. */
async function ambientcgZip(asset) {
  const dir = join(SRC_DIR, "ambientcg", asset);
  const zip = join(dir, `${asset}_2K-JPG.zip`);
  await download(`https://ambientcg.com/get?file=${asset}_2K-JPG.zip`, zip);
  const files = await readdir(dir);
  if (!files.some((f) => f.endsWith(".jpg"))) await run("unzip", ["-o", "-q", zip, "-d", dir]);
  const all = await readdir(dir);
  const find = (re) => {
    const f = all.find((n) => re.test(n));
    return f ? join(dir, f) : null;
  };
  return {
    maps: {
      color: find(/_Color\.jpg$/),
      normal: find(/_NormalGL\.jpg$/),
      rough: find(/_Roughness\.jpg$/),
      ao: find(/_AmbientOcclusion\.jpg$/),
      height: find(/_Displacement\.jpg$/),
      opacity: find(/_Opacity\.jpg$/),
    },
    title: asset,
    author: LICENSES.ambientcg.author,
  };
}

// ── Processing ──

const WEBP = [
  "-define",
  "webp:exact=true",
  "-define",
  "webp:alpha-quality=50",
  "-define",
  "webp:method=6",
];

/** Mean of an image's gray level (0–1, in its own encoding) */
async function meanGray(file) {
  return Number(await magick(file, "-colorspace", "Gray", "-format", "%[fx:mean]", "info:"));
}

/**
 * A surface's two images. With `neutral`, the color is turned into gray
 * detail around a fixed mean, to be tinted per building (OSM colour, kind).
 */
async function packSurface(src, s, out) {
  const { maps } = src;
  const S = `${s.size}x${s.size}!`;
  const resize = ["-filter", "Lanczos", "-resize", S];
  const color = maps.color;
  if (!color || !maps.normal) throw new Error(`${s.id}: missing color or normal map`);
  let colorOps = [];
  if (s.neutral) {
    // Gray detail with a mean of 0.73 (sRGB), i.e. ~0.5 linear: the shader doubles it
    const m = await meanGray(color);
    colorOps = [
      "-colorspace",
      "Gray",
      "-evaluate",
      "multiply",
      String(0.73 / Math.max(0.05, m)),
      "-colorspace",
      "sRGB",
      "-type",
      "TrueColor",
    ];
  }
  const height = maps.height ?? null;
  const a = join(out, `${s.id}.a.webp`);
  await magick(
    "(",
    color,
    ...resize,
    ...colorOps,
    "-alpha",
    "off",
    ")",
    "(",
    ...(height ? [height] : ["-size", S, "xc:gray50"]),
    ...resize,
    "-colorspace",
    "Gray",
    "-auto-level",
    ")",
    "-alpha",
    "off",
    "-compose",
    "CopyOpacity",
    "-composite",
    "-quality",
    "80",
    ...WEBP,
    a,
  );
  // AO: own map, or the red channel of ARM; roughness: own map, or ARM's green
  const aoImg = maps.ao
    ? [maps.ao, "-colorspace", "Gray"]
    : maps.arm
      ? [maps.arm, "-channel", "R", "-separate", "+channel"]
      : ["-size", S, "xc:white"];
  const roughImg = maps.rough
    ? [maps.rough, "-colorspace", "Gray"]
    : maps.arm
      ? [maps.arm, "-channel", "G", "-separate", "+channel"]
      : ["-size", S, "xc:gray80"];
  const b = join(out, `${s.id}.b.webp`);
  await magick(
    "(",
    maps.normal,
    ...resize,
    "-channel",
    "R",
    "-separate",
    "+channel",
    ")",
    "(",
    maps.normal,
    ...resize,
    "-channel",
    "G",
    "-separate",
    "+channel",
    ")",
    "(",
    ...roughImg,
    ...resize,
    ")",
    "(",
    ...aoImg,
    ...resize,
    ")",
    "-channel",
    "RGBA",
    "-combine",
    "-quality",
    "80",
    ...WEBP,
    b,
  );
  return [a, b];
}

/**
 * A cut-out atlas: color + opacity, normal + roughness; plus the bounding
 * boxes of the pieces (leaves, blades) in UV space, so the view can cut cards.
 */
async function packAtlas(src, s, out) {
  const { maps } = src;
  const S = `${s.size}x${s.size}!`;
  const resize = ["-filter", "Lanczos", "-resize", S];
  if (!maps.opacity) throw new Error(`${s.id}: no opacity map`);
  const a = join(out, `${s.id}.a.webp`);
  // Color bleeds outward under transparent pixels, so mipmaps don't fringe
  await magick(
    "(",
    maps.color,
    ...resize,
    "-alpha",
    "off",
    ")",
    "(",
    maps.opacity,
    ...resize,
    "-colorspace",
    "Gray",
    ")",
    "-alpha",
    "off",
    "-compose",
    "CopyOpacity",
    "-composite",
    "-quality",
    "90",
    ...WEBP,
    a,
  );
  const b = join(out, `${s.id}.b.webp`);
  await magick(
    "(",
    maps.normal,
    ...resize,
    "-channel",
    "R",
    "-separate",
    "+channel",
    ")",
    "(",
    maps.normal,
    ...resize,
    "-channel",
    "G",
    "-separate",
    "+channel",
    ")",
    "(",
    ...(maps.rough ? [maps.rough, "-colorspace", "Gray"] : ["-size", S, "xc:gray60"]),
    ...resize,
    ")",
    "(",
    ...(maps.ao ? [maps.ao, "-colorspace", "Gray"] : ["-size", S, "xc:white"]),
    ...resize,
    ")",
    "-channel",
    "RGBA",
    "-combine",
    "-quality",
    "90",
    ...WEBP,
    b,
  );
  // Pieces: connected regions of the opacity map
  const txt = await magick(
    maps.opacity,
    "-resize",
    "512x512!",
    "-colorspace",
    "Gray",
    "-threshold",
    "40%",
    "-define",
    "connected-components:verbose=true",
    "-define",
    "connected-components:area-threshold=150",
    "-connected-components",
    "8",
    "null:",
  );
  const rects = [];
  for (const line of txt.split("\n")) {
    // "  12: 40x180+300+12 320.1,100.2 5400 gray(255)"
    const m = line.match(
      /^\s*\d+:\s+(\d+)x(\d+)\+(\d+)\+(\d+)\s+\S+\s+(\d+)\s+(?:gray|srgb)\((\d+|255)/,
    );
    if (!m || m[6] === "0") continue;
    const [w, h, x, y] = [m[1], m[2], m[3], m[4]].map(Number);
    if (w > 500 && h > 500) continue; // (the background)
    rects.push([x / 512, y / 512, w / 512, h / 512].map((v) => Math.round(v * 1e4) / 1e4));
  }
  return { files: [a, b], meta: { rects } };
}

async function packModel(src, s, out) {
  const files = await json(`https://api.polyhaven.com/files/${s.asset}`);
  const info = await json(`https://api.polyhaven.com/info/${s.asset}`);
  const g = files.gltf["1k"].gltf;
  const dir = join(SRC_DIR, "polyhaven", s.asset);
  const gltf = await download(g.url, join(dir, basename(g.url)));
  for (const [rel, f] of Object.entries(g.include ?? {})) await download(f.url, join(dir, rel));
  const glb = join(out, `${s.id}.glb`);
  const report = await run(BLENDER, [
    "--background",
    "--factory-startup",
    "--python",
    join(ROOT, "scripts", "assets", "model.py"),
    "--",
    gltf,
    glb,
    String(s.tris),
    s.keep ?? "",
    s.split ? "split" : "",
  ]);
  const meta = JSON.parse(
    report
      .split("\n")
      .find((l) => l.startsWith("MODEL "))
      ?.slice(6) ?? "{}",
  );
  return {
    files: [glb],
    meta,
    title: info.name,
    author: Object.keys(info.authors ?? {}).join(", "),
  };
}

async function packSky(s, out) {
  const [info, files] = await Promise.all([
    json(`https://api.polyhaven.com/info/${s.asset}`),
    json(`https://api.polyhaven.com/files/${s.asset}`),
  ]);
  const f = files.hdri["1k"].hdr;
  const hdr = await download(f.url, join(SRC_DIR, "polyhaven", s.asset, basename(f.url)));
  const file = join(out, `${s.id}.rgbe`);
  const meta = await processSky(readRgbe(await readFile(hdr)), file);
  return {
    files: [file],
    meta: { ...meta, ...s.tags },
    title: info.name,
    author: Object.keys(info.authors ?? {}).join(", "),
  };
}

// ── Main ──

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function build(s, tmp) {
  const lic = LICENSES[s.from];
  let files;
  let meta = {};
  let title = s.asset;
  let author = lic.author ?? "";
  if (s.kind === "surface" || s.kind === "atlas") {
    const src =
      s.from === "polyhaven" ? await polyhavenSurface(s.asset) : await ambientcgZip(s.asset);
    title = src.title;
    author = src.author || author;
    if (s.kind === "surface") {
      files = await packSurface(src, s, tmp);
      meta.tile = s.tile ?? src.tileMeters ?? 2;
    } else {
      const r = await packAtlas(src, s, tmp);
      files = r.files;
      meta = r.meta;
    }
  } else if (s.kind === "model") {
    const r = await packModel(null, s, tmp);
    ({ files, meta, title, author } = { ...r, author: r.author || author });
  } else if (s.kind === "sky") {
    const r = await packSky(s, tmp);
    ({ files, meta, title, author } = r);
  } else if (s.kind === "motion") {
    const [subject, take] = s.asset.split("/");
    const dir = join(SRC_DIR, "cmu", subject);
    const asf = await download(
      `http://mocap.cs.cmu.edu/subjects/${subject}/${subject}.asf`,
      join(dir, `${subject}.asf`),
    );
    const amc = await download(
      `http://mocap.cs.cmu.edu/subjects/${subject}/${take}.amc`,
      join(dir, `${take}.amc`),
    );
    const file = join(tmp, `${s.id}.json`);
    meta = await processMotion(await readFile(asf, "utf8"), await readFile(amc, "utf8"), file);
    files = [file];
    title = `Subject #${Number(subject)}, trial ${take.split("_")[1]} (run)`;
  } else {
    throw new Error(`unknown kind ${s.kind}`);
  }
  // Content-addressed names: a changed file never collides with a cached one
  const out = [];
  for (const f of files) {
    const buf = await readFile(f);
    const hash = sha256(buf);
    const name = basename(f).replace(/(\.[a-z]+)$/, `.${hash.slice(0, 10)}$1`);
    await copyFile(f, join(OUT_DIR, name));
    out.push({ name, bytes: buf.length, sha256: hash });
  }
  return {
    id: s.id,
    kind: s.kind,
    files: out,
    meta,
    credit: { title, author, license: lic.license, url: lic.page(s.asset) },
  };
}

async function main() {
  const only = process.argv.slice(2);
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(INSTALL_DIR, { recursive: true });
  const tmp = join(OUT_DIR, ".tmp");
  await mkdir(tmp, { recursive: true });
  const prev = existsSync(MANIFEST) ? JSON.parse(await readFile(MANIFEST, "utf8")) : { assets: [] };
  const byId = new Map(prev.assets.map((a) => [a.id, a]));
  const todo = SOURCES.filter((s) => !only.length || only.some((p) => s.id.startsWith(p)));
  let failed = 0;
  for (const s of todo) {
    try {
      process.stdout.write(`${s.id} … `);
      const entry = await build(s, tmp);
      byId.set(s.id, entry);
      const kb = entry.files.reduce((n, f) => n + f.bytes, 0) / 1024;
      console.log(`${Math.round(kb)} KB`);
    } catch (e) {
      failed++;
      console.log(`FAILED\n  ${String(e.message).split("\n").slice(0, 4).join("\n  ")}`);
    }
  }
  await rm(tmp, { recursive: true, force: true });
  // Keep the sources' order; drop entries no longer listed
  const assets = SOURCES.map((s) => byId.get(s.id)).filter(Boolean);
  const total = assets.reduce((n, a) => n + a.files.reduce((m, f) => m + f.bytes, 0), 0);
  const manifest = { version: 1, bytes: total, assets };
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 1) + "\n");
  for (const a of assets) {
    for (const f of a.files) {
      const from = join(OUT_DIR, f.name);
      if (existsSync(from)) await copyFile(from, join(INSTALL_DIR, f.name));
    }
  }
  console.log(`\n${assets.length} assets, ${(total / 1048576).toFixed(1)} MB → ${OUT_DIR}`);
  console.log(`installed into ${INSTALL_DIR}`);
  if (failed) process.exitCode = 1;
}

await main();
