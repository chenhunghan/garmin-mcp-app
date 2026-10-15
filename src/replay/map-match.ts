/**
 * Snap a GPS path onto OpenStreetMap ways. GPS between buildings drifts 5–20 m
 * (reflections, blocked sky); the mapped paths are usually within 1–3 m of
 * where the runner really was. Each point moves to the best nearby way —
 * preferring foot paths and the way the previous point used, so it doesn't
 * flicker between parallel streets — and the offsets are smoothed along the
 * route so the result stays a clean line. Points with no way nearby keep
 * their GPS position. Pure; unit-tested in tests/map-match.test.ts.
 */
import type { Road, RoadClass } from "../geo/types.ts";

/** How far (m) a point may move onto a way. */
const MAX_SNAP = 18;
/** Preference (m of extra distance accepted) by way class: runners use paths. */
const CLASS_BONUS: Record<RoadClass, number> = {
  path: 4,
  track: 3,
  steps: 1,
  residential: 2,
  service: 1.5,
  minor: 1,
  major: 0,
};
/** Extra preference for staying on the same way as the previous point. */
const STICKY = 5;

interface Segment {
  way: number;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  bonus: number;
}

export function mapMatch(
  x: ArrayLike<number>,
  z: ArrayLike<number>,
  s: ArrayLike<number>,
  roads: Road[],
): { x: Float32Array; z: Float32Array; matched: number } {
  const n = x.length;
  const cell = 25;
  const grid = new Map<string, Segment[]>();
  roads.forEach((r, way) => {
    if (r.cls === "major" && r.width > 10) return; // motorways/trunks: not where people run
    for (let i = 2; i < r.pts.length; i += 2) {
      const seg: Segment = {
        way,
        ax: r.pts[i - 2]!,
        az: r.pts[i - 1]!,
        bx: r.pts[i]!,
        bz: r.pts[i + 1]!,
        bonus: CLASS_BONUS[r.cls],
      };
      const x0 = Math.floor((Math.min(seg.ax, seg.bx) - MAX_SNAP) / cell);
      const x1 = Math.floor((Math.max(seg.ax, seg.bx) + MAX_SNAP) / cell);
      const z0 = Math.floor((Math.min(seg.az, seg.bz) - MAX_SNAP) / cell);
      const z1 = Math.floor((Math.max(seg.az, seg.bz) + MAX_SNAP) / cell);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const key = `${cx},${cz}`;
          let list = grid.get(key);
          if (!list) grid.set(key, (list = []));
          list.push(seg);
        }
      }
    }
  });

  const dx = new Float32Array(n);
  const dz = new Float32Array(n);
  const has = new Uint8Array(n);
  let prevWay = -1;
  let matched = 0;
  for (let i = 0; i < n; i++) {
    const px = x[i]!;
    const pz = z[i]!;
    const list = grid.get(`${Math.floor(px / cell)},${Math.floor(pz / cell)}`);
    let best = Infinity;
    let bx = 0;
    let bz = 0;
    let bway = -1;
    for (const g of list ?? []) {
      const vx = g.bx - g.ax;
      const vz = g.bz - g.az;
      const l2 = vx * vx + vz * vz || 1;
      const t = Math.max(0, Math.min(1, ((px - g.ax) * vx + (pz - g.az) * vz) / l2));
      const qx = g.ax + vx * t;
      const qz = g.az + vz * t;
      const d = Math.hypot(px - qx, pz - qz);
      if (d > MAX_SNAP) continue;
      const score = d - g.bonus - (g.way === prevWay ? STICKY : 0);
      if (score < best) {
        best = score;
        bx = qx;
        bz = qz;
        bway = g.way;
      }
    }
    if (bway >= 0) {
      dx[i] = bx - px;
      dz[i] = bz - pz;
      has[i] = 1;
      matched++;
    }
    prevWay = bway;
  }

  // Smooth the offsets over ±12 m of route; unmatched points pull toward zero
  const out = { x: new Float32Array(n), z: new Float32Array(n), matched };
  const R = 12;
  let lo = 0;
  let hi = 0;
  let sx = 0;
  let sz = 0;
  for (let i = 0; i < n; i++) {
    while (hi < n && s[hi]! <= s[i]! + R) {
      sx += dx[hi]!;
      sz += dz[hi]!;
      hi++;
    }
    while (s[lo]! < s[i]! - R) {
      sx -= dx[lo]!;
      sz -= dz[lo]!;
      lo++;
    }
    const k = hi - lo;
    out.x[i] = x[i]! + sx / k;
    out.z[i] = z[i]! + sz / k;
  }
  return out;
}

/** Even-odd point-in-polygon on a flat [x, z, …] ring. */
export function insidePolygon(px: number, pz: number, p: ArrayLike<number>): boolean {
  let c = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const xi = p[i]!;
    const zi = p[i + 1]!;
    const xj = p[j]!;
    const zj = p[j + 1]!;
    if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

/** Indices of footprints the path passes through (or within `margin` m of). */
export function buildingsOnPath(
  x: ArrayLike<number>,
  z: ArrayLike<number>,
  footprints: { pts: number[] }[],
  margin = 1.2,
): Set<number> {
  const hit = new Set<number>();
  const cell = 30;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < x.length; i++) {
    const key = `${Math.floor(x[i]! / cell)},${Math.floor(z[i]! / cell)}`;
    let list = grid.get(key);
    if (!list) grid.set(key, (list = []));
    list.push(i);
  }
  footprints.forEach((b, k) => {
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < b.pts.length; i += 2) {
      x0 = Math.min(x0, b.pts[i]!);
      x1 = Math.max(x1, b.pts[i]!);
      z0 = Math.min(z0, b.pts[i + 1]!);
      z1 = Math.max(z1, b.pts[i + 1]!);
    }
    for (let cx = Math.floor((x0 - margin) / cell); cx <= Math.floor((x1 + margin) / cell); cx++) {
      for (
        let cz = Math.floor((z0 - margin) / cell);
        cz <= Math.floor((z1 + margin) / cell);
        cz++
      ) {
        for (const i of grid.get(`${cx},${cz}`) ?? []) {
          const px = x[i]!;
          const pz = z[i]!;
          if (px < x0 - margin || px > x1 + margin || pz < z0 - margin || pz > z1 + margin)
            continue;
          if (insidePolygon(px, pz, b.pts) || edgeDistance(px, pz, b.pts) < margin) {
            hit.add(k);
            return;
          }
        }
      }
    }
  });
  return hit;
}

function edgeDistance(px: number, pz: number, p: ArrayLike<number>): number {
  let best = Infinity;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const ax = p[j]!;
    const az = p[j + 1]!;
    const vx = p[i]! - ax;
    const vz = p[i + 1]! - az;
    const l2 = vx * vx + vz * vz || 1;
    const t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / l2));
    best = Math.min(best, Math.hypot(px - ax - vx * t, pz - az - vz * t));
  }
  return best;
}

/**
 * Trees ([x, z, …] records of `stride` numbers) that don't stand on the path:
 * a tree within `margin` m of it would be run through.
 */
export function treesOffPath(
  x: ArrayLike<number>,
  z: ArrayLike<number>,
  trees: number[],
  stride = 4,
  margin = 1.6,
): number[] {
  const cell = 10;
  const grid = new Map<string, number[]>();
  for (let i = 1; i < x.length; i++) {
    const key = `${Math.floor(x[i]! / cell)},${Math.floor(z[i]! / cell)}`;
    let list = grid.get(key);
    if (!list) grid.set(key, (list = []));
    list.push(i);
  }
  const out: number[] = [];
  for (let k = 0; k < trees.length; k += stride) {
    const tx = trees[k]!;
    const tz = trees[k + 1]!;
    let hit = false;
    const cx = Math.floor(tx / cell);
    const cz = Math.floor(tz / cell);
    for (let gx = cx - 1; gx <= cx + 1 && !hit; gx++) {
      for (let gz = cz - 1; gz <= cz + 1 && !hit; gz++) {
        for (const i of grid.get(`${gx},${gz}`) ?? []) {
          // distance to the segment (i − 1, i)
          const ax = x[i - 1]!;
          const az = z[i - 1]!;
          const vx = x[i]! - ax;
          const vz = z[i]! - az;
          const l2 = vx * vx + vz * vz || 1;
          const t = Math.max(0, Math.min(1, ((tx - ax) * vx + (tz - az) * vz) / l2));
          if (Math.hypot(tx - ax - vx * t, tz - az - vz * t) < margin) {
            hit = true;
            break;
          }
        }
      }
    }
    if (!hit) for (let j = 0; j < stride; j++) out.push(trees[k + j]!);
  }
  return out;
}

/**
 * A test for "something is built or worn here" (where no grass grows): within
 * a line's half width (+ margin) of the run's path, roads and rivers, or
 * inside a building footprint. Lines are bucketed in a 16 m grid.
 */
export function groundBlocker(input: {
  path?: { x: ArrayLike<number>; z: ArrayLike<number>; halfWidth: number };
  lines: { pts: ArrayLike<number>; halfWidth: number }[];
  footprints: { pts: number[] }[];
}): (x: number, z: number) => boolean {
  const cell = 16;
  type Seg = { ax: number; az: number; bx: number; bz: number; hw: number };
  const segs = new Map<string, Seg[]>();
  const addSeg = (sg: Seg) => {
    const pad = sg.hw;
    for (
      let cx = Math.floor((Math.min(sg.ax, sg.bx) - pad) / cell);
      cx <= Math.floor((Math.max(sg.ax, sg.bx) + pad) / cell);
      cx++
    ) {
      for (
        let cz = Math.floor((Math.min(sg.az, sg.bz) - pad) / cell);
        cz <= Math.floor((Math.max(sg.az, sg.bz) + pad) / cell);
        cz++
      ) {
        const key = `${cx},${cz}`;
        let list = segs.get(key);
        if (!list) segs.set(key, (list = []));
        list.push(sg);
      }
    }
  };
  for (const l of input.lines) {
    for (let i = 2; i < l.pts.length; i += 2)
      addSeg({
        ax: l.pts[i - 2]!,
        az: l.pts[i - 1]!,
        bx: l.pts[i]!,
        bz: l.pts[i + 1]!,
        hw: l.halfWidth,
      });
  }
  if (input.path) {
    const { x, z, halfWidth } = input.path;
    for (let i = 1; i < x.length; i++)
      addSeg({ ax: x[i - 1]!, az: z[i - 1]!, bx: x[i]!, bz: z[i]!, hw: halfWidth });
  }
  const boxes = new Map<
    string,
    { pts: number[]; x0: number; x1: number; z0: number; z1: number }[]
  >();
  for (const f of input.footprints) {
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < f.pts.length; i += 2) {
      x0 = Math.min(x0, f.pts[i]!);
      x1 = Math.max(x1, f.pts[i]!);
      z0 = Math.min(z0, f.pts[i + 1]!);
      z1 = Math.max(z1, f.pts[i + 1]!);
    }
    const b = { pts: f.pts, x0, x1, z0, z1 };
    for (let cx = Math.floor(x0 / cell); cx <= Math.floor(x1 / cell); cx++) {
      for (let cz = Math.floor(z0 / cell); cz <= Math.floor(z1 / cell); cz++) {
        const key = `${cx},${cz}`;
        let list = boxes.get(key);
        if (!list) boxes.set(key, (list = []));
        list.push(b);
      }
    }
  }
  return (px, pz) => {
    const key = `${Math.floor(px / cell)},${Math.floor(pz / cell)}`;
    for (const sg of segs.get(key) ?? []) {
      const vx = sg.bx - sg.ax;
      const vz = sg.bz - sg.az;
      const l2 = vx * vx + vz * vz || 1;
      const t = Math.max(0, Math.min(1, ((px - sg.ax) * vx + (pz - sg.az) * vz) / l2));
      const dx = px - sg.ax - vx * t;
      const dz = pz - sg.az - vz * t;
      if (dx * dx + dz * dz < sg.hw * sg.hw) return true;
    }
    for (const b of boxes.get(key) ?? []) {
      if (px < b.x0 || px > b.x1 || pz < b.z0 || pz > b.z1) continue;
      if (insidePolygon(px, pz, b.pts)) return true;
    }
    return false;
  };
}
