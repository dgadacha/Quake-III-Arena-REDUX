import type { Vec3 } from '../../formats/bsp';

/**
 * Points de vue de calibration.
 *
 * Juger un rendu depuis un endroit different a chaque essai ne mene a rien :
 * on croit avoir ameliore l'image alors qu'on a change d'angle. Ces prises de
 * vue sont donc fixes, position, orientation et champ de vision compris, et
 * servent de reference avant et apres chaque modification.
 *
 * Les trois premieres couvrent la grande salle de q3dm7 : la vue d'ensemble
 * depuis l'entree, le sol en contre-plongee, et un mur a l'ombre, celui qui
 * revele les noirs bouches.
 */

export interface BenchmarkShot {
  name: string;
  map: string;
  origin: Vec3;
  /** Orientation, en radians. */
  yaw: number;
  pitch: number;
  /** Champ de vision du monde, en degres. */
  fov: number;
}

export const BENCHMARK_SHOTS: BenchmarkShot[] = [
  {
    name: 'q3dm7_salle',
    map: 'q3dm7',
    origin: [800, -352, -14],
    yaw: -0.6,
    pitch: 0.05,
    fov: 90,
  },
  {
    name: 'q3dm7_sol',
    map: 'q3dm7',
    origin: [1000, -352, -14],
    yaw: -0.35,
    pitch: 0.42,
    fov: 90,
  },
  {
    name: 'q3dm7_ombre',
    map: 'q3dm7',
    origin: [1440, -552, -14],
    yaw: 2.35,
    pitch: 0.02,
    fov: 90,
  },
  {
    name: 'q3dm7_reference_escalier',
    map: 'q3dm7',
    origin: [1501, -139, -40],
    yaw: 1.75,
    pitch: -0.34,
    fov: 90,
  },
];

export function benchmarkShot(index: number): BenchmarkShot {
  return BENCHMARK_SHOTS[Math.max(0, Math.min(BENCHMARK_SHOTS.length - 1, index))];
}
