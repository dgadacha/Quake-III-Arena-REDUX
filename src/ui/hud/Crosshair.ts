import type { UIComponent } from '../core/UIManager';
import type { UIEvents } from '../core/UIEvents';
import type { UISettings, UISettingsValues } from '../core/UISettings';

/**
 * Reticule. Il est dessine en filets, dont la longueur, l'epaisseur, l'ecart au
 * centre, la couleur et le contour viennent des reglages : rien n'est une image
 * fixe, donc rien ne pixelise en 4K.
 *
 * Quake demande de la precision : le reticule ne s'anime presque pas. Un tir
 * ecarte les branches d'un rien, une touche allume brievement un marqueur, et
 * c'est tout.
 */
export class Crosshair implements UIComponent {
  readonly element: HTMLElement;
  private readonly parts: HTMLElement[] = [];
  private readonly dot: HTMLElement;
  private readonly marker: HTMLElement;
  private spread = 0;
  private markerTimer = 0;
  private markerKill = false;
  private signature = '';

  constructor(
    private readonly settings: UISettings,
    events: UIEvents,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'hud-crosshair';

    // Quatre branches, un point central, un marqueur de touche.
    for (let i = 0; i < 4; i++) {
      const part = document.createElement('span');
      part.className = 'hud-crosshair__part';
      this.element.appendChild(part);
      this.parts.push(part);
    }
    this.dot = document.createElement('span');
    this.dot.className = 'hud-crosshair__part hud-crosshair__dot';
    this.element.appendChild(this.dot);

    this.marker = document.createElement('span');
    this.marker.className = 'hud-crosshair__marker';
    this.marker.textContent = '×';
    this.element.appendChild(this.marker);

    events.on('weaponFire', () => {
      if (this.settings.current.dynamicCrosshair) this.spread = 3;
    });
    events.on('hit', ({ kill }) => {
      if (!this.settings.current.hitmarker) return;
      // Une elimination se distingue par un marqueur plus marque et un peu plus long.
      this.markerKill = kill;
      this.markerTimer = kill ? 0.18 : 0.1;
    });
  }

  update(delta: number): void {
    const settings = this.settings.current;
    const signature = [
      settings.crosshairStyle,
      settings.crosshairSize,
      settings.crosshairThickness,
      settings.crosshairGap,
      settings.crosshairOpacity,
      settings.crosshairColor,
      settings.crosshairOutline,
    ].join('|');
    if (signature !== this.signature) {
      this.signature = signature;
      this.layout(settings);
    }

    // Retour au centre apres un tir, en une fraction de seconde.
    if (this.spread > 0) {
      this.spread = Math.max(0, this.spread - delta * 18);
      this.place(settings, this.spread);
    }

    if (this.markerTimer > 0) {
      this.markerTimer -= delta;
      const visible = this.markerTimer > 0;
      this.marker.style.opacity = visible ? '1' : '0';
      this.marker.style.color = this.markerKill ? 'var(--ui-danger)' : 'var(--ui-text)';
      this.marker.style.fontSize = this.markerKill ? '26px' : '18px';
    }
  }

  private layout(settings: UISettingsValues): void {
    const style = settings.crosshairStyle;
    const thickness = Math.max(1, settings.crosshairThickness);
    const length = Math.max(2, settings.crosshairSize / 2);

    this.element.style.color = settings.crosshairColor;
    this.element.style.opacity = String(settings.crosshairOpacity);
    this.element.classList.toggle('hud-crosshair--outline', settings.crosshairOutline);

    const showBranches = style === 'cross' || style === 'cross-dot' || style === 'brackets';
    for (const part of this.parts) part.style.display = showBranches ? '' : 'none';
    this.dot.style.display = style === 'dot' || style === 'cross-dot' ? '' : 'none';

    // Branches verticales et horizontales, de meme epaisseur.
    for (let i = 0; i < 4; i++) {
      const part = this.parts[i];
      const vertical = i < 2;
      part.style.width = `${vertical ? thickness : length}px`;
      part.style.height = `${vertical ? length : thickness}px`;
    }

    const dotSize = Math.max(1, thickness);
    this.dot.style.width = `${dotSize}px`;
    this.dot.style.height = `${dotSize}px`;
    this.dot.style.left = `calc(50% - ${dotSize / 2}px)`;
    this.dot.style.top = `calc(50% - ${dotSize / 2}px)`;

    this.marker.style.position = 'absolute';
    this.marker.style.left = '50%';
    this.marker.style.top = '50%';
    this.marker.style.transform = 'translate(-50%, -50%)';
    this.marker.style.opacity = '0';
    this.marker.style.transition = 'opacity var(--ui-fast) ease';
    this.marker.style.fontWeight = '700';

    this.place(settings, 0);
  }

  private place(settings: UISettingsValues, extra: number): void {
    const thickness = Math.max(1, settings.crosshairThickness);
    const length = Math.max(2, settings.crosshairSize / 2);
    const gap = Math.max(0, settings.crosshairGap) + extra;

    const offsets: [string, string][] = [
      // Haut, bas, gauche, droite.
      [`calc(50% - ${thickness / 2}px)`, `calc(50% - ${gap + length}px)`],
      [`calc(50% - ${thickness / 2}px)`, `calc(50% + ${gap}px)`],
      [`calc(50% - ${gap + length}px)`, `calc(50% - ${thickness / 2}px)`],
      [`calc(50% + ${gap}px)`, `calc(50% - ${thickness / 2}px)`],
    ];
    for (let i = 0; i < 4; i++) {
      this.parts[i].style.left = offsets[i][0];
      this.parts[i].style.top = offsets[i][1];
    }
  }
}
