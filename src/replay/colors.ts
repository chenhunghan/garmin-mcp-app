/**
 * Metric → color scales, shared by the 3D route and the HUD timeline.
 * HR uses Garmin's zone colors (grey, blue, green, orange, red); continuous
 * metrics a blue → red ramp between the run's 5th and 95th percentile; grade
 * a diverging blue (downhill) / red (uphill) scale.
 */
import { hrZone, type ReplayData, type Series } from "../replay-model.ts";

export type ColorBy = "hr" | "pace" | "grade" | "cadence" | "power" | "elevation";

export const COLOR_BY_LABEL: Record<ColorBy, string> = {
  hr: "Heart rate zone",
  pace: "Pace",
  grade: "Grade",
  cadence: "Cadence",
  power: "Power",
  elevation: "Elevation",
};

export const ZONE_COLORS = ["#9aa3ad", "#a3adb8", "#3d8bfd", "#34c759", "#ff9f0a", "#ff3b30"];
const RAMP = ["#3b4cc0", "#2fb3c4", "#8fd14f", "#f9c440", "#e8453c"];

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
const RAMP_RGB = RAMP.map(hexToRgb);
const ZONE_RGB = ZONE_COLORS.map(hexToRgb);

function ramp(u: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, u)) * (RAMP_RGB.length - 1);
  const i = Math.min(RAMP_RGB.length - 2, Math.floor(x));
  const f = x - i;
  const a = RAMP_RGB[i]!;
  const b = RAMP_RGB[i + 1]!;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

function diverging(u: number): [number, number, number] {
  // u in [-1, 1]: blue → near-white → red
  const neutral: [number, number, number] = [0.92, 0.92, 0.9];
  const end: [number, number, number] = u < 0 ? [0.23, 0.49, 0.85] : [0.85, 0.27, 0.23];
  const f = Math.min(1, Math.abs(u));
  return [
    neutral[0] + (end[0] - neutral[0]) * f,
    neutral[1] + (end[1] - neutral[1]) * f,
    neutral[2] + (end[2] - neutral[2]) * f,
  ];
}

function percentiles(v: Series | ArrayLike<number> | undefined, lo = 0.05, hi = 0.95) {
  if (!v) return null;
  const xs: number[] = [];
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (x !== null && x !== undefined && Number.isFinite(x)) xs.push(x);
  }
  if (xs.length < 2) return null;
  xs.sort((a, b) => a - b);
  const a = xs[Math.floor(lo * (xs.length - 1))]!;
  const b = xs[Math.floor(hi * (xs.length - 1))]!;
  return b > a ? { a, b } : { a: a - 1, b: b + 1 };
}

/** Which color modes this run has data for. */
export function colorModes(data: ReplayData): ColorBy[] {
  const c = data.channels;
  const modes: ColorBy[] = [];
  if (c.hr) modes.push("hr");
  if (c.speed) modes.push("pace");
  if (c.elev) modes.push("grade", "elevation");
  if (c.cad) modes.push("cadence");
  if (c.power) modes.push("power");
  return modes;
}

/** RGB (0–1, sRGB) per sample for a color mode. */
export function sampleColors(
  data: ReplayData,
  mode: ColorBy,
  grade: ArrayLike<number>,
  elevation: ArrayLike<number>,
): Float32Array {
  const n = data.n;
  const out = new Float32Array(n * 3);
  const c = data.channels;
  const put = (i: number, rgb: [number, number, number]) => {
    out[i * 3] = rgb[0];
    out[i * 3 + 1] = rgb[1];
    out[i * 3 + 2] = rgb[2];
  };
  if (mode === "hr") {
    for (let i = 0; i < n; i++) {
      const hr = c.hr?.[i] ?? null;
      const zones = data.hrZones ?? defaultZones(data);
      put(i, ZONE_RGB[hrZone(hr, zones)]!);
    }
    return out;
  }
  if (mode === "grade") {
    for (let i = 0; i < n; i++) put(i, diverging((grade[i] ?? 0) / 0.1));
    return out;
  }
  const series: Series | ArrayLike<number> | undefined =
    mode === "pace" ? c.speed : mode === "cadence" ? c.cad : mode === "power" ? c.power : elevation;
  const range = percentiles(series);
  for (let i = 0; i < n; i++) {
    const v = series?.[i] ?? null;
    put(i, v === null || !range ? [0.6, 0.6, 0.6] : ramp((v - range.a) / (range.b - range.a)));
  }
  return out;
}

/** Zone floors when Garmin's aren't available: % of the run's max HR. */
export function defaultZones(data: ReplayData): number[] | null {
  const max = data.activity.maxHr ?? percentiles(data.channels.hr, 0, 1)?.b ?? null;
  if (!max) return null;
  return [0.5, 0.6, 0.7, 0.8, 0.9].map((f) => Math.round(max * f));
}

/** CSS color for a value (HUD). */
export function cssColor(rgb: ArrayLike<number>, i: number): string {
  const r = Math.round(rgb[i * 3]! * 255);
  const g = Math.round(rgb[i * 3 + 1]! * 255);
  const b = Math.round(rgb[i * 3 + 2]! * 255);
  return `rgb(${r} ${g} ${b})`;
}
