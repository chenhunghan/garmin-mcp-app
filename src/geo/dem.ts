/**
 * Real elevation from AWS Terrain Tiles (Terrarium encoding: height =
 * R·256 + G + B/256 − 32768 m), resampled onto regular grids in the replay's
 * local meters. Sources: USGS 3DEP/NED, SRTM, GMTED, ETOPO1 and others.
 */
import { cachedFetch } from "./fetch.js";
import { decodePng } from "./png.js";
import type { HeightGrid } from "./types.js";

const TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
const M_PER_DEG = 111_320;

export interface Projection {
  lat0: number;
  lon0: number;
  kx: number;
}

export function projection(lat0: number, lon0: number): Projection {
  return { lat0, lon0, kx: M_PER_DEG * Math.cos((lat0 * Math.PI) / 180) };
}

export const toLocal = (p: Projection, lat: number, lon: number) => ({
  x: (lon - p.lon0) * p.kx,
  z: -(lat - p.lat0) * M_PER_DEG,
});

export const toLatLon = (p: Projection, x: number, z: number) => ({
  lat: p.lat0 - z / M_PER_DEG,
  lon: p.lon0 + x / p.kx,
});

/** Global pixel coordinates (256 px tiles, Web Mercator) at zoom z. */
export function lonLatToPixel(lat: number, lon: number, z: number) {
  const n = 256 * 2 ** z;
  const rad = (lat * Math.PI) / 180;
  return {
    px: ((lon + 180) / 360) * n,
    py: ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
  };
}

export function terrariumHeight(r: number, g: number, b: number) {
  return r * 256 + g + b / 256 - 32768;
}

/** Elevation sampler over the tiles covering a lat/lon box at zoom z. */
async function sampler(south: number, west: number, north: number, east: number, z: number) {
  const a = lonLatToPixel(north, west, z);
  const b = lonLatToPixel(south, east, z);
  const tx0 = Math.floor(a.px / 256);
  const ty0 = Math.floor(a.py / 256);
  const tx1 = Math.floor(b.px / 256);
  const ty1 = Math.floor(b.py / 256);
  const tiles = new Map<string, Float32Array>();
  const jobs: Promise<void>[] = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      jobs.push(
        cachedFetch(`${TILE_URL}/${z}/${tx}/${ty}.png`).then((buf) => {
          const png = decodePng(buf);
          const h = new Float32Array(256 * 256);
          for (let i = 0; i < 256 * 256; i++) {
            const o = i * png.channels;
            h[i] = terrariumHeight(png.data[o]!, png.data[o + 1]!, png.data[o + 2]!);
          }
          tiles.set(`${tx}/${ty}`, h);
        }),
      );
    }
  }
  await Promise.all(jobs);
  const px = (gx: number, gy: number) => {
    const tx = Math.floor(gx / 256);
    const ty = Math.floor(gy / 256);
    const t = tiles.get(`${tx}/${ty}`);
    if (!t) return NaN;
    return t[(gy - ty * 256) * 256 + (gx - tx * 256)]!;
  };
  return (lat: number, lon: number) => {
    const p = lonLatToPixel(lat, lon, z);
    const x = p.px - 0.5;
    const y = p.py - 0.5;
    const i = Math.floor(x);
    const j = Math.floor(y);
    const u = x - i;
    const v = y - j;
    return (
      (px(i, j) * (1 - u) + px(i + 1, j) * u) * (1 - v) +
      (px(i, j + 1) * (1 - u) + px(i + 1, j + 1) * u) * v
    );
  };
}

function tileCount(south: number, west: number, north: number, east: number, z: number) {
  const a = lonLatToPixel(north, west, z);
  const b = lonLatToPixel(south, east, z);
  return (
    (Math.floor(b.px / 256) - Math.floor(a.px / 256) + 1) *
    (Math.floor(b.py / 256) - Math.floor(a.py / 256) + 1)
  );
}

/**
 * A height grid over a square of local meters, from the most detailed zoom
 * whose tile count stays within `maxTiles`.
 */
export async function heightGrid(
  proj: Projection,
  box: { minX: number; maxX: number; minZ: number; maxZ: number },
  opts: { maxZoom: number; maxTiles: number; maxCells: number },
): Promise<HeightGrid> {
  const nw = toLatLon(proj, box.minX, box.minZ);
  const se = toLatLon(proj, box.maxX, box.maxZ);
  let z = opts.maxZoom;
  while (z > 1 && tileCount(se.lat, nw.lon, nw.lat, se.lon, z) > opts.maxTiles) z--;
  const elev = await sampler(se.lat, nw.lon, nw.lat, se.lon, z);
  // Native resolution at this zoom, or coarser to stay within maxCells per side
  const native = (156_543 * Math.cos((proj.lat0 * Math.PI) / 180)) / 2 ** z;
  const extent = Math.max(box.maxX - box.minX, box.maxZ - box.minZ);
  const step = Math.max(native, extent / opts.maxCells);
  const nx = Math.floor((box.maxX - box.minX) / step) + 1;
  const nz = Math.floor((box.maxZ - box.minZ) / step) + 1;
  const h = new Float32Array(nx * nz);
  let min = Infinity;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const ll = toLatLon(proj, box.minX + i * step, box.minZ + j * step);
      let v = elev(ll.lat, ll.lon);
      // Terrarium marks some ocean as deep negative; below sea level near land is rare
      if (!Number.isFinite(v)) v = 0;
      h[j * nx + i] = v;
      if (v < min) min = v;
    }
  }
  const base = Math.floor(min);
  const bytes = new Uint8Array(nx * nz * 2);
  for (let k = 0; k < h.length; k++) {
    const q = Math.max(-32768, Math.min(32767, Math.round((h[k]! - base) * 10)));
    bytes[k * 2] = q & 255;
    bytes[k * 2 + 1] = (q >> 8) & 255;
  }
  return {
    x0: box.minX,
    z0: box.minZ,
    step,
    nx,
    nz,
    base,
    data: Buffer.from(bytes).toString("base64"),
  };
}
