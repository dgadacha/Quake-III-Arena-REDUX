import * as THREE from 'three';

/**
 * Secousses de camera. Chaque source declare une amplitude et une duree ;
 * l'amplitude recue decroit avec la distance, et les secousses en cours
 * s'additionnent sans jamais depasser une limite fixee.
 *
 * L'effet ne touche que l'affichage : la position simulee du joueur, sa visee
 * et ses tirs n'en savent rien.
 */
export interface ShakeSource {
  position: THREE.Vector3;
  /** Amplitude a la source, en unites de carte. */
  amplitude: number;
  radius: number;
  duration: number;
}

interface ActiveShake {
  amplitude: number;
  age: number;
  duration: number;
  frequency: number;
  seed: number;
}

/** Au-dela, une secousse rendrait la visee impraticable. */
const MAX_OFFSET = 6;

export class CameraShakeManager {
  private readonly active: ActiveShake[] = [];
  private readonly offset = new THREE.Vector3();
  enabled = true;

  /** Ajoute une secousse ressentie depuis un point de vue donne. */
  add(source: ShakeSource, viewer: THREE.Vector3): void {
    if (!this.enabled) return;
    const distance = viewer.distanceTo(source.position);
    const falloff = Math.max(0, 1 - distance / Math.max(1, source.radius));
    if (falloff <= 0) return;

    this.active.push({
      amplitude: source.amplitude * falloff,
      age: 0,
      duration: Math.max(0.05, source.duration),
      // Une secousse courte tremble plus vite qu'une longue.
      frequency: 18 + 12 / source.duration,
      seed: Math.random() * 100,
    });
  }

  /** Decalage a appliquer a la camera pour l'image en cours. */
  update(delta: number): THREE.Vector3 {
    this.offset.set(0, 0, 0);
    for (let i = this.active.length - 1; i >= 0; i--) {
      const shake = this.active[i];
      shake.age += delta;
      if (shake.age >= shake.duration) {
        this.active.splice(i, 1);
        continue;
      }
      // L'amplitude s'eteint sur la duree, sans rebond.
      const remaining = 1 - shake.age / shake.duration;
      const strength = shake.amplitude * remaining * remaining;
      const phase = shake.age * shake.frequency + shake.seed;
      this.offset.x += Math.sin(phase * 1.13) * strength;
      this.offset.y += Math.sin(phase * 0.91 + 1.7) * strength;
      this.offset.z += Math.sin(phase * 1.37 + 3.1) * strength;
    }

    const length = this.offset.length();
    if (length > MAX_OFFSET) this.offset.multiplyScalar(MAX_OFFSET / length);
    return this.offset;
  }

  get count(): number {
    return this.active.length;
  }

  clear(): void {
    this.active.length = 0;
  }
}
