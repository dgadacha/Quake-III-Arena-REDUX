import { BinaryReader } from './binary';
import type { Vec3 } from './bsp';

/**
 * Navigation des bots, telle que la carte la porte.
 *
 * A cote du .bsp, le compilateur du jeu ecrit un .aas : le decor decoupe en
 * zones ou un joueur tient debout, et, entre ces zones, la liste des
 * franchissements avec leur nature. Marcher, sauter, se laisser tomber,
 * prendre un teleporteur ou un tremplin : chaque passage est decrit, avec son
 * point de depart, son point d'arrivee et le temps qu'il coute.
 *
 * C'est la raison de lire ce fichier plutot que de fabriquer un maillage de
 * navigation : les sauts que la carte attend sont deja dedans, mesures par le
 * compilateur, et un bot qui les suit se deplace comme celui du jeu. q3dm7 en
 * declare trois mille cinq cent quatre-vingt-dix-neuf zones et cinq mille trois
 * cent huit franchissements.
 *
 * Le repertoire des morceaux est brouille par un ou exclusif, seule coquetterie
 * du format ; les donnees, elles, sont en clair.
 */

/** Natures de franchissement, telles que le jeu les numerote. */
export const Travel = {
  INVALID: 1,
  WALK: 2,
  CROUCH: 3,
  BARRIERJUMP: 4,
  JUMP: 5,
  LADDER: 6,
  WALKOFFLEDGE: 7,
  SWIM: 8,
  WATERJUMP: 9,
  TELEPORT: 10,
  ELEVATOR: 11,
  ROCKETJUMP: 12,
  BFGJUMP: 13,
  GRAPPLEHOOK: 14,
  DOUBLEJUMP: 15,
  RAMPJUMP: 16,
  STRAFEJUMP: 17,
  JUMPPAD: 18,
  FUNCBOB: 19,
} as const;

/** Les huit bits hauts portent des drapeaux, pas la nature du passage. */
const TRAVEL_MASK = 0xffffff;

/** Presence possible dans une zone : debout, accroupi, ou les deux. */
export const Presence = { NONE: 1, NORMAL: 2, CROUCH: 4 } as const;

/** Zones que les bots evitent : le compilateur les marque lui-meme. */
export const AreaFlag = {
  GROUNDED: 1,
  LADDER: 2,
  LIQUID: 4,
  DISABLED: 8,
  /** Zone que le concepteur a interdite aux bots. */
  DONOTENTER: 0x10,
} as const;

export interface AasArea {
  mins: Vec3;
  maxs: Vec3;
  /** Point de reference de la zone : c'est la que le bot est envoye. */
  center: Vec3;
}

export interface AasAreaSettings {
  contents: number;
  flags: number;
  presence: number;
  cluster: number;
  /** Plage de franchissements de cette zone dans la liste commune. */
  firstReachability: number;
  reachabilityCount: number;
}

export interface AasReachability {
  /** Zone d'arrivee. */
  area: number;
  /** Ou quitter la zone de depart, et ou l'on atterrit. */
  start: Vec3;
  end: Vec3;
  travel: number;
  /** Cout du passage, en centiemes de seconde, mesure par le compilateur. */
  time: number;
}

const LUMP_NAMES = [
  'bboxes',
  'vertexes',
  'planes',
  'edges',
  'edgeindex',
  'faces',
  'faceindex',
  'areas',
  'areasettings',
  'reachability',
  'nodes',
  'portals',
  'portalindex',
  'clusters',
] as const;

type LumpName = (typeof LUMP_NAMES)[number];

interface Lump {
  offset: number;
  length: number;
}

/**
 * Le decor decoupe en zones, avec de quoi savoir dans laquelle on se trouve et
 * comment passer de l'une a l'autre.
 */
export class AasMap {
  readonly areas: AasArea[] = [];
  readonly settings: AasAreaSettings[] = [];
  readonly reachabilities: AasReachability[] = [];
  /** Arbre de recherche : un plan par noeud, deux enfants, zones en feuilles. */
  private readonly nodePlane: Int32Array;
  private readonly nodeChildren: Int32Array;
  private readonly planeNormals: Float32Array;
  private readonly planeDists: Float32Array;

  constructor(reader: BinaryReader, lumps: Record<LumpName, Lump>) {
    const planes = lumps.planes.length / 20;
    this.planeNormals = new Float32Array(planes * 3);
    this.planeDists = new Float32Array(planes);
    reader.seek(lumps.planes.offset);
    for (let i = 0; i < planes; i++) {
      this.planeNormals[i * 3] = reader.f32();
      this.planeNormals[i * 3 + 1] = reader.f32();
      this.planeNormals[i * 3 + 2] = reader.f32();
      this.planeDists[i] = reader.f32();
      reader.skip(4); // type du plan : deduit de la normale, inutile ici
    }

    const areas = lumps.areas.length / 48;
    reader.seek(lumps.areas.offset);
    for (let i = 0; i < areas; i++) {
      reader.skip(12); // numero de zone, nombre de faces, premiere face
      const mins = reader.vec3();
      const maxs = reader.vec3();
      const center = reader.vec3();
      this.areas.push({ mins, maxs, center });
    }

    const settings = lumps.areasettings.length / 28;
    reader.seek(lumps.areasettings.offset);
    for (let i = 0; i < settings; i++) {
      const contents = reader.i32();
      const flags = reader.i32();
      const presence = reader.i32();
      const cluster = reader.i32();
      reader.skip(4); // numero de la zone dans son groupe
      const reachabilityCount = reader.i32();
      const firstReachability = reader.i32();
      this.settings.push({ contents, flags, presence, cluster, firstReachability, reachabilityCount });
    }

    const reachabilities = lumps.reachability.length / 44;
    reader.seek(lumps.reachability.offset);
    for (let i = 0; i < reachabilities; i++) {
      const area = reader.i32();
      reader.skip(8); // face et arete par lesquelles on passe : le rendu du debug s'en sert
      const start = reader.vec3();
      const end = reader.vec3();
      const travel = reader.i32();
      const time = reader.u16();
      reader.skip(2); // alignement
      this.reachabilities.push({ area, start, end, travel: travel & TRAVEL_MASK, time });
    }

    const nodes = lumps.nodes.length / 12;
    this.nodePlane = new Int32Array(nodes);
    this.nodeChildren = new Int32Array(nodes * 2);
    reader.seek(lumps.nodes.offset);
    for (let i = 0; i < nodes; i++) {
      this.nodePlane[i] = reader.i32();
      this.nodeChildren[i * 2] = reader.i32();
      this.nodeChildren[i * 2 + 1] = reader.i32();
    }
  }

  get areaCount(): number {
    return this.areas.length;
  }

  /**
   * Zone qui contient ce point, ou zero.
   *
   * L'arbre se descend comme celui du .bsp : le signe du cote du plan choisit
   * l'enfant. Un enfant negatif designe une zone, son oppose ; un enfant nul
   * est du vide solide, ou personne ne tient.
   */
  areaAt(point: Vec3): number {
    let index = 1;
    for (let depth = 0; depth < 256 && index > 0; depth++) {
      const plane = this.nodePlane[index];
      const distance =
        point[0] * this.planeNormals[plane * 3]
        + point[1] * this.planeNormals[plane * 3 + 1]
        + point[2] * this.planeNormals[plane * 3 + 2]
        - this.planeDists[plane];
      index = this.nodeChildren[index * 2 + (distance < 0 ? 1 : 0)];
    }
    return index < 0 ? -index : 0;
  }

  /**
   * Zone praticable la plus proche d'un point, en descendant puis en cherchant
   * autour. Un joueur se tient les pieds au sol et les zones sont posees sur le
   * sol : un point pris a hauteur d'oeil tombe souvent dans le vide.
   */
  areaNear(point: Vec3, radius = 96): number {
    const direct = this.areaAt(point);
    if (direct > 0 && this.walkable(direct)) return direct;

    // Sous les pieds d'abord : c'est la que la zone se trouve neuf fois sur dix.
    for (const drop of [24, 48, 96, 160]) {
      const below = this.areaAt([point[0], point[1], point[2] - drop]);
      if (below > 0 && this.walkable(below)) return below;
    }

    let best = 0;
    let bestDistance = radius * radius;
    for (let area = 1; area < this.areas.length; area++) {
      if (!this.walkable(area)) continue;
      const center = this.areas[area].center;
      const dx = center[0] - point[0];
      const dy = center[1] - point[1];
      const dz = center[2] - point[2];
      const distance = dx * dx + dy * dy + dz * dz;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = area;
      }
    }
    return best;
  }

  /** Un bot peut-il se tenir dans cette zone et la traverser ? */
  walkable(area: number): boolean {
    const settings = this.settings[area];
    if (!settings) return false;
    if ((settings.flags & (AreaFlag.DISABLED | AreaFlag.DONOTENTER)) !== 0) return false;
    return (settings.presence & (Presence.NORMAL | Presence.CROUCH)) !== 0;
  }

  /** Franchissements au depart d'une zone. */
  *exits(area: number): Generator<AasReachability> {
    const settings = this.settings[area];
    if (!settings) return;
    for (let i = 0; i < settings.reachabilityCount; i++) {
      const reachability = this.reachabilities[settings.firstReachability + i];
      if (reachability) yield reachability;
    }
  }
}

/**
 * Lit un fichier .aas. Rend rien si ce n'en est pas un, ou si sa version n'est
 * pas celle du jeu : mieux vaut des bots sans navigation qu'une lecture au
 * hasard.
 */
export function readAas(source: ArrayBuffer | Uint8Array): AasMap | null {
  const reader = new BinaryReader(source);
  if (reader.length < 124) return null;
  if (reader.magic(4) !== 'EAAS') return null;
  const version = reader.i32();
  if (version !== 5) return null;
  reader.skip(4); // empreinte du .bsp associe

  /*
   * Le repertoire est brouille par un ou exclusif avec un compteur : chaque
   * octet porte la valeur de son rang multipliee par cent dix-neuf. Le
   * compteur ne part pas de zero au debut du repertoire mais de quatre, comme
   * si l'entete comptait a partir de son numero de version.
   */
  const directory = reader.slice(12, 112).slice();
  for (let i = 0; i < directory.length; i++) directory[i] ^= ((i + 4) * 119) & 0xff;
  const table = new BinaryReader(directory);

  const lumps = {} as Record<LumpName, Lump>;
  for (const name of LUMP_NAMES) {
    const offset = table.i32();
    const length = table.i32();
    if (offset < 0 || length < 0 || offset + length > reader.length) return null;
    lumps[name] = { offset, length };
  }

  // Deux tailles fixes servent de controle : une zone tient en quarante-huit
  // octets, un franchissement en quarante-quatre. Si le compte ne tombe pas
  // juste, le fichier n'est pas celui qu'on croit.
  if (lumps.areas.length % 48 !== 0 || lumps.reachability.length % 44 !== 0) return null;
  if (lumps.areasettings.length / 28 !== lumps.areas.length / 48) return null;

  return new AasMap(reader, lumps);
}
