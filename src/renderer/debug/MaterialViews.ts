import * as THREE from 'three';

/**
 * Deux outils de jugement, indispensables des lors qu'on refait des matieres.
 *
 * Le premier compare : la meme carte, au meme endroit, avec les textures
 * d'origine ou avec les materiaux HD, et un mode ou l'image est coupee en deux,
 * l'origine a gauche et la refonte a droite. C'est la seule facon honnete de
 * dire si un travail de materiaux apporte quelque chose : de memoire, on croit
 * toujours que c'est mieux.
 *
 * Le second isole : il affiche une seule carte du materiau, couleur, normale,
 * rugosite, part metallique, occlusion, lightmap ou emission. Une rugosite
 * inversee ou une normale trop forte se voient immediatement la, et restent
 * invisibles dans l'image finie.
 */

export type ComparisonMode = 'original' | 'redux' | 'split';

export const COMPARISON_MODES: ComparisonMode[] = ['redux', 'original', 'split'];

/** Materiaux ranges par le constructeur de carte sur chaque maillage. */
interface MeshMaterials {
  original: THREE.Material;
  redux: THREE.Material;
}

/**
 * Coupe l'image en deux. Le decoupage se fait au fragment : chaque materiau
 * abandonne les pixels qui ne sont pas de son cote. Deux dessins par surface,
 * uniquement dans ce mode.
 *
 * La position de la coupe est exprimee dans l'espace de projection, ou le
 * centre de l'image vaut zero et les bords plus ou moins un. Se fier aux
 * coordonnees de fragment obligerait a connaitre la taille exacte du tampon,
 * qui change avec la densite d'affichage et avec la resolution dynamique : la
 * coupe se deplacait alors toute seule.
 *
 * Le rapport des deux composantes est calcule dans le fragment et non dans le
 * sommet : interpolees separement, elles rendent exactement la position a
 * l'ecran, ce qu'une division faite trop tot ne donne pas.
 */
const SPLIT_UNIFORM = { value: 0 };
const originalHooks = new WeakMap<THREE.Material, {
  compile: THREE.Material['onBeforeCompile'];
  cacheKey: THREE.Material['customProgramCacheKey'];
}>();

function patchSide(material: THREE.Material, side: -1 | 1): void {
  const patched = material as THREE.Material & { __side?: number };
  if (patched.__side === side) return;
  if (!originalHooks.has(material)) {
    originalHooks.set(material, {
      compile: material.onBeforeCompile,
      cacheKey: material.customProgramCacheKey,
    });
  }
  const original = originalHooks.get(material)!;
  patched.__side = side;

  material.onBeforeCompile = (shader, renderer) => {
    original.compile.call(material, shader, renderer);
    shader.uniforms.uSplit = SPLIT_UNIFORM;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n        varying vec2 vSplitClip;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n        vSplitClip = vec2(gl_Position.x, gl_Position.w);',
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uSplit;
        varying vec2 vSplitClip;`,
      )
      .replace(
        'void main() {',
        `void main() {
          float position = vSplitClip.x / vSplitClip.y;
          if ((position - uSplit) * ${side.toFixed(1)} < 0.0) discard;`,
      );
  };
  material.customProgramCacheKey = () => `${original.cacheKey.call(material)}|split${side}`;
  material.needsUpdate = true;
}

function unpatch(material: THREE.Material): void {
  const patched = material as THREE.Material & { __side?: number };
  if (patched.__side === undefined) return;
  patched.__side = undefined;
  const original = originalHooks.get(material);
  if (original) {
    material.onBeforeCompile = original.compile;
    material.customProgramCacheKey = original.cacheKey;
    originalHooks.delete(material);
  }
  material.needsUpdate = true;
}

export class MaterialComparison {
  private root: THREE.Object3D | null = null;
  private mode: ComparisonMode = 'redux';
  /** Maillages ajoutes pour le mode coupe, retires en sortant. */
  private readonly doubles: THREE.Mesh[] = [];

  attach(root: THREE.Object3D): void {
    this.clearDoubles();
    this.root = root;
    this.apply();
  }

  get current(): ComparisonMode {
    return this.mode;
  }

  /**
   * Position de la coupe, de moins un a un, zero etant le centre de l'image.
   * Rien d'autre n'est necessaire : la coupe ne depend plus de la resolution.
   */
  setSplit(position: number): void {
    SPLIT_UNIFORM.value = Math.max(-1, Math.min(1, position));
  }

  next(): ComparisonMode {
    const index = COMPARISON_MODES.indexOf(this.mode);
    this.mode = COMPARISON_MODES[(index + 1) % COMPARISON_MODES.length];
    this.apply();
    return this.mode;
  }

  setMode(mode: ComparisonMode): void {
    this.mode = mode;
    this.apply();
  }

  /** Nombre de surfaces qui ont vraiment une version HD. */
  get converted(): number {
    let count = 0;
    this.each((_mesh, materials) => {
      if (materials.original !== materials.redux) count++;
    });
    return count;
  }

  private apply(): void {
    this.clearDoubles();
    if (!this.root) return;

    this.each((mesh, materials) => {
      if (this.mode === 'split' && materials.original !== materials.redux) {
        // A droite la refonte, a gauche l'origine, dessinee par un double.
        patchSide(materials.redux, 1);
        patchSide(materials.original, -1);
        mesh.material = materials.redux;

        const double = new THREE.Mesh(mesh.geometry, materials.original);
        double.name = `${mesh.name}-origine`;
        double.castShadow = false;
        double.receiveShadow = mesh.receiveShadow;
        double.renderOrder = mesh.renderOrder;
        mesh.add(double);
        this.doubles.push(double);
        return;
      }

      unpatch(materials.redux);
      unpatch(materials.original);
      const wantsOriginal = this.mode === 'original';
      // Les cartes HD arrivent apres le chargement : ce drapeau evite qu'une
      // surface repasse en refonte alors que le joueur regarde l'origine.
      mesh.userData.keepOriginal = wantsOriginal;
      mesh.material = wantsOriginal ? materials.original : materials.redux;
    });
  }

  private clearDoubles(): void {
    for (const double of this.doubles) double.removeFromParent();
    this.doubles.length = 0;
  }

  private each(visit: (mesh: THREE.Mesh, materials: MeshMaterials) => void): void {
    this.root?.traverse((object) => {
      const mesh = object as THREE.Mesh;
      const materials = mesh.userData?.materials as MeshMaterials | undefined;
      if (mesh.isMesh && materials) visit(mesh, materials);
    });
  }
}

export type MaterialChannel =
  | 'final'
  | 'baseColor'
  | 'lightmap'
  | 'baseColorLightmap'
  | 'lighting'
  | 'normal'
  | 'roughness'
  | 'metalness'
  | 'ao'
  | 'emissive';

/*
 * L'ordre suit le diagnostic : d'abord la couleur seule, puis la lightmap
 * seule, puis leur produit, puis l'eclairage sans la couleur. C'est dans cet
 * ordre qu'on trouve d'ou viennent des noirs bouches.
 */
export const MATERIAL_CHANNELS: MaterialChannel[] = [
  'final',
  'baseColor',
  'lightmap',
  'baseColorLightmap',
  'lighting',
  'normal',
  'roughness',
  'metalness',
  'ao',
  'emissive',
];

/**
 * Affichage d'une seule carte du materiau. Les materiaux de mise au point sont
 * fabriques a la demande et gardes : passer d'un canal a l'autre ne recompile
 * rien apres le premier passage.
 */
export class MaterialDebug {
  private root: THREE.Object3D | null = null;
  private channel: MaterialChannel = 'final';
  private readonly views = new Map<THREE.Material, Map<MaterialChannel, THREE.Material>>();

  attach(root: THREE.Object3D): void {
    this.views.clear();
    this.root = root;
    this.apply();
  }

  get current(): MaterialChannel {
    return this.channel;
  }

  next(): MaterialChannel {
    const index = MATERIAL_CHANNELS.indexOf(this.channel);
    this.channel = MATERIAL_CHANNELS[(index + 1) % MATERIAL_CHANNELS.length];
    this.apply();
    return this.channel;
  }

  private apply(): void {
    this.root?.traverse((object) => {
      const mesh = object as THREE.Mesh;
      const materials = mesh.userData?.materials as MeshMaterials | undefined;
      if (!mesh.isMesh || !materials) return;

      const source = materials.redux as THREE.MeshStandardMaterial;
      if (this.channel === 'final') {
        mesh.material = source;
        return;
      }
      mesh.material = this.view(source);
    });
  }

  private view(source: THREE.MeshStandardMaterial): THREE.Material {
    let perChannel = this.views.get(source);
    if (!perChannel) {
      perChannel = new Map();
      this.views.set(source, perChannel);
    }
    const existing = perChannel.get(this.channel);
    if (existing) return existing;

    const made = this.make(source);
    perChannel.set(this.channel, made);
    return made;
  }

  private make(source: THREE.MeshStandardMaterial): THREE.Material {
    /*
     * L'eclairage seul se regarde sur un materiau blanc : la couleur de la
     * texture est retiree, tout ce qui reste vient des lumieres, des lightmaps
     * et de l'occlusion.
     */
    if (this.channel === 'lighting') {
      const lit = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        lightMap: source.lightMap,
        lightMapIntensity: source.lightMapIntensity,
        aoMap: source.aoMap,
        aoMapIntensity: source.aoMapIntensity,
        normalMap: source.normalMap,
        normalScale: source.normalScale,
        roughness: source.roughness,
        metalness: 0,
        side: source.side,
      });
      return lit;
    }

    const flat = new THREE.MeshBasicMaterial({
      side: source.side,
      alphaTest: source.alphaTest,
      transparent: source.transparent,
    });

    switch (this.channel) {
      case 'baseColor':
        flat.map = source.map;
        break;
      case 'normal':
        flat.map = source.normalMap;
        break;
      case 'roughness':
        flat.map = source.roughnessMap;
        // Sans carte, la valeur constante est affichee en gris.
        if (!flat.map) flat.color.setScalar(source.roughness);
        break;
      case 'metalness':
        flat.map = source.metalnessMap;
        if (!flat.map) flat.color.setScalar(source.metalness);
        break;
      case 'ao':
        flat.map = source.aoMap;
        if (!flat.map) flat.color.setScalar(1);
        break;
      case 'lightmap':
        flat.map = source.lightMap;
        break;
      case 'baseColorLightmap':
        // Le produit des deux : c'est lui qui dit si les noirs sont deja dans
        // l'eclairage precalcule, avant toute passe d'image.
        flat.map = source.map;
        flat.lightMap = source.lightMap;
        flat.lightMapIntensity = source.lightMapIntensity;
        break;
      case 'emissive':
        flat.map = source.emissiveMap;
        if (!flat.map) flat.color.copy(source.emissive);
        break;
      default:
        break;
    }
    return flat;
  }
}
