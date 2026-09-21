import * as THREE from 'three';
import type { ParticleSystem } from './ParticleSystem';
import type { DecalManager } from './DecalManager';
import type { CameraShakeManager } from './CameraShakeManager';
import type { DynamicLightManager } from '../lighting/DynamicLightManager';

/**
 * Explosions. Chaque composante est separee et peut etre coupee seule : eclat
 * lumineux, lampe, flammes, fumee, etincelles, onde de choc, trace au sol et
 * secousse de camera. C'est ce decoupage qui permet de juger ce que chaque
 * effet apporte, au lieu d'empiler des effets et d'esperer.
 */

export interface ExplosionParts {
  flash: boolean;
  light: boolean;
  fire: boolean;
  smoke: boolean;
  sparks: boolean;
  shockwave: boolean;
  decal: boolean;
  shake: boolean;
}

export const ALL_PARTS: ExplosionParts = {
  flash: true,
  light: true,
  fire: true,
  smoke: true,
  sparks: true,
  shockwave: true,
  decal: true,
  shake: true,
};

export interface ExplosionSpec {
  position: THREE.Vector3;
  /** Normale de la surface touchee, quand il y en a une. */
  normal?: THREE.Vector3;
  radius: number;
  color?: THREE.Color;
  /** Distance au joueur : les effets lointains sont allegis. */
  viewer: THREE.Vector3;
  parts?: Partial<ExplosionParts>;
}

interface Shockwave {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  age: number;
  duration: number;
  radius: number;
  active: boolean;
}

/** Au-dela, une explosion ne merite plus qu'un eclat et quelques particules. */
const FAR_DISTANCE = 1200;
const MID_DISTANCE = 500;

export class ExplosionSystem {
  private readonly waves: Shockwave[] = [];
  private readonly root = new THREE.Group();
  private readonly scratch = new THREE.Vector3();

  constructor(
    private readonly particles: ParticleSystem,
    private readonly decals: DecalManager,
    private readonly lights: DynamicLightManager,
    private readonly shake: CameraShakeManager,
    waveCount = 8,
  ) {
    this.root.name = 'shockwaves';
    const geometry = new THREE.RingGeometry(0.75, 1, 40);
    for (let i = 0; i < waveCount; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xffd9a0,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 25;
      this.root.add(mesh);
      this.waves.push({ mesh, material, age: 0, duration: 0.35, radius: 1, active: false });
    }
  }

  attach(parent: THREE.Object3D): void {
    parent.add(this.root);
  }

  spawn(spec: ExplosionSpec): void {
    const parts = { ...ALL_PARTS, ...spec.parts };
    const color = spec.color ?? new THREE.Color(1, 0.62, 0.22);
    const distance = spec.viewer.distanceTo(spec.position);
    // Le niveau de detail suit la distance : une explosion lointaine ne merite
    // pas le meme nombre de particules qu'une explosion sous le nez.
    const detail = distance > FAR_DISTANCE ? 0.25 : distance > MID_DISTANCE ? 0.6 : 1;

    if (parts.light) {
      this.lights.add({
        position: [spec.position.x, spec.position.y, spec.position.z],
        color: color.clone(),
        intensity: 900,
        radius: spec.radius * 3,
        kind: 'explosion',
        duration: 0.45,
        priority: 100,
      });
    }

    if (parts.flash) {
      // Un seul grain tres lumineux, tres bref : c'est lui qui alimente le halo.
      this.particles.spawn({
        position: spec.position.clone(),
        velocity: new THREE.Vector3(),
        size: spec.radius * 1.1,
        sizeEnd: spec.radius * 1.9,
        // Au-dessus du blanc pour nourrir le halo, sans blanchir la piece.
        color: new THREE.Color(2.2, 1.5, 0.9),
        colorEnd: color.clone(),
        opacity: 1,
        opacityEnd: 0,
        lifetime: 0.14,
        kind: 'flare',
      });
    }

    if (parts.fire) {
      const count = Math.round(18 * detail);
      for (let i = 0; i < count; i++) {
        const direction = randomDirection(this.scratch);
        this.particles.spawn({
          position: spec.position.clone().addScaledVector(direction, spec.radius * 0.2),
          velocity: direction.clone().multiplyScalar(spec.radius * (1.2 + Math.random() * 1.8)),
          drag: 3.2,
          gravity: -120,
          size: spec.radius * (0.35 + Math.random() * 0.35),
          sizeEnd: spec.radius * 0.1,
          color: new THREE.Color(2.4, 1.1, 0.35),
          colorEnd: new THREE.Color(0.5, 0.12, 0.03),
          lifetime: 0.28 + Math.random() * 0.25,
          kind: 'flare',
        });
      }
    }

    if (parts.smoke) {
      const count = Math.round(10 * detail);
      for (let i = 0; i < count; i++) {
        const direction = randomDirection(this.scratch);
        this.particles.spawn({
          position: spec.position.clone().addScaledVector(direction, spec.radius * 0.3),
          velocity: direction.clone().multiplyScalar(spec.radius * 0.5).setZ(30 + Math.random() * 40),
          drag: 1.4,
          size: spec.radius * (0.5 + Math.random() * 0.5),
          sizeEnd: spec.radius * (1.4 + Math.random()),
          angularVelocity: (Math.random() - 0.5) * 1.5,
          color: new THREE.Color(0.22, 0.2, 0.19),
          colorEnd: new THREE.Color(0.1, 0.1, 0.1),
          opacity: 0.7,
          opacityEnd: 0,
          lifetime: 1.1 + Math.random() * 0.8,
          kind: 'smoke',
        });
      }
    }

    if (parts.sparks) {
      const count = Math.round(24 * detail);
      for (let i = 0; i < count; i++) {
        const direction = randomDirection(this.scratch);
        this.particles.spawn({
          position: spec.position.clone(),
          velocity: direction.clone().multiplyScalar(spec.radius * (2.5 + Math.random() * 4)),
          gravity: 800,
          drag: 0.6,
          size: 2.5 + Math.random() * 2,
          sizeEnd: 0.6,
          color: new THREE.Color(3, 2, 0.9),
          colorEnd: new THREE.Color(1, 0.35, 0.08),
          lifetime: 0.4 + Math.random() * 0.5,
          kind: 'spark',
        });
      }
    }

    if (parts.shockwave && detail > 0.3) {
      this.spawnWave(spec.position, spec.normal, spec.radius, color);
    }

    if (parts.decal && spec.normal) {
      this.decals.add({
        position: spec.position.clone(),
        normal: spec.normal.clone(),
        size: spec.radius * 1.4,
        kind: 'burn',
        lifetime: 45,
      });
    }

    if (parts.shake) {
      this.shake.add(
        { position: spec.position.clone(), amplitude: 3.2, radius: spec.radius * 6, duration: 0.4 },
        spec.viewer,
      );
    }
  }

  update(delta: number, camera: THREE.Camera): void {
    for (const wave of this.waves) {
      if (!wave.active) continue;
      wave.age += delta;
      if (wave.age >= wave.duration) {
        wave.active = false;
        wave.mesh.visible = false;
        continue;
      }
      const life = wave.age / wave.duration;
      wave.mesh.scale.setScalar(wave.radius * (0.4 + life * 1.8));
      wave.material.opacity = (1 - life) * 0.55;
      // Sans normale de surface, l'anneau reste tourne vers le joueur.
      if (wave.mesh.userData.faceCamera) wave.mesh.quaternion.copy(camera.quaternion);
    }
  }

  clear(): void {
    for (const wave of this.waves) {
      wave.active = false;
      wave.mesh.visible = false;
    }
  }

  private spawnWave(
    position: THREE.Vector3,
    normal: THREE.Vector3 | undefined,
    radius: number,
    color: THREE.Color,
  ): void {
    const wave = this.waves.find((entry) => !entry.active) ?? this.waves[0];
    wave.active = true;
    wave.age = 0;
    wave.duration = 0.35;
    wave.radius = radius;
    wave.material.color.copy(color);
    wave.material.opacity = 0.55;
    wave.mesh.visible = true;
    wave.mesh.position.copy(position);
    if (normal) {
      wave.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
      wave.mesh.userData.faceCamera = false;
    } else {
      wave.mesh.userData.faceCamera = true;
    }
  }
}

/** Direction tiree au hasard sur la sphere, sans concentration aux poles. */
function randomDirection(out: THREE.Vector3): THREE.Vector3 {
  const z = Math.random() * 2 - 1;
  const angle = Math.random() * Math.PI * 2;
  const radius = Math.sqrt(Math.max(0, 1 - z * z));
  return out.set(Math.cos(angle) * radius, Math.sin(angle) * radius, z);
}
