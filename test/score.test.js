/**
 * 番型与算分测试 —— 武汉红中赖子杠
 *
 * 覆盖：
 *   · 三道胡牌闸门（红中留手 / 皮子留手 / 没开口）
 *   · 小胡（屁胡）与 258 将限制
 *   · 大胡五种牌型 + 三种情境；第一种 3 番底，每多一种只 +1 番（bigHuBase + bigHuExtra）
 *   · 硬胡 / 软胡，含「癞子还原」情形
 *   · 分段计分表：每家输分按「**自家番数 + 赢家番数**」查表、单家封顶、金顶
 *   · 开口番 vs 口口番
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toCounts,
  makeTile,
  tileName,
  RED_DRAGON,
  GREEN_DRAGON,
  WHITE_DRAGON,
  EAST,
  SOUTH,
  WEST,
  NORTH,
} from '../src/engine/tiles.js';
import {
  evaluateWin,
  computePayment,
  countFan,
  settleRound,
  winnerFanPreview,
  eyeIs258,
  isQingYiSe,
  isJiangYiSe,
  isFengYiSe,
  shapeFreeBigHu,
} from '../src/engine/score.js';
import { createRuleSet } from '../src/engine/rules.js';
import { createGame } from '../src/engine/game.js';

const w = (n) => makeTile('wan', n);
const t = (n) => makeTile('tong', n);
const s = (n) => makeTile('tiao', n);
const Z = RED_DRAGON;

const RS = createRuleSet('koukou');

const NEUTRAL_CTX = {
  selfDraw: false,
  from: 1,
  gangShangKaiHua: false,
  haiDiLao: false,
  qiangGangHu: false,
};

/** 评估一手牌：默认「已开口」（武汉必须开口才能胡） */
function ev(hand, opts = {}) {
  return evaluateWin({
    counts: toCounts(hand),
    melds: opts.melds ?? [],
    opened: opts.opened ?? true,
    context: { ...NEUTRAL_CTX, ...(opts.context ?? {}) },
    ruleset: opts.ruleset ?? RS,
    wildTile: opts.wildTile ?? null,
    skinTiles: opts.skinTiles ?? [],
  });
}

const hasType = (res, key) => res.legal && res.types.includes(key);

/* ------------------------------------------------------------------ */
/* 小胡                                                                */
/* ------------------------------------------------------------------ */

test('小胡（屁胡）：没有基础番（番底 0），且判为硬胡', () => {
  const hand = [w(1), w(2), w(3), w(4), w(5), w(6), t(7), t(8), t(9), t(5), t(5), t(5), s(5), s(5)];
  assert.equal(hand.length, 14);
  const r = ev(hand);
  assert.equal(r.legal, true, r.reason);
  assert.equal(r.size, 'small');
  assert.deepEqual(r.types, []);
  // 老吴 2026-09-30：小胡不单独加这一番（旧口径 baseFan = 1）
  assert.equal(r.baseFan, 0);
  assert.equal(r.hardWin, true, '一张癞子都没用 → 硬胡');
  assert.equal(r.wildUsed, 0);
});

test('小胡必须 2/5/8 作将：9 条作将不成立', () => {
  const bad = [w(1), w(2), w(3), w(4), w(5), w(6), t(7), t(8), t(9), t(5), t(5), t(5), s(9), s(9)];
  const r = ev(bad);
  assert.equal(r.legal, false);
  assert.match(r.reason, /不满足胡牌条件/);
  // 关掉这条限制就能胡
  const off = ev(bad, { ruleset: createRuleSet('koukou', { smallHuNeeds258Eye: false }) });
  assert.equal(off.legal, true, off.reason);
});

test('小胡限制：手里两张癞子不能胡小胡', () => {
  // 癞子故意选一筒而不是红中 —— 红中留手会被「红中闸门」先拦下，测不到这一条
  const WILD = t(1);
  const hand = [w(1), w(2), w(3), w(4), w(5), w(6), t(7), t(8), t(9), s(5), s(5), s(9), WILD, WILD];
  const r = ev(hand, { wildTile: WILD });
  assert.equal(r.legal, false, '两个癞子在手里，小胡不成立');
  assert.match(r.reason, /不满足胡牌条件/);

  const loose = ev(hand, { wildTile: WILD, ruleset: createRuleSet('koukou', { maxWildsForSmallHu: 2 }) });
  assert.equal(loose.legal, true, loose.reason);
  assert.equal(loose.size, 'small');
});

/* ------------------------------------------------------------------ */
/* 三道闸门                                                            */
/* ------------------------------------------------------------------ */

test('闸门：手里有红中不能胡（结构成立也不行）', () => {
  const hand = [w(1), w(2), w(3), w(4), w(5), w(6), t(7), t(8), t(9), Z, Z, Z, s(5), s(5)];
  const blocked = ev(hand);
  assert.equal(blocked.legal, false);
  assert.match(blocked.reason, /红中/);

  const off = ev(hand, { ruleset: createRuleSet('koukou', { redDragonInHandBlocksWin: false }) });
  assert.equal(off.legal, true, off.reason);
  assert.equal(off.size, 'small');
});

test('闸门：手里有皮子不能胡', () => {
  // 本局皮子设成九筒（避开红中，免得被红中闸门抢答）
  const hand = [w(1), w(2), w(3), w(4), w(5), w(6), t(7), t(8), t(9), t(5), t(5), t(5), s(5), s(5)];
  const blocked = ev(hand, { skinTiles: [t(9)] });
  assert.equal(blocked.legal, false);
  assert.match(blocked.reason, /皮子/);

  const off = ev(hand, {
    skinTiles: [t(9)],
    ruleset: createRuleSet('koukou', { skinInHandBlocksWin: false }),
  });
  assert.equal(off.legal, true, off.reason);
});

test('闸门：没开口不能胡（武汉必须开口）', () => {
  const hand = [w(1), w(2), w(3), w(4), w(5), w(6), t(7), t(8), t(9), t(5), t(5), t(5), s(5), s(5)];
  const closed = ev(hand, { opened: false });
  assert.equal(closed.legal, false);
  assert.match(closed.reason, /开口/);

  assert.equal(ev(hand, { opened: true }).legal, true);
  assert.equal(
    ev(hand, { opened: false, ruleset: createRuleSet('koukou', { mustOpen: false }) }).legal,
    true,
  );
});

/* ------------------------------------------------------------------ */
/* 大胡：五种牌型 + 可累计                                              */
/* ------------------------------------------------------------------ */

test('大胡·碰碰胡：番底 3（bigHuBase）', () => {
  const hand = [w(1), w(1), w(1), w(2), w(2), w(2), t(3), t(3), t(3), s(4), s(4), s(4), s(9), s(9)];
  const r = ev(hand);
  assert.equal(r.legal, true, r.reason);
  assert.equal(r.size, 'big');
  assert.deepEqual(r.types, ['pengpengHu']);
  assert.equal(r.baseFan, 3);
});

test('大胡·清一色', () => {
  const hand = [w(1), w(2), w(3), w(4), w(5), w(6), w(7), w(8), w(9), w(1), w(2), w(3), w(5), w(5)];
  const r = ev(hand);
  assert.equal(r.legal, true, r.reason);
  assert.ok(hasType(r, 'qingYiSe'));
});

test('大胡可累计：碰碰胡 + 清一色 = 4 番底（3 + 1）', () => {
  const hand = [w(1), w(1), w(1), w(2), w(2), w(2), w(3), w(3), w(3), w(4), w(4), w(4), w(9), w(9)];
  const r = ev(hand);
  assert.equal(r.legal, true, r.reason);
  assert.equal(r.types.length, 2);
  assert.ok(r.types.includes('pengpengHu'));
  assert.ok(r.types.includes('qingYiSe'));
  assert.equal(r.baseFan, 4);
  // 把叠加番调回 3 即可复现旧口径（2 种 × 3 = 6），证明开关真的被读到。
  const legacy = ev(hand, { ruleset: createRuleSet('koukou', { fan: { bigHuExtra: 3 } }) });
  assert.equal(legacy.baseFan, 6);
});

test('大胡·将一色：全 2/5/8', () => {
  const hand = [w(2), w(2), w(2), w(5), w(5), w(5), w(8), w(8), w(8), t(2), t(2), t(2), t(5), t(5)];
  const r = ev(hand);
  assert.equal(r.legal, true, r.reason);
  assert.ok(hasType(r, 'jiangYiSe'));
  assert.ok(hasType(r, 'pengpengHu'));
  assert.equal(r.baseFan, 4);
});

test('大胡·风一色：全字牌，自摸与点炮都能胡（老吴 2026-10-01：没有「全字牌必须自摸」这回事）', () => {
  const hand = [
    EAST, EAST, EAST, SOUTH, SOUTH, SOUTH, WEST, WEST, WEST, NORTH, NORTH, NORTH,
    GREEN_DRAGON, GREEN_DRAGON,
  ];
  const zimo = ev(hand, { context: { selfDraw: true } });
  assert.equal(zimo.legal, true, zimo.reason);
  assert.ok(hasType(zimo, 'fengYiSe'));
  assert.ok(hasType(zimo, 'pengpengHu'));
  assert.equal(zimo.baseFan, 4);

  // ❗老吴 2026-10-01：「全字牌必须自摸，没有这个约束……其他牌型可以接冲」
  //   → 风一色点炮同样能胡（旧闸门 ziYiSeMustSelfDraw 已删除）
  const dianpao = ev(hand, { context: { selfDraw: false, from: 1 } });
  assert.equal(dianpao.legal, true, '风一色点炮应该能胡（可以接冲）：' + dianpao.reason);
  assert.ok(hasType(dianpao, 'fengYiSe'));
});

test('大胡·全求人：四副露 + 单吊将', () => {
  const melds = [
    { type: 'chi', tiles: [w(1), w(2), w(3)], from: 3 },
    { type: 'peng', tiles: [w(5), w(5), w(5)], from: 2 },
    { type: 'peng', tiles: [t(3), t(3), t(3)], from: 1 },
    { type: 'peng', tiles: [t(7), t(7), t(7)], from: 3 },
  ];
  const r = ev([s(9), s(9)], { melds });
  assert.equal(r.legal, true, r.reason);
  assert.ok(hasType(r, 'quanQiuRen'));
  assert.equal(r.baseFan, 3, '副露里有吃 → 不算碰碰胡，只有全求人');
});

test('大胡·情境番：杠上开花 / 海底捞 / 抢杠胡', () => {
  const hand = [w(1), w(2), w(3), w(4), w(5), w(6), t(7), t(8), t(9), t(5), t(5), t(5), s(5), s(5)];
  const r = ev(hand, {
    context: { selfDraw: true, gangShangKaiHua: true, haiDiLao: true },
  });
  assert.equal(r.legal, true, r.reason);
  assert.ok(hasType(r, 'gangShangKaiHua'));
  assert.ok(hasType(r, 'haiDiLao'));
  assert.equal(r.baseFan, 4, '两种情境大胡 → 3 + 1 = 4 番底');
});

test('海底捞 / 杠上开花：这两种大胡不算「自摸」那一番', () => {
  const hand = [w(1), w(1), w(1), w(2), w(2), w(2), t(3), t(3), t(3), s(4), s(4), s(4), s(9), s(9)];
  const winner = { seat: 0, name: 'A', melds: [], opened: true, isDealer: false };
  for (const key of ['gangShangKaiHua', 'haiDiLao']) {
    const r = ev(hand, { context: { selfDraw: true, [key]: true } });
    assert.equal(r.legal, true, r.reason);
    assert.ok(r.types.includes(key));
    const fan = countFan(winner, {
      ruleset: RS, isWinner: true, selfDraw: true, hardWin: r.hardWin,
      baseFan: r.baseFan, size: r.size, types: r.types,
    });
    assert.ok(!fan.details.some((d) => d.key === 'selfDraw'), `${key} 不该再有「自摸」番`);
    assert.equal(fan.total, r.baseFan + (r.hardWin ? 1 : 0), '只保留牌型番底 + 硬胡');

    // 关掉开关 → 回到旧口径，自摸仍 +1 番
    const legacyRS = createRuleSet('koukou', { fan: { specialBigHuNoSelfDrawFan: false } });
    const legacy = countFan(winner, {
      ruleset: legacyRS, isWinner: true, selfDraw: true, hardWin: r.hardWin,
      baseFan: r.baseFan, size: r.size, types: r.types,
    });
    assert.ok(legacy.details.some((d) => d.key === 'selfDraw'));
    assert.equal(legacy.total, fan.total + 1);
  }

  // 对照：普通大胡自摸仍照加「自摸」1 番
  const normal = ev(hand, { context: { selfDraw: true } });
  const normalFan = countFan(winner, {
    ruleset: RS, isWinner: true, selfDraw: true, hardWin: normal.hardWin,
    baseFan: normal.baseFan, size: normal.size, types: normal.types,
  });
  assert.ok(normalFan.details.some((d) => d.key === 'selfDraw'));

  // 结算与门槛预览必须同口径：海底捞 3（底）+ 1（硬胡）= 4 番，不是 5 番
  const players = [
    winner,
    { seat: 1, name: 'B', melds: [], opened: true, isDealer: false },
    { seat: 2, name: 'C', melds: [], opened: true, isDealer: false },
    { seat: 3, name: 'D', melds: [], opened: true, isDealer: false },
  ];
  const winnerResult = { size: 'big', types: ['haiDiLao'], baseFan: 3, hardWin: true };
  const context = { selfDraw: true, from: null };
  assert.equal(winnerFanPreview(winner, winnerResult, context, RS), 4);
  const settlement = settleRound({ players, winnerSeat: 0, winnerResult, context, ruleset: RS });
  assert.equal(settlement.winnerFan, 4);
  assert.ok(!settlement.winnerFanDetails.some((d) => d.key === 'selfDraw'));
  for (const p of settlement.payments) {
    assert.equal(p.effFan, 4);
    assert.equal(p.pay, 2, '大胡 4 番档 = 2 分（若多算自摸会落 5 番档 = 3 分）');
  }
});

test('大胡叠加对全部来源生效：第三种再加 1 番（碰碰胡 + 清一色 + 杠上开花 = 5）', () => {
  const hand = [w(1), w(1), w(1), w(2), w(2), w(2), w(3), w(3), w(3), w(4), w(4), w(4), w(9), w(9)];
  const r = ev(hand, { context: { selfDraw: true, gangShangKaiHua: true } });
  assert.equal(r.legal, true, r.reason);
  assert.equal(r.types.length, 3);
  assert.ok(hasType(r, 'pengpengHu'));
  assert.ok(hasType(r, 'qingYiSe'));
  assert.ok(hasType(r, 'gangShangKaiHua'));
  assert.equal(r.baseFan, 5, '3 + 1 + 1 = 5 番底');
});

test('闸门（已删除的反向对照）：全字牌点炮**能**胡 —— 老吴 2026-10-01 明确没有这条约束', () => {
  // 全字牌且无红中（避免被红中闸门先拦）：东×3 南×3 西×3 北×2 发财×3
  const honor = [
    EAST, EAST, EAST, SOUTH, SOUTH, SOUTH, WEST, WEST, WEST,
    NORTH, NORTH, GREEN_DRAGON, GREEN_DRAGON, GREEN_DRAGON,
  ];
  assert.equal(honor.length, 14);
  /* 旧实现有一道「字一色（见字胡 = 全字牌）必须自摸」闸门，老吴 2026-10-01 否定：
     「**全字牌必须自摸，没有这个约束，只有见字胡才是必须自摸，其他牌型可以接冲**」。
     这条用例就是那道闸门的墓碑 —— 以后谁再加回来，这里会立刻红。 */
  const rong = ev(honor, { context: { selfDraw: false, from: 1 } });
  assert.equal(rong.legal, true, '全字牌点炮应该能胡：' + rong.reason);
  const zimo = ev(honor, { context: { selfDraw: true } });
  assert.equal(zimo.legal, true, zimo.reason);
  assert.ok(hasType(zimo, 'fengYiSe'));
  assert.ok(hasType(zimo, 'pengpengHu'));
});

/* ------------------------------------------------------------------ */
/* 见字胡（老吴 2026-10-01）：点炮被禁（必须自摸），但抢杠不受此限        */
/* ------------------------------------------------------------------ */

test('见字胡：点炮被禁（必须自摸），但抢杠放行（老吴 2026-10-01 明确）', () => {
  // 癞子 = 一筒；手里一对九万 + 一张癞子，进张九万三张凑成九万刻（癞子顶一张）→ 见字胡
  // 其余三副顺子 + 五万将（258），整手除「九万刻含癞」外都是常规模型。
  const WILD = t(1);
  const hand = [
    w(5), w(5),            // 将（258）
    w(1), w(2), w(3),      // 顺
    t(4), t(5), t(6),      // 顺
    s(7), s(8), s(9),      // 顺
    w(9), w(9), WILD,      // 这对九万 + 癞子，进张九万即凑成刻（见字胡）
  ];
  assert.equal(hand.length, 14);

  // 点炮（接冲）：见字胡必须自摸 → 不成立
  const dian = ev(hand, {
    wildTile: WILD,
    context: { selfDraw: false, from: 1, winTile: w(9) },
  });
  assert.equal(dian.legal, false, '见字胡点炮应被禁止');
  assert.match(dian.reason, /见字胡/);

  // 抢杠：结构上不是接冲 → 见字胡闸门排除抢杠 → 允许胡，且抢杠是大胡（+3 番底）
  const qg = ev(hand, {
    wildTile: WILD,
    context: { selfDraw: false, from: 1, winTile: w(9), qiangGangHu: true },
  });
  assert.equal(qg.legal, true, '见字胡牌型应允许抢杠：' + qg.reason);
  assert.equal(qg.size, 'big', '抢杠是大胡');
  assert.ok(qg.types.includes('qiangGangHu'), '应挂 qiangGangHu 大胡牌型');
});

test('见将胡：4 副露 + 1 癞子单吊将，可以接炮（2026-10-22 老吴纠正）', () => {
  // 癞子 = 一筒；4 副露已固定，手里只剩癞子，进张二筒与癞子作将 → 见将胡。
  const WILD = t(1);
  const melds = [
    { type: 'peng', tiles: [w(3), w(3), w(3)], from: 1 },
    { type: 'peng', tiles: [t(6), t(6), t(6)], from: 1 },
    { type: 'peng', tiles: [s(9), s(9), s(9)], from: 1 },
    { type: 'chi', tiles: [t(3), t(4), t(5)], from: 3 },
  ];
  const rs = createRuleSet('koukou', { enforceMinFan: false });
  const dian = ev([WILD, t(2)], {
    melds,
    wildTile: WILD,
    ruleset: rs,
    context: { selfDraw: false, from: 1, winTile: t(2) },
  });
  assert.equal(dian.legal, true, '见将胡点炮应能胡：' + dian.reason);
  const zimo = ev([WILD, t(2)], {
    melds,
    wildTile: WILD,
    ruleset: rs,
    context: { selfDraw: true, winTile: t(2) },
  });
  assert.equal(zimo.legal, true, zimo.reason);
});

test('见将胡：不是 4 副露也成立 —— 2 副露 + 1 癞子单吊将接炮（2026-10-22）', () => {
  // 见将胡只取决于「癞子只补将、面子全是实的」，不要求 4 副露。
  const WILD = t(1);
  const melds = [
    { type: 'peng', tiles: [w(7), w(7), w(7)], from: 1 },
    { type: 'chi', tiles: [s(2), s(3), s(4)], from: 2 },
  ];
  const hand = [
    WILD, t(2),                    // 癞子 + 进张二筒作将（258）
    w(1), w(2), w(3),              // 顺
    t(4), t(5), t(6),              // 顺
  ];
  const rs = createRuleSet('koukou', { enforceMinFan: false });
  const dian = ev(hand, {
    melds,
    wildTile: WILD,
    ruleset: rs,
    context: { selfDraw: false, from: 1, winTile: t(2) },
  });
  assert.equal(dian.legal, true, '非 4 副露的见将胡点炮也应能胡：' + dian.reason);
});

test('见将胡：将里含癞子必须配 2/5/8 —— 杠出非将牌后不得胡（2026-10-23 缺陷回归）', () => {
  // 老吴实测：手上只剩 1 癞子（见将胡形），杠出一张三条（非将）后引擎误判可以胡。
  // 根因：4 副露全刻/杠时 isAllTriplets 对空拆解空真 → 整手判成碰碰胡（大胡），
  //       绕过了 258 将检查。现在「含癞子的将」一律要求配 2/5/8，大胡同样生效。
  const WILD = t(1);
  const melds = [
    { type: 'an', tiles: [w(3), w(3), w(3), w(3)], from: null },
    { type: 'peng', tiles: [w(6), w(6), w(6)], from: 1 },
    { type: 'peng', tiles: [t(6), t(6), t(6)], from: 1 },
    { type: 'peng', tiles: [s(9), s(9), s(9)], from: 1 },
  ];
  const rs = createRuleSet('koukou', { enforceMinFan: false });
  const bad = ev([WILD, s(3)], {
    melds,
    wildTile: WILD,
    ruleset: rs,
    context: { selfDraw: true, winTile: s(3) },
  });
  assert.equal(bad.legal, false, '进张三条不是 2/5/8，含癞子的将不成立');
  assert.match(bad.reason, /不满足胡牌条件/);
  // 换成二条（2/5/8）→ 见将胡成立；全刻副露 → 碰碰胡大胡
  const good = ev([WILD, s(2)], {
    melds,
    wildTile: WILD,
    ruleset: rs,
    context: { selfDraw: true, winTile: s(2) },
  });
  assert.equal(good.legal, true, good.reason);
  assert.equal(good.size, 'big');
  assert.ok(good.types.includes('pengpengHu'), '全刻副露 + 刻子形拆解 = 碰碰胡');
  // 将里**不含**癞子的大胡不受影响：癞子进刻子、实牌对作将照样胡
  const melds3 = [
    { type: 'an', tiles: [w(3), w(3), w(3), w(3)], from: null },
    { type: 'peng', tiles: [w(6), w(6), w(6)], from: 1 },
    { type: 'peng', tiles: [t(6), t(6), t(6)], from: 1 },
  ];
  const realEye = ev([s(2), s(2), w(9), w(9), WILD], {
    melds: melds3,
    wildTile: WILD,
    ruleset: rs,
    context: { selfDraw: true, winTile: s(2) },
  });
  assert.equal(realEye.legal, true, '癞子进刻子、实牌对作将的大胡不该被拦：' + realEye.reason);
  // 清一色例外（老吴 2026-10-09「清一色除外」）：全万副露 + 癞子配九万作将照样胡
  const wanMelds = [
    { type: 'an', tiles: [w(3), w(3), w(3), w(3)], from: null },
    { type: 'peng', tiles: [w(6), w(6), w(6)], from: 1 },
    { type: 'peng', tiles: [w(7), w(7), w(7)], from: 1 },
    { type: 'peng', tiles: [w(8), w(8), w(8)], from: 1 },
  ];
  const qing = ev([WILD, w(9)], {
    melds: wanMelds,
    wildTile: WILD,
    ruleset: rs,
    context: { selfDraw: true, winTile: w(9) },
  });
  assert.equal(qing.legal, true, '清一色下癞子配九万作将应能胡（清一色例外）：' + qing.reason);
  assert.ok(qing.types.includes('qingYiSe'));
});

/* ------------------------------------------------------------------ */
/* 硬胡 / 软胡（含癞子还原）                                             */
/* ------------------------------------------------------------------ */

test('软胡：癞子顶替别的牌时不算硬胡', () => {
  // 癞子 = 一筒；用癞子补上 3 万的位置 → 软胡
  const WILD = t(1);
  const hand = [w(1), w(2), WILD, w(4), w(5), w(6), t(7), t(8), t(9), t(5), t(5), t(5), s(5), s(5)];
  const r = ev(hand, { wildTile: WILD });
  assert.equal(r.legal, true, r.reason);
  assert.equal(r.hardWin, false, '癞子顶替了 3 万 → 软胡');
  assert.equal(r.wildUsed, 1);
});

test('硬胡·癞子还原：癞子当自己原牌用也算硬胡', () => {
  // 癞子 = 三万，手里这张三万正好用在 2-3-4 万里（就是它自己）→ 硬胡
  const WILD = w(3);
  const hand = [w(1), w(1), w(1), w(2), WILD, w(4), w(5), w(6), w(7), t(5), t(5), t(5), s(5), s(5)];
  assert.equal(hand.filter((x) => x === WILD).length, 1);
  const r = ev(hand, { wildTile: WILD });
  assert.equal(r.legal, true, r.reason);
  assert.equal(r.size, 'small');
  // 算番这一版拆解确实用掉了癞子（wildUsed > 0），但仍应判硬胡
  assert.ok(r.wildUsed > 0, '拆解层面用到了癞子');
  assert.equal(r.hardWin, true, '癞子还原成 3 万本身 → 应判硬胡');
});

/* ------------------------------------------------------------------ */
/* 算分：2 的幂次方                                                     */
/* ------------------------------------------------------------------ */

test('算分：power2 模式下输分 = 2^(赢家番 + 输家番)', () => {
  const rs = createRuleSet('koukou', { scoring: 'power2' });
  assert.equal(computePayment(0, 0, rs), 1);
  assert.equal(computePayment(3, 2, rs), 32);
  assert.equal(computePayment(10, 1, rs), 2048);
  assert.equal(computePayment(1, 0, rs), 2);
  assert.equal(computePayment(1, 1, rs), 4);
});

test('算分：table 模式下 computePayment 退化为乘积（仅对照，结算走计分表）', () => {
  const rs = createRuleSet('koukou', { scoring: 'table' });
  assert.equal(computePayment(6, 1, rs), 6);
  assert.equal(computePayment(3, 2, rs), 6);
});

test('算分：simple 模式下是番数相乘', () => {
  const simple = createRuleSet('koukou', { scoring: 'simple' });
  assert.equal(computePayment(3, 4, simple), 12);
});

test('结算（table）：大胡单种自摸硬胡 5 番 + 赢家是庄 → **大胡不算庄家番**（老吴 2026-10-03）', () => {
  const players = [
    { seat: 0, name: 'A', melds: [], opened: true, isDealer: true },
    { seat: 1, name: 'B', melds: [], opened: true, isDealer: false },
    { seat: 2, name: 'C', melds: [], opened: true, isDealer: false },
    { seat: 3, name: 'D', melds: [], opened: true, isDealer: false },
  ];
  const settlement = settleRound({
    players,
    winnerSeat: 0,
    winnerResult: { size: 'big', types: ['pengpengHu'], baseFan: 3, hardWin: true },
    context: { selfDraw: true, from: null },
    ruleset: RS,
  });
  // 赢家：3（大胡底）+ 1（自摸）+ 1（硬胡）= 5 番
  // ❗大胡**不算庄家番**（老吴 2026-10-03）→ 输家 0 番，effFan = 5 + 0 = 5
  //
  // ⚠️ 分数**真的降了**：大胡表 [[3,1],[4,2],[5,3],[6,5],[7,8]]
  //   旧口径 effFan 6 → 6 番档 = **5 分**；新口径 effFan 5 → 5 番档 = **3 分**。
  //   这就是老吴说的「会连带影响付分档位」，此处显式钉住，别被后人当 bug 改回去。
  assert.equal(settlement.winnerFan, 5);
  assert.equal(settlement.topType, null, '未三家封顶，不是金顶');
  for (const p of settlement.payments) {
    assert.equal(p.fan, 0, '大胡不算庄家番 → 输家 0 番');
    assert.ok(
      !p.fanDetails.some((d) => d.key === 'dealer'),
      '大胡的输家明细里不该出现庄家番',
    );
    assert.equal(p.effFan, 5);
    assert.equal(p.pay, 3, '5 番档 = 3 分（旧口径 6 番档是 5 分）');
  }
  assert.equal(settlement.totalWin, 9, '3 家 × 3 分 = 9 分（旧口径 15 分）');
  assert.match(settlement.text, /碰碰胡/);
});

test('结算（table）：大胡不算庄家番 · 反向对照（开关关掉 → 回到旧口径 6 番档）', () => {
  const mk = () => [
    { seat: 0, name: 'A', melds: [], opened: true, isDealer: true },
    { seat: 1, name: 'B', melds: [], opened: true, isDealer: false },
    { seat: 2, name: 'C', melds: [], opened: true, isDealer: false },
    { seat: 3, name: 'D', melds: [], opened: true, isDealer: false },
  ];
  const args = (ruleset) => ({
    players: mk(),
    winnerSeat: 0,
    winnerResult: { size: 'big', types: ['pengpengHu'], baseFan: 3, hardWin: true },
    context: { selfDraw: true, from: null },
    ruleset,
  });
  const off = settleRound(args(createRuleSet('koukou', { bigHuNoDealerFan: false })));
  assert.equal(off.winnerFan, 5);
  for (const p of off.payments) {
    assert.equal(p.fan, 1, '开关关掉 → 赢家是庄，各家照旧 +1 番');
    assert.equal(p.effFan, 6);
    assert.equal(p.pay, 5);
  }
  const on = settleRound(args(createRuleSet('koukou', { bigHuNoDealerFan: true })));
  for (const p of on.payments) {
    assert.equal(p.fan, 0, '开关打开 → 输家 0 番');
    assert.equal(p.effFan, 5);
  }
});

test('结算（table）：小胡**照算**庄家番（大胡免庄、小胡不免）', () => {
  const players = [
    { seat: 0, name: 'A', melds: [], opened: true, isDealer: true },
    { seat: 1, name: 'B', melds: [], opened: true, isDealer: false },
    { seat: 2, name: 'C', melds: [], opened: true, isDealer: false },
    { seat: 3, name: 'D', melds: [], opened: true, isDealer: false },
  ];
  const settlement = settleRound({
    players,
    winnerSeat: 0,
    winnerResult: { size: 'small', types: ['pingHu'], baseFan: 2 },
    context: { selfDraw: true, from: null },
    ruleset: RS,
  });
  assert.equal(settlement.size, 'small');
  for (const p of settlement.payments) {
    assert.ok(
      p.fanDetails.some((d) => d.key === 'dealer'),
      '小胡时庄家番必须照算',
    );
  }
});

test('结算（table）：风一色（全字牌）直接金顶 10 分', () => {
  const players = [
    { seat: 0, name: 'A', melds: [], opened: true, isDealer: true },
    { seat: 1, name: 'B', melds: [], opened: true, isDealer: false },
    { seat: 2, name: 'C', melds: [], opened: true, isDealer: false },
    { seat: 3, name: 'D', melds: [], opened: true, isDealer: false },
  ];
  const settlement = settleRound({
    players,
    winnerSeat: 0,
    winnerResult: { size: 'big', types: ['fengYiSe', 'pengpengHu'], baseFan: 6, hardWin: true },
    context: { selfDraw: true, from: null },
    ruleset: RS,
  });
  // 6（大胡底）+ 1（自摸）+ 1（硬胡）= 8 番；风一色直接金顶
  assert.equal(settlement.winnerFan, 8);
  assert.equal(settlement.topType, 'goldTop');
  for (const p of settlement.payments) assert.equal(p.pay, 10);
  assert.equal(settlement.totalWin, 30);
  assert.match(settlement.text, /金顶/);
  assert.match(settlement.text, /风一色/);
});

/* ------------------------------------------------------------------ */
/* 原赖 / 风赖 = 结算分数 ×2（老吴 2026-09-30 修正口径）                  */
/* ------------------------------------------------------------------ */

/** 三家输家的「自家番」分别是 0 / 1 / 2（**自摸**结算，避免「放冲 +1 番」的噪声） */
function fengLaiPlayers() {
  const peng = (n) => ({ type: 'peng', tiles: [w(n), w(n), w(n)], from: 0 });
  return [
    { seat: 0, name: 'A', melds: [], opened: true, isDealer: false },
    { seat: 1, name: 'B', melds: [], opened: true, isDealer: false }, // 0 番
    { seat: 2, name: 'C', melds: [peng(1)], opened: true, isDealer: false }, // 1 番
    { seat: 3, name: 'D', melds: [peng(2), peng(3)], opened: true, isDealer: false }, // 2 番
  ];
}

test('结算（table）：风赖 → 每笔分数 ×2（番数一点没变）', () => {
  const base = {
    players: fengLaiPlayers(),
    winnerSeat: 0,
    winnerResult: { size: 'big', types: ['pengpengHu'], baseFan: 3, hardWin: false },
    ruleset: RS,
  };
  // 赢家 3（大胡底）+ 1（自摸）= 4 番；三家 effFan = 4/5/6 → 大胡原文表 2/3/5 分
  const plain = settleRound({ ...base, context: { selfDraw: true, from: null } });
  assert.equal(plain.winnerFan, 4);
  assert.equal(plain.mul, 1);
  assert.deepEqual(plain.payments.map((p) => p.pay), [2, 3, 5]);
  assert.equal(plain.totalWin, 10);
  assert.equal(plain.topType, null, '只有 6~7 番，没到三封顶');

  // 加风赖：番数不变，分数整体 ×2
  const feng = settleRound({ ...base, context: { selfDraw: true, from: null, fengLai: true } });
  assert.equal(feng.winnerFan, 4, '风赖不加番');
  assert.equal(feng.mul, 2);
  assert.deepEqual(feng.payments.map((p) => p.pay), [4, 6, 10]);
  assert.equal(feng.totalWin, 20);
  assert.match(feng.text, /分数 ×2/);
});

test('结算（table）：原赖同样 ×2；原赖 + 风赖同时命中仍只 ×2（不叠成 ×4）', () => {
  const base = {
    players: fengLaiPlayers(),
    winnerSeat: 0,
    winnerResult: { size: 'big', types: ['pengpengHu'], baseFan: 3, hardWin: false },
    ruleset: RS,
  };
  const yl = settleRound({ ...base, context: { selfDraw: true, from: null, yuanLai: true } });
  assert.equal(yl.winnerFan, 4, '原赖不加番');
  assert.equal(yl.mul, 2);
  assert.deepEqual(yl.payments.map((p) => p.pay), [4, 6, 10]);

  const both = settleRound({ ...base, context: { selfDraw: true, from: null, yuanLai: true, fengLai: true } });
  assert.equal(both.mul, 2, '同时命中仍只 ×2');
  assert.deepEqual(both.payments.map((p) => p.pay), [4, 6, 10]);
});

/** 赢家 5（大胡底）+ 1（自摸）= 6 番 → 三家 effFan = 6/7/8 → 5/8/8 分，且只有两家封顶（不触发金顶） */
function bigFanPlayers(rs) {
  return {
    players: [
      { seat: 0, name: 'A', melds: [], opened: true, isDealer: false },
      { seat: 1, name: 'B', melds: [], opened: true, isDealer: false },
      { seat: 2, name: 'C', melds: [{ type: 'peng', tiles: [w(1), w(1), w(1)], from: 0 }], opened: true, isDealer: false },
      { seat: 3, name: 'D', melds: [{ type: 'peng', tiles: [w(2), w(2), w(2)], from: 0 }, { type: 'peng', tiles: [w(3), w(3), w(3)], from: 0 }], opened: true, isDealer: false },
    ],
    winnerSeat: 0,
    winnerResult: { size: 'big', types: ['pengpengHu', 'qingYiSe'], baseFan: 5, hardWin: false },
    context: { selfDraw: true, from: null, fengLai: true },
    ruleset: rs,
  };
}

test('结算（table）：**小胡也翻** —— 老吴 2026-09-30 拍板「2、都翻」', () => {
  const peng = (n) => ({ type: 'peng', tiles: [w(n), w(n), w(n)], from: 0 });
  const s = settleRound({
    players: [
      // 赢家：小胡（无牌型底番）+ 自摸 1 + 硬胡 1 + 开口 4 口 = 6 番
      { seat: 0, name: 'A', melds: [peng(1), peng(2), peng(3), peng(4)], opened: true, isDealer: false },
      { seat: 1, name: 'B', melds: [], opened: true, isDealer: false }, // 0 番
      { seat: 2, name: 'C', melds: [peng(5)], opened: true, isDealer: false }, // 1 番
      { seat: 3, name: 'D', melds: [peng(6), peng(7)], opened: true, isDealer: false }, // 2 番
    ],
    winnerSeat: 0,
    winnerResult: { size: 'small', types: [], baseFan: 0, hardWin: true },
    context: { selfDraw: true, from: null, fengLai: true },
    ruleset: RS,
  });
  assert.equal(s.winnerFan, 6, '小胡 6 番 = 0 底 + 自摸 1 + 硬胡 1 + 开口 4');
  // effFan = 6/7/8 → 小胡原文表 1/2/3 分；风赖 ×2 → 2/4/6（全部 ≤ 10，与封顶开关无关）
  assert.deepEqual(s.payments.map((p) => p.effFan), [6, 7, 8]);
  assert.deepEqual(s.payments.map((p) => p.pay), [2, 4, 6]);
  assert.equal(s.mul, 2, '小胡同样翻倍（不按胡牌大小区分）');
});

test('结算（table）：×2 后**不再被那个 10 分封顶夹住**（老吴 2026-09-30「不受普通 10 分封顶影响」）', () => {
  const rs = createRuleSet('koukou');
  assert.equal(rs.scaledPayCap, true, '新口径下仍然有一道封顶，只是封顶值跟着倍率走');
  const settlement = settleRound(bigFanPlayers(rs));
  assert.equal(settlement.topType, null, 'B 只到 6 番没封顶 → 不是金顶');
  assert.deepEqual(settlement.payments.map((p) => p.basePay), [5, 8, 8]);
  // 5×2 = 10；8×2 = 16 → **照付 16**（该家封顶 = 10×2×1 = 20，够不到）
  assert.deepEqual(settlement.payments.map((p) => p.pay), [10, 16, 16]);
  // 三家都是开着口的 → 各自封顶 = 10 × 赖2 × 1 = 20
  assert.deepEqual(settlement.payments.map((p) => p.payCap), [20, 20, 20]);
});

/** 大胡顶档调到 20 分（模拟「刻度上移」），用来把封顶真正顶到 —— 否则 8 分的自然上限够不到 20/40 */
const HIGH_TABLE = {
  scoreTable: { small: [[6, 1], [7, 2], [8, 3], [9, 5], [10, 8]], big: [[3, 1], [4, 2], [5, 3], [6, 5], [7, 20]] },
};

/**
 * 赢家 3（大胡底）+ 1（自摸）= 4 番 → 三家 effFan = 4 / 5 / (7 或 10) → 查表 2 / 3 / 20；
 * 只有 D 到顶档 → 不触发「三家全封顶」的金顶。
 *
 * ⚠️ `openedD` 必须**带着 D 的副露一起换**，否则夹具自相矛盾：
 *   · 开口   → 3 个**碰**   → openFan 3 → loserFan 3 → effFan 7  → 顶档 20 分
 *   · 未开口 → 3 个**暗杠** → 不算开口（`darkGangCountsAsOpen:false`，且不进口数），
 *              但每口 2 番 → gangAn 6 → loserFan 6 → effFan 10 ≥ 7 → 同样到顶档 20 分
 * （踩坑：早先只把 `opened` 置 false 而副露留着 3 个碰 —— 碰本身就是开口，既矛盾又多算了开口番。）
 */
function highCapPlayers(rs, openedD) {
  const peng = (n) => ({ type: 'peng', tiles: [w(n), w(n), w(n)], from: 0 });
  const anGang = (n) => ({ type: 'an', tiles: [w(n), w(n), w(n), w(n)] });
  return {
    players: [
      { seat: 0, name: 'A', melds: [], opened: true, isDealer: false },
      { seat: 1, name: 'B', melds: [], opened: true, isDealer: false },
      { seat: 2, name: 'C', melds: [peng(1)], opened: true, isDealer: false },
      { seat: 3, name: 'D', melds: openedD ? [peng(2), peng(3), peng(4)] : [anGang(2), anGang(3), anGang(4)], opened: openedD, isDealer: false },
    ],
    winnerSeat: 0,
    winnerResult: { size: 'big', types: ['pengpengHu'], baseFan: 3, hardWin: false },
    context: { selfDraw: true, from: null, fengLai: true },
    ruleset: rs,
  };
}

test('结算（table）：**有赖时封顶 20**（封顶值跟着倍率走，老吴 2026-09-30）', () => {
  const rs = createRuleSet('koukou', HIGH_TABLE);
  const s = settleRound(highCapPlayers(rs, true));
  assert.equal(s.topType, null, '只有 D 到顶档 → 不是金顶');
  assert.deepEqual(s.payments.map((p) => p.basePay), [2, 3, 20]);
  // D：20 ×2(风赖) = 40 → 封顶 10×2×1 = 20 把它夹回来
  assert.deepEqual(s.payments.map((p) => p.payCap), [20, 20, 20]);
  assert.deepEqual(s.payments.map((p) => p.pay), [4, 6, 20]);
});

test('结算（table）：**有赖 + 未开口时封顶 40**（未开口也 ×2，再翻一倍封顶）', () => {
  // ⚠️ 2026-10-24 起闷杠（暗杠）默认豁免阳光 —— 本用例专测「未开口翻倍 + 封顶」的算术，
  //    所以显式关掉闷杠豁免，用旧口径当数学习题（豁免本身另有用例）。
  const rs = createRuleSet('koukou', { ...HIGH_TABLE, menGangExemptsSunny: false });
  const s = settleRound(highCapPlayers(rs, false)); // D 未开口（3 暗杠，暗杠不算开口）
  assert.equal(s.topType, null, '只有 D 到顶档 → 不是金顶');
  const d = s.payments.find((p) => p.seat === 3);
  assert.equal(d.opened, false);
  assert.equal(d.payCap, 40, '未开口 → 封顶 10×2×2 = 40');
  // D：查表 20 ×2(风赖) = 40，再 ×2(未开口) = 80 → 被 40 夹回来
  assert.equal(d.pay, 40, 'D = min(20×2×2, 40) = 40');
  // B（已开口）：2×2 = 4；C（已开口）：3×2 = 6 —— 两家都没有未开口翻倍，也就够不到自己的封顶 20
  assert.deepEqual(s.payments.map((p) => p.pay), [4, 6, 40]);
  assert.deepEqual(s.payments.map((p) => p.payCap), [20, 20, 40], '已开口 20 / 未开口 40');
});

test('结算（table）：关掉 scaledPayCap → 完全不封顶（当前刻度下结果一样，因为本来就不触发）', () => {
  const rs = createRuleSet('koukou', { ...HIGH_TABLE, scaledPayCap: false });
  const s = settleRound(highCapPlayers(rs, true));
  // D：20 ×2 = 40，不再夹到 20
  assert.deepEqual(s.payments.map((p) => p.pay), [4, 6, 40]);
});

test('结算（table）：当前原文刻度下封顶**永不触发** —— 单笔自然上限只到 16 / 32', () => {
  const rs = createRuleSet('koukou');
  const opened = settleRound(bigFanPlayers(rs));
  assert.ok(opened.payments.every((p) => p.pay < p.payCap), '已开口：16 < 20，封顶不触发');
  const unopened = settleRound({
    players: [
      { seat: 0, name: 'A', melds: [], opened: true, isDealer: false },
      { seat: 1, name: 'B', melds: [], opened: false, isDealer: false },
      { seat: 2, name: 'C', melds: [], opened: false, isDealer: false },
      { seat: 3, name: 'D', melds: [{ type: 'peng', tiles: [w(1), w(1), w(1)], from: 0 }, { type: 'peng', tiles: [w(2), w(2), w(2)], from: 0 }, { type: 'peng', tiles: [w(3), w(3), w(3)], from: 0 }], opened: false, isDealer: false },
    ],
    winnerSeat: 0,
    winnerResult: { size: 'big', types: ['pengpengHu', 'qingYiSe'], baseFan: 5, hardWin: false },
    context: { selfDraw: true, from: null, fengLai: true },
    ruleset: rs,
  });
  // D：查表 8 ×2(风赖) ×2(未开口) = 32 —— 全表自然上限，仍 < 封顶 40
  assert.equal(unopened.payments.find((p) => p.seat === 3).pay, 32);
  assert.ok(unopened.payments.every((p) => p.pay < p.payCap), '未开口：32 < 40，封顶仍不触发');
});

test('结算（table）：特殊杠不算开口，不按「被阳光」翻倍；闷杠同样豁免（2026-10-24 开关默认开）', () => {
  const players = [
    { seat: 0, name: 'A', melds: [], opened: true, isDealer: false },
    { seat: 1, name: 'B', melds: [{ type: 'skin', tiles: [w(9)], from: null }], opened: false, isDealer: false },
    { seat: 2, name: 'C', melds: [{ type: 'an', tiles: [w(8), w(8), w(8), w(8)], from: null }], opened: false, isDealer: false },
    { seat: 3, name: 'D', melds: [], opened: true, isDealer: false },
  ];
  const s = settleRound({
    players,
    winnerSeat: 0,
    winnerResult: { size: 'big', types: ['pengpengHu'], baseFan: 3, hardWin: true },
    context: { selfDraw: true, from: null },
    ruleset: RS,
  });
  const b = s.payments.find((x) => x.seat === 1);
  const c = s.payments.find((x) => x.seat === 2);
  assert.equal(b.opened, false, '皮子杠不算开口');
  assert.equal(b.sunny, false, '有皮子杠 → 不算被阳光');
  assert.equal(b.payCap, 10, '不被阳光 → 上限不翻倍');
  assert.equal(b.pay, b.basePay, '有特殊杠 → 本笔不翻倍');
  assert.equal(c.sunny, false, '闷杠（暗杠）同样豁免阳光（老吴 2026-10-24）');
  assert.equal(c.payCap, 10, '闷杠豁免 → 上限不翻倍');
  assert.equal(c.pay, c.basePay, '闷杠豁免 → 本笔不翻倍');

  // 关掉开关 → 回到旧口径「暗杠不豁免」
  const legacy = settleRound({
    players,
    winnerSeat: 0,
    winnerResult: { size: 'big', types: ['pengpengHu'], baseFan: 3, hardWin: true },
    context: { selfDraw: true, from: null },
    ruleset: createRuleSet('koukou', { menGangExemptsSunny: false }),
  });
  const c2 = legacy.payments.find((x) => x.seat === 2);
  assert.equal(c2.sunny, true, '开关关掉 → 暗杠仍算被阳光（旧口径对照）');
  assert.equal(c2.pay, c2.basePay * 2);
});

test('连金 / 反金（老吴 2026-10-24）：赢家番 +1、只算一次、开关可关', () => {
  const player = { seat: 0, melds: [] };
  const base = countFan(player, {
    ruleset: RS, isWinner: true, baseFan: 3, size: 'big', types: ['pengpengHu'], selfDraw: true,
  });
  const lian = countFan(player, {
    ruleset: RS, isWinner: true, baseFan: 3, size: 'big', types: ['pengpengHu'], selfDraw: true,
    lianJin: true,
  });
  assert.equal(lian.total, base.total + 1, '连金 +1 番');
  assert.ok(lian.details.some((d) => d.key === 'lianJin' && d.fan === 1), '明细带「连金 1」');
  const fan = countFan(player, {
    ruleset: RS, isWinner: true, baseFan: 3, size: 'big', types: ['pengpengHu'], selfDraw: true,
    fanJin: true,
  });
  assert.equal(fan.total, base.total + 1, '反金 +1 番');
  assert.ok(fan.details.some((d) => d.key === 'fanJin' && d.fan === 1));
  // 输家永远不加（连金/反金只记在赢家头上）
  const loser = countFan(player, { ruleset: RS, isWinner: false, lianJin: true, fanJin: true });
  assert.ok(!loser.details.some((d) => d.key === 'lianJin' || d.key === 'fanJin'));
  // 开关关掉 → 不加
  const off = countFan(player, {
    ruleset: createRuleSet('koukou', { lianJinEnabled: false, fanJinEnabled: false }),
    isWinner: true, baseFan: 3, size: 'big', types: ['pengpengHu'], selfDraw: true,
    lianJin: true, fanJin: true,
  });
  assert.equal(off.total, base.total, '两个开关都关 → 回到旧口径');
});

test('createGame 记录 prevWinnerSeat（连金/反金判据来源）', () => {
  const st = createGame({ seed: 5, prevWinnerSeat: 2 });
  assert.equal(st.prevWinnerSeat, 2);
  const st2 = createGame({ seed: 5 });
  assert.equal(st2.prevWinnerSeat, null);
});

test('结算（table）：**未开口也乘以二**，且不受那个 10 分封顶影响（老吴 2026-09-30 明确）', () => {
  const rs = createRuleSet('koukou');
  const players = [
    { seat: 0, name: 'A', melds: [], opened: true, isDealer: false },
    { seat: 1, name: 'B', melds: [], opened: false, isDealer: false }, // 未开口
    { seat: 2, name: 'C', melds: [], opened: false, isDealer: false }, // 未开口
    { seat: 3, name: 'D', melds: [], opened: true, isDealer: false },
  ];
  const base = {
    players,
    winnerSeat: 0,
    winnerResult: { size: 'big', types: ['pengpengHu'], baseFan: 5, hardWin: false },
    ruleset: rs,
    // 赢家 5 + 1(自摸) = 6 番 → 三家 effFan = 6/6/6 → 大胡表 5 分
    context: { selfDraw: true, from: null, fengLai: true },
  };
  const s = settleRound(base);
  // B / C：5 ×2(未开口) ×2(风赖) = 20（> 普通 10 分，照样付）；D：5 ×2 = 10
  assert.deepEqual(s.payments.map((p) => p.pay), [20, 20, 10]);
  // 封顶：未开口 40 / 已开口 20 —— 20 和 10 都远低于各自封顶，所以是「照乘」
  assert.deepEqual(s.payments.map((p) => p.payCap), [40, 40, 20]);
  assert.equal(s.topType, null, '只有 B/C 到顶档，三家不齐 → 不是金顶');
});

test('结算（table）：点炮 + 风赖 → 放炮者那笔也一起 ×2（未开口翻倍与之相乘）', () => {
  const settlement = settleRound({
    players: [
      { seat: 0, name: 'A', melds: [], opened: true, isDealer: false },
      { seat: 1, name: 'B', melds: [], opened: false, isDealer: false }, // 放炮 + 未开口
      { seat: 2, name: 'C', melds: [], opened: true, isDealer: false },
      { seat: 3, name: 'D', melds: [], opened: true, isDealer: false },
    ],
    winnerSeat: 0,
    winnerResult: { size: 'big', types: ['pengpengHu'], baseFan: 3, hardWin: false },
    context: { selfDraw: false, from: 1, fengLai: true },
    ruleset: RS,
  });
  // 赢家 3 番。B：自家番 1（放冲）+ 3 = 4 番 → 2 分；未开口 ×2 = 4；风赖 ×2 = 8。
  // 注意实现顺序：先乘 mul 再乘「未开口」，但两者都在同一笔上相乘，结果等价。
  const b = settlement.payments.find((p) => p.seat === 1);
  assert.equal(b.fan, 1);
  assert.equal(b.effFan, 4);
  assert.equal(b.pay, 8, '2 分 ×2(风赖) ×2(未开口) = 8');
  // C / D 未开口翻倍不适用：自家番 0 → effFan 3 → 1 分 ×2(风赖) = 2
  assert.equal(settlement.payments.find((p) => p.seat === 2).pay, 2);
  assert.equal(settlement.payments.find((p) => p.seat === 3).pay, 2);
});

test('结算（table）：点炮 + 未开口输家翻倍 + 庄家加番 + 放炮者加番', () => {
  const players = [
    { seat: 0, name: 'A', melds: [
        { type: 'peng', tiles: [w(1), w(1), w(1)], from: 1 },
        { type: 'peng', tiles: [w(2), w(2), w(2)], from: 3 },
        { type: 'peng', tiles: [t(3), t(3), t(3)], from: 2 },
        { type: 'peng', tiles: [t(4), t(4), t(4)], from: 1 },
        { type: 'peng', tiles: [t(5), t(5), t(5)], from: 3 },
      ], opened: true, isDealer: false },
    { seat: 1, name: 'B', melds: [], opened: false, isDealer: true }, // 庄家、未开口
    { seat: 2, name: 'C', melds: [{ type: 'peng', tiles: [s(5), s(5), s(5)], from: 3 }], opened: true, isDealer: false }, // 放炮者
    { seat: 3, name: 'D', melds: [{ type: 'peng', tiles: [s(6), s(6), s(6)], from: 2 }], opened: true, isDealer: false },
  ];
  const settlement = settleRound({
    players,
    winnerSeat: 0,
    winnerResult: { size: 'small', types: [], baseFan: 0, hardWin: true },
    context: { selfDraw: false, from: 2 },
    ruleset: RS,
  });
  // 赢家：0（小胡无基础番）+ 1（硬胡）+ 5（口口番：5 碰）= 6 番
  assert.equal(settlement.winnerFan, 6);
  const b = settlement.payments.find((x) => x.seat === 1); // 庄家、未开口
  const c = settlement.payments.find((x) => x.seat === 2); // 放炮者
  const d = settlement.payments.find((x) => x.seat === 3);
  assert.equal(b.fan, 1, '庄家那头加 1 番');
  assert.equal(b.effFan, 7, '自家 1 + 赢家 6 = 7 番');
  assert.equal(b.opened, false);
  assert.equal(b.pay, 4, '小胡 7 番档 = 2 分，未开口翻倍 → 4 分');
  assert.equal(c.fan, 2, '放炮那家加 1 番（放冲 + 开口）');
  assert.equal(c.effFan, 8, '自家 2 + 赢家 6 = 8 番');
  assert.equal(c.pay, 3, '小胡 8 番档 = 3 分');
  assert.equal(d.fan, 1, '普通输家 1 番');
  assert.equal(d.effFan, 7, '自家 1 + 赢家 6 = 7 番');
  assert.equal(d.pay, 2, '小胡 7 番档 = 2 分');
  assert.equal(settlement.totalWin, 9);
  assert.equal(settlement.topType, null, '未三家封顶，不是金顶');
});

test('结算（table）：每家输分按「自家番 + 赢家番」查表（老吴口径，非只算赢家番）', () => {
  const pengs = (n) =>
    Array.from({ length: n }, () => ({ type: 'peng', tiles: [w(1), w(1), w(1)], from: 0 }));
  const players = [
    { seat: 0, name: 'A', melds: pengs(3), opened: true, isDealer: false }, // 赢家：3 口
    { seat: 1, name: 'B', melds: pengs(6), opened: true, isDealer: false }, // 自家 6 番
    { seat: 2, name: 'C', melds: pengs(3), opened: true, isDealer: false }, // 自家 3 番
    { seat: 3, name: 'D', melds: pengs(5), opened: true, isDealer: false }, // 自家 5 番
  ];
  const settlement = settleRound({
    players,
    winnerSeat: 0,
    winnerResult: { size: 'small', types: [], baseFan: 1, hardWin: true },
    context: { selfDraw: true, from: null },
    ruleset: RS,
  });
  // 赢家：1（底）+ 1（自摸）+ 1（硬胡）+ 3（口口番 3 口）= 6 番
  assert.equal(settlement.winnerFan, 6);
  const bySeat = (n) => settlement.payments.find((x) => x.seat === n);
  assert.equal(bySeat(1).fan, 6);
  assert.equal(bySeat(1).effFan, 12, '自家 6 + 赢家 6 = 12 番');
  assert.equal(bySeat(1).pay, 8, '小胡 12 番 ≥ 顶档 10 → 封顶 8 分');
  assert.equal(bySeat(2).fan, 3);
  assert.equal(bySeat(2).effFan, 9, '自家 3 + 赢家 6 = 9 番');
  assert.equal(bySeat(2).pay, 5, '小胡 9 番档 = 5 分');
  assert.equal(bySeat(3).fan, 5);
  assert.equal(bySeat(3).effFan, 11);
  assert.equal(bySeat(3).pay, 8, '小胡 11 番 ≥ 顶档 10 → 封顶 8 分');
  assert.equal(settlement.totalWin, 21);
  assert.equal(settlement.topType, null, 'seat2 未封顶 → 未三家全封顶 → 非金顶');
  assert.match(settlement.text, /6\+6=12番/);
});

test('结算（table）：三家全部封顶 → 金顶（无赖、三家都开口 → 每家 10 分，武汉口径）', () => {
  const pengs = (n) =>
    Array.from({ length: n }, () => ({ type: 'peng', tiles: [w(1), w(1), w(1)], from: 0 }));
  const players = [
    { seat: 0, name: 'A', melds: [], opened: true, isDealer: false },
    { seat: 1, name: 'B', melds: pengs(5), opened: true, isDealer: false },
    { seat: 2, name: 'C', melds: pengs(5), opened: true, isDealer: false },
    { seat: 3, name: 'D', melds: pengs(5), opened: true, isDealer: false },
  ];
  const settlement = settleRound({
    players,
    winnerSeat: 0,
    winnerResult: { size: 'big', types: ['pengpengHu', 'qingYiSe', 'jiangYiSe'], baseFan: 9, hardWin: true },
    context: { selfDraw: true, from: null },
    ruleset: RS,
  });
  // 赢家：9（三大胡 ×3）+ 1（自摸）+ 1（硬胡）= 11 番
  assert.equal(settlement.winnerFan, 11);
  // 各家：5（5 口）+ 11 = 16 番 ≥ 大胡顶档 7 → 三家全部封顶 → 金顶
  assert.equal(settlement.topType, 'goldTop');
  for (const p of settlement.payments) {
    assert.equal(p.effFan, 16);
    assert.equal(p.payCap, 10, '无赖 + 已开口 → 上限 10');
    assert.equal(p.pay, 10);
  }
  assert.equal(settlement.totalWin, 30);
  assert.match(settlement.text, /金顶/);
});

/* ---------- 金顶金额跟着倍率翻（老吴 2026-09-30 二次纠正） ---------- */

/** 三家全封顶的金顶夹具（复用上方口径），`xTra` 用于追加 melds 变化 */
function goldTopTable(rs, { fengLai = false } = {}) {
  const pengs = (n) =>
    Array.from({ length: n }, () => ({ type: 'peng', tiles: [w(1), w(1), w(1)], from: 0 }));
  return {
    players: [
      { seat: 0, name: 'A', melds: [], opened: true, isDealer: false },
      { seat: 1, name: 'B', melds: pengs(5), opened: true, isDealer: false },
      { seat: 2, name: 'C', melds: pengs(5), opened: true, isDealer: false },
      { seat: 3, name: 'D', melds: pengs(5), opened: true, isDealer: false },
    ],
    winnerSeat: 0,
    winnerResult: { size: 'big', types: ['pengpengHu', 'qingYiSe', 'jiangYiSe'], baseFan: 9, hardWin: true },
    context: { selfDraw: true, from: null, fengLai },
    ruleset: rs,
  };
}

test('结算（table）：**风赖金顶 = 每家 20 分**（老吴原话「显示金顶了，可是每家只付 10 分」）', () => {
  const s = settleRound(goldTopTable(RS, { fengLai: true }));
  assert.equal(s.topType, 'goldTop');
  assert.equal(s.mul, 2, '风赖 → 分数 ×2');
  // 金顶不再固定 10：每家付自己那份上限 = 10 × 2(赖) × 1(已开口) = 20
  assert.deepEqual(s.payments.map((p) => p.payCap), [20, 20, 20]);
  assert.deepEqual(s.payments.map((p) => p.pay), [20, 20, 20]);
  assert.equal(s.totalWin, 60);
});

test('结算（table）：**风赖金顶 + 未开口那家 = 40**（上限也翻倍）', () => {
  const pengs = (n) =>
    Array.from({ length: n }, () => ({ type: 'peng', tiles: [w(1), w(1), w(1)], from: 0 }));
  const anGangs = (n) =>
    Array.from({ length: n }, () => ({ type: 'an', tiles: [w(2), w(2), w(2), w(2)], from: null }));
  const s = settleRound({
    players: [
      { seat: 0, name: 'A', melds: [], opened: true, isDealer: false },
      { seat: 1, name: 'B', melds: pengs(5), opened: true, isDealer: false },
      { seat: 2, name: 'C', melds: pengs(5), opened: true, isDealer: false },
      // D 未开口：5 暗杠（暗杠不算开口）→ gangAn 10 番 → effFan 21 ≥ 7 → 照样封顶
      { seat: 3, name: 'D', melds: anGangs(5), opened: false, isDealer: false },
    ],
    winnerSeat: 0,
    winnerResult: { size: 'big', types: ['pengpengHu', 'qingYiSe', 'jiangYiSe'], baseFan: 9, hardWin: true },
    context: { selfDraw: true, from: null, fengLai: true },
    // 2026-10-24 闷杠默认免阳光 —— 本用例专测「未开口 ×2 + 金顶上限 40」的算术，显式关掉豁免
    ruleset: createRuleSet('koukou', { menGangExemptsSunny: false }),
  });
  assert.equal(s.topType, 'goldTop');
  const d = s.payments.find((p) => p.seat === 3);
  assert.equal(d.opened, false);
  assert.equal(d.payCap, 40, '未开口 + 有赖 → 上限 10×2×2 = 40');
  assert.equal(d.pay, 40);
  assert.deepEqual(s.payments.map((p) => p.pay), [20, 20, 40]);
});

test('结算（table）：关掉 scaledPayCap → 金顶退回「固定 10 分」的旧行为', () => {
  const rs = createRuleSet('koukou', { scaledPayCap: false });
  const s = settleRound(goldTopTable(rs, { fengLai: true }));
  assert.equal(s.topType, 'goldTop');
  assert.equal(s.mul, 2, '番/倍率不变，只是金顶不跟着翻');
  assert.deepEqual(s.payments.map((p) => p.pay), [10, 10, 10]);
});

test('winnerFanPreview 必须与 settleRound 的赢家番数一致', () => {
  const player = {
    seat: 0,
    name: 'A',
    isDealer: true,
    melds: [{ type: 'peng', tiles: [w(1), w(1), w(1)], from: 1 }],
    opened: true,
  };
  const winnerResult = { size: 'small', types: [], baseFan: 1, hardWin: true };
  const context = { selfDraw: true, from: null };
  const preview = winnerFanPreview(player, winnerResult, context, RS);
  const settlement = settleRound({
    players: [
      player,
      { seat: 1, name: 'B', melds: [], opened: true, isDealer: false },
      { seat: 2, name: 'C', melds: [], opened: true, isDealer: false },
      { seat: 3, name: 'D', melds: [], opened: true, isDealer: false },
    ],
    winnerSeat: 0,
    winnerResult,
    context,
    ruleset: RS,
  });
  assert.equal(preview, settlement.winnerFan);
  // 1（底）+ 1（自摸）+ 1（硬胡）+ 1（口口番 1 口）= 4
  assert.equal(preview, 4);
});

/* ------------------------------------------------------------------ */
/* 开口口径：开口番 vs 口口番                                            */
/* ------------------------------------------------------------------ */

test('开口口径：口口番每口各算 1 番，开口番只算 1 番', () => {
  const melds = [
    { type: 'peng', tiles: [w(1), w(1), w(1)], from: 1 },
    { type: 'chi', tiles: [w(2), w(3), w(4)], from: 2 },
    { type: 'peng', tiles: [t(5), t(5), t(5)], from: 3 },
  ];
  const player = { seat: 0, melds, opened: true };

  const kk = countFan(player, { ruleset: createRuleSet('koukou') });
  const ko = countFan(player, { ruleset: createRuleSet('kaikou') });

  assert.equal(kk.details.find((x) => x.key === 'openFan').fan, 3, '口口番：3 口 → 3 番');
  assert.equal(ko.details.find((x) => x.key === 'openFan').fan, 1, '开口番：只算 1 番');
  assert.ok(kk.total > ko.total, '同一副露下口口番应更高');
});

test('杠的番底（老吴 10-08 定稿）：冲杠 2 番、蓄杠 2 番（碰1+杠1），暗杠/癞子杠各 2 番，红中杠/皮子杠各 1 番', () => {
  const melds = [
    { type: 'zhi', tiles: [w(1), w(1), w(1), w(1)], from: 1 },
    { type: 'xu', tiles: [t(2), t(2), t(2), t(2)], from: 2 },
    { type: 'an', tiles: [s(3), s(3), s(3), s(3)], from: null },
    { type: 'skin', tiles: [t(9)], from: null },
    { type: 'wild', tiles: [t(1)], from: null },
    { type: 'red', tiles: [Z], from: null },
  ];
  const player = { seat: 0, melds, opened: true };
  const fan = countFan(player, { ruleset: createRuleSet('koukou') });
  const get = (k) => fan.details.find((x) => x.key === k)?.fan ?? 0;
  // 🔴 老吴 10-08：「冲杠是直接杠，蓄杠有原来碰的 1 番 + 杠的 1 番 = 合计 2 番」
  assert.equal(get('gangZhi'), 2, '冲杠 2 番');
  assert.equal(get('gangXu'), 2, '蓄杠 2 番（碰 1 + 杠 1）');
  assert.equal(get('gangAn'), 2, '暗杠 2 番');
  assert.equal(get('gangWild'), 2, '癞子杠 2 番');
  // 老吴：「红中和皮杠一下都是一番」（9-30 拍板，10-08 复核不变）
  assert.equal(get('gangSkin'), 1, '皮子杠 1 番');
  assert.equal(get('gangRed'), 1, '红中杠 1 番');
  // 杠/蓄杠不再进「口数」→ 没有独立的开口番（老吴：开口不要重复算）
  assert.equal(get('openFan'), 0, '明杠不再额外产生开口番');
});

test('蓄杠的「碰 1 番」由 gangFan.xu 兜住（xu 不进 openCount，碰那 1 番不会凭空消失）', () => {
  // 🔴 根因：`completeXuGang` 把 peng 副露**原地改写**成 xu，而 `openCount()` 只数 chi/peng
  //   ⇒ 蓄杠一副若只靠 `openCount`，碰的那 1 番就消失了（实测改之前蓄杠只给 1 番）。
  const rs = createRuleSet('koukou');
  const f = (melds) => countFan({ seat: 0, melds, opened: true }, { ruleset: rs, isWinner: true, baseFan: 0, size: 'small' }).total;

  assert.equal(f([{ type: 'peng', tiles: [w(1), w(1), w(1)], from: 1 }]), 1, '纯碰 = 1 番（koukou 一口）');
  assert.equal(f([{ type: 'xu', tiles: [w(1), w(1), w(1), w(1)], from: 1 }]), 2, '蓄杠 = 2 番（碰 1 + 杠 1，与纯碰持平不多不少）');
  assert.equal(f([{ type: 'zhi', tiles: [w(1), w(1), w(1), w(1)], from: 1 }]), 2, '冲杠 = 2 番（直接杠）');
  // 反证：蓄杠与冲杠同副露时番数相同，但**走的明细不同**（一个是 gangXu、一个是 gangZhi）
  const r = countFan(
    { seat: 0, melds: [{ type: 'xu', tiles: [w(1), w(1), w(1), w(1)], from: 1 }], opened: true },
    { ruleset: rs, isWinner: true, baseFan: 0, size: 'small' },
  );
  assert.ok(r.details.some((d) => d.key === 'gangXu' && d.fan === 2), '蓄杠的 2 番必须走 gangXu 明细');
  assert.ok(!r.details.some((d) => d.key === 'openFan'), '蓄杠不该再额外产生开口番（否则碰的 1 番被算两次）');
});

test('口与杠（老吴 10-08）：吃/碰每口 1 番、冲杠每口 2 番，两者互不重复', () => {
  const melds = [
    { type: 'peng', tiles: [w(1), w(1), w(1)], from: 1 }, // 碰 → 1 口
    { type: 'chi', tiles: [w(2), w(3), w(4)], from: 2 }, // 吃 → 1 口
    { type: 'zhi', tiles: [t(5), t(5), t(5), t(5)], from: 3 }, // 冲杠 → 2 番（不再算 1 口）
  ];
  const player = { seat: 0, melds, opened: true };
  const fan = countFan(player, { ruleset: createRuleSet('koukou') });
  const get = (k) => fan.details.find((x) => x.key === k)?.fan ?? 0;
  assert.equal(get('openFan'), 2, '碰 + 吃 = 2 口 → 2 番');
  assert.equal(get('gangZhi'), 2, '冲杠 2 番');
  assert.equal(fan.total, 4, '合计 2 + 2 = 4 番');
});

/* ------------------------------------------------------------------ */
/* 判定辅助                                                            */
/* ------------------------------------------------------------------ */

test('辅助判定：eyeIs258 / 清一色 / 将一色 / 风一色', () => {
  assert.equal(eyeIs258({ tile: w(2), wildCount: 0 }), true);
  assert.equal(eyeIs258({ tile: w(5), wildCount: 0 }), true);
  assert.equal(eyeIs258({ tile: w(8), wildCount: 0 }), true);
  assert.equal(eyeIs258({ tile: w(3), wildCount: 0 }), false);
  assert.equal(eyeIs258({ tile: EAST, wildCount: 0 }), false, '字牌不能作小胡的将');
  assert.equal(eyeIs258({ tile: null, wildCount: 2 }), true, '双癞子可当任意将');
  assert.equal(eyeIs258(null), false);

  assert.equal(isQingYiSe([w(1), w(2), w(3)]), true);
  assert.equal(isQingYiSe([w(1), t(2)]), false);
  assert.equal(isQingYiSe([]), false);
  assert.equal(isJiangYiSe([w(2), t(5), s(8)]), true);
  assert.equal(isJiangYiSe([w(2), w(3)]), false);
  assert.equal(isFengYiSe([EAST, SOUTH, WHITE_DRAGON]), true);
  assert.equal(isFengYiSe([EAST, w(1)]), false);
});

test('癞子不破坏清一色（癞子与皮子都从花色判定里剔除）', () => {
  const WILD = t(1);
  const hand = [w(1), w(1), w(1), w(2), w(2), w(2), w(3), w(3), w(3), w(4), w(4), w(4), w(9), WILD];
  const r = ev(hand, { wildTile: WILD });
  assert.equal(r.legal, true, r.reason);
  assert.ok(hasType(r, 'qingYiSe'), '癞子不该破坏清一色');
  assert.ok(hasType(r, 'pengpengHu'));
});

test('未胡的手牌返回 legal=false 并给出原因', () => {
  const hand = [w(1), w(1), w(1), w(3), w(5), w(7), t(2), t(4), t(6), t(8), t(8), t(8), s(1), s(9)];
  const r = ev(hand);
  assert.equal(r.legal, false);
  assert.equal(typeof r.reason, 'string');
  assert.ok(r.reason.length > 0);
});

/* ------------------------------------------------------------------ */
/* 全求人必须点炮（老吴 Rule3：「胡牌全为他人打出」）                     */
/* ------------------------------------------------------------------ */

const QUAN_QIU_REN_MELDS = [
  { type: 'peng', tiles: [t(1), t(1), t(1)], from: 1 },
  { type: 'chi', tiles: [w(2), w(3), w(4)], from: 2 },
  { type: 'peng', tiles: [s(5), s(5), s(5)], from: 3 },
  { type: 'peng', tiles: [t(6), t(6), t(6)], from: 1 },
];

test('全求人：4 口副露 + 单钓将，点炮成立', () => {
  const r = ev([t(7), t(7)], {
    melds: QUAN_QIU_REN_MELDS,
    context: { selfDraw: false, from: 1 },
  });
  assert.equal(r.legal, true, r.reason);
  assert.ok(hasType(r, 'quanQiuRen'), '点炮凑满 4 口 → 全求人');
});

test('全求人：自摸不算全求人（胡牌也须为他人打出）', () => {
  // 自摸时不再算全求人 → 回落成小胡，必须 2/5/8 作将，故用 5 筒做将
  const r = ev([t(5), t(5)], {
    melds: QUAN_QIU_REN_MELDS,
    context: { selfDraw: true },
  });
  assert.equal(r.legal, true, r.reason);
  assert.ok(!hasType(r, 'quanQiuRen'), '自摸不成全求人');
});

test('全求人：暗杠不算「他人打出」，凑不满 4 口', () => {
  const melds = [
    { type: 'an', tiles: [t(1), t(1), t(1), t(1)], from: null },
    { type: 'peng', tiles: [w(2), w(2), w(2)], from: 2 },
    { type: 'peng', tiles: [s(5), s(5), s(5)], from: 3 },
    { type: 'peng', tiles: [t(6), t(6), t(6)], from: 1 },
  ];
  const r = ev([t(7), t(7)], { melds, context: { selfDraw: false, from: 1 } });
  assert.ok(!hasType(r, 'quanQiuRen'), '暗杠来自自己摸牌，不算全求人');
});

test('全求人：4 口里含「蓄杠」也算（老吴 2026-10-29）', () => {
  // 蓄杠 = 碰出来的刻子升级成杠，面子本身仍是别人打的牌 → 必须归进全求人。
  const melds = [
    { type: 'peng', tiles: [t(1), t(1), t(1)], from: 1 },
    { type: 'chi', tiles: [w(2), w(3), w(4)], from: 2 },
    { type: 'xu', tiles: [s(5), s(5), s(5), s(5)], from: 3 },
    { type: 'peng', tiles: [t(6), t(6), t(6)], from: 1 },
  ];
  const r = ev([t(7), t(7)], { melds, context: { selfDraw: false, from: 1 } });
  assert.equal(r.legal, true, r.reason);
  assert.ok(hasType(r, 'quanQiuRen'), '蓄杠是他人打出的刻子升杠 → 仍算全求人');
});

test('全求人：4 口里含「暗杠」仍不算（对照，蓄杠的边界）', () => {
  const melds = [
    { type: 'peng', tiles: [t(1), t(1), t(1)], from: 1 },
    { type: 'chi', tiles: [w(2), w(3), w(4)], from: 2 },
    { type: 'an', tiles: [s(5), s(5), s(5), s(5)], from: null },
    { type: 'peng', tiles: [t(6), t(6), t(6)], from: 1 },
  ];
  const r = ev([t(7), t(7)], { melds, context: { selfDraw: false, from: 1 } });
  assert.ok(!hasType(r, 'quanQiuRen'), '暗杠自己摸的，依然不算求人');
});

test('全求人：4 口里含「皮子杠」不算（特殊杠不构成面子）', () => {
  const melds = [
    { type: 'peng', tiles: [t(1), t(1), t(1)], from: 1 },
    { type: 'chi', tiles: [w(2), w(3), w(4)], from: 2 },
    { type: 'skin', tiles: [t(9)], from: null },
    { type: 'peng', tiles: [t(6), t(6), t(6)], from: 1 },
  ];
  const r = ev([t(7), t(7)], { melds, context: { selfDraw: false, from: 1 } });
  assert.ok(!hasType(r, 'quanQiuRen'), '特殊杠只占 1 张、不折算面子 → 凑不满 4 口');
});

/* ------------------------------------------------------------------ */
/* 乱将 / 乱风（老吴 2026-09-30）                                       */
/* ------------------------------------------------------------------ */

/**
 * 老吴原话：「将一色、风一色都不需要按顺子、刻子的规则，全手牌只要全是将牌或者风牌
 * 就可以胡牌，即乱将乱风就可以」。
 */
const RS_NO_LUAN = createRuleSet('koukou', { luanJiangEnabled: false, luanFengEnabled: false });

test('乱将：全手牌都是 2/5/8 但拆不出 4 面子+1 将 —— 开乱将就能胡，关掉就不能', () => {
  // 222万 55万 88万 222筒 55筒 88筒：只有 2 个刻子 + 4 个对子，凑不出第 3、4 个面子
  const hand = [
    w(2), w(2), w(2), w(5), w(5), w(8), w(8),
    t(2), t(2), t(2), t(5), t(5), t(8), t(8),
  ];
  assert.equal(hand.length, 14);

  // 关掉乱将 → 旧口径：牌型不成立
  const off = ev(hand, { ruleset: RS_NO_LUAN });
  assert.equal(off.legal, false, '旧口径下这手牌拆不出来，不该能胡');

  // 开了乱将 → 判「将一色」大胡，3 番底
  const on = ev(hand);
  assert.equal(on.legal, true, on.reason);
  assert.equal(on.size, 'big');
  assert.ok(on.types.includes('jiangYiSe'), `应判将一色，实际 ${on.types}`);
  assert.equal(on.baseFan, 3, '一种大胡牌型 = 3 番底');
  // ⚠️ 不能因为「既是乱将、physical 又全是 2/5/8」而把将一色记两次
  assert.equal(on.types.filter((x) => x === 'jiangYiSe').length, 1, '将一色不该被记两次');
});

test('乱风：全手牌都是字牌但拆不出面子 —— 自摸能胡，点炮也能胡（老吴 2026-10-01）', () => {
  // 东东东 南南南 西西 北北 发发 白白：2 个刻子 + 4 个对子，同样凑不满 4 面子
  const hand = [
    EAST, EAST, EAST, SOUTH, SOUTH, SOUTH,
    WEST, WEST, NORTH, NORTH, GREEN_DRAGON, GREEN_DRAGON, WHITE_DRAGON, WHITE_DRAGON,
  ];
  assert.equal(hand.length, 14);

  const off = ev(hand, { ruleset: RS_NO_LUAN, context: { selfDraw: true } });
  assert.equal(off.legal, false, '旧口径下这手牌拆不出来，不该能胡');

  // ❗老吴 2026-10-01「其他牌型可以接冲」→ 乱风点炮同样能胡（旧「全字牌必须自摸」闸门已删）
  const dianpao = ev(hand, { context: { selfDraw: false, from: 1 } });
  assert.equal(dianpao.legal, true, '乱风点炮应该能胡：' + dianpao.reason);
  assert.ok(dianpao.types.includes('fengYiSe'), `应判风一色，实际 ${dianpao.types}`);

  const zimo = ev(hand, { context: { selfDraw: true } });
  assert.equal(zimo.legal, true, zimo.reason);
  assert.equal(zimo.size, 'big');
  assert.ok(zimo.types.includes('fengYiSe'), `应判风一色，实际 ${zimo.types}`);
  assert.equal(zimo.types.filter((x) => x === 'fengYiSe').length, 1, '风一色不该被记两次');
});

test('乱将 / 乱风必须张数正好 14 张：13 张不听、15 张不算', () => {
  const h13 = [w(2), w(2), w(2), w(5), w(5), w(8), w(8), t(2), t(2), t(2), t(5), t(5), t(8)];
  assert.equal(h13.length, 13);
  assert.equal(ev(h13).legal, false, '13 张不是完整的一手牌，不能因为「全是 2/5/8」就胡');

  const rs = createRuleSet('koukou');
  const c13 = toCounts(h13);
  assert.equal(shapeFreeBigHu({ counts: c13, melds: [], ruleset: rs, wildTile: null }), null);

  // 15 张（多一张）= 也不是 14 → 直接 null
  const c15 = toCounts([...h13, t(8), t(8)]);
  assert.equal(shapeFreeBigHu({ counts: c15, melds: [], ruleset: rs, wildTile: null }), null);
});

test('乱将：副露算进张数 —— 手牌 11 张 + 1 副露 3 张同样成立', () => {
  // 手牌：222万 55万 88万 22筒（11 张，全是 2/5/8）＋ 副露 222筒
  const hand = [w(2), w(2), w(2), w(5), w(5), w(8), w(8), t(2), t(2), t(5), t(5)];
  const melds = [{ type: 'peng', tiles: [t(8), t(8), t(8)], from: 2 }];
  assert.equal(hand.length + 3, 14);

  const r = ev(hand, { melds });
  assert.equal(r.legal, true, r.reason);
  assert.ok(r.types.includes('jiangYiSe'));
});

/* ================================================================== *
 * 「大胡不算庄家番」· 金顶也不回补（老吴 2026-10-03 / 2026-10-22）
 *
 * 口径：大胡局庄家番**输赢都不算**，金顶局同样不算 —— 不再「先免后回补」。
 * 金顶判定仍按「赢家番 + 输家番（不含庄家番）」算；少 1 番可能把金顶翻掉，
 * 这是规则本身的结果，不做补偿。
 * ================================================================== */

test('结算（table）：大胡免庄家番后，金顶判定不再靠这笔（翻掉就翻掉）', () => {
  // 大胡表 [[3,1],[4,2],[5,3],[6,5],[7,8]]，顶档 7 番。
  // 赢家 5 番、输家免庄家番 0 番 → effFan 5 < 7 → 不是金顶。
  const players = [
    { seat: 0, name: 'A', melds: [], opened: true, isDealer: true },
    { seat: 1, name: 'B', melds: [], opened: true, isDealer: false },
    { seat: 2, name: 'C', melds: [], opened: true, isDealer: false },
    { seat: 3, name: 'D', melds: [], opened: true, isDealer: false },
  ];
  const settlement = settleRound({
    players,
    winnerSeat: 0,
    winnerResult: { size: 'big', types: ['pengpengHu'], baseFan: 3, hardWin: true },
    context: { selfDraw: true, from: null },
    ruleset: createRuleSet('koukou'),
  });
  assert.equal(settlement.winnerFan, 5);
  assert.equal(settlement.topType, null, 'effFan 5 未达顶档 7 → 不是金顶（免庄家番的直接后果）');
  for (const p of settlement.payments) {
    assert.ok(!p.fanDetails.some((d) => d.key === 'dealer'), '大胡输家不该有庄家番');
  }
});

test('结算（table）：大胡金顶也不回补庄家番 —— 庄家是赢家 / 输家都不算', () => {
  // 赢家番数 ≥ 顶档：base3 + 自摸1 + 硬胡1 + zhiGang(2) + anGang(2) = 9 番。
  const mkPlayers = (dealerSeat) => [
    { seat: 0, name: 'A', melds: [{ type: 'an', tiles: [] }, { type: 'zhi', tiles: [] }], opened: true, isDealer: dealerSeat === 0 },
    { seat: 1, name: 'B', melds: [], opened: true, isDealer: dealerSeat === 1 },
    { seat: 2, name: 'C', melds: [], opened: true, isDealer: dealerSeat === 2 },
    { seat: 3, name: 'D', melds: [], opened: true, isDealer: dealerSeat === 3 },
  ];
  const mk = (dealerSeat, winnerSeat, bigHuNoDealerFan) => settleRound({
    players: mkPlayers(dealerSeat),
    winnerSeat,
    winnerResult: { size: 'big', types: ['pengpengHu'], baseFan: 3, hardWin: true },
    context: { selfDraw: true, from: null },
    ruleset: createRuleSet('koukou', { bigHuNoDealerFan }),
  });

  // ① 庄家 = 赢家（座位 0）：三家输家都不能记庄家番（旧口径三家都会 +1）
  const winnerDealer = mk(0, 0, true);
  assert.equal(winnerDealer.topType, 'goldTop', '赢家番数够高 → 仍是金顶');
  for (const p of winnerDealer.payments) {
    assert.ok(!p.fanDetails.some((d) => d.key === 'dealer'), `座位 ${p.seat} 不该有庄家番`);
    assert.equal(p.dealerFanRestored, undefined, '不再有「回补」标记');
    assert.equal(p.pay, 10, '金顶局每家仍付 goldScore');
  }

  // ② 庄家 = 输家（座位 1）：只有庄家那家本该有庄家番，大胡同样免
  const loserDealer = mk(1, 0, true);
  assert.equal(loserDealer.topType, 'goldTop');
  const dealerP = loserDealer.payments.find((p) => p.seat === 1);
  assert.ok(!dealerP.fanDetails.some((d) => d.key === 'dealer'), '庄家作为输家也不记庄家番');
  assert.equal(dealerP.dealerFanRestored, undefined);

  // ③ 反向对照：开关关掉 → 庄家番回来（证明开关仍生效）
  const off = mk(0, 0, false);
  for (const p of off.payments) assert.ok(p.fanDetails.some((d) => d.key === 'dealer'));
});

/* ================================================================== */
/* 乱风 / 乱将（2026-10-29 老吴：「风一色不需要判断顺子和刻子，不需要将牌， */
/*  和将一色一样，成为乱风乱将」）                                      */
/* ================================================================== */

test('风一色不要求将牌：全字牌 + 一张癞子作将照样能胡（与两张实字牌同番）', () => {
  const rs = createRuleSet('koukou', {});
  const wild = makeTile('wan', 5);
  const skins = [makeTile('wan', 4), makeTile('wan', 3), RED_DRAGON];
  const run = (hand) => evaluateWin({
    counts: toCounts(hand),
    melds: [],
    opened: true,
    context: { selfDraw: true, from: null, gangShangKaiHua: false, haiDiLao: false, qiangGangHu: false, winTile: hand[hand.length - 1] },
    ruleset: rs,
    wildTile: wild,
    skinTiles: skins,
  });

  const base = [EAST, EAST, EAST, SOUTH, SOUTH, SOUTH, WEST, WEST, WEST, NORTH, NORTH, NORTH];

  // ① 将 = 字牌 + 癞子（字牌做不成 258 将；旧实现会被 258 闸门判死）
  const withWildEye = run([...base, GREEN_DRAGON, wild]);
  assert.equal(withWildEye.legal, true, '全字牌 + 单癞子作将必须能胡');
  assert.deepEqual(withWildEye.types, ['pengpengHu', 'fengYiSe']);
  assert.equal(withWildEye.baseFan, 4);

  // ② 对照：将 = 两张实字牌，番数必须一致（不能因为将牌形式少算碰碰胡）
  const naturalEye = run([...base, GREEN_DRAGON, GREEN_DRAGON]);
  assert.equal(naturalEye.legal, true);
  assert.equal(naturalEye.baseFan, withWildEye.baseFan, '将牌是否含癞子不影响番数');

  // ③ 对照：将 = 两张癞子
  const twoWildEye = run([...base, wild, wild]);
  assert.equal(twoWildEye.legal, true);
  assert.equal(twoWildEye.baseFan, 4);
});

test('风一色不成面子也能胡（乱风）：七对式全字牌', () => {
  const rs = createRuleSet('koukou', {});
  const res = evaluateWin({
    counts: toCounts([
      EAST, EAST, SOUTH, SOUTH, WEST, WEST, NORTH, NORTH,
      GREEN_DRAGON, GREEN_DRAGON, WHITE_DRAGON, WHITE_DRAGON, EAST, EAST,
    ]),
    melds: [],
    opened: true,
    context: { selfDraw: true, from: null, gangShangKaiHua: false, haiDiLao: false, qiangGangHu: false, winTile: EAST },
    ruleset: rs,
    wildTile: null,
    skinTiles: [],
  });
  assert.equal(res.legal, true, '全字牌凑不出 4 面子 + 将也要能胡');
  assert.deepEqual(res.types, ['fengYiSe']);
  assert.equal(res.baseFan, 3);
});

test('副露 4 口 + 单吊「字牌 + 癞子」点炮能胡，但**不算全求人**（老吴 2026-10-29）', () => {
  const rs = createRuleSet('koukou', {});
  const wild = makeTile('wan', 5);
  const melds = [EAST, SOUTH, WEST, NORTH].map((t) => ({
    type: 'peng', tile: t, tiles: [t, t, t], from: 1,
  }));
  const res = evaluateWin({
    counts: toCounts([GREEN_DRAGON, wild]),
    melds,
    opened: true,
    context: { selfDraw: false, from: 3, gangShangKaiHua: false, haiDiLao: false, qiangGangHu: false, winTile: GREEN_DRAGON },
    ruleset: rs,
    wildTile: wild,
    skinTiles: [makeTile('wan', 4), makeTile('wan', 3), RED_DRAGON],
  });
  assert.equal(res.legal, true);
  assert.ok(res.types.includes('fengYiSe'));
  // 将牌是「发财 + 癞子」→ 见将胡（来任意一张都能配将），不是「最后一张吊将」→ 不算全求人
  assert.ok(!res.types.includes('quanQiuRen'), '将牌含癞子不算全求人');
  assert.equal(res.baseFan, 4, '碰碰胡 + 风一色 = 4 番底（不再多算全求人那一番）');
});

test('风赖 + 风一色 = 金顶，每家付 goldScore × 2（未开口再翻倍）', () => {
  const rs = createRuleSet('koukou', {});
  // 癞子 = 北风 → 风赖；皮 = 西风 / 南风 / 红中
  const res = evaluateWin({
    counts: toCounts([EAST, EAST, EAST, EAST, GREEN_DRAGON, GREEN_DRAGON, GREEN_DRAGON,
      WHITE_DRAGON, WHITE_DRAGON, WHITE_DRAGON, NORTH, NORTH, NORTH, NORTH]),
    melds: [],
    opened: true,
    context: { selfDraw: true, from: null, gangShangKaiHua: false, haiDiLao: false, qiangGangHu: false, winTile: EAST, fengLai: true, yuanLai: false },
    ruleset: rs,
    wildTile: NORTH,
    skinTiles: [WEST, SOUTH, RED_DRAGON],
  });
  assert.equal(res.legal, true);

  const players = [0, 1, 2, 3].map((seat) => ({
    seat, name: `P${seat}`, melds: [], opened: seat !== 3, isDealer: seat === 0,
  }));
  const settled = settleRound({
    players,
    winnerSeat: 0,
    winnerResult: res,
    context: { selfDraw: true, from: null, fengLai: true, yuanLai: false },
    ruleset: rs,
  });
  assert.equal(settled.topType, 'goldTop');
  assert.equal(settled.mul, 2, '风赖只翻分数、不加番');
  const bySeat = Object.fromEntries(settled.payments.map((p) => [p.seat, p]));
  assert.equal(bySeat[1].pay, 20, '已开口输家 = 10 × 2');
  assert.equal(bySeat[2].pay, 20);
  assert.equal(bySeat[3].pay, 40, '未开口（被阳光）输家 = 10 × 2 × 2');
  assert.equal(settled.totalWin, 80);
});
