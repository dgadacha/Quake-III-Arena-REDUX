import type { WeaponId } from '../../game/weapons/WeaponDefs';

/**
 * Evenements du jeu vers l'interface. Le HUD ne va pas interroger la
 * simulation a chaque image : il ecoute ce qui arrive et met a jour ce qui
 * change. Seules les valeurs continues, comme le chronometre, sont lues dans la
 * boucle d'affichage.
 */

export interface UIEventMap {
  playerDamage: { amount: number; fromDirection?: { x: number; y: number; z: number } };
  playerHeal: { amount: number };
  playerDeath: { reason: 'fall' | 'lava' | 'slime' | 'void' | 'combat' };
  playerSpawn: undefined;
  pickup: { label: string; kind: 'health' | 'armor' | 'ammo' | 'weapon' | 'powerup' };
  weaponFire: { weapon: WeaponId };
  weaponSwitch: { weapon: WeaponId; owned: WeaponId[] };
  weaponEmpty: { weapon: WeaponId };
  hit: { kill: boolean };
  /**
   * Elimination, telle que le jeu l'affiche en haut a gauche : qui a tue qui,
   * et avec quoi. Une mort sans auteur est une chute ou la lave.
   */
  obituary: {
    attacker: string;
    victim: string;
    weapon: WeaponId | 'world';
    attackerIsHuman: boolean;
    victimIsHuman: boolean;
    selfInflicted: boolean;
  };
  matchStart: undefined;
  matchEnd: undefined;
  scoreChange: { score: number };
  announce: { text: string };
}

export type UIEventName = keyof UIEventMap;
type Listener<K extends UIEventName> = (payload: UIEventMap[K]) => void;

/** Bus d'evenements simple, sans dependance, typé par la table ci-dessus. */
export class UIEvents {
  private readonly listeners = new Map<UIEventName, Set<Listener<UIEventName>>>();

  on<K extends UIEventName>(name: K, listener: Listener<K>): () => void {
    const set = this.listeners.get(name) ?? new Set();
    set.add(listener as Listener<UIEventName>);
    this.listeners.set(name, set);
    return () => set.delete(listener as Listener<UIEventName>);
  }

  emit<K extends UIEventName>(name: K, payload: UIEventMap[K]): void {
    const set = this.listeners.get(name);
    if (!set) return;
    for (const listener of set) {
      try {
        (listener as Listener<K>)(payload);
      } catch (error) {
        // Un composant fautif ne doit pas interrompre les autres.
        console.warn(`interface : ecouteur de ${name} en echec`, error);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
