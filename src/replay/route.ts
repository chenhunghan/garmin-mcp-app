/**
 * The path on the ground: a ribbon along the route whose traveled part is
 * colored by the chosen metric (the part ahead is a pale trail), plus km
 * posts and lap flags with generated label textures.
 */
import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  cameraPosition,
  color,
  float,
  max,
  mix,
  mul,
  mx_noise_float,
  mx_worley_noise_float,
  normalWorld,
  positionWorld,
  smoothstep,
  sub,
  transformNormalToView,
  uniform,
  uv,
  vec3,
} from "three/tsl";
import {
  G,
  GROUND_IDS,
  groundNormal,
  layerIndex,
  worldNoise,
  type SurfaceSet,
} from "./surfaces.ts";
import { lampAt } from "./furniture.ts";
import { GlowTrail } from "./glow-trail.ts";
import { Line2 } from "three/addons/lines/webgpu/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { locate, timeAtDistance, type ReplayData } from "../replay-model.ts";
import type { Track } from "./track.ts";
import { drape } from "./drape.ts";

const WIDTH = 0.95;
const LIFT = 0.05;

export interface RouteMeshes {
  group: THREE.Group;
  setColors(rgb: Float32Array): void;
  /** Color the route up to sample position `i` */
  setProgress(i: number): void;
  /** Far camera: draw the route as a screen-space line that stays visible */
  setFar(far: boolean): void;
  /** The worn trail in scanned materials (asset pack), or generated */
  setSurfaces(set: SurfaceSet | null): void;
  /** Each frame: the glowing wake behind the runner (hip: its height above the path) */
  update(
    cam: THREE.Vector3,
    t: number,
    hip: number,
    ground: (x: number, z: number) => number,
  ): void;
  dispose(): void;
}

export function labelTexture(
  text: string,
  opts: { bg?: string; fg?: string; w?: number; h?: number; font?: string; radius?: number } = {},
): THREE.CanvasTexture {
  const w = opts.w ?? 256;
  const h = opts.h ?? 128;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const r = opts.radius ?? h * 0.22;
  ctx.fillStyle = opts.bg ?? "rgba(20,24,30,0.86)";
  ctx.beginPath();
  ctx.roundRect(4, 4, w - 8, h - 8, r);
  ctx.fill();
  ctx.fillStyle = opts.fg ?? "#ffffff";
  ctx.font =
    opts.font ?? `600 ${Math.round(h * 0.46)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, w / 2, h / 2 + h * 0.02);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function buildRoute(
  data: ReplayData,
  track: Track,
  heightAt: (x: number, z: number) => number,
  /**
   * Per dense path sample: the ground material the run wears into
   * (GROUND_IDS index), or −1 where it runs on pavement (no trail there).
   * Default: an earth trail all along.
   */
  trailLayer?: Float32Array,
): RouteMeshes {
  // Geometry follows the dense spline path; colors come from the samples
  const path = track.dense;
  const n = path.n;
  const positions = new Float32Array(n * 2 * 3);
  const uvs = new Float32Array(n * 2 * 2);
  const colors = new Float32Array(n * 2 * 3).fill(1);
  for (let i = 0; i < n; i++) {
    const h = path.heading[i]!;
    // Right-hand perpendicular of the travel direction (sin h, cos h)
    const px = Math.cos(h) * (WIDTH / 2);
    const pz = -Math.sin(h) * (WIDTH / 2);
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? -1 : 1;
      const x = path.x[i]! + px * sgn;
      const z = path.z[i]! + pz * sgn;
      // Sit on whichever is higher: the recorded path or the generated ground
      const y = Math.max(path.y[i]!, heightAt(x, z)) + LIFT;
      positions.set([x, y, z], (i * 2 + side) * 3);
      uvs.set([side, path.s[i]! / WIDTH], (i * 2 + side) * 2);
    }
  }
  const index: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  const colorAttr = new THREE.BufferAttribute(colors, 3);
  geo.setAttribute("color", colorAttr);
  geo.setIndex(index);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const trail = trailMesh(track, heightAt, trailLayer);

  // Soft edges across the ribbon
  const edge = smoothstep(float(0.5), float(0.36), abs(sub(uv().x, 0.5)));

  const done = new THREE.MeshStandardNodeMaterial({
    vertexColors: true,
    roughness: 0.55,
    metalness: 0,
    transparent: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  drape(done, 0.26);
  // The split between traveled and ahead, at the runner's distance along the
  // ribbon (in ribbon widths, like uv.y): a soft hand-over just past the feet
  // (drawn per pixel, not on segment boundaries, which left a gap under them)
  const progress = uniform(0);
  const handOver = smoothstep(progress.sub(0.15 / WIDTH), progress.add(0.45 / WIDTH), uv().y);
  done.opacityNode = edge.mul(0.78).mul(float(1).sub(handOver));
  done.emissiveNode = mul(THREE.TSL.vertexColor(), 0.08);

  const ahead = new THREE.MeshStandardNodeMaterial({
    color: 0xf3efe6,
    roughness: 0.8,
    transparent: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  drape(ahead, 0.24);
  ahead.opacityNode = edge.mul(0.18).mul(handOver);

  // Same buffers, separate draw ranges: traveled [0, k), ahead [k, end)
  const aheadGeo = new THREE.BufferGeometry();
  for (const name of ["position", "uv", "color", "normal"]) {
    aheadGeo.setAttribute(name, geo.getAttribute(name));
  }
  aheadGeo.setIndex(geo.getIndex());
  aheadGeo.boundingSphere = geo.boundingSphere;
  const doneMesh = new THREE.Mesh(geo, done);
  const aheadMesh = new THREE.Mesh(aheadGeo, ahead);
  doneMesh.receiveShadow = true;
  aheadMesh.receiveShadow = true;
  doneMesh.renderOrder = 2;
  aheadMesh.renderOrder = 1;
  doneMesh.frustumCulled = false;
  aheadMesh.frustumCulled = false;

  const group = new THREE.Group();
  group.name = "route";
  group.add(trail.mesh);
  // The route itself isn't drawn on the ground any more (ground ribbons got
  // cut by the terrain and sank into it): behind the runner it's a glowing
  // wake at hip height, from afar a line drawn over everything
  const sampleColors = new Float32Array(n * 3).fill(1);
  const glow = new GlowTrail(track, () => sampleColors);
  group.add(glow.group);
  let progressIndex = 0;
  void doneMesh;
  void aheadMesh;

  // Overview line: a constant-width line a little above the ground
  const linePts: number[] = [];
  const lineColors: number[] = [];
  let lastS = -Infinity;
  const lineIdx: number[] = [];
  for (let i = 0; i < n; i++) {
    if (path.s[i]! - lastS < 4 && i !== n - 1) continue;
    lastS = path.s[i]!;
    linePts.push(
      path.x[i]!,
      Math.max(path.y[i]!, heightAt(path.x[i]!, path.z[i]!)) + 1.2,
      path.z[i]!,
    );
    lineColors.push(1, 1, 1);
    lineIdx.push(i);
  }
  const lineGeo = new LineGeometry();
  lineGeo.setPositions(linePts);
  lineGeo.setColors(lineColors);
  const lineMat = new THREE.Line2NodeMaterial({
    vertexColors: true,
    linewidth: 4,
    worldUnits: false,
    // Over everything, like a map overlay: never cut by hills or buildings
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });
  const line = new Line2(lineGeo, lineMat);
  line.computeLineDistances();
  line.visible = false;
  line.renderOrder = 10;
  group.add(line);

  const disposables: { dispose(): void }[] = [
    trail.geo,
    trail.mat,
    glow,
    geo,
    aheadGeo,
    done,
    ahead,
    lineGeo,
    lineMat,
  ];
  addMarkers(group, data, track, heightAt, disposables);

  const totalIdx = Math.max(0, (n - 1) * 6);
  return {
    group,
    setColors(rgb) {
      for (let i = 0; i < n; i++) {
        // Blend between the samples on either side, so colors flow along the path
        const fs = path.sample[i]!;
        const k = Math.min(track.n - 1, Math.floor(fs));
        const k2 = Math.min(track.n - 1, k + 1);
        const f = fs - k;
        const c: [number, number, number] = [0, 0, 0];
        for (let ch = 0; ch < 3; ch++)
          c[ch] = rgb[k * 3 + ch]! + (rgb[k2 * 3 + ch]! - rgb[k * 3 + ch]!) * f;
        for (let side = 0; side < 2; side++) colors.set(c, (i * 2 + side) * 3);
      }
      // Vertex colors are linear; the scales are sRGB
      const c = new THREE.Color();
      for (let k = 0; k < colors.length; k += 3) {
        c.setRGB(colors[k]!, colors[k + 1]!, colors[k + 2]!, THREE.SRGBColorSpace);
        colors[k] = c.r;
        colors[k + 1] = c.g;
        colors[k + 2] = c.b;
      }
      colorAttr.needsUpdate = true;
      for (let k = 0; k < n; k++) sampleColors.set(colors.subarray(k * 6, k * 6 + 3), k * 3);
      lineGeo.setColors(
        lineIdx.flatMap((i) => [colors[i * 6]!, colors[i * 6 + 1]!, colors[i * 6 + 2]!]),
      );
    },
    setFar(far) {
      line.visible = far;
    },
    setSurfaces(set) {
      trail.setSurfaces(set);
    },
    update(cam, t, hip, ground) {
      glow.update(progressIndex, hip, cam, t, ground);
    },
    setProgress(i) {
      const di = track.denseIndex(Math.floor(i), i - Math.floor(i));
      progressIndex = di;
      const a = Math.min(n - 1, Math.floor(di));
      const b = Math.min(n - 1, a + 1);
      progress.value = (path.s[a]! + (path.s[b]! - path.s[a]!) * (di - a)) / WIDTH;
      // Draw ranges overlap by a few segments around the hand-over
      const k0 = Math.max(0, Math.min(totalIdx, (Math.floor(di) - 2) * 6));
      const k1 = Math.max(0, Math.min(totalIdx, (Math.ceil(di) + 2) * 6));
      geo.setDrawRange(0, k1);
      aheadGeo.setDrawRange(k0, totalIdx - k0);
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

function addMarkers(
  group: THREE.Group,
  data: ReplayData,
  track: Track,
  heightAt: (x: number, z: number) => number,
  disposables: { dispose(): void }[],
) {
  const { t, d } = data.channels;
  const totalD = d.at(-1) ?? 0;
  const postMat = new THREE.MeshStandardNodeMaterial({ color: 0xf5f5f0, roughness: 0.5 });
  const postGeo = new THREE.CylinderGeometry(0.045, 0.055, 1.5, 12);
  postGeo.translate(0, 0.75, 0);
  disposables.push(postMat, postGeo);

  /** Scene position `offset` meters to the side of the route at watch distance `dist`. */
  const at = (dist: number, offset: number) => {
    const time = timeAtDistance(data.channels, dist);
    const { i, f } = locate(t, time);
    const di = track.denseIndex(i, f);
    const k = Math.floor(di);
    const k2 = Math.min(track.dense.n - 1, k + 1);
    const ff = di - k;
    const d = track.dense;
    const x0 = d.x[k]! + (d.x[k2]! - d.x[k]!) * ff;
    const z0 = d.z[k]! + (d.z[k2]! - d.z[k]!) * ff;
    const h = d.heading[k]! + (d.heading[k2]! - d.heading[k]!) * ff;
    const x = x0 + Math.cos(h) * offset;
    const z = z0 - Math.sin(h) * offset;
    return { x, z, y: heightAt(x, z), heading: h };
  };

  for (let km = 1; km * 1000 < totalD - 50; km++) {
    const p = at(km * 1000, 2.1);
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.set(p.x, p.y, p.z);
    post.castShadow = true;
    group.add(post);
    const tex = labelTexture(`${km} km`);
    const mat = new THREE.SpriteNodeMaterial({ map: tex, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(1.5, 0.75, 1);
    sprite.position.set(p.x, p.y + 1.95, p.z);
    group.add(sprite);
    disposables.push(tex, mat);
  }

  // Laps that aren't plain 1 km auto laps get a flag
  const laps = data.laps;
  const autoKm =
    laps.length > 1 && laps.slice(0, -1).every((l) => Math.abs(l.endD - l.startD - 1000) < 15);
  if (laps.length > 1 && !autoKm) {
    for (const lap of laps.slice(1)) {
      const p = at(lap.startD, -2.1);
      const pole = new THREE.Mesh(postGeo, postMat);
      pole.position.set(p.x, p.y, p.z);
      pole.scale.y = 1.4;
      group.add(pole);
      const tex = labelTexture(`Lap ${lap.index}`, { bg: "rgba(61,139,253,0.92)" });
      const mat = new THREE.SpriteNodeMaterial({ map: tex, transparent: true, depthWrite: false });
      const flag = new THREE.Sprite(mat);
      flag.scale.set(1.3, 0.65, 1);
      flag.position.set(p.x, p.y + 2.45, p.z);
      group.add(flag);
      disposables.push(tex, mat);
    }
  }
}

/**
 * The worn trail under the run: a draped strip of packed earth and gravel
 * with frayed edges, as its own mesh so it stays crisp whatever the terrain
 * grid's resolution.
 */
function trailMesh(
  track: Track,
  heightAt: (x: number, z: number) => number,
  trailLayer?: Float32Array,
) {
  const path = track.dense;
  const n = path.n;
  const across = [-1, -0.45, 0, 0.45, 1];
  const half = 1.7;
  const pos = new Float32Array(n * across.length * 3);
  const uvs = new Float32Array(n * across.length * 2);
  const layers = new Float32Array(n * across.length);
  const show = new Float32Array(n * across.length);
  // Ease the trail in and out over ~6 m where the run leaves or joins pavement
  const shown = new Float32Array(n);
  for (let i = 0; i < n; i++) shown[i] = trailLayer && trailLayer[i]! < 0 ? 0 : 1;
  const eased = new Float32Array(n);
  for (let i = 0, lo = 0, hi = 0, sum = 0; i < n; i++) {
    while (hi < n && path.s[hi]! <= path.s[i]! + 3) sum += shown[hi++]!;
    while (path.s[lo]! < path.s[i]! - 3) sum -= shown[lo++]!;
    eased[i] = sum / (hi - lo);
  }
  for (let i = 0; i < n; i++) {
    const h = path.heading[i]!;
    const px = Math.cos(h);
    const pz = -Math.sin(h);
    across.forEach((a, k) => {
      const x = path.x[i]! + px * a * half;
      const z = path.z[i]! + pz * a * half;
      const o = i * across.length + k;
      pos.set([x, heightAt(x, z) + 0.03, z], o * 3);
      uvs.set([(a + 1) / 2, path.s[i]! / 4], o * 2);
      const l = trailLayer?.[i] ?? G.dirt;
      layers[o] = l < 0 ? G.dirt : l;
      show[o] = eased[i]!;
    });
  }
  const index: number[] = [];
  const w = across.length;
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < w - 1; k++) {
      const a = i * w + k;
      index.push(a, a + w, a + 1, a + 1, a + w, a + w + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute("aLayer", new THREE.BufferAttribute(layers, 1));
  geo.setAttribute("aShow", new THREE.BufferAttribute(show, 1));
  geo.setIndex(index);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const p = positionWorld.xz;
  const gravel = mx_worley_noise_float(vec3(p.mul(5.5), 0.5));
  const blotch = mx_noise_float(vec3(p.mul(0.45), 4.2))
    .mul(0.5)
    .add(0.5);
  const fray = mx_noise_float(vec3(p.mul(1.3), 9.1)).mul(0.09);
  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: 0.95,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
  drape(mat, 0.18);
  mat.colorNode = mix(color("#7a6650"), color("#a38d6e"), blotch).mul(
    mix(float(0.82), float(1.08), gravel),
  );
  // Frayed edges, trodden harder in the middle
  const visible = attribute("aShow", "float");
  mat.opacityNode = smoothstep(float(0.5), float(0.26), abs(sub(uv().x, 0.5)).add(fray))
    .mul(0.92)
    .mul(visible);
  const generatedColor = mat.colorNode;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.renderOrder = 0.5;
  mesh.frustumCulled = false;
  const setSurfaces = (set: SurfaceSet | null) => {
    if (!set) {
      mat.colorNode = generatedColor;
      mat.normalNode = null;
      mat.roughnessNode = null;
      mat.opacityNode = smoothstep(float(0.5), float(0.26), abs(sub(uv().x, 0.5)).add(fray))
        .mul(0.92)
        .mul(visible);
    } else {
      const near = smoothstep(120, 10, positionWorld.distance(cameraPosition));
      const s = set.sample(
        layerIndex(attribute("aLayer", "float"), GROUND_IDS.length),
        p,
        smoothstep(0.35, 0.65, worldNoise(p, 40, 0.8)),
      );
      mat.colorNode = s.color;
      mat.emissiveNode = s.color.mul(lampAt(p));
      mat.roughnessNode = max(s.rough, float(0.85));
      mat.normalNode = transformNormalToView(groundNormal(normalWorld, s.tilt, near));
      // The scanned trail shows through by its height map at the frayed edges
      const center = smoothstep(float(0.5), float(0.2), abs(sub(uv().x, 0.5)).add(fray));
      mat.opacityNode = smoothstep(float(0.25), float(0.55), center.add(s.height.sub(0.5).mul(0.5)))
        .mul(0.95)
        .mul(visible);
    }
    mat.needsUpdate = true;
  };
  return { mesh, geo, mat, setSurfaces };
}
