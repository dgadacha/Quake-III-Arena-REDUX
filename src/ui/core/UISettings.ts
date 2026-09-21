/**
 * Reglages de l'interface, distincts de ceux du rendu : ils ne changent que ce
 * que le joueur voit de son HUD et de ses menus.
 *
 * Les valeurs sont conservees d'une partie a l'autre dans le stockage local,
 * qui peut etre indisponible : toute lecture est donc protegee et retombe sur
 * les valeurs par defaut.
 */

export type HudStyle = 'classic' | 'modern';
export type CrosshairStyle = 'cross' | 'cross-dot' | 'dot' | 'circle' | 'brackets';

export interface UISettingsValues {
  hudStyle: HudStyle;
  hudScale: number;
  menuScale: number;
  hudOpacity: number;
  /** Flou derriere les panneaux : couteux sur certaines machines. */
  hudBlur: boolean;

  showHealth: boolean;
  showArmor: boolean;
  showAmmo: boolean;
  showWeaponName: boolean;
  showWeaponBar: boolean;
  showScore: boolean;
  showTimer: boolean;
  showKillFeed: boolean;

  crosshairStyle: CrosshairStyle;
  crosshairSize: number;
  crosshairThickness: number;
  crosshairGap: number;
  crosshairOpacity: number;
  crosshairColor: string;
  crosshairOutline: boolean;
  dynamicCrosshair: boolean;

  hitmarker: boolean;
  damageIndicator: boolean;
  pickupNotifications: boolean;

  reducedMotion: boolean;
  highContrast: boolean;
  textScale: number;
  /** Affiche la zone de securite et les limites des composants. */
  debugOverlay: boolean;
}

export const DEFAULT_UI_SETTINGS: UISettingsValues = {
  hudStyle: 'modern',
  hudScale: 1,
  menuScale: 1,
  hudOpacity: 1,
  hudBlur: true,

  showHealth: true,
  showArmor: true,
  showAmmo: true,
  showWeaponName: true,
  showWeaponBar: true,
  showScore: true,
  showTimer: true,
  showKillFeed: true,

  crosshairStyle: 'cross-dot',
  crosshairSize: 20,
  crosshairThickness: 2,
  crosshairGap: 5,
  crosshairOpacity: 0.85,
  crosshairColor: '#ffffff',
  crosshairOutline: true,
  dynamicCrosshair: true,

  hitmarker: true,
  damageIndicator: true,
  pickupNotifications: true,

  reducedMotion: false,
  highContrast: false,
  textScale: 1,
  debugOverlay: false,
};

const STORAGE_KEY = 'quake-redux.ui';
type Listener = (values: UISettingsValues) => void;

export class UISettings {
  private values: UISettingsValues = { ...DEFAULT_UI_SETTINGS };
  private readonly listeners = new Set<Listener>();

  constructor() {
    this.load();
  }

  get current(): Readonly<UISettingsValues> {
    return this.values;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.values);
    return () => this.listeners.delete(listener);
  }

  patch(values: Partial<UISettingsValues>): void {
    let changed = false;
    for (const [key, value] of Object.entries(values) as [keyof UISettingsValues, never][]) {
      if (this.values[key] === value) continue;
      this.values[key] = value;
      changed = true;
    }
    if (!changed) return;
    this.save();
    for (const listener of this.listeners) listener(this.values);
  }

  reset(): void {
    this.values = { ...DEFAULT_UI_SETTINGS };
    this.save();
    for (const listener of this.listeners) listener(this.values);
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const stored = JSON.parse(raw) as Partial<UISettingsValues>;
      // Seules les cles connues sont reprises : un reglage disparu est ignore.
      for (const key of Object.keys(DEFAULT_UI_SETTINGS) as (keyof UISettingsValues)[]) {
        const value = stored[key];
        if (value !== undefined && typeof value === typeof DEFAULT_UI_SETTINGS[key]) {
          this.values[key] = value as never;
        }
      }
    } catch {
      // Stockage indisponible ou contenu illisible : on garde les valeurs par defaut.
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values));
    } catch {
      // Navigation privee ou stockage refuse : les reglages ne survivront pas.
    }
  }
}
