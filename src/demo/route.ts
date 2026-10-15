/**
 * Where the demo runner runs: a GPS position for every meter of a run, so the
 * 3D replay has a track. Interval days are on a 400 m track; every other run
 * is one smooth loop through the fictional runner's neighbourhood, shaped by
 * the run's seed and sized to its distance.
 *
 * The home position sits at the longitude whose solar time matches the
 * machine's time zone, so a 7 am run gets morning sun in the replay.
 */
import { Rng } from "./random.ts";
import type { RunPlan } from "./run.ts";

const M_PER_DEG = 111_320;
const HOME_LAT = 46.2;

export interface Route {
  /** Position at `d` meters into the run */
  at(d: number): { lat: number; lon: number };
}

function homeLon(startMs: number): number {
  return -new Date(startMs).getTimezoneOffset() / 4;
}

/** A closed polyline with cumulative lengths, walked by arc length. */
function walker(points: [number, number][], lat0: number, lon0: number): Route {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1]!;
    const [bx, by] = points[i]!;
    cum.push(cum[i - 1]! + Math.hypot(bx - ax, by - ay));
  }
  const total = cum.at(-1)!;
  const cosLat = Math.cos((lat0 * Math.PI) / 180);
  return {
    at(d) {
      const s = ((d % total) + total) % total;
      let lo = 0;
      let hi = cum.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid]! <= s) lo = mid;
        else hi = mid;
      }
      const f = (s - cum[lo]!) / (cum[hi]! - cum[lo]! || 1);
      const x = points[lo]![0] + (points[hi]![0] - points[lo]![0]) * f;
      const y = points[lo]![1] + (points[hi]![1] - points[lo]![1]) * f;
      return { lat: lat0 + y / M_PER_DEG, lon: lon0 + x / (M_PER_DEG * cosLat) };
    },
  };
}

/** Standard 400 m track, lane 1: two 84.39 m straights and two 36.5 m bends. */
function track(lat0: number, lon0: number, heading: number): Route {
  const straight = 84.39;
  const r = 36.5;
  const pts: [number, number][] = [];
  const push = (x: number, y: number) => {
    const c = Math.cos(heading);
    const s = Math.sin(heading);
    pts.push([x * c - y * s, x * s + y * c]);
  };
  for (let i = 0; i <= 20; i++) push(-straight / 2 + (straight * i) / 20, -r);
  for (let i = 1; i <= 40; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / 40;
    push(straight / 2 + r * Math.cos(a), r * Math.sin(a));
  }
  for (let i = 1; i <= 20; i++) push(straight / 2 - (straight * i) / 20, r);
  for (let i = 1; i <= 40; i++) {
    const a = Math.PI / 2 + (Math.PI * i) / 40;
    push(-straight / 2 + r * Math.cos(a), r * Math.sin(a));
  }
  return walker(pts, lat0, lon0);
}

/** A wobbly loop whose perimeter is the run's distance. */
function loop(distance: number, rng: Rng, lat0: number, lon0: number): Route {
  const a = rng.range(0, 6.28);
  const b = rng.range(0, 6.28);
  const c = rng.range(0, 6.28);
  const k2 = rng.range(0.12, 0.3);
  const k3 = rng.range(0.05, 0.16);
  const stretch = rng.range(1.1, 1.6);
  const rot = rng.range(0, 6.28);
  const shape = (phi: number): [number, number] => {
    const r =
      1 + k2 * Math.sin(2 * phi + a) + k3 * Math.sin(3 * phi + b) + 0.03 * Math.sin(9 * phi + c);
    const x = r * Math.cos(phi) * stretch;
    const y = r * Math.sin(phi);
    return [x * Math.cos(rot) - y * Math.sin(rot), x * Math.sin(rot) + y * Math.cos(rot)];
  };
  const N = 1200;
  const unit: [number, number][] = [];
  for (let i = 0; i <= N; i++) unit.push(shape((2 * Math.PI * i) / N));
  let perimeter = 0;
  for (let i = 1; i <= N; i++) {
    perimeter += Math.hypot(unit[i]![0] - unit[i - 1]![0], unit[i]![1] - unit[i - 1]![1]);
  }
  // Start at home (the loop's first point), so the run begins and ends there
  const scale = distance / perimeter;
  const [sx, sy] = unit[0]!;
  return walker(
    unit.map(([x, y]) => [(x - sx) * scale, (y - sy) * scale]),
    lat0,
    lon0,
  );
}

export function routeOf(plan: RunPlan, distance: number): Route {
  const rng = Rng.of("route", plan.id);
  const lat0 = HOME_LAT + rng.range(-0.004, 0.004);
  const lon0 = homeLon(plan.startMs) + rng.range(-0.004, 0.004);
  // The track: interval sessions (the plan's flat route)
  if (plan.hills < 2) return track(HOME_LAT + 0.011, lon0 - 0.007, 0.35);
  return loop(Math.max(400, distance), rng, lat0, lon0);
}
