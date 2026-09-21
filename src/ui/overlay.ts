import './style.css';
import type { Stats } from '../game/session';

export interface MapEntry {
  /** Chemin dans l'archive, par exemple maps/q3dm1.bsp. */
  path: string;
  name: string;
  source: string;
}

/** Ecrans du jeu : accueil, chargement, affichage en cours de partie. */
export class Overlay {
  private readonly menu: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly hud: HTMLElement;
  private readonly mapList: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly loadingLabel: HTMLElement;
  private readonly loadingFill: HTMLElement;
  private readonly statsBox: HTMLElement;

  private readonly notes: HTMLElement;
  private readonly toast: HTMLElement;
  private toastTimer = 0;
  private maps: MapEntry[] = [];

  private readonly sources: HTMLElement;

  onSelectMap: ((entry: MapEntry) => void) | null = null;
  onSelectSource: ((name: string) => void) | null = null;
  onDemo: (() => void) | null = null;

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="screen screen--menu" data-screen="menu">
        <div class="title">
          <!-- Le logo porte le nom : le repeter en texte ferait doublon. -->
          <img class="title__logo" src="/logo.png" alt="Quake Redux" />
          <p>Moteur d'arene en TypeScript et Three.js</p>
        </div>
        <div class="panel">
          <div class="panel__head">
            <div class="sources"></div>
            <input type="search" placeholder="Filtrer" spellcheck="false" />
          </div>
          <div class="maps"></div>
        </div>
        <div class="actions">
          <button class="primary" data-action="demo">Arene de demonstration</button>
        </div>
        <p class="notes"></p>
      </div>

      <div class="screen screen--loading" data-screen="loading">
        <div class="loading__label">Chargement</div>
        <div class="loading__bar"><div class="loading__fill"></div></div>
      </div>

      <div class="hud">
        <div class="stats"></div>
        <div class="hint">
          Deplacement : W A S D &middot; Saut : espace &middot; Accroupi : Ctrl<br />
          Tir : clic &middot; Armes : 1 a 9 et molette &middot; Reglages : G<br />
          Vue : souris &middot; Relacher : Echap &middot; Reapparaitre : R &middot; Menu : M
        </div>
      </div>

      <div class="toast"></div>
    `;

    this.menu = root.querySelector('[data-screen="menu"]') as HTMLElement;
    this.loading = root.querySelector('[data-screen="loading"]') as HTMLElement;
    this.hud = root.querySelector('.hud') as HTMLElement;
    this.mapList = root.querySelector('.maps') as HTMLElement;
    this.sources = root.querySelector('.sources') as HTMLElement;
    this.search = root.querySelector('input[type="search"]') as HTMLInputElement;
    this.loadingLabel = root.querySelector('.loading__label') as HTMLElement;
    this.loadingFill = root.querySelector('.loading__fill') as HTMLElement;
    this.statsBox = root.querySelector('.stats') as HTMLElement;

    this.notes = root.querySelector('.notes') as HTMLElement;
    this.toast = root.querySelector('.toast') as HTMLElement;

    this.search.addEventListener('input', () => this.renderMaps());
    root.querySelector('[data-action="demo"]')?.addEventListener('click', () => this.onDemo?.());
    this.showMenu();
  }

  /** Dossiers de donnees disponibles : on n'en monte qu'un a la fois. */
  setSources(names: string[], active: string): void {
    this.sources.innerHTML = '';
    for (const name of names) {
      const button = document.createElement('button');
      button.className = name === active ? 'source active' : 'source';
      button.textContent = name;
      button.addEventListener('click', () => {
        if (name !== active) this.onSelectSource?.(name);
      });
      this.sources.appendChild(button);
    }
  }

  setMaps(maps: MapEntry[]): void {
    this.maps = maps;
    this.renderMaps();
  }

  setNotes(text: string, isError = false): void {
    this.notes.textContent = text;
    this.notes.classList.toggle('error', isError);
  }

  showMenu(): void {
    this.menu.classList.add('visible');
    this.loading.classList.remove('visible');
    this.hud.classList.remove('visible');
  }

  showLoading(label: string): void {
    this.loadingLabel.textContent = label;
    this.loadingFill.style.width = '0%';
    this.menu.classList.remove('visible');
    this.loading.classList.add('visible');
    this.hud.classList.remove('visible');
  }

  setProgress(label: string, done: number, total: number): void {
    this.loadingLabel.textContent = label;
    const ratio = total > 0 ? Math.min(1, done / total) : 0;
    this.loadingFill.style.width = `${Math.round(ratio * 100)}%`;
  }

  showGame(): void {
    this.menu.classList.remove('visible');
    this.loading.classList.remove('visible');
    this.hud.classList.add('visible');
  }

  updateStats(stats: Stats): void {

    const [x, y, z] = stats.origin;
    this.statsBox.innerHTML = `
      <div><b>${stats.fps.toFixed(0)}</b> images / s &middot; ${stats.frameTime.toFixed(
        1,
      )} ms &middot; processeur ${stats.cpuTime.toFixed(1)} ms</div>
      <div>${stats.drawCalls} appels &middot; ${formatNumber(stats.triangles)} triangles &middot; ${
        stats.textures
      } textures &middot; ${stats.geometries} maillages</div>
      <div>${stats.activeLights} lampes &middot; ${stats.activeParticles} particules &middot; ${
        stats.activeDecals
      } impacts &middot; rendu ${Math.round(stats.renderScale * 100)} %</div>
      <div>envoi CPU le plus long : ${stats.heaviestStage || 'aucune'}${
        stats.heaviestStageMs > 0 ? ` ${stats.heaviestStageMs.toFixed(2)} ms` : ''
      }</div>
      <div>position ${x.toFixed(0)} ${y.toFixed(0)} ${z.toFixed(0)} &middot; ${
        stats.onGround ? 'au sol' : 'en l\'air'
      }${stats.waterLevel > 0 ? ` &middot; eau ${stats.waterLevel}` : ''}</div>
    `;
  }

  notify(message: string, duration = 2600): void {
    this.toast.textContent = message;
    this.toast.classList.add('visible');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('visible'), duration);
  }

  private renderMaps(): void {
    const filter = this.search.value.trim().toLowerCase();
    const visible = filter ? this.maps.filter((entry) => entry.name.includes(filter)) : this.maps;

    this.mapList.innerHTML = '';
    if (visible.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'notes';
      empty.textContent = this.maps.length
        ? 'Aucune carte ne correspond au filtre.'
        : "Aucune archive trouvee. Placez vos .pk3 dans public/data, puis lancez node tools/scan-data.mjs.";
      this.mapList.appendChild(empty);
      return;
    }

    for (const entry of visible) {
      const button = document.createElement('button');
      button.className = 'map';
      button.innerHTML = `${entry.name}<small>${entry.source}</small>`;
      button.addEventListener('click', () => this.onSelectMap?.(entry));
      this.mapList.appendChild(button);
    }
  }
}

function formatNumber(value: number): string {
  return value.toLocaleString('fr-FR');
}
