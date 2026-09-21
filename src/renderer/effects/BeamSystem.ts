import * as THREE from 'three';

/**
 * Faisceaux : la trace du railgun et l'eclair du fusil a eclairs. Un cylindre
 * tendu entre deux points, en melange additif, repris dans une reserve fixe.
 *
 * La trace du railgun s'efface en quelques dixiemes de seconde ; l'eclair, lui,
 * est renouvele a chaque image tant que le joueur tire, avec une intensite qui
 * vacille : c'est ce battement qui le distingue d'un simple trait.
 */

export type BeamKind = 'rail' | 'lightning';

export interface BeamSpec {
  from: THREE.Vector3;
  to: THREE.Vector3;
  kind: BeamKind;
  color: THREE.Color;
  /** Epaisseur, en unites de carte. */
  width?: number;
  duration?: number;
}

interface Beam {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  age: number;
  duration: number;
  kind: BeamKind;
  baseOpacity: number;
  active: boolean;
}

export class BeamSystem {
  private readonly beams: Beam[] = [];
  private readonly root = new THREE.Group();
  private readonly direction = new THREE.Vector3();
  private readonly middle = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(capacity = 12) {
    this.root.name = 'beams';
    // Cylindre unitaire dresse sur l'axe des y : il sera oriente puis etire.
    const geometry = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
    for (let i = 0; i < capacity; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 22;
      this.root.add(mesh);
      this.beams.push({ mesh, material, age: 0, duration: 0.3, kind: 'rail', baseOpacity: 1, active: false });
    }
  }

  attach(parent: THREE.Object3D): void {
    parent.add(this.root);
  }

  get activeCount(): number {
    return this.beams.reduce((total, beam) => total + (beam.active ? 1 : 0), 0);
  }

  spawn(spec: BeamSpec): void {
    const beam = this.beams.find((entry) => !entry.active) ?? this.oldest();
    beam.active = true;
    beam.age = 0;
    beam.kind = spec.kind;
    beam.duration = spec.duration ?? (spec.kind === 'rail' ? 0.4 : 0.06);
    beam.baseOpacity = spec.kind === 'rail' ? 0.9 : 1;

    // Un faisceau trop epais mange la lisibilite de la scene.
    const width = spec.width ?? (spec.kind === 'rail' ? 1.4 : 3.2);
    this.direction.copy(spec.to).sub(spec.from);
    const length = this.direction.length();
    if (length < 1) {
      beam.active = false;
      beam.mesh.visible = false;
      return;
    }

    beam.material.color.copy(spec.color);
    beam.material.opacity = beam.baseOpacity;
    beam.mesh.visible = true;
    beam.mesh.scale.set(width, length, width);
    this.middle.copy(spec.from).add(spec.to).multiplyScalar(0.5);
    beam.mesh.position.copy(this.middle);
    beam.mesh.quaternion.setFromUnitVectors(this.up, this.direction.divideScalar(length));
  }

  update(delta: number): void {
    for (const beam of this.beams) {
      if (!beam.active) continue;
      beam.age += delta;
      if (beam.age >= beam.duration) {
        beam.active = false;
        beam.mesh.visible = false;
        continue;
      }
      const remaining = 1 - beam.age / beam.duration;
      if (beam.kind === 'rail') {
        // La trace s'amincit en s'effacant.
        beam.material.opacity = beam.baseOpacity * remaining * remaining;
        beam.mesh.scale.x = beam.mesh.scale.z = Math.max(0.2, 1.4 * remaining);
      } else {
        // L'eclair vacille au lieu de s'eteindre regulierement.
        beam.material.opacity = beam.baseOpacity * (0.55 + Math.random() * 0.45) * remaining;
        const flicker = 2.6 + Math.random() * 1.4;
        beam.mesh.scale.x = beam.mesh.scale.z = flicker;
      }
    }
  }

  clear(): void {
    for (const beam of this.beams) {
      beam.active = false;
      beam.mesh.visible = false;
    }
  }

  private oldest(): Beam {
    let oldest = this.beams[0];
    for (const beam of this.beams) {
      if (beam.age / beam.duration > oldest.age / oldest.duration) oldest = beam;
    }
    return oldest;
  }
}
