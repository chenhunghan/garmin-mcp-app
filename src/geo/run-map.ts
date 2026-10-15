/**
 * Real map data around a run's GPS track: elevation grids (fine over the
 * route, coarse to the horizon) and OpenStreetMap features. Each source can
 * fail on its own; what arrives is used.
 */
import { heightGrid, projection, toLocal } from "./dem.js";
import { fetchOsm } from "./osm.js";
import type { RunMap } from "./types.js";

/** The route every ~120 m: enough for a corridor query a few hundred meters wide. */
function simplify(fixes: { lat: number; lon: number }[], proj: ReturnType<typeof projection>) {
  const out: { lat: number; lon: number }[] = [];
  let last: { x: number; z: number } | null = null;
  for (const f of fixes) {
    const p = toLocal(proj, f.lat, f.lon);
    if (!last || Math.hypot(p.x - last.x, p.z - last.z) >= 120) {
      out.push(f);
      last = p;
    }
  }
  out.push(fixes.at(-1)!);
  return out;
}

export async function buildRunMap(
  lat: (number | null)[],
  lon: (number | null)[],
): Promise<RunMap | null> {
  const fixes: { lat: number; lon: number }[] = [];
  for (let i = 0; i < lat.length; i++) {
    const a = lat[i];
    const b = lon[i];
    if (a == null || b == null || (a === 0 && b === 0)) continue;
    fixes.push({ lat: a, lon: b });
  }
  if (fixes.length < 10) return null;
  const origin = fixes[0]!;
  const proj = projection(origin.lat, origin.lon);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const f of fixes) {
    const p = toLocal(proj, f.lat, f.lon);
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  const span = Math.max(maxX - minX, maxZ - minZ, 200);
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const square = (half: number) => ({
    minX: cx - half,
    maxX: cx + half,
    minZ: cz - half,
    maxZ: cz + half,
  });
  const innerHalf = span / 2 + 700;
  const outerHalf = span / 2 + Math.min(9000, Math.max(5000, span * 1.5));

  const missing: string[] = [];
  const attribution: string[] = [];

  const [inner, outer, osm] = await Promise.allSettled([
    heightGrid(proj, square(innerHalf), { maxZoom: 14, maxTiles: 36, maxCells: 720 }),
    heightGrid(proj, square(outerHalf), { maxZoom: 11, maxTiles: 25, maxCells: 320 }),
    fetchOsm(proj, simplify(fixes, proj)),
  ]);

  let dem: RunMap["dem"] = null;
  if (inner.status === "fulfilled" && outer.status === "fulfilled") {
    dem = { inner: inner.value, outer: outer.value };
    attribution.push("Elevation: AWS Terrain Tiles (USGS, SRTM, GMTED, ETOPO1, and others)");
  } else {
    const err =
      inner.status === "rejected" ? inner.reason : (outer as PromiseRejectedResult).reason;
    missing.push(`elevation (${err instanceof Error ? err.message : String(err)})`);
  }
  const features =
    osm.status === "fulfilled"
      ? osm.value
      : { roads: [], areas: [], buildings: [], rivers: [], trees: [], furniture: [] };
  if (osm.status === "fulfilled") attribution.push("Map data © OpenStreetMap contributors");
  else
    missing.push(
      `map features (${osm.reason instanceof Error ? osm.reason.message : String(osm.reason)})`,
    );

  return { origin, dem, ...features, attribution, missing };
}
