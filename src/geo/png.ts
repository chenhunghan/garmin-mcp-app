/**
 * Minimal PNG decoder (8-bit grayscale/RGB/RGBA, non-interlaced) on the
 * standard DecompressionStream (Node and Workers) — enough for elevation
 * tiles, without a dependency.
 */

export interface Png {
  width: number;
  height: number;
  /** Bytes per pixel */
  channels: number;
  data: Uint8Array;
}

export async function decodePng(buf: Uint8Array): Promise<Png> {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (sig.some((b, i) => buf[i] !== b)) throw new Error("Not a PNG");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  while (pos < buf.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(buf[pos + 4]!, buf[pos + 5]!, buf[pos + 6]!, buf[pos + 7]!);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      const depth = body[8]!;
      const color = body[9]!;
      const interlace = body[12]!;
      if (depth !== 8 || interlace !== 0) throw new Error("Unsupported PNG (depth/interlace)");
      channels = color === 0 ? 1 : color === 2 ? 3 : color === 4 ? 2 : color === 6 ? 4 : 0;
      if (!channels) throw new Error(`Unsupported PNG color type ${color}`);
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  const raw = await inflate(idat);
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x]!;
      const a = x >= channels ? out[dst + x - channels]! : 0;
      const b = y > 0 ? out[dst - stride + x]! : 0;
      const c = x >= channels && y > 0 ? out[dst - stride + x - channels]! : 0;
      let r: number;
      switch (filter) {
        case 0:
          r = v;
          break;
        case 1:
          r = v + a;
          break;
        case 2:
          r = v + b;
          break;
        case 3:
          r = v + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`Bad PNG filter ${filter}`);
      }
      out[dst + x] = r & 255;
    }
  }
  return { width, height, channels, data: out };
}

/** zlib-wrapped deflate data, split over IDAT chunks. */
async function inflate(chunks: Uint8Array[]): Promise<Uint8Array> {
  const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.length;
  }
  const stream = new Response(joined).body!.pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
