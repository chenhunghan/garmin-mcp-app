/**
 * Run replay data: Garmin's activity time series (chart details), laps,
 * weather and HR zones turned into one compact, columnar model the 3D view
 * plays back. Pure functions, shared by the server (builds it) and the view
 * (interpolates it), unit-tested in tests/replay-model.test.ts.
 */

/** Per-sample channels the replay knows about (any may be missing). */
export const CHANNELS = [
  "t", // seconds since the start (wall clock, pauses included)
  "d", // meters
  "lat",
  "lon",
  "elev", // m
  "hr", // bpm
  "cad", // steps per minute (both feet)
  "speed", // m/s
  "gap", // grade-adjusted speed, m/s
  "power", // W
  "temp", // °C (watch sensor)
  "vspeed", // vertical speed, m/s
  "stride", // stride length, m
  "vo", // vertical oscillation, cm
  "gct", // ground contact time, ms
  "vr", // vertical ratio, %
  "perf", // performance condition
  "resp", // breaths per minute
  "stamina", // available stamina, %
] as const;

export type Channel = (typeof CHANNELS)[number];
export type Series = (number | null)[];

export interface ReplayLap {
  index: number;
  startT: number;
  endT: number;
  startD: number;
  endD: number;
  avgSpeed: number | null;
  avgHr: number | null;
  intensity: string | null;
}

export interface ReplayWeather {
  tempC: number | null;
  feelsC: number | null;
  humidity: number | null;
  windKph: number | null;
  /** Direction the wind blows FROM, degrees clockwise from north */
  windFromDeg: number | null;
  description: string | null;
  condition: "clear" | "cloudy" | "rain" | "snow" | "fog" | "storm" | null;
}

export interface ReplayActivity {
  id: string;
  name: string | null;
  type: string | null;
  startLocal: string | null;
  /** Epoch ms of the first sample (GMT) */
  startMs: number | null;
  /** Local time minus GMT, minutes (from the activity's start times) */
  utcOffsetMin: number | null;
  distance: number | null;
  duration: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgSpeed: number | null;
  avgCadence: number | null;
  avgPower: number | null;
  elevationGain: number | null;
  elevationLoss: number | null;
  calories: number | null;
  aerobicTE: number | null;
  anaerobicTE: number | null;
  trainingLoad: number | null;
  locationName: string | null;
}

export interface ReplayData {
  activity: ReplayActivity;
  weather: ReplayWeather | null;
  /** HR zone floors, zone 1 → 5 (bpm) */
  hrZones: number[] | null;
  laps: ReplayLap[];
  /** The track has real GPS positions (not a treadmill/indoor run) */
  hasGps: boolean;
  /** Sample count */
  n: number;
  /** Columnar samples; `t` and `d` are always present and complete */
  channels: Partial<Record<Channel, Series>> & { t: number[]; d: number[] };
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Garmin metric key → [channel, scale to the channel's unit by unit key]. */
const KEY_MAP: Record<string, Channel> = {
  sumElapsedDuration: "t",
  sumDistance: "d",
  directLatitude: "lat",
  directLongitude: "lon",
  directElevation: "elev",
  directHeartRate: "hr",
  directDoubleCadence: "cad",
  directSpeed: "speed",
  directGradeAdjustedSpeed: "gap",
  directPower: "power",
  directAirTemperature: "temp",
  directVerticalSpeed: "vspeed",
  directStrideLength: "stride",
  directVerticalOscillation: "vo",
  directGroundContactTime: "gct",
  directVerticalRatio: "vr",
  directPerformanceCondition: "perf",
  directRespirationRate: "resp",
  directAvailableStamina: "stamina",
};

/** Convert a value to the channel's unit, from Garmin's unit key. */
function toChannelUnit(channel: Channel, unit: string | null, v: number): number {
  const u = unit?.toLowerCase() ?? "";
  switch (channel) {
    case "stride":
      // Stride length: m (some firmware reports cm or mm)
      if (u.startsWith("centi")) return v / 100;
      if (u.startsWith("milli")) return v / 1000;
      return v > 10 ? v / 100 : v;
    case "vo":
      // Vertical oscillation: cm
      if (u.startsWith("milli")) return v / 10;
      if (u === "meter") return v * 100;
      return v;
    case "temp":
      return u.startsWith("fahr") ? ((v - 32) * 5) / 9 : v;
    default:
      return v;
  }
}

const ROUND: Partial<Record<Channel, number>> = {
  t: 1,
  d: 1,
  lat: 6,
  lon: 6,
  elev: 1,
  hr: 0,
  cad: 0,
  speed: 3,
  gap: 3,
  power: 0,
  temp: 1,
  vspeed: 2,
  stride: 2,
  vo: 1,
  gct: 0,
  vr: 1,
  perf: 0,
  resp: 0,
  stamina: 0,
};

function round(v: number, places: number) {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

/**
 * Parse `/activity-service/activity/{id}/details` into columnar channels,
 * sorted by time, with `t` and `d` filled in.
 */
export function parseChartDetails(raw: unknown): {
  channels: ReplayData["channels"];
  n: number;
  firstTimestamp: number | null;
} {
  const body = obj(raw);
  const descriptors = Array.isArray(body?.metricDescriptors) ? body.metricDescriptors : [];
  const rows = Array.isArray(body?.activityDetailMetrics) ? body.activityDetailMetrics : [];

  let tsIdx = -1;
  let timerIdx = -1;
  let runCadIdx = -1;
  const cols: { idx: number; channel: Channel; unit: string | null }[] = [];
  for (const d of descriptors) {
    const desc = obj(d);
    const key = str(desc?.key);
    const idx = num(desc?.metricsIndex);
    if (!key || idx === null) continue;
    if (key === "directTimestamp") tsIdx = idx;
    else if (key === "sumDuration") timerIdx = idx;
    else if (key === "directRunCadence") runCadIdx = idx;
    const channel = KEY_MAP[key];
    if (channel) cols.push({ idx, channel, unit: str(obj(desc?.unit)?.key) });
  }
  const hasCad = cols.some((c) => c.channel === "cad");

  type Row = {
    t: number | null;
    values: Partial<Record<Channel, number | null>>;
    ts: number | null;
  };
  const parsed: Row[] = [];
  for (const r of rows) {
    const m = obj(r)?.metrics;
    if (!Array.isArray(m)) continue;
    const values: Partial<Record<Channel, number | null>> = {};
    for (const c of cols) {
      const v = num(m[c.idx]);
      values[c.channel] = v === null ? null : toChannelUnit(c.channel, c.unit, v);
    }
    if (!hasCad && runCadIdx >= 0) {
      const v = num(m[runCadIdx]);
      values.cad = v === null ? null : v * 2;
    }
    const ts = tsIdx >= 0 ? num(m[tsIdx]) : null;
    const t = values.t ?? (timerIdx >= 0 ? num(m[timerIdx]) : null);
    parsed.push({ t, values, ts });
  }

  // Wall-clock time from the timestamps when present (pauses included), else
  // elapsed duration, else the timer
  let firstTimestamp: number | null = null;
  for (const p of parsed) {
    if (p.ts !== null && (firstTimestamp === null || p.ts < firstTimestamp)) firstTimestamp = p.ts;
  }
  for (const p of parsed) {
    if (firstTimestamp !== null && p.ts !== null) p.t = (p.ts - firstTimestamp) / 1000;
  }
  const valid = parsed.filter((p) => p.t !== null).sort((a, b) => a.t! - b.t!);
  // Duplicate timestamps (auto-lap marks) would break interpolation
  const rowsOut: Row[] = [];
  for (const p of valid) {
    if (rowsOut.length && p.t! <= rowsOut.at(-1)!.t!) continue;
    rowsOut.push(p);
  }

  const n = rowsOut.length;
  const channels = { t: [], d: [] } as unknown as ReplayData["channels"];
  const present = new Set<Channel>(cols.map((c) => c.channel));
  if (!hasCad && runCadIdx >= 0) present.add("cad");
  for (const ch of present) {
    if (ch === "t" || ch === "d") continue;
    const series = rowsOut.map((p) => {
      const v = p.values[ch];
      return v === null || v === undefined ? null : round(v, ROUND[ch] ?? 2);
    });
    if (series.some((v) => v !== null)) channels[ch] = series;
  }
  channels.t = rowsOut.map((p) => round(p.t!, 1));

  // Distance: forward-filled, monotonic; integrated from speed when missing
  let last = 0;
  channels.d = rowsOut.map((p, i) => {
    let v = p.values.d ?? null;
    if (v === null) {
      const s = p.values.speed ?? null;
      v = i > 0 && s !== null ? last + s * (channels.t[i]! - channels.t[i - 1]!) : last;
    }
    last = Math.max(last, v);
    return round(last, 1);
  });

  // Speed from distance when the watch didn't record it
  if (!channels.speed && n > 1) {
    channels.speed = channels.d.map((_, i) => {
      const a = Math.max(0, i - 2);
      const b = Math.min(n - 1, i + 2);
      const dt = channels.t[b]! - channels.t[a]!;
      return dt > 0 ? round((channels.d[b]! - channels.d[a]!) / dt, 3) : null;
    });
  }

  // GPS positions of (0, 0) are sanitized/absent fixes
  if (channels.lat && channels.lon) {
    for (let i = 0; i < n; i++) {
      if (channels.lat[i] === 0 && channels.lon[i] === 0) {
        channels.lat[i] = null;
        channels.lon[i] = null;
      }
    }
  }
  return { channels, n, firstTimestamp };
}

/** True when the track has enough real GPS fixes spread over the run. */
export function hasGpsTrack(channels: ReplayData["channels"]): boolean {
  const { lat, lon } = channels;
  if (!lat || !lon) return false;
  let count = 0;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (let i = 0; i < lat.length; i++) {
    const a = lat[i];
    const b = lon[i];
    if (a === null || a === undefined || b === null || b === undefined) continue;
    count++;
    minLat = Math.min(minLat, a);
    maxLat = Math.max(maxLat, a);
    minLon = Math.min(minLon, b);
    maxLon = Math.max(maxLon, b);
  }
  if (count < 10) return false;
  const spanM = Math.hypot(
    (maxLat - minLat) * 111_320,
    (maxLon - minLon) * 111_320 * Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180),
  );
  return spanM > 20;
}

/** Garmin weather (°F, mph) → metric, plus a coarse condition for the scene. */
export function parseWeather(raw: unknown): ReplayWeather | null {
  const w = obj(raw);
  if (!w) return null;
  const f2c = (f: number | null) => (f === null ? null : round(((f - 32) * 5) / 9, 1));
  const description = str(obj(w.weatherTypeDTO)?.desc);
  const tempC = f2c(num(w.temp));
  if (tempC === null && !description) return null;
  const mph = num(w.windSpeed);
  return {
    tempC,
    feelsC: f2c(num(w.apparentTemp)),
    humidity: num(w.relativeHumidity),
    windKph: mph === null ? null : round(mph * 1.609, 1),
    windFromDeg: num(w.windDirection),
    description: description && description !== "Unknown" ? description : null,
    condition: weatherCondition(description),
  };
}

export function weatherCondition(desc: string | null): ReplayWeather["condition"] {
  if (!desc) return null;
  const s = desc.toLowerCase();
  if (/thunder|storm/.test(s)) return "storm";
  if (/snow|sleet|flurr|ice/.test(s)) return "snow";
  if (/rain|shower|drizzle/.test(s)) return "rain";
  if (/fog|mist|haze/.test(s)) return "fog";
  if (/cloud|overcast/.test(s)) return "cloudy";
  if (/clear|sun|fair/.test(s)) return "clear";
  return null;
}

/** HR zone floors from `/activity/{id}/hrTimeInZones`. */
export function parseHrZones(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const floors = raw
    .map((z) => ({ n: num(obj(z)?.zoneNumber), low: num(obj(z)?.zoneLowBoundary) }))
    .filter((z): z is { n: number; low: number } => z.n !== null && z.low !== null)
    .sort((a, b) => a.n - b.n)
    .map((z) => z.low);
  return floors.length >= 5 ? floors.slice(0, 5) : null;
}

/** Laps (or computed km splits) mapped onto the replay's time axis by distance. */
export function parseLaps(raw: unknown, channels: ReplayData["channels"]): ReplayLap[] {
  const body = obj(raw);
  const list = Array.isArray(body?.lapDTOs) ? body.lapDTOs : [];
  const laps: ReplayLap[] = [];
  const total = channels.d.at(-1) ?? 0;
  let startD = 0;
  for (const [i, l] of list.entries()) {
    const lap = obj(l);
    const dist = num(lap?.distance);
    if (dist === null) continue;
    const endD = Math.min(total, startD + dist);
    laps.push({
      index: i + 1,
      startD: round(startD, 1),
      endD: round(endD, 1),
      startT: round(timeAtDistance(channels, startD), 1),
      endT: round(timeAtDistance(channels, endD), 1),
      avgSpeed: num(lap?.averageSpeed),
      avgHr: num(lap?.averageHR),
      intensity: str(lap?.intensityType),
    });
    startD = endD;
  }
  return laps;
}

/** First time the runner reached distance `d` (binary search + interpolation). */
export function timeAtDistance(channels: { t: number[]; d: number[] }, d: number): number {
  const { t, d: dist } = channels;
  if (!t.length) return 0;
  if (d <= dist[0]!) return t[0]!;
  if (d >= dist.at(-1)!) return t.at(-1)!;
  let lo = 0;
  let hi = dist.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (dist[mid]! < d) lo = mid;
    else hi = mid;
  }
  const span = dist[hi]! - dist[lo]!;
  const f = span > 0 ? (d - dist[lo]!) / span : 0;
  return t[lo]! + f * (t[hi]! - t[lo]!);
}

/** Activity summary from `/activity-service/activity/{id}`. */
export function parseActivity(id: string | number, raw: unknown): ReplayActivity {
  const a = obj(raw) ?? {};
  const s = obj(a.summaryDTO) ?? {};
  const type = obj(a.activityTypeDTO);
  const startLocal = str(s.startTimeLocal);
  const startGmt = str(s.startTimeGMT);
  const parse = (v: string | null) =>
    v ? Date.parse(v.replace(" ", "T").replace(/\.\d+$/, "") + "Z") : NaN;
  const local = parse(startLocal);
  const gmt = parse(startGmt);
  return {
    id: String(id),
    name: str(a.activityName),
    type: str(type?.typeKey),
    startLocal,
    startMs: Number.isFinite(gmt) ? gmt : null,
    utcOffsetMin:
      Number.isFinite(local) && Number.isFinite(gmt) ? Math.round((local - gmt) / 60_000) : null,
    distance: num(s.distance),
    duration: num(s.duration),
    avgHr: num(s.averageHR),
    maxHr: num(s.maxHR),
    avgSpeed: num(s.averageSpeed),
    avgCadence: num(s.averageRunCadence),
    avgPower: num(s.averagePower),
    elevationGain: num(s.elevationGain),
    elevationLoss: num(s.elevationLoss),
    calories: num(s.calories),
    aerobicTE: num(s.trainingEffect),
    anaerobicTE: num(s.anaerobicTrainingEffect),
    trainingLoad: num(s.activityTrainingLoad),
    locationName: str(a.locationName),
  };
}

export function buildReplay(input: {
  activityId: string | number;
  details: unknown;
  chart: unknown;
  splits?: unknown;
  weather?: unknown;
  hrZones?: unknown;
}): ReplayData {
  const { channels, n, firstTimestamp } = parseChartDetails(input.chart);
  const activity = parseActivity(input.activityId, input.details);
  if (firstTimestamp !== null) activity.startMs = firstTimestamp;
  return {
    activity,
    weather: parseWeather(input.weather),
    hrZones: parseHrZones(input.hrZones),
    laps: parseLaps(input.splits, channels),
    hasGps: hasGpsTrack(channels),
    n,
    channels,
  };
}

/** A short description for the model: what's being replayed (no time series). */
export function replaySummary(
  activity: ReplayActivity,
  weather: ReplayWeather | null,
  hasGps: boolean | null,
) {
  return {
    activityId: activity.id,
    name: activity.name,
    type: activity.type,
    start: activity.startLocal,
    distanceKm: activity.distance === null ? null : round(activity.distance / 1000, 2),
    durationMin: activity.duration === null ? null : round(activity.duration / 60, 1),
    avgPace: paceLabel(activity.avgSpeed),
    avgHr: activity.avgHr,
    elevationGainM: activity.elevationGain,
    weather,
    gpsTrack: hasGps,
    note: "An interactive 3D replay of this run is open for the user (playback with pace, heart rate, cadence, elevation and more over time). Interpret the run if asked; the replay shows the data.",
  };
}

// ── Playback helpers (view) ───────────────────────────

/** Index i with t[i] <= time < t[i+1], and the fraction between them. */
export function locate(t: ArrayLike<number>, time: number): { i: number; f: number } {
  const n = t.length;
  if (n === 0) return { i: 0, f: 0 };
  if (time <= t[0]!) return { i: 0, f: 0 };
  if (time >= t[n - 1]!) return { i: Math.max(0, n - 2), f: n > 1 ? 1 : 0 };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid]! <= time) lo = mid;
    else hi = mid;
  }
  const span = t[hi]! - t[lo]!;
  return { i: lo, f: span > 0 ? (time - t[lo]!) / span : 0 };
}

/** A channel's value at a located position (nulls: nearest non-null neighbour). */
export function valueAt(series: Series | undefined, at: { i: number; f: number }): number | null {
  if (!series) return null;
  const a = series[at.i] ?? null;
  const b = series[at.i + 1] ?? a;
  if (a === null) return b;
  if (b === null) return a;
  return a + (b - a) * at.f;
}

/** "5:32" per km from m/s. */
export function paceLabel(speed: number | null | undefined): string | null {
  if (!speed || speed < 0.3) return null;
  const secs = Math.round(1000 / speed);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

/** "1:02:05" or "42:05". */
export function clockLabel(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** HR zone 1–5 (0 below zone 1) for a heart rate. */
export function hrZone(hr: number | null, floors: number[] | null): number {
  if (hr === null || !floors) return 0;
  for (let z = floors.length - 1; z >= 0; z--) if (hr >= floors[z]!) return z + 1;
  return 0;
}

/**
 * Sun position (NOAA approximation). Returns elevation and azimuth in
 * degrees; azimuth clockwise from north.
 */
export function sunPosition(
  ms: number,
  lat: number,
  lon: number,
): { elevation: number; azimuth: number } {
  const rad = Math.PI / 180;
  const jd = ms / 86_400_000 + 2440587.5;
  const jc = (jd - 2451545) / 36525;
  const L0 = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360;
  const M = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
  const C =
    Math.sin(M * rad) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) +
    Math.sin(2 * M * rad) * (0.019993 - 0.000101 * jc) +
    Math.sin(3 * M * rad) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * jc;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * rad);
  const eps0 = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * rad);
  const decl = Math.asin(Math.sin(eps * rad) * Math.sin(lambda * rad));
  const y = Math.tan((eps / 2) * rad) ** 2;
  const eqTime =
    (4 *
      (y * Math.sin(2 * L0 * rad) -
        2 * e * Math.sin(M * rad) +
        4 * e * y * Math.sin(M * rad) * Math.cos(2 * L0 * rad) -
        0.5 * y * y * Math.sin(4 * L0 * rad) -
        1.25 * e * e * Math.sin(2 * M * rad))) /
    rad;
  const d = new Date(ms);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  const trueSolar = (((minutes + eqTime + 4 * lon) % 1440) + 1440) % 1440;
  const hourAngle = trueSolar / 4 < 0 ? trueSolar / 4 + 180 : trueSolar / 4 - 180;
  const latR = lat * rad;
  const cosZen =
    Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(hourAngle * rad);
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZen)));
  const elevation = 90 - zenith / rad;
  const azDen = Math.cos(latR) * Math.sin(zenith);
  let azimuth = 0;
  if (Math.abs(azDen) > 1e-6) {
    const c = (Math.sin(latR) * Math.cos(zenith) - Math.sin(decl)) / azDen;
    const a = Math.acos(Math.min(1, Math.max(-1, c))) / rad;
    azimuth = hourAngle > 0 ? (a + 180) % 360 : (540 - a) % 360;
  }
  return { elevation, azimuth };
}
