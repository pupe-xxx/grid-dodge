import { covers, distance, inBounds, isFiring, safeCells, type Cell, type Move, type State } from './rules';

const MOVES: readonly Move[] = [
  { dx: 1, dy: 0, dz: 0 }, { dx: -1, dy: 0, dz: 0 },
  { dx: 0, dy: 1, dz: 0 }, { dx: 0, dy: -1, dz: 0 },
  { dx: 0, dy: 0, dz: 1 }, { dx: 0, dy: 0, dz: -1 },
];

/**
 * 自動プレイの1手。予告されたマスにいたら、いちばん近い安全なマスへ1マス寄る。
 * 画面なしの実行で「必ず避けられる波になっているか」を確かめるのに使う。
 */
export function chooseMove(state: State): Move | null {
  const { config, player, hazards, tick } = state;
  if (!hazards.some((h) => covers(h, player))) return null;

  const safe = safeCells(config, hazards);
  const firingAt = (cell: Cell) => hazards.some((h) => isFiring(h, tick + 1) && covers(h, cell));
  let best: Move | null = null;
  let bestDistance = Infinity;
  for (const move of MOVES) {
    const next = { x: player.x + move.dx, y: player.y + move.dy, z: player.z + move.dz };
    if (!inBounds(config, next) || firingAt(next)) continue;
    const d = Math.min(...safe.map((cell) => distance(cell, next)));
    if (d < bestDistance) {
      best = move;
      bestDistance = d;
    }
  }
  return best;
}
