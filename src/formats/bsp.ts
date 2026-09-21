import { BinaryReader } from './binary';

/**
 * Cartes au format IBSP version 46. Le fichier est une suite de 17 blocs
 * decrits par un sommaire place en tete ; chacun est un tableau de structures
 * de taille fixe, sauf les entites (texte) et la visibilite (bitset).
 */

export const BSP_VERSION = 46;

const Lump = {
  Entities: 0,
  Shaders: 1,
  Planes: 2,
  Nodes: 3,
  Leafs: 4,
  LeafFaces: 5,
  LeafBrushes: 6,
  Models: 7,
  Brushes: 8,
  BrushSides: 9,
  Vertices: 10,
  MeshVerts: 11,
  Effects: 12,
  Faces: 13,
  Lightmaps: 14,
  LightVols: 15,
  Visibility: 16,
} as const;

/** Nature des volumes : sert a la collision et au rendu des liquides. */
export const Contents = {
  SOLID: 1,
  LAVA: 8,
  SLIME: 16,
  WATER: 32,
  FOG: 64,
  PLAYERCLIP: 0x10000,
  MONSTERCLIP: 0x20000,
  TELEPORTER: 0x40000,
  JUMPPAD: 0x80000,
  CLUSTERPORTAL: 0x100000,
  DONOTENTER: 0x200000,
  BOTCLIP: 0x400000,
  ORIGIN: 0x1000000,
  BODY: 0x2000000,
  DETAIL: 0x8000000,
  STRUCTURAL: 0x10000000,
  TRANSLUCENT: 0x20000000,
  TRIGGER: 0x40000000,
  NODROP: 0x80000000,
} as const;

/** Ce que le joueur ne traverse pas. */
export const MASK_SOLID = Contents.SOLID | Contents.PLAYERCLIP | Contents.BODY;
/** Ce qui arrete un tir : le joueur passe les clips, pas les balles. */
export const MASK_SHOT = Contents.SOLID | Contents.BODY;
export const MASK_WATER = Contents.WATER | Contents.LAVA | Contents.SLIME;

export const Surface = {
  NODAMAGE: 0x1,
  SLICK: 0x2,
  SKY: 0x4,
  LADDER: 0x8,
  NOIMPACT: 0x10,
  NOMARKS: 0x20,
  FLESH: 0x40,
  NODRAW: 0x80,
  HINT: 0x100,
  SKIP: 0x200,
  NOLIGHTMAP: 0x400,
  POINTLIGHT: 0x800,
  METALSTEPS: 0x1000,
  NOSTEPS: 0x2000,
  NONSOLID: 0x4000,
  LIGHTFILTER: 0x8000,
  ALPHASHADOW: 0x10000,
  NODLIGHT: 0x20000,
  DUST: 0x40000,
} as const;

export const FaceType = {
  POLYGON: 1,
  PATCH: 2,
  MESH: 3,
  BILLBOARD: 4,
} as const;

export const LIGHTMAP_SIZE = 128;

export type Vec3 = [number, number, number];

export interface BspShader {
  name: string;
  surfaceFlags: number;
  contents: number;
}

export interface BspPlane {
  normal: Vec3;
  dist: number;
}

export interface BspNode {
  plane: number;
  /** Negatif : -(feuille + 1). */
  children: [number, number];
  mins: Vec3;
  maxs: Vec3;
}

export interface BspLeaf {
  cluster: number;
  area: number;
  mins: Vec3;
  maxs: Vec3;
  firstLeafFace: number;
  leafFaceCount: number;
  firstLeafBrush: number;
  leafBrushCount: number;
}

export interface BspModel {
  mins: Vec3;
  maxs: Vec3;
  firstFace: number;
  faceCount: number;
  firstBrush: number;
  brushCount: number;
}

export interface BspBrush {
  firstSide: number;
  sideCount: number;
  shader: number;
  contents: number;
}

export interface BspBrushSide {
  plane: number;
  shader: number;
}

export interface BspFace {
  shader: number;
  effect: number;
  type: number;
  firstVertex: number;
  vertexCount: number;
  firstMeshVert: number;
  meshVertCount: number;
  lightmap: number;
  lightmapStart: [number, number];
  lightmapSize: [number, number];
  lightmapOrigin: Vec3;
  lightmapVecs: [Vec3, Vec3];
  normal: Vec3;
  /** Pour un patch : dimensions de la grille de controle. */
  patchSize: [number, number];
}

/** Sommets stockes a plat : un seul tableau par attribut, prets pour le GPU. */
export interface BspVertices {
  count: number;
  positions: Float32Array;
  texCoords: Float32Array;
  lightCoords: Float32Array;
  normals: Float32Array;
  colors: Uint8Array;
}

export interface BspLightVolumes {
  /** Nombre de cellules sur chaque axe de la grille d'eclairage. */
  counts: [number, number, number];
  mins: Vec3;
  ambient: Uint8Array;
  directional: Uint8Array;
  /** Direction encodee en angles (latitude, longitude) sur un octet chacun. */
  direction: Uint8Array;
}

export interface BspEntity {
  classname: string;
  [key: string]: string;
}

export class BspMap {
  readonly shaders: BspShader[] = [];
  readonly planes: BspPlane[] = [];
  readonly nodes: BspNode[] = [];
  readonly leafs: BspLeaf[] = [];
  readonly leafFaces: Int32Array;
  readonly leafBrushes: Int32Array;
  readonly models: BspModel[] = [];
  readonly brushes: BspBrush[] = [];
  readonly brushSides: BspBrushSide[] = [];
  readonly vertices: BspVertices;
  readonly meshVerts: Int32Array;
  readonly effects: { name: string; brush: number }[] = [];
  readonly faces: BspFace[] = [];
  /** Une lightmap par entree, 128x128 en RGB. */
  readonly lightmaps: Uint8Array[] = [];
  readonly lightVolumes: BspLightVolumes | null;
  readonly entities: BspEntity[] = [];
  readonly clusterCount: number;
  readonly clusterBytes: number;
  private readonly visibility: Uint8Array | null;

  constructor(buffer: ArrayBuffer | Uint8Array, readonly label = 'map') {
    const reader = new BinaryReader(buffer);
    const magic = reader.magic(4);
    if (magic !== 'IBSP') throw new Error(`${label}: signature IBSP attendue, recu "${magic}"`);
    const version = reader.i32();
    if (version !== BSP_VERSION) {
      throw new Error(`${label}: version ${version} non prise en charge (46 attendue)`);
    }

    const directory: { offset: number; length: number }[] = [];
    for (let i = 0; i < 17; i++) directory.push({ offset: reader.i32(), length: reader.i32() });

    const lump = (index: number, stride: number) => {
      const entry = directory[index];
      return { count: stride > 0 ? Math.floor(entry.length / stride) : 0, at: entry.offset, length: entry.length };
    };

    // Entites : un texte de paires cle/valeur.
    const entityLump = directory[Lump.Entities];
    this.entities = parseEntities(
      new TextDecoder('latin1').decode(reader.slice(entityLump.offset, entityLump.length)),
    );

    const shaders = lump(Lump.Shaders, 72);
    reader.seek(shaders.at);
    for (let i = 0; i < shaders.count; i++) {
      this.shaders.push({
        name: reader.fixedString(64).replace(/\\/g, '/').toLowerCase(),
        surfaceFlags: reader.i32(),
        contents: reader.i32(),
      });
    }

    const planes = lump(Lump.Planes, 16);
    reader.seek(planes.at);
    for (let i = 0; i < planes.count; i++) {
      this.planes.push({ normal: reader.vec3(), dist: reader.f32() });
    }

    const nodes = lump(Lump.Nodes, 36);
    reader.seek(nodes.at);
    for (let i = 0; i < nodes.count; i++) {
      this.nodes.push({
        plane: reader.i32(),
        children: [reader.i32(), reader.i32()],
        mins: reader.ivec3(),
        maxs: reader.ivec3(),
      });
    }

    const leafs = lump(Lump.Leafs, 48);
    reader.seek(leafs.at);
    for (let i = 0; i < leafs.count; i++) {
      this.leafs.push({
        cluster: reader.i32(),
        area: reader.i32(),
        mins: reader.ivec3(),
        maxs: reader.ivec3(),
        firstLeafFace: reader.i32(),
        leafFaceCount: reader.i32(),
        firstLeafBrush: reader.i32(),
        leafBrushCount: reader.i32(),
      });
    }

    this.leafFaces = readInt32Lump(reader, directory[Lump.LeafFaces]);
    this.leafBrushes = readInt32Lump(reader, directory[Lump.LeafBrushes]);

    const models = lump(Lump.Models, 40);
    reader.seek(models.at);
    for (let i = 0; i < models.count; i++) {
      this.models.push({
        mins: reader.vec3(),
        maxs: reader.vec3(),
        firstFace: reader.i32(),
        faceCount: reader.i32(),
        firstBrush: reader.i32(),
        brushCount: reader.i32(),
      });
    }

    const brushes = lump(Lump.Brushes, 12);
    reader.seek(brushes.at);
    for (let i = 0; i < brushes.count; i++) {
      const firstSide = reader.i32();
      const sideCount = reader.i32();
      const shader = reader.i32();
      this.brushes.push({
        firstSide,
        sideCount,
        shader,
        contents: this.shaders[shader]?.contents ?? 0,
      });
    }

    const brushSides = lump(Lump.BrushSides, 8);
    reader.seek(brushSides.at);
    for (let i = 0; i < brushSides.count; i++) {
      this.brushSides.push({ plane: reader.i32(), shader: reader.i32() });
    }

    const vertices = lump(Lump.Vertices, 44);
    reader.seek(vertices.at);
    this.vertices = {
      count: vertices.count,
      positions: new Float32Array(vertices.count * 3),
      texCoords: new Float32Array(vertices.count * 2),
      lightCoords: new Float32Array(vertices.count * 2),
      normals: new Float32Array(vertices.count * 3),
      colors: new Uint8Array(vertices.count * 4),
    };
    for (let i = 0; i < vertices.count; i++) {
      this.vertices.positions[i * 3] = reader.f32();
      this.vertices.positions[i * 3 + 1] = reader.f32();
      this.vertices.positions[i * 3 + 2] = reader.f32();
      this.vertices.texCoords[i * 2] = reader.f32();
      this.vertices.texCoords[i * 2 + 1] = reader.f32();
      this.vertices.lightCoords[i * 2] = reader.f32();
      this.vertices.lightCoords[i * 2 + 1] = reader.f32();
      this.vertices.normals[i * 3] = reader.f32();
      this.vertices.normals[i * 3 + 1] = reader.f32();
      this.vertices.normals[i * 3 + 2] = reader.f32();
      this.vertices.colors[i * 4] = reader.u8();
      this.vertices.colors[i * 4 + 1] = reader.u8();
      this.vertices.colors[i * 4 + 2] = reader.u8();
      this.vertices.colors[i * 4 + 3] = reader.u8();
    }

    this.meshVerts = readInt32Lump(reader, directory[Lump.MeshVerts]);

    const effects = lump(Lump.Effects, 72);
    reader.seek(effects.at);
    for (let i = 0; i < effects.count; i++) {
      const name = reader.fixedString(64).toLowerCase();
      const brush = reader.i32();
      reader.skip(4);
      this.effects.push({ name, brush });
    }

    const faces = lump(Lump.Faces, 104);
    reader.seek(faces.at);
    for (let i = 0; i < faces.count; i++) {
      this.faces.push({
        shader: reader.i32(),
        effect: reader.i32(),
        type: reader.i32(),
        firstVertex: reader.i32(),
        vertexCount: reader.i32(),
        firstMeshVert: reader.i32(),
        meshVertCount: reader.i32(),
        lightmap: reader.i32(),
        lightmapStart: [reader.i32(), reader.i32()],
        lightmapSize: [reader.i32(), reader.i32()],
        lightmapOrigin: reader.vec3(),
        lightmapVecs: [reader.vec3(), reader.vec3()],
        normal: reader.vec3(),
        patchSize: [reader.i32(), reader.i32()],
      });
    }

    const lightmapBytes = LIGHTMAP_SIZE * LIGHTMAP_SIZE * 3;
    const lightmaps = lump(Lump.Lightmaps, lightmapBytes);
    for (let i = 0; i < lightmaps.count; i++) {
      this.lightmaps.push(reader.slice(lightmaps.at + i * lightmapBytes, lightmapBytes));
    }

    this.lightVolumes = this.readLightVolumes(reader, directory[Lump.LightVols]);

    const visibility = directory[Lump.Visibility];
    if (visibility.length > 8) {
      reader.seek(visibility.offset);
      this.clusterCount = reader.i32();
      this.clusterBytes = reader.i32();
      this.visibility = reader.slice(reader.offset, this.clusterCount * this.clusterBytes);
    } else {
      this.clusterCount = 0;
      this.clusterBytes = 0;
      this.visibility = null;
    }
  }

  /**
   * Grille d'eclairage : ses dimensions ne sont pas stockees, elles se
   * deduisent des bornes du modele 0 et d'un pas fixe de 64 x 64 x 128.
   */
  private readLightVolumes(
    reader: BinaryReader,
    entry: { offset: number; length: number },
  ): BspLightVolumes | null {
    if (entry.length < 8 || this.models.length === 0) return null;
    const world = this.models[0];
    const step: Vec3 = [64, 64, 128];
    const mins: Vec3 = [0, 0, 0];
    const counts: [number, number, number] = [0, 0, 0];
    for (let axis = 0; axis < 3; axis++) {
      mins[axis] = step[axis] * Math.ceil(world.mins[axis] / step[axis]);
      const maxs = step[axis] * Math.floor(world.maxs[axis] / step[axis]);
      counts[axis] = Math.floor((maxs - mins[axis]) / step[axis]) + 1;
    }
    const total = counts[0] * counts[1] * counts[2];
    if (total <= 0 || total * 8 > entry.length) return null;

    const ambient = new Uint8Array(total * 3);
    const directional = new Uint8Array(total * 3);
    const direction = new Uint8Array(total * 2);
    reader.seek(entry.offset);
    for (let i = 0; i < total; i++) {
      ambient[i * 3] = reader.u8();
      ambient[i * 3 + 1] = reader.u8();
      ambient[i * 3 + 2] = reader.u8();
      directional[i * 3] = reader.u8();
      directional[i * 3 + 1] = reader.u8();
      directional[i * 3 + 2] = reader.u8();
      direction[i * 2] = reader.u8();
      direction[i * 2 + 1] = reader.u8();
    }
    return { counts, mins, ambient, directional, direction };
  }

  /** Feuille contenant un point, par descente dans l'arbre. */
  findLeaf(point: Vec3, model = 0): number {
    if (model !== 0 || this.nodes.length === 0) return -1;
    let index = 0;
    while (index >= 0) {
      const node = this.nodes[index];
      const plane = this.planes[node.plane];
      const distance =
        point[0] * plane.normal[0] + point[1] * plane.normal[1] + point[2] * plane.normal[2] - plane.dist;
      index = distance >= 0 ? node.children[0] : node.children[1];
    }
    return -(index + 1);
  }

  /** Un cluster en voit-il un autre ? Sans donnees de visibilite, tout est visible. */
  clusterVisible(from: number, to: number): boolean {
    if (!this.visibility || from < 0 || to < 0) return true;
    const index = from * this.clusterBytes + (to >> 3);
    if (index < 0 || index >= this.visibility.byteLength) return true;
    return (this.visibility[index] & (1 << (to & 7))) !== 0;
  }

  entitiesOfClass(classname: string): BspEntity[] {
    return this.entities.filter((entity) => entity.classname === classname);
  }
}

function readInt32Lump(reader: BinaryReader, entry: { offset: number; length: number }): Int32Array {
  const count = Math.floor(entry.length / 4);
  const out = new Int32Array(count);
  reader.seek(entry.offset);
  for (let i = 0; i < count; i++) out[i] = reader.i32();
  return out;
}

/** Bloc d'entites : une suite de { "cle" "valeur" ... }. */
export function parseEntities(text: string): BspEntity[] {
  const entities: BspEntity[] = [];
  const pattern = /"([^"]*)"\s+"([^"]*)"/g;
  let depth = 0;
  let current: Record<string, string> | null = null;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '{') {
      depth++;
      if (depth === 1) current = {};
      continue;
    }
    if (char === '}') {
      if (depth === 1 && current) {
        entities.push({ classname: '', ...current } as BspEntity);
        current = null;
      }
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === '"' && current) {
      const end = text.indexOf('}', i);
      const block = text.slice(i, end < 0 ? text.length : end);
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(block))) current[match[1].toLowerCase()] = match[2];
      i = end < 0 ? text.length : end - 1;
    }
  }
  return entities;
}

/** Position d'une entite, ecrite "x y z" dans le bloc texte. */
export function entityVector(entity: BspEntity, key: string, fallback: Vec3 = [0, 0, 0]): Vec3 {
  const raw = entity[key];
  if (!raw) return [...fallback] as Vec3;
  const parts = raw.trim().split(/\s+/).map(Number);
  if (parts.length < 3 || parts.some((value) => !Number.isFinite(value))) return [...fallback] as Vec3;
  return [parts[0], parts[1], parts[2]];
}

export function entityNumber(entity: BspEntity, key: string, fallback = 0): number {
  const value = Number(entity[key]);
  return Number.isFinite(value) ? value : fallback;
}
