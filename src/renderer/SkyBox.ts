import * as THREE from 'three';
import type { TextureLibrary } from './materials/TextureLibrary';

/**
 * Boite d'horizon. Les cartes fournissent six images nommees par leur
 * orientation ; on les pose sur un cube vu de l'interieur, place autour du
 * joueur. Les images ne sont pas retouchees : seule leur orientation est
 * ramenee dans le repere des cartes, ou l'axe z pointe vers le haut.
 */

/** Ordre des faces d'un cube dans Three : +x, -x, +y, -y, +z, -z. */
const FACE_SUFFIXES = ['ft', 'bk', 'lf', 'rt', 'up', 'dn'];

export interface SkyBox {
  mesh: THREE.Mesh;
  /** A appeler a chaque image : le ciel reste centre sur le joueur. */
  follow(position: THREE.Vector3): void;
}

export async function createSkyBox(base: string, textures: TextureLibrary): Promise<SkyBox | null> {
  const materials: THREE.Material[] = [];

  for (const suffix of FACE_SUFFIXES) {
    const loaded = await textures.load(`${base}_${suffix}`);
    if (!loaded) return null;

    const map = loaded.map;
    // Les bords se verraient si l'image se repetait ou se filtrait au-dela.
    map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
    map.minFilter = THREE.LinearFilter;
    map.magFilter = THREE.LinearFilter;
    map.generateMipmaps = false;
    map.needsUpdate = true;

    materials.push(
      new THREE.MeshBasicMaterial({
        map,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        toneMapped: true,
      }),
    );
  }

  const geometry = new THREE.BoxGeometry(1, 1, 1);
  orientForZUp(geometry);

  const mesh = new THREE.Mesh(geometry, materials);
  mesh.scale.setScalar(9000);
  mesh.frustumCulled = false;
  // Le ciel est dessine en premier, derriere tout le reste.
  mesh.renderOrder = -1000;
  mesh.name = 'sky';

  return {
    mesh,
    follow(position) {
      mesh.position.copy(position);
    },
  };
}

/**
 * Les images sont concues pour un repere ou l'axe y pointe vers le haut. Le
 * cube est donc bascule d'un quart de tour, et ses coordonnees de texture
 * reprises face par face pour que les bords se rejoignent.
 */
function orientForZUp(geometry: THREE.BoxGeometry): void {
  geometry.rotateX(Math.PI / 2);

  const uv = geometry.attributes.uv as THREE.BufferAttribute;
  // Quatre sommets par face, dans l'ordre des groupes de la boite.
  const rotations = [0, 0, 1, 3, 2, 0];
  for (let face = 0; face < 6; face++) {
    const quarter = rotations[face];
    if (quarter === 0) continue;
    for (let i = 0; i < 4; i++) {
      const index = face * 4 + i;
      let u = uv.getX(index) - 0.5;
      let v = uv.getY(index) - 0.5;
      for (let turn = 0; turn < quarter; turn++) {
        const nextU = -v;
        v = u;
        u = nextU;
      }
      uv.setXY(index, u + 0.5, v + 0.5);
    }
  }
  uv.needsUpdate = true;
}
