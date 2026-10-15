/**
 * The runner's body: a MakeHuman character (CC0, built by
 * scripts/runner-model/build_runner.py) inlined into the bundle, so nothing is
 * fetched at run time. The procedural skeleton in runner.ts still drives the
 * gait; `Runner.attachModel` copies its motion onto this model's bones.
 */
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import runnerFemale from "./assets/runner-female.glb?inline";

/** Decode the inlined data URL without fetch(): a host's CSP may forbid fetching even data: URLs. */
function bytes(dataUrl: string): ArrayBuffer {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Hair, brows and lashes are cut-outs; everything else is opaque. */
const CUTOUT = /hair|ponytail|bob|braid|afro|eyebrow|eyelash/i;

function toNodeMaterial(
  m: THREE.MeshStandardMaterial,
  name: string,
): THREE.MeshStandardNodeMaterial {
  const cut = CUTOUT.test(name);
  const skin = /body|base/i.test(name);
  return new THREE.MeshStandardNodeMaterial({
    name: m.name,
    map: m.map,
    normalMap: m.normalMap,
    color: m.color,
    roughness: skin ? 0.52 : cut ? 0.75 : 0.7,
    metalness: 0,
    transparent: false,
    alphaTest: cut ? 0.45 : 0,
    side: cut ? THREE.DoubleSide : THREE.FrontSide,
  });
}

export async function loadRunnerModel(): Promise<THREE.Group | null> {
  try {
    const loader = new GLTFLoader();
    // Decode embedded textures with <img> rather than fetch() of blob URLs
    // (ImageBitmapLoader), for the same CSP reason
    loader.register((parser) => {
      (parser as unknown as { textureLoader: THREE.Loader }).textureLoader =
        new THREE.TextureLoader(parser.options.manager);
      return { name: "runner_image_element_textures" };
    });
    const gltf = await loader.parseAsync(bytes(runnerFemale), "");
    const model = gltf.scene;
    model.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false; // (skinned: the bind-pose bounds don't follow the run)
      const old = mesh.material as THREE.MeshStandardMaterial;
      mesh.material = toNodeMaterial(old, `${mesh.name} ${old.name}`);
      old.dispose();
    });
    return model;
  } catch (e) {
    console.warn("[replay] runner model failed to load; using the built-in runner", e);
    return null;
  }
}
