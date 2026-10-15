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

/** What a road or path is surfaced with: OSM `surface`, else a default for its class */
export type Surface =
  | "asphalt"
  | "concrete"
  | "paving"
  | "gravel"
  | "dirt"
  | "grass"
  | "sand"
  | "wood";

export interface Road {
  cls: RoadClass;
  paved: boolean;
  surface?: Surface;
  /** The surface is mapped (OSM `surface`), not assumed from the class */
  surfaceMapped?: boolean;
  /** Street lights along it (OSM `lit`) */
  lit?: boolean;
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
  /** Facade material and color, when mapped (building:material, building:colour) */
  material?: WallMaterial;
  colour?: string;
  /** Roof material and color, when mapped (roof:material, roof:colour) */
  roofMaterial?: RoofMaterial;
  roofColour?: string;
  pts: number[];
}

export type WallMaterial =
  | "plaster"
  | "concrete"
  | "brick"
  | "stone"
  | "glass"
  | "metal"
  | "wood"
  | "tiles";

export type RoofMaterial = "tiles" | "slate" | "metal" | "concrete" | "glass" | "grass";

/** Street furniture mapped as OSM nodes, in `RunMap.furniture` */
export const FURNITURE = [
  "street_lamp",
  "traffic_signals",
  "bench",
  "waste_basket",
  "fire_hydrant",
  "drinking_water",
  "bollard",
] as const;
export type FurnitureKind = (typeof FURNITURE)[number];

export interface River {
  width: number;
  pts: number[];
}

/** Tree kinds, in `RunMap.trees` (the low 2 bits of the kind value) */
export const TREE_BROADLEAF = 0;
export const TREE_CONIFER = 1;
export const TREE_PALM = 2;
/**
 * Genus groups from OSM genus/species/taxon, picking bark and leaves (kind
 * value = group × 4 + kind). 0 = not mapped.
 */
export const TREE_GENUS = [
  "unknown",
  "maple", // Acer, Liquidambar, Platanus: lobed leaves
  "camphor", // Cinnamomum, Machilus, Ficus, Magnolia: glossy oval leaves, rough bark
  "zelkova", // Zelkova, Ulmus, Celtis, Koelreuteria: small serrated leaves, smooth flaky bark
  "heart", // Tilia, Cercis, Populus, Catalpa: heart-shaped leaves
  "pine", // Pinus, Picea, Abies, Cedrus, Juniperus, Cupressus, Taxodium
  "birch", // Betula, Alnus, Fraxinus, Fagus, Quercus: generic broadleaf
] as const;

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
  /** Mapped street furniture: flat [x, z, FURNITURE index, direction (degrees, -1 = unknown), …] */
  furniture?: number[];
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
