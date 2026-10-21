// 点数。落ちた深さと、すれすれで抜けた回数から出す。
// ルール（rules.ts）の状態を読むだけで、ルールの進み方は変えない（動作記録に影響しない）。

import { covers, TICKS_PER_SECOND, type Cell, type State } from './rules';

/** 落ちる速さ（メートル毎秒）。最初は START、毎秒 ACCEL ずつ速くなり、MAX で止まる */
const SPEED_START = 10;
const SPEED_ACCEL = 0.3;
const SPEED_MAX = 25;
/** すれすれ1回で足すメートル */
export const GRAZE_BONUS = 10;
/** 撃たれる直前のこの刻みの間に、撃たれるマスにいたら「すれすれ」 */
export const GRAZE_TICKS = 15;

/** 今の落ちる速さ（メートル毎秒） */
export function fallSpeed(tick: number): number {
  return Math.min(SPEED_MAX, SPEED_START + SPEED_ACCEL * (tick / TICKS_PER_SECOND));
}

/** 始めてから tick 刻みの間に落ちた深さ（メートル） */
export function depthAt(tick: number): number {
  const t = tick / TICKS_PER_SECOND;
  const tMax = (SPEED_MAX - SPEED_START) / SPEED_ACCEL;
  if (t <= tMax) return SPEED_START * t + (SPEED_ACCEL / 2) * t * t;
  return SPEED_START * tMax + (SPEED_ACCEL / 2) * tMax * tMax + SPEED_MAX * (t - tMax);
}

export function scoreOf(tick: number, grazes: number): number {
  return Math.floor(depthAt(tick)) + grazes * GRAZE_BONUS;
}

export interface GrazeTracker {
  /** 1刻み進めるたびに呼ぶ。この刻みで「すれすれ」で抜けた障害のマスを返す（無ければ空） */
  update(state: State): Cell[];
}

/**
 * すれすれの判定。障害が撃たれた刻みに生きていて、その直前（GRAZE_TICKS 刻み以内）に
 * 撃たれたマスにいたら、ぎりぎりで逃げたとみなす。
 */
export function createGrazeTracker(): GrazeTracker {
  const recent: { tick: number; cell: Cell }[] = [];
  return {
    update(state) {
      recent.push({ tick: state.tick, cell: state.player });
      while (recent.length && recent[0]!.tick < state.tick - GRAZE_TICKS) recent.shift();
      if (!state.alive) return [];
      const fired = state.hazards.filter((h) => h.fireAt === state.tick);
      for (const { tick, cell } of recent) {
        if (tick < state.tick && fired.some((h) => covers(h, cell))) return [cell];
      }
      return [];
    },
  };
}
