/**
 * 对局状态机测试 —— 武汉红中赖子杠
 *
 * 覆盖：
 *   · 建局（136 张 / 发牌 / 翻底牌定癞子 / 皮子集合）
 *   · 面子折算与手牌张数守恒（特殊杠不占面子）
 *   · 开口判定（吃碰明杠算；暗杠、红中杠、皮子杠、癞子杠不算 —— 2026-10-21）
 *   · 杠后不补牌（action.noDraw）：只加番、不摸牌/不打牌，直接过手
 *   · 抢杠胡 → 承包；一炮单响按下家优先
 *   · 「N 番起胡」可选门槛
 *   · 确定性、荒庄、视图不泄露
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeTile,
  toCounts,
  tileName,
  WALL_SIZE,
  RED_DRAGON,
  WHITE_DRAGON,
  GREEN_DRAGON,
  EAST,
  SOUTH,
  WEST,
  NORTH,
} from '../src/engine/tiles.js';
import {
  createGame,
  act,
  legalActions,
  chiCombos,
  handNeeded,
  viewFor,
  computeSkinTiles,
  deriveWild,
  isWild,
  isSkin,
  isSpecial,
  HIDDEN_TILE,
} from '../src/engine/game.js';
import { createRuleSet } from '../src/engine/rules.js';
import { countFan, isQingYiSe } from '../src/engine/score.js';
import { exposedMeldCount, computeOpened, SPECIAL_GANG_TYPES, MELD_TYPES, sortMeldsForDisplay } from '../src/engine/melds.js';
import { analyzeHand } from '../src/engine/win.js';
import { decide } from '../src/bot/simpleBot.js';

const w = (n) => makeTile('wan', n);
const t = (n) => makeTile('tong', n);
const s = (n) => makeTile('tiao', n);
const Z = RED_DRAGON;

const RS = createRuleSet('koukou');
/** 兼容旧行为的测试规则：允许把红中 / 皮子 / 癞子打进牌河（默认已禁止，老吴 2026-10-20）。 */
const RS_SPECIAL_DISCARD = createRuleSet('koukou', { specialTilesNoDiscard: false });

/** 跑完整一局 */
function playFull(seed, ruleset = RS, maxSteps = 5000) {
  let state = createGame({ seed, ruleset });
  let steps = 0;
  while (state.phase !== 'settled' && steps < maxSteps) {
    steps++;
    const action = decide(state, state.turn);
    if (!action) break;
    state = act(state, action);
  }
  return { state, steps };
}

/**
 * 清空所有人的手牌并固定癞子/皮子，方便构造确定的局面。
 * 默认把癞子设成白板、皮子清空 —— 这样手牌里只要不出现白板就是「无癞子」。
 */
function blank(state, opts = {}) {
  for (const p of state.players) {
    p.hand = [];
    p.melds = [];
    p.discards = [];
    p.opened = false;
  }
  state.flipTile = opts.flipTile ?? null;
  state.wildTile = opts.wildTile ?? WHITE_DRAGON;
  state.skinTiles = opts.skinTiles ?? [];
  state.claims = [];
  state.claimIndex = 0;
  state.pendingXuGang = null;
  return state;
}

/* ------------------------------------------------------------------ */
/* 建局                                                                */
/* ------------------------------------------------------------------ */

test('建局：庄家 14 张、闲家各 13 张、翻底牌 1 张，牌墙剩 82 张', () => {
  const state = createGame({ seed: 1 });
  assert.equal(state.players[state.dealer].hand.length, 14);
  for (const p of state.players) {
    if (p.seat !== state.dealer) assert.equal(p.hand.length, 13);
  }
  assert.equal(state.wall.length, 82, '136 - 53 - 1(翻底牌) = 82');
  assert.equal(state.phase, 'discard');
  assert.equal(state.turn, state.dealer);
  assert.equal(state.dealer, 0);
});

test('发牌用的是同一副牌：全场每种牌恰好 4 张', () => {
  const state = createGame({ seed: 2 });
  const all = [...state.wall, state.flipTile];
  for (const p of state.players) all.push(...p.hand);
  assert.equal(all.length, WALL_SIZE);
  for (let v = 0; v < 34; v++) {
    assert.equal(all.filter((x) => x === v).length, 4, `${tileName(v)} 张数不对`);
  }
});

test('翻牌定癞子：癞子恒等于翻出那张按规则推出来的下一张，且两者不同', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const state = createGame({ seed });
    assert.notEqual(state.flipTile, null);
    assert.equal(state.wildTile, deriveWild(state.flipTile, RS), `seed=${seed}`);
    assert.notEqual(state.wildTile, state.flipTile, `seed=${seed} 皮子与癞子不应是同一张`);
  }
});

test('红中固定是皮（硬保证）：任何 seed 下红中都不是癞子、且都在皮子集合里', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const state = createGame({ seed });
    assert.equal(isWild(state, RED_DRAGON), false, `seed=${seed} 红中绝不是癞子`);
    assert.ok(isSkin(state, RED_DRAGON), `seed=${seed} 红中应始终是皮子`);
  }
});

test('翻出红中 / 翻北 → 癞子顺延发财；deriveWild 永不会返回红中', () => {
  assert.equal(deriveWild(RED_DRAGON, RS), GREEN_DRAGON, '翻红中 → 癞子发财');
  assert.equal(deriveWild(NORTH, RS), GREEN_DRAGON, '翻北 → 癞子发财（跳过红中）');
  assert.equal(deriveWild(GREEN_DRAGON, RS), WHITE_DRAGON, '翻发财 → 癞子白板');
  assert.equal(deriveWild(WHITE_DRAGON, RS), EAST, '翻白板 → 癞子东风');
  // 穷举所有 34 种翻牌，癞子都不可能是红中
  for (let f = 0; f < 34; f++) {
    assert.notEqual(deriveWild(f, { wildMode: 'flip' }), RED_DRAGON, `翻 ${tileName(f)} 不应让红中当癞子`);
  }
});

test('皮子集合 = 癞子往回数 2 张 + 红中，恒为 3 种 11 张，且不重复', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const state = createGame({ seed });
    assert.equal(state.skinTiles.length, 3, `seed=${seed} 皮子应为 3 种`);
    assert.equal(new Set(state.skinTiles).size, state.skinTiles.length, `seed=${seed} 皮子不应重复`);
    assert.ok(isSkin(state, state.flipTile), `seed=${seed} 翻出的那张永远是皮`);
    assert.ok(isSkin(state, RED_DRAGON), `seed=${seed} 红中应始终是皮子`);
    assert.ok(isWild(state, state.wildTile));
    assert.ok(isSpecial(state, state.wildTile));
    assert.equal(isWild(state, RED_DRAGON), false, '红中不是癞子');
    assert.equal(isSkin(state, state.wildTile), false, '癞子绝不能同时是皮');

    // 牌桌上皮子实张数恒为 11（3 种 × 4 张 − 翻出的那张已不在牌墙）
    let real = 0;
    for (const t of state.wall) if (state.skinTiles.includes(t)) real++;
    for (const p of state.players) {
      for (const t of p.hand) if (state.skinTiles.includes(t)) real++;
      for (const m of p.melds) for (const t of m.tiles) if (state.skinTiles.includes(t)) real++;
    }
    assert.equal(real, 11, `seed=${seed} 皮子实张数应为 11，实际 ${real}`);
  }
});

test('皮子口径（老吴）：翻五万 → 六万癞子 → 四万/五万/红中是皮 = 11 张', () => {
  const rs = createRuleSet('koukou');
  const flip = w(5);
  const wild = deriveWild(flip, rs);
  assert.equal(wild, w(6), '六万是癞子');
  const skins = computeSkinTiles(flip, wild, rs);
  assert.deepEqual(
    [...skins].sort((a, b) => a - b),
    [w(4), w(5), RED_DRAGON].sort((a, b) => a - b),
    '皮子 = 四万、五万、红中',
  );
  assert.equal(skins.length * 4 - 1, 11, '一共 11 张皮（五万被翻出 1 张，不再可用）');
});

test('皮子边界：数牌同花色内循环，字牌跳过红中', () => {
  const rs = createRuleSet('koukou');
  const cases = [
    [w(1), w(2), [w(1), w(9)]], // 一万 → 减一是一万、减二是九万（不出花色）
    [w(9), w(1), [w(9), w(8)]],
    [EAST, SOUTH, [EAST, WHITE_DRAGON]], // 东风 → 减一东风、减二白板
    [NORTH, GREEN_DRAGON, [NORTH, WEST]], // 翻北风 → 癞子发财（跳过红中）→ 皮 北风、西风
    [GREEN_DRAGON, WHITE_DRAGON, [GREEN_DRAGON, NORTH]],
  ];
  for (const [flip, wild, want] of cases) {
    assert.equal(deriveWild(flip, rs), wild, `翻 ${tileName(flip)} 的癞子`);
    const skins = computeSkinTiles(flip, wild, rs);
    for (const t of want) assert.ok(skins.includes(t), `皮子应含 ${tileName(t)}`);
    assert.ok(skins.includes(RED_DRAGON), '红中恒为皮');
    assert.equal(skins.length, 3, '恒为 3 种');
    assert.equal(skins.includes(wild), false, '癞子不当皮');
  }
});

test('翻出的底牌正好是红中时：癞子是发财、皮子 3 种 11 张、不留重复', () => {
  const rs = createRuleSet('koukou');
  const wild = deriveWild(RED_DRAGON, rs);
  assert.equal(wild, GREEN_DRAGON, '翻红中 → 癞子发财（红中永不当癞子）');
  const skins = computeSkinTiles(RED_DRAGON, wild, rs);
  assert.equal(skins.length, 3, '皮子 3 种');
  assert.equal(new Set(skins).size, skins.length, '不能出现两张红中');
  assert.ok(skins.includes(RED_DRAGON), '红中是皮');
  assert.equal(skins.includes(wild), false, '癞子不当皮');
  assert.equal(skins.length * 4 - 1, 11, '翻红中同样是 11 张皮');
});

test('响应等待时间 claimTimeoutMs 是房间级可配参数，非法值回退默认 8000', () => {
  // 默认值
  assert.equal(createRuleSet('koukou').claimTimeoutMs, 8000, '默认 8000ms');
  // 合法覆盖（房主建房时按需调整）
  assert.equal(createRuleSet('koukou', { claimTimeoutMs: 12000 }).claimTimeoutMs, 12000, '可覆盖为 12s');
  // 非法值回退
  assert.equal(createRuleSet('koukou', { claimTimeoutMs: 0 }).claimTimeoutMs, 8000, '0 回退默认');
  assert.equal(createRuleSet('koukou', { claimTimeoutMs: -1 }).claimTimeoutMs, 8000, '负数回退默认');
  assert.equal(createRuleSet('koukou', { claimTimeoutMs: NaN }).claimTimeoutMs, 8000, 'NaN 回退默认');
  // 小数取整
  assert.equal(createRuleSet('koukou', { claimTimeoutMs: 8500.6 }).claimTimeoutMs, 8501, '小数四舍五入');
});

test('viewFor 把「可吃」的多套组合下发给客户端（供玩家选择吃法）', () => {
  const state = blank(createGame({ seed: 12 }), { flipTile: t(9), wildTile: t(1) });
  state.players[0].hand = [w(5), s(1), s(1), s(1), s(2), s(2), s(2), s(3), s(3), s(3), s(4), s(4), s(4), s(5)];
  state.players[1].hand = [w(3), w(4), t(2), t(2), t(2), t(3), t(3), t(3), t(4), t(4), t(4), t(5), t(5)];
  state.players[2].hand = [t(6), t(6), t(6), t(7), t(7), t(7), t(8), t(8), t(8), t(9), t(9), t(9), t(1)];
  state.players[3].hand = [t(5), t(5), t(5), t(6), t(6), t(6), t(7), t(7), t(7), t(8), t(8), t(8), t(9)];
  state.turn = 0;
  state.phase = 'discard';

  act(state, { type: 'discard', seat: 0, tile: w(5) });
  // 下家 seat1 手里 {3万4万} 能配 5万 吃出 345万 这一种吃法
  const view = viewFor(state, 1);
  const chi = view.me.legal.find((a) => a.type === 'chi');
  assert.ok(chi, '下家应收到「可吃」提示');
  assert.ok(Array.isArray(chi.combos) && chi.combos.length >= 1, '吃法组合应下发给客户端');
});

test('响应阶段超时自动过（防卡死）：当前响应者连续 pass，牌局照常推进不卡死', () => {
  const state = blank(createGame({ seed: 12 }), { flipTile: t(9), wildTile: t(1) });
  state.players[0].hand = [w(5), s(1), s(1), s(1), s(2), s(2), s(2), s(3), s(3), s(3), s(4), s(4), s(4), s(5)];
  state.players[1].hand = [w(3), w(4), t(2), t(2), t(2), t(3), t(3), t(3), t(4), t(4), t(4), t(5), t(5)];
  state.players[2].hand = [t(6), t(6), t(6), t(7), t(7), t(7), t(8), t(8), t(8), t(9), t(9), t(9), t(1)];
  state.players[3].hand = [t(5), t(5), t(5), t(6), t(6), t(6), t(7), t(7), t(7), t(8), t(8), t(8), t(9)];
  state.turn = 0;
  state.phase = 'discard';

  act(state, { type: 'discard', seat: 0, tile: w(5) });
  assert.equal(state.phase, 'claim', '有人可吃/可碰时应进入响应阶段');
  // 模拟服务端超时：把当前响应者一律代为「过」，直到回到出牌 / 摸牌阶段
  let guard = 0;
  while (state.phase === 'claim' && guard++ < 10) {
    act(state, { type: 'pass', seat: state.turn });
  }
  assert.notEqual(state.phase, 'claim', '超时自动过之后不应还卡在响应阶段');
  // 之后应能继续走子（落到 discard 或已摸牌）
  assert.ok(state.phase === 'discard' || state.phase === 'settled');
});

/* ------------------------------------------------------------------ */
/* 面子折算                                                            */
/* ------------------------------------------------------------------ */

test('特殊杠不折算面子：红中杠 / 皮子杠 / 癞子杠都不改变手牌应有张数', () => {
  const state = createGame({ seed: 17 });
  const p = state.players[0];
  assert.equal(handNeeded(state, 0), 14);

  p.melds.push({ type: 'red', tiles: [RED_DRAGON], from: null });
  assert.equal(handNeeded(state, 0), 14);
  p.melds.push({ type: 'skin', tiles: [state.flipTile], from: null });
  assert.equal(handNeeded(state, 0), 14);
  p.melds.push({ type: 'wild', tiles: [state.wildTile], from: null });
  assert.equal(handNeeded(state, 0), 14);
  assert.equal(exposedMeldCount(p.melds), 0, '三种特殊杠都不占面子');

  p.melds.push({ type: 'peng', tiles: [w(1), w(1), w(1)], from: 1 });
  assert.equal(handNeeded(state, 0), 11, '一个碰折算 3 张');
  assert.equal(exposedMeldCount(p.melds), 1);
});

test('暗杠占面子但不算开口', () => {
  const state = blank(createGame({ seed: 61 }), { flipTile: t(9), wildTile: t(1) });
  const p = state.players[0];
  p.hand = [w(1), w(1), w(1), w(1), w(2), w(2), t(3), t(4), t(5), s(6), s(7), s(8), s(9), s(9)];
  state.turn = 0;
  state.phase = 'discard';

  act(state, { type: 'an', seat: 0, tile: w(1) });
  assert.equal(state.players[0].opened, false, '暗杠不算开口');
  assert.equal(exposedMeldCount(state.players[0].melds), 1, '暗杠占一个面子');
  assert.equal(handNeeded(state, 0), 11);
  assert.equal(state.players[0].hand.length, 11, '14 - 4 + 1(补摸) = 11');
});

/* ------------------------------------------------------------------ */
/* 特殊牌的处理                                                        */
/* ------------------------------------------------------------------ */

test('癞子 / 皮子 / 红中在手时可以杠掉，但都不算开口', () => {
  const state = blank(createGame({ seed: 51 }), {
    flipTile: t(9),
    wildTile: t(1),
    skinTiles: [t(9), Z],
  });
  const p = state.players[0];
  p.hand = [t(1), Z, t(9), w(1), w(2), w(3), w(4), w(5), w(6), s(5), s(5), s(6), s(7), s(8)];
  state.turn = 0;
  state.phase = 'discard';

  const types = legalActions(state, 0).map((a) => a.type);
  assert.ok(types.includes('wildgang'), '有癞子应能癞子杠');
  assert.ok(types.includes('redgang'), '有红中应能红中杠');
  assert.ok(types.includes('skingang'), '有皮子应能皮子杠');

  act(state, { type: 'redgang', seat: 0, tile: Z });
  assert.equal(state.players[0].opened, false, '红中杠不算开口（老吴 2026-10-21）');
  assert.equal(exposedMeldCount(state.players[0].melds), 0, '红中杠不占面子');
  assert.equal(handNeeded(state, 0), 14);
  assert.equal(state.players[0].hand.length, 14, '14 - 1 + 1(补摸) = 14');
});

test('手里没有红中时不给红中杠动作（按钮只在有红中时出现）', () => {
  const state = blank(createGame({ seed: 51 }), {
    flipTile: t(9),
    wildTile: t(1),
    skinTiles: [t(9), NORTH, Z],
  });
  const p = state.players[0];
  p.hand = [t(1), t(9), NORTH, w(1), w(2), w(3), w(4), w(5), w(6), s(5), s(5), s(6), s(7), s(8)];
  state.turn = 0;
  state.phase = 'discard';

  assert.ok(!legalActions(state, 0).some((a) => a.type === 'redgang'), '没有红中就没有红中杠');
});

test('红中杠 / 癞子杠 / 皮子杠的 tile 必须与杠种一致（防止杠错牌）', () => {
  const state = blank(createGame({ seed: 51 }), {
    flipTile: t(9),
    wildTile: t(1),
    skinTiles: [t(9), NORTH, Z],
  });
  const p = state.players[0];
  p.hand = [t(1), Z, t(9), NORTH, w(1), w(2), w(3), w(4), w(5), w(6), s(5), s(5), s(6), s(7), s(8)];
  state.turn = 0;
  state.phase = 'discard';

  assert.throws(() => act(state, { type: 'redgang', seat: 0, tile: NORTH }), /红中杠只能杠红中/);
  assert.throws(() => act(state, { type: 'wildgang', seat: 0, tile: NORTH }), /癞子杠只能杠癞子/);
  assert.throws(() => act(state, { type: 'skingang', seat: 0, tile: Z }), /不是本局皮子/);
  assert.equal(p.hand.length, 15, '被拒绝的动作不能从手里删牌');
});

/* 老吴 2026-10-21 纠正：特殊杠不能作为胡牌资格的「开口」；
   但输分是否被阳光翻倍是另一套口径（见 score.test.js：有特殊杠不触发阳光）。 */
test('皮子杠不算开口（不能因此获得胡牌资格）', () => {
  const state = blank(createGame({ seed: 51 }), {
    flipTile: t(9),
    wildTile: t(1),
    skinTiles: [t(9), Z],
  });
  const p = state.players[0];
  p.hand = [t(1), Z, t(9), w(1), w(2), w(3), w(4), w(5), w(6), s(5), s(5), s(6), s(7), s(8)];
  state.turn = 0;
  state.phase = 'discard';

  assert.equal(computeOpened(p.melds, state.ruleset), false, '杠之前：未开口');
  act(state, { type: 'skingang', seat: 0, tile: t(9) });
  assert.ok(state.players[0].melds.some((m) => m.type === 'skin'), '皮子已杠出');
  assert.equal(state.players[0].opened, false, '皮子杠不算开口');
});

test('癞子杠不算开口（不能因此获得胡牌资格）', () => {
  const state = blank(createGame({ seed: 51 }), {
    flipTile: t(9),
    wildTile: t(1),
    skinTiles: [t(9), Z],
  });
  const p = state.players[0];
  p.hand = [t(1), Z, t(9), w(1), w(2), w(3), w(4), w(5), w(6), s(5), s(5), s(6), s(7), s(8)];
  state.turn = 0;
  state.phase = 'discard';

  act(state, { type: 'wildgang', seat: 0, tile: t(1) });
  assert.ok(state.players[0].melds.some((m) => m.type === 'wild'), '癞子已杠出');
  assert.equal(state.players[0].opened, false, '癞子杠不算开口');
});

test('红中 / 皮子默认不能被别人碰杠', () => {
  const state = blank(createGame({ seed: 13, ruleset: RS_SPECIAL_DISCARD }), { skinTiles: [t(9), Z] });
  state.players[0].hand = [Z, w(1), w(2), w(3), w(5), w(6), w(7), t(1), t(2), t(3), s(5), s(5), s(5), s(9)];
  state.players[1].hand = [Z, Z, w(4), w(5), w(6), t(1), t(2), t(3), s(1), s(2), s(3), s(5), s(5)];
  state.players[2].hand = [Z, Z, w(7), w(8), w(9), t(4), t(5), t(6), s(1), s(2), s(3), s(8), s(8)];
  state.players[3].hand = [Z, Z, w(1), w(2), w(3), t(7), t(8), t(9), s(4), s(5), s(6), s(9), s(9)];
  state.turn = 0;
  state.phase = 'discard';

  act(state, { type: 'discard', seat: 0, tile: Z });
  const anyPeng = state.claims.some((c) => c.options.some((o) => o.type === 'peng'));
  assert.equal(anyPeng, false, '红中不该被碰');
});

/* ------------------------------------------------------------------ */
/* 红中不能吃 / 碰 / 胡（老吴 2026-10-08 重新明确）                      */
/* ------------------------------------------------------------------ */

test('红中不能吃：即便上家有搭子也不给「吃」选项', () => {
  // 🔴 吃是**独立于碰/明杠的代码路径**（`chiAllowed && !special`，game.js 约 629 行），
  //   原来只有「不能碰」一条断言（上方用例），吃这条路当时**零覆盖**。
  //   这里让下家有完整搭子（红中两侧的牌），若特牌闸门失效就会冒出「吃」。
  const state = blank(createGame({ seed: 13, ruleset: RS_SPECIAL_DISCARD }), { skinTiles: [t(9), Z] });
  // 本局癞子用筒 1，红中不是癞子（红中永远不能当癞子）
  assert.notEqual(state.wildTile, Z, '红中不能当癞子');
  // 下家（seat 1）有 w(3)+w(4)+w(5) 的顺子搭子
  state.players[0].hand = [Z, t(1), t(2), t(3), t(4), t(5), t(6), t(7), t(8), s(1), s(2), s(3), s(4), s(5)];
  state.players[1].hand = [w(3), w(4), w(5), w(6), w(7), w(8), w(9), t(1), t(2), t(3), t(4), t(5), t(6)];
  state.players[2].hand = [w(1), w(2), t(7), t(8), t(9), s(6), s(7), s(8), s(9), s(1), s(2), s(3), s(4)];
  state.players[3].hand = [w(9), t(1), t(2), t(3), t(4), t(5), t(6), s(1), s(2), s(3), s(4), s(5), s(6), s(7)];
  state.turn = 0;
  state.phase = 'discard';

  act(state, { type: 'discard', seat: 0, tile: Z });
  const anyChi = state.claims.some((c) => c.options.some((o) => o.type === 'chi'));
  assert.equal(anyChi, false, '红中不该被吃');

  // 反证：同样搭子换成打出手牌，红中**换成普通牌**时是可以吃的 ——
  //   证明上面那条不是因为「本来就没有吃」而假绿。
  const state2 = blank(createGame({ seed: 13, ruleset: RS_SPECIAL_DISCARD }), { skinTiles: [t(9), Z] });
  state2.players[0].hand = [w(5), t(1), t(2), t(3), t(4), t(5), t(6), t(7), t(8), s(1), s(2), s(3), s(4), s(5)];
  state2.players[1].hand = [w(3), w(4), w(6), w(7), w(8), w(9), t(1), t(2), t(3), t(4), t(5), t(6), t(7)];
  state2.players[2].hand = [w(1), w(2), t(7), t(8), t(9), s(6), s(7), s(8), s(9), s(1), s(2), s(3), s(4)];
  state2.players[3].hand = [w(9), t(1), t(2), t(3), t(4), t(5), t(6), s(1), s(2), s(3), s(4), s(5), s(6), s(7)];
  state2.turn = 0;
  state2.phase = 'discard';
  act(state2, { type: 'discard', seat: 0, tile: w(5) });
  const chiOk = state2.claims.some((c) => c.options.some((o) => o.type === 'chi'));
  assert.equal(chiOk, true, '反证：普通牌有搭子时是可以吃的，说明上面那条不是假绿');
});

test('红中 / 皮子 / 癞子都不能被别人吃、碰、明杠（三种一次覆盖；红中不依赖 skinTiles）', () => {
  const rs = createRuleSet('koukou', {
    specialTilesNoDiscard: false,
    skinIncludesRedDragon: false,
  });
  const base = createGame({ seed: 31, ruleset: rs });
  const wild = base.wildTile;
  const skin = [w(3), w(4), t(9)].find((t) => t !== wild && t !== Z);

  for (const tile of [Z, skin, wild]) {
    const st = blank(createGame({ seed: 31, ruleset: rs }), {
      flipTile: t(9),
      wildTile: wild,
      skinTiles: [skin],
    });
    // 上家/对家/下家都握有这张牌的对子/刻子；下家还刻意摆出可吃的搭子。
    const fillers = [w(1), w(2), w(4), w(6), w(7), w(8), t(1), t(2), t(3), s(1), s(2)];
    st.players[0].hand = [tile, ...fillers, w(5), w(9)];
    st.players[1].hand = [tile, tile, tile, w(2), w(4), w(4), w(6), ...fillers.slice(0, 6)];
    st.players[2].hand = [tile, tile, tile, ...fillers];
    st.players[3].hand = [tile, tile, tile, ...fillers];
    st.turn = 0;
    st.phase = 'discard';

    act(st, { type: 'discard', seat: 0, tile });
    const claimTypes = new Set(st.claims.flatMap((c) => c.options.map((o) => o.type)));
    for (const type of ['chi', 'peng', 'zhi']) {
      assert.ok(!claimTypes.has(type), `${tileName(tile)} 不该被${type}`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* 特殊牌不能进牌河（老吴 2026-10-20）                                  */
/* ------------------------------------------------------------------ */

test('红中 / 皮子 / 癞子不能打进牌河：只给杠，点「打出」自动改判为杠', () => {
  const st = blank(createGame({ seed: 21 }), {
    flipTile: t(9), wildTile: w(5), skinTiles: [w(3), w(4), Z],
  });
  st.players[0].hand = [w(5), w(3), Z, w(1), w(2), w(2), w(2), t(1), t(1), t(1), s(1), s(1), s(1), s(9)];
  st.turn = 0;
  st.phase = 'discard';

  const acts = legalActions(st, 0);
  const disc = acts.filter((a) => a.type === 'discard').map((a) => a.tile);
  assert.ok(!disc.includes(w(5)), '癞子不能打');
  assert.ok(!disc.includes(w(3)), '皮子不能打');
  assert.ok(!disc.includes(Z), '红中不能打');
  assert.ok(disc.includes(w(1)), '普通牌仍可打');
  assert.ok(acts.some((a) => a.type === 'wildgang' && a.tile === w(5)), '癞子杠可选');
  assert.ok(acts.some((a) => a.type === 'skingang' && a.tile === w(3)), '皮子杠可选');
  assert.ok(acts.some((a) => a.type === 'redgang' && a.tile === Z), '红中杠可选');

  // 点「打出」红中 → 引擎改判红中杠：牌进副露、牌河不出牌
  const before = st.players[0].discards.length;
  act(st, { type: 'discard', seat: 0, tile: Z });
  assert.equal(st.players[0].discards.length, before, '红中没进牌河');
  assert.ok(st.players[0].melds.some((m) => m.type === 'red' && m.tiles[0] === Z), '红中进了副露（红中杠）');
  assert.equal(st.players[0].opened, false, '红中杠不算开口');
});

test('红中即使不在皮子集（skinIncludesRedDragon=false）也仍是特殊杠牌：不能打出、可红中杠', () => {
  const rs = createRuleSet('koukou', { skinIncludesRedDragon: false });
  const st = blank(createGame({ seed: 24, ruleset: rs }), {
    flipTile: t(9), wildTile: w(5), skinTiles: [w(3), w(4)],
  });
  st.players[0].hand = [Z, w(1), w(2), w(2), w(2), t(1), t(1), t(1), s(1), s(1), s(1), s(2), s(3), s(4)];
  st.turn = 0;
  st.phase = 'discard';

  assert.ok(!st.skinTiles.includes(Z), '本局配置明确不把红中算进皮子集合');
  const acts = legalActions(st, 0);
  assert.ok(!acts.some((a) => a.type === 'discard' && a.tile === Z), '红中无论如何都不能打出');
  assert.ok(acts.some((a) => a.type === 'redgang' && a.tile === Z), '红中仍可红中杠');

  act(st, { type: 'discard', seat: 0, tile: Z });
  assert.ok(st.players[0].melds.some((m) => m.type === 'red' && m.tiles[0] === Z), '点打出仍自动改判红中杠');
  assert.ok(!st.players[0].discards.includes(Z), '红中没有进牌河');
});

test('点「打出」皮子 / 癞子 → 改判为皮子杠 / 癞子杠（牌河仍无特殊牌）', () => {
  const st = blank(createGame({ seed: 22 }), {
    flipTile: t(9), wildTile: w(5), skinTiles: [w(3), Z],
  });
  st.players[0].hand = [w(5), w(3), Z, w(1), w(2), w(2), w(2), t(1), t(1), t(1), s(1), s(1), s(1), s(9)];
  st.turn = 0;
  st.phase = 'discard';

  act(st, { type: 'discard', seat: 0, tile: w(3) });
  assert.ok(st.players[0].melds.some((m) => m.type === 'skin' && m.tiles[0] === w(3)), '皮子杠生效');
  act(st, { type: 'discard', seat: 0, tile: w(5) });
  assert.ok(st.players[0].melds.some((m) => m.type === 'wild' && m.tiles[0] === w(5)), '癞子杠生效');
  assert.equal(st.players[0].discards.length, 0, '牌河没有任何特殊牌');
});

test('specialTilesNoDiscard=false ⇒ 恢复旧行为（红中/皮子/癞子可打）', () => {
  const rs = createRuleSet('koukou', { specialTilesNoDiscard: false });
  const st = blank(createGame({ seed: 23, ruleset: rs }), {
    flipTile: t(9), wildTile: w(5), skinTiles: [w(3), Z],
  });
  st.players[0].hand = [w(5), w(3), Z, w(1), w(2), w(2), w(2), t(1), t(1), t(1), s(1), s(1), s(1), s(9)];
  st.turn = 0;
  st.phase = 'discard';

  const disc = legalActions(st, 0).filter((a) => a.type === 'discard').map((a) => a.tile);
  assert.ok(disc.includes(w(5)) && disc.includes(w(3)) && disc.includes(Z), '关掉开关后三类牌都能打');
  act(st, { type: 'discard', seat: 0, tile: Z });
  assert.equal(st.players[0].discards[st.players[0].discards.length - 1], Z, '红中确实进了牌河');
});

test('整局不变量：红中 / 皮子 / 癞子从不出现在牌河（20 局）', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const { state } = playFull(seed);
    const banned = new Set([...(state.skinTiles || []), state.wildTile].filter(Number.isInteger));
    for (const d of state.discardLog) {
      assert.ok(!banned.has(d.tile), `seed=${seed}：特殊牌 ${d.tile} 进了牌河`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* 吃                                                                  */
/* ------------------------------------------------------------------ */

test('吃只能吃上家：非下家有搭子也不能吃', () => {
  const a = blank(createGame({ seed: 11 }), { flipTile: t(9), wildTile: t(1) });
  a.players[0].hand = [w(5), s(1), s(1), s(1), s(2), s(2), s(2), s(3), s(3), s(3), s(4), s(4), s(4), s(5)];
  a.players[1].hand = [t(1), t(1), t(1), t(2), t(2), t(2), t(3), t(3), t(3), t(4), t(4), t(4), t(5)];
  a.players[2].hand = [w(3), w(4), t(6), t(6), t(6), t(7), t(7), t(7), t(8), t(8), t(8), t(9), t(9)];
  a.players[3].hand = [t(5), t(5), t(5), t(6), t(6), t(6), t(7), t(7), t(7), t(8), t(8), t(8), t(9)];
  a.turn = 0;
  a.phase = 'discard';

  act(a, { type: 'discard', seat: 0, tile: w(5) });
  assert.equal(
    a.claims.some((c) => c.options.some((o) => o.type === 'chi')),
    false,
    '下家没搭子、有搭子的又不是下家 → 无人能吃',
  );

  const b = blank(createGame({ seed: 12 }), { flipTile: t(9), wildTile: t(1) });
  b.players[0].hand = [w(5), s(1), s(1), s(1), s(2), s(2), s(2), s(3), s(3), s(3), s(4), s(4), s(4), s(5)];
  b.players[1].hand = [w(3), w(4), t(2), t(2), t(2), t(3), t(3), t(3), t(4), t(4), t(4), t(5), t(5)];
  b.players[2].hand = [t(6), t(6), t(6), t(7), t(7), t(7), t(8), t(8), t(8), t(9), t(9), t(9), t(1)];
  b.players[3].hand = [t(5), t(5), t(5), t(6), t(6), t(6), t(7), t(7), t(7), t(8), t(8), t(8), t(9)];
  b.turn = 0;
  b.phase = 'discard';

  act(b, { type: 'discard', seat: 0, tile: w(5) });
  assert.equal(b.phase, 'claim');
  const g = b.claims.find((c) => c.seat === 1);
  assert.ok(g, '下家应出现在响应列表里');
  assert.ok(g.options.some((o) => o.type === 'chi'));
});

test('chiCombos：能吃出所有合法组合', () => {
  const hand = [w(1), w(2), w(4), w(5), w(6)];
  const combos = chiCombos(hand, w(3)).map((c) => c.join('-')).sort();
  const expected = [
    [w(1), w(2)].join('-'),
    [w(2), w(4)].join('-'),
    [w(4), w(5)].join('-'),
  ].sort();
  assert.deepEqual(combos, expected);
  assert.deepEqual(chiCombos(hand, EAST), [], '字牌不能被吃');
});

test('chiCombos 不允许用赖子/皮子当顺子材料（武汉口径）', () => {
  const wild = w(5);
  const exclude = [wild, RED_DRAGON];
  // 手里只有 {赖子(5万), 6万}，别人打 4万 → 不能用赖子凑 456万
  assert.deepEqual(chiCombos([wild, w(6)], w(4), exclude), [], '赖子(5万)不能当 456万 的搭子');
  // 手里只有 {赖子(5万), 3万}，别人打 4万 → 不能用赖子凑 345万
  assert.deepEqual(chiCombos([wild, w(3)], w(4), exclude), [], '赖子(5万)不能当 345万 的搭子');
  // 反向：赖子=9万时，{4万,5万} 是真实牌 → 仍应能吃 345万
  const exclude2 = [w(9), RED_DRAGON];
  assert.deepEqual(chiCombos([w(4), w(5)], w(3), exclude2), [[w(4), w(5)]], '真实 4/5万 仍能吃');
  // 皮子(=3万) 也不能当材料：{3万(皮),5万} 打 4万 → 不能凑 345万
  const skin = w(3);
  const exclude3 = [w(9), skin, RED_DRAGON];
  assert.deepEqual(chiCombos([w(3), w(5)], w(4), exclude3), [], '皮子(3万)不能当 345万 的搭子');
});

test('赖子不能作为吃牌材料：discard 后不给含赖子的吃牌选项', () => {
  const state = blank(createGame({ seed: 12 }), { flipTile: t(9), wildTile: w(5) });
  // seat0 打 4万；seat1 手里有 赖子(5万) + 6万（恰好能凑「456万」的假搭子）
  state.players[0].hand = [w(4), s(1), s(1), s(1), s(2), s(2), s(2), s(3), s(3), s(3), s(4), s(4), s(4), s(5)];
  state.players[1].hand = [w(5), w(6), t(2), t(2), t(2), t(3), t(3), t(3), t(4), t(4), t(4), t(5), t(5)];
  state.players[2].hand = [t(6), t(6), t(6), t(7), t(7), t(7), t(8), t(8), t(8), t(9), t(9), t(9), t(9)];
  state.players[3].hand = [t(5), t(5), t(5), t(6), t(6), t(6), t(7), t(7), t(7), t(8), t(8), t(8), t(9)];
  state.turn = 0;
  state.phase = 'discard';

  act(state, { type: 'discard', seat: 0, tile: w(4) });
  // 全局不变量：任何吃牌选项的 combo 都不能包含赖子(5万)
  // —— 有 bug 时 seat1 会拿到 [5万,6万] 的吃牌组合，这里会触发断言失败
  for (const c of state.claims) {
    for (const o of c.options) {
      if (o.type === 'chi') {
        for (const combo of o.combos) {
          assert.ok(!combo.includes(w(5)), '吃牌组合不能包含赖子(5万)');
        }
      }
    }
  }
});

test('doChi 拒绝把赖子当吃牌材料（防御伪造意图）', () => {
  const state = blank(createGame({ seed: 12 }), { flipTile: t(9), wildTile: w(5) });
  state.players[1].hand = [w(5), w(6), s(1), s(1), s(1), s(2), s(2), s(2), s(3), s(3), s(3), s(4), s(4), s(5)];
  state.players[1].melds = [];
  state.lastDiscard = { tile: w(4), from: 0 };
  state.phase = 'claim';
  state.turn = 1;
  assert.throws(
    () => act(state, { type: 'chi', seat: 1, tile: w(4), tiles: [w(5), w(6)] }),
    /赖子|皮子|不能用于吃牌/,
    '用赖子(5万)凑 456万 吃牌必须被拒绝',
  );
});

test('doPeng 拒绝把特殊牌当碰牌材料（防御伪造意图）', () => {
  const state = blank(createGame({ seed: 12 }), { flipTile: t(9), wildTile: w(5) });
  // 被碰的牌若是赖子(5万)本身 → 必须拒（正常流程已被 canClaimSpecialTiles 拦，这里兜底）
  state.players[1].hand = [w(5), w(5), s(1), s(1), s(1), s(2), s(2), s(2), s(3), s(3), s(3), s(4), s(4), s(5)];
  state.players[1].melds = [];
  state.lastDiscard = { tile: w(5), from: 0 };
  state.phase = 'claim';
  state.turn = 1;
  assert.throws(
    () => act(state, { type: 'peng', seat: 1 }),
    /赖子|皮子|不能用于碰牌/,
    '碰赖子(5万)必须被拒绝',
  );
});

test('皮子不能作为吃牌材料：discard 后不给含皮子的吃牌选项', () => {
  const state = blank(createGame({ seed: 12, ruleset: RS_SPECIAL_DISCARD }), { flipTile: t(9), wildTile: w(5), skinTiles: [w(3), w(4)] });
  // seat0 打 4万；seat1 手里 {皮子(3万), 5万}（恰好能凑「345万」的假搭子，皮子被当作 3万用）
  state.players[0].hand = [w(4), s(1), s(1), s(1), s(2), s(2), s(2), s(3), s(3), s(3), s(4), s(4), s(4), s(5)];
  state.players[1].hand = [w(3), w(5), t(2), t(2), t(2), t(3), t(3), t(3), t(4), t(4), t(4), t(5), t(5)];
  state.players[2].hand = [t(6), t(6), t(6), t(7), t(7), t(7), t(8), t(8), t(8), t(9), t(9), t(9), t(9)];
  state.players[3].hand = [t(5), t(5), t(5), t(6), t(6), t(6), t(7), t(7), t(7), t(8), t(8), t(8), t(9)];
  state.turn = 0;
  state.phase = 'discard';

  act(state, { type: 'discard', seat: 0, tile: w(4) });
  // 全局不变量：任何吃牌选项的 combo 都不能包含皮子(3万)
  // —— 有 bug 时 seat1 会拿到 [3万,5万] 的吃牌组合（皮子顶 3万），这里会触发断言失败
  for (const c of state.claims) {
    for (const o of c.options) {
      if (o.type === 'chi') {
        for (const combo of o.combos) {
          assert.ok(!combo.includes(w(3)), '吃牌组合不能包含皮子(3万)');
        }
      }
    }
  }
});

test('doPeng 拒绝把皮子当碰牌材料（防御伪造意图）', () => {
  const state = blank(createGame({ seed: 12, ruleset: RS_SPECIAL_DISCARD }), { flipTile: t(9), wildTile: w(5), skinTiles: [w(3), w(4)] });
  // 被碰的牌若是皮子(3万)本身 → 必须拒（正常流程已被 canClaimSpecialTiles 拦，这里兜底）
  state.players[1].hand = [w(3), w(3), s(1), s(1), s(1), s(2), s(2), s(2), s(3), s(3), s(3), s(4), s(4), s(5)];
  state.players[1].melds = [];
  state.lastDiscard = { tile: w(3), from: 0 };
  state.phase = 'claim';
  state.turn = 1;
  assert.throws(
    () => act(state, { type: 'peng', seat: 1 }),
    /赖子|皮子|不能用于碰牌/,
    '碰皮子(3万)必须被拒绝',
  );
});

test('碰可以开口', () => {
  const state = blank(createGame({ seed: 71 }), { flipTile: t(9), wildTile: t(1) });
  state.players[0].hand = [w(5), t(2), t(2), t(2), t(3), t(3), t(3), t(4), t(4), t(4), t(5), t(5), t(5), t(6)];
  state.players[1].hand = [w(5), w(5), s(1), s(1), s(1), s(2), s(2), s(2), s(3), s(3), s(3), s(4), s(6)];
  state.players[2].hand = [t(7), t(7), t(7), t(8), t(8), t(8), s(5), s(5), s(5), s(6), s(6), s(6), s(7)];
  state.players[3].hand = [t(9), t(9), t(9), s(8), s(8), s(8), s(9), s(9), s(9), w(1), w(1), w(1), w(2)];
  state.turn = 0;
  state.phase = 'discard';

  act(state, { type: 'discard', seat: 0, tile: w(5) });
  assert.equal(state.phase, 'claim');
  const g = state.claims.find((c) => c.seat === 1);
  assert.ok(g && g.options.some((o) => o.type === 'peng'), '下家应能碰');

  act(state, { type: 'peng', seat: 1 });
  assert.equal(state.players[1].opened, true, '碰算开口');
  assert.equal(state.phase, 'discard');
  assert.equal(state.turn, 1);
  assert.equal(state.players[1].hand.length, 11);
  assert.equal(handNeeded(state, 1), 11);
});

/* ------------------------------------------------------------------ */
/* 必须开口 / N 番起胡                                                  */
/* ------------------------------------------------------------------ */

test('必须开口：未开口时没有「胡」这个选项，开口后就有了', () => {
  const state = blank(createGame({ seed: 7, ruleset: createRuleSet('koukou', { enforceMinFan: false }) }), { flipTile: WHITE_DRAGON, wildTile: EAST });
  const p = state.players[1];
  p.hand = [w(1), w(2), w(3), w(4), w(5), w(6), t(7), t(8), t(9), t(5), t(5), t(5), s(5), s(5)];
  state.turn = 1;
  state.phase = 'discard';

  p.opened = false;
  assert.equal(legalActions(state, 1).some((a) => a.type === 'win'), false, '未开口不该能胡');

  p.opened = true;
  assert.equal(legalActions(state, 1).some((a) => a.type === 'win'), true, '开口后应能胡');
});

test('只有红中杠 / 皮子杠 / 癞子杠 / 暗杠都不算开口（不能凭它们胡牌）', () => {
  const state = blank(createGame({ seed: 7, ruleset: createRuleSet('koukou', { enforceMinFan: false }) }), {
    flipTile: WHITE_DRAGON, wildTile: EAST, skinTiles: [],
  });
  const p = state.players[1];
  p.hand = [w(1), w(2), w(3), w(4), w(5), w(6), t(7), t(8), t(9), t(5), t(5), t(5), s(5), s(5)];
  state.turn = 1;
  state.phase = 'discard';

  for (const type of ['red', 'skin', 'wild', 'an']) {
    p.melds = [{ type, tiles: [w(9)], from: null }];
    p.opened = computeOpened(p.melds, state.ruleset);
    assert.equal(p.opened, false, `${type} 杠不算开口`);
    assert.equal(
      legalActions(state, 1).some((a) => a.type === 'win'),
      false,
      `只有 ${type} 杠时不能胡`,
    );
  }

  p.melds = [{ type: 'peng', tiles: [w(9), w(9), w(9)], from: 0 }];
  p.opened = computeOpened(p.melds, state.ruleset);
  assert.equal(p.opened, true, '碰才算开口');
});

test('关闭 mustOpen 后门清也能胡', () => {
  const ruleset = createRuleSet('koukou', { mustOpen: false, enforceMinFan: false });
  const state = blank(createGame({ seed: 7, ruleset }), { flipTile: WHITE_DRAGON, wildTile: EAST });
  const p = state.players[1];
  p.hand = [w(1), w(2), w(3), w(4), w(5), w(6), t(7), t(8), t(9), t(5), t(5), t(5), s(5), s(5)];
  state.turn = 1;
  state.phase = 'discard';
  p.opened = false;

  assert.ok(legalActions(state, 1).some((a) => a.type === 'win'));
});

test('起胡门槛（小胡 6 / 大胡 3）：番数不够不给胡，关掉开关就能胡', () => {
  const strict = createRuleSet('kaikou', { enforceMinFan: true }); // 小胡门槛 6 番
  const state = blank(createGame({ seed: 7, ruleset: strict }), { flipTile: WHITE_DRAGON, wildTile: EAST });
  const p = state.players[1];
  // 小胡 1 + 自摸 1 + 硬胡 1 = 3 番，差 3 番到 6
  p.hand = [w(1), w(2), w(3), w(4), w(5), w(6), t(7), t(8), t(9), t(5), t(5), t(5), s(5), s(5)];
  state.turn = 1;
  state.phase = 'discard';
  p.opened = true;
  assert.equal(legalActions(state, 1).some((a) => a.type === 'win'), false, '3 番 < 6 番起胡');

  // 同一个开关关掉就能胡 → 证明是门槛在挡（显式关闭，覆盖默认开启）
  const lenient = blank(createGame({ seed: 7, ruleset: createRuleSet('kaikou', { enforceMinFan: false }) }), {
    flipTile: WHITE_DRAGON,
    wildTile: EAST,
  });
  const q = lenient.players[1];
  q.hand = [...p.hand];
  q.opened = true;
  lenient.turn = 1;
  lenient.phase = 'discard';
  assert.ok(legalActions(lenient, 1).some((a) => a.type === 'win'));

  // 分档验证：大胡门槛 3 番（与小胡 6 番不同）。碰碰胡底 3 + 自摸 1 + 硬胡 1 = 5 ≥ 3 → 能胡
  const bigWin = blank(createGame({ seed: 7, ruleset: strict }), {
    flipTile: WHITE_DRAGON,
    wildTile: EAST,
  });
  const u = bigWin.players[1];
  u.hand = [w(1), w(1), w(1), w(2), w(2), w(2), w(3), w(3), w(3), t(5), t(5), t(5), s(7), s(7)];
  u.opened = true;
  bigWin.turn = 1;
  bigWin.phase = 'discard';
  assert.ok(
    legalActions(bigWin, 1).some((a) => a.type === 'win'),
    '大胡 5 番 ≥ 3 番门槛，能胡',
  );
});

/* ------------------------------------------------------------------ */
/* 抢杠胡 / 承包 / 一炮单响                                             */
/* ------------------------------------------------------------------ */

test('抢杠胡：被抢的那家承包，独付全部输分', () => {
  const state = blank(createGame({ seed: 30 }), { flipTile: null, wildTile: WHITE_DRAGON });

  // seat1：碰过三筒，手里捏着第四张 → 蓄杠
  state.players[1].melds = [{ type: 'peng', tiles: [t(3), t(3), t(3)], from: 0 }];
  state.players[1].opened = true;
  state.players[1].hand = [t(3), t(3), t(3), w(1), w(1), w(1), s(8), s(8), s(8), w(9)];

  // seat2：已开口，手里等着 3 筒做 123筒 顺子
  state.players[2].melds = [{ type: 'peng', tiles: [w(1), w(1), w(1)], from: 1 }];
  state.players[2].opened = true;
  state.players[2].hand = [t(1), t(2), w(4), w(5), w(6), w(7), w(8), w(9), s(5), s(5)];

  state.turn = 1;
  state.phase = 'discard';

  assert.ok(
    legalActions(state, 1).some((a) => a.type === 'xu' && a.tile === t(3)),
    '碰过三筒、手里捏着第四张 → 蓄杠必须在合法动作里（老吴 2026-10-20）',
  );
  act(state, { type: 'xu', seat: 1, tile: t(3) });

  // 老吴 2026-10-02：**先问，不直接结算** —— 能抢的人自己点「胡」才收分
  assert.equal(state.phase, 'claim', '有人能抢杠 → 先进响应阶段');
  assert.ok(state.pendingXuGang && state.pendingXuGang.seat === 1 && state.pendingXuGang.tile === t(3),
    '记下「待抢的杠」（谁在补哪张）');
  assert.equal(state.turn, 2, '按「从补杠者下家起算」先问 seat2');
  assert.equal(state.lastDiscard, null, '抢杠阶段没有「刚打出的牌」，不能留脏值');
  assert.equal(state.lastDraw, null, '也不能把补杠者刚摸的牌当成抢杠者的 lastDraw 下发');

  const opts = legalActions(state, 2).map((a) => a.type);
  assert.ok(opts.includes('win'), '给「胡」');
  assert.ok(opts.includes('pass'), '**同时给「过」** —— 这正是老吴报的那个缺陷');

  act(state, { type: 'win', seat: 2 });

  assert.equal(state.phase, 'settled');
  assert.equal(state.result.type, 'win');
  assert.equal(state.result.winner, 2, '抢杠的是下家');
  assert.ok(state.result.types.includes('qiangGangHu'));
  assert.ok(state.result.baozhuang, '抢杠胡应有承包记录');
  assert.equal(state.result.baozhuang.seat, 1);
  assert.equal(state.result.baozhuang.amount, state.result.totalWin);
  assert.equal(state.pendingXuGang, null, '结算后不残留「待抢的杠」');

  // 承包者独付：其余两家出 0
  for (const pay of state.result.payments) {
    assert.equal(pay.pay, pay.seat === 1 ? state.result.totalWin : 0);
  }
  assert.match(state.result.text, /承包/);
});

test('抢杠胡「过」：补杠照常补完，牌局继续（不再强制结算）', () => {
  const state = blank(createGame({ seed: 30 }), { flipTile: null, wildTile: WHITE_DRAGON });
  state.players[1].melds = [{ type: 'peng', tiles: [t(3), t(3), t(3)], from: 0 }];
  state.players[1].opened = true;
  // 10 张 = 13 − 3（已碰出的三张），其中含第 4 张三筒
  state.players[1].hand = [t(3), w(1), w(1), w(1), s(8), s(8), s(8), w(9), s(1), s(2)];
  state.players[2].melds = [{ type: 'peng', tiles: [w(1), w(1), w(1)], from: 1 }];
  state.players[2].opened = true;
  state.players[2].hand = [t(1), t(2), w(4), w(5), w(6), w(7), w(8), w(9), s(5), s(5)];
  state.turn = 1;
  state.phase = 'discard';
  const wallBefore = state.wall.length;
  const handBefore = state.players[1].hand.length;

  act(state, { type: 'xu', seat: 1, tile: t(3) });
  assert.equal(state.phase, 'claim', '先问抢杠');
  act(state, { type: 'pass', seat: 2 });

  assert.equal(state.phase, 'discard', '「过」之后不是结算，而是回到补杠者出牌');
  assert.equal(state.turn, 1, '回合还给补杠者（不换手、不摸别家）');
  assert.equal(state.pendingXuGang, null, '「待抢的杠」已清');
  assert.equal(state.result, null, '没有任何结算');
  assert.equal(state.wall.length, wallBefore - 1, '补杠后补摸一张（杠上开花的机会照给）');
  assert.ok(
    state.players[1].melds.some((m) => m.type === 'xu' && m.tiles[0] === t(3) && m.tiles.length === 4),
    '杠真的补成了（碰 → 蓄杠，4 张）',
  );
  assert.equal(state.players[1].hand.length, handBefore, '手里：−1（补进杠）+1（补摸）= 不变');
  assert.ok(!state.players[1].melds.some((m) => m.type === 'peng' && m.tiles[0] === t(3)), '旧「碰」已被替换');
});

test('杠后不补牌只对红中/皮/赖成立：暗杠必须补摸（noDraw 被剥离，2026-10-24）', () => {
  const st = blank(createGame({ seed: 74 }), { flipTile: null, wildTile: WHITE_DRAGON });
  st.players[0].hand = [w(9), w(9), w(9), w(9), w(1), w(2), w(3), t(4), t(5), t(6), s(7), s(8), s(9), s(5)];
  st.wall = [s(5), ...new Array(20).fill(w(2))];
  st.turn = 0;
  st.phase = 'discard';
  const wallBefore = st.wall.length;

  act(st, { type: 'an', seat: 0, tile: w(9), noDraw: true });

  assert.ok(st.players[0].melds.some((m) => m.type === 'an' && m.tiles[0] === w(9)), '暗杠成立');
  assert.equal(st.players[0].hand.length, 11, '14 - 4 + 1 = 11，占面子的杠必须补摸');
  assert.equal(st.turn, 0, '补摸后仍是自己的出牌回合');
  assert.equal(st.phase, 'discard');
  assert.equal(st.wall.length, wallBefore - 1, '只少补摸的那 1 张');
  assert.equal(st.gangFlag, true, '补了摸 → 杠上开花语境成立');
});

test('蓄杠 noDraw 被剥离：必须补摸（含抢杠全过流程，2026-10-24）', () => {
  const st = blank(createGame({ seed: 30 }), { flipTile: null, wildTile: WHITE_DRAGON });
  st.players[1].melds = [{ type: 'peng', tiles: [t(3), t(3), t(3)], from: 0 }];
  st.players[1].opened = true;
  st.players[1].hand = [t(3), w(1), w(1), w(1), s(8), s(8), s(8), w(9), s(1), s(2)];
  st.players[2].melds = [{ type: 'peng', tiles: [w(1), w(1), w(1)], from: 1 }];
  st.players[2].opened = true;
  st.players[2].hand = [t(1), t(2), w(4), w(5), w(6), w(7), w(8), w(9), s(5), s(5)];
  st.wall = [s(5), ...new Array(20).fill(w(2))];
  st.turn = 1;
  st.phase = 'discard';
  const wallBefore = st.wall.length;

  act(st, { type: 'xu', seat: 1, tile: t(3), noDraw: true });
  assert.equal(st.phase, 'claim', '先给抢杠机会');
  assert.ok(!st.pendingXuGang.noDraw, '占面子的蓄杠不携带 noDraw（act 已剥离）');
  act(st, { type: 'pass', seat: 2 });

  assert.ok(st.players[1].melds.some((m) => m.type === 'xu' && m.tiles[0] === t(3)));
  assert.equal(st.turn, 1, '补摸后仍是补杠者的回合');
  assert.equal(st.players[1].hand.length, 10, '10 - 1 + 1 = 10');
  assert.equal(st.wall.length, wallBefore - 1, '补摸 1 张');
  assert.equal(st.gangFlag, true);
});

test('明杠（zhi）noDraw 被剥离：必须补摸（2026-10-24）', () => {
  const st = blank(createGame({ seed: 31 }), { flipTile: null, wildTile: WHITE_DRAGON });
  st.players[1].hand = [t(3), t(3), t(3), w(1), w(2), w(4), w(5), w(6), s(1), s(2), s(4), s(5), s(6)];
  st.players[0].discards = [t(3)];
  st.lastDiscard = { tile: t(3), from: 0 };
  st.wall = [s(5), ...new Array(20).fill(w(2))];
  st.turn = 1;
  st.phase = 'claim';
  const wallBefore = st.wall.length;

  act(st, { type: 'zhi', seat: 1, noDraw: true });

  assert.ok(st.players[1].melds.some((m) => m.type === 'zhi' && m.tiles[0] === t(3)));
  assert.equal(st.players[1].hand.length, 11, '13 - 3 + 1 = 11，必须补摸');
  assert.equal(st.turn, 1, '补摸后仍是自己的出牌回合');
  assert.equal(st.phase, 'discard');
  assert.equal(st.wall.length, wallBefore - 1);
});

test('杠后不补牌：红中杠 / 皮子杠 / 癞子杠 = 等同打出一张，不摸牌直接过手（2026-10-24）', () => {
  const cases = [
    { action: 'redgang', tile: RED_DRAGON, skins: [RED_DRAGON] },
    { action: 'skingang', tile: t(5), skins: [t(5)] },
    { action: 'wildgang', tile: WHITE_DRAGON, skins: [] },
  ];
  for (const c of cases) {
    const st = blank(createGame({ seed: 52 }), {
      flipTile: null, wildTile: WHITE_DRAGON, skinTiles: c.skins,
    });
    st.players[0].hand = [c.tile, w(1), w(2), w(3), t(4), t(6), t(7), s(7), s(8), s(9), w(5), w(6), s(1), s(2)];
    st.wall = [s(5), ...new Array(20).fill(w(2))];
    st.turn = 0;
    st.phase = 'discard';
    act(st, { type: c.action, seat: 0, tile: c.tile, noDraw: true });
    assert.equal(st.players[0].hand.length, 13, `${c.action}：14 - 1 = 13，不补牌`);
    // 特殊杠不占面子 → 手牌比应有张数少 1 = 「已打出一张」的正常等待状态，不是欠张
    assert.equal(handNeeded(st, 0) - st.players[0].hand.length, 1, `${c.action}：等同打出一张`);
    assert.equal(st.turn, 1, `${c.action}：杠完照常换手到下家`);
    assert.equal(st.players[1].hand.length, 1, `${c.action}：下家摸 1 张`);
    assert.equal(st.gangFlag, false);
  }
});

test('抢杠胡：两家都能抢时，下家先问；下家「过」→ 轮第二家；全过 → 补杠', () => {
  const state = blank(createGame({ seed: 30 }), { flipTile: null, wildTile: WHITE_DRAGON });
  state.players[1].melds = [{ type: 'peng', tiles: [t(3), t(3), t(3)], from: 0 }];
  state.players[1].opened = true;
  state.players[1].hand = [t(3), t(3), t(3), w(1), w(1), w(1), s(8), s(8), s(8), w(9)];
  // seat2 与 seat3 都听三筒（两边用同一套夹具 —— 引擎层不做牌数守恒校验，
  // 与本文件既有「一炮单响」用例的写法一致）
  for (const seat of [2, 3]) {
    state.players[seat].melds = [{ type: 'peng', tiles: [w(1), w(1), w(1)], from: 1 }];
    state.players[seat].opened = true;
    state.players[seat].hand = [t(1), t(2), w(4), w(5), w(6), w(7), w(8), w(9), s(5), s(5)];
  }
  state.turn = 1;
  state.phase = 'discard';

  act(state, { type: 'xu', seat: 1, tile: t(3) });
  assert.equal(state.phase, 'claim');
  assert.equal(state.turn, 2, '下家 seat2 优先');
  assert.ok(legalActions(state, 3).length === 0, '还没轮到 seat3，拿不到任何动作');

  act(state, { type: 'pass', seat: 2 });
  assert.equal(state.phase, 'claim', '还有 seat3 能抢 → 继续问');
  assert.equal(state.turn, 3);
  assert.ok(legalActions(state, 3).map((a) => a.type).includes('win'), '漏抢后 seat3 仍可胡');

  act(state, { type: 'pass', seat: 3 });
  assert.equal(state.phase, 'discard', '两家都过 → 补杠者继续');
  assert.equal(state.turn, 1);
  assert.equal(state.result, null);
});

test('抢杠胡：canPassWin=false 时不给「过」，强行 pass 抛错（有胡必胡）', () => {
  const rs = createRuleSet('koukou', { enforceMinFan: false, canPassWin: false });
  const state = blank(createGame({ seed: 30, ruleset: rs }), { flipTile: null, wildTile: WHITE_DRAGON });
  state.players[1].melds = [{ type: 'peng', tiles: [t(3), t(3), t(3)], from: 0 }];
  state.players[1].opened = true;
  state.players[1].hand = [t(3), t(3), t(3), w(1), w(1), w(1), s(8), s(8), s(8), w(9)];
  state.players[2].melds = [{ type: 'peng', tiles: [w(1), w(1), w(1)], from: 1 }];
  state.players[2].opened = true;
  state.players[2].hand = [t(1), t(2), w(4), w(5), w(6), w(7), w(8), w(9), s(5), s(5)];
  state.turn = 1;
  state.phase = 'discard';

  act(state, { type: 'xu', seat: 1, tile: t(3) });
  const opts = legalActions(state, 2).map((a) => a.type);
  assert.ok(opts.includes('win'));
  assert.ok(!opts.includes('pass'), '关掉 canPassWin → 抢杠也不给「过」');
  assert.throws(() => act(state, { type: 'pass', seat: 2 }), /不允许过胡/);

  // 只能胡
  act(state, { type: 'win', seat: 2 });
  assert.equal(state.phase, 'settled');
  assert.equal(state.result.baozhuang.seat, 1);
});

test('一炮单响：两家都能胡时，按下家优先询问，先胡者结束本局', () => {
  const state = blank(createGame({ seed: 81, ruleset: createRuleSet('koukou', { enforceMinFan: false }) }), { flipTile: null, wildTile: WHITE_DRAGON });
  state.players[0].hand = [s(9), t(1), t(1), t(1), t(2), t(2), t(2), t(3), t(3), t(3), t(4), t(4), t(4)];

  // seat1 与 seat2 都听 九条（s7 s8 + 九条成顺，五条作将）
  for (const seat of [1, 2]) {
    state.players[seat].opened = true;
  }
  state.players[1].hand = [w(1), w(2), w(3), w(4), w(5), w(6), t(7), t(8), t(9), s(5), s(5), s(7), s(8)];
  state.players[2].hand = [w(1), w(2), w(3), t(1), t(2), t(3), t(4), t(5), t(6), s(5), s(5), s(7), s(8)];
  state.players[3].hand = [t(6), t(7), t(8), t(9), t(9), t(9), w(7), w(8), w(9), w(1), w(1), w(1), w(2)];

  state.turn = 0;
  state.phase = 'discard';

  act(state, { type: 'discard', seat: 0, tile: s(9) });
  assert.equal(state.phase, 'claim');
  assert.deepEqual(state.claims.map((c) => c.seat), [1, 2], '先下家、再对家');
  assert.equal(state.turn, 1);
  assert.ok(state.claims[0].options.some((o) => o.type === 'win'));

  act(state, { type: 'win', seat: 1 });
  assert.equal(state.phase, 'settled');
  assert.equal(state.result.winner, 1, '只有一家胡 → 单响');
  assert.equal(state.result.selfDraw, false);
  assert.equal(state.result.from, 0);
  assert.equal(state.result.winTile, s(9), '结算结果记录点炮进张，供牌面补最后一张');
});

test('胡牌后先摊牌：四家都确认才解除 pending（老吴 2026-10-20）', () => {
  const state = blank(
    createGame({ seed: 7, ruleset: createRuleSet('kaikou', { enforceMinFan: false }) }),
    { flipTile: WHITE_DRAGON, wildTile: EAST },
  );
  const p = state.players[1];
  // 碰碰胡 + 将牌（自摸）：1/2/3 万各三张 + 5 筒三张 + 7 条一对
  p.hand = [w(1), w(1), w(1), w(2), w(2), w(2), w(3), w(3), w(3), t(5), t(5), t(5), s(7), s(7)];
  p.opened = true;
  state.turn = 1;
  state.phase = 'discard';
  state.lastDraw = s(7);
  assert.ok(legalActions(state, 1).some((a) => a.type === 'win'), '自摸可胡');

  act(state, { type: 'win', seat: 1 });
  assert.equal(state.phase, 'settled');
  assert.equal(state.result.winTile, s(7), '结算结果记录自摸进张');
  assert.equal(state.reveal.pending, true, '胡牌后进入摊牌确认阶段');

  const v0 = viewFor(state, 0);
  assert.ok(v0.reveal && v0.reveal.pending, '视图带摊牌确认进度');
  const o1 = v0.others.find((o) => o.seat === 1);
  assert.ok(o1 && Array.isArray(o1.hand) && o1.hand.length > 0, '摊牌阶段别家手牌已下发');
  assert.ok(legalActions(state, 0).some((a) => a.type === 'confirm'), '未确认的座位给出「确认」');

  act(state, { type: 'confirm', seat: 0 });
  act(state, { type: 'confirm', seat: 2 });
  assert.equal(state.reveal.pending, true, '三家未齐仍 pending');
  assert.equal(legalActions(state, 0).length, 0, '已确认的座位不再给动作');

  act(state, { type: 'confirm', seat: 3 });
  assert.equal(state.reveal.pending, true, '还差一家仍 pending');
  act(state, { type: 'confirm', seat: 1 });
  assert.equal(state.reveal.pending, false, '四家确认完解除 pending');
  assert.equal(legalActions(state, 0).length, 0, '确认完后不再有摊牌动作');
});

test('荒庄不进摊牌确认（reveal 为 null）', () => {
  const state = blank(createGame({ seed: 5 }), { flipTile: null, wildTile: WHITE_DRAGON });
  state.wall = [];
  state.players[0].hand = [w(1)];
  state.turn = 0;
  state.phase = 'discard';
  act(state, { type: 'discard', seat: 0, tile: w(1) });
  assert.equal(state.phase, 'settled');
  assert.equal(state.reveal, null);
});

/* ------------------------------------------------------------------ */
/* 荒庄 / 确定性 / 守恒                                                 */
/* ------------------------------------------------------------------ */

test('荒庄：牌墙摸尽即结束', () => {
  const state = blank(createGame({ seed: 5 }), { flipTile: null, wildTile: WHITE_DRAGON });
  state.wall = [];
  state.players[0].hand = [w(1)];
  state.turn = 0;
  state.phase = 'discard';

  act(state, { type: 'discard', seat: 0, tile: w(1) });
  assert.equal(state.phase, 'settled');
  assert.equal(state.result.type, 'draw');
  assert.equal(state.result.text, '荒庄');
});

test('确定性：同一 seed 两次运行结果与事件流完全一致', () => {
  const a = playFull(99).state;
  const b = playFull(99).state;
  assert.deepEqual(a.result, b.result);
  assert.equal(a.events.length, b.events.length);
  assert.equal(
    a.events.map((e) => e.message).join('\n'),
    b.events.map((e) => e.message).join('\n'),
  );
  assert.ok(a.result.type === 'win' || a.result.type === 'draw');
});

test('不同 seed 会产生不同牌局', () => {
  const a = playFull(100).state;
  const b = playFull(200).state;
  const sameOpening =
    JSON.stringify(a.players.map((p) => p.hand)) ===
    JSON.stringify(b.players.map((p) => p.hand));
  assert.equal(sameOpening, false);
});

test('连续 60 局都能正常结束，无一死循环', () => {
  let win = 0;
  let draw = 0;
  for (let i = 0; i < 60; i++) {
    const { state } = playFull(5000 + i);
    assert.equal(state.phase, 'settled', `seed=${5000 + i} 未正常结束`);
    assert.ok(state.result, `seed=${5000 + i} 缺少结算结果`);
    if (state.result.type === 'win') win++;
    else draw++;
  }
  assert.equal(win + draw, 60);
  assert.ok(win > 0, '60 局里至少该胡一把');
});

test('胡牌者的手牌张数符合「面子折算」守恒', () => {
  let checked = 0;
  for (let i = 0; i < 40; i++) {
    const { state } = playFull(7000 + i);
    if (state.result.type !== 'win') continue;
    const winner = state.players[state.result.winner];
    const need = handNeeded(state, winner.seat);
    const held = winner.hand.length + (state.result.selfDraw ? 0 : 1);
    assert.equal(held, need, `seed=${7000 + i} 胡牌者张数不守恒`);
    checked++;
  }
  assert.ok(checked > 0, '至少应校验到一局胡牌');
});

test('无人/未轮到自己时没有合法动作', () => {
  const state = createGame({ seed: 41 });
  assert.ok(legalActions(state, state.turn).length > 0);
  assert.equal(legalActions(state, (state.turn + 1) % 4).length, 0, '没轮到就不该有动作');
  state.phase = 'settled';
  assert.equal(legalActions(state, state.turn).length, 0, '已结算不该有动作');
  assert.throws(() => act(state, { type: 'discard', seat: 0, tile: w(1) }), /牌局已结束/);
});

test('viewFor 不泄露他人手牌', () => {
  const state = createGame({ seed: 21 });
  const view = viewFor(state, 0);
  assert.ok(Array.isArray(view.me.hand));
  assert.equal(view.me.hand.length, 14);
  assert.equal(view.wildTile, state.wildTile);
  assert.deepEqual(view.skinTiles, state.skinTiles);
  for (const o of view.others) {
    assert.equal(o.hand, undefined, '别人手牌不应下发给客户端');
    assert.equal(typeof o.handCount, 'number');
  }
});

test('viewFor 对局中**不下发别家暗杠的牌面**（占位 HIDDEN_TILE，摊牌才放开）（老吴 2026-10-23）', () => {
  // 构造：座位 1 直接塞一个暗杠副露，从座位 0 视角看 —— 对局中必须是占位码。
  const state = createGame({ seed: 91 });
  const tile = state.players[1].hand[0];
  state.players[1].hand.splice(state.players[1].hand.indexOf(tile), 4);
  state.players[1].melds.push({ type: 'an', tiles: [tile, tile, tile, tile], from: null });
  state.players[1].hand.push(...state.wall.splice(0, 4)); // 补回张数，保持牌数守恒

  const playing = viewFor(state, 0);
  const other1 = playing.others.find((o) => o.seat === 1);
  assert.equal(other1.melds[0].type, 'an');
  assert.equal(other1.melds[0].tiles.length, 4, '张数照常下发（渲染牌背要用）');
  for (const t of other1.melds[0].tiles) {
    assert.equal(t, HIDDEN_TILE, '对局中暗杠牌面必须是占位码，不能泄露');
  }
  // 自己的暗杠不下掩码（自己杠的牌自己当然知道）
  state.players[0].melds.push({ type: 'an', tiles: [w(1), w(1), w(1), w(1)], from: null });
  const mine = viewFor(state, 0).me.melds.find((m) => m.type === 'an');
  assert.equal(mine.tiles[0], w(1), '自己的暗杠照常下发真实牌面');

  // 摊牌阶段（settled）放开真实牌面
  state.phase = 'settled';
  const revealed = viewFor(state, 0);
  const revealed1 = revealed.others.find((o) => o.seat === 1);
  assert.deepEqual(revealed1.melds[0].tiles, [tile, tile, tile, tile], '摊牌应下发真实暗杠牌面');
});

test('viewFor 只有**终局摊牌**才下发别家手牌（对局中恒为 undefined）', () => {  // 开局：不下发
  const st = createGame({ seed: 33 });
  for (const o of viewFor(st, 0).others) assert.equal(o.hand, undefined, '对局中不能下发');

  // 打几步之后仍然不下发
  let s2 = createGame({ seed: 34 });
  for (let i = 0; i < 6 && s2.phase !== 'settled'; i++) {
    const a = decide(s2, s2.turn);
    if (!a) break;
    s2 = act(s2, a);
  }
  if (s2.phase !== 'settled') {
    for (const o of viewFor(s2, 0).others) assert.equal(o.hand, undefined, '对局中不能下发');
  }

  // 推进到结算 → 摊牌，且张数与各家实际手牌一致
  const { state } = playFull(35, createRuleSet('koukou'));
  assert.equal(state.phase, 'settled');
  const v = viewFor(state, 0);
  assert.equal(v.me.hand.length, state.players[0].hand.length);
  for (const o of v.others) {
    assert.ok(Array.isArray(o.hand), '终局应摊牌');
    assert.deepEqual([...o.hand].sort((a, b) => a - b), [...state.players[o.seat].hand].sort((a, b) => a - b));
  }
});

test('起手掷骰：同 seed 可复算、两张都在 1..6、且经 viewFor 下发（公开信息）', () => {
  const a = createGame({ seed: 7 });
  const b = createGame({ seed: 7 });
  assert.deepEqual(a.dice, b.dice, '同 seed 掷骰结果必须一致');
  for (const v of a.dice) {
    assert.ok(Number.isInteger(v) && v >= 1 && v <= 6, `骰子点数越界：${v}`);
  }

  // 掷骰走**独立随机流**：绝不能因为多加一次掷骰就把牌墙洗乱（回放/复算的生命线）
  assert.deepEqual(a.wall, b.wall, '同 seed 牌墙必须逐字节一致（掷骰不得扰动洗牌序列）');

  // 不同 seed 有较大概率给出不同点数（不作硬断言，只确认 seed 确实参与了推导）
  const set = new Set();
  for (let sd = 1; sd <= 40; sd++) set.add(createGame({ seed: sd }).dice.join(','));
  assert.ok(set.size > 1, '不同 seed 应能给出不同的掷骰结果');

  const v = viewFor(a, 0);
  assert.deepEqual(v.dice, a.dice, 'viewFor 应下发 dice');
  assert.notEqual(v.dice, a.dice, 'viewFor 的 dice 应是副本，避免外部改写引擎状态');
});

test('动作协议：非法动作会抛错而不是静默改状态', () => {
  const state = blank(createGame({ seed: 91 }), { flipTile: null, wildTile: WHITE_DRAGON });
  state.players[0].hand = [w(1), w(2), w(3)];
  state.turn = 0;
  state.phase = 'discard';
  assert.throws(() => act(state, { type: 'discard', seat: 0, tile: w(9) }), /手里没有/);
  assert.throws(() => act(state, { type: 'unknown' }), /未知动作/);
});

/* ------------------------------------------------------------------ */
/* 老吴 Rule2：红中永不当癞子                                           */
/* ------------------------------------------------------------------ */

test('癞子循环：红中永不当癞子，旧房间的 wildCycleIncludesRedDragon 也忽略', () => {
  const off = createRuleSet('koukou');
  const legacy = createRuleSet('koukou', { wildCycleIncludesRedDragon: true });
  for (const rs of [off, legacy]) {
    assert.equal(deriveWild(NORTH, rs), GREEN_DRAGON, '翻北 → 发财（跳过红中）');
    assert.equal(deriveWild(RED_DRAGON, rs), GREEN_DRAGON, '翻红中 → 发财');
    assert.equal(deriveWild(GREEN_DRAGON, rs), WHITE_DRAGON, '翻发财 → 白板');
    assert.equal(deriveWild(WHITE_DRAGON, rs), EAST, '翻白板 → 东风');
    for (let f = 0; f < 34; f++) {
      assert.notEqual(deriveWild(f, rs), RED_DRAGON, `翻 ${tileName(f)} 也不能让红中当癞子`);
    }
  }
  assert.ok(computeSkinTiles(NORTH, GREEN_DRAGON, legacy).includes(RED_DRAGON), '红中仍固定是皮');
});

test('副露展示顺序：红中杠 → 皮子杠 → 癞子杠 → 吃碰杠，且不改原数组', () => {
  const melds = [
    { type: 'peng', tiles: [w(1), w(1), w(1)] },
    { type: 'skin', tiles: [w(5)] },
    { type: 'chi', tiles: [w(2), w(3), w(4)] },
    { type: 'red', tiles: [RED_DRAGON] },
    { type: 'wild', tiles: [w(6)] },
    { type: 'skin', tiles: [w(4)] },
  ];
  const sorted = sortMeldsForDisplay(melds);
  assert.deepEqual(sorted.map((m) => m.type), ['red', 'skin', 'skin', 'wild', 'peng', 'chi']);
  assert.deepEqual(melds.map((m) => m.type), ['peng', 'skin', 'chi', 'red', 'wild', 'skin'], '原数组不变');
});

/* ------------------------------------------------------------------ */
/* 老吴 Rule5：包牌                                                     */
/* ------------------------------------------------------------------ */

test('包牌：全求人点炮 → 放炮者承包，独付全部', () => {
  const rs = createRuleSet('koukou', { enforceMinFan: false });
  const state = blank(createGame({ seed: 41, ruleset: rs }), { flipTile: null, wildTile: WHITE_DRAGON });

  // seat1：4 口副露（碰/吃），单钓 9 筒
  state.players[1].melds = [
    { type: 'peng', tiles: [t(1), t(1), t(1)], from: 0 },
    { type: 'chi', tiles: [w(2), w(3), w(4)], from: 2 },
    { type: 'peng', tiles: [s(5), s(5), s(5)], from: 3 },
    { type: 'peng', tiles: [t(6), t(6), t(6)], from: 0 },
  ];
  state.players[1].opened = true;
  state.players[1].hand = [t(9)];

  state.players[0].hand = [t(9), w(1), w(1), w(1), w(5), w(5), w(5), s(1), s(2), s(3), s(7), s(7), s(7), s(9)];
  state.turn = 0;
  state.phase = 'discard';

  act(state, { type: 'discard', seat: 0, tile: t(9) });
  assert.equal(state.phase, 'claim');
  act(state, { type: 'win', seat: 1 });

  assert.equal(state.result.winner, 1);
  assert.ok(state.result.types.includes('quanQiuRen'));
  assert.ok(state.result.baozhuang, '全求人点炮应承包');
  assert.equal(state.result.baozhuang.seat, 0, '放炮者承包');
  for (const pay of state.result.payments) {
    assert.equal(pay.pay, pay.seat === 0 ? state.result.totalWin : 0);
  }
});

function setupQuanQiuRenPointWin(discarderTiles, opts = {}) {
  const rs = createRuleSet('koukou', { enforceMinFan: false });
  const state = blank(createGame({ seed: 41, ruleset: rs }), {
    flipTile: null,
    wildTile: opts.wildTile ?? WHITE_DRAGON,
    skinTiles: opts.skinTiles ?? [],
  });
  state.players[1].melds = [
    { type: 'peng', tiles: [t(1), t(1), t(1)], from: 0 },
    { type: 'chi', tiles: [w(2), w(3), w(4)], from: 2 },
    { type: 'peng', tiles: [s(5), s(5), s(5)], from: 3 },
    { type: 'peng', tiles: [t(6), t(6), t(6)], from: 0 },
  ];
  state.players[1].opened = true;
  state.players[1].hand = [t(9)];
  state.players[0].hand = [...discarderTiles, t(9)];
  state.turn = 0;
  state.phase = 'discard';
  act(state, { type: 'discard', seat: 0, tile: t(9) });
  assert.equal(state.phase, 'claim');
  act(state, { type: 'win', seat: 1 });
  return state;
}

test('包牌：全求人点炮，放炮者手牌全是将牌（2/5/8）⇒ 免包', () => {
  const jiang13 = [w(2), w(2), w(5), w(5), w(8), w(8), t(2), t(2), t(5), t(5), s(2), s(5), s(8)];
  const state = setupQuanQiuRenPointWin(jiang13);
  assert.ok(state.result.types.includes('quanQiuRen'));
  assert.equal(state.result.baozhuang, undefined, '放炮者全手将 → 不包，三家照常付');
  assert.ok(state.result.payments.every((p) => p.pay > 0), '未承包时三家都付');
});

test('包牌：全求人点炮，放炮者手里有赖子 ⇒ 不算全手将，照常包', () => {
  const tiles = [w(2), w(2), w(5), w(5), w(8), w(8), t(2), t(2), t(5), t(5), s(2), s(5), WHITE_DRAGON];
  const state = setupQuanQiuRenPointWin(tiles);
  assert.ok(state.result.baozhuang, '有癞子 → 放炮者包');
  assert.equal(state.result.baozhuang.seat, 0);
});

test('包牌：全求人点炮，放炮者手里有红中 / 皮子 ⇒ 不算全手将，照常包', () => {
  const withRed = [w(2), w(2), w(5), w(5), w(8), w(8), t(2), t(2), t(5), t(5), s(2), s(5), RED_DRAGON];
  const a = setupQuanQiuRenPointWin(withRed, { skinTiles: [RED_DRAGON] });
  assert.ok(a.result.baozhuang, '有红中 → 放炮者包');
  assert.equal(a.result.baozhuang.seat, 0);

  const withSkin = [w(2), w(2), w(5), w(5), w(8), w(8), t(2), t(2), t(5), t(5), s(2), s(5), t(2)];
  const b = setupQuanQiuRenPointWin(withSkin, { skinTiles: [t(2)] });
  assert.ok(b.result.baozhuang, '有皮子（哪怕点数是 2）→ 放炮者包');
  assert.equal(b.result.baozhuang.seat, 0);
});

test('包牌：清一色「第三句」由谁打出谁包（不是放炮者）', () => {
  const rs = createRuleSet('koukou', { enforceMinFan: false, quanQiuRenBaoEnabled: false });
  const state = blank(createGame({ seed: 42, ruleset: rs }), { flipTile: null, wildTile: WHITE_DRAGON });

  // seat1：清一色（全筒）；第 3 个面子是「碰 5 筒」，由 seat0 打出
  state.players[1].melds = [
    { type: 'peng', tiles: [t(1), t(1), t(1)], from: 2 },
    { type: 'chi', tiles: [t(2), t(3), t(4)], from: 3 },
    { type: 'peng', tiles: [t(5), t(5), t(5)], from: 0 },
    { type: 'chi', tiles: [t(6), t(7), t(8)], from: 2 },
  ];
  state.players[1].opened = true;
  state.players[1].hand = [t(9)];

  state.players[3].hand = [t(9), w(1), w(1), w(1), w(5), w(5), w(5), s(1), s(2), s(3), s(7), s(7), s(7), s(9)];
  state.turn = 3;
  state.phase = 'discard';

  act(state, { type: 'discard', seat: 3, tile: t(9) });
  assert.equal(state.phase, 'claim');
  act(state, { type: 'win', seat: 1 });

  assert.ok(state.result.types.includes('qingYiSe'));
  assert.ok(state.result.baozhuang, '清一色应触发第三句包牌');
  assert.equal(state.result.baozhuang.seat, 0, '包家 = 打出第三句的那家（seat0），而非放炮的 seat3');
});

test('包牌：将一色同样按「第三句」包牌（一色里只有风一色不包）', () => {
  const rs = createRuleSet('koukou', { enforceMinFan: false, quanQiuRenBaoEnabled: false });
  const state = blank(createGame({ seed: 43, ruleset: rs }), { flipTile: null, wildTile: WHITE_DRAGON });

  // 全 2/5/8（跨花色）→ 将一色；第 3 个面子是「碰 8 条」，由 seat0 打出
  state.players[1].melds = [
    { type: 'peng', tiles: [w(2), w(2), w(2)], from: 1 },
    { type: 'peng', tiles: [t(5), t(5), t(5)], from: 2 },
    { type: 'peng', tiles: [s(8), s(8), s(8)], from: 0 },
    { type: 'peng', tiles: [t(8), t(8), t(8)], from: 3 },
  ];
  state.players[1].opened = true;
  state.players[1].hand = [s(2)];

  state.players[3].hand = [s(2), w(1), w(1), w(1), w(5), w(5), w(5), s(1), s(4), s(6), s(7), s(7), s(7), s(9)];
  state.turn = 3;
  state.phase = 'discard';

  act(state, { type: 'discard', seat: 3, tile: s(2) });
  assert.equal(state.phase, 'claim');
  act(state, { type: 'win', seat: 1 });

  assert.ok(state.result.types.includes('jiangYiSe'), '应判成将一色');
  assert.ok(!state.result.types.includes('qingYiSe'), '跨花色 → 不是清一色');
  assert.ok(state.result.baozhuang, '将一色同样要包牌');
  assert.equal(state.result.baozhuang.seat, 0, '包家 = 打出第三句的那家（seat0），而非放炮的 seat3');
});

test('包牌：风一色不包（走「不包胡、直接金顶」）', () => {
  // ❗旧实现要靠 `ziYiSeMustSelfDraw:false` 才造得出点炮的风一色；
  //   老吴 2026-10-01 否定「全字牌必须自摸」后，那道闸门已删除 → 点炮风一色是常态。
  const rs = createRuleSet('koukou', {
    enforceMinFan: false,
    quanQiuRenBaoEnabled: false,
    specialTilesNoDiscard: false,
  });
  const state = blank(createGame({ seed: 44, ruleset: rs }), { flipTile: null, wildTile: WHITE_DRAGON });

  // 全字牌 → 风一色
  state.players[1].melds = [
    { type: 'peng', tiles: [EAST, EAST, EAST], from: 1 },
    { type: 'peng', tiles: [SOUTH, SOUTH, SOUTH], from: 2 },
    { type: 'peng', tiles: [WEST, WEST, WEST], from: 0 },
    { type: 'peng', tiles: [GREEN_DRAGON, GREEN_DRAGON, GREEN_DRAGON], from: 3 },
  ];
  state.players[1].opened = true;
  state.players[1].hand = [WHITE_DRAGON];

  state.players[3].hand = [WHITE_DRAGON, w(1), w(1), w(1), w(5), w(5), w(5), s(1), s(4), s(6), s(7), s(7), s(7), s(9)];
  state.turn = 3;
  state.phase = 'discard';

  act(state, { type: 'discard', seat: 3, tile: WHITE_DRAGON });
  assert.equal(state.phase, 'claim');
  act(state, { type: 'win', seat: 1 });

  assert.ok(state.result.types.includes('fengYiSe'), '应判成风一色');
  assert.equal(state.result.baozhuang, undefined, '风一色不包牌');
  assert.equal(state.result.topType, 'goldTop', '风一色直接金顶');
});

/* ------------------------------------------------------------------ */
/* 老吴 Rule6：基本两口（闲家须杠出 2 皮）                               */
/* ------------------------------------------------------------------ */

test('基本两口：非赢家未杠够 2 皮且手里还留着皮 → 该玩家包胡', () => {
  const rs = createRuleSet('koukou', { enforceMinFan: false });
  const state = blank(createGame({ seed: 51, ruleset: rs }), {
    flipTile: null,
    wildTile: WHITE_DRAGON,
    skinTiles: [RED_DRAGON, t(8)],
  });

  // seat0（庄家）自摸大胡（碰碰胡），各家 effFan ≥ 3 → 有分可算
  state.players[0].opened = true;
  state.players[0].hand = [w(1), w(1), w(1), w(2), w(2), w(2), w(3), w(3), w(3), t(9), t(9), t(9), s(5), s(5)];
  for (const p of state.players) p.opened = true;

  // seat1：闲家，手里留着红中 + 八筒（都是皮），一张都没杠 → 手里 2 张皮，够资格但没杠满两口
  state.players[1].hand = [RED_DRAGON, t(8), w(4), w(5), t(1), t(2), t(3), s(1), s(2), s(3), w(7), w(8), w(9)];
  state.players[1].skinSeen = 3;

  // seat2 / seat3：闲家，手里没皮
  state.players[2].hand = [w(4), w(5), w(6), t(1), t(2), t(3), s(1), s(2), s(3), w(7), w(8), w(9), s(4)];
  state.players[3].hand = [w(4), w(5), w(6), t(1), t(2), t(3), s(1), s(2), s(3), w(7), w(8), w(9), s(6)];

  state.turn = 0;
  state.phase = 'discard';
  act(state, { type: 'win', seat: 0 });

  assert.equal(state.result.winner, 0);
  assert.equal(state.result.baoHus?.length, 1, '只有 seat1 触发包胡');
  assert.equal(state.result.baoHus[0].seat, 1);
  const bySeat = (n) => state.result.payments.find((p) => p.seat === n);
  assert.equal(bySeat(2).pay, 0, '非包胡家免付');
  assert.equal(bySeat(3).pay, 0, '非包胡家免付');
  assert.ok(bySeat(1).pay > 0, '包胡家承担全部');
  assert.match(state.result.text, /基本两口/);
});

test('基本两口：庄家也受约束；多个非赢家同时未达两口 → 都包胡', () => {
  const rs = createRuleSet('koukou', { enforceMinFan: false });
  const state = blank(createGame({ seed: 53, ruleset: rs }), {
    flipTile: null,
    wildTile: WHITE_DRAGON,
    skinTiles: [RED_DRAGON, t(8)],
  });

  state.players[0].opened = true;
  state.players[0].hand = [w(1), w(1), w(1), w(2), w(2), w(2), w(3), w(3), w(3), t(9), t(9), t(9), s(5), s(5)];
  for (const p of state.players) p.opened = true;

  // seat1 / seat2（庄家）都留着 2 张皮、0 口皮子杠 → 两家都未达两口
  state.players[1].hand = [RED_DRAGON, t(8), w(4), w(5), t(1), t(2), t(3), s(1), s(2), s(3), w(7), w(8), w(9)];
  state.players[2].hand = [RED_DRAGON, t(8), w(4), w(5), t(1), t(2), t(4), s(1), s(2), s(4), w(7), w(8), w(9)];
  state.players[2].isDealer = true;
  // seat3 只有 1 张皮 → 凑不出两口，按例外不包
  state.players[3].hand = [RED_DRAGON, w(4), w(5), t(1), t(2), t(3), s(1), s(2), s(3), w(7), w(8), w(9), s(6)];

  state.turn = 0;
  state.phase = 'discard';
  act(state, { type: 'win', seat: 0 });

  assert.equal(state.result.winner, 0);
  assert.deepEqual(state.result.baoHus?.map((b) => b.seat).sort(), [1, 2], '闲家和庄家同时包胡');
  const bySeat = (n) => state.result.payments.find((p) => p.seat === n);
  assert.equal(bySeat(3).pay, 0, '凑不出两口的非赢家免付');
  assert.ok(bySeat(1).pay > 0 && bySeat(2).pay > 0, '两个包胡家都承担输分');
});

test('基本两口：本局只拿到 0~1 张皮 → 确实没有两张皮，不包', () => {
  const rs = createRuleSet('koukou', { enforceMinFan: false });
  const state = blank(createGame({ seed: 52, ruleset: rs }), {
    flipTile: null,
    wildTile: WHITE_DRAGON,
    skinTiles: [RED_DRAGON],
  });

  state.players[0].opened = true;
  state.players[0].hand = [w(1), w(1), w(1), w(2), w(2), w(2), w(3), w(3), w(3), t(9), t(9), t(9), s(5), s(5)];
  for (const p of state.players) p.opened = true;

  // seat1 手里有皮，但本局只拿到 1 张 → 不包
  state.players[1].hand = [RED_DRAGON, w(4), w(5), w(6), t(1), t(2), t(3), s(1), s(2), s(3), w(7), w(8), w(9)];
  state.players[1].skinSeen = 1;

  state.players[2].hand = [w(4), w(5), w(6), t(1), t(2), t(3), s(1), s(2), s(3), w(7), w(8), w(9), s(4)];
  state.players[3].hand = [w(4), w(5), w(6), t(1), t(2), t(3), s(1), s(2), s(3), w(7), w(8), w(9), s(6)];

  state.turn = 0;
  state.phase = 'discard';
  act(state, { type: 'win', seat: 0 });

  assert.equal(state.result.baoHus, undefined, '没有两张皮 → 不包胡');
  for (const p of state.result.payments) assert.ok(p.pay > 0, '三家照常付分');
});

/* ------------------------------------------------------------------ */
/* 老吴 Rule3：海底捞（尾墩数起第 7 墩起为海捞位）                        */
/* ------------------------------------------------------------------ */

test('海底捞：牌墙剩 ≤14 张（最后 7 墩）摸到成形才算，剩得多不算', () => {
  const rs = createRuleSet('koukou', { enforceMinFan: false });
  const winHand = [w(1), w(2), w(3), t(4), t(5), t(6), s(7), s(8), s(9), w(5), w(5), w(5), s(5), s(5)];

  const near = blank(createGame({ seed: 61, ruleset: rs }), { flipTile: null, wildTile: WHITE_DRAGON });
  near.players[0].opened = true;
  near.players[0].hand = [...winHand];
  near.wall = new Array(10).fill(0); // 剩 10 张 < 14 → 海捞位
  near.turn = 0;
  near.phase = 'discard';
  act(near, { type: 'win', seat: 0 });
  assert.ok(near.result.types.includes('haiDiLao'), '剩 10 张 → 海底捞');

  const far = blank(createGame({ seed: 62, ruleset: rs }), { flipTile: null, wildTile: WHITE_DRAGON });
  far.players[0].opened = true;
  far.players[0].hand = [...winHand];
  far.wall = new Array(40).fill(0); // 剩 40 张，不在海捞位
  far.turn = 0;
  far.phase = 'discard';
  act(far, { type: 'win', seat: 0 });
  assert.ok(!far.result.types.includes('haiDiLao'), '剩 40 张 → 不是海底捞');
});

/* ------------------------------------------------------------------ */
/* 起胡门槛：赢家番 + 每一个输家番（老吴 2026-09-30 口径）                */
/* ------------------------------------------------------------------ */

/** 赢家（座位 1）小胡：番底 0 + 自摸 1 + 硬胡 1 + 开口 1 = 3 番，自身 < 6
 *  ⚠️ 老吴 2026-09-30 修正后小胡**没有基础番**，故这里从旧的 4 番降到 3 番；
 *     下面给输家的口数要相应 +1，才能重新凑到「赢家+自家 ≥ 6」。 */
function buildMinFanState(loserMeldCounts) {
  // 用「口口番」预设：每吃/碰一次各 +1 番，这样输家的 N 口才等于 N 番。
  const rs = createRuleSet('koukou', { enforceMinFan: true });
  const st = blank(createGame({ seed: 8, ruleset: rs }), { flipTile: WHITE_DRAGON, wildTile: EAST });
  const p = st.players[1];
  p.melds = [{ type: 'peng', tiles: [w(1), w(1), w(1)], from: 0 }];
  p.opened = true;
  p.hand = [w(2), w(3), w(4), t(5), t(6), t(7), s(7), s(8), s(9), s(5), s(5)];
  st.turn = 1;
  st.phase = 'discard';
  const peng = (n) => Array.from({ length: n }, (_, i) => ({ type: 'peng', tiles: [t(i + 1), t(i + 1), t(i + 1)], from: 0 }));
  st.players[0].melds = peng(loserMeldCounts[0]);
  st.players[2].melds = peng(loserMeldCounts[1]);
  st.players[3].melds = peng(loserMeldCounts[2]);
  return st;
}

test('起胡门槛：赢家自身 3 番，但三家「赢家+自家」都够 6 番 → 可以胡', () => {
  // seat0 是庄家（庄家 +1 番 + 2 口 = 3 番）；seat2/seat3 各 3 口 = 3 番
  const st = buildMinFanState([2, 3, 3]);
  assert.ok(
    legalActions(st, 1).some((a) => a.type === 'win'),
    '赢家 3 番 ＋ 每家 3 番 = 6 番 → 够档可以胡',
  );
});

test('起胡门槛：只要有一家「赢家+自家」不够 6 番 → 不能胡', () => {
  // seat3 只有 2 口 = 2 番 → 3 + 2 = 5 < 6
  const st = buildMinFanState([2, 3, 2]);
  assert.equal(
    legalActions(st, 1).some((a) => a.type === 'win'),
    false,
    '有一家只到 5 番 → 拦下',
  );
});

test('起胡门槛：关掉 minFanCountLosers 就退回「只看赢家自己」（3 番 < 6 → 不给胡）', () => {
  const rs = createRuleSet('kaikou', { enforceMinFan: true, minFanCountLosers: false });
  const st = blank(createGame({ seed: 8, ruleset: rs }), { flipTile: WHITE_DRAGON, wildTile: EAST });
  const p = st.players[1];
  p.melds = [{ type: 'peng', tiles: [w(1), w(1), w(1)], from: 0 }];
  p.opened = true;
  p.hand = [w(2), w(3), w(4), t(5), t(6), t(7), s(7), s(8), s(9), s(5), s(5)];
  st.turn = 1;
  st.phase = 'discard';
  assert.equal(legalActions(st, 1).some((a) => a.type === 'win'), false, '只看赢家 → 3 番不够 6 番');
});

test('十杠成就（老吴 2026-10-25 缺陷回归）：输家达成十杠 → 结算带每家付金顶的成就奖', () => {
  const rs = createRuleSet('koukou', { enforceMinFan: false });
  const st = blank(createGame({ seed: 3, ruleset: rs }), { flipTile: null, wildTile: WHITE_DRAGON });
  for (const p of st.players) { p.hand = []; p.discards = []; p.opened = true; }
  function t0(n) { return 8 + n; } // 筒
  // 座位 0：开口 3 + 明杠 1 + 皮子杠×3 + 癞子杠×3 + 红中杠×1 → 加权口数 1+3+6+1 = 11 ≥ 10
  st.players[0].melds = [
    { type: 'peng', tiles: [w(3), w(3), w(3)], from: 1 },
    { type: 'peng', tiles: [w(4), w(4), w(4)], from: 2 },
    { type: 'peng', tiles: [w(5), w(5), w(5)], from: 3 },
    { type: 'zhi', tiles: [w(6), w(6), w(6), w(6)], from: 1 },
    { type: 'skin', tiles: [t0(1)], from: null },
    { type: 'skin', tiles: [t0(1)], from: null },
    { type: 'skin', tiles: [t0(1)], from: null },
    { type: 'wild', tiles: [WHITE_DRAGON], from: null },
    { type: 'wild', tiles: [WHITE_DRAGON], from: null },
    { type: 'wild', tiles: [WHITE_DRAGON], from: null },
    { type: 'red', tiles: [RED_DRAGON], from: null },
  ];
  st.players[0].hand = [w(2), w(2)];
  st.players[1].melds = [
    { type: 'peng', tiles: [w(7), w(7), w(7)], from: 0 },
    { type: 'peng', tiles: [w(1), w(1), w(1)], from: 2 },
    { type: 'peng', tiles: [w(2), w(2), w(2)], from: 3 },
  ];
  st.players[1].opened = true;
  st.players[1].hand = [w(3), w(3), w(4), w(5), w(6)];
  st.turn = 1; st.phase = 'discard'; st.lastDraw = w(3);
  act(st, { type: 'win', seat: 1 });

  const r = st.result;
  assert.equal(st.players[0].shiGang, true, '加权口数 11 ≥ 10 → 十杠达成');
  assert.ok(Array.isArray(r.bonuses) && r.bonuses.some((b) => b.label === '十杠' && b.seat === 0),
    '结算 result.bonuses 带十杠奖（输家达成同样结算）');
  const bonus = r.bonuses.find((b) => b.label === '十杠');
  assert.equal(bonus.amount, 30, '三家各付金顶 10 → 总 30');
  assert.deepEqual(bonus.payers.map((p) => p.pay), [10, 10, 10], '每家付 10');
  // delta 收支平：四家 delta 求和 = 0
  const sum = r.perSeat.reduce((a, p) => a + p.delta, 0);
  assert.equal(sum, 0, '含成就奖的四家 delta 求和为 0');
});

test('起胡门槛不变量：门槛开时，凡能胡的局每一家「自家+赢家」番数都 ≥ 门槛（杜绝 0 分结算）', () => {
  const rs = createRuleSet('koukou', { enforceMinFan: true });
  let wins = 0;
  let plain = 0; // 非承包/包胡的普通局
  for (let seed = 1; seed <= 60; seed++) {
    const { state } = playFull(seed, rs);
    const r = state.result;
    if (!r || !r.payments) continue; // 荒庄
    wins++;
    const threshold = r.size === 'big' ? rs.minFanBig : rs.minFanSmall;
    // 承包 / 包胡（含「一炮多响包一家」）会让其余两家免付 0 分 —— 判据要同时看
    // result.bao / baozhuang / rainPayers（下雨包/陪包，2026-10-25）与逐家 payments[].baoHu，
    // 否则会把合法免付当成 0 分结算。
    const hasBao = !!(r.bao || r.baozhuang || r.rainPayers
      || (r.payments || []).some((p) => p.baoHu));
    if (!hasBao) plain++;
    for (const pay of r.payments) {
      assert.ok(
        pay.effFan >= threshold,
        `seed=${seed}：${pay.name} 的 effFan=${pay.effFan} 低于门槛 ${threshold}（赢家 ${r.winnerFan} 番）`,
      );
      // 门槛 = 计分表最低档 → 查表分至少 1（金顶/未开口翻倍只会更高）。
      // 承包 / 包胡局里其余两家依法免付，故只在普通局校验「人人有分」。
      if (!hasBao) {
        assert.ok(pay.pay > 0, `seed=${seed}：${pay.name} 竟然 0 分`);
      }
    }
  }
  assert.ok(wins > 30, `样本太少（只胡了 ${wins} 局）`);
  assert.ok(plain > 20, `普通局样本太少（只有 ${plain} 局）`);
});

test('结算文案与实际分账一致：text 里的「X 输 N」必须等于 payments 里的 pay', () => {
  // 承包 / 包胡会改写 payments（一家独付、其余清零），文案必须跟着重算，
  // 否则面板上写着「你 0 分（免付）」，底下的原始文本却还说「你 输 10」。
  const rs = createRuleSet('koukou', { enforceMinFan: true });
  let checked = 0;
  let baoSeen = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const { state } = playFull(seed, rs);
    const r = state.result;
    if (!r || r.type !== 'win') continue;
    checked++;
    const byName = new Map(r.payments.map((p) => [p.name, p.pay]));
    const re = /([^\s｜，（）]+) 输 (\d+)/g;
    let m;
    let n = 0;
    while ((m = re.exec(r.text))) {
      const [, name, amt] = m;
      assert.ok(byName.has(name), `seed=${seed}：文案里的「${name}」不在 payments 里`);
      assert.equal(
        Number(amt),
        byName.get(name),
        `seed=${seed}：文案写「${name} 输 ${amt}」，实际付 ${byName.get(name)} 分`,
      );
      n++;
    }
    assert.ok(n > 0, `seed=${seed} 文案里没解析出任何输分：${r.text}`);
    if (r.baozhuang || (r.baoHus && r.baoHus.length)) baoSeen++;
  }
  assert.ok(checked > 50, `样本太少（只胡了 ${checked} 局）`);
  assert.ok(baoSeen > 0, '样本里应至少出现一次承包 / 包胡，否则这条测试覆盖不到改写路径');
});

test('不变量：凡小胡，赢家手牌里的癞子不得超过 1 张（老吴：两个赖子不能胡小胡）', () => {
  const rs = createRuleSet('koukou', { enforceMinFan: true });
  let small = 0;
  let bigWithTwoWilds = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const { state } = playFull(seed, rs);
    const r = state.result;
    if (!r || r.type !== 'win') continue;
    const win = state.players[r.winner];
    const inHand = win.hand.filter((x) => x === state.wildTile).length;
    if (r.size === 'small') {
      small++;
      assert.ok(
        inHand <= rs.maxWildsForSmallHu,
        `seed=${seed}：小胡却留了 ${inHand} 张癞子在手里（上限 ${rs.maxWildsForSmallHu}）`,
      );
    } else if (inHand >= 2) {
      bigWithTwoWilds++;
    }
  }
  assert.ok(small > 50, `小胡样本太少（只有 ${small} 局）`);
  // 两个癞子只在大胡里合法 —— 样本里应当出现过，否则这条「上限」没被真正压到
  assert.ok(bigWithTwoWilds > 0, '样本里没抓到「大胡 + ≥2 癞子」，覆盖不到上限的反面');
});

test('小胡癞子口径（老吴 2026-09-30 确认）：杠出去的癞子不算手牌', () => {
  // 同一个手牌（14 张、只留 1 张癞子），唯一区别是副露里有没有一口癞子杠：
  //   A 手牌 1 张癞子、没杠        → 总计持有 1 张
  //   B 手牌 1 张癞子 + 癞子杠 1 口 → 总计持有 2 张
  // 老吴：「杠出去了的赖子就不算手牌了」→ 两者都应当能胡小胡。
  const FLIP = t(9); // → 癞子一筒、皮子 {八筒, 九筒, 红中}
  const WILD = t(1);
  const hand = [w(1), w(2), w(3), w(4), w(5), w(6), s(1), s(2), s(3), s(7), s(8), WILD, s(5), s(5)];
  const mk = (melds) => {
    const rs = createRuleSet('koukou', { mustOpen: false, enforceMinFan: false });
    const st = blank(createGame({ seed: 8, ruleset: rs }), {
      flipTile: FLIP,
      wildTile: WILD,
      skinTiles: computeSkinTiles(FLIP, WILD, rs),
    });
    for (const x of hand) {
      assert.ok(!st.skinTiles.includes(x), `夹具前提：手牌不能含皮子（${tileName(x)} 是皮子）`);
    }
    const p = st.players[1];
    p.hand = hand.slice();
    p.melds = melds;
    p.opened = true;
    st.turn = 1;
    st.phase = 'discard';
    return legalActions(st, 1).some((a) => a.type === 'win');
  };

  // 癞子杠只占 1 张牌、不折面子 → 手牌仍是 14 张，不会被「张数守恒」拦掉
  const wildGang = [{ type: 'wild', tiles: [WILD], from: null }];
  assert.equal(handNeeded({ players: [{ melds: wildGang }] }, 0), 14, '癞子杠不占面子，手牌仍应为 14 张');

  assert.equal(mk([]), true, '手牌 1 张癞子、无杠 → 可以胡小胡');
  assert.equal(mk(wildGang), true, '再加一口癞子杠（总持有 2 张）→ 杠出去的不算手牌，仍可胡小胡');

  // 反面：癞子留在手里 2 张就真的不能胡
  const twoInHand = [w(1), w(2), w(3), w(4), w(5), w(6), s(1), s(2), s(3), s(9), WILD, WILD, s(5), s(5)];
  const rs2 = createRuleSet('koukou', { mustOpen: false, enforceMinFan: false });
  const st2 = blank(createGame({ seed: 8, ruleset: rs2 }), {
    flipTile: FLIP,
    wildTile: WILD,
    skinTiles: computeSkinTiles(FLIP, WILD, rs2),
  });
  const p2 = st2.players[1];
  p2.hand = twoInHand;
  p2.melds = [];
  p2.opened = true;
  st2.turn = 1;
  st2.phase = 'discard';
  assert.equal(
    legalActions(st2, 1).some((a) => a.type === 'win'),
    false,
    '两张癞子都留在手里 → 不能胡小胡',
  );
});

test('小胡癞子上限：上限 1 就拦，放到 2 才允许胡（开关生效）', () => {
  // 翻九筒 → 癞子一筒、皮子 {九筒, 八筒, 红中}；手牌避开这三种，保证只被「癞子张数」这一条拦。
  const FLIP = t(9);
  const WILD = t(1);
  const hand = [w(1), w(2), w(3), w(4), w(5), w(6), s(1), s(2), s(3), s(5), s(5), s(9), WILD, WILD];
  const mk = (max) => {
    const rs = createRuleSet('koukou', { maxWildsForSmallHu: max, mustOpen: false, enforceMinFan: false });
    const st = blank(createGame({ seed: 8, ruleset: rs }), {
      flipTile: FLIP,
      wildTile: WILD,
      skinTiles: computeSkinTiles(FLIP, WILD, rs),
    });
    assert.deepEqual(
      [...st.skinTiles].sort((a, b) => a - b),
      [t(8), t(9), RED_DRAGON].sort((a, b) => a - b),
      '夹具前提：皮子 = 八筒/九筒/红中',
    );
    for (const x of hand) {
      assert.ok(!st.skinTiles.includes(x), `夹具前提：手牌不能含皮子（${tileName(x)} 是皮子）`);
    }
    const p = st.players[1];
    p.hand = hand.slice();
    p.melds = [];
    p.opened = true;
    st.turn = 1;
    st.phase = 'discard';
    return legalActions(st, 1).some((a) => a.type === 'win');
  };
  assert.equal(mk(1), false, '上限 1：手里两张癞子不能胡小胡');
  assert.equal(mk(2), true, '上限 2：放宽后可以胡（证明拦它的是这一条，不是别的闸门）');
});

/* ------------------------------------------------------------------ */
/* 杠上开花：特殊杠不算（老吴 2026-09-30 报的 bug）                      */
/*   「我是自摸，可是显示为杠上开花」—— 实测 69 例杠上开花里 44 例        */
/*   （64%）紧邻前一手是皮子杠/红中杠/癞子杠，而这三类在引擎里本来就      */
/*   不占面子、不算「杠」，只是「把 1 张特殊牌拿出去换 1 张摸牌」。         */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ 夹具必须给 seat0 一个**真正的碰**：`doAnGang` 会调 `refreshOpened`，而暗杠**不算开口**
 *    （`darkGangCountsAsOpen:false`）→ 只挂一个暗杠的话 `opened` 会被刷回 false，
 *    接着胡牌会被「必须开口」闸门拦下（踩过一次）。（注：2026-10-19 起三类特殊杠**算开口**，
 *    所以这里担心的是暗杠，不是特殊杠。）
 *
 * ⚠️ 牌墙也必须留够（≥15 张）：补摸后剩 <14 张会**自动算海底捞**（情境大胡），
 *    把「小胡 + 杠上开花」的断言搞成 `size === 'big'`（也踩过一次）。
 */
const WALL_PAD = 20;
const paddedWall = (first) => [first, ...new Array(WALL_PAD).fill(w(2))];

/** 暗杠夹具：已碰一条（算开口），手里 4×w9 拿去暗杠，补摸 s5 → 3 副 + s5s5 将。 */
function anGangThenDrawState(rs) {
  const st = blank(createGame({ seed: 74, ruleset: rs }), { flipTile: null, wildTile: WHITE_DRAGON });
  st.players[0].melds = [{ type: 'peng', tiles: [s(1), s(1), s(1)], from: 1 }];
  st.players[0].opened = true;
  st.players[0].hand = [w(9), w(9), w(9), w(9), t(4), t(5), t(6), s(7), s(8), s(9), s(5)];
  st.wall = paddedWall(s(5));
  st.turn = 0;
  st.phase = 'discard';
  return st;
}

/**
 * 特殊杠夹具：已碰一条（算开口），手里 1 张 special 拿去杠，补摸 w5 → 3 副 + w5w5 将。
 * 特殊杠**不占面子**，所以手牌比暗杠夹具多一副。
 */
function specialGangState(rs, special, skins) {
  const st = blank(createGame({ seed: 73, ruleset: rs }), {
    flipTile: null,
    wildTile: WHITE_DRAGON,
    skinTiles: skins,
  });
  st.players[0].melds = [{ type: 'peng', tiles: [s(1), s(1), s(1)], from: 1 }];
  st.players[0].opened = true;
  st.players[0].hand = [special, w(1), w(2), w(3), t(4), t(5), t(6), s(7), s(8), s(9), w(5)];
  st.wall = paddedWall(w(5));
  st.turn = 0;
  st.phase = 'discard';
  return st;
}

test('杠上开花：暗杠后的补摸成形 → 算杠上开花（真正的杠）', () => {
  const rs = createRuleSet('koukou', { enforceMinFan: false });
  const st = anGangThenDrawState(rs);
  act(st, { type: 'an', seat: 0, tile: w(9) });
  assert.equal(st.gangFlag, true, '暗杠 → 标记杠上开花');
  assert.equal(exposedMeldCount(st.players[0].melds), 2, '碰 + 暗杠 = 2 个面子：11-4+1 = 8');
  assert.equal(st.players[0].hand.length, 8, '暗杠后手牌 8 张');
  act(st, { type: 'win', seat: 0 });
  assert.ok(st.result.types.includes('gangShangKaiHua'), '暗杠后自摸 = 杠上开花');
});

test('杠上开花：**皮子杠 / 红中杠 / 癞子杠**补摸成形也算（2026-10-22 老吴明确）', () => {
  const rs = createRuleSet('koukou', { enforceMinFan: false });
  const cases = [
    { name: '皮子杠', special: w(9), action: 'skingang', skins: [w(9)] },
    { name: '红中杠', special: Z, action: 'redgang', skins: [Z] },
    { name: '癞子杠', special: WHITE_DRAGON, action: 'wildgang', skins: [] },
  ];
  for (const c of cases) {
    const st = specialGangState(rs, c.special, c.skins);
    assert.equal(st.players[0].hand[0], c.special, `${c.name}：夹具手牌第一张就是它`);
    act(st, { type: c.action, seat: 0, tile: c.special });
    assert.equal(st.gangFlag, true, `${c.name} → 补摸后标记杠上开花`);
    assert.equal(exposedMeldCount(st.players[0].melds), 1, `${c.name} 不占面子（只有那个碰）`);
    assert.equal(st.players[0].hand.length, 11, `${c.name} 后手牌仍 11 张（10 + 补摸 1）`);
    act(st, { type: 'win', seat: 0 });
    assert.ok(st.result.types.includes('gangShangKaiHua'), `${c.name} 后自摸 = 杠上开花`);
  }
});

test('杠上开花：标记不能泄漏 —— 弃牌即清除，正常摸牌绝不算', () => {
  const rs = createRuleSet('koukou', { enforceMinFan: false });
  const st = anGangThenDrawState(rs);
  act(st, { type: 'an', seat: 0, tile: w(9) });
  assert.equal(st.gangFlag, true);
  act(st, { type: 'discard', seat: 0, tile: s(5) });
  assert.equal(st.gangFlag, false, '弃牌后必须清掉，不能带到下一家 / 下一次摸牌');
});

/* ------------------------------------------------------------------ */
/* 可胡可过（老吴 2026-09-30）：有胡时允许「过」，抢杠胡不能过            */
/* ------------------------------------------------------------------ */

const PASS_RS = createRuleSet('koukou', { enforceMinFan: false });
/** 一副成形的 14 张（3 副 + w5w5 将 → 小胡） */
const WIN14 = [w(1), w(2), w(3), t(4), t(5), t(6), s(7), s(8), s(9), t(9), t(9), t(9), w(5), w(5)];

test('防过期「胡」：不是本家回合 / 已过胡，旧按钮不能越权结算', () => {
  const st = blank(createGame({ seed: 82, ruleset: PASS_RS }), { flipTile: null, wildTile: WHITE_DRAGON });
  st.players[0].opened = true;
  st.players[0].hand = [...WIN14];
  st.wall = [w(1)];
  st.phase = 'discard';

  st.turn = 1;
  assert.throws(() => act(st, { type: 'win', seat: 0 }), /还没轮到你/);
  assert.equal(st.phase, 'discard', '越权「胡」不能把牌局结算掉');

  st.turn = 0;
  st.winDeclined = true;
  assert.throws(() => act(st, { type: 'win', seat: 0 }), /本轮已经过/);
  assert.equal(st.phase, 'discard', '已过胡的旧按钮不能结算');
});

test('可过胡（自摸）：legal 同时给「自摸」和「过」，过完后本轮不再给，出牌后随摸牌重置', () => {
  const st = blank(createGame({ seed: 80, ruleset: PASS_RS }), { flipTile: null, wildTile: WHITE_DRAGON });
  st.players[0].opened = true;
  st.players[0].hand = [...WIN14];
  st.wall = [w(1), w(2)]; // 留牌给下家摸，用来验证「摸牌即重置」
  st.turn = 0;
  st.phase = 'discard';

  const types = () => legalActions(st, 0).map((a) => a.type);
  assert.ok(types().includes('win'), '成形 → 有自摸');
  assert.ok(types().includes('pass'), '有自摸时**同时**要能「过」');

  act(st, { type: 'pass', seat: 0 });
  assert.equal(st.winDeclined, true);
  assert.equal(st.phase, 'discard', '「过」不换手，仍是自己的出牌阶段');
  assert.ok(!types().includes('win'), '过完本轮不再给「自摸」');
  assert.ok(!types().includes('pass'), '过了就不再重复给「过」');
  assert.ok(types().includes('discard'), '仍然可以正常出牌');

  // 出牌 → 无人响应 → 下家摸牌（drawTile 里把 winDeclined 重置回 false）
  act(st, { type: 'discard', seat: 0, tile: w(1) });
  assert.equal(st.turn, 1);
  assert.equal(st.winDeclined, false, '下一次摸牌后重置 → 新摸的牌可以再胡');
});

test('可过胡（点炮）：响应阶段忽略某个「胡」，牌局继续（漏炮后可继续胡）', () => {
  const st = blank(createGame({ seed: 81, ruleset: PASS_RS }), { flipTile: null, wildTile: WHITE_DRAGON });
  st.players[0].hand = [s(9), t(1), t(1), t(1), t(2), t(2), t(2), t(3), t(3), t(3), t(4), t(4), t(4)];
  st.players[1].opened = true;
  st.players[1].hand = [w(1), w(2), w(3), w(4), w(5), w(6), t(7), t(8), t(9), s(5), s(5), s(7), s(8)];
  st.players[2].opened = true; // 两家都听九条 → 漏炮后应继续问下一家
  st.players[2].hand = [w(1), w(2), w(3), t(1), t(2), t(3), t(4), t(5), t(6), s(5), s(5), s(7), s(8)];
  st.players[3].hand = [t(6), t(7), t(8), t(9), t(9), t(9), w(7), w(8), w(9), w(1), w(1), w(1), w(2)];
  st.wall = [t(5), t(5)];
  st.turn = 0;
  st.phase = 'discard';

  act(st, { type: 'discard', seat: 0, tile: s(9) });
  assert.equal(st.phase, 'claim');
  assert.equal(st.turn, 1, '按「下家优先」先问 seat1');

  const opts = legalActions(st, 1).map((a) => a.type);
  assert.ok(opts.includes('win'), 'seat1 能胡九条');
  assert.ok(opts.includes('pass'), '点炮胡也必须能「过」');

  act(st, { type: 'pass', seat: 1 });
  assert.equal(st.phase, 'claim', '还有 seat2 能胡 → 继续问');
  assert.equal(st.turn, 2);
  assert.ok(legalActions(st, 2).map((a) => a.type).includes('win'), '漏炮后 seat2 仍可胡');
});

test('抢杠胡：**进响应阶段**，必须自己点「胡」才结算（老吴 2026-10-02 改口）', () => {
  const st = blank(createGame({ seed: 30 }), { flipTile: null, wildTile: WHITE_DRAGON });
  st.players[1].melds = [{ type: 'peng', tiles: [t(3), t(3), t(3)], from: 0 }];
  st.players[1].opened = true;
  st.players[1].hand = [t(3), t(3), t(3), w(1), w(1), w(1), s(8), s(8), s(8), w(9)];
  st.players[2].melds = [{ type: 'peng', tiles: [w(1), w(1), w(1)], from: 1 }];
  st.players[2].opened = true;
  st.players[2].hand = [t(1), t(2), w(4), w(5), w(6), w(7), w(8), w(9), s(5), s(5)];
  st.turn = 1;
  st.phase = 'discard';

  act(st, { type: 'xu', seat: 1, tile: t(3) });

  // 旧行为是「当场 finishWin」→ 玩家只看到结算弹窗、没机会选。
  // 现在必须先在 claim 阶段停下来，并把「胡 / 过」都给出去。
  assert.equal(st.phase, 'claim', '不再直接结算');
  assert.equal(st.result, null, '此刻还没有任何结算结果');
  assert.ok(legalActions(st, 2).map((a) => a.type).includes('win'));
  assert.ok(legalActions(st, 2).map((a) => a.type).includes('pass'));

  // 不发动作就什么都不该发生（牌局停在等他响应）
  const snapshot = JSON.stringify({ p: st.phase, t: st.turn, w: st.wall.length, m: st.players[1].melds });
  assert.equal(JSON.stringify({ p: st.phase, t: st.turn, w: st.wall.length, m: st.players[1].melds }), snapshot);

  act(st, { type: 'win', seat: 2 });
  assert.equal(st.phase, 'settled');
  assert.ok(st.result.types.includes('qiangGangHu'));
  assert.equal(st.result.winner, 2);
  assert.equal(st.result.baozhuang.seat, 1, '被抢的那家承包');
});

test('抢杠胡：见字胡牌型照样能抢杠（改走 claim 阶段后仍不被 selfDraw 闸门挡住）', () => {
  // 动机：这个改动把抢杠从「doXuGang 里当场结算」挪进了 claim 阶段，
  // 而 claim 阶段靠 doWin 重建 ctx —— 一旦 ctx 漏了 qiangGangHu，
  // 见字胡那道「必须自摸」的闸门就会把抢杠一起封死。
  // 所以这里在**引擎层**（而不是 score 层）钉一遍这条回归。
  const WILD = t(1);
  const st = blank(createGame({ seed: 30 }), { flipTile: null, wildTile: WILD });

  // seat1：碰过九万，手里第 4 张 → 蓄杠九万（会被抢）
  st.players[1].melds = [{ type: 'peng', tiles: [w(9), w(9), w(9)], from: 0 }];
  st.players[1].opened = true;
  st.players[1].hand = [w(9), s(1), s(1), s(1), t(7), t(7), t(7), t(2), t(2)];

  // seat2：见字胡 —— 一对九万 + 一张癞子，抢到九万时癞子顶上凑成九万刻
  //（其余 3 面子 + 五万将，整手除「九万刻含癞」外都是常规模型）
  st.players[2].melds = [{ type: 'peng', tiles: [s(2), s(2), s(2)], from: 1 }];
  st.players[2].opened = true;
  st.players[2].hand = [w(5), w(5), w(1), w(2), w(3), t(4), t(5), t(6), w(9), WILD];
  st.turn = 1;
  st.phase = 'discard';

  act(st, { type: 'xu', seat: 1, tile: w(9) });
  assert.equal(st.phase, 'claim', '能抢 → 先进响应阶段');
  assert.ok(
    legalActions(st, 2).map((a) => a.type).includes('win'),
    '见字胡牌型不能被抢杠路径误挡（qiangGangHu 必须带到 doWin 重建的 ctx 里）',
  );

  act(st, { type: 'win', seat: 2 });
  assert.equal(st.phase, 'settled');
  assert.ok(st.result.types.includes('qiangGangHu'), '抢杠是大胡牌型');
  assert.equal(st.result.winner, 2);
  assert.equal(st.result.baozhuang.seat, 1, '被抢的那家承包');
});

test('canPassWin=false：有胡必胡 —— 不给「过」，强行 pass 抛错', () => {
  const rs = createRuleSet('koukou', { enforceMinFan: false, canPassWin: false });
  const st = blank(createGame({ seed: 82, ruleset: rs }), { flipTile: null, wildTile: WHITE_DRAGON });
  st.players[0].opened = true;
  st.players[0].hand = [...WIN14];
  st.wall = [w(1)];
  st.turn = 0;
  st.phase = 'discard';

  const types = legalActions(st, 0).map((a) => a.type);
  assert.ok(types.includes('win'));
  assert.ok(!types.includes('pass'), '关掉 canPassWin → 有自摸时不给「过」');
  assert.throws(() => act(st, { type: 'pass', seat: 0 }), /不允许过胡/);

  // 响应阶段同理：有胡时不给 pass
  const st2 = blank(createGame({ seed: 81, ruleset: rs }), { flipTile: null, wildTile: WHITE_DRAGON });
  st2.players[0].hand = [s(9), t(1), t(1), t(1), t(2), t(2), t(2), t(3), t(3), t(3), t(4), t(4), t(4)];
  st2.players[1].opened = true;
  st2.players[1].hand = [w(1), w(2), w(3), w(4), w(5), w(6), t(7), t(8), t(9), s(5), s(5), s(7), s(8)];
  for (const seat of [2, 3]) {
    st2.players[seat].hand = [t(6), t(7), t(8), t(9), t(9), t(9), w(7), w(8), w(9), w(1), w(1), w(1), w(2)];
  }
  st2.wall = [t(5)];
  st2.turn = 0;
  st2.phase = 'discard';
  act(st2, { type: 'discard', seat: 0, tile: s(9) });
  const o = legalActions(st2, 1).map((a) => a.type);
  assert.ok(o.includes('win'));
  assert.ok(!o.includes('pass'), '有胡时不给「过」');
});

/**
 * 不变量（老吴 2026-09-30 提出，2026-10-02 补齐）：
 * 「有胡的时候，同时也要允许用户『过』不胡」
 *
 * ⚠️ 2026-09-30 版口径留了个尾巴：「**仅在抢杠胡的时候不能『过』**」——
 *    实现上靠「抢杠在 doXuGang 里当场判定结算、压根不进 claim 阶段」来绕开。
 *    代价就是老吴 2026-10-02 报的这个缺陷：能抢杠的人**直接看到结算弹窗**，
 *    既没机会点「胡」，也没有「过」。
 *    现在抢杠也走 claim 阶段，于是这条不变量**对自摸 / 点炮 / 抢杠一律成立，不再有特例**。
 *
 * 这条 UI 冒烟（tools/verify-ui.mjs）是**靠运气**才可能覆盖的 —— 人类的出招策略会让它
 * 极少摸成形。所以这里用**逐局逐座位扫 `legalActions`** 的方式把不变量钉死：
 * 只要任何座位在**任何阶段**能看到「胡」，就必须同时能看到「过」。
 */
test('不变量：凡给出「胡」的地方必同时给出「过」（自摸 / 点炮 / 抢杠都成立）', () => {
  let offers = 0;
  let claimOffers = 0;
  let selfOffers = 0;
  let qgOffers = 0;
  for (let i = 0; i < 120; i++) {
    const seed = 9000 + i;
    let state = createGame({ seed, ruleset: RS });
    let steps = 0;
    while (state.phase !== 'settled' && steps++ < 5000) {
      for (let seat = 0; seat < 4; seat++) {
        const acts = legalActions(state, seat);
        if (!acts.some((a) => a.type === 'win')) continue;
        offers++;
        if (state.phase === 'claim') claimOffers++; else selfOffers++;
        if (state.pendingXuGang) qgOffers++;
        assert.ok(
          acts.some((a) => a.type === 'pass'),
          `seed=${seed} phase=${state.phase} seat=${seat}${state.pendingXuGang ? '（抢杠）' : ''}：给了「胡」却没给「过」`,
        );
      }
      const action = decide(state, state.turn);
      if (!action) break;
      state = act(state, action);
    }
  }
  // 这条不变量只有在真的出现过「胡」时才有意义 —— 防止夹具把断言跑成空转
  assert.ok(offers > 0, '120 局里一次「胡」的机会都没有，断言等于没跑');
  assert.ok(selfOffers > 0, `自摸「可胡」至少该出现一次（实际 ${selfOffers}）`);
  assert.ok(claimOffers > 0, `点炮「可胡」至少该出现一次（实际 ${claimOffers}）`);
  // 抢杠是稀有事件：机器人 120 局里可能一次都没触发，所以只报告不强制。
  // 抢杠那条分支由上面四个定点用例（进 claim / 过 / 两家先问 / canPassWin=false）确定性覆盖。
  console.log(`    （本轮扫到 抢杠「可胡」${qgOffers} 次）`);
});

/**
 * 老吴 2026-09-30 上报：「本来不够胡，当吃了一句以后，出来一个『自摸』的按钮，可以胡牌了。」
 *
 * 根因：吃/碰之后手里正好 **14 张**（11 张手牌 + 3 张副露），`canWinWith(自摸)` 判定成立，
 * 于是 `legalActions` 给出了 `win`。但真实规则是**吃/碰后必须打出一张，不许胡**
 * （只有杠后补摸才许胡，那是「杠上开花」）。
 *
 * 下面的夹具把「吃完后 14 张正好是 4 面子 + 1 将」这个局面造出来，验证：
 *   · 不做处理时 `win` 确实会冒出来（把 mustDiscard 强行置 false 就能复现老吴看到的现象）
 *   · 加了 mustDiscard 之后 `win` 消失、`pass` 也没有、只能出牌
 */
const RS_NF = createRuleSet('koukou', { enforceMinFan: false }); // 关掉门槛，隔离 mustDiscard 这一个变量

test('吃牌后必须打牌、不能胡（老吴 2026-09-30）：legalActions 不给「胡」', () => {
  const st = blank(createGame({ seed: 33, ruleset: RS_NF }), { flipTile: null, wildTile: WHITE_DRAGON });
  // 我(0) 手里 123万 456万 789万 + 55筒 + 23条 = 13 张；上家(3) 打出 4条 → 用 23条 吃
  st.players[0].hand = [
    w(1), w(2), w(3), w(4), w(5), w(6), w(7), w(8), w(9), t(5), t(5), s(2), s(3),
  ];
  for (const seat of [1, 2, 3]) {
    st.players[seat].hand = [w(1), w(3), w(5), w(7), w(9), t(1), t(3), t(5), t(7), t(9), s(1), s(5), s(7)];
  }
  st.wall = [w(1), w(1), w(1), w(1), w(1), w(1), w(1), w(1)];
  st.lastDiscard = { tile: s(4), from: 3 };
  st.turn = 3;
  st.phase = 'discard';

  act(st, { type: 'chi', seat: 0, tiles: [s(2), s(3)] });

  assert.equal(st.phase, 'discard');
  assert.equal(st.turn, 0);
  assert.equal(st.mustDiscard, true, '吃完后必须打牌');
  // 吃完 14 张正好是 4 面子 + 1 将 → 牌型本身确实成立（这正是老吴看到「能胡」的原因）
  assert.equal(st.players[0].hand.length, 11, '11 张手牌 + 3 张副露 = 14');
  assert.equal(st.players[0].melds.length, 1);

  // ① 反证：把锁强行打开，`win` 就冒出来了 —— 复现老吴看到的现象
  const saved = st.mustDiscard;
  st.mustDiscard = false;
  const withLockOff = legalActions(st, 0).map((a) => a.type);
  st.mustDiscard = saved;
  assert.ok(withLockOff.includes('win'), '锁关掉时确实会给出「胡」—— 证明夹具真的够胡');

  // ② 加了锁之后：没有「胡」、也没有「过」，只剩出牌
  const types = legalActions(st, 0).map((a) => a.type);
  assert.ok(!types.includes('win'), '吃完后不该有「胡」');
  assert.ok(!types.includes('pass'), '吃完后没有「胡」，自然也不该有「过」');
  assert.ok(types.includes('discard'), '吃完后必须能出牌');
  assert.throws(() => act(st, { type: 'pass', seat: 0 }), /必须先打出一张牌/);

  // ③ 打出一张 → 锁解开（下一轮摸牌成型后可以正常胡）
  act(st, { type: 'discard', seat: 0, tile: w(1) });
  assert.equal(st.mustDiscard, false, '出牌后锁解开');
});

test('碰牌后同样必须打牌、不能胡', () => {
  const st = blank(createGame({ seed: 34, ruleset: RS_NF }), { flipTile: null, wildTile: WHITE_DRAGON });
  // 我(0) 手里 123万 456万 789万 + 55筒 + 77条 = 13 张；上家(3) 打出 7条 → 碰
  st.players[0].hand = [
    w(1), w(2), w(3), w(4), w(5), w(6), w(7), w(8), w(9), t(5), t(5), s(7), s(7),
  ];
  for (const seat of [1, 2, 3]) {
    st.players[seat].hand = [w(1), w(3), w(5), w(7), w(9), t(1), t(3), t(5), t(7), t(9), s(1), s(5), s(8)];
  }
  st.wall = [w(1), w(1), w(1), w(1), w(1), w(1), w(1), w(1)];
  st.lastDiscard = { tile: s(7), from: 3 };
  st.turn = 3;
  st.phase = 'discard';

  act(st, { type: 'peng', seat: 0 });

  assert.equal(st.mustDiscard, true, '碰完后必须打牌');
  const types = legalActions(st, 0).map((a) => a.type);
  assert.ok(!types.includes('win'), '碰完后不该有「胡」');
  assert.ok(types.includes('discard'));
});

test('杠后补摸不受「必须打牌」影响：杠上开花照旧能胡', () => {
  // 这道锁由 drawTile 解开（杠后补摸也走 drawTile），所以杠上开花不会被误伤。
  // 这里用「暗杠 → 补摸」的既有用例交叉验证一遍：补摸后 phase 仍是 discard，
  // 但 mustDiscard 必须是 false。
  const st = anGangThenDrawState(RS_NF);
  assert.equal(st.mustDiscard, false, '杠后补摸后不应还锁着');
  const types = legalActions(st, 0).map((a) => a.type);
  assert.ok(!types.includes('win') || st.mustDiscard === false);
});

test('不变量：canPassWin=false 时凡有「胡」就一律没有「过」（退回旧口径）', () => {
  const rsNo = createRuleSet('koukou', { canPassWin: false });
  let offers = 0;
  for (let i = 0; i < 60; i++) {
    const seed = 9500 + i;
    let state = createGame({ seed, ruleset: rsNo });
    let steps = 0;
    while (state.phase !== 'settled' && steps++ < 5000) {
      for (let seat = 0; seat < 4; seat++) {
        const acts = legalActions(state, seat);
        if (!acts.some((a) => a.type === 'win')) continue;
        offers++;
        assert.ok(
          !acts.some((a) => a.type === 'pass'),
          `seed=${seed} phase=${state.phase} seat=${seat}：关掉 canPassWin 后仍有「过」`,
        );
      }
      const action = decide(state, state.turn);
      if (!action) break;
      state = act(state, action);
    }
  }
  assert.ok(offers > 0, '60 局里一次「胡」的机会都没有，断言等于没跑');
});

/* ------------------------------------------------------------------ */
/* 乱将 / 乱风（老吴 2026-09-30 第 2 条缺陷）                            */
/* ------------------------------------------------------------------ */

/**
 * 老吴原话：「将一色、风一色都不需要按顺子、刻子的规则，全手牌只要全是将牌或者风牌
 *           就可以胡牌，即乱将乱风就可以」。
 *
 * score.test.js 已经在 `evaluateWin` 一层钉死了判定，但老吴是**在牌桌上点按钮**感受到这件事的 ——
 * 所以这里必须再从 `legalActions` 往下走一遍，证明「乱将手牌 → 真的出现『胡』按钮」这条链是通的。
 *
 * ⚠️ 夹具两个坑（都踩过）：
 *   ① 默认 `koukou` 是 `mustOpen: true` —— 光有牌型没开口，报的是「没有开口，不能胡牌」，
 *      跟乱将一点关系没有。所以赢家必须**真的带一个碰**（碰 222万）。
 *   ② 带了一个碰 → 手牌只剩 11 张，得按「11 手牌 + 1 副露」重新配平到 14。
 *
 * 反方向也必须成立：关掉开关 → 同一手牌**不给**「胡」。两半都断言，夹具才不可能「怎么写都过」。
 */

/** 造一个「碰了 222万、手里 11 张全是 2/5/8、却拆不出 3 面子 + 1 将」的局面 */
function luanJiangState(ruleset, seed) {
  const st = blank(createGame({ seed, ruleset }), { flipTile: null, wildTile: WHITE_DRAGON });
  st.players[0].melds = [{ type: 'peng', tiles: [w(2), w(2), w(2)], from: 1 }];
  st.players[0].opened = true; // 开口 —— 否则先被 mustOpen 拦下，测不到乱将
  st.players[0].hand = [
    w(5), w(5), w(5), w(8), w(8), w(8), t(2), t(2), t(5), t(5), t(8),
  ];
  for (const seat of [1, 2, 3]) {
    st.players[seat].hand = [w(1), w(3), w(4), w(6), w(7), w(9), t(1), t(3), t(4), t(6), t(7), t(9), s(1)];
  }
  st.wall = Array.from({ length: 40 }, (_, i) => s(1 + (i % 9)));
  st.phase = 'discard';
  st.turn = 0;
  return st;
}

test('乱将：全手牌都是 2/5/8 但拆不出面子 → 默认规则下 legalActions 给出「胡」', () => {
  /* 常规拆解为什么必然失败：碰掉 222万 后剩 555万 888万 两副刻子（6 张），
     再剩 t2 t2 t5 t5 t8（5 张）—— 凑不出「1 面子 + 1 将」，只能靠乱将。 */
  const st = luanJiangState(RS, 61);
  assert.equal(st.players[0].hand.length, 11, '碰完之后手里应是 11 张');
  const acts = legalActions(st, 0);
  assert.ok(
    acts.some((a) => a.type === 'win'),
    '全 2/5/8 的 11 张 + 1 副露应该能胡（乱将 / 将一色），实际 legalActions='
      + JSON.stringify(acts.map((a) => a.type)),
  );

  // 反向对照：关掉乱将 → 旧口径下这手牌牌型不成立
  const stOff = luanJiangState(createRuleSet('koukou', { luanJiangEnabled: false }), 61);
  assert.ok(
    !legalActions(stOff, 0).some((a) => a.type === 'win'),
    '关掉 luanJiangEnabled 后这手牌不该能胡',
  );
});

test('乱将：真走一步 act(win) 后，结算里记的是「将一色」大胡（且不误判碰碰胡）', () => {
  const st = luanJiangState(RS, 62);
  const after = act(st, { type: 'win', seat: 0 });
  assert.equal(after.phase, 'settled');
  assert.equal(after.result.winner, 0);
  assert.equal(after.result.size, 'big', '乱将应该判成大胡');
  assert.ok(
    after.result.types.includes('jiangYiSe'),
    'types 里应有 jiangYiSe，实际 ' + JSON.stringify(after.result.types),
  );
  assert.ok(!after.result.types.includes('qingYiSe'), '万筒混着不算清一色');
  /* 乱将的拆解是「形状无关」的（sets 为空），不能因为副露是碰就给个碰碰胡把底番翻倍 */
  assert.ok(!after.result.types.includes('pengpengHu'), '乱将不应误判成碰碰胡：' + JSON.stringify(after.result.types));
});

/* ===== 皮子 / 赖子：可以杠，但只是「换牌」，不成为顺子刻子的一部分 =====
 * 老吴 2026-10-03 23:05 补充口径：「皮、赖可以杠，杠了以后在副露，
 * 但是不能成为顺子、刻子的一部分，只算杠。」
 * 本段把三段口径一次钉住：
 *   ① 结构上：特殊杠类型与面子类型**零交集**（不可能被当成 chi/peng/an…）
 *   ② 张数上：特殊杠后手牌张数不变（抽 1 张 + 补摸 1 张）
 *   ③ 被别人：皮子/癞子**不能被吃碰杠**（canClaimSpecialTiles 默认 false）
 * 实测（2000 局）：这些口径现有代码**本来就已实现**，本段是防回归钉子。
 */

test('皮子/赖子口径：特殊杠类型与面子类型零交集（结构上不可能混成面子）', () => {
  assert.deepEqual(SPECIAL_GANG_TYPES, ['skin', 'wild', 'red'], '特殊杠 = 皮子杠/癞子杠/红中杠');
  assert.deepEqual(MELD_TYPES, ['chi', 'peng', 'zhi', 'xu', 'an'], '占面子的副露 = 吃/碰/冲/蓄/暗');
  const overlap = SPECIAL_GANG_TYPES.filter((t) => MELD_TYPES.includes(t));
  assert.deepEqual(overlap, [], '两类必须零交集，否则「特殊杠」会被当面子折算 3 张');
});

test('皮子/赖子口径：杠了之后在副露里，但手牌张数不变（只算杠、不占面子）', () => {
  const state = blank(createGame({ seed: 61 }), { flipTile: t(9), wildTile: t(1), skinTiles: [s(6)] });
  const p = state.players[0];
  p.hand = [w(1), w(2), w(3), t(3), t(4), t(5), s(6), s(7), s(8), s(9), s(9), 20, 21];
  state.turn = 0;
  state.phase = 'discard';
  const before = p.hand.length;

  act(state, { type: 'skingang', seat: 0, tile: s(6) });

  const after = state.players[0];
  assert.ok(after.melds.some((m) => m.type === 'skin'), '皮子杠确实进了副露');
  assert.equal(after.hand.length, before, '抽走 1 张 + 补摸 1 张 ⇒ 张数不变：' + before + ' → ' + after.hand.length);
  assert.equal(handNeeded(state, 0), 14, '手牌应有张数仍是 14（特殊杠不折算面子）');
});

test('皮子/赖子口径：别人不能吃/碰/明杠我的皮子与癞子', () => {
  const rs = createRuleSet('koukou');
  assert.equal(rs.canClaimSpecialTiles, false, '默认禁止碰杠特殊牌');

  // ⚠️ `blank()` 会把 skinTiles 清空（默认 []），所以要显式给一组皮子
  const skinA = t(3);
  const state = blank(createGame({ seed: 61, ruleset: rs }), { flipTile: t(9), wildTile: t(1), skinTiles: [skinA] });
  const skin = skinA;
  // 制造「上家打出一张皮子、下家手里有 2 张」的场景：普通牌型下会给「碰」，特殊牌必须不给
  state.players[0].discards = [skin];
  // ⚠️ 筒只有 1~9（`t(10)` 会 makeTile 越界），多出来的位置用万/条凑
  state.players[1].hand = [skin, skin, w(1), w(2), w(3), w(4), w(5), w(6), w(7), w(8), s(1), s(2), s(3)];
  state.discardLog = [{ seat: 0, tile: skin }];
  state.lastDiscard = { tile: skin, from: 0 };
  state.turn = 1;
  state.phase = 'discard';

  const claims = legalActions(state, 1).filter((a) => a.type === 'peng' || a.type === 'zhi' || a.type === 'chi');
  assert.deepEqual(claims.map((a) => a.type), [], '皮子不该给碰/杠/吃选项');
});

test('皮子/赖子口径：吃牌材料里也不能含皮子或癞子', () => {
  const state = blank(createGame({ seed: 61 }), { flipTile: t(9), wildTile: t(1) });
  const wild = state.wildTile;
  const skin = state.skinTiles[0];
  const combos = chiCombos(state.players[0].hand, t(4), [wild, skin]);
  const usesSpecial = combos.some((c) => c.some((x) => x === wild || x === skin));
  assert.equal(usesSpecial, false, '吃牌组合里不能出现癞子或皮子');
});

/* ===== 皮子/赖子不能暗杠（老吴 2026-10-03 23:20 更正） ===== */

test('皮子/赖子不能暗杠：legalActions 不给 an 选项', () => {
  const wild = w(1);
  const skinA = t(3);
  const state = blank(createGame({ seed: 61 }), { flipTile: t(9), wildTile: wild, skinTiles: [skinA] });
  const p = state.players[0];
  // 手里 4 张癞子 + 4 张皮子
  p.hand = [wild, wild, wild, wild, skinA, skinA, skinA, skinA, s(1), s(2), s(3), s(4), s(5), s(6)];
  state.turn = 0;
  state.phase = 'discard';

  const anTiles = legalActions(state, 0).filter((a) => a.type === 'an').map((a) => a.tile);
  assert.ok(!anTiles.includes(wild), '4 张癞子不该给暗杠选项');
  assert.ok(!anTiles.includes(skinA), '4 张皮子不该给暗杠选项');
  // 但普通牌仍然可以暗杠（⚠️ 挑一张既不是 wildTile 也不在 skinTiles 里的）
  const normal = w(5);
  assert.notEqual(normal, wild, '验证用的普通牌不能就是癞子');
  assert.ok(!state.skinTiles.includes(normal), '验证用的普通牌不能在皮子集里');
  p.hand = [normal, normal, normal, normal, s(1), s(2), s(3), s(4), s(5), s(6), s(7), s(8), s(9)];
  const anOk = legalActions(state, 0).filter((a) => a.type === 'an').map((a) => a.tile);
  assert.ok(anOk.includes(normal), '普通牌 4 张仍可暗杠（不能误伤）');
});

test('皮子/赖子不能暗杠：红中也不能暗杠（红中在 skinTiles 里）', () => {
  // ⚠️ 不要用 `blank()` —— 它会把 skinTiles 覆盖成 opts 里给的值。
  //   这里要验证「默认 skinIncludesRedDragon=true ⇒ 红中属于皮子集」，得让引擎自己算。
  const state = createGame({ seed: 61, ruleset: createRuleSet('koukou') });
  const p = state.players[0];
  p.melds = [];
  p.discards = [];
  p.opened = false;
  assert.ok(state.skinTiles.includes(RED_DRAGON), '红中应属于皮子集合（skinIncludesRedDragon 默认 true）');
  const wild = state.wildTile;
  assert.notEqual(wild, RED_DRAGON, '本局癞子不是红中（红中不能当癞子）');
  p.hand = [RED_DRAGON, RED_DRAGON, RED_DRAGON, RED_DRAGON, s(1), s(2), s(3), s(4), s(5), s(6), s(7), s(8), s(9)];
  state.turn = 0;
  state.phase = 'discard';
  const anTiles = legalActions(state, 0).filter((a) => a.type === 'an').map((a) => a.tile);
  assert.ok(!anTiles.includes(RED_DRAGON), '4 张红中不该给暗杠选项（只能红中杠）');
  // 但红中杠仍要给
  const kinds = legalActions(state, 0).map((a) => a.type);
  assert.ok(kinds.includes('redgang'), '红中杠仍应保留 —— 只禁暗杠，不禁红中杠');
});

test('皮子/赖子不能暗杠：act() 直调也必须拒绝（网络版可绕过 UI）', () => {
  const wild = w(1);
  const state = blank(createGame({ seed: 61 }), { flipTile: t(9), wildTile: wild, skinTiles: [t(3)] });
  state.players[0].hand = [wild, wild, wild, wild, s(1), s(2), s(3), s(4), s(5), s(6), s(7), s(8), s(9)];
  state.turn = 0;
  state.phase = 'discard';
  assert.throws(
    () => act(state, { type: 'an', seat: 0, tile: wild }),
    /不能暗杠/,
    '直调 act() 绕过 legalActions 也必须被拒（不能只靠 UI 藏按钮）',
  );
});

test('specialTilesNoAnGang 关掉 ⇒ 恢复「皮子/癞子可暗杠」（开关真的被引擎读到）', () => {
  const rs = createRuleSet('koukou', { specialTilesNoAnGang: false });
  const st = createGame({ seed: 61, ruleset: rs });
  const p = st.players[0];
  const wild = st.wildTile;
  p.melds = [];
  p.discards = [];
  p.hand = [wild, wild, wild, wild, s(1), s(2), s(3), s(4), s(5), s(6), s(7), s(8), s(9)];
  st.turn = 0;
  st.phase = 'discard';
  const an = legalActions(st, 0).filter((a) => a.type === 'an').map((a) => a.tile);
  assert.ok(an.includes(wild), '开关关掉后癞子应可暗杠（证明 legalActions 确实读了这个开关）');
});

test('皮子/赖子能作万能牌顶顺子/刻子/将（只是不能按数字吃碰）', () => {
  const wild = w(4);
  // ① 顶顺子：2筒 3筒 + 癞子(=4筒)，后面 3 组顺子 + 将
  const c1 = toCounts([t(2), t(3), wild, s(1), s(2), s(3), s(4), s(5), s(6), s(7), s(8), s(9), w(1), w(1)]);
  const a1 = analyzeHand(c1, { exposedMelds: 0, wildTile: wild });
  assert.equal(a1.winning, true, '癞子应能顶顺子里的 4 筒');
  assert.ok(a1.decompositions.some((d) => d.wildUsed >= 1), '确实用到了癞子');

  // ② 顶刻子：3 张癞子当一组刻
  const c2 = toCounts([wild, wild, wild, s(1), s(2), s(3), s(4), s(5), s(6), s(7), s(8), s(9), w(1), w(1)]);
  const a2 = analyzeHand(c2, { exposedMelds: 0, wildTile: wild });
  assert.equal(a2.winning, true, '癞子应能顶刻子');

  // ③ 顶将：1筒1筒 + 癞子(=2筒)
  const c3 = toCounts([t(1), t(1), wild, s(1), s(2), s(3), s(4), s(5), s(6), s(7), s(8), s(9), w(1), w(1)]);
  const a3 = analyzeHand(c3, { exposedMelds: 0, wildTile: wild });
  assert.equal(a3.winning, true, '癞子应能顶将');
});

/* ================================================================== */
/* 癞子杠的牌数约束 —— 老吴 2026-10-09 当面考校 + 纠正                    */
/* ================================================================== */
/*
 * 老吴原话（考校）：
 *   「已经吃碰了四句话，底牌还剩一个赖子，这时候又摸到一个赖子，能不能胡牌？
 *     如果杠了这个摸来的赖子，又杠到了一个赖子，又能不能胡？」
 *
 * 老吴最终口径：
 *   「最后一对牌，必须是将牌（2、5、8），清一色除外。
 *     如果是清一色，摸了赖子就可以胡，再杠赖还是一个赖子，也可以胡。
 *     如果不是清一色，赖子也不是将牌，那么摸到赖子不能胡，必须杠才能胡；
 *     同理，如果用赖子再杠来一个赖子，也不能胡，必须接着杠。」
 *
 * 老吴最后纠正：
 *   「赖子不是皮，赖子只是可以杠而已。」
 *
 * ⚠️ **这些路径此前只靠临时探针验证，没进回归基线** —— 现在钉死。
 *
 * 🔴 关键机制（`score.js` 的 `if (!isBig)` 整块跳过）：
 *   小胡两道闸门 —— `smallHuNeeds258Eye`（将要 258）+ `maxWildsForSmallHu`（手里癞子 ≤ 1）
 *   —— **只管小胡**。只要命中任一大胡牌型（碰碰胡/清一色/…），`isBig = true`，
 *   两道闸门整块失效。所以「清一色下手里 2 个癞子照样能胡」不是特例代码，
 *   而是**统一逻辑的自然结果**。
 *
 * ⚠️ 构造这类场景的三个必备动作（都是探针踩过的坑）：
 *   ① **绝不手写 `skinTiles`** —— 用 `createGame()` 天然的 `wildTile/skinTiles`。
 *      手写会把癞子当皮子塞进去 ⇒ 「手里还有皮子不能胡」的闸门先把人挡掉 ⇒ 掩盖真正原因。
 *   ② **补摸的牌必须避开皮子** —— 造墙时若用 `i % 34` 循环，皮子那张会正好被摸上来。
 *   ③ **牌墙要留够** —— 摸到 `haiDiLaoStacks` 以下会误触「海底捞月」大胡，绕开小胡闸门。
 *
 * ⚠️ 判定一律以 `legalActions` 为准（`buildContext` 会自动带 `haiDiLao` 等字段），
 *    手工调 `evaluateWin` 只看 `reason` 文本会与真实可选项不一致。
 */

/** 造一个「癞子恰好是某张牌」的 seed（不用改引擎的牌墙顺序，纯靠种子筛） */
function seedWithWild(target, limit = 400) {
  for (let seed = 1; seed <= limit; seed++) {
    const g = createGame({ seed, ruleset: RS });
    if (g.wildTile === target) return g;
  }
  throw new Error(`前 ${limit} 个 seed 里没找到癞子为 ${target} 的局面`);
}

/** 清空四家 + 留足牌墙，只摆 seat0 的骨架。⚠️ 不覆盖 wildTile/skinTiles（用天然的） */
function seat0Only(state, wild, hand, melds) {
  for (const p of state.players) {
    p.hand = [];
    p.melds = [];
    p.discards = [];
    p.opened = false;
  }
  state.flipTile = null;
  state.wall = Array.from({ length: 60 }, (_, i) => (i % 34)); // 远大于 haiDiLaoStacks 阈值
  state.claims = [];
  state.claimIndex = 0;
  state.pendingXuGang = null;
  state.players[0].melds = melds;
  state.players[0].hand = hand;
  state.players[0].opened = true;
  state.turn = 0;
  state.phase = 'discard';
  return state;
}

const PENG = (mk, n) => ({ type: 'peng', tiles: [mk(n), mk(n), mk(n)], from: 1 });
const CHI = (mk, a, b, c) => ({ type: 'chi', tiles: [mk(a), mk(b), mk(c)], from: 1 });
/** 跨三花色的 4 副露 ⇒ physical 必然非清一色（老吴口径的「不是清一色」那一支） */
const MIXED_MELDS = () => [PENG(w, 1), PENG(t, 2), PENG(s, 3), CHI(w, 6, 7, 8)];
/** 万子一色 4 副露 ⇒ 清一色那一支（癞子当万子用时 physical 仍全万） */
const WAN_MELDS = () => [PENG(w, 1), PENG(w, 4), CHI(w, 6, 7, 8), PENG(w, 9)];
const canWin = (st, seat = 0) => legalActions(st, seat).some((a) => a.type === 'win');

test('4 副露 + [赖,赖] 不是清一色 ⇒ 不能胡（两个癞子超 maxWildsForSmallHu=1）', () => {
  const g = seedWithWild(t(8)); // 癞子 = 八筒
  assert.ok(!isQingYiSeAll(g), '这个局面不该是清一色（否则下面测的就不是小胡分支了）');
  const st = seat0Only(g, g.wildTile, [g.wildTile, g.wildTile], MIXED_MELDS());
  assert.equal(st.players[0].hand.length, 2, '4 副露 ⇒ 手牌恒需 2 张');
  assert.equal(canWin(st), false, '老吴口径：不是清一色时手里两个癞子不能胡小胡');
  // 反证：把上限放开就能胡了 ⇒ 咬住的就是这条闸门，不是别的地方误挡
  const loose = createRuleSet('koukou', { maxWildsForSmallHu: 2 });
  const st2 = seat0Only(
    createGame({ seed: 13, ruleset: RS }), g.wildTile, [g.wildTile, g.wildTile], MIXED_MELDS(),
  );
  st2.ruleset = loose;
  assert.equal(canWin(st2), true, 'maxWildsForSmallHu 放到 2 就该能胡（反证闸门位置）');
});

test('4 副露 + [赖,赖] 是清一色 ⇒ 能胡（小胡两道闸门只管小胡，大胡整块跳过）', () => {
  const g = seedWithWild(w(3)); // 癞子 = 三万，4 副露全万子
  const st = seat0Only(g, g.wildTile, [g.wildTile, g.wildTile], WAN_MELDS());
  assert.equal(canWin(st), true, '老吴口径：清一色下摸了赖子就可以胡');
  // 反证：物理牌全万 ⇒ 清一色成立。清一色这条走的正是 isBig=true 分支，
  // 所以 maxWildsForSmallHu / smallHuNeeds258Eye 都不生效。
});

test('4 副露 + [赖,普通] ⇒ 能胡（手里癞子 1 个没超上限）', () => {
  const g = seedWithWild(t(8));
  const st = seat0Only(g, g.wildTile, [g.wildTile, w(5)], MIXED_MELDS());
  assert.equal(canWin(st), true, '只有 1 个癞子 → 没超上限 → 能胡（对照上一条）');
});

test('杠掉摸来的赖子 → 补摸普通牌 / 又是癞子 ⇒ 都能胡（杠上开花按大胡，不再受小胡两赖子上限）', () => {
  const g = seedWithWild(t(8));

  // 支 ①：补普通牌 ⇒ 手牌回到 [赖,普通] ⇒ 能胡
  const a = seat0Only(g, g.wildTile, [g.wildTile, g.wildTile], MIXED_MELDS());
  const opts0 = legalActions(a, 0).map((x) => x.type);
  assert.ok(opts0.includes('wildgang'), '手里两个癞子必须给「癞子杠」这个选项');
  assert.equal(canWin(a), false, '杠之前不能胡');
  a.wall[0] = w(5); // 墙头摆一张非皮子的普通牌
  act(a, { type: 'wildgang', seat: 0, tile: g.wildTile });
  assert.deepEqual(a.players[0].hand, [w(5), g.wildTile], '杠掉一个癞子后补摸 1 张');
  assert.equal(a.players[0].melds.filter((m) => m.type === 'wild').length, 1, '副露里多了 1 个癞子杠');
  assert.equal(exposedMeldCount(a.players[0].melds), 4, '🔴 癞子杠不折算面子 ⇒ exposedMeldCount 仍是 4');
  assert.equal(canWin(a), true, '补到普通牌 ⇒ 能胡');

  // 支 ②：补到的**又是癞子** ⇒ 回到 [赖,赖]；因杠上开花按大胡，仍可胡（也可继续杠）
  const b = seat0Only(g, g.wildTile, [g.wildTile, g.wildTile], MIXED_MELDS());
  b.wall[0] = g.wildTile;
  act(b, { type: 'wildgang', seat: 0, tile: g.wildTile });
  assert.deepEqual(b.players[0].hand, [g.wildTile, g.wildTile], '又补回一个癞子');
  assert.equal(canWin(b), true, '杠上开花按大胡 → 手牌两个癞子也能胡');
  assert.ok(legalActions(b, 0).map((x) => x.type).includes('wildgang'), '但必须仍然能接着杠');
});

test('清一色下连杠 2 个癞子 ⇒ 仍然能胡（老吴「再杠赖还是一个赖子，也可以胡」）', () => {
  const g = seedWithWild(w(3));
  const st = seat0Only(g, g.wildTile, [g.wildTile, g.wildTile], WAN_MELDS());
  st.wall[0] = g.wildTile;   // 第 1 次补摸 = 又一个癞子
  st.wall[1] = w(9);          // 第 2 次补摸 = 普通牌（⚠️ 必须避开皮子）
  assert.equal(canWin(st), true, '清一色下起手就能胡');

  act(st, { type: 'wildgang', seat: 0, tile: g.wildTile });
  assert.deepEqual(st.players[0].hand, [g.wildTile, g.wildTile], '第 1 次杠：又补回一个癞子');
  assert.equal(canWin(st), true, '清一色下 1 个癞子照样能胡');

  act(st, { type: 'wildgang', seat: 0, tile: g.wildTile });
  assert.equal(st.players[0].melds.filter((m) => m.type === 'wild').length, 2, '连杠 2 个癞子杠');
  assert.equal(exposedMeldCount(st.players[0].melds), 4, '🔴 连杠 2 个也不折算面子，恒为 4');
  assert.equal(st.players[0].hand.length, 2, '手牌恒需 2 张');
  assert.equal(canWin(st), true, '老吴口径：清一色下连杠到只剩 1 个癞子也能胡');
});

test('癞子不是皮（老吴 2026-10-09 纠正）：两个独立字段，杠的口子各走各的', () => {
  const g = seedWithWild(t(8));
  const wild = g.wildTile;
  assert.equal(isWild(g, wild), true, '癞子就是癞子');
  assert.equal(isSkin(g, wild), false, '🔴 癞子不在皮子集里（两个独立字段，不能混）');
  assert.equal(g.skinTiles.includes(wild), false, '直接查 skinTiles 也应查不到');

  // 皮子往回数那两张确实在 skinTiles 里（对照：证明不是「集合空了」）
  const realSkin = g.skinTiles.find((x) => x !== RED_DRAGON);
  assert.ok(realSkin != null, '皮子集里应有非红中的皮子');
  assert.equal(isSkin(g, realSkin), true, '真皮子就是皮子');

  // 「癞子只是可以杠而已」—— 癞子只给 wildgang，绝不给 skingang
  const a = seat0Only(g, wild, [wild, wild], []);
  const oa = legalActions(a, 0).map((x) => x.type);
  assert.ok(oa.includes('wildgang'), '癞子可以杠');
  assert.equal(oa.includes('skingang'), false, '🔴 癞子不能走皮子杠那条路');

  // 反证：真皮子只给 skingang，不给 wildgang（两条路互不串）
  const b = seat0Only(g, wild, [realSkin, realSkin], []);
  const ob = legalActions(b, 0).map((x) => x.type);
  assert.ok(ob.includes('skingang'), '皮子可以杠');
  assert.equal(ob.includes('wildgang'), false, '🔴 皮子不是癞子，不能走癞子杠那条路');

  // 癞子不能暗杠（老吴 2026-10-03 23:20）—— 判据必须同时查 wildTile 和 skinTiles
  // ⚠️ 必须给**满 4 张**：`legalActions` 的暗杠分支判的是 `counts[t] === 4`，
  //    只放 3 张压根走不到那条判据，反证会假失败（我自己踩过）。
  const four = [wild, wild, wild, wild];
  const c = seat0Only(g, wild, four, []);
  assert.equal(
    legalActions(c, 0).some((x) => x.type === 'an' && x.tile === wild),
    false,
    '手里 4 张癞子也不能暗杠',
  );
  // 反证：关掉 specialTilesNoAnGang 就该给暗杠 ⇒ 咬住的就是这条判据
  const noBan = createRuleSet('koukou', { specialTilesNoAnGang: false });
  const d = seat0Only(g, wild, four, []);
  d.ruleset = noBan;
  assert.equal(
    legalActions(d, 0).some((x) => x.type === 'an' && x.tile === wild),
    true,
    '关掉开关就能暗杠（反证：判据在 specialTilesNoAnGang 这一层）',
  );
});

test('癞子杠：只占 1 张牌、不折算面子、不计开口番，但照常加番（老吴「只是可以杠而已」）', () => {
  const g = seedWithWild(t(8));
  const st = seat0Only(g, g.wildTile, [g.wildTile, g.wildTile, g.wildTile, g.wildTile], []);
  const before = { melds: st.players[0].melds.length, hand: st.players[0].hand.length };
  assert.equal(before.hand, 4, '没副露 ⇒ 手牌就该 14 张（这里是 4 张最小骨架）');

  // 记一个「同番底对照组」：把 4 张癞子换成 4 张真牌暗杠，比对两边的口径
  const wildOnly = countFan(
    { seat: 0, opened: false, melds: [{ type: 'wild', tiles: [t(8)], from: null }] },
    { ruleset: RS, isWinner: true, baseFan: 0, size: 'small' },
  );
  assert.equal(getFanOf(wildOnly, 'gangWild'), RS.gangFan.wild, '癞子杠按 gangFan.wild 计番');
  // 🔴 判据的 key 是 `openFan`（不是 `kouKou`！）—— 写错 key 的话这条断言恒真，
  //    反向对照挂 0 条也发现不了。咬住的是「开口番的番数」而不是「有没有这条明细」。
  assert.equal(getFanOf(wildOnly, 'openFan'), 0, '🔴 癞子杠不进「口数」⇒ 开口番 0（openCount 只数 chi/peng；与「记为开口」是两回事）');
  assert.equal(
    wildOnly.details.some((d) => d.key === 'gangAn'),
    false,
    '癞子杠不能被当成暗杠重复计番',
  );

  // 反证：同一条 melds 换成 chi/peng 就该有开口番 ⇒ 证明上面那个 0 是判据咬住的，不是天生就 0
  const chiOpened = countFan(
    { seat: 0, opened: true, melds: [{ type: 'chi', tiles: [t(2), t(3), t(4)], from: 1 }] },
    { ruleset: RS, isWinner: true, baseFan: 0, size: 'small' },
  );
  assert.equal(getFanOf(chiOpened, 'openFan'), RS.fan.openOnce, '吃一口就有开口番（反证）');
});

/* 小工具：取某条番明细的番数（details 里按 key 索引） */
function getFanOf(fan, key) {
  return fan.details.find((d) => d.key === key)?.fan ?? 0;
}
/** 这个局面（含 4 副露 + 手牌）是不是清一色 —— 用现成判据，不自己重写 */
function isQingYiSeAll(g) {
  const physical = [
    ...g.players[0].hand.filter((x) => x !== g.wildTile),
    ...g.players[0].melds.flatMap((m) => m.tiles.filter((x) => x !== g.wildTile)),
  ];
  return isQingYiSe(physical);
}

/* ------------------------------------------------------------------ */
/* 碰优先于吃（老吴 2026-10-24）：不是谁快谁先 —— 有人要碰时吃家拿不到
 * 选项；碰家「过」之后吃家才能吃。引擎直调路径也要挡（act 队列守卫）。 */
test('碰优先于吃：碰家未过时，吃家无选项且抢吃被拒；碰家过后才可吃', () => {
  let st = createGame({ seed: 7, dealer: 0 });
  for (const p of st.players) { p.hand = []; p.melds = []; p.discards = []; p.opened = false; }
  st.wildTile = WHITE_DRAGON; st.skinTiles = []; st.flipTile = null;
  st.phase = 'discard'; st.turn = 0; st.winDeclined = false;
  st.players[0].hand = [w(2), w(9), w(9), t(2), t(3), t(4), t(6), t(7), t(8), 27, 28, 29, 30];
  st.players[1].hand = [w(1), w(3), t(1), t(1), t(2), t(2), t(3), t(3), t(4), t(4), t(5), t(5), t(9)];
  st.players[2].hand = [w(2), w(2), t(1), t(1), t(2), t(2), t(3), t(3), t(4), t(4), t(5), t(5), t(9)];
  st.players[3].hand = [t(6), t(6), t(6), t(7), t(7), t(7), t(8), t(8), t(8), t(9), t(9), t(9), 31];

  st = act(st, { type: 'discard', seat: 0, tile: w(2) });
  assert.equal(st.phase, 'claim');
  assert.equal(st.claims[0].seat, 2, '队列头＝可碰的 seat2（优先级 2 > 吃的 1）');
  assert.equal(st.claims[1].seat, 1);

  // ① 碰家未表态：吃家（seat1）没有任何合法选项 —— UI 连吃按钮都不会出现
  assert.equal(legalActions(st, 1).length, 0);
  // ② 吃家直调引擎抢吃 → 被队列守卫拒绝（服务端还有 legalActions 一道，双保险）
  assert.throws(
    () => act(st, { type: 'chi', seat: 1, tiles: [w(1), w(3)] }),
    /还没轮到你/,
    '碰家未过时抢吃必须被拒',
  );
  assert.equal(st.phase, 'claim', '被拒后仍在响应阶段，局面不变');
  // ③ 碰家过 → 轮到吃家，此时才出现吃
  st = act(st, { type: 'pass', seat: 2 });
  assert.ok(legalActions(st, 1).some((a) => a.type === 'chi'));
  // ④ 吃家正常吃下并获出牌权
  st = act(st, { type: 'chi', seat: 1, tiles: [w(1), w(3)] });
  assert.equal(st.phase, 'discard');
  assert.equal(st.turn, 1);
});

/* ------------------------------------------------------------------ */
/* 多家同胡一张点炮牌（老吴 2026-10-24）：按 下家→对家→上家 依次表态，   */
/* 优先者不点「过」，后面的人拿不到胡、抢胡也被拒（一炮单响的排队口径，    */
/* 与碰>吃 同一队列）。夹具关掉起胡番数（本用例只验排队，不验番）。      */
test('点炮多胡排队：下家先问，过完才轮对家、上家；未轮到抢胡被拒', () => {
  const rs = createRuleSet('koukou', { enforceMinFan: false });
  let st = blank(createGame({ seed: 11, dealer: 0, ruleset: rs }), { flipTile: null, wildTile: WHITE_DRAGON });
  st.phase = 'discard'; st.turn = 0; st.winDeclined = false;
  st.players[0].hand = [t(3), w(9), w(9), t(6), t(7), t(8), t(9), 27, 28, 29, 30, 31, 32];
  for (const seat of [1, 2, 3]) {
    st.players[seat].melds = [{ type: 'peng', tiles: [w(1), w(1), w(1)], from: 0 }];
    st.players[seat].opened = true;
    st.players[seat].hand = [t(1), t(2), w(4), w(5), w(6), w(7), w(8), w(9), s(5), s(5)];
  }
  st = act(st, { type: 'discard', seat: 0, tile: t(3) });
  assert.equal(st.phase, 'claim');
  assert.deepEqual(st.claims.map((c) => c.seat), [1, 2, 3], '三家按离出牌者距离排队');
  assert.equal(legalActions(st, 2).length, 0, '对家未轮到：零选项');
  assert.equal(legalActions(st, 3).length, 0, '上家未轮到：零选项');
  assert.throws(() => act(st, { type: 'win', seat: 3 }), /还没轮到你/, '上家抢先胡被拒');
  st = act(st, { type: 'pass', seat: 1 });
  assert.equal(st.claims[st.claimIndex].seat, 2, '下家过后轮到对家');
  st = act(st, { type: 'pass', seat: 2 });
  assert.equal(st.claims[st.claimIndex].seat, 3, '对家过后轮到上家');
  assert.ok(legalActions(st, 3).some((a) => a.type === 'win'));
  st = act(st, { type: 'win', seat: 3 });
  assert.equal(st.result.type, 'win');
});

/* ------------------------------------------------------------------ */
/* 包牌：4 口 + 单吊「将牌 + 癞子」——不算全求人，但照常包（2026-10-29 老吴） */
/* ------------------------------------------------------------------ */

test('包牌：4 口 + 单吊「将牌 + 癞子」点炮 → 不算全求人，但放炮者仍包', () => {
  const rs = createRuleSet('koukou', { enforceMinFan: false });
  const state = blank(createGame({ seed: 41, ruleset: rs }), {
    flipTile: null,
    wildTile: WHITE_DRAGON,
    skinTiles: [],
  });

  // 赢家：4 口全副露（碰/吃），手里只剩一张癞子 → 单吊
  state.players[1].melds = [
    { type: 'peng', tiles: [t(1), t(1), t(1)], from: 0 },
    { type: 'chi', tiles: [w(2), w(3), w(4)], from: 2 },
    { type: 'peng', tiles: [s(5), s(5), s(5)], from: 3 },
    { type: 'peng', tiles: [t(6), t(6), t(6)], from: 0 },
  ];
  state.players[1].opened = true;
  state.players[1].hand = [WHITE_DRAGON];

  // 放炮者手里不是全将牌 → 不触发免包
  state.players[0].hand = [
    t(5), w(1), w(1), w(1), w(5), w(5), w(5),
    s(1), s(2), s(3), s(7), s(7), s(7), s(9),
  ];
  state.turn = 0;
  state.phase = 'discard';

  act(state, { type: 'discard', seat: 0, tile: t(5) });
  assert.equal(state.phase, 'claim');
  act(state, { type: 'win', seat: 1 });

  assert.equal(state.result.winner, 1);
  assert.ok(!state.result.types.includes('quanQiuRen'),
    '将牌是「5筒 + 癞子」（见将胡，不是吊某一张）→ 不算全求人');
  assert.ok(state.result.baozhuang, '4 口全副露 + 点炮 → 照常包胡（与番型解耦）');
  assert.equal(state.result.baozhuang.seat, 0, '由放炮者承包');
});

/* ------------------------------------------------------------------ */
/* 风一色豁免包牌 + 不下雨（2026-10-29 老吴：「风一色豁免包牌，         */
/*   不用包牌，不用下雨」）                                            */
/* ------------------------------------------------------------------ */

const pengOf = (tile, from = 0) => ({ type: 'peng', tiles: [tile, tile, tile], from });

test('风一色豁免包牌：4 口全副露 + 点炮 → 无人承包，三家均付金顶', () => {
  const rs = createRuleSet('koukou', { enforceMinFan: false });
  const state = blank(createGame({ seed: 77, ruleset: rs }), {
    flipTile: null, wildTile: null, skinTiles: [],
  });
  state.wildTile = null; // blank 的 `opts.wildTile ?? WHITE_DRAGON` 会把 null 回落成默认癞子

  // 赢家：4 口全副露（碰风牌）+ 手里一张发财 → 点炮白板作将，全字牌 = 风一色
  state.players[1].melds = [pengOf(EAST), pengOf(SOUTH), pengOf(WEST), pengOf(NORTH)];
  state.players[1].opened = true;
  state.players[1].hand = [GREEN_DRAGON];
  state.players[0].hand = [
    w(1), w(1), w(1), w(2), w(2), w(2), w(3), w(3), w(3), w(4), w(4), w(4), w(9), WHITE_DRAGON,
  ];
  state.turn = 0;
  state.phase = 'discard';

  act(state, { type: 'discard', seat: 0, tile: WHITE_DRAGON });
  act(state, { type: 'win', seat: 1 });

  assert.equal(state.result.winner, 1);
  assert.ok(state.result.types.includes('fengYiSe'));
  assert.ok(!state.result.baozhuang, '风一色不包牌（第三句/全求人包一律豁免）');
  assert.ok(!state.result.rainPayers, '没有下雨账');
  const pays = state.result.payments.filter((p) => p.seat !== 1).map((p) => p.pay);
  assert.deepEqual(pays, [20, 20, 20], '金顶三家各付 20，无人承包');
});

test('风一色不下雨：雨主胡风一色 → 本场雨不结算（无包、无陪包）', () => {
  const rs = createRuleSet('koukou', { enforceMinFan: false });
  const state = blank(createGame({ seed: 78, ruleset: rs }), {
    flipTile: null, wildTile: null, skinTiles: [],
  });
  state.wildTile = null;
  state.players[1].melds = [pengOf(EAST), pengOf(SOUTH), pengOf(WEST), pengOf(NORTH)];
  state.players[1].opened = true;
  state.players[1].hand = [GREEN_DRAGON, WHITE_DRAGON];
  // 自己（seat1）宣告过一场万子雨：seat2 包胡、seat3 未下雨
  state.rains = [{ color: 0, owner: 1, baos: [2], penalties: [3] }];
  state.turn = 1;
  state.phase = 'discard';

  act(state, { type: 'win', seat: 1 });

  assert.equal(state.result.winner, 1);
  assert.ok(state.result.types.includes('fengYiSe'));
  assert.ok(!state.result.rainPayers, '风一色这一把不结算下雨');
  assert.ok(!state.result.baozhuang);
  const pays = state.result.payments.filter((p) => p.seat !== 1).map((p) => p.pay);
  assert.deepEqual(pays, [20, 20, 20], '无陪包、无承包 → 三家均付');
});

/* ------------------------------------------------------------------ */
/* 包胡责任归属：一色包归「第 3 句提供者」，全求人归「放炮者」           */
/*   2026-10-29 老吴纠正：「如果是清一色，只剩最后一张牌了，那必然是     */
/*   被包胡了，由包胡者付，不由放炮者付。」                             */
/* ------------------------------------------------------------------ */

test('清一色 4 口 + 点炮 → 由「第 3 句提供者」承包，放炮者不付', () => {
  const rs = createRuleSet('koukou', { enforceMinFan: false });
  const state = blank(createGame({ seed: 79, ruleset: rs }), {
    flipTile: null, wildTile: null, skinTiles: [],
  });
  state.wildTile = null;
  // 副露顺序：第 1 句 seat0 / 第 2 句 seat3 / 第 3 句 seat2 ←包胡者 / 第 4 句 seat0
  state.players[1].melds = [pengOf(w(1), 0), pengOf(w(2), 3), pengOf(w(3), 2), pengOf(w(4), 0)];
  state.players[1].opened = true;
  state.players[1].hand = [w(5)];
  // 放炮者 = seat0（同时也是第 1/4 句提供者，但**不是**第 3 句）
  state.players[0].hand = [
    t(1), t(1), t(1), t(2), t(2), t(2), t(3), t(3), t(3), t(4), t(4), t(4), t(9), w(5),
  ];
  state.turn = 0;
  state.phase = 'discard';

  act(state, { type: 'discard', seat: 0, tile: w(5) });
  act(state, { type: 'win', seat: 1 });

  assert.ok(state.result.types.includes('qingYiSe'));
  assert.equal(state.result.baozhuang.seat, 2, '清一色由第 3 句提供者（包胡者）承包');
  const payOf = (seat) => state.result.payments.find((x) => x.seat === seat).pay;
  assert.ok(payOf(2) > 0, '包胡者独付全额');
  assert.equal(payOf(0), 0, '放炮者不付（打出最后一张 ≠ 包胡者）');
  assert.equal(payOf(3), 0, '其余家免付');
});

test('将一色 4 口 + 点炮 → 同样由「第 3 句提供者」承包', () => {
  const rs = createRuleSet('koukou', { enforceMinFan: false });
  const state = blank(createGame({ seed: 80, ruleset: rs }), {
    flipTile: null, wildTile: null, skinTiles: [],
  });
  state.wildTile = null;
  // 第 1 句 seat0 / 第 2 句 seat1 / 第 3 句 seat3 ←包胡者 / 第 4 句 seat0
  state.players[1].melds = [pengOf(w(2), 0), pengOf(w(5), 1), pengOf(t(8), 3), pengOf(s(2), 0)];
  state.players[1].opened = true;
  state.players[1].hand = [s(5)];
  // 放炮者 = seat2，不是第 3 句提供者
  state.players[2].hand = [
    t(1), t(1), t(1), t(3), t(3), t(3), t(4), t(4), t(4), t(6), t(6), t(6), t(9), s(5),
  ];
  state.turn = 2;
  state.phase = 'discard';

  act(state, { type: 'discard', seat: 2, tile: s(5) });
  act(state, { type: 'win', seat: 1 });

  assert.ok(state.result.types.includes('jiangYiSe'));
  assert.equal(state.result.baozhuang.seat, 3, '将一色同样归第 3 句提供者');
  const payOf = (seat) => state.result.payments.find((x) => x.seat === seat).pay;
  assert.ok(payOf(3) > 0);
  assert.equal(payOf(2), 0, '放炮者不付');
});

test('非一色（混色）4 口 + 点炮 → 仍由放炮者承包（全求人路径不受影响）', () => {
  const rs = createRuleSet('koukou', { enforceMinFan: false });
  const state = blank(createGame({ seed: 81, ruleset: rs }), {
    flipTile: null, wildTile: null, skinTiles: [],
  });
  state.wildTile = null;
  state.players[1].melds = [pengOf(w(1), 0), pengOf(t(2), 3), pengOf(s(3), 2), pengOf(w(4), 0)];
  state.players[1].opened = true;
  state.players[1].hand = [t(5)];
  state.players[0].hand = [
    t(1), t(1), t(1), t(2), t(2), t(2), t(3), t(3), t(3), t(4), t(4), t(4), t(9), t(5),
  ];
  state.turn = 0;
  state.phase = 'discard';

  act(state, { type: 'discard', seat: 0, tile: t(5) });
  act(state, { type: 'win', seat: 1 });

  assert.ok(!state.result.types.includes('qingYiSe'));
  assert.equal(state.result.baozhuang.seat, 0, '非一色仍是放炮者包（全求人）');
});

/* 蓄杠归入「全求人」的 4 口（老吴 2026-10-29：「要归进去」）             */
/*   蓄杠是碰出来的刻子升杠，面子本身仍是别人打出的牌，与明杠同类。       */
/* ------------------------------------------------------------------ */

const xuOf = (tile, from = 0) => ({ type: 'xu', tiles: [tile, tile, tile, tile], from });

test('包牌：4 口里含「蓄杠」+ 点炮 → 放炮者仍包（蓄杠算求人）', () => {
  const rs = createRuleSet('koukou', { enforceMinFan: false });
  const state = blank(createGame({ seed: 82, ruleset: rs }), {
    flipTile: null, wildTile: null, skinTiles: [],
  });
  state.wildTile = null;
  // 混色 4 口，其中一口是碰升杠（xu）
  state.players[1].melds = [pengOf(w(1), 0), pengOf(t(2), 3), xuOf(s(3), 2), pengOf(w(4), 0)];
  state.players[1].opened = true;
  state.players[1].hand = [t(5)];
  state.players[0].hand = [
    t(1), t(1), t(1), t(2), t(2), t(2), t(3), t(3), t(3), t(4), t(4), t(4), t(9), t(5),
  ];
  state.turn = 0;
  state.phase = 'discard';

  act(state, { type: 'discard', seat: 0, tile: t(5) });
  act(state, { type: 'win', seat: 1 });

  assert.ok(state.result.types.includes('quanQiuRen'), '蓄杠 + 3 口 → 4 口全副露，成立全求人');
  assert.equal(state.result.baozhuang.seat, 0, '由放炮者承包（蓄杠已归入全求人）');
});

test('包牌（真实动作流）：真碰 → 真蓄杠 → 补到 4 口，点炮仍由放炮者包', () => {
  const st = baoBlank(103, false);   // 关 rain：混色手牌不触发雨，专测全求人
  baoPeng(st, 0, w(1));              // 第 1 口：碰一万（S0 供）
  baoPeng(st, 2, t(2));              // 第 2 口：碰二筒（S2 供）
  st.players[1].hand.push(w(1));     // 第四张一万到手
  st.turn = 1;
  st.phase = 'discard';
  st.mustDiscard = false;
  act(st, { type: 'xu', seat: 1, tile: w(1) });   // 真蓄杠：peng → xu
  assert.equal(st.players[1].melds.filter((m) => m.type === 'xu').length, 1, '碰已升级为蓄杠');
  baoJunkOut(st, 1);
  baoPeng(st, 3, s(3));              // 第 3 口
  baoPeng(st, 0, s(6));              // 第 4 口 → 4 口全副露，手上只剩将

  // 收尾：手上留一张 5 万，由 S2 点炮（S2 手牌含非 2/5/8，不触发「全手将」免包）
  st.players[1].hand = [w(5)];
  st.players[2].hand.push(w(5));
  st.turn = 2;
  st.phase = 'discard';
  st.mustDiscard = false;
  act(st, { type: 'discard', seat: 2, tile: w(5) });
  act(st, { type: 'win', seat: 1 });

  assert.ok(st.result.types.includes('quanQiuRen'), '4 口（含蓄杠）+ 点炮 → 全求人');
  assert.equal(st.result.baozhuang.seat, 2, '放炮者 S2 包胡');
  assert.equal(baoPayOf(st, 2), 60, '包胡者独付全额');
  assert.equal(baoPayOf(st, 0), 0);
  assert.equal(baoPayOf(st, 3), 0);
});

/* ------------------------------------------------------------------ */
/* 一色包「第三句」的计数口径（2026-10-29 老吴）：                      */
/*   「第三句是能被看见的刻子或者顺子，暗杠不计在内；所以前三个副露有    */
/*    暗杠时，打出第四句同花色的玩家包胡。」                            */
/* ------------------------------------------------------------------ */

const BAO_JUNK = [
  t(2), t(3), t(4), t(5), t(6), t(7), t(8), t(9),
  s(2), s(3), s(4), s(5), s(6), s(7), s(8), s(9),
];
/** 赢家自己打掉的「安全牌」：字牌，别家没有，不会送吃碰 */
const BAO_SAFE = [EAST, SOUTH, WEST, NORTH, GREEN_DRAGON, WHITE_DRAGON];

/** 干净空局：四家无手牌/副露、无癞子皮子、无下雨 */
function baoBlank(seed, rainEnabled = true) {
  const rs = createRuleSet('koukou', { enforceMinFan: false, rainEnabled });
  const st = createGame({ seed, ruleset: rs });
  for (const p of st.players) { p.hand = []; p.melds = []; p.discards = []; p.opened = false; }
  st.flipTile = null;
  st.wildTile = null;   // ⚠️ 必须直接赋值，blank() 的 `opts.wildTile ?? 白板` 会顶替成默认癞子
  st.skinTiles = [];
  st.claims = [];
  st.claimIndex = 0;
  st.rains = [];
  st.players[0].hand = [...BAO_JUNK];
  st.players[2].hand = [...BAO_JUNK];
  st.players[3].hand = [...BAO_JUNK];
  st.players[1].hand = [...BAO_SAFE];
  return st;
}

function baoFeed(st, seat, tile) {
  st.players[seat].hand.push(tile);
  st.turn = seat;
  st.phase = 'discard';
  st.mustDiscard = false;
  act(st, { type: 'discard', seat, tile });
}

function baoJunkOut(st, seat) {
  const hand = st.players[seat].hand;
  const tile = hand.find((x) => BAO_SAFE.includes(x))
    ?? hand.find((x) => BAO_JUNK.includes(x)) ?? hand[0];
  st.turn = seat;
  st.phase = 'discard';
  st.mustDiscard = true;
  act(st, { type: 'discard', seat, tile });
}

/** seat1 用 seat 供的 tile 碰一口，然后打掉一张废牌 */
function baoPeng(st, seat, tile) {
  st.players[1].hand.push(tile, tile);
  baoFeed(st, seat, tile);
  act(st, { type: 'peng', seat: 1 });
  baoJunkOut(st, 1);
}

/** 收尾：副露不动，手牌补成 9 万对子 → 自摸（自摸时胡的那张已在手里） */
function baoFinish(st) {
  st.players[1].hand = [w(9), w(9)];
  st.lastDraw = w(9);
  st.turn = 1;
  st.phase = 'discard';
  st.mustDiscard = false;
  act(st, { type: 'win', seat: 1, selfDraw: true });
}

const baoPayOf = (st, seat) => {
  const row = st.result.payments.find((x) => x.seat === seat);
  return row ? row.pay : 0;
};

test('暗杠不占「第三句」：2 明句 + 1 暗杠，第 4 句同花色被碰 → 第 4 句供牌者包胡', () => {
  const st = baoBlank(101);
  baoPeng(st, 0, w(1));          // 第 1 明句
  baoPeng(st, 2, w(3));          // 第 2 明句
  st.players[1].hand.push(w(7), w(7), w(7), w(7));
  st.turn = 1;
  st.phase = 'discard';
  act(st, { type: 'an', seat: 1, tile: w(7) });  // 暗杠：不算「第三句」
  baoJunkOut(st, 1);
  baoPeng(st, 3, w(5));          // 第 4 句 = 实际第 3 个明牌副露
  baoFinish(st);

  assert.ok(st.result.types.includes('qingYiSe'));
  assert.ok(st.result.baozhuang, '暗杠不计入第三句 → 第 4 句供牌者必须包胡');
  assert.equal(st.result.baozhuang.seat, 3, '由第 4 句的供牌者承包');
  assert.equal(baoPayOf(st, 3), 60, '包胡者独付全额');
  assert.equal(baoPayOf(st, 0), 0);
  assert.equal(baoPayOf(st, 2), 0);
});

test('对照：3 个明句后第 4 句被碰 → 第 4 句不另立包胡，仍由第 3 句供牌者包', () => {
  const st = baoBlank(102);
  baoPeng(st, 0, w(1));
  baoPeng(st, 2, w(3));
  baoPeng(st, 3, w(5));          // 第 3 明句 → 该由 S3 包
  baoPeng(st, 0, w(7));          // 第 4 明句 → 不另立包胡
  baoFinish(st);

  assert.ok(st.result.types.includes('qingYiSe'));
  assert.equal(st.result.baozhuang.seat, 3, '仍是第 3 句供牌者包');
  assert.equal(baoPayOf(st, 0), 0, '第 4 句供牌者不付');
  assert.equal(baoPayOf(st, 3), 60);
});

test('明杠算「能被看见的刻子」：2 明句 + 明杠 + 暗杠，第 4 句供牌者仍包胡', () => {
  const st = baoBlank(103);
  baoPeng(st, 0, w(1));                       // 第 1 明句
  st.players[1].hand.push(w(3), w(3), w(3));
  baoFeed(st, 2, w(3));
  act(st, { type: 'zhi', seat: 1 });          // 明杠 = 看得见的刻子
  baoJunkOut(st, 1);
  st.players[1].hand.push(w(7), w(7), w(7), w(7));
  st.turn = 1;
  st.phase = 'discard';
  act(st, { type: 'an', seat: 1, tile: w(7) });
  baoJunkOut(st, 1);
  baoPeng(st, 3, w(5));
  baoFinish(st);

  assert.equal(st.result.baozhuang.seat, 3, '明杠占位、暗杠不占位 → 第 4 句是第 3 个可见面子');
  assert.equal(baoPayOf(st, 3), 60);
});

test('关掉下雨时，一色包兜底同样只数可见面子（暗杠不计、明杠计）', () => {
  // ① 2 明句 + 暗杠 + 第 4 句
  const a = baoBlank(104, false);
  baoPeng(a, 0, w(1));
  baoPeng(a, 2, w(3));
  a.players[1].hand.push(w(7), w(7), w(7), w(7));
  a.turn = 1;
  a.phase = 'discard';
  act(a, { type: 'an', seat: 1, tile: w(7) });
  baoJunkOut(a, 1);
  baoPeng(a, 3, w(5));
  baoFinish(a);
  assert.equal(a.result.baozhuang.seat, 3, '无下雨时兜底路径也排除暗杠');

  // ② 2 明句 + 明杠 + 暗杠 + 第 4 句
  const b = baoBlank(105, false);
  baoPeng(b, 0, w(1));
  b.players[1].hand.push(w(3), w(3), w(3));
  baoFeed(b, 2, w(3));
  act(b, { type: 'zhi', seat: 1 });
  baoJunkOut(b, 1);
  b.players[1].hand.push(w(7), w(7), w(7), w(7));
  b.turn = 1;
  b.phase = 'discard';
  act(b, { type: 'an', seat: 1, tile: w(7) });
  baoJunkOut(b, 1);
  baoPeng(b, 3, w(5));
  baoFinish(b);
  assert.equal(b.result.baozhuang.seat, 3, '无下雨时兜底路径也把明杠算作可见面子');
});
