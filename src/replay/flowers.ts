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
  grass: [0.04, 0.05, 0.05, 0.12],
  unmapped: [0.04, 0.05, 0.04, 0.1],
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
  ) {
    this.group.name = "flowers";
    this.amount = site.season === "winter" ? 0.15 : site.season === "autumn" ? 0.6 : 1;
    const scales: [number, number][] = [
      [1.4, 2],
      [1.1, 1.6],
      [1.6, 2.6],
      [0.9, 1.3],
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

  private chunk(cx: number, cz: number): Float32Array {
    const key = `${cx},${cz}`;
    const hit = this.chunks.get(key);
    if (hit) return hit;
    const { heightAt, kindAt, blocked } = this.site;
    const r = rng((cx * 83492791) ^ (cz * 2971215073));
    const out: number[] = [];
    // Plants come in loose clusters: a few seeds per chunk, plants around them
    for (let c = 0; c < 6; c++) {
      const sx = (cx + r()) * CHUNK;
      const sz = (cz + r()) * CHUNK;
      const land = kindAt ? (kindAt(sx, sz) ?? "unmapped") : "unmapped";
      const dens = DENSITY[land];
      if (!dens) continue;
      for (let k = 0; k < this.kinds.length; k++) {
        if (!this.kinds[k]?.variants.length) continue;
        // Expected plants in this cluster's share of the chunk
        const n = Math.round(
          ((dens[k]! * CHUNK * CHUNK) / 6) * this.amount * (0.4 + r() * 1.2) + r() * 0.6,
        );
        const spread = 1.2 + r() * 2.5;
        for (let i = 0; i < n; i++) {
          const a = r() * Math.PI * 2;
          const d = Math.sqrt(r()) * spread;
          const x = sx + Math.cos(a) * d;
          const z = sz + Math.sin(a) * d;
          if (blocked(x, z)) continue;
          if (kindAt && (kindAt(x, z) ?? "unmapped") !== land) continue;
          const [s0, s1] = this.kinds[k]!.scale;
          out.push(
            x,
            heightAt(x, z) - 0.01,
            z,
            r() * Math.PI * 2,
            s0 + r() * (s1 - s0),
            k,
            Math.floor(r() * this.kinds[k]!.variants.length),
          );
        }
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
