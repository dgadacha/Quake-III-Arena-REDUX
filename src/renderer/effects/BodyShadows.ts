import * as THREE from 'three';

/**
 * Ombres portees des corps.
 *
 * Les lightmaps de la carte portent les ombres du decor, cuites une fois pour
 * toutes, et les cartes d'ombre des lampes sont rendues une seule fois par
 * affectation : un corps qui se deplace n'y figure jamais. Sans rien de plus,
 * les adversaires flottent au-dessus du sol, et c'est ce qui trahit le plus un
 * personnage pose dans un decor.
 *
 * Le jeu d'origine posait une tache sombre sous les pieds. Ici la silhouette
 * est vraiment dessinee : chaque combattant est rendu vu de dessus dans une
 * petite image, et cette image est projetee au sol sous lui. On voit donc les
 * jambes, les bras et l'arme, et non une ellipse.
 *
 * Une image par combattant plutot qu'un atlas decoupe : quelques kilo-octets
 * de plus, et plus aucune arithmetique de cases, de fenetre ni de rapport de
 * pixels, ou une erreur ne se voit pas mais fait disparaitre l'ombre.
 *
 * Deux details qui comptent : l'ombre s'affaiblit avec la hauteur, comme celle
 * du jeu, et son intensite suit la lumiere du lieu, que la grille sait donner.
 */

/** Cote de l'image d'une silhouette, en pixels. */
const SIZE = 128;
/** Demi-largeur couverte au sol, en unites de carte. */
const REACH = 40;
/** Au-dela de cette hauteur, l'ombre a disparu. */
const MAX_HEIGHT = 160;

export interface ShadowCaster {
  /** Objet a dessiner vu de dessus. */
  group: THREE.Object3D;
  /** Origine du combattant : le centre de la projection. */
  origin: [number, number, number];
  /** Point du sol trouve sous lui, et sa normale. */
  floor: { point: [number, number, number]; normal: [number, number, number] };
  /** Part de lumiere directionnelle du lieu, de zero a un. */
  contrast: number;
}

interface Projector {
  target: THREE.WebGLRenderTarget;
  quad: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
}

/**
 * Le corps est dessine a plat dans son image, sur fond blanc : l'image devient
 * alors un facteur de multiplication, blanc partout sauf sous le corps. La
 * teinte du corps porte la force de l'ombre, choisie avant chaque rendu.
 *
 * Ce detour evite de passer par le canal alpha : une carte d'opacite sur ce
 * materiau ne donnait rien, alors qu'une multiplication de couleur, chemin
 * que la bibliotheque emprunte pour les decalques, fonctionne du premier coup.
 *
 * Le materiau est pose sur chaque maillage le temps du rendu, puis retire : le
 * materiau impose de la bibliotheque ne s'applique qu'a une vraie scene, et
 * reste ignore sur un groupe.
 */
const FLAT = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });

export class BodyShadows {
  private readonly root = new THREE.Group();
  private readonly projectors: Projector[] = [];
  private readonly camera = new THREE.OrthographicCamera(-REACH, REACH, REACH, -REACH, 1, MAX_HEIGHT + 60);
  private readonly geometry = new THREE.PlaneGeometry(REACH * 2, REACH * 2);
  private readonly savedViewport = new THREE.Vector4();
  private readonly savedScissor = new THREE.Vector4();
  private readonly normal = new THREE.Vector3();
  private enabled = true;

  constructor(readonly capacity = 8) {
    this.root.name = 'body-shadows';
    this.camera.up.set(0, 1, 0);

    for (let i = 0; i < capacity; i++) {
      const target = new THREE.WebGLRenderTarget(SIZE, SIZE, { depthBuffer: true, stencilBuffer: false });
      target.texture.minFilter = THREE.LinearFilter;
      target.texture.magFilter = THREE.LinearFilter;
      target.texture.generateMipmaps = false;

      /*
       * Materiau ordinaire plutot qu'un shader maison : la silhouette sert de
       * carte d'opacite, la couleur est noire, et le melange habituel donne
       * exactement la multiplication voulue, la destination gardee moins
       * l'opacite. La carte d'opacite est lue dans le canal vert, ce que le
       * blanc de la silhouette satisfait.
       */
      const material = new THREE.MeshBasicMaterial({
        map: target.texture,
        transparent: true,
        // Multiplication : le blanc de l'image ne change rien, le gris du
        // corps assombrit le sol d'autant.
        blending: THREE.MultiplyBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });

      const quad = new THREE.Mesh(this.geometry, material);
      quad.visible = false;
      quad.frustumCulled = false;
      quad.renderOrder = 12;
      this.root.add(quad);
      this.projectors.push({ target, quad, material });
    }
  }

  attach(parent: THREE.Object3D): void {
    parent.add(this.root);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.root.visible = enabled;
  }

  /** Nombre d'ombres posees a la derniere image. */
  get activeCount(): number {
    return this.projectors.reduce((total, entry) => total + (entry.quad.visible ? 1 : 0), 0);
  }

  /** Image d'une silhouette, pour la mise au point. */
  silhouette(index: number): THREE.WebGLRenderTarget | null {
    return this.projectors[index]?.target ?? null;
  }

  /**
   * Dessine les silhouettes et place les projections. A appeler une fois par
   * image, avant le rendu de la scene : les images doivent etre a jour quand
   * les projections passent.
   */
  draw(renderer: THREE.WebGLRenderer, casters: ShadowCaster[]): void {
    for (const entry of this.projectors) entry.quad.visible = false;
    if (!this.enabled || casters.length === 0) return;

    /*
     * Le rendu hors ecran change la cible, la fenetre et le decoupage : ils
     * sont releves et remis a l'identique. La chaine de post-traitement pose
     * sa propre fenetre, qui ne fait pas la taille du canevas des que la
     * resolution interne n'est pas a cent pour cent, et la lui ecraser
     * recadre toute l'image.
     */
    const previousTarget = renderer.getRenderTarget();
    const previousScissorTest = renderer.getScissorTest();
    renderer.getViewport(this.savedViewport);
    renderer.getScissor(this.savedScissor);

    const count = Math.min(casters.length, this.projectors.length);
    for (let i = 0; i < count; i++) {
      const caster = casters[i];
      const entry = this.projectors[i];
      const height = caster.origin[2] - 24 - caster.floor.point[2];
      if (height > MAX_HEIGHT) continue;

      // Plus le corps est haut, plus l'ombre est faible : sautee, elle
      // disparait presque, comme dans le jeu.
      const fade = Math.max(0, 1 - Math.max(0, height) / MAX_HEIGHT);
      const strength = 0.62 * fade * fade * caster.contrast;
      if (strength < 0.02) continue;

      this.camera.position.set(caster.origin[0], caster.origin[1], caster.origin[2] + MAX_HEIGHT);
      this.camera.lookAt(caster.origin[0], caster.origin[1], caster.origin[2]);
      this.camera.updateProjectionMatrix();

      renderer.setRenderTarget(entry.target);
      // Fond blanc : hors du corps, la multiplication ne doit rien changer.
      renderer.setClearColor(0xffffff, 1);
      renderer.clear(true, true, false);
      // La force de l'ombre est la teinte du corps dans son image.
      FLAT.color.setScalar(1 - strength);
      /*
       * L'objet est rendu comme une scene a lui seul : les autres corps ne
       * doivent pas entrer dans son image.
       */
      this.flatten(caster.group, true);
      renderer.render(caster.group, this.camera);
      this.flatten(caster.group, false);

      entry.quad.position.set(caster.origin[0], caster.origin[1], caster.floor.point[2] + 0.7);
      // Posee sur la pente du sol : sur un escalier, une ombre horizontale
      // s'enfonce dans la marche suivante.
      this.normal.set(caster.floor.normal[0], caster.floor.normal[1], caster.floor.normal[2]).normalize();
      entry.quad.quaternion.setFromUnitVectors(UP, this.normal);
      entry.quad.visible = true;
    }

    renderer.setRenderTarget(previousTarget);
    renderer.setViewport(this.savedViewport);
    renderer.setScissor(this.savedScissor);
    renderer.setScissorTest(previousScissorTest);
  }

  /** Pose ou retire le materiau plat sur les maillages d'un corps. */
  private flatten(group: THREE.Object3D, on: boolean): void {
    group.traverse((object) => {
      const mesh = object as THREE.Mesh & { __shadowMaterial?: THREE.Material | THREE.Material[] };
      if (!mesh.isMesh) return;
      if (on) {
        mesh.__shadowMaterial = mesh.material;
        mesh.material = FLAT;
        return;
      }
      if (mesh.__shadowMaterial) {
        mesh.material = mesh.__shadowMaterial;
        mesh.__shadowMaterial = undefined;
      }
    });
  }

  dispose(): void {
    for (const entry of this.projectors) {
      entry.target.dispose();
      entry.material.dispose();
    }
    this.projectors.length = 0;
    this.geometry.dispose();
    this.root.clear();
    this.root.removeFromParent();
  }
}

const UP = new THREE.Vector3(0, 0, 1);
