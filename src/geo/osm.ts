/**
 * OpenStreetMap features around a run from the Overpass API: roads and paths,
 * land cover (forest, meadow, fields, built-up), water, rivers and buildings,
 * classified for the replay and projected to local meters.
 */
import { cachedFetch } from "./fetch.js";
import { toLocal, type Projection } from "./dem.js";
import type {
  Area,
  AreaKind,
  Building,
  BuildingKind,
  River,
  Road,
  RoadClass,
  RoofMaterial,
  Surface,
  WallMaterial,
} from "./types.js";
import { FURNITURE, TREE_BROADLEAF, TREE_CONIFER, TREE_GENUS, TREE_PALM } from "./types.js";

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
  node["highway"~"^(street_lamp|traffic_signals)$"]${near(200)};
  node["amenity"~"^(bench|waste_basket|drinking_water)$"]${near(200)};
  node["emergency"="fire_hydrant"]${near(200)};
  node["barrier"="bollard"]${near(200)};
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
const PAVED =
  /^(paved|asphalt|concrete|paving_stones|sett|cobblestone|metal|wood|chipseal|bricks|tartan|rubber)/;
const UNPAVED =
  /^(unpaved|gravel|fine_gravel|compacted|dirt|earth|ground|grass|sand|mud|pebblestone|woodchips)/;

/** OSM `surface` → the replay's surface materials (null: not mapped or unknown) */
export function surfaceOf(surface: string): Surface | null {
  const v = surface.split(/[;:]/)[0]!;
  if (/^(asphalt|chipseal|paved|tartan|rubber|acrylic)$/.test(v)) return "asphalt";
  if (v.startsWith("concrete")) return "concrete";
  if (/^(paving_stones|sett|cobblestone|unhewn_cobblestone|bricks|stone|grass_paver)$/.test(v))
    return "paving";
  if (/^(gravel|fine_gravel|compacted|pebblestone|rock|shells)$/.test(v)) return "gravel";
  if (/^(dirt|earth|ground|mud|woodchips|unpaved|clay)$/.test(v)) return "dirt";
  if (v === "grass") return "grass";
  if (v === "sand") return "sand";
  if (/^(wood|metal|metal_grid)$/.test(v)) return "wood";
  return null;
}

/** What an untagged way is usually surfaced with */
function defaultSurface(highway: string, cls: RoadClass): Surface {
  if (highway === "pedestrian" || highway === "footway") return "paving";
  if (highway === "steps") return "concrete";
  if (cls === "track") return "gravel";
  if (cls === "path") return highway === "cycleway" ? "asphalt" : "dirt";
  return "asphalt";
}

const WALL: [RegExp, WallMaterial][] = [
  [/^(brick|bricks)/, "brick"],
  [/^(concrete|reinforced_concrete|cement_block|masonry)/, "concrete"],
  [/^(plaster|render|stucco|lime_render)/, "plaster"],
  [/^(stone|sandstone|limestone|granite|marble)/, "stone"],
  [/^glass/, "glass"],
  [/^(metal|steel|aluminium|metal_plates)/, "metal"],
  [/^(wood|timber|timber_framing|bamboo|log)/, "wood"],
  [/^(tiles|ceramic|tile)/, "tiles"],
];
const ROOF: [RegExp, RoofMaterial][] = [
  [/^(roof_tiles|tile|tiles|clay|ceramic)/, "tiles"],
  [/^(slate|stone)/, "slate"],
  [/^(metal|tin|copper|zinc|steel)/, "metal"],
  [/^(concrete|tar_paper|asphalt|eternit|gravel)/, "concrete"],
  [/^glass/, "glass"],
  [/^(grass|plants)/, "grass"],
];

/** A mapped OSM colour (name or #hex) as #rrggbb, or undefined */
export function osmColour(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const c = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  if (/^#[0-9a-f]{3}$/.test(c)) return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  return COLOURS[c.replace(/[\s_-]/g, "")];
}
const COLOURS: Record<string, string> = {
  white: "#f2f0eb",
  black: "#2b2b2b",
  grey: "#9a9a96",
  gray: "#9a9a96",
  lightgrey: "#c8c8c4",
  lightgray: "#c8c8c4",
  darkgrey: "#5c5c5a",
  darkgray: "#5c5c5a",
  silver: "#c0c0c0",
  beige: "#dccfb0",
  cream: "#efe6cc",
  ivory: "#f2ecd8",
  brown: "#7a5a40",
  tan: "#c8a982",
  red: "#a8443a",
  darkred: "#7a2f2a",
  maroon: "#6e2a2a",
  pink: "#e3b2b0",
  orange: "#d98a4a",
  yellow: "#e6cf6e",
  lightyellow: "#efe4a8",
  gold: "#c9a646",
  green: "#6f8f5a",
  darkgreen: "#3f5a35",
  olive: "#7c7a4a",
  blue: "#5a7aa8",
  lightblue: "#a8c2dc",
  darkblue: "#34486e",
  navy: "#2e3c5e",
  teal: "#4a8a88",
  purple: "#7a5a8a",
  sand: "#d6c39a",
  terracotta: "#b5654a",
};

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

function materialOf<T>(table: [RegExp, T][], v: string | undefined): T | undefined {
  if (!v) return undefined;
  const c = v.trim().toLowerCase();
  for (const [re, m] of table) if (re.test(c)) return m;
  return undefined;
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
  furniture: number[];
}

const GENUS: [RegExp, (typeof TREE_GENUS)[number]][] = [
  [/acer|liquidambar|platanus|sweetgum|maple|plane/i, "maple"],
  [
    /cinnamomum|machilus|ficus|magnolia|camphor|michelia|elaeocarpus|ilex|ligustrum|syzygium|terminalia|bischofia/i,
    "camphor",
  ],
  [/zelkova|ulmus|celtis|koelreuteria|lagerstroemia|prunus|elm|cherry/i, "zelkova"],
  [/tilia|cercis|populus|catalpa|bauhinia|linden|poplar/i, "heart"],
  [
    /pinus|picea|abies|cedrus|juniperus|cupressus|taxodium|metasequoia|podocarpus|araucaria|pine|spruce|fir|cedar/i,
    "pine",
  ],
  [/betula|alnus|fraxinus|fagus|quercus|carpinus|birch|oak|beech|ash/i, "birch"],
];

const PALMS =
  /palm|arecaceae|roystonea|livistona|washingtonia|phoenix|areca|cocos|trachycarpus|archontophoenix|syagrus|caryota/i;

/** Conifer, palm or broadleaf, and the height when mapped (0 = unknown). */
function treeOf(t: Tags): [number, number] {
  const h = parseFloat(t.height ?? "");
  const height = Number.isFinite(h) && h > 1 && h < 80 ? h : 0;
  const taxon = `${t.genus ?? ""} ${t.species ?? ""} ${t.taxon ?? ""} ${t["species:en"] ?? ""}`;
  const genus = GENUS.find(([re]) => re.test(taxon))?.[1] ?? "unknown";
  const kind =
    t.leaf_type === "palm" || PALMS.test(taxon)
      ? TREE_PALM
      : t.leaf_type === "needleleaved" || genus === "pine"
        ? TREE_CONIFER
        : TREE_BROADLEAF;
  return [height, kind + TREE_GENUS.indexOf(genus) * 4];
}
const MAX_TREES = 40000;

/** Overpass JSON → classified features in local meters. Exported for tests. */
export function parseOverpass(json: { elements?: Element[] }, proj: Projection): OsmFeatures {
  const out: OsmFeatures = {
    roads: [],
    areas: [],
    buildings: [],
    rivers: [],
    trees: [],
    furniture: [],
  };
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
      if (e.lat === undefined || e.lon === undefined) continue;
      const l = toLocal(proj, e.lat, e.lon);
      if (t.natural === "tree") {
        tree(l.x, l.z, t);
        continue;
      }
      const kind = FURNITURE.indexOf(
        (t.highway ??
          t.amenity ??
          (t.emergency === "fire_hydrant" ? "fire_hydrant" : t.barrier)) as never,
      );
      if (kind >= 0 && out.furniture.length < 20000 * 4) {
        const dir = parseFloat(t.direction ?? "");
        out.furniture.push(
          Math.round(l.x * 10) / 10,
          Math.round(l.z * 10) / 10,
          kind,
          Number.isFinite(dir) ? Math.round(((dir % 360) + 360) % 360) : -1,
        );
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
      const mapped = surfaceOf(surface);
      out.roads.push({
        cls,
        paved,
        surface: mapped ?? defaultSurface(t.highway, cls),
        ...(mapped ? { surfaceMapped: true } : {}),
        ...(/^(yes|24\/7|automatic|limited|interval|sunset-sunrise|dusk-dawn)$/.test(t.lit ?? "")
          ? { lit: true }
          : {}),
        width,
        pts: flat(g),
      });
      continue;
    }
    if (t.building && closed(g)) {
      if (g.length > 400) continue;
      const h = buildingHeight(t);
      const levels = buildingLevels(t);
      const roof = roofShape(t);
      const material = materialOf(WALL, t["building:material"] ?? t["building:facade:material"]);
      const colour = osmColour(t["building:colour"] ?? t["building:facade:colour"]);
      const roofMaterial = materialOf(ROOF, t["roof:material"]);
      const roofColour = osmColour(t["roof:colour"]);
      out.buildings.push({
        h,
        kind: buildingKind(t, h),
        ...(levels ? { levels } : {}),
        ...(roof ? { roof } : {}),
        ...(material ? { material } : {}),
        ...(colour ? { colour } : {}),
        ...(roofMaterial ? { roofMaterial } : {}),
        ...(roofColour ? { roofColour } : {}),
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
