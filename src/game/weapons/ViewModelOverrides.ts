import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { WeaponId } from './WeaponDefs';

/**
 * Modeles de remplacement pour l'arme tenue en main. Les modeles d'origine
 * restent lus et affiches par defaut ; une entree de cette table prend le
 * dessus quand le fichier est present.
 *
 * Un modele exporte d'un outil moderne n'a ni l'echelle, ni l'orientation, ni
 * le centre des modeles du jeu. Plutot que de coder des valeurs a la main pour
 * chaque fichier, on mesure ses bornes : le plus grand cote donne l'axe du
 * canon, la taille donne l'echelle, et le centre sert de point d'accroche. Les
 * ajustements de la table ne servent qu'a corriger ce que la mesure ne peut pas
 * deviner, comme un modele tourne de bout en bout.
 */

export interface ViewModelOverride {
  /** Chemin servi par le serveur de developpement. */
  path: string;
  /**
   * Part de la largeur de l'ecran que l'arme doit occuper. Dimensionner par
   * l'occupation plutot que par une longueur en unites rend le reglage
   * independant de l'echelle du fichier : un modele exporte deux fois plus
   * grand donnera la meme image.
   */
  occupancy?: number;
  /** Demi-tour a appliquer quand le canon regarde vers l'arriere. */
  flip?: boolean;
  /**
   * Axe vertical du fichier. Les fichiers glTF utilisent y par convention,
   * mais certains exports sortent en z : ce reglage evite une arme couchee.
   */
  up?: 'y' | 'z';
  /**
   * Reglage fin de la prise en main, en degres, dans l'ordre tangage, lacet,
   * roulis. Il reste tres faible : le modele est deja redresse et oriente par
   * la mesure, ceci n'est que le geste.
   */
  rotation?: [number, number, number];
  /** Decalage supplementaire, en unites de carte. */
  offset?: [number, number, number];

}

export const VIEW_MODEL_OVERRIDES: Partial<Record<WeaponId, ViewModelOverride>> = {
  // La place, la prise en main et la taille viennent du reglage de l'arme :
  // cette table ne sert qu'a designer le fichier et a corriger ce que la
  // mesure ne peut pas deviner.
  machinegun: { path: '/models/machine_gun.glb' },
};

const loader = new GLTFLoader();

/**
 * Charge un modele de remplacement et le ramene dans le repere de l'arme :
 * canon vers l'avant de la vue, taille comparable a celle d'un modele du jeu,
 * point d'accroche au centre.
 */
export async function loadOverride(override: ViewModelOverride): Promise<THREE.Object3D | null> {
  try {
    const gltf = await loader.loadAsync(override.path);
    const model = gltf.scene;

    // Bornes du modele tel qu'il a ete exporte.
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    if (size.length() < 1e-6) return null;

    // Le plus grand cote est l'axe du canon.
    const longest = Math.max(size.x, size.y, size.z);
    const axis = longest === size.x ? 'x' : longest === size.y ? 'y' : 'z';
    // Reste a savoir de quel cote il pointe : c'est le bout le plus fin.
    const barrelTowardsPositive = findBarrelSide(model, axis, center);

    const holder = new THREE.Group();
    holder.name = 'viewmodel-override';

    // Recentrage : le modele tourne autour de son propre centre, pas de son origine.
    model.position.sub(center);

    // Le modele est ramene a une longueur de reference d'une unite : la taille
    // reelle a l'ecran est ensuite fixee par le porte-arme, qui connait le
    // champ de vision et la distance.
    model.scale.setScalar(1 / longest);

    /*
     * Orientation. Plutot que d'empiler des rotations, on construit la base du
     * modele puis on la ramene sur celle du jeu : avant sur x, gauche sur y,
     * haut sur z. Trois informations suffisent : l'axe du canon, son sens, et
     * l'axe vertical du fichier, que les formats modernes placent en y.
     */
    const forward = new THREE.Vector3();
    forward[axis] = barrelTowardsPositive === false || override.flip ? -1 : 1;

    const up = new THREE.Vector3();
    const upAxis = override.up ?? 'y';
    // Si le canon occupe deja l'axe vertical declare, on prend l'autre.
    up[upAxis === axis ? (axis === 'y' ? 'z' : 'y') : upAxis] = 1;

    const left = new THREE.Vector3().crossVectors(up, forward).normalize();
    up.crossVectors(forward, left).normalize();

    const pivot = new THREE.Group();
    // La transposee envoie la base du modele sur celle du jeu, et non l'inverse.
    pivot.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(forward, left, up).transpose(),
    );

    pivot.add(model);
    holder.add(pivot);



    // Les modeles exportes arrivent souvent sans reglage d'ombre.
    holder.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
    });

    return holder;
  } catch (error) {
    console.warn(`${override.path} illisible :`, error);
    return null;
  }
}

/**
 * Determine de quel cote pointe le canon. Le modele est coupe en deux moitiees
 * le long de son axe le plus long, et on compare l'epaisseur moyenne de chaque
 * moitiee autour de cet axe : la crosse et la poignee sont massives, le canon
 * est fin. Le bout le plus fin est donc l'avant.
 *
 * Rend vrai si le canon pointe deja vers les valeurs positives de l'axe, faux
 * s'il faut retourner le modele, et rien si la mesure n'est pas concluante.
 */
function findBarrelSide(
  model: THREE.Object3D,
  axis: 'x' | 'y' | 'z',
  center: THREE.Vector3,
): boolean | undefined {
  const others: ('x' | 'y' | 'z')[] = (['x', 'y', 'z'] as const).filter((name) => name !== axis);
  let positiveSum = 0;
  let positiveCount = 0;
  let negativeSum = 0;
  let negativeCount = 0;

  const point = new THREE.Vector3();
  model.updateWorldMatrix(true, true);

  model.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const positions = mesh.geometry.getAttribute('position');
    if (!positions) return;

    // Un echantillon suffit : quelques milliers de points donnent la meme
    // reponse que des centaines de milliers, pour une fraction du temps.
    const step = Math.max(1, Math.floor(positions.count / 4000));
    for (let i = 0; i < positions.count; i += step) {
      point.fromBufferAttribute(positions as THREE.BufferAttribute, i);
      point.applyMatrix4(mesh.matrixWorld);
      const along = point[axis] - center[axis];
      // Distance a l'axe : c'est elle qui dit si le bout est massif ou fin.
      const thickness = Math.hypot(point[others[0]] - center[others[0]], point[others[1]] - center[others[1]]);
      if (along >= 0) {
        positiveSum += thickness;
        positiveCount++;
      } else {
        negativeSum += thickness;
        negativeCount++;
      }
    }
  });

  if (positiveCount === 0 || negativeCount === 0) return undefined;
  const positiveThickness = positiveSum / positiveCount;
  const negativeThickness = negativeSum / negativeCount;
  // Ecart trop faible pour conclure : on ne touche a rien.
  if (Math.abs(positiveThickness - negativeThickness) < Math.max(positiveThickness, negativeThickness) * 0.05) {
    return undefined;
  }
  return positiveThickness < negativeThickness;
}
