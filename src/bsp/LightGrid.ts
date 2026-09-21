import * as THREE from 'three';
import type { BspMap, Vec3 } from '../formats/bsp';

/**
 * Grille d'eclairage de la carte. Le compilateur y range, tous les 64 par 64
 * par 128 unites, une couleur d'ambiance, une couleur directionnelle et la
 * direction d'ou vient la lumiere. C'est ce qui eclaire les objets mobiles :
 * les lightmaps ne couvrent que les surfaces fixes.
 *
 * La valeur lue est interpolee entre les huit cellules qui entourent le point,
 * de sorte qu'un objet qui traverse une piece voit son eclairage evoluer sans
 * marche d'escalier.
 */

export interface GridSample {
  ambient: THREE.Color;
  directional: THREE.Color;
  /** Direction d'ou vient la lumiere, normalisee. */
  direction: THREE.Vector3;
}

const STEP: Vec3 = [64, 64, 128];

export class LightGrid {
  private readonly counts: [number, number, number];
  private readonly mins: Vec3;
  private readonly ambient: Uint8Array;
  private readonly directional: Uint8Array;
  private readonly direction: Uint8Array;
  readonly available: boolean;

  constructor(map: BspMap) {
    const volumes = map.lightVolumes;
    if (!volumes) {
      this.available = false;
      this.counts = [0, 0, 0];
      this.mins = [0, 0, 0];
      this.ambient = new Uint8Array(0);
      this.directional = new Uint8Array(0);
      this.direction = new Uint8Array(0);
      return;
    }
    this.available = true;
    this.counts = volumes.counts;
    this.mins = volumes.mins;
    this.ambient = volumes.ambient;
    this.directional = volumes.directional;
    this.direction = volumes.direction;
  }

  /** Eclairage au point demande, ramene dans la grille si l'on sort. */
  sample(position: Vec3, out?: GridSample): GridSample {
    const result: GridSample = out ?? {
      ambient: new THREE.Color(),
      directional: new THREE.Color(),
      direction: new THREE.Vector3(0, 0, 1),
    };
    if (!this.available) {
      result.ambient.setRGB(0.15, 0.15, 0.15);
      result.directional.setRGB(0, 0, 0);
      result.direction.set(0, 0, 1);
      return result;
    }

    // Coordonnees dans la grille, bornees a l'avant-derniere cellule pour que
    // l'interpolation ait toujours un voisin.
    const cell: number[] = [0, 0, 0];
    const fraction: number[] = [0, 0, 0];
    for (let axis = 0; axis < 3; axis++) {
      const value = (position[axis] - this.mins[axis]) / STEP[axis];
      const floor = Math.floor(value);
      cell[axis] = Math.max(0, Math.min(this.counts[axis] - 1, floor));
      fraction[axis] = Math.max(0, Math.min(1, value - floor));
      if (cell[axis] >= this.counts[axis] - 1) fraction[axis] = 0;
    }

    let totalWeight = 0;
    let ar = 0;
    let ag = 0;
    let ab = 0;
    let dr = 0;
    let dg = 0;
    let db = 0;
    let nx = 0;
    let ny = 0;
    let nz = 0;

    for (let corner = 0; corner < 8; corner++) {
      let weight = 1;
      const at: number[] = [0, 0, 0];
      for (let axis = 0; axis < 3; axis++) {
        if (corner & (1 << axis)) {
          weight *= fraction[axis];
          at[axis] = Math.min(cell[axis] + 1, this.counts[axis] - 1);
        } else {
          weight *= 1 - fraction[axis];
          at[axis] = cell[axis];
        }
      }
      if (weight <= 0) continue;

      const index = at[0] + at[1] * this.counts[0] + at[2] * this.counts[0] * this.counts[1];
      if (index < 0 || index * 3 + 2 >= this.ambient.length) continue;

      // Une cellule entierement noire est dans la roche : elle n'apporte rien.
      const sum =
        this.ambient[index * 3] +
        this.ambient[index * 3 + 1] +
        this.ambient[index * 3 + 2] +
        this.directional[index * 3] +
        this.directional[index * 3 + 1] +
        this.directional[index * 3 + 2];
      if (sum === 0) continue;

      totalWeight += weight;
      ar += this.ambient[index * 3] * weight;
      ag += this.ambient[index * 3 + 1] * weight;
      ab += this.ambient[index * 3 + 2] * weight;
      dr += this.directional[index * 3] * weight;
      dg += this.directional[index * 3 + 1] * weight;
      db += this.directional[index * 3 + 2] * weight;

      const normal = decodeDirection(this.direction[index * 2], this.direction[index * 2 + 1]);
      nx += normal[0] * weight;
      ny += normal[1] * weight;
      nz += normal[2] * weight;
    }

    if (totalWeight <= 0) {
      result.ambient.setRGB(0.08, 0.08, 0.08);
      result.directional.setRGB(0, 0, 0);
      result.direction.set(0, 0, 1);
      return result;
    }

    const scale = 1 / (totalWeight * 255);
    result.ambient.setRGB(ar * scale, ag * scale, ab * scale, THREE.SRGBColorSpace);
    result.directional.setRGB(dr * scale, dg * scale, db * scale, THREE.SRGBColorSpace);
    result.direction.set(nx, ny, nz);
    if (result.direction.lengthSq() < 1e-6) result.direction.set(0, 0, 1);
    else result.direction.normalize();
    return result;
  }
}

/**
 * La direction est rangee sur deux octets : une latitude et une longitude, qui
 * decrivent un point sur la sphere.
 */
function decodeDirection(longitudeByte: number, latitudeByte: number): Vec3 {
  const longitude = (longitudeByte * Math.PI * 2) / 256;
  const latitude = (latitudeByte * Math.PI * 2) / 256;
  return [
    Math.cos(latitude) * Math.sin(longitude),
    Math.sin(latitude) * Math.sin(longitude),
    Math.cos(longitude),
  ];
}
