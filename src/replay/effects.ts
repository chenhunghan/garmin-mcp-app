/**
 * Weather and atmosphere effects: rain streaks or snowflakes around the
 * camera (from Garmin's weather description), breath puffs when it's cold,
 * and stars for night runs. Particles move in real time, independent of the
 * playback rate, so fast-forward doesn't turn rain into a blur.
 */
import * as THREE from "three/webgpu";

export interface Effect {
  object: THREE.Object3D;
  update(dt: number, camera: THREE.Camera, wind: THREE.Vector2): void;
  dispose(): void;
}

export function rain(heavy: boolean): Effect {
  const count = heavy ? 5000 : 2800;
  const box = 40;
  const positions = new Float32Array(count * 6);
  const seeds = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    seeds[i * 3] = (Math.random() - 0.5) * box;
    seeds[i * 3 + 1] = Math.random() * box * 0.6;
    seeds[i * 3 + 2] = (Math.random() - 0.5) * box;
  }
  const geo = new THREE.BufferGeometry();
  const attr = new THREE.BufferAttribute(positions, 3);
  attr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("position", attr);
  const mat = new THREE.LineBasicNodeMaterial({
    color: "#c8d4e0",
    transparent: true,
    opacity: heavy ? 0.42 : 0.32,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  const fall = 9;
  const len = 0.45;
  return {
    object: lines,
    update(dt, camera, wind) {
      const c = camera.position;
      for (let i = 0; i < count; i++) {
        let y = seeds[i * 3 + 1]! - fall * dt;
        if (y < -box * 0.15) y += box * 0.6;
        seeds[i * 3 + 1] = y;
        seeds[i * 3] = seeds[i * 3]! + wind.x * dt * 4;
        seeds[i * 3 + 2] = seeds[i * 3 + 2]! + wind.y * dt * 4;
        const wrap = (v: number) => ((((v + box / 2) % box) + box) % box) - box / 2;
        seeds[i * 3] = wrap(seeds[i * 3]!);
        seeds[i * 3 + 2] = wrap(seeds[i * 3 + 2]!);
        const x = c.x + seeds[i * 3]!;
        const yy = c.y + y - box * 0.2;
        const z = c.z + seeds[i * 3 + 2]!;
        positions[i * 6] = x;
        positions[i * 6 + 1] = yy;
        positions[i * 6 + 2] = z;
        positions[i * 6 + 3] = x - wind.x * 0.18;
        positions[i * 6 + 4] = yy + len;
        positions[i * 6 + 5] = z - wind.y * 0.18;
      }
      attr.needsUpdate = true;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}

export function snow(): Effect {
  const count = 2600;
  const box = 36;
  const geo = new THREE.IcosahedronGeometry(0.022, 0);
  const mat = new THREE.MeshBasicNodeMaterial({
    color: "#ffffff",
    transparent: true,
    opacity: 0.9,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.frustumCulled = false;
  const p = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    p[i * 4] = (Math.random() - 0.5) * box;
    p[i * 4 + 1] = Math.random() * box * 0.5;
    p[i * 4 + 2] = (Math.random() - 0.5) * box;
    p[i * 4 + 3] = Math.random() * 6.28;
  }
  const m = new THREE.Matrix4();
  let t = 0;
  return {
    object: mesh,
    update(dt, camera, wind) {
      t += dt;
      const c = camera.position;
      for (let i = 0; i < count; i++) {
        let y = p[i * 4 + 1]! - 0.9 * dt;
        if (y < -box * 0.1) y += box * 0.5;
        p[i * 4 + 1] = y;
        const ph = p[i * 4 + 3]!;
        const wrap = (v: number) => ((((v + box / 2) % box) + box) % box) - box / 2;
        p[i * 4] = wrap(p[i * 4]! + (wind.x * 1.5 + Math.sin(t + ph) * 0.3) * dt);
        p[i * 4 + 2] = wrap(p[i * 4 + 2]! + (wind.y * 1.5 + Math.cos(t * 0.8 + ph) * 0.3) * dt);
        m.makeTranslation(c.x + p[i * 4]!, c.y + y - box * 0.15, c.z + p[i * 4 + 2]!);
        mesh.setMatrixAt(i, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      mesh.dispose();
    },
  };
}

function puffTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(0.5, "rgba(255,255,255,0.35)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Breath vapour on exhale when it's cold (each puff drifts back and fades). */
export class Breath {
  readonly group = new THREE.Group();
  private puffs: {
    sprite: THREE.Sprite;
    mat: THREE.SpriteNodeMaterial;
    age: number;
    vel: THREE.Vector3;
  }[] = [];
  private tex = puffTexture();
  private next = 0;

  constructor(private strength: number) {
    for (let i = 0; i < 14; i++) {
      const mat = new THREE.SpriteNodeMaterial({
        map: this.tex,
        transparent: true,
        depthWrite: false,
        opacity: 0,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      this.group.add(sprite);
      this.puffs.push({ sprite, mat, age: 99, vel: new THREE.Vector3() });
    }
  }

  /** `exhale` once per breath; `mouth` and `forward` in world space; dt in animation time. */
  update(
    dt: number,
    mouth: THREE.Vector3,
    forward: THREE.Vector3,
    speed: number,
    breathsPerSec: number,
  ) {
    if (this.strength <= 0) return;
    this.next -= dt;
    if (this.next <= 0) {
      this.next = 1 / Math.max(0.3, breathsPerSec);
      const p = this.puffs.find((x) => x.age > 1.6);
      if (p) {
        p.age = 0;
        p.sprite.position.copy(mouth).addScaledVector(forward, 0.12);
        // The runner moves on; the vapour stays behind in the air
        p.vel
          .copy(forward)
          .multiplyScalar(0.4)
          .add(new THREE.Vector3(0, 0.12, 0));
        p.sprite.visible = true;
      }
    }
    for (const p of this.puffs) {
      if (p.age > 1.6) {
        p.sprite.visible = false;
        continue;
      }
      p.age += dt;
      p.sprite.position.addScaledVector(p.vel, dt);
      const s = 0.12 + p.age * 0.35;
      p.sprite.scale.set(s, s, s);
      p.mat.opacity = this.strength * 0.5 * Math.max(0, 1 - p.age / 1.6) * Math.min(1, p.age * 8);
    }
    void speed;
  }

  dispose() {
    this.tex.dispose();
    for (const p of this.puffs) p.mat.dispose();
  }
}

export function stars(): {
  object: THREE.Points;
  material: THREE.PointsNodeMaterial;
  dispose(): void;
} {
  const count = 2500;
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const u = Math.random();
    const v = Math.random() * 0.95 + 0.05;
    const theta = u * Math.PI * 2;
    const phi = Math.acos(v);
    pos[i * 3] = Math.sin(phi) * Math.cos(theta) * 9000;
    pos[i * 3 + 1] = Math.cos(phi) * 9000;
    pos[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * 9000;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const material = new THREE.PointsNodeMaterial({
    color: "#ffffff",
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
  });
  const object = new THREE.Points(geo, material);
  object.frustumCulled = false;
  return {
    object,
    material,
    dispose() {
      geo.dispose();
      material.dispose();
    },
  };
}
