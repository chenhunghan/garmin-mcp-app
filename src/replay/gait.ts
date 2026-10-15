/**
 * Running joint-angle curves over one gait cycle (0 = initial contact,
 * toe-off ≈ 38 %), shaped after published running kinematics (sagittal hip,
 * knee and ankle; e.g. Novacheck 1998, "The biomechanics of running").
 * Degrees; hip flexion, knee flexion and ankle dorsiflexion are positive.
 * The replay uses these for the swing leg; the planted leg is solved with IK
 * so the foot stays on the ground.
 */

type Keys = [number, number][];

export const TOE_OFF = 0.38;

const HIP: Keys = [
  [0, 32],
  [0.1, 28],
  [0.2, 14],
  [0.3, 0],
  [0.38, -10],
  [0.45, -9],
  [0.55, 4],
  [0.65, 22],
  [0.75, 36],
  [0.85, 40],
  [0.93, 35],
];
const KNEE: Keys = [
  [0, 18],
  [0.08, 32],
  [0.16, 42],
  [0.25, 34],
  [0.33, 23],
  [0.38, 20],
  [0.45, 38],
  [0.55, 72],
  [0.63, 92],
  [0.7, 96],
  [0.78, 80],
  [0.86, 50],
  [0.93, 26],
];
const ANKLE: Keys = [
  [0, 3],
  [0.08, 12],
  [0.18, 21],
  [0.28, 12],
  [0.35, -6],
  [0.4, -22],
  [0.48, -16],
  [0.58, -3],
  [0.7, 5],
  [0.85, 6],
  [0.95, 3],
];

/** Periodic Catmull-Rom through the keys. */
function sample(keys: Keys, t: number): number {
  const u = ((t % 1) + 1) % 1;
  const n = keys.length;
  let i = n - 1;
  for (let k = 0; k < n; k++) {
    if (keys[k]![0] > u) break;
    i = k;
  }
  const at = (k: number) => {
    const kk = ((k % n) + n) % n;
    const wrap = Math.floor(k / n);
    return [keys[kk]![0] + wrap, keys[kk]![1]] as const;
  };
  const p0 = at(i - 1);
  const p1 = at(i);
  const p2 = at(i + 1);
  const p3 = at(i + 2);
  const span = p2[0] - p1[0];
  const f = span > 0 ? (u - p1[0] + (u < p1[0] ? 1 : 0)) / span : 0;
  const f2 = f * f;
  const f3 = f2 * f;
  return (
    0.5 *
    (2 * p1[1] +
      (-p0[1] + p2[1]) * f +
      (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * f2 +
      (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * f3)
  );
}

const RAD = Math.PI / 180;

/**
 * Swing-phase angles (radians) at fraction `u` of the swing (0 = toe-off,
 * 1 = next contact). Faster running tucks the heel higher and drives the knee
 * further; `k` is 0 (slow jog) … 1 (fast).
 */
export function swingAngles(u: number, k: number) {
  const t = TOE_OFF + u * (1 - TOE_OFF);
  // How much of the curve's swing excursion to use at this speed
  const hipScale = 0.8 + 0.4 * k;
  const kneeScale = 0.85 + 0.35 * k;
  const hip0 = sample(HIP, TOE_OFF);
  const knee0 = sample(KNEE, TOE_OFF);
  return {
    hip: (hip0 + (sample(HIP, t) - hip0) * hipScale) * RAD,
    knee: (knee0 + (sample(KNEE, t) - knee0) * kneeScale) * RAD,
    ankle: sample(ANKLE, t) * RAD,
  };
}

/** Smooth 0 → 1. */
export function ease(x: number) {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}
