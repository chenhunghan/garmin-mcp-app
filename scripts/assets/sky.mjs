/**
 * Sky photos (equirectangular HDR) → small environment maps for the replay's
 * lighting. The scene has its own sun light at the run's real sun position,
 * so the photo's sun is clipped out: it lights the scene only with its sky,
 * clouds and surroundings. Output: gzipped "RGBE" + u16 width + u16 height +
 * RGBE pixels (rows top to bottom), 512×256.
 */
import { writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

/** Radiance .hdr (flat or new-style RLE) → { w, h, data: Float32Array RGB } */
export function readRgbe(buf) {
  let p = 0;
  const line = () => {
    let s = "";
    while (p < buf.length && buf[p] !== 0x0a) s += String.fromCharCode(buf[p++]);
    p++;
    return s;
  };
  let l;
  do l = line();
  while (l !== "" && p < buf.length);
  const dims = line().match(/-Y (\d+) \+X (\d+)/);
  if (!dims) throw new Error("unsupported HDR orientation");
  const h = Number(dims[1]);
  const w = Number(dims[2]);
  const data = new Float32Array(w * h * 3);
  const scan = new Uint8Array(w * 4);
  for (let y = 0; y < h; y++) {
    if (buf[p] === 2 && buf[p + 1] === 2 && ((buf[p + 2] << 8) | buf[p + 3]) === w) {
      p += 4;
      for (let c = 0; c < 4; c++) {
        let x = 0;
        while (x < w) {
          let n = buf[p++];
          if (n > 128) {
            n -= 128;
            const v = buf[p++];
            for (let i = 0; i < n; i++) scan[x++ * 4 + c] = v;
          } else {
            for (let i = 0; i < n; i++) scan[x++ * 4 + c] = buf[p++];
          }
        }
      }
    } else {
      for (let x = 0; x < w * 4; x++) scan[x] = buf[p++];
    }
    for (let x = 0; x < w; x++) {
      const e = scan[x * 4 + 3];
      const f = e ? Math.pow(2, e - 136) : 0;
      const o = (y * w + x) * 3;
      data[o] = scan[x * 4] * f;
      data[o + 1] = scan[x * 4 + 1] * f;
      data[o + 2] = scan[x * 4 + 2] * f;
    }
  }
  return { w, h, data };
}

const lum = (d, o) => 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];

export async function processSky(img, file, W = 512, H = 256) {
  // Box-downsample to W×H
  const fx = img.w / W;
  const fy = img.h / H;
  const out = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0,
        g = 0,
        b = 0,
        n = 0;
      for (let j = Math.floor(y * fy); j < Math.floor((y + 1) * fy); j++) {
        for (let i = Math.floor(x * fx); i < Math.floor((x + 1) * fx); i++) {
          const o = (j * img.w + i) * 3;
          r += img.data[o];
          g += img.data[o + 1];
          b += img.data[o + 2];
          n++;
        }
      }
      const o = (y * W + x) * 3;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
    }
  }
  // The sun: brightest pixel of the upper half
  let best = -1;
  let sunX = 0;
  let sunY = 0;
  const upper = [];
  for (let y = 0; y < H / 2; y++) {
    for (let x = 0; x < W; x++) {
      const l = lum(out, (y * W + x) * 3);
      upper.push(l);
      if (l > best) {
        best = l;
        sunX = x;
        sunY = y;
      }
    }
  }
  upper.sort((a, b) => a - b);
  const p98 = upper[Math.floor(upper.length * 0.98)];
  // Clip everything brighter than the bright sky (the sun and its glare)
  const cap = p98 * 1.6;
  let clipped = 0;
  for (let i = 0; i < W * H; i++) {
    const l = lum(out, i * 3);
    if (l > cap) {
      const k = cap / l;
      out[i * 3] *= k;
      out[i * 3 + 1] *= k;
      out[i * 3 + 2] *= k;
      clipped++;
    }
  }
  // Mean radiance of sky and ground (solid-angle weighted), for exposure
  let sky = 0,
    skyW = 0,
    ground = 0,
    groundW = 0;
  const skyRgb = [0, 0, 0];
  for (let y = 0; y < H; y++) {
    const wgt = Math.cos(((y + 0.5) / H - 0.5) * Math.PI);
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      const l = lum(out, o);
      if (y < H / 2) {
        sky += l * wgt;
        skyW += wgt;
        skyRgb[0] += out[o] * wgt;
        skyRgb[1] += out[o + 1] * wgt;
        skyRgb[2] += out[o + 2] * wgt;
      } else {
        ground += l * wgt;
        groundW += wgt;
      }
    }
  }
  // RGBE encode
  const px = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const r = out[i * 3],
      g = out[i * 3 + 1],
      b = out[i * 3 + 2];
    const m = Math.max(r, g, b);
    if (m < 1e-32) continue;
    const e = Math.ceil(Math.log2(m) + 1e-9);
    const f = 256 / Math.pow(2, e);
    px[i * 4] = Math.min(255, Math.floor(r * f));
    px[i * 4 + 1] = Math.min(255, Math.floor(g * f));
    px[i * 4 + 2] = Math.min(255, Math.floor(b * f));
    px[i * 4 + 3] = e + 128;
  }
  const head = Buffer.alloc(8);
  head.write("RGBE", 0, "ascii");
  head.writeUInt16LE(W, 4);
  head.writeUInt16LE(H, 6);
  await writeFile(file, gzipSync(Buffer.concat([head, Buffer.from(px)]), { level: 9 }));
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return {
    // Equirect position of the photo's sun (u: 0–1 around, v: 0 top – 1 bottom)
    sunU: r3((sunX + 0.5) / W),
    sunV: r3((sunY + 0.5) / H),
    sunClipped: clipped,
    skyLum: r3(sky / skyW),
    groundLum: r3(ground / groundW),
    skyColor: skyRgb.map((c) => r3(c / skyW / (sky / skyW || 1))),
  };
}
