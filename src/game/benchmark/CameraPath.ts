import * as THREE from 'three';
import { MASK_SOLID, type Vec3 } from '../../formats/bsp';
import type { Level } from '../level';

/**
 * Chemin de camera pour le banc de mesure.
 *
 * Un banc d'essai n'a de valeur que s'il repasse exactement au meme endroit :
 * le chemin est donc construit a partir de la carte elle-meme, sans hasard.
 * Les points de depart des joueurs servent de jalons, pour deux raisons : ils
 * sont forcement dans du vide, et le concepteur de la carte les a repartis
 * dans toutes ses salles, ce qui est exactement ce qu'on veut parcourir.
 *
 * Les jalons sont choisis les plus ecartes possible, relies en une boucle, et
 * chaque segment est verifie contre la collision : un segment qui traverse un
 * mur est releve, et s'il ne passe toujours pas, son jalon est abandonne.
 * Mesurer des images prises dans la pierre ne dirait rien de la carte.
 */

/** Position et orientation de la camera a un instant du parcours. */
export interface PathSample {
  origin: Vec3;
  yaw: number;
  pitch: number;
}

/** Un troncon du parcours, mesure separement. */
export interface PathSegment {
  name: string;
  /** Distance parcourue au debut et a la fin, en unites de la carte. */
  from: number;
  to: number;
}

/** Hauteur de l'oeil au-dessus du point de depart, comme pour le joueur. */
const EYE = 46;

/** Demi-cote de la boite deplacee le long du chemin, pour le controle. */
const CLEARANCE: Vec3 = [12, 12, 12];

/** Relevements essayes quand un segment traverse un mur. */
const LIFTS = [64, 128, 192, 256];

/** Hauteur cherchee au-dessus d'un point pour passer par-dessus un obstacle. */
const CEILING_SEARCH = 640;

/** Inclinaison maximale de la vue, en radians : la camera ne plonge pas. */
const MAX_PITCH = 0.34;

export class CameraPath {
  private readonly curve: THREE.CatmullRomCurve3;
  readonly length: number;
  readonly segments: PathSegment[];

  constructor(points: THREE.Vector3[], segments: PathSegment[]) {
    // Boucle fermee et tension douce : la camera revient a son point de
    // depart, et le parcours peut donc etre rejoue sans coupure.
    this.curve = new THREE.CatmullRomCurve3(points, true, 'catmullrom', 0.4);
    this.length = this.curve.getLength();
    this.segments = segments;
  }

  /** Nom du troncon parcouru a cette distance. */
  segmentAt(distance: number): string {
    const position = ((distance % this.length) + this.length) % this.length;
    for (const segment of this.segments) {
      if (position >= segment.from && position < segment.to) return segment.name;
    }
    return this.segments[this.segments.length - 1]?.name ?? '';
  }

  /**
   * Position et orientation apres la distance demandee. La vue suit la
   * direction du deplacement : c'est ce qui donne un survol lisible, et cela
   * ne depend d'aucun reglage artistique.
   */
  sample(distance: number): PathSample {
    const u = (((distance % this.length) + this.length) % this.length) / this.length;
    const point = this.curve.getPointAt(u);
    const tangent = this.curve.getTangentAt(u);
    const flat = Math.hypot(tangent.x, tangent.y) || 1e-6;
    return {
      origin: [point.x, point.y, point.z],
      yaw: Math.atan2(tangent.y, tangent.x),
      // Le tangent porte la pente du chemin ; on la borne pour que la camera
      // regarde la salle et non le sol.
      pitch: Math.max(-MAX_PITCH, Math.min(MAX_PITCH, -Math.atan2(tangent.z, flat))),
    };
  }
}

/**
 * Construit le parcours d'une carte. Rend rien quand la carte n'a pas assez
 * de points de depart pour dessiner un trajet, ce qui est le cas de l'arene
 * fabriquee par le code.
 */
export function buildCameraPath(level: Level, wanted = 8): CameraPath | null {
  const candidates = level.spawns.map(
    (spawn) => new THREE.Vector3(spawn.origin[0], spawn.origin[1], spawn.origin[2] + EYE),
  );
  if (candidates.length < 3) return null;

  const spread = spreadOut(candidates, Math.min(wanted, candidates.length));
  const tour = nearestNeighbourTour(spread);
  // A defaut de segments francs, les jalons eux-memes font le parcours : ils
  // sont dans le vide, et c'est la seule chose indispensable.
  const { points, waypoint } = connect(tour, level);
  if (points.length < 3) {
    return tour.length >= 3 ? new CameraPath(tour, describe(tour, tour.map(() => true))) : null;
  }

  // Les troncons sont bornes par les jalons d'origine : c'est la mesure par
  // salle, et elle reste comparable d'un essai a l'autre.
  return new CameraPath(points, describe(points, waypoint));
}

/** Troncons mesures separement : un par jalon du parcours. */
function describe(points: THREE.Vector3[], waypoint: boolean[]): PathSegment[] {
  const probe = new THREE.CatmullRomCurve3(points, true, 'catmullrom', 0.4);
  const total = probe.getLength();
  const lengths = probe.getLengths(points.length * 24);
  const last = lengths[lengths.length - 1] || 1;
  const segments: PathSegment[] = [];
  const at = (index: number) => (lengths[Math.min(index * 24, lengths.length - 1)] / last) * total;
  for (let index = 0; index < points.length; index++) {
    if (!waypoint[index]) continue;
    // Le troncon court jusqu'au jalon suivant, detours compris.
    let end = index + 1;
    while (end < points.length && !waypoint[end]) end += 1;
    segments.push({ name: `section ${segments.length + 1}`, from: at(index), to: at(end) });
  }
  return segments;
}

/** Choisit les points les plus ecartes les uns des autres, sans hasard. */
function spreadOut(points: THREE.Vector3[], count: number): THREE.Vector3[] {
  const centre = points
    .reduce((sum, point) => sum.add(point), new THREE.Vector3())
    .divideScalar(points.length);
  let first = 0;
  for (let index = 1; index < points.length; index++) {
    if (points[index].distanceToSquared(centre) < points[first].distanceToSquared(centre)) first = index;
  }

  const chosen = [points[first]];
  const remaining = points.filter((_, index) => index !== first);
  while (chosen.length < count && remaining.length > 0) {
    let best = 0;
    let bestDistance = -1;
    for (let index = 0; index < remaining.length; index++) {
      const nearest = Math.min(...chosen.map((point) => point.distanceToSquared(remaining[index])));
      if (nearest > bestDistance) {
        bestDistance = nearest;
        best = index;
      }
    }
    chosen.push(remaining[best]);
    remaining.splice(best, 1);
  }
  return chosen;
}

/** Relie les jalons du plus proche au plus proche, en partant du premier. */
function nearestNeighbourTour(points: THREE.Vector3[]): THREE.Vector3[] {
  const tour = [points[0]];
  const remaining = points.slice(1);
  while (remaining.length > 0) {
    const last = tour[tour.length - 1];
    let best = 0;
    for (let index = 1; index < remaining.length; index++) {
      if (last.distanceToSquared(remaining[index]) < last.distanceToSquared(remaining[best])) best = index;
    }
    tour.push(remaining[best]);
    remaining.splice(best, 1);
  }
  return tour;
}

/**
 * Rend la suite des points de controle.
 *
 * Tous les jalons sont conserves : abandonner ceux qu'on n'atteint pas en
 * ligne droite reviendrait a ne plus visiter la moitie de la carte, une arene
 * fermee n'ayant presque aucune salle en vue directe d'une autre. Un segment
 * bloque recoit donc un point intermediaire, place aussi haut que la piece le
 * permet : la camera passe par-dessus le mur quand il y a la place, et le
 * traverse seulement quand un plafond s'y oppose.
 */
function connect(tour: THREE.Vector3[], level: Level): { points: THREE.Vector3[]; waypoint: boolean[] } {
  const points: THREE.Vector3[] = [tour[0]];
  // Un point ajoute pour franchir un mur n'ouvre pas un nouveau troncon : la
  // mesure par salle doit suivre les jalons, pas les detours.
  const waypoint: boolean[] = [true];
  for (let index = 1; index <= tour.length; index++) {
    const target = tour[index % tour.length];
    const from = points[points.length - 1];

    if (!clear(level, from, target)) {
      const lifted = liftBetween(level, from, target);
      if (lifted) {
        points.push(lifted);
        waypoint.push(false);
      }
    }
    if (index < tour.length) {
      points.push(target);
      waypoint.push(true);
    }
  }
  return { points, waypoint };
}

/**
 * Point intermediaire releve qui rend les deux moities franchissables. Les
 * hauteurs essayees s'arretent au plafond mesure au-dessus du point : viser
 * plus haut ne ferait que placer la camera dans la pierre.
 */
function liftBetween(level: Level, from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3 | null {
  const middle = from.clone().add(to).multiplyScalar(0.5);
  const headroom = ceilingAbove(level, middle);
  for (const lift of LIFTS) {
    if (lift > headroom) break;
    const raised = middle.clone().setZ(middle.z + lift);
    if (clear(level, from, raised) && clear(level, raised, to)) return raised;
  }
  // Rien ne passe : le plus haut point libre reste le meilleur compromis, la
  // camera longeant alors le plafond plutot que le sol.
  const best = Math.max(0, Math.min(headroom - 32, LIFTS[LIFTS.length - 1]));
  return best > 32 ? middle.clone().setZ(middle.z + best) : null;
}

/** Distance libre au-dessus d'un point, avant de toucher un plafond. */
function ceilingAbove(level: Level, point: THREE.Vector3): number {
  const trace = level.collision.trace(
    [point.x, point.y, point.z],
    [point.x, point.y, point.z + CEILING_SEARCH],
    [-CLEARANCE[0], -CLEARANCE[1], -CLEARANCE[2]],
    CLEARANCE,
    MASK_SOLID,
  );
  return CEILING_SEARCH * Math.max(0, trace.fraction);
}

/** Vrai quand une boite peut aller d'un point a l'autre sans rien toucher. */
function clear(level: Level, from: THREE.Vector3, to: THREE.Vector3): boolean {
  const mins: Vec3 = [-CLEARANCE[0], -CLEARANCE[1], -CLEARANCE[2]];
  const trace = level.collision.trace(
    [from.x, from.y, from.z],
    [to.x, to.y, to.z],
    mins,
    CLEARANCE,
    MASK_SOLID,
  );
  return trace.fraction >= 1 && !trace.startSolid;
}
