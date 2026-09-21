/**
 * Scripts .shader : ils decrivent comment dessiner chaque surface, en couches
 * successives. On en retient ce qui change le rendu d'ensemble : l'image de
 * base, la transparence, le ciel, les surfaces a ne pas dessiner et les
 * deplacements de coordonnees.
 */

export interface ShaderStage {
  /** Image de la couche, ou $lightmap pour l'eclairage precalcule. */
  map: string;
  /** Suite d'images jouees en boucle, avec sa cadence. */
  animMaps: string[];
  animFrequency: number;
  blendSource: string;
  blendDest: string;
  alphaFunc: string;
  rgbGen: string;
  /**
   * Onde appliquee a la couleur de la couche : base, amplitude, phase et
   * frequence, comme dans le script. C'est ce qui fait battre une lampe.
   */
  rgbWave: { base: number; amplitude: number; phase: number; frequency: number } | null;
  /** Couleur imposee a la couche : rgbGen const ( r g b ). */
  rgbConst: [number, number, number] | null;
  /** Onde appliquee a l'opacite de la couche : alphaGen wave. */
  alphaWave: { base: number; amplitude: number; phase: number; frequency: number } | null;
  tcGen: string;
  tcMods: string[];
  depthWrite: boolean;
  clamp: boolean;
}

export interface ShaderDefinition {
  name: string;
  stages: ShaderStage[];
  surfaceParams: Set<string>;
  cull: string;
  /** Renseigne pour un ciel : nom de base des six images, quand il y en a. */
  skyBox: string | null;
  /** Hauteur a laquelle les couches de nuages sont projetees. */
  cloudHeight: number;
  deforms: string[];
  sort: string;
  polygonOffset: boolean;
  /** Image annoncee a l'editeur : bon repli quand aucune couche n'est lisible. */
  editorImage: string | null;
  noMipMaps: boolean;
  /** Puissance declaree au compilateur de cartes : la surface eclaire la scene. */
  surfaceLight: number;
  /** Couleur imposee a cette lumiere de surface, quand elle est precisee. */
  lightColor: [number, number, number] | null;
  /**
   * Image dont la couleur moyenne donne la teinte de la lumiere. C'est ainsi
   * que le compilateur de cartes procede : la lampe prend la couleur de son
   * verre, pas une valeur ecrite a la main.
   */
  lightImage: string | null;
  sun: { color: [number, number, number]; intensity: number; azimuth: number; elevation: number } | null;
  fogParams: { color: [number, number, number]; distance: number } | null;
}

function emptyStage(): ShaderStage {
  return {
    map: '',
    animMaps: [],
    animFrequency: 0,
    blendSource: '',
    blendDest: '',
    alphaFunc: '',
    rgbGen: '',
    rgbWave: null,
    rgbConst: null,
    alphaWave: null,
    tcGen: '',
    tcMods: [],
    depthWrite: true,
    clamp: false,
  };
}

/** Decoupe un script en lignes de mots, commentaires retires. */
function tokenizeLines(text: string): string[][] {
  const lines: string[][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const withoutComment = raw.replace(/\/\/.*$/, '').trim();
    if (!withoutComment) continue;
    // Les accolades collees a un mot doivent rester des mots a part.
    const spaced = withoutComment.replace(/([{}])/g, ' $1 ');
    const words = spaced.split(/\s+/).filter(Boolean);
    if (words.length) lines.push(words);
  }
  return lines;
}

/** Lit un script et rend les definitions qu'il contient. */
export function parseShaderScript(text: string): ShaderDefinition[] {
  const lines = tokenizeLines(text);
  const definitions: ShaderDefinition[] = [];

  let index = 0;
  while (index < lines.length) {
    const nameLine = lines[index++];
    if (nameLine[0] === '{' || nameLine[0] === '}') continue;
    const name = nameLine[0].toLowerCase().replace(/\\/g, '/');

    // Le bloc peut commencer sur la ligne du nom ou sur la suivante.
    if (nameLine.length === 1) {
      if (index >= lines.length || lines[index][0] !== '{') continue;
      index++;
    } else if (nameLine[1] !== '{') {
      continue;
    }

    const definition: ShaderDefinition = {
      name,
      stages: [],
      surfaceParams: new Set(),
      cull: 'front',
      skyBox: null,
      cloudHeight: 512,
      deforms: [],
      sort: '',
      polygonOffset: false,
      editorImage: null,
      noMipMaps: false,
      surfaceLight: 0,
      lightColor: null,
      lightImage: null,
      sun: null,
      fogParams: null,
    };

    let depth = 1;
    let stage: ShaderStage | null = null;
    while (index < lines.length && depth > 0) {
      const words = lines[index++];
      const keyword = words[0].toLowerCase();

      if (keyword === '{') {
        depth++;
        if (depth === 2) stage = emptyStage();
        continue;
      }
      if (keyword === '}') {
        depth--;
        if (depth === 1 && stage) {
          definition.stages.push(stage);
          stage = null;
        }
        continue;
      }

      if (stage) {
        switch (keyword) {
          case 'map':
            stage.map = (words[1] ?? '').toLowerCase().replace(/\\/g, '/');
            break;
          case 'clampmap':
            stage.map = (words[1] ?? '').toLowerCase().replace(/\\/g, '/');
            stage.clamp = true;
            break;
          case 'animmap':
            stage.animFrequency = Number(words[1]) || 0;
            stage.animMaps = words.slice(2).map((word) => word.toLowerCase().replace(/\\/g, '/'));
            if (stage.animMaps.length) stage.map = stage.animMaps[0];
            break;
          case 'blendfunc':
            if (words.length === 2) {
              // Raccourcis usuels : add, filter, blend.
              const mode = words[1].toLowerCase();
              if (mode === 'add') [stage.blendSource, stage.blendDest] = ['gl_one', 'gl_one'];
              else if (mode === 'filter') [stage.blendSource, stage.blendDest] = ['gl_dst_color', 'gl_zero'];
              else [stage.blendSource, stage.blendDest] = ['gl_src_alpha', 'gl_one_minus_src_alpha'];
            } else {
              stage.blendSource = (words[1] ?? '').toLowerCase();
              stage.blendDest = (words[2] ?? '').toLowerCase();
            }
            break;
          case 'alphafunc':
            stage.alphaFunc = (words[1] ?? '').toLowerCase();
            break;
          case 'alphagen': {
            // alphaGen wave <forme> <base> <amplitude> <phase> <frequence>
            if ((words[1] ?? '').toLowerCase() === 'wave') {
              const values = words.slice(3).map(Number);
              if (values.length >= 4 && values.slice(0, 4).every(Number.isFinite)) {
                stage.alphaWave = {
                  base: values[0],
                  amplitude: values[1],
                  phase: values[2],
                  frequency: values[3],
                };
              }
            }
            break;
          }
          case 'rgbgen': {
            stage.rgbGen = words.slice(1).join(' ').toLowerCase();
            // rgbGen const ( r g b ) : la couche prend cette teinte.
            if ((words[1] ?? '').toLowerCase() === 'const') {
              const numbers = words
                .slice(2)
                .join(' ')
                .replace(/[()]/g, ' ')
                .trim()
                .split(/\s+/)
                .map(Number)
                .filter(Number.isFinite);
              if (numbers.length >= 3) stage.rgbConst = [numbers[0], numbers[1], numbers[2]];
            }
            // rgbGen wave <forme> <base> <amplitude> <phase> <frequence>
            if ((words[1] ?? '').toLowerCase() === 'wave') {
              const values = words.slice(3).map(Number);
              if (values.length >= 4 && values.slice(0, 4).every(Number.isFinite)) {
                stage.rgbWave = {
                  base: values[0],
                  amplitude: values[1],
                  phase: values[2],
                  frequency: values[3],
                };
              }
            }
            break;
          }
          case 'tcgen':
            stage.tcGen = words.slice(1).join(' ').toLowerCase();
            break;
          case 'tcmod':
            stage.tcMods.push(words.slice(1).join(' ').toLowerCase());
            break;
          case 'depthwrite':
            stage.depthWrite = true;
            break;
          default:
            break;
        }
        continue;
      }

      switch (keyword) {
        case 'surfaceparm':
          if (words[1]) definition.surfaceParams.add(words[1].toLowerCase());
          break;
        case 'cull':
          definition.cull = (words[1] ?? 'front').toLowerCase();
          break;
        case 'skyparms': {
          // Le premier mot nomme les six images du ciel, un tiret quand la
          // carte prefere des couches de nuages ; le deuxieme donne leur hauteur.
          if (words[1] && words[1] !== '-') definition.skyBox = words[1].toLowerCase().replace(/\\/g, '/');
          const height = Number(words[2]);
          if (Number.isFinite(height) && height > 0) definition.cloudHeight = height;
          definition.surfaceParams.add('sky');
          break;
        }
        case 'deformvertexes':
          definition.deforms.push(words.slice(1).join(' ').toLowerCase());
          break;
        case 'sort':
          definition.sort = (words[1] ?? '').toLowerCase();
          break;
        case 'polygonoffset':
          definition.polygonOffset = true;
          break;
        case 'qer_editorimage':
          definition.editorImage = (words[1] ?? '').toLowerCase().replace(/\\/g, '/');
          break;
        case 'nomipmaps':
          definition.noMipMaps = true;
          break;
        case 'q3map_surfacelight':
          definition.surfaceLight = Number(words[1]) || 0;
          break;
        case 'q3map_sun':
        case 'q3map_sunext': {
          // r v b puissance azimut elevation
          const values = words.slice(1).map(Number);
          if (values.length >= 6 && values.slice(0, 6).every(Number.isFinite)) {
            definition.sun = {
              color: [values[0], values[1], values[2]],
              intensity: values[3],
              azimuth: values[4],
              elevation: values[5],
            };
          }
          break;
        }
        case 'q3map_lightrgb': {
          const values = words.slice(1).map(Number);
          if (values.length >= 3 && values.slice(0, 3).every(Number.isFinite)) {
            definition.lightColor = [values[0], values[1], values[2]];
          }
          break;
        }
        case 'q3map_lightimage':
          definition.lightImage = (words[1] ?? '').toLowerCase().replace(/\\/g, '/').replace(/\.(tga|jpg|jpeg|png)$/, '');
          break;
        case 'fogparms': {
          // Ecrit ( r g b ) distance : les parentheses sont des mots a part.
          const numbers = words.slice(1).map(Number).filter(Number.isFinite);
          if (numbers.length >= 4) {
            definition.fogParams = {
              color: [numbers[0], numbers[1], numbers[2]],
              distance: numbers[3],
            };
          }
          break;
        }
        default:
          break;
      }
    }

    definitions.push(definition);
  }

  return definitions;
}

/** Ce que le moteur de rendu retient d'un shader. */
export interface ShaderSummary {
  name: string;
  /** Image de base a plaquer. */
  texture: string | null;
  /** Couche supplementaire ajoutee par dessus, pour les effets lumineux. */
  glowTexture: string | null;
  translucent: boolean;
  additive: boolean;
  alphaTest: boolean;
  lightmapped: boolean;
  twoSided: boolean;
  sky: boolean;
  skyBox: string | null;
  cloudHeight: number;
  nodraw: boolean;
  /** Defilement des coordonnees, en unites de texture par seconde. */
  scroll: [number, number] | null;
  /** Ondulation de la surface, comme sur l'eau. */
  wavy: boolean;
  animMaps: string[];
  animFrequency: number;
  /** Puissance lumineuse declaree, zero quand la surface n'eclaire pas. */
  surfaceLight: number;
  lightColor: [number, number, number] | null;
  /** Image dont la couleur moyenne donne la teinte de la lampe. */
  lightImage: string | null;
  /** Battement de la couche lumineuse, quand le script en declare un. */
  glowWave: { base: number; amplitude: number; phase: number; frequency: number } | null;
  fog: { color: [number, number, number]; distance: number } | null;
  /** Soleil declare par un shader de ciel, s'il y en a un. */
  sun: { color: [number, number, number]; intensity: number; azimuth: number; elevation: number } | null;
  /** Rangee de tri demandee par le script : additive, banniere, decal. */
  sort: string;
  /**
   * Couches dessinees, telles que le script les decrit. Une lave, par exemple,
   * en superpose deux : une croute qui derive lentement et une nappe additive
   * a l'echelle inversee, dont l'opacite bat. C'est de la que vient son
   * mouvement, et il n'y a donc rien a inventer.
   */
  layers: SurfaceLayer[];
  /**
   * deformVertexes wave : la surface elle-meme ondule. Les valeurs sont celles
   * du script, division comprise, qui etale l'onde le long de la surface.
   */
  deformWave: {
    division: number;
    base: number;
    amplitude: number;
    phase: number;
    frequency: number;
  } | null;
}

/** Une couche d'une surface, avec les transformations que le script lui donne. */
export interface SurfaceLayer {
  texture: string;
  additive: boolean;
  /** tcMod scale : nombre de repetitions de l'image sur la surface. */
  scale: [number, number];
  /** tcMod scroll : defilement, en unites de texture par seconde. */
  scroll: [number, number];
  /** tcMod turb : distorsion des coordonnees. */
  turb: { base: number; amplitude: number; phase: number; frequency: number } | null;
  /** rgbGen const : teinte imposee. */
  tint: [number, number, number] | null;
  /** alphaGen wave : opacite qui bat. */
  alphaWave: { base: number; amplitude: number; phase: number; frequency: number } | null;
}

const HIDDEN_PARAMS = ['nodraw', 'trans', 'hint', 'skip'];

/** Resume ce que la definition implique pour le rendu. */
export function summarizeShader(definition: ShaderDefinition): ShaderSummary {
  const params = definition.surfaceParams;
  const summary: ShaderSummary = {
    name: definition.name,
    texture: null,
    glowTexture: null,
    translucent: false,
    additive: false,
    alphaTest: false,
    lightmapped: definition.stages.some((stage) => stage.map === '$lightmap'),
    twoSided: definition.cull === 'none' || definition.cull === 'twosided' || definition.cull === 'disable',
    sky: params.has('sky') || definition.skyBox !== null,
    skyBox: definition.skyBox,
    cloudHeight: definition.cloudHeight,
    nodraw: params.has('nodraw') || params.has('hint') || params.has('skip'),
    scroll: null,
    wavy: definition.deforms.some((deform) => deform.startsWith('wave')) || params.has('water'),
    animMaps: [],
    animFrequency: 0,
    surfaceLight: definition.surfaceLight,
    lightColor: definition.lightColor,
    lightImage: definition.lightImage,
    glowWave: null,
    fog: definition.fogParams,
    sun: definition.sun,
    sort: definition.sort,
    layers: [],
    deformWave: readDeformWave(definition.deforms),
  };

  for (const stage of definition.stages) {
    if (!stage.map || stage.map === '$lightmap' || stage.map === '$whiteimage') continue;

    summary.layers.push(readLayer(stage));
    const blends = stage.blendSource && stage.blendDest;
    const additive =
      stage.blendSource === 'gl_one' && (stage.blendDest === 'gl_one' || stage.blendDest === 'gl_src_alpha');
    const alphaBlend =
      stage.blendSource === 'gl_src_alpha' && stage.blendDest === 'gl_one_minus_src_alpha';

    if (!summary.texture) {
      summary.texture = stage.map;
      summary.alphaTest = stage.alphaFunc !== '';
      summary.translucent = Boolean(alphaBlend || (blends && !additive && stage.blendDest !== 'gl_zero'));
      summary.additive = additive;
      if (stage.animMaps.length > 1) {
        summary.animMaps = stage.animMaps;
        summary.animFrequency = stage.animFrequency;
      }
      for (const mod of stage.tcMods) {
        const parts = mod.split(/\s+/);
        if (parts[0] === 'scroll') summary.scroll = [Number(parts[1]) || 0, Number(parts[2]) || 0];
        if (parts[0] === 'turb') summary.wavy = true;
      }
    } else if (additive && !summary.glowTexture) {
      summary.glowTexture = stage.map;
      // Le battement appartient a la couche lumineuse, pas a la surface.
      summary.glowWave = stage.rgbWave;
    }
  }

  if (!summary.texture && definition.editorImage) summary.texture = definition.editorImage;
  if (HIDDEN_PARAMS.some((param) => param === 'nodraw' && params.has(param))) summary.nodraw = true;
  return summary;
}

/** Transformations d'une couche, lues telles que le script les ecrit. */
function readLayer(stage: ShaderStage): SurfaceLayer {
  const layer: SurfaceLayer = {
    texture: stage.map,
    additive:
      stage.blendSource === 'gl_one'
      && (stage.blendDest === 'gl_one' || stage.blendDest === 'gl_src_alpha'),
    scale: [1, 1],
    scroll: [0, 0],
    turb: null,
    tint: stage.rgbConst,
    alphaWave: stage.alphaWave,
  };

  for (const mod of stage.tcMods) {
    const parts = mod.split(/\s+/);
    const values = parts.slice(1).map(Number);
    if (parts[0] === 'scale' && values.length >= 2 && values.every(Number.isFinite)) {
      layer.scale = [values[0] || 1, values[1] || 1];
    }
    if (parts[0] === 'scroll' && values.length >= 2 && values.every(Number.isFinite)) {
      layer.scroll = [values[0] || 0, values[1] || 0];
    }
    // tcMod turb <base> <amplitude> <phase> <frequence>
    if (parts[0] === 'turb' && values.length >= 4 && values.slice(0, 4).every(Number.isFinite)) {
      layer.turb = {
        base: values[0],
        amplitude: values[1],
        phase: values[2],
        frequency: values[3],
      };
    }
  }
  return layer;
}

/** Onde de deformation de la surface : deformVertexes wave. */
function readDeformWave(deforms: string[]): ShaderSummary['deformWave'] {
  for (const deform of deforms) {
    const parts = deform.split(/\s+/);
    if (parts[0] !== 'wave') continue;
    const division = Number(parts[1]);
    const values = parts.slice(3).map(Number);
    if (!Number.isFinite(division) || values.length < 4 || !values.slice(0, 4).every(Number.isFinite)) {
      continue;
    }
    return {
      // Une division nulle ferait une onde infinie : le jeu la traite comme un.
      division: division || 1,
      base: values[0],
      amplitude: values[1],
      phase: values[2],
      frequency: values[3],
    };
  }
  return null;
}

/** Table des shaders d'une carte, indexee par nom. */
export class ShaderLibrary {
  private readonly definitions = new Map<string, ShaderDefinition>();
  private readonly summaries = new Map<string, ShaderSummary>();

  add(text: string): number {
    const parsed = parseShaderScript(text);
    for (const definition of parsed) {
      // Le premier script monte gagne, comme dans l'ordre de lecture d'origine.
      if (!this.definitions.has(definition.name)) this.definitions.set(definition.name, definition);
    }
    return parsed.length;
  }

  get count(): number {
    return this.definitions.size;
  }

  /** Definition complete, couches comprises. */
  definition(name: string): ShaderDefinition | null {
    return this.definitions.get(name.toLowerCase().replace(/\\/g, '/')) ?? null;
  }

  get(name: string): ShaderSummary | null {
    const key = name.toLowerCase().replace(/\\/g, '/');
    const cached = this.summaries.get(key);
    if (cached) return cached;
    const definition = this.definitions.get(key);
    if (!definition) return null;
    const summary = summarizeShader(definition);
    this.summaries.set(key, summary);
    return summary;
  }
}
