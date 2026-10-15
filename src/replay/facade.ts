/**
 * Buildings without textures. OSM footprints become walls whose vertices carry
 * the facade's layout: the window bay (fitted per wall, so no window is cut at
 * a corner), floor height, shop front and a seed. The shader turns that into
 * floors, framed windows with rooms behind the glass (interior mapping),
 * weathering, the sky mirrored in the glass, and rooms lit at night. Roofs get
 * a parapet and, on bigger buildings, a few rooftop units.
 */
import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  abs,
  attribute,
  cameraPosition,
  dot,
  exp,
  float,
  floor,
  fract,
  fwidth,
  max,
  min,
  mix,
  mod,
  normalWorld,
  normalize,
  positionWorld,
  pow,
  reflect,
  select,
  smoothstep,
  step,
  transformNormalToView,
  uniform,
  vec2,
  vec3,
  vertexColor,
} from "three/tsl";
import type { Node } from "three/webgpu";
import type { Building, BuildingKind } from "../geo/types.ts";
import { insidePolygon } from "./map-match.ts";
import type { RoofMaterial, WallMaterial } from "../geo/types.ts";
import { W as WL, WALL_IDS, WALL_NEUTRAL, layerIndex, type SurfaceSet } from "./surfaces.ts";

/**
 * Facade and roof materials (WALL_IDS layer): the building's mapped OSM
 * material first, else what that kind of building is usually clad in — in
 * East Asia, tiled facades; elsewhere render, brick and concrete.
 */
const MAPPED_WALL: Record<WallMaterial, number[]> = {
  plaster: [WL.wall_plaster, WL.wall_render],
  concrete: [WL.wall_concrete],
  brick: [WL.wall_brick],
  stone: [WL.wall_lightbrick],
  glass: [-1],
  metal: [WL.wall_metal],
  wood: [WL.wall_wood],
  tiles: [WL.wall_tiles],
};
const MAPPED_ROOF: Record<RoofMaterial, number> = {
  tiles: WL.roof_tiles,
  slate: WL.roof_slate,
  metal: WL.wall_metal,
  concrete: WL.roof_concrete,
  glass: WL.roof_concrete,
  grass: WL.roof_concrete,
};
/** [layer, weight] choices per building kind, when OSM has no material */
const USUAL_WALL: Record<"eastAsia" | "other", Record<BuildingKind, [number, number][]>> = {
  eastAsia: {
    house: [
      [WL.wall_tiles, 0.45],
      [WL.wall_render, 0.35],
      [WL.wall_concrete, 0.2],
    ],
    apartments: [
      [WL.wall_tiles, 0.6],
      [WL.wall_render, 0.2],
      [WL.wall_concrete, 0.2],
    ],
    shop: [
      [WL.wall_tiles, 0.55],
      [WL.wall_render, 0.3],
      [WL.wall_concrete, 0.15],
    ],
    office: [
      [WL.wall_concrete, 0.5],
      [WL.wall_tiles, 0.3],
      [WL.wall_render, 0.2],
    ],
    industrial: [
      [WL.wall_metal, 0.6],
      [WL.wall_concrete, 0.4],
    ],
    civic: [
      [WL.wall_tiles, 0.4],
      [WL.wall_concrete, 0.35],
      [WL.wall_lightbrick, 0.25],
    ],
    shed: [
      [WL.wall_metal, 0.6],
      [WL.wall_concrete, 0.4],
    ],
  },
  other: {
    house: [
      [WL.wall_plaster, 0.45],
      [WL.wall_brick, 0.35],
      [WL.wall_lightbrick, 0.2],
    ],
    apartments: [
      [WL.wall_render, 0.4],
      [WL.wall_concrete, 0.3],
      [WL.wall_brick, 0.3],
    ],
    shop: [
      [WL.wall_plaster, 0.45],
      [WL.wall_render, 0.35],
      [WL.wall_brick, 0.2],
    ],
    office: [
      [WL.wall_concrete, 0.7],
      [WL.wall_render, 0.3],
    ],
    industrial: [
      [WL.wall_metal, 0.6],
      [WL.wall_concrete, 0.25],
      [WL.wall_brick, 0.15],
    ],
    civic: [
      [WL.wall_lightbrick, 0.4],
      [WL.wall_concrete, 0.35],
      [WL.wall_plaster, 0.25],
    ],
    shed: [
      [WL.wall_wood, 0.5],
      [WL.wall_metal, 0.5],
    ],
  },
};
function pick(choices: [number, number][], r: number): number {
  for (const [v, w] of choices) {
    if (r < w) return v;
    r -= w;
  }
  return choices[0]![0];
}
/** Lon/lat inside East Asia (China, Taiwan, Korea, Japan, Hong Kong) */
export function inEastAsia(lat: number, lon: number) {
  return lat > 18 && lat < 46 && lon > 100 && lon < 146;
}

interface Style {
  /** Window bay width (m); 0 = no windows */
  bay: number;
  floor: number;
  /** Shop front / lobby height (m); 0 = none */
  ground: number;
  /** Window width as a share of the bay; sill and head height in the floor (m) */
  win: number;
  sill: number;
  head: number;
  /** Share of rooms lit at night, and of those lit in cool white */
  lit: number;
  cool: number;
  parapet: number;
  /** Metal cladding with vertical ribs */
  clad?: boolean;
  walls: string[];
  roofs: string[];
  glass: string;
}

const STYLE: Record<BuildingKind, Style> = {
  house: {
    bay: 3.2,
    floor: 2.8,
    ground: 0,
    win: 0.4,
    sill: 0.9,
    head: 2.1,
    lit: 0.45,
    cool: 0.2,
    parapet: 0,
    walls: ["#e4dccd", "#d8cbb4", "#c9b79c", "#ebe6dc", "#b9a58e", "#d9d2c4"],
    roofs: ["#8c4a36", "#6d6762", "#9b5a40", "#5d5550"],
    glass: "#1c2125",
  },
  apartments: {
    bay: 3.1,
    floor: 3,
    ground: 0,
    win: 0.5,
    sill: 0.85,
    head: 2.35,
    lit: 0.5,
    cool: 0.3,
    parapet: 0.9,
    walls: ["#dcd6ca", "#cfc7b8", "#bfb5a5", "#e6e1d6", "#c4b8a8", "#a9a49c"],
    roofs: ["#7b7672", "#6a6662", "#86807a"],
    glass: "#1b2024",
  },
  shop: {
    bay: 3.8,
    floor: 3.4,
    ground: 4.2,
    win: 0.55,
    sill: 0.9,
    head: 2.6,
    lit: 0.55,
    cool: 0.45,
    parapet: 0.8,
    walls: ["#d9d1c3", "#c8bba6", "#e1dbd0", "#b8aea2"],
    roofs: ["#77726e", "#6c6865"],
    glass: "#1d2328",
  },
  office: {
    bay: 2.1,
    floor: 3.7,
    ground: 4.6,
    win: 0.84,
    sill: 0.4,
    head: 3.25,
    lit: 0.5,
    cool: 0.85,
    parapet: 1,
    walls: ["#c9ccd0", "#b5b9be", "#d6d4ce", "#9fa5ab"],
    roofs: ["#73777b", "#686c70"],
    glass: "#22313b",
  },
  industrial: {
    bay: 6.5,
    floor: 5,
    ground: 0,
    win: 0.36,
    sill: 3,
    head: 4.2,
    lit: 0.15,
    cool: 0.9,
    parapet: 0.4,
    clad: true,
    walls: ["#a9aeb1", "#bcbcb4", "#8f9a9e", "#c6c0b2", "#9c8f83"],
    roofs: ["#7e8386", "#6f7477", "#8b8f90"],
    glass: "#262c30",
  },
  civic: {
    bay: 3.6,
    floor: 3.9,
    ground: 0,
    win: 0.55,
    sill: 1,
    head: 3.05,
    lit: 0.3,
    cool: 0.6,
    parapet: 0.8,
    walls: ["#d8cfc0", "#c7b9a3", "#e2dcd0", "#b8a48c"],
    roofs: ["#7a6f68", "#8b5745", "#6e6a66"],
    glass: "#1e2529",
  },
  shed: {
    bay: 0,
    floor: 3,
    ground: 0,
    win: 0,
    sill: 0,
    head: 0,
    lit: 0,
    cool: 0,
    parapet: 0,
    walls: ["#b9b1a5", "#9d968c", "#a5a9ab"],
    roofs: ["#5f5b57", "#7a6e66"],
    glass: "#202428",
  },
};

/** Parts, in the shader's `aFacade.z` */
const WALL = 0;
const ROOF = 1;
const PLAIN = 2;
const UNIT = 3;
const CLAD = 4;

/** Growable float buffer: one per attribute, so big cities don't keep JS arrays. */
class Floats {
  data: Float32Array;
  length = 0;
  constructor(cap: number) {
    this.data = new Float32Array(cap);
  }
  push(...v: number[]) {
    if (this.length + v.length > this.data.length) {
      const next = new Float32Array(Math.max(this.data.length * 2, this.length + v.length));
      next.set(this.data);
      this.data = next;
    }
    this.data.set(v, this.length);
    this.length += v.length;
  }
  get array() {
    return this.data.subarray(0, this.length);
  }
}

function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export interface FacadeInput {
  building: Building;
  /** Lowest ground under the footprint (scene y) */
  ground: number;
  /** Wall height above `ground` */
  height: number;
  /** Close to the route: worth balconies */
  near: boolean;
  /** Stable per building (its index in the map), so a tile split doesn't reshuffle looks */
  seed: number;
}

export interface Balcony {
  matrix: THREE.Matrix4;
  color: THREE.Color;
}

/** Share of buildings with balconies, by use */
const BALCONIES: Partial<Record<BuildingKind, number>> = {
  apartments: 0.65,
  shop: 0.35,
  house: 0.2,
};
const MAX_BALCONIES = 20000;

export function buildingsGeometry(
  list: FacadeInput[],
  /** Balconies left to place, shared across calls */
  budget = { balconies: MAX_BALCONIES },
  region: "eastAsia" | "other" = "other",
): {
  geometry: THREE.BufferGeometry | null;
  balconies: Balcony[];
} {
  const cap = list.length * 300;
  const pos = new Floats(cap * 3);
  const nor = new Floats(cap * 3);
  const col = new Floats(cap * 3);
  const fac = new Floats(cap * 4);
  const bld = new Floats(cap * 4);
  const win = new Floats(cap * 4);
  const gls = new Floats(cap * 4);
  const srf = new Floats(cap);
  const balconies: Balcony[] = [];
  const tmp = new THREE.Color();

  list.forEach(({ building: b, ground, height, near, seed: index }) => {
    const st = STYLE[b.kind] ?? STYLE.house;
    const r = rng(index + 1);
    const seed = Math.floor(r() * 4096) / 4096;
    const base = ground - 0.4;

    // Rings wound one way (signed area < 0), so the outward normal is (−dz, dx)
    let pts = b.pts;
    let area = 0;
    for (let i = 0; i < pts.length; i += 2) {
      const j = (i + 2) % pts.length;
      area += pts[i]! * pts[j + 1]! - pts[j]! * pts[i + 1]!;
    }
    if (area > 0) {
      const rev: number[] = [];
      for (let i = pts.length - 2; i >= 0; i -= 2) rev.push(pts[i]!, pts[i + 1]!);
      pts = rev;
    }
    const plan = Math.abs(area) / 2;
    const n = pts.length / 2;
    const px = (i: number) => pts[(((i % n) + n) % n) * 2]!;
    const pz = (i: number) => pts[(((i % n) + n) % n) * 2 + 1]!;

    // Walls run from corner to corner (a turn of more than 25°); collinear
    // OSM nodes in between don't restart the window rhythm
    const corners: number[] = [];
    for (let i = 0; i < n; i++) {
      const ax = px(i) - px(i - 1);
      const az = pz(i) - pz(i - 1);
      const bx = px(i + 1) - px(i);
      const bz = pz(i + 1) - pz(i);
      const la = Math.hypot(ax, az);
      const lb = Math.hypot(bx, bz);
      if (la < 0.01 || lb < 0.01) continue;
      if ((ax * bx + az * bz) / (la * lb) < Math.cos((25 * Math.PI) / 180)) corners.push(i);
    }
    if (!corners.length) corners.push(0);

    // Pitched roofs on four-cornered footprints: OSM's roof:shape, or a mapped house
    const shapeKind = b.roof === "pitched" ? (r() < 0.55 ? "gabled" : "hipped") : b.roof;
    const pitched =
      corners.length === 4 &&
      plan < 1200 &&
      (shapeKind === "gabled" || shapeKind === "hipped" || shapeKind === "pyramidal");
    let ridgeH = 0;
    if (pitched) {
      const e = (i: number) =>
        Math.hypot(
          px(corners[(i + 1) % 4]!) - px(corners[i]!),
          pz(corners[(i + 1) % 4]!) - pz(corners[i]!),
        );
      ridgeH = THREE.MathUtils.clamp(Math.min(e(0) + e(2), e(1) + e(3)) * 0.21, 1.2, 4.5);
    }
    const top = Math.max(2.9, height + 0.4 - ridgeH); // wall top above base
    const parapet = height > 6 && !pitched ? st.parapet : 0;
    // Floors: from OSM's level count where it has one
    const groundH = st.ground && height > st.ground + 3 ? st.ground : 0;
    let floorH = st.floor;
    if (b.levels && b.levels > (groundH ? 1 : 0)) {
      const upper = groundH ? b.levels - 1 : b.levels;
      floorH = THREE.MathUtils.clamp((top - 0.4 - groundH - parapet * 0.5) / upper, 2.5, 6.5);
    }
    // Usable height for windows (v measured from the lowest ground)
    const usable = top - 0.4 - parapet - 0.3;
    const wall = tmp.set(b.colour ?? st.walls[Math.floor(r() * st.walls.length)]!);
    wall.offsetHSL(0, (r() - 0.5) * 0.03, (r() - 0.5) * 0.05).multiplyScalar(0.72);
    const wallC = [wall.r, wall.g, wall.b] as const;
    const roof = new THREE.Color(st.roofs[Math.floor(r() * st.roofs.length)]!);
    if (pitched && b.kind === "house")
      roof.set(["#8c4a36", "#5d5550", "#9b5a40", "#4f5559"][Math.floor(r() * 4)]!);
    if (b.roofColour) roof.set(b.roofColour).multiplyScalar(0.8);
    // Scanned materials: mapped, else usual for the kind and region
    const mappedWall = b.material ? MAPPED_WALL[b.material] : null;
    const wallLayer = mappedWall
      ? mappedWall[Math.floor(r() * mappedWall.length)]!
      : st.clad
        ? WL.wall_metal
        : pick(USUAL_WALL[region][b.kind] ?? USUAL_WALL[region].house, r());
    const roofLayer = b.roofMaterial
      ? MAPPED_ROOF[b.roofMaterial]
      : pitched
        ? region === "eastAsia" || r() < 0.35
          ? WL.roof_slate
          : WL.roof_tiles
        : WL.roof_concrete;
    const glass = new THREE.Color(st.glass).offsetHSL(0, 0, (r() - 0.5) * 0.03);
    // Window proportions vary from building to building: some wide bands,
    // some tall, most in between
    const shape = r();
    const winShare = Math.min(0.92, st.win * (shape < 0.2 ? 1.45 : 0.8 + r() * 0.35));
    const scale = Math.sqrt(floorH / st.floor); // taller storeys, taller windows
    const sill = Math.max(0.2, st.sill * scale * (shape > 0.8 ? 0.55 : 0.85 + r() * 0.3));
    const head = Math.min(floorH - 0.35, st.head * scale * (0.95 + r() * 0.1));
    const lit = st.lit * (0.4 + r() * 1.1);

    // Balconies: on the long walls of some buildings near the route; their
    // windows become doors
    const hasBalconies =
      near &&
      st.bay > 0 &&
      r() < (BALCONIES[b.kind] ?? 0) &&
      usable > groundH + floorH * (groundH ? 1 : 2) &&
      budget.balconies > 0;
    const balcEvery = r() < 0.55 ? 1 : 2;
    const balcDepth = 0.9 + r() * 0.5;
    // Parapets in the wall's colour, or a paler render
    const balcColor = new THREE.Color(...wallC).multiplyScalar(r() < 0.6 ? 1.04 : 1.18);

    const attrs = (u: number, v: number, part: number, bay: number, sl = sill) => {
      srf.push(part === ROOF ? roofLayer : part === UNIT ? WL.roof_concrete : wallLayer);
      fac.push(u, v, part, usable);
      bld.push(bay, floorH, groundH, seed);
      win.push(winShare, sl, head, lit);
      gls.push(glass.r, glass.g, glass.b, st.cool);
    };
    const quad = (
      ax: number,
      az: number,
      bx: number,
      bz: number,
      y0: number,
      y1: number,
      u0: number,
      u1: number,
      part: number,
      bay: number,
      inward: boolean,
      sl = sill,
    ) => {
      const len = Math.hypot(bx - ax, bz - az) || 1;
      let nx = -(bz - az) / len;
      let nz = (bx - ax) / len;
      // Triangles a-b-c, a-c-d face along (−dz, dx); inward faces swap the order
      const corners4 = [
        [ax, y0, az, u0],
        [bx, y0, bz, u1],
        [bx, y1, bz, u1],
        [ax, y1, az, u0],
      ] as const;
      const order = inward ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
      if (inward) {
        nx = -nx;
        nz = -nz;
      }
      for (const o of order) {
        const [x, y, z, u] = corners4[o]!;
        pos.push(x, y, z);
        nor.push(nx, 0, nz);
        col.push(wallC[0], wallC[1], wallC[2]);
        attrs(u, y - ground, part, bay, sl);
      }
    };
    /** A triangle facing away from the building's middle */
    const cxm = pts.reduce((a, v, i) => (i % 2 ? a : a + v), 0) / n;
    const czm = pts.reduce((a, v, i) => (i % 2 ? a + v : a), 0) / n;
    const tri = (
      p: THREE.Vector3,
      q: THREE.Vector3,
      s: THREE.Vector3,
      part: number,
      c: THREE.Color,
    ) => {
      const nn = new THREE.Vector3().subVectors(q, p).cross(new THREE.Vector3().subVectors(s, p));
      if (nn.lengthSq() < 1e-8) return;
      nn.normalize();
      const mid = new THREE.Vector3().add(p).add(q).add(s).divideScalar(3);
      const out = nn.dot(mid.sub(new THREE.Vector3(cxm, base + top - 1, czm))) > 0;
      if (!out) nn.negate();
      for (const v of out ? [p, q, s] : [p, s, q]) {
        pos.push(v.x, v.y, v.z);
        nor.push(nn.x, nn.y, nn.z);
        col.push(c.r, c.g, c.b);
        attrs(0, v.y - ground, part, 0);
      }
    };

    const runs: { from: number; to: number; len: number }[] = [];
    for (let c = 0; c < corners.length; c++) {
      const from = corners[c]!;
      const to = c + 1 < corners.length ? corners[c + 1]! : corners[0]! + n;
      let len = 0;
      for (let i = from; i < to; i++) len += Math.hypot(px(i + 1) - px(i), pz(i + 1) - pz(i));
      runs.push({ from, to, len });
    }
    const longest = Math.max(...runs.map((w) => w.len));

    const wallPart = st.clad ? CLAD : WALL;
    for (const { from, to, len } of runs) {
      const bays = st.bay > 0 && len >= 2.2 ? Math.max(1, Math.round(len / st.bay)) : 0;
      const bay = bays ? len / bays : 0;
      const balc = hasBalconies && bays >= 2 && len >= 5 && len >= longest * 0.45;
      const sl = balc ? 0.06 : sill;
      let s = 0;
      for (let i = from; i < to; i++) {
        const l = Math.hypot(px(i + 1) - px(i), pz(i + 1) - pz(i));
        if (l < 0.01) continue;
        const u0 = bays ? (s / len) * bays : 0;
        const u1 = bays ? ((s + l) / len) * bays : 0;
        quad(
          px(i),
          pz(i),
          px(i + 1),
          pz(i + 1),
          base,
          base + top,
          u0,
          u1,
          wallPart,
          bay,
          false,
          sl,
        );
        if (parapet)
          quad(
            px(i),
            pz(i),
            px(i + 1),
            pz(i + 1),
            base + top - parapet,
            base + top,
            0,
            0,
            PLAIN,
            0,
            true,
          );
        if (balc) {
          const dx = (px(i + 1) - px(i)) / l;
          const dz = (pz(i + 1) - pz(i)) / l;
          const basis = new THREE.Matrix4().makeBasis(
            new THREE.Vector3(dx, 0, dz),
            new THREE.Vector3(0, 1, 0),
            new THREE.Vector3(-dz, 0, dx),
          );
          for (let j = 0; j < bays; j++) {
            if (j % balcEvery) continue;
            const sc = (j + 0.5) * bay; // the bay's middle, along the wall
            if (sc < s || sc >= s + l) continue;
            const x = px(i) + dx * (sc - s);
            const z = pz(i) + dz * (sc - s);
            for (let row = groundH ? 0 : 1; ; row++) {
              const v = groundH + row * floorH;
              if (v + floorH > usable || budget.balconies <= 0) break;
              budget.balconies--;
              const m = basis.clone().scale(new THREE.Vector3(bay * 0.86, 1, balcDepth));
              m.setPosition(x, ground + v, z);
              balconies.push({ matrix: m, color: balcColor });
            }
          }
        }
        s += l;
      }
    }

    const roofY = base + top - parapet;
    if (pitched) {
      // Long walls A–B and C–D, short ends B–C and D–A; the ridge runs between
      // the ends' midpoints, pulled in for hips (to a point for a pyramid)
      const P = corners.map((c) => new THREE.Vector3(px(c), roofY, pz(c)));
      const e = (i: number) => P[i]!.distanceTo(P[(i + 1) % 4]!);
      const o = e(0) + e(2) >= e(1) + e(3) ? 0 : 1;
      const [A, B, C, D] = [0, 1, 2, 3].map((i) => P[(i + o) % 4]!) as [
        THREE.Vector3,
        THREE.Vector3,
        THREE.Vector3,
        THREE.Vector3,
      ];
      const mBC = B.clone().add(C).multiplyScalar(0.5);
      const mDA = D.clone().add(A).multiplyScalar(0.5);
      const axis = mBC.clone().sub(mDA);
      const run = axis.length();
      axis.normalize();
      const short = (B.distanceTo(C) + D.distanceTo(A)) / 2;
      const inset =
        shapeKind === "gabled"
          ? 0
          : shapeKind === "pyramidal"
            ? run / 2
            : Math.min(short / 2, run / 2);
      const r1 = mDA
        .clone()
        .addScaledVector(axis, inset)
        .setY(roofY + ridgeH);
      const r2 = mBC
        .clone()
        .addScaledVector(axis, -inset)
        .setY(roofY + ridgeH);
      // Shingle courses come from the shader; gable ends are wall
      const endPart = inset > 0.01 ? ROOF : PLAIN;
      const endColor = inset > 0.01 ? roof : new THREE.Color(...wallC);
      tri(A, B, r2, ROOF, roof);
      tri(A, r2, r1, ROOF, roof);
      tri(C, D, r1, ROOF, roof);
      tri(C, r1, r2, ROOF, roof);
      tri(B, C, r2, endPart, endColor);
      tri(D, A, r1, endPart, endColor);
    } else {
      // Flat roof (inside the parapet, if any)
      const contour: THREE.Vector2[] = [];
      for (let i = 0; i < n; i++) contour.push(new THREE.Vector2(px(i), pz(i)));
      for (const t of THREE.ShapeUtils.triangulateShape(contour, [])) {
        const [a, b2, c] = t.map((i) => contour[i]!) as [
          THREE.Vector2,
          THREE.Vector2,
          THREE.Vector2,
        ];
        // Upward-facing: (b − a) × (c − a) has +y when (bz−az)(cx−ax) > (bx−ax)(cz−az)
        const up = (b2.y - a.y) * (c.x - a.x) - (b2.x - a.x) * (c.y - a.y) > 0;
        for (const p of up ? [a, b2, c] : [a, c, b2]) {
          pos.push(p.x, roofY, p.y);
          nor.push(0, 1, 0);
          col.push(roof.r, roof.g, roof.b);
          attrs(0, roofY - ground, ROOF, 0);
        }
      }
    }

    // Rooftop units on flat roofs: air handlers, lift rooms
    if (!pitched && height > 8 && plan > 120 && b.kind !== "house" && b.kind !== "shed") {
      let x0 = Infinity;
      let x1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      for (let i = 0; i < n; i++) {
        x0 = Math.min(x0, px(i));
        x1 = Math.max(x1, px(i));
        z0 = Math.min(z0, pz(i));
        z1 = Math.max(z1, pz(i));
      }
      const count = 1 + Math.floor(r() * Math.min(4, plan / 150));
      const unitC = new THREE.Color().setScalar(0.55 + r() * 0.2);
      for (let u = 0, tries = 0; u < count && tries < 20; tries++) {
        const w = 1.4 + r() * 2.2;
        const d = 1.2 + r() * 2;
        const h = 0.9 + r() * 1.4;
        const cx = x0 + r() * (x1 - x0);
        const cz = z0 + r() * (z1 - z0);
        const m = 1.2;
        const ok = [
          [cx - w / 2 - m, cz - d / 2 - m],
          [cx + w / 2 + m, cz - d / 2 - m],
          [cx + w / 2 + m, cz + d / 2 + m],
          [cx - w / 2 - m, cz + d / 2 + m],
        ].every(([x, z]) => insidePolygon(x!, z!, pts));
        if (!ok) continue;
        u++;
        box(cx, roofY, cz, w, h, d, unitC);
      }
    }

    function box(
      cx: number,
      y: number,
      cz: number,
      w: number,
      h: number,
      d: number,
      c: THREE.Color,
    ) {
      for (const [nn, q] of BOX_FACES) {
        for (const o of [0, 1, 2, 0, 2, 3]) {
          pos.push(cx + (q[o * 3]! * w) / 2, y + q[o * 3 + 1]! * h, cz + (q[o * 3 + 2]! * d) / 2);
          nor.push(nn[0]!, nn[1]!, nn[2]!);
          col.push(c.r, c.g, c.b);
          attrs(0, 0, UNIT, 0);
        }
      }
    }
  });

  if (!pos.length) return { geometry: null, balconies };
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos.array.slice(), 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nor.array.slice(), 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col.array.slice(), 3));
  geo.setAttribute("aFacade", new THREE.BufferAttribute(fac.array.slice(), 4));
  geo.setAttribute("aBldg", new THREE.BufferAttribute(bld.array.slice(), 4));
  geo.setAttribute("aWin", new THREE.BufferAttribute(win.array.slice(), 4));
  geo.setAttribute("aGlass", new THREE.BufferAttribute(gls.array.slice(), 4));
  geo.setAttribute("aSurf", new THREE.BufferAttribute(srf.array.slice(), 1));
  geo.computeBoundingSphere();
  return { geometry: geo, balconies };
}

/** Box faces: normal, then 4 corners in [−1, 1] × [0, 1] × [−1, 1], counter-clockwise from outside */
const BOX_FACES: [number[], number[]][] = [
  [
    [0, 1, 0],
    [-1, 1, 1, 1, 1, 1, 1, 1, -1, -1, 1, -1],
  ],
  [
    [1, 0, 0],
    [1, 0, 1, 1, 0, -1, 1, 1, -1, 1, 1, 1],
  ],
  [
    [-1, 0, 0],
    [-1, 0, -1, -1, 0, 1, -1, 1, 1, -1, 1, -1],
  ],
  [
    [0, 0, 1],
    [-1, 0, 1, 1, 0, 1, 1, 1, 1, -1, 1, 1],
  ],
  [
    [0, 0, -1],
    [1, 0, -1, -1, 0, -1, -1, 1, -1, 1, 1, -1],
  ],
];

/**
 * Balconies as instanced meshes: a slab with a solid parapet in front
 * and low side walls, unit-sized (x across the bay, z out from the wall).
 */
export function balconyParts(): { geometry: THREE.BufferGeometry; material: THREE.Material } {
  const part = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) =>
    new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).translate(
      (x0 + x1) / 2,
      (y0 + y1) / 2,
      (z0 + z1) / 2,
    );
  const geo = mergeGeometries([
    part(-0.5, 0.5, -0.16, 0, 0, 1), // slab
    part(-0.5, 0.5, 0, 1.05, 0.93, 1), // front parapet
    part(-0.5, -0.46, 0, 1.05, 0, 0.93), // sides
    part(0.46, 0.5, 0, 1.05, 0, 0.93),
  ])!;
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
  return { geometry: geo, material: mat };
}

/** One tile's balconies, sharing the geometry and material from `balconyParts`. */
export function balconyMesh(
  list: Balcony[],
  parts: { geometry: THREE.BufferGeometry; material: THREE.Material },
): THREE.InstancedMesh | null {
  if (!list.length) return null;
  const mesh = new THREE.InstancedMesh(parts.geometry, parts.material, list.length);
  list.forEach((b, i) => {
    mesh.setMatrixAt(i, b.matrix);
    mesh.setColorAt(i, b.color);
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.computeBoundingSphere();
  return mesh;
}

/** Set by the scene with the sun: how dark it is, and the sky the glass mirrors. */
export const facadeLight = {
  night: uniform(0),
  day: uniform(1),
  horizon: uniform(new THREE.Color(0.8, 0.84, 0.9)),
  zenith: uniform(new THREE.Color(0.45, 0.6, 0.85)),
};

/** Hoskins' hash (vec2 → [0, 1)), on integers only: the seed is interpolated. */
function hash(p: Node<"vec2">) {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031));
  const q = p3.add(dot(p3, vec3(p3.y, p3.z, p3.x).add(33.33)));
  return fract(q.x.add(q.y).mul(q.z));
}

type N = Node<"float">;
/** Anti-aliased [a, b] window along x, filter width w */
function box(x: N, a: N, b: N, w: N) {
  return smoothstep(a.sub(w), a.add(w), x).mul(float(1).sub(smoothstep(b.sub(w), b.add(w), x)));
}

export function facadeMaterial(surfaces: SurfaceSet | null = null) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0 });
  const F = attribute("aFacade", "vec4");
  const B = attribute("aBldg", "vec4");
  const W = attribute("aWin", "vec4");
  const G = attribute("aGlass", "vec4");
  const u = F.x;
  const v = F.y;
  const part = F.z;
  const usable = F.w;
  const bayW = B.x;
  const floorH = B.y;
  const groundH = B.z;
  const seed = B.w;

  const isWall = float(1).sub(step(0.5, part)).add(step(3.5, part)); // walls and clad walls
  const isClad = step(3.5, part);
  const hasBays = step(0.01, bayW);
  const hasGround = step(0.01, groundH);
  const inGround = hasGround.mul(step(v, groundH));

  // Cell (one bay × one floor; the shop front is one tall cell)
  const v2 = v.sub(groundH);
  const row = floor(v2.div(floorH));
  const fy = fract(v2.div(floorH));
  const col = floor(u);
  const fx = fract(u);
  const cellH = mix(floorH, max(groundH, 0.1), inGround);
  const cfy = mix(fy, v.div(max(groundH, 0.1)), inGround);
  const sid = floor(seed.mul(4096).add(0.5));
  const room = vec2(
    col.add(mod(sid, 61).mul(17)),
    mix(row, float(-7), inGround).add(mod(sid, 53).mul(13)),
  );
  const h1 = hash(room);
  const h2 = hash(room.add(3.1));
  const h3 = hash(room.add(7.7));
  const h4 = hash(room.add(12.1));
  const h5 = hash(room.add(19.4));
  const bh = hash(vec2(sid, 5));

  const halfW = W.x.mul(0.5);
  const wx0 = mix(float(0.5).sub(halfW), float(0.05), inGround);
  const wx1 = mix(float(0.5).add(halfW), float(0.95), inGround);
  const wy0 = mix(W.y.div(floorH), float(0.25).div(cellH), inGround);
  const wy1 = mix(W.z.div(floorH), cellH.sub(1).div(cellH), inGround);
  const fitsUp = step(row.add(1).mul(floorH).add(groundH), usable);
  const valid = max(inGround, fitsUp).mul(step(0, v)).mul(isWall).mul(hasBays);

  const ax = fwidth(u).mul(0.75);
  // (filter widths from the continuous coordinates: fract() jumps at every
  // floor line, and its derivative there leaked slivers of window light)
  const ay = fwidth(v).div(cellH).mul(0.75);
  const inWin = box(fx, wx0, wx1, ax)
    .mul(box(cfy, wy0, wy1, ay))
    .mul(valid);
  const fwx = float(0.07).div(max(bayW, 0.5));
  const fwy = float(0.07).div(cellH);
  const inner = box(fx, wx0.add(fwx), wx1.sub(fwx), ax).mul(
    box(cfy, wy0.add(fwy), wy1.sub(fwy), ay),
  );
  // A mullion down the middle of wide windows, and of shop fronts every bay
  const wideWin = step(1.7, wx1.sub(wx0).mul(bayW));
  const mullion = box(fx, float(0.5).sub(fwx.mul(0.5)), float(0.5).add(fwx.mul(0.5)), ax).mul(
    wideWin,
  );
  const paneSharp = inWin.mul(inner).mul(float(1).sub(mullion));
  const frameSharp = inWin.sub(paneSharp).max(0);
  // Far away the pattern is finer than a pixel: fade to its average
  const far = smoothstep(0.18, 0.5, max(ax, ay));
  const avg = wx1.sub(wx0).mul(wy1.sub(wy0)).mul(valid);
  const pane = mix(paneSharp, avg.mul(0.85), far);
  const frame = mix(frameSharp, avg.mul(0.15), far);

  // Rooms behind the glass: intersect the view ray with a box behind the wall
  const V = normalize(positionWorld.sub(cameraPosition));
  const Nw = normalWorld;
  const T = vec3(Nw.z, 0, Nw.x.negate());
  const rx = dot(V, T);
  const ry = V.y;
  const rz = dot(V, Nw).negate().max(0.001);
  const cellW = max(bayW, 0.5);
  const depth = mix(float(4), float(7), inGround);
  const cx = fx.mul(cellW);
  const cy = cfy.mul(cellH);
  const tx = select(rx.greaterThan(0), cellW.sub(cx), cx).div(abs(rx).max(0.001));
  const ty = select(ry.greaterThan(0), cellH.sub(cy), cy).div(abs(ry).max(0.001));
  const tz = depth.div(rz);
  const t = min(tx, min(ty, tz));
  const isY = step(ty, min(tx, tz));
  const isZ = step(tz, min(tx, ty)).mul(float(1).sub(isY));
  const isX = float(1).sub(isY).sub(isZ);
  const hitY = cy.add(ry.mul(t));
  const hitZ = rz.mul(t).div(depth);
  // Room surfaces: a pale ceiling, a darker floor, furniture along the back wall
  const wallTint = mix(vec3(0.86, 0.78, 0.66), vec3(0.72, 0.74, 0.76), h2);
  const albedo = isY
    .mul(select(ry.greaterThan(0), float(0.95), float(0.42)))
    .add(isZ.mul(mix(float(0.42), float(1), step(0.85, hitY))))
    .add(isX.mul(0.85));
  const roomCol = wallTint.mul(albedo);
  // Blinds or curtains part-way down some windows (not shop fronts)
  const inPaneY = cfy.sub(wy0).div(wy1.sub(wy0).max(0.01));
  const blind = step(0.55, h3).mul(h4).mul(float(1).sub(inGround));
  const covered = step(float(1).sub(blind.mul(0.85)), inPaneY);
  const cloth = mix(vec3(0.92, 0.84, 0.68), vec3(0.8, 0.82, 0.84), h1).mul(0.6);
  // By day the light comes in through the window and fades towards the back
  const behind = mix(roomCol.mul(mix(float(1.1), float(0.22), hitZ.min(1))), cloth, covered);

  // Lit rooms at night: shop fronts mostly, the floors above by chance. Each
  // room has a lamp under its ceiling, so the light pools on the ceiling and
  // falls off towards the corners, and shifts with the view (parallax)
  const onRate = mix(W.w, float(0.85), inGround);
  const on = step(h5, onRate);
  const cool = step(h1, G.w);
  const tv = step(0.95, h1).mul(float(1).sub(inGround));
  const lamp = mix(mix(vec3(1, 0.6, 0.28), vec3(0.72, 0.84, 1), cool), vec3(0.3, 0.45, 1), tv);
  const hit = vec3(cx.add(rx.mul(t)), hitY, hitZ.mul(depth));
  const lampPos = vec3(
    cellW.mul(float(0.3).add(h2.mul(0.4))),
    cellH.sub(0.35),
    depth.mul(float(0.3).add(h4.mul(0.35))),
  );
  const dl = hit.sub(lampPos);
  const illum = float(1.5)
    .div(float(1).add(dot(dl, dl).mul(0.5)))
    .add(0.08);
  // A drawn curtain glows evenly, brightest near the lamp
  const inPaneX = fx.sub(wx0).div(wx1.sub(wx0).max(0.01));
  const dp = vec2(inPaneX, inPaneY).sub(vec2(float(0.3).add(h2.mul(0.4)), 0.8));
  const fall = float(0.4).add(exp(dot(dp, dp).mul(-3)).mul(0.8));
  const glow = mix(float(0.55), float(1.4), h4).mul(mix(float(1), float(1.5), inGround));
  const roomLight = lamp.mul(mix(roomCol.mul(illum), cloth.mul(fall).mul(1.1), covered)).mul(
    on
      .mul(glow)
      .mul(mix(float(1), float(0.6), tv))
      .mul(facadeLight.night),
  );

  // The sky in the glass, stronger at grazing angles
  const R = reflect(V, Nw);
  const sky = mix(facadeLight.horizon, facadeLight.zenith, smoothstep(0.1, 0.7, R.y));
  // Looking level, glass mirrors the street and the buildings across it, not the horizon
  const street = facadeLight.horizon.mul(0.22);
  const mirrored = mix(street, sky, smoothstep(0.02, 0.4, R.y));
  const cosV = abs(dot(V, Nw));
  // (each pane a little out of true: the reflection varies pane to pane)
  const fres = float(0.16)
    .add(pow(float(1).sub(cosV), 4).mul(0.6))
    .mul(mix(float(0.7), float(1.3), h3));
  const daylit = behind.mul(0.32).mul(facadeLight.day);

  // Walls: floor slabs, cladding ribs, rain streaks, a dirty base, run-off under the top
  const meters = u.mul(bayW);
  const slab = box(fy, float(0), float(0.24).div(floorH), ay)
    .mul(float(1).sub(inGround))
    .mul(hasBays)
    .mul(float(1).sub(far))
    .mul(step(0, v2));
  const rib = box(fract(meters.div(0.6)), float(0), float(0.3), fwidth(meters.div(0.6)).mul(0.75));
  const streakCol = hash(vec2(floor(meters.mul(1.3)), sid));
  const grime = smoothstep(0.6, 1, streakCol)
    .mul(0.14)
    .add(
      float(1)
        .sub(smoothstep(0, 1.8, v))
        .mul(0.2),
    )
    .add(smoothstep(usable.sub(2.4), usable.add(0.3), v).mul(streakCol).mul(0.16));
  // Sloped roofs: shingle courses every 18 cm of height, tiles a little uneven
  const isSloped = step(0.5, part)
    .mul(step(part, 1.5))
    .mul(step(0.05, float(1).sub(normalWorld.y)));
  const courseY = positionWorld.y.div(0.18);
  const courses = box(fract(courseY), float(0), float(0.22), fwidth(courseY).mul(0.75)).mul(
    isSloped,
  );
  const tileHash = hash(
    vec2(floor(courseY), floor(positionWorld.x.add(positionWorld.z).div(0.35))),
  );
  // Scanned wall and roof materials (asset pack), in the wall's own meters
  // (along it, up it), on roofs along the slope, on flat roofs in plan
  let surface: Node<"vec3"> = vertexColor().xyz;
  let surfaceRough: Node<"float"> | null = null;
  let surfaceNormal: Node<"vec3"> | null = null;
  if (surfaces) {
    const layer = attribute("aSurf", "float");
    const textured = step(-0.5, layer);
    const Tw = normalize(vec3(Nw.z, 0, Nw.x.negate()).add(vec3(1e-4, 0, 0)));
    const slope = float(1).sub(abs(Nw.y));
    const onRoof = step(0.5, part).mul(step(part, 1.5));
    const flatRoof = onRoof.mul(step(slope, 0.05));
    const along = dot(positionWorld, Tw);
    const up = positionWorld.y.div(max(float(0.25), Nw.y.mul(Nw.y).oneMinus().sqrt()));
    const wallUv = vec2(meters, v);
    const roofUv = vec2(along, up);
    const uvw = mix(mix(wallUv, roofUv, onRoof), positionWorld.xz, flatRoof);
    const s = surfaces.sample(layerIndex(layer, WALL_IDS.length), uvw);
    // Plain materials are gray detail around 0.5 (linear): tinted by the
    // building's color; brick, tiles on roofs and wood keep their own
    const neutral = [...WALL_NEUTRAL].reduce<Node<"float">>(
      (acc, i) => acc.add(step(float(i - 0.5), layer).mul(step(layer, float(i + 0.5)))),
      float(0),
    );
    const tint = vertexColor().xyz;
    const own = s.color.mul(mix(vec3(1, 1, 1), tint.div(dot(tint, vec3(0.3333)).max(0.05)), 0.25));
    const detail = mix(own, tint.mul(s.color).mul(2), neutral).mul(mix(float(1), s.ao, 0.6));
    surface = mix(vertexColor().xyz, detail, textured);
    surfaceRough = mix(float(0.88), max(s.rough, float(0.5)), textured);
    // Relief: along the wall (u) and up (v); on roofs along the slope
    const Up = normalize(
      vec3(0, 1, 0)
        .sub(Nw.mul(Nw.y))
        .add(vec3(0, 1e-4, 0)),
    );
    const Bv = mix(Up, vec3(0, 0, 1), flatRoof);
    const Tv = mix(Tw, vec3(1, 0, 0), flatRoof);
    const strength = smoothstep(80, 8, positionWorld.distance(cameraPosition)).mul(textured);
    surfaceNormal = normalize(
      Nw.add(Tv.mul(s.tilt.x.mul(strength))).add(Bv.mul(s.tilt.y.mul(strength))),
    );
  }
  const wallCol = surface
    .mul(float(1).sub(slab.mul(0.16)))
    .mul(mix(float(1), float(0.86).add(rib.mul(0.14)), isClad))
    .mul(float(1).sub(grime.mul(isWall)))
    .mul(float(1).sub(courses.mul(0.22)))
    .mul(mix(float(1), mix(float(0.9), float(1.08), tileHash), isSloped));

  // Shop sign band above the shop front, glowing a little at night
  const sign = hasGround
    .mul(step(groundH.sub(0.85), v))
    .mul(step(v, groundH.sub(0.2)))
    .mul(isWall)
    .mul(hasBays);
  const hue = fract(bh.add(col.mul(0.13)));
  const signCol = vec3(
    abs(hue.mul(6).sub(3)).sub(1).clamp(0, 1),
    float(2)
      .sub(abs(hue.mul(6).sub(2)))
      .clamp(0, 1),
    float(2)
      .sub(abs(hue.mul(6).sub(4)))
      .clamp(0, 1),
  )
    .mul(0.55)
    .add(0.15);

  // Depth: the reveal shades the top of the glass, a pale sill under the window
  const reveal = float(1)
    .sub(smoothstep(0, 0.22, wy1.sub(cfy).mul(cellH)))
    .mul(float(1).sub(far));
  const sillBand = box(cfy, wy0.sub(float(0.07).div(cellH)), wy0, ay)
    .mul(box(fx, wx0.sub(0.02), wx1.add(0.02), ax))
    .mul(valid)
    .mul(float(1).sub(inGround))
    .mul(float(1).sub(far));
  const frameCol = mix(vec3(0.16, 0.17, 0.18), vec3(0.62, 0.63, 0.63), step(0.5, bh));
  const glassCol = vec3(G.x, G.y, G.z);
  let base = mix(wallCol, frameCol, frame);
  base = mix(base, glassCol.mul(float(1).sub(reveal.mul(0.5))), pane);
  base = mix(base, vertexColor().xyz.mul(1.25), sillBand);
  base = mix(base, signCol, sign);
  mat.colorNode = base;
  const isUnit = step(2.5, part).mul(step(part, 3.5));
  mat.roughnessNode = mix(
    mix(mix(surfaceRough ?? float(0.88), float(0.5), isUnit), float(0.45), frame),
    float(0.06),
    pane,
  );
  if (surfaceNormal) {
    // (flat over glass and frames)
    mat.normalNode = transformNormalToView(
      normalize(mix(surfaceNormal, Nw, max(pane, frame).min(1))),
    );
  }
  mat.metalnessNode = isUnit.mul(0.35);
  mat.emissiveNode = mirrored
    .mul(fres)
    .mul(facadeLight.day.mul(0.85).add(0.15))
    .add(daylit.mul(float(1).sub(fres)))
    .mul(float(1).sub(reveal.mul(0.6)))
    .add(roomLight)
    .mul(pane)
    .add(signCol.mul(sign).mul(facadeLight.night).mul(0.5));
  return mat;
}
