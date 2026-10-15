/**
 * Grass on the green ground, around the camera only: tufts of curved blades
 * placed in world-fixed 10 m chunks (generated as they come into range,
 * cached), drawn as one instanced mesh whose buffers are refilled when the
 * camera moves. Where it grows and how tall comes from the land cover: short
 * turf on lawns and pitches, longer meadow grass elsewhere — never taller
 * than ~0.6 m. In the shader (after the stylized-grass references): root to
 * tip color in two variants mixed by noise patches, travelling wind gusts
 * that bend blades more towards the tip, normals tilted up so the field
 * shades as one soft surface, and a fade-out towards the edge of the radius.
 */
import * as THREE from "three/webgpu";
import {
  attribute,
  cameraPosition,
  cos,
  float,
  mix,
  normalize,
  positionLocal,
  pow,
  sin,
  smoothstep,
  texture,
  time,
  transformNormalToView,
  uniform,
  uv,
  vec3,
} from "three/tsl";
import type { AreaKind } from "../geo/types.ts";
import { noiseTexture } from "./clouds.ts";
import { lampAt } from "./furniture.ts";

/** Tufts per m² and blade height range (m) by land kind */
interface Growth {
  density: number;
  h0: number;
  h1: number;
  /** Tint: 0 lush … 1 dry */
  dry: number;
  width: number;
}
const LAWN: Growth = { density: 11, h0: 0.06, h1: 0.13, dry: 0.05, width: 0.9 };
const MEADOW: Growth = { density: 8, h0: 0.2, h1: 0.48, dry: 0.12, width: 1 };
const GROWTH: Partial<Record<AreaKind | "unmapped", Growth>> = {
  park: LAWN,
  pitch: { ...LAWN, h0: 0.05, h1: 0.08, dry: 0 },
  grass: MEADOW,
  unmapped: MEADOW,
  farmland: { density: 6, h0: 0.3, h1: 0.55, dry: 0.6, width: 1.1 },
  scrub: { density: 4, h0: 0.3, h1: 0.55, dry: 0.55, width: 1.1 },
  wetland: { density: 6, h0: 0.35, h1: 0.58, dry: 0.2, width: 0.9 },
  forest: { density: 3, h0: 0.15, h1: 0.35, dry: 0.15, width: 1 },
};

export interface GrassSite {
  heightAt(x: number, z: number): number;
  /** Land kind at a point; undefined = no map (generated meadow everywhere) */
  kindAt?: (x: number, z: number) => AreaKind | null;
  /** Paths, roads, water, buildings */
  blocked(x: number, z: number): boolean;
  season: "spring" | "summer" | "autumn" | "winter";
}

const CHUNK = 10;
const RADIUS = 55;
/** Within this, every tuft; beyond, a share that thins to the edge */
const FULL = 22;
const CAP = 60000;
/** Per tuft: x, y, z, angle | height, width, dry, seed */
const STRIDE = 8;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/**
 * One tuft: `blades` curved blades, 1 m tall (scaled per instance). Without
 * an atlas they're tapered strips; with one (scanned grass blades, asset
 * pack), each is a quad as wide as its atlas piece, cut out by the alpha.
 */
function tuftGeometry(blades = 7, segments = 3, rects?: number[][]) {
  const pos: number[] = [];
  const nor: number[] = [];
  const uvs: number[] = [];
  const along: number[] = [];
  const idx: number[] = [];
  const r = rng(17);
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2 + r() * 0.9;
    const off = 0.02 + r() * 0.15;
    const ox = Math.cos(a) * off;
    const oz = Math.sin(a) * off;
    const face = a + Math.PI / 2 + (r() - 0.5) * 0.8; // blade's flat side
    const fx = Math.cos(face);
    const fz = Math.sin(face);
    const lean = 0.18 + r() * 0.25; // outwards, more at the tip
    const h = 0.75 + r() * 0.25;
    const rect = rects?.length ? rects[Math.floor(r() * rects.length)]! : null;
    // An atlas blade keeps its proportions (its image includes some margin)
    const w = rect ? (h * rect[2]!) / rect[3]! : 0.05 + r() * 0.025;
    const base = pos.length / 3;
    for (let sgm = 0; sgm <= segments; sgm++) {
      const t = sgm / segments;
      const y = t * h;
      const bend = lean * t * t;
      const cx = ox + Math.cos(a) * bend;
      const cz = oz + Math.sin(a) * bend;
      const half = rect ? w / 2 : (w / 2) * (1 - t * 0.92);
      pos.push(cx - fx * half, y, cz - fz * half, cx + fx * half, y, cz + fz * half);
      // Facing out from the tuft (the shader tilts it up)
      nor.push(Math.cos(a), 0.3, Math.sin(a), Math.cos(a), 0.3, Math.sin(a));
      if (rect)
        uvs.push(rect[0]!, rect[1]! + t * rect[3]!, rect[0]! + rect[2]!, rect[1]! + t * rect[3]!);
      else uvs.push(0, t, 1, t);
      along.push(t, t);
      if (sgm < segments) {
        const k = base + sgm * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute("aT", new THREE.Float32BufferAttribute(along, 1));
  g.setIndex(idx);
  return g;
}

/** Set by the scene: wind (direction × strength), the season's dryness */
export const grassLight = {
  wind: uniform(new THREE.Vector2(0.6, 0.3)),
  dry: uniform(0),
  radius: uniform(RADIUS),
};

function grassMaterial(atlas?: THREE.Texture) {
  const mat = new THREE.MeshStandardNodeMaterial({
    side: THREE.DoubleSide,
    roughness: 0.85,
    metalness: 0,
    ...(atlas ? { alphaTest: 0.45 } : {}),
  });
  const P = attribute("aPos", "vec4");
  const S = attribute("aShape", "vec4");
  const t = attribute("aT", "float");
  const ang = P.w;
  const ca = cos(ang);
  const sa = sin(ang);
  const lp = positionLocal;
  // Tuft space → world: rotate about Y, scale (width, height), move
  const local = vec3(
    lp.x.mul(ca).sub(lp.z.mul(sa)).mul(S.y),
    lp.y.mul(S.x),
    lp.x.mul(sa).add(lp.z.mul(ca)).mul(S.y),
  );
  const base = vec3(P.x, P.y, P.z);
  // Shrink towards the edge of the radius (no popping as chunks come and go)
  const d = base.xz.sub(cameraPosition.xz).length();
  const fade = smoothstep(grassLight.radius, grassLight.radius.mul(0.78), d);
  // Wind: gusts travel across the field; each blade flutters a little
  const noise = noiseTexture();
  const gust = texture(noise, base.xz.mul(0.025).sub(grassLight.wind.mul(time.mul(0.08)))).r;
  const sway = float(0.25).add(gust.mul(0.9));
  const flutter = sin(time.mul(4.2).add(S.w.mul(37))).mul(0.18);
  const bendAmt = pow(t, 1.6).mul(S.x);
  const wind = vec3(grassLight.wind.x, 0, grassLight.wind.y)
    .mul(sway.add(flutter))
    .mul(bendAmt)
    .mul(0.55);
  mat.positionNode = base.add(local.mul(fade)).add(wind.mul(fade));

  // Normals: mostly up, a little of the blade's own (soft, even shading)
  const n = vec3(lp.x.mul(ca).sub(lp.z.mul(sa)), float(1.6), lp.x.mul(sa).add(lp.z.mul(ca)));
  mat.normalNode = transformNormalToView(normalize(n));

  // Color: root → tip, lush/dry variants by patches, per-tuft variation
  const patch = texture(noise, base.xz.div(23)).r;
  const macro = texture(noise, base.xz.div(160)).g;
  const dry = S.z.add(grassLight.dry).add(macro.sub(0.5).mul(0.35)).clamp(0, 1);
  const rootA = vec3(0.07, 0.15, 0.03);
  const tipA = vec3(0.22, 0.42, 0.07);
  const rootB = vec3(0.17, 0.2, 0.06);
  const tipB = vec3(0.62, 0.6, 0.24);
  const root = mix(rootA, rootB, dry);
  const tip = mix(mix(tipA, vec3(0.3, 0.48, 0.09), patch), tipB, dry);
  const seedTint = float(0.88).add(S.w.mul(0.24));
  const ao = mix(float(0.55), float(1), smoothstep(0, 0.55, t));
  if (atlas) {
    // Scanned blades: their own color, warmed and paled where it's dry,
    // darker towards the roots (the tuft shades itself)
    const blade = texture(atlas, uv());
    const own = mix(blade.rgb, blade.rgb.mul(vec3(1.35, 1.12, 0.55)), dry.mul(0.8));
    mat.colorNode = own.mul(mix(float(0.62), float(1.05), smoothstep(0, 0.8, t))).mul(seedTint);
    mat.opacityNode = blade.a;
  } else {
    mat.colorNode = mix(root, tip, smoothstep(0, 1, t))
      .mul(seedTint)
      .mul(ao);
  }
  // Light through the blades near the tips (back-lit grass glows), and the
  // street lamps' light at night, like the ground under them
  mat.emissiveNode = tip
    .mul(t.mul(t))
    .mul(0.04)
    .add(mat.colorNode.mul(lampAt(base.xz)));
  return mat;
}

export class Grass {
  mesh: THREE.InstancedMesh;
  private pos: THREE.InstancedBufferAttribute;
  private shape: THREE.InstancedBufferAttribute;
  private chunks = new Map<string, Float32Array>();
  private lastCam = new THREE.Vector3(Infinity, 0, 0);
  private lastAt = -Infinity;
  private lastQ = -1;
  private pending = false;

  constructor(private site: GrassSite) {
    const geo = tuftGeometry();
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4);
    this.shape = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.shape.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aPos", this.pos);
    geo.setAttribute("aShape", this.shape);
    this.mesh = this.makeMesh(geo, grassMaterial());
  }

  /**
   * Switch to scanned grass blades (asset pack): a new mesh with its own
   * buffers replaces the old one, which is freed whole (three frees every
   * buffer a disposed geometry's draws used, the instance matrix included,
   * so nothing can be carried over).
   */
  useAtlas(atlas: { a: THREE.Texture; rects: number[][] }) {
    const old = this.mesh;
    const geo = tuftGeometry(7, 3, atlas.rects);
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(this.pos.array), 4);
    this.shape = new THREE.InstancedBufferAttribute(new Float32Array(this.shape.array), 4);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.shape.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aPos", this.pos);
    geo.setAttribute("aShape", this.shape);
    this.mesh = this.makeMesh(geo, grassMaterial(atlas.a));
    this.mesh.count = old.count;
    old.parent?.add(this.mesh);
    old.parent?.remove(old);
    old.geometry.dispose();
    (old.material as THREE.Material).dispose();
    old.dispose();
  }

  private makeMesh(geo: THREE.BufferGeometry, mat: THREE.Material) {
    const mesh = new THREE.InstancedMesh(geo, mat, CAP);
    mesh.name = "grass";
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  /** The tufts of one chunk (generated once). */
  private chunk(cx: number, cz: number): Float32Array {
    const key = `${cx},${cz}`;
    const hit = this.chunks.get(key);
    if (hit) return hit;
    const { heightAt, kindAt, blocked } = this.site;
    const r = rng((cx * 73856093) ^ (cz * 19349663));
    const out: number[] = [];
    const x0 = cx * CHUNK;
    const z0 = cz * CHUNK;
    // Candidates at the densest rate; each keeps itself by its spot's density
    const n = Math.round(CHUNK * CHUNK * LAWN.density);
    for (let i = 0; i < n; i++) {
      const x = x0 + r() * CHUNK;
      const z = z0 + r() * CHUNK;
      const pick = r();
      const k = kindAt ? kindAt(x, z) : null;
      const g = kindAt ? GROWTH[k ?? "unmapped"] : MEADOW;
      if (!g || pick * LAWN.density > g.density) continue;
      if (blocked(x, z)) continue;
      const y = heightAt(x, z);
      // Not on steep rock
      const slope =
        Math.max(Math.abs(heightAt(x + 0.7, z) - y), Math.abs(heightAt(x, z + 0.7) - y)) / 0.7;
      if (slope > 0.7) continue;
      out.push(
        x,
        y - 0.02,
        z,
        r() * Math.PI * 2,
        g.h0 + (g.h1 - g.h0) * r() ** 1.5,
        g.width * (0.8 + r() * 0.4),
        g.dry,
        r(),
      );
    }
    const arr = new Float32Array(out);
    this.chunks.set(key, arr);
    return arr;
  }

  /** Refill the instances around the camera (throttled; new chunks a few per call). */
  update(cam: THREE.Vector3, quality: number, now: number) {
    const moved = cam.distanceToSquared(this.lastCam) > 9;
    if (!(moved || this.pending || quality !== this.lastQ) || now - this.lastAt < 200) return;
    this.lastAt = now;
    this.lastCam.copy(cam);
    this.lastQ = quality;
    const R = RADIUS * Math.max(0.55, quality);
    grassLight.radius.value = R;
    const full = FULL * Math.max(0.6, quality);
    const c0x = Math.floor((cam.x - R) / CHUNK);
    const c1x = Math.floor((cam.x + R) / CHUNK);
    const c0z = Math.floor((cam.z - R) / CHUNK);
    const c1z = Math.floor((cam.z + R) / CHUNK);
    const P = this.pos.array as Float32Array;
    const S = this.shape.array as Float32Array;
    let n = 0;
    let built = 0;
    this.pending = false;
    // Nearest chunks first, so new ground fills in from the camera outwards
    const list: [number, number, number][] = [];
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cz = c0z; cz <= c1z; cz++) {
        const dx = Math.max(0, Math.abs((cx + 0.5) * CHUNK - cam.x) - CHUNK / 2);
        const dz = Math.max(0, Math.abs((cz + 0.5) * CHUNK - cam.z) - CHUNK / 2);
        const d = Math.hypot(dx, dz);
        if (d < R) list.push([d, cx, cz]);
      }
    }
    list.sort((a, b) => a[0] - b[0]);
    for (const [, cx, cz] of list) {
      if (!this.chunks.has(`${cx},${cz}`)) {
        if (built >= 10) {
          this.pending = true;
          continue;
        }
        built++;
      }
      const t = this.chunk(cx, cz);
      for (let i = 0; i < t.length && n < CAP; i += STRIDE) {
        const dx = t[i]! - cam.x;
        const dz = t[i + 2]! - cam.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d > R) continue;
        // Beyond `full`, keep a share that thins to ~25 % at the edge
        if (d > full && t[i + 7]! > 1 - 0.75 * ((d - full) / (R - full))) continue;
        P[n * 4] = t[i]!;
        P[n * 4 + 1] = t[i + 1]!;
        P[n * 4 + 2] = t[i + 2]!;
        P[n * 4 + 3] = t[i + 3]!;
        S[n * 4] = t[i + 4]!;
        S[n * 4 + 1] = t[i + 5]!;
        S[n * 4 + 2] = t[i + 6]!;
        S[n * 4 + 3] = t[i + 7]!;
        n++;
      }
    }
    this.mesh.count = n;
    this.pos.needsUpdate = true;
    this.shape.needsUpdate = true;
    // Forget chunks far behind (memory), keep a margin for turning around
    if (this.chunks.size > 600) {
      for (const key of this.chunks.keys()) {
        const [cx, cz] = key.split(",").map(Number) as [number, number];
        if (Math.hypot((cx + 0.5) * CHUNK - cam.x, (cz + 0.5) * CHUNK - cam.z) > R * 3)
          this.chunks.delete(key);
      }
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
