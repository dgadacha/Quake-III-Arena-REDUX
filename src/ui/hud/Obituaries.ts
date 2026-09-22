import { WEAPONS, type WeaponId } from '../../game/weapons/WeaponDefs';
import type { UIComponent } from '../core/UIManager';
import type { UIEvents } from '../core/UIEvents';
import type { UISettings } from '../core/UISettings';

/**
 * Journal des eliminations, en haut a gauche comme dans le jeu.
 *
 * Chaque ligne dit qui a tue qui, et avec quoi. Les lignes ou le joueur
 * apparait sont ecrites en clair, les autres en retrait : dans une partie a
 * huit, ce qui compte est de voir d'un coup d'oeil si l'on vient de se faire
 * sortir, pas de lire les huit echanges.
 */

/** Verbe de la ligne, selon ce qui a tue. */
const CAUSE: Partial<Record<WeaponId | 'world', string>> = {
  gauntlet: 'humiliated',
  machinegun: 'machinegunned',
  shotgun: 'gunned down',
  grenade: 'blew up',
  rocket: 'rocketed',
  lightning: 'zapped',
  railgun: 'railed',
  plasma: 'melted',
  bfg: 'vaporised',
  world: 'was killed by the level',
};

/** Duree d'affichage d'une ligne, en secondes. */
const LIFETIME = 5;
const MAX_LINES = 5;

interface Line {
  element: HTMLElement;
  age: number;
}

export class Obituaries implements UIComponent {
  readonly element: HTMLElement;
  private readonly lines: Line[] = [];

  constructor(
    private readonly settings: UISettings,
    events: UIEvents,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'hud-obituaries';

    events.on('obituary', (notice) => {
      const line = document.createElement('div');
      line.className = 'hud-obituary';
      if (notice.attackerIsHuman || notice.victimIsHuman) line.classList.add('hud-obituary--mine');

      if (notice.selfInflicted) {
        line.innerHTML = `<b>${escape(notice.victim)}</b> <span>${
          notice.weapon === 'world' ? CAUSE.world : 'blew himself up'
        }</span>`;
      } else {
        const verb = CAUSE[notice.weapon] ?? 'fragged';
        line.innerHTML = `<b>${escape(notice.attacker)}</b> <span>${verb}</span> <b>${escape(
          notice.victim,
        )}</b>`;
      }

      this.element.append(line);
      this.lines.push({ element: line, age: 0 });
      // Au-dela de cinq lignes, la plus ancienne part : le journal ne doit pas
      // devenir un mur de texte pendant une melee.
      while (this.lines.length > MAX_LINES) {
        const oldest = this.lines.shift();
        oldest?.element.remove();
      }
    });
  }

  update(delta: number): void {
    this.element.style.display = !this.settings.current.showKillFeed ? 'none' : '';
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const line = this.lines[i];
      line.age += delta;
      if (line.age > LIFETIME) {
        line.element.remove();
        this.lines.splice(i, 1);
        continue;
      }
      // Effacement sur la derniere seconde.
      const left = LIFETIME - line.age;
      line.element.style.opacity = left < 1 ? left.toFixed(2) : '1';
    }
  }
}

/** Les noms viennent du jeu, mais rien n'oblige a leur faire confiance. */
function escape(text: string): string {
  return text.replace(/[&<>"]/g, (character) => {
    if (character === '&') return '&amp;';
    if (character === '<') return '&lt;';
    if (character === '>') return '&gt;';
    return '&quot;';
  });
}

/** Nom lisible d'une arme, pour les ecrans qui en parlent. */
export function weaponLabel(weapon: WeaponId | 'world'): string {
  return weapon === 'world' ? 'the level' : WEAPONS[weapon].name;
}
