import * as THREE from 'three';

/**
 * Traces d'impact. Elles sont posees sur un carre oriente selon la surface
 * touchee, legerement decolle pour ne pas se disputer la profondeur avec elle.
 *
 * Toutes les traces d'une meme famille partagent un seul maillage instancie :
 * quatre-vingt-seize traces coutaient autant d'appels de rendu, elles en
 * coutent maintenant deux, un par image de trace. La couleur et le fondu sont
 * portes par instance.
 *
 * Le nombre de traces est borne : au-dela, la plus ancienne disparait, apres un
 * fondu qui evite qu'une marque s'efface brutalement sous les yeux du joueur.
 */

export type DecalKind = 'bullet' | 'burn' | 'plasma' | 'rail' | 'blood';

export interface DecalSpec {
  position: THREE.Vector3;
  normal: THREE.Vector3;
  size: number;
  kind: DecalKind;
  /** Duree de vie, en secondes ; le fondu occupe le dernier quart. */
  lifetime?: number;
}

/** Deux familles d'images : un impact net, une brulure diffuse. */
type DecalFamily = 'mark' | 'scorch';

interface Batch {
  mesh: THREE.InstancedMesh;
  fades: THREE.InstancedBufferAttribute;
  capacity: number;
  count: number;
}

interface Decal {
  family: DecalFamily;
  slot: number;
  age: number;
  lifetime: number;
  active: boolean;
  color: THREE.Color;
  matrix: THREE.Matrix4;
}

const COLORS: Record<DecalKind, number> = {
  bullet: 0x1b1b1b,
  burn: 0x120d0a,
  plasma: 0x2a3f6b,
  rail: 0x2b2b38,
  blood: 0x4a0d0d,
};

const FAMILIES: Record<DecalKind, DecalFamily> = {
  bullet: 'mark',
  rail: 'mark',
  burn: 'scorch',
  plasma: 'scorch',
  blood: 'scorch',
};

const UP = new THREE.Vector3(0, 0, 1);

export class DecalManager {
  private readonly batches: Record<DecalFamily, Batch>;
  private readonly decals: Decal[] = [];
  private readonly root = new THREE.Group();
  private readonly quaternion = new THREE.Quaternion();
  private readonly spin = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private cursor = 0;
  private live = 0;

  constructor(readonly capacity = 96) {
    this.root.name = 'decals';
    const half = Math.max(8, Math.ceil(capacity / 2));
    this.batches = {
      mark: this.createBatch(markTexture(), half),
      scorch: this.createBatch(scorchTexture(), half),
    };
    for (const batch of Object.values(this.batches)) this.root.add(batch.mesh);

    for (let i = 0; i < capacity; i++) {
      this.decals.push({
        family: 'mark',
        slot: -1,
        age: 0,
        lifetime: 0,
        active: false,
        color: new THREE.Color(),
        matrix: new THREE.Matrix4(),
      });
    }
  }

  get activeCount(): number {
    return this.live;
  }

  attach(parent: THREE.Object3D): void {
    parent.add(this.root);
  }

  /** Pose une trace, en reprenant la plus ancienne si la reserve est pleine. */
  add(spec: DecalSpec): void {
    const decal = this.decals[this.cursor];
    this.cursor = (this.cursor + 1) % this.decals.length;

    const family = FAMILIES[spec.kind];
    decal.family = family;
    decal.active = true;
    decal.age = 0;
    decal.lifetime = spec.lifetime ?? 30;
    decal.color.setHex(COLORS[spec.kind]);

    // Carre tourne vers la surface, puis pivote au hasard sur son axe.
    this.quaternion.setFromUnitVectors(UP, spec.normal);
    this.spin.setFromAxisAngle(spec.normal, Math.random() * Math.PI * 2);
    this.quaternion.premultiply(this.spin);
    // Legerement devant la surface, dans l'axe de sa normale.
    this.position.copy(spec.position).addScaledVector(spec.normal, 0.35);
    this.scale.setScalar(spec.size);
    decal.matrix.compose(this.position, this.quaternion, this.scale);
  }

  update(delta: number): void {
    const counts: Record<DecalFamily, number> = { mark: 0, scorch: 0 };
    let live = 0;

    for (const decal of this.decals) {
      if (!decal.active) continue;
      decal.age += delta;
      if (decal.age >= decal.lifetime) {
        decal.active = false;
        continue;
      }

      const batch = this.batches[decal.family];
      const slot = counts[decal.family];
      if (slot >= batch.capacity) continue;
      counts[decal.family] = slot + 1;

      // Fondu sur le dernier quart de la duree de vie.
      const remaining = 1 - decal.age / decal.lifetime;
      batch.mesh.setMatrixAt(slot, decal.matrix);
      batch.mesh.setColorAt(slot, decal.color);
      batch.fades.setX(slot, remaining < 0.25 ? remaining / 0.25 : 1);
      live++;
    }

    for (const family of ['mark', 'scorch'] as DecalFamily[]) {
      const batch = this.batches[family];
      batch.count = counts[family];
      batch.mesh.count = counts[family];
      batch.mesh.visible = counts[family] > 0;
      if (counts[family] === 0) continue;
      batch.mesh.instanceMatrix.needsUpdate = true;
      if (batch.mesh.instanceColor) batch.mesh.instanceColor.needsUpdate = true;
      batch.fades.needsUpdate = true;
    }
    this.live = live;
  }

  clear(): void {
    for (const decal of this.decals) decal.active = false;
    for (const family of ['mark', 'scorch'] as DecalFamily[]) {
      const batch = this.batches[family];
      batch.count = 0;
      batch.mesh.count = 0;
      batch.mesh.visible = false;
    }
    this.live = 0;
  }

  private createBatch(map: THREE.Texture, capacity: number): Batch {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const fades = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    fades.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aFade', fades);

    const material = new THREE.MeshBasicMaterial({
      map,
      transparent: true,
      depthWrite: false,
      // La trace est plaquee sur une surface existante : sans ce decalage,
      // elle clignoterait avec elle selon l'angle de vue.
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      fog: false,
    });
    applyInstanceFade(material);

    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    // Chaque instance porte sa couleur : une seule famille suffit par image.
    mesh.setColorAt(0, new THREE.Color(0xffffff));

    return { mesh, fades, capacity, count: 0 };
  }
}

/** Opacite par instance : un attribut de plus, lu dans le shader. */
function applyInstanceFade(material: THREE.Material): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n        attribute float aFade;\n        varying float vFade;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n        vFade = aFade;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n        varying float vFade;')
      .replace(
        '#include <dithering_fragment>',
        '#include <dithering_fragment>\n        gl_FragColor.a *= vFade;',
      );
  };
  material.customProgramCacheKey = () => 'decal-instanced';
}

/** Petit impact : un centre marque, des bords irreguliers. */
function markTexture(): THREE.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  const center = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - center) / center;
      const dy = (y - center) / center;
      const distance = Math.hypot(dx, dy);
      const edge = 0.7 + 0.3 * Math.sin(Math.atan2(dy, dx) * 5 + distance * 3);
      const value = Math.max(0, 1 - distance / edge);
      const at = (y * size + x) * 4;
      data[at] = data[at + 1] = data[at + 2] = 255;
      data[at + 3] = Math.round(Math.pow(value, 0.6) * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

/** Brulure large, plus diffuse sur les bords. */
function scorchTexture(): THREE.DataTexture {
  const size = 96;
  const data = new Uint8Array(size * size * 4);
  const center = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - center) / center;
      const dy = (y - center) / center;
      const distance = Math.hypot(dx, dy);
      const edge = 0.62 + 0.38 * Math.sin(Math.atan2(dy, dx) * 4 + distance * 6);
      const value = Math.max(0, 1 - distance / edge);
      const at = (y * size + x) * 4;
      data[at] = data[at + 1] = data[at + 2] = 255;
      data[at + 3] = Math.round(Math.pow(value, 1.6) * 235);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}
