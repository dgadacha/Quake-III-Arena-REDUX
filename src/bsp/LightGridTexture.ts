import * as THREE from 'three';
import type { BspMap } from '../formats/bsp';

/**
 * Grille d'eclairage de la carte, versee dans des textures de volume.
 *
 * Le compilateur de cartes range, tous les soixante-quatre par soixante-quatre
 * par cent vingt-huit unites, la couleur d'ambiance, la couleur de la lumiere
 * dominante et la direction d'ou elle vient. Le jeu d'origine ne s'en sert que
 * pour les objets mobiles : les surfaces fixes, elles, n'ont que leur lightmap,
 * qui ne porte aucune direction.
 *
 * Or c'est precisement la direction qui manque pour qu'un materiau moderne
 * existe. Sans elle, une carte de normales ne se voit pas, une rugosite ne
 * change rien, et un metal reste un aplat : il n'y a aucun reflet a placer.
 * En versant la grille dans une texture de volume, chaque pixel du decor peut
 * retrouver d'ou vient sa lumiere et rendre son reflet, sans toucher a la
 * lightmap qui continue de porter la diffusion.
 */

export interface LightGridTextures {
  /** Couleur de la lumiere dominante, en lumiere lineaire. */
  light: THREE.Data3DTexture;
  /** Direction d'ou vient la lumiere, encodee dans zero-un. */
  direction: THREE.Data3DTexture;
  /** Coin de la grille, en unites de carte. */
  mins: THREE.Vector3;
  /** Etendue couverte par la grille. */
  size: THREE.Vector3;
  dispose(): void;
}

/** Pas de la grille, impose par le compilateur de cartes. */
const STEP = [64, 64, 128];

/** Table sRGB vers lineaire : deux cent cinquante-six valeurs suffisent. */
const LINEAR = new Uint8Array(256);
for (let value = 0; value < 256; value++) {
  const srgb = value / 255;
  const linear = srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  LINEAR[value] = Math.round(linear * 255);
}

export function buildLightGridTextures(map: BspMap): LightGridTextures | null {
  const volumes = map.lightVolumes;
  if (!volumes) return null;

  const [countX, countY, countZ] = volumes.counts;
  const total = countX * countY * countZ;
  if (total <= 0) return null;

  const lightData = new Uint8Array(new ArrayBuffer(total * 4));
  const directionData = new Uint8Array(new ArrayBuffer(total * 4));

  for (let index = 0; index < total; index++) {
    const valid = volumes.ambient[index * 3] + volumes.ambient[index * 3 + 1]
      + volumes.ambient[index * 3 + 2] > 0;
    // La couleur part en lumiere lineaire : le rendu travaille en lineaire, et
    // une texture de volume ne beneficie pas de la conversion automatique.
    lightData[index * 4] = LINEAR[volumes.directional[index * 3]];
    lightData[index * 4 + 1] = LINEAR[volumes.directional[index * 3 + 1]];
    lightData[index * 4 + 2] = LINEAR[volumes.directional[index * 3 + 2]];
    lightData[index * 4 + 3] = 255;

    // La direction est rangee en deux angles, comme dans le jeu.
    const longitude = (volumes.direction[index * 2] * Math.PI * 2) / 256;
    const latitude = (volumes.direction[index * 2 + 1] * Math.PI * 2) / 256;
    const x = Math.cos(latitude) * Math.sin(longitude);
    const y = Math.sin(latitude) * Math.sin(longitude);
    const z = Math.cos(longitude);
    directionData[index * 4] = valid ? Math.round((x * 0.5 + 0.5) * 255) : 128;
    directionData[index * 4 + 1] = valid ? Math.round((y * 0.5 + 0.5) * 255) : 128;
    directionData[index * 4 + 2] = valid ? Math.round((z * 0.5 + 0.5) * 255) : 128;
    directionData[index * 4 + 3] = 255;
  }

  const light = makeTexture(lightData, countX, countY, countZ, THREE.LinearFilter);
  // Interpoler les vecteurs (puis les normaliser dans le shader) evite les
  // reflets carres de 64 unites. Une moyenne nulle est ignoree par le shader.
  const direction = makeTexture(directionData, countX, countY, countZ, THREE.LinearFilter);

  return {
    light,
    direction,
    // Les echantillons sont au centre des texels, pas sur leur bord.
    mins: new THREE.Vector3(
      volumes.mins[0] - STEP[0] / 2,
      volumes.mins[1] - STEP[1] / 2,
      volumes.mins[2] - STEP[2] / 2,
    ),
    size: new THREE.Vector3(countX * STEP[0], countY * STEP[1], countZ * STEP[2]),
    dispose: () => {
      light.dispose();
      direction.dispose();
    },
  };
}

function makeTexture(
  data: Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
  depth: number,
  filter: THREE.MagnificationTextureFilter,
): THREE.Data3DTexture {
  const texture = new THREE.Data3DTexture(data, width, height, depth);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = filter;
  texture.magFilter = filter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.wrapR = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}
