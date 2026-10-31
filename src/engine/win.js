/**
 * 胡牌判定（核心算法）—— 支持运行时动态癞子
 *
 * 目标：给定手牌的 counts 表示，穷举所有可行的「拆解方案」。
 * 返回全部拆解而不是布尔值，是因为算番要看拆解结构
 * （同一手牌可能既能拆碰碰胡又能拆平胡，取番高的那版）。
 *
 * ⚠️ 与上一版的根本区别：
 *   癞子不再固定是红中，而是**开局翻底牌决定的**（见 tiles.nextTile）。
 *   因此癞子作为参数传入，引擎本身对「哪张是癞子」完全无感。
 *
 * 字牌（东南西北中发白）可以组刻子，但不能组顺子。
 */

import { TILE_KINDS, WIN_HAND_SIZE, isNumberTile, tileRank } from './tiles.js';

/** 单次判定最多保留的拆解数量，防止极端情况爆量 */
const MAX_DECOMPOSITIONS = 300;

/**
 * 判断这手牌能否胡
 * @param {number[]} counts 长度 34 的计数数组
 * @param {object} [opts]
 * @param {number} [opts.exposedMelds=0] 已有副露数量
 * @param {number|null} [opts.wildTile=null] 本局癞子牌编码
 * @param {boolean} [opts.allowSevenPairs=false] 是否允许七对（武汉麻将默认没有）
 * @returns {boolean}
 */
export function canWin(counts, opts = {}) {
  return analyzeHand(counts, opts).winning;
}

/**
 * 完整分析一手牌
 *
 * 传入的 counts **只是手牌**，不含副露。
 * 带副露时手牌张数为 14 - 3 × exposedMelds，需要组成的面子数为 4 - exposedMelds。
 *
 * @param {number[]} counts
 * @param {object} [opts]
 * @returns {{ winning: boolean, decompositions: object[], total: number }}
 */
export function analyzeHand(counts, opts = {}) {
  const { exposedMelds = 0, wildTile = null, allowSevenPairs = false } = opts;

  const total = counts.reduce((a, b) => a + b, 0);
  const expectedTotal = WIN_HAND_SIZE - 3 * exposedMelds;
  if (total !== expectedTotal) {
    return { winning: false, decompositions: [], total };
  }

  // 把癞子从牌面里拎出来单独计数
  const hasWild = wildTile !== null && wildTile !== undefined;
  const wild = hasWild ? counts[wildTile] : 0;
  const plain = counts.slice();
  if (hasWild) plain[wildTile] = 0;

  const needMelds = 4 - exposedMelds;
  const decompositions = [];
  const seen = new Set();

  const push = (d) => {
    if (decompositions.length >= MAX_DECOMPOSITIONS) return;
    const key = [
      d.eye ? `${d.eye.tile ?? 'w'}:${d.eye.wildCount}` : '-',
      ...d.melds.map((m) => `${m.type}:${m.tile ?? 'w'}:${m.wildCount}`).sort(),
    ].join('|');
    if (seen.has(key)) return;
    seen.add(key);
    decompositions.push(d);
  };

  collectStandard(plain, wild, needMelds, push);

  // 七对必须门清；武汉麻将默认不启用
  if (allowSevenPairs && exposedMelds === 0) {
    const sp = analyzeSevenPairs(plain, wild);
    if (sp) push(sp);
  }

  return { winning: decompositions.length > 0, decompositions, total };
}

/* ------------------------------------------------------------------ */
/* 标准型：4 面子 + 1 将                                                */
/* ------------------------------------------------------------------ */

function collectStandard(plain, wild, needMelds, push) {
  const c = plain.slice();

  for (let eye = 0; eye < TILE_KINDS; eye++) {
    // 将牌 = 2 张实牌
    if (c[eye] >= 2) {
      c[eye] -= 2;
      searchMelds(c, wild, needMelds, [], (melds) => {
        push({ kind: 'standard', eye: { tile: eye, wildCount: 0 }, melds, wildUsed: wild });
      });
      c[eye] += 2;
    }

    // 将牌 = 1 张实牌 + 1 张癞子
    if (wild >= 1 && c[eye] >= 1) {
      c[eye] -= 1;
      searchMelds(c, wild - 1, needMelds, [], (melds) => {
        push({ kind: 'standard', eye: { tile: eye, wildCount: 1 }, melds, wildUsed: wild });
      });
      c[eye] += 1;
    }
  }

  // 将牌 = 2 张癞子
  if (wild >= 2) {
    searchMelds(c, wild - 2, needMelds, [], (melds) => {
      push({ kind: 'standard', eye: { tile: null, wildCount: 2 }, melds, wildUsed: wild });
    });
  }
}

/**
 * 回溯拆面子。
 * 不变式：每次取「最小非零实牌 i」，它必然是某个面子的起点，
 * 于是分支只有「以 i 为刻子成员」和「以 i 为顺子起点」两类，天然无遗漏。
 * 字牌不是数字牌，顺子分支自动被跳过。
 */
function searchMelds(c, wild, need, acc, onFound) {
  if (need === 0) {
    if (wild === 0 && c.every((x) => x === 0)) onFound(acc.slice());
    return;
  }

  let i = -1;
  for (let t = 0; t < TILE_KINDS; t++) {
    if (c[t] > 0) {
      i = t;
      break;
    }
  }

  // 实牌用尽，剩余面子全用癞子凑
  if (i === -1) {
    if (wild >= need * 3) {
      const extra = [];
      for (let k = 0; k < need; k++) {
        extra.push({ type: 'triplet', tile: null, wildCount: 3 });
      }
      onFound(acc.concat(extra));
    }
    return;
  }

  // 分支 A：i 作刻子（real 张实牌 + 癞子补足）
  const maxReal = Math.min(c[i], 3);
  for (let real = maxReal; real >= 1; real--) {
    const needWild = 3 - real;
    if (wild < needWild) continue;
    c[i] -= real;
    acc.push({ type: 'triplet', tile: i, wildCount: needWild });
    searchMelds(c, wild - needWild, need - 1, acc, onFound);
    acc.pop();
    c[i] += real;
  }

  // 分支 B：i 作顺子起点（仅数字牌，1-7 才能起头）
  if (isNumberTile(i) && tileRank(i) <= 7) {
    const j = i + 1;
    const k = i + 2;
    for (let wj = 0; wj <= 1; wj++) {
      for (let wk = 0; wk <= 1; wk++) {
        const needJ = 1 - wj;
        const needK = 1 - wk;
        if (c[j] < needJ) continue;
        if (c[k] < needK) continue;
        const needWild = wj + wk;
        if (wild < needWild) continue;

        c[i] -= 1;
        if (needJ) c[j] -= 1;
        if (needK) c[k] -= 1;
        acc.push({ type: 'sequence', tile: i, wildCount: needWild });
        searchMelds(c, wild - needWild, need - 1, acc, onFound);
        acc.pop();
        c[i] += 1;
        if (needJ) c[j] += 1;
        if (needK) c[k] += 1;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 七对（武汉麻将默认不启用，留作配置）                                  */
/* ------------------------------------------------------------------ */

export function analyzeSevenPairs(plain, wild) {
  const total = plain.reduce((a, b) => a + b, 0) + wild;
  if (total !== 14) return null;

  let pairs = 0;
  let singles = 0;
  let hasQuad = false;

  for (let t = 0; t < TILE_KINDS; t++) {
    pairs += Math.floor(plain[t] / 2);
    singles += plain[t] % 2;
    if (plain[t] >= 4) hasQuad = true;
  }

  const useForSingles = Math.min(singles, wild);
  const remainingWild = wild - useForSingles;
  pairs += useForSingles;
  pairs += Math.floor(remainingWild / 2);

  if (pairs < 7) return null;

  return { kind: 'sevenPairs', eye: null, melds: [], wildUsed: wild, hasQuad };
}

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

/** 拆解是否全为刻子（碰碰胡判定用） */
export function isAllTriplets(d) {
  if (d.kind !== 'standard') return false;
  return d.melds.every((m) => m.type === 'triplet');
}

/** 拆解里顺子的数量 */
export function sequenceCount(d) {
  if (d.kind !== 'standard') return 0;
  return d.melds.filter((m) => m.type === 'sequence').length;
}

/** 拆解消耗的癞子总数（越少越自然） */
export function wildCostOf(d) {
  if (!d || d.kind === 'sevenPairs') return 99;
  let n = d.eye?.wildCount ?? 0;
  for (const m of d.melds) n += m.wildCount;
  return n;
}
