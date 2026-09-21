import type {
  AntiAliasingMode,
  ModernRenderSettings,
  PresetName,
  QualityLevel,
  RenderSettingsStore,
} from '../renderer/RenderSettings';

/**
 * Panneau de reglages graphiques. Chaque amelioration moderne peut etre coupee
 * une par une, et le preset « origine » ramene l'image au plus pres du rendu
 * d'epoque : c'est le point de comparaison qui permet de juger le reste.
 *
 * Les reglages marques d'un signe demandent de recharger la carte : ils
 * changent ce qui est prepare au chargement, pas ce qui est dessine.
 */

interface ToggleRow {
  key: keyof ModernRenderSettings;
  label: string;
  reload?: boolean;
}

interface SliderRow {
  key: keyof ModernRenderSettings;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Affiche la valeur en pourcentage : un facteur parle mal au joueur. */
  percent?: boolean;
  reload?: boolean;
}

const PRESETS: { value: PresetName; label: string }[] = [
  { value: 'original', label: 'Original' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'ultra', label: 'Ultra' },
];

const TOGGLES: ToggleRow[] = [
  { key: 'hdr', label: 'Floating point rendering' },
  { key: 'dynamicLights', label: 'Dynamic lights', reload: true },
  { key: 'shadows', label: 'Shadows', reload: true },
  { key: 'contactShadows', label: 'Contact shadows' },
  { key: 'ambientOcclusion', label: 'Ambient occlusion' },
  { key: 'bloom', label: 'Bloom' },
  { key: 'colorGrading', label: 'Color grading' },
  { key: 'fog', label: 'Fog' },
  { key: 'reflections', label: 'Reflections' },
  { key: 'particles', label: 'Particles' },
  { key: 'decals', label: 'Marks on walls' },
  { key: 'distortion', label: 'Heat distortion' },
  { key: 'motionBlur', label: 'Motion blur' },
  { key: 'cameraShake', label: 'Camera shake' },
  { key: 'dynamicFov', label: 'Dynamic field of view' },
  { key: 'weaponBob', label: 'Weapon bob' },
  { key: 'weaponSway', label: 'Weapon sway' },
  { key: 'viewRecoil', label: 'View recoil and landing' },
  { key: 'dynamicResolution', label: 'Dynamic resolution' },
  { key: 'hdMaterials', label: 'HD materials', reload: true },
  { key: 'deriveMaterialDetail', label: 'Relief derived from textures', reload: true },
];

const SLIDERS: SliderRow[] = [
  { key: 'renderScale', label: 'Internal resolution', min: 0.5, max: 1.5, step: 0.05 },
  { key: 'targetFps', label: 'Target frame rate', min: 30, max: 240, step: 10 },
  { key: 'exposure', label: 'Exposure', min: 0.2, max: 4, step: 0.05 },
  { key: 'whitePoint', label: 'White point', min: 1, max: 12, step: 0.25 },
  { key: 'contrast', label: 'Contrast', min: 0.6, max: 1.6, step: 0.01 },
  { key: 'saturation', label: 'Saturation', min: 0, max: 2, step: 0.02 },
  { key: 'brightness', label: 'Brightness', min: -0.2, max: 0.2, step: 0.01 },
  { key: 'shadowLift', label: 'Black floor', min: 0, max: 0.06, step: 0.002 },
  { key: 'splitTone', label: 'Cool shadows, warm highlights', min: 0, max: 2, step: 0.05 },
  { key: 'temperature', label: 'Temperature', min: -1, max: 1, step: 0.05 },
  { key: 'tint', label: 'Tint', min: -1, max: 1, step: 0.05 },
  { key: 'bloomThreshold', label: 'Bloom threshold', min: 0.2, max: 3, step: 0.05 },
  { key: 'bloomStrength', label: 'Bloom strength', min: 0, max: 2, step: 0.05 },
  { key: 'bloomRadius', label: 'Bloom radius', min: 0, max: 1.5, step: 0.05 },
  { key: 'lightmapGain', label: 'Lightmap intensity', min: 0.4, max: 3, step: 0.05, reload: true },
  { key: 'lightmapOverbright', label: 'Lightmap overbright', min: 0, max: 3, step: 1, reload: true },
  { key: 'lightmapLift', label: 'Lightmap floor', min: 0, max: 0.08, step: 0.002 },
  { key: 'ambientGain', label: 'Ambient light', min: 0, max: 2, step: 0.05, reload: true },
  { key: 'gridSpecular', label: 'Light grid reflections', min: 0, max: 3, step: 0.05 },
  { key: 'microDetail', label: 'Micro detail', min: 0, max: 1.5, step: 0.05, reload: true },
  { key: 'maxDynamicLights', label: 'Lights on at once', min: 0, max: 16, step: 1, reload: true },
  { key: 'patchLevel', label: 'Curve tessellation', min: 2, max: 14, step: 1, reload: true },
  { key: 'anisotropy', label: 'Anisotropic filtering', min: 1, max: 16, step: 1, reload: true },
];

/*
 * Arme tenue en main. Sa place a l'ecran est affaire de gout : certains la
 * veulent au centre, d'autres sur le cote, et le champ de vision qui lui est
 * propre change son allure sans toucher a celui du jeu. Les trois derniers
 * reglages ponderent des mouvements volontairement discrets.
 */
const WEAPON_SLIDERS: SliderRow[] = [
  { key: 'weaponFov', label: 'Field of view', min: 55, max: 80, step: 1 },
  { key: 'weaponTrimX', label: 'Horizontal offset', min: -0.3, max: 0.3, step: 0.02 },
  { key: 'weaponTrimY', label: 'Vertical offset', min: -0.3, max: 0.3, step: 0.02 },
  { key: 'weaponBobStrength', label: 'Bob', min: 0, max: 2, step: 0.05, percent: true },
  { key: 'weaponSwayStrength', label: 'Sway', min: 0, max: 2, step: 0.05, percent: true },
  { key: 'weaponRecoilStrength', label: 'Recoil', min: 0, max: 2, step: 0.05, percent: true },
];

interface ChoiceRow {
  key: keyof ModernRenderSettings;
  label: string;
  options: string[];
}

const CHOICES: ChoiceRow[] = [
  { key: 'antiAliasing', label: 'Antialiasing', options: ['off', 'msaa', 'smaa', 'taa'] },
  { key: 'shadowQuality', label: 'Shadow quality', options: ['off', 'low', 'medium', 'high', 'ultra'] },
  { key: 'aoQuality', label: 'Occlusion quality', options: ['off', 'low', 'medium', 'high', 'ultra'] },
  { key: 'fxQuality', label: 'Effects quality', options: ['low', 'medium', 'high', 'ultra'] },
];

const WEAPON_CHOICES: ChoiceRow[] = [
  { key: 'weaponSide', label: 'Position', options: ['center', 'right', 'left'] },
];

export class SettingsPanel {
  private readonly root: HTMLElement;
  private visible = false;
  /** Prevenu quand un reglage demande de recharger la carte. */
  onReloadNeeded: (() => void) | null = null;

  constructor(parent: HTMLElement, private readonly store: RenderSettingsStore) {
    this.root = document.createElement('div');
    this.root.className = 'settings';
    parent.appendChild(this.root);
    this.render();
    this.store.subscribe(() => this.render());
  }

  toggle(): void {
    this.visible = !this.visible;
    this.root.classList.toggle('visible', this.visible);
  }

  hide(): void {
    this.visible = false;
    this.root.classList.remove('visible');
  }

  get isVisible(): boolean {
    return this.visible;
  }

  private render(): void {
    const settings = this.store.current;
    this.root.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'settings__head';
    head.innerHTML = '<h2>Video</h2>';
    const presets = document.createElement('div');
    presets.className = 'sources';
    for (const preset of PRESETS) {
      const button = document.createElement('button');
      button.className = preset.value === this.store.presetName ? 'source active' : 'source';
      button.textContent = preset.label;
      button.addEventListener('click', () => {
        this.store.applyPreset(preset.value);
        this.onReloadNeeded?.();
      });
      presets.appendChild(button);
    }
    head.appendChild(presets);
    this.root.appendChild(head);

    const columns = document.createElement('div');
    columns.className = 'settings__columns';

    const left = document.createElement('div');
    left.className = 'settings__column';
    for (const row of TOGGLES) {
      left.appendChild(this.buildToggle(row, Boolean(settings[row.key])));
    }
    for (const choice of CHOICES) {
      left.appendChild(this.buildChoice(choice, String(settings[choice.key])));
    }

    const right = document.createElement('div');
    right.className = 'settings__column';
    for (const row of SLIDERS) {
      right.appendChild(this.buildSlider(row, Number(settings[row.key])));
    }

    const weapon = document.createElement('div');
    weapon.className = 'settings__column';
    const title = document.createElement('h3');
    title.className = 'settings__group';
    title.textContent = 'Held weapon';
    weapon.appendChild(title);
    for (const choice of WEAPON_CHOICES) {
      weapon.appendChild(this.buildChoice(choice, String(settings[choice.key])));
    }
    for (const row of WEAPON_SLIDERS) {
      weapon.appendChild(this.buildSlider(row, Number(settings[row.key])));
    }

    columns.append(left, right, weapon);
    this.root.appendChild(columns);

    const note = document.createElement('p');
    note.className = 'settings__note';
    note.textContent = 'Settings marked with a star take effect the next time a map loads. Press G to close.';
    this.root.appendChild(note);
  }

  private buildToggle(row: ToggleRow, value: boolean): HTMLElement {
    const line = document.createElement('label');
    line.className = 'settings__row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = value;
    input.addEventListener('change', () => {
      this.store.patch({ [row.key]: input.checked } as Partial<ModernRenderSettings>);
      if (row.reload) this.onReloadNeeded?.();
    });
    const text = document.createElement('span');
    text.textContent = row.reload ? `${row.label} *` : row.label;
    line.append(input, text);
    return line;
  }

  private buildChoice(choice: ChoiceRow, value: string): HTMLElement {
    const line = document.createElement('label');
    line.className = 'settings__row';
    const text = document.createElement('span');
    text.textContent = choice.label;
    const select = document.createElement('select');
    for (const option of choice.options) {
      const item = document.createElement('option');
      item.value = option;
      item.textContent = LABELS[option] ?? option;
      item.selected = option === value;
      select.appendChild(item);
    }
    select.addEventListener('change', () => {
      const next = select.value as AntiAliasingMode | QualityLevel | 'center' | 'right' | 'left';
      this.store.patch({ [choice.key]: next } as unknown as Partial<ModernRenderSettings>);
    });
    line.append(text, select);
    return line;
  }

  private buildSlider(row: SliderRow, value: number): HTMLElement {
    const line = document.createElement('label');
    line.className = 'settings__row settings__row--slider';
    const text = document.createElement('span');
    text.textContent = row.reload ? `${row.label} *` : row.label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(row.min);
    input.max = String(row.max);
    input.step = String(row.step);
    input.value = String(value);
    const readout = document.createElement('b');
    const show = (raw: number) => (row.percent ? `${Math.round(raw * 100)} %` : format(raw));
    readout.textContent = show(value);
    input.addEventListener('input', () => {
      const next = Number(input.value);
      readout.textContent = show(next);
      this.store.patch({ [row.key]: next } as Partial<ModernRenderSettings>);
    });
    // Un reglage qui demande un rechargement n'est signale qu'au relachement.
    input.addEventListener('change', () => {
      if (row.reload) this.onReloadNeeded?.();
    });
    line.append(text, input, readout);
    return line;
  }
}

/** Noms affiches des valeurs choisies. */
const LABELS: Record<string, string> = {
  off: 'off',
  low: 'low',
  medium: 'medium',
  high: 'high',
  ultra: 'ultra',
  center: 'center',
  right: 'right',
  left: 'left',
};

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
