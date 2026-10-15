/**
 * Image-based light from sky photos (asset pack, sun clipped out): for the
 * run's real sun elevation and Garmin's weather, the two nearest photos (clear
 * noon, broken clouds, overcast, golden hour, dusk, city or open night) are
 * blended, turned so their bright side faces the real sun, and white-balanced
 * part of the way toward the generated sky's own colors, so shade isn't
 * tinted blue and the lighting agrees with the sky the viewer sees. The
 * scene's directional light stays the sun; the photo brings the sky's light,
 * the clouds and the bounce off the surroundings.
 */
import * as THREE from "three/webgpu";
import type { Sky } from "./assets.ts";
import { smoothstepJs } from "./terrain.ts";

export const SKY_IDS = [
  "sky.clear",
  "sky.cloudy",
  "sky.overcast",
  "sky.golden",
  "sky.dusk",
  "sky.night",
  "sky.night-open",
] as const;
type SkyId = (typeof SKY_IDS)[number];

/** Weights of the sky photos for a sun elevation (°), cloud cover 0–1, and whether it's a city */
export function skyWeights(elevation: number, cloud: number, urban: boolean): Map<SkyId, number> {
  const w = new Map<SkyId, number>();
  const add = (id: SkyId, v: number) => v > 0.001 && w.set(id, (w.get(id) ?? 0) + v);
  // Day: clear → broken clouds → overcast, by cover
  const c1 = smoothstepJs(0.25, 0.55, cloud);
  const c2 = smoothstepJs(0.6, 0.85, cloud);
  const day = smoothstepJs(4, 14, elevation);
  add("sky.clear", day * (1 - c1));
  add("sky.cloudy", day * c1 * (1 - c2));
  add("sky.overcast", day * c2);
  // Low sun (dawn, dusk): golden when clear, a cloudy dusk otherwise
  const night = 1 - smoothstepJs(-9, -3, elevation);
  const low = (1 - day) * (1 - night);
  add("sky.golden", low * (1 - c1));
  add("sky.dusk", low * c1);
  add(urban ? "sky.night" : "sky.night-open", night);
  // At most the two strongest, renormalized (each blend costs a full pass)
  const top = [...w.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
  const sum = top.reduce((s, [, v]) => s + v, 0) || 1;
  return new Map(top.map(([id, v]) => [id, v / sum]));
}

const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export class SkyLight {
  private texture: THREE.DataTexture | null = null;

  constructor(private skies: Map<string, Sky>) {}

  /**
   * The blended environment as an equirectangular float texture (rows
   * bottom-up, as three expects), with its mean sky luminance scaled to
   * `target` and its sky tinted toward `tint` (linear RGB, any scale).
   * Returns the texture and the rotation about +y that puts the photos'
   * bright side under the real sun (azimuth of the sun in scene space).
   */
  build(
    weights: Map<string, number>,
    sunDir: THREE.Vector3,
    target: number,
    tint: THREE.Color,
    /** The ground's light (linear RGB): replaces most of the photos' own ground, e.g. a field's green under a city */
    ground: THREE.Color,
  ): { texture: THREE.DataTexture; rotationY: number } | null {
    const parts = [...weights.entries()]
      .map(([id, k]) => ({ sky: this.skies.get(id), k }))
      .filter((p): p is { sky: Sky; k: number } => !!p.sky);
    if (!parts.length) return null;
    const { w, h } = parts[0]!.sky;
    if (parts.some((p) => p.sky.w !== w || p.sky.h !== h)) return null;
    // The scene's sun azimuth in three's equirect convention: atan2(z, x)
    const sunPhi = Math.atan2(sunDir.z, sunDir.x);
    const data = new Float32Array(w * h * 4);
    const tl = lum(tint.r, tint.g, tint.b) || 1;
    for (const { sky, k } of parts) {
      // Exposure: this photo's mean sky luminance → the target
      const gain = (k * target) / Math.max(1e-4, sky.meta.skyLum);
      // White balance: 60% of the way from the photo's sky color to the tint
      const sc = sky.meta.skyColor;
      const wb = [0, 1, 2].map((ch) => {
        const want = [tint.r, tint.g, tint.b][ch]! / tl;
        return Math.pow(want / Math.max(0.05, sc[ch] ?? 1), 0.6);
      });
      // Turn the photo so its sun lands on the scene's sun: its column u
      // has azimuth (u − 0.5)·2π; shift columns by the difference
      const photoPhi = (sky.meta.sunU - 0.5) * Math.PI * 2;
      const shift = Math.round(((photoPhi - sunPhi) / (Math.PI * 2)) * w);
      for (let y = 0; y < h; y++) {
        const src = y * w;
        const dst = (h - 1 - y) * w; // bottom-up
        for (let x = 0; x < w; x++) {
          const sx = (((x + shift) % w) + w) % w;
          const i = (src + sx) * 3;
          const o = (dst + x) * 4;
          data[o] += sky.data[i]! * gain * wb[0]!;
          data[o + 1] += sky.data[i + 1]! * gain * wb[1]!;
          data[o + 2] += sky.data[i + 2]! * gain * wb[2]!;
          data[o + 3] = 1;
        }
      }
    }
    // Below the horizon: mostly the given ground, keeping a little of the
    // photos' own (and their pattern of light and shade), fading in over a
    // few degrees under the horizon
    const groundRef = parts.reduce(
      (acc, { sky, k }) =>
        acc + (k * target * sky.meta.groundLum) / Math.max(1e-4, sky.meta.skyLum),
      0,
    );
    for (let y = 0; y < h / 2; y++) {
      const k = Math.min(1, ((h / 2 - y) / (h / 2)) * 8) * 0.8;
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const l = lum(data[o]!, data[o + 1]!, data[o + 2]!);
        const shade = Math.min(1.6, Math.max(0.4, l / Math.max(1e-4, groundRef)));
        data[o] = data[o]! * (1 - k) + ground.r * shade * k;
        data[o + 1] = data[o + 1]! * (1 - k) + ground.g * shade * k;
        data[o + 2] = data[o + 2]! * (1 - k) + ground.b * shade * k;
      }
    }
    if (!this.texture || this.texture.image.width !== w) {
      this.texture?.dispose();
      this.texture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
      this.texture.mapping = THREE.EquirectangularReflectionMapping;
      this.texture.colorSpace = THREE.LinearSRGBColorSpace;
      this.texture.magFilter = THREE.LinearFilter;
      this.texture.minFilter = THREE.LinearFilter;
      this.texture.generateMipmaps = false;
    } else {
      (this.texture.image.data as Float32Array).set(data);
    }
    this.texture.needsUpdate = true;
    return { texture: this.texture, rotationY: 0 };
  }

  dispose() {
    this.texture?.dispose();
  }
}
