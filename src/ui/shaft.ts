// 描画。地下の縦穴を、キャラの上から見下ろす（Three.js）。
// ルールは 3x3 の平面のまま。障害は穴の底から迫り、撃たれる刻みにキャラのいる面を通り抜ける。
// 座標はワールドの単位で書く（1マス = CELL）。画面の実寸は resize だけが扱う。

import * as THREE from 'three';
import { covers, isFiring, type Cell, type Hazard, type State } from '../game/rules';
import { createRng, type Rng } from '../kit/rng';

/** 1マスの大きさ */
const CELL = 2;
/** 盤の半分の幅 */
const HALF = 1.5 * CELL;
/** 穴の内壁までの半分の幅 */
const WALL = HALF + 0.45;
/** 障害は、撃たれる刻みのこれだけ下から上がってくる */
const RISE_FROM = 42;
/** 壁の1区切りの長さと数。区切りを上へ流して、落ちているように見せる */
const SEG_LEN = 4;
const SEG_COUNT = 24;
const SEG_TOP = 16;
/**
 * 縦の視野角。狭くして遠くから見る。広いと奥の障害がみな真ん中に寄り、どのマスに来るか分からなくなる。
 * 狭いと、奥でもマスどうしが離れて見える
 */
const FOV_WIDE = 20;
const FOV_TALL = 24;
/**
 * 斜めに見下ろす角度の強さ。穴の底（消える点）が、画面の真ん中から上の端までのこの割合の所に来る。
 * 強く斜めにすると、障害がどのマスに来るかが分かりにくくなる（本人／2026-10-21）ので、ほぼ真上から見る
 */
const TILT = 0.12;
/** マスの筋（3x3 の格子）を穴の奥へ並べる間隔と数。障害がどのマスを上がってくるかを見せる */
const LANE_STEP = 5;
const LANE_COUNT = 16;
/** 穴の底の光る面の深さ。障害はこの光を背に影絵で見える */
const CORE_Y = -78;
/** 灯りの枠を置く間隔（壁の区切りの数） */
const FRAME_EVERY = 3;
/** 作る壁の向き（0: +z, 1: +x, 2: -z, 3: -x） */
const WALL_SIDES = [0, 1, 2, 3] as const;

const COLORS = {
  fog: 0x0a0810,
  rock: [0x4a4038, 0x3e3833, 0x524437],
  boulder: 0x6a5a4c,
  wood: 0x7a5230,
  iron: 0x2a2a2e,
  lava: 0xff6a1a,
  lavaGlow: 0xff3d00,
  crystal: [0x5ee7ff, 0xb388ff, 0x7cffc4],
  lamp: 0xffc46b,
  warn: 0xff3b3b,
  graze: 0xffffff,
  grid: 0x8fc2ff,
  suit: 0xe8a33a,
  suitDark: 0x9c5f1c,
  helmet: 0xe6e6e6,
  boots: 0x2b2420,
} as const;

export interface Frame {
  state: State;
  /** ルールの刻みを小数で（刻みの間を滑らかに描くため） */
  tickF: number;
  /** 画面上のキャラの位置（マス単位） */
  shipX: number;
  shipY: number;
  /** これまでに落ちた量（ワールドの単位）。壁と粒を流すのに使う */
  fall: number;
  /** 前の描画からの実時間（秒） */
  dt: number;
}

export interface ShaftView {
  resize(width: number, height: number): void;
  render(frame: Frame): void;
  /** すれすれで抜けたマスを光らせる */
  graze(cells: readonly Cell[]): void;
  hit(): void;
  /** 新しく遊び始める時に、残っている障害と演出を消す */
  reset(): void;
  /** 盤のマス（小数可）が画面のどこに映るか（canvas の左上からのピクセル） */
  project(x: number, y: number): { x: number; y: number };
}

const toWorld = (g: number) => (g - 1) * CELL;

/** 位置で決まる揺らぎ（同じ位置の頂点は同じだけ動くので、面が割れない） */
function jitterAt(x: number, y: number, z: number, seed: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed * 4.123) * 43758.5453;
  return s - Math.floor(s);
}

function rockGeometry(radius: number, seed: number, amount = 0.35): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(radius, 1);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const k = 1 + (jitterAt(+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3), seed) - 0.5) * amount;
    v.multiplyScalar(k);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

/** 壁の1枚。内側へでこぼこさせる。上下の端は揺らさないので、区切りどうしがつながる */
function wallPanel(seed: number): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(WALL * 2 + 0.6, SEG_LEN, 6, 3);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const edge = Math.abs(y) > SEG_LEN / 2 - 0.01;
    const k = edge ? 0.15 : jitterAt(x, y, 0, seed);
    pos.setZ(i, k * 0.7);
  }
  geo.computeVertexNormals();
  return geo;
}

interface Segment {
  group: THREE.Group;
  index: number;
  decor: THREE.Group;
}

interface Obstacle {
  key: string;
  object: THREE.Object3D;
  kind: Hazard['axis'];
  /** 1刻みで上がる量 */
  speed: number;
  y: number;
  spin: THREE.Vector3;
  /** ルールの状態から消えた後は、自分で上がり続ける */
  orphan: boolean;
}

interface CellMarks {
  fill: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  square: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  flash: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  flashLeft: number;
}

interface Debris {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
}

export function createShaftView(canvas: HTMLCanvasElement): ShaftView {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.localClippingEnabled = true;
  // キャラより上の壁は描かない（カメラの手前を大きく横切って、盤が見づらくなるため）。穴をのぞき込む形になる
  const belowPlayer = [new THREE.Plane(new THREE.Vector3(0, -1, 0), 0.2)];

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLORS.fog);
  scene.fog = new THREE.Fog(COLORS.fog, 20, 70);

  const camera = new THREE.PerspectiveCamera(FOV_WIDE, 1, 0.5, 300);
  camera.up.set(0, 0, -1);
  let cameraHeight = 14;
  const camHome = new THREE.Vector3(0, 14, 0);
  const camTarget = new THREE.Vector3();
  let shake = 0;

  // ── 明かり ─────────────────────────────
  scene.add(new THREE.HemisphereLight(0x5a6c90, 0x2a1608, 0.9));
  // 穴の底の溶岩の照り返し。上がってくる岩を下から照らす
  const deepGlow = new THREE.PointLight(0xff7a2a, 1400, 70, 1.5);
  deepGlow.position.set(0, CORE_Y + 8, 0);
  scene.add(deepGlow);
  // 穴の底の溶岩。霧に隠さず、いつも明るく見せる
  const core = new THREE.Mesh(
    new THREE.PlaneGeometry(WALL * 2.2, WALL * 2.2),
    new THREE.MeshBasicMaterial({ color: 0xff8a3a, fog: false }),
  );
  core.rotation.x = -Math.PI / 2;
  core.position.y = CORE_Y;
  scene.add(core);
  // キャラの明かり。手元と、下へ向けた灯り
  const lampNear = new THREE.PointLight(0xffd59a, 10, 6, 1.4);
  scene.add(lampNear);
  const lampDown = new THREE.SpotLight(0xffe2b0, 220, 80, 0.3, 0.8, 1.1);
  scene.add(lampDown, lampDown.target);

  // ── 壁 ─────────────────────────────────
  const rng: Rng = createRng(11);
  const rockMats = COLORS.rock.map(
    (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 1, flatShading: true, clippingPlanes: belowPlayer }),
  );
  const crystalMats = COLORS.crystal.map(
    (c) => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 1.6, roughness: 0.3, flatShading: true, clippingPlanes: belowPlayer }),
  );
  const lampMat = new THREE.MeshBasicMaterial({ color: COLORS.lamp, clippingPlanes: belowPlayer });
  const headLampMat = new THREE.MeshBasicMaterial({ color: COLORS.lamp });
  const woodMat = new THREE.MeshStandardMaterial({ color: COLORS.wood, roughness: 0.9, flatShading: true, clippingPlanes: belowPlayer });
  const ironMat = new THREE.MeshStandardMaterial({ color: COLORS.iron, roughness: 0.6, metalness: 0.6 });
  const crystalGeo = new THREE.ConeGeometry(0.22, 1.2, 5);
  const frameGeo = new THREE.BoxGeometry(WALL * 2, 0.12, 0.12);
  const frameMat = new THREE.MeshBasicMaterial({ color: 0xffb35c, clippingPlanes: belowPlayer });

  const segments: Segment[] = [];
  for (let i = 0; i < SEG_COUNT; i++) {
    const group = new THREE.Group();
    const mat = rockMats[i % rockMats.length]!;
    for (const side of WALL_SIDES) {
      const panel = new THREE.Mesh(wallPanel(i * 4 + side), mat);
      const a = (side * Math.PI) / 2;
      // 面の向きを穴の内側にそろえる
      panel.position.set(Math.sin(a) * WALL, 0, Math.cos(a) * WALL);
      panel.rotation.y = a + Math.PI;
      group.add(panel);
    }
    // 壁の飾り。結晶・灯り・坑道の支え
    const decor = new THREE.Group();
    group.add(decor);
    const roll = rng.next();
    const side = WALL_SIDES[rng.int(WALL_SIDES.length)]!;
    const a = (side * Math.PI) / 2;
    const along = (rng.next() - 0.5) * WALL * 1.4;
    const out = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
    const tangent = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a));
    const base = out.clone().multiplyScalar(WALL - 0.05).addScaledVector(tangent, along);
    if (roll < 0.4) {
      const mat2 = crystalMats[rng.int(crystalMats.length)]!;
      for (let k = 0; k < 3 + rng.int(3); k++) {
        const c = new THREE.Mesh(crystalGeo, mat2);
        const s = 0.6 + rng.next() * 0.9;
        c.scale.set(s, s * (0.8 + rng.next()), s);
        c.position.copy(base).addScaledVector(tangent, (rng.next() - 0.5) * 0.9);
        c.position.y = (rng.next() - 0.5) * 1.6;
        // 壁から内側へ斜めに生える
        c.lookAt(c.position.clone().addScaledVector(out, -1).add(new THREE.Vector3(0, rng.next() - 0.5, 0)));
        c.rotateX(Math.PI / 2);
        decor.add(c);
      }
    } else if (roll < 0.6) {
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.35, 0.25), lampMat);
      lamp.position.copy(base).addScaledVector(out, -0.15);
      decor.add(lamp);
    } else if (roll < 0.75) {
      // 坑道の支え（四隅の柱と横木）
      for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, SEG_LEN, 0.3), woodMat);
        post.position.set(sx * (WALL - 0.1), 0, sz * (WALL - 0.1));
        decor.add(post);
      }
    }
    if (i % FRAME_EVERY === 0) {
      // 灯りの枠。等しい間隔で奥へ縮んで並び、深さが分かる
      for (let k = 0; k < 4; k++) {
        const bar = new THREE.Mesh(frameGeo, frameMat);
        const b = (k * Math.PI) / 2;
        bar.position.set(Math.sin(b) * (WALL - 0.12), SEG_LEN / 2, Math.cos(b) * (WALL - 0.12));
        bar.rotation.y = b;
        decor.add(bar);
      }
    }
    scene.add(group);
    segments.push({ group, index: i, decor });
  }

  // ── 落ちる速さを見せる筋と粒 ─────────────
  const STREAKS = 70;
  const streakPos = new Float32Array(STREAKS * 6);
  const streakSeed = Array.from({ length: STREAKS }, () => {
    const a = rng.int(4);
    const along = (rng.next() - 0.5) * 2 * (WALL - 0.3);
    const inset = WALL - 0.25 - rng.next() * 0.4;
    const x = a === 0 ? inset : a === 1 ? -inset : along;
    const z = a === 2 ? inset : a === 3 ? -inset : along;
    return { x, z, y: rng.next(), len: 1.5 + rng.next() * 3 };
  });
  const streakGeo = new THREE.BufferGeometry();
  streakGeo.setAttribute('position', new THREE.BufferAttribute(streakPos, 3));
  const streakMat = new THREE.LineBasicMaterial({ color: 0xa9dcff, transparent: true, opacity: 0.35, clippingPlanes: belowPlayer });
  scene.add(new THREE.LineSegments(streakGeo, streakMat));

  const DUST = 260;
  const dustPos = new Float32Array(DUST * 3);
  const dustSeed = Array.from({ length: DUST }, () => ({
    x: (rng.next() - 0.5) * 2 * WALL,
    z: (rng.next() - 0.5) * 2 * WALL,
    y: rng.next(),
  }));
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  scene.add(
    new THREE.Points(
      dustGeo,
      new THREE.PointsMaterial({ color: 0xffd9a8, size: 0.07, transparent: true, opacity: 0.7, sizeAttenuation: true, clippingPlanes: belowPlayer }),
    ),
  );

  // ── キャラのいる面の目印（3x3 の線と予告） ───
  const gridPts: number[] = [];
  for (let i = 0; i <= 3; i++) {
    const p = -HALF + i * CELL;
    gridPts.push(-HALF, 0, p, HALF, 0, p, p, 0, -HALF, p, 0, HALF);
  }
  const gridGeo = new THREE.BufferGeometry();
  gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gridPts, 3));
  const grid = new THREE.LineSegments(
    gridGeo,
    new THREE.LineBasicMaterial({ color: COLORS.grid, transparent: true, opacity: 0.22, depthWrite: false }),
  );
  scene.add(grid);

  // マスの筋。3x3 の格子を一定の間隔で穴の奥へ並べ、上へ流す。
  // 障害はいつも自分のマスの筋の中を上がってくるので、遠くでもどのマスに来るかが分かる
  const laneMat = new THREE.LineBasicMaterial({ color: 0xffc98a, transparent: true, opacity: 0.16, depthWrite: false });
  const laneRings: THREE.LineSegments[] = [];
  for (let i = 0; i < LANE_COUNT; i++) {
    const ring = new THREE.LineSegments(gridGeo, laneMat);
    laneRings.push(ring);
    scene.add(ring);
  }

  const flat = (m: THREE.Object3D, y: number) => {
    m.rotation.x = -Math.PI / 2;
    m.position.y = y;
    m.renderOrder = 2;
  };
  const marks: CellMarks[] = [];
  const fillGeo = new THREE.PlaneGeometry(CELL * 0.94, CELL * 0.94);
  const ringGeo = new THREE.RingGeometry(0.93, 1, 40);
  const squareGeo = new THREE.RingGeometry(0.95, 1, 4, 1, Math.PI / 4);
  // 予告の塗りは、真ん中が濃く外へ薄れるぼんやりした光にする（硬い四角だと強すぎる）
  const glowTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.6, 'rgba(255,255,255,0.45)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      const basic = (color: number) =>
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
      const fill = new THREE.Mesh(fillGeo, basic(COLORS.warn));
      fill.material.map = glowTex;
      const ring = new THREE.Mesh(ringGeo, basic(COLORS.warn));
      const square = new THREE.Mesh(squareGeo, basic(COLORS.warn));
      const flash = new THREE.Mesh(fillGeo, basic(COLORS.graze));
      flash.material.blending = THREE.AdditiveBlending;
      for (const [m, y] of [[fill, 0.01], [ring, 0.03], [square, 0.03], [flash, 0.05]] as const) {
        flat(m, y);
        m.position.x = toWorld(gx);
        m.position.z = toWorld(gy);
        scene.add(m);
      }
      marks.push({ fill, ring, square, flash, flashLeft: 0 });
    }
  }

  // ── キャラ ────────────────────────────
  const ship = new THREE.Group();
  const body = new THREE.Group();
  ship.add(body);
  const suitMat = new THREE.MeshStandardMaterial({ color: COLORS.suit, roughness: 0.7, flatShading: true });
  const suitDarkMat = new THREE.MeshStandardMaterial({ color: COLORS.suitDark, roughness: 0.8, flatShading: true });
  const helmetMat = new THREE.MeshStandardMaterial({ color: COLORS.helmet, roughness: 0.4, flatShading: true });
  const bootMat = new THREE.MeshStandardMaterial({ color: COLORS.boots, roughness: 0.9, flatShading: true });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.5, 2, 8), suitMat);
  torso.rotation.x = Math.PI / 2;
  body.add(torso);
  const pack = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.2, 0.42), suitDarkMat);
  pack.position.set(0, 0.24, 0.05);
  body.add(pack);
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 1), helmetMat);
  head.position.set(0, 0.05, -0.55);
  body.add(head);
  const headLamp = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.06, 8), headLampMat);
  headLamp.position.set(0, 0.12, -0.74);
  headLamp.rotation.x = Math.PI / 2;
  body.add(headLamp);
  const limbGeo = new THREE.CapsuleGeometry(0.08, 0.5, 2, 6);
  const limbs: THREE.Object3D[] = [];
  const addLimb = (x: number, z: number, angle: number, mat: THREE.Material, end?: THREE.Material) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0, z);
    pivot.rotation.y = angle;
    const limb = new THREE.Mesh(limbGeo, mat);
    limb.rotation.z = Math.PI / 2;
    limb.position.x = 0.33;
    pivot.add(limb);
    if (end) {
      const tip = new THREE.Mesh(new THREE.IcosahedronGeometry(0.1, 0), end);
      tip.position.x = 0.66;
      pivot.add(tip);
    }
    body.add(pivot);
    limbs.push(pivot);
  };
  addLimb(0.2, -0.28, 0.6, suitMat, helmetMat); // 右腕（手袋）
  addLimb(-0.2, -0.28, Math.PI - 0.6, suitMat, helmetMat);
  addLimb(0.14, 0.32, -0.45, suitDarkMat, bootMat); // 右脚
  addLimb(-0.14, 0.32, Math.PI + 0.45, suitDarkMat, bootMat);
  ship.position.y = 0.4;
  scene.add(ship);

  // ── 障害 ───────────────────────────────
  // 遠くでも形が分かるよう、障害は少し自分で光らせる
  const boulderMat = new THREE.MeshStandardMaterial({
    color: COLORS.boulder, emissive: 0x6a4024, emissiveIntensity: 1, roughness: 1, flatShading: true,
  });
  const beamWoodMat = new THREE.MeshStandardMaterial({
    color: COLORS.wood, emissive: 0x6a3a10, emissiveIntensity: 1, roughness: 0.9, flatShading: true,
  });
  const boulderGeos = [0, 1, 2].map((s) => rockGeometry(0.88, 100 + s));
  const lavaMat = new THREE.MeshStandardMaterial({
    color: COLORS.lava, emissive: COLORS.lava, emissiveIntensity: 1.3, roughness: 0.5, flatShading: true,
  });
  const lavaGlowMat = new THREE.MeshBasicMaterial({
    color: COLORS.lavaGlow, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const lavaCoreGeo = (() => {
    const g = new THREE.BoxGeometry(0.85, 0.5, WALL * 2, 2, 2, 10);
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const z = pos.getZ(i);
      const wob = (jitterAt(0, 0, +z.toFixed(2), 7) - 0.5) * 0.25;
      pos.setX(i, pos.getX(i) * (1 + wob));
      pos.setY(i, pos.getY(i) * (1 + wob));
    }
    g.computeVertexNormals();
    return g;
  })();
  const lavaGlowGeo = new THREE.BoxGeometry(1.5, 1.0, WALL * 2);
  const beamGeo = new THREE.BoxGeometry(WALL * 2, 0.55, 0.8);
  const bandGeo = new THREE.BoxGeometry(0.14, 0.62, 0.88);

  const makeObstacle = (kind: Hazard['axis'], seed: number): THREE.Object3D => {
    if (kind === 'z') return new THREE.Mesh(boulderGeos[seed % boulderGeos.length]!, boulderMat);
    const group = new THREE.Group();
    if (kind === 'x') {
      // 渡された木の梁（横1行）
      group.add(new THREE.Mesh(beamGeo, beamWoodMat));
      for (const bx of [-WALL * 0.6, 0, WALL * 0.6]) {
        const band = new THREE.Mesh(bandGeo, ironMat);
        band.position.x = bx;
        group.add(band);
      }
    } else {
      // 壁から壁へ噴き出す溶岩（縦1列）
      group.add(new THREE.Mesh(lavaCoreGeo, lavaMat));
      group.add(new THREE.Mesh(lavaGlowGeo, lavaGlowMat));
    }
    return group;
  };

  const obstacles = new Map<string, Obstacle>();
  const keyOf = (h: Hazard) => `${h.spawnedAt}:${h.axis}:${h.at.x}:${h.at.y}:${h.at.z}`;
  let lastTickF = 0;

  // ── 当たった時のかけら ─────────────────
  const debris: Debris[] = [];
  const debrisGeo = new THREE.TetrahedronGeometry(0.16, 0);

  const placeObstacle = (o: Obstacle, h: Hazard) => {
    if (h.axis === 'z') o.object.position.set(toWorld(h.at.x), o.y, toWorld(h.at.y));
    else if (h.axis === 'x') o.object.position.set(0, o.y, toWorld(h.at.y));
    else o.object.position.set(toWorld(h.at.x), o.y, 0);
  };

  const updateObstacles = (state: State, tickF: number) => {
    const seen = new Set<string>();
    for (const h of state.hazards) {
      const key = keyOf(h);
      seen.add(key);
      let o = obstacles.get(key);
      if (!o) {
        const seed = h.at.x * 3 + h.at.y + h.spawnedAt;
        o = {
          key,
          object: makeObstacle(h.axis, seed),
          kind: h.axis,
          speed: RISE_FROM / (h.fireAt - h.spawnedAt),
          y: -RISE_FROM,
          spin: new THREE.Vector3(jitterAt(seed, 1, 0, 1) - 0.5, jitterAt(seed, 2, 0, 1) - 0.5, jitterAt(seed, 3, 0, 1) - 0.5)
            .multiplyScalar(0.12),
          orphan: false,
        };
        scene.add(o.object);
        obstacles.set(key, o);
      }
      o.y = -RISE_FROM + (tickF - h.spawnedAt) * o.speed;
      placeObstacle(o, h);
    }
    const dTick = Math.max(0, tickF - lastTickF);
    for (const o of obstacles.values()) {
      if (!seen.has(o.key)) {
        o.orphan = true;
        o.y += dTick * o.speed;
        o.object.position.y = o.y;
      }
      if (o.kind === 'z') {
        o.object.rotation.x += o.spin.x * dTick;
        o.object.rotation.y += o.spin.y * dTick;
        o.object.rotation.z += o.spin.z * dTick;
      }
      if (o.y > cameraHeight + 4) {
        scene.remove(o.object);
        obstacles.delete(o.key);
      }
    }
    lastTickF = tickF;
  };

  const updateMarks = (state: State, tickF: number, dt: number) => {
    for (let gy = 0; gy < 3; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        const m = marks[gy * 3 + gx]!;
        const cell = { x: gx, y: gy, z: 0 };
        let warnLine = -1;
        let warnRock = -1;
        let firing = false;
        for (const h of state.hazards) {
          if (!covers(h, cell)) continue;
          if (isFiring(h, state.tick)) {
            firing = true;
            continue;
          }
          const p = Math.min(1, Math.max(0, (tickF - h.spawnedAt) / (h.fireAt - h.spawnedAt)));
          if (h.axis === 'z') warnRock = Math.max(warnRock, p);
          else warnLine = Math.max(warnLine, p);
        }
        const p = Math.max(warnLine, warnRock);
        m.fill.material.opacity = firing ? 0.5 : p >= 0 ? 0.04 + 0.3 * p * p : 0;
        // 外から真ん中へ縮む枠。縮み切った時に撃たれる
        const shrink = (q: number) => CELL * 0.46 * (1 - q) + 0.12;
        m.ring.material.opacity = warnRock >= 0 ? 0.25 + 0.45 * warnRock : 0;
        m.ring.scale.setScalar(shrink(Math.max(0, warnRock)));
        m.square.material.opacity = warnLine >= 0 ? 0.25 + 0.45 * warnLine : 0;
        m.square.scale.setScalar(shrink(Math.max(0, warnLine)) * Math.SQRT2);
        m.flashLeft = Math.max(0, m.flashLeft - dt);
        m.flash.material.opacity = m.flashLeft * 2.2;
      }
    }
  };

  const updateShip = (frame: Frame, dt: number) => {
    const { state } = frame;
    const tx = toWorld(frame.shipX);
    const tz = toWorld(frame.shipY);
    // 動いた向きへ傾く
    const vx = (tx - ship.position.x) / Math.max(dt, 1e-3);
    const vz = (tz - ship.position.z) / Math.max(dt, 1e-3);
    ship.position.x = tx;
    ship.position.z = tz;
    const t = performance.now() / 1000;
    const tiltZ = THREE.MathUtils.clamp(-vx * 0.03, -0.7, 0.7);
    const tiltX = THREE.MathUtils.clamp(vz * 0.03, -0.6, 0.6);
    body.rotation.z += (tiltZ - body.rotation.z) * 0.3;
    body.rotation.x += (tiltX - body.rotation.x) * 0.3;
    body.rotation.y = Math.sin(t * 1.3) * 0.08;
    // 風を受けて手足が揺れる
    limbs.forEach((l, i) => (l.rotation.z = Math.sin(t * 9 + i * 1.7) * 0.08));
    ship.visible = state.alive;

    lampNear.position.set(ship.position.x, 1.8, ship.position.z);
    lampDown.position.set(ship.position.x, -0.5, ship.position.z);
    lampDown.target.position.set(ship.position.x * 0.5, -30, ship.position.z * 0.5);
  };

  const updateEnvironment = (fall: number) => {
    const total = SEG_LEN * SEG_COUNT;
    const bottom = SEG_TOP - total;
    for (const s of segments) {
      const raw = fall - s.index * SEG_LEN - bottom;
      s.group.position.y = (((raw % total) + total) % total) + bottom;
    }
    const range = 80;
    for (let i = 0; i < STREAKS; i++) {
      const st = streakSeed[i]!;
      const y = ((((st.y * range + fall * 1.4) % range) + range) % range) - (range - SEG_TOP);
      streakPos.set([st.x, y, st.z, st.x, y - st.len, st.z], i * 6);
    }
    streakGeo.attributes.position!.needsUpdate = true;
    for (let i = 0; i < DUST; i++) {
      const d = dustSeed[i]!;
      const y = ((((d.y * range + fall * 0.9) % range) + range) % range) - (range - SEG_TOP);
      dustPos.set([d.x, y, d.z], i * 3);
    }
    dustGeo.attributes.position!.needsUpdate = true;
    const laneRange = LANE_STEP * LANE_COUNT;
    laneRings.forEach((ring, i) => {
      const raw = fall * 1.0 - i * LANE_STEP;
      ring.position.y = -(((-raw % laneRange) + laneRange) % laneRange) - 0.01;
      ring.visible = ring.position.y < -1;
    });
  };

  const updateDebris = (dt: number) => {
    for (let i = debris.length - 1; i >= 0; i--) {
      const d = debris[i]!;
      d.mesh.position.addScaledVector(d.vel, dt);
      d.vel.multiplyScalar(1 - 1.5 * dt);
      d.vel.y += 6 * dt; // 落ちていく本人から見ると、かけらは上へ置いていかれる
      d.mesh.rotation.x += d.spin.x * dt;
      d.mesh.rotation.y += d.spin.y * dt;
      if (d.mesh.position.y > cameraHeight + 2) {
        scene.remove(d.mesh);
        debris.splice(i, 1);
      }
    }
  };

  const tmp = new THREE.Vector3();
  let viewW = 1;
  let viewH = 1;

  return {
    resize(width, height) {
      viewW = width;
      viewH = height;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      // 盤の上側（奥の列）寄りから、手前の列の向きへ斜めに見下ろす。穴の底が画面の上のほうに来て、奥行きが見える。
      // 盤が縦にも横にも収まる距離に置く
      const tall = camera.aspect < 1;
      camera.fov = tall ? FOV_TALL : FOV_WIDE;
      const vHalf = THREE.MathUtils.degToRad(camera.fov / 2);
      const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
      const tilt = Math.atan(TILT * Math.tan(vHalf));
      const dist = Math.max((WALL * 1.12) / Math.tan(hHalf), (WALL * 1.3) / Math.tan(vHalf));
      cameraHeight = dist * Math.cos(tilt);
      camHome.set(0, cameraHeight, -dist * Math.sin(tilt));
      camTarget.set(0, 0, 0);
      camera.updateProjectionMatrix();
      scene.fog = new THREE.Fog(COLORS.fog, dist + 15, dist + 95);
    },

    render(frame) {
      const dt = Math.min(0.1, frame.dt);
      updateEnvironment(frame.fall);
      updateObstacles(frame.state, frame.tickF);
      updateMarks(frame.state, frame.tickF, dt);
      updateShip(frame, dt);
      updateDebris(dt);
      lavaMat.emissiveIntensity = 1.3 + Math.sin(performance.now() / 90) * 0.25;

      shake = Math.max(0, shake - dt * 1.8);
      const sx = (Math.random() - 0.5) * shake * 0.8;
      const sz = (Math.random() - 0.5) * shake * 0.8;
      camera.position.set(camHome.x + sx, camHome.y, camHome.z + sz);
      camera.lookAt(camTarget.x + sx * 0.5, camTarget.y, camTarget.z + sz * 0.5);
      renderer.render(scene, camera);
    },

    graze(cells) {
      for (const c of cells) marks[c.y * 3 + c.x]!.flashLeft = 0.35;
    },

    hit() {
      shake = 1;
      for (let i = 0; i < 16; i++) {
        const mesh = new THREE.Mesh(debrisGeo, i % 3 === 0 ? helmetMat : suitMat);
        mesh.position.copy(ship.position);
        const a = (Math.PI * 2 * i) / 16;
        const vel = new THREE.Vector3(Math.cos(a) * 4, 1 + Math.random() * 3, Math.sin(a) * 4);
        debris.push({ mesh, vel, spin: new THREE.Vector3(Math.random() * 8, Math.random() * 8, 0) });
        scene.add(mesh);
      }
    },

    reset() {
      for (const o of obstacles.values()) scene.remove(o.object);
      obstacles.clear();
      for (const d of debris) scene.remove(d.mesh);
      debris.length = 0;
      for (const m of marks) m.flashLeft = 0;
      lastTickF = 0;
      shake = 0;
    },

    project(x, y) {
      tmp.set(toWorld(x), 0.4, toWorld(y)).project(camera);
      return { x: ((tmp.x + 1) / 2) * viewW, y: ((1 - tmp.y) / 2) * viewH };
    },
  };
}
