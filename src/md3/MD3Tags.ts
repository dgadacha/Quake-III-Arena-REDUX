import * as THREE from 'three';
import type { Md3Model, Md3Tag } from '../formats/md3';

/**
 * Reperes d'assemblage. Chaque image donne, pour chaque repere, une position et
 * trois vecteurs de base. Entre deux images, la position s'interpole
 * lineairement et l'orientation par quaternion : interpoler les neuf nombres de
 * la base produirait des deformations en cours de rotation.
 */

const quaternionA = new THREE.Quaternion();
const quaternionB = new THREE.Quaternion();
const basis = new THREE.Matrix4();

function tagQuaternion(tag: Md3Tag, out: THREE.Quaternion): THREE.Quaternion {
  const a = tag.axis;
  // Les trois vecteurs sont ranges en avant, gauche, haut.
  basis.set(a[0], a[3], a[6], 0, a[1], a[4], a[7], 0, a[2], a[5], a[8], 0, 0, 0, 0, 1);
  return out.setFromRotationMatrix(basis);
}

/** Place la matrice du repere demande, interpole entre deux images. */
export function interpolateTag(
  model: Md3Model,
  name: string,
  frameA: number,
  frameB: number,
  mix: number,
  out: THREE.Matrix4,
): boolean {
  const a = model.tag(frameA, name);
  const b = model.tag(frameB, name);
  if (!a) return false;

  const position = new THREE.Vector3(a.origin[0], a.origin[1], a.origin[2]);
  tagQuaternion(a, quaternionA);

  if (b && mix > 0) {
    position.lerp(new THREE.Vector3(b.origin[0], b.origin[1], b.origin[2]), mix);
    tagQuaternion(b, quaternionB);
    quaternionA.slerp(quaternionB, mix);
  }

  out.compose(position, quaternionA, ONE);
  return true;
}

const ONE = new THREE.Vector3(1, 1, 1);
