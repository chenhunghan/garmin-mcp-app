/**
 * Ground decals (route line, trail, roads, water): drawn pulled
 * toward the camera along the view ray. On screen nothing moves, but the
 * layer wins the depth test against the terrain it lies on — covering both
 * the terrain bulging between the decal's vertices and depth precision far
 * away. Meshes must be in world coordinates (identity transform).
 */
import type * as THREE from "three/webgpu";
import { cameraPosition, positionLocal } from "three/tsl";

export function drape(mat: THREE.NodeMaterial, base = 0.18, perMeter = 0.0025) {
  const toCam = cameraPosition.sub(positionLocal);
  const d = toCam.length();
  mat.positionNode = positionLocal.add(toCam.div(d).mul(d.mul(perMeter).add(base).min(d.mul(0.5))));
  return mat;
}
