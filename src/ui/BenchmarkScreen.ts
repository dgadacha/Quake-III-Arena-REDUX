import type { BenchmarkProgress } from '../game/session';
import type { BenchmarkReport } from '../game/benchmark/BenchmarkRun';

/**
 * Ecrans du banc de mesure : le bandeau pendant le parcours, et le resultat.
 *
 * Le resultat ne se resume pas a une moyenne. Il montre aussi le centieme
 * d'images le plus lent, qui est ce qu'on ressent comme saccade, la cadence
 * troncon par troncon, pour savoir quelle salle coute, et les reglages
 * employes, sans lesquels un chiffre ne se compare a rien.
 */
export class BenchmarkScreen {
  private readonly running: HTMLElement;
  private readonly result: HTMLElement;

  onRepeat: (() => void) | null = null;
  onSettings: (() => void) | null = null;
  onMenu: (() => void) | null = null;
  onCancel: (() => void) | null = null;

  constructor(root: HTMLElement) {
    const host = document.createElement('div');
    host.innerHTML = `
      <div class="bench-run">
        <div class="bench-run__head">
          <span class="bench-run__label">Warming up</span>
          <span class="bench-run__fps"></span>
        </div>
        <div class="bench-run__bar"><div class="bench-run__fill"></div></div>
        <div class="bench-run__note">Esc to abort</div>
      </div>

      <div class="screen screen--bench">
        <div class="bench">
          <div class="bench__head">
            <h2>Benchmark result</h2>
            <span class="bench__map"></span>
          </div>
          <div class="bench__figures"></div>
          <div class="bench__graph"></div>
          <div class="bench__columns">
            <div class="bench__block">
              <h3>By section</h3>
              <div class="bench__segments"></div>
            </div>
            <div class="bench__block">
              <h3>Settings used</h3>
              <div class="bench__settings"></div>
            </div>
          </div>
          <div class="actions">
            <button class="primary" data-bench="repeat">Run again</button>
            <button class="ghost" data-bench="settings">Video settings</button>
            <button class="ghost" data-bench="menu">Back to menu</button>
          </div>
        </div>
      </div>
    `;
    root.appendChild(host);

    this.running = host.querySelector('.bench-run') as HTMLElement;
    this.result = host.querySelector('.screen--bench') as HTMLElement;
    host.querySelector('[data-bench="repeat"]')?.addEventListener('click', () => this.onRepeat?.());
    host.querySelector('[data-bench="settings"]')?.addEventListener('click', () => this.onSettings?.());
    host.querySelector('[data-bench="menu"]')?.addEventListener('click', () => this.onMenu?.());
  }

  get showingResult(): boolean {
    return this.result.classList.contains('visible');
  }

  /** Bandeau du parcours en cours. */
  update(info: BenchmarkProgress): void {
    this.running.classList.add('visible');
    const label = this.running.querySelector('.bench-run__label') as HTMLElement;
    const fps = this.running.querySelector('.bench-run__fps') as HTMLElement;
    const fill = this.running.querySelector('.bench-run__fill') as HTMLElement;
    if (info.warmingUp) {
      label.textContent = 'Warming up';
      fps.textContent = '';
      fill.style.width = '0%';
      return;
    }
    label.textContent = `${info.segment} · ${info.elapsed.toFixed(0)} s of ${info.duration.toFixed(0)}`;
    fps.textContent = `${Math.round(info.fps)} fps`;
    fill.style.width = `${(info.progress * 100).toFixed(1)}%`;
  }

  hideRunning(): void {
    this.running.classList.remove('visible');
  }

  hide(): void {
    this.hideRunning();
    this.result.classList.remove('visible');
  }

  /** Affiche le resultat de l'essai. */
  show(report: BenchmarkReport): void {
    this.hideRunning();
    (this.result.querySelector('.bench__map') as HTMLElement).textContent =
      `${report.map} · ${report.frames} frames in ${report.seconds.toFixed(1)} s · ${Math.round(report.pathLength)} unit path at ${report.speed} per second`;

    const figures = [
      { label: 'Average', value: report.averageFps, hint: 'frames per second' },
      { label: '1 % low', value: report.onePercentLow, hint: 'what reads as stutter' },
      { label: '0.1 % low', value: report.pointOnePercentLow, hint: 'the worst frames' },
      { label: 'Peak', value: report.bestFps, hint: 'fastest frame' },
    ];
    (this.result.querySelector('.bench__figures') as HTMLElement).innerHTML = figures
      .map(
        (figure) => `
        <div class="bench-figure">
          <b>${figure.value.toFixed(1)}</b>
          <span>${figure.label}</span>
          <small>${figure.hint}</small>
        </div>`,
      )
      .join('');

    (this.result.querySelector('.bench__graph') as HTMLElement).innerHTML = graph(report);

    (this.result.querySelector('.bench__segments') as HTMLElement).innerHTML = report.segments
      .map((segment) => {
        const share = report.bestFps > 0 ? Math.min(1, segment.fps / report.bestFps) : 0;
        return `
        <div class="bench-row">
          <span>${segment.name}</span>
          <div class="bench-row__bar"><div style="width:${(share * 100).toFixed(1)}%"></div></div>
          <b>${segment.fps.toFixed(1)}</b>
        </div>`;
      })
      .join('');

    (this.result.querySelector('.bench__settings') as HTMLElement).innerHTML = report.settings
      .map((entry) => `<div class="bench-setting"><span>${entry.label}</span><b>${entry.value}</b></div>`)
      .join('');

    this.result.classList.add('visible');
  }
}

/**
 * Courbe des cadences, tracee en SVG : une image par point, la moyenne en
 * trait horizontal. Elle sert a voir ou l'essai a decroche, ce qu'une moyenne
 * ne dit jamais.
 */
function graph(report: BenchmarkReport): string {
  const values = report.curve.map((delta) => (delta > 0 ? 1 / delta : 0));
  if (values.length < 2) return '';
  const top = Math.max(60, Math.ceil(Math.max(...values) / 30) * 30);
  const width = 100;
  const height = 100;
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - Math.min(1, value / top) * height;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  const average = height - Math.min(1, report.averageFps / top) * height;

  return `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img"
         aria-label="frame rate along the path">
      <polyline class="bench-graph__line" points="${points}" />
      <line class="bench-graph__average" x1="0" x2="${width}" y1="${average.toFixed(2)}" y2="${average.toFixed(2)}" />
    </svg>
    <div class="bench-graph__scale"><span>${top} fps</span><span>0</span></div>
    <div class="bench-graph__note">dashed line: average</div>
  `;
}
