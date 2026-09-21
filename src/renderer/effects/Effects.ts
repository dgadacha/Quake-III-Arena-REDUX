import * as THREE from 'three';
import { DynamicLightManager } from '../lighting/DynamicLightManager';
import type { ModernRenderSettings } from '../RenderSettings';
import { BeamSystem } from './BeamSystem';
import { CameraShakeManager } from './CameraShakeManager';
import { DecalManager } from './DecalManager';
import { ExplosionSystem } from './ExplosionSystem';
import { MuzzleFlashSystem } from './MuzzleFlashSystem';
import { ParticleSystem } from './ParticleSystem';
import { TrailSystem } from './TrailSystem';

/**
 * Regroupe les effets et leur cycle de vie. Ils appartiennent a la scene et non
 * a la carte : changer de carte ne doit pas reconstruire des reserves entieres.
 *
 * Les lumieres des effets ont leur propre budget, separe de celui des lampes de
 * carte : l'eclat d'une explosion ne doit pas avoir a rivaliser avec l'eclairage
 * de fond pour obtenir une place.
 */

/** Capacites selon le niveau de qualite demande. */
const CAPACITY: Record<ModernRenderSettings['fxQuality'], { particles: number; decals: number; lights: number }> = {
  low: { particles: 400, decals: 32, lights: 2 },
  medium: { particles: 900, decals: 64, lights: 4 },
  high: { particles: 1800, decals: 96, lights: 6 },
  ultra: { particles: 3000, decals: 160, lights: 8 },
};

export class Effects {
  readonly particles: ParticleSystem;
  readonly decals: DecalManager;
  readonly shake = new CameraShakeManager();
  readonly lights = new DynamicLightManager();
  readonly explosions: ExplosionSystem;
  readonly muzzle: MuzzleFlashSystem;
  readonly trails: TrailSystem;
  readonly beams = new BeamSystem();

  private settings: ModernRenderSettings;
  private readonly offset = new THREE.Vector3();

  constructor(settings: ModernRenderSettings) {
    this.settings = settings;
    const capacity = CAPACITY[settings.fxQuality];

    this.particles = new ParticleSystem(capacity.particles);
    this.decals = new DecalManager(capacity.decals);
    this.explosions = new ExplosionSystem(this.particles, this.decals, this.lights, this.shake);
    this.muzzle = new MuzzleFlashSystem(this.particles, this.lights);
    this.trails = new TrailSystem(this.particles);
    this.shake.enabled = settings.cameraShake;
  }

  attach(scene: THREE.Scene): void {
    this.particles.attach(scene);
    this.decals.attach(scene);
    this.explosions.attach(scene);
    this.beams.attach(scene);
    this.lights.attach(scene, CAPACITY[this.settings.fxQuality].lights, 0);
  }

  applySettings(settings: ModernRenderSettings): void {
    this.settings = settings;
    this.shake.enabled = settings.cameraShake;
    if (!settings.particles) this.particles.clear();
    if (!settings.decals) this.decals.clear();
    if (!settings.cameraShake) this.shake.clear();
  }

  /** Avance tous les effets et rend le decalage de camera a appliquer. */
  update(delta: number, viewer: THREE.Vector3, camera: THREE.Camera): THREE.Vector3 {
    if (this.settings.particles) this.particles.update(delta);
    if (this.settings.decals) this.decals.update(delta);
    this.explosions.update(delta, camera);
    this.beams.update(delta);
    if (this.settings.dynamicLights) {
      this.lights.update(delta, [viewer.x, viewer.y, viewer.z]);
    }

    if (!this.settings.cameraShake) return this.offset.set(0, 0, 0);
    return this.offset.copy(this.shake.update(delta));
  }

  /** Vide tout : changement de carte, reapparition. */
  clear(): void {
    this.particles.clear();
    this.decals.clear();
    this.trails.clear();
    this.explosions.clear();
    this.beams.clear();
    this.shake.clear();
    this.lights.clearTransient();
  }

  get counts(): { particles: number; decals: number; trails: number } {
    return {
      particles: this.particles.activeCount,
      decals: this.decals.activeCount,
      trails: this.trails.activeCount,
    };
  }
}
