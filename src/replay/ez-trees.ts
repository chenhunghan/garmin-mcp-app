/**
 * Close-up trees: EZ-Tree (MIT, vendored in ./vendor/ez-tree) grows a few
 * variants per look from its presets, dressed with scanned bark and leaf
 * atlases from the asset pack. Which look a tree gets comes from its mapped
 * genus (OSM genus/species/taxon), e.g. maple leaves on an Acer, camphor bark
 * on a Cinnamomum, needles on a pine. The geometry is normalized to 1 m tall
 * and stands on the origin, so the Forest's instance matrices (height ×
 * width) place it like the procedural shapes.
 */
import * as THREE from "three/webgpu";
import {
  attribute,
  float,
  instanceIndex,
  int,
  mix,
  positionLocal,
  sin,
  smoothstep,
  texture,
  time,
  uv,
  vec2,
  vec3,
} from "three/tsl";
// @ts-expect-error (vendored JavaScript, no types)
import { Tree } from "./vendor/ez-tree/tree.js";
import type { AssetLibrary } from "./assets.ts";
import { BARK_IDS } from "./surfaces.ts";
import { TREE_CONIFER, TREE_GENUS } from "../geo/types.ts";
import { treeWind as leafWind } from "./tree-wind.ts";

export const LOOKS = ["broad", "maple", "camphor", "zelkova", "heart", "birch", "pine"] as const;
export type Look = (typeof LOOKS)[number];

const LOOK: Record<Look, { presets: [string, number][]; atlas: string; bark: string }> = {
  broad: {
    presets: [
      ["Oak Medium", 11],
      ["Ash Medium", 23],
    ],
    atlas: "leaves.broad",
    bark: "bark.brown",
  },
  maple: {
    presets: [
      ["Ash Medium", 5],
      ["Oak Medium", 41],
    ],
    atlas: "leaves.maple",
    bark: "bark.zelkova",
  },
  camphor: {
    presets: [
      ["Oak Medium", 77],
      ["Oak Large", 3],
    ],
    atlas: "leaves.broad",
    bark: "bark.camphor",
  },
  zelkova: {
    presets: [
      ["Ash Medium", 61],
      ["Aspen Medium", 7],
    ],
    atlas: "leaves.broad",
    bark: "bark.zelkova",
  },
  heart: {
    presets: [
      ["Aspen Medium", 13],
      ["Aspen Large", 29],
    ],
    atlas: "leaves.heart",
    bark: "bark.brown",
  },
  birch: {
    presets: [
      ["Ash Medium", 97],
      ["Ash Large", 17],
    ],
    atlas: "leaves.broad",
    bark: "bark.brown",
  },
  pine: {
    presets: [
      ["Pine Medium", 31],
      ["Pine Large", 8],
    ],
    atlas: "leaves.needles",
    bark: "bark.pine",
  },
};

/** The look for a tree's kind value (low 2 bits: kind, the rest: genus group); null for palms */
export function lookOf(kindValue: number): number | null {
  const base = kindValue & 3;
  if (base === 2) return null; // palms keep their own shape
  if (base === TREE_CONIFER) return LOOKS.indexOf("pine");
  const genus = TREE_GENUS[kindValue >> 2] ?? "unknown";
  const look: Look = genus === "unknown" ? "broad" : genus;
  return LOOKS.indexOf(look);
}

export interface TreeLook {
  variants: { branches: THREE.BufferGeometry; leaves: THREE.BufferGeometry }[];
  bark: THREE.Material;
  leaves: THREE.Material;
}

/**
 * Grow the variants of the looks in use, with their materials. Null if the
 * leaf atlases or bark can't be loaded.
 */
export async function growLooks(
  lib: AssetLibrary,
  looks: Set<number>,
): Promise<Map<number, TreeLook> | null> {
  const bark = await lib.surfaces([...BARK_IDS], 512);
  if (!bark) return null;
  const out = new Map<number, TreeLook>();
  for (const li of looks) {
    const look = LOOK[LOOKS[li]!]!;
    const atlas = await lib.atlas(look.atlas);
    if (!atlas) continue;
    const variants = look.presets.map(([preset, seed]) => grow(preset, seed, atlas.rects));
    out.set(li, {
      variants,
      bark: barkMaterial(bark.a, BARK_IDS.indexOf(look.bark as never)),
      leaves: leafMaterial(atlas.a),
    });
  }
  return out;
}

function grow(preset: string, seed: number, rects: number[][]) {
  const tree = new Tree();
  tree.loadPreset(preset);
  tree.options.seed = seed;
  // The presets are tuned for textures of whole twigs; ours are single
  // leaves: smaller and more of them
  tree.options.leaves.size *= 1.2;
  tree.options.leaves.count = Math.round(tree.options.leaves.count * 2.2);
  const g = tree.createGeometry({ segmentFactor: 0.6, sectionStride: 1, leafStride: 1 }) as {
    branches: THREE.BufferGeometry;
    leaves: THREE.BufferGeometry;
  };
  // 1 m tall, the trunk's foot at the origin
  g.branches.computeBoundingBox();
  g.leaves.computeBoundingBox();
  const box = g.branches.boundingBox!.clone().union(g.leaves.boundingBox!);
  const s = 1 / Math.max(1e-3, box.max.y - box.min.y);
  for (const geo of [g.branches, g.leaves]) {
    geo.translate(0, -g.branches.boundingBox!.min.y, 0);
    geo.scale(s, s, s);
  }
  // Leaves: each quad shows one leaf of the atlas; normals lean away from
  // the crown's middle, so the crown shades as one mass
  const leaves = g.leaves;
  leaves.computeBoundingBox();
  const center = leaves.boundingBox!.getCenter(new THREE.Vector3());
  const pos = leaves.attributes.position as THREE.BufferAttribute;
  const nor = leaves.attributes.normal as THREE.BufferAttribute;
  const uvs = leaves.attributes.uv as THREE.BufferAttribute;
  const shade = new Float32Array(pos.count);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const half = (leaves.boundingBox!.max.y - leaves.boundingBox!.min.y) / 2 || 1;
  for (let v = 0; v < pos.count; v++) {
    const quad = Math.floor(v / 4);
    const rect = rects.length ? rects[((quad * 2654435761) % rects.length) >>> 0]! : [0, 0, 1, 1];
    uvs.setXY(v, rect[0]! + uvs.getX(v) * rect[2]!, rect[1]! + uvs.getY(v) * rect[3]!);
    p.fromBufferAttribute(pos, v);
    n.fromBufferAttribute(nor, v);
    const out = p.clone().sub(center);
    // Inner leaves are darker (self-shadowed crown)
    shade[v] = THREE.MathUtils.clamp(0.45 + (out.length() / half) * 0.55, 0.45, 1);
    n.multiplyScalar(0.35).add(out.normalize().multiplyScalar(0.65)).normalize();
    nor.setXYZ(v, n.x, n.y, n.z);
  }
  leaves.setAttribute("aShade", new THREE.BufferAttribute(shade, 1));
  uvs.needsUpdate = true;
  return { branches: g.branches, leaves };
}

function sway(strength: number) {
  const phase = float(instanceIndex).mul(1.73);
  const h2 = positionLocal.y.mul(positionLocal.y);
  const s = sin(time.mul(1.4).add(phase)).mul(leafWind).mul(strength).mul(h2);
  return positionLocal.add(vec3(s, 0, s.mul(0.6)));
}

function barkMaterial(bark: THREE.DataArrayTexture, layer: number) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  // EZ-Tree's bark u goes around a branch, v along it (in its own units)
  const t = texture(bark, uv().mul(vec2(2, 0.5))).depth(int(layer));
  mat.colorNode = t.rgb.mul(0.85);
  mat.positionNode = sway(0.012);
  return mat;
}

function leafMaterial(atlas: THREE.DataTexture) {
  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: 0.75,
    metalness: 0,
    side: THREE.DoubleSide,
    alphaTest: 0.5,
  });
  const a = texture(atlas, uv());
  const shade = attribute("aShade", "float");
  // (three multiplies in the instance color: per-tree variety and the season)
  mat.colorNode = a.rgb.mul(mix(float(0.55), float(1.05), smoothstep(0.45, 1, shade)));
  mat.opacityNode = a.a;
  mat.positionNode = sway(0.03);
  return mat;
}
