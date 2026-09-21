import * as THREE from 'three';
import { FaceType, Surface, type BspFace, type BspMap } from '../formats/bsp';
import type { ShaderLibrary } from '../formats/shader';
import { LightmapAtlas } from './Lightmaps';
import { tessellatePatch } from './Bezier';
import { TextureLibrary } from '../renderer/materials/TextureLibrary';
import { classifySurface, type SurfaceMetadata } from '../renderer/materials/SurfaceMetadata';
import { createWorldMaterial } from '../renderer/materials/Q3Material';
import { animatedEmissive } from '../renderer/materials/AnimatedEmissive';
import { hdMaterials } from '../renderer/materials/HDMaterialLoader';
import { buildLightGridTextures, type LightGridTextures } from './LightGridTexture';

/**
 * Construction de la geometrie d'une carte. Les faces sont regroupees par
 * couple image et planche d'eclairage, ce qui ramene quelques milliers de
 * surfaces a quelques centaines d'appels de rendu.
 *
 * Une carte contient plusieurs modeles : le premier est le decor fixe, les
 * suivants sont ses parties mobiles, portes, plateformes et panneaux tournants.
 * Chacun recoit son propre groupe, que le jeu deplacera ensuite.
 */

export interface WorldBuildOptions {
  /** Emploie les materiaux HD quand la chaine en a produit. */
  hdMaterials?: boolean;
  /** Force du reflet tire de la grille d'eclairage de la carte. */
  gridSpecular?: number;
  /** Finesse des surfaces courbes. */
  patchLevel?: number;
  lightMapIntensity?: number;
  lightmapOverbright?: number;
  normalScale?: number;
  onProgress?: (label: string, done: number, total: number) => void;
}

export interface EmissiveSurface {
  /** Centre de l'amas lumineux, ou poser une lampe. */
  position: [number, number, number];
  color: THREE.Color;
  strength: number;
  /** Rayon de l'amas : une flamme isolee eclaire moins loin qu'un mur de lave. */
  radius: number;
}

export interface BuiltWorld {
  root: THREE.Group;
  /** Shader de ciel de la carte et hauteur de ses nuages. */
  skyShader: string | null;
  cloudHeight: number;
  /** Maillage des faces de ciel, a habiller quand il n'y a pas de boite. */
  skyMesh: THREE.Mesh | null;
  /** Un groupe par modele de la carte ; l'indice zero est le decor fixe. */
  brushModels: THREE.Group[];
  animated: ((time: number) => void)[];
  sky: THREE.Texture | null;
  skyColor: THREE.Color;
  /** Surfaces reconnues lumineuses : elles serviront a eclairer la scene. */
  emissiveSurfaces: EmissiveSurface[];
  /** Nom de base des six images du ciel declare par la carte. */
  skyName: string | null;
  stats: { faces: number; triangles: number; groups: number; textures: number; emissive: number };
}

interface GeometryGroup {
  shader: number;
  atlas: number;
  positions: number[];
  normals: number[];
  texCoords: number[];
  lightCoords: number[];
  /** Eclairage precalcule par sommet, deja converti en lineaire. */
  vertexLight: number[];
  indices: number[];
  /** Plage d'indices occupee par chaque face du lot. */
  faceRanges: { face: number; start: number; count: number }[];
}

interface CollectResult {
  groups: Map<string, GeometryGroup>;
  /** Nom de base des six images du ciel, quand la carte en declare une boite. */
  skyName: string | null;
  /** Shader de ciel de la carte, qu'il declare une boite ou des couches. */
  skyShader: string | null;
  /** Hauteur des nuages declaree par le shader de ciel. */
  cloudHeight: number;
  /** Faces de ciel, gardees a part : elles ne recoivent pas d'eclairage. */
  skyGroups: Map<string, GeometryGroup>;
  faceCount: number;
}

/** Trie les faces d'un modele en lots partageant image et planche d'eclairage. */
function collectGroups(
  map: BspMap,
  shaders: ShaderLibrary,
  lightmaps: LightmapAtlas,
  patchLevel: number,
  firstFace: number,
  faceTotal: number,
): CollectResult {
  const groups = new Map<string, GeometryGroup>();
  const skyGroups = new Map<string, GeometryGroup>();
  let skyName: string | null = null;
  let skyShader: string | null = null;
  let cloudHeight = 512;
  let faceCount = 0;

  for (let index = firstFace; index < firstFace + faceTotal; index++) {
    const face = map.faces[index];
    if (!face) continue;
    const bspShader = map.shaders[face.shader];
    const summary = bspShader ? shaders.get(bspShader.name) : null;

    if (bspShader && (bspShader.surfaceFlags & (Surface.NODRAW | Surface.SKIP | Surface.HINT)) !== 0) continue;
    if (summary?.nodraw) continue;

    const isSky = (bspShader && (bspShader.surfaceFlags & Surface.SKY) !== 0) || summary?.sky;
    if (isSky) {
      if (!skyName && summary?.skyBox) skyName = summary.skyBox;
      if (!skyShader && bspShader) {
        skyShader = bspShader.name;
        cloudHeight = summary?.cloudHeight ?? 512;
      }
      // Les faces de ciel sont gardees : quand la carte ne declare pas de
      // boite d'images, son ciel est fait de couches plaquees sur ces faces.
      const key = `sky|${face.shader}`;
      let skyGroup = skyGroups.get(key);
      if (!skyGroup) {
        skyGroup = {
          shader: face.shader,
          atlas: -1,
          positions: [],
          normals: [],
          texCoords: [],
          lightCoords: [],
          vertexLight: [],
          indices: [],
          faceRanges: [],
        };
        skyGroups.set(key, skyGroup);
      }
      if (face.type === FaceType.PATCH) appendPatch(skyGroup, face, map, lightmaps, patchLevel);
      else appendFace(skyGroup, face, map, lightmaps);
      continue;
    }
    if (face.type === FaceType.BILLBOARD) continue;

    const atlas = face.lightmap >= 0 ? lightmaps.placement(face.lightmap)?.atlas ?? -1 : -1;
    const key = `${face.shader}|${atlas}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        shader: face.shader,
        atlas,
        positions: [],
        normals: [],
        texCoords: [],
        lightCoords: [],
        vertexLight: [],
        indices: [],
        faceRanges: [],
      };
      groups.set(key, group);
    }

    const start = group.indices.length;
    if (face.type === FaceType.PATCH) appendPatch(group, face, map, lightmaps, patchLevel);
    else appendFace(group, face, map, lightmaps);
    group.faceRanges.push({ face: index, start, count: group.indices.length - start });
    faceCount++;
  }

  return { groups, skyName, skyShader, cloudHeight, skyGroups, faceCount };
}

interface BuildContext {
  /** Grille d'eclairage de la carte, construite une fois pour toutes. */
  grid: LightGridTextures | null;
  map: BspMap;
  shaders: ShaderLibrary;
  textures: TextureLibrary;
  lightmaps: LightmapAtlas;
  options: WorldBuildOptions;
  animated: ((time: number) => void)[];
  emissiveSurfaces: EmissiveSurface[];
}

/** Transforme les lots en maillages prets a afficher. */
async function buildMeshes(
  groups: Map<string, GeometryGroup>,
  context: BuildContext,
  name: string,
): Promise<{ group: THREE.Group; triangles: number }> {
  const { map, shaders, textures, lightmaps, options } = context;
  const root = new THREE.Group();
  root.name = name;
  let triangles = 0;

  for (const group of groups.values()) {
    if (group.indices.length === 0) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(group.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(group.normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(group.texCoords, 2));

    const vertexLit = group.atlas < 0;
    if (!vertexLit) {
      geometry.setAttribute('uv1', new THREE.Float32BufferAttribute(group.lightCoords, 2));
    } else {
      geometry.setAttribute('vertexLight', new THREE.Float32BufferAttribute(group.vertexLight, 3));
    }
    geometry.setIndex(group.indices);
    geometry.computeBoundingSphere();

    const bspShader = map.shaders[group.shader];
    const shaderName = bspShader?.name ?? '';
    const summary = shaders.get(shaderName);
    const metadata = classifySurface(
      shaderName,
      summary,
      bspShader?.surfaceFlags ?? 0,
      bspShader?.contents ?? 0,
    );

    const textureName = summary?.texture ?? shaderName;
    const texture = await textures.load(textureName);
    const glow = summary?.glowTexture ? await textures.load(summary.glowTexture) : null;
    const animation = summary ? await animatedEmissive(summary, textures) : null;
    /*
     * Version HD de cette matiere, quand la chaine en a produit une. Le nom du
     * script passe avant celui de l'image : une lampe est declaree par un
     * script, et plusieurs scripts de puissances differentes partagent la meme
     * image. Chercher par l'image ferait briller les trois pareil.
     *
     * Le chargement n'est pas attendu. Les cartes HD d'une carte entiere
     * pesent des dizaines de megaoctets a decoder : les mettre sur le chemin
     * critique faisait attendre une minute devant un ecran de chargement. La
     * carte s'affiche donc avec ses textures d'origine, et chaque surface
     * passe en HD des que les siennes sont pretes.
     */
    const pending =
      options.hdMaterials === false || animation !== null
        ? null
        : hdMaterials
            .load(shaderName)
            .then((found) => found ?? hdMaterials.load(textureName));
    const common = {
      metadata,
      texture,
      glow,
      lightMap: vertexLit ? null : lightmaps.textures[group.atlas],
      lightMapIntensity: options.lightMapIntensity ?? Math.PI,
      vertexLit,
      vertexLightIntensity: (options.lightMapIntensity ?? Math.PI) * 0.9,
      normalScale: options.normalScale ?? 0.8,
      grid: context.grid,
      gridSpecular: options.gridSpecular ?? 0,
    };
    const material = createWorldMaterial({ ...common, hd: null });

    // Defilement des coordonnees : lave, eau, bandes lumineuses.
    if (metadata.scroll && texture?.map) {
      const scrolled = texture.map;
      scrolled.wrapS = scrolled.wrapT = THREE.RepeatWrapping;
      const [su, sv] = metadata.scroll;
      context.animated.push((time) => scrolled.offset.set((su * time) % 1, (sv * time) % 1));
    }

    const mesh = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(geometry, animation?.material ?? material);
    if (animation) context.animated.push(animation.update);
    mesh.name = shaderName;
    mesh.userData.surface = metadata;
    /*
     * Les deux materiaux sont retenus cote a cote : le mode de comparaison
     * passe de l'un a l'autre sans recharger la carte, ce qui est la seule
     * facon honnete de juger une direction artistique.
     */
    mesh.userData.materials = { redux: mesh.material, original: mesh.material };

    // Arrivee des cartes HD : un second materiau prend la place, sauf si le
    // joueur a demande de voir la version d'origine.
    void pending?.then((hd) => {
      if (!hd) return;
      const redux = createWorldMaterial({ ...common, hd });
      const materials = mesh.userData.materials as { redux: THREE.Material; original: THREE.Material };
      materials.redux = redux;
      if (mesh.material === materials.original && mesh.userData.keepOriginal !== true) {
        mesh.material = redux;
      }
    });
    mesh.userData.faceRanges = group.faceRanges;
    // Une partie mobile projette son ombre ; le decor fixe la recoit.
    /*
     * Le decor projette ses ombres, murs et colonnes compris. Les cartes
     * d'ombre etant dessinees une fois puis gardees, un decor immobile ne
     * coute rien a chaque image : c'est ce qui permet a une lampe de carte de
     * poser une vraie flaque de lumiere au lieu d'eclairer a travers un mur.
     * Le ciel et les surfaces lumineuses restent a part : l'un est un fond,
     * l'autre est une source.
     */
    mesh.castShadow = !metadata.isSky && !metadata.isEmissive;
    mesh.receiveShadow = !metadata.isSky && !metadata.isEmissive;
    mesh.frustumCulled = true;
    root.add(mesh);
    triangles += group.indices.length / 3;

    if (metadata.isEmissive) collectEmissive(geometry, metadata, material, context.emissiveSurfaces);
    if (animation) material.dispose();
  }

  return { group: root, triangles };
}

export async function buildWorld(
  map: BspMap,
  shaders: ShaderLibrary,
  textures: TextureLibrary,
  options: WorldBuildOptions = {},
): Promise<BuiltWorld> {
  const patchLevel = options.patchLevel ?? 8;
  const lightmaps = new LightmapAtlas(map, options.lightmapOverbright ?? 2);
  const animated: ((time: number) => void)[] = [];
  const emissiveSurfaces: EmissiveSurface[] = [];

  // Les faces de tous les modeles sont triees d'abord, de facon a ne charger
  // les images qu'une seule fois pour l'ensemble de la carte.
  const collected = map.models.map((model) =>
    collectGroups(map, shaders, lightmaps, patchLevel, model.firstFace, model.faceCount),
  );
  const skyName = collected.find((entry) => entry.skyName)?.skyName ?? null;
  const skyShader = collected.find((entry) => entry.skyShader)?.skyShader ?? null;
  const cloudHeight = collected.find((entry) => entry.skyShader)?.cloudHeight ?? 512;

  const needed = new Set<string>();
  for (const entry of collected) {
    for (const group of entry.groups.values()) {
      const name = map.shaders[group.shader]?.name;
      if (!name) continue;
      const summary = shaders.get(name);
      needed.add(summary?.texture ?? name);
      if (summary?.glowTexture) needed.add(summary.glowTexture);
    }
  }
  await loadInBatches([...needed], textures, options.onProgress);

  /*
   * Grille d'eclairage : elle donne a chaque point du decor la direction de sa
   * lumiere dominante, ce que la lightmap ne porte pas. Sans elle, les reflets
   * n'existent pas et les materiaux ne se voient pas.
   */
  const grid = (options.gridSpecular ?? 0) > 0 ? buildLightGridTextures(map) : null;
  const context: BuildContext = {
    map,
    shaders,
    textures,
    lightmaps,
    options,
    animated,
    emissiveSurfaces,
    grid,
  };
  const root = new THREE.Group();
  root.name = 'world';
  const brushModels: THREE.Group[] = [];
  let triangles = 0;
  let faceCount = 0;
  let groupCount = 0;

  for (let index = 0; index < collected.length; index++) {
    const entry = collected[index];
    faceCount += entry.faceCount;
    groupCount += entry.groups.size;
    const built = await buildMeshes(entry.groups, context, index === 0 ? 'worldspawn' : `model*${index}`);
    triangles += built.triangles;
    brushModels.push(built.group);
    root.add(built.group);
    if (index % 8 === 0) options.onProgress?.('geometrie', index + 1, collected.length);
  }

  // Les faces de ciel forment un seul maillage, sans eclairage ni brouillard.
  const skyMesh = buildSkyMesh(collected.flatMap((entry) => [...entry.skyGroups.values()]));
  if (skyMesh) root.add(skyMesh);

  return {
    root,
    skyShader,
    cloudHeight,
    skyMesh,
    brushModels,
    animated,
    sky: null,
    skyColor: new THREE.Color('#10131a'),
    emissiveSurfaces,
    skyName,
    stats: {
      faces: faceCount,
      triangles,
      groups: groupCount,
      textures: textures.size,
      emissive: emissiveSurfaces.length,
    },
  };
}

/**
 * Rassemble les faces de ciel en un seul maillage. Son materiau est pose
 * ensuite, une fois connue la facon dont la carte decrit son ciel.
 */
function buildSkyMesh(groups: GeometryGroup[]): THREE.Mesh | null {
  const positions: number[] = [];
  const normals: number[] = [];
  const texCoords: number[] = [];
  const indices: number[] = [];

  for (const group of groups) {
    const base = positions.length / 3;
    positions.push(...group.positions);
    normals.push(...group.normals);
    texCoords.push(...group.texCoords);
    for (const index of group.indices) indices.push(base + index);
  }
  if (indices.length === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(texCoords, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();

  const mesh = new THREE.Mesh(
    geometry,
    // Fond et non paroi : le ciel n'ecrit pas la profondeur.
    new THREE.MeshBasicMaterial({ color: 0x0b0e13, fog: false, depthWrite: false }),
  );
  mesh.name = 'skyfaces';
  mesh.frustumCulled = false;
  // Le ciel se dessine avant le reste : il ne masque jamais le decor.
  mesh.renderOrder = -1000;
  return mesh;
}

/** Retient le centre d'une surface lumineuse, pour y poser une lampe ensuite. */
/**
 * Retient les endroits lumineux d'un lot de surfaces, pour y poser des lampes.
 *
 * Un lot rassemble toutes les faces qui partagent un materiau : les vingt
 * flammes d'une carte n'en forment qu'un seul, disperse d'un bout a l'autre.
 * Prendre le centre du lot donnerait une lampe au milieu de nulle part. Les
 * sommets sont donc regroupes par cellules de l'espace, et chaque amas donne
 * une lampe, a sa place et a sa taille.
 */
function collectEmissive(
  geometry: THREE.BufferGeometry,
  metadata: SurfaceMetadata,
  material: THREE.MeshStandardMaterial,
  out: EmissiveSurface[],
): void {
  const positions = geometry.getAttribute('position');
  if (!positions || metadata.emissiveStrength <= 0.05) return;

  // Cellules de deux cent cinquante-six unites : deux lampes d'une meme salle
  // restent distinctes, les faces d'une meme flamme se rejoignent.
  const CELL = 256;
  const clusters = new Map<string, { sum: [number, number, number]; count: number; min: [number, number, number]; max: [number, number, number] }>();

  // Un sommet sur quatre suffit a placer une lampe, et une surface de lave
  // peut en compter des milliers.
  const step = Math.max(1, Math.floor(positions.count / 2000));
  for (let index = 0; index < positions.count; index += step) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const key = `${Math.floor(x / CELL)}:${Math.floor(y / CELL)}:${Math.floor(z / CELL)}`;
    const cluster = clusters.get(key);
    if (!cluster) {
      clusters.set(key, { sum: [x, y, z], count: 1, min: [x, y, z], max: [x, y, z] });
      continue;
    }
    cluster.sum[0] += x;
    cluster.sum[1] += y;
    cluster.sum[2] += z;
    cluster.count++;
    for (let axis = 0; axis < 3; axis++) {
      const value = axis === 0 ? x : axis === 1 ? y : z;
      cluster.min[axis] = Math.min(cluster.min[axis], value);
      cluster.max[axis] = Math.max(cluster.max[axis], value);
    }
  }

  for (const cluster of clusters.values()) {
    const size = Math.hypot(
      cluster.max[0] - cluster.min[0],
      cluster.max[1] - cluster.min[1],
      cluster.max[2] - cluster.min[2],
    );
    out.push({
      position: [
        cluster.sum[0] / cluster.count,
        cluster.sum[1] / cluster.count,
        cluster.sum[2] / cluster.count,
      ],
      color: material.emissive.clone(),
      strength: metadata.emissiveStrength,
      // La portee suit la taille de l'amas, entre une lampe murale et un lac
      // de lave, et reste bornee.
      radius: Math.min(900, Math.max(192, size * 1.6 + 128)),
    });
  }
}

/** Face plate ou maillage : les indices sont relatifs au premier sommet. */
function appendFace(group: GeometryGroup, face: BspFace, map: BspMap, lightmaps: LightmapAtlas): void {
  const base = group.positions.length / 3;
  const placement = face.lightmap >= 0 ? lightmaps.placement(face.lightmap) : null;
  const vertices = map.vertices;

  for (let i = 0; i < face.vertexCount; i++) {
    const index = face.firstVertex + i;
    group.positions.push(
      vertices.positions[index * 3],
      vertices.positions[index * 3 + 1],
      vertices.positions[index * 3 + 2],
    );
    group.normals.push(
      vertices.normals[index * 3],
      vertices.normals[index * 3 + 1],
      vertices.normals[index * 3 + 2],
    );
    group.texCoords.push(vertices.texCoords[index * 2], vertices.texCoords[index * 2 + 1]);
    pushLightCoord(group, vertices.lightCoords[index * 2], vertices.lightCoords[index * 2 + 1], placement);
    pushVertexLight(
      group,
      vertices.colors[index * 4],
      vertices.colors[index * 4 + 1],
      vertices.colors[index * 4 + 2],
    );
  }

  /*
   * Ordre des sommets. Les triangles de la carte tournent dans le sens
   * contraire de celui qu'attend le moteur de rendu : mesure faite sur les
   * 5823 faces polygonales de q3dm7, toutes donnaient une normale geometrique
   * opposee a la normale de plan declaree par la face. Les murs etaient donc
   * pris pour des faces arriere et supprimes, ce qui laissait voir a travers
   * eux jusqu'a l'arriere des murs d'en face.
   */
  for (let i = 0; i + 2 < face.meshVertCount; i += 3) {
    group.indices.push(
      base + map.meshVerts[face.firstMeshVert + i],
      base + map.meshVerts[face.firstMeshVert + i + 2],
      base + map.meshVerts[face.firstMeshVert + i + 1],
    );
  }
}

/** Surface courbe : on la decoupe avant de l'ajouter au lot. */
function appendPatch(
  group: GeometryGroup,
  face: BspFace,
  map: BspMap,
  lightmaps: LightmapAtlas,
  level: number,
): void {
  if (face.patchSize[0] < 3 || face.patchSize[1] < 3) return;
  const base = group.positions.length / 3;
  const placement = face.lightmap >= 0 ? lightmaps.placement(face.lightmap) : null;
  const patch = tessellatePatch(face, map.vertices, level);

  for (let i = 0; i < patch.positions.length / 3; i++) {
    group.positions.push(patch.positions[i * 3], patch.positions[i * 3 + 1], patch.positions[i * 3 + 2]);
    group.normals.push(patch.normals[i * 3], patch.normals[i * 3 + 1], patch.normals[i * 3 + 2]);
    group.texCoords.push(patch.texCoords[i * 2], patch.texCoords[i * 2 + 1]);
    pushLightCoord(group, patch.lightCoords[i * 2], patch.lightCoords[i * 2 + 1], placement);
    pushVertexLight(group, patch.colors[i * 4], patch.colors[i * 4 + 1], patch.colors[i * 4 + 2]);
  }
  for (const index of patch.indices) group.indices.push(base + index);
}

/** Les couleurs de la carte sont en espace d'affichage : le rendu les veut lineaires. */
function pushVertexLight(group: GeometryGroup, r: number, g: number, b: number): void {
  group.vertexLight.push(srgbToLinear(r / 255), srgbToLinear(g / 255), srgbToLinear(b / 255));
}

function pushLightCoord(
  group: GeometryGroup,
  u: number,
  v: number,
  placement: { offsetU: number; offsetV: number; scale: number } | null,
): void {
  if (!placement) {
    group.lightCoords.push(0, 0);
    return;
  }
  group.lightCoords.push(placement.offsetU + u * placement.scale, placement.offsetV + v * placement.scale);
}

/** Charge les images par petits paquets pour ne pas saturer le navigateur. */
async function loadInBatches(
  names: string[],
  textures: TextureLibrary,
  onProgress?: (label: string, done: number, total: number) => void,
): Promise<void> {
  const batchSize = 8;
  for (let i = 0; i < names.length; i += batchSize) {
    await Promise.all(names.slice(i, i + batchSize).map((name) => textures.load(name)));
    onProgress?.('textures', Math.min(i + batchSize, names.length), names.length);
  }
}

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}
