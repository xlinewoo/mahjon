/**
 * 摸风定座（纯逻辑，引擎层）—— 四家各抽一张牌（互不相同），按大小排座：
 * 最大者坐东、依次南 / 西 / 北（旧顺时针对应）；本仓库改成**逆时针**出牌序：
 * 东 → 北 → 西 → 南。
 *
 * 这份是实现权威源：
 *   · 联网版 server（server/ws/room.js）首盘用 drawWinds() 决定 dealer（庄家 = 最大点者，坐东）。
 *   · 前端（frontend/game-loop.js）re-export 本模块，net-lobby / net-driver 按 dealer 推风位展示。
 *
 * 方位约定（与屏幕布局正交）：
 *   · DIR_ORDER 是「风位出牌顺序」，不是屏幕位置。玩家永远在屏幕下方（由 posOf 决定）。
 *   · 罗盘固定：上北 / 下南 / 左西 / 右东（见 frontend/game-loop.js 的 POS_COMPASS）。
 *   · 引擎按座位号递增出牌（0→1→2→3→0），座位号递增在屏幕上呈「下→右→上→左」即逆时针；
 *     让风位序 DIR_ORDER 绑定到座位号递增，风位出牌即天然在屏幕上呈逆时针。
 */

import { createRng } from './rng.js';
import { EAST, SOUTH, WEST, NORTH, RED_DRAGON, GREEN_DRAGON, WHITE_DRAGON } from './tiles.js';

/**
 * 四方位顺序 = 出牌顺序（逆时针）：东 → 北 → 西 → 南 → 东。
 * 罗盘上：东(右) → 北(上) → 西(左) → 南(下) 正是逆时针。
 */
export const DIR_ORDER = ['东', '北', '西', '南'];

/** 字牌自大到小 = 东 > 南 > 西 > 北 > 中 > 发 > 白 */
const HONOR_DRAW_ORDER = [EAST, SOUTH, WEST, NORTH, RED_DRAGON, GREEN_DRAGON, WHITE_DRAGON];

/**
 * 摸风比牌字典序权重 [tier, rank, suit]，大者胜。
 *   · 数字牌 tier=1，字牌 tier=0 → 数字牌恒大于字牌。
 *   · 数字牌 rank 取点数（9 最大），同点 suit 次序 万(0) < 筒(1) < 条(2)。
 *   · 字牌 rank 按 东 > 南 > 西 > 北 > 中 > 发 > 白。
 */
export function drawWindKey(tile) {
  if (tile < 27) return [1, tile % 9, Math.floor(tile / 9)];
  return [0, 6 - HONOR_DRAW_ORDER.indexOf(tile), 0];
}

function cmpKeyDesc(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return b[i] - a[i];
  return 0;
}

/**
 * 种子加盐 + 雪崩混合。
 * ⚠️ 不能直接 `createRng(seed).int(4)` —— mulberry32 对小种子的**首个**输出相关性很强，
 *   seed=1/2/3 会算出同一个庄家。加盐 + 三轮位混合后连续种子才互相独立。
 */
export function mixSeed(seed, salt) {
  let h = (seed ^ salt) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * 由庄家推方位：庄家坐东，然后按下家顺序依次 北 / 西 / 南（逆时针）。
 * @param {number} dealer 庄家座位
 * @returns {{dealer:number, seatToDir:Record<number,string>, entries:null}}
 */
export function windsFromDealer(dealer) {
  const seatToDir = {};
  for (let k = 0; k < 4; k++) seatToDir[(dealer + k) % 4] = DIR_ORDER[k];
  return { dealer, seatToDir, entries: null };
}

/**
 * 摸风定座：四家各抽一张（牌面互不相同，同牌面视为平局 → 重抽），
 * 牌最大者坐东**并做庄**，其余按大小依次 北 / 西 / 南（逆时针）。
 *
 * 用 seed 派生独立随机流，保证同一 seed 回放完全一致。
 * @param {number} seed
 * @returns {{dealer:number, seatToDir:Record<number,string>, entries:Array<{seat:number,tile:number,dir:string}>}}
 */
export function drawWinds(seed) {
  const rng = createRng(mixSeed(seed, 0x9e3779b9));
  // 从 34 种牌面里洗牌抽 4 张 → 天然不重复，避免"两张一模一样的牌怎么比"的死结
  const pool = rng.shuffle([...Array(34).keys()]).slice(0, 4);
  const entries = [0, 1, 2, 3].map((seat) => ({ seat, tile: pool[seat] }));
  const ranked = [...entries].sort((a, b) => cmpKeyDesc(drawWindKey(a.tile), drawWindKey(b.tile)));
  const seatToDir = {};
  ranked.forEach((e, i) => {
    e.dir = DIR_ORDER[i];
    seatToDir[e.seat] = DIR_ORDER[i];
  });
  return { dealer: ranked[0].seat, seatToDir, entries: ranked };
}

/** 座位 → 方位（没传 seatToDir 时按座位号兜底，保证 UI 永远拿得到标签） */
export function dirOf(seat, seatToDir) {
  return (seatToDir && seatToDir[seat]) || DIR_ORDER[seat % 4];
}
