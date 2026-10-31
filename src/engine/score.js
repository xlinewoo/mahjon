/**
 * 番型判定与结算 —— 武汉红中赖子杠
 *
 * 与上一版的根本区别（三处结构性改动）：
 *   1. 改为 **小胡 / 大胡** 两档体系：小胡基础 1，大胡基础 10 且可累计
 *   2. 结算改为 **2 的幂次方制**：输分 = 2^(输家番数 + 赢家番数)
 *   3. 新增三道胡牌闸门：持有红中不能胡 / 持有皮子不能胡 / 没开口不能胡
 *
 * 「番」在武汉麻将里的含义就是「翻一倍」，所以番数相加 = 倍数相乘。
 */

import {
  tileName,
  tileRank,
  tileSuit,
  isNumberTile,
  isHonorTile,
  RED_DRAGON,
} from './tiles.js';
import { analyzeHand, isAllTriplets, wildCostOf } from './win.js';
import {
  exposedMeldCount,
  meldsAllTriplets,
  isQuanQiuRen,
  isSpecialGang,
  physicalTiles,
  countGang,
  openCount,
} from './melds.js';

/** 番型中文名 */
export const HU_LABELS = {
  smallHuBase: '小胡（屁胡）',
  bigHuBase: '大胡',
  pengpengHu: '碰碰胡',
  qingYiSe: '清一色',
  jiangYiSe: '将一色',
  fengYiSe: '风一色',
  quanQiuRen: '全求人',
  gangShangKaiHua: '杠上开花',
  haiDiLao: '海底捞',
  qiangGangHu: '抢杠胡',
  dealer: '庄家',
  selfDraw: '自摸',
  discard: '放冲',
  hardWin: '硬胡',
  openFan: '开口',
  /**
   * ⚠️ 内部 type 仍是 `zhi`（手里暗刻 + 别人打第 4 张），但**界面一律叫「杠」**——
   *   「冲杠」是本地自造词，武汉没有这个说法（老吴 2026-10-03）。
   *   改的只是显示文案，`zhi` / `gangZhi` 这些标识一律不动
   *   （动了会连累引擎、结算协议、统计落库的字段名）。
   *   同理 `xu` 显示为「蓄杠」——武汉叫「蓄杠」，这个是真有的说法，保留。
   */
  gangZhi: '杠',
  gangXu: '蓄杠',
  gangAn: '暗杠',
  gangSkin: '皮子杠',
  gangWild: '癞子杠',
  gangRed: '红中杠',
  lianJin: '连金',
  fanJin: '反金',
  yuanLai: '原赖',
  fengLai: '风赖',
  yuanLaiFengLai: '原赖/风赖',
};

/* ------------------------------------------------------------------ */
/* 胡牌合法性 + 牌型判定                                                */
/* ------------------------------------------------------------------ */

/**
 * 评估一手胡牌
 *
 * @param {object} p
 * @param {number[]} p.counts 手牌 counts（不含副露）
 * @param {object[]} p.melds 副露
 * @param {boolean} p.opened 是否已开口
 * @param {object} p.context 情境
 *   { selfDraw, from, gangShangKaiHua, haiDiLao, qiangGangHu }
 * @param {object} p.ruleset 房间规则集
 * @param {number|null} p.wildTile 本局癞子
 * @param {number[]} [p.skinTiles] 本局皮子集合
 * @returns {{ legal: boolean, reason?: string }} 或完整评估结果
 */
export function evaluateWin({ counts, melds, opened, context, ruleset, wildTile, skinTiles = [] }) {
  /* ---- 闸门 1：持有红中不能胡（红中自己就是本局癞子时例外）---- */
  if (ruleset.redDragonInHandBlocksWin && wildTile !== RED_DRAGON && counts[RED_DRAGON] > 0) {
    return { legal: false, reason: `手里还有红中（${counts[RED_DRAGON]} 张），不能胡牌` };
  }

  /* ---- 闸门 2：持有皮子不能胡 ---- */
  if (ruleset.skinInHandBlocksWin) {
    for (const s of skinTiles) {
      if (s !== null && s !== undefined && counts[s] > 0) {
        return { legal: false, reason: `手里还有皮子（${tileName(s)}），不能胡牌` };
      }
    }
  }

  /* ---- 闸门 3：必须开口 ---- */
  if (ruleset.mustOpen && !opened) {
    return { legal: false, reason: '没有开口，不能胡牌' };
  }

  /* ---- 牌型拆解 ---- */
  const analysis = analyzeHand(counts, {
    exposedMelds: exposedMeldCount(melds),
    wildTile,
    allowSevenPairs: ruleset.allowSevenPairs,
  });

  /**
   * 乱将 / 乱风（老吴 2026-09-30）：**将一色 / 风一色不需要成顺子、刻子，也不需要将牌**。
   * 只要「手牌 + 副露」全是 2/5/8 或全是字牌、且正好 14 张，即可胡。
   *
   * ❗2026-10-29 老吴再确认：「风一色也不需要判断顺子和刻子，不需要将牌，
   *    和将一色一样，成为乱风乱将。」→ 本条兜底因此**不能只在「拆解完全不成立」时触发**，
   *    还必须覆盖「拆解成立、却全被 258 将牌闸门否掉」的情形：
   *    典型是**全字牌 + 一张癞子作将**（字牌做不了 2/5/8 将，而 258 闸门此前只给清一色开例外），
   *    以及「副露 4 口 + 单吊『字牌 + 癞子』」。风一色既然不要求将牌，就不该被将牌判死。
   */
  const shapeFreeEval = () => {
    const free = shapeFreeBigHu({ counts, melds, ruleset, wildTile, skinTiles });
    if (!free) return null;
    return evaluateDecomposition(
      { shapeFree: true, shapeFreeTypes: free.types, wildUsed: free.wildUsed, eye: null, sets: [] },
      counts, melds, context, ruleset, wildTile, skinTiles, false,
    );
  };

  if (!analysis.winning) {
    const ev = shapeFreeEval();
    return ev || { legal: false, reason: '牌型不成立' };
  }

  /* ---- 癞子还原：把癞子当普通牌再看一次，用于「硬胡」判定 ----
   * 武汉口径：硬胡 = 没有用癞子凑牌，**或者癞子就当它自己用**。
   * 只按「拆解消耗了几张癞子」判定会漏掉后者，所以这里补一次还原分析。
   */
  const naturalWin = analyzeHand(counts, {
    exposedMelds: exposedMeldCount(melds),
    wildTile: null,
    allowSevenPairs: ruleset.allowSevenPairs,
  }).winning;

  /* ---- 逐个拆解评估，取最优 ---- */
  const candidates = [];
  /**
   * 见字胡（老吴 2026-10-01）：点炮时，**进张靠癞子顶进面子**的拆解一律不成立
   * （摸到任意一张都能胡 → 不许接冲，只能自摸）。
   * ⚠️ 2026-10-22 老吴纠正：癞子只补「将」的一对，是**见将胡**，可以接炮；
   *    这里只挡「面子」里用了癞子的拆解（`isJianZiHu` 不再检查 eye）。
   * ⚠️ 是「跳过这个拆解」而不是「整手不能胡」：只要还存在**不靠癞子顶进张**的拆法，
   *    那张牌就还是普通胡、可以接冲。
   */
  let jianZiSkipped = false;
  for (const d of analysis.decompositions) {
    if (ruleset.jianZiHuMustSelfDraw
        && !context.selfDraw
        // ⚠️ 抢杠胡是当场判定的独立路径（doXuGang 直接 finishWin），**不是**接冲（点炮）。
        //   老吴 2026-10-01：见字胡只挡「点炮」，不挡抢杠 —— 见字胡牌型照样能抢杠。
        && !context.qiangGangHu
        && isJianZiHu(d, context.winTile)) {
      jianZiSkipped = true;
      continue;
    }
    const ev = evaluateDecomposition(d, counts, melds, context, ruleset, wildTile, skinTiles, naturalWin);
    if (ev) candidates.push(ev);
  }
  if (candidates.length === 0) {
    /* ---- 兜底：乱将 / 乱风（❗2026-10-29 老吴口径，详见上方 shapeFreeEval 注释）----
     * 拆解**成立**但全被否（将牌不合规 / 癞子过多）时，同样要再看一次「是不是全将牌 / 全字牌」；
     * 满足就照胡。否则「全字牌 + 一张癞子作将」这类手牌会被 258 将牌闸门白白判死，
     * 与「风一色不需要将牌」直接冲突。
     * 顺序说明：先走乱风 / 乱将，再报见字胡 —— `isJianZiHu` 对 shapeFree 拆解本就返回 false，
     * 风一色（全字牌）点炮也能胡（见 ruleset.luanFengEnabled 注释），两条口径一致。 */
    const freeEv = shapeFreeEval();
    if (freeEv) return freeEv;
    if (jianZiSkipped) {
      return { legal: false, reason: '见字胡（摸到任意一张牌都能胡）必须自摸，点炮不能胡' };
    }
    return { legal: false, reason: '不满足胡牌条件（将牌不合规或癞子过多）' };
  }

  candidates.sort((a, b) => b.fan - a.fan || a.wildUsed - b.wildUsed);
  return candidates[0];
}

/**
 * 对单一拆解判定牌型与基础番
 */
function evaluateDecomposition(d, counts, melds, context, ruleset, wildTile, skinTiles, naturalWin = false) {
  const exclude = [wildTile, ...skinTiles].filter((t) => t !== null && t !== undefined);
  const physical = physicalTiles(counts, melds, exclude);
  const physicalNoRed = physical.filter((t) => t !== RED_DRAGON);

  /* ---- 大胡类型收集 ---- */
  const types = [];

  if (d.shapeFree) {
    // 乱将 / 乱风：牌型由「全手牌是不是同一类」决定，与顺子 / 刻子无关。
    // ⚠️ 这里**不能**再跑一遍下面那几个 `isXxxYiSe(physical)` —— 它们会给出同样的结论，
    //    于是同一牌型被记两次、番数翻倍。清一色例外（将牌全是同一花色时确实同时成立）。
    types.push(...(d.shapeFreeTypes || []));
    if (isQingYiSe(physicalNoRed)) types.push('qingYiSe');
  } else {
    if (meldsAllTriplets(melds) && isAllTriplets(d)) types.push('pengpengHu');
    if (isQingYiSe(physicalNoRed)) types.push('qingYiSe');
    if (isJiangYiSe(physicalNoRed)) types.push('jiangYiSe');
    if (isFengYiSe(physicalNoRed)) types.push('fengYiSe');
  }
  // 全求人：吃/碰/明杠/蓄杠凑满 4 口 + 单钓将，且「胡牌也全为他人打出」→ **必须点炮**
  /* ❗2026-10-29 老吴：「**全求人的场景仅限最后一张吊将**」——
   *   将牌里只要含癞子（1 张或 2 张），这手牌就是**见将胡**（来任意一张都能配成将），
   *   并不是「吊某一张」，所以**不算全求人**番型。
   *   ⚠️ 但那种牌型点炮照样**包胡**：包胡按「4 口全副露 + 点炮」的结构判，
   *      与番型解耦，见 `game.js` 的 `resolveQuanQiuRenBaoSeat`。别把两者绑在一起。
   *   拆解为 shapeFree（乱将/乱风）时 `d.eye` 为 null —— 没有「吊将」概念，同样不算。 */
  if (isQuanQiuRen(melds) && !context.selfDraw
      && d.eye && d.eye.wildCount === 0) types.push('quanQiuRen');

  if (context.gangShangKaiHua) types.push('gangShangKaiHua');
  if (context.haiDiLao) types.push('haiDiLao');
  if (context.qiangGangHu) types.push('qiangGangHu');

  // 乱将 / 乱风：牌型不来自拆解，`wildCostOf(d)` 无意义 → 直接取传入的张数
  const isBig = types.length > 0;
  const wildUsed = d.shapeFree ? (d.wildUsed ?? 0) : wildCostOf(d);
  // 硬胡：没用癞子，或癞子还原成原牌也能成立
  const hardWin = wildUsed === 0 || naturalWin;
  const wildInHand = wildTile !== null && wildTile !== undefined ? counts[wildTile] : 0;

  /* ---- 将里含癞子必须配 2/5/8，**清一色 / 风一色除外**（老吴 2026-10-09 口径，2026-10-23 补大胡缺口）----
   * 老吴原话：「最后一对牌，必须是将牌（2、5、8），清一色除外。如果不是清一色，
   * 赖子也不是将牌，那么摸到赖子不能胡，必须杠才能胡。」
   * 此前这道闸只在 `!isBig` 分支生效 —— 全刻/杠副露会让拆解里只剩「癞子+X 作将」，
   * 而 isAllTriplets 空真判成碰碰胡（大胡）绕过 258 检查 ⇒ 杠出三条也被判胡
   * （老吴 2026-10-23 实测缺陷）。现在对大胡同样生效；清一色例外照旧
   * （清一色下癞子配任何同色牌作将都能胡，见 game.test.js「再杠赖还是一个赖子」）。
   * 两张癞子作将不受限（癞子可当任意 2/5/8，eyeIs258 对 tile:null 恒真）。
   *
   * ❗2026-10-29 加**风一色**例外（老吴：「风一色……不需要将牌，和将一色一样，成为乱风乱将」）：
   *    字牌永远做不成 2/5/8 将，若不豁免，「全字牌 + 一张癞子作将」会被这道闸判死，
   *    而同样牌型把将牌换成两张实字牌或两张癞子又能胡 —— 纯属将牌形式决定生死，不合理。
   *    风一色本身不需要将牌，故此处不校验。
   *    （拆解全被否时的兜底见 evaluateWin 里的 `shapeFreeEval`。） */
  if (d.eye && d.eye.wildCount > 0 && !eyeIs258(d.eye)
      && !types.includes('qingYiSe') && !types.includes('fengYiSe')) return null;

  /* ---- 小胡的两道额外限制 ---- */
  if (!isBig) {
    // 乱将 / 乱风必带牌型（isBig），正常走不到这里；真走到了说明没牌型，直接拒绝
    if (d.shapeFree) return null;
    // 小胡必须 2/5/8 作将
    if (ruleset.smallHuNeeds258Eye && !eyeIs258(d.eye)) return null;
    // 小胡手里癞子不能超过配置上限（武汉：两个癞子不能胡小胡）
    if (wildInHand > ruleset.maxWildsForSmallHu) return null;
  }

  // 小胡**没有**基础番（老吴 2026-09-30 修正：原口径凭空 +1 番）；
  // 大胡底 = 第一种 bigHuBase + 之后每多一种 bigHuExtra（默认为 1）。
  // types 覆盖全部大胡来源（5 种牌型 + 3 种情境），不针对某个组合特判。
  const baseFan = isBig
    ? ruleset.fan.bigHuBase + (types.length - 1) * (ruleset.fan.bigHuExtra ?? 1)
    : (ruleset.fan.smallHuBase ?? 0);

  return {
    legal: true,
    size: isBig ? 'big' : 'small',
    types,
    baseFan,
    wildUsed,
    hardWin,
    wildInHand,
    decomposition: d,
    fan: baseFan, // 后续由 countFan 累加番底
  };
}

/* ------------------------------------------------------------------ */
/* 番底累加                                                            */
/* ------------------------------------------------------------------ */

/**
 * 计算某玩家在本局的番数（含番底）
 *
 * ⚠️ 原赖 / 风赖**不在番里**（老吴 2026-09-30 修正）：它们改成「结算分数的倍率」，
 *    由返回值的 `mul` 字段带出。番数与分数彻底解耦 ——
 *    番数只决定查表落在哪一档，`mul` 在查表**之后**把分数翻倍。
 *
 * @param {object} player { seat, melds, opened }
 * @param {object} opts
 *   { ruleset, isDealer, isWinner, winnerIsDealer, isDiscarder, selfDraw, hardWin, baseFan, size,
 *     types, yuanLai, fengLai }
 * @returns {{ total: number, details: object[], mul: number }} mul = 结算分数倍率（1 或 2）
 */
export function countFan(player, opts) {
  const {
    ruleset,
    isDealer = false,
    isWinner = false,
    winnerIsDealer = false,
    isDiscarder = false,
    selfDraw = false,
    hardWin = false,
    baseFan = 0,
    size = null,
    types = null,
    yuanLai = false,
    fengLai = false,
    lianJin = false,
    fanJin = false,
  } = opts;

  const F = ruleset.fan;
  const details = [];
  let total = 0;
  const add = (key, n) => {
    if (n > 0) {
      total += n;
      details.push({ key, name: HU_LABELS[key] ?? key, fan: n });
    }
  };

  // 牌型基础番（只算赢家）。小胡底默认 0，故 `add` 的 n > 0 判断会直接跳过。
  if (isWinner && baseFan > 0) {
    add(size === 'big' || (!size && baseFan >= F.bigHuBase) ? 'bigHuBase' : 'smallHuBase', baseFan);
  }

  // 庄家因素：赢家是庄 → 所有输家翻倍；赢家是闲 → 庄家那家翻倍
  //
  // ⚠️ 「大胡不算庄家番」（老吴 2026-10-03，2026-10-22 补充）：`size === 'big'` 时跳过，
  //   **庄家是赢家还是输家都不算**，金顶局同样不算（不再回补）。
  if (!isWinner && (isDealer || winnerIsDealer)) {
    if (!(ruleset.bigHuNoDealerFan && size === 'big')) add('dealer', F.dealer);
  }

  // 自摸（赢家）/ 放冲（放冲那家）
  // 海底捞 / 杠上开花本身由自摸产生，老吴 2026-10-23：这两种大胡不再加「自摸」番。
  const skipSelfDrawFan =
    !!F.specialBigHuNoSelfDrawFan &&
    Array.isArray(types) &&
    (types.includes('gangShangKaiHua') || types.includes('haiDiLao'));
  if (isWinner && selfDraw && !skipSelfDrawFan) add('selfDraw', F.selfDraw);
  if (!isWinner && isDiscarder) add('discard', F.discard);

  // 硬胡
  if (isWinner && hardWin) add('hardWin', F.hardWin);

  // 开口：开口番只算一次，口口番按开口次数
  const opens = openCount(player.melds);
  if (ruleset.openMode === 'koukou') add('openFan', opens * F.openOnce);
  else if (opens > 0) add('openFan', F.openOnce);

  // 各类杠（双方都计）
  const g = ruleset.gangFan;
  add('gangZhi', countGang(player.melds, 'zhi') * g.zhi);
  add('gangXu', countGang(player.melds, 'xu') * g.xu);
  add('gangAn', countGang(player.melds, 'an') * g.an);
  add('gangSkin', countGang(player.melds, 'skin') * g.skin);
  add('gangWild', countGang(player.melds, 'wild') * g.wild);
  add('gangRed', countGang(player.melds, 'red') * g.red);

  // 连金 / 反金（老吴 2026-10-24，建桌开关）：只加给**赢家**，各 +1 番、只算一次 ——
  // 只与紧邻的上一局比较（长连胜不累加；上一局荒庄即断线）。
  // 两个 flag 由 game.buildContext 按 state.prevWinnerSeat 预先算好。
  if (isWinner) {
    if (ruleset.lianJinEnabled !== false && lianJin) add('lianJin', (ruleset.fan && ruleset.fan.lianJin) ?? 1);
    if (ruleset.fanJinEnabled !== false && fanJin) add('fanJin', (ruleset.fan && ruleset.fan.fanJin) ?? 1);
  }

  // 原赖 / 风赖 → **结算分数倍率**（不加番）
  //   原赖 + 风赖同时命中 → 仍只翻一倍（沿用「不重复」口径），取两者较大值。
  let mul = 1;
  if (isWinner) {
    const hit = yuanLai || fengLai;
    if (hit) {
      const m =
        yuanLai && fengLai
          ? Math.max(ruleset.yuanLaiMul ?? 1, ruleset.fengLaiMul ?? 1)
          : yuanLai
            ? (ruleset.yuanLaiMul ?? 1)
            : (ruleset.fengLaiMul ?? 1);
      mul = Number.isFinite(m) && m > 1 ? m : 1;
    }
  }

  return { total, details, mul };
}

/* ------------------------------------------------------------------ */
/* 结算                                                                */
/* ------------------------------------------------------------------ */

/**
 * 单笔支付：赢家番数与输家番数合成倍数
 */
export function computePayment(winnerFan, loserFan, ruleset) {
  if (ruleset.scoring === 'power2') {
    const exp = Math.min(winnerFan + loserFan, 30); // 防溢出
    return Math.pow(2, exp);
  }
  return winnerFan * loserFan;
}

/**
 * 赢家的总番数预览 —— 供「N 番起胡」门槛使用。
 * 必须与 settleRound 里算赢家番数的口径完全一致，否则门槛会误杀。
 *
 * ⚠️ 返回的是**番数**，不含原赖/风赖的分数倍率（`mul`）——
 *    起胡门槛只认番数（老吴 2026-09-30：风赖/原赖不加番，只把分数乘 2）。
 */
export function winnerFanPreview(player, winnerResult, context, ruleset) {
  return countFan(player, {
    ruleset,
    isDealer: !!player.isDealer,
    isWinner: true,
    winnerIsDealer: !!player.isDealer,
    selfDraw: !!context.selfDraw,
    hardWin: winnerResult.hardWin,
    baseFan: winnerResult.baseFan,
    size: winnerResult.size,
    types: winnerResult.types,
    yuanLai: !!context.yuanLai,
    fengLai: !!context.fengLai,
    lianJin: !!context.lianJin,
    fanJin: !!context.fanJin,
  }).total;
}

/** 是否做过红中杠 / 皮子杠 / 癞子杠（这三类特殊杠能免掉「被阳光」翻倍）。 */
function hasSpecialGang(player) {
  return (player.melds || []).some(isSpecialGang);
}

/** 是否暗杠过（闷杠）。 */
function hasAnGang(player) {
  return (player.melds || []).some((m) => m.type === 'an');
}

/**
 * 是否「被阳光」（未开口且没有任何豁免杠）。
 * 豁免：红中杠 / 皮子杠 / 癞子杠；**暗杠（闷杠）**默认同样豁免
 * （老吴 2026-10-24，建桌开关 `menGangExemptsSunny`，置 false 回到旧口径「暗杠不豁免」）。
 */
function isSunnyPlayer(player, ruleset) {
  if (player.opened) return false;
  if (hasSpecialGang(player)) return false;
  if (ruleset && ruleset.menGangExemptsSunny !== false && hasAnGang(player)) return false;
  return true;
}

/**
 * 整局结算
 *
 * @param {object} p
 * @param {object[]} p.players [{ seat, name, melds, opened, isDealer }]
 * @param {number} p.winnerSeat
 * @param {object} p.winnerResult evaluateWin 的返回
 * @param {object} p.context { selfDraw, from }
 * @param {object} p.ruleset
 * @returns {object} 结算明细
 */
export function settleRound({ players, winnerSeat, winnerResult, context, ruleset }) {
  const winner = players[winnerSeat];
  const winnerIsDealer = !!winner.isDealer;

  const winnerFan = countFan(winner, {
    ruleset,
    isDealer: winnerIsDealer,
    isWinner: true,
    winnerIsDealer,
    selfDraw: !!context.selfDraw,
    hardWin: winnerResult.hardWin,
    baseFan: winnerResult.baseFan,
    size: winnerResult.size,
    types: winnerResult.types,
    yuanLai: !!context.yuanLai,
    fengLai: !!context.fengLai,
    lianJin: !!context.lianJin,
    fanJin: !!context.fanJin,
  });

  if (ruleset.scoring === 'table') {
    return settleRoundTable({ players, winnerSeat, winnerResult, context, ruleset, winner, winnerFan, winnerIsDealer });
  }

  // —— 旧版 power2 / simple 路径（仅对照实验，默认不再使用）——
  const mul = winnerFan.mul ?? 1;
  const payments = [];
  for (const p of players) {
    if (p.seat === winnerSeat) continue;
    const isDiscarder = context.from === p.seat;
    const loserFan = countFan(p, {
      ruleset,
      isDealer: !!p.isDealer,
      isWinner: false,
      winnerIsDealer,
      isDiscarder,
      selfDraw: !!context.selfDraw,
    });
    let pay = computePayment(winnerFan.total, loserFan.total, ruleset) * mul;
    const capped = pay > ruleset.cap;
    if (capped) pay = ruleset.cap;
    const specialGang = hasSpecialGang(p);
    payments.push({
      seat: p.seat,
      name: p.name,
      fan: loserFan.total,
      fanDetails: loserFan.details,
      pay,
      capped,
      opened: !!p.opened,
      specialGang,
      sunny: isSunnyPlayer(p, ruleset),
    });
  }

  // 金顶：三家全部封顶；光明顶：金顶且还有没开口的
  const allCapped = payments.every((x) => x.capped);
  const anyUnopened = payments.some((x) => x.sunny);
  let topType = null;
  if (allCapped) {
    topType = anyUnopened ? 'brightTop' : 'goldTop';
    const amount = anyUnopened ? ruleset.brightCap : ruleset.goldCap;
    for (const x of payments) x.pay = amount;
  }

  const totalWin = payments.reduce((a, b) => a + b.pay, 0);

  return {
    winnerSeat,
    winnerName: winner.name,
    selfDraw: !!context.selfDraw,
    // 最后进张（自摸=刚摸的牌，点炮/抢杠=别人打出的那张）；结算牌面要把它补在赢家手牌最后。
    winTile: context.winTile ?? null,
    from: context.from ?? null,
    fromName: context.from != null ? players[context.from].name : null,
    size: winnerResult.size,
    types: winnerResult.types,
    winnerFan: winnerFan.total,
    winnerFanDetails: winnerFan.details,
    baseFan: winnerResult.baseFan,
    hardWin: winnerResult.hardWin,
    payments,
    totalWin,
    topType,
    text: formatWinText(winnerResult, winnerFan, payments, ruleset, topType),
  };
}

/**
 * 分段计分表结算（武汉红中赖子杠标准口径）
 *
 * 规则（老吴口径）：
 *   · 【关键】每家输分按「**该输家自己番数 + 赢家番数**」查表 —— 不是只看赢家的番数。
 *     （百度百科·武汉麻将·结算规则·番底：输方要输的分 = 2^(输家所有番数 + 赢家所有番数)）
 *   · 小胡表 6~10 番、大胡表 3~7 番；查表结果即该家应付款，顶档 = capScore（8）分。
 *   · 封顶：某家「自家番 + 赢家番」达/超顶档 → 该家封顶（capScore 分）。
 *   · 金顶：**三家全部封顶**（武汉真实口径），或风一色 → 每家付**自己那份上限**
 *     `payCap = goldScore × mul(赖) × (被阳光 ? 2 : 1)` → 10 / 20 / 20 / 40。
 *     （老吴 2026-09-30：「风赖显示金顶了，可是每家只付 10 分，应该是每家 20 分」。）
 *   · 被阳光（未开口且没有红中/皮子/癞子杠）的输家翻倍；暗杠不豁免。**单笔上限跟着倍率走**（老吴 2026-09-30）：
 *     `上限 = goldScore × mul(赖) × (被阳光 ? 2 : 1)` → 普通 10 ／ 阳光 20 ／ 有赖 20 ／ 有赖+阳光 40。
 *     ⚠️ 非金顶局当前刻度下单笔自然上限只到 16 / 32，够不到 20 / 40 → 那道封顶**实际从不触发**。
 *   · 风一色（全字牌）→ 直接金顶（不包胡）。
 *   · 清一色点炮 → 放炮者「包牌」独付全部，其余两家免付（首版简化，见 README）。
 *   · 原赖 / 风赖 → **查表之后**把分数乘 `mul`（默认 2）——老吴 2026-09-30 修正口径，
 *     不再往番数里加 1 番（那会让风赖屁胡的番数虚高 2 番，把金顶率推到 ~69%）。
 *     **大小胡都翻**；且 **×2 不受那 10 分封顶约束**（老吴拍板「都翻 / 不受」）。
 */
function settleRoundTable({ players, winnerSeat, winnerResult, context, ruleset, winner, winnerFan, winnerIsDealer }) {
  const isFengYiSeWin = winnerResult.types.includes('fengYiSe');
  const isQingYiSeWin = winnerResult.types.includes('qingYiSe');
  const isQingBao = isQingYiSeWin && ruleset.qingYiSeBaoEnabled && context.from != null && !context.selfDraw;

  const topFan = tableTopFan(winnerResult.size, ruleset);
  // 原赖 / 风赖 → 结算分数倍率（老吴 2026-09-30：不加番，只把分数乘 2）
  const mul = winnerFan.mul ?? 1;

  // ① 逐家按「自家番数 + 赢家番数」查分段计分表
  const payments = [];
  for (const p of players) {
    if (p.seat === winnerSeat) continue;
    const isDiscarder = context.from === p.seat;
    const loserFan = countFan(p, {
      ruleset,
      isDealer: !!p.isDealer,
      isWinner: false,
      winnerIsDealer,
      isDiscarder,
      selfDraw: !!context.selfDraw,
      size: winnerResult.size,   // ← 「大胡不算庄家番」要用它；以前漏传，导致 size 恒为 null
    });

    // 武汉口径（老吴）：输家实际按「自家番数 + 赢家番数」查表，不是只看赢家番数
    const effFan = winnerFan.total + loserFan.total;
    const basePay = lookupTableScore(effFan, winnerResult.size, ruleset); // 已含封顶（顶档=capScore）
    const capped = effFan >= topFan; // 该家（自家+赢家）番数达/超顶档 → 封顶

    const specialGang = hasSpecialGang(p);
    payments.push({
      seat: p.seat,
      name: p.name,
      fan: loserFan.total,
      fanDetails: loserFan.details,
      effFan,
      basePay,
      mul,
      pay: mul > 1 ? basePay * mul : basePay, // ← 风赖/原赖在此把分数翻倍（番数不动）
      capped,
      opened: !!p.opened,
      specialGang,
      sunny: isSunnyPlayer(p, ruleset),
    });
  }

  // ② 封顶 / 金顶（武汉真实口径）：
  //    · 某家「自家番 + 赢家番」达/超顶档 → 该家封顶（capScore）分；
  //    · **三家全部封顶**（或风一色）→ 金顶，每家付 goldScore（10）分。
  const allCapped = payments.length > 0 && payments.every((x) => x.capped);
  const goldTop = isFengYiSeWin || allCapped;

  for (const x of payments) {
    // 该家的单笔上限**跟着倍率走**（老吴 2026-09-30）：
    //   上限 = goldScore × mul(赖) × (被阳光 ? 2 : 1) → 10 / 20 / 20 / 40。
    // 老吴 2026-10-21：未开口但做过红中/皮子/癞子杠 → 不算被阳光，不翻倍；暗杠仍算。
    const payCap = ruleset.goldScore * mul * (x.sunny ? 2 : 1);
    x.payCap = payCap;
    if (goldTop) {
      // ❗金顶 = **每家各付自己那份上限**。老吴 2026-09-30 二次纠正：
      //   「风赖显示金顶了，可是每家只付 10 分，应该是每家 20 分」
      //   → 风赖金顶 = 10 × 2 = 20 ／ 该家未开口再翻倍 = 40 ／ 无赖已开口 = 10。
      //   这也顺手消掉了「非金顶局单笔 16 分 > 金顶局单笔 10 分」的老矛盾。
      x.pay = ruleset.scaledPayCap ? payCap : ruleset.goldScore;
      x.capped = true;
      x.payCapApplied = false; // 金顶走的是另一条分支，不算「这道上限削了分」
    } else {
      let pay = x.pay;
      if (x.sunny) pay *= 2; // 被阳光（未开口且无红中/皮子/癞子杠）输家翻倍
      // ⚠️ 当前刻度下查表顶档只有 8 分 → 单笔自然上限 16(有赖) / 32(有赖+未开口)，
      //    都够不到 20 / 40，所以**这道封顶实际上从不触发**（现状 = 照乘不封顶）。
      //    留着公式是为了改刻度时封顶自动跟着走。`tools/cap-compare.js` 可验证。
      x.payCapApplied = !!ruleset.scaledPayCap && pay > payCap;
      if (x.payCapApplied) pay = payCap;
      x.pay = pay;
    }
  }

  // 清一色包牌：放炮者独付全部，其余两家免付（首版简化）
  let bao = null;
  if (isQingBao) {
    const discarder = payments.find((x) => x.seat === context.from);
    const total = payments.reduce((a, b) => a + b.pay, 0);
    for (const x of payments) x.pay = x.seat === context.from ? total : 0;
    bao = { seat: context.from, name: players[context.from].name, amount: total };
  }

  const totalWin = payments.reduce((a, b) => a + b.pay, 0);
  const topType = goldTop || isQingBao ? 'goldTop' : null;

  return {
    winnerSeat,
    winnerName: winner.name,
    selfDraw: !!context.selfDraw,
    // 最后进张（自摸=刚摸的牌，点炮/抢杠=别人打出的那张）；结算牌面要把它补在赢家手牌最后。
    winTile: context.winTile ?? null,
    from: context.from ?? null,
    fromName: context.from != null ? players[context.from].name : null,
    // 局况番（自摸 / 点炮 / 庄家）的落点，供前端把这三笔加番摊开给玩家看
    dealerSeat: players.find((p) => p.isDealer)?.seat ?? null,
    dealerIsWinner: winnerIsDealer,
    size: winnerResult.size,
    types: winnerResult.types,
    winnerFan: winnerFan.total,
    winnerFanDetails: winnerFan.details,
    /** 原赖/风赖的结算分数倍率（1 = 无，2 = 翻倍）。番数里不含它。 */
    mul,
    yuanLai: !!context.yuanLai,
    fengLai: !!context.fengLai,
    baseFan: winnerResult.baseFan,
    hardWin: winnerResult.hardWin,
    payments,
    totalWin,
    topType,
    bao,
    text: formatWinTextTable(winnerResult, winnerFan, payments, ruleset, topType, bao),
  };
}

/** 查分段计分表：取「番数 ≤ winnerFan」的最高档的分；低于最低档 → 0（由起胡门槛兜底） */
function lookupTableScore(winnerFan, size, ruleset) {
  const table = ruleset.scoreTable[size] ?? [];
  let points = 0;
  for (const [fan, pts] of table) {
    if (winnerFan >= fan) points = pts;
    else break;
  }
  return points;
}

/** 计分表顶档番数（超出即金顶） */
function tableTopFan(size, ruleset) {
  const table = ruleset.scoreTable[size] ?? [];
  return table.length ? table[table.length - 1][0] : 0;
}

/**
 * 分段计分表口径的结算文案。
 * ⚠️ 必须在**承包 / 包胡改写 payments 之后**重新调用一次，
 *    否则文案里的「X 输 N」还是改写前的数字，会跟面板里的实际分账自相矛盾。
 */
export function formatWinTextTable(winnerResult, winnerFan, payments, ruleset, topType, bao) {
  const typeNames = winnerResult.types.map((k) => HU_LABELS[k] ?? k);
  const head =
    winnerResult.size === 'big'
      ? `大胡（${typeNames.join(' + ')}）`
      : '小胡（屁胡）';
  const parts = [];
  for (const p of payments) {
    if (p.pay > 0) parts.push(`${p.name} 输 ${p.pay}（${p.fan}+${winnerFan.total}=${p.effFan}番）`);
  }
  let topNote = '';
  if (topType === 'goldTop') topNote = '【金顶】';
  const mul = winnerFan.mul ?? 1;
  let mulNote = '';
  if (mul > 1) mulNote = `｜【原赖/风赖 分数 ×${mul}】`;
  let baoNote = '';
  if (bao && bao.amount > 0) baoNote = `｜【清一色包牌】${bao.name} 独付 ${bao.amount}`;
  return `${head}${winnerResult.hardWin ? '·硬胡' : '·软胡'}｜赢家 ${winnerFan.total} 番｜${parts.join('，')}${topNote}${mulNote}${baoNote}`;
}

/* ------------------------------------------------------------------ */
/* 判定辅助                                                            */
/* ------------------------------------------------------------------ */

/** 将牌是否是 2/5/8（赖子当将视为可凑 258） */
export function eyeIs258(eye) {
  if (!eye) return false;
  if (eye.tile === null) return true; // 两张癞子可当任意牌，包括 258
  if (!isNumberTile(eye.tile)) return false; // 字牌不能作小胡的将
  return [2, 5, 8].includes(tileRank(eye.tile));
}

/** 清一色：全部同一数字花色 */
export function isQingYiSe(physical) {
  if (physical.length === 0) return false;
  if (!isNumberTile(physical[0])) return false;
  const suit = tileSuit(physical[0]);
  return physical.every((t) => isNumberTile(t) && tileSuit(t) === suit);
}

/** 将一色：全部是 2/5/8 */
export function isJiangYiSe(physical) {
  if (physical.length === 0) return false;
  return physical.every((t) => isNumberTile(t) && [2, 5, 8].includes(tileRank(t)));
}

/** 风一色：全部是字牌（含中发白） */
export function isFengYiSe(physical) {
  if (physical.length === 0) return false;
  return physical.every((t) => isHonorTile(t));
}

/**
 * 乱将 / 乱风（老吴 2026-09-30）——**不要求成顺子 / 刻子**的一色判定。
 *
 * 老吴原话：「将一色、风一色都不需要按顺子、刻子的规则，全手牌只要全是将牌或者风牌
 * 就可以胡牌，即乱将乱风就可以。」
 *
 * 只在**常规拆解失败**时才走这条路（常规拆解能成时，牌型已经在 `evaluateDecomposition`
 * 里判过一遍了，而且可能额外带出碰碰胡 / 清一色，番数只会更高）。
 *
 * ⚠️ 必须校验**总张数正好 14 张** —— 否则「手里随便抓几张 2/5/8」也会被判成胡牌。
 *
 * @returns {null | { types: string[], wildUsed: number }} null = 不是乱将 / 乱风
 */
export function shapeFreeBigHu({ counts, melds, ruleset, wildTile, skinTiles = [] }) {
  if (!ruleset.luanJiangEnabled && !ruleset.luanFengEnabled) return null;

  const exclude = [wildTile, ...skinTiles].filter((t) => t !== null && t !== undefined);
  const physical = physicalTiles(counts, melds, exclude).filter((t) => t !== RED_DRAGON);
  if (physical.length === 0) return null;

  // ⚠️ 张数校验：手牌 + 副露「占的位子」= 14 才是完整的一手牌。
  //    位子数**不能**直接数 `m.tiles.length` —— 一副杠存了 4 张牌却只占 3 个位子，
  //    红中/皮子/癞子杠更是只占 1 个位子，那样数会多算。
  const slots = melds.reduce((a, m) => a + (isSpecialGang(m) ? 1 : 3), 0);
  const total = counts.reduce((a, b) => a + b, 0) + slots;
  if (total !== 14) return null;

  const types = [];
  if (ruleset.luanJiangEnabled && isJiangYiSe(physical)) types.push('jiangYiSe');
  if (ruleset.luanFengEnabled && isFengYiSe(physical)) types.push('fengYiSe');
  if (types.length === 0) return null;

  // 癞子被排除在 physical 之外，但它确实被用掉了 → 记进 wildUsed（影响「硬胡」判定）
  const wildUsed = wildTile !== null && wildTile !== undefined ? (counts[wildTile] || 0) : 0;
  return { types, wildUsed };
}

/**
 * 见字胡判定（老吴 2026-10-01）
 *
 * 老吴原话：「**见字胡，是指摸到任意一张牌都可以胡，除了红中和皮，必须杠**」
 *          「**只有见字胡才是必须自摸，其他牌型可以接冲**」
 *
 * 判据：**进来的那张牌是靠癞子顶进「面子」的** —— 它在拆解里所在的那一组
 *       面子用了癞子（`wildCount > 0`）。那张牌换成别的牌照样成立 ⟺ 摸啥都能胡 = 见字胡。
 *
 *   ⚠️ 2026-10-22 老吴纠正：**4 副露 + 1 个癞子单吊将，是「见将胡」，不是见字胡，
 *      可以接炮。** 癞子只是补「将」的那一对，不属于见字胡必须自摸的范畴。
 *      因此这里**不再检查 `eye`**，只检查面子里的癞子。
 *
 *   例①（是）：手里 3 面子 + 将 + 2 癞子，摸进东风 →「癞 癞 东风」凑成第 4 个面子
 *              → 换成任意一张都能凑 → 见字胡 → 必须自摸。
 *   例②（不是）：手里若干面子 + 1 癞子，别人打东风 →「东风 + 癞(当东风)」作将
 *              → 见将胡，可以接炮（不要求 4 副露；4 副露只是全求人的特例）。
 *   例③（不是）：听 3/6 万（手里 4万5万），摸进 6万 →「四五六万」这组 `wildCount === 0`
 *              → 进张是自己凑上顺子的，换张就不成立 → 普通胡，可以接冲。
 *
 * @param {object} d 单个拆解（`{ kind, eye:{tile,wildCount}, melds:[{type,tile,wildCount}] }`）
 * @param {number|null|undefined} winTile 进来的那张牌（自摸=刚摸的，点炮=别人打的）
 * @returns {boolean}
 */
export function isJianZiHu(d, winTile) {
  if (!d || winTile === null || winTile === undefined || winTile < 0) return false;
  if (d.kind === 'sevenPairs') return false; // 武汉没有七对
  if (d.shapeFree) return false;             // 乱将 / 乱风：牌型与拆解无关，不适用
  if (!isNumberTile(winTile) && !isHonorTile(winTile)) return false;

  for (const m of d.melds || []) {
    if (!m || !(m.wildCount > 0)) continue;
    if (m.type === 'triplet') {
      if (m.tile === winTile) return true;
    } else if (m.type === 'sequence' && m.tile !== null && m.tile !== undefined) {
      // 顺子 = [t, t+1, t+2]，同花色内（win.js 保证不跨花色，这里仍显式校验花色）
      if (isNumberTile(winTile) && tileSuit(m.tile) === tileSuit(winTile)
          && winTile >= m.tile && winTile <= m.tile + 2) return true;
    }
  }
  // ⚠️ 不检查将（eye）：4 副露 + 1 癞子单吊将是「见将胡」，可以接炮（2026-10-22 老吴纠正）。
  return false;
}

/** 生成人类可读的胡牌说明 */
export function formatWinText(winnerResult, winnerFan, payments, ruleset, topType) {
  const typeNames = winnerResult.types.map((k) => HU_LABELS[k] ?? k);
  const head =
    winnerResult.size === 'big'
      ? `大胡（${typeNames.join(' + ')}）`
      : '小胡（屁胡）';

  const parts = [];
  for (const p of payments) {
    parts.push(`${p.name} 输 ${p.pay}（${p.fan}番）`);
  }
  let topNote = '';
  if (topType === 'goldTop') topNote = '【金顶】';
  if (topType === 'brightTop') topNote = '【光明顶】';

  return `${head}${winnerResult.hardWin ? '·硬胡' : '·软胡'}｜赢家 ${winnerFan.total} 番｜${parts.join('，')}${topNote}`;
}
