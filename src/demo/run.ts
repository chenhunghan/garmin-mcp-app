/**
 * One simulated run: a plan (segments at target paces) becomes a 5-second
 * time series (distance, speed, heart rate, cadence, elevation), and every
 * number Garmin reports about the run — summary, laps, HR zones, training
 * load/effect — is derived from that series, so they always agree.
 */
import { Rng, clamp, round } from "./random.ts";

export type RunKind = "easy" | "recovery" | "long" | "tempo" | "intervals" | "progression";
export type Intensity = "WARMUP" | "INTERVAL" | "RECOVERY" | "COOLDOWN" | "ACTIVE";

export interface Segment {
  meters?: number;
  seconds?: number;
  /** Target pace, seconds per km */
  pace: number;
  intensity: Intensity;
}

export interface RunPlan {
  id: number;
  date: string;
  kind: RunKind;
  name: string;
  startMs: number;
  seed: number;
  segments: Segment[];
  /** auto = 1 km auto laps; segments = a lap per workout step; single = one lap */
  laps: "auto" | "segments" | "single";
  restHr: number;
  maxHr: number;
  /** Lactate threshold pace (s/km) that day */
  thresholdPace: number;
  /** Rolling-route amplitude in meters (a track is flat) */
  hills: number;
  /** Air temperature, °C */
  tempC: number;
  workoutId: number | null;
  weightKg: number;
}

export interface Sample {
  /** timer seconds */
  t: number;
  /** meters */
  d: number;
  /** m/s */
  speed: number;
  hr: number;
  /** steps per minute */
  cad: number;
  elev: number;
  power: number;
}

export interface LapStats {
  lapIndex: number;
  startMs: number;
  distance: number;
  duration: number;
  averageSpeed: number;
  maxSpeed: number;
  averageHR: number;
  maxHR: number;
  averageRunCadence: number;
  maxRunCadence: number;
  elevationGain: number;
  elevationLoss: number;
  maxElevation: number;
  minElevation: number;
  averagePower: number;
  maxPower: number;
  calories: number;
  strideLength: number;
  intensityType: Intensity;
}

export interface RunSummary {
  distance: number;
  duration: number;
  movingDuration: number;
  elapsedDuration: number;
  averageSpeed: number;
  maxSpeed: number;
  averageHR: number;
  maxHR: number;
  minHR: number;
  averageCadence: number;
  maxCadence: number;
  elevationGain: number;
  elevationLoss: number;
  maxElevation: number;
  minElevation: number;
  averagePower: number;
  maxPower: number;
  normPower: number;
  steps: number;
  calories: number;
  bmrCalories: number;
  strideLength: number;
  /** seconds per HR zone 1–5 */
  zoneSecs: number[];
  zoneFloors: number[];
  trainingLoad: number;
  aerobicTE: number;
  anaerobicTE: number;
  teLabel: string;
  moderateMinutes: number;
  vigorousMinutes: number;
  lapCount: number;
  fastest1k: number | null;
}

const DT = 5;

/** HR zone floors (heart-rate-reserve method: 50/60/70/80/90 %). */
export function zoneFloors(restHr: number, maxHr: number): number[] {
  return [0.5, 0.6, 0.7, 0.8, 0.9].map((f) => Math.round(restHr + f * (maxHr - restHr)));
}

export function simulate(plan: RunPlan): Sample[] {
  const rng = new Rng(plan.seed);
  const ph1 = rng.range(0, 6.28);
  const ph2 = rng.range(0, 6.28);
  const base = rng.range(25, 60);
  const elevAt = (d: number) =>
    base + plan.hills * Math.sin(d / 1400 + ph1) + plan.hills * 0.35 * Math.sin(d / 380 + ph2);
  const thrSpeed = 1000 / plan.thresholdPace;
  const hrr = plan.maxHr - plan.restHr;

  const samples: Sample[] = [];
  let t = 0;
  let d = 0;
  let hr = plan.restHr + 30;
  let speed = (1000 / plan.segments[0]!.pace) * 0.75;
  let ar = 0;
  const push = () => {
    const cad = 138 + 11.5 * speed + rng.normal(0, 1.2);
    samples.push({
      t: round(t, 1),
      d: round(d, 1),
      speed: round(speed, 3),
      hr: Math.round(hr + rng.normal(0, 0.7)),
      cad: Math.round(cad),
      elev: round(elevAt(d) + rng.normal(0, 0.15), 1),
      power: Math.round(
        plan.weightKg * speed * 1.32 * (1 + 4 * ((elevAt(d + 5) - elevAt(d - 5)) / 10)),
      ),
    });
  };
  push();
  for (const seg of plan.segments) {
    const t0 = t;
    const d0 = d;
    const done = () =>
      seg.meters !== undefined ? d - d0 >= seg.meters - 0.01 : t - t0 >= seg.seconds! - 0.01;
    while (!done()) {
      const target = 1000 / seg.pace;
      ar = 0.85 * ar + rng.normal(0, 0.011);
      const grade = (elevAt(d + 5) - elevAt(d - 5)) / 10;
      const want = target * (1 + ar) * (1 - 1.6 * grade);
      speed += (want - speed) * (1 - Math.exp(-DT / 7));
      let step = DT;
      if (seg.meters !== undefined) {
        const left = seg.meters - (d - d0);
        if (speed * step > left) step = left / speed;
      } else {
        step = Math.min(DT, seg.seconds! - (t - t0));
      }
      t += step;
      d += speed * step;
      const r = speed / thrSpeed;
      const drift = 0.0007 * (t / 60);
      const frac = clamp(0.82 * r ** 1.7 + drift, 0.3, 0.97);
      const targetHr = plan.restHr + hrr * frac;
      const tau = targetHr > hr ? 22 : 38;
      hr += (targetHr - hr) * (1 - Math.exp(-step / tau));
      push();
    }
  }
  return plan.laps === "auto" ? withKmMarks(samples) : samples;
}

/** Auto lap: the watch records a point exactly at each full kilometer. */
function withKmMarks(s: Sample[]): Sample[] {
  const out: Sample[] = [s[0]!];
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1]!;
    const b = s[i]!;
    const km = Math.floor(b.d / 1000) * 1000;
    if (km > a.d && km < b.d - 0.5 && km > 0) {
      const f = (km - a.d) / (b.d - a.d);
      const lerp = (x: number, y: number) => x + (y - x) * f;
      out.push({
        t: round(lerp(a.t, b.t), 1),
        d: km,
        speed: round(lerp(a.speed, b.speed), 3),
        hr: Math.round(lerp(a.hr, b.hr)),
        cad: Math.round(lerp(a.cad, b.cad)),
        elev: round(lerp(a.elev, b.elev), 1),
        power: Math.round(lerp(a.power, b.power)),
      });
    }
    out.push(b);
  }
  return out;
}

interface Span {
  from: number;
  to: number;
  intensity: Intensity;
}

/** Sample index ranges of each lap. */
function lapSpans(plan: RunPlan, s: Sample[]): Span[] {
  if (plan.laps === "single") return [{ from: 0, to: s.length - 1, intensity: "ACTIVE" }];
  if (plan.laps === "segments") {
    const spans: Span[] = [];
    let from = 0;
    let t = 0;
    let dist = 0;
    for (const seg of plan.segments) {
      const end = seg.meters !== undefined ? dist + seg.meters : null;
      const tEnd = seg.seconds !== undefined ? t + seg.seconds : null;
      let to = from;
      while (
        to < s.length - 1 &&
        (end !== null ? s[to]!.d < end - 0.05 : s[to]!.t < (tEnd as number) - 0.05)
      ) {
        to++;
      }
      spans.push({ from, to, intensity: seg.intensity });
      t = s[to]!.t;
      dist = s[to]!.d;
      from = to;
    }
    return spans;
  }
  const spans: Span[] = [];
  let from = 0;
  for (let k = 1; ; k++) {
    let to = from;
    while (to < s.length - 1 && s[to]!.d < k * 1000) to++;
    spans.push({ from, to, intensity: "ACTIVE" });
    if (to >= s.length - 1) break;
    from = to;
  }
  // A tiny last lap (a few meters past the last full km) folds into the previous one
  const last = spans.at(-1)!;
  if (spans.length > 1 && s[last.to]!.d - s[last.from]!.d < 30) {
    spans.pop();
    spans.at(-1)!.to = last.to;
  }
  return spans;
}

function statsOf(s: Sample[], from: number, to: number) {
  let hrSum = 0;
  let cadSum = 0;
  let powSum = 0;
  let pow4 = 0;
  let time = 0;
  let maxHr = 0;
  let minHr = 999;
  let maxCad = 0;
  let maxSpeed = 0;
  let maxPower = 0;
  let gain = 0;
  let loss = 0;
  let maxE = -Infinity;
  let minE = Infinity;
  let steps = 0;
  for (let i = from + 1; i <= to; i++) {
    const a = s[i - 1]!;
    const b = s[i]!;
    const dt = b.t - a.t;
    time += dt;
    hrSum += b.hr * dt;
    cadSum += b.cad * dt;
    powSum += b.power * dt;
    pow4 += b.power ** 4 * dt;
    steps += (b.cad * dt) / 60;
    maxHr = Math.max(maxHr, b.hr);
    minHr = Math.min(minHr, b.hr);
    maxCad = Math.max(maxCad, b.cad);
    maxPower = Math.max(maxPower, b.power);
    const s3 = (s[Math.max(from, i - 2)]!.speed + a.speed + b.speed) / 3;
    maxSpeed = Math.max(maxSpeed, s3);
    const de = b.elev - a.elev;
    if (de > 0) gain += de;
    else loss -= de;
    maxE = Math.max(maxE, b.elev);
    minE = Math.min(minE, b.elev);
  }
  const distance = s[to]!.d - s[from]!.d;
  const t = time || 1;
  return {
    distance,
    duration: time,
    averageSpeed: distance / t,
    maxSpeed,
    averageHR: Math.round(hrSum / t),
    maxHR: maxHr,
    minHR: minHr,
    averageRunCadence: round(cadSum / t, 1),
    maxRunCadence: maxCad,
    // Garmin's elevation gain ignores sub-meter wiggles; the series is smooth enough
    elevationGain: Math.round(gain * 0.8),
    elevationLoss: Math.round(loss * 0.8),
    maxElevation: round(maxE, 1),
    minElevation: round(minE, 1),
    averagePower: Math.round(powSum / t),
    maxPower,
    normPower: Math.round((pow4 / t) ** 0.25),
    steps: Math.round(steps),
  };
}

export function laps(plan: RunPlan, s: Sample[]): LapStats[] {
  return lapSpans(plan, s).map((span, i) => {
    const st = statsOf(s, span.from, span.to);
    return {
      lapIndex: i + 1,
      startMs: plan.startMs + s[span.from]!.t * 1000,
      distance: round(st.distance, 2),
      duration: round(st.duration, 1),
      averageSpeed: round(st.averageSpeed, 3),
      maxSpeed: round(st.maxSpeed, 3),
      averageHR: st.averageHR,
      maxHR: st.maxHR,
      averageRunCadence: st.averageRunCadence,
      maxRunCadence: st.maxRunCadence,
      elevationGain: st.elevationGain,
      elevationLoss: st.elevationLoss,
      maxElevation: st.maxElevation,
      minElevation: st.minElevation,
      averagePower: st.averagePower,
      maxPower: st.maxPower,
      calories: Math.round((plan.weightKg * st.distance) / 1000),
      strideLength: round((st.averageSpeed / (st.averageRunCadence / 60)) * 100, 1),
      intensityType: span.intensity,
    };
  });
}

const TE_LABELS: Record<RunKind, string> = {
  easy: "AEROBIC_BASE",
  recovery: "RECOVERY",
  long: "AEROBIC_BASE",
  tempo: "LACTATE_THRESHOLD",
  intervals: "VO2MAX",
  progression: "TEMPO",
};

const ANAEROBIC_BASE: Record<RunKind, [number, number]> = {
  easy: [0, 0.3],
  recovery: [0, 0.1],
  long: [0.1, 0.5],
  tempo: [0.6, 1.2],
  intervals: [1.6, 2.2],
  progression: [0.4, 1.0],
};

export function summarize(plan: RunPlan, s: Sample[]): RunSummary {
  const rng = Rng.of("summary", plan.id);
  const st = statsOf(s, 0, s.length - 1);
  const floors = zoneFloors(plan.restHr, plan.maxHr);
  const zoneSecs = [0, 0, 0, 0, 0];
  const hrr = plan.maxHr - plan.restHr;
  let load = 0;
  let mod = 0;
  let vig = 0;
  let hard = 0;
  for (let i = 1; i < s.length; i++) {
    const dt = s[i]!.t - s[i - 1]!.t;
    const hr = s[i]!.hr;
    let z = -1;
    for (let k = 4; k >= 0; k--) {
      if (hr >= floors[k]!) {
        z = k;
        break;
      }
    }
    if (z >= 0) zoneSecs[z]! += dt;
    const f = clamp((hr - plan.restHr) / hrr, 0, 1);
    load += (dt / 60) * f * 0.64 * Math.exp(1.92 * f);
    if (f >= 0.77) vig += dt / 60;
    else if (f >= 0.55) mod += dt / 60;
    if (f >= 0.86) hard += dt / 60;
  }
  load *= 1.4;
  const [aLo, aHi] = ANAEROBIC_BASE[plan.kind];
  const aerobic = clamp(1 + 3.6 * (1 - Math.exp(-load / 110)) + rng.normal(0, 0.08), 1, 5);
  const anaerobic = clamp(rng.range(aLo, aHi) + 0.05 * hard, 0, 4.2);

  // Fastest 1 km anywhere in the run (for personal records)
  let fastest1k: number | null = null;
  let j = 0;
  for (let i = 0; i < s.length; i++) {
    while (j < s.length && s[j]!.d - s[i]!.d < 1000) j++;
    if (j >= s.length) break;
    const dur = s[j]!.t - s[i]!.t;
    if (fastest1k === null || dur < fastest1k) fastest1k = dur;
  }

  const pause = plan.kind === "intervals" ? rng.range(20, 60) : rng.range(0, 25);
  return {
    distance: round(st.distance, 2),
    duration: round(st.duration, 1),
    movingDuration: Math.round(st.duration - rng.range(0, 6)),
    elapsedDuration: round(st.duration + pause, 1),
    averageSpeed: round(st.averageSpeed, 3),
    maxSpeed: round(st.maxSpeed, 3),
    averageHR: st.averageHR,
    maxHR: st.maxHR,
    minHR: st.minHR,
    averageCadence: st.averageRunCadence,
    maxCadence: st.maxRunCadence,
    elevationGain: st.elevationGain,
    elevationLoss: st.elevationLoss,
    maxElevation: st.maxElevation,
    minElevation: st.minElevation,
    averagePower: st.averagePower,
    maxPower: st.maxPower,
    normPower: st.normPower,
    steps: st.steps,
    calories: Math.round(((plan.weightKg * st.distance) / 1000) * 1.04),
    bmrCalories: Math.round((st.duration / 86_400) * 1610),
    strideLength: round((st.averageSpeed / (st.averageRunCadence / 60)) * 100, 1),
    zoneSecs: zoneSecs.map((v) => round(v, 1)),
    zoneFloors: floors,
    trainingLoad: round(load, 1),
    aerobicTE: round(aerobic, 1),
    anaerobicTE: round(anaerobic, 1),
    teLabel: TE_LABELS[plan.kind],
    moderateMinutes: Math.round(mod),
    vigorousMinutes: Math.round(vig),
    lapCount: lapSpans(plan, s).length,
    fastest1k: fastest1k === null ? null : round(fastest1k, 1),
  };
}
