/**
 * The view's side of the asset pack (src/replay-assets.ts): files arrive
 * through the app-only `garmin-get-replay-asset` tool as bytes and are
 * decoded here without any URL fetch (a host's CSP may forbid even blob: or
 * data: URLs): images with createImageBitmap from a Blob, read back unchanged
 * through an offscreen WebGL 2 context (a 2D canvas premultiplies alpha,
 * which would wreck the height and AO packed into the alpha channels).
 *
 * Everything is optional: whatever fails to arrive leaves the generated
 * look in place.
 */
import * as THREE from "three/webgpu";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { assetEntry, type AssetEntry } from "../replay-assets.ts";

export type FetchAssetFile = (name: string) => Promise<Uint8Array>;

export interface SurfaceArrays {
  /** Color (sRGB) + height in alpha, one layer per surface */
  a: THREE.DataArrayTexture;
  /** Normal X/Y, roughness, AO */
  b: THREE.DataArrayTexture;
  /** Real-world meters per tile, per layer */
  tiles: number[];
  ids: string[];
}

export interface Sky {
  id: string;
  w: number;
  h: number;
  /** Linear RGB, rows top to bottom */
  data: Float32Array;
  meta: {
    sunU: number;
    sunV: number;
    skyLum: number;
    groundLum: number;
    skyColor: number[];
    cover?: number;
    sunUp?: boolean;
    low?: boolean;
    night?: boolean;
    urban?: boolean;
  };
}

let gl: WebGL2RenderingContext | null = null;

/** RGBA8 pixels of an image, unpremultiplied, bottom row first (as textures expect) */
async function decodePixels(bytes: Uint8Array, type: string, size?: number) {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type }), {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
    ...(size ? { resizeWidth: size, resizeHeight: size, resizeQuality: "high" as const } : {}),
  });
  const w = bitmap.width;
  const h = bitmap.height;
  if (!gl) {
    const canvas = new OffscreenCanvas(1, 1);
    gl = canvas.getContext("webgl2", { premultipliedAlpha: false, antialias: false });
    if (!gl) throw new Error("no WebGL 2 for decoding");
  }
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const out = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  gl.deleteTexture(tex);
  bitmap.close();
  return { w, h, data: out };
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function arrayTexture(data: Uint8Array, size: number, layers: number, srgb: boolean) {
  const t = new THREE.DataArrayTexture(data, size, size, layers);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  // Ground is mostly seen at a grazing angle
  t.anisotropy = 16;
  t.needsUpdate = true;
  return t;
}

/** Files already received, across scenes (a scene is rebuilt when the real map arrives) */
const files = new Map<string, Promise<Uint8Array>>();

export class AssetLibrary {
  /** Assets actually shown, for the credits line */
  readonly used = new Set<string>();
  private cache = new Map<string, Promise<unknown>>();

  constructor(private fetchFile: FetchAssetFile) {}

  entry(id: string): AssetEntry | undefined {
    return assetEntry(id);
  }

  private bytes(name: string): Promise<Uint8Array> {
    let p = files.get(name);
    if (!p) {
      p = this.fetchFile(name);
      p.catch(() => files.delete(name));
      files.set(name, p);
    }
    return p;
  }

  private once<T>(key: string, make: () => Promise<T>): Promise<T> {
    let p = this.cache.get(key) as Promise<T> | undefined;
    if (!p) {
      p = make();
      p.catch(() => this.cache.delete(key));
      this.cache.set(key, p);
    }
    return p;
  }

  /**
   * Surfaces as two texture arrays (layer i = ids[i]), all resized to `size`.
   * Null if any of them can't be loaded.
   */
  surfaces(ids: string[], size: number): Promise<SurfaceArrays | null> {
    return this.once(`surfaces:${ids.join(",")}:${size}`, async () => {
      try {
        const entries = ids.map((id) => {
          const e = assetEntry(id);
          if (!e || e.files.length < 2) throw new Error(`no surface ${id}`);
          return e;
        });
        const layer = size * size * 4;
        const a = new Uint8Array(layer * ids.length);
        const b = new Uint8Array(layer * ids.length);
        await Promise.all(
          entries.map(async (e, i) => {
            const [pa, pb] = await Promise.all(
              e.files
                .slice(0, 2)
                .map(async (f) => decodePixels(await this.bytes(f.name), "image/webp", size)),
            );
            a.set(pa!.data, i * layer);
            b.set(pb!.data, i * layer);
          }),
        );
        for (const id of ids) this.used.add(id);
        return {
          a: arrayTexture(a, size, ids.length, true),
          b: arrayTexture(b, size, ids.length, false),
          tiles: entries.map((e) => Number(e.meta.tile) || 2),
          ids,
        };
      } catch (e) {
        console.warn("[replay] surfaces unavailable", ids, e);
        return null;
      }
    });
  }

  /** One cut-out atlas: color+opacity and normal/roughness textures, plus its pieces */
  atlas(
    id: string,
  ): Promise<{ a: THREE.DataTexture; b: THREE.DataTexture; rects: number[][] } | null> {
    return this.once(`atlas:${id}`, async () => {
      try {
        const e = assetEntry(id);
        if (!e) throw new Error(`no atlas ${id}`);
        const [pa, pb] = await Promise.all(
          e.files
            .slice(0, 2)
            .map(async (f) => decodePixels(await this.bytes(f.name), "image/webp")),
        );
        const tex = (p: { w: number; h: number; data: Uint8Array }, srgb: boolean) => {
          const t = new THREE.DataTexture(p.data, p.w, p.h, THREE.RGBAFormat);
          t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          t.magFilter = THREE.LinearFilter;
          t.minFilter = THREE.LinearMipmapLinearFilter;
          t.generateMipmaps = true;
          t.anisotropy = 4;
          t.needsUpdate = true;
          return t;
        };
        this.used.add(id);
        // Pieces are measured top-down in the image; textures are bottom-up
        const rects = ((e.meta.rects as number[][]) ?? []).map(([x, y, w, h]) => [
          x!,
          1 - y! - h!,
          w!,
          h!,
        ]);
        return { a: tex(pa!, true), b: tex(pb!, false), rects };
      } catch (e) {
        console.warn("[replay] atlas unavailable", id, e);
        return null;
      }
    });
  }

  /** A sky photo (sun clipped), linear float RGB */
  sky(id: string): Promise<Sky | null> {
    return this.once(`sky:${id}`, async () => {
      try {
        const e = assetEntry(id);
        if (!e) throw new Error(`no sky ${id}`);
        const raw = await gunzip(await this.bytes(e.files[0]!.name));
        const dv = new DataView(raw.buffer, raw.byteOffset);
        const w = dv.getUint16(4, true);
        const h = dv.getUint16(6, true);
        const data = new Float32Array(w * h * 3);
        for (let i = 0; i < w * h; i++) {
          const o = 8 + i * 4;
          const ex = raw[o + 3]!;
          if (!ex) continue;
          const f = Math.pow(2, ex - 136);
          data[i * 3] = (raw[o]! + 0.5) * f;
          data[i * 3 + 1] = (raw[o + 1]! + 0.5) * f;
          data[i * 3 + 2] = (raw[o + 2]! + 0.5) * f;
        }
        this.used.add(id);
        return { id, w, h, data, meta: e.meta as Sky["meta"] };
      } catch (e) {
        console.warn("[replay] sky unavailable", id, e);
        return null;
      }
    });
  }

  /** A model's variants (top-level nodes "v0", "v1", …), with node materials */
  model(id: string): Promise<THREE.Object3D[] | null> {
    return this.once(`model:${id}`, async () => {
      try {
        const e = assetEntry(id);
        if (!e) throw new Error(`no model ${id}`);
        const gltf = await parseGlb(await this.bytes(e.files[0]!.name));
        const variants = gltf.scene.children.slice();
        for (const v of variants) toNodeMaterials(v);
        this.used.add(id);
        return variants;
      } catch (e) {
        console.warn("[replay] model unavailable", id, e);
        return null;
      }
    });
  }

  /** A JSON asset (motion) */
  json<T>(id: string): Promise<T | null> {
    return this.once(`json:${id}`, async () => {
      try {
        const e = assetEntry(id);
        if (!e) throw new Error(`no asset ${id}`);
        const value = JSON.parse(new TextDecoder().decode(await this.bytes(e.files[0]!.name))) as T;
        this.used.add(id);
        return value;
      } catch (e) {
        console.warn("[replay] asset unavailable", id, e);
        return null;
      }
    });
  }
}

/**
 * GLB bytes → glTF, with embedded images decoded by createImageBitmap from a
 * Blob: GLTFLoader's own path fetches blob: URLs, which a strict CSP blocks.
 */
export async function parseGlb(bytes: Uint8Array): Promise<GLTF> {
  const loader = new GLTFLoader();
  loader.register((parser) => {
    const p = parser as unknown as {
      json: { images: { bufferView?: number; mimeType?: string }[] };
      getDependency(type: string, index: number): Promise<ArrayBuffer>;
      loadImageSource(index: number): Promise<THREE.Texture>;
    };
    p.loadImageSource = async (index: number) => {
      const img = p.json.images[index]!;
      if (img.bufferView === undefined) throw new Error("external image");
      const view = await p.getDependency("bufferView", img.bufferView);
      const bitmap = await createImageBitmap(
        new Blob([view], { type: img.mimeType ?? "image/png" }),
        { premultiplyAlpha: "none", colorSpaceConversion: "none", imageOrientation: "from-image" },
      );
      const t = new THREE.Texture(bitmap as unknown as HTMLImageElement);
      t.flipY = false;
      t.needsUpdate = true;
      return t;
    };
    return { name: "run_coach_bitmap_images" };
  });
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return loader.parseAsync(buf as ArrayBuffer, "");
}

/** glTF's standard materials → node materials (WebGPU renderer), keeping maps */
export function toNodeMaterials(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const old = mesh.material as THREE.MeshStandardMaterial;
    const cut = !!old.alphaMap || old.transparent || old.alphaTest > 0;
    mesh.material = new THREE.MeshStandardNodeMaterial({
      name: old.name,
      map: old.map,
      normalMap: old.normalMap,
      roughnessMap: old.roughnessMap,
      metalnessMap: old.metalnessMap,
      aoMap: old.aoMap,
      color: old.color,
      roughness: old.roughness,
      metalness: old.metalness,
      alphaTest: cut ? 0.5 : 0,
      transparent: false,
      side: cut || old.side === THREE.DoubleSide ? THREE.DoubleSide : THREE.FrontSide,
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    old.dispose();
  });
}
