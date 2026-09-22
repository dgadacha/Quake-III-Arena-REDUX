import assert from 'node:assert/strict';
import { CollisionWorld, boxBrush } from '../src/game/collision';
import { PlayerMove, createMoveState, type MoveInput } from '../src/game/physics';

/**
 * Deplacement du joueur : franchissement des marches.
 *
 * Le decor de l'essai est le plus simple qui reproduise le defaut : un sol,
 * et une volee de marches de seize unites. Le joueur part devant la premiere
 * et avance tout droit pendant deux secondes.
 *
 * Ce qui etait casse : le glissement annoncait « libre » des qu'un de ses
 * rebonds se terminait sans toucher, y compris quand un rebond precedent avait
 * heurte la marche. Le franchissement n'etait donc jamais tente, la vitesse
 * tombait a zero, et le joueur restait plante devant chaque escalier.
 */

/** Sol plat, puis quatre marches de seize unites vers le nord. */
function stairsWorld(): CollisionWorld {
  const brushes = [
    boxBrush([-512, -512, -64], [512, 0, 0]),
    boxBrush([-512, 0, -64], [512, 64, 16]),
    boxBrush([-512, 64, -64], [512, 128, 32]),
    boxBrush([-512, 128, -64], [512, 192, 48]),
    boxBrush([-512, 192, -64], [512, 512, 64]),
  ];
  return new CollisionWorld(brushes);
}

function walk(world: CollisionWorld, yaw: number, seconds = 2): { origin: number[]; stepped: number } {
  const mover = new PlayerMove(world);
  const state = createMoveState([0, -128, 24]);
  state.onGround = true;
  const input: MoveInput = { forward: 127, right: 0, up: 0, jump: false, crouch: false, yaw, pitch: 0 };
  let stepped = 0;
  const ticks = Math.round(seconds * 125);
  for (let tick = 0; tick < ticks; tick++) {
    mover.step(state, input, 1 / 125);
    stepped += state.stepped;
    state.stepped = 0;
  }
  return { origin: state.origin as unknown as number[], stepped };
}

// Vers le nord : les quatre marches sont gravies, et la hauteur gagnee est
// rapportee au rendu pour qu'il amortisse la vue.
const up = walk(stairsWorld(), Math.PI / 2);
assert.ok(up.origin[1] > 192, `le joueur doit atteindre le palier, il est a y=${up.origin[1].toFixed(1)}`);
assert.ok(
  Math.abs(up.origin[2] - 88) < 2,
  `le joueur doit finir sur le palier a 88, il est a z=${up.origin[2].toFixed(1)}`,
);
assert.ok(up.stepped > 60, `les marches doivent etre rapportees, total ${up.stepped.toFixed(1)}`);

// Vers le sud : rien ne gene, le joueur avance de toute la distance parcourue.
// Une seconde seulement : le sol de l'essai s'arrete a cinq cents unites.
const flat = walk(stairsWorld(), -Math.PI / 2, 1);
assert.ok(flat.origin[1] < -380, `sur le plat, le joueur doit avancer, il est a y=${flat.origin[1].toFixed(1)}`);
assert.equal(Math.round(flat.origin[2]), 24);
console.log('PASS deplacement : les marches de seize unites sont gravies, le plat reste libre');
