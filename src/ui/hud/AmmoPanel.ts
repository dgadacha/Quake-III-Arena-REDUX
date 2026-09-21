import { WEAPONS } from '../../game/weapons/WeaponDefs';
import type { UIComponent } from '../core/UIManager';
import type { UIState } from '../core/UIState';
import type { UISettings } from '../core/UISettings';

/**
 * Munitions et arme en main, en bas a droite. Le nombre passe en avant, le nom
 * de l'arme derriere. Quand les munitions s'epuisent, la couleur change et un
 * battement leger prend le relais : pas de grande notification en pleine
 * action.
 */
export class AmmoPanel implements UIComponent {
  readonly element: HTMLElement;
  private readonly value: HTMLElement;
  private readonly weapon: HTMLElement;
  private lastAmmo = -1;
  private lastWeapon = '';
  private lastFlags = '';

  constructor(
    private readonly state: UIState,
    private readonly settings: UISettings,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'hud-panel hud-ammo';
    this.element.innerHTML = `
      <span class="hud-ammo__value">0</span>
      <span class="hud-ammo__weapon">machinegun</span>
    `;
    this.value = this.element.querySelector('.hud-ammo__value') as HTMLElement;
    this.weapon = this.element.querySelector('.hud-ammo__weapon') as HTMLElement;
  }

  update(): void {
    const { player, lowAmmo } = this.state.current;
    const settings = this.settings.current;
    this.element.style.display = settings.showAmmo ? '' : 'none';
    this.weapon.style.display = settings.showWeaponName ? '' : 'none';

    // Les armes sans munitions affichent un tiret plutot qu'un zero trompeur.
    const display = player.unlimited ? '--' : String(player.ammo);
    if (player.ammo !== this.lastAmmo || player.unlimited) {
      this.lastAmmo = player.ammo;
      if (this.value.textContent !== display) this.value.textContent = display;
    }

    if (player.weapon !== this.lastWeapon) {
      this.lastWeapon = player.weapon;
      this.weapon.textContent = WEAPONS[player.weapon].name;
    }

    const flags = `${lowAmmo}:${player.ammo === 0 && !player.unlimited}`;
    if (flags !== this.lastFlags) {
      this.lastFlags = flags;
      this.element.classList.toggle('hud-ammo--low', lowAmmo);
      this.element.classList.toggle('hud-ammo--empty', player.ammo === 0 && !player.unlimited);
    }
  }
}
