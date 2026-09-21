import * as THREE from 'three';
import type { ParticleSystem } from './ParticleSystem';
import type { DynamicLightManager } from '../lighting/DynamicLightManager';

/**
 * Depart de coup. L'eclat est tres bref, quelques dizaines de millisecondes :
 * assez pour marquer le tir et eclairer les murs proches, trop court pour gener
 * la lecture de la scene.
 */

export interface MuzzleFlashSpec {
  position: THREE.Vector3;
  direction: THREE.Vector3;
  /** Taille de l'eclat, en unites de carte. */
  size?: number;
  color?: THREE.Color;
  /** Duree en secondes ; le jeu tient dans une fourchette de 20 a 80 ms. */
  duration?: number;
  smoke?: boolean;
}

export class MuzzleFlashSystem {
  constructor(
    private readonly particles: ParticleSystem,
    private readonly lights: DynamicLightManager,
  ) {}

  flash(spec: MuzzleFlashSpec): void {
    const color = spec.color ?? new THREE.Color(1, 0.82, 0.45);
    const size = spec.size ?? 14;
    const duration = spec.duration ?? 0.05;

    // Grain lumineux tres vif : il depasse le blanc pour nourrir le halo.
    this.particles.spawn({
      position: spec.position.clone(),
      velocity: spec.direction.clone().multiplyScalar(60),
      size,
      sizeEnd: size * 1.5,
      color: new THREE.Color(color.r * 3.2, color.g * 2.8, color.b * 2.2),
      colorEnd: color.clone(),
      opacity: 1,
      opacityEnd: 0,
      lifetime: duration,
      kind: 'flare',
    });

    // Lampe encore plus courte : elle marque les parois sans laisser de trace.
    this.lights.add({
      position: [spec.position.x, spec.position.y, spec.position.z],
      color: color.clone(),
      intensity: 500,
      radius: 320,
      kind: 'muzzle',
      duration: Math.max(0.04, duration),
      priority: 80,
    });

    if (spec.smoke !== false) {
      for (let i = 0; i < 3; i++) {
        this.particles.spawn({
          position: spec.position.clone(),
          velocity: spec.direction
            .clone()
            .multiplyScalar(40 + Math.random() * 40)
            .add(new THREE.Vector3((Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, 10)),
          drag: 2.5,
          size: 5 + Math.random() * 4,
          sizeEnd: 20 + Math.random() * 10,
          angularVelocity: (Math.random() - 0.5) * 2,
          color: new THREE.Color(0.28, 0.27, 0.26),
          colorEnd: new THREE.Color(0.12, 0.12, 0.12),
          opacity: 0.35,
          opacityEnd: 0,
          lifetime: 0.5 + Math.random() * 0.4,
          kind: 'smoke',
        });
      }
    }
  }
}
