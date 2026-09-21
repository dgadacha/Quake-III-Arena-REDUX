import * as THREE from 'three';
import { entityNumber, entityVector, type BspEntity, type BspMap, type Vec3 } from '../../formats/bsp';
import type { CollisionWorld, MoverVolume } from '../collision';

/**
 * Parties mobiles des cartes : portes, plateformes, panneaux tournants et
 * passerelles oscillantes. Leur geometrie est un modele du fichier de carte,
 * designe par une entite sous la forme *1, *2, et ainsi de suite.
 *
 * Les reglages lus dans la carte sont ceux du jeu : vitesse, course, retenue
 * de bord, attente avant fermeture. Rien n'est invente, et rien n'est ecrit
 * dans les fichiers.
 */

type MoverKind = 'door' | 'plat' | 'bobbing' | 'rotating' | 'pendulum';

interface MoverState {
  kind: MoverKind;
  modelIndex: number;
  /** Conteneur place au centre du modele : il porte les rotations. */
  pivot: THREE.Group;
  group: THREE.Group;
  volume: MoverVolume;
  center: THREE.Vector3;
  /** Position de repos et position atteinte, en coordonnees de carte. */
  restOffset: Vec3;
  reachedOffset: Vec3;
  speed: number;
  /** Attente avant retour, en secondes ; negative pour rester ouvert. */
  wait: number;
  /** Rayon de declenchement autour du volume. */
  trigger: number;
  height: number;
  phase: number;
  axis: 0 | 1 | 2;
  /** Avancement de zero (repos) a un (atteint). */
  progress: number;
  direction: 1 | -1;
  holdUntil: number;
}

const DOOR_SPEED = 100;
const PLAT_SPEED = 200;
const DEFAULT_LIP = 8;
/** Marge du declencheur autour d'une porte, comme dans le jeu. */
const TRIGGER_MARGIN = 60;

export class MoverManager {
  private readonly movers: MoverState[] = [];

  constructor(map: BspMap, brushModels: THREE.Group[], collision: CollisionWorld) {
    for (const entity of map.entities) {
      const kind = kindOf(entity.classname);
      if (!kind) continue;
      const modelIndex = modelIndexOf(entity);
      if (modelIndex === null) continue;
      const group = brushModels[modelIndex];
      const model = map.models[modelIndex];
      if (!group || !model) continue;

      const state = this.createMover(kind, entity, modelIndex, group, model);
      if (state) this.movers.push(state);
    }

    collision.setMovers(this.movers.map((mover) => mover.volume));
  }

  get count(): number {
    return this.movers.length;
  }

  private createMover(
    kind: MoverKind,
    entity: BspEntity,
    modelIndex: number,
    group: THREE.Group,
    model: BspMap['models'][number],
  ): MoverState | null {
    const size: Vec3 = [
      model.maxs[0] - model.mins[0],
      model.maxs[1] - model.mins[1],
      model.maxs[2] - model.mins[2],
    ];
    const center = new THREE.Vector3(
      (model.mins[0] + model.maxs[0]) / 2,
      (model.mins[1] + model.maxs[1]) / 2,
      (model.mins[2] + model.maxs[2]) / 2,
    );

    // Les rotations ont besoin d'un pivot : le groupe est recentre dedans.
    const pivot = new THREE.Group();
    pivot.name = `mover*${modelIndex}`;
    const parent = group.parent;
    pivot.position.copy(center);
    group.position.copy(center).multiplyScalar(-1);
    pivot.add(group);
    parent?.add(pivot);

    const brushes: number[] = [];
    for (let i = 0; i < model.brushCount; i++) brushes.push(model.firstBrush + i);

    const volume: MoverVolume = {
      brushes,
      offset: [0, 0, 0],
      mins: [...model.mins] as Vec3,
      maxs: [...model.maxs] as Vec3,
    };

    const lip = entityNumber(entity, 'lip', DEFAULT_LIP);
    const base: MoverState = {
      kind,
      modelIndex,
      pivot,
      group,
      volume,
      center,
      restOffset: [0, 0, 0],
      reachedOffset: [0, 0, 0],
      speed: entityNumber(entity, 'speed', kind === 'plat' ? PLAT_SPEED : DOOR_SPEED),
      wait: entityNumber(entity, 'wait', kind === 'plat' ? 1 : 2),
      trigger: TRIGGER_MARGIN,
      height: entityNumber(entity, 'height', 0),
      phase: entityNumber(entity, 'phase', 0),
      axis: axisOf(entity),
      progress: 0,
      direction: 1,
      holdUntil: 0,
    };

    switch (kind) {
      case 'door': {
        // La course vaut la taille dans la direction d'ouverture, moins le bord.
        const angle = entityNumber(entity, 'angle', 0);
        const direction = doorDirection(angle, entity);
        const span = Math.abs(direction[0]) * size[0] + Math.abs(direction[1]) * size[1] + Math.abs(direction[2]) * size[2];
        const distance = Math.max(1, span - lip);
        base.reachedOffset = [direction[0] * distance, direction[1] * distance, direction[2] * distance];
        return base;
      }
      case 'plat': {
        // Au repos la plateforme est en bas ; elle remonte a sa place d'origine.
        const height = base.height > 0 ? base.height : Math.max(1, size[2] - lip);
        base.restOffset = [0, 0, -height];
        base.reachedOffset = [0, 0, 0];
        base.volume.offset = [...base.restOffset] as Vec3;
        base.trigger = Math.max(TRIGGER_MARGIN, height);
        applyOffset(base, base.restOffset);
        return base;
      }
      case 'bobbing': {
        const height = base.height !== 0 ? base.height : 32;
        const delta: Vec3 = [0, 0, 0];
        delta[base.axis] = height;
        base.reachedOffset = delta;
        // La vitesse d'une passerelle oscillante est une duree de cycle.
        base.speed = entityNumber(entity, 'speed', 4);
        return base;
      }
      case 'rotating': {
        base.speed = entityNumber(entity, 'speed', 100);
        return base;
      }
      case 'pendulum': {
        base.speed = entityNumber(entity, 'speed', 30);
        return base;
      }
    }
  }

  /** Avance toutes les parties mobiles et replace leurs volumes de collision. */
  update(time: number, delta: number, viewer: Vec3): void {
    for (const mover of this.movers) {
      switch (mover.kind) {
        case 'door':
        case 'plat':
          this.updateTriggered(mover, time, delta, viewer);
          break;
        case 'bobbing': {
          // Oscillation continue, decalee par la phase declaree.
          const cycle = mover.speed > 0 ? mover.speed : 4;
          const angle = ((time / cycle) + mover.phase) * Math.PI * 2;
          const wave = Math.sin(angle);
          applyOffset(mover, [
            mover.reachedOffset[0] * wave,
            mover.reachedOffset[1] * wave,
            mover.reachedOffset[2] * wave,
          ]);
          break;
        }
        case 'rotating': {
          // La collision ne suit pas la rotation : le volume reste a sa place.
          const turn = (mover.speed * Math.PI) / 180;
          mover.pivot.rotation.z = mover.axis === 2 ? time * turn : mover.pivot.rotation.z;
          mover.pivot.rotation.x = mover.axis === 0 ? time * turn : mover.pivot.rotation.x;
          mover.pivot.rotation.y = mover.axis === 1 ? time * turn : mover.pivot.rotation.y;
          break;
        }
        case 'pendulum': {
          const swing = Math.sin((time + mover.phase) * 2) * ((mover.speed * Math.PI) / 180);
          mover.pivot.rotation.x = swing;
          break;
        }
      }
    }
  }

  /** Porte ou plateforme : elle part quand le joueur approche, puis revient. */
  private updateTriggered(mover: MoverState, time: number, delta: number, viewer: Vec3): void {
    const near = distanceToBox(viewer, mover.volume, mover.trigger) <= mover.trigger;
    const travel = Math.hypot(
      mover.reachedOffset[0] - mover.restOffset[0],
      mover.reachedOffset[1] - mover.restOffset[1],
      mover.reachedOffset[2] - mover.restOffset[2],
    );
    const step = travel > 0 ? (mover.speed * delta) / travel : 1;

    if (near) {
      mover.direction = 1;
      // Tant que le joueur est la, la fermeture est repoussee.
      mover.holdUntil = time + Math.max(0, mover.wait);
    } else if (mover.progress >= 1 && mover.wait >= 0 && time >= mover.holdUntil) {
      mover.direction = -1;
    }

    mover.progress = Math.max(0, Math.min(1, mover.progress + step * mover.direction));
    applyOffset(mover, [
      mover.restOffset[0] + (mover.reachedOffset[0] - mover.restOffset[0]) * mover.progress,
      mover.restOffset[1] + (mover.reachedOffset[1] - mover.restOffset[1]) * mover.progress,
      mover.restOffset[2] + (mover.reachedOffset[2] - mover.restOffset[2]) * mover.progress,
    ]);
  }
}

function applyOffset(mover: MoverState, offset: Vec3): void {
  mover.volume.offset = [...offset] as Vec3;
  mover.pivot.position.set(
    mover.center.x + offset[0],
    mover.center.y + offset[1],
    mover.center.z + offset[2],
  );
}

function kindOf(classname: string): MoverKind | null {
  switch (classname) {
    case 'func_door':
      return 'door';
    case 'func_plat':
      return 'plat';
    case 'func_bobbing':
      return 'bobbing';
    case 'func_rotating':
      return 'rotating';
    case 'func_pendulum':
      return 'pendulum';
    default:
      return null;
  }
}

/** Les entites designent leur geometrie par *1, *2, etc. */
function modelIndexOf(entity: BspEntity): number | null {
  const raw = entity.model;
  if (!raw || !raw.startsWith('*')) return null;
  const index = Number(raw.slice(1));
  return Number.isFinite(index) ? index : null;
}

function axisOf(entity: BspEntity): 0 | 1 | 2 {
  const flags = entityNumber(entity, 'spawnflags', 0);
  if (flags & 1) return 0;
  if (flags & 2) return 1;
  return 2;
}

/** Direction d'ouverture : -1 vers le haut, -2 vers le bas, sinon un cap. */
function doorDirection(angle: number, entity: BspEntity): Vec3 {
  if (angle === -1) return [0, 0, 1];
  if (angle === -2) return [0, 0, -1];
  const angles = entityVector(entity, 'angles', [0, angle, 0]);
  const yaw = ((entity.angle !== undefined ? angle : angles[1]) * Math.PI) / 180;
  return [Math.cos(yaw), Math.sin(yaw), 0];
}

/** Distance d'un point aux bornes du volume, a sa position courante. */
function distanceToBox(point: Vec3, volume: MoverVolume, margin: number): number {
  let total = 0;
  for (let axis = 0; axis < 3; axis++) {
    const min = volume.mins[axis] + volume.offset[axis] - margin;
    const max = volume.maxs[axis] + volume.offset[axis] + margin;
    const value = point[axis];
    if (value < min) total += (min - value) ** 2;
    else if (value > max) total += (value - max) ** 2;
  }
  return Math.sqrt(total);
}
