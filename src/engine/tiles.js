/**
 * 牌的定义与工具 —— 武汉麻将（136 张）
 *
 * 编码方案（整数 0..33，共 34 种牌）：
 *    0..8   一万 ~ 九万    suit 'wan'
 *    9..17  一筒 ~ 九筒    suit 'tong'
 *   18..26  一条 ~ 九条    suit 'tiao'
 *   27..30  东风 南风 西风 北风   suit 'feng'
 *   31..33  红中 发财 白板        suit 'jian'
 *
 * 每种 4 张，共 136 张（没有梅兰竹菊等花牌）。
 *
 * ⚠️ 关键：**红中不是万能牌**。
 *   武汉红中赖子杠里，红中是「固定杠牌」（红中杠），持有红中时不能胡牌。
 *   真正的万能牌（癞子）是开局翻底牌动态决定的 —— 见 nextTile() 与 ruleset.wildMode。
 */

/** 数字牌（万筒条）种数 */
export const NUM_TILE_KINDS = 27;

/** 牌种总数 */
export const TILE_KINDS = 34;

/** 每种牌的张数 */
export const COPIES_PER_TILE = 4;

/** 整副牌张数 */
export const WALL_SIZE = TILE_KINDS * COPIES_PER_TILE; // 136

/** 胡牌手牌张数 */
export const WIN_HAND_SIZE = 14;

/* ---------------- 字牌编码 ---------------- */
export const EAST = 27;
export const SOUTH = 28;
export const WEST = 29;
export const NORTH = 30;
export const RED_DRAGON = 31; // 红中
export const GREEN_DRAGON = 32; // 发财
export const WHITE_DRAGON = 33; // 白板

/** 风牌：东南西北 */
export const WINDS = [EAST, SOUTH, WEST, NORTH];

/** 箭牌：中发白 */
export const DRAGONS = [RED_DRAGON, GREEN_DRAGON, WHITE_DRAGON];

/** 字牌（风 + 箭） */
export const HONORS = [...WINDS, ...DRAGONS];

/**
 * 翻牌定癞子的循环序列。
 * 资料口径：按「东 南 西 北 红中 发财 白板」的顺序，但**翻到北要跳过红中**，
 * 所以实际循环是 东→南→西→北→发财→白板→东。
 */
export const WILD_CYCLE = [EAST, SOUTH, WEST, NORTH, GREEN_DRAGON, WHITE_DRAGON];

/* ---------------- 基础判断 ---------------- */

/** 是否数字牌（万筒条） */
export function isNumberTile(tile) {
  return tile >= 0 && tile < NUM_TILE_KINDS;
}

/** 是否风牌（东南西北） */
export function isWindTile(tile) {
  return tile >= EAST && tile <= NORTH;
}

/** 是否箭牌（中发白） */
export function isDragonTile(tile) {
  return tile >= RED_DRAGON && tile <= WHITE_DRAGON;
}

/** 是否字牌（风 + 箭），字牌不能组顺子 */
export function isHonorTile(tile) {
  return tile >= NUM_TILE_KINDS && tile < TILE_KINDS;
}

/* ---------------- 基本属性 ---------------- */

/** 花色标识：'wan' | 'tong' | 'tiao' | 'feng' | 'jian' */
export function tileSuit(tile) {
  if (tile < 9) return 'wan';
  if (tile < 18) return 'tong';
  if (tile < NUM_TILE_KINDS) return 'tiao';
  if (tile <= NORTH) return 'feng';
  return 'jian';
}

/** 序号：万筒条 1..9，风 1..4，箭 1..3 */
export function tileRank(tile) {
  if (tile < NUM_TILE_KINDS) return (tile % 9) + 1;
  if (tile <= NORTH) return tile - EAST + 1;
  return tile - RED_DRAGON + 1;
}

const SUIT_BASE = { wan: 0, tong: 9, tiao: 18, feng: EAST, jian: RED_DRAGON };
const SUIT_MAX = { wan: 9, tong: 9, tiao: 9, feng: 4, jian: 3 };

/**
 * 由花色与序号构造牌编码
 * @param {'wan'|'tong'|'tiao'|'feng'|'jian'} suit
 * @param {number} rank
 */
export function makeTile(suit, rank) {
  const base = SUIT_BASE[suit];
  if (base === undefined) throw new Error(`未知花色: ${suit}`);
  if (rank < 1 || rank > SUIT_MAX[suit]) throw new Error(`${suit} 的序号越界: ${rank}`);
  return base + rank - 1;
}

/** 风牌快捷构造（按中文名） */
export function windTile(name) {
  const idx = { 东: 0, 南: 1, 西: 2, 北: 3 }[name];
  if (idx === undefined) throw new Error(`未知风牌: ${name}`);
  return EAST + idx;
}

/** 箭牌快捷构造（按中文名） */
export function dragonTile(name) {
  const idx = { 中: 0, 发: 1, 白: 2 }[name];
  if (idx === undefined) throw new Error(`未知箭牌: ${name}`);
  return RED_DRAGON + idx;
}

const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const SUIT_CN = { wan: '万', tong: '筒', tiao: '条' };
const HONOR_CN = ['东风', '南风', '西风', '北风', '红中', '发财', '白板'];

/** 牌的可读名 */
export function tileName(tile) {
  if (tile >= NUM_TILE_KINDS) return HONOR_CN[tile - NUM_TILE_KINDS];
  return CN_NUM[tileRank(tile) - 1] + SUIT_CN[tileSuit(tile)];
}

/**
 * 取「下一张」牌 —— 翻牌定癞子用。
 * 数字牌在 1-9 内循环（九万 → 一万）；
 * 字牌走 WILD_CYCLE（北 → 发财，跳过红中；白板 → 东风）。
 */
export function nextTile(tile) {
  if (isNumberTile(tile)) {
    const suit = tileSuit(tile);
    const rank = tileRank(tile);
    return makeTile(suit, rank === 9 ? 1 : rank + 1);
  }
  const idx = WILD_CYCLE.indexOf(tile);
  if (idx === -1) return WILD_CYCLE[0]; // 红中不在循环里（固定杠牌）
  return WILD_CYCLE[(idx + 1) % WILD_CYCLE.length];
}

/**
 * 取「上一张」牌 —— 定皮子用（皮子 = 癞子往回数 1、2 张 + 红中）。
 * 与 nextTile 完全对称：
 *   · 数字牌在 1-9 内循环（一万 → 九万，**不跨花色**）；
 *   · 字牌沿 WILD_CYCLE 反向（东风 → 白板），**同样跳过红中**。
 *
 * 跳过红中是必须的：老吴口径下皮子恒为 3 种、共 11 张。
 * 若字牌往回数不跳红中，翻北风时癞子=发财、减一=红中、减二=北风 →
 * 皮子只剩 {红中,北风} 两种 7 张，与「11 个皮」对不上。
 */
export function prevTile(tile) {
  if (isNumberTile(tile)) {
    const suit = tileSuit(tile);
    const rank = tileRank(tile);
    return makeTile(suit, rank === 1 ? 9 : rank - 1);
  }
  const idx = WILD_CYCLE.indexOf(tile);
  if (idx === -1) return WILD_CYCLE[WILD_CYCLE.length - 1]; // 红中不在循环里
  return WILD_CYCLE[(idx - 1 + WILD_CYCLE.length) % WILD_CYCLE.length];
}

/* ---------------- 集合工具 ---------------- */

/** 牌数组 → counts 数组（长度 34） */
export function toCounts(tiles) {
  const counts = new Array(TILE_KINDS).fill(0);
  for (const t of tiles) {
    if (!Number.isInteger(t) || t < 0 || t >= TILE_KINDS) {
      throw new Error(`非法牌编码: ${t}`);
    }
    counts[t]++;
  }
  return counts;
}

/** counts → 牌数组（升序） */
export function fromCounts(counts) {
  const tiles = [];
  for (let t = 0; t < TILE_KINDS; t++) {
    for (let i = 0; i < counts[t]; i++) tiles.push(t);
  }
  return tiles;
}

/** 升序排序，返回新数组 */
export function sortTiles(tiles) {
  return [...tiles].sort((a, b) => a - b);
}

/** 生成一整副牌墙：34 种 × 4 张 = 136 张 */
export function makeWall() {
  const wall = [];
  for (let t = 0; t < TILE_KINDS; t++) {
    for (let i = 0; i < COPIES_PER_TILE; i++) wall.push(t);
  }
  return wall;
}

/** 牌数组 → 展示文本 */
export function formatTiles(tiles) {
  return sortTiles(tiles).map(tileName).join(' ');
}

/** counts → 紧凑展示文本 */
export function formatCounts(counts) {
  const parts = [];
  for (let t = 0; t < TILE_KINDS; t++) {
    if (counts[t] > 0) parts.push(counts[t] > 1 ? `${tileName(t)}×${counts[t]}` : tileName(t));
  }
  return parts.join(' ');
}
