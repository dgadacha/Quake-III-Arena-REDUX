import { BinaryReader } from './binary';

/**
 * Modeles MD3 : armes, objets a ramasser, parties de personnages. Le format
 * range une position par sommet et par image d'animation ; l'animation ne
 * deforme donc pas un squelette, elle interpole entre deux poses completes.
 *
 * Les positions sont stockees en entiers courts au soixante-quatrieme d'unite,
 * et les normales sur deux octets, en latitude et longitude. Les reperes
 * d'assemblage, dits tags, donnent a chaque image la position et l'orientation
 * ou accrocher la piece suivante : torse sur jambes, tete sur torse, arme sur
 * main.
 */

export const MD3_VERSION = 15;
/** Les coordonnees sont rangees au soixante-quatrieme d'unite. */
const XYZ_SCALE = 1 / 64;

export interface Md3Frame {
  mins: [number, number, number];
  maxs: [number, number, number];
  origin: [number, number, number];
  radius: number;
  name: string;
}

export interface Md3Tag {
  name: string;
  origin: [number, number, number];
  /** Trois vecteurs de base, dans l'ordre avant, gauche, haut. */
  axis: [number, number, number, number, number, number, number, number, number];
}

export interface Md3Surface {
  name: string;
  frameCount: number;
  vertexCount: number;
  /** Indices des triangles, trois par face. */
  indices: Uint16Array;
  /** Coordonnees de texture, deux par sommet. */
  texCoords: Float32Array;
  /** Positions de tous les sommets de toutes les images, a la suite. */
  positions: Float32Array;
  /** Normales de tous les sommets de toutes les images, a la suite. */
  normals: Float32Array;
  /** Noms des images de surface declarees par le modele. */
  shaders: string[];
}

export class Md3Model {
  readonly name: string;
  readonly frames: Md3Frame[] = [];
  /** Tags par image : le tableau compte images fois tags entrees. */
  readonly tags: Md3Tag[] = [];
  readonly tagNames: string[] = [];
  readonly surfaces: Md3Surface[] = [];

  constructor(buffer: ArrayBuffer | Uint8Array, readonly label = 'md3') {
    const reader = new BinaryReader(buffer);
    const magic = reader.magic(4);
    if (magic !== 'IDP3') throw new Error(`${label}: signature IDP3 attendue, recu "${magic}"`);
    const version = reader.i32();
    if (version !== MD3_VERSION) {
      throw new Error(`${label}: version ${version} non prise en charge (15 attendue)`);
    }

    this.name = reader.fixedString(64);
    reader.i32(); // drapeaux, sans usage ici
    const frameCount = reader.i32();
    const tagCount = reader.i32();
    const surfaceCount = reader.i32();
    reader.i32(); // nombre de peaux, toujours zero dans les fichiers du jeu
    const framesAt = reader.i32();
    const tagsAt = reader.i32();
    const surfacesAt = reader.i32();

    reader.seek(framesAt);
    for (let i = 0; i < frameCount; i++) {
      this.frames.push({
        mins: reader.vec3(),
        maxs: reader.vec3(),
        origin: reader.vec3(),
        radius: reader.f32(),
        name: reader.fixedString(16),
      });
    }

    reader.seek(tagsAt);
    for (let i = 0; i < frameCount * tagCount; i++) {
      const name = reader.fixedString(64);
      const origin = reader.vec3();
      const axis: Md3Tag['axis'] = [
        reader.f32(),
        reader.f32(),
        reader.f32(),
        reader.f32(),
        reader.f32(),
        reader.f32(),
        reader.f32(),
        reader.f32(),
        reader.f32(),
      ];
      this.tags.push({ name, origin, axis });
      if (i < tagCount) this.tagNames.push(name);
    }

    let cursor = surfacesAt;
    for (let i = 0; i < surfaceCount; i++) {
      const surface = this.readSurface(reader, cursor);
      this.surfaces.push(surface.data);
      cursor = surface.next;
    }
  }

  get frameCount(): number {
    return this.frames.length;
  }

  get tagCount(): number {
    return this.tagNames.length;
  }

  /** Repere d'assemblage d'une image donnee, par son nom. */
  tag(frame: number, name: string): Md3Tag | null {
    const index = this.tagNames.indexOf(name);
    if (index < 0) return null;
    const at = frame * this.tagCount + index;
    return this.tags[at] ?? null;
  }

  private readSurface(reader: BinaryReader, at: number): { data: Md3Surface; next: number } {
    reader.seek(at);
    const magic = reader.magic(4);
    if (magic !== 'IDP3') throw new Error(`${this.label}: surface invalide`);

    const name = reader.fixedString(64);
    reader.i32(); // drapeaux
    const frameCount = reader.i32();
    const shaderCount = reader.i32();
    const vertexCount = reader.i32();
    const triangleCount = reader.i32();
    const trianglesAt = reader.i32();
    const shadersAt = reader.i32();
    const texCoordsAt = reader.i32();
    const verticesAt = reader.i32();
    const end = reader.i32();

    const indices = new Uint16Array(triangleCount * 3);
    reader.seek(at + trianglesAt);
    for (let i = 0; i < triangleCount * 3; i++) indices[i] = reader.i32();

    const shaders: string[] = [];
    reader.seek(at + shadersAt);
    for (let i = 0; i < shaderCount; i++) {
      shaders.push(reader.fixedString(64).replace(/\\/g, '/').toLowerCase());
      reader.i32(); // indice interne, inutile ici
    }

    const texCoords = new Float32Array(vertexCount * 2);
    reader.seek(at + texCoordsAt);
    for (let i = 0; i < vertexCount * 2; i++) texCoords[i] = reader.f32();

    const positions = new Float32Array(frameCount * vertexCount * 3);
    const normals = new Float32Array(frameCount * vertexCount * 3);
    reader.seek(at + verticesAt);
    for (let i = 0; i < frameCount * vertexCount; i++) {
      positions[i * 3] = reader.i16() * XYZ_SCALE;
      positions[i * 3 + 1] = reader.i16() * XYZ_SCALE;
      positions[i * 3 + 2] = reader.i16() * XYZ_SCALE;
      const encoded = reader.u16();
      // Normale rangee en deux angles : latitude sur l'octet haut, longitude sur l'autre.
      const latitude = ((encoded >> 8) & 0xff) * ((Math.PI * 2) / 255);
      const longitude = (encoded & 0xff) * ((Math.PI * 2) / 255);
      normals[i * 3] = Math.cos(latitude) * Math.sin(longitude);
      normals[i * 3 + 1] = Math.sin(latitude) * Math.sin(longitude);
      normals[i * 3 + 2] = Math.cos(longitude);
    }

    return {
      data: { name, frameCount, vertexCount, indices, texCoords, positions, normals, shaders },
      next: at + end,
    };
  }
}

/** Sequences declarees par animation.cfg, pour les modeles de personnages. */
export interface Md3Animation {
  firstFrame: number;
  frameCount: number;
  loopFrames: number;
  /** Images par seconde declarees par le fichier. */
  fps: number;
}

/**
 * Lit un animation.cfg : une ligne par sequence, quatre nombres, le reste en
 * commentaires. Les lignes de reglage de sexe ou de pieds sont ignorees.
 */
export function parseAnimationConfig(text: string): Md3Animation[] {
  const animations: Md3Animation[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const numbers = parts.slice(0, 4).map(Number);
    if (numbers.some((value) => !Number.isFinite(value))) continue;
    animations.push({
      firstFrame: numbers[0],
      frameCount: numbers[1],
      loopFrames: numbers[2],
      fps: Math.max(1, numbers[3]),
    });
  }
  return animations;
}
