import * as THREE from 'three';
import { surfaceTextures, type SurfaceKind } from './Procedural';

/** Reglages partages par tous les materiaux de la carte. */
export const RenderConfig = {
  /** Une texture couvre 128 unites de carte. */
  textureScale: 1 / 128,
  lightMapIntensity: 1.6,
  normalScale: 1,
  environmentIntensity: 0.35,
};

export interface SurfaceOptions {
  tint?: string;
  repeat?: number;
  emissive?: string;
  emissiveIntensity?: number;
  transparent?: boolean;
  opacity?: number;
  metalness?: number;
}

/** Materiau d'une surface fabriquee par le code. */
export function surfaceMaterial(kind: SurfaceKind, options: SurfaceOptions = {}): THREE.MeshStandardMaterial {
  const tint = options.tint ?? defaultTint(kind);
  const textures = surfaceTextures(kind, tint);
  const repeat = options.repeat ?? 1;

  const map = textures.map.clone();
  const normalMap = textures.normalMap.clone();
  const roughnessMap = textures.roughnessMap.clone();
  for (const texture of [map, normalMap, roughnessMap]) {
    texture.repeat.set(repeat, repeat);
    texture.needsUpdate = true;
  }
  map.colorSpace = THREE.SRGBColorSpace;

  return new THREE.MeshStandardMaterial({
    map,
    normalMap,
    roughnessMap,
    normalScale: new THREE.Vector2(RenderConfig.normalScale, RenderConfig.normalScale),
    metalness: options.metalness ?? metalnessFor(kind),
    roughness: 1,
    emissive: new THREE.Color(options.emissive ?? '#000000'),
    emissiveIntensity: options.emissiveIntensity ?? 1,
    transparent: options.transparent ?? false,
    opacity: options.opacity ?? 1,
  });
}

function defaultTint(kind: SurfaceKind): string {
  switch (kind) {
    case 'metal':
      return '#6a707a';
    case 'floor':
      return '#5d5a55';
    case 'trim':
      return '#8a5b34';
    case 'rock':
      return '#4a443d';
    case 'grate':
      return '#3f444b';
    case 'glow':
      return '#ffb14e';
    case 'water':
      return '#2d5f70';
  }
}

/*
 * Un metal pur ne diffuse rien : il ne renvoie que ce qui l'entoure. Sans
 * sonde de reflet, une valeur haute rend le decor noir. On reste donc au
 * milieu, et les reflets viennent s'ajouter quand ils sont actifs.
 */
function metalnessFor(kind: SurfaceKind): number {
  switch (kind) {
    case 'metal':
    case 'trim':
    case 'grate':
      return 0.35;
    case 'glow':
      return 0.1;
    case 'water':
      return 0.4;
    default:
      return 0.15;
  }
}
