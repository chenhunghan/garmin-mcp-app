/**
 * The route behind the runner as a glowing wake at hip height, instead of a
 * ribbon on the ground (ground ribbons got cut by terrain and sank into it):
 * a soft band that streams out of the runner's back along the last ~45 m of
 * the path, colored by the chosen metric and fading out, with a few thin air
 * streaks spiraling around it. Camera-facing strips rebuilt each frame on the
 * CPU (a few hundred vertices), drawn without depth writes (the band blended, the streaks added).
 */
import * as THREE from "three/webgpu";
import { abs, attribute, float, smoothstep, sub, uv, vec4, vertexColor } from "three/tsl";
import type { Track } from "./track.ts";

const LENGTH = 45;
const STEP = 0.35;
const POINTS = Math.ceil(LENGTH / STEP) + 1;
const STREAKS = 3;
const STREAK_LENGTH = 22;

interface Strip {
  geo: THREE.BufferGeometry;
  pos: Float32Array;
  col: Float32Array;
  alpha: Float32Array;
  mesh: THREE.Mesh;
}

function strip(points: number, mat: THREE.Material): Strip {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(points * 2 * 3);
  const col = new Float32Array(points * 2 * 3);
  const alpha = new Float32Array(points * 2);
  const uvs = new Float32Array(points * 2 * 2);
  for (let i = 0; i < points; i++) uvs.set([0, i / (points - 1), 1, i / (points - 1)], i * 4);
  const index: number[] = [];
  for (let i = 0; i < points - 1; i++) {
    const a = i * 2;
    index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("aAlpha", new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(index);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  return { geo, pos, col, alpha, mesh };
}

function glowMaterial(core: number, additive: boolean) {
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    // The band blends normally, so its metric color reads in daylight too;
    // the thin air streaks add light
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    side: THREE.DoubleSide,
    vertexColors: true,
  });
  // Soft across the band (brighter core), faded by the per-vertex alpha
  const across = abs(sub(uv().x, 0.5)).mul(2);
  const soft = smoothstep(float(1), float(0), across);
  const glow = soft
    .mul(soft)
    .mul(core)
    .add(soft.mul(1 - core));
  mat.colorNode = vec4(vertexColor().xyz, 1);
  mat.opacityNode = glow.mul(attribute("aAlpha", "float"));
  mat.fog = false;
  return mat;
}

export class GlowTrail {
  group = new THREE.Group();
  private band: Strip;
  private streaks: Strip[] = [];
  private mats: THREE.Material[] = [];
  private tmp = new THREE.Vector3();
  private side = new THREE.Vector3();
  private tan = new THREE.Vector3();
  private view = new THREE.Vector3();

  constructor(
    private track: Track,
    /** Per dense sample: linear RGB of the chosen metric (3 per sample) */
    private colors: () => Float32Array,
  ) {
    this.group.name = "glow-trail";
    const bandMat = glowMaterial(0.6, false);
    const streakMat = glowMaterial(0.2, true);
    this.mats.push(bandMat, streakMat);
    this.band = strip(POINTS, bandMat);
    this.group.add(this.band.mesh);
    const n = Math.ceil(STREAK_LENGTH / STEP) + 1;
    for (let k = 0; k < STREAKS; k++) {
      const st = strip(n, streakMat);
      this.streaks.push(st);
      this.group.add(st.mesh);
    }
  }

  /** Index into the dense path for distance s (binary search, fractional) */
  private at(s: number): number {
    const S = this.track.dense.s;
    let lo = 0;
    let hi = this.track.dense.n - 1;
    if (s <= S[0]!) return 0;
    if (s >= S[hi]!) return hi;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (S[mid]! <= s) lo = mid;
      else hi = mid;
    }
    return lo + (s - S[lo]!) / Math.max(1e-6, S[hi]! - S[lo]!);
  }

  /**
   * Rebuild around the runner. `di`: the runner's fractional dense index;
   * `hip`: the band's height above the path; `t`: replay time (for the air
   * ripple); `ground`: height of the ground, so the wake never dips into it.
   */
  update(
    di: number,
    hip: number,
    cam: THREE.Vector3,
    t: number,
    ground: (x: number, z: number) => number,
  ) {
    const d = this.track.dense;
    if (d.n < 2) return;
    const k0 = Math.min(d.n - 1, Math.floor(di));
    const k1 = Math.min(d.n - 1, k0 + 1);
    const s0 = d.s[k0]! + (d.s[k1]! - d.s[k0]!) * (di - k0) - 0.25;
    const cols = this.colors();
    const point = (s: number, out: THREE.Vector3) => {
      const f = this.at(s);
      const a = Math.floor(f);
      const b = Math.min(d.n - 1, a + 1);
      const u = f - a;
      const x = d.x[a]! + (d.x[b]! - d.x[a]!) * u;
      const z = d.z[a]! + (d.z[b]! - d.z[a]!) * u;
      const y = Math.max(d.y[a]! + (d.y[b]! - d.y[a]!) * u, ground(x, z));
      return { p: out.set(x, y, z), a, b, u };
    };
    const fill = (
      st: Strip,
      n: number,
      width: (u: number) => number,
      offset: (u: number, s: number, side: THREE.Vector3, up: THREE.Vector3) => THREE.Vector3,
      alpha: (u: number) => number,
      tint: (c: [number, number, number], u: number) => [number, number, number],
    ) => {
      const prev = new THREE.Vector3();
      const cur = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0);
      for (let i = 0; i < n; i++) {
        const s = s0 - i * STEP;
        const u = i / (n - 1);
        const q = point(s, cur);
        // Tangent from the neighbor sample
        point(s - STEP * 0.5, prev);
        this.tan.subVectors(cur, prev).setY(0);
        if (this.tan.lengthSq() < 1e-8) this.tan.set(0, 0, 1);
        this.tan.normalize();
        const base = this.tmp.copy(cur).setY(cur.y + hip);
        base.add(offset(u, s, this.side.set(this.tan.z, 0, -this.tan.x), up));
        // Face the camera: across = tangent × view
        this.view.subVectors(cam, base).normalize();
        const across = this.side.crossVectors(this.tan, this.view);
        if (across.lengthSq() < 1e-8) across.set(this.tan.z, 0, -this.tan.x);
        across.normalize().multiplyScalar(width(u) / 2);
        st.pos.set([base.x - across.x, base.y - across.y, base.z - across.z], i * 6);
        st.pos.set([base.x + across.x, base.y + across.y, base.z + across.z], i * 6 + 3);
        const c: [number, number, number] = [0, 0, 0];
        for (let ch = 0; ch < 3; ch++)
          c[ch] = cols[q.a * 3 + ch]! + (cols[q.b * 3 + ch]! - cols[q.a * 3 + ch]!) * q.u;
        const tc = tint(c, u);
        st.col.set([...tc, ...tc], i * 6);
        const al = alpha(u);
        st.alpha[i * 2] = al;
        st.alpha[i * 2 + 1] = al;
      }
      // Hide the part beyond the start of the run
      for (const name of ["position", "color", "aAlpha"])
        st.geo.getAttribute(name).needsUpdate = true;
    };
    const behind = (u: number, len: number) => Math.min(1, (s0 - u * len) / 3);
    // The band: wide at the hips, tapering and fading over 45 m, a slow ripple
    fill(
      this.band,
      POINTS,
      (u) => 0.42 * (1 - u) ** 0.7 + 0.02,
      (u, s, side) =>
        side.multiplyScalar(0).add(new THREE.Vector3(0, Math.sin(s * 0.9 - t * 2.6) * 0.05 * u, 0)),
      (u) => Math.max(0, behind(u, LENGTH)) * 0.85 * (1 - u) ** 1.6 * ease01(0.012, 0.05, u),
      // A little brighter than the metric's color: it glows a bit
      (c) => [c[0] * 1.25, c[1] * 1.25, c[2] * 1.25],
    );
    // Air streaks: thin, spiraling out around the band as they trail off
    this.streaks.forEach((st, k) => {
      const n = st.alpha.length / 2;
      fill(
        st,
        n,
        (u) => 0.045 * (1 - u) + 0.01,
        (u, s, side, up) => {
          const ph = s * 1.3 - t * 5 + (k * Math.PI * 2) / STREAKS;
          const r = 0.12 + 0.45 * u;
          return side
            .multiplyScalar(Math.cos(ph) * r)
            .add(up.clone().multiplyScalar(Math.sin(ph) * r * 0.6));
        },
        (u) =>
          Math.max(0, behind(u, STREAK_LENGTH)) * 0.55 * (1 - u) ** 1.3 * ease01(0.06, 0.16, u),
        (c) => [0.5 + c[0] * 0.6, 0.5 + c[1] * 0.6, 0.5 + c[2] * 0.6],
      );
    });
  }

  dispose() {
    this.band.geo.dispose();
    for (const s of this.streaks) s.geo.dispose();
    for (const m of this.mats) m.dispose();
  }
}

function ease01(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
