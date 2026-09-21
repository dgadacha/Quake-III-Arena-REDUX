import type { ModernRenderSettings, PresetName, RenderSettingsStore } from '../../renderer/RenderSettings';

/**
 * Reglages proposes au joueur.
 *
 * Le moteur en expose une soixantaine, mais la plupart sont des vis de reglage
 * artistique : contraste, temperature, plancher des lightmaps, amplitude du
 * balancement de l'arme. Elles servent a mettre l'image au point, pas a jouer,
 * et les etaler devant le joueur ne lui dit rien. Cette table garde donc les
 * dix choix qui changent vraiment ce qu'il voit ou ce que sa machine encaisse,
 * dans le meme ordre qu'un menu video d'aujourd'hui.
 *
 * Le reste reste accessible pour la mise au point, par le panneau detaille que
 * la console ouvre.
 */

export interface SettingRow {
  id: string;
  label: string;
  /** Lit la valeur affichee et l'indice courant. */
  read: (settings: ModernRenderSettings, store: RenderSettingsStore) => { text: string; fill?: number };
  /** Avance d'un cran, dans un sens ou dans l'autre. */
  step: (direction: number, settings: ModernRenderSettings, store: RenderSettingsStore) => void;
  /** Vrai quand le changement demande de reprendre la carte. */
  reload?: boolean;
}

const PRESETS: PresetName[] = ['original', 'low', 'medium', 'high', 'ultra'];
/** « Origine » se dit CLASSIC dans un menu : c'est le rendu de 1999. */
const PRESET_LABELS: Record<PresetName, string> = {
  original: 'classic',
  low: 'low',
  medium: 'medium',
  high: 'high',
  ultra: 'ultra',
};

const ANTIALIASING = ['off', 'smaa', 'msaa', 'taa'] as const;
const QUALITY = ['off', 'low', 'medium', 'high', 'ultra'] as const;
const ANISOTROPY = [1, 4, 8, 16];

/** Fait tourner une liste d'un cran, dans un sens ou dans l'autre. */
function cycle<T>(values: readonly T[], current: T, direction: number): T {
  const index = values.indexOf(current);
  const next = (index + direction + values.length) % values.length;
  return values[next];
}

/** Deplace un nombre d'un pas, borne, et rend sa part sur l'intervalle. */
function slide(value: number, direction: number, min: number, max: number, step: number): number {
  const next = Math.min(max, Math.max(min, value + direction * step));
  // Le pas peut tomber sur une valeur flottante : on la ramene au centieme.
  return Math.round(next * 100) / 100;
}

function share(value: number, min: number, max: number): number {
  return (value - min) / (max - min);
}

export const SETTING_ROWS: SettingRow[] = [
  {
    id: 'preset',
    label: 'Preset',
    read: (_settings, store) => ({ text: PRESET_LABELS[store.presetName] }),
    step: (direction, _settings, store) => store.applyPreset(cycle(PRESETS, store.presetName, direction)),
    reload: true,
  },
  {
    id: 'renderScale',
    label: 'Render scale',
    read: (settings) => ({
      text: `${Math.round(settings.renderScale * 100)} %`,
      fill: share(settings.renderScale, 0.5, 1.5),
    }),
    step: (direction, settings, store) =>
      store.patch({ renderScale: slide(settings.renderScale, direction, 0.5, 1.5, 0.05) }),
  },
  {
    id: 'dynamicResolution',
    label: 'Dynamic resolution',
    read: (settings) => ({ text: settings.dynamicResolution ? 'on' : 'off' }),
    step: (_direction, settings, store) => store.patch({ dynamicResolution: !settings.dynamicResolution }),
  },
  {
    id: 'antiAliasing',
    label: 'Antialiasing',
    read: (settings) => ({ text: settings.antiAliasing }),
    step: (direction, settings, store) =>
      store.patch({ antiAliasing: cycle(ANTIALIASING, settings.antiAliasing, direction) }),
  },
  {
    id: 'textures',
    label: 'Textures',
    read: (settings) => ({ text: settings.hdMaterials ? 'hd' : 'classic' }),
    step: (_direction, settings, store) => store.patch({ hdMaterials: !settings.hdMaterials }),
    reload: true,
  },
  {
    id: 'shadows',
    label: 'Shadows',
    read: (settings) => ({ text: settings.shadows ? settings.shadowQuality : 'off' }),
    step: (direction, settings, store) => {
      const next = cycle(QUALITY, settings.shadows ? settings.shadowQuality : 'off', direction);
      store.patch({ shadows: next !== 'off', shadowQuality: next === 'off' ? 'low' : next });
    },
    reload: true,
  },
  {
    id: 'ao',
    label: 'Ambient occlusion',
    read: (settings) => ({ text: settings.ambientOcclusion ? settings.aoQuality : 'off' }),
    step: (direction, settings, store) => {
      const next = cycle(QUALITY, settings.ambientOcclusion ? settings.aoQuality : 'off', direction);
      store.patch({ ambientOcclusion: next !== 'off', aoQuality: next === 'off' ? 'low' : next });
    },
  },
  {
    id: 'bloom',
    label: 'Bloom',
    read: (settings) => ({ text: settings.bloom ? 'on' : 'off' }),
    step: (_direction, settings, store) => store.patch({ bloom: !settings.bloom }),
  },
  {
    id: 'reflections',
    label: 'Reflections',
    read: (settings) => ({ text: settings.reflections ? 'on' : 'off' }),
    step: (_direction, settings, store) => store.patch({ reflections: !settings.reflections }),
    reload: true,
  },
  {
    id: 'anisotropy',
    label: 'Anisotropic filtering',
    read: (settings) => ({ text: `x${settings.anisotropy}` }),
    step: (direction, settings, store) =>
      store.patch({ anisotropy: cycle(ANISOTROPY, settings.anisotropy, direction) }),
    reload: true,
  },
  {
    id: 'brightness',
    label: 'Brightness',
    read: (settings) => ({
      text: settings.exposure.toFixed(2),
      fill: share(settings.exposure, 0.5, 2),
    }),
    step: (direction, settings, store) =>
      store.patch({ exposure: slide(settings.exposure, direction, 0.5, 2, 0.05) }),
  },
];
