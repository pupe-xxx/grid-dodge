import { describe, expect, it } from 'vitest';
import { createInitialState, type Hazard, type State } from '../src/game/rules';
import { createGrazeTracker, depthAt, fallSpeed, GRAZE_TICKS, scoreOf } from '../src/game/score';

function rock(x: number, y: number, fireAt: number): Hazard {
  return { axis: 'z', at: { x, y, z: 0 }, fireAt, endAt: fireAt + 10, spawnedAt: fireAt - 60 };
}

function at(tick: number, x: number, hazards: Hazard[], alive = true): State {
  return { ...createInitialState(), tick, player: { x, y: 1, z: 0 }, hazards, alive };
}

describe('深さ', () => {
  it('速さは上がり、上限で止まる', () => {
    expect(fallSpeed(0)).toBe(10);
    expect(fallSpeed(60 * 10)).toBeCloseTo(13);
    expect(fallSpeed(60 * 999)).toBe(25);
  });

  it('深さは時間とともに増え、速さの上限の後もつながっている', () => {
    expect(depthAt(0)).toBe(0);
    expect(depthAt(60)).toBeCloseTo(10.15);
    const before = depthAt(60 * 50 - 1);
    const after = depthAt(60 * 50 + 1);
    expect(after - before).toBeCloseTo((25 * 2) / 60, 1);
  });

  it('すれすれ1回で 10 m 足す', () => {
    expect(scoreOf(60, 0)).toBe(10);
    expect(scoreOf(60, 2)).toBe(30);
  });
});

describe('すれすれ', () => {
  const hazards = [rock(1, 1, 100)];

  it('撃たれる直前まで撃たれるマスにいて、逃げ切ったら数える', () => {
    const g = createGrazeTracker();
    expect(g.update(at(98, 1, hazards))).toEqual([]);
    expect(g.update(at(99, 2, hazards))).toEqual([]);
    expect(g.update(at(100, 2, hazards))).toEqual([{ x: 1, y: 1, z: 0 }]);
  });

  it('早めに逃げていたら数えない', () => {
    const g = createGrazeTracker();
    g.update(at(100 - GRAZE_TICKS - 2, 1, hazards));
    for (let t = 100 - GRAZE_TICKS - 1; t < 100; t++) g.update(at(t, 2, hazards));
    expect(g.update(at(100, 2, hazards))).toEqual([]);
  });

  it('当たった時は数えない', () => {
    const g = createGrazeTracker();
    g.update(at(99, 1, hazards));
    expect(g.update(at(100, 1, hazards, false))).toEqual([]);
  });
});
