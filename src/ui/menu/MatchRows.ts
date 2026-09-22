import { SKILL_NAMES, type BotSkill } from '../../game/bots/BotBrain';

/**
 * Reglages de la partie, ceux que l'ecran de preparation du jeu propose :
 * le mode, le nombre d'adversaires, leur niveau, la limite de frags et la
 * limite de temps.
 *
 * Le mode est nomme comme dans le jeu, Free For All, et non deathmatch : c'est
 * le libelle que Quake III affiche pour la partie individuelle.
 */

export interface MatchRules {
  bots: number;
  skill: BotSkill;
  /** Frags a atteindre, zero pour aucune limite. */
  fragLimit: number;
  /** Duree, en secondes, zero pour aucune limite. */
  timeLimit: number;
}

export const DEFAULT_MATCH: MatchRules = {
  bots: 7,
  skill: 3,
  fragLimit: 20,
  timeLimit: 600,
};

export interface MatchRow {
  id: string;
  label: string;
  read: (rules: MatchRules) => { text: string; fill?: number };
  step: (direction: number, rules: MatchRules) => void;
}

const FRAG_LIMITS = [0, 5, 10, 15, 20, 25, 30, 50];
const TIME_LIMITS = [0, 300, 600, 900, 1200, 1800];

function cycle(values: number[], current: number, direction: number): number {
  const index = values.indexOf(current);
  const base = index < 0 ? 0 : index;
  return values[(base + direction + values.length) % values.length];
}

export const MATCH_ROWS: MatchRow[] = [
  {
    id: 'mode',
    label: 'Mode',
    // Un seul mode dans cette demonstration : la ligne le dit, sans mentir
    // sur ce qui existe.
    read: () => ({ text: 'free for all' }),
    step: () => {},
  },
  {
    id: 'bots',
    label: 'Opponents',
    read: (rules) => ({ text: String(rules.bots), fill: rules.bots / 11 }),
    step: (direction, rules) => {
      rules.bots = Math.max(0, Math.min(11, rules.bots + direction));
    },
  },
  {
    id: 'skill',
    label: 'Skill',
    read: (rules) => ({ text: SKILL_NAMES[rules.skill].toLowerCase(), fill: (rules.skill - 1) / 4 }),
    step: (direction, rules) => {
      const next = Math.max(1, Math.min(5, rules.skill + direction));
      rules.skill = next as BotSkill;
    },
  },
  {
    id: 'fragLimit',
    label: 'Frag limit',
    read: (rules) => ({ text: rules.fragLimit > 0 ? String(rules.fragLimit) : 'none' }),
    step: (direction, rules) => {
      rules.fragLimit = cycle(FRAG_LIMITS, rules.fragLimit, direction);
    },
  },
  {
    id: 'timeLimit',
    label: 'Time limit',
    read: (rules) => ({
      text: rules.timeLimit > 0 ? `${Math.round(rules.timeLimit / 60)} min` : 'none',
    }),
    step: (direction, rules) => {
      rules.timeLimit = cycle(TIME_LIMITS, rules.timeLimit, direction);
    },
  },
];
