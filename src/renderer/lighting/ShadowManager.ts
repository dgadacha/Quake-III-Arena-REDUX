import * as THREE from 'three';
import type { BspMap } from '../../formats/bsp';
import type { ShaderLibrary } from '../../formats/shader';
import { shadowMapSize, type ModernRenderSettings } from '../RenderSettings';

/**
 * Ombres de la scene. Les cartes a ciel ouvert declarent un soleil dans leur
 * shader de ciel : on le reprend tel quel, avec sa couleur et ses angles, pour
 * porter les ombres exterieures. Les interieurs s'en passent, leur eclairage
 * etant deja dans les lightmaps.
 *
 * Le nombre de sources qui projettent des ombres reste volontairement petit :
 * une carte d'ombre par lampe couterait bien plus que ce qu'elle apporte.
 */
/** Delai entre deux redessins de la carte d'ombre du soleil, en secondes. */
const REFRESH_SECONDS = 0.4;

export class ShadowManager {
  private sun: THREE.DirectionalLight | null = null;
  private readonly bounds = new THREE.Box3();
  private sinceRefresh = 0;

  constructor(private readonly settings: ModernRenderSettings) {}

  /** Cherche le soleil declare par un shader de ciel de la carte. */
  attach(root: THREE.Object3D, map: BspMap, shaders: ShaderLibrary): boolean {
    const declared = findSun(map, shaders);
    if (!declared || !this.settings.shadows || this.settings.shadowQuality === 'off') return false;

    const azimuth = (declared.azimuth * Math.PI) / 180;
    const elevation = (declared.elevation * Math.PI) / 180;
    const direction = new THREE.Vector3(
      Math.cos(elevation) * Math.cos(azimuth),
      Math.cos(elevation) * Math.sin(azimuth),
      Math.sin(elevation),
    );

    const world = map.models[0];
    this.bounds.set(
      new THREE.Vector3(world.mins[0], world.mins[1], world.mins[2]),
      new THREE.Vector3(world.maxs[0], world.maxs[1], world.maxs[2]),
    );
    const center = this.bounds.getCenter(new THREE.Vector3());
    const extent = this.bounds.getSize(new THREE.Vector3()).length() * 0.5;

    const sun = new THREE.DirectionalLight(
      new THREE.Color(declared.color[0], declared.color[1], declared.color[2]),
      // La puissance annoncee est celle du compilateur de cartes : ramenee ici
      // a une echelle ou 100 donne une lumiere du jour franche.
      Math.min(6, declared.intensity / 100),
    );
    sun.position.copy(center).addScaledVector(direction, extent * 1.5);
    sun.target.position.copy(center);
    sun.castShadow = true;

    const size = shadowMapSize(this.settings.shadowQuality);
    sun.shadow.mapSize.set(size, size);
    sun.shadow.camera.near = 16;
    sun.shadow.camera.far = extent * 3.5;
    sun.shadow.camera.left = -extent;
    sun.shadow.camera.right = extent;
    sun.shadow.camera.top = extent;
    sun.shadow.camera.bottom = -extent;
    // Sur des murs de plusieurs centaines d'unites, un biais trop faible fait
    // apparaitre des rayures d'ombre sur les surfaces eclairees.
    sun.shadow.bias = -0.0015;
    sun.shadow.normalBias = 2;
    sun.shadow.camera.updateProjectionMatrix();
    /*
     * La carte d'ombre du soleil n'est pas refaite a chaque image. Le decor ne
     * bouge pas et le soleil non plus : seules les parties mobiles changent, et
     * un rafraichissement periodique suffit a les suivre. Sans cela, les
     * dizaines de milliers de triangles de la carte seraient redessines
     * soixante fois par seconde pour une image identique.
     */
    sun.shadow.autoUpdate = false;
    sun.shadow.needsUpdate = true;

    root.add(sun);
    root.add(sun.target);
    this.sun = sun;
    return true;
  }

  get sunLight(): THREE.DirectionalLight | null {
    return this.sun;
  }

  /**
   * Redessine la carte d'ombre du soleil de temps en temps, pour les parties
   * mobiles de la carte : portes, plateformes, ascenseurs.
   */
  refresh(delta: number): void {
    if (!this.sun) return;
    this.sinceRefresh += delta;
    if (this.sinceRefresh < REFRESH_SECONDS) return;
    this.sinceRefresh = 0;
    this.sun.shadow.needsUpdate = true;
  }

  /** Nombre de lampes autorisees a projeter des ombres, en plus du soleil. */
  get dynamicShadowBudget(): number {
    if (!this.settings.shadows || this.settings.shadowQuality === 'off') return 0;
    switch (this.settings.shadowQuality) {
      case 'low':
        return 0;
      case 'medium':
        return 1;
      default:
        return 2;
    }
  }
}

function findSun(
  map: BspMap,
  shaders: ShaderLibrary,
): { color: [number, number, number]; intensity: number; azimuth: number; elevation: number } | null {
  for (const shader of map.shaders) {
    const summary = shaders.get(shader.name);
    if (summary?.sun) return summary.sun;
  }
  return null;
}
