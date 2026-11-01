/**
 * 3D 牌桌渲染器（数据驱动）—— 由服务端下发的 view 重建场景，供网络版（3D）使用。
 *
 * 与 mahjong-3d/index.html 的关系：
 *   那份是「本地发牌 + 渲染」的演示，状态就是 Three.js 网格本身（hands/discards/melds/wallRing）；
 *   本模块把渲染与对局逻辑**解耦**：每次收到一帧 view（见 src/engine/game.js `viewFor`），
 *   就整桌重建一次。服务端是唯一权威，本模块只做表现，不改任何规则状态。
 *
 * view 契约（网络版 = createNetDriver 的 getView()）：
 *   { phase, turn, dealer, wallLeft, dice:[v1,v2], flipTile, wildTile, skinTiles, lastDiscard,
 *     discardLog:[{seat,tile}], me:{ seat, hand:[code], melds:[{type,tiles,from}], discards:[code], legal:[{type,tile,combos?}] },
 *     others:[{ seat, handCount, melds, discards, opened, hand? }] }   // hand 仅 settled 阶段下发
 *
 * 座位映射：引擎座位 0..3 → 本地方位 S/E/N/W，其中 S 恒为「我」，
 *   E=(me+1)%4（下家）· N=(me+2)%4（对家）· W=(me+3)%4（上家），与引擎逆时针出牌序一致。
 *
 * 交互：hover 抬升自家手牌；点击普通牌 → 出牌（opts.onAction({type:'discard',tile})）；
 *       点击红中/皮子/癞子 → 对应的特殊杠（红中杠/皮子杠/癞子杠，老吴 2026-10-20）。
 */
import * as THREE from '../mahjong-3d/vendor/three.module.js';
import { OrbitControls } from '../mahjong-3d/vendor/OrbitControls.js';
import { faceTexture, backTexture, sideTexture, clearTextureCache } from './assets/tiles3d.js';
import { avatarEl } from './render-widgets.js';
import { sortMeldsForDisplay } from '../src/engine/melds.js';
import { countFan } from '../src/engine/score.js';
import { createRuleSet } from '../src/engine/rules.js';
import { state } from './render-state.js';

/* ---------------- 尺寸常量（与 mahjong-3d 对齐） ---------------- */
const TILE_W = 0.045, TILE_H = 0.062, TILE_D = 0.026, TILE_GAP = 0.004;
const STEP_HAND = TILE_W * 0.97;             // 自家手牌步进（老吴 2026-10-24：微叠 3%，
                                             //  换取 HAND_SCALE 放大后整排不超宽——牌更大更好认）
const STEP_DISCARD = TILE_W + 0.008;         // 弃牌步进
const TABLE_Y = 0;
const WALL_STACKS = 17;
const WALL_HALF = (WALL_STACKS * TILE_W) / 2;   // 0.3825
const WALL_E_OUT = TILE_H / 2;
const SEAT_OFF = 0.16;    // 2026-10-24 参照截图二修：手牌往牌河中央内移，四边给信息牌留空档（S/N ±0.5425）
const CONTENT_HX = WALL_HALF + WALL_E_OUT + SEAT_OFF + 0.033;
const CONTENT_HZ = WALL_HALF + SEAT_OFF + 0.033;
const SEAT_PX = WALL_HALF + WALL_E_OUT + SEAT_OFF;
const SEAT_PZ = WALL_HALF + SEAT_OFF;
const MELD_STEP = TILE_W + 0.002;
const HAND_LIFT = 0.035;
const RED_DRAGON = 31;
/** 手牌摆布（老吴 2026-10-20）：红中 → 皮子 → 赖子 → 普通，组内按牌值升序。
 *  ⚠️ 红中恒为皮子；若极端规则把红中推成癞子，仍按「红中」排最左（左上角会显示红色块）。 */
export function handOrder(codes, wild, skins) {
  const rank = (t) => (t === RED_DRAGON ? 0 : t === wild ? 2 : skins.has(t) ? 1 : 3);
  return [...codes].sort((a, b) => rank(a) - rank(b) || a - b);
}
/* 手牌尺寸（老吴 2026-10-24 统一）：自家手牌、别家暗牌/摊牌、四家副露全部 1.7 倍同尺寸
   （牌河保持 1.5 的密度优先）。 */
const HAND_SCALE = 2.2;      // 别家手牌基准（E/W 的带宽上限也用它兜底）
const MY_HAND_SCALE = 3.5;   // 自家手牌明显更大（≈别家1.6倍）；3.5 时整排正好让开左右下角的信息牌（老吴 2026-10-24）
/* 对家/上家/下家**共用一个尺度**（老吴 2026-10-30 十四轮「把对家、上家、下家调到一样的尺度，
   尽量大一点」）。三家统一值时，真正的瓶颈是 E/W：它们是竖列，整列必须塞进
   「本家手牌内缘 ↔ 对家手牌内缘」这段桌深（13 张自然步距需 ≈0.586·v，可用带仅 ≈1.116），
   上限 ≈1.90（此时牌面露出率 70%，与本家/对家的 3.5 完全同口径，不会再压掉图案）。
   N 的单向极限是 3.5，统一后随 E/W 降到同一值。每帧由 applySize 求解，下限 1.4。 */
let COMMON_HAND_SCALE = HAND_SCALE;
/* S/N 固定手牌尺度（老吴 2026-10-31「手牌固定大小，不要变化，尽量大」）：
   取「MY_HAND_SCALE 与 14 张整排宽度上限 nCapW / 牌河避让上限 nCapZ」的最小值，
   只随视口几何变（窗口 resize），**与牌局进程完全无关** —— 打牌全程恒定。
   常规横屏 = 3.5。每帧由 applySize 求解。 */
let SN_HAND_SCALE = MY_HAND_SCALE;
/* E/W 竖列的「露出率」与「与自家手牌的缝」（老吴 2026-10-30 十七轮「其他玩家手牌再放大一些」）。
   E/W 是竖列：每张牌沿世界 z 只占 TILE_W（短边），所以沿 z 叠一点代价极小 ——
   旧代码按「自然步距 STEP_HAND」求值，等于强制 100% 露出，把带宽全浪费在这一项上。
   现在显式给一个露出率 76%（叠掉 24%，牌背完全看不出差别），换来整列 v 从 1.90 → 2.34。
   缝 0.03：列外缘与本家手牌内缘留 15px，不再贴死。 */
const EW_EXPOSURE = 0.76;
const EW_S_GAP = 0.03;
const flatRestY = (scl) => (TILE_D * scl) / 2 + 0.001;   // 躺平静置高度按各自 scale
const HAND_DRAW_GAP = 0.032;  // 刚摸的牌与手牌之间的空档
/* 选中的抬起量要明显小于悬停（老吴 2026-10-24）：两段式出牌里第二击点的是**原位置**，
   抬太高（HAND_LIFT=0.035 超过半张牌高）会把牌从手指底下移走、第二击点不中。
   悬停是鼠标的事（看得见会瞄准），选中抬起只要可辨识即可。 */
const SELECT_LIFT = 0.016;
/* 2026-10-24 老吴「参照俯视图」：透视相机 → 正交相机 + 正上方垂直俯视，
   四家手牌全部躺平（对局＝回放同一摆法）、不显示牌墙 —— 顶视 2D 桌面效果。
   躺平手牌的静置高度 = 牌厚一半离桌，悬停/选中的抬起动画都回到这个高度。 */
const FLAT_REST_Y = (TILE_D * HAND_SCALE) / 2 + 0.001;

const LOCAL_ORDER = ['S', 'E', 'N', 'W'];
const SEAT_SEED = [
  { key: 'S', yaw: 0, pos: [0, 0, SEAT_PZ], faceUp: true },
  { key: 'E', yaw: -Math.PI / 2, pos: [SEAT_PX, 0, 0], faceUp: false },
  { key: 'N', yaw: Math.PI, pos: [0, 0, -SEAT_PZ], faceUp: false },
  { key: 'W', yaw: Math.PI / 2, pos: [-SEAT_PX, 0, 0], faceUp: false },
];
const RING_SEATS = ['S', 'W', 'N', 'E'];
const RING_BASE = { S: 0, W: WALL_STACKS, N: 2 * WALL_STACKS, E: 3 * WALL_STACKS };
const MELD_N = { chi: 3, peng: 3, zhi: 4, xu: 4, an: 4, skin: 1, wild: 1, red: 1 };
/* 各家门前牌河（老吴 2026-10-27 起）：弃牌不堆桌心，按座位铺在**各家门前**。
   2026-10-31 定稿（老吴「和主视角一样，都从靠近中央指示器的地方开始排列，
   以各自的视角从左到右、从上到下；牌面再大一些」）：
   · 四家第一行都**贴中央指示器**，行朝各自手牌方向长（「上→下」= 各自视角的远→近）；
   · 行内按**各自视角**从左往右：S 左=世界 -x、N 左=+x（屏幕上镜像）、
     E 左=+z（朝 S 侧）、W 左=-z（朝 N 侧）；
   · S/N：6 列 × 3 行；E/W：行沿 x 从指示器铺向手牌，行内沿 z 排（每行 6 张）；
   · 牌面 RIVER_SCALE 1.8 → 2.0（+11%），半宽 0.265 → 0.29 仍容 6 列。
   容量不足时整组等比缩小。 */
const RIVER_SCALE = 2.0;
const RIVER_OUT = 0.42;       // S/N 最靠手牌一行的中心（|z|）；2.0 倍下最近指示器一行外沿 ≈0.094，不压桌心指示器
const RIVER_X_HALF = 0.29;    // S/N 行的横向半宽（6 列 @2.0 倍；0.265 在 2.0 倍下只能排 5 列）
const RIVER_EW_INNER = 0.32;  // E/W 牌河靠指示器一侧的内缘（|x|；S/N 牌河 x 外沿 = RIVER_X_HALF=0.29，留 0.03 缝）
const RIVER_EW_ROWS = 3;      // E/W 行数：与 S/N 同为 3 行，四家行距一致
const RIVER_EW_MAX_COLS = 6;  // E/W 每行最多 6 列 → 满编 3×6 = 18 张，够一整局
const WILD_POS = [0.42, -0.42];  // 癞子指示牌：东北对角空区（新 E 牌河占 x∈[0.32,0.63]、|z|≤0.285，
                                 // N 牌河占 x≤0.29 —— (0.42,-0.42) 与两者各留 ≥0.03）

/* 骰子 / 癞子指示牌要不要摆到桌上（老吴 2026-10-30 二十轮）：
   「牌河中不要显示骰子和赖子了」。这两样原本都落在中场 —— 两颗骰子摆在 E 牌河空档带、
   癞子牌摆在中央指示器右上角，四家牌河铺开以后它们夹在弃牌中间，看着像没归位的散牌。
   癞子信息已经由**左上角「赖」徽标**承担（net3d-main.js updateWildBadge），
   掷骰点数也只是开局仪式，不必占桌面，故默认都不渲染。
   代码与导出（diceValues / diceRestRot / counts）保留：回放对照、想恢复时把开关改 true 即可。 */
const SHOW_DICE = false;
const SHOW_WILD_MARKER = false;

const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const SUIT_CN = { wan: '万', tong: '筒', tiao: '条' };
const HONOR_CN = ['东风', '南风', '西风', '北风', '红中', '发财', '白板'];

/** 引擎编码 → 可读名（与 src/engine/tiles.js tileName 同口径） */
export function tileName(code) {
  if (!Number.isInteger(code) || code < 0 || code > 33) return '?';
  if (code >= 27) return HONOR_CN[code - 27];
  const suit = code < 9 ? 'wan' : code < 18 ? 'tong' : 'tiao';
  const rank = code < 18 ? (code % 9) + 1 : (code % 9) + 1;
  return CN_NUM[rank - 1] + SUIT_CN[suit];
}

function ringOrder() {
  const ord = [];
  for (const seat of RING_SEATS) {
    for (let k = 0; k < WALL_STACKS; k++) {
      const d = (seat === 'S' || seat === 'N') ? WALL_STACKS - 1 - k : k;
      ord.push({ seat, d });
    }
  }
  return ord;
}
const RING = ringOrder();

/** 段内第 (d 墩, layer 层) 的座位组局部坐标（与 mahjong-3d wallSlotPos 完全一致） */
function wallSlotPos(seatKey, d, layer) {
  const x = -WALL_HALF + (d + 0.5) * TILE_W;
  const y = TILE_D / 2 + layer * TILE_D;
  const z = (seatKey === 'S' || seatKey === 'N')
    ? WALL_HALF - SEAT_PZ
    : SEAT_PX - WALL_HALF - WALL_E_OUT;
  return [x, y, z];
}

function discardPerRow(seatKey) {
  const gap = (seatKey === 'E' || seatKey === 'W') ? 2 * (WALL_HALF - TILE_H / 2) : 2 * WALL_HALF;
  return Math.max(4, Math.min(8, Math.floor((gap - 0.02) / STEP_DISCARD) + 1));
}

/* ================================================================
 * 渲染器工厂
 * ================================================================ */
export function createRender3d(opts = {}) {
  let onAction = opts.onAction || (() => {});
  let onMessage = opts.onMessage || (() => {});
  const shadows = opts.shadows !== false;

  /* ---- 场景 ---- */
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0b2b1d'); // 比台呢深两档，把桌面衬托出来（2026-10-24 美化）

  // 2026-10-24 老吴「参照俯视图」：透视 → 正交 + 正上方垂直俯视，没有近大远小；
  // 四家牌躺平后从顶上看就是纯 2D 桌面。画面上方＝对家（-z），下方＝自家（+z）。
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 50);
  const FOCUS_Z = 0;                 // 2026-10-27 对称取景：内容 z∈±0.65，中心归 0 → 上下各只留
                                     // 0.02 边距（旧值 0.12 偏自家：裁对家手牌顶 0.10、自家手牌下空 0.14 一条）
  camera.up.set(0, 0, -1);
  camera.position.set(0, 2.2, FOCUS_Z);
  camera.lookAt(0, 0, FOCUS_Z);

  let renderer = null;
  let controls = null;
  let container = null;
  let labelLayer = null;
  const labelEls = {};
  const _labelV = new THREE.Vector3();
  const _labelBox = new THREE.Box3();
  /** 对家 N 横卡的下缘（上一帧）：矮屏时 W/E 卡要避让它，别互相压住。
   *  跨帧记录即可 —— N 卡位置稳定，首帧例外无害（一帧后自动对齐）。 */
  let _nLabelBottom = 0;

  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, FOCUS_Z);
    // 固定视角：不许旋转 / 拖动 / 缩放（老吴 2026-10-19）。取景完全交给 applySize。
    controls.enableRotate = false;
    controls.enablePan = false;
    controls.enableZoom = false;
    controls.minDistance = 0.7;
    controls.maxDistance = 2.2;
    controls.maxPolarAngle = 1.25;
    controls.update();
  } catch (err) {
    // 无 WebGL（旧浏览器 / 无头缺 GL）：场景仍可构建，便于测试与降级提示
    renderer = null;
    onMessage('WebGL 不可用：' + (err && err.message ? err.message : err));
  }

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  scene.add(new THREE.HemisphereLight(0xfff6e0, 0x1d5c3f, 0.42));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(1.2, 2.2, 0.8);
  sun.castShadow = shadows;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -1.5; sun.shadow.camera.right = 1.5;
  sun.shadow.camera.top = 1.5; sun.shadow.camera.bottom = -1.5;
  scene.add(sun);

  /* ---- 桌面（老吴 2026-10-24 美化）：绿绒台面 + 木质桌沿 ----
   * 此前牌直接浮在一片纯绿背景上（scene.background）。这里补两样，全部
   * 程序化 canvas 纹理，零外部素材（与「零依赖单文件」取向一致）：
   *   · 台呢面 —— 噪点织纹 + 极淡菱形织线，roughness 拉满吃光柔和；
   *   · 实木桌沿 —— 四条木纹框，略高于牌面形成围栏，投影落在台呢上。 */
  const FELT_SIZE = 1.36;
  const FRAME_W = 0.06;   // 2026-10-24 老吴：木纹太宽，收窄
  const FRAME_H = 0.05;

  function feltTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const g = c.getContext('2d');
    if (!g) return new THREE.CanvasTexture(c); // 无 2d context（jsdom 等）：空白贴图兜底
    g.fillStyle = '#1e7a4e';
    g.fillRect(0, 0, 512, 512);
    // 织纹噪点：两种明暗的细点随机铺
    for (let i = 0; i < 26000; i++) {
      const x = Math.random() * 512;
      const y = Math.random() * 512;
      g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.022)' : 'rgba(0,0,0,0.03)';
      g.fillRect(x, y, 1.2, 1.2);
    }
    // 极淡菱形织线（与 2D 台呢的暗纹同族观感）
    g.strokeStyle = 'rgba(255,255,255,0.016)';
    g.lineWidth = 1;
    for (let d = -512; d <= 1024; d += 32) {
      g.beginPath(); g.moveTo(d, 0); g.lineTo(d + 512, 512); g.stroke();
      g.beginPath(); g.moveTo(d + 512, 0); g.lineTo(d, 512); g.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  function woodTexture() {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 128;
    const g = c.getContext('2d');
    if (!g) return new THREE.CanvasTexture(c); // 无 2d context：空白贴图兜底
    g.fillStyle = '#7a4d28';
    g.fillRect(0, 0, 512, 128);
    // 顺纹理的深浅条（纵向正弦 + 噪声扰动）
    for (let x = 0; x < 512; x += 2) {
      const n = Math.sin(x * 0.22) * 6 + Math.sin(x * 0.07) * 10 + Math.random() * 5;
      g.fillStyle = `rgba(${(40 + n) | 0},${(22 + n * 0.6) | 0},0,0.14)`;
      g.fillRect(x, 0, 2, 128);
    }
    // 少量长条深纹
    for (let i = 0; i < 26; i++) {
      g.fillStyle = 'rgba(30,16,4,0.18)';
      g.fillRect(Math.random() * 400, Math.random() * 128, 60 + Math.random() * 110, 1.4);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    return tex;
  }

  const felt = new THREE.Mesh(
    new THREE.PlaneGeometry(FELT_SIZE, FELT_SIZE),
    new THREE.MeshStandardMaterial({ map: feltTexture(), roughness: 0.95, metalness: 0 }),
  );
  felt.rotation.x = -Math.PI / 2;
  felt.position.y = -0.0008; // 比牌底面略低一线，避免共面闪烁
  felt.receiveShadow = shadows;
  scene.add(felt);

  const woodMat = new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.62, metalness: 0.04 });
  // 上/下两条通长（含拐角），左/右两条只到台呢边缘 → 四角自然拼接
  const frameH = new THREE.BoxGeometry(FELT_SIZE + FRAME_W * 2, FRAME_H, FRAME_W);
  const frameV = new THREE.BoxGeometry(FRAME_W, FRAME_H, FELT_SIZE);
  const frameY = FRAME_H / 2 - 0.001;
  // 2026-10-24 老吴「桌面贴满屏宽」：上下两条随视口宽拉长、左右两条随视口宽外移 —— 存引用供 applySize 调
  const frameMeshes = [];
  for (const [x, z, geo, axis, sign] of [
    [0, -(FELT_SIZE / 2 + FRAME_W / 2), frameH, 'z', -1],
    [0, FELT_SIZE / 2 + FRAME_W / 2, frameH, 'z', 1],
    [-(FELT_SIZE / 2 + FRAME_W / 2), 0, frameV, 'x', -1],
    [FELT_SIZE / 2 + FRAME_W / 2, 0, frameV, 'x', 1],
  ]) {
    const m = new THREE.Mesh(geo, woodMat);
    m.position.set(x, frameY, z);
    m.castShadow = shadows;
    m.receiveShadow = shadows;
    m.userData.axis = axis;
    m.userData.sign = sign;
    frameMeshes.push(m);
    scene.add(m);
  }

  /* ---- 共享几何 / 材质 ---- */
  const tileGeo = new THREE.BoxGeometry(TILE_W, TILE_H, TILE_D);
  const SIDE_MAT = new THREE.MeshStandardMaterial({ map: sideTexture(), roughness: 0.8 });
  const BACK_MAT = new THREE.MeshStandardMaterial({ map: backTexture(), roughness: 0.85 });
  const faceMatCache = new Map();
  /** 当前这局的癞子 / 皮子牌面（null / 空集 = 无）。render() 每帧先更新，
   *  贴图缓存按「牌值 + 标记」分开：癞子红色块、皮子/红中蓝色块（无文字）。 */
  let wildCode = null;
  let skinCodes = new Set();
  function faceMatOf(code) {
    // 角标优先级（老吴 2026-10-28）：① 癞子 → 绿底「赖」；② 其余皮子 → 红底「皮」；
    // ③ 红中(RED_DRAGON) → **不需要角标**（老吴 13:39 明确：红中无角标，即便在皮子集合里也不加）。
    // 红中杠仍由引擎按 redgang 独立处理，与角标无关；红中与其它牌同材质，无额外高亮（2026-11-01 老吴去掉金色自发光）。
    const mark = wildCode !== null && code === wildCode
      ? 'wild'
      : (code === RED_DRAGON ? ''
      : (skinCodes.has(code) ? 'skin' : ''));
    const key = code + (mark ? ':' + mark : '');
    if (!faceMatCache.has(key)) {
      const m = new THREE.MeshStandardMaterial({ map: faceTexture(code, mark), roughness: 0.8 });
      faceMatCache.set(key, m);
    }
    return faceMatCache.get(key);
  }
  /** 造一张牌网格（faceUp=false 用牌背）。材质序 [+X,-X,+Y,-Y,+Z(面),-Z] */
  function makeTile(code, faceUp) {
    const face = faceUp ? faceMatOf(code) : BACK_MAT;
    const mesh = new THREE.Mesh(tileGeo, [SIDE_MAT, SIDE_MAT, BACK_MAT, SIDE_MAT, face, BACK_MAT]);
    mesh.castShadow = shadows;
    mesh.userData.code = code;
    mesh.userData.faceUp = !!faceUp;
    return mesh;
  }

  /* ---- 骰子（起手掷骰，服务端下发 view.dice）----
   * 服务端权威：点数来自引擎（同 seed 可复算），本模块只负责摆。
   * 静止姿态由「面值 v 朝上」的旋转决定，故两颗骰子共用同一套材质，靠 rotation 区分点数。 */
  const DICE_SIZE = 0.034;
  const DICE_FACES = [3, 4, 1, 6, 2, 5]; // BoxGeometry 材质序 [+x,-x,+y,-y,+z,-z]，对面点和为 7
  const PIPS = {
    1: [[0.5, 0.5]],
    2: [[0.28, 0.28], [0.72, 0.72]],
    3: [[0.28, 0.28], [0.5, 0.5], [0.72, 0.72]],
    4: [[0.28, 0.28], [0.72, 0.28], [0.28, 0.72], [0.72, 0.72]],
    5: [[0.28, 0.28], [0.72, 0.28], [0.5, 0.5], [0.28, 0.72], [0.72, 0.72]],
    6: [[0.28, 0.24], [0.72, 0.24], [0.28, 0.5], [0.72, 0.5], [0.28, 0.76], [0.72, 0.76]],
  };
  function diceTexture(v) {
    if (typeof document === 'undefined' || !document.createElement) return null;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const g = canvas.getContext('2d');
    if (!g) return null;
    g.fillStyle = '#f6f0dd'; g.fillRect(0, 0, 128, 128);
    g.strokeStyle = 'rgba(0,0,0,.28)'; g.lineWidth = 4;
    if (g.roundRect) { g.beginPath(); g.roundRect(4, 4, 120, 120, 18); g.stroke(); }
    g.fillStyle = v === 1 ? '#c0392b' : '#1a1a1a';
    for (const [fx, fy] of PIPS[v]) { g.beginPath(); g.arc(fx * 128, fy * 128, 13, 0, Math.PI * 2); g.fill(); }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }
  const DICE_MATS = DICE_FACES.map((v) => {
    const tex = diceTexture(v);
    return new THREE.MeshStandardMaterial({ map: tex || null, color: tex ? 0xffffff : 0xf6f0dd, roughness: 0.3, metalness: 0.05 });
  });
  /** 让面值 v 朝上（+Y）的静止欧拉角 */
  function diceRestRot(v) {
    switch (v) {
      case 1: return [0, 0, 0];
      case 2: return [-Math.PI / 2, 0, 0];
      case 3: return [0, 0, Math.PI / 2];
      case 4: return [0, 0, -Math.PI / 2];
      case 5: return [Math.PI / 2, 0, 0];
      case 6: return [Math.PI, 0, 0];
      default: return [0, 0, 0];
    }
  }
  const diceGeo = new THREE.BoxGeometry(DICE_SIZE, DICE_SIZE, DICE_SIZE);
  const diceGroup = new THREE.Group();
  diceGroup.visible = false;
  scene.add(diceGroup);
  const diceMeshes = [0, 1].map((i) => {
    const m = new THREE.Mesh(diceGeo, DICE_MATS);
    m.castShadow = shadows;
    m.visible = false;
    m.userData.dieIndex = i;
    diceGroup.add(m);
    return m;
  });
  // [x, z]：中央指示器右侧空档带（E/W 牌河中段空档内，不与门前牌河相撞，老吴 2026-10-27）
  const DICE_REST = [[0.47, 0.02], [0.47, 0.11]];
  let diceValues = null;

  /* ---- 座位组 ---- */
  const seatGroups = {};
  const groups = {};   // key -> { wall, meld, discard, hand }
  for (const s of SEAT_SEED) {
    const g = new THREE.Group();
    g.position.set(...s.pos);
    g.rotation.y = s.yaw;
    scene.add(g);
    seatGroups[s.key] = g;
    groups[s.key] = {
      hand: new THREE.Group(), meld: new THREE.Group(),
      discard: new THREE.Group(), wall: new THREE.Group(),
    };
    g.add(groups[s.key].hand, groups[s.key].meld, groups[s.key].discard, groups[s.key].wall);
  }
  // 弃牌区中心（座位组局部 z）：保留旧值兜底（牌河已改为各家门前，见 layoutRiverStrip）
  for (const s of SEAT_SEED) {
    const dz = WALL_HALF - 0.116 - SEAT_PZ;
    const dx = WALL_HALF - 0.035;
    if (s.key === 'S' || s.key === 'N') groups[s.key].discard.position.z = dz;
    else groups[s.key].discard.position.z = SEAT_PX - dx;
  }

  /* ---- 标记（癞子）---- */
  const markerGroup = new THREE.Group();
  scene.add(markerGroup);
  /* ---- 公共牌河（所有家统一铺在桌心）---- */
  const riverGroup = new THREE.Group();
  scene.add(riverGroup);
  let wildMesh = null;

  /* ---- 轻量 tween（仅 hover 用）---- */
  const tweens = [];
  function tween(obj, to, dur) {
    const from = {};
    for (const k in to) from[k] = obj[k];
    tweens.push({ obj, from, to, t: 0, dur });
  }
  function killTweens(obj) {
    for (let i = tweens.length - 1; i >= 0; i--) if (tweens[i].obj === obj) tweens.splice(i, 1);
  }
  function updateTweens(dt) {
    for (let i = tweens.length - 1; i >= 0; i--) {
      const tw = tweens[i];
      tw.t += dt;
      const p = Math.min(tw.t / tw.dur, 1);
      const e = 1 - Math.pow(1 - p, 3);
      for (const k in tw.to) tw.obj[k] = tw.from[k] + (tw.to[k] - tw.from[k]) * e;
      if (p >= 1) tweens.splice(i, 1);
    }
  }

  /* ---- 清场 ---- */
  function clearGroup(g) {
    for (let i = g.children.length - 1; i >= 0; i--) g.remove(g.children[i]);
  }
  let myHand = [];         // 自家手牌网格（raycast 目标）
  const rsCache = {};      // HUD「当前番数」用的规则集（按 preset 缓存）
  let currentView = null;
  let currentDriver = null;
  let currentSeat = 0;     // 我的引擎座位
  /* 各座位是否在线（seat → bool），由入口从 `table:players` 灌进来（老吴 2026-10-30）：
     引擎视图里没有连接状态，`connected` 只有房间知道。null = 还没收到 → 一律当作在线，
     回放（没有 socket）也走这条默认，不会把回放里的人都画成灰的。 */
  let onlineBySeat = null;
  let curHalfW = 1.45;     // 当前视口世界半宽（applySize 维护；副露缩放/落位用）
  let curHalfH = 0.80;     // 当前视口世界半高（applySize 维护；E/W 竖列带宽用）
  const keyOf = (seat) => LOCAL_ORDER[((seat - currentSeat) % 4 + 4) % 4];

  /* E/W 竖列可用「竖向带」半高（老吴 2026-11-01 修复「开口后折叠遮挡」）：
   *   横屏/桌面：上下家座位已被推到桌沿（seatXEW 大），整列在 x 向与 S/N 手牌大幅错开，
   *     直接用满屏幕可视高度（减缝留木框）即可让副露+手牌以自然步距摆开、不再压缩到牌背互压；
   *   手机竖屏：座位 x 仍落在 S/N 手牌 x 足迹内，竖向带受 S/N 手牌内缘限制，沿用旧值
   *     （HAND_Z - TILE_H·MY/2 - EW_S_GAP ≈0.53）避免新遮挡。两者取小后兜底 0.30。 */
  function ewZMax() {
    const sx = Math.abs(seatGroups.E.position.x);
    const narrow = HAND_Z - (TILE_H * MY_HAND_SCALE) / 2 - EW_S_GAP;
    const screenHalf = curHalfH - 0.07;   // 留 11px 给木框（牌外缘不压框）
    return Math.max(0.30, sx < 0.67 ? narrow : screenHalf);
  }

  function clearTable() {
    for (const k of LOCAL_ORDER) {
      clearGroup(groups[k].hand);
      clearGroup(groups[k].meld);
      clearGroup(groups[k].discard);
      clearGroup(groups[k].wall);
    }
    for (let i = markerGroup.children.length - 1; i >= 0; i--) markerGroup.remove(markerGroup.children[i]);
    clearGroup(riverGroup);
    myHand = [];
    wildMesh = null;
    hovered = null;
    selectedTileMesh = null;   // 手牌重排后旧选中 mesh 已废弃（两段式出牌）
    highlightedRiverCode = null;
    tweens.length = 0;
  }

  /* ---- 各区域布局 ---- */
  /* E/W 竖列（手牌+副露**合并成一列**，老吴 2026-10-27 五轮「副露在原有行显示，不要单独一行」）
     的世界 z 带宽：下端 0.44 不进本家手牌行；上端 -0.455 不进对家手牌/副露行
     （对家行南缘 -0.474，旧值 -0.64 会穿过它）。列长超带宽时**整列等比缩小**
     （手牌每张完整可见、不叠瓦），缩到 1.2 仍放不下才压缩步距。 */
  /* E/W 竖列的「世界 z 带宽」由 planMelds 按整列缩放 v 动态求解（老吴 2026-10-28 十轮
   * 「上/下家手牌放大到和对家一样，摆得下再往中间靠」）：
   *   带外缘 = HAND_Z - 极留白(clearPole) - 本列牌自身 z 向厚度(TILE_H·v/2)，
   *   其中 clearPole 取本家手牌行（MY_HAND_SCALE=3.5 最大）的内缘半厚 + 0.005；
   *   整列自然步距需求 spanNeed(v) = (n-1)·STEP_HAND·v + TILE_W·v ≤ 可用带 2·(HAND_Z-clearPole) - TILE_H·v
   *   → v ≤ 2(HAND_Z-clearPole) / ((n-1)·STEP_HAND + TILE_W + TILE_H)。
   *   横屏手机 844×390：13 张时 v≈1.5（八轮固定 0.28 边距时只有 ~1.2-1.3）；对家 2.2 需
   *   span≈1.25 世界单位，超出上下家手牌之间的可用高度，物理摆不下 —— 取可达最大值。
   *   缩到 1.2 仍放不下才由 ewColumnFit 压缩步距兜底（手牌每张完整可见、不叠瓦）。 */
  let HAND_Z = SEAT_PZ;                 // 上下家手牌外移后的世界 |z|（applySize 每帧重算）
  let EW_Z_MIN = -(SEAT_PZ - 0.28);
  let EW_Z_MAX = SEAT_PZ - 0.28;
  function ewColumnFit(n, stepMax, tileW) {
    const span = EW_Z_MAX - EW_Z_MIN;
    const step = n > 1 ? Math.min(stepMax, (span - tileW) / (n - 1)) : stepMax;
    const z0 = EW_Z_MIN + (span - ((n - 1) * step + tileW)) / 2 + tileW / 2;
    return { step, z0 };
  }
  /* 各座位手牌缩放：本家 S 固定 SN_HAND_SCALE（≈3.5）、N/E/W 三家固定 COMMON_HAND_SCALE
     （≈1.9，老吴 2026-10-31 深夜「对家的手牌和其他两家做到一致」—— 对家不再用 3.5） */
  const handScaleOf = (key) => (key === 'S' ? SN_HAND_SCALE : COMMON_HAND_SCALE);
  function layoutHand(key, codes, faceUp, drawn = null, xOffset = 0, ewCol = null, sclOverride = null) {
    const g = groups[key].hand;
    // 2026-10-24 老吴「参照俯视图」：四家手牌全部躺平（对局＝回放同一摆法），
    // 正交俯视镜头下就是纯 2D 桌面；自家与别家同尺寸（HAND_SCALE 统一）。
    // 2026-10-27 五轮：E/W 手牌并入副露同一列，整列统一用 planMelds 算好的缩放 ewCol.v。
    const ew = key === 'E' || key === 'W';
    // S/N 传 sclOverride（= plan.sc）——副露多到放不下时，手牌与副露一起缩，视口才装得下
    const scl = ew ? (ewCol ? ewCol.v : HAND_SCALE) : (sclOverride || handScaleOf(key));
    const step = STEP_HAND * scl;
    const gap = drawn != null ? HAND_DRAW_GAP * (scl / HAND_SCALE) : 0;
    const n = codes.length;
    const total = n + (drawn != null ? 1 : 0);
    const dirX = key === 'E' ? 1 : -1;
    /* 老吴 2026-10-31 深夜：「每次摸到新牌的时候，手牌的位置也会移动。改一下，
       新牌在最右侧就可以了，原有手牌位置不动。」
       —— 基础行只按 codes.length 居中（与没摸牌时逐张同位），刚摸的牌接在
       最右（原最后一张 + 自然步距 + 摸牌空档）。打牌后回到 n 张，位置不变。
       E/W 的 ewCol 兜底分支（ewColumnFit）仍用 total —— E/W 不会有 drawn。 */
    let left = n ? -((n - 1) * step) / 2 : 0;
    let colStep = step;
    let slotBase = 0;
    if (ew) {
      // E/W 竖列沿世界 z 排（世界 z = off，E/W 同构）；局部 x = dirX × off。
      // 有 ewCol（分块布局）→ 手牌块从 ewCol.handZ0 起、步距 backStep（副露块已由
      // layoutMeldsFrom 占据另一端，块间空档在 planMelds 里算好）；无则整列自适配。
      if (ewCol) { left = ewCol.handZ0; colStep = ewCol.backStep; }
      else { const col = ewColumnFit(total, step, TILE_W * scl); left = col.z0; colStep = col.step; }
    }
    const put = (code, i, isDrawn) => {
      const m = makeTile(code, faceUp);
      m.rotation.x = -Math.PI / 2;
      if (ew) m.rotateZ(Math.PI);   // E/W 读向修正：字头朝牌河（朝自己）
      const off = left + (slotBase + i) * colStep + (isDrawn ? gap : 0) + xOffset;
      m.position.set(ew ? dirX * off : off, flatRestY(scl), 0);
      m.scale.setScalar(scl);
      g.add(m);
      if (key === 'S' && faceUp) {
        m.userData.inHand = true;
        if (isDrawn) m.userData.drawn = true;
        myHand.push(m);
      }
    };
    codes.forEach((code, i) => put(code, i, false));
    // 新摸的牌先单独放最右，等这轮打完/下一轮再按顺序插回手牌
    if (drawn != null) put(drawn, n, true);
  }
  function layoutBacks(key, count, xOffset = 0, ewCol = null, sclOverride = null) {
    const g = groups[key].hand;
    // 2026-10-24 四家统一尺寸 + 全躺平：别家暗牌与自家同 scale、同摆法
    // 2026-10-27 五轮：E/W 并列缩放同 layoutHand
    const ew = key === 'E' || key === 'W';
    const scl = ew && ewCol ? ewCol.v : (sclOverride || handScaleOf(key));
    const step = STEP_HAND * scl;
    const dirX = key === 'E' ? 1 : -1;
    let left = count ? -((count - 1) * step) / 2 : 0;
    let colStep = step;
    let slotBase = 0;
    if (ew) {
      if (ewCol) { left = ewCol.handZ0; colStep = ewCol.backStep; }
      else { const col = ewColumnFit(count, step, TILE_W * scl); left = col.z0; colStep = col.step; }
    }
    for (let i = 0; i < count; i++) {
      const m = makeTile(0, false);
      m.rotation.x = -Math.PI / 2;
      if (ew) m.rotateZ(Math.PI);   // E/W 读向修正
      const off = left + (slotBase + i) * colStep + xOffset;
      m.position.set(ew ? dirX * off : off, flatRestY(scl), 0);
      m.scale.setScalar(scl);
      g.add(m);
    }
  }
  /* ---- 副露布局（老吴 2026-10-27 五轮重构）----
   * S/N：普通副露（吃/碰/杠）与手牌**同行**铺在手牌行末端；特殊杠（红中/癞子/皮子，
   * 单张）在该端**朝桌心**错一行摆（视效＝手牌行末端的左上角）。放不下时副露整组缩小。
   * E/W：手牌是竖列，副露**并入同一列**（不再单独一列）——列序从上(左上角)往下：
   * 特殊杠 → 普通副露 → 手牌；整列统一缩放塞进 z 带 [EW_Z_MIN, EW_Z_MAX]，手牌每张完整。 */
  /** 指定缩放下的手牌行半宽（副露要不要缩、缩多少都靠它算） */
  function handHalfAt(count, drawn, scl) {
    const step = STEP_HAND * scl;
    const gap = drawn ? HAND_DRAW_GAP * (scl / HAND_SCALE) : 0;
    return ((count - 1 + (drawn ? 1 : 0)) * step + gap) / 2 + (TILE_W * scl) / 2;
  }
  function handHalfOf(key, count, drawn) {
    return handHalfAt(count, drawn, handScaleOf(key));
  }
  function planMelds(key, melds, handCount, drawn) {
    const settled = !!(currentView && currentView.phase === 'settled');
    const isReplay = !!(currentView && currentView.replay);
    const normal = [], special = [];
    for (const meld of melds || []) {
      const tiles = meld.tiles || [];
      const isAn = meld.type === 'an';
      const bucket = (meld.type === 'red' || meld.type === 'wild' || meld.type === 'skin') ? special : normal;
      tiles.forEach((code, i) => {
        const faceUp = isAn && isReplay
          ? i === 0
          : settled || (code !== -1 && code !== null && code !== undefined && !(isAn && i > 0));
        bucket.push({ code, faceUp });
      });
    }
    /* 别家（E/W）手牌尺度固定 = COMMON_HAND_SCALE（老吴 2026-10-31「手牌固定大小，
       不要变化」）—— COMMON 只由视口几何决定，与牌局进程无关。
       2026-10-31 深夜二修「上/下家的牌还是重叠了」：手背下限 50% 太激进（叠掉一半，
       看着就是互相遮挡），提到 70%；副露（明牌）76%；块间空档 0.09 → 0.06。
       典型视口（带宽 1.063、v=1.90）实测：0 副 87% / 1 碰 78% / 带杠 72% /
       极端多杠 ≥63% —— 全程无明显叠瓦，且 v 恒定不变。
       分块：副露块与手牌块分开排步距；特殊杠（红中/赖子/皮子）**不进竖列**，
       由 layoutMeldsFrom 摆到列旁的平行行（朝桌心），与本家 S 同构（老吴深夜）。
       两块都压到下限还放不下（极端多杠）才缩 v —— 最后手段。 */
    const plan = { key, normal, special, sc: handScaleOf(key), meldLeft: 0, handX: 0, spLeft: 0, ew: null };
    if (key === 'E' || key === 'W') {
      const GAPW = 0.06;                       // 副露块 ↔ 手牌块空档（世界单位）
      const v0 = COMMON_HAND_SCALE;
      EW_Z_MAX = ewZMax();   // 视口几何算好的竖向带（横屏用满屏高、竖屏受 S/N 手牌限制）
      EW_Z_MIN = -EW_Z_MAX;
      const span = EW_Z_MAX - EW_Z_MIN;
      const m = normal.length;                 // 副露块张数（特殊杠不占列，见上）
      const h = handCount;                     // 手牌块张数
      const v = v0;                            // 恒定：任何牌局都不缩（老吴「固定大小，不要变化」）
      const tileW = TILE_W * v;
      const meldFloor = EW_EXPOSURE * tileW;
      const backFloor = 0.7 * tileW;
      let meldStep = STEP_HAND * v;              // 副露：先试自然步距（完全分开）
      let backStep = STEP_HAND * v;              // 手牌：同上
      const meldSpan = () => (m > 0 ? (m - 1) * meldStep + tileW : 0);
      const backSpan = () => (h > 0 ? (h - 1) * backStep + tileW : 0);
      const gapW = m > 0 && h > 0 ? GAPW : 0;
      let over = meldSpan() + gapW + backSpan() - span;
      if (over > 0) {                            // ① 先压手牌步距到 70% 露出
        const canGive = h > 1 ? (backStep - backFloor) * (h - 1) : 0;
        const give = Math.min(canGive, over);
        backStep -= give / (h - 1);
        over -= give;
      }
      if (over > 0) {                            // ② 再压副露步距（保 76% 露出）
        const canGive = m > 1 ? (meldStep - meldFloor) * (m - 1) : 0;
        const give = Math.min(canGive, over);
        meldStep -= give / (m - 1);
        over -= give;
      }
      if (over > 0) {                            // ③ 极端多杠兜底：两块同压到 60% 露出，绝不叠死
        const gaps = Math.max(1, (h - 1) + (m - 1));
        const cut = over / gaps;
        backStep = Math.max(0.6 * tileW, backStep - cut);
        meldStep = Math.max(0.6 * tileW, meldStep - cut);
      }
      // 整体居中：副露块在列的一端、手牌块在另一端；W＝副露靠 EW_Z_MIN 侧，
      // E＝取负镜像（副露靠 EW_Z_MAX 侧＝下家自己左手边，与 2026-10-31 定向一致）
      const total = meldSpan() + gapW + backSpan();
      const zStart = EW_Z_MIN + (span - total) / 2;
      const flip = key === 'E' ? -1 : 1;
      const z0 = flip * (zStart + tileW / 2);                          // 副露第 1 张中心
      const handZ0 = flip * (zStart + meldSpan() + gapW + tileW / 2);  // 手牌第 1 张中心
      plan.sc = v;
      plan.ew = { v, meldStep: flip * meldStep, backStep: flip * backStep, z0, handZ0, m };
      return plan;
    }
    /* S/N（老吴 2026-10-31 定稿「手牌、副露都固定大小，尽量大，不要变化」）：
       · 本家 S 手牌恒 SN_HAND_SCALE（常规视口 = 3.5，只随窗口 resize 变）；
         对家 N 与上/下家一致用 COMMON_HAND_SCALE（≈1.9，深夜改）；
       · S 的副露也恒定 3.5（与手牌同行同尺寸），只有真放不下（3 副以上把整行顶出视口）
         才按比例缩一点 —— 缩放是最后手段；
       · 副露挂在手牌左侧会打破行的对称 → 先把「手牌+副露」整行平移居中（handX），
         平移解决不了才缩副露；
       · 预算按「手牌 + 刚摸 1 张」的最宽行算（碰/杠后行宽 +1 张/副），摸牌/打牌
         不会引起副露脉冲缩放。 */
    /* N（老吴 2026-10-31 深夜定稿）：对家手牌与上/下家**同一尺度** COMMON_HAND_SCALE
       （≈1.9）——「对家的手牌为啥比我的还大，和其他两家做到一致就行」。
       此前 N 与本家同用 3.5，比别家大了近一倍。整行（手牌+副露）放不下时才等比缩。 */
    const meldW = (v) => (normal.length ? (normal.length - 1) * MELD_STEP * v + TILE_W * v : 0);
    // S 本家恒 3.5；N 对家与 E/W 一致用 COMMON（≈1.9，老吴 2026-10-31 深夜）
    const sc = key === 'S' ? SN_HAND_SCALE : COMMON_HAND_SCALE;
    const hhBudget = handHalfAt(handCount, 1, sc);   // 预算：最宽行（含摸牌槽）——副露缩放判定用
    /* 老吴 2026-10-31 深夜「摸新牌手牌位置不动」：副露锚点改用**不含摸牌**的行半宽 hh0，
       平移上限也永久预留摸牌槽（step+gap）—— 摸牌/打牌前后副露与手牌逐张同位，
       摸牌只出现在最右端，不再引起整行重排。 */
    const hh = handHalfAt(handCount, null, sc);
    const C = curHalfW - 0.06;                       // 视口内缘（左右各留 0.06）
    let meldScl = sc;
    if (normal.length) {
      const denom = (normal.length - 1) * MELD_STEP + 1.5 * TILE_W;   // meldW + 左缘半张
      const fit = (2 * C - 2 * hhBudget - 0.02) / denom;
      meldScl = Math.max(1.0, Math.min(sc, Math.floor(fit * 100) / 100));
    }
    // 平移居中：整行偏左时右移；上限预留摸牌槽（稳定值，与是否已摸牌无关 → 副露不跳）
    const DRAW_SLOT = STEP_HAND * sc + HAND_DRAW_GAP * (sc / HAND_SCALE);
    const L = hh + 0.02 + meldW(meldScl) + (TILE_W * meldScl) / 2;
    const shift = L > C ? Math.max(0, Math.min((L - hh) / 2, C - hh - DRAW_SLOT)) : 0;
    plan.sc = sc;
    plan.meldScl = meldScl;
    plan.handX = shift;
    plan.meldLeft = -hh - 0.02 - meldW(meldScl) + shift;
    plan.spLeft = plan.meldLeft;
    return plan;
  }
  function layoutMeldsFrom(plan) {
    const key = plan.key;
    const g = groups[key].meld;
    const { normal, special, sc } = plan;
    if (key === 'E' || key === 'W') {
      // 分块（老吴 2026-10-31 深夜）：竖列里只有普通副露（与手牌同一列，槽位由 planMelds 算好）；
      // 特殊杠（红中/赖子/皮子）**不进竖列** —— 错到列中段、朝桌心留间隙（见下方 spGap），
      // 避开对家头像(顶)与我的手牌(底)的遮挡。
      const ewCol = plan.ew;
      const dirX = key === 'E' ? 1 : -1;   // 世界 z = off（E/W 同构）；局部 x = dirX × off
      normal.forEach((t, s) => {
        const m = makeTile(t.code, t.faceUp);
        const off = ewCol.z0 + s * ewCol.meldStep;
        m.position.set(dirX * off, flatRestY(ewCol.v), 0);
        m.rotation.x = -Math.PI / 2;
        m.rotateZ(Math.PI);   // 与 E/W 手牌同读向
        m.scale.setScalar(ewCol.v);
        g.add(m);
      });
      // 特殊杠：与竖列脱开、移到**列中段**、朝桌心错开（老吴 2026-11-01：
      // 原先贴着副露块、落在竖列顶端/底端，被对家头像(顶)与我的手牌(底)压住；
      // 现改为列中段、留出清晰间隙，既避开顶/底遮挡，又满足「往右一些」）。
      const spGap = TILE_H * ewCol.v / 2 + 0.06;   // 列外缘 → 特殊杠中心 的间隙（朝桌心）
      const nSp = special.length;
      special.forEach((t, s) => {
        const m = makeTile(t.code, t.faceUp);
        const off = (s - (nSp - 1) / 2) * ewCol.meldStep;   // 沿局部 x 居中铺开 → 世界 z 居中（列中段）
        m.position.set(dirX * off, flatRestY(ewCol.v), spGap);
        m.rotation.x = -Math.PI / 2;
        m.rotateZ(Math.PI);   // 与 E/W 手牌同读向
        m.scale.setScalar(ewCol.v);
        g.add(m);
      });
      return;
    }
    // S/N：普通副露与手牌同行（行末端），特殊杠在该端朝桌心错一行
    const dir = key === 'S' || key === 'N' ? 1 : -1;   // S/N 副露落在各自左手边（视角左/右）；E/W 走竖列分支
    const place = (seq, zLocal, startWorldX, scl = sc) => {
      const stp = MELD_STEP * scl;
      seq.forEach((t, i) => {
        const m = makeTile(t.code, t.faceUp);
        m.position.set(dir * (startWorldX + i * stp), (TILE_D * scl) / 2 + 0.001, zLocal);
        m.rotation.x = -Math.PI / 2;
        m.scale.setScalar(scl);
        g.add(m);
      });
    };
    place(normal, 0, plan.meldLeft, plan.meldScl || sc);   // 副露用自身固定尺度（老吴 2026-10-31）
    if (special.length) {
      /* 特殊杠（红中 / 癞子 / 皮子，单张）老吴 2026-10-30 十五轮：
         「我的红中赖子皮杠出以后的副露和其他玩家的手牌一样大小」——
         改用别家公共尺度（= E/W 手牌尺寸），与副露尺度取小：副露被压缩时它同步缩，
         不会出现「副露缩了、杠牌不缩」、也不会比同行副露更宽戳出行外。
         「上方」= 朝牌河中央：S 局部 -z / N 局部 -z（N 世界 z = -局部 z，同为朝中央）。
         错行量按「手牌行半厚 + 本牌半厚 + 0.01」算 —— 牌变小后离手牌行自然更近，仍不压。 */
      const spScl = Math.min(plan.meldScl || sc, COMMON_HAND_SCALE);
      const zLocal = -(TILE_H * sc) / 2 - (TILE_H * spScl) / 2 - 0.01;
      place(special, zLocal, plan.spLeft, spScl);
    }
  }
  /* 各家门前牌河（老吴 2026-10-27）：每家打出的牌铺在该家门前（手牌与中央指示器之间）。
     2026-10-30 十九轮起四家**同一套横排网格**（牌不转向）：
       · S/N：6 列 × 3 行；E/W：行沿 x 从指示器铺向手牌，行内沿 z 排。
     容量不足时整组等比缩小。
     2026-10-31 定稿（老吴）：四家统一「**从靠近中央指示器处起摆**，以各自视角
       从左到右、从上到下」—— S 不变；N 行序翻回第一行贴指示器、行内改为 N 视角
       左→右（世界 +x→-x，屏幕上镜像）；E/W 行沿 x 从指示器长向手牌，
       行内沿 z 按 E/W 各自视角（E 左=+z、W 左=-z）。 */
  function riverColsOf(s) {
    return Math.max(3, Math.min(8, Math.floor((2 * (RIVER_X_HALF - (TILE_W * s) / 2)) / (TILE_W * s + 0.006)) + 1));
  }
  /* E/W 牌河的内缘（|x|）：指示器是**固定像素宽**的 DOM 胶囊，它在世界坐标里的半宽
     随视口缩放变化（1280 宽时 ≈0.21，844×390 矮屏时 ≈0.42），所以不能写死常量 ——
     按「指示器实际像素宽 / 当前每世界单位像素数」反算，再加 0.035 空档。
     写死 0.30 时矮屏会直接把牌压到指示器上（量测发现的）。 */
  function riverEWInner() {
    const el = document.getElementById('center-indicator');
    const pxPerUnit = ((container && container.clientWidth) || 1280) / (curHalfW * 2);
    const halfPx = el && !el.hidden ? el.offsetWidth / 2 : 95;
    return Math.max(RIVER_EW_INNER, halfPx / pxPerUnit + 0.035);
  }
  /* E/W 每行的张数（行内沿 z 排）：与 S/N 行**同宽**（2·RIVER_X_HALF），四家牌河横竖同宽。
     另需保证 3 行沿 x 能塞进「指示器内缘 ↔ 手牌内缘」，塞不下由 layoutRiverStrip 的缩小循环兜底。 */
  function riverEWColsOf(s) {
    const step = TILE_W * s + 0.006;
    return Math.max(2, Math.min(RIVER_EW_MAX_COLS, Math.floor((2 * (RIVER_X_HALF - (TILE_W * s) / 2)) / step) + 1));
  }
  /* E/W 手牌内缘（|x|）：牌河 3 行沿 x 的外沿不得越过它。 */
  function riverEWHandInner() {
    return Math.abs(seatGroups.E.position.x) - (TILE_H * COMMON_HAND_SCALE) / 2 - 0.05;
  }
  function layoutRiverStrip(key, tiles) {
    const n = tiles.length;
    if (!n) return;
    const sn = key === 'S' || key === 'N';
    const isEW = !sn;
    const stepW = (s) => TILE_W * s + 0.006;
    const inner = sn ? 0 : riverEWInner();
    const capOf = (s) => (sn ? 3 * riverColsOf(s) : RIVER_EW_ROWS * riverEWColsOf(s));
    let s = RIVER_SCALE;
    while (s > 0.6 && (capOf(s) < n ||
      (isEW && inner + TILE_W * s + (RIVER_EW_ROWS - 1) * (TILE_H * s + 0.008) > riverEWHandInner()))) s -= 0.1;
    const step = stepW(s);
    const rowH = TILE_H * s + 0.008;
    const tileW = TILE_W * s;
    /* 牌河朝向：须与各家「自己手牌」一致（老吴 2026-11-01）。
     * 手牌在带 yaw 的座位组里、且 E/W 单牌额外 rotateZ(π)；牌河在**无旋转**的 riverGroup，
     * 故把「座位 yaw ∘ 单牌旋转」折算成世界四元数直接套到牌河牌上：
     *   S：Rx(-π/2)；N：Ry(π)·Rx(-π/2)；E：Ry(-π/2)·Rx(-π/2)·Rz(π)；W：Ry(π/2)·Rx(-π/2)·Rz(π)。 */
    const seatYaw = key === 'N' ? Math.PI : key === 'E' ? -Math.PI / 2 : key === 'W' ? Math.PI / 2 : 0;
    const isEw = (key === 'E' || key === 'W');
    const qTile = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, isEw ? Math.PI : 0));
    const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), seatYaw);
    const riverQuat = qYaw.multiply(qTile);   // qYaw * qTile（匹配各家手牌世界朝向）
    for (let i = 0; i < n; i++) {
      const m = makeTile(tiles[i].tile, true);
      m.quaternion.copy(riverQuat);     // 各家牌河朝向 = 该家手牌朝向
      if (sn) {
        const cols = riverColsOf(s);
        const row = Math.floor(i / cols), col = i % cols;
        // 老吴 2026-10-31 定稿：第一行贴中央指示器，行朝各自手牌方向长（各自视角的上→下）；
        // 行内按各自视角从左往右：S 左 = 世界 -x；N 面朝桌心，左 = 世界 +x（屏幕上镜像）。
        const zSn = (RIVER_OUT - (2 - row) * rowH) * (key === 'S' ? 1 : -1);
        const xSn = key === 'S'
          ? -((cols - 1) / 2) * step + col * step
          : +((cols - 1) / 2) * step - col * step;
        m.position.set(xSn, TILE_W / 2 + 0.001, zSn);
      } else {
        /* E/W（老吴 2026-10-31 定稿）：行沿 x **从指示器铺向各自手牌**（各自视角的上→下，
           第一行贴指示器，不再以 z=0 居中悬空）；行内沿 z 按各自视角从左往右：
           E 面朝 -x，左 = 世界 +z（朝 S 侧）；W 面朝 +x，左 = 世界 -z（朝 N 侧）。
           列位仍是固定网格（新牌不顶跑旧牌），3 行外沿不越手牌（缩小循环已保证）。 */
        const cols = riverEWColsOf(s);
        const row = Math.floor(i / cols), col = i % cols;
        const zEW = key === 'E'
          ? +((cols - 1) / 2) * step - col * step
          : -((cols - 1) / 2) * step + col * step;
        const xEW = (inner + tileW / 2 + row * rowH) * (key === 'E' ? 1 : -1);
        m.position.set(xEW, TILE_W / 2 + 0.001, zEW);
      }
      m.scale.setScalar(s);
      m.userData.seat = tiles[i].seat;
      m.userData.baseScale = s;
      m.userData.baseY = m.position.y;
      riverGroup.add(m);
    }
  }
  function layoutRiver(view) {
    const bySeat = {};
    const push = (seat, tile) => {
      if (!Number.isInteger(tile)) return;
      const k = keyOf(seat);
      (bySeat[k] || (bySeat[k] = [])).push({ seat, tile });
    };
    if (Array.isArray(view.discardLog) && view.discardLog.length) {
      for (const d of view.discardLog) if (d) push(d.seat, d.tile);
    } else {
      // 兼容本地演示 / 旧合成帧（没有 discardLog）：按座位分组
      for (const t of view.me.discards || []) push(view.me.seat, t);
      for (const o of view.others || []) for (const t of o.discards || []) push(o.seat, t);
    }
    for (const k of LOCAL_ORDER) layoutRiverStrip(k, bySeat[k] || []);
  }

  /** 悬停/点手牌时，把牌河里同牌面的牌抬起来（方形放大高亮，不画圆圈） */
  function highlightRiver(code) {
    for (const m of riverGroup.children) {
      const hit = code !== null && code !== undefined && m.userData.code === code;
      const base = m.userData.baseScale || 1;
      m.scale.setScalar(hit ? base * 1.18 : base);
      m.position.y = (m.userData.baseY ?? m.position.y) + (hit ? 0.006 : 0);
    }
  }
  /* 牌墙：只知道总剩余张数，按环序从前往后填 back 牌（两张一墩） */
  function layoutWall(left) {
    let remain = left;
    for (let i = 0; i < RING.length && remain > 0; i++) {
      const { seat, d } = RING[i];
      for (let layer = 0; layer < 2 && remain > 0; layer++) {
        const m = makeTile(0, false);
        const [x, y, z] = wallSlotPos(seat, d, layer);
        m.position.set(x, y, z);
        m.rotation.x = -Math.PI / 2;
        groups[seat].wall.add(m);
        remain--;
      }
    }
  }

  /* ---- 场景重建 ---- */
  function render(view, driver) {
    if (!view || !view.me) return;
    currentView = view;
    currentDriver = driver || null;
    currentSeat = driver && typeof driver.MY_SEAT === 'number' ? driver.MY_SEAT : view.me.seat;

    // 癞子 / 皮子牌面：所有同值的明牌（手牌/副露/牌河/桌心）都会在左上角带标记
    wildCode = Number.isInteger(view.wildTile) ? view.wildTile : null;
    skinCodes = new Set(Array.isArray(view.skinTiles) ? view.skinTiles : []);

    clearTable();

    // 手牌（红中 → 皮子 → 赖子 → 普通）；刚摸的那张先单独放最右。
    // 副露先规划（同行铺手牌左端需要知道手牌半宽），再摆手牌与副露。
    const mine = handOrder(view.me.hand, wildCode, skinCodes);
    let drawn = null;
    if (view.phase === 'discard' && view.turn === currentSeat && Number.isInteger(view.lastDraw)) {
      const di = mine.indexOf(view.lastDraw);
      if (di >= 0) { drawn = view.lastDraw; mine.splice(di, 1); }
    }
    const planS = planMelds('S', sortMeldsForDisplay(view.me.melds), mine.length, drawn);
    layoutHand('S', mine, true, drawn, planS.handX, null, planS.sc);
    for (const o of view.others) {
      const key = keyOf(o.seat);
      const plan = planMelds(key, sortMeldsForDisplay(o.melds), o.hand ? o.hand.length : o.handCount, null);
      if (o.hand) layoutHand(key, handOrder(o.hand, wildCode, skinCodes), true, null, plan.handX, plan.ew, plan.sc);
      else layoutBacks(key, o.handCount, plan.handX, plan.ew, plan.sc);
      o.__plan = plan;
    }
    // 副露：红中杠 → 皮子杠 → 癞子杠 → 吃碰杠（老吴 2026-10-22）；同行/上方摆法见 layoutMeldsFrom
    layoutMeldsFrom(planS);
    for (const o of view.others) layoutMeldsFrom(o.__plan);
    // 弃牌：各家门前依次排列（老吴 2026-10-27）
    layoutRiver(view);
    // 牌墙：俯视图不显示（老吴 2026-10-24 参考图）—— 剩余张数在顶栏信息里
    // layoutWall(view.wallLeft);

    // 癞子：中央指示器**右上角**外侧亮一张（老吴 2026-10-30 十九轮：
    // 原先的「指示器右侧空档」已被 E 家横排牌河占用，牌挪到指示器右上角、
    // 与 E 牌河第一列上下错开，仍不压任何牌）。
    // ❗2026-10-30 二十轮：老吴「牌河中不要显示赖子了」→ 默认不摆（见 SHOW_WILD_MARKER），
    // 癞子是哪张由左上角徽标说清，桌心再亮一张只会和牌河抢视线。
    if (SHOW_WILD_MARKER && Number.isInteger(view.wildTile)) {
      wildMesh = makeTile(view.wildTile, true);
      wildMesh.position.set(WILD_POS[0], TILE_W / 2 + 0.004, WILD_POS[1]);
      wildMesh.rotation.x = -Math.PI / 2;
      wildMesh.scale.setScalar(1.08);
      markerGroup.add(wildMesh);
    }

    // 起手骰子：两颗，静止展示服务端下发的点数
    // ❗2026-10-30 二十轮：老吴「牌河中不要显示骰子」→ SHOW_DICE=false 时不摆；
    // diceValues 仍然照收（回放/顶栏信息用得到），只是不上桌。
    diceValues = Array.isArray(view.dice) ? view.dice.slice(0, 2) : null;
    diceGroup.visible = !!(SHOW_DICE && diceValues && diceValues.length);
    diceMeshes.forEach((m, i) => {
      const v = diceValues && diceValues[i];
      if (!v) { m.visible = false; return; }
      m.visible = !!SHOW_DICE;
      const [rx, ry, rz] = diceRestRot(v);
      m.rotation.set(rx, ry, rz);
      m.position.set(DICE_REST[i][0], DICE_SIZE / 2 + 0.002, DICE_REST[i][1]);
    });
    updateReplayLabels(view);
  }

  /* ---- 交互：hover 抬升 + 点击出牌 ---- */
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let hovered = null;
  // 两段式出牌的选中牌（老吴 2026-10-24）：第一下点牌＝选中并抬起（可反复换牌），
  // 再点同一张才真正打出/杠 —— 单击即出太容易误触。
  let selectedTileMesh = null;
  function setSelectedTile(m) {
    if (selectedTileMesh === m) return;
    if (selectedTileMesh) tween(selectedTileMesh.position, { y: flatRestY(MY_HAND_SCALE) }, 0.12);
    selectedTileMesh = m || null;
    if (selectedTileMesh) tween(selectedTileMesh.position, { y: flatRestY(MY_HAND_SCALE) + SELECT_LIFT * 2 }, 0.12);
  }
  let highlightedRiverCode = null;

  function ndcFromEvent(e) {
    const el = renderer && renderer.domElement;
    if (!el) return [0, 0];
    // ❗必须先减掉画布在页面里的位置（rect.left/top）。clientX/Y 是**视口坐标**，
    //    而 NDC 要的是**画布内**坐标；早先直接 clientX/clientWidth（漏了 rect），
    //    只要画布不在 (0,0)（#topbar 在它上方、#play 居中 ⇒ left/top 都非 0），
    //    算出的 NDC 就整体偏移 → 射线永远打不中手牌 → 点不出牌（老吴 2026-10-19）。
    const rect = el.getBoundingClientRect();
    const w = rect.width || 1;
    const h = rect.height || 1;
    // 🔴 整页旋转 90°（竖屏手机 html.in-play 自动横屏，2026-10-24）：画布的视觉矩形
    //    与自身坐标系**互换轴向**（视觉宽 = 逻辑高）。clientX/Y 是物理视口坐标，
    //    必须先逆旋转回画布局部坐标：横向分数 = (clientY−top)/视觉高，
    //    纵向分数 = 1 − (clientX−left)/视觉宽。检测用几何特征：
    //    视觉宽≈逻辑高 且 视觉高≈逻辑宽（非正方形画布 90° 旋转的充要表现）。
    if (Math.abs(w - el.clientHeight) < 1 && Math.abs(h - el.clientWidth) < 1 && w !== h) {
      return [((e.clientY - rect.top) / h) * 2 - 1, ((e.clientX - rect.left) / w) * 2 - 1];
    }
    return [((e.clientX - rect.left) / w) * 2 - 1, -((e.clientY - rect.top) / h) * 2 + 1];
  }
  function onMove(e) {
    if (!renderer) return;
    // 🔴 触屏/触控笔不做悬停抬牌（老吴 2026-10-24 手机「点牌无响应」根因之二）：
    //    触摸按下时浏览器会先派发 pointermove ⇒ 牌被抬走（HAND_LIFT=0.035 超过半张牌高），
    //    手指抬起时射线打在牌原来的位置 ⇒ 必落空。悬停预览是鼠标的专利 ——
    //    鼠标用户看得见抬起的牌、会瞄准新位置；触屏没有这个反馈回路。
    if (e.pointerType === 'touch' || e.pointerType === 'pen') return;
    const [nx, ny] = ndcFromEvent(e);
    pointer.set(nx, ny);
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(myHand, false);
    const m = hits.length ? hits[0].object : null;
    if (m !== hovered) {
      // 选中的牌保持抬起：鼠标移开时不把它压回去（两段式出牌的选中态优先于悬停）
      if (hovered && hovered !== selectedTileMesh) tween(hovered.position, { y: flatRestY(MY_HAND_SCALE) }, 0.12);
      hovered = m;
      if (hovered && hovered !== selectedTileMesh) tween(hovered.position, { y: flatRestY(MY_HAND_SCALE) + HAND_LIFT * 2 }, 0.12);
    }
    // 手牌指到哪张，牌河里同牌面的牌就抬起来（老吴 2026-10-20）
    const code = m ? m.userData.code : null;
    if (code !== highlightedRiverCode) {
      highlightedRiverCode = code;
      highlightRiver(code);
    }
  }
  let downX = 0, downY = 0;
  let actionBusy = false;
  function fireAction(action) {
    if (actionBusy || state.actionPending) return;
    actionBusy = true;
    let ret;
    try {
      ret = onAction(action);
    } catch (e) {
      actionBusy = false;
      onMessage((e && e.message) || String(e));
      return;
    }
    if (ret && typeof ret.then === 'function') {
      ret
        .catch((e) => onMessage((e && e.message) || String(e)))
        .finally(() => { actionBusy = false; });
    } else {
      actionBusy = false;
    }
  }
  function onDown(e) {
    downX = e.clientX; downY = e.clientY;
    // 触屏没有 hover：按下时也先把同牌面的河牌高亮出来
    if (hovered && hovered.userData.code !== highlightedRiverCode) {
      highlightedRiverCode = hovered.userData.code;
      highlightRiver(highlightedRiverCode);
    }
  }
  function onUp(e) {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;
    // 🔴 触屏轻点没有 pointermove（手指不动就不触发）⇒ hovered 不会更新，
    //    旧实现点牌无反应（老吴 2026-10-24 手机实测）。改为**以抬起坐标重新射线**，
    //    鼠标/触屏一致，不再依赖 hover 残留。
    if (!renderer) return;
    const [upX, upY] = ndcFromEvent(e);
    pointer.set(upX, upY);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(myHand, false)[0];
    const tapped = hit ? hit.object : null;
    const replaying = !!(currentView && currentView.replay);
    if (!tapped || !tapped.userData.inHand) {
      if (!replaying) setSelectedTile(null);   // 点空处＝取消选中
      return;
    }
    const code = tapped.userData.code;
    // 第一下＝选中（可反复换牌）；回放没有选中态，维持旧的单击走动作分支
    //（回放驱动会提示「不能操作」）。
    if (!replaying && selectedTileMesh !== tapped) {
      setSelectedTile(tapped);
      return;
    }
    // 第二下点同一张：按旧规则执行（能胡先提示 / 特殊杠 / 普通杠 / 打出）
    // 有胡时禁止点牌出牌/杠：3D 是单击即出牌，误点一下就会把自己的牌打进河，
    // 随后再点「胡」自然只会得到「还没轮到你」。必须先点「胡」或「过」。
    const winNow = ((currentView && currentView.me && currentView.me.legal) || [])
      .some((a) => a.type === 'win');
    if (winNow) {
      onMessage('能胡：请点「胡」，或点「过」后再出牌');
      return;
    }
    // 红中 / 皮子 / 癞子：点击 = 对应的特殊杠（不能打进牌河，老吴 2026-10-20）
    const gang = specialGangAction(code);
    if (gang) {
      fireAction(state.gangNoDraw ? { ...gang, noDraw: true } : gang);
      return;
    }
    // 普通杠（蓄杠/暗杠/直杠）**不走点牌**：双击＝默认打出，杠只点操作条上的
    // 「蓄杠/暗杠/杠」按钮（老吴 2026-10-27：蓄杠牌双击误杠出去，应默认打出）。
    if (!isDiscardable(code)) { onMessage(`${tileName(code)} 现在打不出去`); return; }
    fireAction({ type: 'discard', tile: code });
  }
  function specialGangAction(code) {
    if (!currentView || currentView.phase !== 'discard' || currentView.turn !== currentSeat) return null;
    const hand = (currentView.me && currentView.me.hand) || [];
    if (!hand.includes(code)) return null; // 旧帧/错帧的杠动作不能落到别的牌上
    const legal = (currentView.me && currentView.me.legal) || [];
    return legal.find((a) => {
      if (a.tile !== code) return false;
      if (a.type === 'redgang') return code === RED_DRAGON;
      if (a.type === 'wildgang') return code === currentView.wildTile;
      if (a.type === 'skingang') {
        return code !== RED_DRAGON && code !== currentView.wildTile
          && (currentView.skinTiles || []).includes(code);
      }
      return false;
    }) || null;
  }
  function isDiscardable(code) {
    if (!currentView || currentView.phase !== 'discard') return false;
    if (currentView.turn !== currentSeat) return false;
    const legal = (currentView.me && currentView.me.legal) || [];
    return legal.some((a) => a.type === 'discard' && a.tile === code);
  }

  /* ---- 尺寸 / 取景 ---- */
  /* 座位 HUD（老吴 2026-10-24）：每个玩家侧常显「头像 + 昵称 + 当前得分 + 庄」，
     轮到谁行动谁的头像外圈流光（思考中）。回放时名字/得分用注入的整场数据。 */
  function ensureReplayLabels() {
    if (labelLayer || !container || typeof document === 'undefined') return;
    labelLayer = document.createElement('div');
    labelLayer.className = 'r3d-seat-labels';
    labelLayer.hidden = true;
    // 2026-10-24 老吴（参照截图）：只显示 头像/名称/得分/番数 ——
    // 头像加大，庄＝头像左上红色角标，番数＝头像下侧小角标，得分在名字下侧。
    for (const key of LOCAL_ORDER) {
      const node = document.createElement('div');
      node.className = 'r3d-seat-label';
      node.dataset.seatKey = key;   // 外部定位用（net3d-main 补牌开关钉位按 W 卡取矩形）
      node.hidden = true;
      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      const dealer = document.createElement('b');
      dealer.className = 'badge-dealer';
      dealer.textContent = '庄';
      const fan = document.createElement('i');
      fan.className = 'badge-fan';
      const name = document.createElement('span');
      name.className = 'r3d-seat-name';
      const score = document.createElement('span');
      score.className = 'r3d-seat-score';
      const txt = document.createElement('span');
      txt.className = 'r3d-seat-txt';
      txt.append(name, score);
      // 角标锚定头像（老吴 2026-10-27 五轮「番数加在头像图片的角标，不是整个信息栏」）：
      // avatarBox 是 relative 包裹层，庄/番角标以头像图外沿定位；换头像只换 box 内层。
      const avatarBox = document.createElement('span');
      avatarBox.className = 'r3d-avatar-box';
      avatarBox.append(avatar, dealer, fan);
      node.append(avatarBox, txt);
      labelLayer.appendChild(node);
      labelEls[key] = { node, avatarBox, avatar, name, score, fan, dealer, avatarValue: null };
    }
    container.appendChild(labelLayer);
  }

  function updateReplayLabels(view) {
    if (!labelLayer || !container) return;
    const hasView = !!(view && view.me);
    labelLayer.hidden = !hasView;
    if (!hasView) return;
    const w = container.clientWidth || 0;
    const h = container.clientHeight || 0;
    if (!w || !h) return;

    // 当前得分：回放用注入的整场累计；对局用本场 matchStats（一把没打时不显示）
    const replayScores = state.replay && Array.isArray(state.replayScores) ? state.replayScores : null;
    let nets = null;
    if (replayScores) {
      nets = replayScores;
    } else if (state.matchStats && typeof state.matchStats.getMatchStats === 'function') {
      const ms = state.matchStats.getMatchStats();
      if (ms && ms.hands > 0 && Array.isArray(ms.players)) {
        nets = [0, 0, 0, 0];
        for (const p of ms.players) if (nets[p.seat] != null) nets[p.seat] = p.net | 0;
      }
    }
    // 谁在思考 = 当前该谁行动（出牌或响应）；回放驱动恒 -1（不亮）
    const acting = currentDriver && typeof currentDriver.actingSeat === 'function' ? currentDriver.actingSeat() : -1;

    scene.updateMatrixWorld();
    // 相机矩阵自同步（老吴 2026-10-27 六轮）：标签投影用 camera.matrixWorldInverse，
    // 渲染器要等下一帧 rAF 才刷新它 —— 首帧/无 rAF 环境（自动化探针）下会是陈旧矩阵，
    // 投影整体漂移。这里幂等同步一次，钉位永远和当前机位一致。
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    for (let seat = 0; seat < 4; seat++) {
      const ui = labelEls[keyOf(seat)];
      if (!ui) continue;
      const key = keyOf(seat);
      const mine = seat === currentSeat;
      let x = 0;
      let y = 0;
      /* 信息卡摆位（老吴 2026-10-30 十二轮）：左列三件套「上家头像 → 不补牌开关 → 本家头像」
         竖排**贴在一起**夹住开关（旧版把上家钉在屏幕顶 y=64、本家钉在手牌上缘，两块隔了半屏）；
         下家 E 竖卡钉在自身列右缘外侧、**与上家头像同一水平线**（左右对称）。
         对家 N 横卡仍在其手牌行左端外侧、与手牌行垂直居中对齐。 */
      ui.node.hidden = false;
      /* 掉线玩家：头像置灰（老吴 2026-10-30）。数据只从 `table:players` 的 connected 来
         —— 断线/重连服务端都会广播该帧，所以不依赖下一帧 state 也能立刻变灰/复原。 */
      ui.node.classList.toggle('offline', !!onlineBySeat && onlineBySeat[seat] === false);
      ui.node.classList.toggle('row-mode', key === 'N');   // 对家横卡：名称/得分在头像右侧
      const nw = ui.node.offsetWidth || 64;
      const nh = ui.node.offsetHeight || 66;
      // 左列三件套围绕屏幕竖直中线对称：W 卡底边在中线上方 LABEL_GAP，S 卡顶边在下方 LABEL_GAP，
      // 开关（高约 26px）正好落在两卡之间的空槽里（net3d-main.pinFloaters 取两卡中点定位）。
      const LABEL_GAP = 21;
      const toSX = (wx) => { _labelV.set(wx, 0, 0).project(camera); return (_labelV.x * 0.5 + 0.5) * w; };
      const toSY = (wz) => { _labelV.set(0, 0, wz).project(camera); return (-_labelV.y * 0.5 + 0.5) * h; };
      // W 手牌列左缘（W/S 两卡共用；E/W 列 x 足迹 = 列心 ± TILE_H·v/2，含副露同足迹）
      _labelBox.setFromObject(groups.W.hand);
      const colLeftW = _labelBox.isEmpty() ? toSX(-0.9) : toSX(_labelBox.min.x);
      const colRightW = _labelBox.isEmpty() ? null : toSX(_labelBox.max.x);   // 上家列右缘（N 头像避让用）
      if (key === 'W') {
        // 上家：贴自身竖列外侧（列左侧），底边压在中线上方 —— 紧邻「不补牌」开关上侧
        x = colLeftW - nw - 4;
        // 矮屏兜底：不得压到对家 N 横卡（N 卡下缘每帧记录，取上一帧值即可，稳定后一致）
        y = Math.max(Math.round(h / 2 - LABEL_GAP - nh), _nLabelBottom + 2);
      } else if (key === 'S') {
        // 本家：顶边压在中线下方 —— 紧邻开关下侧，与上家头像成竖排（旧版贴手牌上缘，离开关太远）
        x = colLeftW - nw - 4;
        y = Math.round(h / 2 + LABEL_GAP);
      } else if (key === 'E') {
        // 下家：贴自身竖列外侧（列右侧），y 与上家头像卡同一水平线（左右对称）
        _labelBox.setFromObject(groups.E.hand);
        const colRight = _labelBox.isEmpty() ? toSX(0.9) : toSX(_labelBox.max.x);
        x = colRight + 4;
        y = Math.max(Math.round(h / 2 - LABEL_GAP - nh), _nLabelBottom + 2);
      } else {
        // 对家（老吴 2026-10-31）：**固定**在左上角赖子徽标右侧、与徽标同顶对齐，
        // 不再跟随手牌行移动（旧版 x 跟手牌行左缘、y 跟行垂直中心，会随牌变化晃动）。
        // 徽标被隐藏（无癞子局）时也保持同一位置，卡片不跳。
        // 老吴 2026-11-01：横屏下上家(W)头像卡与对家(N)头像同处左上角会叠住，
        // 故 N 头像左缘对齐到 W 手牌列右缘 +8px，明显右移错开；竖屏 W 卡已在屏外则保持贴徽标。
        const wb = document.getElementById('wild-badge');
        const baseX = wb && !wb.hidden ? 12 + (wb.offsetWidth || 0) + 6 : 12;
        x = colRightW != null ? Math.max(baseX, colRightW + 8) : baseX;
        y = 12;
        _nLabelBottom = y + nh;   // 供 W/E 卡避让（固定后此值恒定，W/E 卡位置随之稳定）
      }
      // 兜底：极端视口时不出屏
      x = Math.max(2, Math.min(w - nw - 2, x));
      y = Math.max(2, Math.min(h - nh - 2, y));
      // 名字：回放优先注入的真名；对局用 view 里的名字
      const o = mine ? null : (view.others || []).find((x2) => x2.seat === seat);
      const viewName = mine ? view.me.name : (o && o.name);
      const viewAvatar = mine ? view.me.avatar : (o && o.avatar);
      ui.name.textContent = (state.replay && state.replayNames && state.replayNames[seat])
        || viewName
        || `座位${seat + 1}`;
      // 头像（值变了才重建节点，避免每帧 churn）
      const avVal = viewAvatar ? `${viewAvatar.type}:${viewAvatar.value}` : '';
      if (ui.avatarValue !== avVal) {
        ui.avatarValue = avVal;
        const el = avatarEl(viewName || '', viewAvatar);
        ui.avatarBox.replaceChild(el, ui.avatar);
        ui.avatar = el;
      }
      ui.avatar.classList.toggle('thinking', seat === acting);
      // 当前得分（正绿负红；没有数据留空）
      const score = nets ? (Number(nets[seat]) || 0) : null;
      ui.score.textContent = score == null ? '' : score > 0 ? `+${score}` : String(score);
      ui.score.classList.toggle('pos', score > 0);
      ui.score.classList.toggle('neg', score < 0);
      // 当前番数（老吴 2026-10-25）：该家已形成的明牌口番 + 杠番，随副露实时增长。
      // 面板未暴露的番底旋钮一律引擎默认 → 按 preset 建规则集即可（缓存一份）。
      const melds = mine ? view.me.melds : ((o && o.melds) || []);
      const preset = (currentDriver && currentDriver.ruleset && currentDriver.ruleset.preset) || 'koukou';
      const rsFan = rsCache[preset] || (rsCache[preset] = createRuleSet(preset));
      const fanNow = countFan({ seat, melds }, { ruleset: rsFan, isDealer: seat === view.dealer }).total;
      // 角标文案「1 番」（老吴 2026-10-30 十二轮：原来写作「番1」，中文量词应在数后）
      ui.fan.textContent = fanNow > 0 ? `${fanNow} 番` : '';
      ui.fan.hidden = fanNow <= 0;   // 头像下侧的番数角标（无番不占位）
      ui.dealer.hidden = seat !== view.dealer;  // 庄＝头像左上红色角标
      ui.node.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    }
  }

  function applySize() {
    if (!renderer || !container) return;
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    // 正交取景（2026-10-24 老吴「参照俯视图」）：没有 fov/距离概念，直接设视锥半宽/半高。
    //   半宽：装下「手牌带 + 右侧副露区」的最宽处（约 0.75）；
    //   半高：装下「上下两家手牌带 + 桌心牌河」的桌深（约 0.66）；
    //   contain 兜底互推（halfH 不够就反向加宽 halfW），任何宽高比都不裁内容。
    const aspect = w / h;
    // 2026-10-24 老吴（微信截图）「四家牌尽量靠边、桌面贴满」：方桌在宽视口只占 55-60%
    // 屏宽。改为「桌深定高 + 宽度随视口拉宽」：halfH 固定装下桌深（上下家手牌外缘 0.67），
    // halfW = halfH×aspect（视锥比例必须匹配屏幕），桌呢/木框拉宽到视口宽、E/W 座位贴边。
    // 最宽的一排手牌是本家（MY_HAND_SCALE），按它算横向内容半宽 ——
    // 旧值漏了这一点（用 HAND_SCALE 2.2 估），窄视口下会低估、本家牌被裁。
    const handHalf = ((14 - 1) * STEP_HAND * MY_HAND_SCALE + TILE_W * MY_HAND_SCALE + HAND_DRAW_GAP) / 2;
    const xContent = Math.max(0.72, handHalf + 0.17);   // 横向内容最小半宽（手牌+副露）
    // 0.70→0.80（老吴 2026-10-28 十轮：横屏手机 halfH=0.70 时本家牌外缘 z≈0.71 已伸进
    //   底部木框 z∈[halfH-0.06, halfH] 被遮约 1/3——「手牌被桌面边栏挡住」。抬到 0.80 后
    //   HAND_Z=0.60、牌外缘 0.71，距木框内缘 0.74 还有 0.03，四边手牌完整可见。）
    const halfH = Math.max(0.80, xContent / aspect);
    const halfW = halfH * aspect;
    camera.left = -halfW;
    camera.right = halfW;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.updateProjectionMatrix();
    // 机位固定正上方（正交相机距离不影响大小），lookAt 定画面中心
    camera.up.set(0, 0, -1);
    camera.position.set(0, 2.2, FOCUS_Z);
    camera.lookAt(0, 0, FOCUS_Z);
    // 桌面动态拉宽/收紧（2026-10-24 二修）：桌呢正好铺到视口边（宽×深），
    // 上下框条贴屏边、左右框条贴侧边 —— 不再多铺两道木纹空带（老吴：最多留一行文字栏）。
    const feltW = halfW * 2;
    const feltD = halfH * 2;
    felt.scale.x = feltW / FELT_SIZE;
    felt.scale.y = feltD / FELT_SIZE;
    for (const fm of frameMeshes) {
      if (fm.userData.axis === 'x') {
        fm.position.x = fm.userData.sign * (halfW - FRAME_W / 2);
        fm.scale.y = 1;
      } else if (fm.userData.axis === 'z') {
        fm.position.z = fm.userData.sign * (halfH - FRAME_W / 2);
        fm.scale.x = (feltW + FRAME_W * 2) / (FELT_SIZE + FRAME_W * 2);
      }
    }
    /* 上下家（N/S）手牌外移（老吴 2026-10-30 十二轮：「本家手牌再往下、对家再往顶上，
       盖住两行边缘的第一行」）。
       旧算法 S/N 共用同一个中心 z（牌尺寸却不同：本家 3.5、对家 2.2），因此**外缘不齐**：
       本家外缘比木框内缘差 0.03、对家差 0.05，两条边看起来各空一块。现在改成
       **外缘齐平**——先定一条「手牌外缘目标线」EDGE_Z，再按各家牌高反推中心 z。
       木框内缘 = halfH - FRAME_W(0.06)，木框在屏幕上被内侧阴影分成两行；EDGE_Z 取
       halfH - 0.020 ⇒ 牌外缘压进木框内侧 0.04（约木框宽的 2/3），**盖住里面那行阴影带**，
       外面那行木纹仍露出来（实测裁切确认：底/顶两处手牌下/上缘都越过暗带中线）。
       牌顶面 y=0.09 > 木框 0.05，所以是牌压住框、不会被框挡住。
       N/S 手牌组（及副露组）整体沿座位局部位移 OFF，牌河/牌墙不动；N 经 yaw=π 翻转后 OFF 即世界 -OFF。 */
    const EDGE_Z = halfH - 0.020;
    /* 对家/上家/下家统一尺度（老吴 2026-10-30 十四轮「三家调到一样大，尽量大」）。
       三道上限取小，全部由几何决定、不写死：
         · N 的 z 向：内缘不得越过牌河最靠手牌那一行的外沿（留 0.012 缝）；
         · N 的 x 向：14 张整排不得超出视口内侧（左右各留 0.06，再让 0.01 给副露起点）；
         · E/W 的 z 向（真正的瓶颈）：13 张竖列 =(12·STEP_HAND+TILE_H)·v 必须塞进
           「本家手牌内缘 ↔ 对家手牌内缘」这段桌深 2(HAND_Z-ewPole)。
       E/W 拿到的值最小，于是它成为三家的公共尺度；取整到 0.01 档，与 planMelds 完全同口径
       （否则 1.905 与 1.90 之间会来回抖，三家差一丝、肉眼看不出来但量测对不上）。 */
    const RIVER_NEAR_EDGE = RIVER_OUT + (TILE_H * RIVER_SCALE + 0.008) / 2;   // 牌河近手牌一行外沿 |z|
    const nCapZ = (EDGE_Z - RIVER_NEAR_EDGE - 0.012) / TILE_H;
    const nCapW = (2 * (halfW - 0.06) - 0.01) / (14 * STEP_HAND + TILE_W);
    const zS = EDGE_Z - (TILE_H * MY_HAND_SCALE) / 2;   // 本家手牌中心 z
    const handZ0 = Math.max(0.60, zS);
    /* E/W 竖列的可用带宽（老吴 2026-10-30 十七轮）：从「本家手牌**内缘**」量到对侧，
       再减一道 EW_S_GAP 的缝。旧式用 ewPole = 本家牌半高 + 0.005 当界，等于把
       本家手牌整块又算了一遍，白扔半个带宽；而且算出来的是**中心**极限，
       ewColumnFit 却当**外沿**极限用，两处还差半个牌高。现在统一按外沿：
         band = 2·(handZ0 − TILE_H·MY/2 − EW_S_GAP)
         v    = band / (((n−1)·EW_EXPOSURE + 1) · TILE_W)     // 列沿 z = 短边 TILE_W·v
       13 张、露出率 0.76 ⇒ v ≈ 2.34（旧 1.90，牌面 +23%）。 */
    const ewBand = 2 * (handZ0 - (TILE_H * MY_HAND_SCALE) / 2 - EW_S_GAP);
    const ewCap = ewBand / ((12 * EW_EXPOSURE + 1) * TILE_W);
    COMMON_HAND_SCALE = Math.floor(
      Math.max(1.4, Math.min(MY_HAND_SCALE, nCapZ, nCapW, ewCap)) * 100,
    ) / 100;
    /* S/N 固定尺度：3.5，只有 14 张整排放不下（nCapW）或压到牌河（nCapZ）才让步 ——
       都是视口几何，与牌局无关（老吴 2026-10-31「固定大小，不要变化」）。 */
    SN_HAND_SCALE = Math.floor(Math.min(MY_HAND_SCALE, nCapZ, nCapW) * 100) / 100;
    const zN = EDGE_Z - (TILE_H * COMMON_HAND_SCALE) / 2;   // 对家手牌中心 z（N 已与 E/W 同尺度 ≈1.9，贴边更近）
    groups.S.hand.position.z = zS - SEAT_PZ;
    groups.S.meld.position.z = zS - SEAT_PZ;
    groups.N.hand.position.z = zN - SEAT_PZ;
    groups.N.meld.position.z = zN - SEAT_PZ;
    // E/W 座位：下限 0.46（不进牌河）。
    //   老吴 2026-10-30 十七轮「左侧上家的头像也顶住左侧边缘，和右侧一样」：
    //   E/W 现在**完全对称**，都推到「头像卡外缘贴住屏幕/桌沿」为止。
    //   左侧那三件套（上家头像卡 / 不补牌开关 / 本家头像卡）依旧竖排在列外侧，
    //   卡片本身走 updateReplayLabels 里的出屏兜底（钳到 x≥2），列与卡的关系保持不变。
    //   cardClear = 头像卡宽 + 边距，按屏幕 px 折成世界单位（56px 头像实测卡宽 64、边距 4）。
    const cardClear = (halfW * 180) / w + 0.02;
    const seatXEW = Math.max(0.46, halfW - cardClear);
    seatGroups.E.position.x = seatXEW;
    seatGroups.W.position.x = -seatXEW;
    /* E/W 竖列带的可用 |z| 上限（外沿口径）：EW_Z_MAX 直接就是列的**外缘**，
       ewColumnFit 按 span = 2·EW_Z_MAX 去铺。旧版这里减掉了半个牌高、又用中心极限当外沿，
       双重保守，白扔 0.06（≈30px）。S 牌最大（3.5）、内缘最靠里 ⇒ 拿它当界。
       ewZMax() 依赖上面的 seatXEW 与 curHalfH（横屏用满屏高、竖屏受 S/N 手牌内缘限制）。 */
    HAND_Z = handZ0;
    EW_Z_MAX = ewZMax();
    EW_Z_MIN = -EW_Z_MAX;
    curHalfW = halfW;
    curHalfH = halfH;
    updateHandTopVar(h, null);
    updateReplayLabels(currentView);
    // E/W 门前牌河的世界坐标依赖 seatX：视口变化后按当前帧重建一次（无对局时跳过）
    if (currentView && mounted) render(currentView, currentDriver);
  }

  /* 把「自家手牌最高点距画布底部的距离」写进容器 CSS 变量 --hand-top，
     供 net3d.css 把操作条（吃/碰/杠/胡/过）**浮在手牌正上方**且不压住手牌（老吴 2026-10-19）。 */
  const _p = new THREE.Vector3();
  const _spanV = new THREE.Vector3();
  /** 某座位手牌列在画布上的横向屏幕范围（px）—— 供 DOM 层 HUD 避让（回放工具箱等）。
   *  2026-10-30 十五轮：下家被推到桌沿后，回放工具箱钉「E 卡左缘」会盖住 E 的手牌列，
   *  需要在 DOM 层拿到列的真实屏幕左缘才能让开。空组/未挂载返回 null。 */
  function seatHandSpan(key) {
    const wpx = container ? container.clientWidth : 0;
    const g = groups[key] && groups[key].hand;
    if (!wpx || !g || !g.children.length) return null;
    scene.updateMatrixWorld();
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    let lo = Infinity, hi = -Infinity;
    for (const m of g.children) {
      const e = m.matrixWorld.elements;
      const hw = (TILE_W * m.scale.x) / 2;
      for (const wx of [e[12] - hw, e[12] + hw]) {
        _spanV.set(wx, 0, e[14]).project(camera);
        const sx = (_spanV.x * 0.5 + 0.5) * wpx;
        if (sx < lo) lo = sx;
        if (sx > hi) hi = sx;
      }
    }
    return Number.isFinite(lo) ? { left: lo, right: hi } : null;
  }
  function updateHandTopVar(h, focus) {
    if (!container) return;
    let minTop = Infinity;
    if (myHand.length) {
      scene.updateMatrixWorld();
      for (const m of myHand) {
        _p.setFromMatrixPosition(m.matrixWorld);
        _p.y += (TILE_H * m.scale.y) / 2 + 0.004; // 近似牌顶
        _p.project(camera);
        const sy = (1 - _p.y) * 0.5 * h;
        if (Number.isFinite(sy) && sy < minTop) minTop = sy;
      }
    }
    const bottom = Number.isFinite(minTop) ? Math.max(10, Math.round(h - minTop + 8)) : Math.round(h * 0.2);
    container.style.setProperty('--hand-top', bottom + 'px');
  }

  /* ---- 主循环 ---- */
  let loopHandle = null;
  const clock = new THREE.Clock();
  function loop() {
    const dt = Math.min(clock.getDelta(), 0.05);
    updateTweens(dt);
    if (controls) controls.update();
    if (renderer) renderer.render(scene, camera);
  }

  let mounted = false;
  const onResize = () => applySize();

  function mount(el) {
    if (mounted) return;
    container = el;
    mounted = true;
    if (renderer) el.appendChild(renderer.domElement);
    ensureReplayLabels();
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    globalThis.addEventListener('resize', onResize);
    applySize();
    if (renderer) loopHandle = renderer.setAnimationLoop(loop);
  }
  function unmount() {
    if (!mounted) return;
    if (renderer) {
      renderer.setAnimationLoop(null);
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
    container.removeEventListener('pointermove', onMove);
    container.removeEventListener('pointerdown', onDown);
    container.removeEventListener('pointerup', onUp);
    globalThis.removeEventListener('resize', onResize);
    container = null;
    mounted = false;
    loopHandle = null;
  }

  /** 切换 3D 皮肤：清掉旧贴图/材质缓存，并重画当前帧（没有牌局时只清缓存） */
  function reloadTextures() {
    for (const m of faceMatCache.values()) m.dispose();
    faceMatCache.clear();
    clearTextureCache();
    SIDE_MAT.map = sideTexture();
    SIDE_MAT.needsUpdate = true;
    BACK_MAT.map = backTexture();
    BACK_MAT.needsUpdate = true;
    if (currentView) render(currentView, currentDriver);
  }

  /** 自动化/调试：给定视口坐标，返回射线命中的手牌牌面码（无命中 null）。
   *  与点击路径共用同一套 NDC 换算（含旋转态），验证工具用它定位手牌带。 */
  function pickAt(clientX, clientY) {
    if (!renderer) return null;
    const [nx, ny] = ndcFromEvent({ clientX, clientY });
    pointer.set(nx, ny);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(myHand, false)[0];
    return hit && hit.object.userData ? hit.object.userData.code : null;
  }

  /**
   * 设置「谁在线」（seat → bool）。掉线玩家头像置灰（老吴 2026-10-30）。
   * @param {Record<number, boolean>|null} map  null / undefined = 全部在线（回放、首次连接前）
   */
  function setOnline(map) {
    onlineBySeat = map || null;
    // 只改一个 class，但必须立刻生效：断线那一刻不会有新的 state 帧过来
    if (labelLayer && currentView) updateReplayLabels(currentView);
  }

  return {
    mount, unmount, render, applySize, reloadTextures, pickAt, seatHandSpan, setOnline,
    set onAction(fn) { onAction = fn || (() => {}); },
    set onMessage(fn) { onMessage = fn || (() => {}); },
    get scene() { return scene; },
    get camera() { return camera; },
    get renderer() { return renderer; },
    get controls() { return controls; },
    get currentView() { return currentView; },
    get myHand() { return myHand; },
    get groups() { return groups; },
    get river() { return riverGroup; },
    get riverCodes() { return riverGroup.children.map((m) => m.userData.code); },
    get markers() { return markerGroup; },
    getHovered: () => hovered,
    legalActions() { return (currentView && currentView.me && currentView.me.legal) || []; },
    isDiscardable,
    /** 调试/测试：整桌网格计数 */
    counts() {
      const per = {};
      let hand = 0, meld = 0, discard = 0, wall = 0;
      for (const k of LOCAL_ORDER) {
        per[k] = {
          hand: groups[k].hand.children.length,
          meld: groups[k].meld.children.length,
          discard: 0,
          wall: groups[k].wall.children.length,
        };
        hand += per[k].hand; meld += per[k].meld; wall += per[k].wall;
      }
      // 牌河已统一到桌心：按每张牌 userData.seat 回算各家张数
      for (const m of riverGroup.children) {
        const k = keyOf(m.userData.seat);
        if (per[k]) per[k].discard++;
        discard++;
      }
      return { per, hand, meld, discard, wall, wild: !!wildMesh, markers: markerGroup.children.length, dice: diceMeshes.filter((m) => m.visible).length };
    },
    get diceValues() { return diceValues ? [...diceValues] : null; },
    /** 让某点数朝上的静止姿态（测试用） */
    diceRestRot,
  };
}

export { LOCAL_ORDER, wallSlotPos, discardPerRow, TILE_W, TILE_H, TILE_D };
