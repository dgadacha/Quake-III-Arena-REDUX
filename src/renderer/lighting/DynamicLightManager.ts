import * as THREE from 'three';
import { entityNumber, entityVector, type BspMap, type Vec3 } from '../../formats/bsp';
import type { EmissiveSurface } from '../../bsp/BSPRenderer';

/**
 * Lumieres de la carte et eclats du jeu.
 *
 * Les lightmaps portent l'eclairage de fond : elles disent combien de lumiere
 * arrive sur chaque surface, mais ni d'ou elle vient, ni ce qu'elle laisse dans
 * l'ombre. Ces lampes-ci ajoutent les deux, plus les eclats des tirs et des
 * explosions.
 *
 * Une carte de Quake pose des centaines de lampes ; q3dm7 en compte trois
 * cents. Le nombre allume est donc borne, et a chaque image les candidates sont
 * classees par importance, la proximite comptant autant que la nature. Deux
 * reserves cohabitent : des lampes omnidirectionnelles, et des lampes en cone
 * pour celles que la carte fait viser un point, qui sont exactement les
 * projecteurs des salles.
 *
 * Les ombres suivent la meme logique de budget. Celles des lampes de la carte
 * sont dessinees une fois et gardees : la lampe ne bouge pas, le decor non
 * plus, et une carte d'ombre recalculee a chaque image coute six rendus par
 * lampe pour un resultat identique.
 *
 * Une lampe inutilisee n'est jamais masquee : elle reste dans la scene avec une
 * intensite nulle. Masquer une lumiere change le nombre de lumieres visibles,
 * et Three recompile alors le programme de tous les materiaux de la scene. Avec
 * une reserve qui se redistribue a chaque image, cela produit des centaines de
 * recompilations par seconde : le jeu clignote et l'image passe au noir le
 * temps que les programmes se relient.
 */

export type LightKind =
  | 'map'
  | 'surface'
  | 'projectile'
  | 'muzzle'
  | 'explosion'
  | 'ambientEvent';

export interface LightRequest {
  position: Vec3;
  color: THREE.Color;
  /** Puissance, dans les unites de la carte. */
  intensity: number;
  radius: number;
  kind: LightKind;
  /** Duree de vie en secondes ; absente pour une lampe permanente. */
  duration?: number;
  /** Plus la valeur est haute, plus la lampe garde sa place. */
  priority: number;
  castShadow?: boolean;
  /**
   * Lampe qui vise un point : direction et demi-angle du cone. C'est ainsi que
   * les cartes posent leurs projecteurs, et ce sont eux qui dessinent les
   * flaques de lumiere sur les murs et le sol.
   */
  cone?: { direction: Vec3; angle: number };
}

interface ActiveLight extends LightRequest {
  id: number;
  age: number;
  /** Faux des que la lampe quitte la liste : les emplacements s'en apercoivent. */
  alive: boolean;
  /** Suivi d'un objet mobile : la lampe se replace a chaque image. */
  follow?: () => Vec3 | null;
}

/** Importance de chaque nature de lumiere, a distance egale. */
const KIND_PRIORITY: Record<LightKind, number> = {
  explosion: 100,
  muzzle: 80,
  projectile: 60,
  ambientEvent: 40,
  /*
   * Une lanterne, une flamme ou une coulee de lave passe devant les lampes
   * posees a la main : elle est visible a l'ecran, donc le joueur attend de la
   * voir eclairer ce qui l'entoure. Les entites light de la carte, elles, sont
   * souvent des remplissages invisibles.
   */
  surface: 26,
  map: 10,
};

/** Ce qu'un emplacement de la reserve eclaire, et ou il en est de son fondu. */
interface SlotState {
  source: ActiveLight | null;
  /** De zero a un : la lampe monte ou descend au lieu de sauter. */
  level: number;
  /** Source dont la carte d'ombre est dessinee, pour ne pas la refaire. */
  shadowId?: number;
}

/** Duree du fondu d'une lampe qui entre ou sort du budget, en secondes. */
const FADE_SECONDS = 0.28;

/** Part de la reserve reservee aux cones, quand la carte en declare. */
const CONE_SHARE = 0.5;

export class DynamicLightManager {
  private readonly pool: THREE.PointLight[] = [];
  private readonly cones: THREE.SpotLight[] = [];
  private readonly lights: ActiveLight[] = [];
  private readonly ranked: ActiveLight[] = [];
  private readonly rankedCones: ActiveLight[] = [];
  /**
   * Etat de chaque emplacement : la source qu'il eclaire, et son niveau de
   * fondu. Une lampe qui entre dans le budget monte en un quart de seconde,
   * celle qui en sort descend de meme. Sans cela, elle apparait d'un coup a
   * pleine puissance des qu'on approche, et disparait de meme : c'est le
   * clignotement de lumiere selon la distance.
   */
  private readonly slots: SlotState[] = [];
  private readonly coneSlots: SlotState[] = [];
  private nextId = 1;

  constructor(private maxActive = 8) {}

  get count(): number {
    return this.lights.length;
  }

  get budget(): number {
    return this.maxActive;
  }

  /** Nombre de lampes en cone declarees par la carte. */
  get coneCount(): number {
    return this.lights.reduce((total, light) => total + (light.cone ? 1 : 0), 0);
  }

  /** Cree les reserves et les rattache a la scene. */
  attach(root: THREE.Object3D, maxActive = this.maxActive, shadowBudget = 0, coneCount = 0): void {
    this.maxActive = maxActive;
    for (const light of [...this.pool, ...this.cones]) {
      light.parent?.remove(light);
      light.dispose();
    }
    this.pool.length = 0;
    this.cones.length = 0;
    this.slots.length = 0;
    this.coneSlots.length = 0;

    // La carte ne declare pas toujours des cones : sans eux, tout va aux
    // lampes omnidirectionnelles.
    const coneSlots = coneCount > 0 ? Math.max(1, Math.round(maxActive * CONE_SHARE)) : 0;
    const pointSlots = Math.max(0, maxActive - coneSlots);

    for (let index = 0; index < pointSlots; index++) {
      const light = new THREE.PointLight(0xffffff, 0, 1000, 1);
      // Toujours visible, eteinte quand elle ne sert pas : voir l'en-tete.
      this.prepareShadow(light, index < shadowBudget, 512);
      this.pool.push(light);
      this.slots.push({ source: null, level: 0 });
      root.add(light);
    }

    for (let index = 0; index < coneSlots; index++) {
      const light = new THREE.SpotLight(0xffffff, 0, 1000, Math.PI / 6, 0.4, 1);
      // La cible d'un projecteur est un objet a part entiere : sans elle, la
      // lampe regarde l'origine du monde.
      light.target.position.set(0, 0, 0);
      root.add(light.target);
      // Un cone coute une seule carte d'ombre, contre six pour une lampe
      // omnidirectionnelle : le budget lui profite d'abord.
      this.prepareShadow(light, index < shadowBudget + 1, 1024);
      this.cones.push(light);
      this.coneSlots.push({ source: null, level: 0 });
      root.add(light);
    }
  }

  /**
   * Prepare une lampe a porter des ombres. Elles ne sont pas recalculees a
   * chaque image : une lampe de carte et un decor immobiles donnent toujours
   * la meme carte d'ombre. Elle est donc dessinee au moment ou la lampe prend
   * sa place, puis gardee.
   */
  private prepareShadow(light: THREE.PointLight | THREE.SpotLight, enabled: boolean, size: number): void {
    light.castShadow = enabled;
    if (!enabled) return;
    light.shadow.mapSize.set(size, size);
    light.shadow.camera.near = 8;
    light.shadow.bias = -0.0012;
    // Les cartes de Quake se mesurent en dizaines d'unites par pixel : le
    // decalage le long de la normale doit suivre cette echelle.
    light.shadow.normalBias = 2.5;
    light.shadow.autoUpdate = false;
    light.shadow.needsUpdate = true;
  }

  /** Reprend les lampes posees dans la carte comme sources permanentes. */
  addMapLights(map: BspMap): number {
    // Cibles nommees : elles donnent la direction des projecteurs.
    const targets = new Map<string, Vec3>();
    for (const entity of map.entities) {
      const name = entity.targetname;
      if (name) targets.set(name, entityVector(entity, 'origin'));
    }

    let added = 0;
    for (const entity of map.entities) {
      if (entity.classname !== 'light') continue;
      const power = entityNumber(entity, 'light', 300);
      const raw = entity._color ?? entity.color ?? '1 1 1';
      const parts = raw.trim().split(/\s+/).map(Number);
      const position = entityVector(entity, 'origin');

      // Portee bornee : certaines cartes declarent des puissances enormes pour
      // cuire leurs lightmaps, ce qui ne correspond a aucune portee.
      const radius = Math.min(1600, Math.max(160, power * 1.5));

      let cone: LightRequest['cone'];
      const target = entity.target ? targets.get(entity.target) : undefined;
      if (target) {
        const direction: Vec3 = [
          target[0] - position[0],
          target[1] - position[1],
          target[2] - position[2],
        ];
        const distance = Math.hypot(direction[0], direction[1], direction[2]);
        if (distance > 1) {
          // Le rayon declare est celui du cercle eclaire a l'arrivee : il donne
          // l'ouverture du cone.
          const spread = entityNumber(entity, 'radius', 64);
          cone = { direction, angle: Math.atan2(Math.max(8, spread), distance) };
        }
      }

      this.add({
        position,
        color: new THREE.Color(
          Number.isFinite(parts[0]) ? parts[0] : 1,
          Number.isFinite(parts[1]) ? parts[1] : 1,
          Number.isFinite(parts[2]) ? parts[2] : 1,
        ),
        intensity: power,
        radius: cone ? Math.max(radius, 512) : radius,
        kind: 'map',
        priority: KIND_PRIORITY.map + (cone ? 6 : 0),
        cone,
      });
      added++;
    }
    return added;
  }

  /**
   * Reprend les surfaces lumineuses de la carte comme sources.
   *
   * La puissance vient de ce que le script declare, ramenee a l'echelle des
   * lampes ; la portee vient de la taille de l'amas, une flamme isolee
   * n'eclairant pas comme un lac de lave. Les amas trop faibles sont ecartes :
   * un bandeau a peine lumineux n'a pas besoin de sa propre lampe.
   */
  addSurfaceLights(surfaces: EmissiveSurface[]): number {
    let added = 0;
    for (const surface of surfaces) {
      if (surface.strength < 0.25) continue;
      this.add({
        position: surface.position,
        color: surface.color.clone(),
        intensity: surface.strength * 400,
        radius: surface.radius,
        kind: 'surface',
        priority: KIND_PRIORITY.surface,
      });
      added++;
    }
    return added;
  }

  add(request: LightRequest, follow?: () => Vec3 | null): number {
    const id = this.nextId++;
    this.lights.push({ ...request, id, age: 0, alive: true, follow });
    return id;
  }

  remove(id: number): void {
    const index = this.lights.findIndex((light) => light.id === id);
    if (index >= 0) {
      this.lights[index].alive = false;
      this.lights.splice(index, 1);
    }
  }

  /** Retire tout ce qui n'est pas permanent : changement de carte, reapparition. */
  clearTransient(): void {
    for (let i = this.lights.length - 1; i >= 0; i--) {
      if (this.lights[i].duration === undefined) continue;
      this.lights[i].alive = false;
      this.lights.splice(i, 1);
    }
  }

  /**
   * Vieillit les lampes, suit celles qui sont attachees a un objet, puis
   * distribue les reserves aux plus importantes.
   */
  update(delta: number, viewer: Vec3): void {
    for (let i = this.lights.length - 1; i >= 0; i--) {
      const light = this.lights[i];
      light.age += delta;
      if (light.duration !== undefined && light.age >= light.duration) {
        light.alive = false;
        this.lights.splice(i, 1);
        continue;
      }
      if (light.follow) {
        const position = light.follow();
        if (!position) {
          light.alive = false;
          this.lights.splice(i, 1);
          continue;
        }
        light.position = position;
      }
    }

    if (this.pool.length === 0 && this.cones.length === 0) return;

    this.ranked.length = 0;
    this.rankedCones.length = 0;
    for (const light of this.lights) {
      if (importance(light, viewer) <= 0) continue;
      // Un cone ne peut aller que dans la reserve des cones ; s'il n'y en a
      // pas, il rejoint les lampes ordinaires.
      if (light.cone && this.cones.length > 0) this.rankedCones.push(light);
      else this.ranked.push(light);
    }
    const byImportance = (a: ActiveLight, b: ActiveLight) =>
      importance(b, viewer) - importance(a, viewer);
    this.ranked.sort(byImportance);
    this.rankedCones.sort(byImportance);

    for (let slot = 0; slot < this.pool.length; slot++) {
      const state = this.slots[slot];
      this.settle(state, this.ranked[slot], delta);
      this.applyPoint(this.pool[slot], state, viewer);
    }
    for (let slot = 0; slot < this.cones.length; slot++) {
      const state = this.coneSlots[slot];
      this.settle(state, this.rankedCones[slot], delta);
      this.applyCone(this.cones[slot], state, viewer);
    }
  }

  /**
   * Fait evoluer un emplacement vers la source qu'il doit eclairer.
   *
   * Le changement de source n'est pas immediat : l'emplacement eteint d'abord
   * celle qu'il tenait, puis prend la nouvelle et la rallume. Une lampe ne
   * saute donc jamais de rien a tout, et deux lampes qui echangent leur place
   * dans le classement ne produisent pas de clignotement.
   */
  private settle(state: SlotState, wanted: ActiveLight | undefined, delta: number): void {
    const step = delta / FADE_SECONDS;
    const expired = state.source !== null && !state.source.alive;

    if (state.source !== null && wanted?.id === state.source.id && !expired) {
      state.level = Math.min(1, state.level + step);
      return;
    }

    // Source differente, ou disparue : on descend avant de changer.
    state.level = Math.max(0, state.level - step);
    if (state.level <= 0) {
      state.source = wanted ?? null;
    }
  }

  private applyPoint(target: THREE.PointLight, state: SlotState, viewer: Vec3): void {
    const source = state.source;
    if (!source || state.level <= 0) {
      target.intensity = 0;
      return;
    }
    target.position.set(source.position[0], source.position[1], source.position[2]);
    target.color.copy(source.color);
    target.distance = source.radius;
    target.decay = 1;
    target.intensity = powerOf(source) * state.level * reach(source, viewer);
    this.refreshShadow(target, source, state);
  }

  private applyCone(target: THREE.SpotLight, state: SlotState, viewer: Vec3): void {
    const source = state.source;
    if (!source || !source.cone || state.level <= 0) {
      target.intensity = 0;
      return;
    }
    const { position, cone } = source;
    target.position.set(position[0], position[1], position[2]);
    target.target.position.set(
      position[0] + cone.direction[0],
      position[1] + cone.direction[1],
      position[2] + cone.direction[2],
    );
    target.target.updateMatrixWorld();
    target.color.copy(source.color);
    target.distance = source.radius;
    target.decay = 1;
    // Bord adouci : une coupure franche trahirait le cone.
    target.angle = Math.min(Math.PI / 2.2, cone.angle * 1.25);
    target.penumbra = 0.45;
    // Un cone concentre la meme puissance sur une plus petite part de la
    // sphere : il parait donc plus vif a puissance egale.
    target.intensity = powerOf(source) * 0.7 * state.level * reach(source, viewer);
    this.refreshShadow(target, source, state);
  }

  /**
   * Redessine la carte d'ombre quand la lampe de cet emplacement change, ou
   * quand elle bouge. Une lampe de carte immobile garde la sienne.
   */
  private refreshShadow(
    light: THREE.PointLight | THREE.SpotLight,
    source: ActiveLight,
    state: SlotState,
  ): void {
    if (!light.castShadow) return;
    const moving = source.follow !== undefined || source.duration !== undefined;
    if (state.shadowId !== source.id || moving) {
      light.shadow.camera.far = Math.max(64, source.radius);
      if ('fov' in light.shadow.camera) {
        (light.shadow.camera as THREE.PerspectiveCamera).updateProjectionMatrix();
      }
      light.shadow.needsUpdate = true;
      state.shadowId = source.id;
    }
  }
}

/**
 * Puissance rendue par une lampe. Les cartes eclairent en attenuation
 * lineaire, pas en carre inverse : une lampe annoncee a dix mille unites ne
 * doit pas produire un eclat de plusieurs millions. Les lampes de la carte
 * restent mesurees, puisque les lightmaps portent deja le fond ; les eclats
 * d'un tir, eux, doivent se voir.
 */
function powerOf(source: ActiveLight): number {
  const fade = source.duration !== undefined ? Math.max(0, 1 - source.age / source.duration) : 1;
  /*
   * Les lightmaps portent deja l'eclairage de fond : une lampe de carte reste
   * donc mesuree. Une surface lumineuse, elle, est vue a l'ecran et doit poser
   * sa flaque de lumiere ; un eclat de tir doit se voir franchement.
   */
  const gain = source.kind === 'map' ? 0.6 : source.kind === 'surface' ? 1.1 : 1.4;
  const intensity = gain * source.radius * 0.5 * fade * fade;
  return Number.isFinite(intensity) ? Math.min(2500, intensity) : 0;
}

/**
 * Extinction en bord de portee.
 *
 * Une lampe cesse d'etre candidate au-dela d'une fois et demie sa portee. Si
 * elle eclairait encore a pleine puissance juste avant cette limite, son
 * retrait se verrait ; elle s'eteint donc progressivement sur le dernier tiers,
 * et ne vaut plus rien quand elle quitte le classement.
 */
function reach(light: ActiveLight, viewer: Vec3): number {
  const distance = Math.hypot(
    light.position[0] - viewer[0],
    light.position[1] - viewer[1],
    light.position[2] - viewer[2],
  );
  const limit = light.radius * 1.6;
  const start = light.radius * 1.05;
  if (distance <= start) return 1;
  if (distance >= limit) return 0;
  const ratio = (distance - start) / (limit - start);
  // Courbe lissee : ni cassure a l'entree, ni cassure a la sortie.
  return 1 - ratio * ratio * (3 - 2 * ratio);
}

/** Zero quand la lampe ne peut rien eclairer de visible. */
function importance(light: ActiveLight, viewer: Vec3): number {
  const distance = Math.hypot(
    light.position[0] - viewer[0],
    light.position[1] - viewer[1],
    light.position[2] - viewer[2],
  );
  if (distance > light.radius * 1.6) return 0;
  const proximity = 1 - Math.min(1, distance / (light.radius * 1.6));
  const freshness =
    light.duration !== undefined ? Math.max(0, 1 - light.age / light.duration) : 0.8;
  return light.priority * (0.4 + proximity) + freshness * 30;
}
