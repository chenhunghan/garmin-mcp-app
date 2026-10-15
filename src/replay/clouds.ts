/**
 * Cloud shadows: one tileable noise field (generated, no assets) laid over
 * the world, drifting with the wind. It dims only the sunlight — it wraps the
 * sun's shadow term of every material that receives shadows — so shade gets
 * deeper and lit ground darker while the sky's light stays.
 */
import * as THREE from "three/webgpu";
import { Fn, float, positionWorld, smoothstep, texture, uniform } from "three/tsl";
import type { Node } from "three/webgpu";

const SIZE = 256;
/** World meters per tile of the noise */
const SPAN = 1400;

function cloudTexture() {
  // Periodic value noise, four octaves (the field tiles seamlessly)
  const data = new Uint8Array(SIZE * SIZE * 4);
  const lattice = (period: number, seed: number) => {
    const g = new Float32Array(period * period);
    let s = seed;
    for (let i = 0; i < g.length; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      g[i] = s / 0x7fffffff;
    }
    return (x: number, y: number) => {
      const fx = (x / SIZE) * period;
      const fy = (y / SIZE) * period;
      const i = Math.floor(fx);
      const j = Math.floor(fy);
      const u = fx - i;
      const v = fy - j;
      const su = u * u * (3 - 2 * u);
      const sv = v * v * (3 - 2 * v);
      const at = (a: number, b: number) => g[((b % period) * period + (a % period)) % g.length]!;
      return (
        (at(i, j) * (1 - su) + at(i + 1, j) * su) * (1 - sv) +
        (at(i, j + 1) * (1 - su) + at(i + 1, j + 1) * su) * sv
      );
    };
  };
  const octaves = [lattice(4, 7), lattice(8, 11), lattice(16, 13), lattice(32, 17)];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let v = 0;
      let w = 0.5;
      for (const o of octaves) {
        v += o(x, y) * w;
        w *= 0.5;
      }
      const b = Math.round((v / 0.9375) * 255);
      data.set([b, b, b, 255], (y * SIZE + x) * 4);
    }
  }
  const tex = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

let tex: THREE.DataTexture | null = null;

/** Set by the scene: cover 0–1, drift (in tiles), and how dark a cloud's shadow is */
export const cloudLight = {
  cover: uniform(0.3),
  offset: uniform(new THREE.Vector2()),
  strength: uniform(0.6),
};

/** Sunlight left after the clouds at this point (1 = clear). */
export function cloudShade(): Node<"float"> {
  tex ??= cloudTexture();
  const uv = positionWorld.xz.div(SPAN).add(cloudLight.offset);
  const d = texture(tex, uv).r;
  // Cover c: the densest c share of the field is cloud, soft-edged
  const edge = float(1).sub(cloudLight.cover);
  const cloud = smoothstep(edge.sub(0.08), edge.add(0.08), d);
  return float(1).sub(cloud.mul(cloudLight.strength));
}

/** Wrap a material's sun shadow with the cloud shadows. */
export function withCloudShadows(mat: THREE.Material) {
  const m = mat as THREE.NodeMaterial;
  if (!m.isNodeMaterial || m.receivedShadowNode) return;
  // (called with the shadow node, as three's docs show; the typings omit the argument)
  m.receivedShadowNode = Fn(([shadow]: [Node<"float">]) =>
    shadow.mul(cloudShade()),
  ) as unknown as () => Node;
}

/** Advance the drift: clouds move with the wind, ~2× its speed, at least 3 m/s. */
export function driftClouds(windX: number, windZ: number, t: number) {
  const speed = Math.max(3, Math.hypot(windX, windZ) * 2);
  const l = Math.hypot(windX, windZ) || 1;
  cloudLight.offset.value.set(
    (-(windX / l) * speed * t) / SPAN + 0.37,
    (-(windZ / l) * speed * t) / SPAN + 0.61,
  );
}

/** The tileable noise itself (also the water's ripples) */
export function noiseTexture(): THREE.DataTexture {
  return (tex ??= cloudTexture());
}

export function disposeClouds() {
  tex?.dispose();
  tex = null;
}
