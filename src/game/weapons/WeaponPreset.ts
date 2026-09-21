import type { WeaponId } from './WeaponDefs';

/**
 * Reglage d'affichage d'une arme tenue en main. Chaque modele a sa propre
 * silhouette : un lance-roquettes tenu comme une mitrailleuse parait enorme,
 * une mitrailleuse tenue comme un gantelet disparait. Plutot que des valeurs
 * eparpillees dans le code, chaque arme decrit ici sa place, son geste et la
 * part d'ecran qu'elle a le droit de prendre.
 *
 * Les distances ne sont pas en unites de carte mais en part de l'image : la
 * meme valeur donne la meme composition a tous les champs de vision et sur
 * toutes les resolutions.
 */

/*
 * Les tailles visees viennent de la reference : l'arme est un element majeur de
 * l'image, pas un detail dans un coin. La mitrailleuse couvre pres de soixante
 * pour cent de la largeur, son corps entier est lisible, et sa crosse sort du
 * cadre par le bas et par la droite, puisque les mains ne sont pas dessinees :
 * une arme qui s'arrete au milieu de l'ecran flotte.
 */
export interface WeaponViewmodelPreset {
  /** Ecart lateral, en part de la demi-largeur visible. */
  offsetX: number;
  /** Ecart vertical, en part de la demi-hauteur visible. */
  offsetY: number;
  /** Prise en main, en degres, dans l'ordre tangage, lacet, roulis. */
  rotation: [number, number, number];
  /**
   * Part de la largeur de l'image occupee par la silhouette de l'arme. C'est
   * cette mesure qui fixe la taille, jamais l'echelle du fichier : un modele
   * exporte deux fois plus grand donne la meme image. Elle porte sur les
   * sommets projetes, pas sur la boite englobante, qui deborde largement de ce
   * qu'on voit des qu'un objet est proche et en diagonale.
   */
  occupancy: number;
  /** Champ de vision propre a l'arme, en degres. */
  fov: number;
  /** Multiplicateurs de mouvement : une arme lourde bouge plus lentement. */
  bob: number;
  sway: number;
  recoil: number;
  /**
   * Vitesse du retour apres le coup. Au-dessus de un, l'arme repart vite ;
   * en dessous, elle revient lentement, comme un fusil a pompe.
   */
  recoilSpeed: number;
}

/**
 * Champ de vision de reference de l'arme. Plus etroit que celui du monde, il
 * donne une arme massive et peu deformee : c'est la condition pour qu'un modele
 * occupe le tiers de l'image sans se tordre aux bords.
 */
export const REFERENCE_WEAPON_FOV = 65;

/*
 * Prise en main : tangage, lacet, roulis, en degres.
 *
 * Le lacet est volontairement faible. Trop tourne, le modele ne montre plus
 * que son flanc, a plat, et l'arme parait posee de profil devant l'oeil ;
 * quelques degres suffisent a faire converger le canon vers le viseur tout en
 * gardant la vue de trois quarts par l'arriere, ou l'on voit a la fois le
 * dessus du mecanisme et le corps.
 *
 * Le tangage releve legerement le canon, comme une arme portee a la hanche.
 *
 * Le signe est celui du repere de la vue, ou la camera regarde vers les z
 * negatifs : un lacet positif ramene le canon vers le centre de l'image. Tenue
 * a gauche, l'arme reprend ces angles en miroir.
 */
const HAND: [number, number, number] = [2, 6, -1.5];

export const WEAPON_PRESETS: Record<WeaponId, WeaponViewmodelPreset> = {
  // Le gantelet se porte pres du centre : il n'a pas de canon a montrer.
  gauntlet: {
    offsetX: 0.34,
    offsetY: -0.65,
    rotation: [3, 9, -1.5],
    occupancy: 0.44,
    fov: REFERENCE_WEAPON_FOV,
    bob: 1.1,
    sway: 1,
    recoil: 0.6,
    recoilSpeed: 1.3,
  },
  machinegun: {
    offsetX: 0.36,
    offsetY: -0.63,
    rotation: HAND,
    occupancy: 0.58,
    fov: REFERENCE_WEAPON_FOV,
    bob: 1,
    sway: 1,
    recoil: 1,
    recoilSpeed: 1.0,
  },
  shotgun: {
    offsetX: 0.36,
    offsetY: -0.63,
    rotation: HAND,
    occupancy: 0.6,
    fov: REFERENCE_WEAPON_FOV,
    bob: 0.95,
    sway: 0.95,
    recoil: 1.5,
    recoilSpeed: 0.7,
  },
  grenade: {
    offsetX: 0.36,
    offsetY: -0.63,
    rotation: HAND,
    occupancy: 0.58,
    fov: REFERENCE_WEAPON_FOV,
    bob: 0.95,
    sway: 0.95,
    recoil: 1.1,
    recoilSpeed: 0.9,
  },
  rocket: {
    offsetX: 0.36,
    offsetY: -0.59,
    rotation: [2, 5, -1.5],
    occupancy: 0.66,
    fov: REFERENCE_WEAPON_FOV,
    bob: 0.85,
    sway: 0.8,
    recoil: 1.6,
    recoilSpeed: 0.75,
  },
  lightning: {
    offsetX: 0.36,
    offsetY: -0.61,
    rotation: HAND,
    occupancy: 0.6,
    fov: REFERENCE_WEAPON_FOV,
    bob: 0.9,
    sway: 0.9,
    recoil: 0.4,
    recoilSpeed: 1.4,
  },
  railgun: {
    offsetX: 0.36,
    offsetY: -0.61,
    rotation: [2, 5, -1.5],
    occupancy: 0.6,
    fov: REFERENCE_WEAPON_FOV,
    bob: 0.85,
    sway: 0.8,
    recoil: 1.4,
    recoilSpeed: 0.8,
  },
  plasma: {
    offsetX: 0.36,
    offsetY: -0.63,
    rotation: HAND,
    occupancy: 0.58,
    fov: REFERENCE_WEAPON_FOV,
    bob: 0.95,
    sway: 0.95,
    recoil: 0.7,
    recoilSpeed: 1.2,
  },
  bfg: {
    offsetX: 0.36,
    offsetY: -0.57,
    rotation: [2, 5, -1.5],
    occupancy: 0.7,
    fov: REFERENCE_WEAPON_FOV,
    bob: 0.8,
    sway: 0.75,
    recoil: 1.8,
    recoilSpeed: 0.6,
  },
};

export function weaponPreset(id: WeaponId): WeaponViewmodelPreset {
  return WEAPON_PRESETS[id] ?? WEAPON_PRESETS.machinegun;
}
