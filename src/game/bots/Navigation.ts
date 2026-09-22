import { Travel, type AasMap, type AasReachability } from '../../formats/aas';
import type { Vec3 } from '../../formats/bsp';

/**
 * Itineraires dans le decor, calcules sur les zones de la carte.
 *
 * Le fichier de navigation donne des zones et les franchissements entre elles,
 * chacun avec son cout mesure par le compilateur. Reste a choisir la route :
 * un plus court chemin depuis le but, remonte a l'envers, ce qui donne d'un
 * seul calcul la direction a prendre depuis n'importe quelle zone. Un bot qui
 * poursuit une armure et un bot qui poursuit la meme armure partagent donc le
 * meme travail.
 *
 * Les routes sont gardees en memoire par but. Sur une arene, les buts sont peu
 * nombreux et stables : les objets a ramasser, et la zone ou se trouve
 * l'adversaire.
 */

/**
 * Passages qu'un bot sait executer. Les sauts a la roquette, le grappin et les
 * sauts de course sont ecartes : le compilateur les propose aux bots les plus
 * forts du jeu, et les tenter sans les maitriser bloque le deplacement.
 */
const USABLE = new Set<number>([
  Travel.WALK,
  Travel.CROUCH,
  Travel.BARRIERJUMP,
  Travel.JUMP,
  Travel.WALKOFFLEDGE,
  Travel.SWIM,
  Travel.WATERJUMP,
  Travel.TELEPORT,
  Travel.ELEVATOR,
  Travel.JUMPPAD,
  Travel.FUNCBOB,
]);

/**
 * Majoration de certains passages. Le temps mesure par le compilateur ne dit
 * pas le risque : se laisser tomber coute peu et fait perdre de la sante, un
 * saut rate fait repartir de zero. Ces surcouts poussent le bot vers les
 * chemins plats a cout comparable, sans les lui interdire.
 */
const PENALTY: Record<number, number> = {
  [Travel.JUMP]: 40,
  [Travel.BARRIERJUMP]: 30,
  [Travel.WALKOFFLEDGE]: 20,
  [Travel.CROUCH]: 20,
};

/** Nombre de buts dont on garde la route toute faite. */
const CACHED_GOALS = 24;

interface Route {
  /** Cout restant depuis chaque zone, en centiemes de seconde. */
  cost: Float32Array;
  /** Franchissement a prendre depuis chaque zone, ou moins un. */
  next: Int32Array;
}

export class Navigation {
  /** Franchissements qui arrivent dans une zone, par zone d'arrivee. */
  private readonly incoming: number[][] = [];
  /** Zone de depart de chaque franchissement. */
  private readonly source: Int32Array;
  private readonly routes = new Map<number, Route>();
  private readonly order: number[] = [];

  constructor(readonly aas: AasMap) {
    this.source = new Int32Array(aas.reachabilities.length).fill(-1);
    for (let area = 1; area < aas.areaCount; area++) {
      const settings = aas.settings[area];
      if (!settings) continue;
      for (let i = 0; i < settings.reachabilityCount; i++) {
        const index = settings.firstReachability + i;
        const reachability = aas.reachabilities[index];
        if (!reachability) continue;
        this.source[index] = area;
        const list = this.incoming[reachability.area] ?? (this.incoming[reachability.area] = []);
        list.push(index);
      }
    }
  }

  /** Zone praticable la plus proche d'un point. */
  areaNear(point: Vec3): number {
    return this.aas.areaNear(point);
  }

  areaCenter(area: number): Vec3 | null {
    return this.aas.areas[area]?.center ?? null;
  }

  /**
   * Franchissement a prendre depuis une zone pour rejoindre un but, ou rien
   * quand le but n'est pas atteignable.
   */
  step(from: number, goal: number): AasReachability | null {
    if (from <= 0 || goal <= 0) return null;
    if (from === goal) return null;
    const route = this.routeTo(goal);
    const index = route.next[from];
    return index >= 0 ? this.aas.reachabilities[index] : null;
  }

  /** Cout restant d'une zone jusqu'au but, ou l'infini. */
  cost(from: number, goal: number): number {
    if (from <= 0 || goal <= 0) return Infinity;
    if (from === goal) return 0;
    return this.routeTo(goal).cost[from];
  }

  /**
   * Plus court chemin vers un but, calcule depuis le but en remontant les
   * franchissements a l'envers : une seule descente donne la route depuis
   * toutes les zones de la carte.
   */
  private routeTo(goal: number): Route {
    const cached = this.routes.get(goal);
    if (cached) return cached;

    const count = this.aas.areaCount;
    const cost = new Float32Array(count).fill(Infinity);
    const next = new Int32Array(count).fill(-1);
    cost[goal] = 0;

    const heap = new CostHeap(count);
    heap.push(goal, 0);
    while (heap.size > 0) {
      const area = heap.pop();
      const settled = cost[area];
      for (const index of this.incoming[area] ?? []) {
        const reachability = this.aas.reachabilities[index];
        if (!USABLE.has(reachability.travel)) continue;
        const from = this.source[index];
        if (from <= 0 || !this.aas.walkable(from)) continue;
        const price = settled + Math.max(1, reachability.time) + (PENALTY[reachability.travel] ?? 0);
        if (price >= cost[from]) continue;
        cost[from] = price;
        next[from] = index;
        heap.push(from, price);
      }
    }

    const route = { cost, next };
    this.routes.set(goal, route);
    this.order.push(goal);
    if (this.order.length > CACHED_GOALS) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.routes.delete(oldest);
    }
    return route;
  }

  /** Oublie les routes : une carte differente, ou des portes qui ont bouge. */
  clear(): void {
    this.routes.clear();
    this.order.length = 0;
  }
}

/**
 * File de priorite minimale, sans dependance. Les entrees perimees ne sont pas
 * retirees mais ignorees a la sortie : c'est plus court et suffit largement
 * pour quelques milliers de zones.
 */
class CostHeap {
  private readonly items: number[] = [];
  private readonly costs: number[] = [];

  constructor(capacity: number) {
    this.items.length = 0;
    this.costs.length = 0;
    void capacity;
  }

  get size(): number {
    return this.items.length;
  }

  push(item: number, cost: number): void {
    this.items.push(item);
    this.costs.push(cost);
    let child = this.items.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (this.costs[parent] <= this.costs[child]) break;
      this.swap(parent, child);
      child = parent;
    }
  }

  pop(): number {
    const top = this.items[0];
    const lastItem = this.items.pop() as number;
    const lastCost = this.costs.pop() as number;
    if (this.items.length > 0) {
      this.items[0] = lastItem;
      this.costs[0] = lastCost;
      let parent = 0;
      for (;;) {
        const left = parent * 2 + 1;
        const right = left + 1;
        let smallest = parent;
        if (left < this.items.length && this.costs[left] < this.costs[smallest]) smallest = left;
        if (right < this.items.length && this.costs[right] < this.costs[smallest]) smallest = right;
        if (smallest === parent) break;
        this.swap(parent, smallest);
        parent = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const item = this.items[a];
    this.items[a] = this.items[b];
    this.items[b] = item;
    const cost = this.costs[a];
    this.costs[a] = this.costs[b];
    this.costs[b] = cost;
  }
}
