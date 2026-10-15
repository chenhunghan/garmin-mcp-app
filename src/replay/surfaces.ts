/**
 * Scanned surfaces from the asset pack (src/replay/assets.ts), sampled in
 * world space: ground and roads by their (x, z) in meters, walls by their
 * own wall coordinates. Every layer is read at two scales, the second turned
 * 90°, blended by a large noise, so the tiles don't show as a repeating
 * grid; neighboring materials meet by their height maps (grass fills the
 * gaps between stones first) instead of a straight cross-fade.
 */
import * as THREE from "three/webgpu";
import {
  clamp,
  float,
  int,
  mix,
  normalize,
  smoothstep,
  texture,
  uniformArray,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import type { Node } from "three/webgpu";
import type { SurfaceArrays } from "./assets.ts";
import { noiseTexture } from "./clouds.ts";

/** Ground layers, in the texture array's order (= sources.mjs) */
export const GROUND_IDS = [
  "ground.lawn",
  "ground.meadow",
  "ground.forest",
  "ground.dirt",
  "ground.gravel",
  "ground.asphalt",
  "ground.paving",
  "ground.concrete",
  "ground.sand",
  "ground.rock",
  "ground.soil",
  "ground.worn",
] as const;
export const G = Object.fromEntries(GROUND_IDS.map((id, i) => [id.slice(7), i])) as Record<
  (typeof GROUND_IDS)[number] extends `ground.${infer K}` ? K : never,
  number
>;

/** Wall and roof layers */
export const WALL_IDS = [
  "wall.plaster",
  "wall.render",
  "wall.concrete",
  "wall.brick",
  "wall.lightbrick",
  "wall.tiles",
  "wall.metal",
  "wall.wood",
  "roof.tiles",
  "roof.slate",
  "roof.concrete",
] as const;
export const W = Object.fromEntries(WALL_IDS.map((id, i) => [id.replace(".", "_"), i])) as Record<
  string,
  number
>;
/** Wall layers whose color is gray detail, tinted per building */
export const WALL_NEUTRAL = new Set(
  ["wall.plaster", "wall.render", "wall.concrete", "wall.tiles", "wall.metal", "roof.concrete"].map(
    (id) => WALL_IDS.indexOf(id as never),
  ),
);

export const BARK_IDS = [
  "bark.zelkova",
  "bark.camphor",
  "bark.brown",
  "bark.pine",
  "bark.palm",
] as const;

export interface SurfaceSample {
  /** Linear color */
  color: Node<"vec3">;
  /** 0–1 height (for blending) */
  height: Node<"float">;
  /** Normal map tilt in (u, v) directions of the sampled space, −1…1 */
  tilt: Node<"vec2">;
  rough: Node<"float">;
  ao: Node<"float">;
}

export class SurfaceSet {
  private tiles: ReturnType<typeof uniformArray>;
  constructor(readonly arrays: SurfaceArrays) {
    this.tiles = uniformArray(arrays.tiles, "float");
  }

  /**
   * One layer at a point. `p` is in meters in the surface's plane; the layer
   * index is a node (it can differ per pixel). `breakup` (0–1) blends the
   * second, turned sample in; omit for a single sample (cheaper, e.g. far away).
   */
  sample(layer: Node<"int">, p: Node<"vec2">, breakup?: Node<"float">): SurfaceSample {
    const tile = this.tiles.element(layer) as unknown as Node<"float">;
    const uv1 = p.div(tile);
    const a1 = texture(this.arrays.a, uv1).depth(layer);
    const b1 = texture(this.arrays.b, uv1).depth(layer);
    if (!breakup) {
      return {
        color: a1.rgb,
        height: a1.a,
        tilt: b1.rg.mul(2).sub(1),
        rough: b1.b,
        ao: b1.a,
      };
    }
    // Turned 90°, a little larger and shifted: (u, v) = (z, −x). (Much larger
    // would break the repeats better but looks blurred up close.)
    const uv2 = vec2(p.y, p.x.negate()).div(tile.mul(1.37)).add(vec2(0.37, 0.61));
    const a2 = texture(this.arrays.a, uv2).depth(layer);
    const b2 = texture(this.arrays.b, uv2).depth(layer);
    const t2 = b2.rg.mul(2).sub(1);
    const k = breakup;
    return {
      color: mix(a1.rgb, a2.rgb, k),
      height: mix(a1.a, a2.a, k),
      // The second sample's tilt turned back into the first one's axes
      tilt: mix(b1.rg.mul(2).sub(1), vec2(t2.y.negate(), t2.x), k),
      rough: mix(b1.b, b2.b, k),
      ao: mix(b1.a, b2.a, k),
    };
  }
}

/** Blend weight of a layer B over A: `w` 0–1 moves the line through their height maps. */
export function heightBlend(
  hA: Node<"float">,
  hB: Node<"float">,
  w: Node<"float">,
  sharp = 0.12,
): Node<"float"> {
  const t = w.mul(1.7).sub(0.85).add(hB.sub(hA).mul(0.7));
  return smoothstep(float(-sharp), float(sharp), t);
}

export function mixSample(a: SurfaceSample, b: SurfaceSample, k: Node<"float">): SurfaceSample {
  return {
    color: mix(a.color, b.color, k),
    height: mix(a.height, b.height, k),
    tilt: mix(a.tilt, b.tilt, k),
    rough: mix(a.rough, b.rough, k),
    ao: mix(a.ao, b.ao, k),
  };
}

/**
 * A world-space normal tilted by a ground surface's normal map: `tilt` is
 * along world +x and +z (ground planes sampled at (x, z)).
 */
export function groundNormal(
  n: Node<"vec3">,
  tilt: Node<"vec2">,
  strength: Node<"float"> | number,
): Node<"vec3"> {
  const s = typeof strength === "number" ? float(strength) : strength;
  // Axes along the surface: world x and z projected onto its plane
  const tx = normalize(vec3(1, 0, 0).sub(n.mul(n.x)));
  const tz = normalize(vec3(0, 0, 1).sub(n.mul(n.z)));
  return normalize(n.add(tx.mul(tilt.x.mul(s))).add(tz.mul(tilt.y.mul(s))));
}

/** Large-scale noise 0–1 (the cloud field, ~`scale` m per feature) for breakups and patches */
export function worldNoise(p: Node<"vec2">, scale: number, offset = 0): Node<"float"> {
  return texture(noiseTexture(), p.div(scale).add(offset)).r;
}

/** Ground layer index (int) from a float node, clamped into the array */
export function layerIndex(v: Node<"float">, layers: number): Node<"int"> {
  return int(clamp(v.add(0.5), float(0), float(layers - 1)));
}

export function vec4Of(s: SurfaceSample): Node<"vec4"> {
  return vec4(s.color, s.height);
}

export const surfaceDisposables = (s: SurfaceArrays | null): THREE.Texture[] =>
  s ? [s.a, s.b] : [];
