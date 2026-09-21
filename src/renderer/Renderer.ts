import * as THREE from 'three';
import type { ModernRenderSettings } from './RenderSettings';

/**
 * Enveloppe du moteur de rendu : gestion de la taille, de la resolution
 * interne et de la chaine colorimetrique.
 *
 * Le rendu travaille en espace lineaire du debut a la fin ; la conversion vers
 * l'espace d'affichage a lieu une seule fois, tout a la fin de la chaine.
 */
export class Renderer {
  readonly webgl: THREE.WebGLRenderer;
  private width = 1;
  private height = 1;
  private scale = 1;

  constructor(canvas: HTMLCanvasElement, settings: ModernRenderSettings) {
    this.webgl = new THREE.WebGLRenderer({
      canvas,
      antialias: settings.antiAliasing === 'msaa',
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.webgl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Les couleurs sont converties en sortie de chaine, pas avant.
    this.webgl.outputColorSpace = THREE.SRGBColorSpace;
    this.webgl.toneMapping = THREE.NoToneMapping;
    this.webgl.shadowMap.enabled = settings.shadows;
    this.webgl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.webgl.info.autoReset = false;
    THREE.ColorManagement.enabled = true;

    this.scale = settings.renderScale;
  }

  get maxAnisotropy(): number {
    return this.webgl.capabilities.getMaxAnisotropy();
  }

  /** Vrai quand le materiel accepte un tampon flottant : sans lui, pas de HDR. */
  get supportsHDR(): boolean {
    return this.webgl.capabilities.isWebGL2 || this.webgl.extensions.has('OES_texture_half_float');
  }

  get renderScale(): number {
    return this.scale;
  }

  get internalSize(): { width: number; height: number } {
    return {
      width: Math.max(1, Math.round(this.width * this.scale)),
      height: Math.max(1, Math.round(this.height * this.scale)),
    };
  }

  setViewport(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.applySize();
  }

  setRenderScale(scale: number): void {
    this.scale = Math.max(0.25, Math.min(2, scale));
    this.applySize();
  }

  applySettings(settings: ModernRenderSettings): void {
    this.webgl.shadowMap.enabled = settings.shadows && settings.shadowQuality !== 'off';
    this.webgl.shadowMap.needsUpdate = true;
    if (settings.renderScale !== this.scale) this.setRenderScale(settings.renderScale);
  }

  private applySize(): void {
    const size = this.internalSize;
    // Le canevas garde la taille de la fenetre, seul le rendu change d'echelle.
    const canvas = this.webgl.domElement;
    const pixelRatio = this.webgl.getPixelRatio();
    // Reecrire width/height efface aussi le canevas quand la taille ne change
    // pas. setRenderScale puis setViewport peuvent demander la meme taille.
    if (
      canvas.width !== Math.floor(size.width * pixelRatio) ||
      canvas.height !== Math.floor(size.height * pixelRatio)
    ) {
      this.webgl.setSize(size.width, size.height, false);
    }
    canvas.style.width = `${this.width}px`;
    canvas.style.height = `${this.height}px`;
  }

  dispose(): void {
    this.webgl.dispose();
  }
}
