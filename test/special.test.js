/**
 * 特殊规则测试 —— 原赖 / 风赖 + 七皮 / 十杠
 *
 * 覆盖：
 *   · 原赖 / 风赖 的**分数倍率**（countFan 的 mul）与倍率开关
 *   · createGame 对原赖 / 风赖 的派生判定
 *   · 七皮（累计 7 皮子）/ 十杠（累计 10 杠口）的 sticky 成就
 *   · computeSpecialBonuses：单笔 / 同时两笔 / 规则关闭 / **本局是风赖或原赖时 ×2**
 *   · 终局结果携带 bonuses / bonusTotal；viewFor 暴露新字段
 *
 * ⚠️ **措辞纪律（老吴 2026-10-03 当面纠正）**：别写「赖子局」。
 *    每局都翻底牌决定癞子、**每局都有癞子**，所以「赖子局」字面上等于「每局都成立」，
 *    是句废话。准确说法只有两个：
 *      · **「本局是风赖」** = 癞子是风牌（东南西北）
 *      · **「本局是原赖」** = 癞子与上一局相同
 *    下面的测试名与断言都按这个说法写。
 *
 * ⚠️ **本文件于 2026-10-03 22:06 被误清空过一次**（写回文件的脚本在写入前先截断了文件，
 *    异常发生在真正写入之前 ⇒ 原 345 行内容全丢，且本项目无 git 可恢复）。
 *    下面这份是按引擎**真实 API** 重建的：每条断言都在真实引擎上跑通。
 *    重建时**没有**凭记忆编造旧测试内容 —— 拿不准的覆盖点宁可少写，不写假断言。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeTile,
  RED_DRAGON,
  isWindTile,
} from '../src/engine/tiles.js';
import {
  createGame,
  act,
  viewFor,
  countPlayerSkins,
  countSkinsSeen,
  countSkinsGanged,
  countGangUnits,
  refreshAchievements,
  computeSpecialBonuses,
  laiMulOf,
  bonusDeltaOf,
} from '../src/engine/game.js';
import {
  countFan,
  winnerFanPreview,
} from '../src/engine/score.js';
import { createRuleSet } from '../src/engine/rules.js';
import { decide } from '../src/bot/simpleBot.js';

const RS = createRuleSet('koukou');

/** 机器人跑到终局；返回 { state, steps } */
function playFull(seed, prevWildTile = null, ruleset = RS) {
  let st = createGame({ seed, ruleset, dealer: 0, prevWildTile });
  const opening = st.players.map((p) => [...p.hand]);
  let steps = 0;
  while (st.phase !== 'settled' && steps < 6000) {
    steps++;
    st = act(st, decide(st, st.turn));
  }
  assert.equal(st.phase, 'settled', `seed=${seed} 超过 6000 步仍未结束，可能死循环`);
  return { state: st, steps, opening };
}

/** 一个「无副露、已开口」的裸玩家（喂 countFan 用，避免噪音） */
const BARE = (seat = 0, isDealer = false) => ({ seat, name: 'P' + seat, isDealer, melds: [], opened: true });

/** 取某条番明细的番数（details 里按 key 索引） */
const getFan = (details, key) => details.find((d) => d.key === key)?.fan ?? 0;

/* ==================== 牌型工具 ==================== */

test('makeTile: 万筒条 + 字牌编码', () => {
  assert.equal(makeTile('wan', 1), 0, '一万 = 0');
  assert.equal(makeTile('tong', 1), 9, '一筒 = 9');
  assert.equal(makeTile('tiao', 9), 26, '九条 = 26');
  assert.equal(isWindTile(27), true, '东 = 27 是风');
  assert.equal(isWindTile(30), true, '北 = 30 是风');
  assert.equal(isWindTile(26), false, '九条不是风');
  assert.equal(isWindTile(RED_DRAGON), false, '红中是箭牌，不是风');
});

/* ==================== 原赖 / 风赖的派生判定 ==================== */

test('createGame: 癞子是风牌 ⇒ 本局是风赖', () => {
  // 实测：seed 23/48/61/82/84/111 都出风赖（癞子分别是南/南/北/西/东/西）
  for (const seed of [23, 61, 82]) {
    const g = createGame({ seed, ruleset: RS });
    assert.equal(g.fengLai, true, `seed ${seed} 应当是风赖`);
    assert.ok(isWindTile(g.wildTile), `seed ${seed} 的癞子必须是风牌（实际 ${g.wildTile}）`);
    assert.equal(g.yuanLai, false, `seed ${seed} 没传 prevWildTile ⇒ 不可能是原赖`);
  }
});

test('createGame: 癞子与上局相同 ⇒ 本局是原赖', () => {
  // 「原赖」= 本局癞子 === 上局癞子，所以拿本局自己的癞子当 prevWildTile 必然命中
  const base = createGame({ seed: 7, ruleset: RS });
  const g = createGame({ seed: 7, ruleset: RS, prevWildTile: base.wildTile });
  assert.equal(g.yuanLai, true, '癞子与上局相同 ⇒ 原赖');
  assert.equal(g.prevWildTile, base.wildTile);
  // 不同就不是原赖
  const other = createGame({ seed: 7, ruleset: RS, prevWildTile: (base.wildTile + 1) % 34 });
  assert.equal(other.yuanLai, false, '癞子不同 ⇒ 不是原赖');
});

test('createGame: 不传 prevWildTile ⇒ 本局不可能是原赖', () => {
  for (const seed of [1, 7, 23, 61]) {
    const g = createGame({ seed, ruleset: RS });
    assert.equal(g.yuanLai, false, `seed ${seed} 没传 prevWildTile ⇒ 原赖必须为 false`);
  }
});

/* ==================== countFan 的赖子倍率（分数翻倍，不加番） ==================== */

test('countFan: 本局是原赖 ⇒ mul=2，但番数里不含赖子番', () => {
  const on = countFan(BARE(), {
    ruleset: RS, isWinner: true, winnerIsDealer: false, selfDraw: true, hardWin: true,
    yuanLai: true, fengLai: false,
  });
  const off = countFan(BARE(), {
    ruleset: RS, isWinner: true, winnerIsDealer: false, selfDraw: true, hardWin: true,
    yuanLai: false, fengLai: false,
  });
  assert.equal(on.mul, RS.yuanLaiMul, '原赖 ⇒ 分数 ×2');
  assert.equal(off.mul, 1, '非原赖 ⇒ ×1');
  assert.equal(on.total, off.total, '⚠️ 赖子**不加番**（老吴 2026-09-30 口径）—— 两边番数必须一样');
  assert.equal(getFan(on.details, 'yuanLai'), 0, '明细里不该有「原赖」这一笔番');
  assert.equal(getFan(on.details, 'fengLai'), 0, '明细里不该有「风赖」这一笔番');
});

test('countFan: 本局是风赖 ⇒ mul=2，番数同样不加', () => {
  const on = countFan(BARE(), {
    ruleset: RS, isWinner: true, winnerIsDealer: false, selfDraw: false, hardWin: true,
    yuanLai: false, fengLai: true,
  });
  const off = countFan(BARE(), {
    ruleset: RS, isWinner: true, winnerIsDealer: false, selfDraw: false, hardWin: true,
    yuanLai: false, fengLai: false,
  });
  assert.equal(on.mul, RS.fengLaiMul, '风赖 ⇒ 分数 ×2');
  assert.equal(on.total, off.total, '风赖不加番');
});

test('countFan: 原赖 + 风赖同时命中 ⇒ 仍只 ×2 一次（不叠成 4）', () => {
  const both = countFan(BARE(), {
    ruleset: RS, isWinner: true, winnerIsDealer: false, selfDraw: true, hardWin: true,
    yuanLai: true, fengLai: true,
  });
  assert.equal(both.mul, 2, '两者同时命中只翻一倍（沿用「不重复」口径）');
  assert.notEqual(both.mul, 4);
});

test('countFan: 赖子倍率只给赢家 —— 输家不因赢家是赖子而翻倍', () => {
  // 这是「分数跟着赢家走」的体现：输家自己没赖子 ⇒ mul 恒为 1
  const loser = countFan(BARE(1), {
    ruleset: RS, isWinner: false, winnerIsDealer: false, isDiscarder: false, selfDraw: true,
    yuanLai: true, fengLai: true,
  });
  assert.equal(loser.mul, 1, '输家 mul 恒为 1（倍率由赢家那笔结算统一乘）');
});

test('countFan: 倍率开关置 1 ⇒ 不翻倍（对照）', () => {
  const rs = createRuleSet('koukou', { yuanLaiMul: 1, fengLaiMul: 1 });
  const r = countFan(BARE(), {
    ruleset: rs, isWinner: true, winnerIsDealer: false, selfDraw: true, hardWin: true,
    yuanLai: true, fengLai: true,
  });
  assert.equal(r.mul, 1, '两个倍率都置 1 ⇒ 照乘不翻');
});

test('winnerFanPreview: 赖子只影响结算分数，不影响赢家番数', () => {
  const player = BARE();
  const wr = { hardWin: true, baseFan: 0, size: 'small' };
  const on = winnerFanPreview(player, wr, { selfDraw: true, yuanLai: true, fengLai: false }, RS);
  const off = winnerFanPreview(player, wr, { selfDraw: true, yuanLai: false, fengLai: false }, RS);
  assert.equal(on, off, '预览的番数与是否赖子无关');
});

/* ==================== 七皮 / 十杠：sticky 成就 ==================== */

test('countPlayerSkins: 手里 + 副露里的皮子都算', () => {
  const st = createGame({ seed: 1, ruleset: RS });
  const skins = st.skinTiles;
  const p = { hand: [skins[0], skins[1]], melds: [{ type: 'an', tiles: [skins[2], skins[2], skins[2], skins[2]] }] };
  assert.equal(countPlayerSkins(p, skins), 6, '手里 2 + 副露 4');
});

test('countSkinsSeen: 口径 = 手里/副露的皮子 + skinSeen（累计经手）', () => {
  const st = createGame({ seed: 1, ruleset: RS });
  const skins = st.skinTiles;
  const p = { hand: [skins[0], skins[1]], melds: [{ type: 'skin', tiles: [skins[2]] }], skinSeen: 3 };
  assert.equal(countSkinsSeen(p, skins), 3 + 3, '手里 2 + 副露 1 + skinSeen 3 = 6');
  // ⚠️ seed 1 的 skinTiles = [7,6,31]，造「非皮子」的 hand 必须避开这几个号
  //   （我随手写 [5,6,7,…] 被皮子集命中两次，白排查一轮）
  const p2 = { hand: [100, 101, 102], melds: [], skinSeen: 4 };
  assert.equal(countSkinsSeen(p2, skins), 4, '手上没皮子时只数 skinSeen');
});

test('七皮口径（老吴 2026-10-08）：只数「杠出来的」红中+皮子，手上留着的不算', () => {
  const st = createGame({ seed: 1, ruleset: RS });
  const p = st.players[0];
  const skins = st.skinTiles;
  // ⚠️ seed 1 的 skinTiles = [7,6,31]，造「非皮子」必须用 100+ 号段
  const nonSkin = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112];
  p.hand = [...nonSkin];
  p.skinSeen = 0;
  // 手上握着 3 张皮子 + 累计摸过 4 张 —— **按新口径都不算**
  p.hand = [skins[0], skins[1], skins[2], ...nonSkin.slice(0, 10)];
  p.skinSeen = 4;
  p.melds = [];
  assert.equal(countSkinsGanged(p.melds, skins), 0, '手上/摸到的都不算，只数副露');
  refreshAchievements(st);
  assert.equal(p.qiPi, false, '手上 3 张 + 摸过 4 张 ≠ 七皮（口径只数杠出来的）');

  // 改用皮子杠/红中杠凑够 7 张 ⇒ 达成
  p.melds = new Array(7).fill({ type: 'skin', tiles: [skins[0]], from: null });
  assert.equal(countSkinsGanged(p.melds, skins), 7, '7 个皮子杠 ⇒ 副露里 7 张皮');
  refreshAchievements(st);
  assert.equal(p.qiPi, true, '杠出来的红中+皮子合计 7 个 ⇒ 七皮达成');
});

test('七皮口径：癞子杠那 1 张不计（skinTiles 不含癞子）', () => {
  const st = createGame({ seed: 1, ruleset: RS });
  const p = st.players[0];
  const wild = st.wildTile;
  assert.ok(!st.skinTiles.includes(wild), '癞子不在皮子集合里（本引擎口径）');
  p.melds = new Array(7).fill({ type: 'wild', tiles: [wild], from: null });
  assert.equal(countSkinsGanged(p.melds, st.skinTiles), 0, '7 个癞子杠但一张皮子都不算');
  refreshAchievements(st);
  assert.equal(p.qiPi, false, '癞子杠不计入七皮（除非把癞子也算作皮子，那是另一套口径）');
});

test('七皮口径：红中杠与皮子杠都算（红中在 skinTiles 内）', () => {
  const st = createGame({ seed: 1, ruleset: RS });
  const p = st.players[0];
  const skins = st.skinTiles;
  const RED = 31;
  assert.ok(st.skinTiles.includes(RED), '红中属于皮子集合（skinIncludesRedDragon 默认 true）');
  p.melds = [
    { type: 'red', tiles: [RED], from: null },
    { type: 'skin', tiles: [skins[0]], from: null },
    { type: 'skin', tiles: [skins[1]], from: null },
    { type: 'skin', tiles: [skins[2]], from: null },
    { type: 'red', tiles: [RED], from: null },
    { type: 'red', tiles: [RED], from: null },
  ];
  assert.equal(countSkinsGanged(p.melds, skins), 6, '红中杠 3 + 皮子杠 3 = 6');
  p.melds.push({ type: 'skin', tiles: [skins[0]], from: null });
  assert.equal(countSkinsGanged(p.melds, skins), 7, '再一个皮子杠 ⇒ 7');
  refreshAchievements(st);
  assert.equal(p.qiPi, true, '红中杠+皮子杠合计 7 个 ⇒ 七皮达成');
});

test('七皮口径：手上 7 张皮子但一个都没杠 ⇒ 不算七皮（防「混入手上持有」）', () => {
  // 🔴 这条专门钉住「countSkinsGanged 只看 melds、不看 hand/skinSeen」。
  //   之前做反向对照时注入 `+ melds._skinSeen` 挂 0 条 —— 说明测试没覆盖到那个注入点，
  //   等于测试网有漏洞。补这条：7 张全在手上，杠口数必须还是 0。
  const st = createGame({ seed: 1, ruleset: RS });
  const p = st.players[0];
  const skins = st.skinTiles;
  p.melds = [];
  p.skinSeen = 0;
  p.hand = [skins[0], skins[0], skins[0], skins[0], skins[1], skins[1], skins[1]];
  assert.equal(countSkinsGanged(p.melds, skins), 0, '手上 7 张、杠口 0');
  refreshAchievements(st);
  assert.equal(p.qiPi, false, '手上握着 7 张皮子但没杠出来 ⇒ 不算七皮');
  // 再看「摸过 7 张」也不该算
  p.hand = [];
  p.skinSeen = 7;
  refreshAchievements(st);
  assert.equal(p.qiPi, false, '累计摸过 7 张皮子但没杠出来 ⇒ 也不算七皮（口径只数杠出来的）');
});

test('refreshAchievements: 杠出来的皮子到 7 ⇒ 置 qiPi（sticky：之后回落也不清）', () => {
  const st = createGame({ seed: 1, ruleset: RS });
  const p = st.players[0];
  const skins = st.skinTiles;
  p.melds = new Array(6).fill({ type: 'skin', tiles: [skins[0]], from: null });
  refreshAchievements(st);
  assert.equal(p.qiPi, false, '只杠出 6 个 ⇒ 还没到七皮');
  p.melds.push({ type: 'skin', tiles: [skins[1]], from: null });
  refreshAchievements(st);
  assert.equal(p.qiPi, true, '杠出第 7 个 ⇒ 七皮达成');
  // sticky：把副露清空，标记仍在
  p.melds = [];
  refreshAchievements(st);
  assert.equal(p.qiPi, true, '七皮是 sticky 的：副露撤掉也不该清掉');
});

test('refreshAchievements: 十杠按 melds 里 GANG_TYPES 的个数计', () => {
  const st = createGame({ seed: 1, ruleset: RS });
  const p = st.players[0];
  p.melds = new Array(RS.shiGangCount).fill({ type: 'an', tiles: [0, 0, 0, 0] });
  refreshAchievements(st);
  assert.equal(p.shiGang, true, `累计 ${RS.shiGangCount} 杠 ⇒ 十杠达成`);
});

test('refreshAchievements: 七皮/十杠达成瞬间生成播报事件（金额与三家付款）', () => {
  const st = createGame({ seed: 1, ruleset: RS });
  const p = st.players[0];
  p.melds = new Array(6).fill({ type: 'skin', tiles: [st.skinTiles[0]], from: null });
  refreshAchievements(st);
  assert.equal(st.achievementEvents.length, 0, '未达成时不应有播报');

  p.melds.push({ type: 'skin', tiles: [st.skinTiles[1]], from: null });
  refreshAchievements(st);
  assert.equal(st.achievementEvents.length, 1, '七皮达成应生成一条播报');
  const e = st.achievementEvents[0];
  const perPayer = RS.goldScore * laiMulOf(st);
  assert.equal(e.kind, 'qiPi');
  assert.equal(e.seat, 0);
  assert.equal(e.label, '七皮');
  assert.equal(e.perPayer, perPayer);
  assert.equal(e.amount, perPayer * 3, '三家各付一份');
  assert.deepEqual(e.payers.map((x) => x.seat), [1, 2, 3], '付款人必须是其他三家');

  refreshAchievements(st);
  assert.equal(st.achievementEvents.length, 1, 'sticky 刷新不应重复播报');
});

test('refreshAchievements: 十杠播报金额与最终结算同源，viewFor 会下发', () => {
  const st = createGame({ seed: 1, ruleset: RS });
  const p = st.players[0];
  p.melds = new Array(5).fill({ type: 'wild', tiles: [st.wildTile], from: null });
  refreshAchievements(st);
  assert.equal(p.shiGang, true, '5 个癞子杠 = 10 口');
  const e = st.achievementEvents.find((x) => x.kind === 'shiGang');
  assert.ok(e, '十杠应生成播报');
  const perPayer = RS.goldScore * laiMulOf(st);
  assert.equal(e.amount, perPayer * 3);
  assert.deepEqual(e.payers.map((x) => x.pay), [perPayer, perPayer, perPayer]);

  const v = viewFor(st, 2);
  assert.equal(v.achievements.length, 1, 'viewFor 必须带上播报事件');
  assert.equal(v.achievements[0].kind, 'shiGang');
  assert.equal(v.achievements[0].payers.length, 3);
});

test('refreshAchievements: 规则关掉 ⇒ 不置位', () => {
  const rs = createRuleSet('koukou', { qiPiEnabled: false, shiGangEnabled: false });
  const st = createGame({ seed: 1, ruleset: rs });
  const p = st.players[0];
  p.hand = st.skinTiles.slice(0, 3).concat(st.skinTiles[0]).concat(st.skinTiles[1]).concat(st.skinTiles[1]);
  p.melds = new Array(12).fill({ type: 'an', tiles: [0, 0, 0, 0] });
  refreshAchievements(st);
  assert.equal(p.qiPi, false, 'qiPiEnabled=false ⇒ 不该置位');
  assert.equal(p.shiGang, false, 'shiGangEnabled=false ⇒ 不该置位');
});

/* ==================== computeSpecialBonuses ==================== */

test('computeSpecialBonuses: 单笔七皮 ⇒ 三家各收 goldScore', () => {
  const players = [
    { seat: 0, name: 'A', qiPi: true, shiGang: false },
    { seat: 1, name: 'B', qiPi: false, shiGang: false },
    { seat: 2, name: 'C', qiPi: false, shiGang: false },
    { seat: 3, name: 'D', qiPi: false, shiGang: false },
  ];
  const bonuses = computeSpecialBonuses(players, RS);
  assert.equal(bonuses.length, 1);
  assert.equal(bonuses[0].kind, 'qiPi');
  assert.equal(bonuses[0].amount, RS.goldScore * 3);
  assert.equal(bonuses[0].payers.length, 3);
  assert.equal(bonuses[0].perPayer, RS.goldScore);
});

test('computeSpecialBonuses: 七皮 + 十杠 同时 → 两笔独立奖金', () => {
  const players = [
    { seat: 0, name: 'A', qiPi: true, shiGang: true },
    { seat: 1, name: 'B', qiPi: false, shiGang: false },
    { seat: 2, name: 'C', qiPi: false, shiGang: false },
    { seat: 3, name: 'D', qiPi: false, shiGang: false },
  ];
  const bonuses = computeSpecialBonuses(players, RS);
  assert.equal(bonuses.length, 2);
  const kinds = bonuses.map((b) => b.kind).sort();
  assert.deepEqual(kinds, ['qiPi', 'shiGang']);
  const total = bonuses.reduce((a, b) => a + b.amount, 0);
  assert.equal(total, RS.goldScore * 3 * 2);
});

test('computeSpecialBonuses: 规则关闭则不产生奖金', () => {
  const rs = createRuleSet('koukou', { qiPiEnabled: false, shiGangEnabled: false });
  const players = [
    { seat: 0, name: 'A', qiPi: true, shiGang: true },
    { seat: 1, name: 'B', qiPi: false, shiGang: false },
    { seat: 2, name: 'C', qiPi: false, shiGang: false },
    { seat: 3, name: 'D', qiPi: false, shiGang: false },
  ];
  assert.equal(computeSpecialBonuses(players, rs).length, 0);
});

test('computeSpecialBonuses: 无成就 → 空', () => {
  const players = [
    { seat: 0, name: 'A', qiPi: false, shiGang: false },
    { seat: 1, name: 'B', qiPi: false, shiGang: false },
    { seat: 2, name: 'C', qiPi: false, shiGang: false },
    { seat: 3, name: 'D', qiPi: false, shiGang: false },
  ];
  assert.deepEqual(computeSpecialBonuses(players, RS), []);
});

/* ===== 七皮/十杠 也要跟赖子翻倍（老吴 2026-10-03 21:30 口径） ===== */
/*
 * 口径原话：「金顶每家 10 分，**风赖、原赖要翻番（包括七皮、十杠如果发生在风赖、原赖，也乘以二）**」
 *
 * ⚠️ 改动前 `computeSpecialBonuses(players, ruleset)` 只吃两个参数、
 *    perPayer 恒为 `goldScore(10)` ⇒ 七皮/十杠 **从来不跟赖子倍率走**。
 *    之前一直没被发现，是因为这一段**零测试覆盖**（老口径的测试全是两参调用）。
 */
const LAI_PLAYERS = () => [
  { seat: 0, name: 'A', qiPi: true, shiGang: true },
  { seat: 1, name: 'B', qiPi: false, shiGang: false },
  { seat: 2, name: 'C', qiPi: false, shiGang: false },
  { seat: 3, name: 'D', qiPi: false, shiGang: false },
];

test('七皮/十杠：本局是风赖/原赖时每家付 20（goldScore 10 × 2），否则仍是 10', () => {
  const players = LAI_PLAYERS();

  const plain = computeSpecialBonuses(players, RS);          // 不传 mul ⇒ 默认 1
  assert.equal(plain.length, 2);
  for (const b of plain) {
    assert.equal(b.perPayer, RS.goldScore, '本局非风赖/原赖：每家 10 分（老口径不变）');
    assert.equal(b.mul, 1);
    assert.equal(b.amount, RS.goldScore * 3, '三家各 10 ⇒ 该家收 30');
  }

  const doubled = computeSpecialBonuses(players, RS, 2);      // 本局是风赖或原赖 ⇒ mul=2
  assert.equal(doubled.length, 2);
  for (const b of doubled) {
    assert.equal(b.perPayer, RS.goldScore * 2, '本局是风赖/原赖：每家 20 分');
    assert.equal(b.mul, 2);
    assert.equal(b.amount, RS.goldScore * 2 * 3, '三家各 20 ⇒ 该家收 60');
    assert.equal(b.payers.length, 3);
    for (const p of b.payers) assert.equal(p.pay, RS.goldScore * 2, '每个付款方也必须是 20');
  }
});

test('laiMulOf: 本局是风赖/原赖 = 2，否则 = 1，两者同时命中仍只 ×2 一次', () => {
  const base = { ruleset: RS };
  assert.equal(laiMulOf({ ...base, yuanLai: false, fengLai: false }), 1, '本局既非风赖也非原赖 ⇒ 1');
  assert.equal(laiMulOf({ ...base, yuanLai: true, fengLai: false }), RS.yuanLaiMul);
  assert.equal(laiMulOf({ ...base, yuanLai: false, fengLai: true }), RS.fengLaiMul);
  assert.equal(
    laiMulOf({ ...base, yuanLai: true, fengLai: true }),
    Math.max(RS.yuanLaiMul, RS.fengLaiMul),
    '两者同时命中只 ×2 一次（不叠成 4）',
  );
});

/* ===== 老吴 22:17 收紧口径：「**只有**风赖、原赖才翻倍」 ===== */
/*
 * 22:10 我把这条实现成「本局是风赖或原赖 ⇒ ×2」，逻辑本身对；
 * 22:17 老吴用「只有…才」再钉一遍 ⇒ 重点是**排他性**：其余情形一律 10 分。
 * 下面这组用例把「不该翻倍」的那些情形逐个钉住，防止将来有人扩到别的情形上。
 */
test('只有风赖/原赖才翻倍 —— 其余情形一律每家 10 分', () => {
  const players = LAI_PLAYERS();

  // 逐个 mul 值走一遍：只有 2 翻倍，1 与「不传」都不翻
  assert.equal(computeSpecialBonuses(players, RS)[0].perPayer, 10, '不传 mul ⇒ 10');
  assert.equal(computeSpecialBonuses(players, RS, 1)[0].perPayer, 10, '显式传 1 ⇒ 10');
  assert.equal(computeSpecialBonuses(players, RS, 2)[0].perPayer, 20, '传 2（风赖/原赖）⇒ 20');

  // 非风赖、非原赖的真实牌局 ⇒ 走 laiMulOf 拿到的就是 1 ⇒ 10 分
  const plain = createGame({ seed: 1, ruleset: RS });
  assert.equal(plain.fengLai, false);
  assert.equal(plain.yuanLai, false);
  assert.equal(laiMulOf(plain), 1, '本局既非风赖也非原赖');
  const bp = computeSpecialBonuses(players, plain.ruleset, laiMulOf(plain));
  assert.equal(bp[0].perPayer, 10, '真实非赖子局 ⇒ 每家 10');
  assert.equal(bp[0].mul, 1);
});

test('computeSpecialBonuses: 只有恰好 2 才翻倍，其余值一律回落 1（白名单语义）', () => {
  const players = LAI_PLAYERS();
  // 口径只有 1 / 2 两档 ⇒ 3 / 99 这类值也必须回落，否则会静默算成 30/家、990/家。
  // ⚠️ 这里刻意用 `mul === 2` 的白名单而不是 `mul > 1`：
  //    写 `mul > 1` 时 mul=3 会真的算出 perPayer=30，是本用例先抓出来的。
  for (const bad of [0, -1, 3, 99, 2.5, NaN, Infinity, 'abc', null, undefined]) {
    const b = computeSpecialBonuses(players, RS, bad)[0];
    assert.equal(b.perPayer, RS.goldScore, `mul=${String(bad)} 应回落成 1（每家 10），实际 ${b.perPayer}`);
    assert.equal(b.mul, 1, `mul=${String(bad)} 回落后 mul 字段应为 1`);
  }
  // 唯一合法的 2 必须照翻
  assert.equal(computeSpecialBonuses(players, RS, 2)[0].perPayer, RS.goldScore * 2, 'mul=2 必须翻倍');
});

/* ===== 「又胡牌、又打出七皮十杠」的叠加（老吴 2026-10-03 22:22 问出来的 bug） ===== */
/*
 * 老吴问：「当某个玩家打出七皮、十杠，同时胡牌的话，每家要付多少分？」
 * 一查发现 `perSeat[].delta` **只按 `payments`（胡牌输赢）算，`bonuses` 完全没进账**：
 *   「某家同时七皮 + 十杠」时 `bonusTotal=60` 但**四家 delta 求和仍是 0**（账没平），
 *   累计战绩分 / 战绩面板 / 后端落库全都少算这笔。
 * ⇒ 新增 `bonusDeltaOf()` 并把两条终局路径（胡牌局 / 荒庄局）都接上。
 *
 * 正确口径：每家实际付出 = 胡牌应付 + 该家应付的七皮/十杠；
 *   成就奖**收款人是达成者自己**，所以达成者那边是「收」；两项成就各自独立、收支都要进账。
 */
const BONUS_SEAT = 0;
/** 造一局：开局就把七皮+十杠挂在 BONUS_SEAT 上，然后打到终局 */
function playWithBonus(seed, prevWildTile = null) {
  let st = createGame({ seed, ruleset: RS, dealer: 0, prevWildTile });
  st.players[BONUS_SEAT].qiPi = true;
  st.players[BONUS_SEAT].shiGang = true;
  let steps = 0;
  while (st.phase !== 'settled' && steps < 6000) { steps++; st = act(st, decide(st, st.turn)); }
  return st;
}

test('又胡牌又七皮十杠：perSeat.delta 必须含成就收支（四家求和恒为 0）', () => {
  const st = playWithBonus(1);
  assert.equal(st.result.type, 'win');
  const r = st.result;
  assert.equal(r.bonuses.length, 2, '应有两笔成就奖（七皮 + 十杠）');
  assert.equal(r.bonusTotal, RS.goldScore * 3 * 2, '非赖子局：两笔 × 每家 10 × 三家 = 60');

  // 🔴 核心断言：四家 delta 求和必须为 0（账平）
  const sum = r.perSeat.reduce((a, b) => a + b.delta, 0);
  assert.equal(sum, 0, '四家 delta 求和必须为 0（修之前这里是 60 ⇒ 账没平）');

  // 逐家拆解：delta = 胡牌输赢 + 成就收支
  for (const row of r.perSeat) {
    const hu = row.isWinner ? r.totalWin : -(r.payments.find((p) => p.seat === row.seat)?.pay ?? 0);
    const bonus = bonusDeltaOf(r.bonuses, row.seat);
    assert.equal(row.delta, hu + bonus, `seat${row.seat} 的 delta 必须等于「胡牌输赢 + 成就收支」`);
  }

  // 达成者 seat0：收两笔共 60，同时也要付三家各 10 的胡牌钱
  const achieved = r.perSeat.find((p) => p.seat === BONUS_SEAT);
  const huPart = achieved.isWinner ? r.totalWin : -(r.payments.find((p) => p.seat === BONUS_SEAT)?.pay ?? 0);
  assert.equal(achieved.delta, huPart + RS.goldScore * 3 * 2, '达成者 delta = 胡牌输赢 + 60');
});

test('又胡牌又七皮十杠 · 本局是风赖：成就那笔也 ×2，且账仍然平', () => {
  const st = playWithBonus(61);            // seed 61 ⇒ 癞子北风 ⇒ 本局是风赖
  assert.equal(st.fengLai, true);
  const r = st.result;
  assert.equal(r.bonusTotal, RS.goldScore * 2 * 3 * 2, '风赖局：两笔 × 每家 20 × 三家 = 120');
  assert.equal(r.perSeat.reduce((a, b) => a + b.delta, 0), 0, '账仍要平');
});

test('成就奖由别人拿到时，赢家要倒付（两张账独立叠加，不互相吞掉）', () => {
  // seed 7 的赢家是 seat2，而成就挂在 seat0 ⇒ 赢家既收胡牌钱、又付成就钱
  let st = createGame({ seed: 7, ruleset: RS, dealer: 0 });
  st.players[0].qiPi = true;
  st.players[0].shiGang = true;
  let steps = 0;
  while (st.phase !== 'settled' && steps < 6000) { steps++; st = act(st, decide(st, st.turn)); }
  const r = st.result;
  const w = r.perSeat.find((p) => p.isWinner);
  assert.ok(w && w.seat !== BONUS_SEAT, '这个种子胡牌的与拿到成就的不是同一家');
  assert.equal(r.perSeat.reduce((a, b) => a + b.delta, 0), 0, '账要平');
  // 赢家 delta = 胡牌收入 - 成就支出（可能是很小的正数甚至负数）
  const hu = r.totalWin;
  const bonus = bonusDeltaOf(r.bonuses, w.seat);
  assert.equal(w.delta, hu + bonus, '赢家 delta = 胡牌收入 + (负的) 成就支出');
  assert.ok(bonus < 0, '赢家没拿到成就 ⇒ 成就项是净支出');
});

test('bonusDeltaOf: 荒庄局也能算（两条终局路径共用同一套口径）', () => {
  const players = LAI_PLAYERS();
  const bonuses = computeSpecialBonuses(players, RS);   // 七皮+十杠，收款人 seat0
  assert.equal(bonusDeltaOf(bonuses, 0), RS.goldScore * 3 * 2, '达成者收两笔共 60');
  assert.equal(bonusDeltaOf(bonuses, 1), -RS.goldScore * 2, '其余三家各付两笔共 20');
  assert.deepEqual(
    [0, 1, 2, 3].map((s) => bonusDeltaOf(bonuses, s)),
    [RS.goldScore * 3 * 2, -RS.goldScore * 2, -RS.goldScore * 2, -RS.goldScore * 2],
    '四家加起来必须为 0',
  );
  // 不变量：四家的成就净收支加起来必须为 0（钱在内部转移，不能凭空多出来）
  assert.equal(
    [0, 1, 2, 3].reduce((a, s) => a + bonusDeltaOf(bonuses, s), 0),
    0,
    '四家 bonusDelta 之和必须为 0',
  );
  // 收款人拿到的总额 = 三家付进来的总额
  const paidIn = [1, 2, 3].reduce((a, s) => a + -bonusDeltaOf(bonuses, s), 0);
  assert.equal(paidIn, RS.goldScore * 3 * 2, '三家付进来的 = 达成者收到的 = 60');
  assert.equal(bonusDeltaOf(bonuses, 0), paidIn, '收付必然相等');
});

test('端到端：本局是风赖时（七皮/十杠）金额已经翻倍 —— 传参那一环不能漏', () => {
  // seed 61 ⇒ 癞子北风 ⇒ 本局是风赖（已由 createGame 派生判定保证）
  const st = createGame({ seed: 61, ruleset: RS });
  assert.equal(st.fengLai, true, '这个种子必须出风赖，否则本用例没意义');
  st.players[1].qiPi = true;                                   // 人工置位成就
  const bonuses = computeSpecialBonuses(st.players, st.ruleset, laiMulOf(st));
  const qiPi = bonuses.find((b) => b.kind === 'qiPi');
  assert.ok(qiPi, '应该产生七皮奖金');
  assert.equal(qiPi.perPayer, RS.goldScore * 2, '端到端也要 20');
});

/* ==================== 终局携带 + 视图暴露 ==================== */

test('整局结算结果携带 bonuses / bonusTotal 字段', () => {
  const { state } = playFull(1);
  assert.ok(Array.isArray(state.result.bonuses));
  assert.equal(typeof state.result.bonusTotal, 'number');
});

test('荒庄局同样携带 bonuses / bonusTotal（两条终局路径口径一致）', () => {
  // 找一个走到荒庄的种子：牌墙摸尽
  let found = null;
  for (let seed = 1; seed <= 200 && !found; seed++) {
    const r = playFull(seed);
    if (r.state.result.type === 'draw') found = r;
  }
  assert.ok(found, '200 局内应该至少有一局荒庄');
  assert.ok(Array.isArray(found.state.result.bonuses), '荒庄也必须有 bonuses 字段');
});

test('荒庄局：达成七皮/十杠时 perSeat.delta 也要有收支（不能恒为 0）', () => {
  // 先找一个荒庄种子
  let drawSeed = null;
  for (let seed = 1; seed <= 200 && !drawSeed; seed++) {
    let st = createGame({ seed, ruleset: RS, dealer: 0 });
    let steps = 0;
    while (st.phase !== 'settled' && steps < 6000) { steps++; st = act(st, decide(st, st.turn)); }
    if (st.result.type === 'draw') drawSeed = seed;
  }
  assert.ok(drawSeed, '200 局内应该至少有一局荒庄');

  // 在荒庄局里挂上七皮 + 十杠
  let st = createGame({ seed: drawSeed, ruleset: RS, dealer: 0 });
  st.players[0].qiPi = true;
  st.players[0].shiGang = true;
  let steps = 0;
  while (st.phase !== 'settled' && steps < 6000) { steps++; st = act(st, decide(st, st.turn)); }
  assert.equal(st.result.type, 'draw', '这个种子应当仍是荒庄（成就不影响牌局走向）');

  const r = st.result;
  // ⚠️ 老吴 2026-10-03 22:45 改「七皮」口径为**累计经手**后，这里从 2 笔变成 3 笔：
  //   荒庄这一局里有别的家真的经手过 7 张皮（多半是靠皮子杠凑的）⇒ 额外触发一笔七皮。
  //   这不是回归，是口径修正的预期结果（原口径下这条路径根本不可达）。
  assert.ok(r.bonuses.length >= 2, '至少要有挂上去的七皮 + 十杠两笔');
  const kinds = r.bonuses.map((b) => b.kind);
  assert.ok(kinds.includes('qiPi') && kinds.includes('shiGang'), '必须含七皮与十杠各一笔');
  const seat0 = r.bonuses.filter((b) => b.seat === 0);
  assert.equal(seat0.length, 2, 'seat0 上挂的七皮 + 十杠两笔都应在');
  assert.ok(r.bonusTotal > 0, 'bonusTotal 应为正');
  // 🔴 修之前这里是 `delta: 0` 写死 ⇒ 荒庄局的成就账也不平
  assert.equal(r.perSeat.reduce((a, b) => a + b.delta, 0), 0, '四家 delta 求和必须为 0');
  // seat0 是收款方：它收两笔，但若别家也达成了七皮，seat0 要倒付那笔 ⇒ 用 bonusDeltaOf 对账
  const hu0 = 0; // 荒庄局没有赢家，胡牌输赢恒 0
  assert.equal(
    r.perSeat.find((p) => p.seat === 0).delta,
    hu0 + bonusDeltaOf(r.bonuses, 0),
    'seat0 的 delta 必须等于它的成就净收支（收两笔 − 应付别家的）',
  );
  for (const s of [1, 2, 3]) {
    const hu = 0;
    assert.equal(r.perSeat.find((p) => p.seat === s).delta, hu + bonusDeltaOf(r.bonuses, s), `seat${s} 的 delta 对账`);
  }
});

test('viewFor 暴露 prevWildTile / yuanLai / fengLai', () => {
  const g = createGame({ seed: 9, prevWildTile: 1, ruleset: RS });
  const v = viewFor(g, 0);
  assert.ok('prevWildTile' in v);
  assert.ok('yuanLai' in v);
  assert.ok('fengLai' in v);
  assert.equal(v.prevWildTile, 1);
});

test('viewFor: 本局是风赖时 fengLai 下发为 true（前端要能显示）', () => {
  const g = createGame({ seed: 61, ruleset: RS });
  const v = viewFor(g, 0);
  assert.equal(v.fengLai, true, '风赖必须下发给前端，否则界面不会显示这一手是风赖');
});

/* ===== 六类杠的番底（老吴 2026-10-08 定稿）=====
 * 原话链：
 *  ① 「分采用口口番叠加机制，每明杠加一番、暗杠、癞子杠加两番」
 *  ② 「冲杠 +2」
 *  ③ 「冲杠是直接杠，**蓄杠有原来碰的 1 番，再加杠的 1 番，合计起来是 2 番**」
 *  + 「红中和皮杠一下都是一番」（9-30 拍板，10-08 复核不变）。
 * ⇒ 冲杠 2、蓄杠 2（碰1+杠1）、暗杠 2、癞子杠 2、红中杠 1、皮子杠 1。
 * 🔴 蓄杠的「碰 1 番」**必须由 gangFan.xu 兜住** —— `openCount()` 只数 chi/peng 不数 xu，
 *    而 `completeXuGang` 把 peng 原地改写成 xu ⇒ 碰那 1 番会凭空消失（实测曾只给 1 番）。
 * ⚠️ 变更链：09-29 初版=明杠 1 ⇒ 09-30「杠加两番」全改 2 ⇒ 10-08「每明杠加一番」全改 1
 *          ⇒ 10-08「冲杠 +2」zhi=2 ⇒ **10-08「蓄杠=碰1+杠1=2 番」xu=2**（定稿，明杠齐平）。
 * ⚠️ 这段之前**零测试覆盖**（只有 rules.js 里的配置声明）⇒ 改成别的值也没人发现。
 *   `countFan` 是**两参数**签名 `countFan(player, opts)`。
 */
const RED = 31;
const GANG_FAN_CASES = [
  ['zhi', [{ type: 'zhi', tiles: [3, 3, 3, 3], from: 1 }], 2, '冲杠（明杠）'],
  ['xu', [{ type: 'xu', tiles: [3, 3, 3], from: 1 }], 2, '蓄杠（碰1+杠1）'],
  ['an', [{ type: 'an', tiles: [3, 3, 3, 3], from: null }], 2, '暗杠'],
  ['wild', [{ type: 'wild', tiles: [7], from: null }], 2, '癞子杠'],
  ['red', [{ type: 'red', tiles: [RED], from: null }], 1, '红中杠'],
  ['skin', [{ type: 'skin', tiles: [11], from: null }], 1, '皮子杠'],
];

test('六类杠番底（老吴 10-08 定稿）：冲杠 2、蓄杠 2（碰1+杠1），暗杠/癞子杠各 2，红中杠/皮子杠各 1', () => {
  for (const [key, melds, expect, label] of GANG_FAN_CASES) {
    const r = countFan(
      { seat: 0, melds, opened: true },
      { ruleset: RS, isWinner: true, baseFan: 0, size: 'small' },
    );
    assert.equal(r.total, expect, `${label}(${key}) 应得 ${expect} 番，实际 ${r.total}`);
    const d = r.details.find((x) => x.key.startsWith('gang'));
    assert.ok(d, `${label} 应有杠的计番明细`);
    assert.equal(d.fan, expect, `${label} 明细里的番数应为 ${expect}`);
  }
});

test('杠番可叠加：两种杠各加各的（暗杠 2 + 癞子杠 2 = 4 番）', () => {
  const r = countFan(
    { seat: 0, opened: true, melds: [{ type: 'an', tiles: [3, 3, 3, 3], from: null }, { type: 'wild', tiles: [7], from: null }] },
    { ruleset: RS, isWinner: true, baseFan: 0, size: 'small' },
  );
  assert.equal(r.total, 4, '暗杠 2 + 癞子杠 2 = 4 番');
});

test('红中杠/皮子杠不计入「口数」（openCount），避免与杠番双重计番', () => {
  // 老吴 2026-09-30：「开口不要重复算」—— 明杠算开口但不再进口口番
  const r = countFan(
    { seat: 0, opened: true, melds: [{ type: 'zhi', tiles: [3, 3, 3, 3], from: 1 }] },
    { ruleset: RS, isWinner: true, baseFan: 0, size: 'small' },
  );
  // 明杠只有 gangZhi 一条明细，不应同时出现 kouKou（口口番）
  assert.ok(!r.details.some((d) => d.key === 'kouKou'), '明杠不该再计口口番（否则同一口杠算两次）');
});

/* ===== 十杠口数（老吴 2026-10-03 23:38 定，2026-10-08 二次确认 + 三次补正）=====
 * 原话：「10 杠是指杠牌（包括红中杠、皮子杠、赖子杠、冲杠、蓄杠）的**杠数**加起来达到 10」
 *    +「暗杠/癞子杠 2 口是对的啊，不是错误实现」
 *    +「蓄杠的口数，碰算 1 口，杠算 1 口，合计 2 口」
 * ⇒ **an / wild / xu 各 2 口**，zhi / red / skin 各 1 口。
 * ⚠️ 与「杠的番底」（`gangFan`）是**两套独立配置**（数值巧合一致，改一个不影响另一个）：
 *    - `gangFan` 数**番**：zhi/xu/an/wild 各 2，red/skin 各 1
 *    - `shiGangWeights` 数**口**：an/wild/xu 各 2，zhi/red/skin 各 1
 */

test('十杠口数（老吴 2026-10-08）：暗杠/癞子杠/蓄杠 2 口，其余各 1 口', () => {
  const one = (type, tiles, from = null) => [{ type, tiles, from }];
  assert.equal(countGangUnits(one('zhi', [3, 3, 3, 3], 1), RS), 1, '冲杠 = 1 口');
  assert.equal(countGangUnits(one('xu', [3, 3, 3, 3], 1), RS), 2, '蓄杠 = 2 口（碰 1 + 杠 1）');
  assert.equal(countGangUnits(one('red', [RED]), RS), 1, '红中杠 = 1 口');
  assert.equal(countGangUnits(one('skin', [11]), RS), 1, '皮子杠 = 1 口');
  assert.equal(countGangUnits(one('wild', [7]), RS), 2, '癞子杠 = 2 口');
  assert.equal(countGangUnits(one('an', [3, 3, 3, 3]), RS), 2, '暗杠 = 2 口');
  // 非杠的副露不计
  assert.equal(countGangUnits([{ type: 'chi', tiles: [1, 2, 3], from: 1 }], RS), 0, '吃不是杠');
  assert.equal(countGangUnits([{ type: 'peng', tiles: [1, 1, 1], from: 1 }], RS), 0, '单独的碰不是杠，不计口');
});

test('十杠：10 口杠 ⇒ 达成（加权：暗杠/癞子杠/蓄杠 2 口）', () => {
  const st = createGame({ seed: 1, ruleset: RS });
  st.players[0].hand = [];

  // 路径 A：5 个癞子杠 = 10 口
  st.players[0].melds = new Array(5).fill({ type: 'wild', tiles: [7], from: null });
  assert.equal(countGangUnits(st.players[0].melds, RS), RS.shiGangCount, '5 个癞子杠 = 10 口');
  refreshAchievements(st);
  assert.equal(st.players[0].shiGang, true, '10 口杠 ⇒ 十杠达成');
  // 4 个癞子杠 = 8 口不够
  st.players[0].melds = new Array(4).fill({ type: 'wild', tiles: [7], from: null });
  st.players[0].shiGang = false;
  refreshAchievements(st);
  assert.equal(st.players[0].shiGang, false, '8 口不够');

  // 路径 B：5 个蓄杠 = 10 口（碰 1 + 杠 1）
  st.players[0].melds = new Array(5).fill({ type: 'xu', tiles: [3, 3, 3, 3], from: 1 });
  assert.equal(countGangUnits(st.players[0].melds, RS), RS.shiGangCount, '5 个蓄杠 = 10 口');
  st.players[0].shiGang = false;
  refreshAchievements(st);
  assert.equal(st.players[0].shiGang, true, '5 个蓄杠也达成');

  // 路径 C：10 个皮子杠（各 1 口）也刚好达成
  const tenSkin = new Array(RS.shiGangCount).fill({ type: 'skin', tiles: [11], from: null });
  assert.equal(countGangUnits(tenSkin, RS), RS.shiGangCount, '10 个皮子杠 = 10 口');
  st.players[0].melds = tenSkin;
  st.players[0].shiGang = false;
  refreshAchievements(st);
  assert.equal(st.players[0].shiGang, true, '10 个皮子杠也达成');
});

test('十杠：蓄杠算 2 口而非数两条 meld（引擎把 peng 原地改写成 xu）', () => {
  // `completeXuGang` 是 `meld.type = 'xu'` —— 蓄杠在 melds 数组里只有**一条**，
  // 所以「碰 1 口 + 杠 1 口 = 2 口」必须靠权重表达，不能指望数副露条数。
  const one = [{ type: 'xu', tiles: [3, 3, 3, 3], from: 1 }];
  assert.equal(one.length, 1, '蓄杠只有一条 meld（碰被原地改写，不是新增一条）');
  assert.equal(countGangUnits(one, RS), 2, '但口数是 2（碰 1 + 杠 1）');
  // 若权重误设成 1，就会退化成「数副露条数」—— 这正是要防的实现错误
  const wrong = createRuleSet('koukou', { shiGangWeights: { zhi: 1, xu: 1, an: 2, red: 1, skin: 1, wild: 2 } });
  assert.equal(countGangUnits(one, wrong), 1, '权重设 1 就等于只数条数 —— 老吴口径不是这样');
});

test('十杠口数 ≠ 杠的番底：两套口径独立配置（老吴 10-08 定稿后）', () => {
  // 🔴 定稿后两者**数值不一样**：蓄杠口数 2 / 番底 2（相同），但冲杠口数 1 / 番底 2（相反）；
  //    反向独立性另有专门断言（只改一个配置，另一个不动）。
  const f = (melds, rs = RS) => countFan({ seat: 0, opened: true, melds }, { ruleset: rs, isWinner: true, baseFan: 0, size: 'small' }).total;
  const u = (melds, rs = RS) => countGangUnits(melds, rs);
  const zhi = [{ type: 'zhi', tiles: [3, 3, 3, 3], from: 1 }];
  const xu = [{ type: 'xu', tiles: [3, 3, 3, 3], from: 1 }];
  const wild = [{ type: 'wild', tiles: [7], from: null }];
  const skin = [{ type: 'skin', tiles: [11], from: null }];

  // 冲杠：口数 1、番底 2 —— 数值不同，一眼可辨是两套口径
  assert.equal(u(zhi), 1, '冲杠口数 = 1 口');
  assert.equal(f(zhi), 2, '冲杠番底 = 2 番（老吴 10-08「冲杠 +2」）');
  // 蓄杠：口数 2（碰 1 + 杠 1）、番底 2（碰 1 + 杠 1）—— 数值巧合相同，但来源不同
  assert.equal(u(xu), 2, '蓄杠口数 = 2 口（碰 1 + 杠 1）');
  assert.equal(f(xu), 2, '蓄杠番底 = 2 番（碰 1 + 杠 1）');
  assert.equal(f(wild), 2, '癞子杠番底 = 2 番');
  assert.equal(u(wild), 2, '癞子杠口数 = 2 口');
  assert.equal(f(skin), 1, '皮子杠番底 = 1 番');
  assert.equal(u(skin), 1, '皮子杠口数 = 1 口');

  // 🔴 独立性：只改口数权重不动番底
  const onlyUnits = createRuleSet('koukou', { shiGangWeights: { zhi: 1, xu: 1, an: 1, red: 1, skin: 1, wild: 1 } });
  assert.equal(u(wild, onlyUnits), 1, '权重改回 1 ⇒ 口数变 1');
  assert.equal(f(wild), 2, '但番底仍是 2 番（gangFan 没被动过）');
  // 🔴 独立性：只改番底不动口数
  const onlyFan = createRuleSet('koukou', { gangFan: { zhi: 2, xu: 2, an: 2, red: 1, skin: 1, wild: 1 } });
  assert.equal(f(wild, onlyFan), 1, '番底改成 1 ⇒ 癞子杠只算 1 番');
  assert.equal(u(wild), 2, '但口数仍是 2 口（shiGangWeights 没被动过）');
  // 🔴 独立性：改口数不影响蓄杠番底（最容易被误连的一处）
  assert.equal(f(xu, onlyUnits), 2, '口数权重改成 1 ⇒ 蓄杠番底仍是 2 番');
});

test('十杠：weights 缺失时回落 1 口（老配置不会炸）', () => {
  const bare = createRuleSet('koukou', { shiGangWeights: {} });
  assert.equal(countGangUnits([{ type: 'wild', tiles: [7], from: null }], bare), 1, '没配权重就按 1 口算');
  assert.equal(countGangUnits([{ type: 'chi', tiles: [1, 2, 3], from: 1 }], bare), 0, '吃不是杠，不计口');
});
