import * as THREE from 'three';
import { LIGHTMAP_SIZE, type BspMap } from '../formats/bsp';

/**
 * Les cartes rangent leur eclairage precalcule dans une suite d'images de
 * 128 par 128. On les empile dans de grandes planches pour limiter le nombre
 * de textures, et les coordonnees des faces sont replacees en consequence.
 */

const TILES_PER_SIDE = 16;
const ATLAS_SIZE = LIGHTMAP_SIZE * TILES_PER_SIDE;

export interface LightmapPlacement {
  /** Planche contenant cette lightmap. */
  atlas: number;
  offsetU: number;
  offsetV: number;
  scale: number;
}

export class LightmapAtlas {
  readonly textures: THREE.DataTexture[] = [];
  readonly placements: LightmapPlacement[] = [];

  /**
   * Remonte l'intensite comme le fait le jeu : les valeurs sont decalees vers
   * le haut, et quand une couleur deborde, elle est ramenee par sa composante
   * la plus forte plutot que saturee vers le blanc.
   */
  constructor(map: BspMap, shift = 1) {
    const count = map.lightmaps.length;
    if (count === 0) return;

    const atlasCount = Math.ceil(count / (TILES_PER_SIDE * TILES_PER_SIDE));
    for (let i = 0; i < atlasCount; i++) {
      const data = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4);
      data.fill(255);
      const texture = new THREE.DataTexture(data, ATLAS_SIZE, ATLAS_SIZE, THREE.RGBAFormat);
      texture.colorSpace = THREE.SRGBColorSpace;
      /*
       * Les lightmaps ont leurs propres coordonnees, rangees dans le second
       * jeu de la geometrie. Sans cette ligne, elles sont lues avec les
       * coordonnees de la texture diffuse : la lumiere se retrouve plaquee
       * n'importe ou sur la surface, et il faut monter l'intensite pour que
       * la carte paraisse eclairee, ce qui l'aplatit.
       */
      texture.channel = 1;
      texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      this.textures.push(texture);
    }

    for (let index = 0; index < count; index++) {
      const atlas = Math.floor(index / (TILES_PER_SIDE * TILES_PER_SIDE));
      const local = index % (TILES_PER_SIDE * TILES_PER_SIDE);
      const tileX = local % TILES_PER_SIDE;
      const tileY = Math.floor(local / TILES_PER_SIDE);
      const source = map.lightmaps[index];
      const target = this.textures[atlas].image.data as Uint8Array;

      for (let y = 0; y < LIGHTMAP_SIZE; y++) {
        for (let x = 0; x < LIGHTMAP_SIZE; x++) {
          const from = (y * LIGHTMAP_SIZE + x) * 3;
          const to = ((tileY * LIGHTMAP_SIZE + y) * ATLAS_SIZE + tileX * LIGHTMAP_SIZE + x) * 4;
          let r = source[from];
          let g = source[from + 1];
          let b = source[from + 2];
          if (shift > 0) {
            r <<= shift;
            g <<= shift;
            b <<= shift;
            const max = Math.max(r, g, b);
            if (max > 255) {
              r = Math.round((r * 255) / max);
              g = Math.round((g * 255) / max);
              b = Math.round((b * 255) / max);
            }
          }
          target[to] = r;
          target[to + 1] = g;
          target[to + 2] = b;
          target[to + 3] = 255;
        }
      }

      this.placements.push({
        atlas,
        offsetU: tileX / TILES_PER_SIDE,
        offsetV: tileY / TILES_PER_SIDE,
        scale: 1 / TILES_PER_SIDE,
      });
    }

    for (const texture of this.textures) texture.needsUpdate = true;
  }

  get atlasCount(): number {
    return this.textures.length;
  }

  placement(index: number): LightmapPlacement | null {
    return this.placements[index] ?? null;
  }

  dispose(): void {
    for (const texture of this.textures) texture.dispose();
  }
}
