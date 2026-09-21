import * as THREE from 'three';

/**
 * Particules. Tout est alloue une fois : la reserve, les tampons d'instances et
 * les vecteurs de travail. Une explosion en pleine partie ne doit rien creer,
 * sous peine de faire travailler le ramasse-miettes au plus mauvais moment.
 *
 * Deux lots seulement : un additif pour ce qui emet de la lumiere, etincelles
 * et flammes, un translucide pour ce qui l'absorbe, fumee et poussiere. Chaque
 * particule est un carre tourne face a la camera dans le shader, ce qui evite
 * de recalculer des orientations sur le processeur.
 */

export type ParticleKind = 'flare' | 'spark' | 'smoke';

export interface ParticleSpec {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Acceleration constante, en plus de la gravite. */
  acceleration?: THREE.Vector3;
  gravity?: number;
  /** Freinage par l'air, en fraction de vitesse perdue par seconde. */
  drag?: number;
  size: number;
  sizeEnd?: number;
  rotation?: number;
  angularVelocity?: number;
  color: THREE.Color;
  colorEnd?: THREE.Color;
  opacity?: number;
  opacityEnd?: number;
  lifetime: number;
  kind?: ParticleKind;
}

interface Batch {
  mesh: THREE.Mesh;
  geometry: THREE.InstancedBufferGeometry;
  offsets: THREE.InstancedBufferAttribute;
  scales: THREE.InstancedBufferAttribute;
  rotations: THREE.InstancedBufferAttribute;
  colors: THREE.InstancedBufferAttribute;
  opacities: THREE.InstancedBufferAttribute;
  count: number;
}

interface Particle {
  active: boolean;
  additive: boolean;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  acceleration: THREE.Vector3;
  gravity: number;
  drag: number;
  size: number;
  sizeEnd: number;
  rotation: number;
  angularVelocity: number;
  color: THREE.Color;
  colorEnd: THREE.Color;
  opacity: number;
  opacityEnd: number;
  age: number;
  lifetime: number;
}

const PARTICLE_VERTEX = /* glsl */ `
  attribute vec3 aOffset;
  attribute vec2 aScale;
  attribute float aRotation;
  attribute vec3 aColor;
  attribute float aOpacity;

  varying vec2 vUv;
  varying vec3 vColor;
  varying float vOpacity;

  void main() {
    vUv = uv;
    vColor = aColor;
    vOpacity = aOpacity;

    // Carre tourne face a la camera : les axes de la vue servent de repere.
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    float c = cos(aRotation);
    float s = sin(aRotation);
    vec2 turned = vec2(position.x * c - position.y * s, position.x * s + position.y * c);
    vec3 world = aOffset + right * (turned.x * aScale.x) + up * (turned.y * aScale.y);

    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const PARTICLE_FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vOpacity;

  void main() {
    vec4 texel = texture2D(map, vUv);
    float alpha = texel.a * vOpacity;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(texel.rgb * vColor, alpha);
  }
`;

export class ParticleSystem {
  private readonly particles: Particle[] = [];
  private readonly additive: Batch;
  private readonly translucent: Batch;
  private readonly textures: Record<ParticleKind, THREE.Texture>;
  private nextFree = 0;
  private live = 0;

  constructor(readonly capacity = 2000) {
    this.textures = {
      flare: radialTexture(0.0, 1),
      spark: radialTexture(0.55, 1.6),
      smoke: cloudTexture(),
    };

    this.additive = this.createBatch(capacity, THREE.AdditiveBlending, this.textures.flare);
    this.translucent = this.createBatch(capacity, THREE.NormalBlending, this.textures.smoke);

    for (let i = 0; i < capacity; i++) {
      this.particles.push({
        active: false,
        additive: true,
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        acceleration: new THREE.Vector3(),
        gravity: 0,
        drag: 0,
        size: 1,
        sizeEnd: 1,
        rotation: 0,
        angularVelocity: 0,
        color: new THREE.Color(),
        colorEnd: new THREE.Color(),
        opacity: 1,
        opacityEnd: 0,
        age: 0,
        lifetime: 1,
      });
    }
  }

  get activeCount(): number {
    return this.live;
  }

  attach(root: THREE.Object3D): void {
    root.add(this.additive.mesh);
    root.add(this.translucent.mesh);
  }

  /** Allume une particule prise dans la reserve ; au-dela, la plus ancienne cede sa place. */
  spawn(spec: ParticleSpec): void {
    const particle = this.take();
    if (!particle) return;

    const kind = spec.kind ?? 'flare';
    particle.active = true;
    particle.additive = kind !== 'smoke';
    particle.position.copy(spec.position);
    particle.velocity.copy(spec.velocity);
    if (spec.acceleration) particle.acceleration.copy(spec.acceleration);
    else particle.acceleration.set(0, 0, 0);
    particle.gravity = spec.gravity ?? 0;
    particle.drag = spec.drag ?? 0;
    particle.size = spec.size;
    particle.sizeEnd = spec.sizeEnd ?? spec.size;
    particle.rotation = spec.rotation ?? Math.random() * Math.PI * 2;
    particle.angularVelocity = spec.angularVelocity ?? 0;
    particle.color.copy(spec.color);
    particle.colorEnd.copy(spec.colorEnd ?? spec.color);
    particle.opacity = spec.opacity ?? 1;
    particle.opacityEnd = spec.opacityEnd ?? 0;
    particle.age = 0;
    particle.lifetime = Math.max(0.016, spec.lifetime);
  }

  /** Avance les particules et remplit les tampons d'instances. */
  update(delta: number): void {
    let additiveCount = 0;
    let translucentCount = 0;
    let live = 0;

    for (const particle of this.particles) {
      if (!particle.active) continue;
      particle.age += delta;
      if (particle.age >= particle.lifetime) {
        particle.active = false;
        continue;
      }

      const life = particle.age / particle.lifetime;
      // Freinage puis acceleration : l'ordre evite qu'une particule freinee
      // reparte instantanement.
      if (particle.drag > 0) particle.velocity.multiplyScalar(Math.max(0, 1 - particle.drag * delta));
      particle.velocity.x += particle.acceleration.x * delta;
      particle.velocity.y += particle.acceleration.y * delta;
      particle.velocity.z += (particle.acceleration.z - particle.gravity) * delta;
      particle.position.addScaledVector(particle.velocity, delta);
      particle.rotation += particle.angularVelocity * delta;

      const size = particle.size + (particle.sizeEnd - particle.size) * life;
      const opacity = particle.opacity + (particle.opacityEnd - particle.opacity) * life;
      const batch = particle.additive ? this.additive : this.translucent;
      const index = particle.additive ? additiveCount++ : translucentCount++;

      batch.offsets.setXYZ(index, particle.position.x, particle.position.y, particle.position.z);
      batch.scales.setXY(index, size, size);
      batch.rotations.setX(index, particle.rotation);
      batch.colors.setXYZ(
        index,
        particle.color.r + (particle.colorEnd.r - particle.color.r) * life,
        particle.color.g + (particle.colorEnd.g - particle.color.g) * life,
        particle.color.b + (particle.colorEnd.b - particle.color.b) * life,
      );
      batch.opacities.setX(index, Math.max(0, opacity));
      live++;
    }

    this.live = live;
    this.finish(this.additive, additiveCount);
    this.finish(this.translucent, translucentCount);
  }

  clear(): void {
    for (const particle of this.particles) particle.active = false;
    this.live = 0;
    this.finish(this.additive, 0);
    this.finish(this.translucent, 0);
  }

  private take(): Particle | null {
    // Parcours circulaire : on garde la trace du dernier emplacement servi.
    for (let i = 0; i < this.particles.length; i++) {
      const index = (this.nextFree + i) % this.particles.length;
      if (!this.particles[index].active) {
        this.nextFree = (index + 1) % this.particles.length;
        return this.particles[index];
      }
    }
    // Reserve pleine : la plus ancienne laisse sa place.
    let oldest = this.particles[0];
    for (const particle of this.particles) {
      if (particle.age / particle.lifetime > oldest.age / oldest.lifetime) oldest = particle;
    }
    return oldest;
  }

  private finish(batch: Batch, count: number): void {
    batch.count = count;
    batch.geometry.instanceCount = count;
    batch.mesh.visible = count > 0;
    if (count === 0) return;
    batch.offsets.needsUpdate = true;
    batch.scales.needsUpdate = true;
    batch.rotations.needsUpdate = true;
    batch.colors.needsUpdate = true;
    batch.opacities.needsUpdate = true;
  }

  private createBatch(capacity: number, blending: THREE.Blending, map: THREE.Texture): Batch {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.instanceCount = 0;
    // Un carre unitaire, partage par toutes les instances.
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
    );
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);

    const offsets = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    const scales = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    const rotations = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    const colors = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    const opacities = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    for (const attribute of [offsets, scales, rotations, colors, opacities]) {
      attribute.setUsage(THREE.DynamicDrawUsage);
    }
    geometry.setAttribute('aOffset', offsets);
    geometry.setAttribute('aScale', scales);
    geometry.setAttribute('aRotation', rotations);
    geometry.setAttribute('aColor', colors);
    geometry.setAttribute('aOpacity', opacities);

    const material = new THREE.ShaderMaterial({
      uniforms: { map: { value: map } },
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
      transparent: true,
      blending,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.renderOrder = blending === THREE.AdditiveBlending ? 20 : 10;
    mesh.name = blending === THREE.AdditiveBlending ? 'particles-additive' : 'particles';

    return { mesh, geometry, offsets, scales, rotations, colors, opacities, count: 0 };
  }
}

/** Tache ronde en degrade, du centre vers le bord. */
function radialTexture(inner: number, falloff: number): THREE.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  const center = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - center, y - center) / center;
      const value = Math.max(0, 1 - Math.max(0, distance - inner) / Math.max(0.001, 1 - inner));
      const alpha = Math.pow(value, falloff);
      const at = (y * size + x) * 4;
      data[at] = 255;
      data[at + 1] = 255;
      data[at + 2] = 255;
      data[at + 3] = Math.round(alpha * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

/** Tache irreguliere, pour la fumee et la poussiere. */
function cloudTexture(): THREE.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  const center = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - center) / center;
      const dy = (y - center) / center;
      const distance = Math.hypot(dx, dy);
      // Bord decoupe par quelques ondulations : une tache parfaitement ronde
      // se reconnait tout de suite quand plusieurs se superposent.
      const wobble = 0.82 + 0.18 * Math.sin(Math.atan2(dy, dx) * 3 + distance * 5);
      const value = Math.max(0, 1 - distance / wobble);
      const at = (y * size + x) * 4;
      data[at] = 255;
      data[at + 1] = 255;
      data[at + 2] = 255;
      data[at + 3] = Math.round(Math.pow(value, 1.4) * 230);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}
