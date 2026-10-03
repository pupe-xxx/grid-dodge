// 入口。共通部分（kit）・ルール（game）・画面（ui）をつなぐ。
import { createInitialState, FLAT, isFiring, step, type Move, type State } from './game/rules';
import { createSound } from './kit/audio';
import { createLoop } from './kit/loop';
import { loadPlatform } from './kit/platform';
import { createRng, type Rng } from './kit/rng';
import { createSave } from './kit/save';
import { fitCanvas } from './kit/scale';
import { draw, formatSeconds, VIEW, type Phase } from './ui/render';

/** これだけ指を動かしたら1マス動く（画面上のピクセル） */
const SWIPE_PX = 26;
/** 溜めておく操作の上限。多すぎると、指を止めた後も動き続ける */
const MAX_QUEUED = 2;
/** 終わった直後は、この刻みの間だけ再開の操作を受けない（避けようとしたフリックで始まらないように） */
const RESTART_WAIT = 30;
/** 自機がマスからマスへ寄っていく速さ（1刻みで残りの何割を進むか） */
const SHIP_EASE = 0.4;

const KEYS: Record<string, Move> = {
  ArrowLeft: { dx: -1, dy: 0, dz: 0 }, a: { dx: -1, dy: 0, dz: 0 },
  ArrowRight: { dx: 1, dy: 0, dz: 0 }, d: { dx: 1, dy: 0, dz: 0 },
  ArrowUp: { dx: 0, dy: -1, dz: 0 }, w: { dx: 0, dy: -1, dz: 0 },
  ArrowDown: { dx: 0, dy: 1, dz: 0 }, s: { dx: 0, dy: 1, dz: 0 },
};

async function start(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const stage = document.getElementById('stage') as HTMLElement;
  const status = document.getElementById('status') as HTMLElement;
  const muteButton = document.getElementById('mute') as HTMLButtonElement;
  const ctx = canvas.getContext('2d')!;

  const platform = await loadPlatform();
  await platform.init();

  const sound = createSound();
  const save = createSave('grid-dodge.v1', { bestTicks: 0, muted: false });
  const record = save.load();
  sound.setMuted(record.muted);

  let rng: Rng = createRng();
  let state: State = createInitialState(FLAT);
  let phase: Phase = 'title';
  let busy = false; // 広告の間は入力を受けない
  let frame = 0;
  let overAt = 0;
  let shipX = state.player.x;
  let shipY = state.player.y;
  const queue: Move[] = [];

  fitCanvas(canvas, VIEW);

  const begin = async () => {
    if (busy || phase === 'playing') return;
    if (phase === 'over') {
      if (frame - overAt < RESTART_WAIT) return;
      busy = true;
      await platform.commercialBreak();
      busy = false;
    }
    rng = createRng();
    state = createInitialState(FLAT);
    shipX = state.player.x;
    shipY = state.player.y;
    queue.length = 0;
    phase = 'playing';
    platform.gameplayStart();
  };

  const finish = () => {
    phase = 'over';
    overAt = frame;
    if (state.tick > record.bestTicks) {
      record.bestTicks = state.tick;
      save.save(record);
    }
    sound.tone(110, 500, 0.3);
    platform.gameplayStop();
  };

  const push = (move: Move) => {
    if (phase !== 'playing') return;
    if (queue.length < MAX_QUEUED) queue.push(move);
  };

  const update = () => {
    frame++;
    if (phase === 'playing') {
      const before = state;
      const move = queue.shift() ?? null;
      state = step(state, move, rng);
      if (state.player !== before.player) sound.tone(520, 50, 0.12);
      if (state.wave > before.wave) sound.tone(760, 70, 0.1);
      if (state.hazards.some((h) => h.fireAt === state.tick && isFiring(h, state.tick))) sound.tone(180, 140, 0.2);
      if (!state.alive) finish();
    }
    shipX += (state.player.x - shipX) * SHIP_EASE;
    shipY += (state.player.y - shipY) * SHIP_EASE;
  };

  let shown = '';
  const render = () => {
    draw(ctx, { state, phase, shipX, shipY, bestTicks: record.bestTicks, frame });
    const text = `${formatSeconds(state.tick)} 秒　最高 ${formatSeconds(record.bestTicks)} 秒`;
    if (text !== shown) status.textContent = shown = text;
  };

  window.addEventListener('keydown', (e) => {
    const move = KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    const startKey = e.key === ' ' || e.key === 'Enter';
    if (!move && !startKey) return;
    e.preventDefault();
    if (e.repeat) return;
    if (phase !== 'playing') void begin();
    else if (move) push(move);
  });

  // フリック。指を離すのを待たず、決まった長さを動かした時点で1マス動く。
  // そのまま動かし続ければ、続けて次のマスへ動ける。
  let anchor: { id: number; x: number; y: number } | null = null;
  stage.addEventListener('pointerdown', (e) => {
    anchor = { id: e.pointerId, x: e.clientX, y: e.clientY };
    stage.setPointerCapture(e.pointerId);
    if (phase !== 'playing') void begin();
  });
  stage.addEventListener('pointermove', (e) => {
    if (!anchor || anchor.id !== e.pointerId) return;
    const dx = e.clientX - anchor.x;
    const dy = e.clientY - anchor.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_PX) return;
    push(Math.abs(dx) > Math.abs(dy) ? { dx: Math.sign(dx), dy: 0, dz: 0 } : { dx: 0, dy: Math.sign(dy), dz: 0 });
    anchor = { id: e.pointerId, x: e.clientX, y: e.clientY };
  });
  const release = (e: PointerEvent) => {
    if (anchor?.id === e.pointerId) anchor = null;
  };
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);

  const showMute = () => {
    muteButton.textContent = sound.muted ? '音: 切' : '音: 入';
  };
  muteButton.addEventListener('click', () => {
    sound.setMuted(!sound.muted);
    record.muted = sound.muted;
    save.save(record);
    showMute();
  });
  showMute();

  platform.loadingFinished();
  createLoop({ update, render }).start();
}

void start();
