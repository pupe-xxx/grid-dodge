// ルール。マス目の上を動いて、予告の後に撃たれるマスを避ける。
// このフォルダ（src/game）は画面の処理に触れない。document・Canvas・Math.random・時計は使わない。
// 時間は刻み（tick）の回数で数える。1刻みは 1/60 秒。

import type { Rng } from '../kit/rng';

export const TICKS_PER_SECOND = 60;

/** 盤の形。layers が 1 なら平面、2 以上なら立体 */
export interface Config {
  size: number;
  layers: number;
}

export const FLAT: Config = { size: 3, layers: 1 };
/** 立体版（3x3x3）。ルールは動くが、画面はまだ無い */
export const CUBE: Config = { size: 3, layers: 3 };

export interface Cell {
  x: number;
  y: number;
  z: number;
}

export type Axis = 'x' | 'y' | 'z';

/**
 * 障害。軸に沿った1列をまとめて撃つ。
 * 平面では x が横1行、y が縦1列、z が1マス（上から落ちてくる隕石）になる。
 */
export interface Hazard {
  axis: Axis;
  /** 列が通るマス。軸の方向の値は 0 にそろえる */
  at: Cell;
  /** この刻みから endAt の手前まで、当たると終わり。それより前は予告 */
  fireAt: number;
  endAt: number;
  spawnedAt: number;
}

export interface Move {
  dx: number;
  dy: number;
  dz: number;
}

export interface State {
  config: Config;
  tick: number;
  player: Cell;
  hazards: Hazard[];
  /** これまでに出た波の数 */
  wave: number;
  nextWaveAt: number;
  alive: boolean;
}

const FIRST_WAVE_AT = 45;
const AXES: readonly Axis[] = ['x', 'y', 'z'];

export function createInitialState(config: Config = FLAT): State {
  const mid = Math.floor(config.size / 2);
  return {
    config,
    tick: 0,
    player: { x: mid, y: mid, z: Math.floor(config.layers / 2) },
    hazards: [],
    wave: 0,
    nextWaveAt: FIRST_WAVE_AT,
    alive: true,
  };
}

/** 波ごとの時間（刻み）。進むほど予告と間が短くなる */
export function waveTiming(wave: number): { warn: number; active: number; gap: number } {
  return {
    warn: Math.max(24, 66 - wave),
    active: 10,
    gap: Math.max(4, 20 - Math.floor(wave / 2)),
  };
}

/** 1つの波で同時に来る障害の数 */
export function hazardCount(config: Config, wave: number): number {
  return config.layers > 1 ? Math.min(10, 2 + Math.floor(wave / 4)) : Math.min(4, 1 + Math.floor(wave / 6));
}

/** 予告の間に動けると見込むマスの数。安全なマスは必ずこの範囲に残す */
export function reachOf(warnTicks: number): number {
  return warnTicks >= 40 ? 2 : 1;
}

export function covers(hazard: Hazard, cell: Cell): boolean {
  const { axis, at } = hazard;
  return (axis === 'x' || at.x === cell.x) && (axis === 'y' || at.y === cell.y) && (axis === 'z' || at.z === cell.z);
}

export function isFiring(hazard: Hazard, tick: number): boolean {
  return tick >= hazard.fireAt && tick < hazard.endAt;
}

export function allCells(config: Config): Cell[] {
  const cells: Cell[] = [];
  for (let z = 0; z < config.layers; z++)
    for (let y = 0; y < config.size; y++)
      for (let x = 0; x < config.size; x++) cells.push({ x, y, z });
  return cells;
}

export function inBounds(config: Config, cell: Cell): boolean {
  return (
    cell.x >= 0 && cell.x < config.size &&
    cell.y >= 0 && cell.y < config.size &&
    cell.z >= 0 && cell.z < config.layers
  );
}

export function distance(a: Cell, b: Cell): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z);
}

/** どの障害にも入っていないマス */
export function safeCells(config: Config, hazards: readonly Hazard[]): Cell[] {
  return allCells(config).filter((cell) => !hazards.some((h) => covers(h, cell)));
}

function lineThrough(axis: Axis, cell: Cell): Pick<Hazard, 'axis' | 'at'> {
  return { axis, at: { ...cell, [axis]: 0 } };
}

function sameLine(a: Pick<Hazard, 'axis' | 'at'>, b: Pick<Hazard, 'axis' | 'at'>): boolean {
  return a.axis === b.axis && a.at.x === b.at.x && a.at.y === b.at.y && a.at.z === b.at.z;
}

/**
 * 次の波を作る。
 * - 1つ目は必ず今いるマスを通る（動かないと当たる）
 * - 安全なマスが、今いるマスから reach マス以内に必ず残る
 */
export function createWave(config: Config, player: Cell, wave: number, tick: number, rng: Rng): Hazard[] {
  const { warn, active } = waveTiming(wave);
  const reach = reachOf(warn);
  const lines: Pick<Hazard, 'axis' | 'at'>[] = [lineThrough(rng.pick(AXES), player)];
  const hasEscape = (candidate: readonly Pick<Hazard, 'axis' | 'at'>[]) =>
    allCells(config).some(
      (cell) => distance(cell, player) <= reach && !candidate.some((line) => covers(line as Hazard, cell)),
    );

  const want = hazardCount(config, wave);
  for (let tries = 0; lines.length < want && tries < want * 6; tries++) {
    const cell = { x: rng.int(config.size), y: rng.int(config.size), z: rng.int(config.layers) };
    const line = lineThrough(rng.pick(AXES), cell);
    if (lines.some((l) => sameLine(l, line))) continue;
    if (!hasEscape([...lines, line])) continue;
    lines.push(line);
  }

  const fireAt = tick + warn;
  return lines.map((line) => ({ ...line, fireAt, endAt: fireAt + active, spawnedAt: tick }));
}

/** 1刻み進めた後の状態を新しく返す（元の状態は変えない）。move は盤の外へは出られない */
export function step(state: State, move: Move | null, rng: Rng): State {
  if (!state.alive) return state;
  const tick = state.tick + 1;

  let player = state.player;
  if (move) {
    const next = { x: player.x + move.dx, y: player.y + move.dy, z: player.z + move.dz };
    if (inBounds(state.config, next)) player = next;
  }

  let hazards = state.hazards.filter((h) => h.endAt > tick);
  let { wave, nextWaveAt } = state;
  if (tick >= nextWaveAt) {
    const spawned = createWave(state.config, player, wave, tick, rng);
    hazards = [...hazards, ...spawned];
    nextWaveAt = spawned[0]!.endAt + waveTiming(wave).gap;
    wave++;
  }

  const alive = !hazards.some((h) => isFiring(h, tick) && covers(h, player));
  return { config: state.config, tick, player, hazards, wave, nextWaveAt, alive };
}
