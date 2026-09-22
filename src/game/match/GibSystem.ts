import * as THREE from 'three';
import { Md3Model } from '../../formats/md3';
import type { VirtualFileSystem } from '../../formats/pk3';
import type { Vec3 } from '../../formats/bsp';
import { applyGridLight, createGridLight, setGridLight } from '../../renderer/materials/GridLit';
import type { TextureLibrary } from '../../renderer/materials/TextureLibrary';
import type { TraceFunction } from '../weapons/Projectiles';

/**
 * Morceaux de corps.
 *
 * Quand un coup depasse largement ce qu'il restait de sante, le jeu ne joue
 * pas d'animation de mort : le corps explose et laisse une dizaine de
 * morceaux, qui retombent, rebondissent et s'immobilisent. C'est ce qui
 * distingue une roquette bien placee d'une rafale de mitrailleuse, et cela
 * appartient au rythme d'une partie autant que le son de l'annonceur.
 *
 * Les dix morceaux sont ceux du jeu, et ils partagent une seule image. Ils
 * sont lus une fois par partie, poses dans un ensemble de reserve, et
 * recycles : une melee a huit peut en lancer plusieurs series d'affilee.
 */

/** Sante en dessous de laquelle le corps explose, comme dans le jeu. */
export const GIB_HEALTH = -40;

/** Les dix morceaux du jeu, avec leur poids relatif dans la gerbe. */
const PIECES = [
  'abdomen',
  'arm',
  'brain',
  'chest',
  'fist',
  'foot',
  'forearm',
  'intestine',
  'leg',
  'skull',
];

/** Morceaux lances par explosion : onze, comme le jeu. */
const BURST_COUNT = 11;
/** Reserve : trois gerbes peuvent voler en meme temps. */
const CAPACITY = 36;
const LIFETIME = 6;
const GRAVITY = 700;

interface Gib {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
  resting: boolean;
}

export class GibSystem {
  private readonly root = new THREE.Group();
  private readonly gibs: Gib[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private material: THREE.MeshStandardMaterial | null = null;
  private readonly light = createGridLight();
  private readonly next = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly center = new THREE.Vector3();
  private impactCooldown = 0;

  /** Prevenu quand un morceau rebondit, pour le son. */
  onImpact: ((position: Vec3) => void) | null = null;

  constructor() {
    this.root.name = 'gibs';
  }

  attach(parent: THREE.Object3D): void {
    parent.add(this.root);
  }

  get activeCount(): number {
    return this.gibs.reduce((total, gib) => total + (gib.mesh.visible ? 1 : 0), 0);
  }

  /**
   * Lit les morceaux dans les archives du joueur. Sans eux, la mort garde son
   * animation : rien n'est fabrique pour les remplacer.
   */
  async load(vfs: VirtualFileSystem, textures: TextureLibrary | null): Promise<boolean> {
    if (this.geometries.length > 0) return true;

    const loaded = await Promise.all(
      PIECES.map(async (name) => {
        const data = await vfs.read(`models/gibs/${name}.md3`);
        if (!data) return null;
        try {
          return geometryOf(new Md3Model(data, name));
        } catch {
          return null;
        }
      }),
    );
    for (const geometry of loaded) if (geometry) this.geometries.push(geometry);
    if (this.geometries.length === 0) return false;

    const skin = textures ? await textures.load('models/gibs/gibs.jpg') : null;
    this.material = new THREE.MeshStandardMaterial({
      map: skin?.map ?? null,
      color: skin ? 0xffffff : 0x7a1c14,
      roughness: 0.75,
      metalness: 0.05,
    });
    // Les morceaux volent : comme les corps, leur lumiere vient de la grille.
    applyGridLight(this.material, this.light);

    for (let i = 0; i < CAPACITY; i++) {
      const mesh = new THREE.Mesh(this.geometries[i % this.geometries.length], this.material);
      mesh.visible = false;
      mesh.castShadow = false;
      mesh.frustumCulled = false;
      this.root.add(mesh);
      this.gibs.push({
        mesh,
        velocity: new THREE.Vector3(),
        spin: new THREE.Vector3(),
        life: 0,
        resting: false,
      });
    }
    return true;
  }

  get ready(): boolean {
    return this.gibs.length > 0;
  }

  /**
   * Lance une gerbe depuis un point. Les vitesses sont tirees au hasard dans
   * toutes les directions, avec une part vers le haut : sans cela les
   * morceaux glissent au sol sans jamais se voir.
   */
  burst(position: Vec3): void {
    if (!this.ready) return;
    let launched = 0;
    for (const gib of this.gibs) {
      if (launched >= BURST_COUNT) break;
      if (gib.mesh.visible) continue;

      gib.mesh.geometry = this.geometries[Math.floor(Math.random() * this.geometries.length)];
      gib.mesh.position.set(
        position[0] + (Math.random() - 0.5) * 12,
        position[1] + (Math.random() - 0.5) * 12,
        position[2] + (Math.random() - 0.5) * 20,
      );
      gib.mesh.rotation.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
      gib.mesh.visible = true;
      gib.velocity.set(
        (Math.random() - 0.5) * 340,
        (Math.random() - 0.5) * 340,
        120 + Math.random() * 280,
      );
      gib.spin.set(
        (Math.random() - 0.5) * 18,
        (Math.random() - 0.5) * 18,
        (Math.random() - 0.5) * 18,
      );
      gib.life = LIFETIME;
      gib.resting = false;
      launched++;
    }
  }

  /**
   * Avance les morceaux. Le trajet est teste contre le decor : un morceau
   * rebondit, ralentit, puis s'immobilise, et les derniers dixiemes de sa vie
   * le font disparaitre en retrecissant plutot qu'en s'evanouissant d'un coup.
   */
  update(delta: number, trace: TraceFunction): void {
    this.impactCooldown = Math.max(0, this.impactCooldown - delta);
    let active = 0;
    this.center.set(0, 0, 0);

    for (const gib of this.gibs) {
      if (!gib.mesh.visible) continue;
      gib.life -= delta;
      if (gib.life <= 0) {
        gib.mesh.visible = false;
        gib.mesh.scale.setScalar(1);
        continue;
      }
      active++;
      this.center.add(gib.mesh.position);

      if (!gib.resting) {
        gib.velocity.z -= GRAVITY * delta;
        this.next.copy(gib.mesh.position).addScaledVector(gib.velocity, delta);
        const hit = trace(
          [gib.mesh.position.x, gib.mesh.position.y, gib.mesh.position.z],
          [this.next.x, this.next.y, this.next.z],
          [-2, -2, -2],
          [2, 2, 2],
          1,
        );

        if (hit.fraction < 1) {
          this.normal.set(hit.normal[0], hit.normal[1], hit.normal[2]);
          gib.mesh.position.set(hit.endPosition[0], hit.endPosition[1], hit.endPosition[2]);
          gib.mesh.position.addScaledVector(this.normal, 1.5);
          // Rebond amorti : un morceau ne repart jamais aussi haut.
          gib.velocity.addScaledVector(this.normal, -gib.velocity.dot(this.normal) * 1.5);
          gib.velocity.multiplyScalar(0.42);
          gib.spin.multiplyScalar(0.5);
          if (gib.velocity.lengthSq() < 900) {
            gib.resting = true;
            gib.velocity.set(0, 0, 0);
            gib.spin.set(0, 0, 0);
          } else if (this.impactCooldown <= 0) {
            this.impactCooldown = 0.08;
            this.onImpact?.([gib.mesh.position.x, gib.mesh.position.y, gib.mesh.position.z]);
          }
        } else {
          gib.mesh.position.copy(this.next);
        }

        gib.mesh.rotation.x += gib.spin.x * delta;
        gib.mesh.rotation.y += gib.spin.y * delta;
        gib.mesh.rotation.z += gib.spin.z * delta;
      }

      if (gib.life < 0.6) gib.mesh.scale.setScalar(Math.max(0.05, gib.life / 0.6));
    }

    // Une seule lecture de lumiere pour toute la gerbe : ses morceaux tiennent
    // dans la meme piece, et cela evite un echantillon par morceau.
    if (active > 0) this.center.multiplyScalar(1 / active);
  }

  /** Lumiere du lieu ou les morceaux se trouvent. */
  setLight(sample: { ambient: THREE.Color; directional: THREE.Color; direction: THREE.Vector3 }): void {
    setGridLight(this.light, sample);
  }

  /** Point moyen des morceaux en vol, pour y echantillonner la lumiere. */
  get focus(): Vec3 | null {
    return this.activeCount > 0 ? [this.center.x, this.center.y, this.center.z] : null;
  }

  clear(): void {
    for (const gib of this.gibs) {
      gib.mesh.visible = false;
      gib.mesh.scale.setScalar(1);
      gib.life = 0;
    }
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    this.geometries.length = 0;
    this.material?.dispose();
    this.material = null;
    this.gibs.length = 0;
    this.root.clear();
    this.root.removeFromParent();
  }
}

/** Geometrie fixe d'un morceau : une seule pose, la premiere. */
function geometryOf(model: Md3Model): THREE.BufferGeometry | null {
  const surface = model.surfaces[0];
  if (!surface) return null;
  const count = surface.vertexCount;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(surface.positions.slice(0, count * 3), 3),
  );
  geometry.setAttribute(
    'normal',
    new THREE.Float32BufferAttribute(surface.normals.slice(0, count * 3), 3),
  );
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(surface.texCoords, 2));
  geometry.setIndex(new THREE.Uint16BufferAttribute(surface.indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}
