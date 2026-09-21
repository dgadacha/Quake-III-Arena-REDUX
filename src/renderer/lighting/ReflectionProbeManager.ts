import * as THREE from 'three';

/**
 * Sondes de reflet.
 *
 * Un metal ne diffuse presque rien : il renvoie ce qui l'entoure. Sans
 * environnement a refleter, une surface metallique est donc un aplat sombre, et
 * c'est pour cela que la part metallique devait rester basse jusqu'ici. Ces
 * sondes donnent cet environnement : une vue cubique de la scene, prise en
 * plusieurs endroits de la carte, et la plus proche sert de reflet aux
 * surfaces.
 *
 * Les captures ne sont pas refaites a chaque image. Six rendus par sonde, une
 * fois la carte chargee et etalees sur plusieurs images pour ne pas figer le
 * jeu, suffisent : le decor ne bouge pas.
 */

interface Probe {
  position: THREE.Vector3;
  target: THREE.WebGLCubeRenderTarget;
  camera: THREE.CubeCamera;
  captured: boolean;
}

export class ReflectionProbeManager {
  private readonly probes: Probe[] = [];
  private pending = 0;
  private current = -1;

  constructor(private readonly resolution = 128) {}

  /** Texture de la sonde en cours, ou rien si aucune n'est prete. */
  get texture(): THREE.Texture | null {
    const probe = this.probes[this.current];
    return probe?.captured ? probe.target.texture : null;
  }

  get hasCapture(): boolean {
    return this.probes.some((probe) => probe.captured);
  }

  get count(): number {
    return this.probes.length;
  }

  /** Nombre de sondes restant a prendre. */
  get remaining(): number {
    return Math.max(0, this.probes.length - this.pending);
  }

  /**
   * Declare ou poser les sondes.
   *
   * Les points sont ecartes les uns des autres : deux sondes voisines
   * refleteraient la meme chose pour le prix de douze rendus. Le nombre est
   * borne, la memoire video etant proportionnelle.
   */
  place(positions: THREE.Vector3[], spacing = 420, limit = 8): void {
    this.dispose();
    for (const position of positions) {
      if (this.probes.length >= limit) break;
      const tooClose = this.probes.some(
        (probe) => probe.position.distanceTo(position) < spacing,
      );
      if (tooClose) continue;

      const target = new THREE.WebGLCubeRenderTarget(this.resolution, {
        type: THREE.HalfFloatType,
        generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter,
      });
      this.probes.push({
        position: position.clone(),
        target,
        camera: new THREE.CubeCamera(4, 8000, target),
        captured: false,
      });
    }
    this.pending = 0;
    this.current = -1;
  }

  /**
   * Prend la prochaine sonde qui attend. Une seule par appel : six rendus de
   * la carte entiere dans la meme image se verraient.
   */
  captureNext(renderer: THREE.WebGLRenderer, scene: THREE.Scene): boolean {
    if (this.pending >= this.probes.length) return false;
    const probe = this.probes[this.pending++];

    const hidden: THREE.Object3D[] = [];
    scene.traverse((object) => {
      if (EXCLUDED.has(object.name) && object.visible) {
        object.visible = false;
        hidden.push(object);
      }
    });

    probe.camera.position.copy(probe.position);
    probe.camera.update(renderer, scene);
    probe.captured = true;

    for (const object of hidden) object.visible = true;
    if (this.current < 0) this.current = this.probes.indexOf(probe);
    return true;
  }

  /**
   * Choisit la sonde la plus proche du point demande. Rend vrai quand elle a
   * change, pour que l'appelant reaffecte l'environnement de la scene.
   */
  follow(position: THREE.Vector3): boolean {
    let best = -1;
    let bestDistance = Infinity;
    for (let index = 0; index < this.probes.length; index++) {
      const probe = this.probes[index];
      if (!probe.captured) continue;
      const distance = probe.position.distanceToSquared(position);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    if (best < 0 || best === this.current) return false;
    this.current = best;
    return true;
  }

  dispose(): void {
    for (const probe of this.probes) probe.target.dispose();
    this.probes.length = 0;
    this.pending = 0;
    this.current = -1;
  }
}

/** Objets exclus de la capture : ils n'ont rien a faire dans un reflet fixe. */
const EXCLUDED = new Set([
  'particles',
  'particles-additive',
  'beams',
  'projectiles',
  'shockwaves',
  'decals',
  'world-effects',
  'viewmodel',
]);
