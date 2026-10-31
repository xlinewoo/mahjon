/**
 * 听牌分析测试 —— 老吴 2026-09-30：
 * 「听牌以后有一个提示按钮，点击以后显示可以胡的牌及所剩张数
 *  （按牌河中和各家吃碰以后，所有明牌估算剩余的张数）」
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeTile,
  toCounts,
  tileName,
  RED_DRAGON,
  WHITE_DRAGON,
  EAST,
} from '../src/engine/tiles.js';
import { createGame, act, handNeeded, legalActions, canWinWith } from '../src/engine/game.js';
import { decide } from '../src/bot/simpleBot.js';
import { analyzeTenpai, visibleCount } from '../src/engine/tenpai.js';
import { createRuleSet } from '../src/engine/rules.js';

const w = (n) => makeTile('wan', n);
const t = (n) => makeTile('tong', n);
const s = (n) => makeTile('tiao', n);

const RS = createRuleSet('koukou');
/**
 * 测听牌**机制**时用「关掉起胡门槛」的规则集：
 * 门槛会把「能成牌但番数不够」的听牌滤掉，那是另一回事（由下面单独一条测试守着）。
 * 这里要验的是「差一张 / 剩余张数 / 副露基准」这些几何性质。
 */
const RS_NF = createRuleSet('koukou', { enforceMinFan: false });

/** 造一个「坐在 0 号位、差一张」的局面；其余三家给不会胡的散牌 */
function tenpaiState(hand, opts = {}) {
  const st = createGame({ seed: opts.seed ?? 21, ruleset: opts.ruleset ?? RS_NF });
  for (const p of st.players) { p.hand = []; p.melds = []; p.discards = []; p.opened = false; }
  st.wildTile = opts.wildTile ?? WHITE_DRAGON;
  st.skinTiles = opts.skinTiles ?? [];
  st.flipTile = null;
  st.discardLog = opts.discardLog ?? [];
  st.wall = [w(1), w(1), w(1), w(1), w(1), w(1), w(1), w(1)];
  st.claims = [];
  st.claimIndex = 0;

  st.players[0].hand = [...hand];
  st.players[0].opened = opts.opened ?? true;
  for (const seat of [1, 2, 3]) {
    st.players[seat].hand = [w(1), w(3), w(5), w(7), w(9), t(1), t(3), t(5), t(7), t(9), s(1), s(5), s(7)];
  }
  if (opts.melds) st.players[0].melds = opts.melds;
  st.turn = 0;
  st.phase = opts.phase ?? 'discard';
  return st;
}

test('听牌两种局面：13 张=已经听了(wait)；满手 14 张=轮到出牌，逐张试打看打完能否听(ready)', () => {
  // 13 张：123万 456万 789万 55筒 + 23条 → 听 1条/4条
  const hand = [
    w(1), w(2), w(3), w(4), w(5), w(6), w(7), w(8), w(9), t(5), t(5), s(2), s(3),
  ];
  assert.equal(hand.length, 13);
  const st = tenpaiState(hand);
  assert.equal(handNeeded(st, 0), 14);

  const r = analyzeTenpai(st, 0);
  assert.equal(r.mode, 'wait', '13 张 = 差一张');
  assert.equal(r.tenpai, true);
  assert.equal(r.total, 13);
  const names = r.waits.map((x) => x.name).sort();
  assert.ok(names.length >= 1, `应至少听一张，实际 ${names.join('/')}`);
  assert.ok(names.includes('一条'), `应听一条，实际 ${names.join('/')}`);

  // 加一张变 14 张（= 轮到自己出牌时的常态）→ 转为 ready 模式：逐张试打
  st.players[0].hand.push(s(9));
  const r2 = analyzeTenpai(st, 0);
  assert.equal(r2.mode, 'ready', '满手 14 张 = 轮到出牌');
  assert.equal(r2.tenpai, true, '打掉九条就能听 1条/4条');
  const best = r2.byDiscard.find((d) => d.tile === s(9));
  assert.ok(best, `「打九条」应出现在 byDiscard 里：${r2.byDiscard.map((d) => d.name).join('/')}`);
  assert.ok(best.waits.some((x) => x.name === '一条'), '打九条后应听一条');
  // 并集里同样要有一条
  assert.ok(r2.waits.some((x) => x.name === '一条'), '并集里应有一条');
});

test('听牌：一手怎么打都听不了牌时，不给提示（tenpai=false）', () => {
  // 一手散牌：怎么打都不可能听
  const hand = [
    w(1), w(4), w(7), t(1), t(4), t(7), s(1), s(4), s(7), EAST, EAST, EAST, s(9), s(9),
  ];
  assert.equal(hand.length, 14);
  const st = tenpaiState(hand);
  const r = analyzeTenpai(st, 0);
  assert.equal(r.mode, 'ready');
  assert.equal(r.tenpai, false, '一手散牌不该提示听牌');
  assert.equal(r.byDiscard.length, 0);
});

test('听牌：剩余张数 = 4 − 明牌张数（牌河 + 各家副露 + 自己手牌 + 翻出的底牌）', () => {
  const hand = [
    w(1), w(2), w(3), w(4), w(5), w(6), w(7), w(8), w(9), t(5), t(5), s(2), s(3),
  ];
  const st = tenpaiState(hand);
  const tile = s(1); // 一条

  // ① 没露过 → 手里 0 张、牌河 0 张 → 剩 4 张
  assert.equal(visibleCount(st, 0, tile), 0);
  let r = analyzeTenpai(st, 0);
  let one = r.waits.find((x) => x.tile === tile);
  assert.ok(one, '应听一条');
  assert.equal(one.remain, 4, '一张都没露 → 剩 4 张');

  // ② 牌河里出现 2 张
  st.discardLog = [{ seat: 1, tile }, { seat: 2, tile }];
  assert.equal(visibleCount(st, 0, tile), 2);
  r = analyzeTenpai(st, 0);
  one = r.waits.find((x) => x.tile === tile);
  assert.equal(one.remain, 2, '牌河 2 张 → 剩 2 张');

  // ③ 别家碰掉 3 张（副露里）
  st.discardLog = [];
  st.players[2].melds = [{ type: 'peng', tiles: [tile, tile, tile], from: 1 }];
  assert.equal(visibleCount(st, 0, tile), 3);
  r = analyzeTenpai(st, 0);
  one = r.waits.find((x) => x.tile === tile);
  assert.equal(one.remain, 1, '被碰掉 3 张 → 剩 1 张');

  // ④ 4 张全露 → 直接从听牌列表里消失
  st.players[2].melds = [{ type: 'peng', tiles: [tile, tile, tile], from: 1 }];
  st.discardLog = [{ seat: 1, tile }];
  assert.equal(visibleCount(st, 0, tile), 4);
  r = analyzeTenpai(st, 0);
  assert.ok(!r.waits.some((x) => x.tile === tile), '4 张全露了，不该再列为听牌');
});

test('听牌：副露会改变「差几张」的基准（吃了一口后手牌 11 张才算满手）', () => {
  // 1 副露（碰 3 张）→ 成牌时手牌应 11 张，所以「差一张」= 手牌 10 张
  const melds = [{ type: 'peng', tiles: [t(8), t(8), t(8)], from: 2 }];
  const st = tenpaiState([w(1), w(2), w(3), w(4), w(5), w(6), w(7), w(8), w(9), t(5)], { melds });
  assert.equal(handNeeded(st, 0), 11);

  const r = analyzeTenpai(st, 0);
  assert.equal(r.mode, 'wait', '手牌 10 张 + 1 副露 = 差一张');
  assert.equal(r.tenpai, true);

  // 手牌补到 11 张（= 刚吃完还没打）→ 转为 ready 模式
  st.players[0].hand.push(t(5));
  const r2 = analyzeTenpai(st, 0);
  assert.equal(r2.mode, 'ready', '手牌 11 张 + 1 副露 = 满手，必须先打出去');
});

test('听牌：红中不在可胡列表里（持有红中不能胡）', () => {
  const hand = [
    w(1), w(2), w(3), w(4), w(5), w(6), w(7), w(8), w(9), t(5), t(5), s(2), s(3),
  ];
  const st = tenpaiState(hand, { skinTiles: [] });
  const r = analyzeTenpai(st, 0);
  assert.ok(!r.waits.some((x) => x.tile === RED_DRAGON), '红中永远不能当胡牌张');
});

test('听牌：起胡门槛会过滤掉「能成牌但番数不够」的张', () => {
  // 同一手牌，关掉门槛后听的张数 ≥ 开着门槛时（门槛只会更严，不会更松）
  const hand = [
    w(1), w(2), w(3), w(4), w(5), w(6), w(7), w(8), w(9), t(5), t(5), s(2), s(3),
  ];
  const noGate = analyzeTenpai(tenpaiState(hand), 0);
  const withGate = analyzeTenpai(tenpaiState(hand, { ruleset: RS }), 0);
  assert.ok(noGate.waits.length >= withGate.waits.length, '门槛只会减少可胡的张数');
  assert.ok(noGate.waits.length > 0, '关掉门槛后这手牌该有听牌（否则这条断言等于没跑）');
});

/**
 * 不变量（最强的一条）：**开着门槛**逐局扫描，凡提示「能胡」的牌，
 * 真拿到手时引擎必须真的给 `win` —— 绝不能出现「提示能胡、真胡不了」。
 */
test('不变量：开着门槛逐局扫描，提示能胡的牌真拿到时引擎确实给「胡」', () => {
  let checked = 0;
  for (let seed = 1; seed <= 80 && checked < 12; seed++) {
    let st = createGame({ seed, ruleset: RS });
    let steps = 0;
    while (st.phase !== 'settled' && steps++ < 3000) {
      const r = analyzeTenpai(st, 0);
      if (r.tenpai && r.waits.length) {
        if (r.mode === 'wait') {
          // 已经听了：直接把这张牌塞进手牌验
          for (const wt of r.waits) {
            const counts = toCounts([...st.players[0].hand, wt.tile]);
            const res = canWinWith(st, 0, counts, { selfDraw: true });
            assert.equal(
              res.legal, true,
              `seed=${seed} 提示「${wt.name}」能胡，但引擎判：${res.reason}`,
            );
            checked++;
          }
        } else {
          // 满手：验「打掉 d.tile 之后，再来 w.tile 确实能胡」
          for (const d of r.byDiscard) {
            const rest = st.players[0].hand.slice();
            rest.splice(rest.indexOf(d.tile), 1);
            for (const wt of d.waits) {
              const counts = toCounts([...rest, wt.tile]);
              const res = canWinWith(st, 0, counts, { selfDraw: true });
              assert.equal(
                res.legal, true,
                `seed=${seed} 提示「打${d.name}后听${wt.name}」，但引擎判：${res.reason}`,
              );
              checked++;
            }
          }
        }
        break; // 每个种子只验一次，避免把牌局改乱
      }
      // 推进一步：交给机器人（响应阶段的吃/碰/杠/过由它决定，避免自己拼动作拼错）
      const a = decide(st, st.turn);
      if (!a) break;
      st = act(st, a);
    }
  }
  assert.ok(checked > 0, `80 局里一次听牌都没出现，这条不变量等于没跑（checked=${checked}）`);
});

test('听牌：不变量 —— 提示出来的每一张牌，真摸到时引擎确实判胡（不出现「提示能胡、真胡不了」）', () => {
  const hand = [
    w(1), w(2), w(3), w(4), w(5), w(6), w(7), w(8), w(9), t(5), t(5), s(2), s(3),
  ];
  const base = tenpaiState(hand);
  const r = analyzeTenpai(base, 0);
  assert.equal(r.tenpai, true);
  assert.ok(r.waits.length > 0, '这一手该有听牌');

  for (const wt of r.waits) {
    // ❗每张都用一个**全新的**局面去试，避免前一次 act 把状态改乱
    const st = tenpaiState(hand);
    st.players[0].hand.push(wt.tile);
    st.players[0].hand.sort((a, b) => a - b);
    st.turn = 0;
    st.phase = 'discard';

    const legal = legalActions(st, 0).map((a) => a.type);
    assert.ok(
      legal.includes('win'),
      `提示「${wt.name}」能胡，但真摸到/拿到时 legalActions 里没有 win（${legal.join(',')}）`,
    );

    act(st, { type: 'win', seat: 0 });
    assert.equal(st.phase, 'settled', `提示「${wt.name}」能胡，但 act(win) 后没结算`);
    assert.equal(st.result.winnerSeat, 0, `提示「${wt.name}」能胡，但赢家不是 0 号位`);
  }
});
