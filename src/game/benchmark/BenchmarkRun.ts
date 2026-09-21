import type { CameraPath, PathSample } from './CameraPath';

/**
 * Banc de mesure.
 *
 * Le principe d'un banc utile est qu'il soit le meme a chaque essai : meme
 * trajet, meme vitesse, meme duree, et une resolution interne figee. C'est a
 * cette condition que deux chiffres se comparent, et que changer un reglage
 * veut dire quelque chose.
 *
 * Ce qui est retenu n'est pas seulement la moyenne. Une arene qui tient
 * soixante images par seconde en moyenne mais tombe a vingt en entrant dans la
 * salle de lave n'est pas jouable, et c'est le centieme d'images le plus lent
 * qui le dit. Chaque troncon du parcours est mesure a part, pour savoir quelle
 * salle coute.
 */

/** Ce qu'un troncon du parcours a donne. */
export interface BenchmarkSegment {
  name: string;
  frames: number;
  seconds: number;
  fps: number;
}

export interface BenchmarkReport {
  map: string;
  /** Duree mesuree, echauffement exclu. */
  seconds: number;
  frames: number;
  averageFps: number;
  /**
   * Moyenne des durees du centieme d'images le plus lent, exprimee en images
   * par seconde. C'est la mesure qui correspond a ce qu'on ressent comme
   * saccade, et elle est toujours plus basse que la moyenne.
   */
  onePercentLow: number;
  pointOnePercentLow: number;
  bestFps: number;
  worstFps: number;
  /** Images ecartees : suspension du navigateur ou du systeme. */
  dropped: number;
  /** Vrai quand la fenetre a ete masquee : les chiffres ne valent rien. */
  hidden: boolean;
  segments: BenchmarkSegment[];
  /** Durees d'image ramenees a une centaine de valeurs, pour le trace. */
  curve: number[];
  /** Reglages employes : sans eux le resultat ne veut rien dire. */
  settings: { label: string; value: string }[];
  /** Taille du tampon de rendu, en pixels reels. */
  buffer: { width: number; height: number };
  /** Longueur du parcours et vitesse de la camera, en unites de la carte. */
  pathLength: number;
  speed: number;
}

/** Vitesse de la camera, en unites de carte par seconde. */
export const CAMERA_SPEED = 320;

/**
 * Tour de chauffe. Le parcours est survole une premiere fois en accelere, sans
 * rien compter : un programme d'affichage ne se compile qu'a la premiere image
 * ou il sert, les sondes de reflet se prennent une par image, et les cartes HD
 * arrivent en differe. Sans ce tour, la mesure du centieme le plus lent ne
 * dirait pas comment la carte tourne, mais combien de temps le moteur a mis a
 * la decouvrir.
 */
export const WARMUP_SECONDS = 4;

/**
 * Duree au-dela de laquelle une image ne vient plus du rendu.
 *
 * Un navigateur suspend l'animation d'une fenetre masquee ou d'un onglet en
 * arriere-plan, et le systeme peut retirer la main au processus. Ces images
 * durent des dizaines de fois le budget et ne disent rien de la carte : les
 * compter ferait tomber le centieme le plus lent a quelques images par
 * seconde alors que le rendu, lui, n'a pas ralenti. Elles sont donc ecartees,
 * et leur nombre est rapporte.
 */
export const OUTLIER_SECONDS = 0.1;

export class BenchmarkRun {
  private distance = 0;
  private warmed = 0;
  private recorded = 0;
  private readonly frames: { delta: number; segment: string }[] = [];
  private readonly recent: number[] = [];
  /** Images ecartees parce que trop longues pour venir du rendu. */
  private dropped = 0;
  /** Vrai si la fenetre a ete masquee pendant l'essai. */
  private hidden = false;
  readonly duration: number;

  constructor(
    private readonly path: CameraPath,
    private readonly mapName: string,
    private readonly speed = CAMERA_SPEED,
  ) {
    this.duration = path.length / this.speed;
  }

  /** Vrai tant que l'echauffement n'est pas termine. */
  get warmingUp(): boolean {
    return this.warmed < WARMUP_SECONDS;
  }

  get elapsed(): number {
    return this.recorded;
  }

  /** Part du parcours accomplie, de zero a un. */
  get progress(): number {
    return Math.min(1, this.recorded / this.duration);
  }

  get frameCount(): number {
    return this.frames.length;
  }

  /** Cadence instantanee, lissee sur une vingtaine d'images. */
  get liveFps(): number {
    if (this.recent.length === 0) return 0;
    const total = this.recent.reduce((sum, delta) => sum + delta, 0);
    return total > 0 ? this.recent.length / total : 0;
  }

  get segmentName(): string {
    return this.path.segmentAt(this.distance);
  }

  /** Signale que la fenetre n'etait pas visible : le resultat est a jeter. */
  noteHidden(): void {
    this.hidden = true;
  }

  /**
   * Avance d'une image. Pendant l'echauffement la camera reste au depart et
   * rien n'est compte ; ensuite elle suit le chemin a vitesse constante.
   */
  advance(delta: number): { sample: PathSample; done: boolean } {
    if (this.warmingUp) {
      this.warmed += delta;
      // Le tour de chauffe couvre tout le parcours : chaque matiere est vue
      // une fois, donc compilee, avant que la mesure commence.
      const rushed = (this.warmed / WARMUP_SECONDS) * this.path.length;
      return { sample: this.path.sample(rushed), done: false };
    }

    this.distance += this.speed * delta;
    this.recorded += delta;
    if (delta > OUTLIER_SECONDS) {
      this.dropped += 1;
    } else {
      this.frames.push({ delta, segment: this.path.segmentAt(this.distance) });
      this.recent.push(delta);
      if (this.recent.length > 20) this.recent.shift();
    }

    return { sample: this.path.sample(this.distance), done: this.recorded >= this.duration };
  }

  /** Resultat de l'essai, une fois le parcours termine. */
  report(settings: { label: string; value: string }[], buffer: { width: number; height: number }): BenchmarkReport {
    const deltas = this.frames.map((frame) => frame.delta).filter((delta) => delta > 0);
    const total = deltas.reduce((sum, delta) => sum + delta, 0);
    const sorted = [...deltas].sort((a, b) => b - a);

    const segments = new Map<string, { frames: number; seconds: number }>();
    for (const frame of this.frames) {
      const entry = segments.get(frame.segment) ?? { frames: 0, seconds: 0 };
      entry.frames += 1;
      entry.seconds += frame.delta;
      segments.set(frame.segment, entry);
    }

    return {
      map: this.mapName,
      seconds: total,
      frames: deltas.length,
      averageFps: total > 0 ? deltas.length / total : 0,
      onePercentLow: lowAverage(sorted, 0.01),
      pointOnePercentLow: lowAverage(sorted, 0.001),
      bestFps: sorted.length > 0 ? 1 / sorted[sorted.length - 1] : 0,
      worstFps: sorted.length > 0 ? 1 / sorted[0] : 0,
      dropped: this.dropped,
      hidden: this.hidden,
      segments: [...segments.entries()]
        .map(([name, entry]) => ({
          name,
          frames: entry.frames,
          seconds: entry.seconds,
          fps: entry.seconds > 0 ? entry.frames / entry.seconds : 0,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true })),
      curve: condense(deltas, 120),
      settings,
      buffer,
      pathLength: this.path.length,
      speed: this.speed,
    };
  }
}

/**
 * Cadence moyenne de la part la plus lente des images. La part est prise sur
 * les durees triees de la plus longue a la plus courte : c'est la definition
 * employee par les outils de mesure, et elle repond a la question « quand ca
 * saccade, ca descend a combien ».
 */
function lowAverage(sortedDescending: number[], fraction: number): number {
  if (sortedDescending.length === 0) return 0;
  const count = Math.max(1, Math.round(sortedDescending.length * fraction));
  const slice = sortedDescending.slice(0, count);
  const total = slice.reduce((sum, delta) => sum + delta, 0);
  return total > 0 ? slice.length / total : 0;
}

/** Ramene une suite de durees a un nombre fixe de valeurs moyennes. */
function condense(values: number[], count: number): number[] {
  if (values.length <= count) return values;
  const step = values.length / count;
  const out: number[] = [];
  for (let index = 0; index < count; index++) {
    const from = Math.floor(index * step);
    const to = Math.max(from + 1, Math.floor((index + 1) * step));
    const slice = values.slice(from, to);
    out.push(slice.reduce((sum, value) => sum + value, 0) / slice.length);
  }
  return out;
}
