import { Travel } from '../../formats/aas';
import type { Vec3 } from '../../formats/bsp';
import type { Arena, Fighter } from '../match/Arena';
import type { MoveInput } from '../physics';
import { WEAPONS, type WeaponId } from '../weapons/WeaponDefs';
import type { Navigation } from './Navigation';

/**
 * Conduite d'un bot.
 *
 * L'intelligence des bots du jeu est un sous-systeme entier : fichiers de
 * caractere, logique floue, objectifs a long terme, bavardage. Ce n'est pas ce
 * qu'on refait ici. Ce qu'il faut pour qu'une arene soit vivante est plus
 * court a decrire : aller chercher ce qui traine, engager ce qu'on voit,
 * garder la distance qui convient a son arme, esquiver, et viser avec un
 * defaut.
 *
 * Le deplacement passe par la meme simulation que le joueur : un bot n'est
 * qu'un jeu de commandes, forward, right, saut, angles. Il glisse donc dans
 * les couloirs, franchit les marches et se fait pousser par une roquette
 * exactement comme lui.
 *
 * Les chemins viennent du fichier de navigation de la carte, donc du
 * compilateur du jeu : les sauts que l'arene attend y sont deja.
 */

/** Cinq niveaux, ceux du jeu, du plus tendre au plus dur. */
export type BotSkill = 1 | 2 | 3 | 4 | 5;

export const SKILL_NAMES: Record<BotSkill, string> = {
  1: 'I CAN WIN',
  2: 'BRING IT ON',
  3: 'HURT ME PLENTY',
  4: 'HARDCORE',
  5: 'NIGHTMARE',
};

interface SkillProfile {
  /** Delai avant d'ouvrir le feu sur une cible qui apparait, en secondes. */
  reaction: number;
  /** Ecart de visee, en degres. */
  aimError: number;
  /** Vitesse de rotation, en radians par seconde. */
  turnRate: number;
  /** Anticipe le deplacement de la cible pour les armes a projectile. */
  leads: boolean;
  /** Se deplace lateralement pendant l'echange. */
  dodges: boolean;
  /** Part des tirs relaches volontairement, pour ne pas etre parfait. */
  hesitation: number;
}

const PROFILES: Record<BotSkill, SkillProfile> = {
  1: { reaction: 0.6, aimError: 7, turnRate: 3, leads: false, dodges: false, hesitation: 0.35 },
  2: { reaction: 0.45, aimError: 5, turnRate: 4, leads: false, dodges: true, hesitation: 0.22 },
  3: { reaction: 0.3, aimError: 3, turnRate: 5.5, leads: true, dodges: true, hesitation: 0.12 },
  4: { reaction: 0.2, aimError: 1.8, turnRate: 7, leads: true, dodges: true, hesitation: 0.05 },
  5: { reaction: 0.12, aimError: 0.9, turnRate: 9.5, leads: true, dodges: true, hesitation: 0 },
};

/**
 * Distance de confort de chaque arme. Un bot qui tient le fusil a pompe
 * cherche le contact, celui qui tient le railgun garde ses distances : c'est
 * ce qui donne des duels differents selon ce qu'il a ramasse.
 */
const COMFORT: Record<WeaponId, { best: number; min: number; max: number }> = {
  gauntlet: { best: 40, min: 0, max: 80 },
  machinegun: { best: 600, min: 0, max: 4000 },
  shotgun: { best: 200, min: 0, max: 700 },
  grenade: { best: 500, min: 150, max: 1200 },
  rocket: { best: 550, min: 120, max: 2000 },
  lightning: { best: 400, min: 0, max: 700 },
  railgun: { best: 1400, min: 200, max: 8000 },
  plasma: { best: 450, min: 0, max: 1200 },
  bfg: { best: 700, min: 200, max: 2000 },
};

/** Valeur d'un objet pour un bot, selon ce qui lui manque. */
const ITEM_VALUE = { weapon: 120, armor: 100, health: 70, ammo: 40, powerup: 200 } as const;

/** Au-dela, le bot renonce a une cible qu'il ne voit plus. */
const MEMORY = 3;
/** Le but est reexamine a cet intervalle, en secondes. */
const GOAL_INTERVAL = 1.5;
/** Recherche de zone complete a cet intervalle : elle coute plus cher. */
const AREA_INTERVAL = 0.4;

export class BotBrain {
  weapon: WeaponId = 'machinegun';
  firing = false;
  /** Direction de tir, normalisee. */
  readonly aimDirection: Vec3 = [1, 0, 0];

  private yaw = 0;
  private pitch = 0;
  private area = 0;
  private areaTimer = 0;
  private goalArea = 0;
  private goalPoint: Vec3 | null = null;
  private goalTimer = 0;
  private target: Fighter | null = null;
  private targetSeenAt = -100;
  private targetSince = -100;
  private lastKnown: Vec3 | null = null;
  private strafe = 1;
  private strafeTimer = 0;
  private jumpTimer = 0;
  private clock = 0;
  private stuckFor = 0;
  private readonly profile: SkillProfile;
  private readonly lastOrigin: Vec3 = [0, 0, 0];

  constructor(
    private readonly self: Fighter,
    private readonly arena: Arena,
    skill: BotSkill,
    private navigation: Navigation | null,
  ) {
    this.profile = PROFILES[skill];
    this.yaw = self.yaw;
  }

  reset(): void {
    this.target = null;
    this.goalArea = 0;
    this.goalPoint = null;
    this.goalTimer = 0;
    this.lastKnown = null;
    this.firing = false;
    this.yaw = this.self.yaw;
    this.pitch = 0;
    this.stuckFor = 0;
  }

  /**
   * La navigation de la carte arrive apres le debut de la partie : le fichier
   * se lit en fond, et un bot sans plan erre en attendant.
   */
  setNavigation(navigation: Navigation | null): void {
    this.navigation = navigation;
    this.goalArea = 0;
    this.goalTimer = 0;
  }

  /** Oriente le bot d'autorite : un teleporteur impose sa direction. */
  faceTo(yaw: number): void {
    this.yaw = yaw;
  }

  /**
   * Un tour de reflexion, rendu sous forme de commandes. Tout passe par la :
   * le bot ne touche jamais lui-meme a sa position.
   */
  think(delta: number, matchOver: boolean): MoveInput {
    this.clock += delta;
    this.areaTimer -= delta;
    this.goalTimer -= delta;
    this.strafeTimer -= delta;
    this.jumpTimer -= delta;

    this.updateArea(delta);
    this.chooseTarget();
    this.chooseWeapon();

    const desired = this.target ? this.fight(delta) : this.roam();
    this.aim(delta);
    this.firing = !matchOver && this.wantsToFire();

    return this.commands(desired);
  }

  /** Zone de navigation ou se trouve le bot. */
  private updateArea(delta: number): void {
    const navigation = this.navigation;
    if (!navigation) return;
    if (this.areaTimer > 0 && this.area > 0) return;
    this.areaTimer = AREA_INTERVAL;
    const found = navigation.areaNear(this.self.state.origin);
    if (found > 0) this.area = found;

    // Coince : si la position ne bouge plus alors qu'on avance, on change de
    // but plutot que de pousser un mur indefiniment.
    const origin = this.self.state.origin;
    const moved = Math.hypot(origin[0] - this.lastOrigin[0], origin[1] - this.lastOrigin[1]);
    this.lastOrigin[0] = origin[0];
    this.lastOrigin[1] = origin[1];
    this.lastOrigin[2] = origin[2];
    if (moved < 4) {
      this.stuckFor += AREA_INTERVAL;
      if (this.stuckFor > 1.2) {
        this.stuckFor = 0;
        this.goalArea = 0;
        this.goalPoint = null;
        this.goalTimer = 0;
        this.jumpTimer = 0;
        // Un demi-tour pour se degager, plutot qu'un blocage silencieux.
        this.yaw += Math.PI * (0.5 + Math.random() * 0.5);
      }
    } else {
      this.stuckFor = 0;
    }
    void delta;
  }

  /** Cible la plus interessante : la plus proche que l'on voit. */
  private chooseTarget(): void {
    const eye = this.arena.eyeOf(this.self);
    let best: Fighter | null = null;
    let bestDistance = Infinity;

    for (const fighter of this.arena.fighters) {
      if (fighter.id === this.self.id || !fighter.player.alive) continue;
      const center = this.arena.centerOf(fighter);
      const distance = Math.hypot(center[0] - eye[0], center[1] - eye[1], center[2] - eye[2]);
      if (distance >= bestDistance) continue;
      if (!this.arena.visible(eye, center, this.self.id, fighter.id)) continue;
      best = fighter;
      bestDistance = distance;
    }

    if (best) {
      if (this.target?.id !== best.id) this.targetSince = this.clock;
      this.target = best;
      this.targetSeenAt = this.clock;
      this.lastKnown = [...this.arena.centerOf(best)] as Vec3;
      return;
    }

    // Plus personne en vue : on garde la cible un instant, le temps d'aller
    // voir ou elle est passee.
    if (this.target && this.clock - this.targetSeenAt > MEMORY) {
      this.target = null;
    }
  }

  /**
   * Arme la plus adaptee a la distance, parmi celles que le bot porte et qui
   * ont des munitions.
   */
  private chooseWeapon(): void {
    const distance = this.target ? this.distanceTo(this.target) : 600;
    let best: WeaponId = 'gauntlet';
    let bestScore = -Infinity;

    for (const id of this.self.player.owned) {
      if (!this.self.player.canFire(id)) continue;
      const comfort = COMFORT[id];
      if (!comfort) continue;
      if (distance < comfort.min || distance > comfort.max) continue;
      // Les degats par seconde donnent le fond du classement, la distance
      // ideale l'ajuste : une roquette a bout portant se retourne contre soi.
      const definition = WEAPONS[id];
      const rate = definition.damage * (definition.pellets ?? 1) / Math.max(0.05, definition.fireDelay);
      const fit = 1 - Math.min(1, Math.abs(distance - comfort.best) / comfort.max);
      const score = rate * (0.4 + fit);
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    }

    this.weapon = best;
  }

  /** Echange de tirs : garder la distance, se decaler, sauter parfois. */
  private fight(delta: number): Vec3 {
    const target = this.target;
    if (!target) return this.roam();

    const origin = this.self.state.origin;
    const center = this.arena.centerOf(target);
    const toTarget: Vec3 = [center[0] - origin[0], center[1] - origin[1], 0];
    const distance = Math.hypot(toTarget[0], toTarget[1]) || 1;
    toTarget[0] /= distance;
    toTarget[1] /= distance;

    const comfort = COMFORT[this.weapon];
    // Approche ou recul selon la distance de confort de l'arme tenue.
    let advance = 0;
    if (distance > comfort.best * 1.3) advance = 1;
    else if (distance < comfort.best * 0.7) advance = -1;

    const desired: Vec3 = [toTarget[0] * advance, toTarget[1] * advance, 0];

    if (this.profile.dodges) {
      if (this.strafeTimer <= 0) {
        this.strafe = Math.random() < 0.5 ? -1 : 1;
        this.strafeTimer = 0.5 + Math.random() * 0.8;
      }
      // Perpendiculaire a la ligne de tir : c'est l'esquive du jeu.
      desired[0] += -toTarget[1] * this.strafe;
      desired[1] += toTarget[0] * this.strafe;
    }

    void delta;
    return normalize(desired);
  }

  /**
   * Hors combat : aller chercher quelque chose. Le but est choisi sur la
   * valeur de l'objet et le cout du chemin, puis suivi par le graphe de la
   * carte.
   */
  private roam(): Vec3 {
    const navigation = this.navigation;
    if (!navigation || this.area <= 0) return this.wanderBlind();

    if (this.goalTimer <= 0 || this.goalArea <= 0) {
      this.goalTimer = GOAL_INTERVAL;
      this.pickGoal();
    }

    // Une cible perdue de vue : on va voir ou elle etait.
    if (!this.goalArea && this.lastKnown) {
      this.goalArea = navigation.areaNear(this.lastKnown);
    }
    if (!this.goalArea) return this.wanderBlind();

    const step = navigation.step(this.area, this.goalArea);
    if (!step) {
      // Deja dans la zone du but : on marche sur le point exact.
      const point = this.goalPoint ?? navigation.areaCenter(this.goalArea);
      if (!point) return this.wanderBlind();
      return this.towards(point);
    }

    // Les sauts se declenchent en approchant du bord annonce.
    const origin = this.self.state.origin;
    const gap = Math.hypot(step.start[0] - origin[0], step.start[1] - origin[1]);
    if (
      (step.travel === Travel.JUMP || step.travel === Travel.BARRIERJUMP)
      && gap < 48
      && this.self.state.onGround
    ) {
      this.jumpTimer = 0.2;
    }

    return this.towards(gap > 24 ? step.start : step.end);
  }

  /** Choisit un but : un objet utile, sinon une zone au hasard. */
  private pickGoal(): void {
    const navigation = this.navigation;
    if (!navigation) return;
    const items = this.arena.goals;
    const origin = this.self.state.origin;
    let bestScore = -Infinity;
    let bestArea = 0;
    let bestPoint: Vec3 | null = null;

    for (const item of items) {
      const point: Vec3 = [item.position.x, item.position.y, item.position.z];
      const straight = Math.hypot(point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]);
      // Au-dela, l'objet n'entre plus en ligne de compte : le cout du chemin
      // se calcule sur les seuls candidats plausibles.
      if (straight > 2500) continue;

      let value: number = ITEM_VALUE[item.kind] ?? 40;
      if (item.kind === 'health' && this.self.player.health > 90) value *= 0.3;
      if (item.kind === 'armor' && this.self.player.armor > 100) value *= 0.3;
      if (item.kind === 'weapon' && item.weapon && this.self.player.owned.has(item.weapon as WeaponId)) {
        value *= 0.4;
      }

      const area = navigation.areaNear(point);
      if (area <= 0) continue;
      const cost = navigation.cost(this.area, area);
      if (!Number.isFinite(cost)) continue;
      const score = value - cost * 0.08;
      if (score > bestScore) {
        bestScore = score;
        bestArea = area;
        bestPoint = point;
      }
    }

    if (bestArea > 0) {
      this.goalArea = bestArea;
      this.goalPoint = bestPoint;
      return;
    }

    // Rien a ramasser : un point de depart au hasard, pour continuer a bouger.
    const spawns = this.arena.spawnPoints;
    if (spawns.length > 0) {
      const choice = spawns[Math.floor(Math.random() * spawns.length)];
      this.goalArea = navigation.areaNear(choice);
      this.goalPoint = [...choice] as Vec3;
    }
  }

  /** Sans navigation : on avance droit devant, en tournant sur obstacle. */
  private wanderBlind(): Vec3 {
    if (this.goalTimer <= 0) {
      this.goalTimer = 2 + Math.random() * 2;
      this.yaw += (Math.random() - 0.5) * Math.PI;
    }
    return [Math.cos(this.yaw), Math.sin(this.yaw), 0];
  }

  private towards(point: Vec3): Vec3 {
    const origin = this.self.state.origin;
    return normalize([point[0] - origin[0], point[1] - origin[1], 0]);
  }

  /**
   * Visee. Le bot tourne a vitesse bornee vers sa cible, avec un ecart qui
   * depend de son niveau : c'est cet ecart, et le temps de reaction, qui font
   * la difficulte, pas une precision retiree apres coup.
   */
  private aim(delta: number): void {
    const eye = this.arena.eyeOf(this.self);
    let point: Vec3 | null = this.target ? this.arena.centerOf(this.target) : this.lastKnown;

    if (point && this.target && this.profile.leads) {
      const definition = WEAPONS[this.weapon];
      if (definition.speed) {
        // Anticipation : la cible aura avance le temps que le projectile
        // arrive. Une seule passe suffit a rendre un tir credible.
        const velocity = this.target.state.velocity;
        const distance = Math.hypot(point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]);
        const travel = distance / definition.speed;
        point = [
          point[0] + velocity[0] * travel,
          point[1] + velocity[1] * travel,
          point[2] + velocity[2] * travel * 0.5,
        ];
      }
    }

    if (!point) {
      // Personne a viser : le regard suit la marche.
      this.pitch += (0 - this.pitch) * Math.min(1, delta * 4);
      this.setAimFromAngles();
      return;
    }

    const dx = point[0] - eye[0];
    const dy = point[1] - eye[1];
    const dz = point[2] - eye[2];
    const flat = Math.hypot(dx, dy) || 1;
    const wantedYaw = Math.atan2(dy, dx);
    const wantedPitch = -Math.atan2(dz, flat);

    // Ecart de visee, tire une fois par cible et lentement derive : un ecart
    // retire a chaque image donnerait un tremblement, pas une imprecision.
    const error = (this.profile.aimError * Math.PI) / 180;
    const wobble = Math.sin(this.clock * 1.7 + this.self.id) * error;
    const rate = this.profile.turnRate * delta;

    this.yaw = approachAngle(this.yaw, wantedYaw + wobble, rate);
    this.pitch = approachAngle(this.pitch, wantedPitch + wobble * 0.4, rate);
    this.setAimFromAngles();
  }

  private setAimFromAngles(): void {
    const cp = Math.cos(this.pitch);
    this.aimDirection[0] = cp * Math.cos(this.yaw);
    this.aimDirection[1] = cp * Math.sin(this.yaw);
    this.aimDirection[2] = -Math.sin(this.pitch);
  }

  /** Feu : cible vue depuis assez longtemps, dans l'axe, et a portee. */
  private wantsToFire(): boolean {
    const target = this.target;
    if (!target || !target.player.alive) return false;
    if (this.clock - this.targetSince < this.profile.reaction) return false;
    if (!this.self.player.canFire(this.weapon)) return false;

    const distance = this.distanceTo(target);
    const comfort = COMFORT[this.weapon];
    if (distance > comfort.max) return false;

    // Dans l'axe : sans cela un bot tire dans le mur en tournant.
    const eye = this.arena.eyeOf(this.self);
    const center = this.arena.centerOf(target);
    const toTarget = normalize([center[0] - eye[0], center[1] - eye[1], center[2] - eye[2]]);
    const aligned =
      toTarget[0] * this.aimDirection[0]
      + toTarget[1] * this.aimDirection[1]
      + toTarget[2] * this.aimDirection[2];
    if (aligned < 0.985) return false;

    // Une roquette a bout portant blesse celui qui la tire : il s'en abstient.
    if (WEAPONS[this.weapon].splashRadius && distance < 150) return false;

    // Hesitation : les niveaux faibles relachent la detente par moments.
    if (this.profile.hesitation > 0 && Math.sin(this.clock * 3.3 + this.self.id * 2) < -1 + this.profile.hesitation * 2) {
      return false;
    }
    return true;
  }

  private distanceTo(fighter: Fighter): number {
    const a = this.self.state.origin;
    const b = fighter.state.origin;
    return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }

  /** Traduit une direction du monde en commandes, comme une manette. */
  private commands(desired: Vec3): MoveInput {
    const cos = Math.cos(this.yaw);
    const sin = Math.sin(this.yaw);
    // Repere du jeu : l'avant suit le lacet, la droite est a quatre-vingt-dix
    // degres dans le sens des aiguilles.
    const forward = desired[0] * cos + desired[1] * sin;
    const right = desired[0] * sin - desired[1] * cos;

    return {
      forward: Math.round(Math.max(-1, Math.min(1, forward)) * 127),
      right: Math.round(Math.max(-1, Math.min(1, right)) * 127),
      up: 0,
      jump: this.jumpTimer > 0,
      crouch: false,
      yaw: this.yaw,
      pitch: this.pitch,
    };
  }
}

function normalize(vector: Vec3): Vec3 {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (length < 1e-6) return [0, 0, 0];
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

/** Rapproche un angle d'un autre par le plus court chemin, vitesse bornee. */
function approachAngle(current: number, wanted: number, rate: number): number {
  let delta = wanted - current;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  if (Math.abs(delta) <= rate) return wanted;
  return current + Math.sign(delta) * rate;
}
