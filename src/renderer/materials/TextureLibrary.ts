import * as THREE from 'three';
import type { VirtualFileSystem } from '../../formats/pk3';
import { asBlobPart, asBytes } from '../../util/bytes';

/**
 * Images des cartes. Le jeu range ses textures en .jpg et en .tga, et les
 * scripts les nomment sans extension : on essaie les deux. Le relief et la
 * rugosite sont deduits de la luminance, ce qui donne du volume aux surfaces
 * agrandies sans rien demander d'autre que la texture d'origine.
 */

export interface DecodedImage {
  width: number;
  height: number;
  /** Quatre octets par pixel, du haut vers le bas. */
  data: Uint8Array;
  hasAlpha: boolean;
}

/** Decodeur TGA : couleurs vraies et niveaux de gris, compresses ou non. */
export function decodeTga(bytes: Uint8Array): DecodedImage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idLength = view.getUint8(0);
  const colorMapType = view.getUint8(1);
  const imageType = view.getUint8(2);
  const width = view.getUint16(12, true);
  const height = view.getUint16(14, true);
  const depth = view.getUint8(16);
  const descriptor = view.getUint8(17);

  if (colorMapType !== 0) throw new Error('TGA a palette non pris en charge');
  const compressed = imageType === 10 || imageType === 11;
  const grayscale = imageType === 3 || imageType === 11;
  if (![2, 3, 10, 11].includes(imageType)) throw new Error(`TGA de type ${imageType} non pris en charge`);

  const bytesPerPixel = Math.max(1, depth >> 3);
  const out = new Uint8Array(width * height * 4);
  const pixelCount = width * height;
  let cursor = 18 + idLength;
  let written = 0;

  const emit = (index: number, source: number) => {
    const at = index * 4;
    if (grayscale) {
      const level = bytes[source];
      out[at] = level;
      out[at + 1] = level;
      out[at + 2] = level;
      out[at + 3] = 255;
      return;
    }
    // Les octets sont ranges en bleu, vert, rouge.
    out[at] = bytes[source + 2];
    out[at + 1] = bytes[source + 1];
    out[at + 2] = bytes[source];
    out[at + 3] = bytesPerPixel === 4 ? bytes[source + 3] : 255;
  };

  if (!compressed) {
    for (let i = 0; i < pixelCount; i++) emit(i, cursor + i * bytesPerPixel);
    written = pixelCount;
  } else {
    while (written < pixelCount && cursor < bytes.byteLength) {
      const packet = bytes[cursor++];
      const count = (packet & 0x7f) + 1;
      if (packet & 0x80) {
        // Paquet repete : une seule couleur pour tout le groupe.
        for (let i = 0; i < count && written < pixelCount; i++) emit(written++, cursor);
        cursor += bytesPerPixel;
      } else {
        for (let i = 0; i < count && written < pixelCount; i++) {
          emit(written++, cursor);
          cursor += bytesPerPixel;
        }
      }
    }
  }

  // Bit 5 du descripteur : origine en haut a gauche, sinon en bas.
  if ((descriptor & 0x20) === 0) flipVertically(out, width, height);

  let hasAlpha = false;
  if (bytesPerPixel === 4) {
    for (let i = 3; i < out.length; i += 4) {
      if (out[i] !== 255) {
        hasAlpha = true;
        break;
      }
    }
  }
  return { width, height, data: out, hasAlpha };
}

function flipVertically(data: Uint8Array, width: number, height: number): void {
  const stride = width * 4;
  const row = new Uint8Array(stride);
  for (let y = 0; y < height >> 1; y++) {
    const top = y * stride;
    const bottom = (height - 1 - y) * stride;
    row.set(data.subarray(top, top + stride));
    data.copyWithin(top, bottom, bottom + stride);
    data.set(row, bottom);
  }
}

async function decodeWithBrowser(bytes: Uint8Array, type: string): Promise<DecodedImage> {
  const bitmap = await createImageBitmap(new Blob([asBlobPart(bytes)], { type }));
  // La taille doit etre relevee avant la fermeture : apres, elle vaut zero.
  const width = bitmap.width;
  const height = bitmap.height;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('canvas 2d indisponible');
  context.drawImage(bitmap, 0, 0);
  const pixels = context.getImageData(0, 0, width, height);
  bitmap.close();
  return { width, height, data: new Uint8Array(pixels.data.buffer.slice(0)), hasAlpha: false };
}

export interface LoadedTexture {
  map: THREE.Texture;
  normalMap: THREE.Texture | null;
  roughnessMap: THREE.Texture | null;
  hasAlpha: boolean;
}

/** Charge et met en cache les images d'une carte. */
export class TextureLibrary {
  private readonly cache = new Map<string, Promise<LoadedTexture | null>>();
  /** Relief deduit : agreable de pres, inutile de loin. */
  deriveDetail = true;
  anisotropy = 8;

  constructor(private readonly vfs: VirtualFileSystem) {}

  get size(): number {
    return this.cache.size;
  }

  load(name: string): Promise<LoadedTexture | null> {
    const key = name.toLowerCase().replace(/\.(tga|jpg|jpeg|png)$/i, '');
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.loadUncached(key);
      this.cache.set(key, pending);
    }
    return pending;
  }

  private async loadUncached(name: string): Promise<LoadedTexture | null> {
    const found = await this.vfs.readAny(name, ['tga', 'jpg', 'jpeg', 'png']);
    if (!found) return null;

    let image: DecodedImage;
    try {
      if (found.path.endsWith('.tga')) image = decodeTga(found.data);
      else image = await decodeWithBrowser(found.data, found.path.endsWith('.png') ? 'image/png' : 'image/jpeg');
    } catch {
      return null;
    }

    if (image.width <= 0 || image.height <= 0) return null;

    const map = new THREE.DataTexture(asBytes(image.data), image.width, image.height, THREE.RGBAFormat);
    map.colorSpace = THREE.SRGBColorSpace;
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.magFilter = THREE.LinearFilter;
    map.minFilter = THREE.LinearMipmapLinearFilter;
    map.generateMipmaps = true;
    map.anisotropy = this.anisotropy;
    map.needsUpdate = true;

    let normalMap: THREE.Texture | null = null;
    let roughnessMap: THREE.Texture | null = null;
    if (this.deriveDetail && image.width <= 1024 && image.height <= 1024) {
      const derived = deriveDetailMaps(image);
      normalMap = derived.normalMap;
      roughnessMap = derived.roughnessMap;
      normalMap.anisotropy = this.anisotropy;
    }

    return { map, normalMap, roughnessMap, hasAlpha: image.hasAlpha };
  }
}

/**
 * Relief et rugosite deduits de la luminance : les creux de la texture
 * deviennent des creux de surface, les zones claires deviennent lisses.
 */
export function deriveDetailMaps(image: DecodedImage): {
  normalMap: THREE.DataTexture;
  roughnessMap: THREE.DataTexture;
} {
  const { width, height, data } = image;
  const luminance = new Float32Array(width * height);
  for (let i = 0; i < luminance.length; i++) {
    const at = i * 4;
    luminance[i] = (data[at] * 0.299 + data[at + 1] * 0.587 + data[at + 2] * 0.114) / 255;
  }

  const normals = new Uint8Array(width * height * 4);
  const rough = new Uint8Array(width * height * 4);
  const strength = 2.5;
  for (let y = 0; y < height; y++) {
    const up = ((y - 1 + height) % height) * width;
    const down = ((y + 1) % height) * width;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const left = (x - 1 + width) % width;
      const right = (x + 1) % width;
      const dx = (luminance[row + left] - luminance[row + right]) * strength;
      const dy = (luminance[up + x] - luminance[down + x]) * strength;
      const inverse = 1 / Math.hypot(dx, dy, 1);
      const at = (row + x) * 4;
      normals[at] = Math.round((dx * inverse * 0.5 + 0.5) * 255);
      normals[at + 1] = Math.round((dy * inverse * 0.5 + 0.5) * 255);
      normals[at + 2] = Math.round((inverse * 0.5 + 0.5) * 255);
      normals[at + 3] = 255;

      // Les surfaces sombres sont plus mates, les claires plus polies.
      const value = Math.round((0.45 + (1 - luminance[row + x]) * 0.5) * 255);
      rough[at] = value;
      rough[at + 1] = value;
      rough[at + 2] = value;
      rough[at + 3] = 255;
    }
  }

  const normalMap = new THREE.DataTexture(normals, width, height, THREE.RGBAFormat);
  normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.minFilter = THREE.LinearMipmapLinearFilter;
  normalMap.generateMipmaps = true;
  normalMap.needsUpdate = true;

  const roughnessMap = new THREE.DataTexture(rough, width, height, THREE.RGBAFormat);
  roughnessMap.wrapS = roughnessMap.wrapT = THREE.RepeatWrapping;
  roughnessMap.minFilter = THREE.LinearMipmapLinearFilter;
  roughnessMap.generateMipmaps = true;
  roughnessMap.needsUpdate = true;

  return { normalMap, roughnessMap };
}
