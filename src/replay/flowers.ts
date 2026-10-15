/**
 * Small flowering plants in the grass (scanned models from the asset pack):
 * clover-like sorrel and dandelions on lawns, yellow flowers and dandelions
 * in meadows. Only where the map says there's grass (or, without a map, in
 * the generated meadow), never on paths or roads, none in winter. Placed in
 * world-fixed chunks around the camera like the grass, one instanced draw
 * per model part.
 */
import * as THREE from "three/webgpu";
import type { AreaKind } from "../geo/types.ts";
import type { GrassSite } from "./grass.ts";

const CHUNK = 10;
const RADIUS = 38;
const CAP = 4000;

/**
 * Plants per m² by land kind: [gazania, dandelion, sorrel, periwinkle]. Low
 * rosettes and clover on lawns; taller periwinkle shows above meadow grass.
 */
export const FLOWER_IDS = ["plant.flowers", "plant.dandelion", "plant.sorrel", "plant.periwinkle"];
const DENSITY: Partial<Record<AreaKind | "unmapped", number[]>> = {
  park: [0.04, 0.06, 0.3, 0.01],
  grass: [0.1, 0.1, 0.05, 0.06],
  unmapped: [0.1, 0.1, 0.04, 0.05],
  wetland: [0, 0, 0, 0.05],
  farmland: [0.02, 0.02, 0, 0.03],
};

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

interface Patch {
  x: number;
  z: number;
  spread: number;
  land: AreaKind | "unmapped";
  kind: number;
  n: number;
}

interface Kind {
  /** Model variants: each a list of parts */
  variants: { geometry: THREE.BufferGeometry; material: THREE.Material; matrix: THREE.Matrix4 }[][];
  meshes: THREE.InstancedMesh[][];
  /** Scale range: meadow plants stand a little taller, to show above the grass */
  scale: [number, number];
}

export class Flowers {
  group = new THREE.Group();
  private kinds: Kind[] = [];
  /** Per chunk: [x, y, z, yaw, scale, kind, variant] */
  private chunks = new Map<string, Float32Array>();
  private lastCam = new THREE.Vector3(Infinity, 0, 0);
  private lastAt = -Infinity;
  private amount: number;

  constructor(
    private site: GrassSite,
    models: (THREE.Object3D[] | null)[],
    /** Latitude of the run: in the subtropics things flower all year */
    lat: number | null = null,
  ) {
    this.group.name = "flowers";
    const warm = lat !== null && Math.abs(lat) < 30;
    this.amount =
      site.season === "winter"
        ? warm
          ? 0.6
          : 0.1
        : site.season === "autumn"
          ? warm
            ? 0.9
            : 0.5
          : 1;
    const scales: [number, number][] = [
      [2.5, 3.5],
      [2, 2.8],
      [2, 3],
      [1.4, 1.9],
    ];
    models.forEach((variants, k) => {
      const kind: Kind = { variants: [], meshes: [], scale: scales[k] ?? [1, 1.5] };
      for (const v of (variants ?? []).slice(0, 4)) {
        const parts: Kind["variants"][number] = [];
        v.updateMatrixWorld(true);
        v.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh)
            parts.push({
              geometry: m.geometry,
              material: m.material as THREE.Material,
              matrix: m.matrixWorld.clone(),
            });
        });
        if (!parts.length) continue;
        kind.variants.push(parts);
        kind.meshes.push(
          parts.map((p) => {
            const mesh = new THREE.InstancedMesh(p.geometry, p.material, CAP);
            mesh.count = 0;
            mesh.frustumCulled = false;
            mesh.castShadow = false;
            mesh.receiveShadow = true;
            mesh.matrixAutoUpdate = false;
            mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            this.group.add(mesh);
            return mesh;
          }),
        );
      }
      this.kinds.push(kind);
    });
  }

  /**
   * The patches of one chunk: plants grow in patches of one kind (a clump of
   * dandelions, a drift of clover), which read from the path as spots of
   * color. Deterministic, so the grass can thin out under them (bloomAt).
   */
  private patchCache = new Map<string, Patch[]>();
  private patches(cx: number, cz: number): Patch[] {
    const key = `${cx},${cz}`;
    const hit = this.patchCache.get(key);
    if (hit) return hit;
    const { kindAt } = this.site;
    const r = rng((cx * 83492791) ^ (cz * 2971215073));
    const list: Patch[] = [];
    for (let c = 0; c < 3; c++) {
      const x = (cx + r()) * CHUNK;
      const z = (cz + r()) * CHUNK;
      const land = kindAt ? (kindAt(x, z) ?? "unmapped") : "unmapped";
      const dens = DENSITY[land];
      const spread = 0.7 + r() * 1.1;
      const pick = r();
      const amount = r();
      if (!dens || !this.amount) continue;
      const avail = dens.map((v, k) => (this.kinds[k]?.variants.length ? v : 0));
      const total = avail.reduce((a, b) => a + b, 0);
      if (!total) continue;
      let rest = pick * total;
      let kind = 0;
      while (kind < avail.length - 1 && rest >= avail[kind]!) rest -= avail[kind++]!;
      const n = Math.round(((total * 4 * CHUNK * CHUNK) / 3) * this.amount * (0.6 + amount * 1.2));
      if (n > 0) list.push({ x, z, spread, land, kind, n });
    }
    if (this.patchCache.size > 4000) this.patchCache.clear();
    this.patchCache.set(key, list);
    return list;
  }

  /** How much a flower patch covers this spot, 0–1 (the grass grows shorter there) */
  bloomAt(x: number, z: number): number {
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    let best = 0;
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (const pt of this.patches(cx + i, cz + j)) {
          const d = Math.hypot(x - pt.x, z - pt.z) / (pt.spread * 1.15);
          if (d < 1) best = Math.max(best, 1 - d * d);
        }
    return best;
  }

  private chunk(cx: number, cz: number): Float32Array {
    const key = `${cx},${cz}`;
    const hit = this.chunks.get(key);
    if (hit) return hit;
    const { heightAt, kindAt, blocked } = this.site;
    const out: number[] = [];
    for (const pt of this.patches(cx, cz)) {
      const r = rng((pt.x * 7919) ^ (pt.z * 104729));
      for (let i = 0; i < pt.n; i++) {
        const a = r() * Math.PI * 2;
        const d = Math.sqrt(r()) * pt.spread;
        const x = pt.x + Math.cos(a) * d;
        const z = pt.z + Math.sin(a) * d;
        if (blocked(x, z)) continue;
        if (kindAt && (kindAt(x, z) ?? "unmapped") !== pt.land) continue;
        const [s0, s1] = this.kinds[pt.kind]!.scale;
        out.push(
          x,
          heightAt(x, z) - 0.01,
          z,
          r() * Math.PI * 2,
          s0 + r() * (s1 - s0),
          pt.kind,
          Math.floor(r() * this.kinds[pt.kind]!.variants.length),
        );
      }
    }
    const arr = new Float32Array(out);
    this.chunks.set(key, arr);
    return arr;
  }

  update(cam: THREE.Vector3, quality: number, now: number) {
    if (!this.amount || !this.kinds.length) return;
    if (cam.distanceToSquared(this.lastCam) < 4 || now - this.lastAt < 250) return;
    this.lastAt = now;
    this.lastCam.copy(cam);
    const R = RADIUS * Math.max(0.6, quality);
    const fill = this.kinds.map((k) => k.meshes.map(() => 0));
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    const p = new THREE.Vector3();
    const part = new THREE.Matrix4();
    let built = 0;
    for (let cx = Math.floor((cam.x - R) / CHUNK); cx <= Math.floor((cam.x + R) / CHUNK); cx++) {
      for (let cz = Math.floor((cam.z - R) / CHUNK); cz <= Math.floor((cam.z + R) / CHUNK); cz++) {
        if (!this.chunks.has(`${cx},${cz}`) && built++ > 12) continue;
        const t = this.chunk(cx, cz);
        for (let i = 0; i < t.length; i += 7) {
          const dx = t[i]! - cam.x;
          const dz = t[i + 2]! - cam.z;
          if (dx * dx + dz * dz > R * R) continue;
          const k = t[i + 5]!;
          const v = t[i + 6]!;
          const kind = this.kinds[k]!;
          const at = fill[k]![v]!;
          if (at >= CAP) continue;
          fill[k]![v] = at + 1;
          p.set(t[i]!, t[i + 1]!, t[i + 2]!);
          q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, t[i + 3]!);
          sc.setScalar(t[i + 4]!);
          m.compose(p, q, sc);
          kind.meshes[v]!.forEach((mesh, j) => {
            part.multiplyMatrices(m, kind.variants[v]![j]!.matrix);
            mesh.setMatrixAt(at, part);
          });
        }
      }
    }
    this.kinds.forEach((kind, k) =>
      kind.meshes.forEach((parts, v) =>
        parts.forEach((mesh) => {
          mesh.count = fill[k]![v]!;
          mesh.instanceMatrix.needsUpdate = true;
        }),
      ),
    );
    if (this.chunks.size > 500) {
      for (const key of this.chunks.keys()) {
        const [cx, cz] = key.split(",").map(Number) as [number, number];
        if (Math.hypot((cx + 0.5) * CHUNK - cam.x, (cz + 0.5) * CHUNK - cam.z) > R * 3)
          this.chunks.delete(key);
      }
    }
  }

  dispose() {
    for (const kind of this.kinds)
      for (const parts of kind.meshes) for (const m of parts) m.dispose();
  }
}
