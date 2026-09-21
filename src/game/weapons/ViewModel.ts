import * as THREE from 'three';
import { Md3Model } from '../../formats/md3';
import type { VirtualFileSystem } from '../../formats/pk3';
import { Md3Mesh } from '../../md3/MD3Renderer';
import type { TextureLibrary } from '../../renderer/materials/TextureLibrary';
import type { ViewmodelMotion } from '../../camera/FPSCameraEffects';
import type { WeaponId } from './WeaponDefs';
import { VIEW_MODEL_OVERRIDES, loadOverride } from './ViewModelOverrides';
import { REFERENCE_WEAPON_FOV, weaponPreset, type WeaponViewmodelPreset } from './WeaponPreset';
import { ShellCasingPool, ViewModelFlash } from './ViewModelFX';

/**
 * Arme tenue en main.
 *
 * Elle a sa propre scene et sa propre camera, pour deux raisons. D'abord le
 * champ de vision : le monde se joue entre quatre-vingt-dix et cent dix
 * degres, ou une arme placee devant l'oeil se deforme et grossit ; une camera
 * dediee, autour de soixante-dix degres, garde l'arme juste quel que soit le
 * reglage du joueur. Ensuite la profondeur : dessinee apres le monde sur une
 * profondeur remise a zero, l'arme ne traverse jamais un mur dont on
 * s'approche.
 *
 * Les mouvements ne s'additionnent pas dans une seule transformation : chacun
 * a son point d'accroche, empiles dans cet ordre.
 *
 *   racine -> position -> balancement -> retard -> recul -> porte-arme -> modele
 *
 * On peut ainsi regler, multiplier ou couper un mouvement sans toucher aux
 * autres, et un modele garde sa prise en main quand le joueur change sa place.
 *
 * La taille est fixee par la part d'ecran que l'arme doit occuper, jamais par
 * l'echelle du fichier : un modele exporte deux fois plus grand donne la meme
 * image.
 */

const MODEL_DIRECTORIES: Record<WeaponId, string> = {
  gauntlet: 'gauntlet',
  machinegun: 'machinegun',
  shotgun: 'shotgun',
  grenade: 'grenadel',
  rocket: 'rocketl',
  lightning: 'lightning',
  railgun: 'railgun',
  plasma: 'plasma',
  bfg: 'bfg',
};

/** Distance de l'arme devant la camera qui lui est dediee, en unites de carte. */
const DISTANCE = 30;

export interface ViewModelSettings {
  /** Champ de vision de l'arme, en degres, independant de celui du monde. */
  fov: number;
  /** Ajustement lateral du joueur, ajoute a la place prevue par l'arme. */
  trimX: number;
  /** Ajustement vertical du joueur. */
  trimY: number;
  /** Cote choisi par le joueur : l'arme peut passer a gauche ou au centre. */
  side: 'center' | 'right' | 'left';
  visible: boolean;
}

export const DEFAULT_VIEW_MODEL_SETTINGS: ViewModelSettings = {
  fov: REFERENCE_WEAPON_FOV,
  trimX: 0,
  trimY: 0,
  side: 'right',
  visible: true,
};

/** Eclairage lu dans la carte, exprime dans le repere de la vue. */
export interface ViewModelEnvironment {
  ambient: THREE.Color;
  directional: THREE.Color;
  /** Direction d'ou vient la lumiere, dans le repere de la camera. */
  direction: THREE.Vector3;
}

interface WeaponModel {
  group: THREE.Object3D;
  md3: Md3Mesh | null;
  /**
   * Echantillon de sommets, dans le repere du porte-arme. La silhouette se
   * mesure sur eux et non sur la boite englobante : pres de l'oeil, une boite
   * autour d'un objet en diagonale deborde largement de ce qu'on voit, et
   * dimensionner dessus donne une arme deux fois trop petite.
   */
  points: Float32Array;
  /** Point du canon, dans le repere du modele normalise. */
  muzzle: THREE.Vector3;
  /**
   * Part d'ecran imposee par le fichier, quand ses proportions ne sont pas
   * celles du modele du jeu. Sans valeur, c'est le reglage de l'arme qui
   * decide.
   */
  occupancy?: number;
}

export class ViewModel {
  /** Scene propre a l'arme : le monde n'y figure pas. */
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(REFERENCE_WEAPON_FOV, 1, 0.5, 200);

  /** Chaine des points d'accroche, de la racine au modele. */
  private readonly root = new THREE.Group();
  private readonly positionAnchor = new THREE.Group();
  /** Reception apres une chute : l'arme s'enfonce puis revient. */
  private readonly landingAnchor = new THREE.Group();
  private readonly bobAnchor = new THREE.Group();
  private readonly swayAnchor = new THREE.Group();
  private readonly recoilAnchor = new THREE.Group();
  /** Changement de base et prise en main : avant du modele vers l'avant de la vue. */
  private readonly holder = new THREE.Group();
  private readonly holderBase = new THREE.Quaternion();
  /** Point du canon : eclat, fumee, lumiere. Jamais la source du tir. */
  private readonly muzzleAnchor = new THREE.Object3D();

  /** Eclairage propre a la scene de l'arme. */
  private readonly ambientLight = new THREE.AmbientLight(0xffffff, 1.1);
  private readonly keyLight = new THREE.DirectionalLight(0xfff0dd, 2.2);
  private readonly fillLight = new THREE.DirectionalLight(0x9fc4ff, 0.8);

  /** Eclat du depart de coup et douilles, dans la scene de l'arme. */
  private readonly flash = new ViewModelFlash(this.scene);
  private readonly casings = new ShellCasingPool(this.scene);
  private readonly muzzleWorld = new THREE.Vector3();
  private readonly ejection = new THREE.Vector3();

  private readonly cache = new Map<WeaponId, WeaponModel | null>();
  private readonly overrides = new Map<WeaponId, Promise<WeaponModel | null>>();
  private current: WeaponModel | null = null;
  private currentId: WeaponId | null = null;
  private loading: WeaponId | null = null;
  private preset: WeaponViewmodelPreset = weaponPreset('machinegun');

  private settings: ViewModelSettings = { ...DEFAULT_VIEW_MODEL_SETTINGS };
  private aspect = 16 / 9;
  private readonly restPosition = new THREE.Vector3();
  private readonly adjust = new THREE.Quaternion();
  private readonly adjustEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly tagMatrix = new THREE.Matrix4();
  private readonly localMuzzle = new THREE.Vector3();
  private readonly scratchMatrix = new THREE.Matrix4();
  private readonly scratchPoint = new THREE.Vector3();

  constructor(
    private readonly vfs: VirtualFileSystem | null,
    private readonly textures: TextureLibrary | null,
  ) {
    this.scene.name = 'viewmodel';

    // Base : l'avant du modele, porte par l'axe des x du repere des cartes,
    // regarde vers l'avant de la vue, et le haut reste en haut.
    const basis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(0, 0, -1),
      new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(0, 1, 0),
    );
    this.holder.quaternion.setFromRotationMatrix(basis);
    this.holderBase.copy(this.holder.quaternion);

    this.root.name = 'viewmodel-root';
    this.positionAnchor.name = 'position-anchor';
    this.landingAnchor.name = 'landing-anchor';
    this.bobAnchor.name = 'bob-anchor';
    this.swayAnchor.name = 'sway-anchor';
    this.recoilAnchor.name = 'recoil-anchor';
    this.muzzleAnchor.name = 'muzzle-anchor';

    this.recoilAnchor.add(this.holder);
    this.swayAnchor.add(this.recoilAnchor);
    this.bobAnchor.add(this.swayAnchor);
    this.landingAnchor.add(this.bobAnchor);
    this.positionAnchor.add(this.landingAnchor);
    this.root.add(this.positionAnchor);
    this.scene.add(this.root);
    this.holder.add(this.muzzleAnchor);

    /*
     * Eclairage propre a l'arme. La scene du monde n'etant pas rendue ici, le
     * modele a besoin de ses propres sources : une ambiance, une lumiere
     * principale legerement en hauteur, et un rappel plus froid a l'oppose
     * pour detacher la silhouette du fond. Les couleurs et les intensites
     * suivent ensuite l'eclairage de la carte.
     */
    this.keyLight.position.set(-0.4, 1, 0.6);
    this.fillLight.position.set(0.8, -0.2, -0.6);
    this.scene.add(this.ambientLight, this.keyLight, this.fillLight);

    this.applySettings(this.settings);
  }

  get object(): THREE.Object3D {
    return this.root;
  }

  get hasModel(): boolean {
    return this.current !== null;
  }

  /** Point d'accroche du canon, pour les effets de tir. */
  get muzzle(): THREE.Object3D {
    return this.muzzleAnchor;
  }

  applySettings(settings: Partial<ViewModelSettings>): void {
    this.settings = { ...this.settings, ...settings };
    this.applyFov();
    this.place();
  }

  setViewport(width: number, height: number): void {
    this.aspect = height > 0 ? width / height : 1;
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
    this.place();
  }

  /**
   * Eclairage lu dans la carte. Le modele doit appartenir a la scene : dans
   * une salle rouge il se teinte, dans un couloir sombre il s'assombrit. Une
   * luminosite minimale est conservee : une arme illisible est pire qu'une
   * arme mal eclairee.
   */
  setEnvironment(environment: ViewModelEnvironment): void {
    const ambient = luminance(environment.ambient);
    const key = luminance(environment.directional);

    // La teinte de la carte est melangee a du blanc : la couleur locale doit
    // se sentir, pas repeindre l'arme.
    this.ambientLight.color.copy(environment.ambient).lerp(WHITE, 0.55);
    this.ambientLight.intensity = clamp(1.3 + ambient * 2.4, 1.3, 2.6);

    this.keyLight.color.copy(environment.directional).lerp(WHITE, 0.4);
    this.keyLight.intensity = clamp(2.0 + key * 3.0, 2.0, 3.6);
    if (environment.direction.lengthSq() > 1e-6) {
      this.keyLight.position.copy(environment.direction).normalize();
    }

    this.fillLight.intensity = clamp(0.5 + ambient * 1.2, 0.5, 1.5);
  }

  /** Champ de vision applique : reglage du joueur, ecarte par l'arme. */
  private applyFov(): void {
    const fov = this.settings.fov + (this.preset.fov - REFERENCE_WEAPON_FOV);
    this.camera.fov = clamp(fov, 40, 110);
    this.camera.updateProjectionMatrix();
  }

  /** Dimensions visibles a la distance de l'arme, d'apres son champ de vision. */
  private visibleSize(): { width: number; height: number } {
    const halfHeight = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * DISTANCE;
    return { width: halfHeight * this.aspect * 2, height: halfHeight * 2 };
  }

  /** Place les points d'accroche et met le modele a la taille voulue. */
  private place(): void {
    const { width, height } = this.visibleSize();
    const side = this.settings.side;
    const lateral = this.preset.offsetX + this.settings.trimX;
    const vertical = this.preset.offsetY + this.settings.trimY;
    const mirror = side === 'left' ? -1 : 1;
    const signed = side === 'center' ? 0 : lateral * mirror;

    this.restPosition.set((width / 2) * signed, (height / 2) * vertical, -DISTANCE);
    this.positionAnchor.position.copy(this.restPosition);

    // Prise en main : quelques degres, appliques apres le changement de base.
    // Passee a gauche, l'arme est tenue en miroir.
    const [pitch, yaw, roll] = this.preset.rotation;
    this.adjustEuler.set(
      THREE.MathUtils.degToRad(pitch),
      THREE.MathUtils.degToRad(yaw * mirror),
      THREE.MathUtils.degToRad(roll * mirror),
    );
    this.adjust.setFromEuler(this.adjustEuler);
    this.holder.quaternion.copy(this.holderBase).premultiply(this.adjust);

    if (this.current) this.fitToScreen(this.current.occupancy ?? this.preset.occupancy);
  }

  /**
   * Met le modele a la taille voulue en mesurant ce qu'il occupe reellement a
   * l'ecran. Se fier a sa longueur en trois dimensions ne marche pas : une
   * arme pointee vers l'avant est vue en raccourci, et paraitrait deux fois
   * trop petite. On projette donc sa boite englobante et on ajuste.
   */
  private fitToScreen(target: number): void {
    /*
     * La largeur projetee croit avec l'echelle, mais pas proportionnellement :
     * en grandissant, le modele avance aussi vers l'oeil, et pres de l'oeil sa
     * projection s'emballe. Corriger l'echelle par simple regle de trois finit
     * donc par osciller. Une dichotomie, elle, ne peut pas s'egarer : on
     * encadre la taille demandee, puis on resserre.
     */
    let low = 0.001;
    let high = 1;
    for (let i = 0; i < 30 && this.projectedWidth(high) < target; i++) high *= 1.8;
    for (let i = 0; i < 30; i++) {
      const middle = (low + high) / 2;
      if (this.projectedWidth(middle) < target) low = middle;
      else high = middle;
    }
    this.projectedWidth((low + high) / 2);
  }

  /**
   * Silhouette projetee du modele a cette echelle : bornes en part d'image,
   * l'origine en haut a gauche. Rend rien quand le modele passe derriere le
   * plan de coupe, ce qui veut dire qu'il est trop gros.
   */
  private projectedBounds(
    scale: number,
  ): { left: number; right: number; top: number; bottom: number } | null {
    const model = this.current;
    if (!model) return null;

    this.holder.scale.setScalar(scale);
    this.root.updateWorldMatrix(true, true);
    this.camera.updateMatrixWorld();
    this.holder.updateMatrixWorld(true);

    const toCamera = this.scratchMatrix
      .copy(this.camera.matrixWorldInverse)
      .multiply(this.holder.matrixWorld);

    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    const point = this.scratchPoint;

    for (let index = 0; index < model.points.length; index += 3) {
      point.set(model.points[index], model.points[index + 1], model.points[index + 2]);
      point.applyMatrix4(toCamera);
      if (point.z > -this.camera.near) return null;
      point.applyMatrix4(this.camera.projectionMatrix);
      const x = (point.x + 1) / 2;
      const y = (1 - point.y) / 2;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
    if (!Number.isFinite(left)) return null;
    return { left, right, top, bottom };
  }

  /** Part de largeur d'image occupee par le modele a cette echelle. */
  private projectedWidth(scale: number): number {
    const bounds = this.projectedBounds(scale);
    if (!bounds) return Infinity;
    return bounds.right - bounds.left;
  }

  /**
   * Ou l'arme se trouve a l'ecran, en part d'image, l'origine en haut a
   * gauche. Sert a verifier trois choses : que le corps du modele reste
   * visible, que le canon rejoint la zone du viseur, et que rien ne recouvre
   * le bloc des munitions.
   */
  measure(): {
    rect: { left: number; top: number; right: number; bottom: number };
    muzzle: { x: number; y: number };
    width: number;
    height: number;
  } | null {
    if (!this.current) return null;
    const bounds = this.projectedBounds(this.holder.scale.x);
    if (!bounds) return null;

    const muzzle = this.muzzlePoint(new THREE.Vector3()).project(this.camera);
    return {
      rect: bounds,
      muzzle: { x: (muzzle.x + 1) / 2, y: (1 - muzzle.y) / 2 },
      width: bounds.right - bounds.left,
      height: bounds.bottom - bounds.top,
    };
  }

  async setWeapon(id: WeaponId): Promise<void> {
    if (this.currentId === id || this.loading === id) return;
    this.loading = id;

    let model = this.cache.get(id);
    if (model === undefined) {
      model = await this.load(id);
      this.cache.set(id, model);
    }

    if (this.loading !== id) return;
    this.loading = null;
    this.show(id, model);
    void this.loadOverrideFor(id);
  }

  private show(id: WeaponId, model: WeaponModel | null): void {
    if (this.current) this.holder.remove(this.current.group);
    this.current = model;
    this.currentId = id;
    this.preset = weaponPreset(id);
    this.applyFov();

    if (!model) {
      this.place();
      return;
    }
    // L'arme est solidaire de la camera : son ombre n'aurait pas de sens, et
    // la laisser dans les cartes d'ombre la dessinerait une fois par source.
    model.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) mesh.castShadow = false;
    });
    this.holder.add(model.group);
    this.place();
    this.updateMuzzleAnchor();
  }

  private async loadOverrideFor(id: WeaponId): Promise<void> {
    const override = VIEW_MODEL_OVERRIDES[id];
    if (!override) return;
    const cached = this.cache.get(id);
    if (cached && cached.md3 === null) return;

    let pending = this.overrides.get(id);
    if (!pending) {
      pending = loadOverride(override).then((group) =>
        group
          ? {
              group,
              md3: null,
              // Sans repere d'assemblage, le canon est au bout du modele.
              muzzle: new THREE.Vector3(0.5, 0, 0),
              occupancy: override.occupancy,
              points: samplePoints(group),
            }
          : null,
      );
      this.overrides.set(id, pending);
    }

    const model = await pending;
    if (!model) return;
    this.cache.set(id, model);
    if (this.currentId === id) this.show(id, model);
  }

  /**
   * Depart de coup vu de l'arme : un eclat au bout du canon, une lampe tres
   * courte qui detache le modele, et une douille ejectee quand l'arme en
   * ejecte. Le tir lui-meme ne depend en rien de tout ceci.
   */
  fire(color: THREE.Color, ejects: boolean): void {
    if (!this.settings.visible) return;
    const { height } = this.visibleSize();
    this.muzzlePoint(this.muzzleWorld);
    // La taille de l'eclat suit celle de l'image, comme les mouvements.
    this.flash.fire(color, height * 0.3);
    if (ejects) {
      /*
       * La douille sort de la culasse et passe au-dessus du corps de l'arme.
       * Ejectee depuis l'axe du canon, elle serait cachee par le modele lui
       * meme : la vue est de trois quarts arriere, et l'arme occupe tout le
       * coin de l'image.
       */
      this.ejection
        .copy(this.muzzleWorld)
        .lerp(this.restPosition, 0.5)
        .addScaledVector(RIGHT, height * 0.03)
        .addScaledVector(UP, height * 0.1);
      this.ejection.z += 5;
      // Taille de la douille, puis vitesse d'ejection : les deux suivent la
      // taille de l'image, comme tout le reste de l'arme.
      this.casings.eject(this.ejection, height * 0.045, height);
    }
  }

  /**
   * Applique les mouvements, chacun sur son point d'accroche et pondere par
   * l'arme : une mitrailleuse ne bouge pas comme un lance-roquettes.
   */
  update(motion: ViewmodelMotion, delta = 0): void {
    this.root.visible = this.settings.visible;
    if (!this.settings.visible) return;

    const { width, height } = this.visibleSize();
    const preset = this.preset;

    // Reception : elle porte l'arme entiere, balancement compris.
    this.landingAnchor.position.set(0, motion.landing * height, 0);

    // Balancement de la marche.
    this.bobAnchor.position.set(
      motion.bob.x * preset.bob * width,
      motion.bob.y * preset.bob * height,
      0,
    );
    this.bobAnchor.rotation.z = motion.bob.roll * preset.bob;

    // Retard sur les mouvements de vue.
    this.swayAnchor.position.set(
      motion.sway.x * preset.sway * width,
      motion.sway.y * preset.sway * height,
      0,
    );
    this.swayAnchor.rotation.set(motion.sway.pitch * preset.sway, motion.sway.yaw * preset.sway, 0);

    // Recul : l'arme recule vers l'oeil, se releve, et revient.
    this.recoilAnchor.position.set(
      0,
      motion.recoil.up * preset.recoil * height,
      motion.recoil.back * preset.recoil * DISTANCE,
    );
    this.recoilAnchor.rotation.x = motion.recoil.pitch * preset.recoil;

    if (delta > 0) {
      this.flash.update(delta, this.muzzlePoint(this.muzzleWorld));
      // La gravite des douilles est celle de la vue, a l'echelle de l'image.
      this.casings.update(delta, height * 2.4);
    }
  }

  /** Point du canon, en coordonnees du monde de l'arme. */
  muzzlePoint(out: THREE.Vector3): THREE.Vector3 {
    this.updateMuzzleAnchor();
    this.muzzleAnchor.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.muzzleAnchor.matrixWorld);
  }

  /**
   * Replace le point du canon. Les modeles du jeu portent un repere
   * d'assemblage nomme tag_flash ; les autres n'ont que leurs bornes, et le
   * canon est alors au bout du modele.
   */
  private updateMuzzleAnchor(): void {
    if (!this.current) {
      this.muzzleAnchor.position.set(0, 0, 0);
      return;
    }
    this.current.group.updateMatrix();
    if (this.current.md3?.tagMatrix('tag_flash', this.tagMatrix)) {
      this.localMuzzle.setFromMatrixPosition(this.tagMatrix);
      this.muzzleAnchor.position.copy(this.localMuzzle).applyMatrix4(this.current.group.matrix);
      return;
    }
    this.muzzleAnchor.position.copy(this.current.muzzle).applyMatrix4(this.current.group.matrix);
  }

  setVisible(visible: boolean): void {
    this.applySettings({ visible });
  }

  private async load(id: WeaponId): Promise<WeaponModel | null> {
    if (!this.vfs || !this.textures) return null;
    const directory = MODEL_DIRECTORIES[id];
    const path = `models/weapons2/${directory}/${directory}.md3`;
    const data = await this.vfs.read(path);
    if (!data) return null;

    try {
      const model = new Md3Model(data, path);
      const mesh = new Md3Mesh(model);
      await mesh.loadTextures(this.textures);
      mesh.setFrames(0, 0, 0);

      // Les modeles du jeu ne sont pas normalises : on les ramene a une unite
      // de long, comme les modeles de remplacement.
      const box = new THREE.Box3().setFromObject(mesh.group);
      const size = box.getSize(new THREE.Vector3());
      const longest = Math.max(size.x, size.y, size.z) || 1;
      mesh.group.scale.setScalar(1 / longest);
      const center = box.getCenter(new THREE.Vector3()).multiplyScalar(1 / longest);
      mesh.group.position.sub(center);

      return {
        group: mesh.group,
        md3: mesh,
        muzzle: new THREE.Vector3(0.5, 0, 0),
        points: samplePoints(mesh.group),
      };
    } catch (error) {
      console.warn(`${path} illisible :`, error);
      return null;
    }
  }
}

/**
 * Echantillon de sommets d'un modele, exprimes dans le repere de son groupe.
 * Quelques centaines de points suffisent a cerner une silhouette : le modele
 * en compte des dizaines de milliers, et la mesure tourne trente fois a chaque
 * changement de reglage.
 */
function samplePoints(model: THREE.Object3D, target = 700): Float32Array {
  model.updateWorldMatrix(true, true);
  const inverse = new THREE.Matrix4().copy(model.matrixWorld).invert();

  let total = 0;
  model.traverse((object) => {
    const mesh = object as THREE.Mesh;
    const attribute = mesh.isMesh ? mesh.geometry.getAttribute('position') : null;
    if (attribute) total += attribute.count;
  });
  if (total === 0) return new Float32Array(0);

  const stride = Math.max(1, Math.floor(total / target));
  const collected: number[] = [];
  const point = new THREE.Vector3();

  model.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const attribute = mesh.geometry.getAttribute('position');
    if (!attribute) return;
    // Les points reviennent dans le repere du groupe : le porte-arme les y
    // attend, quelle que soit la hierarchie interne du fichier.
    const toGroup = new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld);
    for (let index = 0; index < attribute.count; index += stride) {
      point.fromBufferAttribute(attribute as THREE.BufferAttribute, index);
      point.applyMatrix4(toGroup);
      collected.push(point.x, point.y, point.z);
    }
  });

  return new Float32Array(collected);
}

/** Droite et haut de la vue : de ce cote sortent les douilles. */
const RIGHT = new THREE.Vector3(1, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);

const WHITE = new THREE.Color(0xffffff);

function luminance(color: THREE.Color): number {
  return color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}
