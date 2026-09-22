import * as THREE from 'three';
import { Contents, type Vec3 } from '../formats/bsp';
import { Renderer } from '../renderer/Renderer';
import { RenderPipeline } from '../renderer/RenderPipeline';
import { hdMaterials } from '../renderer/materials/HDMaterialLoader';
import { RenderSettingsStore, type ModernRenderSettings, type PresetName } from '../renderer/RenderSettings';
import { PerformanceHUD, type FrameMetrics } from '../renderer/debug/PerformanceHUD';
import { Effects } from '../renderer/effects/Effects';
import { WeaponSystem } from './weapons/WeaponSystem';
import { WorldEffects } from './entities/WorldEffects';
import { ItemManager } from './entities/Items';
import { PlayerState } from './PlayerState';
import type { UIManager } from '../ui/core/UIManager';
import { ReflectionProbeManager } from '../renderer/lighting/ReflectionProbeManager';
import { FPSCameraEffects } from '../camera/FPSCameraEffects';
import { ViewModel, type ViewModelSettings } from './weapons/ViewModel';
import { weaponPreset } from './weapons/WeaponPreset';
import type { WeaponId } from './weapons/WeaponDefs';
import type { GridSample } from '../bsp/LightGrid';
import {
  MaterialComparison,
  MaterialDebug,
  type ComparisonMode,
  type MaterialChannel,
} from '../renderer/debug/MaterialViews';
import {
  clearLiquids,
  setGridSpecular,
  setLightmapLift,
  setReflections,
  updateLiquids,
  updatePulses,
} from '../renderer/materials/Q3Material';
import { gradeFor, NEUTRAL_GRADE, type MapGrade } from '../renderer/grading/MapGrading';
import { FOCUS_MENU_VIEW } from './focus';
import { benchmarkShot, type BenchmarkShot } from '../renderer/debug/Benchmark';
import { buildCameraPath } from './benchmark/CameraPath';
import { BenchmarkRun, type BenchmarkReport } from './benchmark/BenchmarkRun';
import { measureTextureBudget } from '../renderer/debug/TextureBudget';

import { Input } from './input';
import { pickSpawn, type Level } from './level';
import { MoveConfig, PlayerMove, createMoveState, type MoveState } from './physics';

/**
 * Duree du rattrapage de la vue apres une marche, en secondes, et hauteur
 * maximale rattrapee. Ce sont les valeurs du jeu d'origine : deux dixiemes de
 * seconde, et trente-deux unites, soit deux marches.
 */
const STEP_SMOOTH_SECONDS = 0.2;
const MAX_STEP_SMOOTH = 32;

/**
 * Echelle de rendu de la vue du menu. Le decor y est un fond, pas une partie :
 * il n'a pas besoin de la resolution du jeu, et l'entree en partie la rend.
 */
const MENU_RENDER_SCALE = 0.75;

/**
 * Etalonnage du menu : la meme intention que la carte, ramenee a une ambiance
 * presque noire. L'exposition tombe, le contraste monte un peu, et les seules
 * choses qui restent lisibles sont les torches et la lave.
 */
function menuGrade(grade: MapGrade): MapGrade {
  return {
    ...grade,
    exposure: grade.exposure * 0.42,
    contrast: grade.contrast * 1.12,
    saturation: grade.saturation * 0.92,
  };
}

/** Ou en est l'essai en cours, pour l'afficher pendant le parcours. */
export interface BenchmarkProgress {
  warmingUp: boolean;
  progress: number;
  elapsed: number;
  duration: number;
  fps: number;
  segment: string;
}

export interface Stats extends FrameMetrics {
  /** Arme en main, affichee au joueur. */
  weapon: string;
  /** Etape la plus couteuse de la chaine de rendu, et son cout. */
  heaviestStage: string;
  heaviestStageMs: number;
  /** Vitesse horizontale : le chiffre que l'on regarde pour juger un enchainement de sauts. */
  speed: number;
  origin: Vec3;
  onGround: boolean;
  waterLevel: number;
}

/**
 * Assemble la simulation et le rendu. La simulation avance par pas fixes et le
 * rendu interpole entre deux pas : l'image reste fluide quel que soit le
 * nombre d'images par seconde, sans jamais modifier le mouvement.
 */
/** Armes qui ejectent une douille a chaque coup. */
const EJECTS_CASINGS = new Set<WeaponId>(['machinegun', 'shotgun']);

/** Les reglages de l'arme, tires de ceux du rendu. */
function weaponSettings(settings: ModernRenderSettings): ViewModelSettings {
  return {
    fov: settings.weaponFov,
    trimX: settings.weaponTrimX,
    trimY: settings.weaponTrimY,
    side: settings.weaponSide,
    visible: true,
  };
}

export class Session {
  readonly renderer: Renderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly input: Input;
  readonly settings = new RenderSettingsStore('high');
  readonly effects: Effects;
  readonly weapons: WeaponSystem;
  /** Sante, armure et munitions : ce que le HUD affiche. */
  readonly player = new PlayerState();

  private readonly pipeline: RenderPipeline;
  private readonly perf = new PerformanceHUD();
  private level: Level | null = null;
  private move: PlayerMove | null = null;
  private state: MoveState = createMoveState([0, 0, 0]);
  private running = false;
  private paused = false;
  private lastTime = 0;
  private bobPhase = 0;
  private readonly eye = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();
  /**
   * Brouillard applique par les materiaux. Deux objets, l'un lineaire et
   * l'autre exponentiel : changer de nature demande de recompiler, ce qui
   * n'arrive qu'en changeant de reglage, jamais en cours de partie.
   */
  private worldEffects: WorldEffects | null = null;
  private items: ItemManager | null = null;
  private ui: UIManager | null = null;
  private viewModel: ViewModel | null = null;
  private readonly cameraEffects = new FPSCameraEffects();
  private lastYaw = 0;
  private lastPitch = 0;
  /** Moyenne glissante du temps d'image, pour la resolution dynamique. */
  private smoothedFrameMs = 16;
  private scaleCooldown = 0;
  private readonly probe = new ReflectionProbeManager();
  /** Comparaison origine / refonte, et affichage d'une carte du materiau. */
  /** Intention d'etalonnage de la carte affichee. */
  private grade: MapGrade = NEUTRAL_GRADE;
  private histogramCanvas: HTMLCanvasElement | null = null;
  private readonly comparison = new MaterialComparison();
  private readonly materialDebug = new MaterialDebug();
  private readonly aimDirection = new THREE.Vector3(1, 0, 0);
  /** Eclairage lu dans la carte pour l'arme tenue en main. */
  private readonly gridSample: GridSample = {
    ambient: new THREE.Color(),
    directional: new THREE.Color(),
    direction: new THREE.Vector3(0, 0, 1),
  };
  private readonly viewRotation = new THREE.Quaternion();
  private readonly lightDirection = new THREE.Vector3();
  private readonly fogLinear = new THREE.Fog(0x0d1015, 2000, 8000);
  private readonly fogExponential = new THREE.FogExp2(0x0d1015, 0.0004);
  private fogKind: 'off' | 'linear' | 'exponential' = 'off';
  /** Hauteur de marche restant a rattraper par la vue, et son age. */
  private stepChange = 0;
  private stepAge = STEP_SMOOTH_SECONDS;

  onStats: ((stats: Stats) => void) | null = null;

  /**
   * Vue du menu : la carte est rendue derriere les entrees, presque noire.
   * L'etalonnage, l'echelle de rendu et la place de la camera sont mis de cote
   * pendant ce temps, et rendus au jeu quand le menu se ferme.
   */
  private menuView: { grade: MapGrade; drift: number; view: typeof FOCUS_MENU_VIEW } | null = null;

  /** Essai en cours : la camera suit un parcours et chaque image est comptee. */
  private bench: {
    run: BenchmarkRun;
    finish: (report: BenchmarkReport | null) => void;
    onProgress?: (info: BenchmarkProgress) => void;
    restore: { dynamicResolution: boolean; paused: boolean };
  } | null = null;

  constructor(canvas: HTMLCanvasElement) {
    // Les cartes sont decrites avec l'axe z vers le haut.
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

    this.renderer = new Renderer(canvas, this.settings.current);
    // Les cartes HD existent en deux versions : des blocs compresses, lus
    // directement par la carte graphique, et des PNG. Le choix se fait ici,
    // une fois pour la session, d'apres ce que le materiel sait lire.
    hdMaterials.setRenderer(this.renderer.webgl);
    this.pipeline = new RenderPipeline(this.renderer);
    this.camera = new THREE.PerspectiveCamera(90, 1, 1, 12000);
    this.camera.up.set(0, 0, 1);
    // La camera rejoint la scene : sans cela, ce qui lui est accroche, comme
    // l'arme tenue en main, n'est jamais parcouru au moment du rendu.
    this.scene.add(this.camera);

    this.effects = new Effects(this.settings.current);
    this.effects.attach(this.scene);
    this.weapons = new WeaponSystem(this.effects, this.effects.beams);
    this.weapons.attach(this.scene);

    this.input = new Input(canvas);
    this.input.onFire = (held) => this.weapons.setFiring(held);
    // Un tir ne part que si l'arme est en main et chargee.
    this.weapons.canFire = (weapon) => this.player.owned.has(weapon) && this.player.canFire(weapon);
    this.weapons.onEmpty = (weapon) => this.ui?.events.emit('weaponEmpty', { weapon });
    this.weapons.onSwitch = (weapon) =>
      this.ui?.events.emit('weaponSwitch', { weapon, owned: [...this.player.owned] });
    // Recul visuel : il depend de l'arme, jamais de sa precision.
    this.weapons.onFired = (definition) => {
      this.cameraEffects.kick(definition.flashSize * 0.06);
      // Depart de coup vu de l'arme : eclat, lampe courte, douille.
      this.viewModel?.fire(definition.color, EJECTS_CASINGS.has(definition.id));
      this.player.consume(definition.id);
      this.ui?.events.emit('weaponFire', { weapon: definition.id });
    };
    this.input.onSelectWeapon = (index) => this.weapons.selectIndex(index);
    this.input.onCycleWeapon = (step) => this.weapons.cycle(step);
    this.settings.subscribe((settings) => this.applySettings(settings));
    window.addEventListener('resize', this.resize);
    this.resize();
  }

  get currentLevel(): Level | null {
    return this.level;
  }

  /** Relie l'interface : la session la nourrit, elle ne la pilote pas. */
  attachUI(manager: UIManager): void {
    this.ui = manager;
  }

  /** Etat du joueur, expose pour la mise au point. */
  get playerState(): MoveState {
    return this.state;
  }

  applyPreset(preset: PresetName): void {
    this.settings.applyPreset(preset);
  }

  /** Remplace la carte affichee. */
  setLevel(level: Level): void {
    if (this.level) {
      this.scene.remove(this.level.root);
      disposeTree(this.level.root);
    }
    this.level = level;
    this.scene.add(level.root);
    this.scene.background = level.sky ?? level.skyColor;
    // Le brouillard est calcule sur l'image finie, pas par materiau.
    this.scene.fog = null;

    clearLiquids();
    this.effects.clear();
    this.weapons.clear();
    this.weapons.setTrace((start, end, mins, maxs, mask) =>
      level.collision.trace(start, end, mins, maxs, mask),
    );
    // Lueurs, tremplins, teleporteurs et braises : lus dans la carte.
    this.worldEffects = level.map ? new WorldEffects(level.map, level.root, this.effects) : null;

    // Objets a ramasser : la lueur s'eteint avec l'objet et revient avec lui.
    this.items = level.map ? new ItemManager(level.map) : null;
    if (this.items) {
      this.items.onAvailabilityChange = (key, available) =>
        this.worldEffects?.setGlowVisible(key, available);
    }
    this.ui?.state.setMatch({ map: level.name, time: 0, countdown: false, score: 0 });

    // Arme tenue en main. Le modele vient des archives de la carte quand il y
    // en a, sinon du modele de remplacement, qui ne demande rien.
    this.viewModel = new ViewModel(level.vfs ?? null, level.textures ?? null);
    this.viewModel.applySettings(weaponSettings(this.settings.current));
    this.viewModel.setViewport(window.innerWidth, window.innerHeight);
    this.pipeline.setOverlay(this.viewModel.scene, this.viewModel.camera, this.settings.current);
    void this.viewModel.setWeapon(this.weapons.currentId);
    this.cameraEffects.reset();

    /*
     * Etalonnage de la carte : ce qui donne son caractere a une arene, par
     * dessus les reglages du joueur.
     */
    this.grade = gradeFor(level.name);
    this.pipeline.setMapGrade(this.grade);

    // Outils de jugement : ils tiennent les materiaux des surfaces.
    this.comparison.attach(level.root);
    this.materialDebug.attach(level.root);

    this.move = new PlayerMove(level.collision);
    this.respawn();
    this.pipeline.setScene(this.scene, this.camera, this.settings.current);

    /*
     * Ou poser les sondes de reflet. Les points de depart de la carte sont un
     * bon jeu de positions : ils sont repartis dans tout l'espace jouable, a
     * hauteur d'oeil, et le concepteur les a places dans les pieces qui
     * comptent. Elles sont ensuite ecartees entre elles par le gestionnaire.
     */
    if (this.settings.current.reflections) {
      this.probe.place(
        level.spawns.map(
          (spawn) => new THREE.Vector3(spawn.origin[0], spawn.origin[1], spawn.origin[2] + 40),
        ),
      );
      setReflections(true);
    } else {
      this.probe.dispose();
      setReflections(false);
    }
  }

  respawn(): void {
    if (!this.level) return;
    const spawn = pickSpawn(this.level);
    this.state = createMoveState([...spawn.origin] as Vec3);
    this.input.setAngles(spawn.yaw, 0);
    this.player.reset();
    this.items?.reset();
    this.weapons.select('machinegun');
    this.cameraEffects.reset();
    this.ui?.events.emit('playerSpawn', undefined);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
  }

  /** Le menu suspend la simulation, le rendu continue. */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /**
   * Resolution interne ajustee sur la cadence visee. Elle ne descend jamais
   * sous les deux tiers, et remonte des que la marge revient ; un delai entre
   * deux changements evite l'oscillation. La simulation n'en sait rien.
   */
  private adjustResolution(delta: number): void {
    const settings = this.settings.current;
    if (!settings.dynamicResolution) return;

    // Les images du chargement durent des centaines de millisecondes : les
    // compter ferait chuter la resolution alors que la machine n'y est pour
    // rien. Au-dela de cent millisecondes, l'image est ignoree.
    const frameMs = delta * 1000;
    if (frameMs > 100) return;
    // Moyenne glissante : une image isolee ne doit pas faire bouger l'echelle.
    this.smoothedFrameMs += (frameMs - this.smoothedFrameMs) * 0.1;
    this.scaleCooldown -= delta;
    if (this.scaleCooldown > 0) return;

    const budget = 1000 / Math.max(30, settings.targetFps);
    const current = this.renderer.renderScale;
    if (this.smoothedFrameMs > budget * 1.2 && current > 0.66) {
      this.renderer.setRenderScale(Math.max(0.66, current - 0.05));
      this.scaleCooldown = 0.5;
      this.resize();
    } else if (this.smoothedFrameMs < budget * 0.8 && current < settings.renderScale) {
      this.renderer.setRenderScale(Math.min(settings.renderScale, current + 0.05));
      this.scaleCooldown = 1;
      this.resize();
    }
  }

  private applySettings(settings: ModernRenderSettings): void {
    this.renderer.applySettings(settings);
    this.pipeline.applySettings(settings);
    this.effects.applySettings(settings);
    setGridSpecular(settings.gridSpecular);
    setLightmapLift(settings.lightmapLift);
    this.viewModel?.applySettings(weaponSettings(settings));
    this.resize();
  }

  /**
   * Eclaire l'arme tenue en main avec la lumiere de l'endroit. La grille
   * d'eclairage de la carte donne, a la position du joueur, une ambiance, une
   * couleur directionnelle et la direction d'ou vient la lumiere : c'est ce
   * qui eclaire les objets mobiles dans le jeu d'origine. La direction est
   * ramenee dans le repere de la vue, seul repere que connait la scene de
   * l'arme.
   */
  private updateWeaponLighting(): void {
    const grid = this.level?.grid;
    if (!this.viewModel || !grid) return;
    grid.sample([this.eye.x, this.eye.y, this.eye.z], this.gridSample);
    this.camera.getWorldQuaternion(this.viewRotation);
    this.viewRotation.invert();
    this.lightDirection.copy(this.gridSample.direction).applyQuaternion(this.viewRotation);
    this.viewModel.setEnvironment({
      ambient: this.gridSample.ambient,
      directional: this.gridSample.directional,
      direction: this.lightDirection,
    });
  }

  /**
   * Place la vue a un point de calibration et arrete le temps. Toujours la
   * meme position, la meme orientation et le meme champ de vision : c'est la
   * seule facon de comparer deux reglages.
   */
  /**
   * Ce que la vue rencontre a un point de l'ecran, en coordonnees de moins un
   * a un. Sert a nommer une surface dont on se demande ce qu'elle est.
   */
  pick(x = 0, y = 0): { name: string; distance: number; material: string } | null {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(x, y), this.camera);
    raycaster.far = 8000;
    const hits = raycaster.intersectObjects(this.scene.children, true);
    for (const hit of hits) {
      const mesh = hit.object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible) continue;
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      return {
        name: mesh.name || mesh.type,
        distance: Math.round(hit.distance),
        material: (material as THREE.Material)?.type ?? '',
      };
    }
    return null;
  }

  /** Ce que les textures de la carte affichee occupent en memoire video. */
  textureBudget() {
    return measureTextureBudget(this.scene);
  }

  /**
   * Lance le banc de mesure sur la carte affichee.
   *
   * La simulation est suspendue et la resolution interne figee : un essai dont
   * la resolution bouge en cours de route ne mesure plus les reglages, il
   * mesure la resolution. Rend rien quand la carte n'offre pas de quoi tracer
   * un parcours, comme l'arene fabriquee par le code.
   */
  /**
   * Montre la carte derriere le menu. La simulation attend, la camera reste
   * presque immobile, et l'image est ramenee a une ambiance tres sombre : le
   * menu doit se lire par-dessus sans que le decor lui dispute l'attention.
   */
  enterMenuView(view = FOCUS_MENU_VIEW): void {
    if (!this.level || this.menuView) return;
    const grade = this.grade;
    this.menuView = { grade, drift: 0, view };
    this.setPaused(true);
    this.input.releaseLock();
    this.input.setAngles(view.yaw, view.pitch);
    this.state.origin[0] = view.origin[0];
    this.state.origin[1] = view.origin[1];
    this.state.origin[2] = view.origin[2];
    this.state.previousOrigin[0] = view.origin[0];
    this.state.previousOrigin[1] = view.origin[1];
    this.state.previousOrigin[2] = view.origin[2];
    this.state.velocity[0] = 0;
    this.state.velocity[1] = 0;
    this.state.velocity[2] = 0;

    // L'arme tenue en main n'a rien a faire dans un menu.
    if (this.viewModel) this.viewModel.scene.visible = false;
    // Le decor du menu ne merite pas la resolution du jeu : elle est rendue
    // au premier lancement de partie.
    this.renderer.setRenderScale(Math.min(this.settings.current.renderScale, MENU_RENDER_SCALE));
    this.resize();
    this.pipeline.setMapGrade(menuGrade(grade));
  }

  /** Rend au jeu ce que la vue du menu avait mis de cote. */
  leaveMenuView(): void {
    const view = this.menuView;
    if (!view) return;
    this.menuView = null;
    if (this.viewModel) this.viewModel.scene.visible = true;
    this.renderer.setRenderScale(this.settings.current.renderScale);
    this.resize();
    this.pipeline.setMapGrade(view.grade);
  }

  get inMenuView(): boolean {
    return this.menuView !== null;
  }

  runBenchmark(onProgress?: (info: BenchmarkProgress) => void): Promise<BenchmarkReport | null> {
    if (this.bench) return Promise.resolve(null);
    if (!this.level) return Promise.resolve(null);
    const path = buildCameraPath(this.level);
    if (!path) return Promise.resolve(null);

    const settings = this.settings.current;
    const restore = { dynamicResolution: settings.dynamicResolution, paused: this.paused };
    this.settings.patch({ dynamicResolution: false });
    this.renderer.setRenderScale(settings.renderScale);
    this.resize();
    this.input.releaseLock();
    this.setPaused(true);
    /*
     * L'arme tenue en main n'a rien a faire dans un parcours de mesure : la
     * simulation etant suspendue, elle resterait figee dans un coin de
     * l'image. Son cout de rendu est negligeable devant celui du decor.
     */
    if (this.viewModel) this.viewModel.scene.visible = false;

    const run = new BenchmarkRun(path, this.level.name);
    return new Promise((resolve) => {
      this.bench = { run, finish: resolve, onProgress, restore };
    });
  }

  /** Arrete l'essai en cours sans resultat. */
  cancelBenchmark(): void {
    if (!this.bench) return;
    const { finish } = this.bench;
    this.closeBenchmark();
    finish(null);
  }

  get benchmarking(): boolean {
    return this.bench !== null;
  }

  /**
   * Derive de la vue du menu. Quelques unites de deplacement et un dixieme de
   * degre de rotation sur une vingtaine de secondes : de quoi sentir la
   * profondeur, pas de quoi croire a un economiseur d'ecran.
   */
  private driftMenuView(delta: number): void {
    const view = this.menuView;
    if (!view) return;
    view.drift += delta;
    const sway = Math.sin(view.drift * 0.26);
    const rise = Math.sin(view.drift * 0.17 + 1.2);
    const { origin, yaw, pitch } = view.view;
    this.state.origin[0] = origin[0] + sway * 3;
    this.state.origin[1] = origin[1] + rise * 2;
    this.state.origin[2] = origin[2] + rise * 1.5;
    this.state.previousOrigin[0] = this.state.origin[0];
    this.state.previousOrigin[1] = this.state.origin[1];
    this.state.previousOrigin[2] = this.state.origin[2];
    this.input.setAngles(yaw + sway * 0.0026, pitch + rise * 0.0018);
  }

  /** Une image de l'essai : la camera avance, le temps passe est compte. */
  private driveBenchmark(delta: number): void {
    const active = this.bench;
    if (!active) return;

    // Une fenetre masquee suspend l'animation : l'essai ne mesure plus rien.
    if (document.hidden) active.run.noteHidden();
    const { sample, done } = active.run.advance(delta);
    this.state.origin[0] = sample.origin[0];
    this.state.origin[1] = sample.origin[1];
    this.state.origin[2] = sample.origin[2];
    this.state.previousOrigin[0] = sample.origin[0];
    this.state.previousOrigin[1] = sample.origin[1];
    this.state.previousOrigin[2] = sample.origin[2];
    this.state.velocity[0] = 0;
    this.state.velocity[1] = 0;
    this.state.velocity[2] = 0;
    this.input.setAngles(sample.yaw, sample.pitch);

    active.onProgress?.({
      warmingUp: active.run.warmingUp,
      progress: active.run.progress,
      elapsed: active.run.elapsed,
      duration: active.run.duration,
      fps: active.run.liveFps,
      segment: active.run.segmentName,
    });

    if (!done) return;
    const report = active.run.report(this.describeSettings(), { ...this.renderer.internalSize });
    const { finish } = active;
    this.closeBenchmark();
    finish(report);
  }

  /** Rend au jeu ce que l'essai avait mis de cote. */
  private closeBenchmark(): void {
    const active = this.bench;
    if (!active) return;
    this.bench = null;
    if (this.viewModel) this.viewModel.scene.visible = true;
    this.settings.patch({ dynamicResolution: active.restore.dynamicResolution });
    this.setPaused(active.restore.paused);
  }

  /**
   * Reglages employes par l'essai. Un resultat sans eux ne veut rien dire :
   * c'est la premiere chose qu'on regarde en comparant deux chiffres.
   */
  private describeSettings(): { label: string; value: string }[] {
    const settings = this.settings.current;
    const { width, height } = this.renderer.internalSize;
    const onOff = (value: boolean) => (value ? 'on' : 'off');
    return [
      { label: 'Preset', value: this.settings.presetName },
      { label: 'Render buffer', value: `${width} x ${height}` },
      { label: 'Internal resolution', value: `${Math.round(settings.renderScale * 100)} %` },
      { label: 'Antialiasing', value: settings.antiAliasing },
      { label: 'Ambient occlusion', value: settings.ambientOcclusion ? settings.aoQuality : 'off' },
      { label: 'Shadows', value: settings.shadows ? settings.shadowQuality : 'off' },
      { label: 'Bloom', value: onOff(settings.bloom) },
      { label: 'Reflections', value: onOff(settings.reflections) },
      { label: 'HD materials', value: onOff(settings.hdMaterials) },
      { label: 'Micro detail', value: settings.microDetail > 0 ? `${Math.round(settings.microDetail * 100)} %` : 'off' },
      { label: 'Dynamic lights', value: settings.dynamicLights ? String(settings.maxDynamicLights) : 'off' },
      { label: 'Anisotropic filtering', value: `x${settings.anisotropy}` },
    ];
  }

  /**
   * Place la vue a un point donne et arrete le temps. Sert a retrouver
   * exactement la vue d'une capture : le point de calibration est fixe, celui
   * dont on parle ne l'est pas.
   */
  place(x: number, y: number, z: number, yaw = 0, pitch = 0): void {
    this.state.origin[0] = x;
    this.state.origin[1] = y;
    this.state.origin[2] = z;
    this.state.previousOrigin[0] = x;
    this.state.previousOrigin[1] = y;
    this.state.previousOrigin[2] = z;
    this.state.velocity[0] = 0;
    this.state.velocity[1] = 0;
    this.state.velocity[2] = 0;
    this.input.setAngles(yaw, pitch);
    // Le temps est arrete avant de dessiner : un pas de simulation de duree
    // nulle laisse des valeurs invalides dans l'etat du joueur. Les
    // animations, elles, continuent d'avancer.
    this.setPaused(true);
    this.update(0);
    this.pipeline.render();
  }

  benchmark(index = 0): BenchmarkShot {
    const shot = benchmarkShot(index);
    this.state.origin[0] = shot.origin[0];
    this.state.origin[1] = shot.origin[1];
    this.state.origin[2] = shot.origin[2];
    this.state.previousOrigin[0] = shot.origin[0];
    this.state.previousOrigin[1] = shot.origin[1];
    this.state.previousOrigin[2] = shot.origin[2];
    this.state.velocity[0] = 0;
    this.state.velocity[1] = 0;
    this.state.velocity[2] = 0;
    this.input.setAngles(shot.yaw, shot.pitch);
    this.camera.fov = shot.fov;
    this.camera.updateProjectionMatrix();
    this.setPaused(true);
    this.update(0);
    this.pipeline.render();
    return shot;
  }

  /**
   * Distribution de luminance de l'image affichee.
   *
   * C'est la mesure qui dit si les ombres sont ecrasees : une part importante
   * de pixels sous un centieme signifie que la matiere a disparu, quel que
   * soit le ressenti devant l'ecran. Rend aussi la part de pixels brules, pour
   * verifier qu'on ne corrige pas un exces par un autre.
   */
  histogram(samples = 320): {
    moyenne: number;
    median: number;
    sous001: number;
    sous003: number;
    sous005: number;
    sur095: number;
  } {
    const canvas = this.renderer.webgl.domElement;
    if (!this.histogramCanvas) {
      this.histogramCanvas = document.createElement('canvas');
    }
    const scratch = this.histogramCanvas;
    const height = Math.max(1, Math.round((samples * canvas.height) / Math.max(1, canvas.width)));
    scratch.width = samples;
    scratch.height = height;
    const context = scratch.getContext('2d');
    if (!context) {
      return { moyenne: 0, median: 0, sous001: 0, sous003: 0, sous005: 0, sur095: 0 };
    }

    // Le tampon de dessin est perdu a la fin de l'image : on redessine, puis
    // on lit dans la meme tache.
    this.pipeline.render();
    context.drawImage(canvas, 0, 0, samples, height);
    const data = context.getImageData(0, 0, samples, height).data;

    const values: number[] = [];
    let total = 0;
    let dark1 = 0;
    let dark3 = 0;
    let dark5 = 0;
    let bright = 0;
    for (let index = 0; index < data.length; index += 4) {
      const luminance =
        (data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722) / 255;
      values.push(luminance);
      total += luminance;
      if (luminance < 0.01) dark1++;
      if (luminance < 0.03) dark3++;
      if (luminance < 0.05) dark5++;
      if (luminance > 0.95) bright++;
    }
    values.sort((a, b) => a - b);
    const count = values.length || 1;
    const percent = (value: number) => Math.round((value / count) * 1000) / 10;
    return {
      moyenne: Math.round((total / count) * 1000) / 1000,
      median: Math.round(values[Math.floor(count / 2)] * 1000) / 1000,
      sous001: percent(dark1),
      sous003: percent(dark3),
      sous005: percent(dark5),
      sur095: percent(bright),
    };
  }

  /** Passe a la vue de comparaison suivante : refonte, origine, image coupee. */
  cycleComparison(): { mode: ComparisonMode; converted: number } {
    const mode = this.comparison.next();
    return { mode, converted: this.comparison.converted };
  }

  /**
   * Passe a la carte de materiau suivante. Revenu a l'image finie, la vue de
   * comparaison reprend la main.
   */
  cycleMaterialChannel(): MaterialChannel {
    const channel = this.materialDebug.next();
    if (channel === 'final') this.comparison.setMode(this.comparison.current);
    return channel;
  }

  /** Ou l'arme se trouve a l'ecran, pour regler sa place sur des nombres. */
  measureViewModel(): ReturnType<ViewModel['measure']> {
    return this.viewModel?.measure() ?? null;
  }

  private resize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setViewport(width, height);
    const internal = this.renderer.internalSize;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.viewModel?.setViewport(width, height);
    this.pipeline.setSize(internal.width, internal.height);
  };

  private frame = (now: number): void => {
    if (!this.running) return;
    requestAnimationFrame(this.frame);

    const delta = Math.min((now - this.lastTime) / 1000, 0.25);
    this.lastTime = now;

    this.perf.beginFrame();
    // Redimensionner le canevas efface son contenu : toujours le faire avant
    // de dessiner l'image qui sera presentee par le navigateur.
    this.adjustResolution(delta);
    this.update(delta);

    /*
     * Sondes de reflet : une par image, et seulement une fois la carte
     * affichee. Six rendus du decor entier par sonde ; les prendre toutes dans
     * la meme image se verrait, et les prendre avant l'affichage retarderait
     * l'entree en jeu.
     */
    if (this.level && this.probe.remaining > 0) {
      // Une sonde voit depuis sa propre position. La visibilite du joueur
      // retirait des murs de sa capture et les reflets montraient du ciel.
      this.level.visibility?.showAll();
      this.probe.captureNext(this.renderer.webgl, this.scene);
      this.level.visibility?.update([this.eye.x, this.eye.y, this.eye.z]);
      this.scene.environment = this.probe.texture;
    } else if (this.level && this.probe.follow(this.camera.position)) {
      // La sonde la plus proche a change de piece avec le joueur.
      this.scene.environment = this.probe.texture;
    }

    this.pipeline.render();

    const counts = this.effects.counts;
    const metrics = this.perf.endFrame(this.renderer.webgl, delta, {
      renderScale: this.renderer.renderScale,
      activeLights: countLitLights(this.scene),
      activeParticles: counts.particles,
      activeDecals: counts.decals,
    });
    const heaviest = this.pipeline.timings[0];
    this.onStats?.({
      ...metrics,
      weapon: this.weapons.current.name,
      heaviestStage: heaviest?.stage ?? '',
      heaviestStageMs: heaviest?.ms ?? 0,
      speed: Math.hypot(this.state.velocity[0], this.state.velocity[1]),
      origin: [...this.state.origin] as Vec3,
      onGround: this.state.onGround,
      waterLevel: this.state.waterLevel,
    });
  };

  private update(delta: number): void {
    if (!this.level || !this.move) return;

    const input = this.input.sample();
    // Banc de mesure : la camera suit son parcours, la simulation attend.
    if (this.bench) this.driveBenchmark(delta);
    if (this.menuView) this.driftMenuView(delta);
    if (!this.paused) {
      this.move.step(this.state, input, delta);

      const effect = this.level.triggers?.apply(this.state, (yaw) =>
        this.input.setAngles(yaw, this.input.angles.pitch),
      );
      if (effect === 'teleport') {
        this.scratch.set(this.state.origin[0], this.state.origin[1], this.state.origin[2] + 24);
        this.worldEffects?.flashTeleport(this.scratch, this.eye);
        this.effects.trails.clear();
      } else if (effect === 'push') {
        this.scratch.set(this.state.origin[0], this.state.origin[1], this.state.origin[2]);
        this.worldEffects?.burstJumppad(this.scratch);
      }
      // Tombe hors de la carte ou passe dans une zone mortelle : on repart.
      const fell = this.level.floor !== undefined && this.state.origin[2] < this.level.floor;
      if (effect === 'respawn' || fell) this.respawn();
    }

    // Position de rendu : entre le pas precedent et le pas courant.
    const alpha = this.move.alpha;
    const previous = this.state.previousOrigin;
    const origin = this.state.origin;
    const x = previous[0] + (origin[0] - previous[0]) * alpha;
    const y = previous[1] + (origin[1] - previous[1]) * alpha;
    const z = previous[2] + (origin[2] - previous[2]) * alpha;

    const time = performance.now() / 1000;
    for (const animate of this.level.animated) animate(time, this.state.origin, delta);
    this.worldEffects?.update(delta, time, this.eye);
    updateLiquids(time);
    updatePulses(time);

    // Etat du joueur : exces de sante qui redescend, objets ramasses.
    this.player.update(delta);
    const taken = this.items?.update(delta, this.state.origin, this.player) ?? [];
    for (const pickup of taken) {
      this.ui?.events.emit('pickup', { label: pickup.label, kind: pickup.kind });
      if (pickup.kind === 'health' || pickup.kind === 'armor') {
        this.ui?.events.emit('playerHeal', { amount: 0 });
      }
    }

    // Mort : on repart aussitot, sans ecran intermediaire pour l'instant.
    if (!this.player.alive) {
      this.ui?.events.emit('playerDeath', { reason: 'combat' });
      this.respawn();
    }

    if (this.ui) {
      this.ui.state.setPlayer(this.player.snapshot(this.weapons.currentId));
      this.ui.state.setOwned([...this.player.owned]);
      this.ui.state.setSpeed(Math.hypot(this.state.velocity[0], this.state.velocity[1]));
      // Le chronometre est la seule valeur lue a chaque image.
      this.ui.state.setMatch({ time: this.ui.state.current.match.time + delta });
      this.ui.update(delta);
    }

    /*
     * Amorti des marches.
     *
     * Le franchissement d'une marche deplace le joueur d'un cran vers le haut
     * en une seule commande. Prise telle quelle, la vue saute a chaque marche
     * et un escalier se monte par saccades, ce qu'on lit comme un accrochage.
     * Le jeu d'origine garde donc la vue en arriere de la montee et la rattrape
     * en deux dixiemes de seconde : la hauteur restante s'ajoute a la marche
     * suivante, bornee, de sorte qu'un escalier entier se monte d'un glissement
     * continu.
     */
    const climbed = this.state.stepped;
    this.state.stepped = 0;
    if (climbed > 0.1) {
      const remaining = this.stepAge < STEP_SMOOTH_SECONDS
        ? this.stepChange * (1 - this.stepAge / STEP_SMOOTH_SECONDS)
        : 0;
      this.stepChange = Math.min(MAX_STEP_SMOOTH, remaining + climbed);
      this.stepAge = 0;
    }
    this.stepAge += delta;
    const stepLag = this.stepAge < STEP_SMOOTH_SECONDS
      ? this.stepChange * (1 - this.stepAge / STEP_SMOOTH_SECONDS)
      : 0;

    // Balancement de la marche, tres leger, uniquement au sol.
    const horizontal = Math.hypot(this.state.velocity[0], this.state.velocity[1]);
    if (this.state.onGround) this.bobPhase += delta * horizontal * 0.02;
    const bob = this.state.onGround
      ? Math.sin(this.bobPhase) * Math.min(horizontal / MoveConfig.speed, 1) * 0.8
      : 0;

    // Effets de vue : balancement, retard de l'arme, recul, reception.
    const { yaw: currentYaw, pitch: currentPitch } = this.input.angles;
    this.cameraEffects.setOptions({
      bobStrength: this.settings.current.weaponBob ? this.settings.current.weaponBobStrength : 0,
      swayStrength: this.settings.current.weaponSwayStrength,
      recoilStrength: this.settings.current.weaponRecoilStrength,
      // Le geste du recul appartient a l'arme tenue en main.
      recoilSpeed: weaponPreset(this.weapons.currentId).recoilSpeed,
      sway: this.settings.current.weaponSway,
      recoil: this.settings.current.viewRecoil,
      landing: this.settings.current.viewRecoil,
      dynamicFov: this.settings.current.dynamicFov,
      baseFov: 90,
    });
    if (this.state.landed > 0) {
      this.cameraEffects.land(this.state.landed);
      // Une reception violente coute de la sante, comme a l'origine.
      const lost = this.player.fallDamage(this.state.landed);
      if (lost > 0) this.ui?.events.emit('playerDamage', { amount: lost });
      this.state.landed = 0;
    }
    const viewEffects = this.cameraEffects.update(delta, {
      speed: horizontal,
      onGround: this.state.onGround,
      landingImpact: 0,
      yawDelta: shortestAngle(currentYaw - this.lastYaw),
      pitchDelta: currentPitch - this.lastPitch,
    });
    this.lastYaw = currentYaw;
    this.lastPitch = currentPitch;

    if (Math.abs(this.camera.fov - viewEffects.fov) > 0.05) {
      this.camera.fov = viewEffects.fov;
      this.camera.updateProjectionMatrix();
    }
    this.viewModel?.update(viewEffects.motion, delta);
    this.updateWeaponLighting();
    void this.viewModel?.setWeapon(this.weapons.currentId);

    this.eye.set(x, y, z + this.state.viewHeight + bob + viewEffects.viewOffset - stepLag);

    // Les effets rendent le tremblement de camera ; il decale le point de vue
    // et le point vise du meme vecteur, de sorte que la visee ne bouge pas.
    const shake = this.effects.update(delta, this.eye, this.camera);
    this.camera.position.copy(this.eye).add(shake);

    const yaw = currentYaw;
    const pitch = currentPitch;
    const cosPitch = Math.cos(pitch);
    this.lookTarget.set(
      this.eye.x + cosPitch * Math.cos(yaw),
      this.eye.y + cosPitch * Math.sin(yaw),
      this.eye.z - Math.sin(pitch),
    ).add(shake);
    this.camera.lookAt(this.lookTarget);
    this.camera.updateMatrixWorld();

    // Direction de tir : celle du regard, prise avant le tremblement.
    this.aimDirection
      .set(cosPitch * Math.cos(yaw), cosPitch * Math.sin(yaw), -Math.sin(pitch))
      .normalize();
    if (!this.paused) this.weapons.update(delta, this.eye, this.aimDirection);

    this.updateFog();
  }

  /**
   * Choix du brouillard pour l'image en cours. Rien n'est ajoute d'office : une
   * carte sans brouillard reste nette, comme a l'origine. Seules l'immersion et
   * les volumes declares par la carte en produisent.
   */
  private updateFog(): void {
    if (!this.level) return;
    if (!this.settings.current.fog) {
      this.setFog('off');
      return;
    }

    // Tete sous la surface : la portee s'effondre et l'image prend la teinte
    // du liquide traverse.
    if (this.state.waterLevel >= 3) {
      const lava = (this.state.waterType & Contents.LAVA) !== 0;
      const slime = (this.state.waterType & Contents.SLIME) !== 0;
      this.fogExponential.color.setHex(lava ? 0xff5a1e : slime ? 0x4f7a2a : 0x2d5f70);
      this.fogExponential.density = lava ? 0.05 : slime ? 0.015 : 0.004;
      this.setFog('exponential');
      return;
    }

    const declared = this.level.fogAt?.([this.eye.x, this.eye.y, this.eye.z]);
    if (declared) {
      this.fogExponential.color.copy(declared.color);
      // La distance annoncee est celle ou le fond a disparu.
      this.fogExponential.density = 3 / Math.max(64, declared.depthForOpaque);
      this.setFog('exponential');
      return;
    }

    /*
     * Brouillard d'ambiance de la carte. Il ne vient pas d'office : seules les
     * cartes dont l'etalonnage en declare un en recoivent, et seulement la ou
     * la carte elle-meme n'en pose pas.
     */
    const ambient = this.grade.fog;
    if (ambient) {
      this.fogExponential.color.set(ambient.color);
      this.fogExponential.density = ambient.density;
      this.setFog('exponential');
      return;
    }

    this.setFog('off');
  }

  /** Changer la nature du brouillard demande de recompiler les materiaux. */
  private setFog(kind: 'off' | 'linear' | 'exponential'): void {
    if (this.fogKind === kind) return;
    this.fogKind = kind;
    this.scene.fog = kind === 'off' ? null : kind === 'linear' ? this.fogLinear : this.fogExponential;
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) material.needsUpdate = true;
    });
  }
}

/** Ecart d'angle le plus court entre deux orientations. */
function shortestAngle(delta: number): number {
  let value = delta;
  while (value > Math.PI) value -= Math.PI * 2;
  while (value < -Math.PI) value += Math.PI * 2;
  return value;
}

function countLitLights(scene: THREE.Scene): number {
  /*
   * Les lampes de la reserve ne quittent jamais la scene : les masquer
   * changerait le nombre de lumieres visibles et ferait recompiler tous les
   * materiaux. On compte donc celles qui eclairent vraiment.
   */
  let count = 0;
  scene.traverse((object) => {
    const light = object as THREE.Light;
    if (light.isLight && light.visible && light.intensity > 0.01) count++;
  });
  return count;
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      material.dispose();
    }
  });
}
