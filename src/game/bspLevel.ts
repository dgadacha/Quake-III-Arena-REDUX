import * as THREE from 'three';
import { BspMap, entityNumber, entityVector, type Vec3 } from '../formats/bsp';
import type { ShaderLibrary } from '../formats/shader';
import type { VirtualFileSystem } from '../formats/pk3';
import { buildWorld } from '../bsp/BSPRenderer';
import { DynamicLightManager } from '../renderer/lighting/DynamicLightManager';
import { ShadowManager } from '../renderer/lighting/ShadowManager';
import { createSkyBox } from '../renderer/SkyBox';
import { createSkyDome, createSkyLayerMaterial } from '../renderer/SkyLayers';
import { MoverManager } from './entities/Movers';
import { TriggerManager } from './entities/Triggers';
import { LightGrid } from '../bsp/LightGrid';
import { BspVisibility } from '../bsp/BSPVisibility';
import { TextureLibrary } from '../renderer/materials/TextureLibrary';
import { hdMaterials } from '../renderer/materials/HDMaterialLoader';
import type { ModernRenderSettings } from '../renderer/RenderSettings';
import type { Level, SpawnPoint } from './level';
import { Contents } from '../formats/bsp';
import { CollisionWorld, pointInsideBrush } from './collision';

export interface BspLoadOptions {
  settings: ModernRenderSettings;
  /** Anisotropie maximale acceptee par la carte graphique. */
  maxAnisotropy?: number;
  onProgress?: (label: string, done: number, total: number) => void;
}

/** Charge une carte du jeu et en fait un niveau jouable. */
export async function loadBspLevel(
  path: string,
  data: Uint8Array,
  vfs: VirtualFileSystem,
  shaders: ShaderLibrary,
  options: BspLoadOptions,
): Promise<Level & { map: BspMap; lights: DynamicLightManager }> {
  const name = path.split('/').pop()?.replace(/\.bsp$/i, '') ?? path;
  const settings = options.settings;
  options.onProgress?.('lecture', 0, 1);
  const map = new BspMap(data, name);

  const textures = new TextureLibrary(vfs);
  textures.deriveDetail = settings.deriveMaterialDetail;
  textures.anisotropy = Math.min(settings.anisotropy, options.maxAnisotropy ?? settings.anisotropy);

  // Materiaux HD produits par la chaine hors ligne. Le manifeste est lu une
  // fois ; son absence n'empeche rien, la carte garde ses textures d'origine.
  if (settings.hdMaterials) {
    hdMaterials.setAnisotropy(textures.anisotropy);
    await hdMaterials.open();
  }

  const built = await buildWorld(map, shaders, textures, {
    hdMaterials: settings.hdMaterials,
    gridSpecular: settings.gridSpecular,
    microDetail: settings.microDetail,
    patchLevel: settings.patchLevel,
    // L'eclairage indirect de Three passe par la loi de Lambert : sans ce
    // facteur, les lightmaps ressortent trois fois trop sombres.
    lightMapIntensity: Math.PI * settings.lightmapGain,
    lightmapOverbright: settings.lightmapOverbright,
    onProgress: options.onProgress,
  });

  const root = new THREE.Group();
  root.add(built.root);

  // Un fond d'ambiance discret : les lightmaps font le gros du travail.
  root.add(new THREE.AmbientLight(new THREE.Color('#2b3038'), Math.PI * settings.ambientGain));

  const shadows = new ShadowManager(settings);
  const hasSun = shadows.attach(root, map, shaders);
  const lights = new DynamicLightManager(settings.maxDynamicLights);
  if (settings.dynamicLights) {
    // Les lampes sont lues d'abord : le nombre de projecteurs que la carte
    // declare decide du partage de la reserve.
    lights.addMapLights(map);
    /*
     * Lanternes, flammes, lave et ecrans. Ce sont les sources que le joueur
     * voit, et jusqu'ici elles ne faisaient que briller : elles n'eclairaient
     * rien. Chaque amas lumineux releve dans la geometrie devient une lampe, a
     * sa place et a sa portee, et le gestionnaire n'allume que les plus proches.
     */
    lights.addSurfaceLights(built.emissiveSurfaces);
    lights.attach(root, settings.maxDynamicLights, shadows.dynamicShadowBudget, lights.coneCount);
  }

  const animated = [
    ...built.animated,
    (_time: number, viewer: Vec3, delta: number) => {
      lights.update(delta, viewer);
      shadows.refresh(delta);
    },
  ];

  /*
   * Ciel de la carte. Deux cas, tous deux prevus par les scripts d'origine :
   * six images formant une boite placee autour du joueur, ou des couches de
   * nuages plaquees sur les faces de ciel de la carte. Sans l'un ou l'autre,
   * le fond reste noir, ce qui se voit beaucoup dans les cartes ouvertes.
   */
  let skyInstalled = false;
  if (built.skyName) {
    const sky = await createSkyBox(built.skyName, textures);
    if (sky) {
      root.add(sky.mesh);
      animated.push((_time, viewer) => sky.follow(new THREE.Vector3(viewer[0], viewer[1], viewer[2])));
      skyInstalled = true;
      // La boite suffit : les faces de ciel de la carte n'ont plus a etre vues.
      if (built.skyMesh) built.skyMesh.visible = false;
    }
  }

  if (!skyInstalled && built.skyShader && built.skyMesh) {
    const definition = shaders.definition(built.skyShader);
    const material = definition
      ? await createSkyLayerMaterial({ definition, textures, cloudHeight: built.cloudHeight })
      : null;
    if (material) {
      built.skyMesh.material = material;
      const dome = createSkyDome(material);
      root.add(dome);
      const uniforms = material.uniforms as Record<string, { value: unknown }>;
      animated.push((time, viewer) => {
        uniforms.time.value = time;
        (uniforms.viewer.value as THREE.Vector3).set(viewer[0], viewer[1], viewer[2] + 26);
        dome.position.set(viewer[0], viewer[1], viewer[2] + 26);
      });
    }
  }
  /*
   * Visibilite du decor fixe. Les parties mobiles restent toujours affichees :
   * elles ne figurent pas dans les feuilles de l'arbre.
   */
  const visibility = new BspVisibility(map, built.brushModels[0] ?? built.root);
  visibility.showAll();
  animated.push((_time, viewer) => {
    // Le point de vue est celui des yeux, pas celui des pieds.
    visibility.update([viewer[0], viewer[1], viewer[2] + 26]);
  });

  const spawns = readSpawns(map);
  const collision = CollisionWorld.fromMap(map);
  const grid = new LightGrid(map);

  // Portes, plateformes et panneaux : geometrie deja construite, mouvement ici.
  const movers = new MoverManager(map, built.brushModels, collision);
  animated.push((time, viewer, delta) => movers.update(time, delta, viewer));
  const triggers = new TriggerManager(map);

  // Volumes de brouillard : un volume marque brouillard, dont le script donne
  // la couleur et la distance a laquelle le fond disparait.
  const fogVolumes: { brush: (typeof collision.brushes)[number]; color: THREE.Color; depthForOpaque: number }[] = [];
  for (let index = 0; index < map.brushes.length; index++) {
    const brush = map.brushes[index];
    if ((brush.contents & Contents.FOG) === 0) continue;
    const fog = shaders.get(map.shaders[brush.shader]?.name ?? '')?.fog;
    if (!fog) continue;
    fogVolumes.push({
      brush: collision.brushes[index],
      color: new THREE.Color(fog.color[0], fog.color[1], fog.color[2]),
      depthForOpaque: Math.max(64, fog.distance),
    });
  }
  const fogAt = (point: Vec3) => {
    for (const volume of fogVolumes) {
      if (pointInsideBrush(point, volume.brush)) {
        return { color: volume.color, depthForOpaque: volume.depthForOpaque };
      }
    }
    return null;
  };

  return {
    name,
    map,
    vfs,
    textures,
    lights,
    root,
    collision,
    spawns,
    ambient: new THREE.Color('#0d1015'),
    skyColor: built.skyColor,
    animated,
    sky: built.sky,
    hasSun,
    grid,
    movers,
    triggers,
    visibility,
    fogAt,
    // Une marge sous le decor : en dessous, c'est la chute sans retour.
    floor: (map.models[0]?.mins[2] ?? -4096) - 512,
  } as Level & {
    map: BspMap;
    lights: DynamicLightManager;
    sky: THREE.Texture | null;
    hasSun: boolean;
    grid: LightGrid;
    movers: MoverManager;
    triggers: TriggerManager;
    visibility: BspVisibility;
  };
}

/** Points de depart poses dans la carte, toutes variantes de jeu confondues. */
function readSpawns(map: BspMap): SpawnPoint[] {
  const classes = [
    'info_player_deathmatch',
    'team_ctf_redspawn',
    'team_ctf_bluespawn',
    'info_player_start',
    'info_player_intermission',
  ];
  const spawns: SpawnPoint[] = [];
  for (const classname of classes) {
    for (const entity of map.entitiesOfClass(classname)) {
      const origin = entityVector(entity, 'origin');
      // Le jeu releve le point de depart de neuf unites avant d'y poser le joueur.
      const angle = entityNumber(entity, 'angle', 0);
      spawns.push({ origin: [origin[0], origin[1], origin[2] + 9] as Vec3, yaw: (angle * Math.PI) / 180 });
    }
    if (spawns.length > 0 && classname === 'info_player_deathmatch') break;
  }
  if (spawns.length === 0) spawns.push({ origin: [0, 0, 64], yaw: 0 });
  return spawns;
}
