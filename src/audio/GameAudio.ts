import { sound } from './SoundSystem';
import { Surface } from '../formats/bsp';
import type { WeaponId } from '../game/weapons/WeaponDefs';

/**
 * Sons de la partie.
 *
 * Ce sont ceux du jeu, lus dans les archives du joueur, avec les choix que le
 * jeu fait : quatre echantillons de mitrailleuse tires au hasard pour qu'une
 * rafale ne soit pas un bourdonnement, un pas qui change selon la matiere du
 * sol, un ricochet plutot qu'une explosion quand la balle touche la pierre.
 *
 * Rien n'est fabrique ici. Une arme sans son declare reste muette : inventer
 * un bruit de remplacement donnerait un autre jeu.
 */

/** Sons de depart de coup, un par arme. */
const FIRE: Partial<Record<WeaponId, string[]>> = {
  gauntlet: ['sound/weapons/melee/fstatck.wav'],
  machinegun: [
    'sound/weapons/machinegun/machgf1b.wav',
    'sound/weapons/machinegun/machgf2b.wav',
    'sound/weapons/machinegun/machgf3b.wav',
    'sound/weapons/machinegun/machgf4b.wav',
  ],
  shotgun: ['sound/weapons/shotgun/sshotf1b.wav'],
  grenade: ['sound/weapons/grenade/grenlf1a.wav'],
  rocket: ['sound/weapons/rocket/rocklf1a.wav'],
  lightning: ['sound/weapons/lightning/lg_fire.wav'],
  railgun: ['sound/weapons/railgun/railgf1a.wav'],
  plasma: ['sound/weapons/plasma/hyprbf1a.wav'],
  bfg: ['sound/weapons/bfg/bfg_fire.wav'],
};

/** Explosions et impacts, par arme. */
const BURST: Partial<Record<WeaponId, string>> = {
  rocket: 'sound/weapons/rocket/rocklx1a.wav',
  grenade: 'sound/weapons/rocket/rocklx1a.wav',
  plasma: 'sound/weapons/plasma/plasmx1a.wav',
  bfg: 'sound/weapons/rocket/rocklx1a.wav',
};

const RICOCHET = [
  'sound/weapons/machinegun/ric1.wav',
  'sound/weapons/machinegun/ric2.wav',
  'sound/weapons/machinegun/ric3.wav',
];

const BEAM_HIT = [
  'sound/weapons/lightning/lg_hit.wav',
  'sound/weapons/lightning/lg_hit2.wav',
  'sound/weapons/lightning/lg_hit3.wav',
];

const BOUNCE = ['sound/weapons/grenade/hgrenb1a.wav', 'sound/weapons/grenade/hgrenb2a.wav'];

/** Pas, par matiere. Le jeu choisit sur les indicateurs de surface. */
const STEPS = {
  normal: ['step1', 'step2', 'step3', 'step4'],
  metal: ['clank1', 'clank2', 'clank3', 'clank4'],
  splash: ['splash1', 'splash2', 'splash3', 'splash4'],
  energy: ['energy1', 'energy2', 'energy3', 'energy4'],
} as const;

const PICKUP: Record<string, string> = {
  health: 'sound/items/n_health.wav',
  armor: 'sound/misc/ar1_pkup.wav',
  ammo: 'sound/misc/am_pkup.wav',
  weapon: 'sound/misc/w_pkup.wav',
  powerup: 'sound/items/quaddamage.wav',
};

const WORLD = {
  jump: 'sound/player/sarge/jump1.wav',
  land: 'sound/player/land1.wav',
  change: 'sound/weapons/change.wav',
  empty: 'sound/weapons/noammo.wav',
  teleportIn: 'sound/world/telein.wav',
  teleportOut: 'sound/world/teleout.wav',
  jumppad: 'sound/world/jumppad.wav',
  waterIn: 'sound/player/watr_in.wav',
  waterOut: 'sound/player/watr_out.wav',
  respawn: 'sound/items/respawn1.wav',
} as const;

/**
 * Douleur et mort. Le jeu enregistre un jeu de cris par personnage : chaque
 * modele a son dossier, avec quatre paliers de douleur et trois cris de mort.
 * Faire crier sept adversaires avec la meme voix s'entend tout de suite, on
 * les charge donc par personnage, avec Sarge en repli.
 */
const DEFAULT_VOICE = 'sarge';

function painOf(voice: string, level: 25 | 50 | 75 | 100): string {
  return `sound/player/${voice}/pain${level}_1.wav`;
}

function deathOf(voice: string, index: number): string {
  return `sound/player/${voice}/death${index}.wav`;
}

/** Tous les echantillons de voix d'un personnage. */
function voiceFiles(voice: string): string[] {
  return [
    painOf(voice, 25),
    painOf(voice, 50),
    painOf(voice, 75),
    painOf(voice, 100),
    deathOf(voice, 1),
    deathOf(voice, 2),
    deathOf(voice, 3),
  ];
}

/**
 * Confirmation de touche : le bip que le jeu renvoie a celui qui tire, dose
 * selon les degats. C'est ce retour qui rend un duel lisible, plus que le
 * marqueur a l'ecran.
 */
const HIT = {
  low: 'sound/feedback/hit.wav',
  25: 'sound/feedback/hit25.wav',
  50: 'sound/feedback/hit50.wav',
  75: 'sound/feedback/hit75.wav',
  100: 'sound/feedback/hit100.wav',
} as const;

/** Voix de l'annonceur, telle que le jeu la declenche. */
const ANNOUNCE = {
  prepare: 'sound/feedback/prepare.wav',
  three: 'sound/feedback/three.wav',
  two: 'sound/feedback/two.wav',
  one: 'sound/feedback/one.wav',
  fight: 'sound/feedback/fight.wav',
  oneFrag: 'sound/feedback/1_frag.wav',
  twoFrags: 'sound/feedback/2_frags.wav',
  threeFrags: 'sound/feedback/3_frags.wav',
  oneMinute: 'sound/feedback/1_minute.wav',
  fiveMinutes: 'sound/feedback/5_minute.wav',
  excellent: 'sound/feedback/excellent.wav',
  impressive: 'sound/feedback/impressive.wav',
  humiliation: 'sound/feedback/humiliation.wav',
  youWin: 'sound/player/announce/youwin.wav',
  lostLead: 'sound/feedback/lostlead.wav',
  takenLead: 'sound/feedback/takenlead.wav',
} as const;

export type AnnounceName = keyof typeof ANNOUNCE;

/** Distance parcourue entre deux pas, en unites de carte. */
const STRIDE = 120;

function step(names: readonly string[]): string {
  return `sound/player/footsteps/${names[Math.floor(Math.random() * names.length)]}.wav`;
}

function any(names: readonly string[]): string {
  return names[Math.floor(Math.random() * names.length)];
}

export class GameAudio {
  private loaded = false;
  private travelled = 0;
  private wasInWater = false;
  private readonly speakers: (() => void)[] = [];
  private read: ((path: string) => Promise<Uint8Array | null>) | null = null;
  /** Personnages dont la voix est chargee. */
  private readonly voices = new Set<string>([DEFAULT_VOICE]);

  /**
   * Charge tout ce dont une partie a besoin. Les sons absents des archives
   * sont ignores en silence : une installation incomplete doit rester
   * jouable.
   */
  async load(read: (path: string) => Promise<Uint8Array | null>): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    // Le lecteur est garde : les voix des adversaires arrivent plus tard, en
    // meme temps que leurs corps.
    this.read = read;
    const names = new Set<string>([
      ...Object.values(FIRE).flat(),
      ...Object.values(BURST),
      ...RICOCHET,
      ...BEAM_HIT,
      ...BOUNCE,
      ...Object.values(WORLD),
      ...Object.values(PICKUP),
      ...Object.values(STEPS).flatMap((list) => list.map((name) => `sound/player/footsteps/${name}.wav`)),
      ...voiceFiles(DEFAULT_VOICE),
      ...Object.values(HIT),
      ...Object.values(ANNOUNCE),
    ]);
    await Promise.all([...names].map((name) => sound.load(name, read)));
  }

  /** Place l'auditeur sur la vue du joueur, a chaque image. */
  listen(position: [number, number, number], forward: [number, number, number]): void {
    sound.setListener(position, forward);
  }

  fire(weapon: WeaponId): void {
    const names = FIRE[weapon];
    if (!names) return;
    // Les quatre coups de mitrailleuse du jeu, plus un demi-ton de variation :
    // une rafale garde du grain au lieu de sonner comme une boucle.
    sound.play(any(names), { detune: (Math.random() - 0.5) * 1.4 });
  }

  /**
   * Coup parti ailleurs que dans les mains du joueur. Le meme echantillon que
   * le sien, mais place dans la scene : c'est ce qui permet d'entendre d'ou
   * l'on vous tire dessus.
   */
  fireAt(weapon: WeaponId, position: [number, number, number]): void {
    const names = FIRE[weapon];
    if (!names) return;
    sound.play(any(names), { position, detune: (Math.random() - 0.5) * 1.4 });
  }

  /**
   * Charge la voix d'un personnage. Appelee quand son corps arrive : les cris
   * viennent du meme dossier que ses modeles.
   */
  async loadVoice(voice: string): Promise<void> {
    if (!voice || this.voices.has(voice) || !this.read) return;
    this.voices.add(voice);
    const read = this.read;
    await Promise.all(voiceFiles(voice).map((name) => sound.load(name, read)));
  }

  /** Cri de douleur, choisi sur la sante restante comme le fait le jeu. */
  pain(position: [number, number, number], health: number, voice = DEFAULT_VOICE): void {
    const level = health <= 25 ? 25 : health <= 50 ? 50 : health <= 75 ? 75 : 100;
    const name = this.voices.has(voice) ? voice : DEFAULT_VOICE;
    sound.play(painOf(name, level), { position, gain: 0.9 });
  }

  death(position: [number, number, number], voice = DEFAULT_VOICE): void {
    const name = this.voices.has(voice) ? voice : DEFAULT_VOICE;
    sound.play(deathOf(name, 1 + Math.floor(Math.random() * 3)), { position });
  }

  /**
   * Bip de touche renvoye a celui qui tire. Il ne sort pas de la scene : il
   * appartient a l'interface, comme dans le jeu.
   */
  hitConfirm(damage: number): void {
    const name = damage >= 100 ? HIT[100] : damage >= 75 ? HIT[75] : damage >= 50 ? HIT[50] : damage >= 25 ? HIT[25] : HIT.low;
    sound.play(name, { gain: 0.8 });
  }

  /** Voix de l'annonceur. */
  announce(name: AnnounceName): void {
    sound.play(ANNOUNCE[name], { gain: 0.9 });
  }

  empty(): void {
    sound.play(WORLD.empty);
  }

  change(): void {
    sound.play(WORLD.change, { gain: 0.7 });
  }

  /**
   * Impact d'un tir instantane. La pierre renvoie un ricochet, le metal aussi
   * mais plus clair, et un faisceau grille la surface au lieu de ricocher.
   */
  impact(weapon: WeaponId, position: [number, number, number], surfaceFlags: number): void {
    if ((surfaceFlags & Surface.NOIMPACT) !== 0) return;
    const metal = (surfaceFlags & Surface.METALSTEPS) !== 0;
    if (weapon === 'lightning' || weapon === 'plasma' || weapon === 'bfg') {
      sound.play(any(BEAM_HIT), { position, gain: 0.8 });
      return;
    }
    sound.play(any(RICOCHET), { position, gain: metal ? 0.9 : 0.6, detune: metal ? 2 : -1 });
  }

  /** Explosion d'un projectile. */
  burst(weapon: WeaponId, position: [number, number, number]): void {
    const name = BURST[weapon];
    if (name) sound.play(name, { position });
  }

  /** Rebond d'une grenade. */
  bounce(position: [number, number, number]): void {
    sound.play(any(BOUNCE), { position, gain: 0.7 });
  }

  /**
   * Pas. Le son vient de la distance parcourue et non d'un minuteur : en
   * marchant on entend moins de pas qu'en courant, sans rien compter d'autre.
   */
  travel(distance: number, surfaceFlags: number, waterLevel: number): void {
    if ((surfaceFlags & Surface.NOSTEPS) !== 0) return;
    this.travelled += distance;
    if (this.travelled < STRIDE) return;
    this.travelled = 0;

    const family = waterLevel > 0
      ? STEPS.splash
      : (surfaceFlags & Surface.METALSTEPS) !== 0
        ? STEPS.metal
        : (surfaceFlags & Surface.FLESH) !== 0
          ? STEPS.energy
          : STEPS.normal;
    sound.play(step(family), { gain: 0.45, detune: (Math.random() - 0.5) * 2 });
  }

  jump(): void {
    sound.play(WORLD.jump, { gain: 0.6 });
  }

  /** Reception. Une chute franche s'entend, un pas de descente non. */
  land(force: number): void {
    if (force < 200) return;
    sound.play(WORLD.land, { gain: Math.min(1, force / 500) });
  }

  /** Entree et sortie de l'eau, sur le changement de niveau d'immersion. */
  water(level: number): void {
    const inside = level > 1;
    if (inside === this.wasInWater) return;
    this.wasInWater = inside;
    sound.play(inside ? WORLD.waterIn : WORLD.waterOut, { gain: 0.8 });
  }

  pickup(kind: string): void {
    const name = PICKUP[kind];
    if (name) sound.play(name, { gain: 0.8 });
  }

  teleport(position: [number, number, number]): void {
    sound.play(WORLD.teleportIn, { position });
  }

  jumppad(position: [number, number, number]): void {
    sound.play(WORLD.jumppad, { position });
  }

  respawn(): void {
    sound.play(WORLD.respawn, { gain: 0.5 });
  }

  /**
   * Ambiances de la carte. Une carte declare des haut-parleurs, avec leur son
   * et leur place : q3dm7 en a pour le grondement de sa lave. Ils sont lus en
   * boucle a l'endroit ou la carte les pose, et s'arretent avec elle.
   */
  async ambiences(
    sources: { noise: string; origin: [number, number, number] }[],
    read: (path: string) => Promise<Uint8Array | null>,
  ): Promise<void> {
    this.silence();
    for (const source of sources) {
      const name = source.noise.replace(/\\/g, '/').toLowerCase();
      const path = name.endsWith('.wav') ? name : `${name}.wav`;
      await sound.load(path, read);
      const stop = sound.loop(path, source.origin, 0.5);
      if (stop) this.speakers.push(stop);
    }
  }

  /** Coupe les ambiances : on quitte la carte. */
  silence(): void {
    for (const stop of this.speakers) stop();
    this.speakers.length = 0;
    this.travelled = 0;
    this.wasInWater = false;
  }
}
