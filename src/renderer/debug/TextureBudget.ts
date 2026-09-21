import * as THREE from 'three';

/**
 * Budget des textures.
 *
 * Une texture ordinaire occupe quatre octets par pixel en memoire video, et un
 * tiers de plus avec ses niveaux de mipmap ; une texture compressee, un octet.
 * Multiplie par le nombre de surfaces d'une arene, l'ecart decide de la
 * cadence, et rien dans le jeu ne le montre : le compteur d'images ne dit pas
 * pourquoi il descend.
 *
 * Cette mesure parcourt la scene, releve chaque texture une seule fois, meme
 * partagee par vingt surfaces, et rend ce qu'elle coute vraiment.
 */

export interface TextureBudget {
  /** Textures distinctes rencontrees. */
  count: number;
  /** Octets en memoire video, mipmaps comprises. */
  bytes: number;
  /** Part compressee par le materiel, et part laissee en RGBA. */
  compressedBytes: number;
  plainBytes: number;
  compressedCount: number;
  /** Les plus lourdes, pour savoir ou regarder. */
  heaviest: { name: string; width: number; height: number; bytes: number; compressed: boolean }[];
}

/** Proprietes d'un materiau susceptibles de porter une texture. */
const SLOTS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'emissiveMap',
  'lightMap',
  'alphaMap',
  'bumpMap',
  'displacementMap',
  'envMap',
] as const;

export function measureTextureBudget(scene: THREE.Object3D): TextureBudget {
  const seen = new Map<string, { name: string; width: number; height: number; bytes: number; compressed: boolean }>();

  const collect = (texture: THREE.Texture | null | undefined, owner: string): void => {
    if (!texture || seen.has(texture.uuid)) return;
    const measured = cost(texture);
    if (!measured) return;
    seen.set(texture.uuid, { name: texture.name || owner, ...measured });
  };

  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!material) continue;
      const record = material as unknown as Record<string, THREE.Texture | undefined>;
      for (const slot of SLOTS) collect(record[slot], `${object.name || 'surface'}.${slot}`);
    }
  });

  let bytes = 0;
  let compressedBytes = 0;
  let compressedCount = 0;
  for (const entry of seen.values()) {
    bytes += entry.bytes;
    if (entry.compressed) {
      compressedBytes += entry.bytes;
      compressedCount += 1;
    }
  }

  const heaviest = [...seen.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 8);
  return {
    count: seen.size,
    bytes,
    compressedBytes,
    plainBytes: bytes - compressedBytes,
    compressedCount,
    heaviest,
  };
}

/** Ce qu'une texture occupe, d'apres sa nature et sa taille. */
function cost(texture: THREE.Texture): { width: number; height: number; bytes: number; compressed: boolean } | null {
  const compressed = texture as THREE.CompressedTexture;
  if (Array.isArray(compressed.mipmaps) && compressed.mipmaps.length > 0) {
    let total = 0;
    for (const level of compressed.mipmaps) {
      const data = (level as { data?: ArrayBufferView }).data;
      if (data) total += data.byteLength;
    }
    if (total > 0) {
      return {
        width: compressed.image?.width ?? 0,
        height: compressed.image?.height ?? 0,
        bytes: total,
        compressed: true,
      };
    }
  }

  const image = texture.image as { width?: number; height?: number } | undefined;
  const width = image?.width ?? 0;
  const height = image?.height ?? 0;
  if (!width || !height) return null;
  // Quatre octets par pixel, et un tiers de plus quand les niveaux existent.
  const levels = texture.generateMipmaps ? 4 / 3 : 1;
  return { width, height, bytes: Math.round(width * height * 4 * levels), compressed: false };
}
