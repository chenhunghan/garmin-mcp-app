/**
 * A seamless, skinned human body built without assets: the body is a signed
 * distance field (tapered capsules and ellipsoids blended with a smooth
 * union), meshed with surface nets, shaded with normals from the field's
 * gradient, and skinned to the runner's skeleton by distance to each bone.
 * Clothing is the same body inflated and trimmed, as separate skinned shells.
 */
import * as THREE from "three/webgpu";

export type Sdf = (x: number, y: number, z: number) => number;
type V = THREE.Vector3;

// ── SDF primitives ──

export function smin(a: number, b: number, k: number) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Ellipsoid (approximate distance, good near the surface). */
export function ellipsoid(c: V, r: V): Sdf & { box: THREE.Box3 } {
  const f = ((x: number, y: number, z: number) => {
    const px = (x - c.x) / r.x;
    const py = (y - c.y) / r.y;
    const pz = (z - c.z) / r.z;
    const k0 = Math.hypot(px, py, pz);
    const k1 = Math.hypot(px / r.x, py / r.y, pz / r.z);
    return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(r.x, r.y, r.z);
  }) as Sdf & { box: THREE.Box3 };
  f.box = new THREE.Box3(c.clone().sub(r), c.clone().add(r));
  return f;
}

/**
 * Round cone from a (radius ra) to b (radius rb), optionally squashed
 * front-to-back (`depth` < 1 makes the cross-section an ellipse).
 */
export function roundCone(
  a: V,
  b: V,
  ra: number,
  rb: number,
  depth = 1,
): Sdf & { box: THREE.Box3 } {
  const bax = b.x - a.x;
  const bay = b.y - a.y;
  const baz = (b.z - a.z) / depth;
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = ra - rb;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  const f = ((x: number, y: number, z: number) => {
    const pax = x - a.x;
    const pay = y - a.y;
    const paz = (z - a.z) / depth;
    const yv = pax * bax + pay * bay + paz * baz;
    const zv = yv - l2;
    const qx = pax * l2 - bax * yv;
    const qy = pay * l2 - bay * yv;
    const qz = paz * l2 - baz * yv;
    const x2 = qx * qx + qy * qy + qz * qz;
    const y2 = yv * yv * l2;
    const z2 = zv * zv * l2;
    const k = Math.sign(rr) * rr * rr * x2;
    let d: number;
    if (Math.sign(zv) * a2 * z2 > k) d = Math.sqrt(x2 + z2) * il2 - rb;
    else if (Math.sign(yv) * a2 * y2 < k) d = Math.sqrt(x2 + y2) * il2 - ra;
    else d = (Math.sqrt(x2 * a2 * il2) + yv * rr) * il2 - ra;
    return d * (depth < 1 ? (1 + depth) / 2 : 1);
  }) as Sdf & { box: THREE.Box3 };
  const r = Math.max(ra, rb);
  f.box = new THREE.Box3(
    new THREE.Vector3(Math.min(a.x, b.x) - r, Math.min(a.y, b.y) - r, Math.min(a.z, b.z) - r),
    new THREE.Vector3(Math.max(a.x, b.x) + r, Math.max(a.y, b.y) + r, Math.max(a.z, b.z) + r),
  );
  return f;
}

/** Smooth union of primitives, skipping those far from the point. */
export function blend(prims: (Sdf & { box: THREE.Box3 })[], k: number): Sdf & { box: THREE.Box3 } {
  const boxes = prims.map((p) => p.box);
  const f = ((x: number, y: number, z: number) => {
    let d = Infinity;
    for (let i = 0; i < prims.length; i++) {
      const b = boxes[i]!;
      // Lower bound on the distance to this primitive's box
      const dx = Math.max(b.min.x - x, 0, x - b.max.x);
      const dy = Math.max(b.min.y - y, 0, y - b.max.y);
      const dz = Math.max(b.min.z - z, 0, z - b.max.z);
      const lb = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (lb > d + k) continue;
      d = smin(d, prims[i]!(x, y, z), k);
    }
    return d;
  }) as Sdf & { box: THREE.Box3 };
  const box = new THREE.Box3();
  for (const b of boxes) box.union(b);
  f.box = box;
  return f;
}

// ── Surface nets ──

/** Mesh the zero level set of `sdf` inside `box` with cells of size `h`. */
export function surfaceNets(sdf: Sdf, box: THREE.Box3, h: number): THREE.BufferGeometry {
  const min = box.min.clone().subScalar(h * 2);
  const size = box.getSize(new THREE.Vector3()).addScalar(h * 4);
  const nx = Math.ceil(size.x / h) + 1;
  const ny = Math.ceil(size.y / h) + 1;
  const nz = Math.ceil(size.z / h) + 1;
  const field = new Float32Array(nx * ny * nz);
  const idx = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  for (let k = 0; k < nz; k++) {
    const z = min.z + k * h;
    for (let j = 0; j < ny; j++) {
      const y = min.y + j * h;
      for (let i = 0; i < nx; i++) field[idx(i, j, k)] = sdf(min.x + i * h, y, z);
    }
  }

  const positions: number[] = [];
  const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cidx = (i: number, j: number, k: number) => i + (nx - 1) * (j + (ny - 1) * k);
  const corners = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [0, 1, 1],
    [1, 1, 1],
  ] as const;
  const edges = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ] as const;
  const v = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const [a, b, d] = corners[c]!;
          v[c] = field[idx(i + a, j + b, k + d)]!;
          if (v[c]! < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let n = 0;
        for (const [e0, e1] of edges) {
          const a = v[e0]!;
          const b = v[e1]!;
          if (a < 0 === b < 0) continue;
          const t = a / (a - b);
          const c0 = corners[e0]!;
          const c1 = corners[e1]!;
          sx += c0[0] + (c1[0] - c0[0]) * t;
          sy += c0[1] + (c1[1] - c0[1]) * t;
          sz += c0[2] + (c1[2] - c0[2]) * t;
          n++;
        }
        cellVert[cidx(i, j, k)] = positions.length / 3;
        positions.push(
          min.x + (i + sx / n) * h,
          min.y + (j + sy / n) * h,
          min.z + (k + sz / n) * h,
        );
      }
    }
  }

  // A quad around every grid edge that crosses the surface
  const indices: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) indices.push(a, c, b, a, d, c);
    else indices.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < nz - 1; k++) {
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const inside = field[idx(i, j, k)]! < 0;
        if (inside !== field[idx(i + 1, j, k)]! < 0 && i < nx - 1) {
          quad(
            cellVert[cidx(i, j - 1, k - 1)]!,
            cellVert[cidx(i, j, k - 1)]!,
            cellVert[cidx(i, j, k)]!,
            cellVert[cidx(i, j - 1, k)]!,
            inside,
          );
        }
        if (inside !== field[idx(i, j + 1, k)]! < 0) {
          quad(
            cellVert[cidx(i - 1, j, k - 1)]!,
            cellVert[cidx(i - 1, j, k)]!,
            cellVert[cidx(i, j, k)]!,
            cellVert[cidx(i, j, k - 1)]!,
            inside,
          );
        }
        if (inside !== field[idx(i, j, k + 1)]! < 0) {
          quad(
            cellVert[cidx(i - 1, j - 1, k)]!,
            cellVert[cidx(i, j - 1, k)]!,
            cellVert[cidx(i, j, k)]!,
            cellVert[cidx(i - 1, j, k)]!,
            inside,
          );
        }
      }
    }
  }

  // Normals from the field's gradient: smooth shading regardless of the grid
  const normals = new Float32Array(positions.length);
  const e = h * 0.5;
  for (let p = 0; p < positions.length; p += 3) {
    const x = positions[p]!;
    const y = positions[p + 1]!;
    const z = positions[p + 2]!;
    const gx = sdf(x + e, y, z) - sdf(x - e, y, z);
    const gy = sdf(x, y + e, z) - sdf(x, y - e, z);
    const gz = sdf(x, y, z + e) - sdf(x, y, z - e);
    const l = Math.hypot(gx, gy, gz) || 1;
    normals[p] = gx / l;
    normals[p + 1] = gy / l;
    normals[p + 2] = gz / l;
  }

  // Make every triangle face outward (agree with the gradient)
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const ux = positions[b]! - positions[a]!;
    const uy = positions[b + 1]! - positions[a + 1]!;
    const uz = positions[b + 2]! - positions[a + 2]!;
    const wx = positions[c]! - positions[a]!;
    const wy = positions[c + 1]! - positions[a + 1]!;
    const wz = positions[c + 2]! - positions[a + 2]!;
    const fx = uy * wz - uz * wy;
    const fy = uz * wx - ux * wz;
    const fz = ux * wy - uy * wx;
    const dot =
      fx * (normals[a]! + normals[b]! + normals[c]!) +
      fy * (normals[a + 1]! + normals[b + 1]! + normals[c + 1]!) +
      fz * (normals[a + 2]! + normals[b + 2]! + normals[c + 2]!);
    if (dot < 0) {
      indices[t + 1] = c / 3;
      indices[t + 2] = b / 3;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

// ── Skinning ──

export interface BoneSegment {
  /** Index into the skeleton's bones */
  bone: number;
  a: V;
  b: V;
  /** How far the bone's influence reaches (m) */
  reach: number;
}

function segDist(p: V, a: V, b: V) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz;
  const t =
    l2 > 0
      ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / l2))
      : 0;
  return Math.hypot(p.x - a.x - abx * t, p.y - a.y - aby * t, p.z - a.z - abz * t);
}

/** Up to four bone weights per vertex, from the distance to each bone segment. */
export function skinWeights(geo: THREE.BufferGeometry, segments: BoneSegment[]) {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const skinIndex = new Uint16Array(pos.count * 4);
  const skinWeight = new Float32Array(pos.count * 4);
  const p = new THREE.Vector3();
  const scored: { bone: number; w: number }[] = [];
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    scored.length = 0;
    let best = Infinity;
    const dists = segments.map((s) => {
      const d = segDist(p, s.a, s.b) / s.reach;
      best = Math.min(best, d);
      return d;
    });
    segments.forEach((s, k) => {
      // Blend only between bones nearly as close as the closest one
      const rel = dists[k]! - best;
      const w = Math.exp(-((rel / 0.35) ** 2)) * (1 / (0.05 + dists[k]!));
      if (w > 1e-3) {
        const prev = scored.find((x) => x.bone === s.bone);
        if (prev) prev.w = Math.max(prev.w, w);
        else scored.push({ bone: s.bone, w });
      }
    });
    scored.sort((a, b) => b.w - a.w);
    const top = scored.slice(0, 4);
    const sum = top.reduce((acc, x) => acc + x.w, 0) || 1;
    top.forEach((x, k) => {
      skinIndex[i * 4 + k] = x.bone;
      skinWeight[i * 4 + k] = x.w / sum;
    });
  }
  geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndex, 4));
  geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeight, 4));
}

/**
 * Give clothing the weights of the nearest body vertex, so a shell moves
 * exactly with the skin underneath (no skin poking through in a stride).
 */
export function transferWeights(target: THREE.BufferGeometry, source: THREE.BufferGeometry) {
  const sp = source.attributes.position as THREE.BufferAttribute;
  const si = source.attributes.skinIndex as THREE.BufferAttribute;
  const sw = source.attributes.skinWeight as THREE.BufferAttribute;
  const cell = 0.03;
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) =>
    `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < sp.count; i++) {
    const k = key(sp.getX(i), sp.getY(i), sp.getZ(i));
    let list = grid.get(k);
    if (!list) grid.set(k, (list = []));
    list.push(i);
  }
  const tp = target.attributes.position as THREE.BufferAttribute;
  const skinIndex = new Uint16Array(tp.count * 4);
  const skinWeight = new Float32Array(tp.count * 4);
  for (let i = 0; i < tp.count; i++) {
    const x = tp.getX(i);
    const y = tp.getY(i);
    const z = tp.getZ(i);
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    const cz = Math.floor(z / cell);
    let best = -1;
    let bestD = Infinity;
    for (let r = 1; r <= 3 && best < 0; r++) {
      for (let a = -r; a <= r; a++)
        for (let b = -r; b <= r; b++)
          for (let c = -r; c <= r; c++) {
            const list = grid.get(`${cx + a},${cy + b},${cz + c}`);
            if (!list) continue;
            for (const j of list) {
              const d = (sp.getX(j) - x) ** 2 + (sp.getY(j) - y) ** 2 + (sp.getZ(j) - z) ** 2;
              if (d < bestD) {
                bestD = d;
                best = j;
              }
            }
          }
    }
    if (best < 0) continue;
    for (let k = 0; k < 4; k++) {
      skinIndex[i * 4 + k] = si.getComponent(best, k);
      skinWeight[i * 4 + k] = sw.getComponent(best, k);
    }
  }
  target.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndex, 4));
  target.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeight, 4));
}
