import type { WeaponId } from './weapons/WeaponDefs';

/**
 * Etat du joueur : sante, armure et munitions. Les chiffres sont ceux du jeu,
 * y compris les details qui font sa mecanique : on apparait avec plus de sante
 * que le maximum, et l'exces redescend d'un point par seconde ; l'armure
 * absorbe deux tiers des degats ; une chute ne blesse qu'au-dela d'une certaine
 * vitesse.
 */

export type AmmoType = 'bullets' | 'shells' | 'grenades' | 'rockets' | 'lightning' | 'slugs' | 'cells' | 'bfg';

/** Munitions consommees par chaque arme ; le gantelet n'en use pas. */
export const WEAPON_AMMO: Record<WeaponId, AmmoType | null> = {
  gauntlet: null,
  machinegun: 'bullets',
  shotgun: 'shells',
  grenade: 'grenades',
  rocket: 'rockets',
  lightning: 'lightning',
  railgun: 'slugs',
  plasma: 'cells',
  bfg: 'bfg',
};

const MAX_HEALTH = 100;
const SPAWN_HEALTH = 125;
const MAX_ARMOR = 200;
/** Part des degats prise par l'armure. */
const ARMOR_PROTECTION = 0.66;
const MAX_AMMO = 200;

export interface PlayerSnapshot {
  health: number;
  armor: number;
  weapon: WeaponId;
  ammo: number;
  /** Munitions illimitees, comme pour le corps a corps. */
  unlimited: boolean;
  alive: boolean;
}

export class PlayerState {
  health = SPAWN_HEALTH;
  armor = 0;
  alive = true;
  /** Armes en possession du joueur. */
  readonly owned = new Set<WeaponId>(['gauntlet', 'machinegun']);
  private readonly ammo = new Map<AmmoType, number>();
  /** Reste de seconde, pour la decroissance de l'exces. */
  private decayTimer = 0;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.health = SPAWN_HEALTH;
    this.armor = 0;
    this.alive = true;
    this.owned.clear();
    this.owned.add('gauntlet');
    this.owned.add('machinegun');
    this.ammo.clear();
    // Le joueur reapparait avec de quoi se servir de sa mitrailleuse.
    this.ammo.set('bullets', 100);
    this.decayTimer = 0;
  }

  ammoOf(type: AmmoType | null): number {
    if (!type) return Infinity;
    return this.ammo.get(type) ?? 0;
  }

  /** Vrai si l'arme peut tirer : munitions disponibles et arme possedee. */
  canFire(weapon: WeaponId): boolean {
    if (!this.alive) return false;
    const type = WEAPON_AMMO[weapon];
    if (!type) return true;
    return this.ammoOf(type) > 0;
  }

  /** Retire une munition pour un tir ; rend faux si le tir n'a pas lieu. */
  consume(weapon: WeaponId): boolean {
    const type = WEAPON_AMMO[weapon];
    if (!type) return true;
    const left = this.ammoOf(type);
    if (left <= 0) return false;
    this.ammo.set(type, left - 1);
    return true;
  }

  addAmmo(type: AmmoType, amount: number): number {
    const before = this.ammoOf(type);
    const after = Math.min(MAX_AMMO, before + amount);
    this.ammo.set(type, after);
    return after - before;
  }

  addHealth(amount: number, limit = MAX_HEALTH): number {
    const before = this.health;
    // Un soin ordinaire ne depasse pas cent ; les grosses trousses vont plus haut.
    this.health = Math.min(Math.max(limit, this.health), this.health + amount);
    return this.health - before;
  }

  addArmor(amount: number): number {
    const before = this.armor;
    this.armor = Math.min(MAX_ARMOR, this.armor + amount);
    return this.armor - before;
  }

  giveWeapon(weapon: WeaponId): boolean {
    if (this.owned.has(weapon)) return false;
    this.owned.add(weapon);
    return true;
  }

  /**
   * Applique des degats. L'armure en absorbe les deux tiers, dans la limite de
   * ce qu'il en reste. Rend le total reellement retire a la sante.
   */
  damage(amount: number): number {
    if (!this.alive || amount <= 0) return 0;

    let toHealth = amount;
    if (this.armor > 0) {
      const absorbed = Math.min(this.armor, Math.floor(amount * ARMOR_PROTECTION));
      this.armor -= absorbed;
      toHealth = amount - absorbed;
    }

    this.health -= toHealth;
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
    }
    return toHealth;
  }

  /**
   * Degats d'une reception. La violence du choc se deduit du carre de la
   * vitesse verticale : en dessous du seuil, la chute ne coute rien.
   */
  fallDamage(verticalSpeed: number): number {
    const severity = verticalSpeed * verticalSpeed * 0.0001;
    if (severity > 60) return this.damage(10);
    if (severity > 40) return this.damage(5);
    return 0;
  }

  /** Fait redescendre l'exces de sante et d'armure, un point par seconde. */
  update(delta: number): void {
    if (!this.alive) return;
    this.decayTimer += delta;
    while (this.decayTimer >= 1) {
      this.decayTimer -= 1;
      if (this.health > MAX_HEALTH) this.health--;
      if (this.armor > MAX_HEALTH) this.armor--;
    }
  }

  snapshot(weapon: WeaponId): PlayerSnapshot {
    const type = WEAPON_AMMO[weapon];
    return {
      health: Math.round(this.health),
      armor: Math.round(this.armor),
      weapon,
      ammo: type ? this.ammoOf(type) : 0,
      unlimited: type === null,
      alive: this.alive,
    };
  }
}

/** Objets a ramasser reconnus dans les cartes, avec leur effet et leur delai. */
export interface ItemDefinition {
  classname: string;
  kind: 'health' | 'armor' | 'ammo' | 'weapon' | 'powerup';
  amount: number;
  /** Plafond particulier pour les grosses trousses de soin. */
  limit?: number;
  ammoType?: AmmoType;
  weapon?: WeaponId;
  /** Delai de reapparition, en secondes. */
  respawn: number;
  label: string;
}

export const ITEMS: ItemDefinition[] = [
  { classname: 'item_health_small', kind: 'health', amount: 5, limit: 200, respawn: 35, label: '+5 HEALTH' },
  { classname: 'item_health', kind: 'health', amount: 25, respawn: 35, label: '+25 HEALTH' },
  { classname: 'item_health_large', kind: 'health', amount: 50, respawn: 35, label: '+50 HEALTH' },
  { classname: 'item_health_mega', kind: 'health', amount: 100, limit: 200, respawn: 35, label: 'MEGA HEALTH' },
  { classname: 'item_armor_shard', kind: 'armor', amount: 5, respawn: 25, label: '+5 ARMOR' },
  { classname: 'item_armor_combat', kind: 'armor', amount: 50, respawn: 25, label: '+50 ARMOR' },
  { classname: 'item_armor_body', kind: 'armor', amount: 100, respawn: 25, label: '+100 ARMOR' },
  { classname: 'ammo_bullets', kind: 'ammo', amount: 50, ammoType: 'bullets', respawn: 40, label: '+50 BULLETS' },
  { classname: 'ammo_shells', kind: 'ammo', amount: 10, ammoType: 'shells', respawn: 40, label: '+10 SHELLS' },
  { classname: 'ammo_grenades', kind: 'ammo', amount: 5, ammoType: 'grenades', respawn: 40, label: '+5 GRENADES' },
  { classname: 'ammo_rockets', kind: 'ammo', amount: 5, ammoType: 'rockets', respawn: 40, label: '+5 ROCKETS' },
  { classname: 'ammo_lightning', kind: 'ammo', amount: 60, ammoType: 'lightning', respawn: 40, label: '+60 LIGHTNING' },
  { classname: 'ammo_slugs', kind: 'ammo', amount: 10, ammoType: 'slugs', respawn: 40, label: '+10 SLUGS' },
  { classname: 'ammo_cells', kind: 'ammo', amount: 30, ammoType: 'cells', respawn: 40, label: '+30 CELLS' },
  { classname: 'ammo_bfg', kind: 'ammo', amount: 15, ammoType: 'bfg', respawn: 40, label: '+15 BFG AMMO' },
  { classname: 'weapon_machinegun', kind: 'weapon', amount: 50, weapon: 'machinegun', ammoType: 'bullets', respawn: 5, label: 'MACHINEGUN' },
  { classname: 'weapon_shotgun', kind: 'weapon', amount: 10, weapon: 'shotgun', ammoType: 'shells', respawn: 5, label: 'SHOTGUN' },
  { classname: 'weapon_grenadelauncher', kind: 'weapon', amount: 10, weapon: 'grenade', ammoType: 'grenades', respawn: 5, label: 'GRENADE LAUNCHER' },
  { classname: 'weapon_rocketlauncher', kind: 'weapon', amount: 10, weapon: 'rocket', ammoType: 'rockets', respawn: 5, label: 'ROCKET LAUNCHER' },
  { classname: 'weapon_lightning', kind: 'weapon', amount: 100, weapon: 'lightning', ammoType: 'lightning', respawn: 5, label: 'LIGHTNING GUN' },
  { classname: 'weapon_railgun', kind: 'weapon', amount: 10, weapon: 'railgun', ammoType: 'slugs', respawn: 5, label: 'RAILGUN' },
  { classname: 'weapon_plasmagun', kind: 'weapon', amount: 50, weapon: 'plasma', ammoType: 'cells', respawn: 5, label: 'PLASMA GUN' },
  { classname: 'weapon_bfg', kind: 'weapon', amount: 15, weapon: 'bfg', ammoType: 'bfg', respawn: 5, label: 'BFG' },
];

export const ITEMS_BY_CLASS = new Map(ITEMS.map((item) => [item.classname, item]));
