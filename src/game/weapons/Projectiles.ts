import * as THREE from 'three';
import type { Effects } from '../../renderer/effects/Effects';
import type { TrailKind } from '../../renderer/effects/TrailSystem';
import type { TraceResult } from '../collision';
import type { Vec3 } from '../../formats/bsp';
import { WEAPONS, type WeaponId } from './WeaponDefs';

/**
 * Projectiles : roquettes, grenades, plasma et BFG. Chacun avance a la vitesse
 * du jeu, laisse une trainee semee le long de son trajet reel et porte sa
 * propre lampe. La collision se fait sur le segment parcouru depuis l'image
 * precedente : a deux mille unites par seconde, tester la seule position
 * courante ferait passer le plasma au travers des murs.
 *
 * Les grenades rebondissent et explosent a l'echeance de leur fusee, comme a
 * l'origine.
 */

export type TraceFunction = (start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3, mask: number) => TraceResult;

interface Projectile {
  active: boolean;
  weapon: WeaponId;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  gravity: number;
  age: number;
  fuse: number;
  trailId: number;
  lightId: number;
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
}

/** Demi-taille du volume d'un projectile, comme dans le jeu. */
const PROJECTILE_HALF: Vec3 = [-2, -2, -2];
const PROJECTILE_HALF_MAX: Vec3 = [2, 2, 2];
const MASK_SHOT = 1 | 0x2000000;

export class ProjectileSystem {
  private readonly projectiles: Projectile[] = [];
  private readonly root = new THREE.Group();
  private readonly nextPosition = new THREE.Vector3();
  private trace: TraceFunction | null = null;

  constructor(private readonly effects: Effects, capacity = 48) {
    this.root.name = 'projectiles';
    const geometry = new THREE.SphereGeometry(1, 10, 8);
    for (let i = 0; i < capacity; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 18;
      this.root.add(mesh);
      this.projectiles.push({
        active: false,
        weapon: 'rocket',
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        gravity: 0,
        age: 0,
        fuse: 0,
        trailId: 0,
        lightId: 0,
        mesh,
        material,
      });
    }
  }

  attach(parent: THREE.Object3D): void {
    parent.add(this.root);
  }

  setTrace(trace: TraceFunction | null): void {
    this.trace = trace;
  }

  get activeCount(): number {
    return this.projectiles.reduce((total, entry) => total + (entry.active ? 1 : 0), 0);
  }

  /** Lance un projectile depuis un point, dans une direction normalisee. */
  spawn(weapon: WeaponId, origin: THREE.Vector3, direction: THREE.Vector3): void {
    const definition = WEAPONS[weapon];
    if (!definition.speed) return;
    const projectile = this.projectiles.find((entry) => !entry.active);
    if (!projectile) return;

    projectile.active = true;
    projectile.weapon = weapon;
    projectile.position.copy(origin);
    projectile.velocity.copy(direction).multiplyScalar(definition.speed);
    projectile.gravity = definition.gravity ?? 0;
    projectile.age = 0;
    // Sans fusee, le projectile vit assez longtemps pour traverser une carte.
    projectile.fuse = definition.fuse ?? 10;

    projectile.material.color.copy(definition.color);
    projectile.mesh.visible = true;
    projectile.mesh.position.copy(origin);
    projectile.mesh.scale.setScalar(weapon === 'bfg' ? 9 : weapon === 'plasma' ? 4 : 5);

    projectile.trailId = this.effects.trails.start(trailFor(weapon), origin);
    projectile.lightId = this.effects.lights.add(
      {
        position: [origin.x, origin.y, origin.z],
        color: definition.color.clone(),
        intensity: weapon === 'bfg' ? 500 : 260,
        radius: weapon === 'bfg' ? 500 : 300,
        kind: 'projectile',
        priority: 60,
      },
      // La lampe suit le projectile, et disparait avec lui.
      () => (projectile.active ? [projectile.position.x, projectile.position.y, projectile.position.z] : null),
    );
  }

  update(delta: number, viewer: THREE.Vector3): void {
    for (const projectile of this.projectiles) {
      if (!projectile.active) continue;

      projectile.age += delta;
      projectile.velocity.z -= projectile.gravity * delta;
      this.nextPosition.copy(projectile.position).addScaledVector(projectile.velocity, delta);

      const hit = this.trace
        ? this.trace(
            [projectile.position.x, projectile.position.y, projectile.position.z],
            [this.nextPosition.x, this.nextPosition.y, this.nextPosition.z],
            PROJECTILE_HALF,
            PROJECTILE_HALF_MAX,
            MASK_SHOT,
          )
        : null;

      if (hit && hit.fraction < 1) {
        const point = new THREE.Vector3(hit.endPosition[0], hit.endPosition[1], hit.endPosition[2]);
        const normal = new THREE.Vector3(hit.normal[0], hit.normal[1], hit.normal[2]);

        if (projectile.weapon === 'grenade' && projectile.age < projectile.fuse) {
          // Une grenade rebondit et garde sa fusee.
          this.bounce(projectile, point, normal);
          continue;
        }
        this.detonate(projectile, point, normal, viewer);
        continue;
      }

      projectile.position.copy(this.nextPosition);
      projectile.mesh.position.copy(projectile.position);
      this.effects.trails.advance(projectile.trailId, projectile.position);

      if (projectile.age >= projectile.fuse) {
        this.detonate(projectile, projectile.position.clone(), undefined, viewer);
      }
    }
  }

  clear(): void {
    for (const projectile of this.projectiles) {
      if (projectile.active) this.effects.trails.stop(projectile.trailId);
      projectile.active = false;
      projectile.mesh.visible = false;
    }
  }

  private bounce(projectile: Projectile, point: THREE.Vector3, normal: THREE.Vector3): void {
    projectile.position.copy(point).addScaledVector(normal, 1);
    projectile.mesh.position.copy(projectile.position);
    // Rebond amorti : la grenade roule au sol au lieu de repartir.
    const along = projectile.velocity.dot(normal);
    projectile.velocity.addScaledVector(normal, -along * 1.65);
    projectile.velocity.multiplyScalar(0.62);
    this.effects.trails.advance(projectile.trailId, projectile.position);
  }

  private detonate(
    projectile: Projectile,
    point: THREE.Vector3,
    normal: THREE.Vector3 | undefined,
    viewer: THREE.Vector3,
  ): void {
    const definition = WEAPONS[projectile.weapon];
    this.effects.explosions.spawn({
      position: point,
      normal: normal && normal.lengthSq() > 0 ? normal : undefined,
      radius: definition.splashRadius ?? 60,
      color: projectile.weapon === 'plasma' || projectile.weapon === 'bfg' ? definition.color.clone() : undefined,
      viewer,
      // Le plasma frappe souvent et vite : pas de secousse a chaque impact.
      parts: projectile.weapon === 'plasma' ? { shake: false, smoke: false } : undefined,
    });

    this.effects.trails.stop(projectile.trailId);
    this.effects.lights.remove(projectile.lightId);
    projectile.active = false;
    projectile.mesh.visible = false;
  }
}

function trailFor(weapon: WeaponId): TrailKind {
  if (weapon === 'grenade') return 'grenade';
  if (weapon === 'plasma' || weapon === 'bfg') return 'plasma';
  return 'rocket';
}
