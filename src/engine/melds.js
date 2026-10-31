/**
 * 副露（吃/碰/各种杠）工具
 *
 * 关键概念：**面子折算**
 *   吃 / 碰 / 杠 / 蓄杠 / 暗杠 都代表一个完整的「面子」，折算 3 张牌。
 *   但「皮子杠 / 癞子杠 / 红中杠」只是把 1 张特殊牌拿出去换 1 张摸牌，
 *   净手牌数不变，**不构成面子**，不能参与 3 张折算。
 *
 * 这个区分很容易踩坑：拿 melds.length 去算手牌应有张数，
 * 杠过红中/皮子的玩家就会被误判成张数不符，胡牌永远判不出来。
 */

import { RED_DRAGON } from './tiles.js';

/** 不占面子的特殊杠 */
export const SPECIAL_GANG_TYPES = ['skin', 'wild', 'red'];

/** 占一个完整面子的副露 */
export const MELD_TYPES = ['chi', 'peng', 'zhi', 'xu', 'an'];

/** 明杠（会暴露信息、算开口） */
export const OPEN_GANG_TYPES = ['zhi', 'xu'];

/** 展示顺序：红中杠 → 皮子杠 → 癞子杠 → 吃碰杠（组内保持原先后）。 */
const MELD_DISPLAY_RANK = { red: 0, skin: 1, wild: 2, an: 99 };
const NORMAL_MELD_RANK = 3;

/** 是否特殊杠（皮子杠/癞子杠/红中杠） */
export function isSpecialGang(meld) {
  return SPECIAL_GANG_TYPES.includes(meld.type);
}

/**
 * 副露展示顺序（老吴 2026-10-22）：红中 → 皮子 → 癞子 → 普通吃碰杠。
 * 只用于前端摆牌，返回新数组，不改变服务端/引擎里的副露真实顺序。
 */
export function sortMeldsForDisplay(melds) {
  return [...(melds || [])].sort(
    (a, b) => (MELD_DISPLAY_RANK[a.type] ?? NORMAL_MELD_RANK)
      - (MELD_DISPLAY_RANK[b.type] ?? NORMAL_MELD_RANK),
  );
}

/**
 * 真正占面子的副露数量
 * @param {object[]} melds
 * @returns {number}
 */
export function exposedMeldCount(melds) {
  let n = 0;
  for (const m of melds) {
    if (!isSpecialGang(m)) n++;
  }
  return n;
}

/**
 * 副露是否全为刻子类 —— 碰碰胡的必要条件
 */
export function meldsAllTriplets(melds) {
  return melds.every((m) => m.type !== 'chi');
}

/**
 * 全求人：吃/碰/明杠/蓄杠 凑满 4 组，手上只剩将牌。
 * 注意暗杠不算（暗杠是自己摸的，不算「求人」）。
 *
 * ❗2026-10-29 老吴补：**蓄杠（xu）也要归进全求人**。
 *   蓄杠只是把「碰」升成杠，面子本身仍是别人打出的牌（碰出来的刻子），
 *   与明杠（zhi）同属「看得见、来自他人」的副露 —— 不能因为补了一张就不算求人。
 *   皮子杠 / 癞子杠 / 红中杠仍不算（它们不构成面子，见 SPECIAL_GANG_TYPES）。
 */
export function isQuanQiuRen(melds) {
  const real = melds.filter((m) => !isSpecialGang(m));
  if (real.length !== 4) return false;
  return real.every(
    (m) => m.type === 'chi' || m.type === 'peng' || OPEN_GANG_TYPES.includes(m.type),
  );
}

/**
 * 统计某类杠的数量
 * @param {object[]} melds
 * @param {string} type
 */
export function countGang(melds, type) {
  return melds.filter((m) => m.type === type).length;
}

/**
 * 收集参与胡牌的全部「实牌」（用于颜色类番型判定）。
 * 可排除若干特殊牌（癞子 / 皮子）—— 它们不该破坏花色结构。
 *
 * @param {number[]} handCounts
 * @param {object[]} melds
 * @param {number[]} exclude 需要排除的牌编码（癞子、皮子）
 * @returns {number[]}
 */
export function physicalTiles(handCounts, melds, exclude = []) {
  const ex = new Set(exclude.filter((t) => t !== null && t !== undefined));
  const tiles = [];
  for (let t = 0; t < handCounts.length; t++) {
    if (ex.has(t)) continue;
    for (let i = 0; i < handCounts[t]; i++) tiles.push(t);
  }
  for (const m of melds) {
    for (const t of m.tiles) {
      if (ex.has(t)) continue;
      tiles.push(t);
    }
  }
  return tiles;
}

/** 该玩家是否开口（吃 / 碰 / 明杠；特殊杠/暗杠默认不算，见 ruleset 开关） */
export function computeOpened(melds, ruleset) {
  for (const m of melds) {
    if (m.type === 'chi' || m.type === 'peng') return true;
    if (OPEN_GANG_TYPES.includes(m.type)) return true;
    if (m.type === 'an' && ruleset.darkGangCountsAsOpen) return true;
    // 红中杠 / 皮子杠 / 癞子杠：默认不算胡牌资格的开口（老吴 2026-10-21）
    if (isSpecialGang(m) && ruleset.specialGangCountsAsOpen) return true;
  }
  return false;
}

/**
 * 「口」数 —— 口口番按这个算番（每口 1 番）。
 *
 * ⚠️ **只数吃 / 碰，不数明杠**（老吴 2026-09-30 明确：「开口不要重复算」）。
 *    明杠（杠 zhi / 蓄杠 xu）的番由 `gangFan` 单独计（每口 2 番）；
 *    如果这里再数一遍，同一口杠就会被算两次。
 *    注意：明杠**仍然算「开口」**（见 computeOpened，必须开口才能胡），
 *    只是不再进「口数」这个计番维度。
 */
export function openCount(melds) {
  let n = 0;
  for (const m of melds) {
    if (m.type === 'chi' || m.type === 'peng') n++;
  }
  return n;
}

/** 手里是否有红中 */
export function hasRedDragon(handCounts) {
  return handCounts[RED_DRAGON] > 0;
}
