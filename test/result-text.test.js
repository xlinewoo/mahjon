/**
 * 前端结算文案测试（纯逻辑，无 DOM）
 *
 * 起因：老吴 2026-09-30 报「我胡了，面板却写『你 点炮胡牌（放炮：玩家2）』」。
 *   · 「点炮」的主语是**放炮那家**，不是赢家 —— 写成「你 点炮胡牌」会被读成「我放炮了」。
 *   · 同一块面板里一半用座位称呼（下家/对家/上家）、一半用「玩家N」，也要统一。
 * 另外覆盖「局况番」（自摸 / 点炮 / 庄家）三笔加番的落点文案。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seatLabel, winnerHeadline, situationRows, MY_SEAT } from '../frontend/game-loop.js';

/** 造一个 settled 的 result（字段与 settleRoundTable + finishWin 的产物一致） */
function mkResult(over = {}) {
  const names = ['我', '下家', '对家', '上家'];
  const payments = [1, 2, 3]
    .filter((s) => s !== (over.winnerSeat ?? 0))
    .map((s) => ({ seat: s, name: names[s], fan: 2, effFan: 7, pay: 8, opened: true }));
  return {
    type: 'win',
    winnerSeat: 0,
    winnerName: names[over.winnerSeat ?? 0],
    selfDraw: false,
    from: 1,
    fromName: names[1],
    dealerSeat: 0,
    dealerIsWinner: false,
    // 默认按**小胡**造（`size` 缺省时不算大胡）⇒ 庄家番照算，与旧断言兼容。
    // 「大胡不算庄家番」的新口径另有用例显式覆盖（见下方两条）。
    size: 'small',
    winnerFan: 5,
    payments,
    totalWin: 24,
    topType: null,
    ...over,
  };
}

test('结算头条：点炮胡的主语是放炮者，不是赢家（老吴报的 bug）', () => {
  const r = mkResult({ winnerSeat: 0, from: 1, selfDraw: false });
  assert.equal(winnerHeadline(r), '你 胡牌（下家 点炮）');
  assert.ok(!winnerHeadline(r).includes('点炮胡牌'), '绝不能出现「点炮胡牌」这种读反的写法');
});

test('结算头条：自摸', () => {
  assert.equal(winnerHeadline(mkResult({ winnerSeat: 0, selfDraw: true, from: null })), '你 自摸胡牌');
});

test('结算头条：别家赢时用座位称呼，不出现「玩家N」', () => {
  const r = mkResult({ winnerSeat: 2, from: 3, selfDraw: false });
  const head = winnerHeadline(r);
  assert.equal(head, '对家 胡牌（上家 点炮）');
  assert.ok(!/玩家\d/.test(head), '文案里不能混用「玩家N」');
});

test('seatLabel：自己=你，赢家用 winnerName，输家用 payments.name', () => {
  const r = mkResult({ winnerSeat: 2, from: 3 });
  assert.equal(seatLabel(MY_SEAT, r), '你');
  assert.equal(seatLabel(2, r), r.winnerName);
  assert.equal(seatLabel(1, r), r.payments.find((p) => p.seat === 1).name);
  assert.equal(seatLabel(null, r), '', 'null 座位返回空串');
});

test('局况番：点炮局 → 点炮 +1 记放炮者、庄家 +1 记庄家', () => {
  const rows = situationRows(mkResult({ winnerSeat: 0, from: 1, selfDraw: false, dealerSeat: 0 }));
  assert.deepEqual(rows.map((x) => x.label), ['点炮 +1', '庄家 +1']);
  assert.equal(rows[0].who, '下家', '点炮那笔记在放炮的下家头上');
  assert.equal(rows[1].who, '你', '庄家那笔记在庄家（你）头上');
});

test('局况番：自摸局 → 自摸 +1，且不再出现点炮项', () => {
  const rows = situationRows(mkResult({ winnerSeat: 0, selfDraw: true, from: null }));
  assert.deepEqual(rows.map((x) => x.label), ['自摸 +1', '庄家 +1']);
  assert.equal(rows[0].who, '你');
  assert.ok(!rows.some((x) => x.label.startsWith('点炮')), '自摸局不该有点炮加番');
});

test('局况番：赢家是庄 → 标明「三家各 +1」', () => {
  const rows = situationRows(mkResult({ winnerSeat: 0, selfDraw: true, from: null, dealerSeat: 0, dealerIsWinner: true }));
  const dealer = rows.find((x) => x.label === '庄家 +1');
  assert.ok(dealer, '庄家项必须在');
  assert.ok(dealer.note.includes('三家各 +1'), '赢家是庄时要说明等价于三家各 +1');
});

test('局况番：没有庄家信息时只出两笔，不崩', () => {
  const rows = situationRows(mkResult({ dealerSeat: null }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, '点炮 +1');
});

/* ------------------------------------------------------------------ *
 * 「大胡不算庄家番」· 结算文案侧（老吴 2026-10-03）
 *
 * 文案必须与算分一致：大胡免掉庄家番时，面板**不能**再列「庄家 +1」，
 * 否则玩家按面板算总分会对不上账。
 * ------------------------------------------------------------------ */

test('局况番：大胡 → 不显示「庄家 +1」（这一笔根本没发生）', () => {
  const rows = situationRows(mkResult({ winnerSeat: 0, selfDraw: true, from: null, size: 'big' }));
  assert.deepEqual(
    rows.map((x) => x.label),
    ['自摸 +1'],
    '大胡局只该有自摸，不能凭空多一笔庄家番',
  );
});

test('局况番：大胡金顶也不显示「庄家 +1」（2026-10-22 补充：输赢都不算）', () => {
  const rows = situationRows(mkResult({
    winnerSeat: 0, selfDraw: true, from: null, size: 'big', topType: 'goldTop',
  }));
  assert.ok(
    !rows.some((x) => x.label === '庄家 +1'),
    '大胡金顶不再回补庄家番，面板也不能显示',
  );
});

test('局况番：海底捞 / 杠上开花 → 不显示「自摸 +1」', () => {
  for (const type of ['haiDiLao', 'gangShangKaiHua']) {
    const rows = situationRows(mkResult({
      winnerSeat: 0, selfDraw: true, from: null, size: 'big', types: [type],
    }));
    assert.ok(!rows.some((x) => x.label === '自摸 +1'), `${type} 不该列自摸番`);
    assert.ok(!rows.some((x) => x.label === '庄家 +1'), '大胡本来就没有庄家番');
  }

  // 与其它大胡叠加时同样不计自摸番
  const combo = situationRows(mkResult({
    winnerSeat: 0, selfDraw: true, from: null, size: 'big',
    types: ['qingYiSe', 'gangShangKaiHua'],
  }));
  assert.ok(!combo.some((x) => x.label === '自摸 +1'));
});

test('局况番：小胡 → 照常显示「庄家 +1」（只有大胡才免）', () => {
  const rows = situationRows(mkResult({ winnerSeat: 0, selfDraw: true, from: null, size: 'small' }));
  assert.deepEqual(rows.map((x) => x.label), ['自摸 +1', '庄家 +1']);
});
