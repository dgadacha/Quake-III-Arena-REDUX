import * as THREE from 'three';
import type { SurfaceMetadata } from './SurfaceMetadata';
import type { LoadedTexture } from './TextureLibrary';
import type { HDMaterialMaps } from './HDMaterialLoader';
import type { LightGridTextures } from '../../bsp/LightGridTexture';
import { materialTuning, type MaterialTuning } from './MaterialTuning';
import { detailTexture, detailTiles } from './MicroDetail';
import { lavaSurface } from './LavaSurface';

/**
 * Materiaux du decor. Les textures et les scripts du jeu ne sont pas touches :
 * ils alimentent un materiau moderne qui sait repondre aux lumieres, projeter
 * du relief et nourrir le halo lumineux.
 *
 * Deux sources d'eclairage precalcule coexistent dans une carte : les lightmaps
 * pour les grandes surfaces, et une couleur par sommet pour le reste. La
 * seconde doit eclairer la surface, pas teinter sa couleur : c'est pourquoi
 * elle est injectee dans l'eclairage indirect plutot que multipliee a l'albedo.
 */

export interface WorldMaterialOptions {
  metadata: SurfaceMetadata;
  texture: LoadedTexture | null;
  glow: LoadedTexture | null;
  lightMap: THREE.Texture | null;
  lightMapIntensity: number;
  /** Surface eclairee par les couleurs de sommet de la carte. */
  vertexLit: boolean;
  vertexLightIntensity: number;
  normalScale: number;
  /**
   * Cartes HD produites par la chaine hors ligne. Absentes, la surface garde
   * exactement son materiau d'origine : c'est ce qui permet de convertir une
   * carte matiere par matiere.
   */
  hd?: HDMaterialMaps | null;
  /** Grille d'eclairage de la carte, pour le reflet directionnel. */
  grid?: LightGridTextures | null;
  /** Force du reflet tire de la grille. Zero le coupe. */
  gridSpecular?: number;
  /**
   * Force du micro-relief. Zero le coupe et rend la surface telle que ses
   * cartes la decrivent, ce qui est le point de comparaison.
   */
  microDetail: number;
}

/**
 * Une modification du programme du materiau. Plusieurs peuvent s'appliquer a
 * la meme surface : eclairage par sommet, ondulation d'un liquide, reflet tire
 * de la grille. Chacune porte sa cle, faute de quoi Three confondrait deux
 * programmes differents.
 */
interface ShaderPatch {
  key: string;
  apply: (shader: THREE.WebGLProgramParametersWithUniforms) => void;
}

function patchMaterial(material: THREE.Material, patches: ShaderPatch[]): void {
  if (patches.length === 0) return;
  material.onBeforeCompile = (shader) => {
    for (const patch of patches) patch.apply(shader);
  };
  material.customProgramCacheKey = () => patches.map((patch) => patch.key).join('|');
}

/*
 * Part metallique maximale d'une surface eclairee par lightmap.
 *
 * Un metal pur ne diffuse rien : il ne renvoie que ce qui l'entoure. Or
 * l'eclairage precalcule de la carte arrive par la diffusion, et lui seul sait
 * ou passe la lumiere dans une arene fermee. Sans environnement a refleter, un
 * metal franc donne donc un aplat noir, et il faut rester bas.
 *
 * Avec des sondes de reflet, l'environnement existe : le metal a quelque chose
 * a renvoyer, et la part metallique peut enfin s'approcher de ce qu'elle
 * devrait etre. C'est la que le rendu physique se voit.
 */
const MAX_METALNESS_WITHOUT_REFLECTIONS = 0.35;
const MAX_METALNESS_WITH_REFLECTIONS = 0.8;

/** Vrai quand des sondes de reflet alimentent la scene. */
let reflectionsReady = false;

/** Declare la presence de sondes de reflet : voir les deux plafonds ci-dessus. */
export function setReflections(ready: boolean): void {
  reflectionsReady = ready;
}

function metalnessCeiling(): number {
  return reflectionsReady ? MAX_METALNESS_WITH_REFLECTIONS : MAX_METALNESS_WITHOUT_REFLECTIONS;
}

/**
 * Force du reflet d'environnement, par nature de matiere. Une pierre seche
 * renvoie un voile, une plaque de metal renvoie la piece.
 */
const ENVIRONMENT_INTENSITY: Record<string, number> = {
  metal: 1,
  liquid: 1.1,
  glass: 1,
  emissive: 0.4,
  concrete: 0.25,
  stone: 0.22,
  wood: 0.3,
  organic: 0.2,
  fabric: 0.15,
  mixed: 0.4,
};

/*
 * Force du reflet tire de la grille. Un seul objet partage par tous les
 * materiaux : le reglage prend effet immediatement, sans recharger la carte.
 */
const gridSpecularUniform = { value: 1 };

/**
 * Plancher de la lightmap, partage par toutes les surfaces.
 *
 * Les lightmaps de Quake descendent tres bas dans les recoins. Multipliees par
 * une texture sombre, puis par l'occlusion, puis passees dans une courbe
 * filmique, elles ne laissent plus rien : la matiere disparait. Relever leur
 * plancher de quelques centiemes rend la pierre lisible sans eclaircir la
 * piece, parce que seules les valeurs les plus basses sont touchees.
 */
const lightmapLiftUniform = { value: 0 };

/** Change le plancher des lightmaps, pour toutes les surfaces. */
export function setLightmapLift(value: number): void {
  lightmapLiftUniform.value = Math.max(0, value);
}

/** Change la force des reflets de la grille, pour toutes les surfaces. */
export function setGridSpecular(value: number): void {
  gridSpecularUniform.value = Math.max(0, value);
}

/**
 * Lampes qui battent. Le script de la surface declare une onde ; le materiau
 * la garde ici, et l'avance avec le temps de la partie. Comme pour les
 * liquides, la liste est tenue par le materiau et non par la carte : un
 * materiau HD qui arrive apres le chargement s'y inscrit sans rien casser.
 */
const pulsedMaterials: {
  material: THREE.MeshStandardMaterial;
  strength: number;
  wave: { base: number; amplitude: number; phase: number; frequency: number };
}[] = [];

/** Avance le battement des lampes de la carte. */
export function updatePulses(time: number): void {
  for (const entry of pulsedMaterials) {
    const cycle = Math.sin((time * entry.wave.frequency + entry.wave.phase) * Math.PI * 2);
    entry.material.emissiveIntensity =
      Math.max(0, entry.wave.base + entry.wave.amplitude * cycle) * entry.strength;
  }
}

/** Surfaces liquides animees : leur ondulation avance avec ce compteur. */
const liquidMaterials: { material: THREE.MeshStandardMaterial; uniforms: Record<string, { value: number }> }[] = [];

/** Avance l'ondulation des liquides de la carte. */
export function updateLiquids(time: number): void {
  for (const entry of liquidMaterials) entry.uniforms.liquidTime.value = time;
}

export function clearLiquids(): void {
  liquidMaterials.length = 0;
  pulsedMaterials.length = 0;
}

export function createWorldMaterial(options: WorldMaterialOptions): THREE.MeshStandardMaterial {
  const { metadata, texture, hd } = options;

  const material = new THREE.MeshStandardMaterial({
    map: hd?.map ?? texture?.map ?? null,
    normalMap: hd?.normalMap ?? texture?.normalMap ?? null,
    roughnessMap: hd?.surfaceMap ?? texture?.roughnessMap ?? null,
    lightMap: options.lightMap,
    lightMapIntensity: options.lightMapIntensity,
    metalness: metadata.isReflective ? 0.35 : 0.05,
    roughness: metadata.isWater || metadata.isSlime ? 0.15 : 0.85,
    color: texture || hd ? 0xffffff : 0x8a8a8a,
    side: metadata.twoSided ? THREE.DoubleSide : THREE.FrontSide,
    transparent: false,
    depthWrite: true,
  });

  if (!hd && texture?.normalMap) {
    material.normalScale = new THREE.Vector2(options.normalScale, options.normalScale);
  }

  /*
   * Surface lumineuse. A defaut de materiau HD, l'emission est deduite : la
   * couche additive du script quand il y en a une, la texture sinon, et une
   * puissance logarithmique tiree de ce que le script declare.
   */
  if (metadata.isEmissive && !hd?.entry.emission) {
    const color = metadata.emissiveColor;
    material.emissive = color ? new THREE.Color(color[0], color[1], color[2]) : new THREE.Color(0xffffff);
    material.emissiveMap = options.glow?.map ?? texture?.map ?? null;
    material.emissiveIntensity = metadata.emissiveStrength;
  }

  if (hd) applyHDMaps(material, hd, options);

  if (metadata.alphaTest || texture?.hasAlpha) {
    material.alphaTest = 0.5;
  }
  if (metadata.isTransparent) {
    material.transparent = true;
    material.opacity = metadata.isWater || metadata.isSlime ? 0.82 : 0.75;
    material.depthWrite = false;
  }
  if (metadata.isAdditive) {
    material.transparent = true;
    material.blending = THREE.AdditiveBlending;
    material.depthWrite = false;
  }

  const patches: ShaderPatch[] = [];
  const tuning = hd && materialTuning(metadata.name);
  if (tuning) {
    material.roughness *= tuning.roughness;
    material.envMapIntensity = tuning.environment;
    material.metalness = Math.min(material.metalness, tuning.metalnessLimit);
    material.normalScale.multiplyScalar(tuning.normal);
    patches.push(albedoTuningPatch(tuning));
  }
  /*
   * Micro-relief : il demande une normale, puisque c'est elle qu'il incline,
   * et n'a rien a faire sur une vitre, une surface additive ou le ciel.
   */
  if (
    options.microDetail > 0
    && material.normalMap
    && material.map
    && !metadata.isSky
    && !metadata.isAdditive
    && !metadata.isTransparent
  ) {
    const source = hd?.entry.sourceSize?.[0] ?? (texture?.map.image?.width as number | undefined) ?? 128;
    patches.push(microDetailPatch(detailTiles(source), options.microDetail));
  }
  if (options.lightMap) patches.push(lightmapLiftPatch());
  if (options.vertexLit) patches.push(vertexLightPatch(options.vertexLightIntensity));
  if (metadata.isWater || metadata.isSlime) patches.push(liquidPatch(material, metadata.isSlime));
  /*
   * Lave. Elle a son propre traitement : ce n'est ni de l'eau, qui reflete,
   * ni une surface fixe, et tout son mouvement est deja decrit par son
   * script. L'emission declaree devient la chaleur de ses veines.
   */
  if (metadata.isLava && material.map) {
    const declared = hd?.entry.emission?.intensity ?? metadata.emissiveStrength ?? 1;
    const lava = lavaSurface(material, metadata, Math.max(0.6, declared));
    liquidMaterials.push({ material, uniforms: lava.uniforms });
    patches.push({ key: lava.key, apply: lava.apply });
  }
  /*
   * Reflet tire de la grille d'eclairage. Il n'est pose que sur les surfaces
   * opaques du decor : une vitre ou une surface additive n'a rien a y gagner,
   * et le ciel encore moins.
   */
  if (options.grid && !metadata.isSky && !metadata.isAdditive) {
    patches.push(gridSpecularPatch(options.grid, tuning?.specular ?? 1));
  }
  patchMaterial(material, patches);
  return material;
}

/**
 * Micro-relief.
 *
 * La texture agrandie n'a pas plus de detail a montrer que son original ; ce
 * qui manque de pres, c'est le grain. Une couche unique, repetee bien plus
 * souvent que la texture elle-meme, incline legerement la normale et module la
 * teinte. Elle s'efface seule avec la distance : ses niveaux de mipmap tendent
 * vers une surface plane, donc vers rien.
 */
function microDetailPatch(tiles: number, strength: number): ShaderPatch {
  return {
    // La source est la meme pour toutes les surfaces : une seule clef, donc un
    // seul programme, et la frequence passe par un uniforme.
    key: 'microDetail',
    apply(shader) {
      shader.uniforms.detailMap = { value: detailTexture() };
      shader.uniforms.detailTiles = { value: tiles };
      shader.uniforms.detailStrength = { value: strength };
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D detailMap;
          uniform float detailTiles;
          uniform float detailStrength;`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          #ifdef USE_NORMALMAP_TANGENTSPACE
            vec2 microSlope = texture2D(detailMap, vNormalMapUv * detailTiles).xy * 2.0 - 1.0;
            normal = normalize(normal + tbn * vec3(microSlope * detailStrength, 0.0));
          #endif`)
        .replace('#include <map_fragment>', `#include <map_fragment>
          float microGrain = texture2D(detailMap, vMapUv * detailTiles).z;
          diffuseColor.rgb *= 1.0 + (microGrain - 0.5) * detailStrength * 0.4;`);
    },
  };
}

function albedoTuningPatch(tuning: MaterialTuning): ShaderPatch {
  return {
    key: 'albedoTuning',
    apply(shader) {
      shader.uniforms.surfaceSaturation = { value: tuning.saturation };
      shader.uniforms.surfaceTint = { value: new THREE.Vector3(...tuning.tint) };
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float surfaceSaturation;
          uniform vec3 surfaceTint;`)
        .replace('#include <map_fragment>', `#include <map_fragment>
          float surfaceLuma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          diffuseColor.rgb = mix(vec3(surfaceLuma), diffuseColor.rgb, surfaceSaturation) * surfaceTint;`);
    },
  };
}

/**
 * Plancher de la lightmap.
 *
 * Le calcul de Three est repris tel quel, a une ligne pres : la couleur lue
 * dans la lightmap est melangee a un plancher avant d'etre ajoutee a
 * l'eclairage indirect. Reprendre le bloc entier est le seul moyen d'agir a
 * cet endroit precis de la chaine d'eclairage.
 */
function lightmapLiftPatch(): ShaderPatch {
  return {
    key: 'lightmapLift',
    apply: (shader) => {
      shader.uniforms.q3LightmapLift = lightmapLiftUniform;
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\n        uniform float q3LightmapLift;',
        )
        .replace(
          '#include <lights_fragment_maps>',
          `#if defined( RE_IndirectDiffuse )
            #ifdef USE_LIGHTMAP
              vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );
              vec3 lifted = max(lightMapTexel.rgb, vec3(q3LightmapLift));
              irradiance += lifted * lightMapIntensity;
            #endif
            // La lightmap contient deja la lumiere indirecte. La sonde fournit
            // les reflets, sans ajouter une deuxieme couche d'ambiance diffuse.
            #if !defined( USE_LIGHTMAP ) && defined( USE_ENVMAP ) && defined( STANDARD ) && defined( ENVMAP_TYPE_CUBE_UV )
              iblIrradiance += getIBLIrradiance( geometryNormal );
            #endif
          #endif
          #if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
            #ifdef USE_ANISOTROPY
              radiance += getIBLAnisotropyRadiance( geometryViewDir, geometryNormal, material.roughness, material.anisotropyB, material.anisotropy );
            #else
              radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );
            #endif
            #ifdef USE_CLEARCOAT
              clearcoatRadiance += getIBLRadiance( geometryViewDir, geometryClearcoatNormal, material.clearcoatRoughness );
            #endif
          #endif`,
        );
    },
  };
}

/**
 * Reflet directionnel tire de la grille d'eclairage.
 *
 * La lightmap de la carte dit combien de lumiere arrive en un point, jamais
 * d'ou elle vient ; la grille, elle, porte la direction mais seulement une
 * moyenne grossiere de l'intensite. On prend donc le meilleur des deux : la
 * direction vient de la grille, l'intensite de la lumiere precalculee qui
 * arrive vraiment sur ce pixel. Le reflet est ainsi vif au pied d'une lampe et
 * eteint dans un recoin, ce qu'aucune des deux sources ne sait faire seule.
 *
 * Seul le terme de reflet est ajoute : la diffusion reste celle de la carte,
 * donc rien n'est compte deux fois.
 *
 * C'est ce terme qui fait exister les materiaux : sans lui, une carte de
 * normales ne se voit pas et un metal reste un aplat.
 */
function gridSpecularPatch(grid: LightGridTextures, gain: number): ShaderPatch {
  return {
    key: 'grid',
    apply: (shader) => {
      shader.uniforms.gridLight = { value: grid.light };
      shader.uniforms.gridDirection = { value: grid.direction };
      shader.uniforms.gridMins = { value: grid.mins };
      shader.uniforms.gridSize = { value: grid.size };
      shader.uniforms.gridSpecular = gridSpecularUniform;
      shader.uniforms.surfaceSpecularGain = { value: gain };

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n        varying vec3 vGridPosition;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          // Echantillonner dans la piece, au-dessus de la surface, pour eviter
          // les cellules sans eclairage enfouies dans les murs et le sol.
          vGridPosition = (modelMatrix * vec4(position, 1.0)).xyz
            + normalize(mat3(modelMatrix) * normal) * 16.0;`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
        uniform sampler3D gridLight;
        uniform sampler3D gridDirection;
        uniform vec3 gridMins;
        uniform vec3 gridSize;
        uniform float gridSpecular;
        uniform float surfaceSpecularGain;
        varying vec3 vGridPosition;`,
        )
        .replace(
          '#include <lights_fragment_end>',
          `{
          vec3 cell = (vGridPosition - gridMins) / gridSize;
          if (all(greaterThanEqual(cell, vec3(0.0))) && all(lessThanEqual(cell, vec3(1.0)))) {
            vec3 gridColor = texture(gridLight, cell).rgb;
            vec3 worldDirection = texture(gridDirection, cell).rgb * 2.0 - 1.0;
            if (dot(worldDirection, worldDirection) > 0.01) {
              // Les lumieres du rendu sont exprimees dans le repere de la vue.
              vec3 towards = normalize((viewMatrix * vec4(normalize(worldDirection), 0.0)).xyz);
              float incidence = saturate(dot(geometryNormal, towards));
              /*
               * Intensite : la lumiere precalculee qui arrive sur ce pixel,
               * teintee par la couleur de la lampe dominante du lieu.
               */
              vec3 tint = gridColor / max(max(gridColor.r, max(gridColor.g, gridColor.b)), 0.001);
              vec3 energy = irradiance * mix(vec3(1.0), tint, 0.6);
              reflectedLight.directSpecular += energy * gridSpecular * surfaceSpecularGain * incidence
                * BRDF_GGX(towards, geometryViewDir, geometryNormal, material);
            }
          }
        }
        #include <lights_fragment_end>`,
        );
    },
  };
}

/**
 * Pose les cartes HD sur le materiau.
 *
 * La rugosite et la part metallique viennent du fichier, l'occlusion suit les
 * coordonnees de la texture et non celles de la lightmap, et le relief garde la
 * force decidee par la matiere. La part metallique, elle, est plafonnee : voir
 * la constante plus haut.
 */
function applyHDMaps(
  material: THREE.MeshStandardMaterial,
  hd: HDMaterialMaps,
  options: WorldMaterialOptions,
): void {
  if (hd.normalMap) {
    // La chaine calcule les pentes par texel. Sans compensation, une carte
    // 2048 produit huit fois moins de relief que la meme structure en 256.
    const size = hd.normalMap.image as { width: number; height: number };
    material.normalScale = new THREE.Vector2(
      hd.normalStrength * size.width / 256,
      hd.normalStrength * size.height / 256,
    );
  }
  if (hd.surfaceMap) {
    /*
     * Une seule texture porte les trois proprietes de surface, un canal
     * chacune : Three lit le rouge en occlusion, le vert en rugosite et le
     * bleu en metal. C'est la convention des materiaux de glTF, et elle evite
     * trois televersements RGBA pour trois images a un seul canal.
     */
    material.roughnessMap = hd.surfaceMap;
    material.metalnessMap = hd.surfaceMap;
    material.aoMap = hd.surfaceMap;
    material.aoMapIntensity = 0.7;
    // La carte multiplie cette valeur : c'est elle qui porte la variation.
    material.roughness = hd.roughnessMultiplier;
  }
  const ceiling = metalnessCeiling();
  if (hd.metalness < 0) {
    // Moins un : la part metallique est dans le canal bleu, pas constante.
    material.metalness = options.lightMap ? ceiling : 1;
  } else {
    material.metalness = options.lightMap ? Math.min(hd.metalness, ceiling) : hd.metalness;
  }
  // Force du reflet : elle vient de la matiere declaree par la chaine.
  material.envMapIntensity = ENVIRONMENT_INTENSITY[hd.entry.type] ?? 0.35;
  /*
   * Emission. Ce n'est plus une devinette tiree du nom de la texture : le
   * script du jeu dit quelle couche est lumineuse, avec quelle puissance elle
   * a servi a cuire les lightmaps, et de quelle couleur est son verre. La
   * puissance declaree ne dit pas combien la surface doit briller a l'ecran,
   * puisque son eclairage est deja dans la carte : elle sert a la faire
   * exister comme source, et a nourrir le halo.
   */
  const emission = hd.entry.emission;
  if (hd.emissiveMap) material.emissiveMap = hd.emissiveMap;
  if (emission) {
    material.emissive = new THREE.Color(...emission.color);
    material.emissiveIntensity = emission.intensity;
    if (!material.emissiveMap) material.emissiveMap = hd.map;
    /*
     * Battement declare par le script : les flammes battent a dix hertz, les
     * tremplins a un hertz et demi. C'est ce qui donne vie a une salle
     * immobile.
     */
    if (emission.wave && emission.intensity > 0) {
      pulsedMaterials.push({ material, strength: emission.intensity, wave: emission.wave });
    }
  }
}

/**
 * Eau et slime. La texture d'origine reste la couleur de la surface ; ce qui
 * est ajoute, c'est le mouvement et la facon dont elle repond a la lumiere :
 * la normale est perturbee par deux trains d'ondes croises, et la surface
 * devient plus reflechissante quand le regard la rase, comme un vrai liquide.
 */
function liquidPatch(material: THREE.MeshStandardMaterial, slime: boolean): ShaderPatch {
  material.roughness = slime ? 0.35 : 0.08;
  material.metalness = slime ? 0.2 : 0.4;
  material.envMapIntensity = slime ? 0.5 : 1.1;

  const uniforms: Record<string, { value: number }> = {
    liquidTime: { value: 0 },
    liquidAmplitude: { value: slime ? 0.1 : 0.16 },
  };

  const apply = (shader: THREE.WebGLProgramParametersWithUniforms) => {
    shader.uniforms.liquidTime = uniforms.liquidTime;
    shader.uniforms.liquidAmplitude = uniforms.liquidAmplitude;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n        varying vec3 vLiquidPosition;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n        vLiquidPosition = (modelMatrix * vec4(position, 1.0)).xyz;',
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float liquidTime;
        uniform float liquidAmplitude;
        varying vec3 vLiquidPosition;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        // Deux trains d'ondes croises, d'echelles differentes : le motif ne se
        // repete pas a l'oeil et ne demande aucune texture supplementaire.
        float waveA = sin(vLiquidPosition.x * 0.06 + liquidTime * 1.7)
          + sin(vLiquidPosition.y * 0.045 - liquidTime * 1.1);
        float waveB = sin((vLiquidPosition.x + vLiquidPosition.y) * 0.021 + liquidTime * 0.7);
        vec3 ripple = vec3(waveA, waveB, 0.0) * liquidAmplitude;
        normal = normalize(normal + ripple);`,
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
        // Un liquide vu de biais reflete plus qu'il ne laisse voir le fond.
        float grazing = 1.0 - abs(dot(normalize(vViewPosition), normal));
        gl_FragColor.a = clamp(gl_FragColor.a + pow(grazing, 3.0) * 0.35, 0.0, 1.0);`,
      );
  };

  liquidMaterials.push({ material, uniforms });
  return { key: slime ? 'liquid:slime' : 'liquid:water', apply };
}

/**
 * Ajoute la couleur de sommet a l'eclairage indirect recu par la surface. Sans
 * cela, une surface sans lightmap reste noire tant qu'aucune lampe ne l'atteint,
 * alors que la carte porte deja son eclairage dans ses sommets.
 */
export function applyVertexLighting(material: THREE.Material, intensity: number): void {
  patchMaterial(material, [vertexLightPatch(intensity)]);
}

function vertexLightPatch(intensity: number): ShaderPatch {
  const apply = (shader: THREE.WebGLProgramParametersWithUniforms) => {
    shader.uniforms.vertexLightIntensity = { value: intensity };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec3 vertexLight;
        varying vec3 vVertexLight;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vVertexLight = vertexLight;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float vertexLightIntensity;
        varying vec3 vVertexLight;`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `irradiance += vVertexLight * vertexLightIntensity;
        #include <lights_fragment_end>`,
      );
  };
  // Deux materiaux dont le programme differe ne doivent pas etre confondus.
  return { key: `vertexLit:${intensity.toFixed(3)}`, apply };
}
