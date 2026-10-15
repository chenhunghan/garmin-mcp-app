/**
 * The 3D replay: renderer (WebGPU, falling back to WebGL 2), sky and sun at
 * the run's real time and place, weather, terrain, route, scenery and the
 * runner, a third-person camera rig, and the playback clock.
 *
 * React owns the controls and HUD; this class owns everything per-frame and
 * reports the playback time back at a modest rate (`onFrame`).
 */
import * as THREE from "three/webgpu";
import {
  length,
  mix,
  normalize,
  pass,
  positionLocal,
  smoothstep,
  uniform,
  uv,
  vec2,
} from "three/tsl";
import { SkyMesh } from "three/addons/objects/SkyMesh.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { hrZone, locate, sunPosition, valueAt, type ReplayData } from "../replay-model.ts";
import { ZONE_COLORS, defaultZones, sampleColors, type ColorBy } from "./colors.ts";
import { buildTrack, measureDense, type Track } from "./track.ts";
import { buildingsOnPath, groundBlocker, mapMatch, treesOffPath } from "./map-match.ts";
import { Grass, grassLight } from "./grass.ts";
import { buildTerrain, seasonOf, smoothstepJs, type Terrain } from "./terrain.ts";
import { buildRoute, type RouteMeshes } from "./route.ts";
import { Runner } from "./runner.ts";
import {
  heavyInfluence,
  loadRunnerModel,
  runnerSex,
  shapeRunner,
  type RunnerBody,
} from "./runner-model.ts";
import {
  buildMapLayers,
  firstBuildingHit,
  type Detail,
  landCoverTexture,
  occluderIndex,
  type Occluder,
} from "./map-layers.ts";
import { decodeGrid, insideGrid, sampleGrid, type RunMap } from "../geo/types.ts";
import { Breath, rain, snow, stars, type Effect } from "./effects.ts";
import { facadeLight } from "./facade.ts";
import { Forest, treeWind } from "./trees.ts";
import { cloudLight, disposeClouds, driftClouds, withCloudShadows } from "./clouds.ts";
import { AssetLibrary, type FetchAssetFile } from "./assets.ts";
import { G, GROUND_IDS, SurfaceSet, WALL_IDS } from "./surfaces.ts";
import { SKY_IDS, SkyLight, skyWeights } from "./sky-light.ts";
import { growLooks } from "./ez-trees.ts";
import type { AreaKind, Surface } from "../geo/types.ts";
import type { MapLayers } from "./map-layers.ts";

/** What the run wears into the ground on each surface (−1: pavement, no trail) */
const TRAIL_ON: Record<Surface, number> = {
  asphalt: -1,
  concrete: -1,
  paving: -1,
  wood: -1,
  gravel: G.gravel,
  dirt: G.dirt,
  grass: G.worn,
  sand: G.sand,
};
const TRAIL_OFF_ROAD: Partial<Record<AreaKind, number>> = {
  residential: -1,
  industrial: -1,
  park: G.worn,
  pitch: G.worn,
  grass: G.worn,
  sand: G.sand,
  rock: G.gravel,
};

export type CameraMode = "chase" | "side" | "front" | "drone" | "overview";

export const CAMERA_LABEL: Record<CameraMode, string> = {
  chase: "Chase",
  side: "Side",
  front: "Front",
  drone: "Drone",
  overview: "Overview",
};

export interface SceneInfo {
  backend: "WebGPU" | "WebGL 2";
  syntheticCourse: boolean;
  /** Terrain and map features come from real data (elevation + OpenStreetMap) */
  realMap: boolean;
}

export interface FrameInfo {
  t: number;
  playing: boolean;
}

const tmpV = new THREE.Vector3();
const tmpSnapA = new THREE.Vector3();
const tmpSnapB = new THREE.Vector3();
const tmpSnapC = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

export class ReplayScene {
  // Playback
  time = 0;
  playing = false;
  rate = 1;
  readonly duration: number;
  onFrame?: (f: FrameInfo) => void;
  onEnded?: () => void;

  renderer!: THREE.WebGPURenderer;
  scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.2, 20000);
  private controls!: OrbitControls;
  private track: Track;
  private terrain!: Terrain;
  private route!: RouteMeshes;
  private runner = new Runner();
  private sky = new SkyMesh();
  sun = new THREE.DirectionalLight("#ffffff", 3);
  hemi = new THREE.HemisphereLight("#bcd6f0", "#4a5a35", 0.6);
  private headlamp = new THREE.SpotLight("#fff3df", 0, 45, 0.55, 0.5, 1.2);
  private stars = stars();
  private effects: Effect[] = [];
  private breath: Breath;
  private envScene = new THREE.Scene();
  /** The ground as the environment map sees it: lit grass and pavement */
  private envGroundMat = new THREE.MeshBasicNodeMaterial({
    color: new THREE.Color(0.18, 0.2, 0.15),
    side: THREE.DoubleSide,
    fog: false,
  });
  private pmrem: THREE.PMREMGenerator | null = null;
  private envTarget: THREE.RenderTarget | null = null;
  private lastEnvSun = new THREE.Vector3(0, -1, 0);

  private mode: CameraMode = "chase";
  private userActiveUntil = 0;
  /** Camera offset from the runner as steered, before buildings push it */
  private desired = new THREE.Vector3();
  private hasDesired = false;
  private arm = { lift: 0, scale: 1 };
  private lastTarget = new THREE.Vector3();
  private droneAngle = 0;
  private lastFrameAt = 0;
  private lastReport = 0;
  private lastSunT = -Infinity;
  private colorBy: ColorBy = "hr";
  private zones: number[] | null;
  private zoneColors = ZONE_COLORS.map((c) => new THREE.Color(c));
  private wind = new THREE.Vector2();
  private cloud = 0.2;
  private origin: { lat: number; lon: number };
  private startMs: number;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;
  private runnerPos = new THREE.Vector3();
  private groundAbs: ((x: number, z: number) => number) | null = null;
  private disposeLater: { dispose(): void }[] = [];
  private forest: Forest | null = null;
  private grass: Grass | null = null;
  private layers: MapLayers | null = null;
  /** Map way each dense path sample was snapped to (−1: none) */
  private matchedWay: Int32Array | null = null;
  /** Fetches files of the asset pack (scanned materials, sky light, models); set before init() */
  fetchAsset: FetchAssetFile | null = null;
  private assets: AssetLibrary | null = null;
  /** Sky photos for the environment light, once they've arrived */
  private skyLight: SkyLight | null = null;
  /** Called when more assets are on screen (for the credits line) */
  onAssets?: (ids: string[]) => void;
  /** Which runner is shown: from the Garmin profile, or the user's pick */
  body: RunnerBody = "profile";
  private bodyLoad = 0;
  private bodyModel: { object: THREE.Object3D; dispose(): void } | null = null;
  private details: Detail[] = [];
  /**
   * Detail level 0.4–1: how far trees and balconies are drawn. Frames that
   * run slow lower it first; the pixel ratio only drops once it's at the floor
   * (the frame is mostly limited by the CPU's draws, not by pixels)
   */
  private quality = 1;
  private frameEma = 1 / 60;
  private lastShadow = { x: NaN, y: NaN, z: NaN, sun: new THREE.Vector3(), t: NaN };
  private occluders: Map<string, Occluder[]> | null = null;
  private speedNow = 0;
  private blur = uniform(0);
  private blurPipeline: THREE.RenderPipeline | null = null;
  private heading = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private data: ReplayData,
    private map: RunMap | null = null,
  ) {
    // Real elevation: the path and the ground both follow it
    if (map?.dem && data.hasGps) {
      const { inner, outer } = map.dem;
      const hi = decodeGrid(inner);
      const ho = decodeGrid(outer);
      this.groundAbs = (x, z) =>
        insideGrid(inner, x, z) ? sampleGrid(inner, hi, x, z) : sampleGrid(outer, ho, x, z);
    }
    this.track = buildTrack(data, this.groundAbs ?? undefined);
    // Onto the mapped paths: GPS between buildings drifts several meters
    if (map?.roads.length && !this.track.synthetic) {
      const d = this.track.dense;
      const snapped = mapMatch(d.x, d.z, d.s, map.roads);
      this.matchedWay = snapped.way;
      d.x.set(snapped.x);
      d.z.set(snapped.z);
      measureDense(d);
      // Buildings the snapped path still runs through are mapping or GPS
      // error; leave them out rather than run through walls
      const through = buildingsOnPath(d.x, d.z, map.buildings);
      // …and trees standing on the path (mapping offsets of a meter or two)
      this.map = {
        ...map,
        buildings: through.size ? map.buildings.filter((_, k) => !through.has(k)) : map.buildings,
        trees: treesOffPath(d.x, d.z, map.trees ?? []),
      };
    }
    this.duration = data.channels.t.at(-1) ?? 0;
    this.zones = data.hrZones ?? defaultZones(data);
    const offsetMin = data.activity.utcOffsetMin ?? -new Date().getTimezoneOffset();
    // Without GPS, put the sun where the local clock says it is
    this.origin = this.track.origin ?? { lat: 45, lon: offsetMin / 4 };
    this.startMs = data.activity.startMs ?? Date.now() - this.duration * 1000;
    const tempC = data.weather?.tempC ?? data.channels.temp?.find((v) => v !== null) ?? 15;
    this.breath = new Breath(smoothstepJs(8, -2, tempC ?? 15));
  }

  async init(): Promise<SceneInfo> {
    const renderer = new THREE.WebGPURenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: "high-performance",
      // Dev UI: ?webgl tests the WebGL 2 fallback that runs where WebGPU isn't available
      forceWebGL:
        typeof __DEV_UI__ !== "undefined" &&
        __DEV_UI__ &&
        new URLSearchParams(location.search).has("webgl"),
    });
    await renderer.init();
    this.renderer = renderer;
    // The screen's own resolution (2 on most laptops); adaptQuality drops it
    // when frames run slow, after the detail level
    this.maxPixelRatio = Math.max(1, Math.min(window.devicePixelRatio, 2));
    renderer.setPixelRatio(this.maxPixelRatio);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
      ? "WebGPU"
      : "WebGL 2";

    // The runner's body: the bundled character model, driven by the gait
    // skeleton (falls back to the built-in body if it can't load)
    await this.setRunnerBody(this.body);
    this.buildWorld();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.receiveShadow) return;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material])
        withCloudShadows(mat);
    });
    // Shadows are drawn when something in them changed (see updateShadow)
    this.sun.shadow.autoUpdate = false;
    this.sun.shadow.needsUpdate = true;
    this.setupCamera();
    this.setupMotionBlur();
    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas.parentElement ?? this.canvas);
    this.seek(0);
    this.lastFrameAt = performance.now();
    renderer.setAnimationLoop(() => this.frame());
    void this.loadAssets();
    return { backend, syntheticCourse: this.track.synthetic, realMap: this.groundAbs !== null };
  }

  private buildWorld() {
    const { data, track, scene } = this;
    const w = data.weather;
    const condition = w?.condition ?? null;
    const tempC = w?.tempC ?? data.channels.temp?.find((v) => v !== null) ?? 15;
    const season = seasonOf(data.activity.startLocal, this.track.origin?.lat ?? null);
    const snowCover =
      condition === "snow" ? 1 : (tempC ?? 15) < -2 && season === "winter" ? 0.5 : 0;

    // Wind: Garmin gives where it blows from; particles and grass need where it goes
    const kph = w?.windKph ?? 8;
    const from = ((w?.windFromDeg ?? 225) * Math.PI) / 180;
    // North is −z, east is +x
    this.wind.set(-Math.sin(from), Math.cos(from)).multiplyScalar(Math.min(1, kph / 40));
    this.cloud =
      condition === "clear"
        ? 0.12
        : condition === "cloudy"
          ? 0.72
          : condition === "rain" || condition === "storm"
            ? 0.92
            : condition === "snow"
              ? 0.85
              : condition === "fog"
                ? 0.6
                : 0.3;

    // Sky
    this.sky.scale.setScalar(9000);
    this.sky.turbidity.value = 2 + this.cloud * 8;
    this.sky.rayleigh.value = 1.2 + this.cloud * 1.5;
    this.sky.mieCoefficient.value = 0.004 + this.cloud * 0.01;
    this.sky.mieDirectionalG.value = 0.8;
    this.sky.cloudCoverage.value = this.cloud;
    this.sky.cloudDensity.value = 0.35 + this.cloud * 0.5;
    scene.add(this.sky);
    // The environment (reflections and the sky's light) is baked from a plain
    // dome in the sky's own colors, not from the sky shader: its radiance is
    // physically scaled and strongly blue, so even without the sun disc it
    // lit every surface blue-white. The dome's zenith is pulled towards the
    // horizon (a neutral, overcast-ish light in the shade); the warm ground
    // below stands for the sunlight it bounces. (Both small: the PMREM bake's
    // cube camera sees 100 m.)
    const dir = normalize(positionLocal);
    const zenith = mix(facadeLight.horizon, facadeLight.zenith, 0.5);
    const domeMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, fog: false });
    domeMat.colorNode = mix(facadeLight.horizon, zenith, smoothstep(0, 0.7, dir.y));
    const dome = new THREE.Mesh(new THREE.SphereGeometry(60, 32, 16), domeMat);
    this.envScene.add(dome);
    this.disposeLater.push(dome.geometry, domeMat);
    const groundDisc = new THREE.Mesh(
      new THREE.CircleGeometry(58, 48).rotateX(-Math.PI / 2).translate(0, -2, 0),
      this.envGroundMat,
    );
    this.envScene.add(groundDisc);
    this.disposeLater.push(groundDisc.geometry, groundDisc.material);
    scene.add(this.stars.object);

    // Fog: visibility from the weather
    const far =
      condition === "fog"
        ? 260
        : condition === "rain" || condition === "storm"
          ? 1100
          : condition === "snow"
            ? 700
            : 2600;
    this.fogRange = { near: far * 0.15, far };
    scene.fog = new THREE.Fog("#c5d5e3", far * 0.15, far);

    // Lights
    scene.add(this.hemi);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.045;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 600;
    scene.add(this.sun, this.sun.target);
    // One crisp shadow map around the runner (cascaded shadows rendered
    // nothing on some backends); far scenery is lit without shadows
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -22;
    cam.right = cam.top = 22;
    cam.near = 1;
    cam.far = 700;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.radius = 3;

    // Terrain and route
    const seed = Number(String(data.activity.id).slice(-6)) || 1;
    const groundAbs = this.groundAbs;
    const b = track.bounds;
    const half = Math.max(b.maxX - b.minX, b.maxZ - b.minZ, 200) / 2 + 500;
    const lcX = (b.minX + b.maxX) / 2 - half;
    const lcZ = (b.minZ + b.maxZ) / 2 - half;
    const landCover = this.map && groundAbs ? landCoverTexture(this.map, lcX, lcZ, half * 2) : null;
    this.terrain = buildTerrain(track, {
      seed,
      season,
      snow: snowCover,
      ground: groundAbs ? (x, z) => groundAbs(x, z) - track.minY : undefined,
      landCover,
    });
    scene.add(this.terrain.group);
    // The path lies on the ground, not the other way round: a watch's
    // barometric elevation drifts, so passes over the same street are
    // recorded at different heights, while the ground has one height there
    const d = track.dense;
    for (let k = 0; k < d.n; k++) d.y[k] = this.terrain.heightAt(d.x[k]!, d.z[k]!);
    if (landCover) this.disposeLater.push(landCover.texture);
    if (this.map && groundAbs) {
      const layers = buildMapLayers(this.map, this.terrain.heightAt, this.terrain.distanceAt);
      scene.add(layers.group);
      this.layers = layers;
      this.disposeLater.push(layers);
      this.occluders = occluderIndex(layers.occluders);
      this.details = layers.details;
      if (this.map.trees?.length) {
        this.forest = new Forest(this.map.trees, this.terrain.heightAt, season);
        scene.add(this.forest.group);
        this.disposeLater.push(this.forest);
      }
    }
    // Grass on the green ground (not under snow), off paths, roads and buildings
    if (snowCover < 0.4) {
      const m = this.map && groundAbs ? this.map : null;
      const blocked = groundBlocker({
        path: { x: track.dense.x, z: track.dense.z, halfWidth: 1.15 },
        lines: m
          ? [
              ...m.roads.map((r) => ({ pts: r.pts, halfWidth: r.width / 2 + 0.35 })),
              ...m.rivers.map((r) => ({ pts: r.pts, halfWidth: r.width / 2 + 0.6 })),
            ]
          : [],
        footprints: m?.buildings ?? [],
      });
      this.grass = new Grass({
        heightAt: this.terrain.heightAt,
        kindAt: landCover ? landCover.kindAt : m ? () => null : undefined,
        blocked,
        season,
      });
      grassLight.dry.value = season === "autumn" ? 0.3 : season === "winter" ? 0.45 : 0;
      scene.add(this.grass.mesh);
      this.disposeLater.push(this.grass);
    }
    this.route = buildRoute(data, track, this.terrain.heightAt, this.trailLayers(landCover));
    scene.add(this.route.group);
    this.setColorBy(this.colorBy);

    // Runner (+ headlamp for runs in the dark)
    scene.add(this.runner.root);
    this.headlamp.position.set(0, 1.72, 0.12);
    this.headlamp.target.position.set(0, 0, 9);
    this.headlamp.castShadow = false;
    this.runner.root.add(this.headlamp, this.headlamp.target);
    scene.add(this.breath.group);

    // Weather particles
    if (condition === "rain" || condition === "storm")
      this.effects.push(rain(condition === "storm"));
    if (condition === "snow") this.effects.push(snow());
    for (const e of this.effects) scene.add(e.object);
  }

  /**
   * The ground the run wears a trail into, per path sample: the surface of
   * the mapped way it follows, else the land it crosses (null: no map, an
   * earth trail all along).
   */
  private trailLayers(
    landCover: { kindAt(x: number, z: number): AreaKind | null } | null,
  ): Float32Array | undefined {
    const map = this.map;
    if (!map || !this.groundAbs) return undefined;
    const d = this.track.dense;
    const out = new Float32Array(d.n);
    for (let k = 0; k < d.n; k++) {
      const way = this.matchedWay?.[k] ?? -1;
      const road = way >= 0 ? map.roads[way] : undefined;
      if (road) {
        out[k] = TRAIL_ON[road.surface ?? (road.paved ? "asphalt" : "dirt")];
        continue;
      }
      const kind = landCover?.kindAt(d.x[k]!, d.z[k]!) ?? null;
      out[k] = kind ? (TRAIL_OFF_ROAD[kind] ?? G.dirt) : G.dirt;
    }
    return out;
  }

  /**
   * Upgrade the generated look with the asset pack as its parts arrive:
   * scanned ground and road materials first. Anything missing keeps the
   * generated version.
   */
  private async loadAssets() {
    if (!this.fetchAsset) return;
    const lib = (this.assets ??= new AssetLibrary(this.fetchAsset));
    const notify = () => this.onAssets?.([...lib.used]);
    const ground = lib.surfaces([...GROUND_IDS], 1024).then((arrays) => {
      if (!arrays || this.disposed) return;
      this.disposeLater.push(arrays.a, arrays.b);
      const set = new SurfaceSet(arrays);
      this.terrain.setSurfaces(set);
      this.layers?.setSurfaces(set);
      this.route.setSurfaces(set);
      notify();
    });
    const walls = this.layers
      ? lib.surfaces([...WALL_IDS], 512).then((arrays) => {
          if (!arrays || this.disposed || !this.layers) return;
          this.disposeLater.push(arrays.a, arrays.b);
          this.layers.setWallSurfaces(new SurfaceSet(arrays));
          this.sun.shadow.needsUpdate = true;
          notify();
        })
      : null;
    const forest = this.forest;
    const trees = forest
      ? growLooks(lib, forest.usedLooks()).then((looks) => {
          if (!looks?.size || this.disposed) return;
          for (const look of looks.values()) {
            withCloudShadows(look.bark);
            withCloudShadows(look.leaves);
          }
          forest.attachLooks(looks);
          notify();
        })
      : null;
    const skies = Promise.all(SKY_IDS.map((id) => lib.sky(id))).then((list) => {
      if (this.disposed) return;
      const found = list.filter((x) => x !== null);
      if (!found.length) return;
      this.skyLight = new SkyLight(new Map(found.map((x) => [x.id, x])));
      this.disposeLater.push(this.skyLight);
      // Re-bake now with the photos
      this.lastEnvAt = 0;
      this.lastEnvSun.set(0, -1, 0);
      this.updateSun(true);
      notify();
    });
    await Promise.allSettled([ground, skies, walls, trees]);
  }

  private setupCamera() {
    const controls = new OrbitControls(this.camera, this.canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 2.2;
    controls.maxDistance = 4000;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.enablePan = false;
    controls.addEventListener("start", () => (this.userActiveUntil = Infinity));
    controls.addEventListener("end", () => (this.userActiveUntil = performance.now() + 2500));
    this.controls = controls;
  }

  /**
   * Radial blur toward the screen center, masked to the edges, so the runner
   * stays sharp while the surroundings streak. Ten taps along the ray.
   */
  private setupMotionBlur() {
    try {
      const pipeline = new THREE.RenderPipeline(this.renderer);
      const scenePass = pass(this.scene, this.camera);
      const tex = scenePass.getTextureNode("output");
      const p = uv();
      const dir = p.sub(0.5);
      const edge = smoothstep(0.16, 0.62, length(dir.mul(vec2(1.25, 1))));
      const amount = this.blur.mul(edge);
      const taps = 10;
      let sum: ReturnType<typeof tex.add> = tex.sample(p).add(0);
      for (let k = 1; k < taps; k++)
        sum = sum.add(tex.sample(p.sub(dir.mul(amount.mul(k / (taps - 1))))));
      pipeline.outputNode = sum.div(taps);
      this.blurPipeline = pipeline;
    } catch {
      this.blurPipeline = null;
    }
  }

  private resize() {
    const el = this.canvas.parentElement ?? this.canvas;
    const w = Math.max(1, el.clientWidth);
    const h = Math.max(1, el.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ── Public controls ──

  play() {
    if (this.time >= this.duration - 0.01) this.time = 0;
    this.playing = true;
  }

  pause() {
    this.playing = false;
  }

  seek(t: number) {
    this.time = Math.max(0, Math.min(this.duration, t));
    // Place everything immediately (the camera too) instead of easing there
    const prev = this.runnerPos.clone();
    this.placeRunner(0);
    const jump = prev.distanceTo(this.runnerPos);
    if (jump > 30 || this.lastTarget.lengthSq() === 0) this.snapCamera();
    this.updateSun(true);
  }

  setRate(rate: number) {
    this.rate = rate;
  }

  setColorBy(mode: ColorBy) {
    this.colorBy = mode;
    this.route.setColors(sampleColors(this.data, mode, this.track.grade, this.track.y));
  }

  setCameraMode(mode: CameraMode) {
    this.mode = mode;
    this.userActiveUntil = 0;
    if (mode === "overview") {
      const b = this.track.bounds;
      const cx = (b.minX + b.maxX) / 2;
      const cz = (b.minZ + b.maxZ) / 2;
      const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ, 100);
      const cy = this.terrain.heightAt(cx, cz);
      this.controls.target.set(cx, cy, cz);
      this.camera.position.set(cx + span * 0.35, cy + span * 0.9, cz + span * 0.75);
      this.controls.update();
    } else {
      this.snapCamera();
    }
  }

  // ── Per frame ──

  private frame() {
    if (this.disposed) return;
    const now = performance.now();
    const rawDt = (now - this.lastFrameAt) / 1000;
    const dt = Math.min(0.1, rawDt);
    this.lastFrameAt = now;
    this.adaptQuality(rawDt, now);

    if (this.playing) {
      this.time += dt * this.rate;
      if (this.time >= this.duration) {
        this.time = this.duration;
        this.playing = false;
        this.onEnded?.();
      }
    }
    this.placeRunner(this.playing ? dt : 0);
    this.updateSun(false);
    this.updateCamera(dt);
    for (const e of this.effects) e.update(dt, this.camera, this.wind);
    this.updateFog();
    this.updateDetails(now);
    // Clouds drift with the run's wind (in replay time, so a seek lands on the same sky)
    driftClouds(this.wind.x * 11, this.wind.y * 11, this.time);
    this.updateShadow();

    // Motion blur at the edges of the view, with the apparent speed: none at
    // a 1× jog, building with surges and fast-forward
    const apparent = this.speedNow * (this.playing ? this.rate : 0);
    const target =
      0.05 * smoothstepJs(6, 70, apparent) +
      0.012 * smoothstepJs(4.2, 6.5, this.playing ? this.speedNow : 0);
    this.blur.value += (target - this.blur.value) * (1 - Math.exp(-dt * 3));
    if (this.blurPipeline && this.blur.value > 0.0015) this.blurPipeline.render();
    else this.renderer.render(this.scene, this.camera);

    if (now - this.lastReport > 80) {
      this.lastReport = now;
      this.onFrame?.({ t: this.time, playing: this.playing });
    }
  }

  private placeRunner(animDt: number) {
    const { track, data } = this;
    const at = locate(data.channels.t, this.time);
    const i = at.i;
    const j = Math.min(track.n - 1, i + 1);
    const f = at.f;
    if (track.n === 0) return;
    // Position on the dense spline path (round corners, matches the ribbon)
    const d = track.dense;
    const di = track.denseIndex(i, f);
    const k = Math.floor(di);
    const k2 = Math.min(d.n - 1, k + 1);
    const ff = di - k;
    const x = lerp(d.x[k]!, d.x[k2]!, ff);
    const z = lerp(d.z[k]!, d.z[k2]!, ff);
    const y = Math.max(lerp(d.y[k]!, d.y[k2]!, ff), this.terrain.heightAt(x, z)) + 0.05;
    this.runnerPos.set(x, y, z);
    this.heading = lerp(d.heading[k]!, d.heading[k2]!, ff);
    const root = this.runner.root;
    root.position.copy(this.runnerPos);
    root.rotation.y = this.heading;

    // Turn rate per meter over ±15 m, for leaning into corners
    let a = k;
    let b = k2;
    while (a > 0 && d.s[k]! - d.s[a]! < 15) a--;
    while (b < d.n - 1 && d.s[b]! - d.s[k]! < 15) b++;
    const ds = d.s[b]! - d.s[a]!;
    const curvature = ds > 3 ? (d.heading[b]! - d.heading[a]!) / ds : 0;

    const c = data.channels;
    const hr = valueAt(c.hr, at);
    const zone = hrZone(hr, this.zones);
    // Garmin's speed is smoothed and can read 0 while the distance already
    // grows (the first half-minute of a run): take the faster of the two
    const i0 = Math.max(0, i - 2);
    const i1 = Math.min(c.t.length - 1, j + 2);
    const span = c.t[i1]! - c.t[i0]!;
    const fromDistance = span > 0 && span < 30 ? Math.max(0, (c.d[i1]! - c.d[i0]!) / span) : 0;
    const speed = Math.max(valueAt(c.speed, at) ?? 0, Math.min(fromDistance, 12));
    // Stopped (auto-pause gap or standing): a gap in time without distance
    const gap = c.t[j]! - c.t[i]! > 20 && c.d[j]! - c.d[i]! < 5;
    this.speedNow = gap ? 0 : speed;
    this.runner.update(animDt, {
      speed: gap ? 0 : speed,
      cadence: valueAt(c.cad, at),
      gct: valueAt(c.gct, at),
      vo: valueAt(c.vo, at),
      grade: lerp(track.grade[i]!, track.grade[j]!, f),
      curvature,
      hr,
      zoneColor: this.zoneColors[zone]!,
      rate: this.playing ? this.rate : 1,
    });
    this.route.setProgress(i + f);

    if (animDt > 0) {
      const head = this.runner.headWorld(tmpV);
      const fwd = tmpV2.set(Math.sin(this.heading), 0, Math.cos(this.heading));
      const resp = valueAt(c.resp, at);
      this.breath.update(
        animDt * Math.min(this.rate, 3),
        head,
        fwd,
        speed,
        resp ? resp / 60 : 0.45 + speed * 0.1,
      );
    }
  }

  private updateSun(force: boolean) {
    if (!force && Math.abs(this.time - this.lastSunT) < 5) return;
    this.lastSunT = this.time;
    const ms = this.startMs + this.time * 1000;
    const { elevation, azimuth } = sunPosition(ms, this.origin.lat, this.origin.lon);
    const el = (elevation * Math.PI) / 180;
    const az = (azimuth * Math.PI) / 180;
    // North = −z, east = +x
    const dir = new THREE.Vector3(
      Math.sin(az) * Math.cos(el),
      Math.sin(el),
      -Math.cos(az) * Math.cos(el),
    );
    this.sky.sunPosition.value.copy(dir);

    const day = smoothstepJs(-6, 10, elevation);
    const sunUp = smoothstepJs(-1.5, 8, elevation);
    const dim = 1 - this.cloud * 0.65;
    const night = 1 - smoothstepJs(-10, -1, elevation);
    // The directional light is the sun by day and the moon at night
    if (elevation > -1.5) {
      this.sunDir.copy(dir);
      const warm = smoothstepJs(0, 25, elevation);
      this.sun.color.setRGB(1, lerp(0.62, 0.96, warm), lerp(0.38, 0.9, warm));
      this.sun.intensity = 3.2 * sunUp * dim + 0.05;
    } else {
      this.sunDir.set(-dir.x, 0.75, -dir.z).normalize();
      this.sun.color.set("#9fb3e6");
      this.sun.intensity = 0.35 * night;
    }
    this.hemi.intensity = lerp(0.1, 0.32, day) * lerp(1, 1.35, this.cloud);
    this.hemi.color.setRGB(lerp(0.3, 0.74, day), lerp(0.36, 0.84, day), lerp(0.55, 0.94, day));
    const fog = this.scene.fog as THREE.Fog;
    const dusk = 1 - Math.abs(smoothstepJs(-6, 14, elevation) * 2 - 1);
    fog.color.setRGB(
      lerp(lerp(0.07, 0.78, day), 0.86, dusk * 0.6),
      lerp(lerp(0.09, 0.84, day), 0.68, dusk * 0.6),
      lerp(lerp(0.14, 0.9, day), 0.58, dusk * 0.6),
    );
    if (this.cloud > 0.6)
      fog.color.lerp(new THREE.Color(0.62, 0.66, 0.7).multiplyScalar(lerp(0.15, 1, day)), 0.5);
    this.stars.material.opacity = night * (1 - this.cloud);
    this.headlamp.intensity = night * 60;
    // Cloud shadows: as many as the sky has clouds, faint once it's overcast
    // (the light is diffuse then) and gone with the sun
    cloudLight.cover.value = THREE.MathUtils.clamp(this.cloud * 0.9, 0.05, 0.85);
    cloudLight.strength.value = 0.55 * sunUp * (1 - smoothstepJs(0.75, 1, this.cloud));
    treeWind.value = 0.3 + Math.hypot(this.wind.x, this.wind.y) * 1.6;
    // Grass leans downwind; a breeze even on a still day
    const wl = Math.hypot(this.wind.x, this.wind.y);
    grassLight.wind.value
      .set(this.wind.x, this.wind.y)
      .divideScalar(wl || 1)
      .multiplyScalar(0.25 + wl * 0.9);
    // Facades: lit rooms come on before it's fully dark; glass mirrors the sky
    facadeLight.night.value = 1 - smoothstepJs(-4, 4, elevation);
    facadeLight.day.value = day;
    const skyGain = lerp(0.25, 2.6, day) * dim;
    facadeLight.horizon.value.copy(fog.color).multiplyScalar(skyGain);
    facadeLight.zenith.value
      .setRGB(lerp(0.05, 0.36, day), lerp(0.07, 0.55, day), lerp(0.13, 0.95, day))
      .lerp(fog.color, this.cloud * 0.7)
      .multiplyScalar(skyGain);
    this.renderer.toneMappingExposure = lerp(1.8, 1.12, day);
    this.updateEnvironment(dir, day);
  }

  private sunDir = new THREE.Vector3(0, 1, 0);
  private lastEnvAt = 0;
  private maxPixelRatio = 1.5;
  private lastScaleAt = 0;

  /**
   * Adaptive detail (after tw-tree): a smoothed frame time steers `quality`,
   * which sets how far trees and balconies are drawn. Only at the floor does
   * the pixel ratio drop — and it comes back first when there's headroom.
   */
  private adaptQuality(dt: number, now: number) {
    if (dt > 0.5) return; // a hidden tab or a breakpoint, not a slow frame
    this.frameEma += (dt - this.frameEma) * 0.05;
    if (now - this.lastScaleAt < 1000) return;
    this.lastScaleAt = now;
    const pr = this.renderer.getPixelRatio();
    if (this.frameEma > 1 / 40) {
      if (this.quality > 0.4) this.quality = Math.max(0.4, this.quality * 0.82);
      // Never below 1× CSS pixels: thin lines turn into visible stair steps
      else if (pr > 1) this.setPixelRatio(Math.max(1, pr - 0.2));
    } else if (this.frameEma < 1 / 56) {
      if (pr < this.maxPixelRatio) this.setPixelRatio(Math.min(this.maxPixelRatio, pr + 0.1));
      else if (this.quality < 1) this.quality = Math.min(1, this.quality * 1.12);
    }
  }

  private setPixelRatio(pr: number) {
    this.renderer.setPixelRatio(pr);
    this.resize();
  }

  /** Balconies near the camera only; trees refill their near/far sets. */
  private lastDetailAt = 0;
  private updateDetails(now: number) {
    const cam = this.camera.position;
    this.forest?.update(cam, this.quality, now);
    this.grass?.update(cam, this.quality, now);
    if (now - this.lastDetailAt < 200) return;
    this.lastDetailAt = now;
    for (const d of this.details) {
      const r = d.radius * this.quality + 250; // (+ half a tile's diagonal)
      d.object.visible = (d.x - cam.x) ** 2 + (d.z - cam.z) ** 2 < r * r;
    }
  }

  /**
   * The sun's shadow map is redrawn only when something in it changed: the
   * runner moved or the sun did. Paused, orbiting the camera costs no shadow
   * pass at all.
   */
  private updateShadow() {
    const last = this.lastShadow;
    const p = this.sun.target.position;
    const moved =
      p.x !== last.x ||
      p.y !== last.y ||
      p.z !== last.z ||
      this.time !== last.t ||
      this.sunDir.distanceToSquared(last.sun) > 1e-10;
    if (!moved) return;
    last.x = p.x;
    last.y = p.y;
    last.z = p.z;
    last.t = this.time;
    last.sun.copy(this.sunDir);
    this.sun.shadow.needsUpdate = true;
  }

  private fogRange = { near: 300, far: 2600 };

  /** Fog starts beyond what the camera looks at, so far views aren't swallowed. */
  private updateFog() {
    const fog = this.scene.fog as THREE.Fog;
    const dist = this.camera.position.distanceTo(this.controls.target);
    fog.near = this.fogRange.near + dist;
    fog.far = this.fogRange.far + dist * 1.3;
    // The ribbon is too thin to see from far away: show the route line instead
    this.route.setFar(dist > 70);
  }

  /** Image-based lighting from the sky, refreshed when the sun moves. */
  private updateEnvironment(dir: THREE.Vector3, day: number) {
    if (this.scene.environment) {
      // Re-baking the environment is costly: only when the sun moved noticeably,
      // and at most every few seconds (fast-forward moves it quickly)
      if (dir.angleTo(this.lastEnvSun) < 0.05) return;
      if (performance.now() - this.lastEnvAt < 3000) return;
    }
    this.lastEnvSun.copy(dir);
    this.lastEnvAt = performance.now();
    this.envGroundMat.color.setRGB(0.46, 0.42, 0.33).multiplyScalar(lerp(0.03, 1, day));
    try {
      this.pmrem ??= new THREE.PMREMGenerator(this.renderer);
      const prev = this.envTarget;
      const photo = this.skyLight ? this.photoEnvironment(dir) : null;
      this.envTarget = photo
        ? this.pmrem.fromEquirectangular(photo)
        : this.pmrem.fromScene(this.envScene, 0.04);
      this.scene.environment = this.envTarget.texture;
      prev?.dispose();
    } catch {
      // Hemisphere light alone
    }
    // Without the sun disc the sky map is in a sane range: it now carries the
    // sky's light and real reflections (the hemisphere light only fills in)
    this.scene.environmentIntensity = lerp(0.2, 0.34, day) * lerp(1, 1.1, this.cloud);
  }

  /**
   * The sky photos blended for this sun and weather, as bright as the plain
   * dome would be (its colors are the generated sky's), so exposure and the
   * rest of the lighting stay as tuned.
   */
  private photoEnvironment(dir: THREE.Vector3): THREE.Texture | null {
    const elevation = (Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)) * 180) / Math.PI;
    const urban = (this.map?.buildings.length ?? 0) > 40;
    const weights = skyWeights(elevation, this.cloud, urban);
    const h = facadeLight.horizon.value;
    const z = facadeLight.zenith.value;
    const tint = new THREE.Color(h.r + z.r, h.g + z.g, h.b + z.b).multiplyScalar(0.5);
    // The dome's mean luminance over the upper hemisphere (zenith pulled
    // halfway to the horizon, as in buildWorld)
    const target = 0.2126 * tint.r + 0.7152 * tint.g + 0.0722 * tint.b;
    return (
      this.skyLight!.build(weights, dir, target, tint, this.envGroundMat.color)?.texture ?? null
    );
  }

  private updateCamera(dt: number) {
    const target = tmpV.copy(this.runnerPos).add(new THREE.Vector3(0, 1.25, 0));
    const controls = this.controls;
    if (this.mode === "overview") {
      controls.update();
      this.keepAboveGround();
      this.updateSunLight();
      return;
    }
    // Work on the camera where the user and the chase put it, before any
    // building pushed it (feeding the pushed position back in made it shake)
    if (this.hasDesired) this.camera.position.copy(this.lastTarget).add(this.desired);
    // Follow the runner: move the camera by the runner's movement
    const delta = tmpV2.copy(target).sub(this.lastTarget);
    if (delta.length() < 50) this.camera.position.add(delta);
    this.lastTarget.copy(target);
    controls.target.copy(target);

    const userActive = performance.now() < this.userActiveUntil;
    if (!userActive) {
      const offset = new THREE.Vector3().subVectors(this.camera.position, target);
      const sph = new THREE.Spherical().setFromVector3(offset);
      const want = this.cameraGoal();
      if (this.mode === "drone") this.droneAngle += dt * 0.12;
      let dTheta = want.theta - sph.theta;
      while (dTheta > Math.PI) dTheta -= 2 * Math.PI;
      while (dTheta < -Math.PI) dTheta += 2 * Math.PI;
      const k = 1 - Math.exp(-dt * 2.2);
      sph.theta += dTheta * k;
      sph.phi += (want.phi - sph.phi) * k;
      sph.radius += (want.radius - sph.radius) * k * 0.6;
      offset.setFromSpherical(sph);
      this.camera.position.copy(target).add(offset);
    }
    controls.update();
    this.keepAboveGround();
    this.desired.subVectors(this.camera.position, target);
    this.hasDesired = true;
    this.avoidBuildings(target, dt);
    this.updateSunLight();
  }

  /**
   * Nearest building along a fat sight line (center ±1.2 m sideways), so the
   * camera isn't left peeking through a gap between two walls.
   */
  private sightHit(target: THREE.Vector3, cam: THREE.Vector3): number {
    const occ = this.occluders!;
    const dx = cam.x - target.x;
    const dz = cam.z - target.z;
    const l = Math.hypot(dx, dz) || 1;
    const sx = (-dz / l) * 1.2;
    const sz = (dx / l) * 1.2;
    let hit = firstBuildingHit(occ, target, cam);
    for (const k of [-1, 1]) {
      const a = new THREE.Vector3(target.x + sx * k, target.y, target.z + sz * k);
      const b = new THREE.Vector3(cam.x + sx * k, cam.y, cam.z + sz * k);
      hit = Math.min(hit, firstBuildingHit(occ, a, b));
    }
    return hit;
  }

  /**
   * Spring arm. The camera the user and the chase logic steer (`desired`) is
   * never moved by buildings; the camera drawn is derived from it each frame:
   * if a building blocks the view, first raised over the roofs at the same
   * distance, else pulled in front of it. The adjustment snaps in quickly and
   * eases back out slowly, and since it's always measured from `desired`, it
   * can't feed back into itself.
   */
  private avoidBuildings(target: THREE.Vector3, dt: number) {
    if (!this.occluders) return;
    const sph = new THREE.Spherical().setFromVector3(this.desired);
    const wanted = this.camera.position;
    let lift = 0;
    let scale = 1;
    const hit = this.sightHit(target, wanted);
    if (Number.isFinite(hit)) {
      const candidate = new THREE.Vector3();
      let clear = false;
      for (let dl = 0.15; sph.phi - dl >= 0.25; dl += 0.15) {
        candidate
          .setFromSpherical(new THREE.Spherical(sph.radius, sph.phi - dl, sph.theta))
          .add(target);
        if (!Number.isFinite(this.sightHit(target, candidate))) {
          lift = dl;
          clear = true;
          break;
        }
      }
      if (!clear) scale = Math.max(1.2, hit - 0.7) / sph.radius;
    }
    const arm = this.arm;
    const kIn = 1 - Math.exp(-dt * 25);
    const kOut = 1 - Math.exp(-dt * 2.5);
    arm.lift += (lift - arm.lift) * (lift > arm.lift ? kIn : kOut);
    arm.scale += (scale - arm.scale) * (scale < arm.scale ? kIn : kOut);
    if (arm.lift < 1e-3 && arm.scale > 0.999) return;
    sph.phi = Math.max(0.2, sph.phi - arm.lift);
    sph.radius *= arm.scale;
    this.camera.position.setFromSpherical(sph).add(target);
    this.keepAboveGround();
    this.camera.lookAt(target);
  }

  private cameraGoal(): { theta: number; phi: number; radius: number } {
    const h = this.heading;
    switch (this.mode) {
      case "side":
        return { theta: h - Math.PI / 2, phi: 1.42, radius: 6.5 };
      case "front":
        return { theta: h, phi: 1.38, radius: 5.2 };
      case "drone":
        return { theta: h + Math.PI + this.droneAngle, phi: 0.72, radius: 32 };
      default:
        return { theta: h + Math.PI, phi: 1.24, radius: 6 };
    }
  }

  private snapCamera() {
    if (this.mode === "overview") return;
    const target = new THREE.Vector3().copy(this.runnerPos).add(new THREE.Vector3(0, 1.25, 0));
    const g = this.cameraGoal();
    const offset = new THREE.Vector3().setFromSpherical(
      new THREE.Spherical(g.radius, g.phi, g.theta),
    );
    this.camera.position.copy(target).add(offset);
    this.controls.target.copy(target);
    this.lastTarget.copy(target);
    this.controls.update();
    this.hasDesired = false;
    this.arm = { lift: 0, scale: 1 };
  }

  private keepAboveGround() {
    const p = this.camera.position;
    const ground = this.terrain.heightAt(p.x, p.z) + 0.8;
    if (p.y < ground) p.y = ground;
  }

  /** Point the sun (or moon) at the area around the camera and runner. */
  private updateSunLight() {
    const focus = this.mode === "overview" ? this.controls.target : this.runnerPos;
    // Snap the shadow box to whole shadow-map texels across the light, so
    // shadow edges don't crawl as it follows the runner
    const cam = this.sun.shadow.camera;
    const texel = (cam.right - cam.left) / this.sun.shadow.mapSize.x;
    const d = this.sunDir;
    const right = tmpSnapA.set(0, 1, 0).cross(d);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    const up = tmpSnapB.copy(d).cross(right).normalize();
    const a = Math.round(focus.dot(right) / texel) * texel;
    const b = Math.round(focus.dot(up) / texel) * texel;
    const c = focus.dot(d);
    const snapped = tmpSnapC
      .copy(right)
      .multiplyScalar(a)
      .addScaledVector(up, b)
      .addScaledVector(d, c);
    this.sun.target.position.copy(snapped);
    this.sun.position.copy(snapped).addScaledVector(d, 300);
    this.sun.target.updateMatrixWorld();
  }

  /**
   * Dress the runner: the female or male character (from the profile unless
   * picked), its build from the athlete's BMI and its size from their height.
   */
  async setRunnerBody(body: RunnerBody) {
    this.body = body;
    const load = ++this.bodyLoad;
    const athlete = this.data.athlete ?? null;
    const model = await loadRunnerModel(runnerSex(body, athlete));
    if (this.disposed || load !== this.bodyLoad) return;
    this.bodyModel?.dispose();
    this.bodyModel = null;
    if (!model) {
      this.runner.detachModel();
      return;
    }
    shapeRunner(model, heavyInfluence(athlete));
    this.runner.attachModel(model);
    const height = athlete?.heightCm ? athlete.heightCm / 100 : null;
    this.runner.root.scale.setScalar(
      height ? THREE.MathUtils.clamp(height / this.runner.modelHeight, 0.86, 1.16) : 1,
    );
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) withCloudShadows(m.material as THREE.Material);
    });
    this.bodyModel = {
      object: model,
      dispose() {
        model.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          m.geometry.dispose();
          (m.material as THREE.Material).dispose();
        });
      },
    };
  }

  dispose() {
    this.disposed = true;
    this.bodyModel?.dispose();
    this.renderer?.setAnimationLoop(null);
    this.resizeObserver?.disconnect();
    this.controls?.dispose();
    this.route?.dispose();
    for (const d of this.disposeLater) d.dispose();
    this.terrain?.dispose();
    this.runner.dispose();
    this.breath.dispose();
    this.stars.dispose();
    for (const e of this.effects) e.dispose();
    this.envTarget?.dispose();
    this.pmrem?.dispose();
    this.blurPipeline?.dispose();
    this.renderer?.dispose();
    disposeClouds();
  }
}
