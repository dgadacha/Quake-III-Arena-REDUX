import type { UIComponent } from '../core/UIManager';
import type { UIState } from '../core/UIState';

/**
 * Tableau des scores : celui qu'on ouvre en cours de partie, et celui qui
 * reste a l'ecran quand la partie est finie.
 *
 * La composition est celle du jeu : le mode en tete, la limite de frags a
 * cote, puis une ligne par combattant, frags et morts. La ligne du joueur est
 * mise en avant, sans quoi on cherche son nom dans une liste de huit.
 */
export class Scoreboard implements UIComponent {
  readonly element: HTMLElement;
  private readonly head: HTMLElement;
  private readonly rows: HTMLElement;
  private readonly note: HTMLElement;
  private signature = '';
  private open = false;
  private final = false;

  constructor(private readonly state: UIState) {
    this.element = document.createElement('div');
    this.element.className = 'hud-scoreboard';
    this.element.innerHTML = `
      <div class="hud-scoreboard__head"></div>
      <div class="hud-scoreboard__rows"></div>
      <div class="hud-scoreboard__note"></div>
    `;
    this.head = this.element.querySelector('.hud-scoreboard__head') as HTMLElement;
    this.rows = this.element.querySelector('.hud-scoreboard__rows') as HTMLElement;
    this.note = this.element.querySelector('.hud-scoreboard__note') as HTMLElement;
    this.element.style.display = 'none';
  }

  /** Ouvert tant que la touche est tenue, ferme des qu'elle est relachee. */
  setOpen(open: boolean): void {
    this.open = open;
  }

  /** La partie est finie : le tableau reste, avec le vainqueur en tete. */
  setFinal(final: boolean): void {
    this.final = final;
    if (final) this.signature = '';
  }

  update(): void {
    const visible = this.open || this.final;
    this.element.style.display = visible ? '' : 'none';
    if (!visible) return;

    const { standings, match } = this.state.current;
    // Rien n'est reecrit tant que rien n'a change : le tableau reste ouvert
    // plusieurs secondes d'affilee.
    const signature = `${match.mode}|${match.fragLimit}|${standings
      .map((entry) => `${entry.name}:${entry.score}:${entry.deaths}`)
      .join(',')}`;
    if (signature === this.signature) return;
    this.signature = signature;

    this.head.innerHTML = `
      <span class="hud-scoreboard__mode">${match.mode}</span>
      <span class="hud-scoreboard__limit">${
        match.fragLimit > 0 ? `FRAG LIMIT ${match.fragLimit}` : 'NO LIMIT'
      }</span>
    `;

    this.rows.innerHTML = standings
      .map((entry, index) => {
        const classes = ['hud-scoreboard__row'];
        if (entry.human) classes.push('hud-scoreboard__row--mine');
        if (index === 0 && this.final) classes.push('hud-scoreboard__row--winner');
        return `
          <div class="${classes.join(' ')}">
            <span class="hud-scoreboard__rank">${index + 1}</span>
            <span class="hud-scoreboard__name">${escape(entry.name)}</span>
            <span class="hud-scoreboard__frags">${entry.score}</span>
            <span class="hud-scoreboard__deaths">${entry.deaths}</span>
          </div>
        `;
      })
      .join('');

    const leader = standings[0];
    this.note.textContent = this.final
      ? leader?.human
        ? 'YOU WIN'
        : `${leader?.name ?? ''} WINS`
      : 'FRAGS · DEATHS';
  }
}

function escape(text: string): string {
  return text.replace(/[&<>"]/g, (character) => {
    if (character === '&') return '&amp;';
    if (character === '<') return '&lt;';
    if (character === '>') return '&gt;';
    return '&quot;';
  });
}
