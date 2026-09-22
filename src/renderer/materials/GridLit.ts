import * as THREE from 'three';

/**
 * Eclairage d'un objet mobile par la grille de la carte.
 *
 * Les surfaces du decor portent leur lumiere cuite dans leurs lightmaps ; un
 * corps qui se deplace, lui, n'a rien. Le jeu regle cela avec la grille
 * d'eclairage : une cellule tous les soixante-quatre par soixante-quatre par
 * cent vingt-huit, qui donne pour chaque endroit une lumiere ambiante, une
 * lumiere dominante et la direction d'ou elle vient. C'est ce qui fait qu'un
 * joueur s'assombrit en entrant dans un couloir et prend la teinte orange
 * d'une salle de lave.
 *
 * L'echantillon est pris une fois par image et par objet, sur le processeur,
 * et pose dans trois uniformes : inutile de lire la grille par pixel pour un
 * corps de cinquante unites de haut.
 */

export interface GridLightUniforms {
  ambient: { value: THREE.Color };
  directed: { value: THREE.Color };
  /** Direction du monde d'ou vient la lumiere, normalisee. */
  direction: { value: THREE.Vector3 };
}

export function createGridLight(): GridLightUniforms {
  return {
    ambient: { value: new THREE.Color(0, 0, 0) },
    directed: { value: new THREE.Color(0, 0, 0) },
    direction: { value: new THREE.Vector3(0, 0, 1) },
  };
}

/**
 * Ajoute cet eclairage a un materiau, en gardant ce qu'il faisait deja : les
 * modeles animes ont leur propre greffon, qui melange deux poses, et le
 * remplacer effacerait l'animation.
 */
export function applyGridLight(material: THREE.Material, light: GridLightUniforms): void {
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;

  material.onBeforeCompile = (shader, renderer) => {
    previousCompile?.call(material, shader, renderer);

    shader.uniforms.gridAmbient = light.ambient;
    shader.uniforms.gridDirected = light.directed;
    shader.uniforms.gridDirection = light.direction;

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 gridAmbient;
        uniform vec3 gridDirected;
        uniform vec3 gridDirection;`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `{
          /*
           * Ambiante plus dominante, ponderee par l'incidence : c'est le
           * modele du jeu, et il suffit pour un corps. Les lumieres du rendu
           * sont exprimees dans le repere de la vue, la direction du monde y
           * est donc ramenee.
           */
          irradiance += gridAmbient;
          vec3 gridTowards = normalize((viewMatrix * vec4(gridDirection, 0.0)).xyz);
          irradiance += gridDirected * saturate(dot(geometryNormal, gridTowards));
        }
        #include <lights_fragment_end>`,
      );
  };

  material.customProgramCacheKey = () => `${previousKey?.call(material) ?? ''}|gridLit`;
  material.needsUpdate = true;
}

/**
 * Reporte un echantillon de la grille dans les uniformes.
 *
 * Les gains ramenent les valeurs de la grille, qui sont des octets, a des
 * niveaux comparables a ceux du decor : sans eux un corps reste une silhouette
 * noire dans une piece eclairee.
 */
export function setGridLight(
  light: GridLightUniforms,
  sample: { ambient: THREE.Color; directional: THREE.Color; direction: THREE.Vector3 },
  ambientGain = 2.1,
  directedGain = 2.6,
): void {
  light.ambient.value.copy(sample.ambient).multiplyScalar(ambientGain);
  light.directed.value.copy(sample.directional).multiplyScalar(directedGain);
  if (sample.direction.lengthSq() > 1e-6) {
    light.direction.value.copy(sample.direction).normalize();
  }
}
