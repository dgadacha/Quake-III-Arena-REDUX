import * as THREE from 'three';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';

/** AO a resolution reduite, composee dans l'image du monde a pleine taille. */
export class ScaledGTAOPass extends GTAOPass {
  constructor(scene: THREE.Scene, camera: THREE.Camera, width: number, height: number,
    private readonly resolutionScale = 0.5) {
    super(scene, camera, width, height);
    this.setSize(width, height);
  }

  override setSize(width: number, height: number): void {
    const scale = this.resolutionScale ?? 0.5;
    super.setSize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
  }
}
