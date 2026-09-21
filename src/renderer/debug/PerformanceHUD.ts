import type * as THREE from 'three';

/**
 * Releve de ce que coute une image. Les chiffres viennent du moteur de rendu
 * lui-meme : ils servent a savoir ou passe le temps avant d'optimiser quoi que
 * ce soit.
 */
export interface FrameMetrics {
  fps: number;
  /** Duree de l'image, en millisecondes. */
  frameTime: number;
  cpuTime: number;
  drawCalls: number;
  triangles: number;
  programs: number;
  textures: number;
  geometries: number;
  activeLights: number;
  activeParticles: number;
  activeDecals: number;
  renderScale: number;
}

export class PerformanceHUD {
  private frames = 0;
  private elapsed = 0;
  private fps = 0;
  private frameTime = 0;
  private cpuTime = 0;
  private frameStart = 0;

  readonly metrics: FrameMetrics = {
    fps: 0,
    frameTime: 0,
    cpuTime: 0,
    drawCalls: 0,
    triangles: 0,
    programs: 0,
    textures: 0,
    geometries: 0,
    activeLights: 0,
    activeParticles: 0,
    activeDecals: 0,
    renderScale: 1,
  };

  beginFrame(): void {
    this.frameStart = performance.now();
  }

  /** A appeler apres le rendu : les compteurs sont lus puis remis a zero. */
  endFrame(renderer: THREE.WebGLRenderer, delta: number, extra: Partial<FrameMetrics> = {}): FrameMetrics {
    const now = performance.now();
    this.cpuTime = now - this.frameStart;
    this.frameTime = delta * 1000;

    this.frames++;
    this.elapsed += delta;
    if (this.elapsed >= 0.5) {
      this.fps = this.frames / this.elapsed;
      this.frames = 0;
      this.elapsed = 0;
    }

    const render = renderer.info.render;
    const memory = renderer.info.memory;
    Object.assign(this.metrics, {
      fps: this.fps,
      frameTime: this.frameTime,
      cpuTime: this.cpuTime,
      drawCalls: render.calls,
      triangles: render.triangles,
      programs: renderer.info.programs?.length ?? 0,
      textures: memory.textures,
      geometries: memory.geometries,
      ...extra,
    });

    // Les compteurs cumulent toutes les passes : on les remet a zero ici.
    renderer.info.reset();
    return this.metrics;
  }
}
