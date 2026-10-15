/**
 * Mapped trees (OpenStreetMap natural=tree and tree rows), procedural and
 * instanced: broadleaf crowns of jittered lumps with crown-shaped normals,
 * conifers of stacked cones, palms with drooping fronds. Each kind has a
 * near and a far shape; the instance buffers are refilled from precomputed
 * matrices as the camera moves (at most 4× a second), near trees within the
 * detail radius (casting shadows), far ones beyond it. Six draws in all.
 */
import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { float, instanceIndex, positionLocal, sin, time, uniform, vec3 } from "three/tsl";
import { TREE_CONIFER, TREE_PALM } from "../geo/types.ts";

const LEAF = new THREE.Color("#4d7a30");
const LEAF_DARK = new THREE.Color("#2f4f22");
const NEEDLE = new THREE.Color("#2e4a2a");
const FROND = new THREE.Color("#5f8a35");
const BARK = new THREE.Color("#5b4636");
const PALM_BARK = new THREE.Color("#8a7a62");

function paint(geo: THREE.BufferGeometry, c: (p: THREE.Vector3, k: number) => THREE.Color) {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3();
  for (let k = 0; k < pos.count; k++) {
    p.fromBufferAttribute(pos, k);
    const cc = c(p, k);
    col.set([cc.r, cc.g, cc.b], k * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.deleteAttribute("uv"); // (every part must carry the same attributes to merge)
  return geo;
}

function trunk(r0: number, r1: number, h: number, seg: number, color: THREE.Color) {
  const g = new THREE.CylinderGeometry(r1, r0, h, seg, 1, true).translate(0, h / 2, 0);
  return paint(g.toNonIndexed(), () => color);
}

/** Jittered value in [−1, 1] from a position (stable per vertex position). */
function jitter(x: number, y: number, z: number) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

/** A crown of lumps; normals point away from the crown's middle (reads as one soft mass). */
function crown(lumps: number, detail: number, center: THREE.Vector3, radius: number) {
  const parts: THREE.BufferGeometry[] = [];
  const rnd = (k: number) => jitter(k * 1.7, k * 3.1, 0.5) * 0.5 + 0.5;
  for (let k = 0; k < lumps; k++) {
    const r = radius * (k === 0 ? 0.62 : 0.42 + rnd(k) * 0.16);
    const g = new THREE.IcosahedronGeometry(r, detail);
    if (k > 0) {
      const a = (k / (lumps - 1)) * Math.PI * 2 + rnd(k + 9);
      const up = (rnd(k + 20) - 0.35) * radius * 0.7;
      g.translate(Math.cos(a) * radius * 0.48, up, Math.sin(a) * radius * 0.48);
    }
    g.translate(center.x, center.y, center.z);
    parts.push(g);
  }
  const g = mergeGeometries(parts)!;
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nor = g.attributes.normal as THREE.BufferAttribute;
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let k = 0; k < pos.count; k++) {
    p.fromBufferAttribute(pos, k);
    const d = p.clone().sub(center);
    p.addScaledVector(d.normalize(), jitter(p.x, p.y, p.z) * radius * 0.1);
    pos.setXYZ(k, p.x, p.y, p.z);
    n.fromBufferAttribute(nor, k).lerp(d, 0.7).normalize();
    nor.setXYZ(k, n.x, n.y, n.z);
  }
  return paint(g, (q) => {
    // darker underneath and inside
    const t = THREE.MathUtils.clamp((q.y - (center.y - radius)) / (radius * 2), 0, 1);
    return LEAF_DARK.clone()
      .lerp(LEAF, 0.35 + 0.65 * t)
      .multiplyScalar(0.92 + jitter(q.z, q.x, q.y) * 0.08);
  });
}

function broadleaf(near: boolean) {
  const c = crown(near ? 7 : 1, near ? 1 : 0, new THREE.Vector3(0, 0.64, 0), 0.3);
  return near ? mergeGeometries([trunk(0.05, 0.03, 0.5, 6, BARK), c])! : c;
}

function conifer(near: boolean) {
  const parts = [trunk(0.04, 0.02, 0.3, near ? 6 : 4, BARK)];
  const tiers = near
    ? [
        [0.24, 0.42, 0.42],
        [0.18, 0.36, 0.62],
        [0.11, 0.3, 0.82],
      ]
    : [[0.22, 0.8, 0.6]];
  for (const [r, h, y] of tiers) {
    const g = new THREE.ConeGeometry(r, h, near ? 9 : 6, 1, true)
      .translate(0, y!, 0)
      .toNonIndexed();
    parts.push(
      paint(g, (q) =>
        NEEDLE.clone().multiplyScalar(0.75 + 0.35 * THREE.MathUtils.clamp(q.y, 0, 1)),
      ),
    );
  }
  return mergeGeometries(parts)!;
}

function palm(near: boolean) {
  const top = 0.86;
  const parts = [trunk(0.035, 0.025, top, near ? 6 : 4, PALM_BARK)];
  const fronds = near ? 9 : 5;
  const segs = near ? 5 : 2;
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + jitter(f, 1, 2) * 0.3;
    const pos: number[] = [];
    const len = 0.3 + jitter(f, 3, 4) * 0.04;
    const ring = (s: number) => {
      const t = s / segs;
      const out = len * t;
      const y = top + 0.06 * Math.sin(t * Math.PI * 0.8) - 0.16 * t * t;
      const w = 0.06 * Math.sin(Math.PI * Math.min(1, t * 1.15 + 0.05));
      const cx = Math.cos(a);
      const cz = Math.sin(a);
      return [
        [cx * out - cz * w, y, cz * out + cx * w],
        [cx * out + cz * w, y, cz * out - cx * w],
      ] as const;
    };
    for (let s = 0; s < segs; s++) {
      const [a0, a1] = ring(s);
      const [b0, b1] = ring(s + 1);
      pos.push(...a0, ...b0, ...b1, ...a0, ...b1, ...a1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    parts.push(paint(g, (q) => FROND.clone().multiplyScalar(0.8 + 0.3 * (q.y - top + 0.2))));
  }
  return mergeGeometries(parts)!;
}

/** Leaves sway a little in the wind (more towards the top) */
export const treeWind = uniform(0.5);

function treeMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const phase = float(instanceIndex).mul(1.73);
  const h2 = positionLocal.y.mul(positionLocal.y);
  const sway = sin(time.mul(1.4).add(phase)).mul(treeWind).mul(0.018).mul(h2);
  mat.positionNode = positionLocal.add(vec3(sway, 0, sway.mul(0.6)));
  return mat;
}

/** Near-detail radius and far radius (m), scaled by quality */
const NEAR = 170;
const FAR = 1900;

export class Forest {
  group = new THREE.Group();
  private matrices: Float32Array;
  private colors: Float32Array;
  private kinds: Uint8Array;
  private px: Float32Array;
  private pz: Float32Array;
  private meshes: { near: THREE.InstancedMesh; far: THREE.InstancedMesh }[] = [];
  private mats: THREE.Material[] = [];
  private lastAt = -Infinity;
  private lastCam = new THREE.Vector3(Infinity, 0, 0);
  private lastQ = -1;
  readonly count: number;

  constructor(
    trees: number[],
    heightAt: (x: number, z: number) => number,
    season: "spring" | "summer" | "autumn" | "winter",
  ) {
    const n = Math.floor(trees.length / 4);
    this.count = n;
    this.group.name = "trees";
    this.matrices = new Float32Array(n * 16);
    this.colors = new Float32Array(n * 3);
    this.kinds = new Uint8Array(n);
    this.px = new Float32Array(n);
    this.pz = new Float32Array(n);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const c = new THREE.Color();
    const perKind = [0, 0, 0];
    for (let k = 0; k < n; k++) {
      const x = trees[k * 4]!;
      const z = trees[k * 4 + 1]!;
      const mapped = trees[k * 4 + 2]!;
      const kind = trees[k * 4 + 3]! === TREE_CONIFER ? 1 : trees[k * 4 + 3]! === TREE_PALM ? 2 : 0;
      const r = (j: number) => jitter(x * 0.37 + j, z * 0.41, j * 1.3) * 0.5 + 0.5;
      const h = mapped || [7 + r(1) * 6, 9 + r(1) * 8, 8 + r(1) * 7][kind]!;
      const wide = kind === 2 ? 1 : 0.85 + r(2) * 0.35;
      p.set(x, heightAt(x, z) - 0.05, z);
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, r(3) * Math.PI * 2);
      s.set(h * wide, h, h * wide);
      m.compose(p, q, s).toArray(this.matrices, k * 16);
      // A little variety; broadleaf crowns turn in autumn
      c.setRGB(1, 1, 1).offsetHSL((r(4) - 0.5) * 0.05, (r(5) - 0.5) * 0.15, (r(6) - 0.5) * 0.14);
      if (kind === 0 && season === "autumn" && r(7) < 0.55)
        c.multiply(new THREE.Color(1.35, 0.95, 0.55));
      if (kind === 0 && season === "winter" && r(7) < 0.4)
        c.multiply(new THREE.Color(1.1, 0.9, 0.7));
      c.toArray(this.colors, k * 3);
      this.kinds[k] = kind;
      this.px[k] = x;
      this.pz[k] = z;
      perKind[kind]!++;
    }
    const shapes = [broadleaf, conifer, palm];
    for (let kind = 0; kind < 3; kind++) {
      const cap = Math.max(1, perKind[kind]!);
      const make = (near: boolean) => {
        const mat = treeMaterial();
        this.mats.push(mat);
        const mesh = new THREE.InstancedMesh(shapes[kind]!(near), mat, cap);
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.castShadow = near;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.setColorAt(0, new THREE.Color(1, 1, 1));
        this.group.add(mesh);
        return mesh;
      };
      this.meshes.push({ near: make(true), far: make(false) });
    }
  }

  /** Refill the instance buffers around the camera (throttled). */
  update(cam: THREE.Vector3, quality: number, now: number) {
    if (!this.count) return;
    const moved = cam.distanceToSquared(this.lastCam) > 15 * 15;
    if (!(moved || quality !== this.lastQ) || now - this.lastAt < 250) return;
    this.lastAt = now;
    this.lastCam.copy(cam);
    this.lastQ = quality;
    const near2 = (NEAR * quality) ** 2;
    const far2 = (FAR * Math.max(0.6, quality)) ** 2;
    const fill = this.meshes.map(() => [0, 0]);
    for (let k = 0; k < this.count; k++) {
      const dx = this.px[k]! - cam.x;
      const dz = this.pz[k]! - cam.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > far2) continue;
      const kind = this.kinds[k]!;
      const lod = d2 < near2 ? 0 : 1;
      const mesh = lod ? this.meshes[kind]!.far : this.meshes[kind]!.near;
      const at = fill[kind]![lod]!++;
      mesh.instanceMatrix.array.set(this.matrices.subarray(k * 16, k * 16 + 16), at * 16);
      mesh.instanceColor!.array.set(this.colors.subarray(k * 3, k * 3 + 3), at * 3);
    }
    this.meshes.forEach((m, kind) => {
      for (const [lod, mesh] of [m.near, m.far].entries()) {
        mesh.count = fill[kind]![lod]!;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor!.needsUpdate = true;
      }
    });
  }

  dispose() {
    for (const { near, far } of this.meshes) {
      near.geometry.dispose();
      far.geometry.dispose();
      near.dispose();
      far.dispose();
    }
    for (const m of this.mats) m.dispose();
  }
}
