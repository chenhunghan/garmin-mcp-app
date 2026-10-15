/**
 * CMU motion capture (ASF skeleton + AMC frames) → one running cycle of the
 * upper body, as curves the replay's runner can play on its own skeleton:
 * sampled at 64 phases of the stride, starting at the left foot's touchdown
 * (the gait phase runner.ts uses), averaged over the take's cycles.
 *
 * Channels (radians; "left" = the runner's left; + as in runner.ts):
 * - pelvisYaw: pelvis turned left of the direction of travel
 * - pelvisRoll: left hip higher than the right
 * - chestYaw: thorax turned left of the pelvis
 * - lean: trunk pitch forward, minus its mean (the mean comes from speed and hill)
 * - flexL/flexR: upper arm swung forward of the trunk's down axis
 * - abdL/abdR: upper arm out from the side
 * - elbowL/elbowR: elbow bend (0 = straight)
 *
 * Forward kinematics as in the CMU ASF/AMC spec: a bone's global rotation is
 * parent · C · M · C⁻¹ (C from its `axis`, M from the frame's dof angles,
 * both Euler XYZ applied x then y then z), its end = start + rotation ·
 * direction · length.
 */
import { writeFile } from "node:fs/promises";

const PHASES = 64;

// ── Small linear algebra (3×3 row-major) ──
const mul = (a, b) => {
  const o = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return o;
};
const apply = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
const transpose = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
const rx = (d) => {
  const a = (d * Math.PI) / 180;
  return [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
};
const ry = (d) => {
  const a = (d * Math.PI) / 180;
  return [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
};
const rz = (d) => {
  const a = (d * Math.PI) / 180;
  return [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
};
/** Euler angles applied in `order` (e.g. "XYZ": x first) as one matrix */
function euler(angles, order = "XYZ") {
  const f = { X: rx, Y: ry, Z: rz };
  let m = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (const axis of order) m = mul(f[axis](angles[axis] ?? 0), m);
  return m;
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => scale(a, 1 / (Math.hypot(...a) || 1));

// ── Parsing ──
export function parseAsf(text) {
  const lines = text.split("\n").map((l) => l.trim());
  const bones = new Map();
  const children = new Map();
  let lengthUnit = 1;
  let rootOrder = ["TX", "TY", "TZ", "RX", "RY", "RZ"];
  let rootAxis = "XYZ";
  let section = "";
  let cur = null;
  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith(":")) {
      section = line.split(/\s+/)[0];
      if (section === ":units") continue;
      continue;
    }
    const t = line.split(/\s+/);
    if (section === ":units" && t[0] === "length") lengthUnit = Number(t[1]);
    if (section === ":root") {
      if (t[0] === "order") rootOrder = t.slice(1).map((s) => s.toUpperCase());
      if (t[0] === "axis") rootAxis = t[1].toUpperCase();
    }
    if (section === ":bonedata") {
      if (t[0] === "begin") cur = { dof: [] };
      else if (t[0] === "end") bones.set(cur.name, cur);
      else if (t[0] === "name") cur.name = t[1];
      else if (t[0] === "direction") cur.direction = t.slice(1, 4).map(Number);
      else if (t[0] === "length") cur.length = Number(t[1]);
      else if (t[0] === "axis") {
        const order = t[4].toUpperCase();
        const [a, b, c] = t.slice(1, 4).map(Number);
        cur.axis = { X: a, Y: b, Z: c, order };
      } else if (t[0] === "dof") cur.dof = t.slice(1).map((s) => s.toUpperCase());
    }
    if (section === ":hierarchy" && t[0] !== "begin" && t[0] !== "end") {
      children.set(t[0], t.slice(1));
    }
  }
  return { bones, children, lengthUnit, rootOrder, rootAxis };
}

export function parseAmc(text) {
  const frames = [];
  let cur = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(":")) continue;
    if (/^\d+$/.test(line)) {
      cur = new Map();
      frames.push(cur);
      continue;
    }
    const t = line.split(/\s+/);
    cur?.set(t[0], t.slice(1).map(Number));
  }
  return frames;
}

/** Joint positions (start and end of every bone) for one frame */
function pose(asf, frame) {
  const pos = new Map(); // bone name → { start, end, R }
  const rootV = frame.get("root") ?? [0, 0, 0, 0, 0, 0];
  const r = {};
  asf.rootOrder.forEach((ch, i) => (r[ch] = rootV[i]));
  const R = euler({ X: r.RX, Y: r.RY, Z: r.RZ }, asf.rootAxis);
  const origin = [r.TX ?? 0, r.TY ?? 0, r.TZ ?? 0];
  pos.set("root", { start: origin, end: origin, R });
  const visit = (parent) => {
    for (const name of asf.children.get(parent) ?? []) {
      const b = asf.bones.get(name);
      const p = pos.get(parent);
      const C = euler(b.axis, b.axis.order);
      const v = frame.get(name) ?? [];
      const a = {};
      b.dof.forEach((d, i) => (a[d.slice(1)] = v[i] ?? 0));
      const M = euler(a, b.axis.order);
      const G = mul(mul(mul(p.R, C), M), transpose(C));
      const end = add(p.end, scale(apply(G, b.direction), b.length));
      pos.set(name, { start: p.end, end, R: G });
      visit(name);
    }
  };
  visit("root");
  return pos;
}

/** Signed angle of `v` about `axis` from `ref` (both projected on the plane ⟂ axis) */
function signedAngle(ref, v, axis) {
  const a = norm(sub(ref, scale(axis, dot(ref, axis))));
  const b = norm(sub(v, scale(axis, dot(v, axis))));
  return Math.atan2(dot(cross(a, b), axis), dot(a, b));
}

/** Takes as [{ asf, amc }] (each with its subject's skeleton): every full stride of each is averaged */
export async function processMotion(takes, file) {
  const channels = ["pelvisYaw", "pelvisRoll", "chestYaw", "lean", "flexL", "flexR", "abdL", "abdR", "elbowL", "elbowR"];
  const sum = Object.fromEntries(channels.map((c) => [c, new Float64Array(PHASES)]));
  let cycles = 0;
  let meters = 0;
  let seconds = 0;
  let steps = 0;
  const skeletons = new Map();
  for (const take of takes) {
    try {
      let asf = skeletons.get(take.asf);
      if (!asf) skeletons.set(take.asf, (asf = parseAsf(take.asf)));
      const r = takeCycles(asf, parseAmc(take.amc), sum);
      cycles += r.cycles;
      meters += r.meters;
      seconds += r.seconds;
      steps += r.cycles * 2;
    } catch {
      // (a take without a full stride)
    }
  }
  if (!cycles) throw new Error("no full strides in the takes");
  const speed = meters / seconds;
  const cadence = (steps * 60) / seconds;
  const out = { phases: PHASES, speed: round(speed), cadence: round(cadence), cycles, curves: {} };
  for (const c of channels) {
    const raw = Array.from(sum[c], (x) => x / cycles);
    // A light circular smoothing (5 taps): few strides leave a little noise
    const v = raw.map((_, i) => {
      let t = 0;
      for (const [o, w] of [[-2, 1], [-1, 2], [0, 3], [1, 2], [2, 1]]) t += raw[(i + o + PHASES) % PHASES] * w;
      return t / 9;
    });
    if (c === "lean") {
      const mean = v.reduce((s, x) => s + x, 0) / v.length;
      out.meanLean = round(mean);
      for (let i = 0; i < v.length; i++) v[i] -= mean;
    }
    out.curves[c] = v.map(round);
  }
  await writeFile(file, JSON.stringify(out));
  return { speed: out.speed, cadence: out.cadence, cycles };
}

/** Add one take's strides (left touchdown to left touchdown) into `sum` */
function takeCycles(asf, frames, sum) {
  const fps = 120;
  const up = [0, 1, 0];
  const metersPerUnit = (1 / asf.lengthUnit) * 0.0254;
  const P = frames.map((f) => pose(asf, f));
  const n = P.length;
  // Left touchdowns: the left ankle (ltibia's end) comes down to its lowest band
  const ankleY = P.map((p) => p.get("ltibia").end[1]);
  const lo = Math.min(...ankleY);
  const hi = Math.max(...ankleY);
  const thr = lo + 0.18 * (hi - lo);
  const touch = [];
  for (let i = 1; i < n; i++)
    if (ankleY[i] < thr && ankleY[i - 1] >= thr && (!touch.length || i - touch.at(-1) > fps * 0.4))
      touch.push(i);
  if (touch.length < 2) throw new Error(`only ${touch.length} touchdowns`);
  // Travel direction and speed over the take (horizontal)
  const r0 = P[touch[0]].get("root").start;
  const r1 = P[touch.at(-1)].get("root").start;
  const travel = norm([r1[0] - r0[0], 0, r1[2] - r0[2]]);
  const seconds = (touch.at(-1) - touch[0]) / fps;
  const meters = Math.hypot(r1[0] - r0[0], r1[2] - r0[2]) * metersPerUnit;
  const cycles = touch.length - 1;
  for (let c = 0; c < cycles; c++) {
    const a = touch[c];
    const b = touch[c + 1];
    for (let k = 0; k < PHASES; k++) {
      // Interpolate the frame at this phase (nearest is fine at 120 fps)
      const p = P[Math.round(a + ((b - a) * k) / PHASES)];
      const lhip = p.get("lhipjoint").end;
      const rhip = p.get("rhipjoint").end;
      const lsh = p.get("lclavicle").end;
      const rsh = p.get("rclavicle").end;
      const pelvisLeft = norm(sub(lhip, rhip));
      const pelvisFwd = norm(cross(up, pelvisLeft)); // left × … : up × left = forward? (see below)
      // Facing +z with +x left: up × left = (0,1,0)×(1,0,0) = (0,0,−1): flip
      const pf = scale(pelvisFwd, -1);
      const thoraxUp = norm(sub(p.get("lowerneck").start, p.get("lowerback").start));
      const chestLeft = norm(sub(lsh, rsh));
      const chestFwd = norm(cross(chestLeft, thoraxUp)); // (1,0,0)×(0,1,0) = (0,0,1)
      sum.pelvisYaw[k] += signedAngle(travel, pf, up);
      sum.pelvisRoll[k] += Math.asin(Math.max(-1, Math.min(1, dot(pelvisLeft, up))));
      sum.chestYaw[k] += signedAngle(pf, chestFwd, up);
      // Trunk pitch: thorax up tilted toward the direction of travel
      sum.lean[k] += Math.atan2(dot(thoraxUp, travel), dot(thoraxUp, up));
      for (const [s, side] of [
        ["L", 1],
        ["R", -1],
      ]) {
        const pre = s === "L" ? "l" : "r";
        const shoulder = p.get(`${pre}humerus`).start;
        const elbow = p.get(`${pre}humerus`).end;
        const wrist = p.get(`${pre}radius`).end;
        const d = norm(sub(elbow, shoulder));
        const f = norm(sub(wrist, elbow));
        const down = scale(thoraxUp, -1);
        const out = scale(chestLeft, side);
        sum[`flex${s}`][k] += Math.atan2(dot(d, chestFwd), dot(d, down));
        sum[`abd${s}`][k] += Math.atan2(dot(d, out), dot(d, down));
        sum[`elbow${s}`][k] += Math.acos(Math.max(-1, Math.min(1, dot(d, f))));
      }
    }
  }
  return { cycles, meters, seconds };
}

function round(x) {
  return Math.round(x * 10000) / 10000;
}
