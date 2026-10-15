/**
 * The run's path in scene space: GPS projected to meters around the start
 * (east = +x, north = −z, up = +y), smoothed, with elevation, cumulative
 * distance and heading per sample. Runs without GPS (treadmill, indoor) get
 * an illustrative loop of the same length, still with the real elevation.
 */
import type { ReplayData } from "../replay-model.ts";

export interface Track {
  n: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  /** Cumulative distance along the smoothed path, m (scene distance, not watch distance) */
  s: Float32Array;
  /** Heading: angle of travel direction, radians, atan2(dx, dz) */
  heading: Float32Array;
  /** Uphill grade (rise/run) */
  grade: Float32Array;
  minY: number;
  maxY: number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Latitude/longitude of the scene origin (for the sun) */
  origin: { lat: number; lon: number } | null;
  synthetic: boolean;
  /**
   * The path resampled along a Catmull-Rom spline every ~1.5 m: what the
   * ribbon, the terrain and the runner follow, so corners are round even when
   * samples are far apart (Garmin downsamples long runs).
   */
  dense: Dense;
  /** Position in `dense` of sample position i + f */
  denseIndex(i: number, f: number): number;
}

export interface Dense {
  n: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  s: Float32Array;
  heading: Float32Array;
  /** Sample position (i + f) of each dense point, for coloring by metric */
  sample: Float32Array;
}

const DENSE_STEP = 1.5;

function catmull(p0: number, p1: number, p2: number, p3: number, t: number) {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/** Cumulative distance and smoothed, unwrapped heading of a dense path (after it moves). */
export function measureDense(dense: Dense) {
  const m = dense.n;
  dense.s[0] = 0;
  for (let k = 1; k < m; k++) {
    dense.s[k] =
      dense.s[k - 1]! + Math.hypot(dense.x[k]! - dense.x[k - 1]!, dense.z[k]! - dense.z[k - 1]!);
  }
  // Heading over ±3 m, unwrapped
  let lo = 0;
  let hi = 0;
  for (let k = 0; k < m; k++) {
    while (lo < k && dense.s[lo]! < dense.s[k]! - 3) lo++;
    while (hi < m - 1 && dense.s[hi]! < dense.s[k]! + 3) hi++;
    const hx = dense.x[hi]! - dense.x[lo]!;
    const hz = dense.z[hi]! - dense.z[lo]!;
    let h = Math.hypot(hx, hz) > 0.3 ? Math.atan2(hx, hz) : k > 0 ? dense.heading[k - 1]! : 0;
    if (k > 0) {
      const prev = dense.heading[k - 1]!;
      while (h - prev > Math.PI) h -= 2 * Math.PI;
      while (h - prev < -Math.PI) h += 2 * Math.PI;
    }
    dense.heading[k] = h;
  }
}

function densify(n: number, x: Float32Array, y: Float32Array, z: Float32Array) {
  const segStart = new Float32Array(Math.max(1, n));
  const segCount = new Float32Array(Math.max(1, n));
  const dx: number[] = [];
  const dy: number[] = [];
  const dz: number[] = [];
  const ds: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const m = Math.max(1, Math.ceil(Math.hypot(x[i + 1]! - x[i]!, z[i + 1]! - z[i]!) / DENSE_STEP));
    segStart[i] = dx.length;
    segCount[i] = m;
    const a = Math.max(0, i - 1);
    const d = Math.min(n - 1, i + 2);
    for (let k = 0; k < m; k++) {
      const t = k / m;
      dx.push(catmull(x[a]!, x[i]!, x[i + 1]!, x[d]!, t));
      dz.push(catmull(z[a]!, z[i]!, z[i + 1]!, z[d]!, t));
      dy.push(y[i]! + (y[i + 1]! - y[i]!) * t);
      ds.push(i + t);
    }
  }
  if (n > 0) {
    segStart[n - 1] = dx.length;
    dx.push(x[n - 1]!);
    dy.push(y[n - 1]!);
    dz.push(z[n - 1]!);
    ds.push(n - 1);
  }
  const m = dx.length;
  const dense: Dense = {
    n: m,
    x: Float32Array.from(dx),
    y: Float32Array.from(dy),
    z: Float32Array.from(dz),
    s: new Float32Array(m),
    heading: new Float32Array(m),
    sample: Float32Array.from(ds),
  };
  measureDense(dense);
  const denseIndex = (i: number, f: number) =>
    n < 2 ? 0 : i >= n - 1 ? m - 1 : Math.min(m - 1, segStart[i]! + f * segCount[i]!);
  return { dense, denseIndex };
}

const M_PER_DEG = 111_320;

function fillGaps(v: (number | null)[]): number[] | null {
  const first = v.findIndex((x) => x !== null);
  if (first < 0) return null;
  const out = Array.from({ length: v.length }, () => 0);
  let lastI = -1;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (x === null || x === undefined) continue;
    if (lastI < 0) for (let k = 0; k < i; k++) out[k] = x;
    else
      for (let k = lastI + 1; k < i; k++) {
        const f = (k - lastI) / (i - lastI);
        out[k] = out[lastI]! + (x - out[lastI]!) * f;
      }
    out[i] = x;
    lastI = i;
  }
  for (let k = lastI + 1; k < v.length; k++) out[k] = out[lastI]!;
  return out;
}

/** Centered moving average over a window in meters of distance (not samples). */
function smoothByDistance(values: number[], d: ArrayLike<number>, radius: number): number[] {
  const n = values.length;
  const out = Array.from({ length: n }, () => 0);
  let lo = 0;
  let hi = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    while (hi < n && d[hi]! <= d[i]! + radius) sum += values[hi++]!;
    while (d[lo]! < d[i]! - radius) sum -= values[lo++]!;
    out[i] = sum / (hi - lo);
  }
  return out;
}

/** An illustrative loop with the run's length, for runs without GPS. */
function syntheticPath(d: number[]): { x: number[]; z: number[] } {
  const total = Math.max(d.at(-1) ?? 0, 200);
  // A rounded, gently irregular loop; a 400 m-ish run becomes a track oval
  const shape = (u: number) => {
    const a = u * Math.PI * 2;
    const r = 1 + 0.18 * Math.sin(2 * a + 0.7) + 0.07 * Math.sin(3 * a + 2.1);
    return [r * Math.cos(a) * 1.35, r * Math.sin(a)] as const;
  };
  const N = 720;
  let per = 0;
  let prev = shape(0);
  const cum = [0];
  for (let i = 1; i <= N; i++) {
    const p = shape(i / N);
    per += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    cum.push(per);
    prev = p;
  }
  // Long runs go around a bigger loop instead of many tiny laps
  const laps = Math.max(1, Math.round(total / 6000));
  const scale = total / laps / per;
  const x: number[] = [];
  const z: number[] = [];
  const [x0, z0] = shape(0);
  for (const dist of d) {
    const s = (((dist / scale) % per) + per) % per;
    let k = cum.findIndex((c) => c >= s);
    if (k <= 0) k = 1;
    const f = (s - cum[k - 1]!) / (cum[k]! - cum[k - 1]! || 1);
    const a = shape((k - 1 + f) / N);
    x.push((a[0] - x0) * scale);
    z.push((a[1] - z0) * scale);
  }
  return { x, z };
}

/**
 * `ground` (optional): real terrain height (m above sea level) at a scene
 * position. With it, the path follows the real ground; without it, the
 * watch's recorded elevation.
 */
export function buildTrack(data: ReplayData, ground?: (x: number, z: number) => number): Track {
  const { channels } = data;
  const n = data.n;
  const d = channels.d;
  let xs: number[];
  let zs: number[];
  let origin: Track["origin"] = null;
  const lat = data.hasGps && channels.lat ? fillGaps(channels.lat) : null;
  const lon = data.hasGps && channels.lon ? fillGaps(channels.lon) : null;
  if (lat && lon) {
    const lat0 = lat[0]!;
    const lon0 = lon[0]!;
    origin = { lat: lat0, lon: lon0 };
    const kx = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
    xs = lon.map((v) => (v - lon0) * kx);
    zs = lat.map((v) => -(v - lat0) * M_PER_DEG);
    // GPS jitter: a few meters of smoothing keeps corners, loses the zigzag
    xs = smoothByDistance(xs, d, 4);
    zs = smoothByDistance(zs, d, 4);
  } else {
    ({ x: xs, z: zs } = syntheticPath(d));
  }

  const elevRaw = ground
    ? Array.from({ length: n }, (_, i) => ground(xs[i]!, zs[i]!))
    : channels.elev
      ? fillGaps(channels.elev)
      : null;
  const elev = elevRaw ? smoothByDistance(elevRaw, d, 12) : Array.from({ length: n }, () => 0);
  let minY = Infinity;
  let maxY = -Infinity;
  for (const e of elev) {
    minY = Math.min(minY, e);
    maxY = Math.max(maxY, e);
  }
  if (!Number.isFinite(minY)) minY = maxY = 0;

  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const z = new Float32Array(n);
  const s = new Float32Array(n);
  const heading = new Float32Array(n);
  const grade = new Float32Array(n);
  const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (let i = 0; i < n; i++) {
    x[i] = xs[i]!;
    z[i] = zs[i]!;
    y[i] = elev[i]! - minY;
    if (i > 0) s[i] = s[i - 1]! + Math.hypot(x[i]! - x[i - 1]!, z[i]! - z[i - 1]!);
    bounds.minX = Math.min(bounds.minX, x[i]!);
    bounds.maxX = Math.max(bounds.maxX, x[i]!);
    bounds.minZ = Math.min(bounds.minZ, z[i]!);
    bounds.maxZ = Math.max(bounds.maxZ, z[i]!);
  }
  if (n === 0) Object.assign(bounds, { minX: -50, maxX: 50, minZ: -50, maxZ: 50 });

  // Heading and grade over ~10 m, so standing still or GPS noise doesn't spin the runner
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    while (lo < i && s[lo]! < s[i]! - 6) lo++;
    while (hi < n - 1 && s[hi]! < s[i]! + 6) hi++;
    const dx = x[hi]! - x[lo]!;
    const dz = z[hi]! - z[lo]!;
    const run = Math.hypot(dx, dz);
    heading[i] = run > 0.5 ? Math.atan2(dx, dz) : i > 0 ? heading[i - 1]! : 0;
    const dd = d[hi]! - d[lo]!;
    grade[i] = dd > 2 ? Math.max(-0.4, Math.min(0.4, (y[hi]! - y[lo]!) / dd)) : 0;
  }
  // Unwrap headings so interpolation never turns the long way round
  for (let i = 1; i < n; i++) {
    let delta = heading[i]! - heading[i - 1]!;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    heading[i] = heading[i - 1]! + delta;
  }

  return {
    n,
    x,
    y,
    z,
    s,
    heading,
    grade,
    minY,
    maxY,
    bounds,
    origin,
    synthetic: !(lat && lon),
    ...densify(n, x, y, z),
  };
}
