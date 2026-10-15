/**
 * Street furniture where OpenStreetMap maps it: lamps (mapped lamp posts,
 * and along ways tagged lit=yes, one every ~28 m), traffic signals, benches,
 * bins, fire hydrants, drinking fountains and bollards. Scanned models from
 * the asset pack where it has one (lamp, bench, bin, hydrant), simple built
 * shapes otherwise and until the pack arrives. Instanced, one draw per part.
 *
 * At night the lamps light the ground: each lamp splats a pool of light into
 * a small texture around the camera (`lampAt` in the ground, road and trail
 * shaders), and their heads glow.
 */
import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { color, float, texture, uniform } from "three/tsl";
import type { Node } from "three/webgpu";
import { FURNITURE, type FurnitureKind, type Road } from "../geo/types.ts";
import type { AssetLibrary } from "./assets.ts";

/** Lamps per lit way: spacing along it (m), and how far off its center line */
const LAMP_EVERY = 28;
const MAX_LAMPS = 4000;

export interface Item {
  kind: FurnitureKind;
  x: number;
  z: number;
  /** Facing (radians, about +y), toward the nearest road unless mapped */
  yaw: number;
}

// ── Lamp light on the ground ──

const LIGHT_N = 256;
/** Meters covered by the light map (1 m per texel) */
const LIGHT_SPAN = 256;
const lightData = new Uint8Array(LIGHT_N * LIGHT_N);
const lightTex = new THREE.DataTexture(lightData, LIGHT_N, LIGHT_N, THREE.RedFormat);
lightTex.magFilter = lightTex.minFilter = THREE.LinearFilter;
lightTex.needsUpdate = true;

export const lampLight = {
  origin: uniform(new THREE.Vector2(-1e6, -1e6)),
  /** 0 by day, 1 at night (set by the scene) */
  night: uniform(0),
  // Warm-white LED (most city lamps now), a little warmer than daylight
  color: uniform(new THREE.Color(1, 0.86, 0.68)),
};

/** Light from street lamps reaching the ground at `p` (x, z), as irradiance to multiply the albedo by */
export function lampAt(p: Node<"vec2">): Node<"vec3"> {
  const uv = p.sub(lampLight.origin).div(LIGHT_SPAN);
  const v = texture(lightTex, uv).r;
  return color(lampLight.color).mul(v.mul(v).mul(lampLight.night).mul(float(1.6)));
}

// ── Built shapes (no assets) ──

function lathe(points: [number, number][], seg = 10) {
  return new THREE.LatheGeometry(
    points.map(([r, y]) => new THREE.Vector2(r, y)),
    seg,
  );
}
function painted(geo: THREE.BufferGeometry, c: string) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute("uv");
  const col = new THREE.Color(c);
  const n = g.attributes.position!.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([col.r, col.g, col.b], i * 3);
  g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return g;
}

const BUILT: Record<FurnitureKind, () => THREE.BufferGeometry> = {
  street_lamp: () =>
    mergeGeometries([
      painted(new THREE.CylinderGeometry(0.06, 0.09, 6, 8).translate(0, 3, 0), "#4a4d50"),
      painted(new THREE.BoxGeometry(0.05, 0.05, 1.3).translate(0, 5.95, 0.6), "#4a4d50"),
      painted(new THREE.BoxGeometry(0.28, 0.1, 0.5).translate(0, 5.9, 1.2), "#5a5d60"),
    ])!,
  traffic_signals: () =>
    mergeGeometries([
      painted(new THREE.CylinderGeometry(0.06, 0.07, 3.3, 8).translate(0, 1.65, 0), "#3d4042"),
      painted(new THREE.BoxGeometry(0.32, 0.95, 0.26).translate(0, 3.1, 0.12), "#26292b"),
      painted(
        new THREE.CylinderGeometry(0.1, 0.1, 0.03, 10)
          .rotateX(Math.PI / 2)
          .translate(0, 3.38, 0.26),
        "#c83228",
      ),
      painted(
        new THREE.CylinderGeometry(0.1, 0.1, 0.03, 10).rotateX(Math.PI / 2).translate(0, 3.1, 0.26),
        "#6b5a1c",
      ),
      painted(
        new THREE.CylinderGeometry(0.1, 0.1, 0.03, 10)
          .rotateX(Math.PI / 2)
          .translate(0, 2.82, 0.26),
        "#1d4a2c",
      ),
    ])!,
  bench: () =>
    mergeGeometries([
      painted(new THREE.BoxGeometry(1.6, 0.06, 0.42).translate(0, 0.45, 0), "#7a5a3c"),
      painted(new THREE.BoxGeometry(1.6, 0.36, 0.05).translate(0, 0.72, -0.2), "#7a5a3c"),
      painted(new THREE.BoxGeometry(0.06, 0.45, 0.4).translate(-0.7, 0.22, 0), "#3a3c3e"),
      painted(new THREE.BoxGeometry(0.06, 0.45, 0.4).translate(0.7, 0.22, 0), "#3a3c3e"),
    ])!,
  waste_basket: () =>
    painted(
      lathe([
        [0, 0],
        [0.2, 0],
        [0.22, 0.85],
        [0, 0.85],
      ]),
      "#3f5a46",
    ),
  fire_hydrant: () =>
    painted(
      lathe([
        [0, 0],
        [0.13, 0],
        [0.11, 0.06],
        [0.1, 0.55],
        [0.13, 0.6],
        [0.08, 0.72],
        [0, 0.78],
      ]),
      "#b8352b",
    ),
  drinking_water: () =>
    mergeGeometries([
      painted(
        lathe([
          [0, 0],
          [0.14, 0],
          [0.12, 0.85],
          [0, 0.85],
        ]),
        "#8f969b",
      ),
      painted(
        lathe([
          [0, 0.82],
          [0.26, 0.86],
          [0.24, 0.95],
          [0, 0.9],
        ]),
        "#a8aeb2",
      ),
    ])!,
  bollard: () =>
    mergeGeometries([
      painted(
        lathe([
          [0, 0],
          [0.08, 0],
          [0.08, 0.8],
          [0.05, 0.9],
          [0, 0.92],
        ]),
        "#3b3e40",
      ),
      painted(
        new THREE.CylinderGeometry(0.083, 0.083, 0.06, 10, 1, true).translate(0, 0.72, 0),
        "#d8d4c4",
      ),
    ])!,
};

/** Scanned models (asset pack) for these kinds */
const MODEL: Partial<Record<FurnitureKind, string>> = {
  street_lamp: "street.lamp",
  bench: "street.bench",
  waste_basket: "street.bin",
  fire_hydrant: "street.hydrant",
};

/** Height of the light under a lamp's head (m), built and scanned */
const LAMP_HEAD = { built: 5.85, model: 3.65 };

/**
 * Mapped furniture plus lamps along lit ways, each turned to face the
 * nearest road (or as mapped). Exported for tests.
 */
export function placeFurniture(furniture: number[], roads: Road[]): Item[] {
  const segs = segmentIndex(roads);
  const items: Item[] = [];
  for (let i = 0; i + 3 < furniture.length; i += 4) {
    const kind = FURNITURE[furniture[i + 2]!];
    if (!kind) continue;
    const x = furniture[i]!;
    const z = furniture[i + 1]!;
    const dir = furniture[i + 3]!;
    // OSM direction: degrees clockwise from north (the way it faces); north is −z
    const yaw = dir >= 0 ? Math.PI - (dir * Math.PI) / 180 : facingRoad(segs, x, z);
    items.push({ kind, x, z, yaw });
  }
  // Lamps along lit ways, at the edge, alternating sides on wide roads. A
  // street and its sidewalks are often each tagged lit: a lamp keeps 15 m
  // from every other (mapped ones included), or the pools merge into bands
  const MIN_GAP = 15;
  const near = new Map<string, number[]>();
  const key = (x: number, z: number) => `${Math.floor(x / MIN_GAP)},${Math.floor(z / MIN_GAP)}`;
  const taken = (x: number, z: number) => {
    const cx = Math.floor(x / MIN_GAP);
    const cz = Math.floor(z / MIN_GAP);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) {
        const l = near.get(`${cx + i},${cz + j}`);
        if (!l) continue;
        for (let k = 0; k < l.length; k += 2)
          if ((l[k]! - x) ** 2 + (l[k + 1]! - z) ** 2 < MIN_GAP * MIN_GAP) return true;
      }
    return false;
  };
  const mark = (x: number, z: number) => {
    const k = key(x, z);
    let l = near.get(k);
    if (!l) near.set(k, (l = []));
    l.push(x, z);
  };
  for (const it of items) if (it.kind === "street_lamp") mark(it.x, it.z);
  let lamps = 0;
  // Wider (busier) ways first: their lamps win over a footway's beside them
  for (const r of [...roads].sort((a, b) => b.width - a.width)) {
    if (!r.lit || r.pts.length < 4) continue;
    let carry = LAMP_EVERY / 2;
    let side = 1;
    for (let i = 2; i < r.pts.length && lamps < MAX_LAMPS; i += 2) {
      const ax = r.pts[i - 2]!;
      const az = r.pts[i - 1]!;
      const dx = r.pts[i]! - ax;
      const dz = r.pts[i + 1]! - az;
      const len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      const ux = dx / len;
      const uz = dz / len;
      for (let s = carry; s < len; s += LAMP_EVERY) {
        const off = r.width / 2 + 0.6;
        // Perpendicular (−uz, ux); the lamp leans out over the way
        const px = ax + ux * s - uz * off * side;
        const pz = az + uz * s + ux * off * side;
        if (taken(px, pz)) continue;
        mark(px, pz);
        items.push({ kind: "street_lamp", x: px, z: pz, yaw: Math.atan2(uz * side, -ux * side) });
        lamps++;
        if (r.width > 7) side = -side;
      }
      carry = (((carry - len) % LAMP_EVERY) + LAMP_EVERY) % LAMP_EVERY;
    }
  }
  return items;
}

interface Seg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}
function segmentIndex(roads: Road[]) {
  const cell = 30;
  const grid = new Map<string, Seg[]>();
  for (const r of roads) {
    for (let i = 2; i < r.pts.length; i += 2) {
      const s = { ax: r.pts[i - 2]!, az: r.pts[i - 1]!, bx: r.pts[i]!, bz: r.pts[i + 1]! };
      const x0 = Math.floor(Math.min(s.ax, s.bx) / cell);
      const x1 = Math.floor(Math.max(s.ax, s.bx) / cell);
      const z0 = Math.floor(Math.min(s.az, s.bz) / cell);
      const z1 = Math.floor(Math.max(s.az, s.bz) / cell);
      for (let cx = x0; cx <= x1; cx++)
        for (let cz = z0; cz <= z1; cz++) {
          const key = `${cx},${cz}`;
          let l = grid.get(key);
          if (!l) grid.set(key, (l = []));
          l.push(s);
        }
    }
  }
  return { grid, cell };
}

/** Yaw that turns an object's +z toward the nearest road (0 when none is near) */
function facingRoad(idx: ReturnType<typeof segmentIndex>, x: number, z: number) {
  let best = Infinity;
  let bx = x;
  let bz = z + 1;
  const cx = Math.floor(x / idx.cell);
  const cz = Math.floor(z / idx.cell);
  for (let i = -1; i <= 1; i++)
    for (let j = -1; j <= 1; j++)
      for (const s of idx.grid.get(`${cx + i},${cz + j}`) ?? []) {
        const vx = s.bx - s.ax;
        const vz = s.bz - s.az;
        const t = Math.max(
          0,
          Math.min(1, ((x - s.ax) * vx + (z - s.az) * vz) / (vx * vx + vz * vz || 1)),
        );
        const qx = s.ax + vx * t;
        const qz = s.az + vz * t;
        const d = Math.hypot(x - qx, z - qz);
        if (d < best) {
          best = d;
          bx = qx;
          bz = qz;
        }
      }
  if (!Number.isFinite(best) || best < 0.05) return 0;
  return Math.atan2(bx - x, bz - z);
}

export class StreetFurniture {
  group = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];
  private byKind = new Map<FurnitureKind, Item[]>();
  private heads: THREE.InstancedMesh | null = null;
  private headMat = new THREE.MeshBasicNodeMaterial({ color: "#ffd9a0" });
  private builtMat = new THREE.MeshStandardNodeMaterial({
    vertexColors: true,
    roughness: 0.6,
    metalness: 0.2,
  });
  private lamps: Float32Array;
  private lightCenter = new THREE.Vector2(Infinity, Infinity);
  private modelKinds = new Set<FurnitureKind>();

  constructor(
    readonly items: Item[],
    private heightAt: (x: number, z: number) => number,
  ) {
    this.group.name = "furniture";
    for (const it of items) {
      let l = this.byKind.get(it.kind);
      if (!l) this.byKind.set(it.kind, (l = []));
      l.push(it);
    }
    for (const [kind, list] of this.byKind)
      this.instance(kind, [{ geometry: BUILT[kind](), material: this.builtMat }], list, 1);
    const lamps = this.byKind.get("street_lamp") ?? [];
    this.lamps = new Float32Array(lamps.flatMap((l) => [l.x, l.z]));
    this.placeHeads(LAMP_HEAD.built);
    this.headMat.colorNode = color("#ffe2b8").mul(lampLight.night.mul(14).add(0.6));
  }

  /** Lamp positions (flat x, z) */
  get lampCount() {
    return this.lamps.length / 2;
  }

  private instance(
    kind: FurnitureKind,
    parts: { geometry: THREE.BufferGeometry; material: THREE.Material; matrix?: THREE.Matrix4 }[],
    list: Item[],
    scale: number,
  ) {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3(scale, scale, scale);
    const p = new THREE.Vector3();
    for (const part of parts) {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, list.length);
      list.forEach((it, i) => {
        p.set(it.x, this.heightAt(it.x, it.z), it.z);
        q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, it.yaw);
        m.compose(p, q, s);
        if (part.matrix) m.multiply(part.matrix);
        mesh.setMatrixAt(i, m);
      });
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.kind = kind;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
      this.meshes.push(mesh);
    }
  }

  private placeHeads(headY: number) {
    const lamps = this.byKind.get("street_lamp") ?? [];
    if (this.heads) {
      this.group.remove(this.heads);
      this.heads.geometry.dispose();
      this.heads.dispose();
    }
    if (!lamps.length) return;
    const geo = new THREE.SphereGeometry(0.16, 10, 6).scale(1.4, 0.6, 1.4);
    const heads = new THREE.InstancedMesh(geo, this.headMat, lamps.length);
    const m = new THREE.Matrix4();
    lamps.forEach((l, i) => {
      // Built lamps hang their light at the end of the arm
      const reach = headY === LAMP_HEAD.built ? 1.2 : 0;
      const x = l.x + Math.sin(l.yaw) * reach;
      const z = l.z + Math.cos(l.yaw) * reach;
      m.makeTranslation(x, this.heightAt(l.x, l.z) + headY, z);
      heads.setMatrixAt(i, m);
    });
    heads.computeBoundingSphere();
    heads.castShadow = false;
    this.heads = heads;
    this.group.add(heads);
  }

  /** Swap built shapes for the asset pack's scanned models, where it has them */
  async useModels(lib: AssetLibrary): Promise<string[]> {
    const used: string[] = [];
    for (const [kind, list] of this.byKind) {
      const id = MODEL[kind];
      if (!id || this.modelKinds.has(kind)) continue;
      const variants = await lib.model(id);
      const v = variants?.[0];
      if (!v) continue;
      // Remove the built version
      for (const mesh of this.meshes.filter((x) => x.userData.kind === kind)) {
        this.group.remove(mesh);
        mesh.geometry.dispose();
        mesh.dispose();
      }
      this.meshes = this.meshes.filter((x) => x.userData.kind !== kind);
      const parts: {
        geometry: THREE.BufferGeometry;
        material: THREE.Material;
        matrix: THREE.Matrix4;
      }[] = [];
      v.updateMatrixWorld(true);
      v.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh)
          parts.push({
            geometry: mesh.geometry,
            material: mesh.material as THREE.Material,
            matrix: mesh.matrixWorld.clone(),
          });
      });
      this.instance(kind, parts, list, 1);
      this.modelKinds.add(kind);
      if (kind === "street_lamp") this.placeHeads(LAMP_HEAD.model);
      used.push(id);
    }
    return used;
  }

  /** Re-splat the lamp pools around the camera when it moved far enough */
  update(cam: THREE.Vector3) {
    if (!this.lamps.length) return;
    if (Math.hypot(cam.x - this.lightCenter.x, cam.z - this.lightCenter.y) < 40) return;
    this.lightCenter.set(cam.x, cam.z);
    const x0 = Math.round(cam.x - LIGHT_SPAN / 2);
    const z0 = Math.round(cam.z - LIGHT_SPAN / 2);
    lightData.fill(0);
    // Each lamp lights ~9 m around it, brightest under it; overlapping pools
    // add up but stay well short of saturating (a park's many lit paths)
    const R = 6.5;
    for (let i = 0; i < this.lamps.length; i += 2) {
      const lx = this.lamps[i]! - x0;
      const lz = this.lamps[i + 1]! - z0;
      if (lx < -R || lz < -R || lx > LIGHT_N + R || lz > LIGHT_N + R) continue;
      for (
        let j = Math.max(0, Math.floor(lz - R));
        j <= Math.min(LIGHT_N - 1, Math.ceil(lz + R));
        j++
      ) {
        for (
          let k = Math.max(0, Math.floor(lx - R));
          k <= Math.min(LIGHT_N - 1, Math.ceil(lx + R));
          k++
        ) {
          const d2 = ((k + 0.5 - lx) ** 2 + (j + 0.5 - lz) ** 2) / (R * R);
          if (d2 >= 1) continue;
          const v = (1 - d2) * (1 - d2) * 150;
          const o = j * LIGHT_N + k;
          lightData[o] = Math.min(255, lightData[o]! + v);
        }
      }
    }
    lampLight.origin.value.set(x0, z0);
    lightTex.needsUpdate = true;
  }

  dispose() {
    for (const m of this.meshes) {
      if (!this.modelKinds.has(m.userData.kind)) m.geometry.dispose();
      m.dispose();
    }
    this.heads?.geometry.dispose();
    this.heads?.dispose();
    this.headMat.dispose();
    this.builtMat.dispose();
    lightData.fill(0);
    lampLight.origin.value.set(-1e6, -1e6);
    lightTex.needsUpdate = true;
  }
}
