// 動作記録に入れる場面。
// 種を固定した自動プレイの、半秒ごとの状態を並べる（平面と立体）。
import { CUBE, FLAT, type Config } from '../../src/game/rules';
import { playGame } from '../../src/game/sim';
import { fingerprint, type Trace } from '../../src/kit/golden';

const GAMES = 20;
const MAX_TICKS = 1800;
const EVERY = 30;

function traceGame(seed: number, config: Config, moveEvery: number): Trace {
  const trace: Trace = [];
  const result = playGame(seed, {
    config,
    maxTicks: MAX_TICKS,
    moveEvery,
    onTick: (state) => {
      if (state.tick % EVERY === 0 || !state.alive) trace.push(fingerprint(state));
    },
  });
  trace.push(fingerprint(result));
  return trace;
}

export function goldenCases(): Record<string, Trace> {
  const cases: Record<string, Trace> = {};
  for (let seed = 1; seed <= GAMES; seed++) {
    cases[`平面 seed ${seed}`] = traceGame(seed, FLAT, 10);
    cases[`立体 seed ${seed}`] = traceGame(seed, CUBE, 10);
    cases[`平面・動かない seed ${seed}`] = traceGame(seed, FLAT, 0);
  }
  return cases;
}
