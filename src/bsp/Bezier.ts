import type { BspFace, BspVertices } from '../formats/bsp';

/**
 * Surfaces courbes. Une face de type patch decrit une grille de points de
 * controle ; chaque bloc de trois par trois definit un carreau quadratique que
 * l'on decoupe en petits triangles. Le niveau de decoupe fixe la finesse du
 * resultat : c'est la que se gagne l'aspect lisse des arches et des tunnels.
 */

export interface TessellatedPatch {
  positions: Float32Array;
  normals: Float32Array;
  texCoords: Float32Array;
  lightCoords: Float32Array;
  colors: Uint8Array;
  indices: number[];
}

interface ControlPoint {
  position: [number, number, number];
  texCoord: [number, number];
  lightCoord: [number, number];
  normal: [number, number, number];
  color: [number, number, number, number];
}

function controlPoint(vertices: BspVertices, index: number): ControlPoint {
  return {
    position: [
      vertices.positions[index * 3],
      vertices.positions[index * 3 + 1],
      vertices.positions[index * 3 + 2],
    ],
    texCoord: [vertices.texCoords[index * 2], vertices.texCoords[index * 2 + 1]],
    lightCoord: [vertices.lightCoords[index * 2], vertices.lightCoords[index * 2 + 1]],
    normal: [
      vertices.normals[index * 3],
      vertices.normals[index * 3 + 1],
      vertices.normals[index * 3 + 2],
    ],
    color: [
      vertices.colors[index * 4],
      vertices.colors[index * 4 + 1],
      vertices.colors[index * 4 + 2],
      vertices.colors[index * 4 + 3],
    ],
  };
}

/** Courbe quadratique passant par les points extremes, tiree vers celui du milieu. */
function quadratic(a: number, b: number, c: number, t: number): number {
  const inverse = 1 - t;
  return inverse * inverse * a + 2 * inverse * t * b + t * t * c;
}

function interpolate(a: ControlPoint, b: ControlPoint, c: ControlPoint, t: number): ControlPoint {
  const mix = (index: number, key: 'position' | 'normal') => quadratic(a[key][index], b[key][index], c[key][index], t);
  const mix2 = (index: number, key: 'texCoord' | 'lightCoord') =>
    quadratic(a[key][index], b[key][index], c[key][index], t);
  const mixColor = (index: number) => Math.round(quadratic(a.color[index], b.color[index], c.color[index], t));
  return {
    position: [mix(0, 'position'), mix(1, 'position'), mix(2, 'position')],
    texCoord: [mix2(0, 'texCoord'), mix2(1, 'texCoord')],
    lightCoord: [mix2(0, 'lightCoord'), mix2(1, 'lightCoord')],
    normal: [mix(0, 'normal'), mix(1, 'normal'), mix(2, 'normal')],
    color: [mixColor(0), mixColor(1), mixColor(2), mixColor(3)],
  };
}

/**
 * Decoupe une face courbe. Le niveau vaut le nombre de segments par carreau :
 * plus il monte, plus la surface est fine, au prix de triangles supplementaires.
 */
export function tessellatePatch(face: BspFace, vertices: BspVertices, level = 8): TessellatedPatch {
  const width = face.patchSize[0];
  const height = face.patchSize[1];
  const blocksX = (width - 1) / 2;
  const blocksY = (height - 1) / 2;

  const positions: number[] = [];
  const normals: number[] = [];
  const texCoords: number[] = [];
  const lightCoords: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const step = level + 1;
  for (let blockY = 0; blockY < blocksY; blockY++) {
    for (let blockX = 0; blockX < blocksX; blockX++) {
      const base = positions.length / 3;

      // Les trois courbes du carreau sont d'abord echantillonnees en colonnes.
      for (let i = 0; i <= level; i++) {
        const u = i / level;
        const columns: ControlPoint[] = [];
        for (let row = 0; row < 3; row++) {
          const index = (blockY * 2 + row) * width + blockX * 2;
          const a = controlPoint(vertices, face.firstVertex + index);
          const b = controlPoint(vertices, face.firstVertex + index + 1);
          const c = controlPoint(vertices, face.firstVertex + index + 2);
          columns.push(interpolate(a, b, c, u));
        }
        for (let j = 0; j <= level; j++) {
          const v = j / level;
          const point = interpolate(columns[0], columns[1], columns[2], v);
          const length = Math.hypot(point.normal[0], point.normal[1], point.normal[2]) || 1;
          positions.push(point.position[0], point.position[1], point.position[2]);
          normals.push(point.normal[0] / length, point.normal[1] / length, point.normal[2] / length);
          texCoords.push(point.texCoord[0], point.texCoord[1]);
          lightCoords.push(point.lightCoord[0], point.lightCoord[1]);
          colors.push(point.color[0], point.color[1], point.color[2], point.color[3]);
        }
      }

      for (let i = 0; i < level; i++) {
        for (let j = 0; j < level; j++) {
          const a = base + i * step + j;
          const b = base + (i + 1) * step + j;
          indices.push(a, b, a + 1, a + 1, b, b + 1);
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    texCoords: new Float32Array(texCoords),
    lightCoords: new Float32Array(lightCoords),
    colors: new Uint8Array(colors),
    indices,
  };
}
