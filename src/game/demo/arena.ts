import * as THREE from 'three';
import { Contents, type Vec3 } from '../../formats/bsp';
import { CollisionWorld, boxBrush, type CollisionBrush } from '../collision';
import { surfaceMaterial } from '../../renderer/materials/DemoMaterials';
import { RenderConfig } from '../../renderer/materials/DemoMaterials';
import type { Level, SpawnPoint } from '../level';
import type { SurfaceKind } from '../../renderer/materials/Procedural';

/**
 * Arene fabriquee par le code : elle ne demande aucun fichier et sert a la fois
 * de terrain de jeu et de banc d'essai pour la collision et le deplacement.
 * Chaque bloc pose en meme temps sa geometrie et son volume de collision.
 */

interface BlockOptions {
  kind: SurfaceKind;
  tint?: string;
  emissive?: string;
  /** Faces a ne pas dessiner, par exemple le dessous d'une dalle. */
  skip?: Face[];
  contents?: number;
  /** Bloc traversable : decor, eau, volume de declenchement. */
  solid?: boolean;
  opacity?: number;
  /** Bloc qui ne porte pas d'ombre : une grille laisse passer la lumiere. */
  shadow?: boolean;
}

type Face = 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-';

interface Batch {
  material: THREE.Material;
  positions: number[];
  normals: number[];
  uvs: number[];
  /** Ce lot porte-t-il une ombre ? */
  shadow: boolean;
}

class ArenaBuilder {
  private readonly batches = new Map<string, Batch>();
  readonly brushes: CollisionBrush[] = [];
  readonly lights: THREE.Light[] = [];

  block(mins: Vec3, maxs: Vec3, options: BlockOptions): void {
    const key = `${options.kind}:${options.tint ?? ''}:${options.emissive ?? ''}:${options.opacity ?? 1}:${options.shadow === false ? 'n' : 'y'}`;
    let batch = this.batches.get(key);
    if (!batch) {
      const material = surfaceMaterial(options.kind, {
        tint: options.tint,
        emissive: options.emissive,
        emissiveIntensity: options.emissive ? 1.4 : 1,
        transparent: (options.opacity ?? 1) < 1,
        opacity: options.opacity ?? 1,
      });
      batch = { material, positions: [], normals: [], uvs: [], shadow: options.shadow !== false };
      this.batches.set(key, batch);
    }
    this.pushBox(batch, mins, maxs, options.skip ?? []);

    if (options.solid !== false) {
      this.brushes.push(boxBrush(mins, maxs, options.contents ?? Contents.SOLID));
    } else if (options.contents) {
      this.brushes.push(boxBrush(mins, maxs, options.contents));
    }
  }

  /*
   * Une lampe de l'arene. L'attenuation est lineaire, comme dans le jeu
   * d'origine : une decroissance en carre de la distance, physiquement juste,
   * demanderait des intensites enormes et laisserait le decor dans le noir des
   * qu'on s'eloigne d'un metre.
   */
  light(position: Vec3, color: string, intensity: number, distance: number): void {
    const light = new THREE.PointLight(new THREE.Color(color), intensity, distance, 1);
    light.position.set(position[0], position[1], position[2]);
    this.lights.push(light);
  }

  /** Six quadrilateres, avec des coordonnees de texture a l'echelle du monde. */
  private pushBox(batch: Batch, mins: Vec3, maxs: Vec3, skip: Face[]): void {
    const faces: { face: Face; normal: Vec3; corners: Vec3[]; axes: [number, number] }[] = [
      {
        face: 'z+',
        normal: [0, 0, 1],
        corners: [
          [mins[0], mins[1], maxs[2]],
          [maxs[0], mins[1], maxs[2]],
          [maxs[0], maxs[1], maxs[2]],
          [mins[0], maxs[1], maxs[2]],
        ],
        axes: [0, 1],
      },
      {
        face: 'z-',
        normal: [0, 0, -1],
        corners: [
          [mins[0], maxs[1], mins[2]],
          [maxs[0], maxs[1], mins[2]],
          [maxs[0], mins[1], mins[2]],
          [mins[0], mins[1], mins[2]],
        ],
        axes: [0, 1],
      },
      {
        face: 'x+',
        normal: [1, 0, 0],
        corners: [
          [maxs[0], mins[1], mins[2]],
          [maxs[0], maxs[1], mins[2]],
          [maxs[0], maxs[1], maxs[2]],
          [maxs[0], mins[1], maxs[2]],
        ],
        axes: [1, 2],
      },
      {
        face: 'x-',
        normal: [-1, 0, 0],
        corners: [
          [mins[0], maxs[1], mins[2]],
          [mins[0], mins[1], mins[2]],
          [mins[0], mins[1], maxs[2]],
          [mins[0], maxs[1], maxs[2]],
        ],
        axes: [1, 2],
      },
      {
        face: 'y+',
        normal: [0, 1, 0],
        corners: [
          [maxs[0], maxs[1], mins[2]],
          [mins[0], maxs[1], mins[2]],
          [mins[0], maxs[1], maxs[2]],
          [maxs[0], maxs[1], maxs[2]],
        ],
        axes: [0, 2],
      },
      {
        face: 'y-',
        normal: [0, -1, 0],
        corners: [
          [mins[0], mins[1], mins[2]],
          [maxs[0], mins[1], mins[2]],
          [maxs[0], mins[1], maxs[2]],
          [mins[0], mins[1], maxs[2]],
        ],
        axes: [0, 2],
      },
    ];

    for (const entry of faces) {
      if (skip.includes(entry.face)) continue;
      const [u, v] = entry.axes;
      const quad = entry.corners;
      const order = [0, 1, 2, 0, 2, 3];
      for (const index of order) {
        const corner = quad[index];
        batch.positions.push(corner[0], corner[1], corner[2]);
        batch.normals.push(entry.normal[0], entry.normal[1], entry.normal[2]);
        batch.uvs.push(corner[u] * RenderConfig.textureScale, corner[v] * RenderConfig.textureScale);
      }
    }
  }

  build(): THREE.Group {
    const group = new THREE.Group();
    for (const batch of this.batches.values()) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(batch.positions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(batch.normals, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(batch.uvs, 2));
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, batch.material);
      mesh.castShadow = batch.shadow;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    for (const light of this.lights) group.add(light);
    return group;
  }
}

/**
 * Trace une arene symetrique : une cour a ciel ouvert, une plateforme centrale
 * accessible par deux rampes, une coursive en hauteur et un bassin en contrebas.
 */
export function buildDemoArena(): Level {
  const builder = new ArenaBuilder();
  const HALF = 1024;
  const WALL = 32;
  const HEIGHT = 704;
  const PIT = { min: -320, max: 320, floor: -192, water: -64 };

  // Sol en quatre dalles : le vide central forme le bassin.
  const floorParts: [Vec3, Vec3][] = [
    [[-HALF, -HALF, -32], [HALF, PIT.min, 0]],
    [[-HALF, PIT.max, -32], [HALF, HALF, 0]],
    [[-HALF, PIT.min, -32], [PIT.min, PIT.max, 0]],
    [[PIT.max, PIT.min, -32], [HALF, PIT.max, 0]],
  ];
  for (const [mins, maxs] of floorParts) {
    builder.block(mins, maxs, { kind: 'floor', skip: ['z-'] });
  }

  // Bassin : parois et fond, puis le volume d'eau, traversable.
  builder.block([PIT.min, PIT.min, PIT.floor - 32], [PIT.max, PIT.max, PIT.floor], {
    kind: 'rock',
    skip: ['z-'],
  });
  for (const [mins, maxs] of [
    [[PIT.min - WALL, PIT.min - WALL, PIT.floor], [PIT.min, PIT.max + WALL, 0]] as [Vec3, Vec3],
    [[PIT.max, PIT.min - WALL, PIT.floor], [PIT.max + WALL, PIT.max + WALL, 0]] as [Vec3, Vec3],
    [[PIT.min, PIT.min - WALL, PIT.floor], [PIT.max, PIT.min, 0]] as [Vec3, Vec3],
    [[PIT.min, PIT.max, PIT.floor], [PIT.max, PIT.max + WALL, 0]] as [Vec3, Vec3],
  ]) {
    builder.block(mins, maxs, { kind: 'rock' });
  }
  builder.block([PIT.min, PIT.min, PIT.floor], [PIT.max, PIT.max, PIT.water], {
    kind: 'water',
    solid: false,
    contents: Contents.WATER,
    opacity: 0.55,
    skip: ['z-'],
  });

  // Murs d'enceinte.
  const walls: [Vec3, Vec3][] = [
    [[-HALF - WALL, -HALF - WALL, -32], [HALF + WALL, -HALF, HEIGHT]],
    [[-HALF - WALL, HALF, -32], [HALF + WALL, HALF + WALL, HEIGHT]],
    [[-HALF - WALL, -HALF, -32], [-HALF, HALF, HEIGHT]],
    [[HALF, -HALF, -32], [HALF + WALL, HALF, HEIGHT]],
  ];
  for (const [mins, maxs] of walls) builder.block(mins, maxs, { kind: 'metal' });

  // Bandeau decoratif a mi-hauteur sur les quatre murs.
  const trim = 256;
  for (const [mins, maxs] of [
    [[-HALF, -HALF - 8, trim], [HALF, -HALF + 8, trim + 32]] as [Vec3, Vec3],
    [[-HALF, HALF - 8, trim], [HALF, HALF + 8, trim + 32]] as [Vec3, Vec3],
    [[-HALF - 8, -HALF, trim], [-HALF + 8, HALF, trim + 32]] as [Vec3, Vec3],
    [[HALF - 8, -HALF, trim], [HALF + 8, HALF, trim + 32]] as [Vec3, Vec3],
  ]) {
    builder.block(mins, maxs, { kind: 'trim', solid: false });
  }

  // Quatre piliers, autant de repaires pour couper la ligne de vue.
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const x = sx * 640;
      const y = sy * 640;
      builder.block([x - 64, y - 64, -32], [x + 64, y + 64, 384], { kind: 'metal', tint: '#5b6068' });
      builder.block([x - 80, y - 80, 384], [x + 80, y + 80, 416], { kind: 'trim' });
      builder.light([x, y, 440], '#ffd9a0', 2600, 1400);
    }
  }

  // Passerelle traversant la cour d'est en ouest, au-dessus du bassin.
  const bridgeZ = 288;
  builder.block([-HALF, -96, bridgeZ], [HALF, 96, bridgeZ + 16], { kind: 'grate' });
  for (const side of [-1, 1]) {
    builder.block([-HALF, side * 96 - 8, bridgeZ + 16], [HALF, side * 96 + 8, bridgeZ + 64], {
      kind: 'trim',
      solid: false,
    });
  }

  // Deux escaliers menant a la passerelle depuis le nord et le sud.
  for (const side of [-1, 1]) {
    const steps = Math.ceil((bridgeZ + 16) / 16);
    for (let i = 0; i < steps; i++) {
      const z = -32 + i * 16;
      const y = side * (PIT.max + 64 + i * 24);
      builder.block(
        [-192, Math.min(y, y + side * 24), z] as Vec3,
        [192, Math.max(y, y + side * 24), z + 16] as Vec3,
        { kind: 'floor', tint: '#65625c' },
      );
    }
  }

  // Plateforme centrale au-dessus du bassin, atteignable en sautant.
  builder.block([-160, -160, 96], [160, 160, 128], { kind: 'metal', tint: '#70757e' });
  builder.block([-48, -48, 128], [48, 48, 144], { kind: 'glow', emissive: '#ff9a3c', solid: false });
  builder.light([0, 0, 200], '#ff9a3c', 3400, 1600);

  // Lampes murales.
  for (const side of [-1, 1]) {
    for (const along of [-512, 0, 512]) {
      builder.block([along - 48, side * HALF - 12, 480], [along + 48, side * HALF + 4, 520], {
        kind: 'glow',
        emissive: '#9fd8ff',
        solid: false,
      });
      builder.light([along, side * (HALF - 64), 500], '#9fd8ff', 1700, 1200);
      builder.block([side * HALF - 4, along - 48, 480], [side * HALF + 12, along + 48, 520], {
        kind: 'glow',
        emissive: '#9fd8ff',
        solid: false,
      });
      builder.light([side * (HALF - 64), along, 500], '#9fd8ff', 1700, 1200);
    }
  }

  // Plafond ouvert : une grille laisse passer la lumiere du ciel.
  builder.block([-HALF - WALL, -HALF - WALL, HEIGHT], [HALF + WALL, HALF + WALL, HEIGHT + 16], {
    kind: 'grate',
    solid: true,
    opacity: 1,
    shadow: false,
  });

  const spawns: SpawnPoint[] = [
    { origin: [-768, -768, 32], yaw: Math.PI * 0.25 },
    { origin: [768, -768, 32], yaw: Math.PI * 0.75 },
    { origin: [768, 768, 32], yaw: Math.PI * 1.25 },
    { origin: [-768, 768, 32], yaw: Math.PI * 1.75 },
    { origin: [0, -640, 32], yaw: Math.PI * 0.5 },
    { origin: [0, 640, 32], yaw: Math.PI * 1.5 },
  ];

  const root = builder.build();
  const sun = new THREE.DirectionalLight(new THREE.Color('#ffe9c4'), Math.PI * 1.1);
  sun.position.set(600, -900, 1600);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 64;
  sun.shadow.camera.far = 4096;
  const extent = 1400;
  sun.shadow.camera.left = -extent;
  sun.shadow.camera.right = extent;
  sun.shadow.camera.top = extent;
  sun.shadow.camera.bottom = -extent;
  sun.shadow.bias = -0.0009;
  root.add(sun);
  root.add(new THREE.HemisphereLight(new THREE.Color('#9fc4ff'), new THREE.Color('#3a3129'), Math.PI * 0.5));
  root.add(new THREE.AmbientLight(new THREE.Color('#2a2f38'), Math.PI * 0.6));

  return {
    name: "Arene de demonstration",
    root,
    collision: new CollisionWorld(builder.brushes),
    spawns,
    ambient: new THREE.Color('#2a2f38'),
    skyColor: new THREE.Color('#5b7fa6'),
    animated: [],
  };
}
