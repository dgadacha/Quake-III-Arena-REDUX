import * as THREE from 'three';
import type { Md3Model, Md3Surface } from '../formats/md3';
import type { ShaderLibrary } from '../formats/shader';
import { hdMaterials } from '../renderer/materials/HDMaterialLoader';
import type { TextureLibrary } from '../renderer/materials/TextureLibrary';
import { interpolateTag } from './MD3Tags';

/**
 * Affichage d'un modele MD3. Le format donne une pose complete par image ; le
 * melange entre deux poses se fait dans le shader, a partir de deux jeux
 * d'attributs. Le processeur ne recopie des sommets que lorsque la paire
 * d'images change, pas a chaque image, et les normales sont melangees de la
 * meme facon que les positions, sans quoi l'eclairage sauterait.
 */

interface SurfaceView {
  surface: Md3Surface;
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
  mesh: THREE.Mesh;
  position: THREE.BufferAttribute;
  positionNext: THREE.BufferAttribute;
  normal: THREE.BufferAttribute;
  normalNext: THREE.BufferAttribute;
  mixUniform: { value: number };
}

export class Md3Mesh {
  readonly group = new THREE.Group();
  private readonly views: SurfaceView[] = [];
  private frameA = -1;
  private frameB = -1;
  private mix = 0;

  constructor(readonly model: Md3Model) {
    this.group.name = model.name || 'md3';
    for (const surface of model.surfaces) this.views.push(this.createView(surface));
    this.setFrames(0, 0, 0);
  }

  /**
   * Charge les images de surface declarees par le modele.
   *
   * La version refaite passe d'abord : un modele est regarde de pres, son
   * arme plus que tout le reste, et une peau de deux cent cinquante-six
   * pixels s'y voit aussitot. A defaut, l'image d'origine, et le rendu reste
   * celui de 1999 sur cette surface.
   *
   * La decoupe vient du script du jeu, jamais du canal alpha de l'image. Le
   * BFG le montre : sa peau se pose sur un reflet par son alpha, et la
   * decouper perce l'arme.
   */
  async loadTextures(
    textures: TextureLibrary,
    shaders: ShaderLibrary | null = null,
    /**
     * Correspondance surface vers image, lue dans un .skin. Les modeles de
     * personnages ne declarent pas leurs images dans le fichier lui-meme :
     * c'est la peau qui les donne, et c'est ainsi qu'un meme corps se decline
     * en plusieurs tenues.
     */
    skin: Map<string, string> | null = null,
  ): Promise<void> {
    // Le manifeste peut n'avoir pas encore ete lu : un modele arrive parfois
    // avant la premiere surface de la carte.
    await hdMaterials.open();
    for (const view of this.views) {
      const name = skin?.get(view.surface.name) ?? view.surface.shaders[0];
      if (!name) continue;

      const hd = await hdMaterials.load(name);
      if (hd) {
        view.material.map = hd.map;
        view.material.normalMap = hd.normalMap;
        /*
         * Une seule texture porte l'occlusion, la rugosite et le metal : Three
         * lit un canal par propriete, les trois creneaux pointent donc sur
         * elle.
         */
        view.material.roughnessMap = hd.surfaceMap;
        view.material.metalnessMap = hd.surfaceMap;
        view.material.aoMap = hd.surfaceMap;
        view.material.metalness = hd.metalness;
        view.material.roughness = hd.roughnessMultiplier;
        if (hd.normalMap) {
          view.material.normalScale = new THREE.Vector2(hd.normalStrength, hd.normalStrength);
        }
        view.material.color.setHex(0xffffff);
        const hdScript = shaders?.get(name.replace(/\.(tga|jpg|jpeg|png)$/i, '')) ?? null;
        view.material.alphaTest = hdScript?.alphaTest ? 0.5 : 0;
        view.material.needsUpdate = true;
        continue;
      }

      const loaded = await textures.load(name);
      if (!loaded) continue;
      view.material.map = loaded.map;
      view.material.normalMap = loaded.normalMap;
      view.material.roughnessMap = loaded.roughnessMap;
      if (loaded.normalMap) view.material.normalScale = new THREE.Vector2(0.7, 0.7);
      view.material.color.setHex(0xffffff);
      const script = shaders?.get(name.replace(/\.(tga|jpg|jpeg|png)$/i, '')) ?? null;
      view.material.alphaTest = script?.alphaTest ? 0.5 : 0;
      view.material.needsUpdate = true;
    }
  }

  /**
   * Choisit la paire d'images affichee et leur melange. Les attributs ne sont
   * recopies que si la paire a change.
   */
  setFrames(frameA: number, frameB: number, mix: number): void {
    const total = this.model.frameCount;
    const a = clampFrame(frameA, total);
    const b = clampFrame(frameB, total);
    this.mix = Math.max(0, Math.min(1, mix));

    if (a !== this.frameA || b !== this.frameB) {
      this.frameA = a;
      this.frameB = b;
      for (const view of this.views) copyFrames(view, a, b);
    }
    for (const view of this.views) view.mixUniform.value = this.mix;
  }

  /** Materiaux des surfaces, pour qui veut les eclairer autrement. */
  get materials(): THREE.MeshStandardMaterial[] {
    return this.views.map((view) => view.material);
  }

  /** Matrice du repere demande, dans l'espace du modele. */
  tagMatrix(name: string, out: THREE.Matrix4): boolean {
    return interpolateTag(this.model, name, this.frameA, this.frameB, this.mix, out);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    for (const view of this.views) {
      view.geometry.dispose();
      view.material.dispose();
    }
    this.views.length = 0;
  }

  private createView(surface: Md3Surface): SurfaceView {
    const geometry = new THREE.BufferGeometry();
    const count = surface.vertexCount;

    const position = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    const positionNext = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    const normal = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    const normalNext = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    for (const attribute of [position, positionNext, normal, normalNext]) {
      attribute.setUsage(THREE.DynamicDrawUsage);
    }

    geometry.setAttribute('position', position);
    geometry.setAttribute('positionNext', positionNext);
    geometry.setAttribute('normal', normal);
    geometry.setAttribute('normalNext', normalNext);
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(surface.texCoords, 2));
    geometry.setIndex(new THREE.Uint16BufferAttribute(surface.indices, 1));

    const mixUniform = { value: 0 };
    const material = new THREE.MeshStandardMaterial({
      color: 0xb0b0b0,
      roughness: 0.6,
      metalness: 0.25,
    });
    applyFrameBlend(material, mixUniform);

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    this.group.add(mesh);

    return { surface, geometry, material, mesh, position, positionNext, normal, normalNext, mixUniform };
  }
}

/** Melange des deux poses dans le shader, positions et normales ensemble. */
function applyFrameBlend(material: THREE.Material, mixUniform: { value: number }): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.frameMix = mixUniform;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float frameMix;
        attribute vec3 positionNext;
        attribute vec3 normalNext;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        'vec3 objectNormal = normalize(mix(normal, normalNext, frameMix));',
      )
      .replace('#include <begin_vertex>', 'vec3 transformed = mix(position, positionNext, frameMix);');
  };
  material.customProgramCacheKey = () => 'md3-blend';
}

function copyFrames(view: SurfaceView, frameA: number, frameB: number): void {
  const { surface } = view;
  const stride = surface.vertexCount * 3;
  const fromA = frameA * stride;
  const fromB = frameB * stride;

  (view.position.array as Float32Array).set(surface.positions.subarray(fromA, fromA + stride));
  (view.positionNext.array as Float32Array).set(surface.positions.subarray(fromB, fromB + stride));
  (view.normal.array as Float32Array).set(surface.normals.subarray(fromA, fromA + stride));
  (view.normalNext.array as Float32Array).set(surface.normals.subarray(fromB, fromB + stride));

  view.position.needsUpdate = true;
  view.positionNext.needsUpdate = true;
  view.normal.needsUpdate = true;
  view.normalNext.needsUpdate = true;
  view.geometry.computeBoundingSphere();
}

function clampFrame(frame: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(total - 1, Math.round(frame)));
}

/**
 * Animation d'un modele : avance le temps et rend la paire d'images courante.
 * Les modeles d'armes et d'objets n'ont souvent qu'une pose ; les personnages
 * en ont plusieurs centaines, decoupees en sequences.
 */
export class Md3Animator {
  private time = 0;
  private first = 0;
  private count = 1;
  private loop = 1;
  private fps = 15;

  setSequence(firstFrame: number, frameCount: number, loopFrames: number, fps: number): void {
    this.first = firstFrame;
    this.count = Math.max(1, frameCount);
    this.loop = Math.max(0, loopFrames);
    this.fps = Math.max(1, fps);
    this.time = 0;
  }

  advance(delta: number): { frameA: number; frameB: number; mix: number } {
    this.time += delta * this.fps;
    let index = Math.floor(this.time);

    if (index >= this.count) {
      if (this.loop > 0) {
        // Sequence bouclee : on repart sur les dernieres images declarees.
        const looped = this.count - this.loop;
        index = looped + ((index - looped) % this.loop);
        this.time = index + (this.time % 1);
      } else {
        index = this.count - 1;
        this.time = index;
      }
    }

    const next = this.loop > 0 || index + 1 < this.count ? (index + 1) % this.count : index;
    return { frameA: this.first + index, frameB: this.first + next, mix: this.time % 1 };
  }
}
