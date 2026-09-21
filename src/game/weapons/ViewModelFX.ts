import * as THREE from 'three';

/**
 * Effets attaches a l'arme tenue en main : l'eclat du depart de coup et les
 * douilles ejectees.
 *
 * Ils vivent dans la scene de l'arme et non dans celle du monde. La raison est
 * simple : cette scene a sa propre camera, plus etroite, et sa profondeur est
 * remise a zero. Un eclat pose dans le monde a la position du canon serait a
 * la fois mal place et parfois masque par un mur proche, alors qu'il appartient
 * a l'arme.
 *
 * L'eclairage du monde par le tir, lui, reste dans le monde : c'est la lampe
 * tres courte que pose le systeme d'effets.
 */

/** Duree de l'eclat, en secondes. Le jeu tient dans une trentaine de millisecondes. */
const FLASH_SECONDS = 0.045;

/**
 * Image de l'eclat : un coeur blanc, une decroissance douce, et quelques rais.
 * Elle est dessinee une fois au lancement plutot que lue dans un fichier : le
 * motif est simple, et cela evite de dependre d'un asset.
 */
function flashTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) {
    const middle = size / 2;
    const gradient = context.createRadialGradient(middle, middle, 0, middle, middle, middle);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.18, 'rgba(255,238,200,0.92)');
    gradient.addColorStop(0.45, 'rgba(255,170,70,0.35)');
    gradient.addColorStop(1, 'rgba(255,120,30,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);

    // Rais : ils cassent le disque et donnent la forme d'un depart de coup.
    context.globalCompositeOperation = 'lighter';
    context.strokeStyle = 'rgba(255,230,180,0.55)';
    context.lineCap = 'round';
    for (let ray = 0; ray < 5; ray++) {
      const angle = (ray / 5) * Math.PI * 2 + Math.random() * 0.4;
      const length = middle * (0.55 + Math.random() * 0.45);
      context.lineWidth = 2 + Math.random() * 3;
      context.beginPath();
      context.moveTo(middle, middle);
      context.lineTo(middle + Math.cos(angle) * length, middle + Math.sin(angle) * length);
      context.stroke();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class ViewModelFlash {
  private readonly sprite: THREE.Mesh;
  private readonly light: THREE.PointLight;
  private readonly material: THREE.MeshBasicMaterial;
  private age = FLASH_SECONDS;
  private scale = 1;

  constructor(scene: THREE.Scene) {
    /*
     * Deux quadrilateres croises plutot qu'un seul : vu de biais, une simple
     * affiche disparaitrait, et l'arme est justement vue de trois quarts.
     */
    const geometry = new THREE.BufferGeometry();
    const plane = new THREE.PlaneGeometry(1, 1);
    const across = plane.clone().rotateY(Math.PI / 2);
    const merged = mergePlanes(plane, across);
    geometry.setAttribute('position', merged.position);
    geometry.setAttribute('uv', merged.uv);
    geometry.setIndex(merged.index);

    this.material = new THREE.MeshBasicMaterial({
      map: flashTexture(),
      color: new THREE.Color(1, 0.85, 0.5),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      /*
       * L'eclat se dessine par dessus l'arme, sans test de profondeur. Il
       * nait au bout du canon, donc a l'interieur meme de la geometrie qui
       * l'entoure : teste en profondeur, il disparaissait derriere le canon.
       */
      depthTest: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    this.sprite = new THREE.Mesh(geometry, this.material);
    this.sprite.renderOrder = 10;
    this.sprite.visible = false;
    this.sprite.frustumCulled = false;
    scene.add(this.sprite);

    /*
     * La lampe n'eclaire que la scene de l'arme : c'est le modele qu'elle doit
     * faire ressortir, le monde a la sienne. Elle reste dans la scene en
     * permanence, eteinte entre deux coups : masquer une lumiere change le
     * nombre de lumieres visibles et fait recompiler les materiaux.
     */
    this.light = new THREE.PointLight(new THREE.Color(1, 0.72, 0.4), 0, 60, 1);
    scene.add(this.light);
  }

  /**
   * Depart de coup. La taille et l'orientation changent a chaque tir : un
   * eclat toujours identique se remarque des le troisieme coup.
   */
  fire(color: THREE.Color, size: number): void {
    this.age = 0;
    this.scale = size * (0.85 + Math.random() * 0.4);
    this.material.color.copy(color);
    this.sprite.rotation.z = Math.random() * Math.PI * 2;
    this.sprite.visible = true;
    this.light.color.copy(color);
  }

  /** Place l'eclat au bout du canon et le fait decroitre. */
  update(delta: number, muzzle: THREE.Vector3): void {
    if (this.age >= FLASH_SECONDS) {
      if (this.sprite.visible) {
        this.sprite.visible = false;
        this.material.opacity = 0;
        this.light.intensity = 0;
      }
      return;
    }
    this.age += delta;
    const remaining = Math.max(0, 1 - this.age / FLASH_SECONDS);

    this.sprite.position.copy(muzzle);
    this.light.position.copy(muzzle);
    // L'eclat grandit en s'eteignant, comme une bouffee de gaz.
    this.sprite.scale.setScalar(this.scale * (0.7 + (1 - remaining) * 0.6));
    this.material.opacity = remaining;
    this.light.intensity = 38 * remaining;
  }
}

/** Une douille en vol, dans le repere de la vue. */
interface Casing {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  spin: THREE.Vector3;
  rotation: THREE.Euler;
  age: number;
  life: number;
  /** Taille, a l'echelle de l'image : une douille se voit, a peine. */
  size: number;
}

/**
 * Douilles ejectees.
 *
 * Elles volent dans le repere de la vue, tombent et sortent du cadre en moins
 * d'une seconde : inutile de les faire rebondir sur le decor, on ne les voit
 * pas assez longtemps. Un seul maillage instancie les porte toutes, et la
 * reserve est creee une fois pour toutes : rien n'est alloue au moment du tir.
 */
export class ShellCasingPool {
  private readonly mesh: THREE.InstancedMesh;
  private readonly casings: Casing[] = [];
  private next = 0;
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly hidden = new THREE.Vector3(0, 0, 0);

  constructor(scene: THREE.Scene, private readonly count = 14) {
    const geometry = new THREE.CylinderGeometry(0.22, 0.24, 0.9, 6, 1, false);
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.72, 0.56, 0.24),
      metalness: 0.9,
      roughness: 0.35,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, count);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);

    for (let index = 0; index < count; index++) {
      this.casings.push({
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        spin: new THREE.Vector3(),
        rotation: new THREE.Euler(),
        age: 1,
        life: 1,
        size: 1,
      });
      this.hide(index);
    }
  }

  /**
   * Ejecte une douille depuis la culasse. La direction part vers la droite et
   * vers le haut, avec assez de hasard pour que deux tirs ne se ressemblent
   * pas, et la gravite s'applique dans le repere de la vue.
   */
  eject(origin: THREE.Vector3, size: number, speed: number): void {
    const casing = this.casings[this.next];
    this.next = (this.next + 1) % this.count;

    casing.position.copy(origin);
    casing.size = size;
    // Vers la droite, vers le haut, et un peu vers l'oeil : la douille passe
    // dans le champ avant de tomber hors du cadre.
    casing.velocity.set(
      speed * (0.3 + Math.random() * 0.2),
      speed * (0.42 + Math.random() * 0.24),
      speed * (0.12 + Math.random() * 0.14),
    );
    casing.spin.set(
      (Math.random() - 0.5) * 24,
      (Math.random() - 0.5) * 24,
      (Math.random() - 0.5) * 24,
    );
    casing.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    casing.age = 0;
    casing.life = 0.7 + Math.random() * 0.3;
  }

  update(delta: number, gravity: number): void {
    let visible = false;
    for (let index = 0; index < this.casings.length; index++) {
      const casing = this.casings[index];
      if (casing.age >= casing.life) continue;

      casing.age += delta;
      if (casing.age >= casing.life) {
        this.hide(index);
        continue;
      }

      casing.velocity.y -= gravity * delta;
      casing.position.addScaledVector(casing.velocity, delta);
      casing.rotation.x += casing.spin.x * delta;
      casing.rotation.y += casing.spin.y * delta;
      casing.rotation.z += casing.spin.z * delta;

      this.quaternion.setFromEuler(casing.rotation);
      this.scale.setScalar(casing.size);
      this.matrix.compose(casing.position, this.quaternion, this.scale);
      this.mesh.setMatrixAt(index, this.matrix);
      visible = true;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = visible;
  }

  private hide(index: number): void {
    this.scale.setScalar(0);
    this.quaternion.identity();
    this.matrix.compose(this.hidden, this.quaternion, this.scale);
    this.mesh.setMatrixAt(index, this.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Assemble deux quadrilateres croises en une seule geometrie. */
function mergePlanes(
  first: THREE.BufferGeometry,
  second: THREE.BufferGeometry,
): { position: THREE.BufferAttribute; uv: THREE.BufferAttribute; index: number[] } {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (const geometry of [first, second]) {
    const position = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    const offset = positions.length / 3;
    for (let index = 0; index < position.count; index++) {
      positions.push(position.getX(index), position.getY(index), position.getZ(index));
      uvs.push(uv.getX(index), uv.getY(index));
    }
    const source = geometry.getIndex();
    if (source) {
      for (let index = 0; index < source.count; index++) indices.push(offset + source.getX(index));
    }
  }

  return {
    position: new THREE.Float32BufferAttribute(positions, 3),
    uv: new THREE.Float32BufferAttribute(uvs, 2),
    index: indices,
  };
}
