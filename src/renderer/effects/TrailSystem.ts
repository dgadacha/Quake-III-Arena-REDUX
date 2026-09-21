import * as THREE from 'three';
import type { ParticleSystem } from './ParticleSystem';

/**
 * Trainees de projectiles. Les particules sont semees le long du trajet
 * reellement parcouru entre deux images, et non a la position courante : a la
 * vitesse d'une roquette, poser un seul grain par image laisserait des trous
 * dans la trainee.
 */

export type TrailKind = 'rocket' | 'plasma' | 'grenade';

interface Emitter {
  id: number;
  kind: TrailKind;
  last: THREE.Vector3;
  /** Distance restant a parcourir avant la prochaine particule. */
  carry: number;
  active: boolean;
}

interface TrailProfile {
  /** Distance entre deux particules, en unites de carte. */
  spacing: number;
  size: number;
  sizeEnd: number;
  color: THREE.Color;
  colorEnd: THREE.Color;
  lifetime: number;
  smoke: boolean;
}

const PROFILES: Record<TrailKind, TrailProfile> = {
  rocket: {
    spacing: 14,
    size: 7,
    sizeEnd: 26,
    color: new THREE.Color(1.6, 0.8, 0.3),
    colorEnd: new THREE.Color(0.16, 0.15, 0.14),
    lifetime: 0.7,
    smoke: true,
  },
  plasma: {
    spacing: 18,
    size: 5,
    sizeEnd: 1,
    color: new THREE.Color(0.5, 1.4, 2.6),
    colorEnd: new THREE.Color(0.1, 0.3, 0.8),
    lifetime: 0.25,
    smoke: false,
  },
  grenade: {
    spacing: 22,
    size: 4,
    sizeEnd: 12,
    color: new THREE.Color(0.5, 0.6, 0.5),
    colorEnd: new THREE.Color(0.12, 0.13, 0.12),
    lifetime: 0.5,
    smoke: true,
  },
};

export class TrailSystem {
  private readonly emitters: Emitter[] = [];
  private nextId = 1;

  constructor(private readonly particles: ParticleSystem, capacity = 32) {
    for (let i = 0; i < capacity; i++) {
      this.emitters.push({ id: 0, kind: 'rocket', last: new THREE.Vector3(), carry: 0, active: false });
    }
  }

  get activeCount(): number {
    return this.emitters.reduce((total, emitter) => total + (emitter.active ? 1 : 0), 0);
  }

  /** Ouvre une trainee et rend son identifiant, ou zero si la reserve est pleine. */
  start(kind: TrailKind, position: THREE.Vector3): number {
    const emitter = this.emitters.find((entry) => !entry.active);
    if (!emitter) return 0;
    emitter.id = this.nextId++;
    emitter.kind = kind;
    emitter.last.copy(position);
    emitter.carry = 0;
    emitter.active = true;
    return emitter.id;
  }

  /** Seme les particules entre l'ancienne et la nouvelle position. */
  advance(id: number, position: THREE.Vector3): void {
    const emitter = this.emitters.find((entry) => entry.active && entry.id === id);
    if (!emitter) return;

    const profile = PROFILES[emitter.kind];
    const travelled = emitter.last.distanceTo(position);
    if (travelled <= 0) return;

    const direction = position.clone().sub(emitter.last).divideScalar(travelled);
    let distance = emitter.carry;
    while (distance < travelled) {
      const point = emitter.last.clone().addScaledVector(direction, distance);
      this.particles.spawn({
        position: point,
        velocity: direction.clone().multiplyScalar(-20).add(jitter(8)),
        drag: 2,
        size: profile.size,
        sizeEnd: profile.sizeEnd,
        color: profile.color.clone(),
        colorEnd: profile.colorEnd.clone(),
        opacity: profile.smoke ? 0.6 : 1,
        opacityEnd: 0,
        lifetime: profile.lifetime,
        kind: profile.smoke ? 'smoke' : 'flare',
      });
      distance += profile.spacing;
    }

    emitter.carry = distance - travelled;
    emitter.last.copy(position);
  }

  stop(id: number): void {
    const emitter = this.emitters.find((entry) => entry.active && entry.id === id);
    if (emitter) emitter.active = false;
  }

  clear(): void {
    for (const emitter of this.emitters) emitter.active = false;
  }
}

function jitter(amount: number): THREE.Vector3 {
  return new THREE.Vector3(
    (Math.random() - 0.5) * amount,
    (Math.random() - 0.5) * amount,
    (Math.random() - 0.5) * amount,
  );
}
