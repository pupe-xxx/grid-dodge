// 入口。共通部分（kit）・ルール（game）・画面（ui）をつなぐ。
import { createInitialState, FLAT, isFiring, step, type Move, type State } from './game/rules';
import { createGrazeTracker, fallSpeed, GRAZE_BONUS, scoreOf, type GrazeTracker } from './game/score';
import { createSound } from './kit/audio';
import { createLoop } from './kit/loop';
import { loadPlatform } from './kit/platform';
import { createRng, type Rng } from './kit/rng';
import { createSave } from './kit/save';
import { createShaftView } from './ui/shaft';

type Phase = 'title' | 'playing' | 'over';

/** これだけ指を動かしたら1マス動く（画面上のピクセル） */
const SWIPE_PX = 26;
/** 溜めておく操作の上限。多すぎると、指を止めた後も動き続ける */
const MAX_QUEUED = 2;
/** 終わった直後は、この刻みの間だけ再開の操作を受けない（避けようとしたフリックで始まらないように） */
const RESTART_WAIT = 30;
/** キャラがマスからマスへ寄っていく速さ（1刻みで残りの何割を進むか） */
const SHIP_EASE = 0.4;
/** すれすれの時に時間を遅くする長さ（画面の刻み）と速さ */
const SLOW_FRAMES = 16;
const SLOW_SCALE = 0.35;
/** 落ちる速さ（メートル毎秒）を、壁が流れる量（ワールドの単位毎秒）に直す倍率 */
const FALL_UNITS_PER_METER = 1.6;

const KEYS: Record<string, Move> = {
  ArrowLeft: { dx: -1, dy: 0, dz: 0 }, a: { dx: -1, dy: 0, dz: 0 },
  ArrowRight: { dx: 1, dy: 0, dz: 0 }, d: { dx: 1, dy: 0, dz: 0 },
  ArrowUp: { dx: 0, dy: -1, dz: 0 }, w: { dx: 0, dy: -1, dz: 0 },
  ArrowDown: { dx: 0, dy: 1, dz: 0 }, s: { dx: 0, dy: 1, dz: 0 },
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function start(): Promise<void> {
  const canvas = $<HTMLCanvasElement>('game');
  const stage = $('stage');
  const status = $('status');
  const muteButton = $<HTMLButtonElement>('mute');
  const titleScreen = $('title-screen');
  const overScreen = $('over-screen');
  const flash = $('flash');
  const pops = $('pops');

  const platform = await loadPlatform();
  await platform.init();

  const sound = createSound();
  const save = createSave('grid-dodge.v2', { best: 0, muted: false });
  const record = save.load();
  sound.setMuted(record.muted);

  const view = createShaftView(canvas);
  const fit = () => view.resize(stage.clientWidth, stage.clientHeight);
  new ResizeObserver(fit).observe(stage);
  fit();

  let rng: Rng = createRng();
  let state: State = createInitialState(FLAT);
  let grazeTracker: GrazeTracker = createGrazeTracker();
  let grazes = 0;
  let phase: Phase = 'title';
  let busy = false; // 広告の間は入力を受けない
  let frame = 0;
  let overAt = 0;
  let shipX = state.player.x;
  let shipY = state.player.y;
  let fall = 0;
  /** 落ちる速さに掛ける倍率。当たった後は 0 へ落ちていく */
  let fallMul = 0.5;
  let timeScale = 1;
  let slowLeft = 0;
  /** ルールを進める分の端数（時間を遅くしている間に溜まる） */
  let carry = 0;
  let lastRender = performance.now();
  const queue: Move[] = [];

  const showScreens = () => {
    titleScreen.hidden = phase !== 'title';
    overScreen.hidden = phase !== 'over';
  };

  const flashScreen = (color: string, ms: number) => {
    flash.style.transition = 'none';
    flash.style.background = color;
    flash.style.opacity = '1';
    void flash.offsetWidth;
    flash.style.transition = `opacity ${ms}ms ease-out`;
    flash.style.opacity = '0';
  };

  const popText = (text: string, x: number, y: number) => {
    const p = view.project(x, y);
    const el = document.createElement('div');
    el.className = 'pop';
    el.textContent = text;
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    pops.append(el);
    el.addEventListener('animationend', () => el.remove());
  };

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
    grazeTracker = createGrazeTracker();
    grazes = 0;
    shipX = state.player.x;
    shipY = state.player.y;
    queue.length = 0;
    fallMul = 1;
    timeScale = 1;
    slowLeft = 0;
    carry = 0;
    view.reset();
    phase = 'playing';
    showScreens();
    platform.gameplayStart();
  };

  const finish = () => {
    phase = 'over';
    overAt = frame;
    const score = scoreOf(state.tick, grazes);
    const isBest = score > record.best;
    if (isBest) {
      record.best = score;
      save.save(record);
    }
    $('over-depth').textContent = `${score} m`;
    $('over-grazes').textContent = grazes > 0 ? `すれすれ ×${grazes}（+${grazes * GRAZE_BONUS} m）` : '';
    $('over-best').textContent = isBest ? '最高記録' : `最高 ${record.best} m`;
    $('over-best').classList.toggle('best', isBest);
    view.hit();
    flashScreen('rgba(255, 60, 40, 0.55)', 500);
    sound.tone(110, 500, 0.3);
    platform.gameplayStop();
    // 当たった瞬間を少し見せてから結果を出す
    setTimeout(() => phase === 'over' && showScreens(), 650);
  };

  const push = (move: Move) => {
    if (phase !== 'playing') return;
    if (queue.length < MAX_QUEUED) queue.push(move);
  };

  const tickOnce = () => {
    const before = state;
    const move = queue.shift() ?? null;
    state = step(state, move, rng);
    if (state.player !== before.player) sound.tone(520, 50, 0.12);
    if (state.wave > before.wave) sound.tone(760, 70, 0.1);
    if (state.hazards.some((h) => h.fireAt === state.tick && isFiring(h, state.tick))) sound.tone(180, 140, 0.2);
    const grazed = grazeTracker.update(state);
    if (grazed.length) {
      grazes++;
      view.graze(grazed);
      popText(`すれすれ +${GRAZE_BONUS}`, state.player.x, state.player.y);
      flashScreen('rgba(255, 255, 255, 0.18)', 260);
      sound.tone(1400, 90, 0.12);
      slowLeft = SLOW_FRAMES;
    }
    if (!state.alive) finish();
  };

  const update = () => {
    frame++;
    if (phase === 'playing') {
      timeScale = slowLeft > 0 ? SLOW_SCALE : 1;
      if (slowLeft > 0) slowLeft--;
      carry += timeScale;
      while (carry >= 1 && phase === 'playing') {
        carry -= 1;
        tickOnce();
      }
    } else {
      timeScale = 1;
    }
    if (phase === 'over') fallMul = Math.max(0, fallMul - 0.03);
    fall += (fallSpeed(state.tick) * FALL_UNITS_PER_METER * fallMul * timeScale) / 60;
    shipX += (state.player.x - shipX) * SHIP_EASE;
    shipY += (state.player.y - shipY) * SHIP_EASE;
  };

  let shown = '';
  const render = (alpha: number) => {
    const now = performance.now();
    const dt = (now - lastRender) / 1000;
    lastRender = now;
    const tickF = phase === 'playing' ? state.tick + Math.min(0.999, carry + alpha * timeScale) : state.tick;
    view.render({ state, tickF, shipX, shipY, fall, dt });
    const text = `深さ ${scoreOf(state.tick, grazes)} m　最高 ${record.best} m`;
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
  // 1回のフリックで動くのは1マスまで（勢いで2マス動かないように）。次に動くには指を離す。
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
    anchor = null;
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
  showScreens();

  platform.loadingFinished();
  createLoop({ update, render }).start();
}

void start();
