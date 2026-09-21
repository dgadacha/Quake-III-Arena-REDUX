import * as THREE from 'three';

/**
 * Cartes compressees par la chaine de textures.
 *
 * Une texture ordinaire est televersee en quatre octets par pixel : le
 * navigateur decode le PNG en RGBA, et la carte graphique garde cet RGBA. A
 * pleine couverture, les trois cartes d'une surface depassaient ainsi le
 * gigaoctet et demi pour une seule arene. Compressees en blocs BC7, elles
 * occupent un octet par pixel, et il n'y a plus rien a decoder : le tampon
 * part tel quel vers la carte graphique.
 *
 * Le format est celui que la chaine ecrit : douze octets d'entete, puis les
 * niveaux de mipmap du plus grand au plus petit. Ils sont dans le fichier
 * parce qu'une texture compressee ne peut pas les faire calculer a
 * l'execution.
 */

/** Entete : quatre octets de signature, puis version, format, espace, niveaux, taille. */
const HEADER = 12;
const SIGNATURE = 'Q3TX';
const FORMAT_BC7 = 1;

/** Un bloc BC7 couvre quatre pixels par quatre et pese seize octets. */
const BLOCK_BYTES = 16;

export function supportsBlockTextures(renderer: THREE.WebGLRenderer): boolean {
  return renderer.extensions.has('EXT_texture_compression_bptc');
}

/**
 * Lit un fichier de cartes compressees. Rend rien quand l'entete n'est pas
 * celle attendue : l'appelant retombe alors sur le PNG.
 */
export function readBlockTexture(buffer: ArrayBuffer): THREE.CompressedTexture | null {
  if (buffer.byteLength < HEADER) return null;
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < SIGNATURE.length; index++) {
    if (bytes[index] !== SIGNATURE.charCodeAt(index)) return null;
  }

  const view = new DataView(buffer);
  const format = view.getUint8(5);
  const srgb = view.getUint8(6) === 1;
  const levelCount = view.getUint8(7);
  let width = view.getUint16(8, true);
  let height = view.getUint16(10, true);
  if (view.getUint8(4) !== 1 || format !== FORMAT_BC7 || levelCount < 1 || width < 1 || height < 1) return null;

  const levels: { data: Uint8Array; width: number; height: number }[] = [];
  let offset = HEADER;
  for (let level = 0; level < levelCount; level++) {
    if (offset + 4 > buffer.byteLength) return null;
    const length = view.getUint32(offset, true);
    offset += 4;
    if (offset + length > buffer.byteLength) return null;
    // Controle de coherence : un niveau pese exactement le nombre de blocs
    // qu'il couvre. Un fichier tronque ferait echouer le televersement plus
    // loin, avec un message illisible.
    const expected = Math.ceil(width / 4) * Math.ceil(height / 4) * BLOCK_BYTES;
    if (length !== expected) return null;
    levels.push({ data: new Uint8Array(buffer, offset, length), width, height });
    offset += length;
    width = Math.max(1, width >> 1);
    height = Math.max(1, height >> 1);
  }

  const texture = new THREE.CompressedTexture(
    levels,
    levels[0].width,
    levels[0].height,
    THREE.RGBA_BPTC_Format,
  );
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
