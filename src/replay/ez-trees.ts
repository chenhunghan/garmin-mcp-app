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
    const leavesAtlas = await lib.atlas(look.atlas);
    if (!leavesAtlas) continue;
    const atlas = twigAtlas(leavesAtlas, li);
    const variants = look.presets.map(([preset, seed]) => grow(preset, seed, atlas.rects));
    out.set(li, {
      variants,
      bark: barkMaterial(bark.a, BARK_IDS.indexOf(look.bark as never)),
      leaves: leafMaterial(atlas.a),
    });
  }
  return out;
}

/**
 * The scanned atlases hold single leaves; EZ-Tree's presets expect each leaf
 * card to carry a whole twig. Compose four twigs (a stem with 6–8 leaves
 * along it, smaller toward the tip) into a new atlas, so cards at the presets'
 * sizes show leaves at their real size. Pieces are drawn along their long
 * axis, base to tip (leaves stand upright in the atlases; needles lie).
 */
export function twigAtlas(
  src: { a: THREE.DataTexture; rects: number[][] },
  seed = 0,
): { a: THREE.DataTexture; rects: number[][] } {
  const img = src.a.image as { data: Uint8Array; width: number; height: number };
  const SW = img.width;
  const SH = img.height;
  const N = 1024;
  const C = N / 2; // one twig per quadrant
  const out = new Uint8Array(N * N * 4);
  let r = (seed + 1) * 2654435761;
  const rnd = () => (r = (r * 1103515245 + 12345) >>> 0) / 4294967296;
  const rects = src.rects.length ? src.rects : [[0, 0, 1, 1]];
  // "over" for unpremultiplied colors
  const put = (x: number, y: number, cr: number, cg: number, cb: number, ca: number) => {
    if (x < 0 || y < 0 || x >= N || y >= N || ca <= 0) return;
    const o = (y * N + x) * 4;
    const da = out[o + 3]! / 255;
    const a = ca + da * (1 - ca);
    if (a <= 0) return;
    out[o] = (cr * ca + out[o]! * da * (1 - ca)) / a;
    out[o + 1] = (cg * ca + out[o + 1]! * da * (1 - ca)) / a;
    out[o + 2] = (cb * ca + out[o + 2]! * da * (1 - ca)) / a;
    out[o + 3] = a * 255;
  };
  /** Draw a piece with its base at (bx, by), pointing along angle `ang`, `len` px long */
  const leaf = (rect: number[], bx: number, by: number, ang: number, len: number) => {
    const [rx, ry, rw, rh] = rect as [number, number, number, number];
    const upright = rh >= rw;
    const pieceLen = upright ? rh : rw;
    const pieceW = upright ? rw : rh;
    const wid = (len * pieceW) / pieceLen;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const half = Math.ceil(Math.hypot(len, wid)) + 2;
    for (let y = -half; y <= half; y++) {
      for (let x = -half; x <= half; x++) {
        // Local: u along the leaf (0 base → 1 tip), w across (−0.5…0.5)
        const u = (x * ca + y * sa) / len;
        const w = (-x * sa + y * ca) / wid;
        if (u < 0 || u > 1 || w < -0.5 || w > 0.5) continue;
        const su = upright ? rx + (w + 0.5) * rw : rx + u * rw;
        const sv = upright ? ry + u * rh : ry + (w + 0.5) * rh;
        const sx = Math.min(SW - 1, Math.max(0, Math.floor(su * SW)));
        const sy = Math.min(SH - 1, Math.max(0, Math.floor(sv * SH)));
        const o = (sy * SW + sx) * 4;
        put(
          Math.round(bx + x),
          Math.round(by + y),
          img.data[o]!,
          img.data[o + 1]!,
          img.data[o + 2]!,
          img.data[o + 3]! / 255,
        );
      }
    }
  };
  for (let q = 0; q < 4; q++) {
    const ox = (q % 2) * C;
    const oy = Math.floor(q / 2) * C;
    // Stem from the bottom middle, bending a little
    const bend = (rnd() - 0.5) * 0.5;
    const stem = (t: number) =>
      [ox + C / 2 + Math.sin(t * 1.6) * bend * C * 0.25, oy + C * 0.04 + t * C * 0.7] as const;
    for (let t = 0; t <= 1; t += 0.004) {
      const [x, y] = stem(t);
      for (let d = -2; d <= 2; d++) put(Math.round(x + d), Math.round(y), 92, 74, 50, 1);
    }
    const count = 6 + Math.floor(rnd() * 3);
    for (let k = 0; k < count; k++) {
      const t = 0.18 + (0.72 * k) / (count - 1);
      const [x, y] = stem(t);
      const side = k % 2 ? 1 : -1;
      // Up and out from the stem, steeper and smaller toward the tip
      const ang = Math.PI / 2 + side * (0.95 - 0.55 * t + (rnd() - 0.5) * 0.3);
      const len = C * (0.32 - 0.1 * t) * (0.85 + rnd() * 0.3);
      leaf(rects[Math.floor(rnd() * rects.length)]!, x, y, ang, len);
    }
    // A leaf at the tip
    const [tx, ty] = stem(0.98);
    leaf(
      rects[Math.floor(rnd() * rects.length)]!,
      tx,
      ty,
      Math.PI / 2 + (rnd() - 0.5) * 0.3,
      C * 0.2,
    );
  }
  // Bleed leaf colors into the transparent pixels around them, so the
  // mipmaps don't fringe the leaves dark
  for (let pass = 0; pass < 6; pass++) {
    const prev = out.slice();
    for (let y = 1; y < N - 1; y++) {
      for (let x = 1; x < N - 1; x++) {
        const o = (y * N + x) * 4;
        if (prev[o + 3]! > 0 || (prev[o]! | prev[o + 1]! | prev[o + 2]!) > 0) continue;
        let cr = 0,
          cg = 0,
          cb = 0,
          n = 0;
        for (const d of [-4, 4, -N * 4, N * 4]) {
          const q = o + d;
          if (prev[q + 3]! > 0 || (prev[q]! | prev[q + 1]! | prev[q + 2]!) > 0) {
            cr += prev[q]!;
            cg += prev[q + 1]!;
            cb += prev[q + 2]!;
            n++;
          }
        }
        if (n) {
          out[o] = cr / n;
          out[o + 1] = cg / n;
          out[o + 2] = cb / n;
        }
      }
    }
  }
  const tex = new THREE.DataTexture(out, N, N, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return {
    a: tex,
    rects: [
      [0, 0, 0.5, 0.5],
      [0.5, 0, 0.5, 0.5],
      [0, 0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5, 0.5],
    ],
  };
}

function grow(preset: string, seed: number, rects: number[][]) {
  const tree = new Tree();
  tree.loadPreset(preset);
  tree.options.seed = seed;
  // A little fuller than the presets: our twigs are slimmer than theirs
  tree.options.leaves.count = Math.round(tree.options.leaves.count * 1.4);
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
