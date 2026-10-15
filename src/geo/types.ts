/**
 * Real-world map data around a run, as sent from the server to the replay
 * view. Coordinates are local meters around `origin` (east = +x, north = −z),
 * the same projection the view uses for the GPS track.
 */

export interface HeightGrid {
  /** Scene x of column 0, z of row 0 (meters), and spacing */
  x0: number;
  z0: number;
  step: number;
  nx: number;
  nz: number;
  /** Heights = base + value / 10 (meters above sea level), Int16 little-endian, base64 */
  base: number;
  data: string;
}

export type RoadClass = "major" | "minor" | "residential" | "service" | "track" | "path" | "steps";

export interface Road {
  cls: RoadClass;
  paved: boolean;
  /** Width in meters */
  width: number;
  /** Flat [x, z, x, z, …] */
  pts: number[];
}

export type AreaKind =
  | "forest"
  | "scrub"
  | "grass"
  | "farmland"
  | "residential"
  | "industrial"
  | "rock"
  | "sand"
  | "wetland"
  | "water"
  | "park"
  | "pitch";

export interface Area {
  kind: AreaKind;
  pts: number[];
}

/** What a building is used for: picks its facade (window layout, glass, colors) */
export type BuildingKind =
  | "house"
  | "apartments"
  | "shop"
  | "office"
  | "industrial"
  | "civic"
  | "shed";

export interface Building {
  /** Height above ground, meters */
  h: number;
  kind: BuildingKind;
  /** Floors above ground, when OSM has them */
  levels?: number;
  /** Roof shape from OSM's roof:shape; "pitched" = a house with no shape mapped */
  roof?: "flat" | "gabled" | "hipped" | "pyramidal" | "pitched";
  pts: number[];
}

export interface River {
  width: number;
  pts: number[];
}

/** Tree kinds, in `RunMap.trees` */
export const TREE_BROADLEAF = 0;
export const TREE_CONIFER = 1;
export const TREE_PALM = 2;

export interface RunMap {
  origin: { lat: number; lon: number };
  /** Fine grid over the route, coarse grid to the horizon */
  dem: { inner: HeightGrid; outer: HeightGrid } | null;
  roads: Road[];
  areas: Area[];
  buildings: Building[];
  rivers: River[];
  /** Mapped trees (OSM natural=tree, and tree rows sampled every 7 m): flat [x, z, height (0 = unknown), kind, …] */
  trees: number[];
  attribution: string[];
  /** Parts that couldn't be fetched (the rest still renders) */
  missing: string[];
}

export function decodeGrid(g: HeightGrid): Float32Array {
  const bin = atob(g.data);
  const out = new Float32Array(g.nx * g.nz);
  for (let i = 0; i < out.length; i++) {
    const lo = bin.charCodeAt(i * 2);
    const hi = bin.charCodeAt(i * 2 + 1);
    let v = (hi << 8) | lo;
    if (v & 0x8000) v -= 0x10000;
    out[i] = g.base + v / 10;
  }
  return out;
}

/** Bilinear lookup in a decoded grid (clamped at the edges). */
export function sampleGrid(g: HeightGrid, h: Float32Array, x: number, z: number): number {
  const fx = Math.max(0, Math.min(g.nx - 1.001, (x - g.x0) / g.step));
  const fz = Math.max(0, Math.min(g.nz - 1.001, (z - g.z0) / g.step));
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const u = fx - i;
  const v = fz - j;
  const a = h[j * g.nx + i]!;
  const b = h[j * g.nx + i + 1]!;
  const c = h[(j + 1) * g.nx + i]!;
  const d = h[(j + 1) * g.nx + i + 1]!;
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

export function insideGrid(g: HeightGrid, x: number, z: number): boolean {
  return (
    x >= g.x0 && z >= g.z0 && x <= g.x0 + (g.nx - 1) * g.step && z <= g.z0 + (g.nz - 1) * g.step
  );
}
