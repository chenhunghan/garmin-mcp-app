/**
 * OpenStreetMap features in the replay: roads and paths draped on the
 * terrain, rivers and lakes, extruded buildings, and a land-cover texture
 * (forest, meadow, fields, built-up…) that colors the ground.
 */
import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { insidePolygon } from "./map-match.ts";
import { drape } from "./drape.ts";
import {
  abs,
  attribute,
  cameraPosition,
  dot,
  float,
  max,
  mix,
  normalWorld,
  normalize,
  positionWorld,
  pow,
  reflect,
  smoothstep,
  texture,
  time,
  transformNormalToView,
  vec2,
  vec3,
  vertexColor,
} from "three/tsl";
import { noiseTexture, withCloudShadows } from "./clouds.ts";
import { lampAt } from "./furniture.ts";
import type { Node } from "three/webgpu";
import {
  balconyMesh,
  balconyParts,
  buildingsGeometry,
  facadeLight,
  facadeMaterial,
  inEastAsia,
  type FacadeInput,
} from "./facade.ts";
import {
  G,
  GROUND_IDS,
  groundNormal,
  layerIndex,
  worldNoise,
  type SurfaceSet,
} from "./surfaces.ts";
import type { Surface } from "../geo/types.ts";

/** Ground material for each road surface */
const SURFACE_LAYER: Record<Surface, number> = {
  asphalt: G.asphalt,
  concrete: G.concrete,
  paving: G.paving,
  gravel: G.gravel,
  dirt: G.dirt,
  grass: G.worn,
  sand: G.sand,
  wood: G.paving,
};
import type { AreaKind, RunMap } from "../geo/types.ts";

const LAND_COLOR: Record<AreaKind, string> = {
  farmland: "#a39f55",
  grass: "#5f8c36",
  park: "#538d38",
  pitch: "#4c9440",
  scrub: "#5a663b",
  forest: "#2e4a23",
  residential: "#8f8b80",
  industrial: "#8a8580",
  sand: "#d6c79d",
  rock: "#8f8a82",
  wetland: "#4d6b4c",
  water: "#3b6176",
};
// Later kinds paint over earlier ones
const LAND_ORDER: AreaKind[] = [
  "farmland",
  "grass",
  "park",
  "scrub",
  "forest",
  "residential",
  "industrial",
  "pitch",
  "sand",
  "rock",
  "wetland",
  "water",
];

/** The ground material for each land kind (index into GROUND_IDS, see surfaces.ts) */
const LAND_SURFACE: Record<AreaKind, number> = {
  farmland: G.soil,
  grass: G.lawn,
  park: G.lawn,
  pitch: G.lawn,
  scrub: G.forest,
  forest: G.forest,
  residential: G.worn,
  industrial: G.gravel,
  sand: G.sand,
  rock: G.rock,
  wetland: G.meadow,
  water: G.meadow,
};
/** "Nothing mapped here" in the surface index */
export const NO_SURFACE = 255;

export interface LandCover {
  texture: THREE.CanvasTexture;
  /** Ground material per texel (R8: GROUND_IDS index, 255 = not mapped), nearest-sampled */
  surfaceIndex: THREE.DataTexture;
  /** World rectangle the texture covers */
  x0: number;
  z0: number;
  size: number;
  /** The mapped land kind at a point (null where nothing is mapped) */
  kindAt(x: number, z: number): AreaKind | null;
}

/** Rasterize land-cover polygons into a texture over a square of the ground. */
export function landCoverTexture(
  map: RunMap,
  x0: number,
  z0: number,
  size: number,
): LandCover | null {
  if (!map.areas.length) return null;
  const N = 2048;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = N;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, N, N);
  const k = N / size;
  for (const kind of LAND_ORDER) {
    ctx.fillStyle = LAND_COLOR[kind];
    for (const a of map.areas) {
      if (a.kind !== kind || a.pts.length < 6) continue;
      ctx.beginPath();
      for (let i = 0; i < a.pts.length; i += 2) {
        const px = (a.pts[i]! - x0) * k;
        const py = (a.pts[i + 1]! - z0) * k;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = 8;
  texture.flipY = false;

  // The same polygons as kind indices (1-based, in the red channel), for
  // lookups on the CPU (where grass grows)
  const M = 1024;
  const kc = document.createElement("canvas");
  kc.width = kc.height = M;
  const kctx = kc.getContext("2d", { willReadFrequently: true })!;
  const km = M / size;
  LAND_ORDER.forEach((kind, idx) => {
    kctx.fillStyle = `rgb(${idx + 1},0,0)`;
    for (const a of map.areas) {
      if (a.kind !== kind || a.pts.length < 6) continue;
      kctx.beginPath();
      for (let i = 0; i < a.pts.length; i += 2) {
        const px = (a.pts[i]! - x0) * km;
        const py = (a.pts[i + 1]! - z0) * km;
        if (i === 0) kctx.moveTo(px, py);
        else kctx.lineTo(px, py);
      }
      kctx.closePath();
      kctx.fill();
    }
  });
  const kinds = kctx.getImageData(0, 0, M, M).data;
  const index = new Uint8Array(M * M);
  for (let i = 0; i < M * M; i++) {
    const kind = kinds[i * 4 + 3]! >= 128 ? LAND_ORDER[kinds[i * 4]! - 1] : undefined;
    index[i] = kind ? LAND_SURFACE[kind] : NO_SURFACE;
  }
  const surfaceIndex = new THREE.DataTexture(index, M, M, THREE.RedFormat, THREE.UnsignedByteType);
  surfaceIndex.magFilter = surfaceIndex.minFilter = THREE.NearestFilter;
  surfaceIndex.generateMipmaps = false;
  surfaceIndex.needsUpdate = true;
  const kindAt = (x: number, z: number): AreaKind | null => {
    const i = Math.floor(((x - x0) / size) * M);
    const j = Math.floor(((z - z0) / size) * M);
    if (i < 0 || j < 0 || i >= M || j >= M) return null;
    const k = (j * M + i) * 4;
    // (anti-aliased edges blend indices: only trust fully covered pixels)
    if (kinds[k + 3]! < 250) return null;
    return LAND_ORDER[kinds[k]! - 1] ?? null;
  };
  return { texture, surfaceIndex, x0, z0, size, kindAt };
}

/** Make every triangle of a ground-hugging mesh face up (winding-agnostic). */
function faceUp(geo: THREE.BufferGeometry) {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const idx = geo.index!;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let t = 0; t < idx.count; t += 3) {
    a.fromBufferAttribute(pos, idx.getX(t));
    b.fromBufferAttribute(pos, idx.getX(t + 1));
    c.fromBufferAttribute(pos, idx.getX(t + 2));
    const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    if (ny < 0) {
      const tmp = idx.getX(t + 1);
      idx.setX(t + 1, idx.getX(t + 2));
      idx.setX(t + 2, tmp);
    }
  }
  return geo;
}

/** Densify a polyline to ≤ `step` m segments (so a draped ribbon follows the ground). */
function densify(pts: number[], step: number): number[] {
  const out: number[] = [pts[0]!, pts[1]!];
  for (let i = 2; i < pts.length; i += 2) {
    const ax = pts[i - 2]!;
    const az = pts[i - 1]!;
    const bx = pts[i]!;
    const bz = pts[i + 1]!;
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let k = 1; k <= n; k++) out.push(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n);
  }
  return out;
}

/** A flat ribbon of `width` along a polyline, `lift` above the ground. */
function ribbon(
  pts: number[],
  width: number,
  lift: number,
  heightAt: (x: number, z: number) => number,
  rgb: THREE.Color,
  /** Ground material (GROUND_IDS index) for the scanned surfaces */
  layer = 0,
): THREE.BufferGeometry | null {
  if (pts.length < 4) return null;
  const p = densify(pts, 2.5);
  const n = p.length / 2;
  const pos = new Float32Array(n * 6);
  const col = new Float32Array(n * 6);
  const lay = new Float32Array(n * 2).fill(layer);
  const across = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    let dx = p[b * 2]! - p[a * 2]!;
    let dz = p[b * 2 + 1]! - p[a * 2 + 1]!;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    for (let side = 0; side < 2; side++) {
      const s = side ? 1 : -1;
      const x = p[i * 2]! + dz * s * (width / 2);
      const z = p[i * 2 + 1]! - dx * s * (width / 2);
      const o = (i * 2 + side) * 3;
      pos[o] = x;
      pos[o + 1] = heightAt(x, z) + lift;
      pos[o + 2] = z;
      col[o] = rgb.r;
      col[o + 1] = rgb.g;
      col[o + 2] = rgb.b;
      across[i * 2 + side] = s;
    }
  }
  const index: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("aSurface", new THREE.BufferAttribute(lay, 1));
  geo.setAttribute("aAcross", new THREE.BufferAttribute(across, 1));
  geo.setIndex(index);
  return faceUp(geo);
}

export interface Occluder {
  pts: number[];
  roof: number;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/**
 * Distance from `from` toward `to` at which the line first enters a
 * building (Infinity when the view is clear). Samples every 0.4 m.
 */
export function firstBuildingHit(
  index: Map<string, Occluder[]>,
  from: THREE.Vector3,
  to: THREE.Vector3,
): number {
  const len = from.distanceTo(to);
  const steps = Math.ceil(len / 0.4);
  for (let k = 3; k <= steps; k++) {
    const t = k / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    const z = from.z + (to.z - from.z) * t;
    for (const o of index.get(`${Math.floor(x / 25)},${Math.floor(z / 25)}`) ?? []) {
      if (y > o.roof || x < o.x0 || x > o.x1 || z < o.z0 || z > o.z1) continue;
      if (insidePolygon(x, z, o.pts)) return t * len;
    }
  }
  return Infinity;
}

/** Occluders bucketed by 25 m cells. */
export function occluderIndex(occluders: Occluder[]): Map<string, Occluder[]> {
  const index = new Map<string, Occluder[]>();
  for (const o of occluders) {
    for (let cx = Math.floor(o.x0 / 25); cx <= Math.floor(o.x1 / 25); cx++) {
      for (let cz = Math.floor(o.z0 / 25); cz <= Math.floor(o.z1 / 25); cz++) {
        const key = `${cx},${cz}`;
        let list = index.get(key);
        if (!list) index.set(key, (list = []));
        list.push(o);
      }
    }
  }
  return index;
}

/** Small things worth drawing only near the camera (radius scaled by quality) */
export interface Detail {
  object: THREE.Object3D;
  x: number;
  z: number;
  radius: number;
}

export interface MapLayers {
  group: THREE.Group;
  details: Detail[];
  /** Footprints with their roof height (scene y), for camera collision */
  occluders: Occluder[];
  /** Roads and paths in scanned materials (asset pack), or back to plain colors */
  setSurfaces(set: SurfaceSet | null): void;
  /** Facades and roofs in scanned materials (asset pack) */
  setWallSurfaces(set: SurfaceSet): void;
  dispose(): void;
}

export function buildMapLayers(
  map: RunMap,
  heightAt: (x: number, z: number) => number,
  /** Distance to the route: buildings close to it get the most detail */
  distanceAt: (x: number, z: number) => number = () => 0,
): MapLayers {
  const group = new THREE.Group();
  group.name = "map";
  const disposables: { dispose(): void }[] = [];
  const add = (geos: THREE.BufferGeometry[], mat: THREE.Material, shadows = false) => {
    if (!geos.length) return;
    const geo = mergeGeometries(geos.map((g) => (g.index ? g.toNonIndexed() : g)))!;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.castShadow = shadows;
    group.add(mesh);
    disposables.push(geo, mat);
  };

  // Roads: asphalt or dirt, wider roads drawn under narrower ones
  const asphalt = new THREE.Color("#4a4d52");
  const lightPaving = new THREE.Color("#8d8984");
  const dirt = new THREE.Color("#a08a6a");
  const roads = [...map.roads].sort((a, b) => b.width - a.width);
  const roadGeos = roads
    .map((r) =>
      ribbon(
        r.pts,
        r.width,
        0.05 + Math.min(0.06, r.width * 0.004),
        heightAt,
        r.paved ? (r.cls === "path" || r.cls === "steps" ? lightPaving : asphalt) : dirt,
        SURFACE_LAYER[r.surface ?? (r.paved ? "asphalt" : "dirt")],
      ),
    )
    .filter((g): g is THREE.BufferGeometry => g !== null);
  const roadMat = drape(
    new THREE.MeshStandardNodeMaterial({
      vertexColors: true,
      roughness: 0.88,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    }),
    0.12,
  ) as THREE.MeshStandardNodeMaterial;
  roadMat.emissiveNode = vertexColor().xyz.mul(lampAt(positionWorld.xz));
  add(roadGeos, roadMat);
  const setRoadSurfaces = (set: SurfaceSet | null) => {
    if (!set) {
      roadMat.colorNode = null;
      roadMat.emissiveNode = vertexColor().xyz.mul(lampAt(positionWorld.xz));
      roadMat.normalNode = null;
      roadMat.roughnessNode = null;
      roadMat.aoNode = null;
    } else {
      const p = positionWorld.xz;
      const near = smoothstep(200, 20, positionWorld.distance(cameraPosition));
      const s = set.sample(
        layerIndex(attribute("aSurface", "float"), GROUND_IDS.length),
        p,
        smoothstep(0.35, 0.65, worldNoise(p, 50, 0.4)),
      );
      // Grime and wear collect along the edges
      const edge = smoothstep(0.62, 1, abs(attribute("aAcross", "float")));
      roadMat.colorNode = s.color.mul(float(1).sub(edge.mul(0.22)));
      roadMat.emissiveNode = roadMat.colorNode.mul(lampAt(p));
      roadMat.roughnessNode = max(s.rough, float(0.72));
      roadMat.aoNode = mix(float(1), s.ao, near.mul(0.8));
      roadMat.normalNode = transformNormalToView(groundNormal(normalWorld, s.tilt, near));
    }
    roadMat.needsUpdate = true;
  };

  // Water: lakes flat at their shore level, rivers draped
  const waterMat = () => drape(waterMaterial(), 0.1);
  const lakes: THREE.BufferGeometry[] = [];
  for (const a of map.areas) {
    if (a.kind !== "water" || a.pts.length < 8) continue;
    const contour: THREE.Vector2[] = [];
    let level = Infinity;
    for (let i = 0; i < a.pts.length; i += 2) {
      contour.push(new THREE.Vector2(a.pts[i]!, a.pts[i + 1]!));
      level = Math.min(level, heightAt(a.pts[i]!, a.pts[i + 1]!));
    }
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    if (!tris.length) continue;
    const pos = new Float32Array(contour.length * 3);
    contour.forEach((v, i) => pos.set([v.x, level + 0.12, v.y], i * 3));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setIndex(tris.flat());
    lakes.push(faceUp(geo));
  }
  add(lakes, waterMat());
  const white = new THREE.Color(1, 1, 1);
  const rivers = map.rivers
    .map((r) => ribbon(r.pts, r.width, 0.1, heightAt, white))
    .filter((g): g is THREE.BufferGeometry => g !== null);
  add(rivers, waterMat());

  // Buildings: footprints extruded from the lowest ground under them, with
  // generated facades (facade.ts)
  const facades: FacadeInput[] = [];
  const occluders: Occluder[] = [];
  for (const b of map.buildings) {
    if (b.pts.length < 6) continue;
    let ground = Infinity;
    let top = -Infinity;
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < b.pts.length; i += 2) {
      const h = heightAt(b.pts[i]!, b.pts[i + 1]!);
      ground = Math.min(ground, h);
      top = Math.max(top, h);
      x0 = Math.min(x0, b.pts[i]!);
      x1 = Math.max(x1, b.pts[i]!);
      z0 = Math.min(z0, b.pts[i + 1]!);
      z1 = Math.max(z1, b.pts[i + 1]!);
    }
    const height = b.h + (top - ground);
    occluders.push({ pts: b.pts, roof: ground + height, x0, x1, z0, z1 });
    const near = distanceAt((x0 + x1) / 2, (z0 + z1) / 2) < 150;
    facades.push({ building: b, ground, height, near, seed: facades.length });
  }
  // Cut into 350 m tiles, so the camera and the sun's shadow camera (a 44 m
  // box around the runner) draw only the tiles they see; as one mesh, the
  // shadow pass drew every building and balcony of the city each frame
  const TILE = 350;
  const tiles = new Map<string, FacadeInput[]>();
  for (const f of facades) {
    const p = f.building.pts;
    const key = `${Math.floor(p[0]! / TILE)},${Math.floor(p[1]! / TILE)}`;
    let list = tiles.get(key);
    if (!list) tiles.set(key, (list = []));
    list.push(f);
  }
  // Tiles nearest the route first: they get the balconies when there are many
  const tileList = [...tiles.entries()]
    .map(([key, list]) => {
      const [tx, tz] = key.split(",").map(Number) as [number, number];
      const cx = (tx + 0.5) * TILE;
      const cz = (tz + 0.5) * TILE;
      return { list, cx, cz, d: distanceAt(cx, cz) };
    })
    .sort((a, b) => a.d - b.d);
  let facadeMat = facadeMaterial();
  const facadeMeshes: THREE.Mesh[] = [];
  const region = inEastAsia(map.origin.lat, map.origin.lon) ? "eastAsia" : "other";
  const balconyShared = balconyParts();
  disposables.push(balconyShared.geometry, balconyShared.material);
  const budget = { balconies: 20000 };
  const details: Detail[] = [];
  for (const tile of tileList) {
    const { geometry, balconies } = buildingsGeometry(tile.list, budget, region);
    if (geometry) {
      const mesh = new THREE.Mesh(geometry, facadeMat);
      facadeMeshes.push(mesh);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
      disposables.push(geometry);
    }
    const inst = balconyMesh(balconies, balconyShared);
    if (inst) {
      group.add(inst);
      disposables.push(inst);
      details.push({ object: inst, x: tile.cx, z: tile.cz, radius: 360 });
    }
  }

  return {
    group,
    occluders,
    details,
    setSurfaces(set) {
      setRoadSurfaces(set);
    },
    setWallSurfaces(set) {
      const old = facadeMat;
      facadeMat = facadeMaterial(set);
      withCloudShadows(facadeMat);
      for (const m of facadeMeshes) m.material = facadeMat;
      old.dispose();
    },
    dispose() {
      for (const d of disposables) d.dispose();
      facadeMat.dispose();
    },
  };
}

/**
 * Water: ripples from two drifting samples of the noise field (flattened with
 * distance, so thin rivers don't sparkle), the sky mirrored more at grazing
 * angles, and the sun's glint from the low roughness.
 */
function waterMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({
    color: "#123038",
    roughness: 0.06,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
  const tex = noiseTexture();
  const p = positionWorld.xz;
  const h = (q: Node<"vec2">) => texture(tex, q).r;
  const slope = (scale: number, drift: [number, number]) => {
    const q = p.div(scale).add(vec2(time.mul(drift[0]), time.mul(drift[1])));
    const e = 1 / 256;
    return vec2(
      h(q.add(vec2(e, 0))).sub(h(q.sub(vec2(e, 0)))),
      h(q.add(vec2(0, e))).sub(h(q.sub(vec2(0, e)))),
    );
  };
  const dist = positionWorld.distance(cameraPosition);
  const amp = smoothstep(380, 15, dist).mul(2.2);
  const s = slope(31, [0.004, 0.0025])
    .add(slope(11, [-0.007, 0.005]).mul(0.6))
    .mul(amp);
  const n = normalize(vec3(s.x.negate(), 1, s.y.negate()));
  mat.normalNode = transformNormalToView(n);
  const V = normalize(positionWorld.sub(cameraPosition));
  const R = reflect(V, n);
  const sky = mix(facadeLight.horizon, facadeLight.zenith, smoothstep(0, 0.6, R.y));
  const cosV = abs(dot(V, n));
  const fres = float(0.03).add(pow(float(1).sub(cosV), 5).mul(0.7));
  mat.emissiveNode = sky.mul(fres).mul(0.85);
  return mat;
}
