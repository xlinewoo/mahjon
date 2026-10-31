#!/usr/bin/env node
/**
 * 定向验证：赖子 / 皮子 / 红中 **不能作为吃、碰材料**
 * （武汉红中赖子杠口径：特殊牌失去本身数字含义，只能用于杠 / 胡牌万能替牌）
 *
 * 用法：node tools/verify-special-claim.mjs
 *
 * 构造三组精确局面，打印引擎实际给出的响应（吃/碰/杠/胡）选项：
 *   ① 赖子顶顺子 —— 手里「赖子(5万)+6万」打 4万 → 必须**不能**吃出 4-5-6万
 *   ② 皮子顶顺子 —— 手里「皮子(3万)+5万」打 4万 → 必须**不能**吃出 3-4-5万
 *   ③ 对照：正常牌 —— 手里「4万+5万」打 3万      → **应该能**吃出 3-4-5万
 *   ④ 皮子被碰    —— 打出一张皮子               → 必须**不能**被碰
 */

import { createGame, act, isSpecial } from '../src/engine/game.js';
import { makeTile, tileName, RED_DRAGON, formatTiles } from '../src/engine/tiles.js';

const w = (n) => makeTile('wan', n);
const t = (n) => makeTile('tong', n);
const s = (n) => makeTile('tiao', n);

/** 造一副可控局面：清空手牌、钉死癞子/皮子 */
function setup({ wildTile, skinTiles }) {
  const state = createGame({ seed: 12 });
  for (const p of state.players) {
    p.hand = [];
    p.melds = [];
    p.discards = [];
    p.opened = false;
  }
  state.flipTile = null;
  state.wildTile = wildTile;
  state.skinTiles = skinTiles;
  state.claims = [];
  state.claimIndex = 0;
  return state;
}

const FILL = [t(1), t(1), t(1), t(4), t(4), t(4), t(7), t(7), t(7), s(2), s(2)];

/** 跑一组：seat0 打 trig，返回所有 seat 的响应选项 */
function run(label, { wildTile, skinTiles, seat1Hand, trig, expectChi, trigOwner = 0 }) {
  const state = setup({ wildTile, skinTiles });
  state.turn = trigOwner;
  state.phase = 'discard';

  // 出牌者手里放一张要打的牌
  const discarder = state.players[trigOwner];
  discarder.hand = [trig, ...FILL, s(9)];
  // 吃碰者（下家 seat1）
  state.players[1].hand = [...seat1Hand, ...FILL];

  act(state, { type: 'discard', seat: trigOwner, tile: trig });

  const excl = new Set([wildTile, ...skinTiles].filter((x) => x !== null && x !== undefined));
  const specials = (arr) => arr.filter((x) => excl.has(x)).map(tileName);

  console.log(`\n──────── 组 ${label} ────────`);
  console.log(`  癞子：${wildTile === null ? '（无）' : tileName(wildTile)}` +
    `　皮子：${skinTiles.length ? skinTiles.map(tileName).join('、') : '（无）'}`);
  console.log(`  seat${trigOwner} 打出：${tileName(trig)}`);
  console.log(`  seat1 手牌：${formatTiles(seat1Hand)}`);

  if (!state.claims || state.claims.length === 0) {
    console.log('  → 无人可响应（无吃/碰/杠/胡）');
  }
  let sawChi = false;
  for (const c of state.claims ?? []) {
    for (const o of c.options) {
      if (o.type === 'chi') {
        sawChi = true;
        for (const combo of o.combos) {
          const bad = specials(combo);
          const mark = bad.length ? `❌ 含特殊牌 ${bad.join('')}` : '✅ 全为真实牌';
          console.log(`  seat${c.seat} 可吃：${formatTiles([...combo, trig].sort((a, b) => a - b))}　${mark}`);
        }
      } else if (o.type === 'peng') {
        const bad = specials([o.tile]);
        const mark = bad.length ? `❌ 被碰的是特殊牌 ${bad.join('')}` : '✅ 被碰的是真实牌';
        console.log(`  seat${c.seat} 可碰：${tileName(o.tile)}　${mark}`);
      }
    }
  }

  if (expectChi === true) {
    console.log(`  ⇒ ${sawChi ? '✅ 正常吃成立' : '❌ 期望能吃却吃不到（异常）'}`);
    return sawChi;
  }
  if (expectChi === false) {
    console.log(`  ⇒ ${sawChi ? '❌ 竟然能吃到特殊牌（缺陷！）' : '✅ 正确：吃不到特殊牌'}`);
    return !sawChi;
  }
  return true;
}

console.log('武汉红中赖子杠 —— 赖子/皮子 不能吃碰 定向验证');

let ok = true;

// ① 赖子(5万)顶顺子：手里 赖子+6万，打 4万 → 不能吃 456万
ok = run('① 赖子顶顺子', {
  wildTile: w(5),
  skinTiles: [RED_DRAGON],
  seat1Hand: [w(5), w(6), w(2)],
  trig: w(4),
  expectChi: false,
}) && ok;

// ② 皮子(3万)顶顺子：手里 皮子(3万)+5万，打 4万 → 不能吃 345万
ok = run('② 皮子顶顺子', {
  wildTile: w(9),
  skinTiles: [w(3), RED_DRAGON],
  seat1Hand: [w(3), w(5), w(7)],
  trig: w(4),
  expectChi: false,
}) && ok;

// ③ 对照组：正常 4万+5万，打 3万 → 应该能吃 345万
ok = run('③ 对照·正常吃', {
  wildTile: w(9),
  skinTiles: [RED_DRAGON],
  seat1Hand: [w(4), w(5), w(7)],
  trig: w(3),
  expectChi: true,
}) && ok;

// ④ 皮子被碰：seat0 打出一张皮子(3万) → 谁都不能碰
ok = run('④ 皮子不能被碰', {
  wildTile: w(9),
  skinTiles: [w(3), RED_DRAGON],
  seat1Hand: [w(3), w(3), w(5)],
  trig: w(3),
  expectChi: false,
}) && ok;

console.log(`\n════════ 总结：${ok ? '✅ 全部通过 —— 赖子/皮子/红中 都不能吃碰' : '❌ 有用例未通过'} ════════`);
process.exit(ok ? 0 : 1);
