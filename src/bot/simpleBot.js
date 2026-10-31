/**
 * 简单机器人策略
 *
 * 目标不是打得好，而是：① 能跑完一局 ② 覆盖尽可能多的规则分支
 * ③ 完全确定性（同一 state 永远做同一决策），复盘和压测才有意义。
 *
 * 本版针对武汉规则的关键调整：
 *   · 红中和皮子留在手里不能胡 → 必须优先打出去
 *   · 癞子是万能牌 → 打死不打
 *   · 字牌只能凑刻子、不能组顺子 → 价值低于同位置数字牌
 */

import {
  toCounts,
  isNumberTile,
  tileSuit,
  tileRank,
  makeTile,
  RED_DRAGON,
} from '../engine/tiles.js';
import { legalActions } from '../engine/game.js';

/** 默认策略参数 */
export const DEFAULT_STYLE = {
  pengRate: 70, // 武汉麻将必须开口才能胡，碰要积极
  chiRate: 45,
  gangRate: 85,
  specialGangRate: 60, // 红中杠/皮子杠：反正留不住，杠掉划算
  wildGangRate: 15, // 癞子杠：赖子是万能牌，杠掉太可惜
};

/**
 * 决定某座位当前该做什么
 */
export function decide(state, seat, style = DEFAULT_STYLE) {
  const acts = legalActions(state, seat);
  if (acts.length === 0) return null;
  const pick = (type) => acts.find((a) => a.type === type);

  // 1. 能胡就胡
  const win = pick('win');
  if (win) return win;

  // 2. 癞子杠（保守）
  const wildGang = pick('wildgang');
  if (wildGang && roll(state, seat, 'wildgang') < style.wildGangRate) return wildGang;

  // 3. 红中杠 / 皮子杠（留不住，杠掉）
  const redGang = pick('redgang');
  if (redGang && roll(state, seat, 'redgang') < style.specialGangRate) return redGang;
  const skinGang = pick('skingang');
  if (skinGang && roll(state, seat, 'skingang') < style.specialGangRate) return skinGang;

  // 4. 杠 / 暗杠 / 蓄杠
  const gang = pick('zhi') ?? pick('an');
  if (gang && roll(state, seat, 'gang') < style.gangRate) return gang;
  const xu = pick('xu');
  if (xu && roll(state, seat, 'xu') < style.gangRate) return xu;

  // 5. 碰
  const peng = pick('peng');
  if (peng && roll(state, seat, 'peng') < style.pengRate) return peng;

  // 6. 吃
  const chi = pick('chi');
  if (chi && roll(state, seat, 'chi') < style.chiRate) {
    const combo = chi.combos?.[0];
    if (combo) return { type: 'chi', seat, tiles: combo };
  }

  // 7. 打牌：打掉价值最低的
  const discards = acts.filter((a) => a.type === 'discard');
  if (discards.length > 0) {
    const hand = state.players[seat].hand;
    let best = discards[0];
    let bestVal = Infinity;
    for (const a of discards) {
      const v = tileValue(state, hand, a.tile);
      if (v < bestVal) {
        bestVal = v;
        best = a;
      }
    }
    return best;
  }

  return pick('pass') ?? acts[0];
}

/**
 * 牌的价值：越高越该留在手里
 *
 * 价值序（低 → 高）：
 *   红中 / 皮子（留不住，必须打） < 字牌 < 边张数字 < 中张数字 < 癞子（万能牌）
 */
export function tileValue(state, hand, tile) {
  // 癞子打死不打
  if (state.wildTile !== null && tile === state.wildTile) return 9999;

  // 红中 / 皮子留着不能胡，优先级最高打出去
  if (state.skinTiles.includes(tile)) return -1000;

  const counts = toCounts(hand);
  let score = (counts[tile] - 1) * 6;

  if (isNumberTile(tile)) {
    const suit = tileSuit(tile);
    const rank = tileRank(tile);
    for (const [d, weight] of [[-1, 3], [1, 3], [-2, 1], [2, 1]]) {
      const r = rank + d;
      if (r < 1 || r > 9) continue;
      if (counts[makeTile(suit, r)] > 0) score += weight;
    }
    // 中张比边张灵活
    score += 2 - Math.abs(rank - 5) * 0.5;
  } else {
    // 字牌只能凑刻子，没有顺子潜力
    score -= 1;
  }

  return score;
}

/** 确定性掷骰：返回 0..99 */
function roll(state, seat, tag) {
  let h = (state.seed ^ Math.imul(state.seq + 1, 2654435761) ^ Math.imul(seat + 1, 40503)) >>> 0;
  for (let i = 0; i < tag.length; i++) {
    h = Math.imul(h ^ tag.charCodeAt(i), 16777619) >>> 0;
  }
  return (h >>> 8) % 100;
}
