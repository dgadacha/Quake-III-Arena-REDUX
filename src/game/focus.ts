/**
 * Carte de la demonstration technique.
 *
 * Le portage ne cherche pas a couvrir les trente cartes du jeu : il cherche a
 * prouver une direction artistique sur une seule, entierement. Tout le reste du
 * catalogue est donc ecarte, de sorte que le travail de materiaux, d'eclairage
 * et de reglages porte sur un terrain unique et comparable d'une version a
 * l'autre.
 */
export const FOCUS_MAP = 'q3dm7';

/**
 * Vue du menu : le decor rendu derriere les entrees.
 *
 * Le point est choisi pour ce qu'il montre une fois l'image assombrie : une
 * nappe de lave qui eclaire par le bas, un mur de cranes, une arche. Presque
 * noir au repos, quelques lueurs chaudes, et c'est le lien immediat entre le
 * menu et ce que la demonstration montre ensuite.
 */
export const FOCUS_MENU_VIEW = {
  origin: [587, -666, -330] as [number, number, number],
  yaw: (190 * Math.PI) / 180,
  pitch: (2 * Math.PI) / 180,
};

/** Une carte fait-elle partie de la demonstration ? */
export function isFocusMap(name: string): boolean {
  return name.toLowerCase() === FOCUS_MAP;
}
