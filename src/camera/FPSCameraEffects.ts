/**
 * Effets de camera et d'arme. Tout ce qui est calcule ici est purement visuel :
 * le point de vue et l'arme affichee bougent, la visee ne bouge pas. Le tir
 * part toujours de la direction du regard telle que la simulation la connait.
 *
 * Quatre effets, tous coupables : balancement de l'arme au rythme de la marche,
 * retard de l'arme sur les mouvements de vue, recul au tir, et amorti de
 * reception apres une chute.
 */

export interface CameraEffectState {
  /** Vitesse horizontale, en unites par seconde. */
  speed: number;
  onGround: boolean;
  /** Vitesse verticale au moment du contact, positive vers le bas. */
  landingImpact: number;
  /** Variation d'angle de vue depuis l'image precedente, en radians. */
  yawDelta: number;
  pitchDelta: number;
}

export interface CameraEffectOptions {
  bobStrength: number;
  bobSpeed: number;
  swayStrength: number;
  recoilStrength: number;
  /**
   * Vitesse du retour apres le coup, propre a l'arme. L'amplitude ne change
   * pas : seule la duree du geste bouge, ce qui distingue le claquement d'un
   * fusil a pompe du rebond d'une mitrailleuse.
   */
  recoilSpeed: number;
  sway: boolean;
  recoil: boolean;
  landing: boolean;
  dynamicFov: boolean;
  /** Champ de vision de reference, en degres. */
  baseFov: number;
}

/**
 * Mouvements de l'arme tenue en main, separes par nature : chacun va sur son
 * propre point d'accroche, ce qui permet de les regler, de les couper ou de
 * les multiplier arme par arme sans qu'ils se melangent.
 *
 * Les decalages sont en part de l'image, les angles en radians, et le recul en
 * part de la distance qui separe l'arme de l'oeil.
 */
export interface ViewmodelMotion {
  bob: { x: number; y: number; roll: number };
  sway: { x: number; y: number; yaw: number; pitch: number };
  recoil: { back: number; up: number; pitch: number };
  /** Reception apres une chute : l'arme descend puis revient. */
  landing: number;
}

export interface CameraEffectResult {
  /** Decalage vertical du point de vue, en unites de carte. */
  viewOffset: number;
  motion: ViewmodelMotion;
  fov: number;
}

export const DEFAULT_EFFECT_OPTIONS: CameraEffectOptions = {
  bobStrength: 1,
  bobSpeed: 1,
  swayStrength: 1,
  recoilStrength: 1,
  recoilSpeed: 1,
  sway: true,
  recoil: true,
  landing: true,
  dynamicFov: true,
  baseFov: 90,
};

/*
 * Amplitudes de reference, exprimees en part de l'ecran. Elles sont
 * volontairement minuscules : le jeu se joue vite, et une arme qui se balance
 * genererait plus de gene qu'elle n'apporte de vie. Les reglages du joueur les
 * ponderent, ils ne les remplacent pas.
 */
const BOB_AMOUNT = 0.008;
const SWAY_AMOUNT = 0.012;
const RECOIL_AMOUNT = 0.015;

/** Vitesse de reference : celle du deplacement normal. */
const REFERENCE_SPEED = 320;

/*
 * Raideur du ressort de recul, et l'impulsion qui lui donne une amplitude de
 * un. L'amortissement mange pres des deux tiers de l'elan avant le point haut :
 * l'impulsion en tient compte, de sorte que l'amplitude de reference decrive
 * bien ce qu'on voit a l'ecran.
 */
const RECOIL_STIFFNESS = 260;
const RECOIL_PULSE = 40;

export class FPSCameraEffects {
  private options: CameraEffectOptions = { ...DEFAULT_EFFECT_OPTIONS };
  private bobPhase = 0;
  /** Recul en cours, et sa vitesse : un ressort amorti. */
  private recoil = 0;
  private recoilVelocity = 0;
  private landing = 0;
  private landingVelocity = 0;
  private swayYaw = 0;
  private swayPitch = 0;

  private readonly motion: ViewmodelMotion = {
    bob: { x: 0, y: 0, roll: 0 },
    sway: { x: 0, y: 0, yaw: 0, pitch: 0 },
    recoil: { back: 0, up: 0, pitch: 0 },
    landing: 0,
  };
  private readonly result: CameraEffectResult;

  constructor() {
    this.result = {
      viewOffset: 0,
      motion: this.motion,
      fov: DEFAULT_EFFECT_OPTIONS.baseFov,
    };
  }

  setOptions(options: Partial<CameraEffectOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /** Coup tire : l'arme recule puis revient, portee par son ressort. */
  kick(amount: number): void {
    if (!this.options.recoil) return;
    // L'elan suit la vitesse du ressort : l'amplitude atteinte reste la meme.
    this.recoilVelocity -= amount * RECOIL_PULSE * this.options.recoilSpeed;
  }

  /** Reception : la vue s'enfonce puis remonte. */
  land(impact: number): void {
    if (!this.options.landing) return;
    // En dessous d'une simple marche, la reception ne se voit pas.
    if (impact < 200) return;
    this.landingVelocity -= Math.min(1, impact / 700) * 26;
  }

  reset(): void {
    this.bobPhase = 0;
    this.recoil = 0;
    this.recoilVelocity = 0;
    this.landing = 0;
    this.landingVelocity = 0;
    this.swayYaw = 0;
    this.swayPitch = 0;
  }

  update(delta: number, state: CameraEffectState): CameraEffectResult {
    const options = this.options;
    const ratio = Math.min(1, state.speed / REFERENCE_SPEED);

    // Balancement : la phase avance avec la distance parcourue, pas avec le
    // temps, sinon le pas semble courir sur place a l'arret.
    if (state.onGround) this.bobPhase += delta * state.speed * 0.021 * options.bobSpeed;
    const bobScale = BOB_AMOUNT * options.bobStrength * ratio;
    const bob = state.onGround ? Math.sin(this.bobPhase) * bobScale : 0;
    const bobSide = state.onGround ? Math.sin(this.bobPhase * 0.5) * bobScale : 0;

    // Ressort du recul : rappel proportionnel a l'ecart, freinage proportionnel
    // a la vitesse. Les deux coefficients donnent un retour net et sans rebond.
    const speed = Math.max(0.2, options.recoilSpeed);
    const stiffness = RECOIL_STIFFNESS * speed * speed;
    this.recoilVelocity += (-this.recoil * stiffness - this.recoilVelocity * 22 * speed) * delta;
    this.recoil += this.recoilVelocity * delta;

    this.landingVelocity += (-this.landing * 180 - this.landingVelocity * 17) * delta;
    this.landing += this.landingVelocity * delta;

    if (options.sway) {
      /*
       * L'arme suit la vue avec un retard : l'ecart d'angle la pousse, puis
       * elle revient au centre. Le rattrapage est exponentiel et non
       * proportionnel au temps d'image : sans cela, le geste serait plus mou a
       * cent images par seconde qu'a soixante.
       */
      const follow = 1 - Math.exp(-9 * delta);
      this.swayYaw += (state.yawDelta - this.swayYaw) * follow;
      this.swayPitch += (state.pitchDelta - this.swayPitch) * follow;
    } else {
      this.swayYaw = 0;
      this.swayPitch = 0;
    }

    const sway = SWAY_AMOUNT * options.swayStrength;
    // Le ressort travaille vers l'arriere : on le lit a l'endroit.
    const kick = RECOIL_AMOUNT * options.recoilStrength * -this.recoil;

    this.motion.bob.x = bobSide * 0.6;
    this.motion.bob.y = bob;
    this.motion.bob.roll = bobSide * 0.6;

    this.motion.sway.x = -this.swayYaw * sway * 30;
    this.motion.sway.y = this.swayPitch * sway * 24;
    this.motion.sway.yaw = this.swayYaw * 0.3;
    this.motion.sway.pitch = this.swayPitch * 0.2;

    this.motion.recoil.back = kick;
    this.motion.recoil.up = kick * 0.6;
    this.motion.recoil.pitch = kick * 1.4;

    this.motion.landing = this.landing * 0.004;

    // Le point de vue ne bouge qu'a la reception : le balancement reste dans
    // l'arme, jamais dans la camera de visee.
    this.result.viewOffset = this.landing * (options.landing ? 1 : 0);
    this.result.fov = options.dynamicFov
      ? options.baseFov + Math.max(0, state.speed - REFERENCE_SPEED) * 0.006
      : options.baseFov;
    return this.result;
  }
}
