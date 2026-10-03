import { covers, isFiring, TICKS_PER_SECOND, type Hazard, type State } from '../game/rules';
import { createRng } from '../kit/rng';

// 論理サイズ。描画はすべてこの座標で書く（実際の大きさは kit/scale が合わせる）
export const VIEW = { width: 720, height: 720 } as const;

export type Phase = 'title' | 'playing' | 'over';

export interface Scene {
  state: State;
  phase: Phase;
  /** 画面上の自機の位置（マス単位）。マスからマスへ滑らかに動かすため、ルールの位置とは別に持つ */
  shipX: number;
  shipY: number;
  bestTicks: number;
  /** 起動してからの刻み。星のまたたきなど、ルールに関係しない動きに使う */
  frame: number;
}

const MARGIN = 60;
const GAP = 12;
const COLORS = {
  bg: '#070b16',
  cell: '#111d33',
  cellEdge: '#2b4a7a',
  warn: '#ff5252',
  beam: '#ffe0e0',
  ship: '#4fc3f7',
  text: '#e3f2fd',
  dim: '#8fa8c7',
} as const;

const starRng = createRng(7);
const STARS = Array.from({ length: 70 }, () => ({
  x: starRng.next() * VIEW.width,
  y: starRng.next() * VIEW.height,
  size: 1 + starRng.next() * 2,
  speed: 0.2 + starRng.next() * 0.8,
  phase: starRng.next() * Math.PI * 2,
}));

function cellSize(state: State): number {
  return (VIEW.width - MARGIN * 2) / state.config.size;
}

/** マスの真ん中の座標（マス単位の位置から） */
function center(state: State, x: number, y: number): { cx: number; cy: number } {
  const size = cellSize(state);
  return { cx: MARGIN + (x + 0.5) * size, cy: MARGIN + (y + 0.5) * size };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawStars(ctx: CanvasRenderingContext2D, frame: number): void {
  for (const star of STARS) {
    const y = (star.y + frame * star.speed) % VIEW.height;
    ctx.globalAlpha = 0.35 + 0.35 * Math.sin(frame * 0.05 + star.phase);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(star.x, y, star.size, star.size);
  }
  ctx.globalAlpha = 1;
}

function drawBoard(ctx: CanvasRenderingContext2D, state: State): void {
  const size = cellSize(state);
  for (let y = 0; y < state.config.size; y++) {
    for (let x = 0; x < state.config.size; x++) {
      roundRect(ctx, MARGIN + x * size + GAP / 2, MARGIN + y * size + GAP / 2, size - GAP, size - GAP, 18);
      ctx.fillStyle = COLORS.cell;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = COLORS.cellEdge;
      ctx.stroke();
    }
  }
}

function drawHazard(ctx: CanvasRenderingContext2D, state: State, hazard: Hazard): void {
  const size = cellSize(state);
  const firing = isFiring(hazard, state.tick);
  // 予告の進み具合（0 → 1 で撃たれる）
  const progress = Math.min(1, (state.tick - hazard.spawnedAt) / (hazard.fireAt - hazard.spawnedAt));
  const layer = state.player.z;

  for (let y = 0; y < state.config.size; y++) {
    for (let x = 0; x < state.config.size; x++) {
      if (!covers(hazard, { x, y, z: layer })) continue;
      const left = MARGIN + x * size + GAP / 2;
      const top = MARGIN + y * size + GAP / 2;
      const inner = size - GAP;
      roundRect(ctx, left, top, inner, inner, 18);
      ctx.fillStyle = COLORS.warn;
      ctx.globalAlpha = firing ? 0.75 : 0.12 + 0.3 * progress;
      ctx.fill();
      if (!firing) {
        // 外から内へ縮む枠。マスの真ん中に届いた時に撃たれる
        const inset = (inner / 2 - 14) * progress;
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 4;
        ctx.strokeStyle = COLORS.warn;
        if (hazard.axis === 'z') {
          ctx.beginPath();
          ctx.arc(left + inner / 2, top + inner / 2, inner / 2 - inset, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          roundRect(ctx, left + inset, top + inset, inner - inset * 2, inner - inset * 2, 12);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }
  }

  if (hazard.axis === 'z') {
    if (firing) {
      const { cx, cy } = center(state, hazard.at.x, hazard.at.y);
      ctx.fillStyle = COLORS.beam;
      ctx.beginPath();
      ctx.arc(cx, cy, size * 0.3, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }

  // レーザー。予告の間は細い線、撃つ時は太い光
  const horizontal = hazard.axis === 'x';
  const { cx, cy } = center(state, hazard.at.x, hazard.at.y);
  ctx.strokeStyle = firing ? COLORS.beam : COLORS.warn;
  ctx.globalAlpha = firing ? 1 : 0.25 + 0.5 * progress;
  ctx.lineWidth = firing ? size * 0.34 : 3;
  ctx.shadowColor = COLORS.warn;
  ctx.shadowBlur = firing ? 30 : 0;
  ctx.beginPath();
  if (horizontal) {
    ctx.moveTo(0, cy);
    ctx.lineTo(VIEW.width, cy);
  } else {
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, VIEW.height);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;

  // 盤の両端の発射口
  ctx.fillStyle = COLORS.warn;
  for (const side of [0, 1]) {
    const edge = side === 0 ? MARGIN * 0.5 : VIEW.width - MARGIN * 0.5;
    ctx.beginPath();
    ctx.arc(horizontal ? edge : cx, horizontal ? cy : edge, 8 + 6 * progress, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawShip(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const { state } = scene;
  const size = cellSize(state);
  const { cx, cy } = center(state, scene.shipX, scene.shipY);
  const r = size * 0.2;

  if (!state.alive) {
    ctx.strokeStyle = COLORS.warn;
    ctx.lineWidth = 6;
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI * 2 * i) / 8;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r * 0.5, cy + Math.sin(a) * r * 0.5);
      ctx.lineTo(cx + Math.cos(a) * r * 1.6, cy + Math.sin(a) * r * 1.6);
      ctx.stroke();
    }
    return;
  }

  ctx.shadowColor = COLORS.ship;
  ctx.shadowBlur = 24;
  ctx.fillStyle = COLORS.ship;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r * 1.2);
  ctx.lineTo(cx + r, cy + r);
  ctx.lineTo(cx, cy + r * 0.5);
  ctx.lineTo(cx - r, cy + r);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
}

function drawText(ctx: CanvasRenderingContext2D, text: string, y: number, px: number, color: string): void {
  ctx.font = `bold ${px}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, VIEW.width / 2, y);
}

function drawOverlay(ctx: CanvasRenderingContext2D, scene: Scene): void {
  if (scene.phase === 'playing') return;
  ctx.fillStyle = 'rgba(7, 11, 22, 0.72)';
  ctx.fillRect(0, 0, VIEW.width, VIEW.height);
  if (scene.phase === 'title') {
    drawText(ctx, 'GRID DODGE', 270, 84, COLORS.text);
    drawText(ctx, '赤く光ったマスから逃げる', 370, 30, COLORS.dim);
    drawText(ctx, 'フリック / 矢印キーで1マス動く', 415, 30, COLORS.dim);
    drawText(ctx, 'タップでスタート', 520, 38, COLORS.ship);
  } else {
    drawText(ctx, 'GAME OVER', 250, 76, COLORS.warn);
    drawText(ctx, `${formatSeconds(scene.state.tick)} 秒`, 350, 64, COLORS.text);
    const isBest = scene.state.tick >= scene.bestTicks && scene.state.tick > 0;
    drawText(ctx, isBest ? '最高記録' : `最高 ${formatSeconds(scene.bestTicks)} 秒`, 420, 30, isBest ? COLORS.ship : COLORS.dim);
    drawText(ctx, 'タップでもう一度', 530, 38, COLORS.ship);
  }
}

export function formatSeconds(ticks: number): string {
  return (ticks / TICKS_PER_SECOND).toFixed(1);
}

export function draw(ctx: CanvasRenderingContext2D, scene: Scene): void {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, VIEW.width, VIEW.height);
  drawStars(ctx, scene.frame);
  drawBoard(ctx, scene.state);
  for (const hazard of scene.state.hazards) drawHazard(ctx, scene.state, hazard);
  drawShip(ctx, scene);
  drawOverlay(ctx, scene);
}
