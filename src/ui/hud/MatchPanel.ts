import type { UIComponent } from '../core/UIManager';
import type { UIState } from '../core/UIState';
import type { UISettings } from '../core/UISettings';

/**
 * Chronometre et score, en haut a droite. Le chronometre est la seule valeur
 * lue a chaque image, et le texte n'est reecrit qu'au changement de seconde.
 */
export class MatchPanel implements UIComponent {
  readonly element: HTMLElement;
  private readonly time: HTMLElement;
  private readonly score: HTMLElement;
  private readonly scoreRow: HTMLElement;
  private lastSecond = -1;
  private lastScore = -1;
  private lastLimit = -1;
  private readonly limit: HTMLElement;

  constructor(
    private readonly state: UIState,
    private readonly settings: UISettings,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'hud-panel hud-match';
    this.element.innerHTML = `
      <div class="hud-match__score">
        <span class="hud-match__label">score</span>
        <b>0</b><span class="hud-match__limit"></span>
      </div>
      <div class="hud-match__time">00:00</div>
    `;
    this.time = this.element.querySelector('.hud-match__time') as HTMLElement;
    this.scoreRow = this.element.querySelector('.hud-match__score') as HTMLElement;
    this.score = this.scoreRow.querySelector('b') as HTMLElement;
    this.limit = this.scoreRow.querySelector('.hud-match__limit') as HTMLElement;
  }

  update(): void {
    const { match } = this.state.current;
    const settings = this.settings.current;
    this.time.style.display = settings.showTimer ? '' : 'none';
    this.scoreRow.style.display = settings.showScore ? '' : 'none';

    const seconds = Math.max(0, Math.floor(match.time));
    if (seconds !== this.lastSecond) {
      this.lastSecond = seconds;
      const minutes = Math.floor(seconds / 60);
      const rest = seconds % 60;
      this.time.textContent = `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
    }
    if (match.score !== this.lastScore) {
      this.lastScore = match.score;
      this.score.textContent = String(match.score);
    }
    if (match.fragLimit !== this.lastLimit) {
      this.lastLimit = match.fragLimit;
      // La limite se lit a cote du score : c'est ce qui dit ou l'on en est.
      this.limit.textContent = match.fragLimit > 0 ? ` / ${match.fragLimit}` : '';
    }
  }
}
