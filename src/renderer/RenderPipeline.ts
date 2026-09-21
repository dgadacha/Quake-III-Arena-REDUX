import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { TAARenderPass } from 'three/examples/jsm/postprocessing/TAARenderPass.js';
import { ScaledGTAOPass } from './postprocessing/ScaledGTAOPass';
import { ToneMappingPass } from './postprocessing/ToneMappingPass';
import { NEUTRAL_GRADE, type MapGrade } from './grading/MapGrading';
import type { Renderer } from './Renderer';
import type { ModernRenderSettings, QualityLevel } from './RenderSettings';

/**
 * Chaine de rendu, montee dans un ordre fixe :
 *
 *   geometrie -> occlusion ambiante -> halo lumineux -> tone mapping et
 *   etalonnage -> anticrenelage -> affichage
 *
 * Elle est reconstruite quand un reglage change la composition des etapes, et
 * mise a jour sur place quand seul un parametre bouge.
 */
export class RenderPipeline {
  private composer: EffectComposer | null = null;
  private tonePass: ToneMappingPass | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private aoPass: GTAOPass | null = null;
  /**
   * Duree de chaque etape, en millisecondes. C'est le temps mis a envoyer les
   * commandes, pas celui mis par la carte graphique a les executer : le rendu
   * etant asynchrone, seule une extension de chronometrage donnerait le second,
   * et elle est rarement disponible. La mesure suffit a reperer l'etape qui
   * coute, ce qui est tout l'objet.
   */
  private readonly stageTimings = new Map<string, number>();
  private scene: THREE.Scene | null = null;
  private camera: THREE.Camera | null = null;
  /** Scene et camera de l'arme tenue en main, dessinees par-dessus le monde. */
  /** Intention de la carte affichee, gardee entre deux constructions. */
  private grade: MapGrade = NEUTRAL_GRADE;
  private overlayScene: THREE.Scene | null = null;
  private overlayCamera: THREE.Camera | null = null;
  private signature = '';

  constructor(private readonly renderer: Renderer) {}

  /** Change la scene rendue sans tout reconstruire si la composition tient. */
  setScene(scene: THREE.Scene, camera: THREE.Camera, settings: ModernRenderSettings): void {
    this.scene = scene;
    this.camera = camera;
    this.build(settings);
  }

  /**
   * Declare la scene de l'arme tenue en main. Elle a sa propre camera, avec un
   * champ de vision plus etroit que celui du monde, et passe apres lui : son
   * modele ne traverse donc jamais un mur dont on s'approche.
   */
  setOverlay(scene: THREE.Scene, camera: THREE.Camera, settings: ModernRenderSettings): void {
    this.overlayScene = scene;
    this.overlayCamera = camera;
    this.build(settings);
  }

  /** Signature des reglages qui imposent de remonter la chaine. */
  private static signatureOf(settings: ModernRenderSettings): string {
    return [
      settings.hdr,
      settings.bloom,
      settings.ambientOcclusion && settings.aoQuality !== 'off',
      settings.aoQuality,
      settings.antiAliasing,
      settings.renderScale,
    ].join('|');
  }

  applySettings(settings: ModernRenderSettings): void {
    if (!this.scene || !this.camera) return;
    if (RenderPipeline.signatureOf(settings) !== this.signature) {
      this.build(settings);
      return;
    }
    this.tonePass?.apply(settings);
    if (this.bloomPass) {
      this.bloomPass.threshold = settings.bloomThreshold;
      this.bloomPass.strength = settings.bloomStrength;
      this.bloomPass.radius = settings.bloomRadius;
    }
    if (this.aoPass) applyAoQuality(this.aoPass, settings.aoQuality);
  }

  private build(settings: ModernRenderSettings): void {
    if (!this.scene || !this.camera) return;
    this.dispose();

    const { width, height } = this.renderer.internalSize;
    const target = new THREE.WebGLRenderTarget(width, height, {
      // Sans tampon flottant, les sources vives se couperaient a 1.
      type: settings.hdr && this.renderer.supportsHDR ? THREE.HalfFloatType : THREE.UnsignedByteType,
      colorSpace: THREE.LinearSRGBColorSpace,
      samples: settings.antiAliasing === 'msaa' ? 4 : 0,
    });
    const composer = new EffectComposer(this.renderer.webgl, target);
    composer.setSize(width, height);

    if (settings.antiAliasing === 'taa') {
      const taa = new TAARenderPass(this.scene, this.camera, 0x000000, 0);
      taa.sampleLevel = 2;
      taa.unbiased = true;
      composer.addPass(taa);
    } else {
      composer.addPass(new RenderPass(this.scene, this.camera));
    }

    if (settings.ambientOcclusion && settings.aoQuality !== 'off') {
      const scale = settings.aoQuality === 'ultra' ? 1 : settings.aoQuality === 'high' ? 0.75 : 0.5;
      const ao = new ScaledGTAOPass(this.scene, this.camera, width, height, scale);
      ao.output = GTAOPass.OUTPUT.Default;
      applyAoQuality(ao, settings.aoQuality);
      composer.addPass(ao);
      this.aoPass = ao;
    } else {
      this.aoPass = null;
    }

    /*
     * L'arme tenue en main vient apres le monde et apres son occlusion : une
     * occlusion calculee sur la geometrie du decor assombrissait le modele des
     * qu'on longeait un mur. Le halo et l'etalonnage, eux, s'appliquent
     * ensuite aux deux : l'arme doit appartenir a l'image, pas y etre collee.
     */
    if (this.overlayScene && this.overlayCamera) {
      const overlay = new RenderPass(this.overlayScene, this.overlayCamera);
      // Le monde est deja dessine : on garde l'image et on repart d'une
      // profondeur vierge pour poser l'arme devant.
      overlay.clear = false;
      overlay.clearDepth = true;
      composer.addPass(overlay);
    }

    if (settings.bloom) {
      const bloom = new UnrealBloomPass(
        new THREE.Vector2(width, height),
        settings.bloomStrength,
        settings.bloomRadius,
        settings.bloomThreshold,
      );
      composer.addPass(bloom);
      this.bloomPass = bloom;
    } else {
      this.bloomPass = null;
    }

    const tone = new ToneMappingPass(settings);
    tone.setGrade(this.grade);
    composer.addPass(tone);
    this.tonePass = tone;

    if (settings.antiAliasing === 'smaa') composer.addPass(new SMAAPass(width, height));

    // ToneMappingPass produit deja le sRGB. SMAA travaille ainsi sur les
    // contrastes affiches et aucune copie plein ecran supplementaire n'est requise.

    // Chaque etape est enveloppee pour connaitre son cout.
    this.stageTimings.clear();
    for (const pass of composer.passes) this.instrument(pass);

    this.composer = composer;
    this.signature = RenderPipeline.signatureOf(settings);
  }

  /** Cout de chaque etape de la derniere image, du plus lourd au plus leger. */
  get timings(): { stage: string; ms: number }[] {
    return [...this.stageTimings.entries()]
      .map(([stage, ms]) => ({ stage, ms }))
      .sort((a, b) => b.ms - a.ms);
  }

  private instrument(pass: { render: (...args: never[]) => void; constructor: { name: string } }): void {
    const label = pass.constructor.name.replace(/^_/, '');
    const original = pass.render.bind(pass);
    const timings = this.stageTimings;
    pass.render = (...args: never[]) => {
      const start = performance.now();
      original(...args);
      timings.set(label, performance.now() - start);
    };
  }

  /**
   * Largeur, en pixels, du tampon dans lequel le monde est dessine. Elle suit
   * la resolution interne et la densite d'affichage, et change donc quand la
   * resolution dynamique reagit : ce qui se mesure en coordonnees de fragment
   * doit la relire a chaque image.
   */
  get bufferWidth(): number {
    return this.composer?.readBuffer?.width ?? this.renderer.internalSize.width;
  }

  /** Declare l'intention d'etalonnage de la carte affichee. */
  setMapGrade(grade: MapGrade): void {
    this.grade = grade;
    this.tonePass?.setGrade(grade);
  }

  setSize(width: number, height: number): void {
    // Le composer transmet deja la taille physique (avec le pixel ratio) a
    // toutes ses passes. Les redimensionner ensuite en pixels CSS desaccorde
    // les textures d'occlusion et de bloom sur les ecrans Retina.
    this.composer?.setSize(width, height);
  }

  render(): void {
    if (this.composer) this.composer.render();
    else if (this.scene && this.camera) this.renderer.webgl.render(this.scene, this.camera);
  }

  dispose(): void {
    // EffectComposer ne libere que ses propres cibles, pas celles des passes.
    for (const pass of this.composer?.passes ?? []) pass.dispose();
    this.composer?.dispose();
    this.composer = null;
  }
}

/** Nombre d'echantillons et portee de l'occlusion, selon le niveau demande. */
function applyAoQuality(pass: GTAOPass, quality: QualityLevel): void {
  const table: Record<Exclude<QualityLevel, 'off'>, { samples: number; radius: number; thickness: number }> = {
    low: { samples: 8, radius: 24, thickness: 10 },
    medium: { samples: 12, radius: 32, thickness: 14 },
    high: { samples: 16, radius: 48, thickness: 18 },
    ultra: { samples: 24, radius: 64, thickness: 22 },
  };
  const values = table[quality === 'off' ? 'low' : quality];
  pass.updateGtaoMaterial({
    radius: values.radius,
    distanceExponent: 2,
    thickness: values.thickness,
    scale: 1,
    samples: values.samples,
    // Au-dela du rayon, l'occlusion s'efface vite : sinon elle assombrit des
    // surfaces qui n'ont rien autour d'elles.
    distanceFallOff: 0.6,
    screenSpaceRadius: false,
  });
  /*
   * L'occlusion creuse les angles ; elle ne doit ni cerner les objets de noir
   * ni retirer la lumiere de la piece. Mesure a l'appui : a ce melange, elle
   * coute six pour cent de luminance moyenne dans un couloir et trois dans une
   * grande salle, ce qui est exactement le contact qu'on cherche.
   */
  pass.blendIntensity = quality === 'ultra' ? 0.6 : quality === 'high' ? 0.5 : 0.35;
}
