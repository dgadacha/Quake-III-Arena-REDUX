import * as THREE from 'three';

/**
 * Micro-relief de surface.
 *
 * Une texture agrandie, meme huit fois, ne raconte rien de plus que ce que ses
 * soixante-quatre pixels d'origine contenaient : de pres, la surface reste
 * lisse, et c'est cette absence de grain qu'on lit comme du flou. Les jeux
 * modernes ne resolvent pas cela par la resolution, qui coute de la memoire
 * sans rien apporter, mais par une couche de detail repetee bien plus
 * souvent : du grain, des micro-rayures, de la porosite.
 *
 * La couche est la meme pour toute la carte, calculee au demarrage et tenue en
 * une seule texture : deux canaux de pente pour le relief, un troisieme pour
 * une variation de teinte. Elle est repetee a frequence constante dans le
 * monde, quelle que soit la taille de la texture qu'elle accompagne, et
 * s'efface d'elle-meme avec la distance : ses niveaux de mipmap tendent vers
 * une surface plane.
 */

/** Cote de la texture de detail. Elle est repetee, elle n'a pas a etre grande. */
const SIZE = 256;

/** Distance du monde couverte par une repetition du detail, en unites. */
const WORLD_SPAN = 14;

let shared: THREE.DataTexture | null = null;

/** Texture de detail partagee, calculee au premier appel. */
export function detailTexture(): THREE.DataTexture {
  if (shared) return shared;

  const grain = noise(SIZE, 48, 3);
  const speck = noise(SIZE, 11, 4);
  const data = new Uint8Array(SIZE * SIZE * 4);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const index = y * SIZE + x;
      // Pente du grain, prise sur ses voisins : c'est elle qui incline la
      // normale. Les bords se rejoignent, la texture se repete sans couture.
      const left = grain[y * SIZE + ((x + SIZE - 1) % SIZE)];
      const right = grain[y * SIZE + ((x + 1) % SIZE)];
      const up = grain[((y + SIZE - 1) % SIZE) * SIZE + x];
      const down = grain[((y + 1) % SIZE) * SIZE + x];
      data[index * 4] = clampByte(0.5 - (right - left) * 2);
      data[index * 4 + 1] = clampByte(0.5 - (down - up) * 2);
      data[index * 4 + 2] = clampByte(speck[index]);
      data[index * 4 + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  shared = texture;
  return texture;
}

/**
 * Nombre de repetitions du detail pour une texture donnee, de sorte que son
 * grain garde la meme taille dans le monde d'un mur a l'autre.
 *
 * Les cartes du jeu plaquent leurs textures a deux texels par unite : une
 * texture de 256 pixels de large couvre donc 128 unites, et le detail doit s'y
 * repeter neuf fois pour valoir quatorze unites.
 */
export function detailTiles(sourceWidth: number): number {
  const span = Math.max(8, sourceWidth / 2);
  return Math.max(1, span / WORLD_SPAN);
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value * 255)));
}

/**
 * Bruit doux repetable, entre zero et un, somme sur plusieurs octaves. La
 * grille se referme sur elle-meme, comme dans la chaine de textures.
 */
function noise(size: number, cells: number, octaves: number): Float32Array {
  const total = new Float32Array(size * size);
  let amplitude = 1;
  let weight = 0;

  for (let octave = 0; octave < octaves; octave++) {
    const count = cells * 2 ** octave;
    const grid = new Float32Array(count * count);
    for (let index = 0; index < grid.length; index++) grid[index] = Math.random();

    for (let y = 0; y < size; y++) {
      const positionY = (y / size) * count;
      const lowY = Math.floor(positionY);
      const fractionY = positionY - lowY;
      const smoothY = fractionY * fractionY * (3 - 2 * fractionY);
      for (let x = 0; x < size; x++) {
        const positionX = (x / size) * count;
        const lowX = Math.floor(positionX);
        const fractionX = positionX - lowX;
        const smoothX = fractionX * fractionX * (3 - 2 * fractionX);
        const x0 = lowX % count;
        const x1 = (lowX + 1) % count;
        const y0 = (lowY % count) * count;
        const y1 = ((lowY + 1) % count) * count;
        const top = grid[y0 + x0] * (1 - smoothX) + grid[y0 + x1] * smoothX;
        const bottom = grid[y1 + x0] * (1 - smoothX) + grid[y1 + x1] * smoothX;
        total[y * size + x] += (top * (1 - smoothY) + bottom * smoothY) * amplitude;
      }
    }
    weight += amplitude;
    amplitude *= 0.5;
  }

  for (let index = 0; index < total.length; index++) total[index] /= weight;
  return total;
}
