import * as THREE from 'three';
import type { BspMap, Vec3 } from '../formats/bsp';

/**
 * Visibilite du decor. Une carte porte sa propre table de visibilite : pour
 * chaque groupe de feuilles, la liste de ceux qu'on peut voir depuis lui. Sans
 * elle, tout le decor est dessine, y compris l'exterieur des murs et l'arriere
 * des structures, ce qui donne des batiments qui semblent flotter sur du noir.
 *
 * Plutot que de decouper le decor en un maillage par feuille, ce qui
 * multiplierait les appels de rendu, chaque maillage garde ses indices complets
 * et n'expose que les plages des faces visibles. Le travail n'a lieu que
 * lorsque le joueur change de groupe de feuilles.
 */

interface TrackedMesh {
  mesh: THREE.Mesh;
  /** Indices d'origine, dans l'ordre de construction. */
  source: Uint32Array;
  ranges: { face: number; start: number; count: number }[];
  attribute: THREE.BufferAttribute;
  /** Tampon reutilise a chaque mise a jour. */
  active: Uint32Array;
}

export class BspVisibility {
  private readonly tracked: TrackedMesh[] = [];
  private readonly faceVisible: Uint8Array;
  /**
   * Faces qu'aucune feuille ne reference. Elles echappent a la table de
   * visibilite et doivent rester affichees, sans quoi il manque des morceaux
   * de murs et de sols.
   */
  private readonly alwaysVisible: Uint8Array;
  private lastCluster = -2;
  private drawnFaces = 0;
  private orphanCount = 0;

  constructor(private readonly map: BspMap, root: THREE.Object3D) {
    this.faceVisible = new Uint8Array(map.faces.length);
    this.alwaysVisible = new Uint8Array(map.faces.length);

    const referenced = new Uint8Array(map.faces.length);
    for (const leaf of map.leafs) {
      for (let i = 0; i < leaf.leafFaceCount; i++) {
        const face = map.leafFaces[leaf.firstLeafFace + i];
        if (face >= 0 && face < referenced.length) referenced[face] = 1;
      }
    }
    for (let face = 0; face < referenced.length; face++) {
      if (referenced[face] === 0) {
        this.alwaysVisible[face] = 1;
        this.orphanCount++;
      }
    }

    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const ranges = mesh.userData.faceRanges as TrackedMesh['ranges'] | undefined;
      const index = mesh.geometry.getIndex();
      if (!ranges || ranges.length === 0 || !index) return;

      const source = new Uint32Array(index.array as ArrayLike<number>);
      const active = new Uint32Array(source.length);
      // BufferAttribute garde le tableau fourni ; les variantes typees en font
      // une copie, et les ecritures n'atteindraient jamais la carte graphique.
      const attribute = new THREE.BufferAttribute(active, 1);
      attribute.setUsage(THREE.DynamicDrawUsage);
      mesh.geometry.setIndex(attribute);
      this.tracked.push({ mesh, source, ranges, attribute, active });
    });
  }

  get meshCount(): number {
    return this.tracked.length;
  }

  get visibleFaces(): number {
    return this.drawnFaces;
  }

  /** Nombre de faces hors table de visibilite, toujours affichees. */
  get unreferencedFaces(): number {
    return this.orphanCount;
  }

  /** Remet tout le decor a l'affichage : sert quand la visibilite est coupee. */
  showAll(): void {
    this.lastCluster = -2;
    for (const entry of this.tracked) {
      entry.active.set(entry.source);
      entry.attribute.needsUpdate = true;
      entry.mesh.geometry.setDrawRange(0, entry.source.length);
      /*
       * Un maillage dont aucune face n'etait visible avait ete retire du
       * rendu : le remettre a l'affichage fait partie du travail. Sans cela,
       * la capture des sondes de reflet, qui passe par ici, refletait un decor
       * amoindri de tout ce que le joueur ne voyait pas a cet instant.
       */
      entry.mesh.visible = true;
    }
    this.drawnFaces = this.map.faces.length;
  }

  /**
   * Met a jour l'affichage pour un point de vue. Ne fait rien tant que le
   * joueur reste dans le meme groupe de feuilles.
   */
  update(position: Vec3): boolean {
    if (this.map.clusterCount === 0) {
      if (this.lastCluster !== -1) {
        this.showAll();
        this.lastCluster = -1;
      }
      return false;
    }

    const leafIndex = this.map.findLeaf(position);
    const cluster = this.map.leafs[leafIndex]?.cluster ?? -1;
    if (cluster === this.lastCluster) return false;
    this.lastCluster = cluster;

    // Hors du decor, aucune feuille n'est de reference : tout est affiche.
    if (cluster < 0) {
      this.showAll();
      return true;
    }

    this.faceVisible.set(this.alwaysVisible);
    let faces = this.orphanCount;
    for (const leaf of this.map.leafs) {
      if (leaf.cluster < 0) continue;
      if (!this.map.clusterVisible(cluster, leaf.cluster)) continue;
      for (let i = 0; i < leaf.leafFaceCount; i++) {
        const face = this.map.leafFaces[leaf.firstLeafFace + i];
        if (face >= 0 && face < this.faceVisible.length && this.faceVisible[face] === 0) {
          this.faceVisible[face] = 1;
          faces++;
        }
      }
    }
    this.drawnFaces = faces;

    for (const entry of this.tracked) {
      let cursor = 0;
      for (const range of entry.ranges) {
        if (this.faceVisible[range.face] === 0) continue;
        entry.active.set(entry.source.subarray(range.start, range.start + range.count), cursor);
        cursor += range.count;
      }
      entry.attribute.needsUpdate = true;
      entry.mesh.geometry.setDrawRange(0, cursor);
      // Un maillage dont aucune face n'est visible ne passe plus par le GPU.
      entry.mesh.visible = cursor > 0;
    }
    return true;
  }
}
