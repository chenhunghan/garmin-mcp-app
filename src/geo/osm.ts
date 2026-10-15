/**
 * OpenStreetMap features around a run from the Overpass API: roads and paths,
 * land cover (forest, meadow, fields, built-up), water, rivers and buildings,
 * classified for the replay and projected to local meters.
 */
import { cachedFetch } from "./fetch.js";
import { toLocal, type Projection } from "./dem.js";
import type { Area, AreaKind, Building, BuildingKind, River, Road, RoadClass } from "./types.js";
import { TREE_BROADLEAF, TREE_CONIFER, TREE_PALM } from "./types.js";

// Fastest first; overpass-api.de often queues requests for tens of seconds
const ENDPOINTS = [
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

type Tags = Record<string, string>;
interface Geom {
  lat: number;
  lon: number;
}
interface Element {
  type: "way" | "relation" | "node";
  tags?: Tags;
  lat?: number;
  lon?: number;
  geometry?: Geom[];
  members?: { type: string; role: string; geometry?: Geom[] }[];
}

/**
 * Features near the route only — a corridor around a simplified polyline
 * (Overpass `around`), so a run through a dense city doesn't ask for every
 * building in a 50 km² box.
 */
export function overpassQuery(route: { lat: number; lon: number }[]) {
  const line = route.map((p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).join(",");
  const near = (r: number) => `(around:${r},${line})`;
  return `[out:json][timeout:180][maxsize:536870912];
(
  way["highway"]${near(450)};
  way["building"]${near(300)};
  way["natural"~"^(water|wood|scrub|heath|grassland|bare_rock|scree|sand|beach|wetland)$"]${near(600)};
  way["landuse"]${near(600)};
  way["leisure"~"^(park|pitch|track|golf_course|garden|nature_reserve)$"]${near(600)};
  way["waterway"~"^(river|stream|canal)$"]${near(800)};
  node["natural"="tree"]${near(250)};
  way["natural"="tree_row"]${near(250)};
  relation["type"="multipolygon"]["natural"~"^(water|wood|scrub|heath|grassland|bare_rock|scree|sand|wetland)$"]${near(600)};
  relation["type"="multipolygon"]["landuse"]${near(600)};
);
out geom qt;`;
}

const ROAD: Record<string, [RoadClass, number]> = {
  motorway: ["major", 12],
  trunk: ["major", 11],
  primary: ["major", 10],
  secondary: ["major", 8.5],
  tertiary: ["minor", 7],
  unclassified: ["minor", 6],
  residential: ["residential", 6],
  living_street: ["residential", 5],
  service: ["service", 4],
  pedestrian: ["path", 4],
  track: ["track", 3],
  footway: ["path", 1.8],
  path: ["path", 1.6],
  cycleway: ["path", 2.2],
  bridleway: ["path", 2],
  steps: ["steps", 1.6],
};
const ROAD_LINKS: Record<string, string> = {
  motorway_link: "motorway",
  trunk_link: "trunk",
  primary_link: "primary",
  secondary_link: "secondary",
  tertiary_link: "tertiary",
};
const PAVED = /^(paved|asphalt|concrete|paving_stones|sett|cobblestone|metal|wood|chipseal)/;
const UNPAVED =
  /^(unpaved|gravel|fine_gravel|compacted|dirt|earth|ground|grass|sand|mud|pebblestone|woodchips)/;

function areaKind(t: Tags): AreaKind | null {
  const n = t.natural;
  const l = t.landuse;
  const le = t.leisure;
  if (n === "water" || l === "reservoir" || l === "basin") return "water";
  if (n === "wood" || l === "forest") return "forest";
  if (n === "scrub" || n === "heath") return "scrub";
  if (
    n === "grassland" ||
    l === "meadow" ||
    l === "grass" ||
    l === "village_green" ||
    l === "recreation_ground"
  )
    return "grass";
  if (
    l === "farmland" ||
    l === "orchard" ||
    l === "vineyard" ||
    l === "allotments" ||
    l === "farmyard" ||
    l === "greenhouse_horticulture"
  )
    return "farmland";
  if (
    l === "residential" ||
    l === "retail" ||
    l === "commercial" ||
    l === "construction" ||
    l === "education" ||
    l === "religious"
  )
    return "residential";
  if (
    l === "industrial" ||
    l === "railway" ||
    l === "quarry" ||
    l === "landfill" ||
    l === "military"
  )
    return "industrial";
  if (n === "bare_rock" || n === "scree") return "rock";
  if (n === "sand" || n === "beach") return "sand";
  if (n === "wetland") return "wetland";
  if (
    le === "park" ||
    le === "garden" ||
    le === "golf_course" ||
    le === "nature_reserve" ||
    l === "cemetery"
  )
    return "park";
  if (le === "pitch" || le === "track") return "pitch";
  return null;
}

function buildingHeight(t: Tags): number {
  const h = parseFloat(t.height ?? "");
  if (Number.isFinite(h) && h > 1 && h < 600) return h;
  const levels = parseFloat(t["building:levels"] ?? "");
  if (Number.isFinite(levels) && levels > 0 && levels < 200) return levels * 3 + 1;
  if (/^(garage|garages|shed|hut|carport|kiosk|cabin)$/.test(t.building ?? "")) return 3;
  if (/^(apartments|commercial|office|hospital|hotel|university)$/.test(t.building ?? ""))
    return 15;
  return 7;
}

const KIND: [RegExp, BuildingKind][] = [
  [/^(garage|garages|shed|hut|carport|kiosk|cabin|roof|greenhouse|barn|stable)$/, "shed"],
  [/^(house|detached|semidetached_house|terrace|bungalow|farm|villa|houseboat)$/, "house"],
  [/^(apartments|residential|dormitory|hotel)$/, "apartments"],
  [/^(retail|commercial|supermarket|mall|store|shop)$/, "shop"],
  [/^(office|government|bank)$/, "office"],
  [/^(industrial|warehouse|factory|manufacture|hangar|depot|service|storage_tank)$/, "industrial"],
  [
    /^(school|university|college|hospital|church|cathedral|chapel|temple|mosque|shrine|public|civic|train_station|transportation|stadium|sports_hall|kindergarten)$/,
    "civic",
  ],
];

/** The building's use, from its own tag, then shop/office tags, then its size. */
export function buildingKind(t: Tags, h: number): BuildingKind {
  const b = t.building ?? "";
  for (const [re, kind] of KIND) if (re.test(b)) return kind;
  if (t.shop || t.amenity === "restaurant" || t.amenity === "cafe") return "shop";
  if (t.office) return "office";
  if (t.amenity) return "civic";
  return h <= 9 ? "house" : "apartments";
}

function buildingLevels(t: Tags): number | undefined {
  const levels = parseFloat(t["building:levels"] ?? "");
  return Number.isFinite(levels) && levels >= 1 && levels < 200 ? Math.round(levels) : undefined;
}

function roofShape(t: Tags): Building["roof"] {
  const r = t["roof:shape"] ?? "";
  if (r === "flat") return "flat";
  if (/^(gabled|half-hipped|saltbox|gambrel|mansard|skillion)$/.test(r)) return "gabled";
  if (/^(hipped|side_hipped)$/.test(r)) return "hipped";
  if (r === "pyramidal") return "pyramidal";
  // Only houses mapped as houses: in many cities a small "yes" is a flat-roofed block
  if (
    !r &&
    /^(house|detached|semidetached_house|bungalow|farm|villa|cabin|barn|hut)$/.test(
      t.building ?? "",
    )
  )
    return "pitched";
  return undefined;
}

export interface OsmFeatures {
  roads: Road[];
  areas: Area[];
  buildings: Building[];
  rivers: River[];
  trees: number[];
}

const PALMS =
  /palm|arecaceae|roystonea|livistona|washingtonia|phoenix|areca|cocos|trachycarpus|archontophoenix|syagrus|caryota/i;

/** Conifer, palm or broadleaf, and the height when mapped (0 = unknown). */
function treeOf(t: Tags): [number, number] {
  const h = parseFloat(t.height ?? "");
  const height = Number.isFinite(h) && h > 1 && h < 80 ? h : 0;
  const taxon = `${t.genus ?? ""} ${t.species ?? ""} ${t.taxon ?? ""} ${t["species:en"] ?? ""}`;
  const kind =
    t.leaf_type === "palm" || PALMS.test(taxon)
      ? TREE_PALM
      : t.leaf_type === "needleleaved"
        ? TREE_CONIFER
        : TREE_BROADLEAF;
  return [height, kind];
}
const MAX_TREES = 40000;

/** Overpass JSON → classified features in local meters. Exported for tests. */
export function parseOverpass(json: { elements?: Element[] }, proj: Projection): OsmFeatures {
  const out: OsmFeatures = { roads: [], areas: [], buildings: [], rivers: [], trees: [] };
  const tree = (x: number, z: number, t: Tags) => {
    if (out.trees.length >= MAX_TREES * 4) return;
    out.trees.push(Math.round(x * 10) / 10, Math.round(z * 10) / 10, ...treeOf(t));
  };
  const flat = (g: Geom[]) => {
    const pts: number[] = [];
    for (const p of g) {
      const l = toLocal(proj, p.lat, p.lon);
      pts.push(Math.round(l.x * 10) / 10, Math.round(l.z * 10) / 10);
    }
    return pts;
  };
  const closed = (g: Geom[]) =>
    g.length >= 4 && g[0]!.lat === g.at(-1)!.lat && g[0]!.lon === g.at(-1)!.lon;

  for (const e of json.elements ?? []) {
    const t = e.tags ?? {};
    if (e.type === "relation") {
      const kind = areaKind(t);
      if (!kind) continue;
      for (const m of e.members ?? []) {
        if (m.role === "outer" && m.geometry && closed(m.geometry))
          out.areas.push({ kind, pts: flat(m.geometry) });
      }
      continue;
    }
    if (e.type === "node") {
      if (t.natural === "tree" && e.lat !== undefined && e.lon !== undefined) {
        const l = toLocal(proj, e.lat, e.lon);
        tree(l.x, l.z, t);
      }
      continue;
    }
    if (e.type !== "way" || !e.geometry || e.geometry.length < 2) continue;
    const g = e.geometry;

    if (t.natural === "tree_row") {
      // A tree every ~7 m along the row
      const pts = flat(g);
      let carry = 0;
      for (let i = 2; i < pts.length; i += 2) {
        const ax = pts[i - 2]!;
        const az = pts[i - 1]!;
        const len = Math.hypot(pts[i]! - ax, pts[i + 1]! - az);
        for (let s = carry; s < len; s += 7)
          tree(ax + ((pts[i]! - ax) * s) / len, az + ((pts[i + 1]! - az) * s) / len, t);
        carry = (((carry - len) % 7) + 7) % 7;
      }
      continue;
    }

    if (t.highway) {
      if (
        t.tunnel === "yes" ||
        t.area === "yes" ||
        /^(proposed|construction|platform|corridor|elevator|raceway|bus_stop)$/.test(t.highway)
      )
        continue;
      const def = ROAD[ROAD_LINKS[t.highway] ?? t.highway];
      if (!def) continue;
      const [cls, width] = def;
      const surface = t.surface ?? "";
      const paved = PAVED.test(surface)
        ? true
        : UNPAVED.test(surface)
          ? false
          : cls !== "track" && cls !== "path";
      out.roads.push({ cls, paved, width, pts: flat(g) });
      continue;
    }
    if (t.building && closed(g)) {
      if (g.length > 400) continue;
      const h = buildingHeight(t);
      const levels = buildingLevels(t);
      const roof = roofShape(t);
      out.buildings.push({
        h,
        kind: buildingKind(t, h),
        ...(levels ? { levels } : {}),
        ...(roof ? { roof } : {}),
        pts: flat(g.slice(0, -1)),
      });
      continue;
    }
    if (t.waterway) {
      const w = t.waterway === "river" ? 12 : t.waterway === "canal" ? 8 : 2.5;
      const width = parseFloat(t.width ?? "");
      out.rivers.push({
        width: Number.isFinite(width) && width > 0 && width < 300 ? width : w,
        pts: flat(g),
      });
      continue;
    }
    const kind = areaKind(t);
    if (kind && closed(g)) out.areas.push({ kind, pts: flat(g) });
  }
  // Big buildings first, so a cap keeps the landmarks
  if (out.buildings.length > 20000) out.buildings.length = 20000;
  return out;
}

export async function fetchOsm(
  proj: Projection,
  route: { lat: number; lon: number }[],
): Promise<OsmFeatures> {
  const body = `data=${encodeURIComponent(overpassQuery(route))}`;
  const errors: string[] = [];
  for (const url of ENDPOINTS) {
    try {
      const buf = await cachedFetch(url, { body, maxAgeDays: 30, timeoutMs: 200_000 });
      const json = JSON.parse(new TextDecoder().decode(buf)) as {
        elements?: Element[];
        remark?: string;
      };
      // Overpass reports timeouts and memory limits as a 200 with a remark
      if (json.remark && !json.elements?.length) throw new Error(json.remark.slice(0, 120));
      return parseOverpass(json, proj);
    } catch (err) {
      errors.push(`${new URL(url).host}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(errors.join("; "));
}
