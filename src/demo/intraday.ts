/**
 * Intraday series for one demo day (heart rate, stress, body battery, sleep
 * stages, respiration), generated on request from the day's summary so they
 * agree with it: same resting/max HR, same average stress, same body battery
 * at wake and at bedtime.
 */
import { Rng, clamp, mean, round } from "./random.ts";
import { simulate } from "./run.ts";
import { addDays, gmtIso, localMs } from "./time.ts";
import { SNAPSHOT_SECS, type DemoDay, type Night, type World } from "./world.ts";

const MIN = 60_000;

/** The day's [start, end) in epoch ms; today ends at the snapshot. */
export function dayWindow(day: DemoDay): [number, number] {
  const start = localMs(day.date, 0);
  return [start, day.isToday ? localMs(day.date, SNAPSHOT_SECS) : localMs(addDays(day.date, 1), 0)];
}

/** Sleep periods overlapping the day: last night (ends this morning) and tonight. */
function asleep(world: World, day: DemoDay, ms: number): Night | null {
  const tonight = world.byDate.get(addDays(day.date, 1))?.night;
  for (const n of [day.night, tonight]) {
    if (n && ms >= n.start && ms < n.end) return n;
  }
  return null;
}

/** Run HR by wall-clock time, for runs on the day. */
function runAt(day: DemoDay) {
  const runs = day.runs.map((r) => ({ r, samples: simulate(r.plan) }));
  return (ms: number): { hr: number } | null => {
    for (const { r, samples } of runs) {
      const t = (ms - r.plan.startMs) / 1000;
      if (t < 0 || t > samples.at(-1)!.t) continue;
      const s = samples.find((x) => x.t >= t) ?? samples.at(-1)!;
      return { hr: s.hr };
    }
    return null;
  };
}

/** Heart rate every 2 minutes: [ms, bpm]. */
export function heartRateValues(world: World, day: DemoDay): [number, number][] {
  const rng = Rng.of("hr", day.date);
  const [from, to] = dayWindow(day);
  const inRun = runAt(day);
  const out: [number, number][] = [];
  let walk = 0;
  let afterRun = 0;
  for (let ms = from; ms < to; ms += 2 * MIN) {
    const run = inRun(ms);
    const night = asleep(world, day, ms);
    let hr: number;
    if (run) {
      hr = run.hr;
      afterRun = 40;
    } else if (night) {
      const f = (ms - night.start) / (night.end - night.start);
      hr = day.rhr + 3 + 5 * Math.cos(f * Math.PI * 1.6) * (1 - f) + rng.normal(0, 1.2);
    } else {
      walk = 0.8 * walk + rng.normal(0, 4);
      const hour = (ms - from) / 3_600_000;
      const active = hour > 7 && hour < 21 ? 8 : 2;
      hr = day.rhr + 16 + active + Math.abs(walk) + afterRun * 0.5;
      afterRun = Math.max(0, afterRun - 4);
    }
    out.push([ms, Math.round(hr)]);
  }
  // The day's min and max as reported in the summary
  const sleeping = out.filter(([ms]) => asleep(world, day, ms));
  if (sleeping.length) sleeping[Math.floor(sleeping.length * 0.55)]![1] = day.minHr;
  if (!day.runs.length && out.length > 400) {
    out[Math.floor(out.length * 0.62)]![1] = day.maxHr;
  }
  return out;
}

/** Stress every 3 minutes: [ms, level]; -2 while running (too much motion). */
export function stressValues(world: World, day: DemoDay): [number, number][] {
  const rng = Rng.of("stress", day.date);
  const [from, to] = dayWindow(day);
  const runs = day.runs.map((r) => [
    r.plan.startMs,
    r.plan.startMs + r.summary.elapsedDuration * 1000,
  ]);
  const out: [number, number][] = [];
  let ar = 0;
  let afterRun = 0;
  for (let ms = from; ms < to; ms += 3 * MIN) {
    if (runs.some(([a, b]) => ms >= a! && ms < b!)) {
      out.push([ms, -2]);
      afterRun = 12;
      continue;
    }
    const night = asleep(world, day, ms);
    ar = 0.85 * ar + rng.normal(0, 6);
    let v: number;
    if (night) v = night.avgSleepStress + rng.normal(0, 4);
    else if (afterRun > 0) {
      v = 30 + afterRun * 2.5 + rng.normal(0, 4);
      afterRun--;
    } else v = day.stressAvg + 8 + ar;
    out.push([ms, Math.round(clamp(v, 1, 99))]);
  }
  // Shift the awake values so the day's average matches the summary
  const awake = out.filter(([ms, v]) => v >= 0 && !asleep(world, day, ms));
  const all = out.filter(([, v]) => v >= 0);
  if (awake.length && all.length) {
    const shift = ((day.stressAvg - mean(all.map(([, v]) => v))) * all.length) / awake.length;
    for (const e of awake) e[1] = Math.round(clamp(e[1] + shift, 1, 99));
  }
  // One peak (a busy meeting, a commute) at the day's max
  const peakAt = awake[Math.floor(awake.length * 0.4)];
  if (peakAt) peakAt[1] = day.stressMax;
  return out;
}

/** Body battery every 15 minutes: [ms, level]. */
export function bodyBatteryValues(world: World, day: DemoDay): [number, number][] {
  const [from, to] = dayWindow(day);
  const rng = Rng.of("bb", day.date);
  const next = world.byDate.get(addDays(day.date, 1));
  const wake = day.night.end;
  const bedMs = next ? next.night.start : to;
  const bed = day.bb.bed ?? day.bb.end;
  const raw = (ms: number) => {
    // Awake: steady drain, runs cost extra, a small afternoon top-up
    let level = day.bb.atWake - day.bb.drainPerHour * ((ms - wake) / 3_600_000);
    for (const r of day.runs) {
      const done = (ms - r.plan.startMs) / (r.summary.elapsedDuration * 1000);
      level -= (r.summary.trainingLoad / 6) * clamp(done, 0, 1);
    }
    const afternoon = localMs(day.date, 14 * 3600);
    if (ms > afternoon) level += day.bb.rech * clamp((ms - afternoon) / 3_600_000, 0, 1);
    return level;
  };
  const rawBed = raw(bedMs);
  const out: [number, number][] = [];
  for (let ms = from; ms < to; ms += 15 * MIN) {
    let level: number;
    if (ms < wake) {
      // Charging overnight, fastest early in the night
      const f = clamp((ms - from) / (wake - from), 0, 1);
      level = day.bb.midnight + (day.bb.atWake - day.bb.midnight) * Math.sin((f * Math.PI) / 2);
    } else if (ms < bedMs) {
      // Anchor the awake curve on the bedtime level
      level = raw(ms) + ((bed - rawBed) * (ms - wake)) / Math.max(bedMs - wake, 1);
    } else {
      const f = clamp((ms - bedMs) / (to - bedMs), 0, 1);
      level = bed + (day.bb.end - bed) * f;
    }
    out.push([ms, Math.round(clamp(level + rng.normal(0, 0.4), 5, 100))]);
  }
  return out;
}

/** Sleep stages (hypnogram): deep early in the night, REM later. */
export function sleepLevels(night: Night, date: string) {
  const rng = Rng.of("levels", date);
  const cycles = Math.max(3, Math.round(night.sleepSecs / 5400));
  const deepW = Array.from({ length: cycles }, (_, k) => Math.max(0.05, 1 - k * 0.28));
  const remW = Array.from({ length: cycles }, (_, k) => 0.5 + k * 0.4);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const awakeBreaks = night.awakeCount;
  const levels: { startGMT: string; endGMT: string; activityLevel: number }[] = [];
  let t = night.start;
  const push = (secs: number, level: number) => {
    if (secs < 60) return;
    levels.push({ startGMT: gmtIso(t), endGMT: gmtIso(t + secs * 1000), activityLevel: level });
    t += secs * 1000;
  };
  // Falling asleep
  const firstAwake = Math.min(night.awakeSecs * 0.3, 600);
  push(Math.round(firstAwake / 60) * 60, 3);
  let awakeLeft = night.awakeSecs - Math.round(firstAwake / 60) * 60;
  for (let k = 0; k < cycles; k++) {
    const deep = Math.round((night.deepSecs * deepW[k]!) / sum(deepW) / 60) * 60;
    const rem = Math.round((night.remSecs * remW[k]!) / sum(remW) / 60) * 60;
    const light = Math.round(night.lightSecs / cycles / 60) * 60;
    const split = rng.range(0.35, 0.6);
    push(Math.round((light * split) / 60) * 60, 1);
    push(deep, 0);
    push(light - Math.round((light * split) / 60) * 60, 1);
    push(rem, 2);
    if (k < cycles - 1 && k < awakeBreaks) {
      const a = Math.round(awakeLeft / Math.max(1, awakeBreaks - k) / 60) * 60;
      push(a, 3);
      awakeLeft -= a;
    }
  }
  if (awakeLeft >= 60) push(awakeLeft, 3);
  return levels;
}

/** Respiration every 2 minutes while asleep, every 10 minutes awake. */
export function respirationValues(world: World, day: DemoDay): [number, number][] {
  const rng = Rng.of("resp", day.date);
  const [from, to] = dayWindow(day);
  const out: [number, number][] = [];
  for (let ms = from; ms < to; ms += 10 * MIN) {
    const night = asleep(world, day, ms);
    const v = night ? night.avgRespiration + rng.normal(0, 0.6) : 16.5 + rng.normal(0, 1.4);
    out.push([ms, round(clamp(v, 8, 26), 0)]);
  }
  return out;
}
