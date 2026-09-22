import * as THREE from 'three';
import { MASK_SHOT, type Vec3 } from '../../formats/bsp';
import type { BeamSystem } from '../../renderer/effects/BeamSystem';
import type { Effects } from '../../renderer/effects/Effects';
import { PLAYER_MAXS, PLAYER_MINS, type TraceResult } from '../collision';
import type { ItemManager } from '../entities/Items';
import type { Level } from '../level';
import { PlayerMove, createMoveState, resetMoveState, type MoveInput, type MoveState } from '../physics';
import { PlayerState } from '../PlayerState';
import { WEAPONS, type WeaponId } from '../weapons/WeaponDefs';
import { WeaponSystem } from '../weapons/WeaponSystem';
import { BotBrain, type BotSkill } from '../bots/BotBrain';
import type { Navigation } from '../bots/Navigation';
import { loadPlayerAssets, PlayerModel } from './PlayerModel';

/**
 * Partie individuelle : un humain, des bots, une limite de frags et une
 * limite de temps.
 *
 * L'arene tient la liste des combattants et arbitre : elle place les corps
 * dans les traces de tir, applique les degats avec les chiffres du jeu,
 * compte les frags, fait reapparaitre les morts et annonce la fin. Elle ne
 * dessine rien et ne lit aucune commande : la session lui confie l'humain,
 * dont elle partage l'etat, et fabrique elle-meme ses bots.
 *
 * Le mode s'appelle Free For All, comme dans le jeu, et non deathmatch.
 */

export type FighterKind = 'human' | 'bot';

export interface Fighter {
  id: number;
  name: string;
  kind: FighterKind;
  /** Etat de deplacement : partage avec la session pour l'humain. */
  state: MoveState;
  player: PlayerState;
  /** Simulation propre au bot ; l'humain est pousse par la session. */
  move: PlayerMove | null;
  weapons: WeaponSystem;
  brain: BotBrain | null;
  /** Orientation, en radians. */
  yaw: number;
  pitch: number;
  score: number;
  deaths: number;
  /** Temps restant avant de pouvoir reapparaitre, en secondes. */
  respawnIn: number;
  /** Dernier a l'avoir touche, pour attribuer un frag a la lave. */
  lastAttacker: number;
  lastAttackerAt: number;
  /** Nom du modele du jeu qui l'incarne, quand il y en a un. */
  model: string;
}

export interface ArenaRules {
  /** Frags a atteindre pour gagner. Zero : pas de limite. */
  fragLimit: number;
  /** Duree de la partie, en secondes. Zero : pas de limite. */
  timeLimit: number;
  /** Nombre de bots en piste. */
  bots: number;
  skill: BotSkill;
}

export const DEFAULT_RULES: ArenaRules = {
  fragLimit: 20,
  timeLimit: 600,
  bots: 7,
  skill: 3,
};

export interface KillNotice {
  attacker: string;
  victim: string;
  weapon: WeaponId | 'world';
  /** L'un des deux est l'humain : le journal le met en avant. */
  attackerIsHuman: boolean;
  victimIsHuman: boolean;
  selfInflicted: boolean;
}

/** Sons que l'arene declenche. La session branche ceux du jeu. */
export interface ArenaSounds {
  fireAt(weapon: WeaponId, position: Vec3): void;
  pain(position: Vec3, health: number): void;
  death(position: Vec3): void;
  hitConfirm(damage: number): void;
  announce(name: 'fight' | 'oneFrag' | 'twoFrags' | 'threeFrags' | 'oneMinute' | 'fiveMinutes'
    | 'excellent' | 'impressive' | 'humiliation' | 'youWin' | 'takenLead' | 'lostLead'): void;
}

/**
 * Noms des combattants du jeu, avec le modele qui les incarne. Les modeles
 * sont ceux de pak0 ; si l'un manque, le bot reste jouable sans corps.
 */
const ROSTER: { name: string; model: string }[] = [
  { name: 'Sarge', model: 'sarge' },
  { name: 'Grunt', model: 'grunt' },
  { name: 'Major', model: 'major' },
  { name: 'Visor', model: 'visor' },
  { name: 'Klesk', model: 'klesk' },
  { name: 'Ranger', model: 'ranger' },
  { name: 'Bitterman', model: 'bitterman' },
  { name: 'Mynx', model: 'mynx' },
  { name: 'Orbb', model: 'orbb' },
  { name: 'Slash', model: 'slash' },
  { name: 'Anarki', model: 'anarki' },
];

/** Delai avant de reapparaitre : court, comme dans une partie du jeu. */
const RESPAWN_DELAY = 1.2;
/** Un frag attribue a celui qui vous a touche juste avant la chute. */
const ASSIST_WINDOW = 5;
/** Deux frags dans cet intervalle valent la voix de l'annonceur. */
const EXCELLENT_WINDOW = 2;

export class Arena {
  readonly fighters: Fighter[] = [];
  readonly rules: ArenaRules;
  private level: Level | null = null;
  private items: ItemManager | null = null;
  private navigation: Navigation | null = null;
  private elapsed = 0;
  private running = false;
  private finished = false;
  private announcedFrags = 0;
  private announcedMinutes = 0;
  private humanLeading = false;
  private lastHumanFrag = -100;
  private readonly eye = new THREE.Vector3();
  private readonly aim = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();
  /** Corps des bots, charges depuis les archives, par combattant. */
  private readonly models = new Map<number, PlayerModel>();
  /** Temps depuis la mort, pour laisser l'animation se jouer. */
  private readonly deadFor = new Map<number, number>();

  /** Prevenu de chaque elimination : le journal de l'interface s'en nourrit. */
  onKill: ((notice: KillNotice) => void) | null = null;
  /** Prevenu quand l'humain prend des degats, avec la direction du tir. */
  onHumanDamage: ((amount: number, from: Vec3) => void) | null = null;
  /** Prevenu quand l'humain touche quelqu'un. */
  onHumanHit: ((kill: boolean) => void) | null = null;
  /** Prevenu quand le score de l'humain change. */
  onScore: ((score: number) => void) | null = null;
  /** Prevenu a la fin de la partie, avec le classement. */
  onEnd: ((standings: Fighter[]) => void) | null = null;
  /**
   * Prevenu quand l'humain reapparait : la session tient ses angles de vue et
   * ses effets de camera, que l'arene ne connait pas.
   */
  onHumanSpawn: (() => void) | null = null;

  constructor(
    private readonly effects: Effects,
    private readonly beams: BeamSystem,
    private readonly sounds: ArenaSounds,
    rules: Partial<ArenaRules> = {},
  ) {
    this.rules = { ...DEFAULT_RULES, ...rules };
  }

  get time(): number {
    return this.elapsed;
  }

  /** Temps restant, ou le temps ecoule quand la partie n'a pas de limite. */
  get remaining(): number {
    return this.rules.timeLimit > 0 ? Math.max(0, this.rules.timeLimit - this.elapsed) : this.elapsed;
  }

  get over(): boolean {
    return this.finished;
  }

  get human(): Fighter | null {
    return this.fighters.find((fighter) => fighter.kind === 'human') ?? null;
  }

  /**
   * Objets encore disponibles, pour les bots qui cherchent ou aller. La liste
   * vient de la carte : ni cible inventee, ni objet cache aux bots.
   */
  get goals(): { position: THREE.Vector3; kind: 'health' | 'armor' | 'ammo' | 'weapon' | 'powerup'; weapon?: string }[] {
    return this.items?.goals ?? [];
  }

  /** Points d'apparition de la carte : de quoi errer quand rien ne traine. */
  get spawnPoints(): Vec3[] {
    return this.level?.spawns.map((spawn) => spawn.origin) ?? [];
  }

  /** Classement, du meilleur au dernier. */
  get standings(): Fighter[] {
    return [...this.fighters].sort((a, b) => b.score - a.score || a.deaths - b.deaths);
  }

  /**
   * Ouvre une partie sur une carte. L'humain est confie par la session, qui
   * garde la main sur ses commandes ; les bots sont fabriques ici.
   */
  open(options: {
    level: Level;
    items: ItemManager | null;
    navigation: Navigation | null;
    humanState: MoveState;
    humanPlayer: PlayerState;
    humanWeapons: WeaponSystem;
    parent: THREE.Object3D;
  }): void {
    this.close();
    this.level = options.level;
    this.items = options.items;
    this.navigation = options.navigation;

    const human: Fighter = {
      id: 0,
      name: 'You',
      kind: 'human',
      state: options.humanState,
      player: options.humanPlayer,
      move: null,
      weapons: options.humanWeapons,
      brain: null,
      yaw: 0,
      pitch: 0,
      score: 0,
      deaths: 0,
      respawnIn: 0,
      lastAttacker: -1,
      lastAttackerAt: -100,
      model: '',
    };
    this.fighters.push(human);
    this.wire(human);

    const roster = shuffle(ROSTER).slice(0, Math.max(0, this.rules.bots));
    for (const entry of roster) {
      const state = createMoveState([0, 0, 0]);
      const fighter: Fighter = {
        id: this.fighters.length,
        name: entry.name,
        kind: 'bot',
        state,
        player: new PlayerState(),
        move: new PlayerMove(options.level.collision),
        // Les bots partagent les effets du monde : leurs tirs se voient et
        // s'entendent comme ceux du joueur.
        weapons: new WeaponSystem(this.effects, this.beams, 12),
        brain: null,
        yaw: 0,
        pitch: 0,
        score: 0,
        deaths: 0,
        respawnIn: 0,
        lastAttacker: -1,
        lastAttackerAt: -100,
        model: entry.model,
      };
      fighter.brain = new BotBrain(fighter, this, this.rules.skill, this.navigation);
      fighter.weapons.attach(options.parent);
      this.fighters.push(fighter);
      this.wire(fighter);
      this.loadBody(fighter, options.level, options.parent);
    }

    for (const fighter of this.fighters) this.spawn(fighter);
    this.elapsed = 0;
    this.running = true;
    this.finished = false;
    this.announcedFrags = 0;
    this.announcedMinutes = 0;
    this.humanLeading = false;
    this.sounds.announce('fight');
  }

  /**
   * Charge le corps d'un bot : trois pieces, une peau et un fichier
   * d'animations, pris dans les archives du joueur. Un modele absent laisse
   * le bot jouable et invisible plutot que d'interrompre la partie.
   */
  private loadBody(fighter: Fighter, level: Level, parent: THREE.Object3D): void {
    const vfs = level.vfs;
    if (!vfs || !fighter.model) return;
    void loadPlayerAssets(vfs, fighter.model).then((assets) => {
      if (!assets || !this.fighters.includes(fighter)) return;
      const model = new PlayerModel(assets, level.textures ?? null, level.shaders ?? null, vfs);
      parent.add(model.group);
      this.models.set(fighter.id, model);
    });
  }

  /**
   * Donne la navigation aux bots, partie commencee. Le fichier de la carte se
   * lit en fond : la partie demarre sans lui plutot que d'attendre.
   */
  setNavigation(navigation: Navigation | null): void {
    this.navigation = navigation;
    for (const fighter of this.fighters) fighter.brain?.setNavigation(navigation);
  }

  close(): void {
    for (const model of this.models.values()) model.dispose();
    this.models.clear();
    this.deadFor.clear();
    for (const fighter of this.fighters) {
      fighter.weapons.clear();
      fighter.weapons.onDamage = null;
      fighter.weapons.projectiles.onDetonate = null;
    }
    this.fighters.length = 0;
    this.running = false;
    this.finished = false;
    this.level = null;
    this.items = null;
  }

  /**
   * Branche les armes d'un combattant sur les traces et les degats.
   *
   * L'humain garde les rappels que la session lui a poses : recul de la vue,
   * son dans les mains, evenements d'interface. On ne lui ajoute que ce qui
   * regarde l'arene, c'est-a-dire qui il touche.
   */
  private wire(fighter: Fighter): void {
    const weapons = fighter.weapons;
    weapons.owner = fighter.id;
    weapons.setTrace((start, end, mins, maxs, mask) =>
      this.trace(start, end, mins, maxs, mask, fighter.id),
    );
    weapons.onDamage = (target, definition, point, direction) => {
      this.hit(fighter.id, target, definition.damage, definition.id, direction, point);
    };
    weapons.projectiles.onDetonate = (weapon, point, owner, direct) => {
      this.explode(weapon, point, owner, direct);
    };
    if (fighter.kind === 'human') return;

    weapons.canFire = (weapon) => fighter.player.owned.has(weapon) && fighter.player.canFire(weapon);
    weapons.onFired = (definition) => {
      fighter.player.consume(definition.id);
      this.sounds.fireAt(definition.id, this.eyeOf(fighter));
    };
  }

  /**
   * Trace du decor et des corps. Le decor est trace comme d'habitude, puis
   * chaque combattant vivant est teste comme une boite : la plus proche
   * l'emporte. C'est ainsi que le jeu procede, et c'est ce qui permet a un
   * couloir de proteger celui qui s'y cache.
   */
  trace(start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3, mask: number, ignore = -1): TraceResult {
    const world = this.level
      ? this.level.collision.trace(start, end, mins, maxs, mask)
      : emptyTrace(end);
    let best = world.fraction;
    let struck = -1;

    for (const fighter of this.fighters) {
      if (fighter.id === ignore || !fighter.player.alive) continue;
      // Boite du corps, elargie de celle du projectile : un rayon et une
      // boite qui se croisent se ramenent a un rayon et une boite plus grande.
      const origin = fighter.state.origin;
      const low: Vec3 = [
        origin[0] + PLAYER_MINS[0] - maxs[0],
        origin[1] + PLAYER_MINS[1] - maxs[1],
        origin[2] + PLAYER_MINS[2] - maxs[2],
      ];
      const high: Vec3 = [
        origin[0] + PLAYER_MAXS[0] - mins[0],
        origin[1] + PLAYER_MAXS[1] - mins[1],
        origin[2] + fighter.state.viewHeight + 6 - mins[2],
      ];
      const fraction = rayBox(start, end, low, high, best);
      if (fraction === null) continue;
      best = fraction;
      struck = fighter.id;
    }

    if (struck < 0) return world;

    const direction: Vec3 = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
    return {
      fraction: best,
      endPosition: [
        start[0] + direction[0] * best,
        start[1] + direction[1] * best,
        start[2] + direction[2] * best,
      ],
      // La normale n'a pas de sens sur un corps : on renvoie le tir.
      normal: normalizeInverse(direction),
      startSolid: false,
      allSolid: false,
      surfaceFlags: 0,
      contents: 0,
      entity: struck,
    };
  }

  /** Position de l'oeil d'un combattant, d'ou partent ses tirs. */
  eyeOf(fighter: Fighter): Vec3 {
    const origin = fighter.state.origin;
    return [origin[0], origin[1], origin[2] + fighter.state.viewHeight];
  }

  /** Centre du corps, ou l'on vise. */
  centerOf(fighter: Fighter): Vec3 {
    const origin = fighter.state.origin;
    return [origin[0], origin[1], origin[2] + fighter.state.viewHeight * 0.6];
  }

  /**
   * Y a-t-il une ligne de vue degagee entre ces deux points ?
   *
   * Le masque est celui des tirs, pas celui des deplacements : une carte pose
   * des volumes qui arretent les joueurs sans arreter les balles, autour d'une
   * nappe de lave par exemple. Les compter comme des murs rend les bots
   * aveugles au milieu d'une piece degagee.
   */
  visible(from: Vec3, to: Vec3, ignore: number, expect = -1): boolean {
    if (!this.level) return false;
    const hit = this.trace(from, to, [0, 0, 0], [0, 0, 0], MASK_SHOT, ignore);
    if (hit.fraction >= 0.999) return true;
    // Le corps vise arrete la trace : c'est bien qu'on le voit. Un autre
    // corps sur le trajet, en revanche, le couvre.
    return expect >= 0 && hit.entity === expect;
  }

  /**
   * Degats d'un coup porte. L'armure absorbe sa part dans l'etat du
   * combattant ; ici on decide qui marque, ce que l'on entend, et la poussee.
   */
  private hit(
    attackerId: number,
    targetId: number,
    amount: number,
    weapon: WeaponId,
    direction: Vec3,
    point: Vec3,
  ): void {
    const target = this.fighters[targetId];
    const attacker = this.fighters[attackerId];
    if (!target || !target.player.alive || this.finished) return;

    // Se blesser soi-meme coute moitie moins, comme dans le jeu.
    const damage = attackerId === targetId ? Math.floor(amount * 0.5) : amount;
    if (damage <= 0) return;

    const before = target.player.health;
    target.player.damage(damage);
    target.lastAttacker = attackerId;
    target.lastAttackerAt = this.elapsed;

    // Poussee : elle fait decoller un corps touche par une roquette.
    const push = Math.min(damage, 200) * (weapon === 'railgun' ? 2 : 5);
    target.state.velocity[0] += direction[0] * push * 0.25;
    target.state.velocity[1] += direction[1] * push * 0.25;
    target.state.velocity[2] += Math.max(direction[2], 0.25) * push * 0.25;

    this.bleed(point, direction);

    if (target.player.alive) {
      this.sounds.pain(this.centerOf(target), target.player.health);
    }
    if (attacker && attackerId !== targetId) {
      if (attacker.kind === 'human') {
        this.sounds.hitConfirm(Math.min(before, damage));
        this.onHumanHit?.(!target.player.alive);
      }
    }
    if (target.kind === 'human') {
      this.onHumanDamage?.(damage, direction);
    }

    if (!target.player.alive) this.kill(targetId, attackerId, weapon);
  }

  /**
   * Explosion : degats de plein fouet, puis degats de souffle qui decroissent
   * avec la distance et traversent ce qui ne bloque pas la vue.
   */
  private explode(weapon: WeaponId, point: Vec3, owner: number, direct: number): void {
    const definition = WEAPONS[weapon];
    const splash = definition.splashDamage ?? 0;
    const radius = definition.splashRadius ?? 0;

    if (direct >= 0) {
      const target = this.fighters[direct];
      if (target) {
        const center = this.centerOf(target);
        this.hit(owner, direct, definition.damage, weapon, direction(point, center), point);
      }
    }

    if (splash <= 0 || radius <= 0) return;
    for (const fighter of this.fighters) {
      if (!fighter.player.alive || fighter.id === direct) continue;
      const center = this.centerOf(fighter);
      const distance = Math.hypot(center[0] - point[0], center[1] - point[1], center[2] - point[2]);
      if (distance >= radius) continue;
      // Decroissance lineaire, comme dans le jeu.
      const amount = Math.round(splash * (1 - distance / radius));
      if (amount <= 0) continue;
      if (!this.visible(point, center, -1, fighter.id)) continue;
      this.hit(owner, fighter.id, amount, weapon, direction(point, center), center);
    }
  }

  /**
   * Gerbe au point touche. Quelques particules rouges projetees a l'oppose du
   * tir : le jeu pose un modele, ici le rendu s'en charge, et cela suffit a
   * dire qu'on a touche quelqu'un et non un mur.
   */
  private bleed(point: Vec3, direction: Vec3): void {
    for (let i = 0; i < 8; i++) {
      this.scratch.set(
        -direction[0] + (Math.random() - 0.5) * 0.9,
        -direction[1] + (Math.random() - 0.5) * 0.9,
        -direction[2] + Math.random() * 0.6,
      );
      this.effects.particles.spawn({
        position: new THREE.Vector3(point[0], point[1], point[2]),
        velocity: this.scratch.clone().multiplyScalar(60 + Math.random() * 90),
        gravity: 500,
        drag: 1.4,
        size: 3 + Math.random() * 3,
        sizeEnd: 1,
        color: new THREE.Color(0.45, 0.02, 0.03),
        colorEnd: new THREE.Color(0.12, 0.01, 0.01),
        opacity: 0.95,
        opacityEnd: 0,
        lifetime: 0.5 + Math.random() * 0.4,
        kind: 'spark',
      });
    }
  }

  /** Degats du decor : lave, chute, sortie de carte. */
  hurt(fighterId: number, amount: number, cause: 'lava' | 'fall' | 'void'): void {
    const fighter = this.fighters[fighterId];
    if (!fighter || !fighter.player.alive) return;
    fighter.player.damage(amount);
    if (fighter.player.alive) {
      if (cause !== 'fall') this.sounds.pain(this.centerOf(fighter), fighter.player.health);
      return;
    }
    // Mort par le decor : le dernier a avoir touche recolte le frag, comme
    // dans le jeu, sinon la victime perd un point.
    const recent = this.elapsed - fighter.lastAttackerAt < ASSIST_WINDOW ? fighter.lastAttacker : -1;
    this.kill(fighterId, recent, 'world');
  }

  private kill(victimId: number, attackerId: number, weapon: WeaponId | 'world'): void {
    const victim = this.fighters[victimId];
    if (!victim) return;
    const attacker = attackerId >= 0 ? this.fighters[attackerId] : null;

    victim.player.alive = false;
    victim.deaths++;
    victim.respawnIn = RESPAWN_DELAY;
    victim.weapons.setFiring(false);
    this.sounds.death(this.centerOf(victim));

    const selfInflicted = !attacker || attacker.id === victim.id;
    if (selfInflicted) {
      // Se tuer soi-meme coute un frag, comme dans le jeu.
      victim.score = Math.max(-99, victim.score - 1);
    } else {
      attacker.score++;
      if (attacker.kind === 'human') {
        this.onScore?.(attacker.score);
        if (weapon === 'gauntlet') this.sounds.announce('humiliation');
        else if (this.elapsed - this.lastHumanFrag < EXCELLENT_WINDOW) this.sounds.announce('excellent');
        this.lastHumanFrag = this.elapsed;
      }
    }
    if (victim.kind === 'human') this.onScore?.(victim.score);

    this.onKill?.({
      attacker: attacker && !selfInflicted ? attacker.name : victim.name,
      victim: victim.name,
      weapon,
      attackerIsHuman: Boolean(attacker && attacker.kind === 'human' && !selfInflicted),
      victimIsHuman: victim.kind === 'human',
      selfInflicted,
    });

    this.checkLead();
    this.checkLimits();
  }

  /**
   * Place un combattant sur un point d'apparition. Le jeu choisit le point le
   * plus loin des vivants, avec une part de hasard pour ne pas tomber toujours
   * au meme endroit.
   */
  spawn(fighter: Fighter): void {
    const level = this.level;
    if (!level || level.spawns.length === 0) return;

    const ranked = level.spawns
      .map((spawn) => {
        let nearest = Infinity;
        for (const other of this.fighters) {
          if (other.id === fighter.id || !other.player.alive) continue;
          const origin = other.state.origin;
          const distance = Math.hypot(
            spawn.origin[0] - origin[0],
            spawn.origin[1] - origin[1],
            spawn.origin[2] - origin[2],
          );
          nearest = Math.min(nearest, distance);
        }
        return { spawn, nearest };
      })
      .sort((a, b) => b.nearest - a.nearest);

    const choice = ranked[Math.floor(Math.random() * Math.min(3, ranked.length))].spawn;
    resetMoveState(fighter.state, [...choice.origin] as Vec3);
    fighter.player.reset();
    fighter.yaw = choice.yaw;
    fighter.pitch = 0;
    fighter.respawnIn = 0;
    fighter.lastAttacker = -1;
    fighter.weapons.clear();
    fighter.weapons.select('machinegun');
    fighter.brain?.reset();
    if (fighter.kind === 'human') this.onHumanSpawn?.();
  }

  /**
   * Avance la partie : les bots pensent et se deplacent, les morts
   * reapparaissent, les limites sont verifiees. L'humain est deplace par la
   * session, on ne touche qu'a son etat de combat.
   */
  update(delta: number, viewer: THREE.Vector3): void {
    if (!this.running || !this.level) return;
    if (!this.finished) this.elapsed += delta;

    for (const fighter of this.fighters) {
      if (!fighter.player.alive) {
        fighter.respawnIn -= delta;
        // Le corps garde son animation de mort un instant avant de partir.
        const dead = (this.deadFor.get(fighter.id) ?? 0) + delta;
        this.deadFor.set(fighter.id, dead);
        this.poseBody(fighter, delta, dead < 2.5);
        // L'humain choisit quand repartir ; les bots repartent aussitot.
        if (fighter.respawnIn <= 0 && fighter.kind === 'bot' && !this.finished) this.spawn(fighter);
        continue;
      }
      this.deadFor.set(fighter.id, 0);

      // L'exces de sante de l'humain redescend cote session, qui tient son
      // etat : le faire ici le ferait deux fois.
      if (fighter.kind === 'bot') {
        fighter.player.update(delta);
        this.advanceBot(fighter, delta, viewer);
      }
      this.poseBody(fighter, delta, true);
      this.checkWorld(fighter);
    }

    this.checkLimits();
  }

  /** Un bot decide, se deplace, ramasse et tire. */
  private advanceBot(fighter: Fighter, delta: number, viewer: THREE.Vector3): void {
    const brain = fighter.brain;
    const level = this.level;
    if (!brain || !level || !fighter.move) return;

    const input: MoveInput = brain.think(delta, this.finished);
    fighter.move.step(fighter.state, input, delta);
    fighter.yaw = input.yaw;
    fighter.pitch = input.pitch;

    const effect = level.triggers?.apply(fighter.state, (yaw) => {
      fighter.yaw = yaw;
      brain.faceTo(yaw);
    });
    if (effect === 'respawn') {
      this.hurt(fighter.id, 1000, 'lava');
      return;
    }

    // Les bots ramassent ce qu'ils touchent, comme le joueur.
    this.items?.gather(fighter.state.origin, fighter.player);

    const eye = this.eyeOf(fighter);
    this.eye.set(eye[0], eye[1], eye[2]);
    const aim = brain.aimDirection;
    this.aim.set(aim[0], aim[1], aim[2]);
    fighter.weapons.select(brain.weapon);
    fighter.weapons.setFiring(brain.firing);
    fighter.weapons.update(delta, this.eye, this.aim);
    void viewer;
  }

  /**
   * Pose le corps d'un combattant. Le joueur ne voit pas le sien : il est a la
   * premiere personne, et son arme est un modele a part.
   */
  private poseBody(fighter: Fighter, delta: number, visible: boolean): void {
    const model = this.models.get(fighter.id);
    if (!model) return;
    if (!visible || fighter.kind === 'human') {
      model.hide();
      return;
    }
    model.setWeapon(fighter.weapons.currentId);
    model.update(delta, {
      origin: [...fighter.state.origin] as [number, number, number],
      yaw: fighter.yaw,
      pitch: fighter.pitch,
      velocity: [...fighter.state.velocity] as [number, number, number],
      onGround: fighter.state.onGround,
      ducked: fighter.state.ducked,
      firing: fighter.brain?.firing ?? false,
      alive: fighter.player.alive,
    });
  }

  /** Lave, sol mortel et sortie de carte. */
  private checkWorld(fighter: Fighter): void {
    const level = this.level;
    if (!level) return;
    if (level.floor !== undefined && fighter.state.origin[2] < level.floor) {
      this.hurt(fighter.id, 1000, 'void');
    }
  }

  /** L'humain repart quand il le demande, une fois le delai passe. */
  respawnHuman(): boolean {
    const human = this.human;
    if (!human || human.player.alive || human.respawnIn > 0 || this.finished) return false;
    this.spawn(human);
    return true;
  }

  /** Annonces de fin de partie approchante, comme le jeu les donne. */
  private checkLimits(): void {
    if (this.finished) return;
    const leader = this.standings[0];
    const limit = this.rules.fragLimit;

    if (limit > 0 && leader) {
      const left = limit - leader.score;
      if (left <= 3 && left > 0 && left !== this.announcedFrags) {
        this.announcedFrags = left;
        this.sounds.announce(left === 1 ? 'oneFrag' : left === 2 ? 'twoFrags' : 'threeFrags');
      }
      if (leader.score >= limit) return this.finish();
    }

    if (this.rules.timeLimit > 0) {
      const minutes = Math.ceil(this.remaining / 60);
      if ((minutes === 1 || minutes === 5) && minutes !== this.announcedMinutes) {
        this.announcedMinutes = minutes;
        this.sounds.announce(minutes === 1 ? 'oneMinute' : 'fiveMinutes');
      }
      if (this.remaining <= 0) return this.finish();
    }
  }

  /** Voix qui signale la prise ou la perte de la tete du classement. */
  private checkLead(): void {
    const human = this.human;
    if (!human) return;
    const leading = this.standings[0]?.id === human.id && human.score > 0;
    if (leading === this.humanLeading) return;
    this.humanLeading = leading;
    this.sounds.announce(leading ? 'takenLead' : 'lostLead');
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    for (const fighter of this.fighters) fighter.weapons.setFiring(false);
    const standings = this.standings;
    if (standings[0]?.kind === 'human') this.sounds.announce('youWin');
    this.onEnd?.(standings);
  }
}

/** Direction normalisee d'un point vers un autre. */
function direction(from: Vec3, to: Vec3): Vec3 {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const length = Math.hypot(dx, dy, dz) || 1;
  return [dx / length, dy / length, dz / length];
}

function normalizeInverse(vector: Vec3): Vec3 {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [-vector[0] / length, -vector[1] / length, -vector[2] / length];
}

/**
 * Rencontre d'un segment et d'une boite : rend la part du trajet au contact,
 * ou rien. Les trois axes se traitent comme des tranches, et l'entree la plus
 * tardive doit rester avant la sortie la plus precoce.
 */
function rayBox(start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3, limit: number): number | null {
  let enter = 0;
  let exit = limit;

  for (let axis = 0; axis < 3; axis++) {
    const delta = end[axis] - start[axis];
    if (Math.abs(delta) < 1e-6) {
      if (start[axis] < mins[axis] || start[axis] > maxs[axis]) return null;
      continue;
    }
    let near = (mins[axis] - start[axis]) / delta;
    let far = (maxs[axis] - start[axis]) / delta;
    if (near > far) [near, far] = [far, near];
    enter = Math.max(enter, near);
    exit = Math.min(exit, far);
    if (enter > exit) return null;
  }

  return enter <= exit && enter < limit ? enter : null;
}

function emptyTrace(end: Vec3): TraceResult {
  return {
    fraction: 1,
    endPosition: [...end] as Vec3,
    normal: [0, 0, 1],
    startSolid: false,
    allSolid: false,
    surfaceFlags: 0,
    contents: 0,
  };
}

function shuffle<T>(list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
