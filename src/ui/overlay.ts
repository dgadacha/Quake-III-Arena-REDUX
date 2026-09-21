import './style.css';
import type { Stats } from '../game/session';

export interface MapEntry {
  /** Chemin dans l'archive, par exemple maps/q3dm1.bsp. */
  path: string;
  name: string;
  source: string;
}

/**
 * Couches de service : chargement, compteurs de mise au point et messages
 * courts. Le menu principal est un composant a part : il a sa propre mise en
 * page, celle du jeu d'origine.
 */
export class Overlay {
  private readonly loading: HTMLElement;
  private readonly hud: HTMLElement;
  private readonly loadingLabel: HTMLElement;
  private readonly loadingFill: HTMLElement;
  private readonly statsBox: HTMLElement;

  private readonly toast: HTMLElement;
  private toastTimer = 0;

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="screen screen--loading" data-screen="loading">
        <div class="loading__label">Loading</div>
        <div class="loading__bar"><div class="loading__fill"></div></div>
      </div>

      <div class="hud">
        <div class="stats"></div>
        <div class="hint">
          Move: W A S D &middot; Jump: space &middot; Crouch: Ctrl<br />
          Fire: click &middot; Weapons: 1 to 9 and wheel &middot; Settings: G<br />
          Look: mouse &middot; Release: Esc &middot; Respawn: R &middot; Menu: M
        </div>
      </div>

      <div class="toast"></div>
    `;

    this.loading = root.querySelector('[data-screen="loading"]') as HTMLElement;
    this.hud = root.querySelector('.hud') as HTMLElement;
    this.loadingLabel = root.querySelector('.loading__label') as HTMLElement;
    this.loadingFill = root.querySelector('.loading__fill') as HTMLElement;
    this.statsBox = root.querySelector('.stats') as HTMLElement;
    this.toast = root.querySelector('.toast') as HTMLElement;
  }

  /** Etat hors partie : ni chargement, ni compteurs, le menu passe devant. */
  showMenu(): void {
    this.loading.classList.remove('visible');
    this.hud.classList.remove('visible');
  }

  showLoading(label: string): void {
    this.loadingLabel.textContent = label;
    this.loadingFill.style.width = '0%';
    this.loading.classList.add('visible');
    this.hud.classList.remove('visible');
  }

  setProgress(label: string, done: number, total: number): void {
    this.loadingLabel.textContent = label;
    const ratio = total > 0 ? Math.min(1, done / total) : 0;
    this.loadingFill.style.width = `${Math.round(ratio * 100)}%`;
  }

  showGame(): void {
    this.loading.classList.remove('visible');
    this.hud.classList.add('visible');
  }

  /**
   * Montre le decor sans rien par-dessus : c'est l'etat du banc de mesure,
   * ou seul son bandeau doit apparaitre.
   */
  showScene(): void {
    this.loading.classList.remove('visible');
    this.hud.classList.remove('visible');
  }

  updateStats(stats: Stats): void {

    const [x, y, z] = stats.origin;
    this.statsBox.innerHTML = `
      <div><b>${stats.fps.toFixed(0)}</b> fps &middot; ${stats.frameTime.toFixed(
        1,
      )} ms &middot; cpu ${stats.cpuTime.toFixed(1)} ms</div>
      <div>${stats.drawCalls} draw calls &middot; ${formatNumber(stats.triangles)} triangles &middot; ${
        stats.textures
      } textures &middot; ${stats.geometries} meshes</div>
      <div>${stats.activeLights} lights &middot; ${stats.activeParticles} particles &middot; ${
        stats.activeDecals
      } marks &middot; render ${Math.round(stats.renderScale * 100)} %</div>
      <div>longest cpu submit: ${stats.heaviestStage || 'none'}${
        stats.heaviestStageMs > 0 ? ` ${stats.heaviestStageMs.toFixed(2)} ms` : ''
      }</div>
      <div>position ${x.toFixed(0)} ${y.toFixed(0)} ${z.toFixed(0)} &middot; ${
        stats.onGround ? 'on ground' : 'airborne'
      }${stats.waterLevel > 0 ? ` &middot; water ${stats.waterLevel}` : ''}</div>
    `;
  }

  notify(message: string, duration = 2600): void {
    this.toast.textContent = message;
    this.toast.classList.add('visible');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('visible'), duration);
  }
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}
