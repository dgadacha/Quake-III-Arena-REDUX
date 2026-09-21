import '../styles/tokens.css';
import '../styles/hud.css';
import { UIEvents } from './UIEvents';
import { UISettings, type UISettingsValues } from './UISettings';
import { UIState } from './UIState';

/**
 * Racine de l'interface. Elle tient la zone de securite, les echelles et les
 * modes d'accessibilite, et fournit aux composants un endroit ou s'accrocher.
 *
 * Rien n'est positionne en pixels absolus : les composants se placent dans les
 * coins de la zone de securite, elle-meme exprimee en pourcentage, de sorte que
 * le HUD tienne aussi bien en 1280 par 720 qu'en tres large.
 */

export type InputDevice = 'keyboard' | 'mouse' | 'gamepad';

export interface UIComponent {
  /** Element racine du composant, place dans une zone du HUD. */
  readonly element: HTMLElement;
  /** Appele a chaque image ; le composant decide de ce qu'il met a jour. */
  update?(delta: number): void;
  dispose?(): void;
}

export type HudZone =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'center'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export class UIManager {
  readonly events = new UIEvents();
  readonly state = new UIState();
  readonly settings = new UISettings();

  private readonly root: HTMLElement;
  private readonly zones = new Map<HudZone, HTMLElement>();
  private readonly components: UIComponent[] = [];
  private device: InputDevice = 'keyboard';

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'ui';
    parent.appendChild(this.root);

    const safe = document.createElement('div');
    safe.className = 'ui__safe';
    this.root.appendChild(safe);

    for (const zone of [
      'top-left',
      'top-center',
      'top-right',
      'center',
      'bottom-left',
      'bottom-center',
      'bottom-right',
    ] as HudZone[]) {
      const element = document.createElement('div');
      element.className = `ui__zone ui__zone--${zone}`;
      safe.appendChild(element);
      this.zones.set(zone, element);
    }

    this.settings.subscribe((values) => this.applySettings(values));
    window.addEventListener('keydown', this.noteKeyboard, { passive: true });
    window.addEventListener('mousemove', this.noteMouse, { passive: true });
    window.addEventListener('gamepadconnected', this.noteGamepad);
  }

  get activeDevice(): InputDevice {
    return this.device;
  }

  /** Accroche un composant dans une zone du HUD. */
  mount(component: UIComponent, zone: HudZone): void {
    this.zones.get(zone)?.appendChild(component.element);
    this.components.push(component);
  }

  setHudVisible(visible: boolean): void {
    this.root.classList.toggle('ui--hidden', !visible);
  }

  update(delta: number): void {
    for (const component of this.components) component.update?.(delta);
  }

  dispose(): void {
    for (const component of this.components) component.dispose?.();
    this.components.length = 0;
    window.removeEventListener('keydown', this.noteKeyboard);
    window.removeEventListener('mousemove', this.noteMouse);
    window.removeEventListener('gamepadconnected', this.noteGamepad);
    this.root.remove();
  }

  private applySettings(values: UISettingsValues): void {
    const style = this.root.style;
    style.setProperty('--ui-hud-scale', String(values.hudScale * values.textScale));
    style.setProperty('--ui-menu-scale', String(values.menuScale));
    style.setProperty('--ui-crosshair-scale', String(values.crosshairSize / 20));
    style.setProperty('--ui-hud-opacity', String(values.hudOpacity));

    // Les modes d'accessibilite pilotent des jetons, pas des composants.
    const documentElement = document.documentElement;
    documentElement.dataset.reducedMotion = values.reducedMotion ? 'true' : 'false';
    documentElement.dataset.highContrast = values.highContrast ? 'true' : 'false';
    documentElement.dataset.hudBlur = values.hudBlur ? 'true' : 'false';
    this.root.dataset.hudStyle = values.hudStyle;
    this.root.classList.toggle('ui--debug', values.debugOverlay);
  }

  private noteKeyboard = (): void => {
    this.device = 'keyboard';
  };

  private noteMouse = (): void => {
    if (this.device === 'gamepad') this.device = 'mouse';
  };

  private noteGamepad = (): void => {
    this.device = 'gamepad';
  };
}
