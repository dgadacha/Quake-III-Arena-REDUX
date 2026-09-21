import * as THREE from 'three';
import { readBlockTexture } from '../materials/CompressedMaps';

/**
 * Controle de la compression des textures.
 *
 * La chaine ecrit chaque carte deux fois : en PNG et en blocs BC7. Rien ne dit
 * de l'exterieur que les seconds sont bien lus : un octet mal place dans
 * l'entete d'un bloc donne une image plausible, decalee ou delavee, et cela ne
 * se remarque qu'a l'oeil, tard.
 *
 * Ce controle dessine les deux versions de la meme carte, relit les pixels et
 * compare. Il dit donc deux choses d'un coup : que le format est bien
 * interprete par la carte graphique, et ce que la compression a coute.
 */

export interface CompressionReport {
  width: number;
  height: number;
  /** Ecart moyen et maximal, sur zero-un. */
  meanError: number;
  maxError: number;
  /** Rapport signal sur bruit, en decibels. Au-dela de quarante, invisible. */
  psnr: number;
  /** Octets en memoire video, de part et d'autre, mipmaps comprises. */
  pngBytes: number;
  packedBytes: number;
}

export async function compareCompression(
  renderer: THREE.WebGLRenderer,
  png: string,
  packed: string,
): Promise<CompressionReport | null> {
  const [reference, blocks] = await Promise.all([
    new THREE.TextureLoader().loadAsync(png),
    fetch(packed).then((response) => response.arrayBuffer()).then(readBlockTexture),
  ]);
  if (!blocks) return null;
  reference.flipY = false;
  reference.colorSpace = THREE.SRGBColorSpace;
  reference.needsUpdate = true;

  const width = blocks.image.width;
  const height = blocks.image.height;
  const first = await read(renderer, reference, width, height);
  const second = await read(renderer, blocks, width, height);

  let sum = 0;
  let worst = 0;
  let squared = 0;
  for (let index = 0; index < first.length; index++) {
    // Le canal alpha ne porte rien ici : les cartes sont opaques.
    if (index % 4 === 3) continue;
    const error = Math.abs(first[index] - second[index]) / 255;
    sum += error;
    squared += error * error;
    worst = Math.max(worst, error);
  }
  const count = (first.length / 4) * 3;
  const mean = squared / count;

  reference.dispose();
  blocks.dispose();

  return {
    width,
    height,
    meanError: sum / count,
    maxError: worst,
    psnr: mean > 0 ? 10 * Math.log10(1 / mean) : 99,
    pngBytes: Math.round(width * height * 4 * (4 / 3)),
    packedBytes: Math.round(width * height * (4 / 3)),
  };
}

/** Dessine une texture a sa taille reelle et relit les pixels. */
async function read(
  renderer: THREE.WebGLRenderer,
  texture: THREE.Texture,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const target = new THREE.WebGLRenderTarget(width, height);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: texture }),
  );
  scene.add(quad);

  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  renderer.setRenderTarget(previous);

  const pixels = new Uint8Array(width * height * 4);
  await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height, pixels);

  quad.geometry.dispose();
  (quad.material as THREE.Material).dispose();
  target.dispose();
  return pixels;
}
