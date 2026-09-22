import '../styles/menu.css';
import type { ModernRenderSettings, RenderSettingsStore } from '../../renderer/RenderSettings';
import { SETTING_ROWS, type SettingRow } from './SettingsRows';
import type { MenuAudio } from './MenuAudio';

/**
 * Menu principal.
 *
 * La composition est celle de Quake III : le titre en haut, les entrees au
 * centre en capitales, le symbole derriere elles, une ligne discrete en bas.
 * Ce qui change, c'est la finition : le decor est rendu en temps reel derriere
 * le menu, la navigation repond au clavier comme a la souris, et les pages
 * glissent l'une vers l'autre au lieu de se remplacer.
 *
 * Le menu ne decide de rien : il annonce l'entree choisie et laisse le jeu
 * agir. C'est ce qui permet de le relire sans suivre le jeu entier.
 */

export interface MenuEntry {
  id: string;
  label: string;
  /** Ligne secondaire sous l'entree, pour une precision courte. */
  note?: string;
  /** Entree de second rang : plus petite, elle ne concurrence pas les autres. */
  minor?: boolean;
}

interface MenuPage {
  id: string;
  title?: string;
  /** Contenu libre place avant les entrees, par exemple la carte a jouer. */
  header?: string;
  /** Page de reglages : ses lignes viennent de la table, pas des entrees. */
  settings?: boolean;
  entries: MenuEntry[];
}

/** Pages du menu de la demonstration. Aucune entree morte : tout repond. */
const PAGES: MenuPage[] = [
  {
    id: 'main',
    entries: [
      { id: 'single', label: 'Single player' },
      { id: 'benchmark', label: 'Benchmark' },
      { id: 'settings', label: 'Settings' },
      { id: 'credits', label: 'Credits' },
      { id: 'arena', label: 'Test arena', minor: true },
    ],
  },
  {
    id: 'single',
    title: 'Single player',
    header: 'card',
    entries: [
      { id: 'start', label: 'Start match' },
      { id: 'back', label: 'Back', minor: true },
    ],
  },
  {
    id: 'settings',
    title: 'Settings',
    settings: true,
    entries: [{ id: 'back', label: 'Back', minor: true }],
  },
  {
    id: 'credits',
    title: 'Credits',
    header: 'credits',
    entries: [{ id: 'back', label: 'Back', minor: true }],
  },
];

export class MainMenu {
  private readonly root: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly selector: HTMLElement;
  private readonly symbol: HTMLElement;
  private readonly notes: HTMLElement;
  private readonly sources: HTMLElement;
  private readonly pages = new Map<string, { element: HTMLElement; items: HTMLButtonElement[] }>();
  /** Lignes de reglage, pour les relire quand une valeur change. */
  private readonly rows = new Map<HTMLButtonElement, SettingRow>();
  private page = 'main';
  private index = 0;
  private visible = false;

  /** Entree validee : son identifiant, page comprise. */
  onSelect: ((page: string, entry: string) => void) | null = null;
  onSource: ((name: string) => void) | null = null;
  /** Prevenu quand un reglage change demande de reprendre la carte. */
  onReload: (() => void) | null = null;
  /** Prevenu quand les reglages ouverts en partie sont refermes. */
  onClose: (() => void) | null = null;

  constructor(
    parent: HTMLElement,
    build: string,
    private readonly store?: RenderSettingsStore,
    private readonly audio?: MenuAudio,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'menu';
    this.root.innerHTML = `
      <svg class="menu__symbol" viewBox="0 0 1000 620" aria-hidden="true">
        <!--
          Le symbole du jeu, redessine au trait : deux croissants ouverts en
          haut et en bas, et les trois lames au centre. Il est presque noir,
          et c'est voulu : il porte la composition sans prendre le regard.
        -->
        <path d="M 430 118 C 232 160 128 250 140 336 C 151 428 292 500 452 528
                 C 304 480 174 414 166 336 C 158 262 246 176 430 118 Z" />
        <path d="M 570 118 C 768 160 872 250 860 336 C 849 428 708 500 548 528
                 C 696 480 826 414 834 336 C 842 262 754 176 570 118 Z" />
        <path d="M 500 60 L 520 300 L 500 560 L 480 300 Z" />
        <path d="M 396 150 L 424 330 L 404 520 L 378 330 Z" />
        <path d="M 604 150 L 622 330 L 596 520 L 576 330 Z" />
      </svg>
      <img class="menu__logo" src="/logo.png" alt="Quake Redux" />
      <div class="menu__stage">
        <div class="menu__selector"></div>
      </div>
      <div class="menu__footer">
        <span><b>Quake Redux</b> &middot; tech demo</span>
        <span class="menu__notes"></span>
        <span class="menu__sources"></span>
      </div>
    `;
    parent.appendChild(this.root);

    this.stage = this.root.querySelector('.menu__stage') as HTMLElement;
    this.selector = this.root.querySelector('.menu__selector') as HTMLElement;
    this.symbol = this.root.querySelector('.menu__symbol') as HTMLElement;
    this.notes = this.root.querySelector('.menu__notes') as HTMLElement;
    this.sources = this.root.querySelector('.menu__sources') as HTMLElement;
    (this.root.querySelector('.menu__footer span') as HTMLElement).insertAdjacentHTML(
      'afterend',
      `<span class="menu__build">build ${build}</span>`,
    );

    for (const page of PAGES) this.pages.set(page.id, this.buildPage(page));
    this.showPage('main');
    window.addEventListener('keydown', this.onKey);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  get currentPage(): string {
    return this.page;
  }

  show(): void {
    this.visible = true;
    this.root.classList.remove('menu--overlay');
    this.root.classList.add('menu--visible');
    this.showPage('main');
  }

  /**
   * Ouvre les reglages par-dessus la partie : ni titre ni symbole, et un
   * assombrissement leger, pour qu'on voie encore ou l'on se trouve.
   */
  openSettings(): void {
    this.visible = true;
    this.root.classList.add('menu--visible', 'menu--overlay');
    this.showPage('settings');
  }

  get inOverlay(): boolean {
    return this.root.classList.contains('menu--overlay');
  }

  hide(): void {
    this.visible = false;
    this.root.classList.remove('menu--visible');
    this.selector.classList.remove('menu__selector--visible');
  }

  /** Nom de la carte jouable, affiche sur la page de partie. */
  setMap(name: string | null): void {
    const card = this.root.querySelector('.menu-card__map') as HTMLElement | null;
    if (card) card.textContent = name ?? 'no map';
    const start = this.pages.get('single')?.items.find((item) => item.dataset.entry === 'start');
    if (start) start.disabled = name === null;
    const single = this.pages.get('main')?.items.find((item) => item.dataset.entry === 'single');
    if (single) single.disabled = name === null;
    const bench = this.pages.get('main')?.items.find((item) => item.dataset.entry === 'benchmark');
    if (bench) bench.disabled = name === null;
  }

  setNotes(text: string, isError = false): void {
    this.notes.textContent = text;
    this.notes.classList.toggle('menu__notes--error', isError);
  }

  /** Dossiers de donnees montes : un seul a la fois, comme dans le jeu. */
  setSources(names: string[], active: string): void {
    this.sources.innerHTML = '';
    for (const name of names) {
      const button = document.createElement('button');
      button.className = name === active ? 'menu__source menu__source--active' : 'menu__source';
      button.textContent = name;
      button.addEventListener('click', () => {
        if (name !== active) this.onSource?.(name);
      });
      this.sources.appendChild(button);
    }
  }

  /** Revient a la page precedente, ou rend faux quand on est a la racine. */
  back(): boolean {
    if (this.page === 'main') return false;
    this.showPage('main');
    return true;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    this.root.remove();
  }

  private buildPage(page: MenuPage): { element: HTMLElement; items: HTMLButtonElement[] } {
    const element = document.createElement('div');
    element.className = 'menu-screen';
    element.dataset.page = page.id;

    if (page.title) {
      const title = document.createElement('h2');
      title.className = 'menu-screen__title';
      title.textContent = page.title;
      element.appendChild(title);
    }
    if (page.header === 'card') {
      const card = document.createElement('div');
      card.className = 'menu-card';
      card.innerHTML = `
        <div class="menu-card__map">q3dm7</div>
        <div class="menu-card__title">The temple of retribution</div>
        <div class="menu-card__line">free for all &middot; no bots in this build</div>
      `;
      element.appendChild(card);
    }
    if (page.header === 'credits') {
      const text = document.createElement('p');
      text.className = 'menu-text';
      text.innerHTML = `
        <b>Quake III Arena</b> is the work of id Software, 1999.<br />
        This is a rendering study: the maps, textures, models and sounds are
        read from your own installation and never leave your machine.<br />
        <b>Quake Redux</b> only adds an engine and a modern look.
      `;
      element.appendChild(text);
    }

    const items: HTMLButtonElement[] = [];
    if (page.settings) {
      const list = document.createElement('div');
      list.className = 'menu-settings';
      element.appendChild(list);
      for (const row of SETTING_ROWS) items.push(this.buildSettingRow(row, list));
    }
    for (const entry of page.entries) {
      const item = document.createElement('button');
      item.className = entry.minor ? 'menu-item menu-item--minor' : 'menu-item';
      item.dataset.entry = entry.id;
      item.innerHTML = entry.note
        ? `${entry.label}<span class="menu-item__note">${entry.note}</span>`
        : entry.label;
      item.addEventListener('mouseenter', () => {
        if (item.disabled || this.index === items.indexOf(item)) return;
        this.index = items.indexOf(item);
        this.refresh();
        this.audio?.play('move');
      });
      item.addEventListener('click', () => this.choose(items.indexOf(item)));
      items.push(item);
      element.appendChild(item);
    }

    this.stage.appendChild(element);
    return { element, items };
  }

  /**
   * Une ligne de reglage : le nom a gauche, la valeur a droite. Elle se change
   * a gauche et a droite, ou en la validant, comme au menu d'origine.
   */
  private buildSettingRow(row: SettingRow, host: HTMLElement): HTMLButtonElement {
    const line = document.createElement('button');
    line.className = 'menu-item menu-setting';
    line.dataset.entry = `set:${row.id}`;
    line.innerHTML = `
      <span class="menu-setting__label">${row.label}</span>
      <span class="menu-setting__bar"><span></span></span>
      <span class="menu-setting__value"></span>
    `;
    line.addEventListener('mouseenter', () => {
      const page = this.pages.get('settings');
      if (!page || this.index === page.items.indexOf(line)) return;
      this.index = page.items.indexOf(line);
      this.refresh();
      this.audio?.play('move');
    });
    line.addEventListener('click', (event) => {
      // Le clic droit de la souris n'arrive pas ici : un clic avance d'un
      // cran, et la molette comme les fleches font les deux sens.
      this.adjust(event.shiftKey ? -1 : 1, line);
    });
    line.addEventListener('wheel', (event) => {
      event.preventDefault();
      this.adjust(event.deltaY > 0 ? -1 : 1, line);
    }, { passive: false });
    host.appendChild(line);
    this.rows.set(line, row);
    return line;
  }

  /** Change la valeur d'une ligne de reglage et la reaffiche. */
  private adjust(direction: number, line: HTMLButtonElement): void {
    const row = this.rows.get(line);
    if (!row || !this.store) return;
    row.step(direction, this.store.current, this.store);
    this.readSettings();
    this.audio?.play('move');
    if (row.reload) this.onReload?.();
  }

  /** Reporte les valeurs courantes dans les lignes de la page de reglages. */
  private readSettings(): void {
    if (!this.store) return;
    const settings: ModernRenderSettings = { ...this.store.current };
    for (const [line, row] of this.rows) {
      const value = row.read(settings, this.store);
      (line.querySelector('.menu-setting__value') as HTMLElement).textContent = value.text;
      const bar = line.querySelector('.menu-setting__bar') as HTMLElement;
      const fill = bar.firstElementChild as HTMLElement;
      bar.classList.toggle('menu-setting__bar--visible', value.fill !== undefined);
      fill.style.width = `${Math.round((value.fill ?? 0) * 100)}%`;
    }
  }

  private showPage(id: string): void {
    const target = this.pages.get(id);
    if (!target) return;
    for (const [pageId, page] of this.pages) {
      if (pageId === id) {
        page.element.className = 'menu-screen menu-screen--active';
        continue;
      }
      // La page quittee glisse du cote d'ou l'autre arrive.
      const leaving = pageId === 'main' && id !== 'main';
      page.element.className = `menu-screen ${leaving ? 'menu-screen--left' : 'menu-screen--right'}`;
    }
    this.page = id;
    if (id === 'settings') this.readSettings();
    this.index = target.items.findIndex((item) => !item.disabled);
    if (this.index < 0) this.index = 0;
    this.refresh();
  }

  /** Souligne l'entree courante et place le selecteur devant elle. */
  private refresh(): void {
    const page = this.pages.get(this.page);
    if (!page) return;
    page.items.forEach((item, position) => {
      item.classList.toggle('menu-item--active', position === this.index && !item.disabled);
    });

    const active = page.items[this.index];
    if (!active || active.disabled || !this.visible) {
      this.selector.classList.remove('menu__selector--visible');
      return;
    }
    const bounds = active.getBoundingClientRect();
    const host = this.stage.getBoundingClientRect();
    const size = this.selector.getBoundingClientRect();
    this.selector.style.top = `${bounds.top - host.top + bounds.height / 2 - size.height / 2}px`;
    // Trois pixels d'avance quand l'entree est prise : le mouvement se sent
    // sans se voir.
    this.selector.style.left = `${bounds.left - host.left - size.width - 6}px`;
    this.selector.classList.add('menu__selector--visible');
  }

  private choose(position: number): void {
    const page = this.pages.get(this.page);
    const item = page?.items[position];
    if (!page || !item) return;
    if (item.disabled) {
      // Le jeu repond aussi quand il ne se passe rien : c'est ce qui dit que
      // l'entree existe mais n'est pas disponible.
      this.audio?.play('deny');
      return;
    }
    this.index = position;
    this.refresh();
    // Le symbole marque le choix d'une impulsion, puis revient a l'ombre.
    this.symbol.classList.add('menu__symbol--pulse');
    window.setTimeout(() => this.symbol.classList.remove('menu__symbol--pulse'), 260);

    const entry = item.dataset.entry ?? '';
    if (entry === 'back') {
      // Ouverts en partie, les reglages se referment sur le jeu et non sur le
      // menu principal.
      if (this.inOverlay) this.onClose?.();
      else this.showPage('main');
      return;
    }
    if (entry.startsWith('set:')) {
      this.adjust(1, item);
      return;
    }
    if (this.page === 'main' && (entry === 'single' || entry === 'credits' || entry === 'settings')) {
      this.showPage(entry);
      return;
    }
    this.onSelect?.(this.page, entry);
  }

  private move(direction: number): void {
    const page = this.pages.get(this.page);
    if (!page) return;
    const count = page.items.length;
    for (let step = 1; step <= count; step++) {
      const next = (this.index + direction * step + count * step) % count;
      if (!page.items[next].disabled) {
        this.index = next;
        this.refresh();
        this.audio?.play('move');
        return;
      }
    }
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    if (!this.visible) return;
    switch (event.code) {
      case 'ArrowUp':
      case 'KeyW':
        event.preventDefault();
        this.move(-1);
        break;
      case 'ArrowDown':
      case 'KeyS':
        event.preventDefault();
        this.move(1);
        break;
      case 'Enter':
      case 'NumpadEnter':
      case 'Space':
        event.preventDefault();
        this.choose(this.index);
        break;
      case 'ArrowLeft':
      case 'KeyA': {
        const item = this.pages.get(this.page)?.items[this.index];
        if (item && this.rows.has(item)) {
          event.preventDefault();
          this.adjust(-1, item);
        }
        break;
      }
      case 'ArrowRight':
      case 'KeyD': {
        const item = this.pages.get(this.page)?.items[this.index];
        if (item && this.rows.has(item)) {
          event.preventDefault();
          this.adjust(1, item);
        }
        break;
      }
      case 'Escape':
        if (this.inOverlay) break;
        if (this.page !== 'main') {
          event.preventDefault();
          this.audio?.play('back');
          this.showPage('main');
        }
        break;
      default:
        break;
    }
  };
}
