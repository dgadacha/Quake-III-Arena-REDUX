import * as THREE from 'three';
import type { Effects } from '../../renderer/effects/Effects';
import type { BeamSystem } from '../../renderer/effects/BeamSystem';
import type { DecalKind } from '../../renderer/effects/DecalManager';
import { Surface, type Vec3 } from '../../formats/bsp';
import { ProjectileSystem, type TraceFunction } from './Projectiles';
import { WEAPONS, WEAPON_ORDER, type WeaponDef, type WeaponId } from './WeaponDefs';

/**
 * Tirs et cadences. Chaque arme garde le comportement du jeu : delai entre deux
 * coups, dispersion, portee, vitesse de projectile. Ce qui est ajoute, c'est ce
 * qu'on voit : depart de coup, faisceau, trainee, impact, trace.
 *
 * Un exemplaire par combattant, humain comme bot : ils partagent les effets et
 * les faisceaux, qui sont ceux du monde. Ce systeme ne connait ni sante ni
 * score ; quand un coup atteint quelqu'un, il le signale et l'arene tranche.
 */

const MASK_SHOT = 1 | 0x2000000;
const POINT: Vec3 = [0, 0, 0];
/** Distance de reference du jeu pour convertir une dispersion en angle. */
const SPREAD_DISTANCE = 8192;

export class WeaponSystem {
  readonly projectiles: ProjectileSystem;
  private weapon: WeaponId = 'rocket';
  private cooldown = 0;
  private firing = false;
  private trace: TraceFunction | null = null;
  /** Prevenu a chaque coup parti : sert au recul visuel. */
  onFired: ((weapon: WeaponDef) => void) | null = null;
  /** Consulte avant chaque tir : munitions et arme en possession. */
  canFire: ((weapon: WeaponId) => boolean) | null = null;
  /** Prevenu quand le tir n'a pas lieu faute de munitions. */
  onEmpty: ((weapon: WeaponId) => void) | null = null;
  /**
   * Prevenu quand un tir instantane touche une surface. La matiere touchee
   * vient avec : le son d'un ricochet sur du metal n'est pas celui d'un
   * ricochet sur de la pierre.
   */
  onImpact: ((weapon: WeaponId, point: [number, number, number], surfaceFlags: number) => void) | null = null;
  /**
   * Prevenu quand un coup instantane atteint un combattant. L'arene applique
   * les degats : l'arme sait ce qu'elle fait, pas a qui.
   */
  onDamage:
    | ((
        target: number,
        weapon: WeaponDef,
        point: [number, number, number],
        direction: [number, number, number],
      ) => void)
    | null = null;
  /** Combattant qui tient l'arme. L'arene s'en sert pour attribuer les tirs. */
  owner = -1;

  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly aim = new THREE.Vector3();
  private readonly muzzlePoint = new THREE.Vector3();
  private readonly hitPoint = new THREE.Vector3();
  private readonly hitNormal = new THREE.Vector3();

  constructor(
    private readonly effects: Effects,
    private readonly beams: BeamSystem,
    /**
     * Projectiles en vol pour ce porteur. Le joueur en a besoin de beaucoup,
     * un bot de peu : chaque place reservee est un objet de scene en plus.
     */
    projectileCapacity = 48,
  ) {
    this.projectiles = new ProjectileSystem(effects, projectileCapacity);
  }

  attach(parent: THREE.Object3D): void {
    this.projectiles.attach(parent);
  }

  setTrace(trace: TraceFunction | null): void {
    this.trace = trace;
    this.projectiles.setTrace(trace);
  }

  get current(): WeaponDef {
    return WEAPONS[this.weapon];
  }

  get currentId(): WeaponId {
    return this.weapon;
  }

  /** Prevenu a chaque changement d'arme. */
  onSwitch: ((weapon: WeaponId) => void) | null = null;

  select(id: WeaponId): void {
    if (!WEAPONS[id] || id === this.weapon) return;
    this.weapon = id;
    this.onSwitch?.(id);
    // Changer d'arme n'annule pas le delai en cours, mais ne l'allonge pas non plus.
    this.cooldown = Math.min(this.cooldown, WEAPONS[id].fireDelay);
  }

  selectIndex(index: number): void {
    const id = WEAPON_ORDER[index];
    if (id) this.select(id);
  }

  cycle(step: number): void {
    const at = WEAPON_ORDER.indexOf(this.weapon);
    const next = (at + step + WEAPON_ORDER.length) % WEAPON_ORDER.length;
    this.select(WEAPON_ORDER[next]);
  }

  setFiring(held: boolean): void {
    this.firing = held;
  }

  /** Avance les cadences, les projectiles et declenche les tirs demandes. */
  update(delta: number, eye: THREE.Vector3, direction: THREE.Vector3): void {
    this.cooldown = Math.max(0, this.cooldown - delta);
    this.projectiles.update(delta, eye);

    if (!this.firing || this.cooldown > 0) return;
    const definition = this.current;

    if (this.canFire && !this.canFire(definition.id)) {
      this.onEmpty?.(definition.id);
      // Le clic reste enfonce : on reessaie au prochain delai, sans tirer.
      this.cooldown = definition.fireDelay;
      return;
    }

    this.fire(definition, eye, direction);
    this.onFired?.(definition);
    this.cooldown = definition.fireDelay;
    // Une arme a un coup attend le relachement du bouton.
    if (!definition.automatic) this.firing = false;
  }

  clear(): void {
    this.projectiles.clear();
    this.cooldown = 0;
    this.firing = false;
  }

  private fire(definition: WeaponDef, eye: THREE.Vector3, direction: THREE.Vector3): void {
    // Repere de tir : la droite et le haut servent a ecarter les plombs.
    this.right.set(direction.y, -direction.x, 0);
    if (this.right.lengthSq() < 1e-6) this.right.set(1, 0, 0);
    this.right.normalize();
    this.up.crossVectors(this.right, direction).normalize();

    // Le coup part devant l'oeil, un peu plus bas, la ou se tient l'arme.
    this.muzzlePoint.copy(eye).addScaledVector(direction, 20).addScaledVector(this.up, -8);

    this.effects.muzzle.flash({
      position: this.muzzlePoint.clone(),
      direction: direction.clone(),
      size: definition.flashSize,
      color: definition.color.clone(),
      smoke: definition.kind !== 'beam',
    });

    switch (definition.kind) {
      case 'melee':
        this.fireHitscan(definition, direction, 1, 0, definition.range ?? 32);
        break;
      case 'hitscan':
        this.fireHitscan(
          definition,
          direction,
          definition.pellets ?? 1,
          definition.spread ?? 0,
          definition.range ?? 8192,
        );
        break;
      case 'beam':
        this.fireBeam(definition, direction);
        break;
      case 'projectile':
        this.projectiles.spawn(definition.id, this.muzzlePoint.clone(), direction.clone(), this.owner);
        break;
    }
  }

  /** Coups instantanes : un plomb, onze pour le fusil a pompe. */
  private fireHitscan(
    definition: WeaponDef,
    direction: THREE.Vector3,
    pellets: number,
    spread: number,
    range: number,
  ): void {
    if (!this.trace) return;
    const ratio = spread / SPREAD_DISTANCE;

    for (let i = 0; i < pellets; i++) {
      this.aim.copy(direction);
      if (ratio > 0) {
        // Ecart tire dans un disque, comme le jeu : un angle puis un rayon.
        const angle = Math.random() * Math.PI * 2;
        const radius = (Math.random() * 2 - 1) * ratio;
        this.aim
          .addScaledVector(this.right, Math.cos(angle) * radius)
          .addScaledVector(this.up, Math.sin(angle) * radius)
          .normalize();
      }

      const end: Vec3 = [
        this.muzzlePoint.x + this.aim.x * range,
        this.muzzlePoint.y + this.aim.y * range,
        this.muzzlePoint.z + this.aim.z * range,
      ];
      const hit = this.trace(
        [this.muzzlePoint.x, this.muzzlePoint.y, this.muzzlePoint.z],
        end,
        POINT,
        POINT,
        MASK_SHOT,
      );
      if (hit.fraction >= 1) continue;

      this.hitPoint.set(hit.endPosition[0], hit.endPosition[1], hit.endPosition[2]);
      this.hitNormal.set(hit.normal[0], hit.normal[1], hit.normal[2]);
      const struck = hit.entity ?? -1;

      if (definition.id === 'railgun') {
        // Trait fin qui s'efface vite, plus une gerbe a l'arrivee.
        this.beams.spawn({
          from: this.muzzlePoint.clone(),
          to: this.hitPoint.clone(),
          kind: 'rail',
          color: definition.color.clone(),
        });
      }

      if (struck >= 0) {
        // Sur un corps, pas de trace d'impact : l'arene s'occupe du reste.
        this.onDamage?.(
          struck,
          definition,
          [this.hitPoint.x, this.hitPoint.y, this.hitPoint.z],
          [this.aim.x, this.aim.y, this.aim.z],
        );
        continue;
      }
      this.impact(definition, this.hitPoint, this.hitNormal, hit.surfaceFlags);
    }
  }

  /** Eclair : un faisceau court, renouvele tant que le joueur tire. */
  private fireBeam(definition: WeaponDef, direction: THREE.Vector3): void {
    if (!this.trace) return;
    const range = definition.range ?? 768;
    const end: Vec3 = [
      this.muzzlePoint.x + direction.x * range,
      this.muzzlePoint.y + direction.y * range,
      this.muzzlePoint.z + direction.z * range,
    ];
    const hit = this.trace(
      [this.muzzlePoint.x, this.muzzlePoint.y, this.muzzlePoint.z],
      end,
      POINT,
      POINT,
      MASK_SHOT,
    );

    const target =
      hit.fraction < 1
        ? new THREE.Vector3(hit.endPosition[0], hit.endPosition[1], hit.endPosition[2])
        : new THREE.Vector3(end[0], end[1], end[2]);

    this.beams.spawn({
      from: this.muzzlePoint.clone(),
      to: target,
      kind: 'lightning',
      color: definition.color.clone(),
    });

    if (hit.fraction < 1) {
      const struck = hit.entity ?? -1;
      if (struck >= 0) {
        this.onDamage?.(struck, definition, [target.x, target.y, target.z], [direction.x, direction.y, direction.z]);
        return;
      }
      this.hitNormal.set(hit.normal[0], hit.normal[1], hit.normal[2]);
      this.impact(definition, target, this.hitNormal, hit.surfaceFlags);
    }
  }

  /**
   * Gerbe, poussiere, lueur et trace au point touche.
   *
   * La matiere compte : une plaque de metal crache des etincelles et peu de
   * poussiere, une pierre fait l'inverse. La carte porte deja cette
   * information dans les indicateurs de surface, ceux-la memes qui decident du
   * bruit des pas dans le jeu d'origine ; on s'en sert plutot que de deviner
   * d'apres le nom de la texture.
   */
  private impact(
    definition: WeaponDef,
    point: THREE.Vector3,
    normal: THREE.Vector3,
    surfaceFlags = 0,
  ): void {
    if ((surfaceFlags & Surface.NOIMPACT) !== 0) return;
    this.onImpact?.(definition.id, [point.x, point.y, point.z], surfaceFlags);

    const energy = definition.id === 'plasma' || definition.id === 'lightning' || definition.id === 'bfg';
    const metal = (surfaceFlags & Surface.METALSTEPS) !== 0;
    const dusty = (surfaceFlags & Surface.DUST) !== 0 || (!metal && !energy);
    const flesh = (surfaceFlags & Surface.FLESH) !== 0;

    const base = definition.id === 'shotgun' ? 3 : definition.id === 'railgun' ? 14 : 6;
    const sparks = flesh ? 0 : Math.round(base * (metal ? 1.7 : dusty ? 0.5 : 1));

    for (let i = 0; i < sparks; i++) {
      const spread = new THREE.Vector3(
        normal.x + (Math.random() - 0.5) * 1.2,
        normal.y + (Math.random() - 0.5) * 1.2,
        normal.z + (Math.random() - 0.5) * 1.2,
      ).normalize();
      // Une etincelle de metal part plus vite, plus blanche, et rebondit.
      const heat = metal ? 3.4 : 2.4;
      this.effects.particles.spawn({
        position: point.clone().addScaledVector(normal, 1),
        velocity: spread.multiplyScalar((metal ? 180 : 120) + Math.random() * 220),
        gravity: energy ? 0 : 700,
        drag: energy ? 5 : 1,
        size: 2 + Math.random() * 2,
        sizeEnd: 0.5,
        color: definition.color.clone().multiplyScalar(heat),
        colorEnd: definition.color.clone().multiplyScalar(0.4),
        lifetime: 0.18 + Math.random() * (metal ? 0.42 : 0.3),
        kind: 'spark',
      });
    }

    // Poussiere : c'est elle qui fait lire la pierre et le beton.
    const dust = flesh ? 0 : Math.round((definition.id === 'shotgun' ? 5 : 3) * (dusty ? 1.6 : metal ? 0.3 : 1));
    for (let i = 0; i < dust; i++) {
      this.effects.particles.spawn({
        position: point.clone().addScaledVector(normal, 2),
        velocity: new THREE.Vector3(
          normal.x * 40 + (Math.random() - 0.5) * 60,
          normal.y * 40 + (Math.random() - 0.5) * 60,
          normal.z * 40 + (Math.random() - 0.5) * 60 + 20,
        ),
        drag: 3,
        gravity: 120,
        size: 3 + Math.random() * 3,
        sizeEnd: 16 + Math.random() * 10,
        angularVelocity: (Math.random() - 0.5) * 2,
        color: new THREE.Color(0.42, 0.38, 0.33),
        colorEnd: new THREE.Color(0.2, 0.18, 0.16),
        opacity: 0.4,
        opacityEnd: 0,
        lifetime: 0.45 + Math.random() * 0.5,
        kind: 'smoke',
      });
    }

    // Lueur breve : elle marque le point d'impact sans eclairer la piece.
    this.effects.particles.spawn({
      position: point.clone().addScaledVector(normal, 2),
      velocity: new THREE.Vector3(),
      size: energy ? 26 : 14,
      sizeEnd: energy ? 6 : 2,
      color: definition.color.clone().multiplyScalar(2),
      colorEnd: definition.color.clone(),
      opacity: 1,
      opacityEnd: 0,
      lifetime: 0.16,
      kind: 'flare',
    });

    this.effects.lights.add({
      position: [point.x, point.y, point.z],
      color: definition.color.clone(),
      intensity: definition.id === 'railgun' ? 420 : 200,
      radius: definition.id === 'railgun' ? 380 : 240,
      kind: 'ambientEvent',
      duration: 0.12,
      priority: 40,
    });

    // Les surfaces marquees sans trace n'en gardent pas, comme a l'origine.
    if ((surfaceFlags & Surface.NOMARKS) === 0) {
      this.effects.decals.add({
        position: point.clone(),
        normal: normal.clone(),
        size: decalSize(definition.id),
        kind: decalKind(definition.id),
      });
    }
  }


}

function decalKind(id: WeaponId): DecalKind {
  switch (id) {
    case 'plasma':
    case 'bfg':
      return 'plasma';
    case 'lightning':
    case 'railgun':
      return 'rail';
    case 'rocket':
    case 'grenade':
      return 'burn';
    default:
      return 'bullet';
  }
}

function decalSize(id: WeaponId): number {
  switch (id) {
    case 'railgun':
      return 16;
    case 'shotgun':
      return 7;
    case 'plasma':
      return 14;
    case 'lightning':
      return 9;
    default:
      return 10;
  }
}
