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

/** Une carte fait-elle partie de la demonstration ? */
export function isFocusMap(name: string): boolean {
  return name.toLowerCase() === FOCUS_MAP;
}
