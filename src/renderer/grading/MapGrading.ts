/**
 * Etalonnage par carte.
 *
 * Deux cartes de Quake n'ont pas la meme intention : un temple gothique eclaire
 * a la torche sous un ciel rouge ne se regarde pas comme une station spatiale
 * en metal froid. Les lightmaps portent bien cette intention, mais la courbe de
 * rendu, elle, est la meme partout : le resultat se ressemble d'une carte a
 * l'autre, et ce qui faisait l'ambiance se perd.
 *
 * Ce fichier ne contient donc que des intentions, une par carte. Elles ne
 * remplacent pas les reglages du joueur : elles s'y combinent, les
 * multiplicateurs se multipliant et les decalages s'ajoutant. Un joueur qui
 * baisse l'exposition la baisse partout, et la carte garde son caractere.
 *
 * Rien n'est invente : la teinte vient du ciel et des lampes de la carte, le
 * contraste de la difference entre ses zones eclairees et ses recoins.
 */

export interface MapGrade {
  /** Multiplicateur d'exposition. */
  exposure: number;
  /** Multiplicateur du point blanc : plus bas, les hautes lumieres saturent plus tot. */
  whitePoint: number;
  contrast: number;
  saturation: number;
  /** Ajouts : chauffe ou refroidit, et decale la teinte. */
  temperature: number;
  tint: number;
  /** Eclaircissement. Jamais negatif : voir la passe de rendu. */
  brightness: number;
  /**
   * Relevement du point noir. Quelques millièmes suffisent : le but est qu'un
   * mur dans l'ombre reste un mur de pierre sombre, et non une surface noire.
   */
  shadowLift: number;
  /**
   * Brouillard d'ambiance propre a la carte. Il n'est pose que sur les cartes
   * qui le declarent ici, et jamais sur une carte qui a deja le sien.
   */
  fog?: { color: string; density: number };
}

export const NEUTRAL_GRADE: MapGrade = {
  exposure: 1,
  whitePoint: 1,
  contrast: 1,
  saturation: 1,
  temperature: 0,
  tint: 0,
  brightness: 0,
  shadowLift: 0,
};

const GRADES: Record<string, MapGrade> = {
  /*
   * q3dm7, le temple. Ciel rouge, torches, lave : l'image doit etre chaude et
   * sombre, avec des hautes lumieres qui saturent tot pour que les flammes et
   * les croix de fer brillent vraiment. Le brouillard est tres faible : juste
   * de quoi eloigner le fond des grandes salles.
   */
  q3dm7: {
    exposure: 1,
    whitePoint: 0.92,
    // Contraste neutre : il doit venir de l'eclairage et des materiaux, pas
    // d'un filtre pose sur toute l'image.
    contrast: 1,
    saturation: 0.96,
    // Chaude, mais pas au point de repeindre chaque surface en orange : la
    // lumiere des lanternes doit trancher sur des matieres plus neutres.
    temperature: 0.1,
    tint: -0.02,
    brightness: 0,
    shadowLift: 0,
    fog: { color: '#1a0d0a', density: 0.00012 },
  },

  /*
   * q3dm17, la cour suspendue. Ciel noir, metal froid : l'image reste neutre,
   * a peine refroidie, et le contraste vient du vide autour des plateformes.
   */
  q3dm17: {
    exposure: 1.02,
    whitePoint: 0.95,
    contrast: 1,
    saturation: 0.97,
    temperature: -0.06,
    tint: 0.02,
    brightness: 0,
    shadowLift: 0,
  },
};

/** Intention de la carte demandee, ou rien de particulier. */
export function gradeFor(name: string): MapGrade {
  return GRADES[name.toLowerCase()] ?? NEUTRAL_GRADE;
}

/** Cartes qui ont une intention declaree. */
export function gradedMaps(): string[] {
  return Object.keys(GRADES);
}
