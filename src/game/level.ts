import * as THREE from 'three';
import type { Vec3 } from '../formats/bsp';
import type { BspMap } from '../formats/bsp';
import type { VirtualFileSystem } from '../formats/pk3';
import type { TextureLibrary } from '../renderer/materials/TextureLibrary';
import type { CollisionWorld } from './collision';
import type { LightGrid } from '../bsp/LightGrid';
import type { MoveState } from './physics';
import type { TriggerEffect } from './entities/Triggers';
import type { BspVisibility } from '../bsp/BSPVisibility';

export interface SpawnPoint {
  origin: Vec3;
  /** Orientation en radians, zero vers l'axe des x. */
  yaw: number;
}

/** Tout ce qu'il faut pour jouer une carte : geometrie, collision, departs. */
export interface Level {
  name: string;
  root: THREE.Group;
  /** Donnees de la carte, absentes pour une arene fabriquee par le code. */
  map?: BspMap;
  /** De quoi charger les modeles de la carte : archives et images. */
  vfs?: VirtualFileSystem;
  textures?: TextureLibrary;
  collision: CollisionWorld;
  spawns: SpawnPoint[];
  /**
   * Grille d'eclairage de la carte : ce qui eclaire ce qui bouge, joueurs,
   * objets a ramasser et arme tenue en main.
   */
  grid?: LightGrid;
  /** La capture des reflets suspend temporairement le culling du joueur. */
  visibility?: BspVisibility;
  /** Teinte du brouillard lointain et de l'ambiance. */
  ambient: THREE.Color;
  skyColor: THREE.Color;
  /** Boite d'horizon de la carte, quand elle en declare une. */
  sky?: THREE.Texture | null;
  /** Ce qui bouge a chaque image : textures qui defilent, lampes proches. */
  animated: ((time: number, viewer: Vec3, delta: number) => void)[];
  /** Tremplins, teleporteurs et zones mortelles de la carte. */
  triggers?: { apply(state: MoveState, setYaw: (yaw: number) => void): TriggerEffect };
  /** Bornes du decor : sous cette limite, le joueur est tombe hors de la carte. */
  floor?: number;
  /**
   * Brouillard declare par la carte a cet endroit, ou rien. Le brouillard n'est
   * jamais ajoute d'office : seules les cartes qui en declarent en ont.
   */
  fogAt?: (point: Vec3) => { color: THREE.Color; depthForOpaque: number } | null;
}

export function pickSpawn(level: Level, index?: number): SpawnPoint {
  if (index === undefined) {
    const forced = new URLSearchParams(location.search).get('spawn');
    index = forced !== null ? Number(forced) : Math.floor(Math.random() * level.spawns.length);
  }
  if (level.spawns.length === 0) return { origin: [0, 0, 64], yaw: 0 };
  return level.spawns[Math.max(0, Math.min(level.spawns.length - 1, index))];
}
