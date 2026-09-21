import type { UIComponent } from '../core/UIManager';
import type { UIState } from '../core/UIState';
import type { UISettings } from '../core/UISettings';

/**
 * Sante et armure, en bas a gauche. Le nombre est l'element principal ; le mot
 * qui l'accompagne reste discret. Trois etats de sante changent la couleur et,
 * en dessous du quart, ajoutent un battement contenu.
 *
 * Le texte n'est reecrit que lorsque la valeur change : mettre a jour le
 * document a chaque image coute plus que tout le reste du HUD.
 */
export class StatusPanel implements UIComponent {
  readonly element: HTMLElement;
  private readonly healthRow: HTMLElement;
  private readonly healthValue: HTMLElement;
  private readonly armorRow: HTMLElement;
  private readonly armorValue: HTMLElement;
  private lastHealth = -1;
  private lastArmor = -1;
  private lastLevel = '';

  constructor(
    private readonly state: UIState,
    private readonly settings: UISettings,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'hud-panel hud-status';
    this.element.innerHTML = `
      <div class="hud-stat hud-stat--health">
        <span class="hud-stat__value">125</span>
        <span class="hud-stat__label">health</span>
      </div>
      <div class="hud-stat hud-stat--armor">
        <span class="hud-stat__value">0</span>
        <span class="hud-stat__label">armor</span>
      </div>
    `;

    this.healthRow = this.element.querySelector('.hud-stat--health') as HTMLElement;
    this.healthValue = this.healthRow.querySelector('.hud-stat__value') as HTMLElement;
    this.armorRow = this.element.querySelector('.hud-stat--armor') as HTMLElement;
    this.armorValue = this.armorRow.querySelector('.hud-stat__value') as HTMLElement;
  }

  update(): void {
    const { player, healthLevel } = this.state.current;
    const settings = this.settings.current;

    this.healthRow.style.display = settings.showHealth ? '' : 'none';
    this.armorRow.style.display = settings.showArmor && player.armor > 0 ? '' : 'none';

    if (player.health !== this.lastHealth) {
      this.lastHealth = player.health;
      this.healthValue.textContent = String(player.health);
    }
    if (player.armor !== this.lastArmor) {
      this.lastArmor = player.armor;
      this.armorValue.textContent = String(player.armor);
    }
    if (healthLevel !== this.lastLevel) {
      this.lastLevel = healthLevel;
      this.healthRow.classList.toggle('hud-stat--warning', healthLevel === 'warning');
      this.healthRow.classList.toggle('hud-stat--critical', healthLevel === 'critical');
    }
  }
}
