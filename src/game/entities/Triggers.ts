import { entityNumber, entityVector, type BspEntity, type BspMap, type Vec3 } from '../../formats/bsp';
import { MoveConfig, type MoveState } from '../physics';
import { PLAYER_MAXS, PLAYER_MINS } from '../collision';

/**
 * Volumes de declenchement de la carte : tremplins, teleporteurs et zones
 * mortelles. Ils sont invisibles et decrits par un modele du fichier de carte.
 *
 * Les tremplins gardent le calcul du jeu : la vitesse communiquee est celle qui
 * amene exactement le joueur sur la cible visee, en tenant compte de la
 * gravite. Un tremplin ne se regle donc pas, il se deduit de la carte.
 */

export type TriggerEffect = 'none' | 'respawn' | 'push' | 'teleport';

type TriggerKind = 'push' | 'teleport' | 'hurt';

interface Trigger {
  kind: TriggerKind;
  mins: Vec3;
  maxs: Vec3;
  /** Tremplin : vitesse a communiquer. */
  velocity: Vec3;
  /** Teleporteur : arrivee et orientation. */
  destination: Vec3;
  yaw: number;
}

export class TriggerManager {
  private readonly triggers: Trigger[] = [];
  /** Le declencheur ne se rejoue pas tant que le joueur ne l'a pas quitte. */
  private inside = new Set<number>();

  constructor(map: BspMap) {
    for (const entity of map.entities) {
      const kind = kindOf(entity.classname);
      if (!kind) continue;

      const model = modelOf(entity, map);
      if (!model) continue;

      const trigger: Trigger = {
        kind,
        mins: [...model.mins] as Vec3,
        maxs: [...model.maxs] as Vec3,
        velocity: [0, 0, 0],
        destination: [0, 0, 0],
        yaw: 0,
      };

      const target = entity.target ? findTarget(map, entity.target) : null;
      if (kind === 'push') {
        if (!target) continue;
        trigger.velocity = launchVelocity(trigger, entityVector(target, 'origin'));
      } else if (kind === 'teleport') {
        if (!target) continue;
        trigger.destination = entityVector(target, 'origin');
        trigger.yaw = (entityNumber(target, 'angle', 0) * Math.PI) / 180;
      }

      this.triggers.push(trigger);
    }
  }

  get count(): number {
    return this.triggers.length;
  }

  /**
   * Applique les declencheurs touches. Renvoie ce qui a eu lieu, pour que
   * l'appelant s'occupe de ce qui le concerne, comme une reapparition.
   */
  apply(state: MoveState, setYaw: (yaw: number) => void): TriggerEffect {
    let effect: TriggerEffect = 'none';
    const stillInside = new Set<number>();

    for (let index = 0; index < this.triggers.length; index++) {
      const trigger = this.triggers[index];
      if (!touches(state.origin, trigger)) continue;
      stillInside.add(index);
      // Un volume deja occupe a l'image precedente ne se rejoue pas.
      if (this.inside.has(index)) continue;

      switch (trigger.kind) {
        case 'push':
          state.velocity = [...trigger.velocity] as Vec3;
          state.onGround = false;
          state.groundPlane = false;
          effect = 'push';
          break;
        case 'teleport':
          state.origin = [trigger.destination[0], trigger.destination[1], trigger.destination[2] + 9];
          state.previousOrigin = [...state.origin] as Vec3;
          state.velocity = [0, 0, 0];
          setYaw(trigger.yaw);
          effect = 'teleport';
          break;
        case 'hurt':
          effect = 'respawn';
          break;
      }
    }

    this.inside = stillInside;
    return effect;
  }
}

/**
 * Vitesse de lancement d'un tremplin : la duree de vol se deduit de la
 * difference de hauteur, la vitesse horizontale de la distance a parcourir
 * pendant ce temps, et la vitesse verticale de la gravite.
 */
function launchVelocity(trigger: Trigger, target: Vec3): Vec3 {
  const center: Vec3 = [
    (trigger.mins[0] + trigger.maxs[0]) / 2,
    (trigger.mins[1] + trigger.maxs[1]) / 2,
    (trigger.mins[2] + trigger.maxs[2]) / 2,
  ];
  const height = target[2] - center[2];
  const gravity = MoveConfig.gravity;
  const time = Math.sqrt(Math.max(1, height) / (0.5 * gravity));
  if (!Number.isFinite(time) || time <= 0) return [0, 0, 0];

  const flat: Vec3 = [target[0] - center[0], target[1] - center[1], 0];
  const distance = Math.hypot(flat[0], flat[1]);
  const forward = distance > 0 ? distance / time : 0;
  const direction: Vec3 = distance > 0 ? [flat[0] / distance, flat[1] / distance, 0] : [0, 0, 0];

  return [direction[0] * forward, direction[1] * forward, time * gravity];
}

/** La boite du joueur touche-t-elle le volume ? */
function touches(origin: Vec3, trigger: Trigger): boolean {
  for (let axis = 0; axis < 3; axis++) {
    if (origin[axis] + PLAYER_MAXS[axis] < trigger.mins[axis]) return false;
    if (origin[axis] + PLAYER_MINS[axis] > trigger.maxs[axis]) return false;
  }
  return true;
}

function kindOf(classname: string): TriggerKind | null {
  switch (classname) {
    case 'trigger_push':
      return 'push';
    case 'trigger_teleport':
      return 'teleport';
    case 'trigger_hurt':
      return 'hurt';
    default:
      return null;
  }
}

function modelOf(entity: BspEntity, map: BspMap): BspMap['models'][number] | null {
  const raw = entity.model;
  if (!raw || !raw.startsWith('*')) return null;
  const index = Number(raw.slice(1));
  return Number.isFinite(index) ? map.models[index] ?? null : null;
}

function findTarget(map: BspMap, name: string): BspEntity | null {
  return map.entities.find((entity) => entity.targetname === name) ?? null;
}
