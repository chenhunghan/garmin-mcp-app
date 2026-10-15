/**
 * The runner: a procedurally modeled athlete (no external assets) animated
 * from the recorded data. The gait is driven by cadence (step frequency),
 * speed and ground contact time (stance length), vertical oscillation (bounce)
 * and grade (lean). Legs use two-bone IK so a planted foot stays put while the
 * body moves over it, rolling from heel strike to toe-off.
 *
 * Conventions: the runner faces +z, its left is +x, y is up. A limb hanging
 * down swings forward with a negative x rotation; the upright spine leans
 * forward with a positive one.
 */
import * as THREE from "three/webgpu";
import {
  blend,
  ellipsoid,
  roundCone,
  skinWeights,
  smin,
  surfaceNets,
  transferWeights,
  type BoneSegment,
} from "./body.ts";
import { ease, swingAngles } from "./gait.ts";

export interface RunnerState {
  /** Ground speed, m/s (real, before playback rate) */
  speed: number;
  /** Steps per minute */
  cadence: number | null;
  /** Ground contact time, ms */
  gct: number | null;
  /** Vertical oscillation, cm */
  vo: number | null;
  grade: number;
  /** Turn rate, rad per meter traveled (for leaning into corners) */
  curvature: number;
  hr: number | null;
  /** HR zone color for the watch face */
  zoneColor: THREE.Color;
  /** Playback rate; the gait animates at most 3× real time */
  rate: number;
}

// Body dimensions (m), a ~1.76 m runner
const ANKLE_H = 0.078;
const SHIN = 0.43;
const THIGH = 0.44;
const HIP_W = 0.088;
const HEEL_BACK = 0.065;
const BALL_FWD = 0.135;
const UPPER_ARM = 0.285;
const FOREARM = 0.255;
const SHOULDER_W = 0.185;
const RAD_ = Math.PI / 180;

const PALETTE = {
  skin: "#c48a68",
  shirt: "#ff5a36",
  shorts: "#1e2633",
  shoe: "#f2f4f7",
  sole: "#ff5a36",
  sock: "#f4f4f2",
  cap: "#1d2229",
  lens: "#0d1014",
  hair: "#2a1d16",
};

/** A body part shaped by revolving a radius profile [y, r] around the y axis. */
function lathe(profile: [number, number][], segments = 28, sx = 1, sz = 1): THREE.BufferGeometry {
  const pts = profile.map(([y, r]) => new THREE.Vector2(Math.max(r, 0.0001), y));
  const geo = new THREE.LatheGeometry(pts, segments);
  geo.scale(sx, 1, sz);
  geo.computeVertexNormals();
  return geo;
}

/** Smooth closed profile from control radii along [y0 → y1] with rounded ends. */
function limbProfile(y0: number, y1: number, radii: number[], steps = 18): [number, number][] {
  const out: [number, number][] = [];
  const n = radii.length - 1;
  for (let k = 0; k <= steps; k++) {
    const u = k / steps;
    const x = u * n;
    const i = Math.min(n - 1, Math.floor(x));
    const f = x - i;
    // Catmull-Rom through the control radii
    const p0 = radii[Math.max(0, i - 1)]!;
    const p1 = radii[i]!;
    const p2 = radii[i + 1]!;
    const p3 = radii[Math.min(n, i + 2)]!;
    const r =
      0.5 *
      (2 * p1 +
        (-p0 + p2) * f +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f +
        (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f);
    out.push([y0 + (y1 - y0) * u, r]);
  }
  // Round caps
  const capR0 = radii[0]!;
  const capR1 = radii[n]!;
  const cap = (y: number, r: number, dir: number) => {
    const pts: [number, number][] = [];
    for (let k = 1; k <= 5; k++) {
      const a = (k / 5) * (Math.PI / 2);
      pts.push([y + dir * Math.sin(a) * r * 0.8, Math.cos(a) * r]);
    }
    return pts;
  };
  return [...cap(y0, capR0, -1).reverse(), ...out, ...cap(y1, capR1, 1)];
}

function shoeGeometry(): { upper: THREE.BufferGeometry; sole: THREE.BufferGeometry } {
  // Side profile (x = forward from the ankle, y = up from the ankle)
  const s = new THREE.Shape();
  s.moveTo(-HEEL_BACK, -ANKLE_H + 0.03);
  s.lineTo(BALL_FWD + 0.05, -ANKLE_H + 0.03);
  s.quadraticCurveTo(BALL_FWD + 0.085, -ANKLE_H + 0.035, BALL_FWD + 0.075, -ANKLE_H + 0.06);
  s.quadraticCurveTo(BALL_FWD + 0.04, -ANKLE_H + 0.085, 0.07, -0.012);
  s.quadraticCurveTo(0.035, 0.018, 0.012, 0.03);
  s.lineTo(-0.045, 0.026);
  s.quadraticCurveTo(-HEEL_BACK - 0.012, 0.012, -HEEL_BACK - 0.01, -0.03);
  s.quadraticCurveTo(-HEEL_BACK - 0.008, -ANKLE_H + 0.035, -HEEL_BACK, -ANKLE_H + 0.03);
  const width = 0.07;
  const upper = new THREE.ExtrudeGeometry(s, {
    depth: width,
    bevelEnabled: true,
    bevelThickness: 0.014,
    bevelSize: 0.012,
    bevelSegments: 4,
    curveSegments: 14,
  });
  upper.translate(0, 0, -width / 2);
  upper.rotateY(-Math.PI / 2);

  const so = new THREE.Shape();
  so.moveTo(-HEEL_BACK - 0.006, -ANKLE_H);
  so.lineTo(BALL_FWD + 0.05, -ANKLE_H);
  so.quadraticCurveTo(BALL_FWD + 0.095, -ANKLE_H + 0.004, BALL_FWD + 0.088, -ANKLE_H + 0.03);
  so.lineTo(-HEEL_BACK - 0.012, -ANKLE_H + 0.034);
  so.quadraticCurveTo(-HEEL_BACK - 0.02, -ANKLE_H + 0.01, -HEEL_BACK - 0.006, -ANKLE_H);
  const sw = 0.088;
  const sole = new THREE.ExtrudeGeometry(so, {
    depth: sw,
    bevelEnabled: true,
    bevelThickness: 0.006,
    bevelSize: 0.005,
    bevelSegments: 3,
    curveSegments: 10,
  });
  sole.translate(0, 0, -sw / 2);
  sole.rotateY(-Math.PI / 2);
  upper.computeVertexNormals();
  sole.computeVertexNormals();
  return { upper, sole };
}

interface Leg {
  hip: THREE.Bone;
  knee: THREE.Bone;
  ankle: THREE.Bone;
  side: 1 | -1;
}

interface Arm {
  shoulder: THREE.Bone;
  elbow: THREE.Bone;
  side: 1 | -1;
}

/** The skinned body and clothes take a moment to mesh: build them once per page. */
let meshCache: {
  body: THREE.BufferGeometry;
  shirt: THREE.BufferGeometry;
  shorts: THREE.BufferGeometry;
  socks: THREE.BufferGeometry;
} | null = null;

export class Runner {
  readonly root = new THREE.Group();
  private pelvis = new THREE.Bone();
  private spine = new THREE.Bone();
  private chest = new THREE.Bone();
  private neck = new THREE.Bone();
  private head = new THREE.Bone();
  private legs: Leg[] = [];
  private arms: Arm[] = [];
  private watchFace!: THREE.MeshStandardNodeMaterial;
  private disposables: { dispose(): void }[] = [];
  private phase = 0;
  private beat = 0;
  private breath = 0;
  private lean = 0;
  private roll = 0;
  private smoothSpeed = 0;
  private clock = 0;
  private chainQ = new THREE.Quaternion();
  private headTarget = new THREE.Quaternion();
  private headEuler = new THREE.Euler();
  private watchParts: THREE.Mesh[] = [];
  private watchHome: {
    parent: THREE.Object3D;
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    scale: THREE.Vector3;
  }[] = [];
  private modelObject: THREE.Object3D | null = null;
  /** Standing height of the attached model in this skeleton's units (m) */
  modelHeight = 1.7;
  /** Character model driven by this skeleton (see attachModel) */
  private model: {
    bones: THREE.Bone[];
    map: Map<THREE.Bone, { driver: THREE.Bone; restInv: THREE.Quaternion; rest: THREE.Quaternion }>;
    pelvis: THREE.Bone;
    pelvisRest: THREE.Vector3;
    driverPelvisRest: THREE.Vector3;
  } | null = null;

  constructor() {
    this.build();
  }

  private mat(color: string, opts: Partial<THREE.MeshPhysicalNodeMaterialParameters> = {}) {
    const m = new THREE.MeshPhysicalNodeMaterial({ color, roughness: 0.6, metalness: 0, ...opts });
    this.disposables.push(m);
    return m;
  }

  private mesh(geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    this.disposables.push(geo);
    return m;
  }

  /** Skeleton: pelvis → spine → chest → neck → head, arms off the chest, legs off the pelvis. */
  private buildSkeleton() {
    this.root.name = "runner";
    this.root.rotation.order = "YXZ";
    this.root.add(this.pelvis);
    this.spine.position.y = 0.1;
    this.pelvis.add(this.spine);
    this.spine.add(this.chest);
    this.neck.position.y = 0.43;
    this.chest.add(this.neck);
    this.head.position.y = 0.1;
    this.neck.add(this.head);
    for (const side of [1, -1] as const) {
      const shoulder = new THREE.Bone();
      shoulder.position.set(side * SHOULDER_W, 0.375, -0.012);
      this.chest.add(shoulder);
      const elbow = new THREE.Bone();
      elbow.position.y = -UPPER_ARM;
      shoulder.add(elbow);
      this.arms.push({ shoulder, elbow, side });
    }
    for (const side of [1, -1] as const) {
      const hip = new THREE.Bone();
      hip.position.set(side * HIP_W, -0.04, 0);
      this.pelvis.add(hip);
      const knee = new THREE.Bone();
      knee.position.y = -THIGH;
      hip.add(knee);
      const ankle = new THREE.Bone();
      ankle.position.y = -SHIN;
      knee.add(ankle);
      this.legs.push({ hip, knee, ankle, side });
    }
  }

  /** Bind pose: standing, arms and legs slightly apart so the mesh doesn't fuse them. */
  private restPose() {
    this.pelvis.position.set(0, ANKLE_H + THIGH + SHIN + 0.04, 0);
    for (const b of this.bones()) b.rotation.set(0, 0, 0);
    for (const a of this.arms) a.shoulder.rotation.z = a.side * 0.42;
    for (const l of this.legs) l.hip.rotation.z = l.side * 0.09;
    this.root.updateMatrixWorld(true);
  }

  private bones(): THREE.Bone[] {
    return [
      this.pelvis,
      this.spine,
      this.chest,
      this.neck,
      this.head,
      ...this.arms.flatMap((a) => [a.shoulder, a.elbow]),
      ...this.legs.flatMap((l) => [l.hip, l.knee, l.ankle]),
    ];
  }

  private build() {
    this.buildSkeleton();
    this.restPose();
    const bones = this.bones();
    const w = (b: THREE.Object3D, x = 0, y = 0, z = 0) =>
      b.localToWorld(new THREE.Vector3(x, y, z));
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

    const pelvisC = w(this.pelvis);
    const spineW = w(this.spine);
    const neckW = w(this.neck);
    const headW = w(this.head);
    const arm = this.arms.map((a) => ({
      side: a.side,
      sh: w(a.shoulder),
      el: w(a.elbow),
      wr: w(a.elbow, 0, -FOREARM, 0),
      hand: w(a.elbow, 0, -FOREARM - 0.05, 0.004),
    }));
    const leg = this.legs.map((l) => ({
      side: l.side,
      hip: w(l.hip),
      knee: w(l.knee),
      ankle: w(l.ankle),
    }));
    const lerpV = (a: THREE.Vector3, b: THREE.Vector3, t: number) => a.clone().lerp(b, t);

    // ── Body field ──
    const torso = [
      ellipsoid(pelvisC.clone().add(V(0, 0.005, -0.005)), V(0.148, 0.11, 0.104)),
      roundCone(
        pelvisC.clone().add(V(0, 0.06, 0)),
        spineW.clone().add(V(0, 0.2, 0.004)),
        0.125,
        0.13,
        0.74,
      ),
      ellipsoid(spineW.clone().add(V(0, 0.27, 0.012)), V(0.152, 0.168, 0.108)),
      ellipsoid(spineW.clone().add(V(0, 0.3, 0.045)), V(0.135, 0.085, 0.085)),
      ellipsoid(spineW.clone().add(V(0, 0.29, -0.05)), V(0.14, 0.13, 0.075)),
      roundCone(
        arm[0]!.sh.clone().add(V(-0.03, -0.005, -0.005)),
        arm[1]!.sh.clone().add(V(0.03, -0.005, -0.005)),
        0.058,
        0.058,
      ),
      ...arm.map((a) =>
        roundCone(
          neckW.clone().add(V(0, 0.03, -0.012)),
          a.sh.clone().add(V(-a.side * 0.04, 0.0, -0.012)),
          0.048,
          0.042,
        ),
      ),
    ];
    const glutes = leg.map((l) =>
      ellipsoid(l.hip.clone().add(V(l.side * 0.004, 0.0, -0.045)), V(0.074, 0.08, 0.062)),
    );
    const neck = roundCone(
      neckW.clone().add(V(0, -0.03, -0.004)),
      headW.clone().add(V(0, 0.035, 0.0)),
      0.054,
      0.047,
    );
    const headParts = [
      ellipsoid(headW.clone().add(V(0, 0.1, 0.0)), V(0.087, 0.107, 0.1)),
      ellipsoid(headW.clone().add(V(0, 0.042, 0.03)), V(0.064, 0.056, 0.07)),
      ellipsoid(headW.clone().add(V(0, 0.016, 0.066)), V(0.03, 0.025, 0.026)),
      ellipsoid(headW.clone().add(V(0, 0.074, 0.098)), V(0.012, 0.022, 0.02)),
      ellipsoid(headW.clone().add(V(0, 0.106, 0.074)), V(0.068, 0.02, 0.034)),
      ellipsoid(headW.clone().add(V(0.087, 0.088, 0.0)), V(0.012, 0.028, 0.02)),
      ellipsoid(headW.clone().add(V(-0.087, 0.088, 0.0)), V(0.012, 0.028, 0.02)),
    ];
    const deltoids = arm.map((a) =>
      ellipsoid(lerpV(a.sh, a.el, 0.1).add(V(a.side * 0.004, 0.006, 0)), V(0.05, 0.064, 0.052)),
    );
    const upperArms = arm.flatMap((a) => [
      roundCone(a.sh, a.el, 0.04, 0.032),
      ellipsoid(lerpV(a.sh, a.el, 0.48).add(V(0, 0, 0.01)), V(0.035, 0.07, 0.037)),
    ]);
    const forearms = arm.flatMap((a) => [
      roundCone(a.el, a.wr, 0.034, 0.022),
      ellipsoid(lerpV(a.el, a.wr, 0.25), V(0.033, 0.065, 0.034)),
      ellipsoid(a.hand, V(0.027, 0.048, 0.042)),
    ]);
    const thighs = leg.flatMap((l) => [
      roundCone(l.hip, l.knee, 0.084, 0.05),
      ellipsoid(lerpV(l.hip, l.knee, 0.42).add(V(0, 0, 0.022)), V(0.068, 0.15, 0.07)),
    ]);
    const shins = leg.flatMap((l) => [
      ellipsoid(l.knee.clone().add(V(0, 0, 0.014)), V(0.048, 0.05, 0.048)),
      roundCone(l.knee, l.ankle, 0.047, 0.03),
      ellipsoid(lerpV(l.knee, l.ankle, 0.3).add(V(0, 0, -0.024)), V(0.047, 0.1, 0.05)),
      ellipsoid(l.ankle, V(0.032, 0.04, 0.036)),
    ]);
    const body = blend(
      [
        ...torso,
        ...glutes,
        neck,
        ...headParts,
        ...deltoids,
        ...upperArms,
        ...forearms,
        ...thighs,
        ...shins,
      ],
      0.03,
    );

    // ── Clothes: the body inflated, then trimmed ──
    const shirtTorso = blend([...torso, ...deltoids], 0.03);
    const cutWaist = pelvisC.y + 0.03;
    const neckline = neckW.clone().add(V(0, 0.005, 0.03));
    const sleeves = arm.map((a) => {
      const dir = a.el.clone().sub(a.sh).normalize();
      const end = a.sh.clone().addScaledVector(dir, UPPER_ARM * 0.42);
      const cone = roundCone(a.sh, a.el, 0.05, 0.043);
      return (x: number, y: number, z: number) =>
        Math.max(
          cone(x, y, z) - 0.004,
          (x - end.x) * dir.x + (y - end.y) * dir.y + (z - end.z) * dir.z,
        );
    });
    const shirt = (x: number, y: number, z: number) => {
      let d = shirtTorso(x, y, z) - 0.014;
      d = smin(d, sleeves[0]!(x, y, z), 0.02);
      d = smin(d, sleeves[1]!(x, y, z), 0.02);
      d = Math.max(d, cutWaist - y);
      d = Math.max(
        d,
        -(Math.hypot(x - neckline.x, (y - neckline.y) * 1.3, z - neckline.z) - 0.072),
      );
      return d;
    };
    // Shorts drape over the glutes: give them a little more room than the skin
    const shortGlutes = leg.map((l) =>
      ellipsoid(l.hip.clone().add(V(l.side * 0.004, 0.0, -0.047)), V(0.082, 0.088, 0.07)),
    );
    const shortsBody = blend([torso[0]!, torso[1]!, ...shortGlutes, ...thighs], 0.035);
    const shortsTop = pelvisC.y + 0.085;
    const shortsHem = leg[0]!.hip.y - 0.2;
    const shorts = (x: number, y: number, z: number) =>
      Math.max(shortsBody(x, y, z) - 0.016, y - shortsTop, shortsHem - y);
    const sockBody = blend(
      shins.filter((_, k) => k % 4 >= 1),
      0.02,
    );
    const sockTop = leg[0]!.ankle.y + 0.085;
    const socks = (x: number, y: number, z: number) =>
      Math.max(sockBody(x, y, z) - 0.004, y - sockTop);

    if (!meshCache) {
      // Clothes stand off the skin: give their boxes room so nothing is clipped open
      const box = body.box.clone().expandByScalar(0.04);
      const shirtBox = new THREE.Box3(
        V(box.min.x, cutWaist - 0.02, box.min.z),
        V(box.max.x, neckW.y + 0.08, box.max.z),
      );
      const shortsBox = new THREE.Box3(
        V(-0.3, shortsHem - 0.03, box.min.z),
        V(0.3, shortsTop + 0.03, box.max.z),
      );
      const sockBox = new THREE.Box3(V(-0.3, 0, -0.12), V(0.3, sockTop + 0.02, 0.12));
      meshCache = {
        // ~8 mm cells: smooth with the field's normals, a fraction of the triangles
        body: surfaceNets(body, box, 0.0085),
        shirt: surfaceNets(shirt, shirtBox, 0.009),
        shorts: surfaceNets(shorts, shortsBox, 0.009),
        socks: surfaceNets(socks, sockBox, 0.007),
      };
    }

    // ── Skinning: each vertex follows its nearest bones ──
    const B = (b: THREE.Bone) => bones.indexOf(b);
    const segments: BoneSegment[] = [
      { bone: B(this.pelvis), a: pelvisC.clone().add(V(0, -0.07, 0)), b: spineW, reach: 1 },
      { bone: B(this.chest), a: spineW.clone().add(V(0, 0.06, 0)), b: neckW, reach: 1 },
      { bone: B(this.neck), a: neckW, b: headW, reach: 1 },
      {
        bone: B(this.head),
        a: headW.clone().add(V(0, 0.04, 0)),
        b: headW.clone().add(V(0, 0.2, 0)),
        reach: 1,
      },
      ...this.arms.flatMap((a, k) => [
        { bone: B(a.shoulder), a: arm[k]!.sh, b: arm[k]!.el, reach: 1 },
        { bone: B(a.elbow), a: arm[k]!.el, b: arm[k]!.hand, reach: 1 },
      ]),
      ...this.legs.flatMap((l, k) => [
        { bone: B(l.hip), a: leg[k]!.hip, b: leg[k]!.knee, reach: 1 },
        { bone: B(l.knee), a: leg[k]!.knee, b: leg[k]!.ankle, reach: 1 },
        {
          bone: B(l.ankle),
          a: leg[k]!.ankle,
          b: leg[k]!.ankle.clone().add(V(0, -0.06, 0.05)),
          reach: 1,
        },
      ]),
    ];
    const skeleton = new THREE.Skeleton(bones);
    let bodyGeo: THREE.BufferGeometry | null = null;
    const skinned = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
      const g = geo.clone();
      if (bodyGeo) transferWeights(g, bodyGeo);
      else {
        skinWeights(g, segments);
        bodyGeo = g;
      }
      const m = new THREE.SkinnedMesh(g, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      this.root.add(m);
      m.updateMatrixWorld(true);
      m.bind(skeleton);
      this.disposables.push(g);
      return m;
    };

    const skin = this.mat(PALETTE.skin, {
      roughness: 0.5,
      sheen: 0.35,
      sheenColor: new THREE.Color("#ffc9b0"),
      sheenRoughness: 0.55,
      specularIntensity: 0.6,
    });
    const shirtMat = this.mat(PALETTE.shirt, {
      roughness: 0.8,
      sheen: 1,
      sheenColor: new THREE.Color("#ffc0aa"),
      sheenRoughness: 0.4,
    });
    const shortsMat = this.mat(PALETTE.shorts, {
      roughness: 0.62,
      sheen: 0.9,
      sheenColor: new THREE.Color("#8696b0"),
      sheenRoughness: 0.35,
    });
    const sockMat = this.mat(PALETTE.sock, {
      roughness: 0.9,
      sheen: 0.6,
      sheenColor: new THREE.Color("#ffffff"),
    });
    skinned(meshCache.body, skin);
    skinned(meshCache.shirt, shirtMat);
    skinned(meshCache.shorts, shortsMat);
    skinned(meshCache.socks, sockMat);

    // ── Rigid accessories ──
    const shoe = this.mat(PALETTE.shoe, {
      roughness: 0.55,
      sheen: 0.5,
      sheenColor: new THREE.Color("#ffffff"),
    });
    const sole = this.mat(PALETTE.sole, { roughness: 0.45, clearcoat: 0.3 });
    const cap = this.mat(PALETTE.cap, {
      roughness: 0.75,
      sheen: 0.6,
      sheenColor: new THREE.Color("#5a6575"),
    });
    const lens = this.mat(PALETTE.lens, {
      roughness: 0.08,
      metalness: 0.4,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      iridescence: 0.6,
    });
    const hair = this.mat(PALETTE.hair, {
      roughness: 0.85,
      sheen: 0.4,
      sheenColor: new THREE.Color("#6a4a3a"),
    });
    const band = this.mat("#15181d", { roughness: 0.5 });
    this.watchFace = new THREE.MeshStandardNodeMaterial({
      color: "#0a0c10",
      emissive: new THREE.Color("#3d8bfd"),
      emissiveIntensity: 1.5,
      roughness: 0.2,
    });
    this.disposables.push(this.watchFace);

    const { upper, sole: soleGeo } = shoeGeometry();
    this.disposables.push(upper, soleGeo);
    for (const l of this.legs) {
      // Slightly trimmed: full-size shoes read clownish at this scale
      for (const part of [
        this.mesh(upper.clone(), shoe, l.ankle),
        this.mesh(soleGeo.clone(), sole, l.ankle),
      ]) {
        part.scale.setScalar(0.88);
        part.position.y = -ANKLE_H * 0.12;
      }
    }
    const left = this.arms.find((a) => a.side === 1)!;
    const strap = this.mesh(new THREE.TorusGeometry(0.027, 0.007, 10, 28), band, left.elbow);
    strap.rotation.x = Math.PI / 2;
    strap.position.y = -FOREARM + 0.03;
    strap.scale.set(1, 0.85, 1);
    const face = this.mesh(
      new THREE.CylinderGeometry(0.018, 0.018, 0.009, 28),
      this.watchFace,
      left.elbow,
    );
    face.rotation.z = Math.PI / 2;
    face.position.set(0.03, -FOREARM + 0.03, 0);
    this.watchParts.push(strap, face);
    this.watchHome = this.watchParts.map((p) => ({
      parent: p.parent!,
      position: p.position.clone(),
      quaternion: p.quaternion.clone(),
      scale: p.scale.clone(),
    }));
    this.buildHead(hair, cap, lens);

    // Back to a neutral standing pose until the first update
    this.restPose();
  }

  private buildHead(hair: THREE.Material, cap: THREE.Material, lens: THREE.Material) {
    const h = this.head;
    // Hair at the back, a short ponytail through the cap
    const back = this.mesh(
      new THREE.SphereGeometry(0.098, 32, 20, 0, Math.PI * 2, 0, Math.PI * 0.6),
      hair,
      h,
    );
    back.position.set(0, 0.108, -0.012);
    back.rotation.x = -0.55;
    back.scale.set(0.93, 1.05, 1.02);
    const tail = this.mesh(lathe(limbProfile(-0.13, 0, [0.012, 0.022, 0.02, 0.01]), 14), hair, h);
    tail.position.set(0, 0.13, -0.096);
    tail.rotation.x = 0.6;
    // Cap: crown + brim
    const crown = this.mesh(
      new THREE.SphereGeometry(0.102, 36, 18, 0, Math.PI * 2, 0, Math.PI * 0.5),
      cap,
      h,
    );
    crown.position.set(0, 0.128, 0.002);
    crown.scale.set(0.95, 0.8, 1.04);
    const brimShape = new THREE.Shape();
    brimShape.absellipse(0, 0, 0.082, 0.072, 0, Math.PI, false, 0);
    const brim = this.mesh(
      new THREE.ExtrudeGeometry(brimShape, {
        depth: 0.005,
        bevelEnabled: true,
        bevelSize: 0.003,
        bevelThickness: 0.002,
        bevelSegments: 3,
        curveSegments: 24,
      }),
      cap,
      h,
    );
    brim.rotation.x = Math.PI / 2 - 0.2;
    brim.position.set(0, 0.132, 0.092);
    // Sunglasses: a curved band of lens
    const glasses = this.mesh(
      new THREE.CylinderGeometry(0.098, 0.098, 0.03, 40, 1, true, -0.95, 1.9),
      lens,
      h,
    );
    glasses.position.set(0, 0.098, 0.006);
    glasses.scale.set(0.94, 1, 1.02);
    (glasses.material as THREE.MeshPhysicalNodeMaterial).side = THREE.DoubleSide;
  }

  /** Ankle position (z, y) and foot pitch for a stance or swing phase. */
  private footPose(p: number, sf: number, stance: number, speed: number, lift: number) {
    // Land just ahead of the hips (not overstriding), push off well behind
    const zTd = stance * 0.3;
    const zOff = -stance * 0.7;
    // Ankle position for a ground contact point c with foot pitch θ (toe up > 0):
    // rotate about the heel when toe-up, about the ball when heel-up
    const ankleFor = (c: number, theta: number) => {
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      if (theta >= 0) {
        const vz = HEEL_BACK;
        const vy = ANKLE_H;
        return { z: c - HEEL_BACK + vz * cos - vy * sin, y: vz * sin + vy * cos };
      }
      const vz = -BALL_FWD;
      const vy = ANKLE_H;
      return { z: c + BALL_FWD + vz * cos - vy * sin, y: vz * sin + vy * cos };
    };
    if (p < sf) {
      const u = p / sf;
      const c = zTd + (zOff - zTd) * u;
      const theta =
        u < 0.12 ? 0.12 * (1 - u / 0.12) : u < 0.55 ? 0 : -1.0 * ((u - 0.55) / 0.45) ** 1.6;
      const a = ankleFor(c, theta);
      return { z: a.z, y: a.y, pitch: theta };
    }
    const u = (p - sf) / (1 - sf);
    const off = ankleFor(zOff, -1.0);
    // Land near-flat (midfoot-ish), foot coming down under the knee
    const td = ankleFor(zTd, 0.12);
    // Cubic Bézier: toe-off → heel recovery (behind, high) → reach → touchdown
    const k = Math.min(1, Math.max(0, (speed - 1.5) / 3.5));
    // Heel snaps up behind after toe-off, knee drives forward, foot drops in
    const p1 = { z: off.z - 0.06 - 0.08 * k, y: off.y + lift * (1.5 + 0.9 * k) };
    const p2 = { z: td.z + 0.06 + 0.04 * k, y: td.y + lift * 0.9 };
    const b = (a: number, b1: number, c: number, d: number) =>
      (1 - u) ** 3 * a + 3 * (1 - u) ** 2 * u * b1 + 3 * (1 - u) * u * u * c + u ** 3 * d;
    const pitch = u < 0.5 ? -1.0 + (0.7 * u) / 0.5 : -0.3 + (0.42 * (u - 0.5)) / 0.5;
    return { z: b(off.z, p1.z, p2.z, td.z), y: b(off.y, p1.y, p2.y, td.y), pitch };
  }

  /**
   * Two-bone IK in the sagittal plane: hip → ankle target, knee bends forward.
   * Returns bone rotations (thigh and knee relative to their parents; ankle
   * relative to the shin, from the foot's pitch in the world).
   */
  private legIK(hipY: number, target: { z: number; y: number; pitch: number }) {
    const dz = target.z;
    const dy = target.y - hipY;
    let L = Math.hypot(dz, dy);
    L = Math.min(L, (THIGH + SHIN) * 0.9995);
    L = Math.max(L, Math.abs(THIGH - SHIN) + 0.01);
    const phi = Math.atan2(dz, -dy);
    const alpha = Math.acos(
      Math.min(1, Math.max(-1, (THIGH * THIGH + L * L - SHIN * SHIN) / (2 * THIGH * L))),
    );
    const beta = Math.acos(
      Math.min(1, Math.max(-1, (THIGH * THIGH + SHIN * SHIN - L * L) / (2 * THIGH * SHIN))),
    );
    const thigh = -(phi + alpha);
    const knee = Math.PI - beta;
    return { thigh, knee, ankle: -target.pitch - thigh - knee };
  }

  update(dt: number, s: RunnerState) {
    // Smooth the speed so GPS noise doesn't jolt the gait
    this.smoothSpeed +=
      (s.speed - this.smoothSpeed) * (1 - Math.exp(-dt * Math.min(s.rate, 4) * 3));
    const moving = Math.max(0, this.smoothSpeed);
    // Running steps on the watch (cadence) mean running, even when the speed
    // reads ~0 (before the GPS locks, or Garmin's smoothed speed lagging the
    // start): the pose runs; the planted foot only travels as far as the
    // runner really moves, so it's running on the spot
    const stepping = (s.cadence ?? 0) > 100;
    const v = stepping ? Math.max(moving, 2.4) : moving;
    const run = Math.min(1, Math.max(0, (v - 0.5) / 1.2));
    const cadence = s.cadence && s.cadence > 60 ? s.cadence : 150 + 9 * v;
    const visualRate = Math.min(s.rate, 3);
    const cycleT = 120 / cadence;
    const gct = (s.gct && s.gct > 120 ? s.gct / 1000 : 0.3 - 0.035 * (v - 2.6)) || 0.27;
    const sf = Math.min(0.62, Math.max(0.26, gct / cycleT));
    // Ground covered under a planted foot, in the animation's time
    const stance =
      Math.min(1.0, (moving * s.rate * Math.max(0.17, gct)) / Math.max(visualRate, 1e-3)) * run;
    const vo = ((s.vo && s.vo > 2 ? s.vo : 8 + 0.6 * (v - 3)) / 100) * run;
    const lift = (0.12 + 0.1 * Math.min(3, Math.max(0, v - 1.8))) * run + 0.01;
    const fast = Math.min(1, Math.max(0, (v - 2.6) / 2.4));

    this.clock += dt * visualRate;
    this.phase = (this.phase + (dt * visualRate * (run > 0.01 ? 1 : 0.15)) / cycleT) % 1;
    const p = this.phase;
    // Stride-to-stride variation: slow, small, never a perfect loop
    const vary = (k: number) =>
      1 +
      0.045 * Math.sin(this.clock * (0.53 + k * 0.17) + k * 2.1) * Math.sin(this.clock * 0.21 + k);

    // Pelvis: lowest just after landing (mid-stance), highest in flight
    const q = (((2 * p - sf * 0.45) % 1) + 1) % 1;
    const hipLow = 0.902 + (1 - run) * 0.04;
    const pelvisY = hipLow + (vo / 2) * (1 - Math.cos(2 * Math.PI * q)) + 0.04;
    this.pelvis.position.y = pelvisY;
    // Stance weight per leg (0 in swing, peaks mid-stance), for the hip drop
    const legPhase = (side: 1 | -1) => (side === 1 ? p : (p + 0.5) % 1);
    const weight = (lp: number) => (lp < sf ? Math.sin((Math.PI * lp) / sf) : 0);
    const wL = weight(legPhase(1));
    const wR = weight(legPhase(-1));
    // Transverse rotation: the swinging leg's hip comes forward with it
    const pelvisYaw = -0.1 * Math.cos(2 * Math.PI * (p - 0.85)) * run * vary(1);
    this.pelvis.rotation.y = pelvisYaw;
    // Obliquity: the swing side drops while the other leg carries the weight
    this.pelvis.rotation.z = 0.055 * (wL - wR) * run;

    // Legs: the planted foot by IK (stays put, rolls heel → toe); the swing leg
    // follows the running curves, bent to start and end exactly at the IK poses
    for (const leg of this.legs) {
      const lp = legPhase(leg.side);
      const hipY = pelvisY - 0.04;
      const ground = (pose: { z: number; y: number; pitch: number }) => {
        pose.y += pose.z * s.grade;
        return pose;
      };
      let a: { thigh: number; knee: number; ankle: number };
      if (lp < sf || run < 0.05) {
        a = this.legIK(hipY, ground(this.footPose(lp, sf, stance, v, lift)));
      } else {
        const u = (lp - sf) / (1 - sf);
        const off = this.legIK(hipY, ground(this.footPose(sf - 1e-4, sf, stance, v, lift)));
        const td = this.legIK(hipY, ground(this.footPose(0, sf, stance, v, lift)));
        const c = swingAngles(u, fast);
        const c0 = swingAngles(0, fast);
        const c1 = swingAngles(1, fast);
        // Curve shape, shifted so it meets the planted poses at both ends
        const w = ease(u);
        const kneeVar = vary(3 + leg.side);
        a = {
          thigh: -c.hip + (off.thigh + c0.hip) * (1 - w) + (td.thigh + c1.hip) * w,
          knee:
            c.knee * kneeVar +
            (off.knee - c0.knee * kneeVar) * (1 - w) +
            (td.knee - c1.knee * kneeVar) * w,
          ankle: -c.ankle + (off.ankle + c0.ankle) * (1 - w) + (td.ankle + c1.ankle) * w,
        };
      }
      leg.hip.rotation.x = a.thigh;
      leg.knee.rotation.x = a.knee;
      leg.ankle.rotation.x = a.ankle;
      // Keep the knees pointing ahead despite the pelvis turning; feet land
      // close to the midline under the body
      leg.hip.rotation.y = -pelvisYaw * 0.7;
      leg.hip.rotation.z = leg.side * (0.03 - 0.045 * weight(lp)) * run;
    }

    // Trunk: forward lean from speed and hill, a small flex on each landing,
    // shoulders counter-rotating against the pelvis
    const targetLean =
      (0.13 + 0.028 * v + Math.max(-0.08, Math.min(0.12, s.grade * 0.7))) * run + 0.02;
    this.lean += (targetLean - this.lean) * (1 - Math.exp(-dt * 4));
    this.spine.rotation.x = this.lean + 0.018 * Math.cos(2 * Math.PI * q) * run;
    this.spine.rotation.y = -pelvisYaw * 0.8;
    this.chest.rotation.y = -pelvisYaw * 1.1 - 0.05 * Math.cos(2 * Math.PI * (p - 0.85)) * run;
    this.chest.rotation.z = -this.pelvis.rotation.z * 0.6;

    // Head: steady and level, eyes on the path ahead, whatever the trunk does
    this.chainQ
      .copy(this.pelvis.quaternion)
      .multiply(this.spine.quaternion)
      .multiply(this.chest.quaternion)
      .invert();
    this.headTarget.setFromEuler(
      this.headEuler.set(0.07 + 0.01 * Math.sin(this.clock * 0.6), 0, 0),
    );
    this.neck.quaternion.copy(this.chainQ).multiply(this.headTarget);
    this.head.rotation.set(0, 0, 0);

    // Arms: driven by the opposite leg and lagging it a little; most of the
    // swing is behind the body; the elbow closes on the way forward and the
    // hand drifts toward the midline
    const armAmp = (24 + 16 * fast) * vary(5) * run + 2;
    for (const arm of this.arms) {
      const opposite = legPhase(arm.side === 1 ? -1 : 1);
      // +1 when the opposite leg's knee is furthest forward
      const f = Math.cos(2 * Math.PI * (opposite - 0.82));
      const flex = (-14 + armAmp * f) * run;
      arm.shoulder.rotation.x = -flex * RAD_;
      arm.shoulder.rotation.z = arm.side * (0.12 - 0.05 * f * run);
      arm.shoulder.rotation.y = -arm.side * (0.12 + 0.12 * (f + 1) * 0.5) * run;
      const elbow = 12 + (66 + 14 * fast + 22 * (f + 1) * 0.5) * run;
      arm.elbow.rotation.x = -elbow * RAD_;
    }

    // Lean into corners: tan(lean) = v²·curvature / g
    const targetRoll = Math.max(-0.3, Math.min(0.3, Math.atan((v * v * s.curvature) / 9.81)));
    this.roll += (targetRoll - this.roll) * (1 - Math.exp(-dt * 3));
    this.pelvis.rotation.x = 0;
    this.root.rotation.z = -this.roll;

    // Breathing and heartbeat (real time, scaled like the gait)
    this.breath += dt * visualRate * (0.4 + 0.25 * run);
    this.chest.scale.setScalar(1 + 0.008 * Math.sin(2 * Math.PI * this.breath));
    const bpm = s.hr ?? 70;
    this.beat = (this.beat + (dt * visualRate * bpm) / 60) % 1;
    const pulse =
      Math.exp(-((this.beat * 6) ** 2)) + 0.5 * Math.exp(-(((this.beat - 0.18) * 7) ** 2));
    this.watchFace.emissive.copy(s.zoneColor);
    this.watchFace.emissiveIntensity = 0.9 + 2.6 * pulse;
    this.driveModel();
  }

  /**
   * Wear a character model (a glTF scene with a game-engine rig: pelvis,
   * spine_01–03, neck_01, head, upperarm/lowerarm/hand, thigh/calf/foot _l/_r)
   * in place of the built-in body. This skeleton keeps running the gait; each
   * frame every mapped model bone takes the same world rotation change from
   * its rest as its driver bone. Limbs are first aligned at rest (the model's
   * A-pose arms onto our arms), and the model is scaled to our leg length so
   * the planted feet stay planted.
   */
  attachModel(model: THREE.Object3D) {
    const root = this.root;
    this.detachModel();
    const keep = { p: root.position.clone(), q: root.quaternion.clone(), s: root.scale.clone() };
    root.position.set(0, 0, 0);
    root.quaternion.identity();
    root.scale.setScalar(1);
    this.restPose();
    root.add(model);
    root.updateMatrixWorld(true);
    const bone = (name: string) => model.getObjectByName(name) as THREE.Bone | undefined;
    const need = ["pelvis", "thigh_l", "calf_l", "foot_l", "head"];
    if (need.some((n) => !bone(n))) {
      root.remove(model);
      root.position.copy(keep.p);
      root.quaternion.copy(keep.q);
      root.scale.copy(keep.s);
      console.warn("[replay] runner model has no game-engine rig; keeping the built-in runner");
      return;
    }
    const wp = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());

    // Scale to our leg length, then stand the feet on our ankles' level
    const legModel =
      wp(bone("thigh_l")!).distanceTo(wp(bone("calf_l")!)) +
      wp(bone("calf_l")!).distanceTo(wp(bone("foot_l")!));
    model.scale.multiplyScalar((THIGH + SHIN) / legModel);
    root.updateMatrixWorld(true);
    const ankle = this.legs[0]!.ankle;
    model.position.y += wp(ankle).y - wp(bone("foot_l")!).y;
    root.updateMatrixWorld(true);

    const leftArm = this.arms.find((a) => a.side === 1)!;
    const rightArm = this.arms.find((a) => a.side === -1)!;
    const leftLeg = this.legs.find((l) => l.side === 1)!;
    const rightLeg = this.legs.find((l) => l.side === -1)!;
    const wrist = (a: Arm) => a.elbow.localToWorld(new THREE.Vector3(0, -FOREARM, 0));
    // model bone, driver bone, and (for limbs) the two points that give each its direction
    const pairs: [string, THREE.Bone, (() => THREE.Vector3) | null, string | null][] = [
      ["pelvis", this.pelvis, null, null],
      ["spine_01", this.spine, null, null],
      ["spine_03", this.chest, null, null],
      ["neck_01", this.neck, null, null],
      ["head", this.head, null, null],
      ["upperarm_l", leftArm.shoulder, () => wp(leftArm.elbow), "lowerarm_l"],
      ["lowerarm_l", leftArm.elbow, () => wrist(leftArm), "hand_l"],
      ["upperarm_r", rightArm.shoulder, () => wp(rightArm.elbow), "lowerarm_r"],
      ["lowerarm_r", rightArm.elbow, () => wrist(rightArm), "hand_r"],
      ["thigh_l", leftLeg.hip, () => wp(leftLeg.knee), "calf_l"],
      ["calf_l", leftLeg.knee, () => wp(leftLeg.ankle), "foot_l"],
      ["thigh_r", rightLeg.hip, () => wp(rightLeg.knee), "calf_r"],
      ["calf_r", rightLeg.knee, () => wp(rightLeg.ankle), "foot_r"],
      ["foot_l", leftLeg.ankle, null, null],
      ["foot_r", rightLeg.ankle, null, null],
    ];
    const map = new Map<
      THREE.Bone,
      { driver: THREE.Bone; restInv: THREE.Quaternion; rest: THREE.Quaternion }
    >();
    for (const [name, driver, driverEnd, modelEnd] of pairs) {
      const b = bone(name);
      if (!b) continue;
      const rest = b.getWorldQuaternion(new THREE.Quaternion());
      if (driverEnd && modelEnd && bone(modelEnd)) {
        // Turn the model's limb onto ours at rest
        const dDir = driverEnd().sub(wp(driver)).normalize();
        const mDir = wp(bone(modelEnd)!).sub(wp(b)).normalize();
        rest.premultiply(new THREE.Quaternion().setFromUnitVectors(mDir, dDir));
      }
      map.set(b, {
        driver,
        restInv: driver.getWorldQuaternion(new THREE.Quaternion()).invert(),
        rest,
      });
    }
    const bones: THREE.Bone[] = [];
    model.traverse((o) => {
      if ((o as THREE.Bone).isBone) bones.push(o as THREE.Bone);
    });
    const pelvis = bone("pelvis")!;
    this.model = {
      bones,
      map,
      pelvis,
      pelvisRest: root.worldToLocal(wp(pelvis)),
      driverPelvisRest: root.worldToLocal(wp(this.pelvis)),
    };

    // The watch goes on the model's left wrist, set in the forearm bone's own
    // frame: its axis runs to the hand (the hand's local position), the face
    // on the outside of the arm, where it was on ours
    const forearm = bone("lowerarm_l");
    const hand = bone("hand_l");
    const entry = forearm && map.get(forearm);
    if (forearm && hand && entry) {
      const axis = hand.position.clone().normalize();
      const len = hand.position.length();
      // Outside of our arm in the world → the bone's frame (as posed at rest)
      const out = new THREE.Vector3(1, 0, 0)
        .applyQuaternion(leftArm.elbow.getWorldQuaternion(new THREE.Quaternion()))
        .applyQuaternion(entry.rest.clone().invert());
      out.addScaledVector(axis, -out.dot(axis)).normalize();
      // Sizes in meters, whatever the bone's scale
      const k = 1 / forearm.getWorldScale(new THREE.Vector3()).x;
      const at = axis.clone().multiplyScalar(len - 0.045 * k);
      const [strap, face] = this.watchParts as [THREE.Mesh, THREE.Mesh];
      forearm.add(strap, face);
      // Strap: the torus lies around its Z axis → around the bone
      strap.position.copy(at);
      strap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
      strap.scale.set(1.12 * k, 0.95 * k, 1.1 * k);
      // Face: the cylinder's Y axis points out of the arm, just above the strap
      face.position.copy(at).addScaledVector(out, 0.031 * k);
      face.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), out);
      face.scale.setScalar(k);
    }
    // Hide the built-in body (skinned body and clothes, head pieces, shoes)
    const inModel = new Set<THREE.Object3D>();
    model.traverse((o) => inModel.add(o));
    const watch = new Set<THREE.Object3D>(this.watchParts);
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && !inModel.has(o) && !watch.has(o)) o.visible = false;
    });

    // Standing height: crown of the head over the soles
    const box = new THREE.Box3();
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && /base|body/i.test(mesh.name)) box.expandByObject(mesh, true);
    });
    if (!box.isEmpty()) this.modelHeight = box.max.y - Math.min(box.min.y, 0);
    this.modelObject = model;

    root.position.copy(keep.p);
    root.quaternion.copy(keep.q);
    root.scale.copy(keep.s);
    root.updateMatrixWorld(true);
  }

  /** Take the character model off again (the watch goes back on our arm). */
  detachModel() {
    if (!this.modelObject) return;
    this.watchParts.forEach((p, k) => {
      const home = this.watchHome[k]!;
      home.parent.add(p);
      p.position.copy(home.position);
      p.quaternion.copy(home.quaternion);
      p.scale.copy(home.scale);
    });
    this.modelObject.removeFromParent();
    this.modelObject = null;
    this.model = null;
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.visible = true;
    });
  }

  private driveModel() {
    const m = this.model;
    if (!m) return;
    this.root.updateMatrixWorld(true);
    // The pelvis travels with ours (bob, sway), offset by the rest difference
    const pos = new THREE.Vector3().copy(this.pelvis.position);
    this.pelvis.parent!.localToWorld(pos);
    this.root.worldToLocal(pos);
    pos.sub(m.driverPelvisRest).add(m.pelvisRest);
    this.root.localToWorld(pos);
    m.pelvis.parent!.worldToLocal(pos);
    m.pelvis.position.copy(pos);
    const q = new THREE.Quaternion();
    const parentQ = new THREE.Quaternion();
    for (const b of m.bones) {
      const e = m.map.get(b);
      if (e) {
        e.driver.getWorldQuaternion(q).multiply(e.restInv).multiply(e.rest);
        b.parent!.getWorldQuaternion(parentQ);
        b.quaternion.copy(parentQ.invert().multiply(q));
      }
      b.updateWorldMatrix(false, false);
    }
  }

  /** World position of the head (for breath puffs and camera targets). */
  headWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.head.getWorldPosition(out).add(new THREE.Vector3(0, 0.08, 0));
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }
}
