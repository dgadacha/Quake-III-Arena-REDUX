import type { WeaponId } from '../../game/weapons/WeaponDefs';
import type { PlayerSnapshot } from '../../game/PlayerState';

/**
 * Etat que l'interface affiche. Il est nourri par les evenements du jeu et par
 * un releve envoye a chaque image pour les valeurs continues, position et
 * chronometre. L'interface ne pilote pas la simulation : elle la lit.
 */

export type HealthLevel = 'healthy' | 'warning' | 'critical';

export interface MatchState {
  /** Temps restant en secondes, ou temps ecoule si la partie n'a pas de limite. */
  time: number;
  countdown: boolean;
  score: number;
  /** Nom de la carte en cours, tel qu'il est connu du moteur. */
  map: string;
}

export interface UIStateValues {
  player: PlayerSnapshot;
  healthLevel: HealthLevel;
  lowAmmo: boolean;
  owned: WeaponId[];
  match: MatchState;
  /** Vitesse horizontale : le chiffre que regardent les joueurs d'arene. */
  speed: number;
}

const LOW_AMMO = 5;

export class UIState {
  private readonly values: UIStateValues = {
    player: { health: 125, armor: 0, weapon: 'machinegun', ammo: 100, unlimited: false, alive: true },
    healthLevel: 'healthy',
    lowAmmo: false,
    owned: ['gauntlet', 'machinegun'],
    match: { time: 0, countdown: false, score: 0, map: '' },
    speed: 0,
  };

  get current(): Readonly<UIStateValues> {
    return this.values;
  }

  setPlayer(snapshot: PlayerSnapshot): void {
    this.values.player = snapshot;
    this.values.healthLevel = levelOf(snapshot.health);
    this.values.lowAmmo = !snapshot.unlimited && snapshot.ammo > 0 && snapshot.ammo <= LOW_AMMO;
  }

  setOwned(owned: WeaponId[]): void {
    this.values.owned = owned;
  }

  setMatch(match: Partial<MatchState>): void {
    Object.assign(this.values.match, match);
  }

  setSpeed(speed: number): void {
    this.values.speed = speed;
  }
}

/** Trois etats de sante, aux seuils du jeu. */
function levelOf(health: number): HealthLevel {
  if (health <= 25) return 'critical';
  if (health <= 50) return 'warning';
  return 'healthy';
}
