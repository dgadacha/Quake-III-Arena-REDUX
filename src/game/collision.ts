import { BspMap, Contents, FaceType, MASK_SOLID, type Vec3 } from '../formats/bsp';
import {
  PATCH_COLLISION_SUBDIVISIONS,
  buildPatchCollide,
  type PatchCollide,
} from '../bsp/PatchCollide';

/**
 * Collision par volumes convexes. Une carte decrit ses murs par des brushes,
 * c'est-a-dire des intersections de demi-espaces ; l'arene generee par le code
 * fabrique les siens de la meme facon, si bien qu'un seul moteur suffit.
 */

const EPSILON = 0.03125;

export interface CollisionPlane {
  normal: Vec3;
  dist: number;
  surfaceFlags: number;
}

export interface CollisionBrush {
  sides: CollisionPlane[];
  contents: number;
  mins: Vec3;
  maxs: Vec3;
}

/**
 * Partie mobile de la carte : ses volumes restent decrits a leur position
 * d'origine, et c'est le trajet teste qui est ramene dans leur repere.
 */
export interface MoverVolume {
  /** Indices de ses volumes dans la liste generale. */
  brushes: number[];
  offset: Vec3;
  mins: Vec3;
  maxs: Vec3;
}

export interface TraceResult {
  /** Part du trajet effectivement parcourue, de 0 a 1. */
  fraction: number;
  endPosition: Vec3;
  normal: Vec3;
  /** Vrai si le point de depart etait deja dans un volume solide. */
  startSolid: boolean;
  allSolid: boolean;
  surfaceFlags: number;
  contents: number;
}

export const PLAYER_MINS: Vec3 = [-15, -15, -24];
export const PLAYER_MAXS: Vec3 = [15, 15, 32];
export const PLAYER_CROUCH_MAXS: Vec3 = [15, 15, 16];
export const VIEW_HEIGHT = 26;
export const CROUCH_VIEW_HEIGHT = 12;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Bornes d'un brush, deduites de ses plans axiaux quand elles manquent. */
function brushBounds(sides: CollisionPlane[]): { mins: Vec3; maxs: Vec3 } {
  const mins: Vec3 = [-Infinity, -Infinity, -Infinity];
  const maxs: Vec3 = [Infinity, Infinity, Infinity];
  for (const side of sides) {
    for (let axis = 0; axis < 3; axis++) {
      if (side.normal[axis] > 0.99) maxs[axis] = Math.min(maxs[axis], side.dist);
      else if (side.normal[axis] < -0.99) mins[axis] = Math.max(mins[axis], -side.dist);
    }
  }
  for (let axis = 0; axis < 3; axis++) {
    if (!Number.isFinite(mins[axis])) mins[axis] = -65536;
    if (!Number.isFinite(maxs[axis])) maxs[axis] = 65536;
  }
  return { mins, maxs };
}

export function makeBrush(sides: CollisionPlane[], contents: number): CollisionBrush {
  const { mins, maxs } = brushBounds(sides);
  return { sides, contents, mins, maxs };
}

/** Boite alignee sur les axes, forme la plus courante dans une arene. */
export function boxBrush(
  mins: Vec3,
  maxs: Vec3,
  contents: number = Contents.SOLID,
  surfaceFlags = 0,
): CollisionBrush {
  const sides: CollisionPlane[] = [
    { normal: [1, 0, 0], dist: maxs[0], surfaceFlags },
    { normal: [-1, 0, 0], dist: -mins[0], surfaceFlags },
    { normal: [0, 1, 0], dist: maxs[1], surfaceFlags },
    { normal: [0, -1, 0], dist: -mins[1], surfaceFlags },
    { normal: [0, 0, 1], dist: maxs[2], surfaceFlags },
    { normal: [0, 0, -1], dist: -mins[2], surfaceFlags },
  ];
  return { sides, contents, mins: [...mins] as Vec3, maxs: [...maxs] as Vec3 };
}

interface TraceWork {
  start: Vec3;
  end: Vec3;
  /** Boite rendue symetrique : le trajet porte le decalage. */
  extents: Vec3;
  offset: Vec3;
  mask: number;
  bounds: { mins: Vec3; maxs: Vec3 };
  result: TraceResult;
}

export class CollisionWorld {
  readonly brushes: CollisionBrush[];
  /** Portes, plateformes et panneaux : ils ne sont pas dans l'arbre. */
  private movers: MoverVolume[] = [];
  private readonly map: BspMap | null;
  /** Surfaces courbes solides, rangees par indice de face. */
  private readonly patches = new Map<number, PatchCollide>();
  /** Marqueur par brush : evite de tester deux fois le meme dans l'arbre. */
  private readonly visited: Int32Array;
  /** Meme principe pour les surfaces courbes, partagees entre feuilles. */
  private readonly visitedFaces: Int32Array;
  private pass = 0;

  constructor(brushes: CollisionBrush[], map: BspMap | null = null) {
    this.brushes = brushes;
    this.map = map;
    this.visited = new Int32Array(brushes.length);
    this.visitedFaces = new Int32Array(map?.faces.length ?? 0);
  }

  get patchCount(): number {
    return this.patches.size;
  }

  get patchFacetCount(): number {
    let total = 0;
    for (const patch of this.patches.values()) total += patch.facets.length;
    return total;
  }

  /**
   * Prepare la collision des surfaces courbes de la carte. Elles ne sont pas
   * des volumes : sans cette etape, on traverse les rampes et les tubes courbes
   * qui n'ont pas de volume d'arret autour.
   */
  buildPatches(subdivisions = PATCH_COLLISION_SUBDIVISIONS): void {
    if (!this.map) return;
    const map = this.map;
    for (let index = 0; index < map.faces.length; index++) {
      const face = map.faces[index];
      if (face.type !== FaceType.PATCH) continue;
      const shader = map.shaders[face.shader];
      if (!shader) continue;
      // Seules les surfaces declarees solides arretent le joueur.
      if ((shader.contents & MASK_SOLID) === 0) continue;

      const collide = buildPatchCollide(
        face,
        map.vertices,
        shader.contents,
        shader.surfaceFlags,
        subdivisions,
      );
      if (collide) this.patches.set(index, collide);
    }
  }

  /** Declare les parties mobiles, dont la position change en cours de partie. */
  setMovers(movers: MoverVolume[]): void {
    this.movers = movers;
  }

  /** Construit le monde de collision a partir des volumes de la carte. */
  static fromMap(map: BspMap, patchSubdivisions = PATCH_COLLISION_SUBDIVISIONS): CollisionWorld {
    const brushes: CollisionBrush[] = map.brushes.map((brush) => {
      const sides: CollisionPlane[] = [];
      for (let i = 0; i < brush.sideCount; i++) {
        const side = map.brushSides[brush.firstSide + i];
        if (!side) continue;
        const plane = map.planes[side.plane];
        if (!plane) continue;
        sides.push({
          normal: [...plane.normal] as Vec3,
          dist: plane.dist,
          surfaceFlags: map.shaders[side.shader]?.surfaceFlags ?? 0,
        });
      }
      return makeBrush(sides, brush.contents);
    });
    const world = new CollisionWorld(brushes, map);
    world.buildPatches(patchSubdivisions);
    return world;
  }

  trace(start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3, mask = MASK_SOLID): TraceResult {
    const result: TraceResult = {
      fraction: 1,
      endPosition: [...end] as Vec3,
      normal: [0, 0, 0],
      startSolid: false,
      allSolid: false,
      surfaceFlags: 0,
      contents: 0,
    };

    // Boite symetrique : le centre absorbe le decalage vertical du joueur.
    const offset: Vec3 = [
      (mins[0] + maxs[0]) * 0.5,
      (mins[1] + maxs[1]) * 0.5,
      (mins[2] + maxs[2]) * 0.5,
    ];
    const extents: Vec3 = [maxs[0] - offset[0], maxs[1] - offset[1], maxs[2] - offset[2]];
    const work: TraceWork = {
      start: [start[0] + offset[0], start[1] + offset[1], start[2] + offset[2]],
      end: [end[0] + offset[0], end[1] + offset[1], end[2] + offset[2]],
      extents,
      offset,
      mask,
      bounds: sweptBounds(
        [start[0] + offset[0], start[1] + offset[1], start[2] + offset[2]],
        [end[0] + offset[0], end[1] + offset[1], end[2] + offset[2]],
        extents,
      ),
      result,
    };

    this.pass++;
    if (this.map && this.map.nodes.length > 0) {
      this.traceNode(work, 0, 0, 1, work.start, work.end);
    } else {
      for (let i = 0; i < this.brushes.length; i++) this.traceBrush(work, i);
    }
    this.traceMovers(work);

    if (result.fraction === 1) {
      result.endPosition = [...end] as Vec3;
    } else {
      result.fraction = Math.max(0, result.fraction);
      result.endPosition = [
        start[0] + (end[0] - start[0]) * result.fraction,
        start[1] + (end[1] - start[1]) * result.fraction,
        start[2] + (end[2] - start[2]) * result.fraction,
      ];
    }
    return result;
  }

  /**
   * Parties mobiles : le trajet est decale de leur deplacement, ce qui revient
   * a les tester la ou elles se trouvent vraiment. Une translation ne change
   * pas l'orientation des plans, la normale touchee reste donc valable.
   */
  private traceMovers(work: TraceWork): void {
    for (const mover of this.movers) {
      if (mover.brushes.length === 0) continue;
      // Bornes du mover a sa position courante, comparees au trajet.
      if (
        work.bounds.mins[0] > mover.maxs[0] + mover.offset[0] + work.extents[0] ||
        work.bounds.maxs[0] < mover.mins[0] + mover.offset[0] - work.extents[0] ||
        work.bounds.mins[1] > mover.maxs[1] + mover.offset[1] + work.extents[1] ||
        work.bounds.maxs[1] < mover.mins[1] + mover.offset[1] - work.extents[1] ||
        work.bounds.mins[2] > mover.maxs[2] + mover.offset[2] + work.extents[2] ||
        work.bounds.maxs[2] < mover.mins[2] + mover.offset[2] - work.extents[2]
      ) {
        continue;
      }

      const shifted: TraceWork = {
        ...work,
        start: [
          work.start[0] - mover.offset[0],
          work.start[1] - mover.offset[1],
          work.start[2] - mover.offset[2],
        ],
        end: [
          work.end[0] - mover.offset[0],
          work.end[1] - mover.offset[1],
          work.end[2] - mover.offset[2],
        ],
        bounds: { mins: [0, 0, 0], maxs: [0, 0, 0] },
      };
      shifted.bounds = sweptBounds(shifted.start, shifted.end, work.extents);
      for (const index of mover.brushes) this.traceBrush(shifted, index);
    }
  }

  /** Descente dans l'arbre : seules les feuilles traversees sont examinees. */
  private traceNode(work: TraceWork, node: number, startFrac: number, endFrac: number, p1: Vec3, p2: Vec3): void {
    if (work.result.fraction <= startFrac) return;

    if (node < 0) {
      const leaf = this.map!.leafs[-(node + 1)];
      if (!leaf) return;
      for (let i = 0; i < leaf.leafBrushCount; i++) {
        this.traceBrush(work, this.map!.leafBrushes[leaf.firstLeafBrush + i]);
      }
      if (this.patches.size > 0) {
        for (let i = 0; i < leaf.leafFaceCount; i++) {
          this.tracePatch(work, this.map!.leafFaces[leaf.firstLeafFace + i]);
        }
      }
      return;
    }

    const bspNode = this.map!.nodes[node];
    const plane = this.map!.planes[bspNode.plane];
    const t1 = dot(p1, plane.normal) - plane.dist;
    const t2 = dot(p2, plane.normal) - plane.dist;
    // La boite elargit le plan de la moitie de sa diagonale projetee.
    const offset =
      Math.abs(work.extents[0] * plane.normal[0]) +
      Math.abs(work.extents[1] * plane.normal[1]) +
      Math.abs(work.extents[2] * plane.normal[2]);

    if (t1 >= offset && t2 >= offset) {
      this.traceNode(work, bspNode.children[0], startFrac, endFrac, p1, p2);
      return;
    }
    if (t1 < -offset && t2 < -offset) {
      this.traceNode(work, bspNode.children[1], startFrac, endFrac, p1, p2);
      return;
    }

    // Le trajet coupe le plan : on le decoupe en deux, avec un peu de marge.
    let side: 0 | 1;
    let fracEnter: number;
    let fracLeave: number;
    if (t1 < t2) {
      const inverse = 1 / (t1 - t2);
      side = 1;
      fracEnter = (t1 - offset + EPSILON) * inverse;
      fracLeave = (t1 + offset + EPSILON) * inverse;
    } else if (t1 > t2) {
      const inverse = 1 / (t1 - t2);
      side = 0;
      fracEnter = (t1 + offset + EPSILON) * inverse;
      fracLeave = (t1 - offset - EPSILON) * inverse;
    } else {
      side = 0;
      fracEnter = 1;
      fracLeave = 0;
    }

    fracEnter = clamp01(fracEnter);
    fracLeave = clamp01(fracLeave);

    const near = bspNode.children[side];
    const far = bspNode.children[side ^ 1];
    const midEnter = startFrac + (endFrac - startFrac) * fracEnter;
    this.traceNode(work, near, startFrac, midEnter, p1, lerp(p1, p2, fracEnter));
    const midLeave = startFrac + (endFrac - startFrac) * fracLeave;
    this.traceNode(work, far, midLeave, endFrac, lerp(p1, p2, fracLeave), p2);
  }

  /** Surface courbe d'une feuille : chacune de ses facettes est un volume. */
  private tracePatch(work: TraceWork, faceIndex: number): void {
    if (faceIndex < 0 || faceIndex >= this.visitedFaces.length) return;
    if (this.visitedFaces[faceIndex] === this.pass) return;
    this.visitedFaces[faceIndex] = this.pass;

    const patch = this.patches.get(faceIndex);
    if (!patch) return;
    // Bornes de la surface entiere : la plupart sont ecartees d'un coup.
    for (let axis = 0; axis < 3; axis++) {
      if (work.bounds.mins[axis] > patch.maxs[axis] + work.extents[axis]) return;
      if (work.bounds.maxs[axis] < patch.mins[axis] - work.extents[axis]) return;
    }
    for (const facet of patch.facets) this.traceVolume(work, facet);
  }

  /** Trajet contre un volume convexe : on cherche l'entree la plus tardive. */
  private traceBrush(work: TraceWork, index: number): void {
    if (index < 0 || index >= this.brushes.length) return;
    if (this.visited[index] === this.pass) return;
    this.visited[index] = this.pass;
    this.traceVolume(work, this.brushes[index]);
  }

  private traceVolume(work: TraceWork, brush: CollisionBrush): void {
    if (brush.sides.length === 0) return;
    if ((brush.contents & work.mask) === 0) return;
    if (!boundsOverlap(work.bounds, brush, work.extents)) return;

    let enterFrac = -1;
    let leaveFrac = 1;
    let startsOutside = false;
    let endsOutside = false;
    let clipPlane: CollisionPlane | null = null;

    for (const side of brush.sides) {
      // Plan repousse vers l'exterieur du coin de la boite qui le touche.
      const offset =
        Math.abs(work.extents[0] * side.normal[0]) +
        Math.abs(work.extents[1] * side.normal[1]) +
        Math.abs(work.extents[2] * side.normal[2]);
      const dist = side.dist + offset;
      const d1 = dot(work.start, side.normal) - dist;
      const d2 = dot(work.end, side.normal) - dist;

      if (d2 > 0) endsOutside = true;
      if (d1 > 0) startsOutside = true;
      // Le trajet reste du bon cote d'un plan : il ne touche pas ce volume.
      if (d1 > 0 && (d2 >= EPSILON || d2 >= d1)) return;
      if (d1 <= 0 && d2 <= 0) continue;

      if (d1 > d2) {
        const fraction = (d1 - EPSILON) / (d1 - d2);
        if (fraction > enterFrac) {
          enterFrac = fraction;
          clipPlane = side;
        }
      } else {
        const fraction = (d1 + EPSILON) / (d1 - d2);
        if (fraction < leaveFrac) leaveFrac = fraction;
      }
    }

    if (!startsOutside) {
      work.result.startSolid = true;
      work.result.contents |= brush.contents;
      if (!endsOutside) {
        work.result.allSolid = true;
        work.result.fraction = 0;
        work.result.normal = [0, 0, 1];
      }
      return;
    }

    if (enterFrac < leaveFrac && enterFrac > -1 && enterFrac < work.result.fraction && clipPlane) {
      work.result.fraction = Math.max(enterFrac, 0);
      work.result.normal = [...clipPlane.normal] as Vec3;
      work.result.surfaceFlags = clipPlane.surfaceFlags;
      work.result.contents = brush.contents;
    }
  }

  /** Nature du volume a un point : eau, lave, vide. */
  pointContents(point: Vec3): number {
    let contents = this.movers.length > 0 ? this.moverContents(point) : 0;
    if (this.map && this.map.nodes.length > 0) {
      const leafIndex = this.map.findLeaf(point);
      const leaf = this.map.leafs[leafIndex];
      if (!leaf) return contents;
      for (let i = 0; i < leaf.leafBrushCount; i++) {
        const brush = this.brushes[this.map.leafBrushes[leaf.firstLeafBrush + i]];
        if (brush && pointInBrush(point, brush)) contents |= brush.contents;
      }
      return contents;
    }
    for (const brush of this.brushes) {
      if (pointInBrush(point, brush)) contents |= brush.contents;
    }
    return contents;
  }

  /** Nature des volumes mobiles a un point : eau montante, plateforme. */
  moverContents(point: Vec3): number {
    let contents = 0;
    for (const mover of this.movers) {
      const local: Vec3 = [
        point[0] - mover.offset[0],
        point[1] - mover.offset[1],
        point[2] - mover.offset[2],
      ];
      for (const index of mover.brushes) {
        const brush = this.brushes[index];
        if (brush && pointInBrush(local, brush)) contents |= brush.contents;
      }
    }
    return contents;
  }
}

export function pointInsideBrush(point: Vec3, brush: CollisionBrush): boolean {
  return pointInBrush(point, brush);
}

function pointInBrush(point: Vec3, brush: CollisionBrush): boolean {
  for (const side of brush.sides) {
    if (dot(point, side.normal) - side.dist > 0) return false;
  }
  return brush.sides.length > 0;
}

function sweptBounds(start: Vec3, end: Vec3, extents: Vec3): { mins: Vec3; maxs: Vec3 } {
  const mins: Vec3 = [0, 0, 0];
  const maxs: Vec3 = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    mins[axis] = Math.min(start[axis], end[axis]) - extents[axis] - 1;
    maxs[axis] = Math.max(start[axis], end[axis]) + extents[axis] + 1;
  }
  return { mins, maxs };
}

function boundsOverlap(bounds: { mins: Vec3; maxs: Vec3 }, brush: CollisionBrush, extents: Vec3): boolean {
  for (let axis = 0; axis < 3; axis++) {
    if (bounds.mins[axis] > brush.maxs[axis] + extents[axis]) return false;
    if (bounds.maxs[axis] < brush.mins[axis] - extents[axis]) return false;
  }
  return true;
}

function lerp(a: Vec3, b: Vec3, fraction: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * fraction,
    a[1] + (b[1] - a[1]) * fraction,
    a[2] + (b[2] - a[2]) * fraction,
  ];
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
