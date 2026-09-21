import { Surface, type BspFace, type BspVertices, type Vec3 } from '../formats/bsp';
import { tessellatePatch } from './Bezier';
import type { CollisionBrush, CollisionPlane } from '../game/collision';

/**
 * Collision des surfaces courbes. Une surface courbe n'est pas un volume : elle
 * est decoupee en petites facettes convexes, chacune formee du plan de la
 * facette, d'un plan de fond a faible distance, et d'un plan par bord qui la
 * ferme lateralement. Ces facettes se testent alors exactement comme les
 * volumes ordinaires de la carte.
 *
 * La decoupe utilisee pour la collision est plus grossiere que celle du rendu :
 * l'ecart est de l'ordre de l'unite, invisible au jeu, et divise par plusieurs
 * le nombre de facettes a parcourir.
 */

/** Epaisseur donnee aux facettes. Le trajet teste etant continu, une faible
 *  valeur suffit : elle evite seulement les cas degeneres. */
const FACET_THICKNESS = 4;
/** Ecart en dessous duquel quatre points sont traites comme coplanaires. */
const COPLANAR_EPSILON = 0.5;
const AREA_EPSILON = 0.05;
/**
 * Segments par carreau pour la collision. Six suffisent : l'ecart avec la
 * surface affichee reste sous l'unite, et une carte chargee tourne autour de
 * dix mille facettes, ce qui ne pese pas sur le trajet teste.
 */
export const PATCH_COLLISION_SUBDIVISIONS = 6;

export interface PatchCollide {
  facets: CollisionBrush[];
  mins: Vec3;
  maxs: Vec3;
}

/**
 * Construit la collision d'une surface courbe, ou rien quand la surface ne
 * doit pas arreter les joueurs.
 */
export function buildPatchCollide(
  face: BspFace,
  vertices: BspVertices,
  contents: number,
  surfaceFlags: number,
  subdivisions = PATCH_COLLISION_SUBDIVISIONS,
): PatchCollide | null {
  if (face.patchSize[0] < 3 || face.patchSize[1] < 3) return null;
  if ((surfaceFlags & Surface.NONSOLID) !== 0) return null;

  const patch = tessellatePatch(face, vertices, subdivisions);
  const pointCount = patch.positions.length / 3;
  if (pointCount === 0) return null;

  // La decoupe rend une grille par bloc de controle ; les blocs se suivent.
  const step = subdivisions + 1;
  const blocksX = (face.patchSize[0] - 1) / 2;
  const blocksY = (face.patchSize[1] - 1) / 2;
  const facets: CollisionBrush[] = [];

  const mins: Vec3 = [Infinity, Infinity, Infinity];
  const maxs: Vec3 = [-Infinity, -Infinity, -Infinity];

  for (let block = 0; block < blocksX * blocksY; block++) {
    const base = block * step * step;
    if (base + step * step > pointCount) break;

    for (let i = 0; i < subdivisions; i++) {
      for (let j = 0; j < subdivisions; j++) {
        const a = base + i * step + j;
        const b = base + (i + 1) * step + j;
        const c = a + 1;
        const d = b + 1;

        const pa = pointAt(patch.positions, a);
        const pb = pointAt(patch.positions, b);
        const pc = pointAt(patch.positions, c);
        const pd = pointAt(patch.positions, d);
        const reference = pointAt(patch.normals, a);

        // Un quadrilatere plat fait une seule facette ; sinon on le coupe.
        if (coplanar(pa, pb, pd, pc)) {
          const facet = makeFacet([pa, pb, pd, pc], reference, contents, surfaceFlags);
          if (facet) facets.push(facet);
        } else {
          const first = makeFacet([pa, pb, pc], reference, contents, surfaceFlags);
          if (first) facets.push(first);
          const second = makeFacet([pc, pb, pd], pointAt(patch.normals, d), contents, surfaceFlags);
          if (second) facets.push(second);
        }
      }
    }
  }

  if (facets.length === 0) return null;
  for (const facet of facets) {
    for (let axis = 0; axis < 3; axis++) {
      mins[axis] = Math.min(mins[axis], facet.mins[axis]);
      maxs[axis] = Math.max(maxs[axis], facet.maxs[axis]);
    }
  }
  return { facets, mins, maxs };
}

function pointAt(array: Float32Array, index: number): Vec3 {
  return [array[index * 3], array[index * 3 + 1], array[index * 3 + 2]];
}

const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function normalize(v: Vec3): number {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (length < 1e-8) return 0;
  v[0] /= length;
  v[1] /= length;
  v[2] /= length;
  return length;
}

/** Les quatre points tiennent-ils dans un meme plan ? */
function coplanar(a: Vec3, b: Vec3, c: Vec3, d: Vec3): boolean {
  const normal = cross(subtract(b, a), subtract(c, a));
  if (normalize(normal) === 0) return false;
  const distance = dot(normal, a);
  return Math.abs(dot(normal, d) - distance) <= COPLANAR_EPSILON;
}

/**
 * Facette convexe d'apres ses sommets, pris dans l'ordre du contour. La normale
 * de reference vient de la surface : elle donne le bon cote.
 */
function makeFacet(
  points: Vec3[],
  reference: Vec3,
  contents: number,
  surfaceFlags: number,
): CollisionBrush | null {
  const normal = cross(subtract(points[1], points[0]), subtract(points[2], points[0]));
  const area = normalize(normal);
  if (area < AREA_EPSILON) return null;

  // La facette doit regarder du meme cote que la surface d'origine.
  if (dot(normal, reference) < 0) {
    normal[0] = -normal[0];
    normal[1] = -normal[1];
    normal[2] = -normal[2];
    points = [...points].reverse();
  }

  const distance = dot(normal, points[0]);
  const sides: CollisionPlane[] = [
    { normal: [...normal] as Vec3, dist: distance, surfaceFlags },
    // Plan de fond : la facette devient un volume mince, donc ferme.
    {
      normal: [-normal[0], -normal[1], -normal[2]],
      dist: -(distance - FACET_THICKNESS),
      surfaceFlags,
    },
  ];

  // Un plan par bord, perpendiculaire a la facette et tourne vers l'exterieur.
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    const edge = subtract(next, current);
    const border = cross(edge, normal);
    if (normalize(border) === 0) continue;

    const borderDistance = dot(border, current);
    // Verification du sens : les autres sommets doivent rester du bon cote.
    let outside = false;
    for (const point of points) {
      if (dot(border, point) - borderDistance > 0.01) {
        outside = true;
        break;
      }
    }
    if (outside) {
      sides.push({
        normal: [-border[0], -border[1], -border[2]],
        dist: -borderDistance,
        surfaceFlags,
      });
    } else {
      sides.push({ normal: border, dist: borderDistance, surfaceFlags });
    }
  }

  const mins: Vec3 = [Infinity, Infinity, Infinity];
  const maxs: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const point of points) {
    for (let axis = 0; axis < 3; axis++) {
      mins[axis] = Math.min(mins[axis], point[axis]);
      maxs[axis] = Math.max(maxs[axis], point[axis]);
    }
  }
  // Les bornes tiennent compte de l'epaisseur donnee vers l'arriere.
  for (let axis = 0; axis < 3; axis++) {
    mins[axis] -= FACET_THICKNESS;
    maxs[axis] += FACET_THICKNESS;
  }

  return { sides, contents, mins, maxs };
}
