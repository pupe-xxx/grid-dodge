import { describe, expect, it } from 'vitest';
import {
  covers, createInitialState, createWave, CUBE, distance, FLAT, hazardCount, isFiring, reachOf, safeCells, step,
  waveTiming, type Hazard, type State,
} from '../src/game/rules';
import { playGame, playMany } from '../src/game/sim';
import { createRng } from '../src/kit/rng';

const RIGHT = { dx: 1, dy: 0, dz: 0 };
const UP = { dx: 0, dy: -1, dz: 0 };
const DEEPER = { dx: 0, dy: 0, dz: 1 };

function hazardAt(state: State, axis: Hazard['axis'], fireAt: number): Hazard {
  return { axis, at: { ...state.player, [axis]: 0 }, fireAt, endAt: fireAt + 10, spawnedAt: state.tick };
}

describe('動き', () => {
  it('最初は真ん中にいて、障害は無い', () => {
    expect(createInitialState().player).toEqual({ x: 1, y: 1, z: 0 });
    expect(createInitialState(CUBE).player).toEqual({ x: 1, y: 1, z: 1 });
    expect(createInitialState().hazards).toEqual([]);
  });

  it('1刻みで1マス動き、元の状態は変わらない', () => {
    const s = createInitialState();
    const next = step(s, RIGHT, createRng(1));
    expect(next.player).toEqual({ x: 2, y: 1, z: 0 });
    expect(next.tick).toBe(1);
    expect(s.player).toEqual({ x: 1, y: 1, z: 0 });
    expect(s.tick).toBe(0);
  });

  it('盤の外へは出られない', () => {
    const rng = createRng(1);
    let s = step(createInitialState(), RIGHT, rng);
    s = step(s, RIGHT, rng);
    expect(s.player.x).toBe(2);
    expect(step(createInitialState(), DEEPER, rng).player.z).toBe(0);
    expect(step(createInitialState(CUBE), DEEPER, rng).player.z).toBe(2);
  });
});

describe('障害', () => {
  it('平面では、x は横1行、y は縦1列、z は1マスを撃つ', () => {
    const s = createInitialState();
    const count = (axis: Hazard['axis']) => 9 - safeCells(FLAT, [hazardAt(s, axis, 10)]).length;
    expect(count('x')).toBe(3);
    expect(count('y')).toBe(3);
    expect(count('z')).toBe(1);
    expect(covers(hazardAt(s, 'x', 10), { x: 0, y: 1, z: 0 })).toBe(true);
    expect(covers(hazardAt(s, 'x', 10), { x: 0, y: 0, z: 0 })).toBe(false);
  });

  it('予告の間は当たらず、撃たれる刻みにいると終わる', () => {
    const rng = createRng(1);
    let s: State = { ...createInitialState(), nextWaveAt: 9999 };
    s = { ...s, hazards: [hazardAt(s, 'x', 3)] };
    s = step(step(s, null, rng), null, rng);
    expect(s.alive).toBe(true);
    s = step(s, null, rng);
    expect(s.alive).toBe(false);
    expect(step(s, RIGHT, rng)).toBe(s);
  });

  it('撃たれる前に列の外へ動けば当たらない。撃ち終わった障害は消える', () => {
    const rng = createRng(1);
    let s: State = { ...createInitialState(), nextWaveAt: 9999 };
    s = { ...s, hazards: [hazardAt(s, 'x', 3)] };
    s = step(s, UP, rng);
    for (let i = 0; i < 12; i++) s = step(s, null, rng);
    expect(s.alive).toBe(true);
    expect(s.hazards).toEqual([]);
  });

  it('撃たれている列に入ると終わる', () => {
    const rng = createRng(1);
    let s: State = { ...createInitialState(), nextWaveAt: 9999 };
    const top = { ...s, player: { x: 1, y: 0, z: 0 } };
    s = { ...s, hazards: [hazardAt(top, 'x', 1)] };
    expect(step(s, null, rng).alive).toBe(true);
    expect(step(s, UP, rng).alive).toBe(false);
  });
});

describe('波', () => {
  it('進むほど予告が短くなり、同時に来る数が増える', () => {
    expect(waveTiming(0).warn).toBeGreaterThan(waveTiming(30).warn);
    expect(waveTiming(500).warn).toBe(24);
    expect(hazardCount(FLAT, 0)).toBe(1);
    expect(hazardCount(FLAT, 500)).toBe(4);
    expect(hazardCount(CUBE, 500)).toBeGreaterThan(hazardCount(FLAT, 500));
  });

  it('どの波も、今いるマスを撃ち、動ける範囲に安全なマスを残す', () => {
    for (const config of [FLAT, CUBE]) {
      for (let seed = 1; seed <= 300; seed++) {
        const rng = createRng(seed);
        const player = { x: rng.int(config.size), y: rng.int(config.size), z: rng.int(config.layers) };
        const wave = rng.int(80);
        const hazards = createWave(config, player, wave, 100, rng);
        expect(hazards.length).toBeGreaterThan(0);
        expect(hazards.length).toBeLessThanOrEqual(hazardCount(config, wave));
        expect(covers(hazards[0]!, player)).toBe(true);
        const reach = reachOf(waveTiming(wave).warn);
        expect(safeCells(config, hazards).some((cell) => distance(cell, player) <= reach)).toBe(true);
        expect(hazards.every((h) => isFiring(h, h.fireAt) && !isFiring(h, h.fireAt - 1))).toBe(true);
      }
    }
  });

  it('前の波を撃ち終わってから、次の波の予告が出る', () => {
    const rng = createRng(5);
    let s = createInitialState();
    for (let i = 0; i < 2000; i++) {
      s = step({ ...s, alive: true }, null, rng);
      expect(new Set(s.hazards.map((h) => h.spawnedAt)).size).toBeLessThanOrEqual(1);
    }
    expect(s.wave).toBeGreaterThan(10);
  });
});

describe('画面なしの自動プレイ', () => {
  it('同じ種なら同じ結果になる', () => {
    expect(playGame(42, { moveEvery: 0 })).toEqual(playGame(42, { moveEvery: 0 }));
    expect(playGame(42, { config: CUBE })).toEqual(playGame(42, { config: CUBE }));
  });

  it('動かなければ最初の波で終わる', () => {
    const { survived, shortest } = playMany(50, 1, { moveEvery: 0 });
    expect(survived).toBe(0);
    expect(shortest).toBe(45 + waveTiming(0).warn);
  });

  it('10刻みに1マスしか動けなくても、平面・立体とも2分間避け切れる', () => {
    for (const config of [FLAT, CUBE]) {
      expect(playMany(100, 1, { config, maxTicks: 7200 }).survived).toBe(100);
    }
  });
});
