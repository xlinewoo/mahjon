/**
 * 胡牌算法测试 —— 武汉红中赖子杠（136 张）
 *
 * 这一层的测试完全不涉及番数，只测「结构」：
 *   · 牌定义（34 种 / 136 张 / 每种 4 张）
 *   · 翻牌定癞子的「下一张」规则
 *   · 字牌只能组刻子、不能组顺子
 *   · 动态癞子补顺子 / 补刻子 / 当将
 *   · 面子折算（带副露时手牌张数）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeTile,
  makeWall,
  toCounts,
  formatTiles,
  tileName,
  tileSuit,
  tileRank,
  windTile,
  dragonTile,
  nextTile,
  isNumberTile,
  isHonorTile,
  isWindTile,
  isDragonTile,
  TILE_KINDS,
  WALL_SIZE,
  COPIES_PER_TILE,
  WIN_HAND_SIZE,
  EAST,
  SOUTH,
  WEST,
  NORTH,
  RED_DRAGON,
  GREEN_DRAGON,
  WHITE_DRAGON,
  WINDS,
  DRAGONS,
  HONORS,
  WILD_CYCLE,
} from '../src/engine/tiles.js';
import {
  analyzeHand,
  canWin,
  isAllTriplets,
  sequenceCount,
  wildCostOf,
} from '../src/engine/win.js';

const w = (n) => makeTile('wan', n);
const t = (n) => makeTile('tong', n);
const s = (n) => makeTile('tiao', n);
const Z = RED_DRAGON;

/* ------------------------------------------------------------------ */
/* 牌定义                                                              */
/* ------------------------------------------------------------------ */

test('牌种共 34 种，整副 136 张，每种 4 张', () => {
  assert.equal(TILE_KINDS, 34);
  assert.equal(WALL_SIZE, 136);
  assert.equal(COPIES_PER_TILE, 4);
  assert.equal(WIN_HAND_SIZE, 14);

  const wall = makeWall();
  assert.equal(wall.length, 136);
  for (let v = 0; v < TILE_KINDS; v++) {
    assert.equal(wall.filter((x) => x === v).length, 4, `${tileName(v)} 张数不对`);
  }
  assert.equal(wall.filter((x) => x < 27).length, 108, '序数牌应有 108 张');
  assert.equal(wall.filter((x) => isHonorTile(x)).length, 28, '字牌应有 28 张');
});

test('花色与序号：万筒条 + 东南西北 + 中发白', () => {
  assert.equal(tileName(w(5)), '五万');
  assert.equal(tileName(t(9)), '九筒');
  assert.equal(tileName(s(1)), '一条');
  assert.equal(tileName(EAST), '东风');
  assert.equal(tileName(SOUTH), '南风');
  assert.equal(tileName(WEST), '西风');
  assert.equal(tileName(NORTH), '北风');
  assert.equal(tileName(Z), '红中');
  assert.equal(tileName(GREEN_DRAGON), '发财');
  assert.equal(tileName(WHITE_DRAGON), '白板');

  assert.equal(tileSuit(w(1)), 'wan');
  assert.equal(tileSuit(t(5)), 'tong');
  assert.equal(tileSuit(s(9)), 'tiao');
  assert.equal(tileSuit(EAST), 'feng');
  assert.equal(tileSuit(Z), 'jian');

  assert.equal(tileRank(w(9)), 9);
  assert.equal(tileRank(NORTH), 4);
  assert.equal(tileRank(WHITE_DRAGON), 3);

  assert.equal(isNumberTile(EAST), false);
  assert.equal(isHonorTile(Z), true);
  assert.equal(isWindTile(NORTH), true);
  assert.equal(isDragonTile(Z), true);
  assert.equal(isDragonTile(EAST), false);

  assert.equal(windTile('西'), WEST);
  assert.equal(dragonTile('发'), GREEN_DRAGON);
  assert.deepEqual(WINDS, [EAST, SOUTH, WEST, NORTH]);
  assert.deepEqual(DRAGONS, [Z, GREEN_DRAGON, WHITE_DRAGON]);
  assert.equal(HONORS.length, 7);
});

test('翻牌定癞子：数字牌的「下一张」在 1-9 内循环，不跨花色', () => {
  assert.equal(nextTile(w(1)), w(2));
  assert.equal(nextTile(w(8)), w(9));
  assert.equal(nextTile(w(9)), w(1), '九万的下一张回到一万');
  assert.equal(nextTile(t(5)), t(6));
  assert.equal(nextTile(s(9)), s(1));
  assert.notEqual(nextTile(w(9)), t(1));
});

test('翻牌定癞子：字牌的「下一张」跳过红中', () => {
  assert.deepEqual(WILD_CYCLE, [EAST, SOUTH, WEST, NORTH, GREEN_DRAGON, WHITE_DRAGON]);
  assert.equal(nextTile(EAST), SOUTH);
  assert.equal(nextTile(SOUTH), WEST);
  assert.equal(nextTile(WEST), NORTH);
  assert.equal(nextTile(NORTH), GREEN_DRAGON, '北的下一张是发财（跳过红中）');
  assert.equal(nextTile(GREEN_DRAGON), WHITE_DRAGON);
  assert.equal(nextTile(WHITE_DRAGON), EAST, '白板的下一张转回东风');
  assert.equal(nextTile(Z), EAST, '红中不在癞子循环里，兜底给东风');
});

/* ------------------------------------------------------------------ */
/* 字牌结构                                                            */
/* ------------------------------------------------------------------ */

test('字牌可以作刻子', () => {
  const hand = [EAST, EAST, EAST, SOUTH, SOUTH, SOUTH, WEST, WEST, WEST, NORTH, NORTH, NORTH, Z, Z];
  assert.equal(hand.length, 14);
  const res = analyzeHand(toCounts(hand));
  assert.ok(res.winning, `${formatTiles(hand)} 应能胡（四刻子 + 红中将）`);
});

test('字牌不能组顺子：东南西 不是面子', () => {
  // 若把「东南西」当顺子，这手牌就能胡；按规则它不能。
  const hand = [
    EAST, SOUTH, WEST,
    EAST, SOUTH, WEST,
    w(1), w(2), w(3),
    w(4), w(5), w(6),
    Z, Z,
  ];
  assert.equal(hand.length, 14);
  assert.equal(canWin(toCounts(hand)), false, '字牌不能当顺子用');
});

test('七对：默认不启用（武汉麻将没有七对）', () => {
  const hand = [
    EAST, EAST, SOUTH, SOUTH, WEST, WEST, NORTH, NORTH,
    Z, Z, GREEN_DRAGON, GREEN_DRAGON, WHITE_DRAGON, WHITE_DRAGON,
  ];
  assert.equal(hand.length, 14);
  assert.equal(canWin(toCounts(hand)), false, '默认不该认七对');
  assert.equal(canWin(toCounts(hand), { allowSevenPairs: true }), true, '开启后才认');
});

/* ------------------------------------------------------------------ */
/* 动态癞子                                                            */
/* ------------------------------------------------------------------ */

test('癞子补顺子：癞子填顺子的缺张', () => {
  const hand = [w(1), w(2), Z, w(4), w(5), w(6), t(7), t(8), t(9), s(5), s(5), s(5), s(9), s(9)];
  assert.equal(hand.length, 14);
  const res = analyzeHand(toCounts(hand), { wildTile: Z });
  assert.ok(res.winning, '1万2万+癞子 应能补成 123万');
});

test('癞子补顺子的中间张：1万 + 癞子 + 3万', () => {
  const hand = [w(1), Z, w(3), w(4), w(5), w(6), t(7), t(8), t(9), s(5), s(5), s(5), s(9), s(9)];
  assert.equal(hand.length, 14);
  const res = analyzeHand(toCounts(hand), { wildTile: Z });
  assert.ok(res.winning);
});

test('癞子补刻子：1万1万 + 癞子', () => {
  const hand = [w(1), w(1), Z, w(2), w(3), w(4), t(7), t(8), t(9), s(5), s(5), s(5), s(9), s(9)];
  assert.equal(hand.length, 14);
  const res = analyzeHand(toCounts(hand), { wildTile: Z });
  assert.ok(res.winning);
});

test('双癞子作将', () => {
  const hand = [w(1), w(2), w(3), w(4), w(5), w(6), t(7), t(8), t(9), s(5), s(5), s(5), Z, Z];
  assert.equal(hand.length, 14);
  const res = analyzeHand(toCounts(hand), { wildTile: Z });
  assert.ok(res.winning);
});

test('四张癞子也能补完（极端情形）', () => {
  const hand = [w(1), w(1), w(1), t(9), t(9), t(9), s(5), s(5), s(5), s(1), Z, Z, Z, Z];
  assert.equal(hand.length, 14);
  const res = analyzeHand(toCounts(hand), { wildTile: Z });
  assert.ok(res.winning, '4 张癞子应能补出一个面子 + 将');
});

test('癞子不传入时当作普通牌（癞子参数才是唯一决定因素）', () => {
  // 同一手牌：把红中当癞子能胡，不当癞子就只是孤张
  const hand = [w(1), w(2), Z, w(4), w(5), w(6), t(7), t(8), t(9), s(5), s(5), s(5), s(9), s(9)];
  assert.equal(canWin(toCounts(hand), { wildTile: Z }), true);
  assert.equal(canWin(toCounts(hand), { wildTile: null }), false);
});

/* ------------------------------------------------------------------ */
/* 面子折算                                                            */
/* ------------------------------------------------------------------ */

test('带副露：手牌张数按 3 张一个面子折算', () => {
  const hand = [w(2), w(2), w(2), t(7), t(8), t(9), s(5), s(5), s(5), t(5), t(5)];
  assert.equal(hand.length, 11, '1 副露 → 手牌 11 张');
  const res = analyzeHand(toCounts(hand), { exposedMelds: 1 });
  assert.ok(res.winning);
});

test('全求人形态：4 副露 → 手牌只剩 2 张将', () => {
  const hand = [s(5), s(5)];
  const res = analyzeHand(toCounts(hand), { exposedMelds: 4 });
  assert.ok(res.winning, '只剩将牌也应该成立');
});

test('张数不符直接判不胡', () => {
  const hand = [w(1), w(2), w(3)];
  assert.equal(canWin(toCounts(hand)), false);
  const res = analyzeHand(toCounts(hand));
  assert.equal(res.winning, false);
  assert.equal(res.total, 3);
});

test('不能胡：孤张太多', () => {
  const hand = [w(1), w(1), w(1), w(3), w(5), w(7), t(2), t(4), t(6), t(8), t(8), t(8), s(1), s(9)];
  assert.equal(hand.length, 14);
  assert.equal(canWin(toCounts(hand)), false, `${formatTiles(hand)} 不应能胡`);
});

/* ------------------------------------------------------------------ */
/* 拆解辅助                                                            */
/* ------------------------------------------------------------------ */

test('拆解辅助：isAllTriplets / sequenceCount / wildCostOf', () => {
  const hand = [w(1), w(1), w(1), w(2), w(2), w(2), t(3), t(3), t(3), s(4), s(4), s(4), s(9), s(9)];
  const res = analyzeHand(toCounts(hand));
  assert.ok(res.winning);
  const d = res.decompositions.find((x) => isAllTriplets(x));
  assert.ok(d, '应存在全刻子拆解');
  assert.equal(sequenceCount(d), 0);
  assert.equal(wildCostOf(d), 0, '没用到癞子');

  // 混了顺子的牌型不该被认成全刻子
  const mixed = [w(1), w(2), w(3), w(4), w(5), w(6), t(7), t(8), t(9), s(5), s(5), s(5), s(9), s(9)];
  const dm = analyzeHand(toCounts(mixed)).decompositions[0];
  assert.equal(isAllTriplets(dm), false);
  assert.equal(sequenceCount(dm), 3);
});

test('compareHand：同花色不同写法解析结果一致', () => {
  const a = toCounts([w(1), w(2), w(3)]);
  const b = toCounts([makeTile('wan', 1), makeTile('wan', 2), makeTile('wan', 3)]);
  assert.deepEqual(a, b);
  assert.deepEqual(a.slice(0, 4), [1, 1, 1, 0]);
});
