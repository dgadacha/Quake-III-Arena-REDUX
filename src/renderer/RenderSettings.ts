/**
 * Reglages du rendu moderne. Chaque amelioration est desactivable : le preset
 * « origine » ramene l'image au plus pres du rendu d'epoque, ce qui sert de
 * point de comparaison pendant la mise au point.
 *
 * Aucun de ces reglages ne touche au jeu : ils ne changent ni la simulation,
 * ni la collision, ni les fichiers de la carte.
 */

export type AntiAliasingMode = 'off' | 'msaa' | 'smaa' | 'taa';
export type QualityLevel = 'off' | 'low' | 'medium' | 'high' | 'ultra';
export type PresetName = 'original' | 'low' | 'medium' | 'high' | 'ultra';

export interface ModernRenderSettings {
  /** Rendu en virgule flottante : les sources vives depassent 1. */
  hdr: boolean;
  dynamicLights: boolean;
  shadows: boolean;
  contactShadows: boolean;
  ambientOcclusion: boolean;
  bloom: boolean;
  colorGrading: boolean;
  fog: boolean;
  reflections: boolean;
  ssr: boolean;
  particles: boolean;
  decals: boolean;
  distortion: boolean;
  motionBlur: boolean;
  cameraShake: boolean;
  dynamicFov: boolean;
  /** Balancement de l'arme au rythme de la marche. */
  weaponBob: boolean;
  /** Retard de l'arme sur les mouvements de vue. */
  weaponSway: boolean;
  /** Recul visuel au tir et amorti de reception. */
  viewRecoil: boolean;
  /** Champ de vision de l'arme tenue en main, independant de celui du monde. */
  weaponFov: number;
  /** Cote ou l'arme est tenue. */
  weaponSide: 'center' | 'right' | 'left';
  /**
   * Ajustement lateral de l'arme, ajoute a la place que son reglage prevoit.
   * Zero laisse chaque arme a l'endroit prevu pour elle.
   */
  weaponTrimX: number;
  /** Ajustement vertical de l'arme. */
  weaponTrimY: number;
  /** Amplitude du balancement, en part de l'amplitude de reference. */
  weaponBobStrength: number;
  /** Amplitude du retard sur les mouvements de vue. */
  weaponSwayStrength: number;
  /** Amplitude du recul visuel. */
  weaponRecoilStrength: number;

  antiAliasing: AntiAliasingMode;
  /** Resolution interne, de 0.5 a 1.5 ; l'interface reste nette. */
  renderScale: number;
  /** Baisse la resolution interne quand la cadence visee n'est pas tenue. */
  dynamicResolution: boolean;
  /** Cadence visee, en images par seconde. */
  targetFps: number;
  anisotropy: number;
  shadowQuality: QualityLevel;
  aoQuality: QualityLevel;
  fxQuality: Exclude<QualityLevel, 'off'>;
  maxDynamicLights: number;
  /** Finesse des surfaces courbes de la carte. */
  patchLevel: number;

  exposure: number;
  whitePoint: number;
  contrast: number;
  saturation: number;
  /**
   * Relevement du point noir, de zero a quelques centiemes. Il preserve la
   * matiere dans les ombres sans grisailler l'image.
   */
  shadowLift: number;
  /**
   * Ecart de teinte entre les deux bouts de l'echelle : ombres vers le froid,
   * hautes lumieres vers le chaud. Zero rend l'image telle que les materiaux
   * et les lumieres la donnent.
   */
  splitTone: number;
  brightness: number;
  /** Rechauffe ou refroidit l'image, en unites arbitraires de -1 a 1. */
  temperature: number;
  tint: number;

  bloomThreshold: number;
  bloomStrength: number;
  bloomRadius: number;

  /** Intensite des lightmaps de la carte, 1 respecte l'eclairage d'origine. */
  lightmapGain: number;
  /**
   * Decalage applique aux lightmaps a la lecture. Le jeu d'origine eclaircit
   * ses lightmaps d'un ou deux crans selon la rampe gamma de la carte
   * graphique ; sans rampe, deux crans redonnent l'ambiance attendue.
   */
  lightmapOverbright: number;
  /**
   * Plancher des lightmaps. Il empeche qu'une zone peu eclairee tombe a zero
   * et perde sa matiere, sans eclaircir le reste de la piece.
   */
  lightmapLift: number;
  ambientGain: number;
  /**
   * Materiaux HD produits hors ligne par la chaine de textures, depuis les
   * textures du jeu. Coupe, la carte revient exactement a ses textures
   * d'origine : c'est le point de comparaison de la refonte.
   */
  hdMaterials: boolean;
  /**
   * Force du reflet tire de la grille d'eclairage de la carte. La lightmap dit
   * combien de lumiere arrive sur une surface, jamais d'ou : la grille, elle,
   * porte la direction, et c'est elle qui fait exister relief, rugosite et
   * metal. Zero revient au rendu d'epoque, ou une surface est un aplat.
   */
  gridSpecular: number;
  /**
   * Relief et rugosite deduits de la luminance des textures d'origine. Rien
   * n'est remplace ni reecrit : la texture reste celle du jeu, le moteur en
   * derive seulement des donnees de surface au chargement. Le preset
   * « origine » le coupe.
   */
  deriveMaterialDetail: boolean;
}

export const PRESETS: Record<PresetName, ModernRenderSettings> = {
  original: {
    hdr: false,
    dynamicLights: false,
    shadows: false,
    contactShadows: false,
    ambientOcclusion: false,
    bloom: false,
    colorGrading: false,
    fog: true,
    reflections: false,
    ssr: false,
    particles: false,
    decals: false,
    distortion: false,
    motionBlur: false,
    cameraShake: false,
    dynamicFov: false,
    weaponBob: true,
    weaponSway: false,
    viewRecoil: false,
    weaponFov: 65,
    weaponSide: 'right',
    weaponTrimX: 0,
    weaponTrimY: 0,
    weaponBobStrength: 1,
    weaponSwayStrength: 0.6,
    weaponRecoilStrength: 0.8,
    antiAliasing: 'off',
    renderScale: 1,
    dynamicResolution: false,
    targetFps: 60,
    anisotropy: 4,
    shadowQuality: 'off',
    aoQuality: 'off',
    fxQuality: 'low',
    maxDynamicLights: 0,
    patchLevel: 5,
    exposure: 1,
    whitePoint: 4,
    contrast: 1,
    saturation: 1,
    shadowLift: 0,
    splitTone: 0,
    brightness: 0,
    temperature: 0,
    tint: 0,
    bloomThreshold: 1.2,
    bloomStrength: 0,
    bloomRadius: 0.4,
    lightmapGain: 1,
    lightmapOverbright: 2,
    lightmapLift: 0,
    ambientGain: 0.35,
    hdMaterials: false,
    gridSpecular: 0,
    deriveMaterialDetail: false,
  },
  low: {
    ...baseModern(),
    shadows: false,
    contactShadows: false,
    ambientOcclusion: false,
    antiAliasing: 'off',
    renderScale: 0.75,
    anisotropy: 4,
    shadowQuality: 'off',
    aoQuality: 'off',
    fxQuality: 'low',
    maxDynamicLights: 4,
    patchLevel: 5,
    hdMaterials: false,
    gridSpecular: 0,
    deriveMaterialDetail: false,
  },
  medium: {
    ...baseModern(),
    contactShadows: false,
    antiAliasing: 'smaa',
    renderScale: 1,
    anisotropy: 8,
    shadowQuality: 'low',
    aoQuality: 'low',
    fxQuality: 'medium',
    maxDynamicLights: 6,
    patchLevel: 7,
  },
  high: {
    ...baseModern(),
    antiAliasing: 'smaa',
    renderScale: 1,
    anisotropy: 16,
    shadowQuality: 'medium',
    aoQuality: 'medium',
    fxQuality: 'high',
    maxDynamicLights: 8,
    patchLevel: 9,
    // Une seule capture au chargement : de quoi donner un reflet a l'eau et
    // aux surfaces metalliques sans cout par image.
    reflections: true,
  },
  ultra: {
    ...baseModern(),
    antiAliasing: 'smaa',
    renderScale: 1.25,
    anisotropy: 16,
    shadowQuality: 'high',
    aoQuality: 'high',
    fxQuality: 'ultra',
    maxDynamicLights: 12,
    patchLevel: 12,
    ssr: false,
    reflections: true,
  },
};

function baseModern(): ModernRenderSettings {
  return {
    hdr: true,
    dynamicLights: true,
    shadows: true,
    contactShadows: true,
    ambientOcclusion: true,
    bloom: true,
    colorGrading: true,
    fog: true,
    reflections: false,
    ssr: false,
    particles: true,
    decals: true,
    distortion: true,
    motionBlur: false,
    cameraShake: true,
    dynamicFov: true,
    weaponBob: true,
    weaponSway: true,
    viewRecoil: true,
    weaponFov: 65,
    weaponSide: 'right',
    weaponTrimX: 0,
    weaponTrimY: 0,
    weaponBobStrength: 1,
    weaponSwayStrength: 1,
    weaponRecoilStrength: 1,
    antiAliasing: 'smaa',
    renderScale: 1,
    dynamicResolution: true,
    targetFps: 60,
    anisotropy: 8,
    shadowQuality: 'medium',
    aoQuality: 'medium',
    fxQuality: 'high',
    maxDynamicLights: 8,
    patchLevel: 8,
    exposure: 1,
    whitePoint: 4,
    contrast: 1,
    saturation: 0.94,
    // Les ajouts dans les ombres restent disponibles, mais ne doivent pas
    // relever les noirs et poser un voile colore par defaut.
    shadowLift: 0,
    splitTone: 0,
    brightness: 0,
    temperature: 0,
    tint: 0,
    bloomThreshold: 1.1,
    bloomStrength: 0.5,
    bloomRadius: 0.5,
    lightmapGain: 1.35,
    lightmapOverbright: 2,
    lightmapLift: 0.02,
    ambientGain: 0.2,
    hdMaterials: true,
    gridSpecular: 1.6,
    deriveMaterialDetail: true,
  };
}

type Listener = (settings: ModernRenderSettings, changed: (keyof ModernRenderSettings)[]) => void;

/** Reglages courants, avec avis aux parties interessees a chaque changement. */
export class RenderSettingsStore {
  private settings: ModernRenderSettings;
  private preset: PresetName;
  private readonly listeners = new Set<Listener>();

  constructor(preset: PresetName = 'high') {
    this.preset = preset;
    this.settings = { ...PRESETS[preset] };
  }

  get current(): Readonly<ModernRenderSettings> {
    return this.settings;
  }

  get presetName(): PresetName {
    return this.preset;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  applyPreset(preset: PresetName): void {
    this.preset = preset;
    const previous = this.settings;
    this.settings = { ...PRESETS[preset] };
    this.notify(differences(previous, this.settings));
  }

  patch(values: Partial<ModernRenderSettings>): void {
    const changed: (keyof ModernRenderSettings)[] = [];
    for (const [key, value] of Object.entries(values) as [keyof ModernRenderSettings, never][]) {
      if (this.settings[key] === value) continue;
      this.settings[key] = value;
      changed.push(key);
    }
    if (changed.length) this.notify(changed);
  }

  private notify(changed: (keyof ModernRenderSettings)[]): void {
    for (const listener of this.listeners) listener(this.settings, changed);
  }
}

function differences(a: ModernRenderSettings, b: ModernRenderSettings): (keyof ModernRenderSettings)[] {
  const keys = Object.keys(b) as (keyof ModernRenderSettings)[];
  return keys.filter((key) => a[key] !== b[key]);
}

/** Taille des cartes d'ombre selon le niveau demande. */
export function shadowMapSize(quality: QualityLevel): number {
  switch (quality) {
    case 'off':
      return 0;
    case 'low':
      return 1024;
    case 'medium':
      return 2048;
    case 'high':
      return 3072;
    case 'ultra':
      return 4096;
  }
}
