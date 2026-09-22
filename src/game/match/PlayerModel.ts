import * as THREE from 'three';
import { Md3Model } from '../../formats/md3';
import type { VirtualFileSystem } from '../../formats/pk3';
import type { ShaderLibrary } from '../../formats/shader';
import { Md3Mesh } from '../../md3/MD3Renderer';
import type { TextureLibrary } from '../../renderer/materials/TextureLibrary';
import { applyGridLight, createGridLight, setGridLight } from '../../renderer/materials/GridLit';
import { MODEL_DIRECTORIES } from '../weapons/ViewModel';
import type { WeaponId } from '../weapons/WeaponDefs';

/**
 * Corps d'un combattant, tel que le jeu l'assemble.
 *
 * Un personnage n'est pas un modele mais trois : les jambes, le torse et la
 * tete, chacun avec ses propres images d'animation, emboites par leurs reperes
 * d'assemblage. Les jambes portent le repere du torse, le torse celui de la
 * tete et celui de l'arme. C'est ce decoupage qui permet a un joueur de courir
 * vers la gauche en visant a droite : les jambes suivent la marche, le torse
 * suit le regard, et l'ecart entre les deux est borne.
 *
 * Les animations sont decrites dans un fichier texte a cote des modeles, avec
 * pour chacune sa premiere image, sa longueur, sa partie bouclee et sa
 * cadence. Les animations de jambes y sont numerotees a la suite de celles du
 * torse alors que le modele des jambes ne contient pas ces images : il faut
 * donc retirer le bloc du torse, comme le fait le jeu.
 */

export type LegsAnimation =
  | 'LEGS_WALKCR'
  | 'LEGS_WALK'
  | 'LEGS_RUN'
  | 'LEGS_BACK'
  | 'LEGS_SWIM'
  | 'LEGS_JUMP'
  | 'LEGS_LAND'
  | 'LEGS_JUMPB'
  | 'LEGS_LANDB'
  | 'LEGS_IDLE'
  | 'LEGS_IDLECR'
  | 'LEGS_TURN';

export type TorsoAnimation =
  | 'TORSO_GESTURE'
  | 'TORSO_ATTACK'
  | 'TORSO_ATTACK2'
  | 'TORSO_DROP'
  | 'TORSO_RAISE'
  | 'TORSO_STAND'
  | 'TORSO_STAND2';

export type BothAnimation =
  | 'BOTH_DEATH1'
  | 'BOTH_DEAD1'
  | 'BOTH_DEATH2'
  | 'BOTH_DEAD2'
  | 'BOTH_DEATH3'
  | 'BOTH_DEAD3';

export type AnimationName = BothAnimation | TorsoAnimation | LegsAnimation;

/** Ordre du fichier de configuration, celui du jeu. */
const ANIMATION_ORDER: AnimationName[] = [
  'BOTH_DEATH1',
  'BOTH_DEAD1',
  'BOTH_DEATH2',
  'BOTH_DEAD2',
  'BOTH_DEATH3',
  'BOTH_DEAD3',
  'TORSO_GESTURE',
  'TORSO_ATTACK',
  'TORSO_ATTACK2',
  'TORSO_DROP',
  'TORSO_RAISE',
  'TORSO_STAND',
  'TORSO_STAND2',
  'LEGS_WALKCR',
  'LEGS_WALK',
  'LEGS_RUN',
  'LEGS_BACK',
  'LEGS_SWIM',
  'LEGS_JUMP',
  'LEGS_LAND',
  'LEGS_JUMPB',
  'LEGS_LANDB',
  'LEGS_IDLE',
  'LEGS_IDLECR',
  'LEGS_TURN',
];

export interface Animation {
  first: number;
  count: number;
  /** Nombre d'images bouclees ; zero pour une animation qui se joue une fois. */
  looping: number;
  fps: number;
}

export interface PlayerAssets {
  name: string;
  lower: Md3Model;
  upper: Md3Model;
  head: Md3Model;
  animations: Partial<Record<AnimationName, Animation>>;
  skins: { lower: Map<string, string>; upper: Map<string, string>; head: Map<string, string> };
}

/** Etat que le corps doit montrer, releve sur le combattant. */
export interface PoseInput {
  origin: [number, number, number];
  /** Orientation du regard, en radians. */
  yaw: number;
  pitch: number;
  velocity: [number, number, number];
  onGround: boolean;
  ducked: boolean;
  firing: boolean;
  alive: boolean;
}

/** Ecart maximal entre le torse et les jambes, en degres, comme dans le jeu. */
const MAX_TWIST = 40;
/** Le torse garde la pose de tir un instant apres le coup. */
const ATTACK_HOLD = 0.35;

export class PlayerModel {
  readonly group = new THREE.Group();
  private readonly legs: Md3Mesh;
  private readonly torso: Md3Mesh;
  private readonly head: Md3Mesh;
  /** Reperes d'assemblage : ils portent les pieces suivantes. */
  private readonly torsoAnchor = new THREE.Object3D();
  private readonly headAnchor = new THREE.Object3D();
  private readonly weaponAnchor = new THREE.Object3D();
  private weapon: Md3Mesh | null = null;
  private weaponId: WeaponId | null = null;

  private legsAnimation: LegsAnimation = 'LEGS_IDLE';
  private torsoAnimation: TorsoAnimation | BothAnimation = 'TORSO_STAND';
  private legsTime = 0;
  private torsoTime = 0;
  private attackHold = 0;
  private legsYaw = 0;
  private deathAnimation: BothAnimation | null = null;
  private readonly matrix = new THREE.Matrix4();
  private readonly twist = new THREE.Matrix4();
  /** Lumiere du lieu, relue a chaque image dans la grille de la carte. */
  private readonly light = createGridLight();

  constructor(
    private readonly assets: PlayerAssets,
    private readonly textures: TextureLibrary | null,
    private readonly shaders: ShaderLibrary | null,
    private readonly vfs: VirtualFileSystem | null,
  ) {
    this.group.name = `player-${assets.name}`;
    this.legs = new Md3Mesh(assets.lower);
    this.torso = new Md3Mesh(assets.upper);
    this.head = new Md3Mesh(assets.head);

    this.torsoAnchor.matrixAutoUpdate = false;
    this.headAnchor.matrixAutoUpdate = false;
    this.weaponAnchor.matrixAutoUpdate = false;

    this.group.add(this.legs.group);
    this.group.add(this.torsoAnchor);
    this.torsoAnchor.add(this.torso.group);
    this.torsoAnchor.add(this.headAnchor);
    this.torsoAnchor.add(this.weaponAnchor);
    this.headAnchor.add(this.head.group);

    if (this.textures) {
      void this.legs.loadTextures(this.textures, this.shaders, assets.skins.lower);
      void this.torso.loadTextures(this.textures, this.shaders, assets.skins.upper);
      void this.head.loadTextures(this.textures, this.shaders, assets.skins.head);
    }

    // Le corps n'a pas de lightmap : sa lumiere vient de la grille.
    for (const mesh of [this.legs, this.torso, this.head]) {
      for (const material of mesh.materials) applyGridLight(material, this.light);
    }
  }

  /** Pose la lumiere du lieu, echantillonnee par l'arene. */
  setLight(sample: { ambient: THREE.Color; directional: THREE.Color; direction: THREE.Vector3 }): void {
    setGridLight(this.light, sample);
  }

  /** Arme visible dans la main : le modele du jeu, accroche au repere. */
  setWeapon(id: WeaponId): void {
    if (this.weaponId === id || !this.vfs || !this.textures) return;
    this.weaponId = id;
    const directory = MODEL_DIRECTORIES[id];
    void this.vfs.read(`models/weapons2/${directory}/${directory}.md3`).then(async (data) => {
      if (!data || this.weaponId !== id) return;
      if (this.weapon) {
        this.weaponAnchor.remove(this.weapon.group);
        this.weapon.dispose?.();
      }
      const mesh = new Md3Mesh(new Md3Model(data, directory));
      await mesh.loadTextures(this.textures!, this.shaders);
      mesh.setFrames(0, 0, 0);
      for (const material of mesh.materials) applyGridLight(material, this.light);
      this.weapon = mesh;
      this.weaponAnchor.add(mesh.group);
    });
  }

  /**
   * Pose du corps pour cette image. Les jambes tournent vers la marche, le
   * torse vers le regard, et la tete ajoute l'inclinaison.
   */
  update(delta: number, pose: PoseInput): void {
    this.group.visible = true;
    /*
     * Le corps se pose a l'origine du combattant, sans decalage : c'est la
     * regle du jeu, et les modeles sont dessines pour elle. Leurs pieds ne
     * touchent pas tout a fait le bas de la boite de collision, ce qui est
     * aussi le cas dans le jeu.
     */
    this.group.position.set(pose.origin[0], pose.origin[1], pose.origin[2]);

    this.chooseAnimations(delta, pose);
    this.advance(delta);
    this.orient(pose);
    this.attach();
  }

  /** Corps masque : mort effacee, ou combattant en attente de reapparition. */
  hide(): void {
    this.group.visible = false;
  }

  dispose(): void {
    this.legs.dispose?.();
    this.torso.dispose?.();
    this.head.dispose?.();
    this.weapon?.dispose?.();
    this.group.removeFromParent();
  }

  /** Choix des animations, sur le mouvement et l'etat du combattant. */
  private chooseAnimations(delta: number, pose: PoseInput): void {
    if (!pose.alive) {
      if (!this.deathAnimation) {
        const choice = 1 + Math.floor(Math.random() * 3);
        this.deathAnimation = `BOTH_DEATH${choice}` as BothAnimation;
        this.torsoAnimation = this.deathAnimation;
        this.legsAnimation = 'LEGS_IDLE';
        this.torsoTime = 0;
        this.legsTime = 0;
      }
      return;
    }
    this.deathAnimation = null;

    const speed = Math.hypot(pose.velocity[0], pose.velocity[1]);
    // Marche avant ou arriere : le signe de la vitesse dans l'axe du regard.
    const forward = Math.cos(pose.yaw) * pose.velocity[0] + Math.sin(pose.yaw) * pose.velocity[1];

    let legs: LegsAnimation;
    if (!pose.onGround) legs = 'LEGS_JUMP';
    else if (pose.ducked) legs = speed > 20 ? 'LEGS_WALKCR' : 'LEGS_IDLECR';
    else if (speed < 20) legs = 'LEGS_IDLE';
    else if (forward < -20) legs = 'LEGS_BACK';
    else legs = speed > 200 ? 'LEGS_RUN' : 'LEGS_WALK';

    if (legs !== this.legsAnimation) {
      this.legsAnimation = legs;
      this.legsTime = 0;
    }

    if (pose.firing) this.attackHold = ATTACK_HOLD;
    else this.attackHold = Math.max(0, this.attackHold - delta);

    const torso: TorsoAnimation = this.attackHold > 0 ? 'TORSO_ATTACK' : 'TORSO_STAND';
    if (torso !== this.torsoAnimation) {
      this.torsoAnimation = torso;
      this.torsoTime = 0;
    }
  }

  /** Avance les deux horloges et pose les images sur chaque piece. */
  private advance(delta: number): void {
    this.legsTime += delta;
    this.torsoTime += delta;

    const legs = this.assets.animations[this.legsAnimation];
    if (legs) applyFrames(this.legs, legs, this.legsTime);

    const torso = this.assets.animations[this.torsoAnimation];
    if (torso) applyFrames(this.torso, torso, this.torsoTime);

    // La tete n'a qu'une image : elle se contente de suivre son repere.
    this.head.setFrames(0, 0, 0);
    this.weapon?.setFrames(0, 0, 0);
  }

  /**
   * Orientation. Les jambes rattrapent le regard sans le suivre exactement :
   * sans cet ecart, un joueur qui recule semble courir en arriere le buste
   * face au vide.
   */
  private orient(pose: PoseInput): void {
    const speed = Math.hypot(pose.velocity[0], pose.velocity[1]);
    let wanted = pose.yaw;
    if (speed > 40) {
      // Direction reelle de la marche : c'est elle que les jambes suivent.
      wanted = Math.atan2(pose.velocity[1], pose.velocity[0]);
    }

    let difference = wanted - this.legsYaw;
    while (difference > Math.PI) difference -= Math.PI * 2;
    while (difference < -Math.PI) difference += Math.PI * 2;
    this.legsYaw += difference * 0.2;

    // Ecart borne entre le torse et les jambes.
    let twist = pose.yaw - this.legsYaw;
    while (twist > Math.PI) twist -= Math.PI * 2;
    while (twist < -Math.PI) twist += Math.PI * 2;
    const limit = (MAX_TWIST * Math.PI) / 180;
    if (twist > limit) this.legsYaw += twist - limit;
    if (twist < -limit) this.legsYaw += twist + limit;

    this.group.rotation.set(0, 0, this.legsYaw);
    this.twist.makeRotationZ(pose.yaw - this.legsYaw);
  }

  /** Emboite les pieces par leurs reperes d'assemblage. */
  private attach(): void {
    if (this.legs.tagMatrix('tag_torso', this.matrix)) {
      // Le torse tourne en plus de son repere : l'ecart avec les jambes.
      this.torsoAnchor.matrix.copy(this.matrix).multiply(this.twist);
    }
    if (this.torso.tagMatrix('tag_head', this.matrix)) {
      this.headAnchor.matrix.copy(this.matrix);
    }
    if (this.torso.tagMatrix('tag_weapon', this.matrix)) {
      this.weaponAnchor.matrix.copy(this.matrix);
    }
  }
}

/** Pose la paire d'images et leur melange, d'apres le temps ecoule. */
function applyFrames(mesh: Md3Mesh, animation: Animation, time: number): void {
  const count = Math.max(1, animation.count);
  const step = time * animation.fps;
  let index = Math.floor(step);
  const mix = step - index;

  if (animation.looping > 0) {
    // Partie bouclee : les dernieres images tournent en rond.
    const loopStart = count - animation.looping;
    index = index < count ? index : loopStart + ((index - count) % Math.max(1, animation.looping));
  } else {
    index = Math.min(index, count - 1);
  }

  const next = animation.looping > 0
    ? (index + 1 < count ? index + 1 : count - animation.looping)
    : Math.min(index + 1, count - 1);

  mesh.setFrames(animation.first + index, animation.first + next, index === next ? 0 : mix);
}

/**
 * Lit un fichier d'animations. Les valeurs sont celles du jeu, y compris le
 * decalage a retirer aux animations de jambes.
 */
export function parseAnimations(text: string): Partial<Record<AnimationName, Animation>> {
  const animations: Partial<Record<AnimationName, Animation>> = {};
  const rows: Animation[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (line.length === 0) continue;
    const parts = line.split(/\s+/);
    const numbers = parts.map(Number);
    if (parts.length < 4 || numbers.slice(0, 4).some((value) => !Number.isFinite(value))) continue;
    rows.push({ first: numbers[0], count: numbers[1], looping: numbers[2], fps: Math.max(1, numbers[3]) });
  }

  for (let i = 0; i < ANIMATION_ORDER.length && i < rows.length; i++) {
    animations[ANIMATION_ORDER[i]] = rows[i];
  }

  /*
   * Les animations de jambes sont numerotees a la suite de celles du torse,
   * alors que le modele des jambes ne contient pas ces images. Le jeu retire
   * donc le bloc du torse a toutes les animations a partir de la marche
   * accroupie.
   */
  const legsStart = animations.LEGS_WALKCR?.first;
  const torsoStart = animations.TORSO_GESTURE?.first;
  if (legsStart !== undefined && torsoStart !== undefined) {
    const skip = legsStart - torsoStart;
    for (const name of ANIMATION_ORDER.slice(ANIMATION_ORDER.indexOf('LEGS_WALKCR'))) {
      const animation = animations[name];
      if (animation) animation.first -= skip;
    }
  }

  return animations;
}

/** Lit une peau : une surface par ligne, avec l'image qui l'habille. */
export function parseSkin(text: string): Map<string, string> {
  const skin = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (line.length === 0) continue;
    const [surface, texture] = line.split(',');
    if (!surface || !texture) continue;
    skin.set(surface.trim(), texture.trim().replace(/\\/g, '/'));
  }
  return skin;
}

/**
 * Charge un personnage depuis les archives du joueur. Rend rien si l'une des
 * trois pieces manque : un corps sans tete vaut moins qu'aucun corps.
 */
export async function loadPlayerAssets(
  vfs: VirtualFileSystem,
  name: string,
): Promise<PlayerAssets | null> {
  const base = `models/players/${name}`;
  const [lower, upper, head] = await Promise.all([
    vfs.read(`${base}/lower.md3`),
    vfs.read(`${base}/upper.md3`),
    vfs.read(`${base}/head.md3`),
  ]);
  if (!lower || !upper || !head) return null;

  const [config, lowerSkin, upperSkin, headSkin] = await Promise.all([
    vfs.read(`${base}/animation.cfg`),
    vfs.read(`${base}/lower_default.skin`),
    vfs.read(`${base}/upper_default.skin`),
    vfs.read(`${base}/head_default.skin`),
  ]);

  const decoder = new TextDecoder('latin1');
  try {
    return {
      name,
      lower: new Md3Model(lower, `${base}/lower.md3`),
      upper: new Md3Model(upper, `${base}/upper.md3`),
      head: new Md3Model(head, `${base}/head.md3`),
      animations: config ? parseAnimations(decoder.decode(config)) : {},
      skins: {
        lower: lowerSkin ? parseSkin(decoder.decode(lowerSkin)) : new Map(),
        upper: upperSkin ? parseSkin(decoder.decode(upperSkin)) : new Map(),
        head: headSkin ? parseSkin(decoder.decode(headSkin)) : new Map(),
      },
    };
  } catch (error) {
    console.warn(`${base} illisible :`, error);
    return null;
  }
}
