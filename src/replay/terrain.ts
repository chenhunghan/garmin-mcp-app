/**
 * Landscape around the route. Next to the path the ground follows the run's
 * recorded elevation (with a slightly sunken path bed); further out, hills
 * grow out of the route's own height trend, rising to ridged mountains at the
 * horizon. There is no map data, so the landscape is generated — only the
 * path and its elevation are real.
 *
 * Two meshes: a fine grid over the route (a few meters per cell) and a coarse
 * one out to the horizon underneath it. The material adds per-pixel relief
 * and color from world-space noise, so the ground holds up close to the camera.
 */
import * as THREE from "three/webgpu";
import {
  cameraPosition,
  clamp,
  color,
  float,
  max,
  mix,
  normalWorld,
  normalize,
  positionWorld,
  select,
  smoothstep,
  texture,
  transformNormalToView,
  uniform,
  vec2,
  vec3,
  vertexColor,
} from "three/tsl";
import type { Node } from "three/webgpu";
import type { Track } from "./track.ts";
import type { LandCover } from "./map-layers.ts";
import { lampAt } from "./furniture.ts";
import {
  G,
  GROUND_IDS,
  groundNormal,
  heightBlend,
  layerIndex,
  mixSample,
  worldNoise,
  type SurfaceSet,
} from "./surfaces.ts";

/** Seeded 2D gradient-ish noise + fBm (CPU side, for heights). */
export function makeNoise(seed: number) {
  const perm = new Uint8Array(512);
  let s = seed >>> 0 || 1;
  const rand = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [p[i], p[j]] = [p[j]!, p[i]!];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255]!;
  const grad = (h: number) => (h / 255) * 2 - 1;
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const noise = (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const X = xi & 255;
    const Y = yi & 255;
    const v00 = grad(perm[perm[X]! + Y]!);
    const v10 = grad(perm[perm[X + 1]! + Y]!);
    const v01 = grad(perm[perm[X]! + Y + 1]!);
    const v11 = grad(perm[perm[X + 1]! + Y + 1]!);
    const u = fade(xf);
    const v = fade(yf);
    return (v00 * (1 - u) + v10 * u) * (1 - v) + (v01 * (1 - u) + v11 * u) * v;
  };
  const fbm = (x: number, y: number, octaves = 5) => {
    let sum = 0;
    let amp = 0.5;
    let f = 1;
    for (let o = 0; o < octaves; o++) {
      sum += amp * noise(x * f, y * f);
      f *= 2.03;
      amp *= 0.5;
    }
    return sum;
  };
  /** Ridged multifractal in [0, ~1]: sharp crests, soft valleys. */
  const ridged = (x: number, y: number, octaves = 5) => {
    let sum = 0;
    let amp = 0.55;
    let f = 1;
    let weight = 1;
    for (let o = 0; o < octaves; o++) {
      let n = 1 - Math.abs(noise(x * f + o * 17.3, y * f - o * 9.1) * 1.6);
      n = Math.max(0, n) ** 2 * weight;
      weight = Math.min(1, n * 1.6);
      sum += n * amp;
      f *= 2.1;
      amp *= 0.5;
    }
    return sum;
  };
  return { noise, fbm, ridged, rand };
}

export type Season = "spring" | "summer" | "autumn" | "winter";

export function seasonOf(startLocal: string | null, lat: number | null): Season {
  const month = startLocal ? Number(startLocal.slice(5, 7)) : 6;
  const south = (lat ?? 1) < 0;
  const m = south ? ((month + 5) % 12) + 1 : month;
  if (m >= 3 && m <= 5) return "spring";
  if (m >= 6 && m <= 8) return "summer";
  if (m >= 9 && m <= 11) return "autumn";
  return "winter";
}

const PALETTE: Record<Season, { lush: string; dry: string; accent: string; dark: string }> = {
  spring: { lush: "#4d8a2e", dry: "#86a347", accent: "#a3c25a", dark: "#2f5c22" },
  summer: { lush: "#4a7f2a", dry: "#9a9a4c", accent: "#77983a", dark: "#2c5420" },
  autumn: { lush: "#5f7a2c", dry: "#a88d45", accent: "#b9853f", dark: "#3d5222" },
  winter: { lush: "#5d6b40", dry: "#8a7e5e", accent: "#776e52", dark: "#3e4a2e" },
};

export interface Terrain {
  group: THREE.Group;
  heightAt(x: number, z: number): number;
  /** Distance to the route (m), approximate */
  distanceAt(x: number, z: number): number;
  size: number;
  center: { x: number; z: number };
  /** Switch the ground to scanned materials (asset pack), or back to generated detail */
  setSurfaces(set: SurfaceSet | null): void;
  dispose(): void;
}

export function smoothstepJs(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** A regular grid of values with lookup matching PlaneGeometry's triangles. */
class Grid {
  readonly h: Float32Array;
  /** Stride each chunk is drawn at, keyed by its first lattice index */
  readonly strides = new Map<number, number>();
  chunkCells = 0;
  constructor(
    readonly x0: number,
    readonly z0: number,
    readonly step: number,
    readonly res: number,
  ) {
    this.h = new Float32Array((res + 1) * (res + 1));
  }
  /**
   * Height of the surface as drawn: within a coarse chunk the triangles span
   * several lattice cells, so sample the same corners they do.
   */
  sampleDrawn(x: number, z: number) {
    const fx = Math.max(0, Math.min(this.res - 1e-6, (x - this.x0) / this.step));
    const fz = Math.max(0, Math.min(this.res - 1e-6, (z - this.z0) / this.step));
    const c = this.chunkCells;
    const ci = Math.floor(fx / c) * c;
    const cj = Math.floor(fz / c) * c;
    const s = this.strides.get(cj * (this.res + 1) + ci) ?? 1;
    if (s === 1) return this.sample(this.h, x, z);
    const lx = (fx - ci) / s;
    const lz = (fz - cj) / s;
    const a = Math.min(Math.floor(lx), Math.floor((Math.min(c, this.res - ci) - 1e-6) / s));
    const b = Math.min(Math.floor(lz), Math.floor((Math.min(c, this.res - cj) - 1e-6) / s));
    const u = lx - a;
    const v = lz - b;
    const r = this.res + 1;
    const at = (i: number, j: number) =>
      this.h[Math.min(this.res, cj + j * s) * r + Math.min(this.res, ci + i * s)]!;
    const h00 = at(a, b);
    const h10 = at(a + 1, b);
    const h01 = at(a, b + 1);
    const h11 = at(a + 1, b + 1);
    if (u + v <= 1) return h00 + (h10 - h00) * u + (h01 - h00) * v;
    return h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
  }
  contains(x: number, z: number) {
    const fx = (x - this.x0) / this.step;
    const fz = (z - this.z0) / this.step;
    return fx >= 0 && fz >= 0 && fx <= this.res && fz <= this.res;
  }
  sample(arr: Float32Array, x: number, z: number) {
    const fx = (x - this.x0) / this.step;
    const fz = (z - this.z0) / this.step;
    const i = Math.max(0, Math.min(this.res - 1, Math.floor(fx)));
    const j = Math.max(0, Math.min(this.res - 1, Math.floor(fz)));
    const u = Math.max(0, Math.min(1, fx - i));
    const v = Math.max(0, Math.min(1, fz - j));
    const r = this.res + 1;
    const a = arr[j * r + i]!;
    const b = arr[j * r + i + 1]!;
    const c = arr[(j + 1) * r + i]!;
    const d = arr[(j + 1) * r + i + 1]!;
    if (u + v <= 1) return a + (b - a) * u + (c - a) * v;
    return d + (c - d) * (1 - u) + (b - d) * (1 - v);
  }
}

export function buildTerrain(
  track: Track,
  opts: {
    seed: number;
    season: Season;
    snow: number;
    /** Real ground height in scene units (m, relative to the track's lowest point) */
    ground?: (x: number, z: number) => number;
    /** OpenStreetMap land cover, painted into the ground color */
    landCover?: LandCover | null;
  },
): Terrain {
  const { bounds } = track;
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ, 200);
  const center = { x: (bounds.minX + bounds.maxX) / 2, z: (bounds.minZ + bounds.maxZ) / 2 };
  const size = span + 2 * Math.min(4000, Math.max(1800, span * 1.2));
  const noise = makeNoise(opts.seed);
  const relief = track.maxY - track.minY;
  const hillAmp = 6 + Math.min(60, span * 0.012) + relief * 0.35;
  const mountainAmp = 90 + Math.min(260, span * 0.06) + relief;

  // ── Distance to the route, its height there, and the route's height trend,
  // on a coarse grid: route points splat into the cells around them ──
  const cStep = Math.max(10, size / 640);
  const coarse = new Grid(center.x - size / 2, center.z - size / 2, cStep, Math.ceil(size / cStep));
  const cr = coarse.res + 1;
  const cDist = new Float32Array(cr * cr).fill(1e9);
  const cY = new Float32Array(cr * cr);
  const pts: { x: number; z: number; y: number }[] = [];
  let lastS = -Infinity;
  const path = track.dense;
  for (let i = 0; i < path.n; i++) {
    if (path.s[i]! - lastS < 2 && i !== path.n - 1) continue;
    lastS = path.s[i]!;
    pts.push({ x: path.x[i]!, z: path.z[i]!, y: path.y[i]! });
  }
  // Nearest route point for every coarse cell: seed the cells under the
  // route, then sweep forward and backward passing nearest-point ids to
  // neighbors (a vector distance transform: continuous everywhere)
  const ids = new Int32Array(cr * cr).fill(-1);
  const cellD = (k: number, id: number) => {
    const p = pts[id]!;
    const i = k % cr;
    const j = Math.floor(k / cr);
    return Math.hypot(coarse.x0 + i * cStep - p.x, coarse.z0 + j * cStep - p.z);
  };
  pts.forEach((p, id) => {
    const ci = Math.round((p.x - coarse.x0) / cStep);
    const cj = Math.round((p.z - coarse.z0) / cStep);
    for (let j = Math.max(0, cj - 2); j <= Math.min(coarse.res, cj + 2); j++) {
      for (let i = Math.max(0, ci - 2); i <= Math.min(coarse.res, ci + 2); i++) {
        const k = j * cr + i;
        const d = cellD(k, id);
        if (d < cDist[k]!) {
          cDist[k] = d;
          ids[k] = id;
        }
      }
    }
  });
  const relax = (k: number, n: number) => {
    const id = ids[n]!;
    if (id < 0) return;
    const d = cellD(k, id);
    if (d < cDist[k]!) {
      cDist[k] = d;
      ids[k] = id;
    }
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j <= coarse.res; j++) {
      for (let i = 0; i <= coarse.res; i++) {
        const k = j * cr + i;
        if (i > 0) relax(k, k - 1);
        if (j > 0) {
          relax(k, k - cr);
          if (i > 0) relax(k, k - cr - 1);
          if (i < coarse.res) relax(k, k - cr + 1);
        }
      }
      for (let i = coarse.res; i >= 0; i--) if (i < coarse.res) relax(j * cr + i, j * cr + i + 1);
    }
    for (let j = coarse.res; j >= 0; j--) {
      for (let i = coarse.res; i >= 0; i--) {
        const k = j * cr + i;
        if (i < coarse.res) relax(k, k + 1);
        if (j < coarse.res) {
          relax(k, k + cr);
          if (i < coarse.res) relax(k, k + cr + 1);
          if (i > 0) relax(k, k + cr - 1);
        }
      }
      for (let i = 0; i <= coarse.res; i++) if (i > 0) relax(j * cr + i, j * cr + i - 1);
    }
  }
  for (let k = 0; k < ids.length; k++) cY[k] = ids[k]! >= 0 ? pts[ids[k]!]!.y : 0;
  // Where two parts of the route pass close at different heights (a loop's
  // start and finish, barometric drift), the nearest point's height jumps
  // between them: blur it so the ground ramps instead of forming a cliff
  const blurred = new Float32Array(cY.length);
  for (let pass = 0; pass < 6; pass++) {
    for (let j = 0; j <= coarse.res; j++) {
      for (let i = 0; i <= coarse.res; i++) {
        let sum = 0;
        let n = 0;
        for (let b = -1; b <= 1; b++) {
          for (let a = -1; a <= 1; a++) {
            const ii = i + a;
            const jj = j + b;
            if (ii < 0 || jj < 0 || ii > coarse.res || jj > coarse.res) continue;
            sum += cY[jj * cr + ii]!;
            n++;
          }
        }
        blurred[j * cr + i] = sum / n;
      }
    }
    cY.set(blurred);
  }
  // Inverse-distance-weighted route height: the far field's base level
  const sparse = pts.filter((_, k) => k % Math.max(1, Math.floor(pts.length / 160)) === 0);
  const cBase = coarse.h;
  for (let j = 0; j <= coarse.res; j++) {
    for (let i = 0; i <= coarse.res; i++) {
      const x = coarse.x0 + i * cStep;
      const z = coarse.z0 + j * cStep;
      let ws = 0;
      let vs = 0;
      for (const p of sparse) {
        const w = 1 / ((p.x - x) ** 2 + (p.z - z) ** 2 + 900);
        ws += w;
        vs += w * p.y;
      }
      const k = j * cr + i;
      cBase[k] = ws > 0 ? vs / ws : 0;
    }
  }

  // Exact nearest route point, for vertices close to the path
  const cell = 12;
  const buckets = new Map<number, number[]>();
  const bkey = (cx: number, cz: number) => (cx + 32768) * 65536 + (cz + 32768);
  pts.forEach((p, k) => {
    const key = bkey(Math.floor(p.x / cell), Math.floor(p.z / cell));
    let list = buckets.get(key);
    if (!list) buckets.set(key, (list = []));
    list.push(k);
  });
  const nearest = (x: number, z: number) => {
    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);
    let best = Infinity;
    let nearY = 0;
    for (let a = -6; a <= 6; a++) {
      for (let b = -6; b <= 6; b++) {
        const list = buckets.get(bkey(cx + a, cz + b));
        if (!list) continue;
        for (const k of list) {
          const p = pts[k]!;
          const d = (p.x - x) ** 2 + (p.z - z) ** 2;
          if (d < best) {
            best = d;
            nearY = p.y;
          }
        }
      }
    }
    if (!Number.isFinite(best)) return { dist: Infinity, y: 0, nearY: 0 };
    // Height: a blend of every route point nearly as close as the nearest one,
    // so the ground ramps smoothly between nearby parts of the route
    const dmin = Math.sqrt(best);
    let ws = 0;
    let ys = 0;
    for (let a = -6; a <= 6; a++) {
      for (let b = -6; b <= 6; b++) {
        const list = buckets.get(bkey(cx + a, cz + b));
        if (!list) continue;
        for (const k of list) {
          const p = pts[k]!;
          const d = Math.sqrt((p.x - x) ** 2 + (p.z - z) ** 2);
          const w = Math.exp(-(((d - dmin) / 10) ** 2));
          if (w < 1e-3) continue;
          ws += w;
          ys += w * p.y;
        }
      }
    }
    return { dist: dmin, y: ws > 0 ? ys / ws : 0, nearY };
  };

  /** Ground height and distance to the path at (x, z). */
  const field = (x: number, z: number, exact: boolean) => {
    let dist = coarse.sample(cDist, x, z);
    let ry = coarse.sample(cY, x, z);
    // Right by the path the ground may not rise above the path itself, or a
    // stretch of the route (drifting altimeter, a loop's overlapping ends)
    // disappears under it
    let cap = Infinity;
    if (exact && dist < 70) {
      const n = nearest(x, z);
      if (n.dist < 12) cap = n.nearY - 0.16 + Math.max(0, n.dist - 2.5) * 0.6;
      if (Number.isFinite(n.dist)) {
        // Exact near the path, easing to the coarse field so there's no seam
        const t = smoothstepJs(45, 70, dist);
        dist = n.dist + (dist - n.dist) * t;
        ry = n.y + (ry - n.y) * t;
      }
    }
    if (opts.ground) {
      // Real terrain: the measured ground, with the path bed eased into it
      const w = smoothstepJs(3.5, 30, dist);
      return { h: Math.min(cap, (ry - 0.16) * (1 - w) + opts.ground(x, z) * w), dist };
    }
    const base = coarse.sample(cBase, x, z);
    const hills =
      noise.fbm(x / 520, z / 520) * hillAmp +
      noise.fbm(x / 140 + 17, z / 140 - 5, 4) * hillAmp * 0.18 +
      noise.fbm(x / 28 - 3, z / 28 + 11, 3) * 0.7;
    const mountains =
      noise.ridged(x / 1900 + 3.7, z / 1900 - 1.3) * mountainAmp * smoothstepJs(700, 2400, dist);
    const far = base + hills * smoothstepJs(12, 240, dist) + mountains;
    // Gentle undulation beside the path, so the verge isn't ironed flat
    const verge = noise.fbm(x / 9, z / 9, 3) * 0.35 * smoothstepJs(3, 14, dist);
    const w = smoothstepJs(3.5, 160, dist);
    return { h: Math.min(cap, (ry - 0.16) * (1 - w) + far * w + verge * (1 - w)), dist };
  };

  // ── Meshes ──
  const pal = PALETTE[opts.season];
  const lush = new THREE.Color(pal.lush);
  const dry = new THREE.Color(pal.dry);
  const dark = new THREE.Color(pal.dark);
  const accent = new THREE.Color(pal.accent);
  const tmp = new THREE.Color();
  /** Large-scale meadow color (linear RGB), baked per vertex. */
  const macroColor = (x: number, z: number, out: Float32Array, o: number) => {
    if (opts.ground) {
      // Real terrain: no invented meadow patches; land cover comes from the map
      out[o] = lush.r;
      out[o + 1] = lush.g;
      out[o + 2] = lush.b;
      return;
    }
    const big = noise.fbm(x / 290 + 31, z / 290 - 7, 4) * 0.5 + 0.5;
    const mid = noise.fbm(x / 33 - 11, z / 33 + 5, 3) * 0.5 + 0.5;
    tmp.copy(lush).lerp(dry, smoothstepJs(0.35, 0.95, big) * 0.45);
    tmp.lerp(dark, smoothstepJs(0.6, 0.15, mid) * 0.38);
    tmp.lerp(accent, smoothstepJs(0.7, 0.9, mid) * 0.3);
    out[o] = tmp.r;
    out[o + 1] = tmp.g;
    out[o + 2] = tmp.b;
  };

  const ground = groundMaterial(opts.snow, opts.landCover ?? null, opts.season);
  const material = ground.material;
  const group = new THREE.Group();
  group.name = "terrain";
  const geos: THREE.BufferGeometry[] = [];

  /**
   * Heights on a lattice, cut into chunks (frustum-culled separately) whose
   * resolution drops with distance from the route; skirts hide the cracks
   * where neighboring chunks differ in resolution.
   */
  const lattice = (
    x0: number,
    z0: number,
    extent: number,
    res: number,
    exact: boolean,
    drop: number,
    chunkCells: number,
    strideFor: (dist: number) => number,
  ) => {
    const grid = new Grid(x0, z0, extent / res, res);
    grid.chunkCells = chunkCells;
    const r = res + 1;
    const pd = new Float32Array(r * r);
    for (let j = 0; j <= res; j++) {
      for (let i = 0; i <= res; i++) {
        const f = field(x0 + i * grid.step, z0 + j * grid.step, exact);
        grid.h[j * r + i] = f.h - drop;
        pd[j * r + i] = Math.min(f.dist, 500);
      }
    }
    // Normals from the whole lattice, so chunk borders shade continuously
    const H = (i: number, j: number) =>
      grid.h[Math.max(0, Math.min(res, j)) * r + Math.max(0, Math.min(res, i))]!;
    for (let cj = 0; cj < res; cj += chunkCells) {
      for (let ci = 0; ci < res; ci += chunkCells) {
        const ni = Math.min(chunkCells, res - ci);
        const nj = Math.min(chunkCells, res - cj);
        // Resolution from the closest the route comes to this chunk
        let closest = Infinity;
        for (let j = cj; j <= cj + nj; j++) {
          for (let i = ci; i <= ci + ni; i++) closest = Math.min(closest, pd[j * r + i]!);
        }
        let stride = strideFor(closest);
        while (stride > 1 && (ni % stride || nj % stride)) stride >>= 1;
        grid.strides.set(cj * r + ci, stride);
        const ci2 = ni / stride;
        const cj2 = nj / stride;
        const verts = (ci2 + 1) * (cj2 + 1);
        const skirt = 2 * (ci2 + cj2);
        const pos = new Float32Array((verts + skirt) * 3);
        const nor = new Float32Array((verts + skirt) * 3);
        const col = new Float32Array((verts + skirt) * 3);
        const vi = (a: number, b: number) => b * (ci2 + 1) + a;
        const put = (k: number, i: number, j: number, dy: number) => {
          const x = x0 + i * grid.step;
          const z = z0 + j * grid.step;
          pos[k * 3] = x;
          pos[k * 3 + 1] = H(i, j) - dy;
          pos[k * 3 + 2] = z;
          const nx = H(i - 1, j) - H(i + 1, j);
          const nz = H(i, j - 1) - H(i, j + 1);
          const ny = 2 * grid.step;
          const l = Math.hypot(nx, ny, nz);
          nor[k * 3] = nx / l;
          nor[k * 3 + 1] = ny / l;
          nor[k * 3 + 2] = nz / l;
          macroColor(x, z, col, k * 3);
        };
        for (let b = 0; b <= cj2; b++)
          for (let a = 0; a <= ci2; a++) put(vi(a, b), ci + a * stride, cj + b * stride, 0);
        const index: number[] = [];
        for (let b = 0; b < cj2; b++) {
          for (let a = 0; a < ci2; a++) {
            const p00 = vi(a, b);
            const p10 = vi(a + 1, b);
            const p01 = vi(a, b + 1);
            const p11 = vi(a + 1, b + 1);
            index.push(p00, p01, p10, p10, p01, p11);
          }
        }
        // Skirt: the border loop, repeated 4 m lower
        const border: [number, number][] = [];
        for (let a = 0; a < ci2; a++) border.push([a, 0]);
        for (let b = 0; b < cj2; b++) border.push([ci2, b]);
        for (let a = ci2; a > 0; a--) border.push([a, cj2]);
        for (let b = cj2; b > 0; b--) border.push([0, b]);
        border.forEach(([a, b], k) => put(verts + k, ci + a * stride, cj + b * stride, 4));
        for (let k = 0; k < border.length; k++) {
          const [a0, b0] = border[k]!;
          const [a1, b1] = border[(k + 1) % border.length]!;
          const t0 = vi(a0, b0);
          const t1 = vi(a1, b1);
          const s0 = verts + k;
          const s1 = verts + ((k + 1) % border.length);
          index.push(t0, s0, t1, t1, s0, s1, t0, t1, s0, t1, s1, s0);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
        geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
        geo.setIndex(index);
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, material);
        mesh.receiveShadow = true;
        group.add(mesh);
        geos.push(geo);
      }
    }
    return grid;
  };

  // Route area: 3 m cells by the path, coarser away from it. Horizon: a
  // coarse lattice a little lower underneath, so the route area always wins
  const innerExtent = span + 600;
  const innerRes = Math.min(1080, Math.max(240, Math.ceil(innerExtent / 3 / 8) * 8));
  const inner = lattice(
    center.x - innerExtent / 2,
    center.z - innerExtent / 2,
    innerExtent,
    innerRes,
    true,
    0,
    40,
    (d) => (d < 60 ? 1 : d < 250 ? 2 : d < 600 ? 4 : 8),
  );
  const outer = lattice(center.x - size / 2, center.z - size / 2, size, 320, false, 0.8, 40, (d) =>
    d < 1500 ? 2 : 4,
  );

  return {
    group,
    heightAt(x, z) {
      return inner.contains(x, z) ? inner.sampleDrawn(x, z) : outer.sampleDrawn(x, z);
    },
    distanceAt(x, z) {
      return coarse.sample(cDist, x, z);
    },
    size,
    center,
    setSurfaces: ground.setSurfaces,
    dispose() {
      for (const g of geos) g.dispose();
      material.dispose();
    },
  };
}

// ── Detail texture ──

/** Tileable gradient noise on a lattice of `period` cells per tile. */
function periodicNoise(seed: number) {
  const g = new Float32Array(512 * 2);
  let s = seed;
  for (let i = 0; i < 512; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const a = (s / 0x7fffffff) * Math.PI * 2;
    g[i * 2] = Math.cos(a);
    g[i * 2 + 1] = Math.sin(a);
  }
  const hash = (i: number, j: number) => ((i * 73856093) ^ (j * 19349663)) & 511;
  return (x: number, y: number, period: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const w = (a: number) => ((a % period) + period) % period;
    const dot = (i: number, j: number, dx: number, dy: number) => {
      const h = hash(w(i), w(j));
      return g[h * 2]! * dx + g[h * 2 + 1]! * dy;
    };
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const a = dot(xi, yi, xf, yf);
    const b = dot(xi + 1, yi, xf - 1, yf);
    const c = dot(xi, yi + 1, xf, yf - 1);
    const d = dot(xi + 1, yi + 1, xf - 1, yf - 1);
    return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 1.4;
  };
}

/**
 * One tileable RGBA texture with everything the ground shader needs up close:
 * R,G = slope of a small relief height (the normal's tilt), B = brightness
 * variation, A = gravel cells. Built once; sampling it replaces ~25 noise
 * evaluations per pixel.
 */
let detailCache: THREE.DataTexture | null = null;
function detailTexture(): THREE.DataTexture {
  if (detailCache) return detailCache;
  const N = 512;
  const n = periodicNoise(1337);
  const n2 = periodicNoise(4242);
  const height = new Float32Array(N * N);
  const bright = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const u = i / N;
      const v = j / N;
      let h = 0;
      let amp = 1;
      for (const p of [4, 8, 16, 32, 64]) {
        h += n(u * p, v * p, p) * amp;
        amp *= 0.55;
      }
      height[j * N + i] = h;
      bright[j * N + i] = n2(u * 12, v * 12, 12) * 0.6 + n2(u * 48, v * 48, 48) * 0.4;
    }
  }
  // Gravel: distance to random points on a wrapped 24×24 grid (Worley)
  const cells = 24;
  const pts: number[] = [];
  let s = 99;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let k = 0; k < cells * cells; k++) pts.push(rnd(), rnd());
  const data = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      const hx = height[j * N + ((i + 1) % N)]! - height[j * N + ((i + N - 1) % N)]!;
      const hz = height[((j + 1) % N) * N + i]! - height[((j + N - 1) % N) * N + i]!;
      const cx = (i / N) * cells;
      const cz = (j / N) * cells;
      let best = 9;
      for (let a = -1; a <= 1; a++) {
        for (let b = -1; b <= 1; b++) {
          const gx = (((Math.floor(cx) + a) % cells) + cells) % cells;
          const gz = (((Math.floor(cz) + b) % cells) + cells) % cells;
          const px = Math.floor(cx) + a + pts[(gz * cells + gx) * 2]!;
          const pz = Math.floor(cz) + b + pts[(gz * cells + gx) * 2 + 1]!;
          best = Math.min(best, Math.hypot(px - cx, pz - cz));
        }
      }
      data[k * 4] = Math.max(0, Math.min(255, 128 + hx * 90));
      data[k * 4 + 1] = Math.max(0, Math.min(255, 128 + hz * 90));
      data[k * 4 + 2] = Math.max(0, Math.min(255, 128 + bright[k]! * 160));
      data[k * 4 + 3] = Math.max(0, Math.min(255, best * 255));
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  detailCache = tex;
  return tex;
}

/**
 * Meadow (baked per-vertex color), dirt path, rock and snow, with relief and
 * fine color from the detail texture at two scales (breaks up tiling) — or,
 * once the asset pack's scanned materials arrive, those: the mapped land
 * cover picks each spot's material, rock takes the steep slopes, and worn
 * patches break up the green.
 */
function groundMaterial(snow: number, landCover: LandCover | null, season: Season) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  const snowU = uniform(snow);
  const slope = float(1).sub(normalWorld.y);
  const snowMix = snowU.mul(smoothstep(0.55, 0.25, slope));
  const p = positionWorld.xz;
  const near = smoothstep(260, 25, positionWorld.distance(cameraPosition));

  const generated = () => {
    const tex = detailTexture();
    const a = texture(tex, p.div(7));
    const b = texture(tex, vec2(p.y, p.x.negate()).div(31));
    const fine = a.b.mul(0.6).add(b.b.mul(0.4));
    const variation = mix(float(0.86), float(1.1), fine);
    let grass = vertexColor().mul(variation);
    if (landCover) {
      // OpenStreetMap land cover where mapped; plain meadow elsewhere
      const lc = texture(
        landCover.texture,
        p.sub(vec2(landCover.x0, landCover.z0)).div(landCover.size),
      );
      grass = mix(grass, lc.rgb.mul(variation), lc.a);
    }
    // Rock on steep slopes; the trail itself is a mesh (route.ts), independent
    // of this grid's resolution
    const rockMix = smoothstep(0.3, 0.5, slope.add(b.b.sub(0.5).mul(0.2)));
    const rock = mix(color("#6f6a62"), color("#8f887e"), fine);
    const rocky = mix(grass, rock, rockMix);
    mat.colorNode = mix(rocky, color("#eef2f6").mul(mix(float(0.93), float(1.02), fine)), snowMix);
    mat.emissiveNode = mat.colorNode.mul(lampAt(p));
    mat.roughnessNode = mix(float(0.97), float(0.6), snowMix);
    mat.aoNode = null;
    // Relief: tilt the normal by the texture's slopes (two scales), fading with distance
    const tilt = a.rg.sub(0.5).mul(1.0).add(b.rg.sub(0.5).mul(0.6));
    const strength = near.mul(mix(float(0.7), float(1.5), rockMix));
    const g = vec3(tilt.x, 0, tilt.y).mul(strength);
    mat.normalNode = transformNormalToView(normalize(normalWorld.sub(g)));
  };

  const scanned = (set: SurfaceSet) => {
    const N = GROUND_IDS.length;
    const breakup = smoothstep(0.35, 0.65, worldNoise(p, 60, 0.13));
    // Each spot's material from the land cover (borders jittered ±1.5 m so
    // they aren't straight raster steps); unmapped ground is meadow
    let primary: Node<"float"> = float(G.lawn);
    if (landCover) {
      const jitter = vec2(worldNoise(p, 7, 0.31), worldNoise(p, 7, 0.77))
        .sub(0.5)
        .mul(3);
      const uv = p.add(jitter).sub(vec2(landCover.x0, landCover.z0)).div(landCover.size);
      const raw = texture(landCover.surfaceIndex, uv).r.mul(255);
      const inside = uv.x
        .greaterThan(0)
        .and(uv.x.lessThan(1))
        .and(uv.y.greaterThan(0))
        .and(uv.y.lessThan(1));
      primary = select(inside.and(raw.lessThan(254.5)), raw, float(G.lawn));
    }
    const veg = primary.lessThan(G.forest + 0.5).or(primary.equal(float(G.worn)));
    const A = set.sample(layerIndex(primary, N), p, breakup);
    // Rock on steep slopes; elsewhere patches of thinner grass with soil
    // showing (on lawns) or bare, trodden ground (in meadows and woods)
    const rockW = smoothstep(0.28, 0.5, slope);
    const patch = smoothstep(0.55, 0.9, worldNoise(p, 45, 0.52)).mul(0.8);
    const patchW = select(veg, patch, float(0));
    const patchLayer = select(primary.equal(float(G.lawn)), float(G.meadow), float(G.worn));
    const second = select(rockW.greaterThan(patchW), float(G.rock), patchLayer);
    const B = set.sample(layerIndex(second, N), p, breakup);
    const k = heightBlend(A.height, B.height, max(rockW, patchW));
    const s = mixSample(A, B, k);
    // Large-scale variation baked per vertex (generated landscapes), relative
    // to its base green, and the season on everything that grows
    const lush = new THREE.Color(PALETTE[season].lush);
    const macro = clamp(
      vertexColor().xyz.div(vec3(lush.r, lush.g, lush.b)),
      vec3(0.7, 0.7, 0.7),
      vec3(1.35, 1.35, 1.35),
    );
    const dry = season === "autumn" ? 0.18 : season === "winter" ? 0.3 : 0;
    const seasonal = mix(s.color, s.color.mul(vec3(1.18, 1.0, 0.62)), float(dry));
    const base = select(veg, seasonal.mul(macro), s.color);
    mat.colorNode = mix(
      base,
      color("#eef2f6").mul(mix(float(0.92), float(1.02), s.height)),
      snowMix,
    );
    // (Some scans' roughness reads glossy, ~0.3 for grass: ground is never that smooth)
    mat.roughnessNode = mix(max(s.rough, float(0.88)), float(0.6), snowMix);
    mat.aoNode = mix(float(1), s.ao, near.mul(0.85));
    mat.normalNode = transformNormalToView(
      groundNormal(normalWorld, s.tilt, near.mul(float(1).sub(snowMix.mul(0.7)))),
    );
  };

  generated();
  return {
    material: mat,
    setSurfaces(set: SurfaceSet | null) {
      if (set) scanned(set);
      else generated();
      mat.needsUpdate = true;
    },
  };
}
