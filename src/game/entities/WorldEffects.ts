import * as THREE from 'three';
import { entityVector, type BspEntity, type BspMap, type Vec3 } from '../../formats/bsp';
import type { Effects } from '../../renderer/effects/Effects';
import type { SurfaceMetadata } from '../../renderer/materials/SurfaceMetadata';

/**
 * Vie du decor : ce que la carte declare deja et que le moteur d'origine
 * animait, repris avec les moyens d'aujourd'hui. Lueur des objets a ramasser,
 * energie des tremplins, colonnes des teleporteurs, braises au-dessus de la
 * lave.
 *
 * Rien n'est ajoute a la carte : les emplacements viennent de ses entites et de
 * ses surfaces. Tout est alloue au chargement, et les effets ne travaillent que
 * dans le voisinage du joueur.
 */

interface Glow {
  sprite: THREE.Sprite;
  /** Cle de l'emplacement, pour retrouver la lueur d'un objet ramasse. */
  key: string;
  position: THREE.Vector3;
  color: THREE.Color;
  /** Taille au repos, en unites de carte. */
  size: number;
  /** Les objets forts battent plus visiblement. */
  strong: boolean;
  phase: number;
}

interface Emitter {
  position: THREE.Vector3;
  color: THREE.Color;
  kind: 'jumppad' | 'teleporter' | 'lava';
  /** Portee au-dela de laquelle l'emetteur se met en veille. */
  range: number;
  /** Temps restant avant la prochaine particule. */
  timer: number;
  interval: number;
  /** Etendue horizontale sur laquelle semer les particules. */
  spread: number;
}

/** Couleurs des familles d'objets, reprises de leur role dans le jeu. */
const ITEM_COLORS: { match: RegExp; color: number; size: number; strong: boolean }[] = [
  { match: /^item_quad/, color: 0x4f7bff, size: 34, strong: true },
  { match: /^item_regen|^item_haste|^item_invis|^item_flight/, color: 0x8f6bff, size: 30, strong: true },
  { match: /^item_health_mega/, color: 0x3fa8ff, size: 28, strong: true },
  { match: /^item_armor_body/, color: 0xff3c3c, size: 26, strong: true },
  { match: /^item_armor/, color: 0xffd23c, size: 24, strong: false },
  { match: /^item_health/, color: 0x46d46a, size: 20, strong: false },
  { match: /^weapon_/, color: 0xffb066, size: 22, strong: false },
  { match: /^ammo_/, color: 0xcfa85c, size: 16, strong: false },
  { match: /^holdable_/, color: 0x9de3ff, size: 22, strong: false },
];

const LAVA_RANGE = 1400;
const PAD_RANGE = 1600;

export class WorldEffects {
  private readonly glows: Glow[] = [];
  private readonly emitters: Emitter[] = [];
  private readonly root = new THREE.Group();
  private readonly scratch = new THREE.Vector3();

  constructor(map: BspMap, world: THREE.Object3D, private readonly effects: Effects) {
    this.root.name = 'world-effects';
    world.add(this.root);

    const texture = glowTexture();
    this.collectItems(map, texture);
    this.collectPads(map);
    this.collectTeleporters(map);
    this.collectLava(world);
  }

  /** Eteint ou rallume la lueur d'un emplacement : objet pris, objet revenu. */
  setGlowVisible(key: string, visible: boolean): void {
    for (const glow of this.glows) {
      if (glow.key === key) glow.sprite.visible = visible;
    }
  }

  get counts(): { glows: number; emitters: number } {
    return { glows: this.glows.length, emitters: this.emitters.length };
  }

  /** Objets a ramasser : une lueur qui bat, et une lampe quand on approche. */
  private collectItems(map: BspMap, texture: THREE.Texture): void {
    for (const entity of map.entities) {
      const profile = ITEM_COLORS.find((entry) => entry.match.test(entity.classname));
      if (!profile) continue;

      const origin = entityVector(entity, 'origin');
      const material = new THREE.SpriteMaterial({
        map: texture,
        color: new THREE.Color(profile.color),
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        fog: false,
      });
      const sprite = new THREE.Sprite(material);
      // Les objets flottent un peu au-dessus de leur point d'ancrage.
      sprite.position.set(origin[0], origin[1], origin[2] + 16);
      sprite.scale.setScalar(profile.size);
      sprite.renderOrder = 15;
      this.root.add(sprite);

      this.glows.push({
        sprite,
        key: `${Math.round(origin[0])},${Math.round(origin[1])},${Math.round(origin[2])}`,
        position: sprite.position.clone(),
        color: new THREE.Color(profile.color),
        size: profile.size,
        strong: profile.strong,
        phase: Math.random() * Math.PI * 2,
      });

      // Lampe permanente pour les objets importants : le gestionnaire ne garde
      // que les plus proches, selon son budget, et rien n'est alloue par image.
      if (profile.strong) {
        this.effects.lights.add({
          position: [sprite.position.x, sprite.position.y, sprite.position.z],
          color: new THREE.Color(profile.color),
          intensity: 150,
          radius: 320,
          kind: 'ambientEvent',
          priority: 20,
        });
      }
    }
  }

  /** Tremplins : une colonne d'energie montante au-dessus du volume. */
  private collectPads(map: BspMap): void {
    for (const entity of map.entities) {
      if (entity.classname !== 'trigger_push') continue;
      const model = modelOf(entity, map);
      if (!model) continue;

      this.emitters.push({
        position: new THREE.Vector3(
          (model.mins[0] + model.maxs[0]) / 2,
          (model.mins[1] + model.maxs[1]) / 2,
          model.mins[2] + 4,
        ),
        color: new THREE.Color(0x66b8ff),
        kind: 'jumppad',
        range: PAD_RANGE,
        timer: 0,
        interval: 0.08,
        spread: Math.min(48, (model.maxs[0] - model.mins[0]) / 2),
      });
    }
  }

  /**
   * Teleporteurs : meme colonne, aux couleurs du passage. Seules comptent les
   * arrivees veritables. Les points de visee portent souvent la meme
   * classe d'entite que les cibles de tremplins, qui sont posees en plein air :
   * les retenir ferait fumer le vide au milieu des cartes.
   */
  private collectTeleporters(map: BspMap): void {
    const targeted = new Set<string>();
    for (const entity of map.entities) {
      if (entity.classname === 'trigger_teleport' && entity.target) targeted.add(entity.target);
    }
    const destinations = map.entities.filter(
      (entity) =>
        entity.classname === 'misc_teleporter_dest' ||
        (entity.targetname !== undefined && targeted.has(entity.targetname)),
    );
    for (const entity of destinations) {
      const origin = entityVector(entity, 'origin');
      this.emitters.push({
        position: new THREE.Vector3(origin[0], origin[1], origin[2] - 12),
        color: new THREE.Color(0xa07bff),
        kind: 'teleporter',
        range: PAD_RANGE,
        timer: 0,
        interval: 0.08,
        spread: 18,
      });
    }
  }

  /** Lave : des braises montent des grandes surfaces, quand on est proche. */
  private collectLava(world: THREE.Object3D): void {
    world.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const surface = mesh.userData.surface as SurfaceMetadata | undefined;
      if (!surface?.isLava) return;

      const geometry = mesh.geometry;
      geometry.computeBoundingBox();
      const box = geometry.boundingBox;
      if (!box) return;
      const size = box.getSize(new THREE.Vector3());
      // Une flaque minuscule ne merite pas son propre emetteur.
      if (size.x * size.y < 4096) return;

      this.emitters.push({
        position: new THREE.Vector3((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, box.max.z),
        color: new THREE.Color(0xff7a2a),
        kind: 'lava',
        range: LAVA_RANGE,
        timer: 0,
        interval: 0.14,
        spread: Math.min(400, Math.max(size.x, size.y) / 2),
      });
    });
  }

  /** Passage dans un teleporteur : eclat, lampe et gerbe. */
  flashTeleport(position: THREE.Vector3, viewer: THREE.Vector3): void {
    this.effects.explosions.spawn({
      position: position.clone(),
      radius: 40,
      color: new THREE.Color(0.7, 0.55, 1),
      viewer,
      parts: { smoke: false, decal: false, shake: false, sparks: true, shockwave: true },
    });
  }

  /** Declenchement d'un tremplin : une poussee de particules vers le haut. */
  burstJumppad(position: THREE.Vector3): void {
    for (let i = 0; i < 18; i++) {
      this.effects.particles.spawn({
        position: position
          .clone()
          .add(new THREE.Vector3((Math.random() - 0.5) * 40, (Math.random() - 0.5) * 40, 4)),
        velocity: new THREE.Vector3((Math.random() - 0.5) * 60, (Math.random() - 0.5) * 60, 280 + Math.random() * 220),
        drag: 1.2,
        size: 5 + Math.random() * 4,
        sizeEnd: 1,
        color: new THREE.Color(0.7, 1.6, 2.8),
        colorEnd: new THREE.Color(0.1, 0.4, 1),
        lifetime: 0.5 + Math.random() * 0.4,
        kind: 'spark',
      });
    }
    this.effects.lights.add({
      position: [position.x, position.y, position.z + 20],
      color: new THREE.Color(0.45, 0.75, 1),
      intensity: 380,
      radius: 400,
      kind: 'ambientEvent',
      duration: 0.3,
      priority: 50,
    });
  }

  /** Anime les lueurs et seme les particules des emetteurs proches. */
  update(delta: number, time: number, viewer: THREE.Vector3): void {
    for (const glow of this.glows) {
      if (!glow.sprite.visible) continue;
      // Battement lent, plus marque pour les objets importants.
      const beat = Math.sin(time * (glow.strong ? 3.2 : 2) + glow.phase);
      const scale = glow.size * (1 + beat * (glow.strong ? 0.12 : 0.06));
      glow.sprite.scale.setScalar(scale);
      const material = glow.sprite.material as THREE.SpriteMaterial;
      material.opacity = 0.55 + beat * 0.15 + (glow.strong ? 0.2 : 0);

    }

    for (const emitter of this.emitters) {
      if (viewer.distanceToSquared(emitter.position) > emitter.range * emitter.range) continue;
      emitter.timer -= delta;
      if (emitter.timer > 0) continue;
      emitter.timer = emitter.interval;
      this.emit(emitter);
    }
  }

  private emit(emitter: Emitter): void {
    const spread = emitter.spread;
    this.scratch.set(
      emitter.position.x + (Math.random() - 0.5) * spread * 2,
      emitter.position.y + (Math.random() - 0.5) * spread * 2,
      emitter.position.z,
    );

    if (emitter.kind === 'lava') {
      // Braise qui monte, ralentit, puis s'eteint.
      this.effects.particles.spawn({
        position: this.scratch.clone(),
        velocity: new THREE.Vector3((Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, 40 + Math.random() * 70),
        drag: 0.8,
        gravity: -30,
        size: 2.5 + Math.random() * 2.5,
        sizeEnd: 0.6,
        color: new THREE.Color(2.6, 1.1, 0.3),
        colorEnd: new THREE.Color(0.5, 0.1, 0.02),
        lifetime: 1.1 + Math.random() * 1.2,
        kind: 'spark',
      });
      return;
    }

    const rising = emitter.kind === 'jumppad' ? 220 : 90;
    this.effects.particles.spawn({
      position: this.scratch.clone(),
      velocity: new THREE.Vector3((Math.random() - 0.5) * 15, (Math.random() - 0.5) * 15, rising * (0.6 + Math.random())),
      drag: 1.5,
      size: 3 + Math.random() * 3,
      sizeEnd: 0.8,
      color: emitter.color.clone().multiplyScalar(2.2),
      colorEnd: emitter.color.clone().multiplyScalar(0.3),
      lifetime: 0.6 + Math.random() * 0.6,
      kind: 'spark',
    });
  }
}

function modelOf(entity: BspEntity, map: BspMap): BspMap['models'][number] | null {
  const raw = entity.model;
  if (!raw || !raw.startsWith('*')) return null;
  const index = Number(raw.slice(1));
  return Number.isFinite(index) ? map.models[index] ?? null : null;
}

/** Tache lumineuse au centre marque, utilisee par toutes les lueurs. */
function glowTexture(): THREE.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  const center = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - center, y - center) / center;
      const core = Math.max(0, 1 - distance / 0.35);
      const halo = Math.max(0, 1 - distance);
      const alpha = Math.min(1, Math.pow(halo, 2.2) * 0.75 + Math.pow(core, 1.5));
      const at = (y * size + x) * 4;
      data[at] = data[at + 1] = data[at + 2] = 255;
      data[at + 3] = Math.round(alpha * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

export type { Vec3 };
