import { Contents, MASK_SOLID, MASK_WATER, Surface, type Vec3 } from '../formats/bsp';
import {
  CROUCH_VIEW_HEIGHT,
  PLAYER_CROUCH_MAXS,
  PLAYER_MAXS,
  PLAYER_MINS,
  VIEW_HEIGHT,
  type CollisionWorld,
  type TraceResult,
} from './collision';

/**
 * Deplacement du joueur, repris du modele de l'arene d'origine : accelerations
 * differentes au sol et en l'air, glissement sur les plans touches,
 * franchissement des marches, nage. L'acceleration en l'air s'arrete des que la
 * vitesse projetee sur la direction demandee atteint la vitesse visee : en
 * tournant pendant un saut, la projection reste basse et la vitesse continue de
 * monter, c'est ce qui rend l'enchainement de sauts utile.
 */
export const MoveConfig = {
  gravity: 800,
  /** Vitesse de reference : 320 unites par seconde. */
  speed: 320,
  stopSpeed: 100,
  accelerate: 10,
  airAccelerate: 1,
  waterAccelerate: 4,
  flyAccelerate: 8,
  friction: 6,
  waterFriction: 1,
  flightFriction: 3,
  jumpVelocity: 270,
  stepSize: 18,
  duckScale: 0.25,
  swimScale: 0.5,
  /** En deca, une pente ne porte plus le joueur. */
  minWalkNormal: 0.7,
  overclip: 1.001,
  maxClipPlanes: 5,
  /** Pas de simulation fixe : la physique ne depend pas du framerate. */
  tickRate: 1 / 125,
};

export interface MoveState {
  origin: Vec3;
  /** Position au pas de simulation precedent, pour l'interpolation du rendu. */
  previousOrigin: Vec3;
  velocity: Vec3;
  onGround: boolean;
  groundPlane: boolean;
  groundNormal: Vec3;
  groundSurfaceFlags: number;
  ducked: boolean;
  viewHeight: number;
  waterLevel: number;
  waterType: number;
  jumpHeld: boolean;
  /** Temps restant d'un saut hors de l'eau, en secondes. */
  waterJumpTime: number;
  /** Renseigne par le moteur quand la derniere commande a produit un saut. */
  justJumped: boolean;
  landed: number;
  /**
   * Hauteur gagnee par les marches franchies pendant la commande, en unites.
   * Le rendu s'en sert pour amortir la vue : sans cela, chaque marche fait
   * sauter la camera d'un cran et un escalier se monte par saccades.
   */
  stepped: number;
}

export interface MoveInput {
  /** Commandes dans l'intervalle -127..127, comme les commandes reseau. */
  forward: number;
  right: number;
  up: number;
  jump: boolean;
  crouch: boolean;
  yaw: number;
  pitch: number;
}

export function createMoveState(origin: Vec3): MoveState {
  return {
    origin: [...origin] as Vec3,
    previousOrigin: [...origin] as Vec3,
    velocity: [0, 0, 0],
    onGround: false,
    groundPlane: false,
    groundNormal: [0, 0, 1],
    groundSurfaceFlags: 0,
    ducked: false,
    viewHeight: VIEW_HEIGHT,
    waterLevel: 0,
    waterType: 0,
    jumpHeld: false,
    waterJumpTime: 0,
    justJumped: false,
    landed: 0,
    stepped: 0,
  };
}

/**
 * Remet un etat de deplacement a neuf, sans en fabriquer un autre. Les
 * combattants sont tenus par l'arene, qui garde une reference sur leur etat :
 * remplacer l'objet a chaque reapparition la laisserait avec l'ancien.
 */
export function resetMoveState(state: MoveState, origin: Vec3): void {
  const fresh = createMoveState(origin);
  Object.assign(state, fresh);
  state.origin = [...origin] as Vec3;
  state.previousOrigin = [...origin] as Vec3;
  state.velocity = [0, 0, 0];
  state.groundNormal = [0, 0, 1];
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);

function normalize(v: Vec3): number {
  const len = length(v);
  if (len === 0) return 0;
  v[0] /= len;
  v[1] /= len;
  v[2] /= len;
  return len;
}

/** Retire du mouvement la part qui entre dans le plan touche. */
function clipVelocity(velocity: Vec3, normal: Vec3, overbounce: number): Vec3 {
  let backoff = dot(velocity, normal);
  backoff = backoff < 0 ? backoff * overbounce : backoff / overbounce;
  return [
    velocity[0] - normal[0] * backoff,
    velocity[1] - normal[1] * backoff,
    velocity[2] - normal[2] * backoff,
  ];
}

/** Repere de la vue : avant, droite, haut. */
export function angleVectors(yaw: number, pitch: number): [Vec3, Vec3, Vec3] {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const forward: Vec3 = [cp * cy, cp * sy, -sp];
  const right: Vec3 = [sy, -cy, 0];
  const up: Vec3 = [sp * cy, sp * sy, cp];
  return [forward, right, up];
}

export class PlayerMove {
  private accumulator = 0;
  private frametime = MoveConfig.tickRate;
  private forward: Vec3 = [1, 0, 0];
  private right: Vec3 = [0, 1, 0];
  private mins: Vec3 = [...PLAYER_MINS] as Vec3;
  private maxs: Vec3 = [...PLAYER_MAXS] as Vec3;

  constructor(private world: CollisionWorld) {}

  setWorld(world: CollisionWorld): void {
    this.world = world;
  }

  /** Avance la simulation d'un temps reel quelconque, par pas fixes. */
  step(state: MoveState, input: MoveInput, deltaTime: number): void {
    this.accumulator += Math.min(deltaTime, 0.25);
    state.justJumped = false;
    while (this.accumulator >= MoveConfig.tickRate) {
      state.previousOrigin = [...state.origin] as Vec3;
      this.tick(state, input);
      this.accumulator -= MoveConfig.tickRate;
    }
  }

  /** Part du pas en cours deja ecoulee : sert a placer la camera entre deux pas. */
  get alpha(): number {
    return Math.max(0, Math.min(1, this.accumulator / MoveConfig.tickRate));
  }

  private trace(start: Vec3, end: Vec3): TraceResult {
    return this.world.trace(start, end, this.mins, this.maxs, MASK_SOLID);
  }

  private tick(state: MoveState, input: MoveInput): void {
    this.frametime = MoveConfig.tickRate;
    const [forward, right] = angleVectors(input.yaw, input.pitch);
    this.forward = forward;
    this.right = right;

    this.setWaterLevel(state);
    this.checkDuck(state, input);
    this.groundTrace(state);

    if (state.waterJumpTime > 0) {
      state.waterJumpTime -= this.frametime;
      if (state.waterJumpTime <= 0) state.waterJumpTime = 0;
      this.waterJumpMove(state);
    } else if (state.waterLevel > 1) {
      this.waterMove(state, input);
    } else if (state.onGround) {
      this.walkMove(state, input);
    } else {
      this.airMove(state, input);
    }

    this.groundTrace(state);
    this.setWaterLevel(state);
  }

  /** Hauteur de la boite selon que le joueur est accroupi ou non. */
  private checkDuck(state: MoveState, input: MoveInput): void {
    this.mins = [...PLAYER_MINS] as Vec3;
    if (input.crouch || input.up < -10) {
      state.ducked = true;
    } else if (state.ducked) {
      // On ne se releve que si la place est libre au-dessus.
      this.maxs = [...PLAYER_MAXS] as Vec3;
      const trace = this.world.trace(state.origin, state.origin, this.mins, this.maxs, MASK_SOLID);
      if (!trace.allSolid) state.ducked = false;
    }
    this.maxs = state.ducked ? ([...PLAYER_CROUCH_MAXS] as Vec3) : ([...PLAYER_MAXS] as Vec3);

    const target = state.ducked ? CROUCH_VIEW_HEIGHT : VIEW_HEIGHT;
    // La vue suit la hauteur avec un leger retard, comme a l'origine.
    const rate = 140 * this.frametime;
    if (state.viewHeight < target) state.viewHeight = Math.min(target, state.viewHeight + rate);
    else if (state.viewHeight > target) state.viewHeight = Math.max(target, state.viewHeight - rate);
  }

  /** Cherche le sol juste sous les pieds. */
  private groundTrace(state: MoveState): void {
    const point: Vec3 = [state.origin[0], state.origin[1], state.origin[2] - 0.25];
    const trace = this.trace(state.origin, point);
    state.groundNormal = [...trace.normal] as Vec3;
    state.groundSurfaceFlags = trace.surfaceFlags;

    if (trace.allSolid) {
      this.correctAllSolid(state);
      return;
    }
    if (trace.fraction === 1) {
      state.onGround = false;
      state.groundPlane = false;
      return;
    }
    // Un mouvement vers le haut assez franc decolle du sol.
    if (state.velocity[2] > 0 && dot(state.velocity, trace.normal) > 10) {
      state.onGround = false;
      state.groundPlane = false;
      return;
    }
    if (trace.normal[2] < MoveConfig.minWalkNormal) {
      state.groundPlane = true;
      state.onGround = false;
      return;
    }
    if (!state.onGround) state.landed = Math.abs(state.velocity[2]);
    state.groundPlane = true;
    state.onGround = true;
  }

  /** Coince dans un mur : on cherche une case libre autour avant d'abandonner. */
  private correctAllSolid(state: MoveState): void {
    for (let x = -1; x <= 1; x++) {
      for (let y = -1; y <= 1; y++) {
        for (let z = -1; z <= 1; z++) {
          const point: Vec3 = [state.origin[0] + x, state.origin[1] + y, state.origin[2] + z];
          const trace = this.world.trace(point, point, this.mins, this.maxs, MASK_SOLID);
          if (trace.allSolid || trace.startSolid) continue;
          state.origin = point;
          this.groundTrace(state);
          return;
        }
      }
    }
    state.onGround = false;
    state.groundPlane = false;
  }

  /** Immersion : trois niveaux, des pieds jusqu'aux yeux. */
  private setWaterLevel(state: MoveState): void {
    state.waterLevel = 0;
    state.waterType = 0;
    const feet: Vec3 = [state.origin[0], state.origin[1], state.origin[2] + PLAYER_MINS[2] + 1];
    let contents = this.world.pointContents(feet);
    if ((contents & MASK_WATER) === 0) return;

    state.waterType = contents;
    state.waterLevel = 1;
    const span = state.viewHeight - PLAYER_MINS[2];
    const waist: Vec3 = [state.origin[0], state.origin[1], state.origin[2] + PLAYER_MINS[2] + span / 2];
    contents = this.world.pointContents(waist);
    if ((contents & MASK_WATER) === 0) return;

    state.waterLevel = 2;
    const eyes: Vec3 = [state.origin[0], state.origin[1], state.origin[2] + PLAYER_MINS[2] + span];
    contents = this.world.pointContents(eyes);
    if ((contents & MASK_WATER) !== 0) state.waterLevel = 3;
  }

  /** Echelle des commandes : une diagonale ne va pas plus vite qu'une ligne droite. */
  private commandScale(input: MoveInput): number {
    const max = Math.max(Math.abs(input.forward), Math.abs(input.right), Math.abs(input.up));
    if (!max) return 0;
    const total = Math.hypot(input.forward, input.right, input.up);
    return (MoveConfig.speed * max) / (127 * total);
  }

  private friction(state: MoveState): void {
    const velocity = state.velocity;
    const flat: Vec3 = [velocity[0], velocity[1], state.onGround ? 0 : velocity[2]];
    const speed = length(flat);
    if (speed < 1) {
      velocity[0] = 0;
      velocity[1] = 0;
      return;
    }

    let drop = 0;
    if (state.waterLevel <= 1 && state.onGround && (state.groundSurfaceFlags & Surface.SLICK) === 0) {
      const control = speed < MoveConfig.stopSpeed ? MoveConfig.stopSpeed : speed;
      drop += control * MoveConfig.friction * this.frametime;
    }
    if (state.waterLevel) {
      drop += speed * MoveConfig.waterFriction * state.waterLevel * this.frametime;
    }

    let newSpeed = speed - drop;
    if (newSpeed < 0) newSpeed = 0;
    newSpeed /= speed;
    velocity[0] *= newSpeed;
    velocity[1] *= newSpeed;
    velocity[2] *= newSpeed;
  }

  /**
   * Acceleration vers la direction demandee, plafonnee sur la projection de la
   * vitesse actuelle : au-dela de la vitesse visee, la poussee s'annule.
   */
  private accelerate(state: MoveState, wishDir: Vec3, wishSpeed: number, accel: number): void {
    const currentSpeed = dot(state.velocity, wishDir);
    const addSpeed = wishSpeed - currentSpeed;
    if (addSpeed <= 0) return;
    let accelSpeed = accel * this.frametime * wishSpeed;
    if (accelSpeed > addSpeed) accelSpeed = addSpeed;
    state.velocity[0] += accelSpeed * wishDir[0];
    state.velocity[1] += accelSpeed * wishDir[1];
    state.velocity[2] += accelSpeed * wishDir[2];
  }

  private checkJump(state: MoveState, input: MoveInput): boolean {
    if (!input.jump && input.up < 10) {
      state.jumpHeld = false;
      return false;
    }
    // Il faut relacher la touche entre deux sauts.
    if (state.jumpHeld) return false;
    state.jumpHeld = true;
    state.onGround = false;
    state.groundPlane = false;
    state.velocity[2] = MoveConfig.jumpVelocity;
    state.justJumped = true;
    return true;
  }

  private walkMove(state: MoveState, input: MoveInput): void {
    if (state.waterLevel > 2 && dot(this.forward, state.groundNormal) > 0) {
      this.waterMove(state, input);
      return;
    }
    if (this.checkJump(state, input)) {
      this.airMove(state, input);
      return;
    }

    this.friction(state);
    const scale = this.commandScale(input);

    // Les directions de vue sont rabattues puis posees sur la pente du sol.
    const forward: Vec3 = [this.forward[0], this.forward[1], 0];
    const right: Vec3 = [this.right[0], this.right[1], 0];
    const clippedForward = clipVelocity(forward, state.groundNormal, MoveConfig.overclip);
    const clippedRight = clipVelocity(right, state.groundNormal, MoveConfig.overclip);
    normalize(clippedForward);
    normalize(clippedRight);

    const wishVelocity: Vec3 = [
      clippedForward[0] * input.forward + clippedRight[0] * input.right,
      clippedForward[1] * input.forward + clippedRight[1] * input.right,
      clippedForward[2] * input.forward + clippedRight[2] * input.right,
    ];
    const wishDir: Vec3 = [...wishVelocity] as Vec3;
    let wishSpeed = normalize(wishDir) * scale;

    if (state.ducked && wishSpeed > MoveConfig.speed * MoveConfig.duckScale) {
      wishSpeed = MoveConfig.speed * MoveConfig.duckScale;
    }
    if (state.waterLevel) {
      const waterScale = 1 - ((1 - MoveConfig.swimScale) * state.waterLevel) / 3;
      if (wishSpeed > MoveConfig.speed * waterScale) wishSpeed = MoveConfig.speed * waterScale;
    }

    const slick = (state.groundSurfaceFlags & Surface.SLICK) !== 0;
    this.accelerate(state, wishDir, wishSpeed, slick ? MoveConfig.airAccelerate : MoveConfig.accelerate);
    if (slick) state.velocity[2] -= MoveConfig.gravity * this.frametime;

    const speed = length(state.velocity);
    // Glisser le long du sol sans perdre de vitesse en montant une pente.
    state.velocity = clipVelocity(state.velocity, state.groundNormal, MoveConfig.overclip);
    normalize(state.velocity);
    state.velocity[0] *= speed;
    state.velocity[1] *= speed;
    state.velocity[2] *= speed;

    if (state.velocity[0] === 0 && state.velocity[1] === 0) return;
    this.stepSlideMove(state, false);
  }

  private airMove(state: MoveState, input: MoveInput): void {
    this.friction(state);
    const scale = this.commandScale(input);

    const forward: Vec3 = [this.forward[0], this.forward[1], 0];
    const right: Vec3 = [this.right[0], this.right[1], 0];
    normalize(forward);
    normalize(right);

    const wishDir: Vec3 = [
      forward[0] * input.forward + right[0] * input.right,
      forward[1] * input.forward + right[1] * input.right,
      0,
    ];
    const wishSpeed = normalize(wishDir) * scale;

    this.accelerate(state, wishDir, wishSpeed, MoveConfig.airAccelerate);
    // Une pente trop raide ne porte pas, mais elle devie quand meme.
    if (state.groundPlane) {
      state.velocity = clipVelocity(state.velocity, state.groundNormal, MoveConfig.overclip);
    }
    this.stepSlideMove(state, true);
  }

  private waterMove(state: MoveState, input: MoveInput): void {
    if (this.checkWaterJump(state, input)) {
      this.waterJumpMove(state);
      return;
    }
    this.friction(state);
    const scale = this.commandScale(input);

    let wishVelocity: Vec3;
    if (!scale) {
      // Sans commande, on coule doucement.
      wishVelocity = [0, 0, -60];
    } else {
      wishVelocity = [
        scale * (this.forward[0] * input.forward + this.right[0] * input.right),
        scale * (this.forward[1] * input.forward + this.right[1] * input.right),
        scale * (this.forward[2] * input.forward + this.right[2] * input.right) +
          scale * (input.jump ? 127 : input.up),
      ];
    }

    const wishDir: Vec3 = [...wishVelocity] as Vec3;
    let wishSpeed = normalize(wishDir);
    if (wishSpeed > MoveConfig.speed * MoveConfig.swimScale) {
      wishSpeed = MoveConfig.speed * MoveConfig.swimScale;
    }
    this.accelerate(state, wishDir, wishSpeed, MoveConfig.waterAccelerate);

    if (state.groundPlane && dot(state.velocity, state.groundNormal) < 0) {
      const speed = length(state.velocity);
      state.velocity = clipVelocity(state.velocity, state.groundNormal, MoveConfig.overclip);
      normalize(state.velocity);
      state.velocity[0] *= speed;
      state.velocity[1] *= speed;
      state.velocity[2] *= speed;
    }
    this.slideMove(state, false);
  }

  /** Sortie de l'eau : un mur devant et de la place au-dessus. */
  private checkWaterJump(state: MoveState, input: MoveInput): boolean {
    if (state.waterJumpTime > 0) return false;
    if (state.waterLevel !== 2) return false;
    if (input.forward <= 0 && !input.jump) return false;

    const flat: Vec3 = [this.forward[0], this.forward[1], 0];
    normalize(flat);
    const ahead: Vec3 = [
      state.origin[0] + flat[0] * 30,
      state.origin[1] + flat[1] * 30,
      state.origin[2] + 4,
    ];
    if ((this.world.pointContents(ahead) & Contents.SOLID) === 0) return false;

    // De la place juste au-dessus du rebord, sinon on reste dans l'eau.
    ahead[2] += 16;
    if (this.world.pointContents(ahead) !== 0) return false;

    state.velocity = [this.forward[0] * 200, this.forward[1] * 200, 350];
    state.waterJumpTime = 2;
    state.jumpHeld = true;
    return true;
  }

  private waterJumpMove(state: MoveState): void {
    // Aucun controle pendant la sortie de l'eau : on retombe, c'est tout.
    this.stepSlideMove(state, true);
    state.velocity[2] -= MoveConfig.gravity * this.frametime;
    if (state.velocity[2] < 0) state.waterJumpTime = 0;
  }

  /**
   * Avance en glissant sur les surfaces touchees. Jusqu'a cinq plans sont
   * combines : sur une arete, le mouvement suit la ligne d'intersection.
   */
  private slideMove(state: MoveState, gravity: boolean): boolean {
    const planes: Vec3[] = [];
    let endVelocity: Vec3 = [...state.velocity] as Vec3;

    if (gravity) {
      endVelocity = [state.velocity[0], state.velocity[1], state.velocity[2] - MoveConfig.gravity * this.frametime];
      // La gravite s'applique en deux moitiees, avant et apres le deplacement.
      state.velocity[2] = (state.velocity[2] + endVelocity[2]) * 0.5;
      if (state.groundPlane) {
        state.velocity = clipVelocity(state.velocity, state.groundNormal, MoveConfig.overclip);
      }
    }

    let timeLeft = this.frametime;
    if (state.groundPlane) planes.push([...state.groundNormal] as Vec3);
    planes.push(normalized(state.velocity));

    /*
     * Nombre de rebonds employes. C'est lui qui dit si le deplacement a ete
     * gene, et non le fait que la derniere tentative ait abouti : un pas qui
     * touche une marche puis glisse librement le long de sa face a bien ete
     * gene, et c'est ce qui doit declencher la montee de la marche. En
     * annoncant « libre » dans ce cas, le franchissement n'etait jamais
     * tente et le joueur restait plante devant la premiere marche de chaque
     * escalier, vitesse a zero.
     */
    let bumps = 0;
    for (let bump = 0; bump < 4; bump++) {
      bumps = bump;
      const end: Vec3 = [
        state.origin[0] + state.velocity[0] * timeLeft,
        state.origin[1] + state.velocity[1] * timeLeft,
        state.origin[2] + state.velocity[2] * timeLeft,
      ];
      const trace = this.trace(state.origin, end);

      if (trace.allSolid) {
        // Enfonce dans la geometrie : on annule le mouvement vertical.
        state.velocity[2] = 0;
        return true;
      }
      if (trace.fraction > 0) state.origin = [...trace.endPosition] as Vec3;
      if (trace.fraction === 1) break;

      timeLeft -= timeLeft * trace.fraction;
      if (planes.length >= MoveConfig.maxClipPlanes) {
        state.velocity = [0, 0, 0];
        return true;
      }

      // Deja touche ce plan pendant ce pas : on s'en ecarte un peu.
      const seen = planes.find((plane) => dot(plane, trace.normal) > 0.99);
      if (seen) {
        state.velocity[0] += trace.normal[0];
        state.velocity[1] += trace.normal[1];
        state.velocity[2] += trace.normal[2];
        continue;
      }
      planes.push([...trace.normal] as Vec3);

      let resolved: Vec3 | null = null;
      for (let i = 0; i < planes.length && !resolved; i++) {
        if (dot(state.velocity, planes[i]) >= 0.1) continue;
        let clipped = clipVelocity(state.velocity, planes[i], MoveConfig.overclip);
        let endClipped = clipVelocity(endVelocity, planes[i], MoveConfig.overclip);

        for (let j = 0; j < planes.length; j++) {
          if (j === i) continue;
          if (dot(clipped, planes[j]) >= 0.1) continue;
          clipped = clipVelocity(clipped, planes[j], MoveConfig.overclip);
          endClipped = clipVelocity(endClipped, planes[j], MoveConfig.overclip);
          // Toujours contre le premier plan : on suit l'arete entre les deux.
          if (dot(clipped, planes[i]) >= 0) continue;

          const crease: Vec3 = [
            planes[i][1] * planes[j][2] - planes[i][2] * planes[j][1],
            planes[i][2] * planes[j][0] - planes[i][0] * planes[j][2],
            planes[i][0] * planes[j][1] - planes[i][1] * planes[j][0],
          ];
          normalize(crease);
          const along = dot(crease, state.velocity);
          clipped = [crease[0] * along, crease[1] * along, crease[2] * along];
          const alongEnd = dot(crease, endVelocity);
          endClipped = [crease[0] * alongEnd, crease[1] * alongEnd, crease[2] * alongEnd];

          // Un troisieme plan bloque tout : le mouvement s'arrete.
          for (let k = 0; k < planes.length; k++) {
            if (k === i || k === j) continue;
            if (dot(clipped, planes[k]) < 0.1) {
              state.velocity = [0, 0, 0];
              return true;
            }
          }
        }
        resolved = clipped;
        endVelocity = endClipped;
      }

      if (resolved) state.velocity = resolved;
      /*
       * Le jeu d'origine n'arrete pas le mouvement quand la vitesse corrigee
       * s'oppose a celle de depart. Ajouter cette regle revenait a planter le
       * joueur des qu'un glissement le renvoyait legerement en arriere.
       */
    }

    if (gravity) state.velocity = endVelocity;
    return bumps !== 0;
  }

  /** Comme le glissement, mais en essayant de monter la marche rencontree. */
  private stepSlideMove(state: MoveState, gravity: boolean): void {
    const startOrigin: Vec3 = [...state.origin] as Vec3;
    const startVelocity: Vec3 = [...state.velocity] as Vec3;

    if (!this.slideMove(state, gravity)) return;

    // En pleine ascension, on ne s'accroche pas a une marche.
    const below: Vec3 = [startOrigin[0], startOrigin[1], startOrigin[2] - MoveConfig.stepSize];
    let trace = this.trace(startOrigin, below);
    if (state.velocity[2] > 0 && (trace.fraction === 1 || trace.normal[2] < 0.7)) return;

    const above: Vec3 = [startOrigin[0], startOrigin[1], startOrigin[2] + MoveConfig.stepSize];
    trace = this.trace(startOrigin, above);
    if (trace.allSolid) return;

    // Hauteur reellement disponible : le plafond peut la limiter.
    const stepSize = trace.endPosition[2] - startOrigin[2];
    state.origin = [...trace.endPosition] as Vec3;
    state.velocity = [...startVelocity] as Vec3;
    this.slideMove(state, gravity);

    // Puis on repose le joueur au sol.
    const down: Vec3 = [state.origin[0], state.origin[1], state.origin[2] - stepSize];
    trace = this.trace(state.origin, down);
    if (!trace.allSolid) state.origin = [...trace.endPosition] as Vec3;
    if (trace.fraction < 1) {
      state.velocity = clipVelocity(state.velocity, trace.normal, MoveConfig.overclip);
    }
    // Hauteur reellement gagnee : le rendu l'amortit sur la vue.
    const climbed = state.origin[2] - startOrigin[2];
    if (climbed > 0) state.stepped += climbed;
  }
}

function normalized(v: Vec3): Vec3 {
  const out: Vec3 = [...v] as Vec3;
  normalize(out);
  return out;
}
