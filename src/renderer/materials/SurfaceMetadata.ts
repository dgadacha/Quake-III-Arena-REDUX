import { Contents, Surface } from '../../formats/bsp';
import type { ShaderSummary } from '../../formats/shader';

/**
 * Lecture moderne d'une surface de carte. Rien n'est ecrit dans les fichiers du
 * jeu : on lit le script d'origine et les indicateurs poses par le compilateur
 * de cartes, et on en deduit en memoire ce que le rendu doit en faire.
 */
export interface SurfaceMetadata {
  name: string;
  isSky: boolean;
  isWater: boolean;
  isLava: boolean;
  isSlime: boolean;
  isFog: boolean;
  /** Surface qui emet de la lumiere : elle alimente le halo lumineux. */
  isEmissive: boolean;
  emissiveStrength: number;
  emissiveColor: [number, number, number] | null;
  isTransparent: boolean;
  isAdditive: boolean;
  isReflective: boolean;
  receivesAO: boolean;
  receivesDynamicLight: boolean;
  twoSided: boolean;
  alphaTest: boolean;
  /** Surface glissante : le deplacement le sait deja, le rendu aussi. */
  slick: boolean;
  scroll: [number, number] | null;
  wavy: boolean;
}

/** Noms de textures qui designent une surface lumineuse sans le declarer. */
const LIGHT_HINTS = ['light', 'lamp', 'glow', 'flame', 'fire', 'torch', 'lava', 'plasma', 'energy'];

export function classifySurface(
  name: string,
  summary: ShaderSummary | null | undefined,
  surfaceFlags: number,
  contents: number,
): SurfaceMetadata {
  const lower = name.toLowerCase();
  const sky = (surfaceFlags & Surface.SKY) !== 0 || Boolean(summary?.sky);
  const water = (contents & Contents.WATER) !== 0 || lower.includes('water');
  const lava = (contents & Contents.LAVA) !== 0 || lower.includes('lava');
  const slime = (contents & Contents.SLIME) !== 0 || lower.includes('slime');
  const fog = (contents & Contents.FOG) !== 0 || Boolean(summary?.fog);

  // Une surface annoncee lumineuse au compilateur l'est vraiment ; sinon, une
  // couche additive ou un nom parlant donnent une bonne indication.
  const declared = summary?.surfaceLight ?? 0;
  const hinted = LIGHT_HINTS.some((hint) => lower.includes(hint));
  const additive = Boolean(summary?.additive);
  const isEmissive = declared > 0 || lava || (additive && hinted) || (hinted && !summary?.lightmapped);

  /**
   * La puissance declaree au compilateur de cartes a servi a cuire les
   * lightmaps : l'eclairage qu'elle produit est deja dans la carte. Elle ne dit
   * donc pas combien la surface doit briller, seulement qu'elle brille. On ne
   * pousse la surface qu'un peu au-dessus du blanc, de quoi nourrir le halo
   * sans repeindre la piece : une echelle logarithmique garde les grosses
   * lampes a peine plus fortes que les petites.
   */
  let emissiveStrength = 0;
  if (declared > 0) {
    emissiveStrength = Math.min(0.9, 0.15 + Math.log10(Math.max(10, declared)) / 8);
  } else if (lava) {
    emissiveStrength = 0.7;
  } else if (isEmissive) {
    emissiveStrength = additive ? 0.45 : 0.25;
  }

  return {
    name: lower,
    isSky: sky,
    isWater: water,
    isLava: lava,
    isSlime: slime,
    isFog: fog,
    isEmissive,
    emissiveStrength,
    emissiveColor: summary?.lightColor ?? null,
    isTransparent: Boolean(summary?.translucent) || water || slime,
    isAdditive: additive,
    isReflective: water || slime || lower.includes('metal') || lower.includes('shiny'),
    receivesAO: !sky && !isEmissive,
    receivesDynamicLight: !sky,
    twoSided: Boolean(summary?.twoSided),
    alphaTest: Boolean(summary?.alphaTest),
    slick: (surfaceFlags & Surface.SLICK) !== 0,
    scroll: summary?.scroll ?? null,
    wavy: Boolean(summary?.wavy),
  };
}
