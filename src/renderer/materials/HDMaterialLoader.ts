import * as THREE from 'three';

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

/** Une entree du manifeste, telle que la chaine l'ecrit. */
export interface HDMaterialEntry {
  type: string;
  resolution: number;
  sourceResolution: number;
  engine: string;
  maps: Partial<Record<'baseColor' | 'normal' | 'roughness' | 'metalness' | 'ao' | 'emissive' | 'height', string>>;
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

/** Cartes chargees, pretes a etre posees sur un materiau. */
export interface HDMaterialMaps {
  map: THREE.Texture;
  normalMap: THREE.Texture | null;
  roughnessMap: THREE.Texture | null;
  metalnessMap: THREE.Texture | null;
  aoMap: THREE.Texture | null;
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
    const [map, normalMap, roughnessMap, metalnessMap, aoMap, emissiveMap] = await Promise.all([
      this.texture(entry.maps.baseColor, THREE.SRGBColorSpace),
      this.texture(entry.maps.normal, THREE.NoColorSpace),
      this.texture(entry.maps.roughness, THREE.NoColorSpace),
      this.texture(entry.maps.metalness, THREE.NoColorSpace),
      this.texture(entry.maps.ao, THREE.NoColorSpace),
      this.texture(entry.maps.emissive, THREE.SRGBColorSpace),
    ]);
    if (!map) return null;

    return {
      map,
      normalMap,
      roughnessMap,
      metalnessMap,
      aoMap,
      emissiveMap,
      metalness: entry.metalness,
      normalStrength: entry.normalStrength,
      roughnessMultiplier: entry.roughnessMultiplier,
      entry,
    };
  }

  private texture(path: string | undefined, colorSpace: THREE.ColorSpace): Promise<THREE.Texture | null> {
    if (!path) return Promise.resolve(null);
    const cached = this.textures.get(path);
    if (cached) return cached;

    const pending = this.loader
      .loadAsync(path)
      .then((texture) => {
        // Les UV BSP ont leur origine en haut, comme nos DataTexture source.
        // TextureLoader inverse Y par defaut, ce qui retournait les versions
        // HD et desalignait les motifs avec l'eclairage cuit.
        texture.flipY = false;
        texture.colorSpace = colorSpace;
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = true;
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
