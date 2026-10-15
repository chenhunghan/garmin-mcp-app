/**
 * Ground decals (trail, roads, water): drawn pulled toward the camera along
 * the view ray. On screen nothing moves, but the layer wins the depth test
 * against the terrain it lies on — covering both the terrain bulging between
 * the decal's vertices and depth precision far away. Meshes must be in world
 * coordinates (identity transform).
 *
 * Not around the runner: there the pull would put the decal in front of the
 * feet standing on it (shoes and shins vanished into the road). Within
 * ~0.9 m of the runner there's no pull, full pull from ~2 m (polygon offset
 * still keeps the decal above the ground in between).
 */
import * as THREE from "three/webgpu";
import { cameraPosition, positionLocal, smoothstep, uniform, vec2 } from "three/tsl";

/** The runner's position (set every frame by the scene) */
export const drapeKeepOut = uniform(new THREE.Vector3(1e9, 0, 1e9));

export function drape(mat: THREE.NodeMaterial, base = 0.18, perMeter = 0.0025) {
  const toCam = cameraPosition.sub(positionLocal);
  const d = toCam.length();
  const fromRunner = positionLocal.xz.sub(vec2(drapeKeepOut.x, drapeKeepOut.z)).length();
  const keep = smoothstep(0.9, 2.0, fromRunner);
  mat.positionNode = positionLocal.add(
    toCam.div(d).mul(d.mul(perMeter).add(base).min(d.mul(0.5)).mul(keep)),
  );
  return mat;
}
