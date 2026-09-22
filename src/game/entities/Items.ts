import * as THREE from 'three';
import { entityVector, type BspMap, type Vec3 } from '../../formats/bsp';
import { ITEMS_BY_CLASS, type ItemDefinition, type PlayerState } from '../PlayerState';

/**
 * Objets a ramasser. Les emplacements viennent des entites de la carte, les
 * effets et les delais de reapparition des valeurs du jeu.
 *
 * Le ramassage se teste sur la distance a l'objet, sans trace : les objets sont
 * poses en espace libre et cette approximation suffit, tout en restant bon
 * marche meme avec cinquante objets sur la carte.
 */

export interface PickupResult {
  label: string;
  kind: ItemDefinition['kind'];
}

interface Item {
  definition: ItemDefinition;
  position: THREE.Vector3;
  /** Cle stable, pour retrouver la lueur correspondante. */
  key: string;
  available: boolean;
  timer: number;
}

/** Portee du ramassage : la hauteur du joueur, en gros. */
const PICKUP_RADIUS = 44;

export class ItemManager {
  private readonly items: Item[] = [];
  private readonly point = new THREE.Vector3();

  /** Prevenu quand un objet disparait ou revient, pour masquer sa lueur. */
  onAvailabilityChange: ((key: string, available: boolean) => void) | null = null;

  constructor(map: BspMap) {
    for (const entity of map.entities) {
      const definition = ITEMS_BY_CLASS.get(entity.classname);
      if (!definition) continue;
      const origin = entityVector(entity, 'origin');
      this.items.push({
        definition,
        position: new THREE.Vector3(origin[0], origin[1], origin[2] + 16),
        key: keyOf(origin),
        available: true,
        timer: 0,
      });
    }
  }

  get count(): number {
    return this.items.length;
  }

  get availableCount(): number {
    return this.items.reduce((total, item) => total + (item.available ? 1 : 0), 0);
  }

  /**
   * Fait revenir les objets dont le delai est ecoule. A appeler une fois par
   * image, et une seule : l'arene compte plusieurs combattants, et faire
   * avancer les delais une fois par combattant ferait revenir les objets huit
   * fois plus vite.
   */
  tick(delta: number): void {
    for (const item of this.items) {
      if (item.available) continue;
      item.timer -= delta;
      if (item.timer <= 0) {
        item.available = true;
        this.onAvailabilityChange?.(item.key, true);
      }
    }
  }

  /**
   * Ramasse les objets qu'un combattant touche, humain ou bot. Rend la liste
   * de ce qui vient d'etre pris.
   */
  gather(origin: Vec3, player: PlayerState): PickupResult[] {
    const taken: PickupResult[] = [];
    this.point.set(origin[0], origin[1], origin[2] + 24);

    for (const item of this.items) {
      if (!item.available) continue;
      if (this.point.distanceToSquared(item.position) > PICKUP_RADIUS * PICKUP_RADIUS) continue;
      const result = this.collect(item, player);
      if (!result) continue;

      taken.push(result);
      item.available = false;
      item.timer = item.definition.respawn;
      this.onAvailabilityChange?.(item.key, false);
    }

    return taken;
  }

  /**
   * Objets disponibles, pour qui cherche ou aller. Les bots s'en servent comme
   * de buts : une armure vaut le detour, une boite de balles beaucoup moins.
   */
  get goals(): { position: THREE.Vector3; kind: ItemDefinition['kind']; weapon?: string }[] {
    return this.items
      .filter((item) => item.available)
      .map((item) => ({
        position: item.position,
        kind: item.definition.kind,
        weapon: item.definition.weapon,
      }));
  }

  /** Applique l'effet d'un objet, ou rien si le joueur n'en a pas besoin. */
  private collect(item: Item, player: PlayerState): PickupResult | null {
    const definition = item.definition;
    switch (definition.kind) {
      case 'health': {
        const gained = player.addHealth(definition.amount, definition.limit);
        return gained > 0 ? { label: definition.label, kind: 'health' } : null;
      }
      case 'armor': {
        const gained = player.addArmor(definition.amount);
        return gained > 0 ? { label: definition.label, kind: 'armor' } : null;
      }
      case 'ammo': {
        if (!definition.ammoType) return null;
        const gained = player.addAmmo(definition.ammoType, definition.amount);
        return gained > 0 ? { label: definition.label, kind: 'ammo' } : null;
      }
      case 'weapon': {
        if (!definition.weapon) return null;
        const isNew = player.giveWeapon(definition.weapon);
        let gained = 0;
        if (definition.ammoType) gained = player.addAmmo(definition.ammoType, definition.amount);
        return isNew || gained > 0 ? { label: definition.label, kind: 'weapon' } : null;
      }
      default:
        return null;
    }
  }

  reset(): void {
    for (const item of this.items) {
      if (!item.available) this.onAvailabilityChange?.(item.key, true);
      item.available = true;
      item.timer = 0;
    }
  }
}

/** Cle d'un emplacement, arrondie a l'unite. */
export function keyOf(origin: Vec3): string {
  return `${Math.round(origin[0])},${Math.round(origin[1])},${Math.round(origin[2])}`;
}
