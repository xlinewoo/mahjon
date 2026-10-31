/**
 * 前端纯逻辑层（无 DOM 依赖）—— 武汉红中赖子杠
 *
 * 把引擎（createGame / act / viewFor）的「座位→方位」「方位名」「结算文案」等
 * 纯函数收拢到这里，供网络版渲染层（render.js）、回放与单测共用。
 * 人类固定坐 MY_SEAT（座位 0）。
 *
 * 这一层不碰 document / window，方便在 Node 里 headless 跑通验证。
 */

import { createGame, act, viewFor } from '../src/engine/game.js';
import { createRuleSet } from '../src/engine/rules.js';
import { analyzeTenpai } from '../src/engine/tenpai.js';
import { createRng } from '../src/engine/rng.js';

// 摸风定座（纯函数）统一从引擎层引入，前端 / server 共用一份实现，避免漂移
import {
  DIR_ORDER,
  windsFromDealer,
  dirOf,
  drawWinds,
  mixSeed,
} from '../src/engine/winds.js';

export { DIR_ORDER, windsFromDealer, dirOf, drawWinds };

/** 人类固定座位（老吴坐这里） */
export const MY_SEAT = 0;

/* ------------------------------------------------------------------ */
/* 方位与摸风定座（纯逻辑，无 DOM）                                     */
/* ------------------------------------------------------------------ */

/** 屏幕相对位置（玩家恒定在主视觉下方，出牌逆时针 → 下家在右、对家在上、上家在左） */
export const POS_ORDER = ['bottom', 'right', 'top', 'left'];
export const POS_LABEL = { bottom: '你', right: '下家', top: '对家', left: '上家' };
/** 屏幕位置 → 中文方位名（罗盘：上北下南左西右东），仅用于布局命名，与谁坐哪无关 */
export const POS_COMPASS = { top: '北', right: '东', bottom: '南', left: '西' };

/** 座位 → 屏幕相对位置：我=bottom，下家=right，对家=top，上家=left */
export function posOf(seat, mySeat = MY_SEAT) {
  return POS_ORDER[((seat - mySeat) % 4 + 4) % 4];
}

/** 座位 → 相对称呼（你 / 下家 / 对家 / 上家） */
export function relOf(seat, mySeat = MY_SEAT) {
  return POS_LABEL[posOf(seat, mySeat)];
}

/** 座位 → 引擎内名字：自己叫「你」，其余用方位（东 / 南 / 西 / 北），让结算文案也带方位 */
export function buildSeatNames(seatToDir, mySeat = MY_SEAT) {
  return [0, 1, 2, 3].map((s) => (s === mySeat ? '你' : dirOf(s, seatToDir)));
}

/** 座位 → 展示名（带相对位置，如「东·下家」）；自己只显示「你」 */
export function seatTag(seat, seatToDir, mySeat = MY_SEAT) {
  const dir = dirOf(seat, seatToDir);
  if (seat === mySeat) return `${dir}（你）`;
  return `${dir}·${relOf(seat, mySeat)}`;
}


/* ------------------------------------------------------------------ */
/* 结算文案（纯逻辑，无 DOM —— 便于 headless 回归测试）                  */
/* ------------------------------------------------------------------ */

/**
 * 座位 → 展示名。自己显示「你」，其余优先用「方位·相对称呼」（如「东·下家」）。
 * 传了 seatToDir 就用方位；没传（老测试的调用方式）退回引擎里的名字（也是方位）。
 */
export function seatLabel(seat, result, mySeat = MY_SEAT, seatToDir = null) {
  if (seat === null || seat === undefined) return '';
  if (seat === mySeat) return '你';
  if (seatToDir) return seatTag(seat, seatToDir, mySeat);
  if (result && seat === result.winnerSeat && result.winnerName) return result.winnerName;
  const p = ((result && result.payments) || []).find((x) => x.seat === seat);
  if (p && p.name) return p.name;
  return `座位${seat + 1}`;
}

/**
 * 结算头条。
 * ⚠️ 「点炮」的主语是**放炮那家**，不是赢家。
 *    以前写成「你 点炮胡牌」会被读成「我放炮了」——老吴 2026-09-30 报的 bug。
 *    正确：自摸 → 「你 自摸胡牌」；点炮 → 「你 胡牌（东·下家 点炮）」。
 */
export function winnerHeadline(result, mySeat = MY_SEAT, seatToDir = null) {
  const who = seatLabel(result.winnerSeat, result, mySeat, seatToDir);
  return result.selfDraw
    ? `${who} 自摸胡牌`
    : `${who} 胡牌（${seatLabel(result.from, result, mySeat, seatToDir)} 点炮）`;
}

/**
 * 局况番：三笔固定加番（老吴拍板）各自的落点。
 *   · 自摸 +1 → 赢家（海底捞 / 杠上开花除外，2026-10-23）
 *   · 点炮 +1 → 放炮那家
 *   · 庄家 +1 → 庄家（赢家是庄时，三家 effFan 各 +1）
 * 点炮/庄家这两笔记在**输家**头上，所以不在「赢家番数明细」里 —— 必须单独摊开。
 *
 * ⚠️ 2026-10-03 起：**大胡不算庄家番**（老吴拍板）⇒ 大胡局这一行**不出现**，
 *   否则面板会显示一笔账面上不存在的加番，玩家按它算总分会对不上。
 *   2026-10-22 补充：大胡时庄家是赢家/输家都不算，**金顶局也不回补**。
 */
export function situationRows(result, mySeat = MY_SEAT, seatToDir = null) {
  const rows = [];
  /* 海底捞 / 杠上开花（老吴 2026-10-23）：这两种大胡不计「自摸」番，
   * 面板也不能列「自摸 +1」，否则会和账面分数对不上。 */
  const specialNoSelfDraw = (result.types || []).some(
    (t) => t === 'haiDiLao' || t === 'gangShangKaiHua',
  );
  if (result.selfDraw && !specialNoSelfDraw) {
    rows.push({ label: '自摸 +1', who: seatLabel(result.winnerSeat, result, mySeat, seatToDir), note: '赢家' });
  } else if (!result.selfDraw && result.from !== null && result.from !== undefined) {
    rows.push({ label: '点炮 +1', who: seatLabel(result.from, result, mySeat, seatToDir), note: '放炮那家' });
  }
  /* 「大胡不算庄家番」（老吴 2026-10-03 / 2026-10-22）：大胡时这一笔**根本没发生**，
   * 所以文案也**不能**再列出来 —— 否则面板会显示一笔账面上不存在的加番，
   * 玩家按它算总分就会对不上。金顶局同样不列。 */
  const bigHuNoDealer = result.size === 'big';
  if (!bigHuNoDealer && result.dealerSeat !== null && result.dealerSeat !== undefined) {
    rows.push({
      label: '庄家 +1',
      who: seatLabel(result.dealerSeat, result, mySeat, seatToDir),
      note: result.dealerIsWinner ? '庄家＝赢家，因此三家各 +1' : '庄家，本局是闲家',
    });
  }
  return rows;
}

