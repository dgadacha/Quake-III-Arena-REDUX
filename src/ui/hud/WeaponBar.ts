import { WEAPON_ORDER, WEAPONS, type WeaponId } from '../../game/weapons/WeaponDefs';
import type { UIComponent } from '../core/UIManager';
import type { UIEvents } from '../core/UIEvents';
import type { UIState } from '../core/UIState';
import type { UISettings } from '../core/UISettings';

/** Abreviations affichees dans la barre, une par arme. */
const SHORT: Record<WeaponId, string> = {
  gauntlet: 'gnt',
  machinegun: 'mg',
  shotgun: 'sg',
  grenade: 'gl',
  rocket: 'rl',
  lightning: 'lg',
  railgun: 'rg',
  plasma: 'pg',
  bfg: 'bfg',
};

/**
 * Barre des armes. Elle n'est pas affichee en permanence : elle apparait au
 * changement d'arme ou au ramassage, puis s'efface au bout de deux secondes.
 */
export class WeaponBar implements UIComponent {
  readonly element: HTMLElement;
  private readonly slots = new Map<WeaponId, HTMLElement>();
  private visibleFor = 0;
  private lastActive: WeaponId | null = null;

  constructor(
    private readonly state: UIState,
    private readonly settings: UISettings,
    events: UIEvents,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'hud-weapons';

    WEAPON_ORDER.forEach((id, index) => {
      const slot = document.createElement('div');
      slot.className = 'hud-weapon';
      slot.innerHTML = `<span class="hud-weapon__slot">${index + 1}</span><span>${SHORT[id]}</span>`;
      slot.title = WEAPONS[id].name;
      this.element.appendChild(slot);
      this.slots.set(id, slot);
    });

    events.on('weaponSwitch', () => this.show());
    events.on('pickup', ({ kind }) => {
      if (kind === 'weapon') this.show();
    });
  }

  private show(): void {
    this.visibleFor = 2;
  }

  update(delta: number): void {
    if (!this.settings.current.showWeaponBar) {
      this.element.classList.remove('hud-weapons--visible');
      return;
    }

    if (this.visibleFor > 0) {
      this.visibleFor -= delta;
      this.element.classList.add('hud-weapons--visible');
    } else {
      this.element.classList.remove('hud-weapons--visible');
      return;
    }

    const { player, owned } = this.state.current;
    if (player.weapon === this.lastActive) return;
    this.lastActive = player.weapon;

    for (const [id, slot] of this.slots) {
      slot.classList.toggle('hud-weapon--owned', owned.includes(id));
      slot.classList.toggle('hud-weapon--active', id === player.weapon);
    }
  }
}
