/**
 * 下雨 / 陪包测试（老吴 2026-10-25 定稿，同日四次修订后的最终口径）
 *
 *   ① 结算条件：**雨主自己胡牌**——A 没胡就按实际赢家牌面正常算分，包胡/下雨全不计算
 *   ② 包胡触发：A 的该花色**明牌**副露（暗杠不计）被喂到**第 3 句** → 供牌者包胡；
 *      第 4 个明牌不包，除非前三句里有暗杠（暗杠计数位移，第 4 句实际是第 3 个明牌）
 *   ③ 陪包：出牌时**手中有该花色却未出** → 当场记陪包（不看结算手牌）
 *   ④ 各包/陪者各付该局总分（不均摊）
 *   ⑤ 惩罚只挂**第一场**被包的花色；第二种花色不算惩罚（只约束出牌顺序）
 *   · 全求人：义务人只剩该花色将牌时打该将，不包全求人
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, act } from '../src/engine/game.js';
import { createRuleSet } from '../src/engine/rules.js';
import { WHITE_DRAGON } from '../src/engine/tiles.js';

const w = (n) => n - 1;        // 万 = 0..8
const t = (n) => 8 + n;        // 筒 = 9..17

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
  state.rains = [];
  return state;
}

const RS = createRuleSet('koukou', { enforceMinFan: false });

test('下雨触发：第三句明牌被喂 → 供牌者包胡；第四个明牌不包（二次修订②）', () => {
  const st = blank(createGame({ seed: 8 }));
  st.ruleset = RS;
  st.players[0].melds = [
    { type: 'peng', tiles: [w(3), w(3), w(3)], from: 1 },
    { type: 'peng', tiles: [w(4), w(4), w(4)], from: 2 },
  ];
  st.players[0].hand = [w(5), w(5), t(1)];
  st.lastDiscard = { tile: w(5), from: 3 };
  st.turn = 0;
  st.phase = 'claim';

  act(st, { type: 'peng', seat: 0 }); // 第 3 个明牌副露
  assert.equal(st.rains.length, 1, '宣告一场雨');
  assert.equal(st.rains[0].color, 0);
  assert.deepEqual(st.rains[0].baos, [3], '座位 3 供第三句 → 包胡');
  assert.equal(st.rains[0].owner, 0);

  // 第 4 个明牌（座位 1 再喂）→ 不包
  st.players[0].hand = [w(5), w(5), t(1)];
  st.lastDiscard = { tile: w(5), from: 1 };
  st.turn = 0;
  st.phase = 'claim';
  act(st, { type: 'peng', seat: 0 });
  assert.equal(st.rains.length, 1);
  assert.deepEqual(st.rains[0].baos, [3], '第四句不包胡');
});

test('暗杠计数位移：前三句里有一个暗杠 → 第四句（第 3 个明牌）照包（二次修订②）', () => {
  const st = blank(createGame({ seed: 8 }));
  st.ruleset = RS;
  st.players[0].melds = [
    { type: 'peng', tiles: [w(3), w(3), w(3)], from: 1 },
    { type: 'peng', tiles: [w(4), w(4), w(4)], from: 2 },
  ];
  st.players[0].hand = [w(7), w(7), w(7), w(7), t(1)];
  st.turn = 0;
  st.phase = 'discard';
  act(st, { type: 'an', seat: 0, tile: w(7) }); // 暗杠万七（不计明牌）

  st.players[0].hand = [w(5), w(5), t(1)];
  st.lastDiscard = { tile: w(5), from: 3 };
  st.turn = 0;
  st.phase = 'claim';
  act(st, { type: 'peng', seat: 0 }); // 明牌副露第 3 句（总第四句）
  assert.equal(st.rains.length, 1, '前三句有暗杠 → 第四句照包');
  assert.deepEqual(st.rains[0].baos, [3]);
});

test('陪包逐轮判定：出牌时手中有万却打筒 → 当场记陪包（二次修订③）', () => {
  const st = blank(createGame({ seed: 9 }));
  st.ruleset = RS;
  st.players[0].melds = [
    { type: 'peng', tiles: [w(3), w(3), w(3)], from: 1 },
    { type: 'peng', tiles: [w(4), w(4), w(4)], from: 2 },
  ];
  st.players[0].hand = [w(5), w(5), t(1)];
  st.lastDiscard = { tile: w(5), from: 3 };
  st.turn = 0;
  st.phase = 'claim';
  act(st, { type: 'peng', seat: 0 }); // 宣告：baos=[3]

  // 义务人座位 2：手里 [万九, 筒一] 却打筒一 → 记陪包
  st.players[2].hand = [w(9), t(1)];
  st.turn = 2;
  st.phase = 'discard';
  st.lastDraw = t(1);
  st.claims = [];
  st.claimIndex = 0;
  act(st, { type: 'discard', seat: 2, tile: t(1) });
  assert.deepEqual(st.rains[0].penalties, [2], '手中有万未下雨 → 当场记陪包');

  // 雨主（座位 0）自摸胡清一色碰碰 → 座位 3 包 + 座位 2 陪，各付总分
  st.players[0].hand = [w(6), w(6), w(7), w(7), w(7)];
  st.turn = 0;
  st.phase = 'discard';
  st.lastDraw = w(7);
  st.claims = [];
  st.claimIndex = 0;
  act(st, { type: 'win', seat: 0 });

  const r = st.result;
  assert.ok(r && r.type === 'win');
  const perPay = r.rainPayers[0].amount;
  assert.deepEqual(r.rainPayers.map((x) => [x.seat, x.kind]), [[3, 'bao'], [2, 'pei']],
    '座位 3 包胡（第三句）、座位 2 未下雨陪包');
  const pay = (s) => r.payments.find((x) => x.seat === s).pay;
  assert.equal(pay(3), perPay, '包胡者付总分');
  assert.equal(pay(2), perPay, '陪包者付同样的分数');
  assert.equal(pay(1), 0, '座位 1 没有雨债（非包非欠）');
  assert.equal(r.totalWin, perPay * 2);
});

test('雨主没胡 → 包胡下雨全不计算：别人胡牌按其牌面正常结算（二次修订①）', () => {
  const st = blank(createGame({ seed: 10 }));
  st.ruleset = RS;
  // 雨主 = 座位 0（万），但最后胡的是座位 1 的筒子清一色
  st.players[0].melds = [
    { type: 'peng', tiles: [w(3), w(3), w(3)], from: 1 },
    { type: 'peng', tiles: [w(4), w(4), w(4)], from: 2 },
  ];
  st.players[1].melds = [
    { type: 'peng', tiles: [t(1), t(1), t(1)], from: 0 },
    { type: 'peng', tiles: [t(2), t(2), t(2)], from: 3 },
  ];
  st.players[1].opened = true;
  st.players[1].hand = [t(3), t(4), t(5), t(6), t(7), t(7), t(7)]; // 7 张（2 副露 → 待胡 7）
  st.players[0].hand = [w(5), w(5), t(1)];
  st.rains = [{ color: 0, owner: 0, baos: [3], penalties: [2] }]; // 座位 2 还被记过陪包
  st.lastDiscard = { tile: t(5), from: 3 };
  st.phase = 'claim';
  st.turn = 0;
  st.claimIndex = 0;
  st.claims = [{ seat: 1, priority: 3, options: [{ seat: 1, type: 'win', tile: t(5), priority: 3 }] }];

  act(st, { type: 'win', seat: 1 });
  const r = st.result;
  assert.ok(r && r.type === 'win');
  assert.ok(r.types.includes('qingYiSe'), '赢家是筒一色');
  assert.ok(!r.rainPayers, '雨主没胡 → 包胡下雨全不计算');
  assert.ok(!r.baozhuang, '无承包');
  assert.ok(r.payments.every((x) => x.pay > 0), '各输家按赢家牌面正常查表（座位 2 的陪包记录不生效）');
});

test('全求人点炮：义务人只剩雨花色将牌时打该将 → 不包全求人', () => {
  const make = (discarderHand) => {
    const st = blank(createGame({ seed: 10 }));
    st.ruleset = RS;
    // 跨花色副露 → 全求人+碰碰（非清一色）→ 纯测全求人包与豁免
    st.players[0].melds = [
      { type: 'peng', tiles: [w(1), w(1), w(1)], from: 1 },
      { type: 'peng', tiles: [t(2), t(2), t(2)], from: 2 },
      { type: 'peng', tiles: [18, 18, 18], from: 3 },
      { type: 'peng', tiles: [w(4), w(4), w(4)], from: 1 },
    ];
    st.players[0].opened = true;
    st.players[0].hand = [w(2)]; // 单吊 w2（对眼）
    st.players[1].melds = [{ type: 'peng', tiles: [t(1), t(1), t(1)], from: 0 }]; // 非将副露 → 非全手将
    st.players[1].hand = discarderHand;
    st.rains = [{ color: 0, owner: 3, baos: [2], penalties: [] }];
    st.lastDiscard = { tile: w(2), from: 1 };
    st.phase = 'claim';
    st.turn = 0;
    st.claimIndex = 0;
    st.claims = [{ seat: 0, priority: 3, options: [{ seat: 0, type: 'win', tile: w(2), priority: 3 }] }];
    return st;
  };

  // 手里只剩雨花色的将牌（万五）→ 被下雨逼着打的将 → 全求人包豁免
  const exempt = make([w(5)]);
  act(exempt, { type: 'win', seat: 0 });
  assert.ok(!exempt.result.baozhuang, '全求人包已豁免');
  assert.equal(exempt.result.rainPayers, undefined, '雨主没胡 → 不发生下雨结算');

  // 手里是雨花色的非将牌（万六）→ 不满足豁免 → 照常包全求人
  const bao = make([w(6)]);
  act(bao, { type: 'win', seat: 0 });
  assert.ok(bao.result.baozhuang, '不满足将牌条件 → 放炮者包全求人');
  assert.equal(bao.result.baozhuang.seat, 1);
});
