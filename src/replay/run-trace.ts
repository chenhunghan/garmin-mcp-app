/**
 * The run's trace (instead of a ribbon on the ground, which terrain cut and
 * swallowed):
 *
 * - `PathLine`: a thin glowing line along everything run so far, colored by
 *   the chosen metric. It leaves the runner at the hips and settles to a
 *   hand's height above the ground over the next few meters, and never fades.
 *   Built once; camera-facing in the vertex shader, cut at the runner by a
 *   uniform, at least ~1.5 px wide at any distance.
 * - `Dust`: dust kicked up by the feet, spreading behind the runner, drifting
 *   with the run's wind and settling. Each puff is a function of replay time
 *   (spawned at fixed times along the run, seeded by its index), so pausing
 *   freezes it and seeking lands on the same dust.
 */
import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  cameraPosition,
  cross,
  float,
  instancedDynamicBufferAttribute,
  max,
  mix,
  normalize,
  positionGeometry,
  smoothstep,
  step,
  uniform,
  uv,
  vec3,
  vec4,
  vertexColor,
} from "three/tsl";
import { locate } from "../replay-model.ts";
import { facadeLight } from "./facade.ts";
import type { Track } from "./track.ts";

/** Height of the settled line above the ground */
const LOW = 0.22;
/** Core width in meters close up; never thinner than ~1.6 px */
const CORE = 0.045;
const PX = 0.0016;
/** The quad is this many core widths wide, for the halo */
const HALO = 4;

export class PathLine {
  mesh: THREE.Mesh;
  private runnerS = uniform(0);
  private hip = uniform(0.95);
  private mat: THREE.MeshBasicNodeMaterial;

  constructor(
    private track: Track,
    ground: (x: number, z: number) => number,
    /** Per vertex (2 per dense sample) linear RGB, shared with the caller */
    colors: THREE.BufferAttribute,
  ) {
    const d = track.dense;
    const n = d.n;
    const pos = new Float32Array(n * 2 * 3);
    const dir = new Float32Array(n * 2 * 3);
    const s = new Float32Array(n * 2);
    const uvs = new Float32Array(n * 2 * 2);
    for (let i = 0; i < n; i++) {
      const x = d.x[i]!;
      const z = d.z[i]!;
      // Above the path and the ground here and halfway to either neighbor,
      // so the line never dips into a bump between samples
      let y = Math.max(d.y[i]!, ground(x, z));
      for (const j of [i - 1, i + 1]) {
        if (j < 0 || j >= n) continue;
        y = Math.max(y, ground((x + d.x[j]!) / 2, (z + d.z[j]!) / 2));
      }
      const h = d.heading[i]!;
      for (let side = 0; side < 2; side++) {
        const o = i * 2 + side;
        pos.set([x, y, z], o * 3);
        dir.set([Math.sin(h), 0, Math.cos(h)], o * 3);
        s[o] = d.s[i]!;
        uvs.set([side, 0], o * 2);
      }
    }
    const index: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aDir", new THREE.BufferAttribute(dir, 3));
    geo.setAttribute("aS", new THREE.BufferAttribute(s, 1));
    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute("color", colors);
    geo.setIndex(index);

    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexColors: true,
    });
    const sv = attribute("aS", "float");
    const behind = this.runnerS.sub(sv);
    // Out of the hips, down to a hand's height over ~8 m
    const lift = mix(this.hip, float(LOW), smoothstep(0.4, 8, behind));
    const center = positionGeometry.add(vec3(0, lift, 0));
    const toCam = cameraPosition.sub(center);
    const dist = toCam.length();
    const view = toCam.div(dist);
    const dv = attribute("aDir", "vec3");
    // Across the line, facing the camera (a horizontal bias keeps it defined
    // when looking straight along the line)
    const across = normalize(cross(dv, view).add(vec3(dv.z.negate(), 0, dv.x).mul(0.05)));
    const w = max(float(CORE), dist.mul(PX));
    const sideX = uv().x.mul(2).sub(1);
    // Zero width ahead of the runner: no fragments for the part not run yet
    const shown = step(sv, this.runnerS.add(0.5));
    mat.positionNode = center
      .add(
        across.mul(
          sideX
            .mul(w)
            .mul(HALO / 2)
            .mul(shown),
        ),
      )
      // A hair toward the camera far away, against depth precision
      .add(view.mul(dist.mul(0.002)));
    const q = abs(sideX);
    const core = smoothstep(0.32, 0.16, q);
    const halo = float(1).sub(q).pow(2.5).mul(0.3);
    const ends = smoothstep(this.runnerS.add(0.05), this.runnerS.sub(0.3), sv);
    mat.colorNode = vec4(
      // A hot, near-white core in a halo of the metric's color
      mix(vertexColor().xyz.mul(1.5), vertexColor().xyz.mul(0.6).add(0.7), core.mul(0.7)),
      1,
    );
    mat.opacityNode = max(core.mul(0.95), halo).mul(ends);
    this.mat = mat;

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = "path-line";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  /** `di`: the runner's fractional dense index; `hip`: hip height above the path */
  update(di: number, hip: number) {
    const d = this.track.dense;
    const a = Math.max(0, Math.min(d.n - 1, Math.floor(di)));
    const b = Math.min(d.n - 1, a + 1);
    this.runnerS.value = d.s[a]! + (d.s[b]! - d.s[a]!) * (di - a) - 0.2;
    this.hip.value = hip;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

/** Seconds of replay time between puffs */
const DT = 0.09;
/** Longest a grain of dust stays visible */
const LIFE = 4;
const PER_PUFF = 16;
const MAX = (Math.ceil(LIFE / DT) + 2) * PER_PUFF;
const DUST_TONE = [0.78, 0.7, 0.58];

/** Deterministic random in [0, 1) for puff k, grain j, draw m */
function rand(k: number, j: number, m: number) {
  let h =
    Math.imul(k ^ 0x9e3779b9, 0x85ebca6b) ^
    Math.imul(j + 1, 0xc2b2ae35) ^
    Math.imul(m + 7, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

export class Dust {
  sprite: THREE.Sprite;
  private posSize: THREE.InstancedBufferAttribute;
  private colAlpha: THREE.InstancedBufferAttribute;
  private mat: THREE.SpriteNodeMaterial;

  constructor(
    private track: Track,
    private times: ArrayLike<number>,
    private ground: (x: number, z: number) => number,
    /** Per dense sample linear RGB of the chosen metric */
    private colors: () => Float32Array,
  ) {
    this.posSize = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    this.colAlpha = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    this.posSize.setUsage(THREE.DynamicDrawUsage);
    this.colAlpha.setUsage(THREE.DynamicDrawUsage);
    const mat = new THREE.SpriteNodeMaterial({
      transparent: true,
      depthWrite: false,
    });
    const ps = instancedDynamicBufferAttribute(this.posSize, "vec4") as unknown as ReturnType<
      typeof vec4
    >;
    const ca = instancedDynamicBufferAttribute(this.colAlpha, "vec4") as unknown as ReturnType<
      typeof vec4
    >;
    mat.positionNode = ps.xyz;
    mat.scaleNode = ps.w;
    // A soft round grain cloud: dense in the middle, no visible edge
    const r2 = uv().sub(0.5).length().mul(2).pow(2);
    const soft = max(float(0), float(1).sub(r2)).pow(2);
    mat.colorNode = ca.xyz;
    mat.opacityNode = soft.mul(ca.w);
    this.mat = mat;
    this.sprite = new THREE.Sprite(mat);
    this.sprite.name = "dust";
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = 5;
    this.sprite.count = 0;
    this.sprite.visible = false;
  }

  /** Fractional dense index and distance at replay time `time` */
  private at(time: number) {
    const { i, f } = locate(this.times, time);
    const di = this.track.denseIndex(i, f);
    const d = this.track.dense;
    const a = Math.max(0, Math.min(d.n - 1, Math.floor(di)));
    const b = Math.min(d.n - 1, a + 1);
    return { di, a, b, u: di - a, s: d.s[a]! + (d.s[b]! - d.s[a]!) * (di - a) };
  }

  /** `time`: replay time; `wind`: the run's wind in m/s (x east, y → z) */
  update(time: number, wind: THREE.Vector2) {
    const d = this.track.dense;
    const t0 = this.times[0] ?? 0;
    const cols = this.colors();
    const P = this.posSize.array as Float32Array;
    const C = this.colAlpha.array as Float32Array;
    // Dust is lit, so it dims at night; the glints keep glowing
    const lit = 1 - 0.75 * facadeLight.night.value;
    let n = 0;
    const kHi = Math.floor(time / DT);
    const kLo = Math.max(0, Math.ceil((time - LIFE) / DT) - 1);
    for (let k = kLo; k <= kHi && n < MAX; k++) {
      const tk = k * DT;
      if (tk < t0 || tk > time) continue;
      const here = this.at(tk);
      // Speed over the last 0.3 s: no dust standing still
      const v = (here.s - this.at(tk - 0.3).s) / 0.3;
      if (!(v > 0.7)) continue;
      const amount = Math.min(1, v / 3.2);
      const { a, b, u } = here;
      const fx = d.x[a]! + (d.x[b]! - d.x[a]!) * u;
      const fz = d.z[a]! + (d.z[b]! - d.z[a]!) * u;
      const h = d.heading[a]! + (d.heading[b]! - d.heading[a]!) * u;
      const sx = Math.sin(h);
      const sz = Math.cos(h);
      // Right of the travel direction
      const rx = Math.cos(h);
      const rz = -Math.sin(h);
      const g = Math.max(d.y[a]! + (d.y[b]! - d.y[a]!) * u, this.ground(fx, fz));
      const c0 = cols[a * 3] ?? 1;
      const c1 = cols[a * 3 + 1] ?? 1;
      const c2 = cols[a * 3 + 2] ?? 1;
      for (let j = 0; j < PER_PUFF && n < MAX; j++) {
        const r = (m: number) => rand(k, j, m);
        if (r(0) > amount * 0.85 + 0.1) continue;
        const life = 1.2 + 2.4 * r(1);
        const age = time - tk - r(2) * DT;
        if (age < 0 || age > life) continue;
        const life01 = age / life;
        const mote = r(3) < 0.25;
        // Off one foot or the other, kicked back, out and up, slowed by the air
        const foot = (r(4) < 0.5 ? -1 : 1) * (0.08 + 0.06 * r(5));
        const back = (0.15 + 0.6 * r(6)) * Math.min(v, 5) * 0.3;
        const lat = (r(7) - 0.5) * 1.3 + foot * 1.5;
        const up = 0.2 + 1.1 * r(8) * r(8);
        const drag = 2.4 + 2 * r(9);
        const f = (1 - Math.exp(-drag * age)) / drag;
        // Spreading as it drifts: a slow swirl growing with √age
        const swirl = Math.sqrt(age) * 0.22 * (0.5 + r(10));
        const drift = 0.35 + 0.25 * r(11);
        const x =
          fx +
          rx * (foot + lat * f) -
          sx * back * f +
          wind.x * age * drift +
          Math.sin(age * 1.9 + r(12) * 6.28) * swirl;
        const z =
          fz +
          rz * (foot + lat * f) -
          sz * back * f +
          wind.y * age * drift +
          Math.cos(age * 1.6 + r(13) * 6.28) * swirl;
        const size = mote
          ? 0.012 + 0.016 * r(14)
          : 0.03 + 0.05 * r(14) + (0.12 + 0.28 * r(15)) * life01 ** 0.6;
        // Fine dust hangs and rises a little, coarse settles back
        let y =
          g +
          0.03 +
          up * f +
          age * (r(16) - 0.4) * 0.08 +
          Math.sin(age * 2.3 + r(17) * 6.28) * 0.03 * Math.sqrt(age);
        y = Math.max(y, g + 0.5 * size);
        const fade = Math.min(1, age / 0.1) * (1 - life01) ** 1.5;
        P[n * 4] = x;
        P[n * 4 + 1] = y;
        P[n * 4 + 2] = z;
        P[n * 4 + 3] = size;
        if (mote) {
          // A bright glint in the metric's color
          C[n * 4] = c0 * 1.4 + 0.15;
          C[n * 4 + 1] = c1 * 1.4 + 0.15;
          C[n * 4 + 2] = c2 * 1.4 + 0.15;
          C[n * 4 + 3] = 0.7 * fade;
        } else {
          C[n * 4] = (DUST_TONE[0]! * 0.45 + c0 * 0.55) * lit;
          C[n * 4 + 1] = (DUST_TONE[1]! * 0.45 + c1 * 0.55) * lit;
          C[n * 4 + 2] = (DUST_TONE[2]! * 0.45 + c2 * 0.55) * lit;
          C[n * 4 + 3] = 0.22 * fade * (1 - 0.5 * life01) * (0.6 + 0.4 * r(18));
        }
        n++;
      }
    }
    this.sprite.count = Math.max(1, n);
    this.sprite.visible = n > 0;
    if (n > 0) {
      this.posSize.needsUpdate = true;
      this.colAlpha.needsUpdate = true;
    }
  }

  dispose() {
    this.mat.dispose();
  }
}
