import type { UIComponent, UIManager } from '../core/UIManager';
import { AmmoPanel } from './AmmoPanel';
import { Crosshair } from './Crosshair';
import { MatchPanel } from './MatchPanel';
import { StatusPanel } from './StatusPanel';
import { WeaponBar } from './WeaponBar';

/**
 * Assemble le HUD de jeu. La disposition suit une regle simple : les valeurs
 * vitales aux deux coins du bas, la partie en haut a droite, et le centre
 * laisse libre autour du reticule.
 */
class SpeedReadout implements UIComponent {
  readonly element: HTMLElement;
  private last = -1;

  constructor(private readonly manager: UIManager) {
    this.element = document.createElement('div');
    this.element.className = 'hud-speed';
    this.element.textContent = '0';
  }

  update(): void {
    const speed = Math.round(this.manager.state.current.speed);
    if (speed === this.last) return;
    this.last = speed;
    this.element.textContent = String(speed);
  }
}

export function createHud(manager: UIManager): void {
  const { state, settings, events } = manager;

  manager.mount(new StatusPanel(state, settings), 'bottom-left');
  manager.mount(new AmmoPanel(state, settings), 'bottom-right');
  manager.mount(new MatchPanel(state, settings), 'top-right');
  manager.mount(new Crosshair(settings, events), 'center');
  manager.mount(new WeaponBar(state, settings, events), 'bottom-center');
  manager.mount(new SpeedReadout(manager), 'bottom-center');
}
