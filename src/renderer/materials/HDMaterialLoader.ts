import * as THREE from 'three';
import { readBlockTexture, supportsBlockTextures } from './CompressedMaps';

/**
 * Materiaux HD produits par la chaine hors ligne.
 *
 * Le jeu ne devine rien : il lit le manifeste ecrit par la chaine, et n'emploie
 * un materiau HD que pour les textures qui y figurent. Une texture absente
 * garde son materiau d'origine, ce qui permet de convertir une carte matiere
 * par matiere sans jamais casser le rendu.
 *
 * Les cartes sont mises en cache par chemin : une texture partagee par vingt
 * surfaces n'est ni retelechargee ni redecodee vingt fois.
 */

/**
 * Cartes qu'une surface peut porter. Occlusion, rugosite et metal tiennent
 * dans la seule carte « orm », un canal chacun : separees, ces trois images a
 * un seul canal arrivaient en RGBA et occupaient la moitie de la memoire
 * video de la carte.
 */
export type MapKey = 'baseColor' | 'normal' | 'orm' | 'emissive' | 'height';

/** Une entree du manifeste, telle que la chaine l'ecrit. */
export interface HDMaterialEntry {
  type: string;
  resolution: number;
  sourceResolution: number;
  /** Largeur et hauteur de la texture d'origine, et de la version produite. */
  sourceSize?: [number, number];
  size?: [number, number];
  engine: string;
  maps: Partial<Record<MapKey, string>>;
  /**
   * Memes cartes, en blocs compresses. Le jeu les prefere quand la carte
   * graphique sait les lire : un octet par pixel au lieu de quatre, et rien a
   * decoder au chargement.
   */
  compressed?: Partial<Record<MapKey, string>>;
  /** Part metallique constante, ou moins un quand une carte la porte. */
  metalness: number;
  normalStrength: number;
  roughnessMultiplier: number;
  seamless: boolean;
  validation: { ssim: number; edges: number; histogram: number; passed: boolean };
  /**
   * Emission declaree par le script de la surface : sa puissance au
   * compilateur de cartes, la teinte de sa partie lumineuse, et le battement
   * quand le script en prevoit un.
   */
  emission?: {
    declared: number;
    intensity: number;
    color: [number, number, number];
    wave: { base: number; amplitude: number; phase: number; frequency: number } | null;
  };
}

/**
 * Cartes chargees, pretes a etre posees sur un materiau.
 *
 * La rugosite, le metal et l'occlusion sont la meme texture : Three lit le
 * rouge pour l'occlusion, le vert pour la rugosite et le bleu pour le metal,
 * et c'est dans cet ordre que la chaine les a empilees.
 */
export interface HDMaterialMaps {
  map: THREE.Texture;
  normalMap: THREE.Texture | null;
  surfaceMap: THREE.Texture | null;
  emissiveMap: THREE.Texture | null;
  metalness: number;
  normalStrength: number;
  roughnessMultiplier: number;
  entry: HDMaterialEntry;
}

/** Emission d'une surface, telle que son script la declare. */
export type HDEmission = NonNullable<HDMaterialEntry['emission']>;

const MANIFEST_URL = 'generated/materials/manifest.json';

export class HDMaterialLibrary {
  private manifest: Record<string, HDMaterialEntry> = {};
  private loaded = false;
  private readonly textures = new Map<string, Promise<THREE.Texture | null>>();
  private readonly materials = new Map<string, Promise<HDMaterialMaps | null>>();
  private readonly loader = new THREE.TextureLoader();
  private anisotropy = 1;
  /** Vrai quand la carte graphique lit les blocs compresses. */
  private blocks = false;

  /** Nombre de materiaux disponibles, une fois le manifeste lu. */
  get size(): number {
    return Object.keys(this.manifest).length;
  }

  get names(): string[] {
    return Object.keys(this.manifest);
  }

  setAnisotropy(value: number): void {
    this.anisotropy = Math.max(1, value);
  }

  /**
   * Declare le rendu, pour savoir si les cartes compressees sont lisibles. A
   * defaut, les PNG font le travail : la chaine ecrit toujours les deux.
   */
  setRenderer(renderer: THREE.WebGLRenderer): void {
    this.blocks = supportsBlockTextures(renderer);
  }

  get compressionAvailable(): boolean {
    return this.blocks;
  }

  /**
   * Lit le manifeste. L'absence de fichier n'est pas une erreur : elle
   * signifie que la chaine n'a pas encore tourne sur cette machine.
   */
  async open(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const response = await fetch(MANIFEST_URL);
      if (!response.ok) return;
      this.manifest = (await response.json()) as Record<string, HDMaterialEntry>;
    } catch {
      this.manifest = {};
    }
  }

  has(name: string): boolean {
    return name in this.manifest;
  }

  entry(name: string): HDMaterialEntry | null {
    return this.manifest[name] ?? null;
  }

  /** Charge les cartes d'une texture, ou rien si elle n'a pas de version HD. */
  load(name: string): Promise<HDMaterialMaps | null> {
    const existing = this.materials.get(name);
    if (existing) return existing;

    const entry = this.manifest[name];
    if (!entry) return Promise.resolve(null);

    const pending = this.build(entry);
    this.materials.set(name, pending);
    return pending;
  }

  private async build(entry: HDMaterialEntry): Promise<HDMaterialMaps | null> {
    const [map, normalMap, surfaceMap, emissiveMap] = await Promise.all([
      this.texture(entry, 'baseColor', THREE.SRGBColorSpace),
      this.texture(entry, 'normal', THREE.NoColorSpace),
      this.texture(entry, 'orm', THREE.NoColorSpace),
      this.texture(entry, 'emissive', THREE.SRGBColorSpace),
    ]);
    if (!map) return null;

    return {
      map,
      normalMap,
      surfaceMap,
      emissiveMap,
      metalness: entry.metalness,
      normalStrength: entry.normalStrength,
      roughnessMultiplier: entry.roughnessMultiplier,
      entry,
    };
  }

  private texture(
    entry: HDMaterialEntry,
    key: MapKey,
    colorSpace: THREE.ColorSpace,
  ): Promise<THREE.Texture | null> {
    const packed = this.blocks ? entry.compressed?.[key] : undefined;
    const path = packed ?? entry.maps[key];
    if (!path) return Promise.resolve(null);
    const cached = this.textures.get(path);
    if (cached) return cached;

    const pending = (packed ? this.blockTexture(packed) : this.loader.loadAsync(path))
      .then((texture) => {
        if (!texture) return null;
        // Les UV BSP ont leur origine en haut, comme nos DataTexture source.
        // TextureLoader inverse Y par defaut, ce qui retournait les versions
        // HD et desalignait les motifs avec l'eclairage cuit.
        // Les blocs compresses portent deja leur orientation et leur espace
        // de couleur ; le PNG, lui, arrive retourne et sans espace declare.
        if (!packed) {
          texture.flipY = false;
          texture.colorSpace = colorSpace;
        }
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        // Les niveaux d'une texture compressee sont dans le fichier : la carte
        // graphique ne sait pas les calculer.
        texture.generateMipmaps = !packed;
        texture.anisotropy = this.anisotropy;
        /*
         * Toutes ces cartes suivent les coordonnees de la texture diffuse. Il
         * faut le dire pour l'occlusion : dans Three, c'est le canal de la
         * texture qui choisit le jeu de coordonnees, et le second jeu est
         * reserve aux lightmaps de la carte.
         */
        texture.channel = 0;
        return texture;
      })
      .catch(() => null);

    this.textures.set(path, pending);
    return pending;
  }

  /** Lit un fichier de blocs compresses ecrit par la chaine de textures. */
  private async blockTexture(path: string): Promise<THREE.Texture | null> {
    try {
      const response = await fetch(path);
      if (!response.ok) return null;
      return readBlockTexture(await response.arrayBuffer());
    } catch {
      return null;
    }
  }

  dispose(): void {
    for (const pending of this.textures.values()) {
      void pending.then((texture) => texture?.dispose());
    }
    this.textures.clear();
    this.materials.clear();
  }
}

/** Bibliotheque partagee : un seul manifeste et un seul cache par session. */
export const hdMaterials = new HDMaterialLibrary();
