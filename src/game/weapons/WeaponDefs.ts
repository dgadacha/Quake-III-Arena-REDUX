import * as THREE from 'three';

/**
 * Les huit armes de l'arene, plus le corps a corps. Cadences, degats,
 * dispersions, vitesses et rayons sont ceux du jeu : ce sont les chiffres qui
 * font le rythme des duels, ils ne se retouchent pas.
 *
 * Chaque arme porte en plus une identite visuelle, couleur et taille des
 * effets, qui ne change rien a son comportement.
 */

export type WeaponId =
  | 'gauntlet'
  | 'machinegun'
  | 'shotgun'
  | 'grenade'
  | 'rocket'
  | 'lightning'
  | 'railgun'
  | 'plasma'
  | 'bfg';

export type WeaponKind = 'melee' | 'hitscan' | 'projectile' | 'beam';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  kind: WeaponKind;
  /** Delai entre deux tirs, en secondes. */
  fireDelay: number;
  damage: number;
  /** Dispersion, dans les unites du jeu : un ecart a 16 fois la distance. */
  spread?: number;
  pellets?: number;
  /** Portee du faisceau, pour les armes qui en ont une. */
  range?: number;
  speed?: number;
  gravity?: number;
  /** Duree avant explosion spontanee, en secondes. */
  fuse?: number;
  splashDamage?: number;
  splashRadius?: number;
  /** Le tir se repete tant que le bouton reste enfonce. */
  automatic: boolean;
  color: THREE.Color;
  /** Taille de l'eclat au depart du coup. */
  flashSize: number;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  gauntlet: {
    id: 'gauntlet',
    name: 'Gauntlet',
    kind: 'melee',
    fireDelay: 0.4,
    damage: 50,
    range: 32,
    automatic: true,
    color: new THREE.Color(1, 0.9, 0.6),
    flashSize: 8,
  },
  machinegun: {
    id: 'machinegun',
    name: 'Machinegun',
    kind: 'hitscan',
    fireDelay: 0.1,
    damage: 7,
    spread: 200,
    pellets: 1,
    range: 8192,
    automatic: true,
    color: new THREE.Color(1, 0.85, 0.5),
    flashSize: 11,
  },
  shotgun: {
    id: 'shotgun',
    name: 'Shotgun',
    kind: 'hitscan',
    fireDelay: 1,
    damage: 10,
    spread: 700,
    pellets: 11,
    range: 8192,
    automatic: false,
    color: new THREE.Color(1, 0.78, 0.4),
    flashSize: 18,
  },
  grenade: {
    id: 'grenade',
    name: 'Grenade Launcher',
    kind: 'projectile',
    fireDelay: 0.8,
    damage: 100,
    speed: 700,
    gravity: 800,
    fuse: 2.5,
    splashDamage: 100,
    splashRadius: 150,
    automatic: true,
    color: new THREE.Color(0.6, 1, 0.5),
    flashSize: 13,
  },
  rocket: {
    id: 'rocket',
    name: 'Rocket Launcher',
    kind: 'projectile',
    fireDelay: 0.8,
    damage: 100,
    speed: 900,
    splashDamage: 100,
    splashRadius: 120,
    automatic: true,
    color: new THREE.Color(1, 0.55, 0.2),
    flashSize: 16,
  },
  lightning: {
    id: 'lightning',
    name: 'Lightning Gun',
    kind: 'beam',
    fireDelay: 0.05,
    damage: 8,
    range: 768,
    automatic: true,
    color: new THREE.Color(0.55, 0.75, 1),
    flashSize: 9,
  },
  railgun: {
    id: 'railgun',
    name: 'Railgun',
    kind: 'hitscan',
    fireDelay: 1.5,
    damage: 100,
    pellets: 1,
    range: 8192,
    automatic: false,
    color: new THREE.Color(0.35, 0.65, 1),
    flashSize: 14,
  },
  plasma: {
    id: 'plasma',
    name: 'Plasma Gun',
    kind: 'projectile',
    fireDelay: 0.1,
    damage: 20,
    speed: 2000,
    splashDamage: 15,
    splashRadius: 20,
    automatic: true,
    color: new THREE.Color(0.45, 0.8, 1),
    flashSize: 10,
  },
  bfg: {
    id: 'bfg',
    name: 'BFG',
    kind: 'projectile',
    fireDelay: 0.2,
    damage: 100,
    speed: 2000,
    splashDamage: 100,
    splashRadius: 120,
    automatic: true,
    color: new THREE.Color(0.6, 1, 0.7),
    flashSize: 20,
  },
};

/** Ordre de selection, celui des touches du jeu. */
export const WEAPON_ORDER: WeaponId[] = [
  'gauntlet',
  'machinegun',
  'shotgun',
  'grenade',
  'rocket',
  'lightning',
  'railgun',
  'plasma',
  'bfg',
];
