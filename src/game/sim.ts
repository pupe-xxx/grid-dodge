import { createRng } from '../kit/rng';
import { chooseMove } from './bot';
import { createInitialState, step, FLAT, type Config, type State } from './rules';

export interface RunOptions {
  config?: Config;
  /** ここまで生き残ったら打ち切る（刻み） */
  maxTicks?: number;
  /** 自動プレイが動けるのは、この刻みごとに1マスだけ。0 なら動かない */
  moveEvery?: number;
  /** 1刻みごとに呼ばれる（動作記録を取るのに使う） */
  onTick?: (state: State) => void;
}

export interface RunResult {
  seed: number;
  ticks: number;
  waves: number;
  survived: boolean;
}

/** 画面なしで1回遊ばせる。同じ種なら同じ結果になる */
export function playGame(seed: number, opts: RunOptions = {}): RunResult {
  const { config = FLAT, maxTicks = 3600, moveEvery = 10, onTick } = opts;
  const rng = createRng(seed);
  let state = createInitialState(config);
  while (state.alive && state.tick < maxTicks) {
    const canMove = moveEvery > 0 && state.tick % moveEvery === 0;
    state = step(state, canMove ? chooseMove(state) : null, rng);
    onTick?.(state);
  }
  return { seed, ticks: state.tick, waves: state.wave, survived: state.alive };
}

export function playMany(games: number, firstSeed = 1, opts: RunOptions = {}): { survived: number; shortest: number } {
  let survived = 0;
  let shortest = Infinity;
  for (let i = 0; i < games; i++) {
    const result = playGame(firstSeed + i, opts);
    if (result.survived) survived++;
    shortest = Math.min(shortest, result.ticks);
  }
  return { survived, shortest };
}
