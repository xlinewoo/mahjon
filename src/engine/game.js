/**
 * 对局状态机 —— 武汉红中赖子杠（136 张）
 *
 * 设计原则（与上一版一致，仍然有效）：
 *   1. 服务端权威 —— 所有牌局事实只存在于 state，客户端只发「意图」
 *   2. 纯逻辑、零 I/O、零 Math.random —— 同一 seed 完整可复算
 *   3. 一切变更走 act(state, action)
 *
 * 本版新增/重写的规则：
 *   · 开局翻底牌定癞子：翻出的叫「皮子」，它的下一张是「癞子」
 *   · 杠拆成 6 种：杠(zhi) / 蓄杠(xu) / 暗杠(an) / 红中杠(red) / 皮子杠(skin) / 癞子杠(wild)
 *   · 暗杠、红中杠、皮子杠、癞子杠 **都不算开口**
 *   · 持有红中或皮子 → 不能胡牌
 *   · 抢杠胡 → 被抢的那家承包
 *   · 杠后可选不补牌（action.noDraw）→ 只加番，不摸牌/不打牌，直接过手
 *
 * 牌数守恒（m = 占面子的副露数，特殊杠不占）：
 *   等待摸牌时 hand.length = 13 - 3m
 *   摸牌/吃碰后  hand.length = 14 - 3m
 */

import {
  makeWall,
  makeTile,
  nextTile,
  prevTile,
  toCounts,
  tileSuit,
  tileRank,
  tileName,
  formatTiles,
  RED_DRAGON,
  GREEN_DRAGON,
  WHITE_DRAGON,
  EAST,
  SOUTH,
  WEST,
  NORTH,
  TILE_KINDS,
  isNumberTile,
  isWindTile,
} from './tiles.js';
import { createRng } from './rng.js';
import { createRuleSet } from './rules.js';
import { evaluateWin, settleRound, winnerFanPreview, countFan, formatWinTextTable, HU_LABELS } from './score.js';
import { exposedMeldCount, computeOpened, isQuanQiuRen } from './melds.js';

export const SEATS = 4;

/** 视图里「暗杠被掩去」的占位牌码：对局中别家暗杠只给张数不给牌面（老吴 2026-10-23）。
 *  渲染层见到该值一律画牌背；摊牌（settled）后 viewFor 下发真实牌面。 */
export const HIDDEN_TILE = -1;

/* ------------------------------------------------------------------ */
/* 建局                                                                */
/* ------------------------------------------------------------------ */

/**
 * 创建一局新牌
 * @param {{ seed?: number, ruleset?: object, dealer?: number, names?: string[],
 *           prevWildTile?: number|null }} opts
 *   prevWildTile 上一局的癞子（用于判定「原赖」），不传则本局不可能是原赖
 */
/**
 * @param {object} opts
 * @param {number} [opts.seed] 洗牌种子。⚠️ **绝不能下发给任何在线客户端**（见 viewFor 注释）。
 * @param {string|null} [opts.handTag] 本局的**不可反推**标识，仅用于前端「本局内去重/播报」这类
 *   需要区分「同局 vs 下一局」的场景。由调用方随机生成（服务端 randomBytes）；
 *   缺省时前端自行造一个（单机版无对局外泄露面，可退化为本地 seed 派生）。
 */
export function createGame({ seed = 1, ruleset = createRuleSet('koukou'), dealer = 0, names, avatars, prevWildTile = null, prevWinnerSeat = null, handTag = null } = {}) {
  const rng = createRng(seed);
  const wall = rng.shuffle(makeWall());

  // 起手掷骰（两颗，1..6）：**纯展示**用 —— 服务端权威、同 seed 可复算。
  // ⚠️ 必须另起一条随机流：若沿用上面那条 rng 掷骰，洗牌序列会被顶掉，
  //    同一 seed 的历史牌局将全部漂移（回放/复算全废）。
  const diceRng = createRng((seed ^ 0x9e3779b9) >>> 0);
  const dice = [1 + diceRng.int(6), 1 + diceRng.int(6)];

  const players = [];
  for (let seat = 0; seat < SEATS; seat++) {
    players.push({
      seat,
      name: names?.[seat] ?? `玩家${seat + 1}`,
      // 预设头像（emoji）；不传则前端按名字首字本地生成（老行为兜底）
      avatar: avatars?.[seat] ?? null,
      hand: [],
      melds: [],
      discards: [],
      opened: false,
      isDealer: seat === dealer,
      drawCount: 0,
      turnCount: 0,
      qiPi: false, // 达到七皮（封顶触发，牌局继续）
      shiGang: false, // 达到十杠
      skinSeen: 0, // 本局累计拿到的皮子张数（含已杠/已打出，用于「基本两口」包胡判定）
    });
  }

  // 逐轮发牌：每人 13 张，庄家多 1 张
  for (let round = 0; round < 13; round++) {
    for (let s = 0; s < SEATS; s++) players[s].hand.push(wall.shift());
  }
  players[dealer].hand.push(wall.shift());

  // ---- 翻底牌定癞子 ----
  let flipTile = null;
  let wildTile = null;
  if (ruleset.wildMode === 'flip') {
    flipTile = wall.shift();
    wildTile = deriveWild(flipTile, ruleset);
  }
  // 'none' → 本局完全没有癞子（对照实验用）
  // 注意：原先的 wildMode='redDragon'（红中当癞子）已废弃 —— 红中固定是皮，绝不当癞子

  // 原赖：本局癞子与上一局癞子相同；风赖：本局癞子为风牌（东南西北）
  const yuanLai = wildTile !== null && prevWildTile !== null && wildTile === prevWildTile;
  const fengLai = wildTile !== null && isWindTile(wildTile);
  const skinTiles = computeSkinTiles(flipTile, wildTile, ruleset);

  // 起手牌里已经拿到的皮子，计入「本局累计皮子」
  for (const p of players) p.skinSeen = p.hand.filter((t) => skinTiles.includes(t)).length;

  for (const p of players) p.hand.sort((a, b) => a - b);

  return {
    ruleset,
    seed,
    // 对外的局标识（不可反推 seed）。没有传就留 null，让前端退化处理。
    handTag: handTag == null ? null : String(handTag),
    dealer,
    wall,
    dice, // 起手掷骰 [v1, v2]（1..6）—— 公开信息，仅用于前端展示
    turn: dealer,
    phase: 'discard', // 'discard' | 'claim' | 'settled'
    // 胡牌后的「摊牌确认」：phase 已经是 settled（结果已算出），但四家还没都确认前
    // 前端只摊牌、不弹结算页。荒庄没有这一层（直接结算）。
    //   { pending: boolean, confirmed: number[] }
    reveal: null,
    players,
    flipTile,
    wildTile,
    skinTiles,
    prevWildTile,
    // 上一局的赢家座位（连金 / 反金判定用；null = 上局荒庄或开局无上局）
    prevWinnerSeat,
    yuanLai,
    fengLai,
    lastDiscard: null,
    lastDraw: null,
    gangFlag: false,
    lastDrawIsLast: false,
    // 本家本轮「过掉自摸」了吗（老吴 2026-09-30：有胡时也要允许过）。
    // 每次摸牌重置；为真时 legalActions 不再给出 `win`，玩家继续正常出牌。
    winDeclined: false,
    // 刚吃/碰过 → **必须先出牌**（老吴 2026-09-30）。
    // 吃/碰之后手里正好是 14 张（11 张手牌 + 3 张副露），`canWinWith(自摸)` 会判定成立，
    // 于是冒出一个「胡」按钮 —— 但真实规则是**吃/碰后必须打牌，不能胡**（只有杠后补摸才许胡，
    // 那是「杠上开花」）。摸牌（含杠后补摸）与出牌都会把它清掉。
    mustDiscard: false,
    // 全局弃牌流水（按出牌先后）：前端「牌桌中央依次显示」需要跨家的顺序，
    // 各家自己的 discards 只有本家顺序，凑不出全局次序。
    discardLog: [],
    claims: [],
    claimIndex: 0,
    // 下雨 / 陪包（老吴 2026-10-25 定，同日二次修订）：数组，按宣告先后排序。
    //   每场雨 { color: 0|9|18, owner: 触发者座位, baos: [第三句提供者], penalties: [未下雨被记陪包的座位] }
    //   · 触发：A 的该花色**明牌**副露（chi/peng/zhi/xu，暗杠不计）恰好在喂牌后达到第 3 句 → 供牌者包胡
    //     （第 4 个明牌不包；前三句里有暗杠时第 4 句实际是第 3 个明牌 → 照包，天然实现）
    //   · 结算：**雨主自己胡牌**才结算该雨（A 没胡 → 包胡/下雨全部不计算，老吴 10-25 修订①）
    //   · 惩罚：只挂**第一场**被包的花色（第二场雨只约束出牌顺序、不算惩罚，修订⑤）；
    //     义务人每轮出牌时手中有该花色却未出 → 当场记陪包（修订③），结算各付总分
    rains: [],
    // 正在「待抢」的蓄杠（老吴 2026-10-02）：
    //   { seat, tile } —— seat 想补杠 tile，但先把响应机会给可能抢杠胡的三家。
    //   三家全「过」才真正补杠；有人点「胡」则当场结算（seat 承包）。
    //   非 null 时 phase 一定是 'claim'，且 claims 里全是 type:'win' 的抢杠选项。
    pendingXuGang: null,
    wallDrawn: 0,
    result: null,
    events: [],
    seq: 0,
    // 七皮 / 十杠「刚达成」的播报事件：只追加、不删除；前端按 seq+seed 去重后弹出。
    // 金额在这一刻按规则算好，和终局 computeSpecialBonuses 同源（只是提前展示，不提前记账）。
    achievementSeq: 0,
    achievementEvents: [],
  };
}

/**
 * 由翻出的底牌推导「癞子」。
 *
 * 数字牌（万筒条）在 1-9 内顺延；字牌按全序「东南西北 红中 发财 白板」推进，
 * 但**永远跳过红中**：红中固定是皮子/红中杠，任何规则下都不能当癞子。
 *   翻北 / 翻红中 → 癞子都是「发财」；翻发财 → 白板；翻白板 → 东风。
 *
 * ⚠️ 旧房间 JSON 里可能残留 `wildCycleIncludesRedDragon:true`，这里**一律忽略**。
 */
const HONOR_FULL = [EAST, SOUTH, WEST, NORTH, RED_DRAGON, GREEN_DRAGON, WHITE_DRAGON];

export function deriveWild(flipTile, ruleset) {
  if (ruleset.wildMode === 'none') return null;
  if (flipTile === null) return null;
  if (isNumberTile(flipTile)) return nextTile(flipTile);
  const idx = HONOR_FULL.indexOf(flipTile);
  for (let step = 1; step <= HONOR_FULL.length; step++) {
    const cand = HONOR_FULL[(idx + step) % HONOR_FULL.length];
    if (cand !== RED_DRAGON) return cand;
  }
  return GREEN_DRAGON;
}

/**
 * 计算本局「皮子」集合（老吴 2026-09-30 口径）
 *
 *   皮子 = 癞子往回数 `skinPrevCount` 张（默认 2 张：**癞子减一、减二**）+ **红中**
 *
 * 例：翻出五万 → 六万是癞子 → 皮子 = {五万, 四万} + 红中。
 * 「一共 11 张皮」的算法：五万 4 张里 1 张已被翻出（不再可用）→ 3 + 4(四万) + 4(红中) = 11 ✓
 * 任何翻牌都恒为 11：翻一万 → {一万(3), 九万(4), 红中(4)}；翻北风 → {北风(3), 西风(4), 红中(4)}。
 *
 * ⚠️ 防御：旧回放若曾把红中记成癞子，红中仍不能同时算皮子；新对局中
 *    `deriveWild()` 已硬保证红中永远不会成为癞子。
 */
export function computeSkinTiles(flipTile, wildTile, ruleset) {
  const skins = [];
  const add = (t) => {
    if (t === null || t === undefined) return;
    if (!skins.includes(t)) skins.push(t);
  };
  // ① 癞子往回数 N 张（默认 2：癞子减一 = 翻出的那张；癞子减二 = 它的前一张）
  const n = ruleset.skinPrevCount ?? 0;
  if (n > 0) {
    let cur = wildTile ?? flipTile;
    for (let i = 0; i < n && cur !== null && cur !== undefined; i++) {
      cur = prevTile(cur);
      add(cur);
    }
  }
  // ② 翻出的那张（无癞子模式下回推不到它，补上）
  if (ruleset.skinIncludesFlipTile) add(flipTile);
  // ③ 红中固定是皮：无论癞子是谁，红中一律进皮子集合（除非它自己就是癞子）
  if (ruleset.skinIncludesRedDragon && wildTile !== RED_DRAGON) add(RED_DRAGON);
  for (const t of ruleset.extraSkinTiles ?? []) add(t);
  return skins;
}

/** 该座位当前应有的手牌张数（摸牌后）。特殊杠不折算面子 */
export function handNeeded(state, seat) {
  return 14 - 3 * exposedMeldCount(state.players[seat].melds);
}

/** 该牌是否本局的癞子 / 皮子 */
export function isWild(state, tile) {
  return state.wildTile !== null && tile === state.wildTile;
}
export function isSkin(state, tile) {
  return state.skinTiles.includes(tile);
}
export function isSpecial(state, tile) {
  // 红中永远按特殊牌处理（即使某些规则把它排除出皮子集合）：不能吃碰、不能暗杠、不能打出。
  return tile === RED_DRAGON || isWild(state, tile) || isSkin(state, tile);
}

/* ------------------------------------------------------------------ */
/* 动作枚举                                                            */
/* ------------------------------------------------------------------ */

/** 该牌此刻能走的特殊杠类型（null = 不是特殊牌 / 对应杠被规则关闭）。
 *  顺序：癞子优先；红中永远走 redgang（不依赖 skinTiles）；普通皮子走 skingang。
 *  老吴 2026-10-20：红中/皮子/癞子不能进牌河，点「打出」时按这里改判成杠。 */
export function specialGangFor(state, tile) {
  if (!Number.isInteger(tile)) return null;
  if (tile === state.wildTile) return 'wildgang';
  // 红中固定是特殊杠牌：即使 skinIncludesRedDragon=false 也要能红中杠、不能打出。
  if (tile === RED_DRAGON) return state.ruleset.redDragonGangEnabled ? 'redgang' : null;
  if (!Array.isArray(state.skinTiles) || !state.skinTiles.includes(tile)) return null;
  return state.ruleset.skinGangEnabled !== false ? 'skingang' : null;
}

/** 列出某座位此刻可以做的动作 */
export function legalActions(state, seat) {
  if (state.phase === 'settled') {
    // 胡牌摊牌阶段：四家各点一次「确认」后才弹结算页（老吴 2026-10-20）。
    if (state.reveal && state.reveal.pending) {
      return state.reveal.confirmed.includes(seat) ? [] : [{ type: 'confirm', seat, tile: null }];
    }
    return [];
  }

  /* ---------- 响应阶段 ---------- */
  if (state.phase === 'claim') {
    const pending = state.claims[state.claimIndex];
    if (!pending || pending.seat !== seat) return [];
    const opts = pending.options.map((o) => ({ ...o }));
    // 「过」永远给（过吃/碰/杠）。可胡时是否也能过，由 canPassWin 决定。
    // ⚠️ 抢杠胡**现在也走这里**（老吴 2026-10-02 改口）—— 于是「有胡必给过」这条不变量
    //    对自摸 / 点炮 / 抢杠三种情况全部成立，不再有「抢杠不能过」的特例。
    const hasWin = opts.some((o) => o.type === 'win');
    if (state.ruleset.canPassWin !== false || !hasWin) opts.push({ type: 'pass', seat });
    return opts;
  }

  if (state.phase !== 'discard' || state.turn !== seat) return [];

  const p = state.players[seat];
  const acts = [];
  const counts = toCounts(p.hand);

  /* ---- 打牌 ----
   * 🔴 红中 / 皮子 / 癞子不能进牌河（老吴 2026-10-20）：能杠的只给杠，不给打。
   *   兜底：若整手都是这类牌（没有普通牌可打，正常不会发生），仍允许打出一张，
   *   否则会出现「无动作可做」的死局。 */
  const noSpecialDiscard = state.ruleset.specialTilesNoDiscard !== false;
  const seen = new Set();
  for (const t of p.hand) {
    if (seen.has(t)) continue;
    if (noSpecialDiscard && specialGangFor(state, t)) continue;
    seen.add(t);
    acts.push({ type: 'discard', seat, tile: t });
  }
  if (noSpecialDiscard && !acts.some((a) => a.type === 'discard')) {
    for (const t of p.hand) {
      if (seen.has(t)) continue;
      seen.add(t);
      acts.push({ type: 'discard', seat, tile: t });
    }
  }

  /* ---- 自摸（本轮已「过」掉的不再出现） ----
   * ⚠️ 两把锁：① 本轮「过」过；② 刚吃/碰过（老吴 2026-09-30：吃碰后必须打牌，不能胡）。
   *    吃/碰之后手里是 14 张（11 张手牌 + 3 张副露），canWinWith 会判定成立 —— 但那不是自摸，
   *    真实规则要先把牌打出去。杠后补摸走 `drawTile`，锁已解开 → 杠上开花照旧。 */
  const selfCtx = buildContext(state, seat, { selfDraw: true });
  const canSelfDraw = canWinWith(state, seat, counts, selfCtx).legal
    && !state.mustDiscard;
  if (canSelfDraw && !state.winDeclined) {
    acts.push({ type: 'win', seat });
  }
  /* ---- 「过」不胡（老吴 2026-09-30）：有胡才能过，过完继续出牌 ---- */
  if (canSelfDraw && !state.winDeclined && state.ruleset.canPassWin !== false) {
    acts.push({ type: 'pass', seat });
  }

  pushGangActions(state, seat, p, counts, acts);
  return acts;
}

/** 收集当前手牌 / 副露下的全部杠动作（暗杠 / 蓄杠 / 红中杠 / 皮子杠 / 癞子杠）。
 *  legalActions 与「杠后不补牌的续杠判断」（afterGangDraw）共用，保证两处口径一致。 */
function pushGangActions(state, seat, p, counts, acts) {
  /* ---- 暗杠 ----
   * 🔴 皮子 / 癞子**不能暗杠**（老吴 2026-10-03 23:20）。
   *   特殊杠只走 `doSpecialGang`（skin/wild/red，各占 1 张、不折算面子），
   *   暗杠是「占一个完整面子」的副露，皮子/赖子不该走这条路。
   *
   * ⚠️ 判据要**同时**查 `wildTile`（癞子是独立字段，**不在 `skinTiles` 里** —— 我第一版只查
   *   skinTiles，结果癞子仍能暗杠，被自己的测试当场抓住）。
   *   `skinIncludesRedDragon:true` 时红中也在 skinTiles 里，所以这条一并把「4 张红中暗杠」排除了。 */
  for (let t = 0; t < TILE_KINDS; t++) {
    if (state.ruleset.specialTilesNoAnGang !== false) {
      if (t === RED_DRAGON || t === state.wildTile) continue;
      if (state.skinTiles.includes(t)) continue;
    }
    if (counts[t] === 4) acts.push({ type: 'an', seat, tile: t });
  }

  /* ---- 蓄杠 ---- */
  for (const m of p.melds) {
    if (m.type === 'peng' && counts[m.tiles[0]] >= 1) {
      acts.push({ type: 'xu', seat, tile: m.tiles[0] });
    }
  }

  /* ---- 特殊杠 ---- */
  const wildT = state.wildTile;
  if (wildT !== null && counts[wildT] > 0) {
    acts.push({ type: 'wildgang', seat, tile: wildT });
  }
  // 红中不依赖 skinTiles：即使规则把它排除出皮子集合，也照样给「红中杠」。
  if (counts[RED_DRAGON] > 0) {
    const gt = specialGangFor(state, RED_DRAGON);
    if (gt) acts.push({ type: gt, seat, tile: RED_DRAGON });
  }
  for (const s of state.skinTiles) {
    if (s === wildT || s === RED_DRAGON || counts[s] <= 0) continue;
    const gt = specialGangFor(state, s);
    if (gt) acts.push({ type: gt, seat, tile: s });
  }
}

/* ------------------------------------------------------------------ */
/* 动作执行                                                            */
/* ------------------------------------------------------------------ */

export function act(state, action) {
  // 状态版本号：服务端按 (handNo, rev) 缓存每座位的听牌分析/视图派生数据。
  // 在函数入口自增 —— 即使后续校验抛错（状态未变）也只是缓存多算一轮，不影响正确性。
  state.rev = (state.rev || 0) + 1;

  if (state.phase === 'settled') {
    // 结算结果已出，但还在等四家确认摊牌 —— 只接受 confirm。
    if (state.reveal && state.reveal.pending && action && action.type === 'confirm') {
      return confirmReveal(state, action);
    }
    throw new Error('牌局已结束');
  }

  // 🔴 响应队列守卫（老吴 2026-10-24：碰优先于吃，不是谁快谁先）：
  //    claim 阶段只有**队列当前响应者**（claims[claimIndex].seat）能行动 ——
  //    碰家未表态前，吃家的 chi/peng/win 一律拒绝（服务端 applyAction 已用
  //    legalActions 挡了一道；这里给引擎直调路径（回放/机器人/测试）补上同样的口径，
  //    否则 doChi 不看队列、可以直接跳过碰家把牌吃走）。
  if (state.phase === 'claim' && action && action.seat !== undefined) {
    const pending = state.claims[state.claimIndex];
    if (pending && action.seat !== pending.seat) {
      throw new Error('还没轮到你（响应按优先级排队：胡>碰/杠>吃）');
    }
  }

  // 红中 / 皮子 / 癞子点「打出」→ 自动改判为对应的特殊杠（老吴 2026-10-20）。
  // 只在轮到该座位时改判，避免把越权/抢牌之类的非法动作用「杠」洗白。
  if (action && action.type === 'discard' && state.ruleset.specialTilesNoDiscard !== false
      && state.phase === 'discard' && state.turn === action.seat) {
    const gt = specialGangFor(state, action.tile);
    if (gt) action = { ...action, type: gt };
  }

  // 「杠后不摸牌」只对红中杠 / 皮子杠 / 癞子杠成立（老吴 2026-10-24）：
  // 特殊杠只走 1 张牌，等价于打出一张 → 不补摸、直接过手（下轮摸牌自然补齐，不欠张）；
  // 暗杠 / 蓄杠 / 明杠（zhi）占面子，**必须补摸** —— 客户端误带 noDraw 一律剥掉。
  if (action && action.noDraw && (action.type === 'an' || action.type === 'xu' || action.type === 'zhi')) {
    action = { ...action, noDraw: false };
  }

  let result;
  switch (action.type) {
    case 'discard':
      result = doDiscard(state, action);
      break;
    case 'win':
      result = doWin(state, action);
      break;
    case 'an':
      result = doAnGang(state, action);
      break;
    case 'xu':
      result = doXuGang(state, action);
      break;
    case 'wildgang':
      result = doSpecialGang(state, action, 'wild');
      break;
    case 'redgang':
      result = doSpecialGang(state, action, 'red');
      break;
    case 'skingang':
      result = doSpecialGang(state, action, 'skin');
      break;
    case 'peng':
      result = doPeng(state, action);
      break;
    case 'zhi':
      result = doZhiGang(state, action);
      break;
    case 'chi':
      result = doChi(state, action);
      break;
    case 'pass':
      result = doPass(state, action);
      break;
    default:
      throw new Error(`未知动作: ${action.type}`);
  }

  // 每次动作后刷新「七皮 / 十杠」成就（达到即锁定，不会因后续弃牌而丢失）
  refreshAchievements(state);
  return result;
}

/** 胡牌摊牌确认：每家点一次；最后一家确认后解除 pending（结算页才会弹出） */
function confirmReveal(state, action) {
  const seat = action.seat;
  const rv = state.reveal;
  if (!rv || !rv.pending) throw new Error('本局结算已确认');
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.players.length) {
    throw new Error('座位无效');
  }
  if (!rv.confirmed.includes(seat)) rv.confirmed.push(seat);
  if (rv.confirmed.length >= state.players.length) rv.pending = false;
  log(state, `${state.players[seat].name} 确认摊牌（${rv.confirmed.length}/${state.players.length}）`);
  return state;
}

/* ------------------------------------------------------------------ */
/* 七皮 / 十杠 成就                                                     */
/* ------------------------------------------------------------------ */

const GANG_TYPES = ['zhi', 'xu', 'an', 'red', 'skin', 'wild'];

/** 某玩家手里 + 副露里当前持有的皮子张数（红中杠/皮子杠各算 1 张） */
export function countPlayerSkins(player, skinTiles) {
  const set = new Set(skinTiles);
  let n = 0;
  for (const t of player.hand) if (set.has(t)) n++;
  for (const m of player.melds) for (const t of m.tiles) if (set.has(t)) n++;
  return n;
}

/**
 * 某玩家**本局累计经手过**的皮子张数 —— 「七皮」用这个口径。
 *
 * 🔴 老吴 2026-10-03 22:45 定口径：「七皮是需要七张皮**全部刚出来**才算」，
 *   即**累计**，不是手上同时持有。
 *
 * ⚠️ 为什么不能直接用 `p.skinSeen`（那是「基本两口」包胡判定用的）：
 *   `skinSeen` **只在 `drawTile` 里 +1**（摸牌），
 *   而 `doSpecialGang`（皮子杠/红中杠/癞子杠）是 `p.hand.splice()` 把牌**直接**塞进 melds，
 *   **完全不经过 drawTile** ⇒ 皮子杠一次就是 4 张皮子进副露、却一张都不计数。
 *   实测 3000 局：皮子杠发生 9842 次，`skinSeen` 最大值只有 8，
 *   改用累计口径后七皮达成率 0.25% → 10.92%（这才对得上「实战中经常发生」）。
 *
 * 口径 = `skinSeen`（摸到的）+ 副露里的皮子（杠出去的、吃碰进来的）。
 *   两者不重叠：`skinSeen` 只在 drawTile 加，杠/吃碰走的牌不经 drawTile。
 *   手上剩余**不重复计** —— 那些牌已经算在 `skinSeen` 里了。
 */
export function countSkinsSeen(player, skinTiles) {
  return countPlayerSkins(player, skinTiles) + (player.skinSeen || 0);
}

/**
 * 「十杠」用的**加权杠口数** —— 各类杠的权重不同（老吴 2026-10-03 23:38 定口径，
 * 2026-10-08 二次确认「暗杠/癞子杠 2 口是对的，不是错误实现」）。
 *
 * 口数权重：
 *   · 杠 `zhi` / 蓄杠 `xu` / 红中杠 `red` / 皮子杠 `skin` —— 各 **1 口**
 *   · 暗杠 `an` / 癞子杠 `wild` —— 各 **2 口**
 *
 * ⚠️ 权重全部走 `ruleset.shiGangWeights`（口径进开关，**不改引擎**）。
 *   权重缺失（`ruleset` 或某个键缺失）时回落 1 口。
 * ⚠️ 与 `gangFan`（杠的**番底**，同样是 an/wild 各 2）是**两套独立口径**，别互相推断。
 *
 * @param {object[]} melds
 * @param {object} ruleset
 * @returns {number} 加权口数
 */
export function countGangUnits(melds, ruleset) {
  const w = ruleset?.shiGangWeights ?? {};
  let n = 0;
  for (const m of melds) {
    if (!GANG_TYPES.includes(m.type)) continue;
    n += w[m.type] ?? 1;
  }
  return n;
}

/**
 * 「七皮」用的口径：**杠出来的红中 + 皮子**张数（老吴 2026-10-08 定口径）。
 *
 * 原话：「七皮是指**杠出来的牌**里面，红中和皮加起来有 7 个」
 * —— 只数**进副露的**皮子，**不算手上留着的、不算摸到的**。
 *
 * ⚠️ 与 `countSkinsSeen()`（累计经手，含摸牌）是**两套不同口径**：
 *   · `countSkinsSeen` —— 摸到 + 杠走的，用于「基本两口」包胡判定的历史遗留值
 *   · `countSkinsGanged` —— **只数杠走的**，七皮用它
 *
 * 每种杠实际带走的皮子张数（实测 2000 局）：
 *   · 皮子杠 `skin` 1 张 · 红中杠 `red` 1 张 · 癞子杠 `wild` 1 张（癞子不在皮子集 ⇒ 计 0）
 *   · 冲杠 `zhi` 4 张 · 暗杠 `an` 4 张 —— 但皮子/癞子**不能暗杠**（`specialTilesNoAnGang`），
 *     且皮子**不能被碰/明杠**（`canClaimSpecialTiles:false`）⇒ 实测贡献 0
 *   · 蓄杠 `xu` 补 1 张凑 4 张 —— 皮子不能被碰 ⇒ 实测贡献 0
 * 所以实际只有**皮子杠 + 红中杠**两条路，一家要连杠 7 次。
 *
 * @param {object[]} melds
 * @param {number[]} skinTiles 本局皮子集合（注意**不含癞子**）
 * @returns {number} 副露里属于皮子集合（含红中）的张数
 */
export function countSkinsGanged(melds, skinTiles) {
  const set = new Set(skinTiles);
  let n = 0;
  for (const m of melds) {
    for (const t of m.tiles) if (set.has(t)) n++;
  }
  return n;
}

/**
 * 刷新每个玩家的 七皮 / 十杠 成就标记（sticky）。
 * 七皮：杠出来的红中+皮子累计达到 ruleset.qiPiCount（默认 7）
 * 十杠：加权杠口数达到 ruleset.shiGangCount（默认 10）
 */
export function refreshAchievements(state) {
  const rs = state.ruleset;
  for (const p of state.players) {
    const wasQiPi = p.qiPi;
    const wasShiGang = p.shiGang;
    const skins = countSkinsGanged(p.melds, state.skinTiles);
    p.qiPi = rs.qiPiEnabled && (p.qiPi || skins >= rs.qiPiCount);
    const gangs = countGangUnits(p.melds, rs);
    p.shiGang = rs.shiGangEnabled && (p.shiGang || gangs >= rs.shiGangCount);
    if (!wasQiPi && p.qiPi) pushAchievementEvent(state, p, 'qiPi');
    if (!wasShiGang && p.shiGang) pushAchievementEvent(state, p, 'shiGang');
  }
}

/** 刚达成的成就 → 一条可广播的播报事件（含每家该收/该付多少）。 */
function pushAchievementEvent(state, p, kind) {
  // 用与终局完全相同的奖金算法算金额，避免「播报 10 分、结算 20 分」。
  // 必须传齐四家：奖金算法按「其余三家」生成 payers，只传本人会算成 0 家。
  // 只把当前这一项标记为 true，防止同一动作同时达成七皮+十杠时两条事件互相包含。
  const probe = state.players.map((x) => ({
    seat: x.seat,
    name: x.name,
    qiPi: kind === 'qiPi' && x.seat === p.seat,
    shiGang: kind === 'shiGang' && x.seat === p.seat,
  }));
  const bonus = computeSpecialBonuses(probe, state.ruleset, laiMulOf(state))
    .find((b) => b.seat === p.seat && b.kind === kind);
  if (!bonus) return;
  state.achievementSeq++;
  state.achievementEvents.push({
    seq: state.achievementSeq,
    seat: p.seat,
    name: p.name,
    kind,
    label: bonus.label,
    perPayer: bonus.perPayer,
    amount: bonus.amount,
    mul: bonus.mul,
    payers: bonus.payers.map((x) => ({ seat: x.seat, name: x.name, pay: x.pay })),
  });
}

/**
 * 计算「七皮 / 十杠」成就奖金 —— 与胜负结算互相独立的附加账本。
 *
 * 依赖 refreshAchievements 已经写好的 sticky 标记（p.qiPi / p.shiGang），
 * 不再重新数牌，保证：
 *   1. 荒庄（settleDraw）与胡牌（finishWin）两条终局路径口径一致；
 *   2. 映射后的精简玩家对象（finishWin 里只带 seat/name/melds/qiPi/shiGang）
 *      也能直接喂进来。
 *
 * 每项成就：达成者从其余三家各收一笔 goldCap（金鼎口径，见 ruleset.goldCap）。
 * 七皮与十杠同时达成 → 两笔独立奖金（分别计算，互不影响）。
 *
 * @param {object[]} players 至少含 { seat, name, qiPi, shiGang }
 * @param {object} ruleset
 * @param {number} [mul=1] 赖子倍率。**只有本局是风赖、或是原赖时才传 2，其余一律 1。**
 *   老吴 2026-10-03 口径：「七皮、十杠如果发生在风赖、原赖，也乘以二」——
 *   判据只看**本局是风赖还是原赖**（不是「这局有没有人胡牌」，成就奖是独立账本，
 *   荒庄局一样算）。唯一合法的 `mul` 来源是 `laiMulOf(state)`；
 *   本函数内部按**白名单**校验：只有恰好 2 才翻，其余（0 / 3 / NaN / 字符串…）一律回落 1。
 * @returns {object[]} 每笔奖金：{ seat, name, kind, label, perPayer, amount, payers, mul }
 */
export function computeSpecialBonuses(players, ruleset, mul = 1) {
  const rs = ruleset;
  // ⚠️ 口径（老吴 2026-10-03 22:17 收紧）：**只有本局是风赖、或是原赖时才 ×2，其余一律 1。**
  //   传进来的 mul 只能来自 `laiMulOf(state)`（唯一判据就是本局是不是风赖/原赖）。
  //
  //   守卫必须写成「**恰好 2 才翻**」而不是「大于 1 就翻」：
  //   后者会把 3 / 99 这类手滑传进来的值也当成合法倍率，静默算成 30/家、990/家
  //   （实测踩过：写 `mul > 1` 时 mul=3 真的算出 perPayer=30，是测试先抓出来的）。
  //   口径只有「1」和「2」两档 ⇒ 白名单式校验，任何第三种值都回落成 1。
  const safeMul = mul === 2 ? 2 : 1;
  // 金鼎 = 金顶（新分段计分下的 goldScore）；本局是风赖/原赖时每家 ×2（20 分）
  const perPayer = rs.goldScore * safeMul;
  const bonuses = [];
  for (const p of players) {
    const others = players.filter((x) => x.seat !== p.seat);
    if (rs.qiPiEnabled && p.qiPi) {
      bonuses.push(makeBonus(p, 'qiPi', '七皮', others, perPayer, safeMul));
    }
    if (rs.shiGangEnabled && p.shiGang) {
      bonuses.push(makeBonus(p, 'shiGang', '十杠', others, perPayer, safeMul));
    }
  }
  return bonuses;
}

function makeBonus(p, kind, label, others, perPayer, mul = 1) {
  return {
    seat: p.seat,
    name: p.name,
    kind,
    label,
    perPayer,
    mul,
    amount: others.length * perPayer,
    payers: others.map((x) => ({ seat: x.seat, name: x.name, pay: perPayer })),
  };
}

/**
 * 本局的「赖子倍率」：**本局是风赖或原赖时 = 2，否则 = 1**。
 *
 * ⚠️ **别用「赖子局」这个说法**（老吴 2026-10-03 纠正）：每局都翻底牌决定癞子、
 * 每局都有癞子，所以「赖子局」字面上等于「每局都成立」，是句废话。
 * 精确说法只有两个：**「本局是风赖」**（癞子是风牌）或**「本局是原赖」**（癞子与上局相同）。
 *
 * 判据只看**本局性质**、与谁胡牌无关 ⇒ 胡牌局与荒庄局都能用，
 * 且**七皮 / 十杠**这类成就奖也要跟着翻倍。
 * 两者同时命中仍只 ×2 一次（沿用「不重复」口径，与 `countFan` 里的 mul 一致）。
 */
export function laiMulOf(state) {
  const rs = state.ruleset;
  if (state.yuanLai && state.fengLai) return Math.max(rs.yuanLaiMul ?? 1, rs.fengLaiMul ?? 1);
  if (state.yuanLai) return rs.yuanLaiMul ?? 1;
  if (state.fengLai) return rs.fengLaiMul ?? 1;
  return 1;
}

/**
 * 某个座位因**七皮 / 十杠成就奖**产生的净收支（正 = 收钱，负 = 付钱）。
 *
 * 口径：每项成就由达成者（`bonus.seat`）从**其余三家各收一笔** `perPayer`；
 *   两项成就（七皮 / 十杠）各自独立 ⇒ 同一个座位可能又收又付，要**都进账**。
 *
 * 🔴 为什么必须并进 `perSeat[].delta`（老吴 2026-10-03 22:22 查出来的 bug）：
 *   修之前 `perSeat[].delta` 只按 `payments`（胡牌输赢）算，`bonuses` 完全没进账 ⇒
 *   「某家既达成七皮/十杠、又胡牌」时 `bonusTotal=60` 但**四家 delta 求和仍是 0**（账没平），
 *   累计战绩分 / 战绩面板 / 后端落库全都少算这笔。
 *   胡牌局与荒庄局**共用**这一个函数，避免两条终局路径口径漂移。
 */
export function bonusDeltaOf(bonuses, seat) {
  let received = 0;
  let paid = 0;
  for (const b of bonuses) {
    if (b.seat === seat) received += b.amount;
    const payer = b.payers.find((x) => x.seat === seat);
    if (payer) paid += payer.pay;
  }
  return received - paid;
}

/* ------------------------------ 打牌 ------------------------------ */

function doDiscard(state, { seat, tile }) {
  const p = state.players[seat];
  const idx = p.hand.indexOf(tile);
  if (idx === -1) throw new Error(`${p.name} 手里没有 ${tileName(tile)}`);

  // 下雨惩罚（老吴 2026-10-25 修订③）：必须在 splice 之前判「手中有该花色却未出」
  checkRainPenalty(state, seat, tile);

  p.hand.splice(idx, 1);
  p.discards.push(tile);
  state.discardLog.push({ seat, tile });
  state.lastDiscard = { tile, from: seat };
  state.lastDraw = null;
  state.gangFlag = false;
  state.lastDrawIsLast = false;
  // 打出去一张 → 「吃/碰后必须打牌」的锁解开
  state.mustDiscard = false;
  log(state, `${p.name} 打出 ${tileName(tile)}`);

  beginClaims(state, tile, seat);
  return state;
}

/* --------------------------- 他人响应 ----------------------------- */

function beginClaims(state, tile, fromSeat) {
  const options = [];
  const special = isSpecial(state, tile);

  for (let i = 1; i < SEATS; i++) {
    const s = (fromSeat + i) % SEATS;
    const p = state.players[s];

    // 胡（点炮）
    const ctx = buildContext(state, s, { selfDraw: false, from: fromSeat });
    if (canWinWith(state, s, toCounts([...p.hand, tile]), ctx).legal) {
      options.push({ seat: s, type: 'win', priority: 3, tile, ctx });
    }

    // 红中/皮子/癞子默认不能被碰杠
    if (special && !state.ruleset.canClaimSpecialTiles) continue;

    const cnt = p.hand.filter((t) => t === tile).length;
    if (cnt >= 2) options.push({ seat: s, type: 'peng', priority: 2, tile });
    if (cnt >= 3) options.push({ seat: s, type: 'zhi', priority: 2, tile });

    // 吃（仅上家，且不能含特殊牌）
    if (state.ruleset.chiAllowed && !special) {
      const prev = (fromSeat + 1) % SEATS;
      const ok = state.ruleset.chiOnlyFromPrev ? s === prev : true;
      if (ok) {
        // 赖子 / 皮子 / 红中 不能当吃牌材料（武汉口径，永远禁止）
        const ex = new Set();
        if (state.wildTile !== null && state.wildTile !== undefined) ex.add(state.wildTile);
        for (const sk of state.skinTiles) ex.add(sk);
        if (state.wildTile !== RED_DRAGON) ex.add(RED_DRAGON);
        const combos = chiCombos(p.hand, tile, [...ex]);
        if (combos.length) options.push({ seat: s, type: 'chi', priority: 1, tile, combos });
      }
    }
  }

  if (options.length === 0) {
    nextDraw(state, (fromSeat + 1) % SEATS);
    return;
  }

  enterClaimPhase(state, options, fromSeat);
}

/**
 * 把散装选项聚合成「按座位分组 + 排序」的响应队列，并切进 claim 阶段。
 *
 * 排序规则：先看优先级（胡 3 > 碰/杠 2 > 吃 1），同级**按座位从出牌者下家起算的距离**。
 * 抢杠胡复用同一套排序（`fromSeat` 传被抢的那家），于是「一炮单响按下家优先」在
 * 抢杠场景下也成立。
 */
function enterClaimPhase(state, options, fromSeat) {
  // 按座位聚合（同一人可能既能胡又能碰，只问一次）
  const bySeat = new Map();
  for (const opt of options) {
    if (!bySeat.has(opt.seat)) bySeat.set(opt.seat, { seat: opt.seat, priority: 0, options: [] });
    const g = bySeat.get(opt.seat);
    g.options.push(opt);
    if (opt.priority > g.priority) g.priority = opt.priority;
  }

  const grouped = [...bySeat.values()].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return ((a.seat - fromSeat + SEATS) % SEATS) - ((b.seat - fromSeat + SEATS) % SEATS);
  });

  state.claims = grouped;
  state.claimIndex = 0;
  state.phase = 'claim';
  state.turn = grouped[0].seat;
}

function doPass(state, { seat }) {
  /* ---- 出牌阶段的自摸「过」：本轮不胡，继续正常出牌（不推进回合） ---- */
  if (state.phase === 'discard') {
    if (state.turn !== seat) throw new Error('还没轮到你');
    const ctx = buildContext(state, seat, { selfDraw: true });
    if (!canWinWith(state, seat, toCounts(state.players[seat].hand), ctx).legal) {
      throw new Error('当前没有可胡的牌，不需要「过」');
    }
    // 刚吃/碰过 → 压根没有「胡」这个选项，自然也没有「过」
    if (state.mustDiscard) throw new Error('刚吃/碰过，必须先打出一张牌');
    if (state.ruleset.canPassWin === false) throw new Error('本房间口径不允许过胡');
    state.winDeclined = true; // legalActions 里的 `win` / `pass` 随即消失，只剩出牌
    log(state, `${state.players[seat].name} 过（不胡）`);
    return state;
  }

  if (state.phase !== 'claim') throw new Error('当前不是响应阶段');
  const cur = state.claims[state.claimIndex];
  if (!cur || cur.seat !== seat) throw new Error('还没轮到你响应');
  if (state.ruleset.canPassWin === false && cur.options.some((o) => o.type === 'win')) {
    throw new Error('本房间口径不允许过胡（有胡必须胡）');
  }

  state.claimIndex++;
  if (state.claimIndex >= state.claims.length) {
    state.claims = [];
    state.claimIndex = 0;
    // 抢杠：能抢的三家全「过」→ 补杠者继续把杠补完（不换手、不摸新牌）
    const qg = state.pendingXuGang;
    if (qg) {
      state.pendingXuGang = null;
      log(state, `无人抢杠，${state.players[qg.seat].name} 继续蓄杠`);
      completeXuGang(state, qg.seat, qg.tile, !!qg.noDraw);
    } else {
      nextDraw(state, (state.lastDiscard.from + 1) % SEATS);
    }
  } else {
    state.turn = state.claims[state.claimIndex].seat;
  }
  return state;
}

/* ------------------------------ 吃 ------------------------------- */

/**
 * 计算能吃出哪些「搭子」组合（返回每组的另外两张牌）。
 *
 * ⚠️ **赖子 / 皮子 / 红中 不能当作吃牌材料**（武汉红中赖子杠口径）：
 *    它们只能用于「杠」或「胡牌时的万能替牌」，绝不能作为吃 / 碰凑顺子、刻子的那张牌。
 *    所以 `exclude` 里列出的特殊牌码会从手牌计数中剔除，永远不会被算进顺子。
 *
 * @param {number[]} hand 吃牌者的手牌
 * @param {number} tile 别人打出的、要吃的牌
 * @param {number[]} [exclude=[]] 本局特殊牌码（赖子 / 皮子 / 红中），不可当作吃牌材料
 */
export function chiCombos(hand, tile, exclude = []) {
  if (!isNumberTile(tile)) return [];
  const counts = toCounts(hand);
  // 把特殊牌从计数里抹掉：它们不能被当成顺子的一张
  const ex = new Set(exclude.filter((t) => t !== null && t !== undefined));
  for (const t of ex) counts[t] = 0;
  const suit = tileSuit(tile);
  const rank = tileRank(tile);
  const combos = [];
  for (const [a, b] of [[-2, -1], [-1, 1], [1, 2]]) {
    const ra = rank + a;
    const rb = rank + b;
    if (ra < 1 || ra > 9 || rb < 1 || rb > 9) continue;
    const ta = makeTile(suit, ra);
    const tb = makeTile(suit, rb);
    if (counts[ta] > 0 && counts[tb] > 0) combos.push([ta, tb]);
  }
  return combos;
}

function doChi(state, { seat, tiles }) {
  const p = state.players[seat];
  const tile = state.lastDiscard.tile;
  const from = state.lastDiscard.from;

  // 武汉口径：赖子 / 皮子 / 红中 不能当作吃牌材料（也挡住网络对战里伪造的意图）
  for (const t of tiles) {
    if (isSpecial(state, t)) throw new Error('赖子 / 皮子 / 红中 不能用于吃牌');
  }

  for (const t of tiles) {
    const idx = p.hand.indexOf(t);
    if (idx === -1) throw new Error(`手上没有 ${tileName(t)}，无法吃`);
    p.hand.splice(idx, 1);
  }

  consumeDiscard(state, from);
  p.melds.push({ type: 'chi', tiles: [...tiles, tile].sort((a, b) => a - b), from });
  refreshOpened(state, seat);
  checkRainDeclare(state, seat, from);
  log(state, `${p.name} 吃 ${tiles.map(tileName).join('')} 配 ${tileName(tile)}`);

  // 吃完手里是 14 张 → 必须打出去一张，**不许胡**（老吴 2026-09-30）
  toDiscardPhase(state, seat, true);
  return state;
}

/* ------------------------------ 碰 ------------------------------- */

function doPeng(state, { seat }) {
  const p = state.players[seat];
  const tile = state.lastDiscard.tile;
  const from = state.lastDiscard.from;

  // 武汉口径：赖子 / 皮子 / 红中 不能当碰牌材料（被碰的牌本身也不能是特殊牌）
  if (isSpecial(state, tile)) throw new Error('赖子 / 皮子 / 红中 不能用于碰牌');

  for (let k = 0; k < 2; k++) {
    const idx = p.hand.indexOf(tile);
    if (idx === -1) throw new Error(`手上不够两张 ${tileName(tile)}`);
    p.hand.splice(idx, 1);
  }

  consumeDiscard(state, from);
  p.melds.push({ type: 'peng', tiles: [tile, tile, tile], from });
  refreshOpened(state, seat);
  checkRainDeclare(state, seat, from);
  log(state, `${p.name} 碰 ${tileName(tile)}`);

  // 碰完同样必须打出去一张，**不许胡**（老吴 2026-09-30）
  toDiscardPhase(state, seat, true);
  return state;
}

/* ------------------------------ 杠 ------------------------------- */

/** 杠：手里暗刻 3 张 + 别人打出第 4 张。不能被抢杠 */
function doZhiGang(state, { seat, noDraw }) {
  const p = state.players[seat];
  const tile = state.lastDiscard.tile;
  const from = state.lastDiscard.from;

  for (let k = 0; k < 3; k++) {
    const idx = p.hand.indexOf(tile);
    if (idx === -1) throw new Error(`手上不够三张 ${tileName(tile)}`);
    p.hand.splice(idx, 1);
  }

  consumeDiscard(state, from);
  p.melds.push({ type: 'zhi', tiles: [tile, tile, tile, tile], from });
  refreshOpened(state, seat);
  checkRainDeclare(state, seat, from);
  log(state, `${p.name} 杠 ${tileName(tile)}`);

  afterGangDraw(state, seat, true, !!noDraw);
  return state;
}

/**
 * 蓄杠：碰过之后又摸到第 4 张。可被抢杠。
 *
 * ⚠️ **老吴 2026-10-02 改口**：原先「抢杠胡当场判定并结算、不进响应阶段」，
 *    导致能抢杠的玩家**直接看到结算弹窗**，既没机会点「胡」，也没有「过」。
 *    现在改成：**先把响应机会给出去**，有人点「胡」才结算，全「过」才真正补杠。
 *    —— 于是抢杠胡与「可胡可过」口径统一，`legalActions` 那套「有胡必给过」的
 *    不变量对自摸 / 点炮 / 抢杠三种情况全部成立，不再有特例。
 */
function doXuGang(state, { seat, tile, noDraw }) {
  const p = state.players[seat];

  // 前置校验提到最前：进响应阶段前就要确认这个杠本来就合法，
  // 否则会出现「问了一圈抢杠、最后补杠失败」的畸形状态
  if (p.hand.indexOf(tile) === -1) throw new Error(`手上没有 ${tileName(tile)}，无法蓄杠`);
  if (!p.melds.some((m) => m.type === 'peng' && m.tiles[0] === tile)) {
    throw new Error('没有可补杠的碰');
  }

  // 谁能抢杠胡？按「从补杠者下家起算」的顺序问，与一炮单响同口径
  if (state.ruleset.robbingXuGang) {
    const robs = [];
    for (let i = 1; i < SEATS; i++) {
      const s = (seat + i) % SEATS;
      const sp = state.players[s];
      // 抢杠胡的「进张」= 被加杠的那张牌（见字胡判定要用）
      const ctx = buildContext(state, s, { selfDraw: false, from: seat, qiangGangHu: true, winTile: tile });
      const res = canWinWith(state, s, toCounts([...sp.hand, tile]), ctx);
      if (res.legal) robs.push({ seat: s, type: 'win', priority: 3, tile, ctx });
    }
    if (robs.length > 0) {
      log(state, `${p.name} 蓄杠 ${tileName(tile)} —— 等抢杠`);
      // 进 claim 阶段前清掉上一手的残留：抢杠阶段没有「刚打出的牌」，也没有「刚摸的牌」，
      // 否则 viewFor 会把补杠者刚摸的那张当成抢杠者的 lastDraw 下发（既脏又泄牌）。
      state.lastDiscard = null;
      state.lastDraw = null;
      state.gangFlag = false;
      state.pendingXuGang = { seat, tile, noDraw: !!noDraw };
      enterClaimPhase(state, robs, seat);
      return state;
    }
  }

  return completeXuGang(state, seat, tile, !!noDraw);
}

/** 真正补杠（无人抢杠 / 抢杠者全「过」之后走这里） */
function completeXuGang(state, seat, tile, noDraw = false) {
  const p = state.players[seat];

  const idx = p.hand.indexOf(tile);
  if (idx === -1) throw new Error(`手上没有 ${tileName(tile)}，无法蓄杠`);
  p.hand.splice(idx, 1);

  const meld = p.melds.find((m) => m.type === 'peng' && m.tiles[0] === tile);
  if (!meld) throw new Error('没有可补杠的碰');
  meld.type = 'xu';
  meld.tiles = [tile, tile, tile, tile];
  refreshOpened(state, seat);
  log(state, `${p.name} 蓄杠 ${tileName(tile)}`);

  state.pendingXuGang = null;
  afterGangDraw(state, seat, true, noDraw);
  return state;
}

/** 暗杠 */
function doAnGang(state, { seat, tile, noDraw }) {
  const p = state.players[seat];
  // 🔴 皮子 / 癞子不能暗杠（老吴 2026-10-03 23:20）—— 特殊杠只走 `doSpecialGang`。
  //   `legalActions` 已经过滤过，这里再挡一道：网络版客户端可以直接 POST 动作，
  //   不能只靠 UI 藏按钮。
  //   ⚠️ 癞子是**独立字段** `state.wildTile`，不在 `skinTiles` 里，两个都要查。
  //   `skinTiles` 含红中（默认开），所以「4 张红中暗杠」也一并排除。
  if (state.ruleset.specialTilesNoAnGang !== false
    && (tile === RED_DRAGON || tile === state.wildTile || state.skinTiles.includes(tile))) {
    throw new Error(`${tileName(tile)} 是特殊杠牌（红中/皮子/癞子），不能暗杠（只能走对应特殊杠）`);
  }
  for (let k = 0; k < 4; k++) {
    const idx = p.hand.indexOf(tile);
    if (idx === -1) throw new Error(`暗杠需要四张 ${tileName(tile)}`);
    p.hand.splice(idx, 1);
  }
  p.melds.push({ type: 'an', tiles: [tile, tile, tile, tile], from: null });
  refreshOpened(state, seat);
  log(state, `${p.name} 暗杠 ${tileName(tile)}`);

  afterGangDraw(state, seat, true, !!noDraw);
  return state;
}

/** 红中杠 / 皮子杠 / 癞子杠：只占 1 张牌，不折算面子，不算开口 */
function doSpecialGang(state, { seat, tile, noDraw }, kind) {
  const p = state.players[seat];
  // 🔴 牌值必须和杠种匹配：红中杠只能杠红中、癞子杠只能杠癞子、皮子杠只能杠皮子。
  //   否则旧客户端/错误 action 只要碰巧带对 type，就能把手里另一张牌当特殊杠杠掉
  //   （老吴 2026-10-22 实测：点红中杠却把北风杠了出去）。
  if (kind === 'red' && tile !== RED_DRAGON) {
    throw new Error(`红中杠只能杠红中，不能杠 ${tileName(tile)}`);
  }
  if (kind === 'wild' && (state.wildTile === null || tile !== state.wildTile)) {
    throw new Error(`癞子杠只能杠癞子 ${tileName(state.wildTile)}`);
  }
  if (kind === 'skin'
    && (tile === RED_DRAGON || tile === state.wildTile || !state.skinTiles.includes(tile))) {
    throw new Error(`${tileName(tile)} 不是本局皮子`);
  }
  const idx = p.hand.indexOf(tile);
  if (idx === -1) throw new Error(`手里没有 ${tileName(tile)}`);
  if (kind === 'skin' && !state.ruleset.skinGangEnabled) {
    throw new Error('本房间不允许皮子杠');
  }

  p.hand.splice(idx, 1);
  p.melds.push({ type: kind, tiles: [tile], from: null });
  refreshOpened(state, seat);

  const label = kind === 'red' ? '红中杠' : kind === 'skin' ? '皮子杠' : '癞子杠';
  log(state, `${p.name} ${label} ${tileName(tile)}`);

  // 特殊杠（红中/皮子/癞子杠）补摸成形也算杠上开花（2026-10-22 老吴明确）
  afterGangDraw(state, seat, !!state.ruleset.specialGangCountsAsGangShangKaiHua, !!noDraw);
  return state;
}

/**
 * 杠后补摸一张并标记「杠上开花」语境。
 *
 * 六种杠（冲 zhi / 蓄 xu / 暗 an / 红中 red / 皮子 skin / 癞子 wild）
 * 补摸成形都算杠上开花；特殊杠的开关见 `ruleset.specialGangCountsAsGangShangKaiHua`
 * （2026-10-22 老吴明确：不管什么杠，只要杠到的牌满足胡牌条件就算）。
 */
function afterGangDraw(state, seat, gangShangKaiHua = true, noDraw = false) {
  state.claims = [];
  state.claimIndex = 0;
  state.lastDiscard = null;
  state.lastDraw = null;

  // 杠后不补牌（老吴 2026-10-21，2026-10-24 收窄口径）：只加番，不摸底牌、也不打牌。
  // ⚠️ 只有红中杠 / 皮子杠 / 癞子杠可以 noDraw（act 里已把其他杠的 noDraw 剥掉）：
  //    特殊杠只走 1 张牌 = 等价于打出一张 → 直接过手让下家摸，
  //    自己下轮摸牌补回 1 张即对齐 —— 等同于「打过一张牌」的正常节奏，不存在欠张。
  if (noDraw) {
    log(state, `${state.players[seat].name} 杠后不补牌，过手`);
    nextDraw(state, (seat + 1) % SEATS);
    return;
  }

  if (!drawTile(state, seat)) return;
  state.gangFlag = !!gangShangKaiHua;
  state.turn = seat;
  state.phase = 'discard';
  state.players[seat].hand.sort((a, b) => a - b);
}

/* ------------------------------ 胡 ------------------------------- */

function doWin(state, { seat }) {
  const p = state.players[seat];

  if (state.phase === 'claim') {
    const pending = state.claims[state.claimIndex];
    const canHu = pending && pending.seat === seat && pending.options.some((o) => o.type === 'win');
    if (!canHu) throw new Error('当前没有可胡的牌');

    // 抢杠胡 vs 点炮：两者都在 claim 阶段，但「进张」和「承包者」不同 ——
    //   点炮：进张 = 上家刚打出的那张，放炮者按包牌规则可能承包
    //   抢杠：进张 = 被加杠的那张，补杠者**必然**承包（独付）
    const qg = state.pendingXuGang;
    const tile = qg ? qg.tile : state.lastDiscard.tile;
    const ctx = qg
      ? buildContext(state, seat, { selfDraw: false, from: qg.seat, qiangGangHu: true, winTile: tile })
      : buildContext(state, seat, { selfDraw: false, from: state.lastDiscard.from });
    const res = canWinWith(state, seat, toCounts([...p.hand, tile]), ctx);
    if (!res.legal) throw new Error(res.reason ?? '不满足胡牌条件');

    if (qg) {
      log(state, `${p.name} 抢杠胡 ${tileName(tile)} —— ${state.players[qg.seat].name} 承包`);
    } else {
      log(state, `${p.name} 胡 ${tileName(tile)}（${state.players[ctx.from].name} 点炮）`);
    }
    return finishWin(state, seat, res, ctx, qg ? qg.seat : null);
  }

  if (state.phase !== 'discard') throw new Error('当前不能胡');
  if (state.turn !== seat) throw new Error('还没轮到你');
  if (state.mustDiscard) throw new Error('刚吃/碰过，必须先打出一张牌');
  if (state.winDeclined) throw new Error('本轮已经过，不能再胡');

  const ctx = buildContext(state, seat, { selfDraw: true });
  const res = canWinWith(state, seat, toCounts(p.hand), ctx);
  if (!res.legal) throw new Error(res.reason ?? '不满足胡牌条件');

  log(state, `${p.name} 自摸 ${tileName(state.lastDraw)}`);
  return finishWin(state, seat, res, ctx, null);
}

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */

function drawTile(state, seat) {
  if (state.wall.length <= 0) {
    settleDraw(state);
    return false;
  }
  const tile = state.wall.shift();
  const p = state.players[seat];
  p.hand.push(tile);
  p.hand.sort((a, b) => a - b);
  p.drawCount++;
  state.lastDraw = tile;
  state.lastDrawIsLast = state.wall.length === 0;
  state.wallDrawn++;
  // 新摸一张 = 上一次「过掉自摸」的决定作废，「胡」按钮重新出现；
  // 同时也解掉「吃/碰后必须打牌」的锁（杠后补摸同样走这里 → 杠上开花不受影响）
  state.winDeclined = false;
  state.mustDiscard = false;
  // 「基本两口」用：本局累计拿到几张皮（杠出去/打出去都不减）
  if (state.skinTiles.includes(tile)) p.skinSeen++;
  return true;
}

function nextDraw(state, seat) {
  state.claims = [];
  state.claimIndex = 0;
  state.lastDiscard = null;
  // 正常摸牌绝不可能是「杠上开花」→ 明确清掉，堵住「上一手的杠标记被下一家继承」的隐患
  state.gangFlag = false;
  if (!drawTile(state, seat)) return;
  state.turn = seat;
  state.phase = 'discard';
  state.players[seat].turnCount++;
}

/**
 * 进入出牌阶段。
 * @param {boolean} [mustDiscard] 刚吃/碰过 → 必须打出一张，**不给「胡」**
 */
function toDiscardPhase(state, seat, mustDiscard = false) {
  state.claims = [];
  state.claimIndex = 0;
  state.lastDiscard = null;
  state.lastDraw = null;
  state.gangFlag = false;
  state.mustDiscard = !!mustDiscard;
  state.turn = seat;
  state.phase = 'discard';
}

function consumeDiscard(state, from) {
  state.players[from].discards.pop();
  // 全局流水同步回收：被碰/吃/杠/胡拿走的那张要离开牌河，
  // 否则「依次牌河」里会留下已经被吃掉的牌（实测多出 9 张）。
  const last = state.discardLog[state.discardLog.length - 1];
  if (last && last.seat === from) state.discardLog.pop();
}

function refreshOpened(state, seat) {
  const p = state.players[seat];
  p.opened = computeOpened(p.melds, state.ruleset);
}

/** 花色首码（数字牌）：万 0 / 筒 9 / 条 18；字牌返回 -1（不参与下雨） */
function suitBaseOf(t) {
  if (!isNumberTile(t)) return -1;
  return t < 9 ? 0 : t < 18 ? 9 : 18;
}

/**
 * 下雨宣告（老吴 2026-10-25 定，同日二次修订②）：A 吃/碰/明杠之后，若 A 的该花色
 * **明牌副露**（chi/peng/zhi/xu，暗杠不计）恰好达到**第 3 句** → 本次供牌者包胡。
 * 第 4 个明牌不包；但前三句里若有暗杠，第 4 句实际是第 3 个明牌 → 照包
 * （老吴：「第四句不包胡，除非前三句话里面有一个暗杠」——用明牌计数天然实现）。
 */
function checkRainDeclare(state, seat, from) {
  const rs = state.ruleset;
  if (rs.rainEnabled === false) return;
  if (from === null || from === undefined || from === seat) return;
  const melds = state.players[seat].melds;
  const last = melds[melds.length - 1];
  const color = suitBaseOf(last.tiles[0]);
  if (color < 0) return;
  const exposed = melds.filter((m) => ['chi', 'peng', 'zhi', 'xu'].includes(m.type)
    && suitBaseOf(m.tiles[0]) === color);
  if (exposed.length !== 3) return; // 只在喂出第 3 个明牌副露的那一下宣告
  if (state.rains.some((r) => r.color === color && r.owner === seat)) return; // 幂等
  const suitName = color === 0 ? '万' : color === 9 ? '筒' : '条';
  state.rains.push({ color, owner: seat, baos: [from], penalties: [] });
  log(state, `${state.players[seat].name} 第三句${suitName} —— ${state.players[from].name} 包胡（${suitName}一色），其余各家必须下雨`);
}

/**
 * 下雨惩罚（老吴 2026-10-25 修订③）：出牌时**手中有该花色却未出该花色** → 当场记陪包。
 * 惩罚只挂**第一场**被包的花色（修订⑤：第二种花色不算惩罚，只约束出牌顺序）。
 * 包胡者与雨主免义务。
 */
function checkRainPenalty(state, seat, tile) {
  const rs = state.ruleset;
  if (rs.rainEnabled === false || !state.rains.length) return;
  const r0 = state.rains[0];
  if (r0.owner === seat || r0.baos.includes(seat)) return;
  if (r0.penalties.includes(seat)) return; // 已记过一次，陪包是定局
  const hasSuit = state.players[seat].hand.some((t) => suitBaseOf(t) === r0.color);
  if (hasSuit && suitBaseOf(tile) !== r0.color) {
    r0.penalties.push(seat);
    const suitName = r0.color === 0 ? '万' : r0.color === 9 ? '筒' : '条';
    log(state, `${state.players[seat].name} 手中有${suitName}却未下雨 —— 结算陪包`);
  }
}

function buildContext(state, seat, extra = {}) {
  const rs = state.ruleset;
  /* 进来的那张牌 —— 「见字胡」判定要用（老吴 2026-10-01：见字胡必须自摸，不能接冲）。
     自摸 = 刚从牌墙摸的那张；点炮 / 抢杠 = 别人打出的（或被抢的那张）。
     调用方可用 `extra.winTile` 显式指定（听牌分析试牌时必须指定，否则判据会指着错牌）。 */
  const winTile = extra.winTile !== undefined
    ? extra.winTile
    : (extra.selfDraw ? state.lastDraw : (state.lastDiscard ? state.lastDiscard.tile : null));
  return {
    selfDraw: !!extra.selfDraw,
    from: extra.from ?? null,
    winTile: winTile ?? null,
    gangShangKaiHua: state.gangFlag && !!extra.selfDraw,
    // 海底捞：尾墩数起第 haiDiLaoStacks 墩（默认 7 墩 = 14 张）起为海捞位。
    // 摸牌后 wall.length = 摸牌前张数 - 1，故「摸牌前 ≤ 14 张」⟺「摸牌后 < 14 张」。
    haiDiLao:
      !!extra.selfDraw &&
      rs.haiDiLaoStacks > 0 &&
      state.wall.length < rs.haiDiLaoStacks * 2,
    qiangGangHu: !!extra.qiangGangHu,
    yuanLai: !!state.yuanLai, // 原赖：本局癞子与上局同
    fengLai: !!state.fengLai, // 风赖：本局癞子为风
    // 连金 / 反金（老吴 2026-10-24）：与**紧邻上一局的赢家**比较，只算一次。
    //   连金 = 本局该座位就是上局赢家；反金 = 上局赢家被他的下家或对家胡（上家不算）。
    //   上局荒庄（prevWinnerSeat = null）即断线，两者都不成立。
    lianJin: state.prevWinnerSeat !== null && state.prevWinnerSeat !== undefined
      && seat === state.prevWinnerSeat,
    fanJin: state.prevWinnerSeat !== null && state.prevWinnerSeat !== undefined
      && seat !== state.prevWinnerSeat
      && (seat === (state.prevWinnerSeat + 1) % SEATS || seat === (state.prevWinnerSeat + 2) % SEATS),
  };
}

/**
 * 「N 番起胡」门槛（老吴 2026-09-30 明确）。
 *
 * 门槛衡量的**不是赢家一个人的番数**，而是 **赢家番 ＋ 每一个输家的番数**：
 *     effFan(该输家) = 赢家总番 + 该输家自家番
 * 只有当**每一个输家**的 effFan 都 ≥ 门槛（小胡 6 番 / 大胡 3 番）时，才允许胡牌。
 * 门槛恰等于分段计分表的最低档 → 能胡即保证三家都至少得 1 分，杜绝 0 分结算。
 *
 * @returns {{fan:number, name:string, eff:number}|null} 最差的那一家（不够档时用于提示）
 */
function worstEffFanForWin(state, seat, winnerFanResult, context) {
  const rs = state.ruleset;
  const winnerIsDealer = !!state.players[seat].isDealer;
  let worst = null;
  for (const q of state.players) {
    if (q.seat === seat) continue;
    const loserFan = countFan(
      { seat: q.seat, melds: q.melds },
      {
        ruleset: rs,
        isDealer: !!q.isDealer,
        isWinner: false,
        winnerIsDealer,
        isDiscarder: context.from === q.seat,
        selfDraw: !!context.selfDraw,
      },
    ).total;
    const eff = winnerFanResult.total + loserFan;
    if (worst === null || eff < worst.eff) worst = { fan: loserFan, name: q.name, eff };
  }
  return worst;
}

/**
 * 这手牌（counts + 副露）在本局规则下能不能胡。
 *
 * 导出给 `tenpai.js` 做「听牌分析」用 —— 那里要把 34 种牌逐个塞进手牌试一遍，
 * 必须复用同一套闸门（红中/皮子/开口/起胡门槛），否则提示会和实际能对上的牌不一致。
 */
export function canWinWith(state, seat, counts, context) {
  const p = state.players[seat];
  const res = evaluateWin({
    counts,
    melds: p.melds,
    opened: p.opened,
    context,
    ruleset: state.ruleset,
    wildTile: state.wildTile,
    skinTiles: state.skinTiles,
  });
  if (!res.legal) return res;

  // 「几番起胡」门槛（老吴拍板：小胡 6 番 / 大胡 3 番；按「赢家番 + 每个输家番」判定）
  const rs = state.ruleset;
  if (rs.enforceMinFan) {
    const threshold = res.size === 'big' ? rs.minFanBig : rs.minFanSmall;
    if (threshold > 0) {
      const winnerFan = winnerFanPreview(
        { seat: p.seat, name: p.name, melds: p.melds, opened: p.opened, isDealer: p.isDealer },
        res,
        context,
        rs,
      );
      const worst = rs.minFanCountLosers
        ? worstEffFanForWin(state, seat, { total: winnerFan }, context)
        : { fan: 0, name: '赢家自己', eff: winnerFan };
      if (worst && worst.eff < threshold) {
        return {
          legal: false,
          reason: `番数不够（赢家 ${winnerFan} 番 ＋ ${worst.name} ${worst.fan} 番 = ${worst.eff} 番，${res.size === 'big' ? '大胡' : '小胡'}需每家都 ≥ ${threshold} 番起胡）`,
        };
      }
    }
  }
  return res;
}

/**
 * 判定「包牌」责任方（Rule5）。
 *   · 抢杠包牌由调用方直接传入，不走这里；
 *   · 其余两种都只发生在**点炮**胡牌时。
 * @returns {number|null} 包牌家座位，或 null
 */
/**
 * 5-2 全求人点炮包牌（2026-10-22 老吴纠正：看**放炮者**，不是赢家）。
 * 「打出将牌的玩家包胡。免包的条件是他的手牌全部是将牌，
 *   有赖子或者红中皮都不算全手将牌。」
 * 下雨豁免（老吴 2026-10-25）：放炮者是下雨义务人、打进张是雨花色的将牌、
 * 且其手里仅剩该花色的将牌 —— 被下雨规则**强制**打出的一张，不包全求人。
 *
 * ❗2026-10-29 老吴：「副露 4 口 + 单吊『字牌+癞子』点炮，这种场景下，**必定是被包胡了**，
 *   不算全求人。」——「不算全求人」已经由 `score.js` 处理（番型要求将牌是**实牌**）；
 *   本函数因此改为**只看结构**：4 口全副露 + 点炮 → 放炮者包，
 *   **不再依赖 `winResult.types.includes('quanQiuRen')`**。
 *   否则一旦番型被拿掉，包胡也会跟着消失，与老吴口径正好相反。
 *
 * @returns {number|null} 放炮者座位（不包返回 null）
 */
function resolveQuanQiuRenBaoSeat(state, seat, context, winResult) {
  if (!state.ruleset.quanQiuRenBaoEnabled) return null;
  const from = context.from;
  if (from === null || from === undefined) return null;
  if (context.selfDraw) return null; // 自摸没有「放炮者」
  // 风一色豁免包牌（老吴 2026-10-29）：金顶固定分，不进「一色包」体系。
  // 调用方已在 settleWin 里用 isFengWin 短路，这里再判一次是为了函数自洽。
  if (winResult && winResult.types.includes('fengYiSe')) return null;
  // 结构条件：自己 4 口全是吃/碰/明杠/**蓄杠**（暗杠、皮子杠、癞子杠、红中杠都不算）
  //   ↑ 蓄杠 2026-10-29 老吴补：碰升杠仍是别人打的面子，归进全求人（见 melds.isQuanQiuRen）
  if (!isQuanQiuRen(state.players[seat].melds)) return null;
  if (isAllJiangHand(state.players[from], state.wildTile, state.skinTiles)) return null;
  if (isRainJiangExempt(state, from, context)) return null;
  return from;
}

/**
 * 5-1 清（将）一色「第三句」包牌（老吴 2026-09-30 明确）：
 * **一色牌型里只有风一色不包牌，其余（清一色 / 将一色 / 清将）一律要包。**
 * 风一色（全字牌）本身走「不包胡、直接金顶」，此处显式排除以自文档化。
 * ⚠️ 2026-10-25 下雨口径叠加在其上：第 3、4 句**同花色**喂牌都包（state.rain.baos），
 *    与本条取**并集**（跨花色将一色的「第三句」只有本条能覆盖，见 game.test.js 夹具）。
 * ⚠️ 2026-10-29 老吴补「第三句」计数口径：只数**能被看见的**面子（吃/碰/明杠/蓄杠），
 *    **暗杠不计** —— 见 `VISIBLE_MELD_TYPES`。下雨关闭时只剩本条兜底，口径必须一致。
 * @returns {number[]} 第三句提供者座位（可能为空）
 */
function resolveThirdMeldBaoSeats(state, seat, winResult) {
  const rs = state.ruleset;
  if (!rs.qingJiangBaoEnabled) return [];
  const types = winResult.types;
  const isQing = types.includes('qingYiSe');
  const isJiang = types.includes('jiangYiSe');
  const isFeng = types.includes('fengYiSe');
  if (isFeng || (!isQing && !isJiang)) return [];
  const provider = thirdColorMeldProvider(state.players[seat], isQing ? 'qing' : 'jiang');
  return provider !== null ? [provider] : [];
}

/**
 * 全求人包牌的**下雨将牌豁免**（老吴 2026-10-25）：
 * 「下雨的过程中最后仅剩该花色的将牌了，打该将不包全求人。」
 * 判定：放炮者手牌（打出后）每一张都是雨花色的将牌（2/5/8）或癞子/皮子（可当将），
 *       且打出的进张就是雨花色的将 —— 这张牌是下雨义务**逼**出来的，不算主动喂全求人。
 */
function isRainJiangExempt(state, from, context) {
  const r0 = state.rains[0]; // 只看第一场雨（第二种花色不算惩罚，无豁免需求）
  if (!r0) return false;
  const color = r0.color;
  const winTile = context.winTile;
  if (winTile === null || winTile === undefined || !isNumberTile(winTile)) return false;
  if (winTile < color || winTile >= color + 9) return false;
  if (![2, 5, 8].includes(tileRank(winTile))) return false;
  const specialOk = (t) => t === state.wildTile || (state.skinTiles || []).includes(t);
  const rest = state.players[from].hand;
  if (rest.length === 0) return false;
  return rest.every((t) => specialOk(t)
    || (t >= color && t < color + 9 && [2, 5, 8].includes(tileRank(t))));
}

/**
 * 全手将（老吴 2026-10-22）：手牌 + 副露的每一张都是 2/5/8，且不能含癞子 / 红中 / 皮子。
 * 癞子、红中、皮子即使点数是 2/5/8 也不算将牌。
 */
function isAllJiangHand(player, wildTile, skinTiles) {
  const special = new Set([wildTile, RED_DRAGON, ...(skinTiles || [])].filter((t) => t !== null && t !== undefined));
  const tiles = [...player.hand, ...player.melds.flatMap((m) => m.tiles)];
  if (tiles.length === 0) return false;
  return tiles.every((tile) => !special.has(tile) && isNumberTile(tile) && [2, 5, 8].includes(tileRank(tile)));
}

/**
 * 「能被看见的刻子或顺子」—— 一色包第三句的计数口径（老吴 2026-10-29）：
 *   chi（顺子）/ peng（刻子）/ zhi（明杠，看得见的刻子）/ xu（蓄杠，本是碰出来的刻子）
 *   **不含 an（暗杠）**，也不含皮子杠 / 癞子杠 / 红中杠这些特殊杠。
 * 与 `checkRainDeclare` 的明牌计数（chi/peng/zhi/xu，暗杠不计）保持同一口径。
 */
const VISIBLE_MELD_TYPES = ['chi', 'peng', 'zhi', 'xu'];

/**
 * 找出「打出第 3 个能被看见的同色面子」的那一家。
 * 副露按发生顺序追加；暗杠不占位，所以「2 明句 + 1 暗杠」时，
 * 第 4 句就是第 3 个明牌副露 → 由它的供牌者包胡（老吴 2026-10-29）。
 * @param {'qing'|'jiang'} kind
 */
function thirdColorMeldProvider(player, kind) {
  const real = player.melds.filter(
    (m) => VISIBLE_MELD_TYPES.includes(m.type) && m.from !== null && m.from !== undefined,
  );
  const match = real.filter((m) => {
    if (!m.tiles.every((t) => isNumberTile(t))) return false;
    if (kind === 'jiang') return m.tiles.every((t) => [2, 5, 8].includes(tileRank(t)));
    return true; // 清一色：面子天然同花色
  });
  if (match.length < 3) return null;
  return match[2].from;
}

/**
 * 基本两口（Rule6，老吴 2026-10-21 确认）：所有非赢家（含庄家）都须有 basicTwoKouCount
 * （默认 2）口皮子/红中杠。有人胡牌时，未达 2 口的非赢家包胡；多个同时未达 → 多个都包胡。
 *
 * 例外：结算时「手里剩余的皮 + 已经杠出的皮/红中」不足 2 张的，说明本局确实凑不出两口，
 * 不包胡（老吴原话：手牌中剩余的皮加上已有的番数不足 2 的，作为例外）。
 *
 * 阳光（负分翻倍）是另一套口径：未开口且没有红中/皮子/癞子杠才翻倍（暗杠不豁免）。
 */
/**
 * 用**改写后的** payments 重新生成结算文案。
 *
 * 承包 / 包胡会把某家的 pay 抬到总额、其余几家清零；若沿用 `settlement.text`
 * （在改写前生成），文案里的「X 输 N」就和面板里的实际分账对不上了。
 */
function rebuildSettlementText(settlement, rs) {
  return formatWinTextTable(
    { size: settlement.size, types: settlement.types, hardWin: settlement.hardWin },
    { total: settlement.winnerFan },
    settlement.payments,
    rs,
    settlement.topType,
    settlement.bao,
  );
}

function applyBasicTwoKou(state, winnerSeat, settlement, rs) {
  if (!rs.basicTwoKouEnabled || rs.basicTwoKouCount <= 0) return settlement;
  const skinSet = new Set(state.skinTiles);
  if (skinSet.size === 0) return settlement;

  const need = rs.basicTwoKouCount;
  const baoSeats = [];
  for (const p of state.players) {
    if (p.seat === winnerSeat) continue;
    const handSkins = p.hand.filter((t) => skinSet.has(t)).length;
    const skinGangs = p.melds.filter((m) => m.type === 'skin' || m.type === 'red').length;
    if (skinGangs >= need) continue; // 已杠满两口 → 不包
    // 手里剩下的皮 + 已杠出的皮/红中不足 2 张 → 本局确实凑不出两口，例外不包。
    if (handSkins + skinGangs < need) continue;
    if (rs.basicTwoKouRequireHandSkin && handSkins < 1) continue;
    baoSeats.push(p.seat);
  }
  if (baoSeats.length === 0) return settlement;

  const baoSet = new Set(baoSeats);
  const moved = settlement.payments
    .filter((x) => !baoSet.has(x.seat))
    .reduce((a, x) => a + x.pay, 0);
  const k = baoSeats.length;
  const base = Math.floor(moved / k);
  const rem = moved - base * k;

  const payments = settlement.payments.map((x) => {
    if (!baoSet.has(x.seat)) return { ...x, pay: 0, baoHu: false, basePay: x.pay };
    const idx = baoSeats.indexOf(x.seat);
    return {
      ...x,
      basePay: x.pay,
      pay: x.pay + base + (idx < rem ? 1 : 0),
      baoHu: true,
    };
  });

  const baoHus = baoSeats.map((s) => ({
    seat: s,
    name: state.players[s].name,
    amount: payments.find((x) => x.seat === s).pay,
  }));

  const note = `｜【基本两口】${baoHus.map((b) => `${b.name} 包胡 ${b.amount}`).join('、')}`;
  const totalWin = payments.reduce((a, b) => a + b.pay, 0);
  const merged = { ...settlement, payments, baoHus, totalWin };
  return { ...merged, text: rebuildSettlementText(merged, rs) + note };
}

/**
 * 结算
 * @param {number|null} baoSeat 承包者（抢杠胡时为被抢的那家；其余包牌类型在此自动判定）
 */
function finishWin(state, seat, winResult, context, baoSeat) {
  state.phase = 'settled';
  // 老吴 2026-10-20：先在桌面上摊开四家手牌，等四家都点「确认」，再弹结算页。
  // result 仍然立刻算好（视图里 result 不隐藏），只是前端在 pending 期间不弹窗。
  state.reveal = { pending: true, confirmed: [] };
  state.claims = [];
  state.pendingXuGang = null; // 终局快照里不该残留「待抢的杠」
  refreshAchievements(state); // 兜底刷新，确保终局快照里的成就标记是最新的（含本回合致胜动作可能触发的七皮/十杠）

  const rs = state.ruleset;
  // —— 包牌（Rule5）+ 下雨/陪包（老吴 2026-10-25）——
  //   优先级：抢杠被抢者承包（调用方传入）＞ **一色包（第 3 句 / 下雨）** ＞ 全求人放炮者。
  //   ❗2026-10-29 老吴纠正优先级：「清一色仍由放炮者独付 60，这是怎么来的？如果是清一色，
  //     只剩最后一张牌了，那必然是被包胡了，**由包胡者付，不由放炮者付**。」
  //     —— 「包胡者」= 打出**第三句**同花色的人，「放炮者」= 打出最后一张的人，是两个角色。
  //     清/将一色到最后一两张时，一色包必然成立 ⇒ 责任归包胡者，放炮者不掏钱。
  //     全求人（4 口全副露 + 点炮 → 放炮者包）只在**非一色**牌型下才有意义，
  //     因为清/将一色 4 口必然同色 ⇒ 第 3 句必然存在 ⇒ 一定走一色包。
  //   下雨包生效前提：赢家做成**清一色 / 将一色**（风一色不包不下，见 ruleset.rainEnabled）。
  //   ❗2026-10-29 老吴：「风一色豁免包牌，不用包牌，不用下雨。」
  //     —— 风一色是金顶（固定分），整条「一色包」体系对它不成立：
  //        ① 第三句包：resolveThirdMeldBaoSeats 早已 isFeng 排除；
  //        ② 全求人包：本函数下方 qqrBao 一并豁免；
  //        ③ 下雨包 / 未下雨陪包：myRain 置 null，雨主胡风一色则该场雨不结算。
  //     保留不动的两条（与「一色包」无关，属独立责任）：
  //        · 抢杠被抢者承包（baoSeat，杠者的责任）；
  //        · 基本两口包（闲家该杠的皮没杠满 2 口，与胡什么牌型无关）。
  const isFengWin = winResult.types.includes('fengYiSe');
  let baoList = [];
  // 下雨结算条件（老吴 2026-10-25 修订①）：**雨主自己胡牌**。
  // A（雨主）没胡 → 谁胡按谁的牌面正常算分，所有包胡/下雨/陪包都不计算。
  // 风一色胡牌 → 该场雨不结算（老吴 2026-10-29「不用下雨」）。
  const myRain = rs.rainEnabled !== false && !isFengWin
    ? (state.rains.find((r) => r.owner === seat) ?? null)
    : null;
  if (baoSeat !== null && baoSeat !== undefined) {
    baoList = [baoSeat]; // 抢杠：被抢者承包（不走下雨叠加，与既有口径一致）
  } else {
    // ① 一色包优先：第三句（既有口径）∪ 下雨包（第 3、4 句同花色喂牌者）—— 并集、去重、剔除赢家
    const colorBao = [...new Set([
      ...resolveThirdMeldBaoSeats(state, seat, winResult),
      ...(myRain ? myRain.baos : []),
    ])].filter((s) => s !== seat);
    if (colorBao.length) {
      baoList = colorBao;
    } else {
      // ② 只有「非一色」的 4 口全副露 + 点炮，才由**放炮者**包（全求人）。
      //    一色包判定失败时（例如 4 口里有暗杠/特殊杠、明副露不足 3 口）才回落到这里兜底。
      const qqrBao = isFengWin ? null : resolveQuanQiuRenBaoSeat(state, seat, context, winResult);
      baoList = qqrBao !== null ? [qqrBao] : [];
    }
  }

  const players = state.players.map((p) => ({
    seat: p.seat,
    name: p.name,
    melds: p.melds,
    opened: p.opened,
    isDealer: p.isDealer,
    qiPi: !!p.qiPi,
    shiGang: !!p.shiGang,
  }));

  let settlement = settleRound({
    players,
    winnerSeat: seat,
    winnerResult: winResult,
    context,
    ruleset: rs,
  });

  // 陪包（老吴 2026-10-25 修订③/⑤）：逐轮出牌时「手中有该花色却未出」已在 doDiscard 当场记录；
  // 惩罚只挂**第一场**被包的花色，且只有**雨主胡牌**才清算。
  // 第二场被包的花色不算惩罚（只约束出牌顺序：第一种下完才轮到第二种）。
  let peiSeats = [];
  if (myRain && state.rains[0] === myRain) {
    peiSeats = myRain.penalties.filter((s) => s !== seat && !baoList.includes(s));
  }

  if (baoList.length || peiSeats.length) {
    // 各包/陪者**各付全额**（不均摊）：先包先下（先列包胡者，再列陪包者）。
    // 极端三家全掏 = 总分 ×3 ≈ 普通局单家的 9 倍（对称局，老吴口径）。
    const perPay = settlement.totalWin;
    const payers = [
      ...baoList.map((s) => ({ seat: s, kind: 'bao' })),
      ...peiSeats.map((s) => ({ seat: s, kind: 'pei' })),
    ];
    const payments = settlement.payments.map((x) => {
      const hit = payers.find((py) => py.seat === x.seat);
      return { ...x, basePay: x.pay, pay: hit ? perPay : 0 };
    });
    const totalWin = payments.reduce((a, b) => a + b.pay, 0);
    const rainPayers = payers.map((py) => ({
      seat: py.seat,
      name: state.players[py.seat].name,
      kind: py.kind,
      amount: perPay,
    }));
    const baoNames = rainPayers.filter((x) => x.kind === 'bao').map((x) => x.name);
    const peiNames = rainPayers.filter((x) => x.kind === 'pei').map((x) => x.name);
    let note = '';
    if (baoList.length === 1 && peiSeats.length === 0) {
      note = `｜【承包】${rainPayers[0].name} 独付 ${perPay}（其余两家免付）`;
    } else {
      const parts = [];
      if (baoNames.length) parts.push(`包胡 ${baoNames.join('、')}`);
      if (peiNames.length) parts.push(`${peiNames.join('、')} 未下雨陪包`);
      note = `｜【下雨】${parts.join('，')}（各付 ${perPay}，其余免付）`;
    }
    const merged = {
      ...settlement,
      payments,
      totalWin,
      rainPayers,
      // 兼容旧展示：单一承包（抢杠）沿用 baozhuang 字段
      baozhuang: baoList.length === 1 && peiSeats.length === 0
        ? { seat: baoList[0], name: rainPayers[0].name, amount: perPay }
        : null,
      bao: null,
    };
    settlement = { ...merged, text: rebuildSettlementText(merged, rs) + note };
  } else {
    // —— 基本两口（Rule6）：闲家须杠出 2 皮，未达两口且手中有皮 → 该闲家包胡 ——
    settlement = applyBasicTwoKou(state, seat, settlement, rs);
  }

  const totalWin = settlement.payments.reduce((a, b) => a + b.pay, 0);
  settlement = { ...settlement, totalWin };

  // 七皮 / 十杠 成就奖金（与胜负结算独立的附加账本，牌局继续期间已锁定，此处只收账）
  // ⚠️ 老吴 2026-10-03：七皮/十杠发生在**风赖/原赖**局也要 ×2。
  //   口径是「**本局是风赖还是原赖**」，与谁胡牌无关 —— 所以这里直接判 state.fengLai/yuanLai，
  //   不去借 `settlement.mul`（那个字段的含义是「赢家的赖子倍率」，借它等于引入隐含推理）。
  //   与下面的 settleDraw 用同一段判据，两处口径必须一致。
  const bonuses = computeSpecialBonuses(players, state.ruleset, laiMulOf(state));
  const bonusTotal = bonuses.reduce((a, b) => a + b.amount, 0);
  const bonusNote = bonusTotal > 0 ? `｜七皮/十杠 +${bonusTotal}` : '';

  /* 包胡 / 陪包责任（老吴 2026-10-30）：「当有包胡或者陪包的时候，在结算页面相关玩家后
     显示『包胡』或者『陪包』」。
     责任信息原先散在三处 —— `rainPayers`（按 kind 分 bao/pei）、`baoHus`（只记基本两口的包胡）、
     `baozhuang`（只有单一承包的旧字段）；前端各拼各的必漏，且三家全掏时无法一眼看出谁是包胡。
     这里归一成 `baoRoles: [{ seat, kind:'bao'|'pei', amount }]`：
       · 同一座位只留一条，**包胡优先于陪包**（下雨分支已保证互斥，这里是兜底）；
       · amount = 该家实际独付/陪付的分（已含金顶/加倍改写后的金额）。 */
  const baoRoles = [];
  const addBaoRole = (s, kind, amount) => {
    if (!Number.isInteger(s)) return;
    const hit = baoRoles.find((x) => x.seat === s);
    if (!hit) { baoRoles.push({ seat: s, kind, amount: amount | 0 }); return; }
    if (kind === 'bao' && hit.kind !== 'bao') { hit.kind = 'bao'; hit.amount = amount | 0; }
  };
  for (const x of settlement.rainPayers || []) addBaoRole(x.seat, x.kind === 'pei' ? 'pei' : 'bao', x.amount);
  for (const b of settlement.baoHus || []) addBaoRole(b.seat, 'bao', b.amount);
  if (settlement.baozhuang) addBaoRole(settlement.baozhuang.seat, 'bao', settlement.baozhuang.amount);

  // 结构化「本把每家战绩」——供前端牌桌面板 / 单局明细 / 报表 / 后端落库复用，不依赖视图时序
  //
  // 🔴 `delta` **必须把七皮/十杠算进去**（老吴 2026-10-03 22:22 问「打出七皮十杠又胡牌时每家付多少」时查出）：
  //   修之前 `delta` 只取 `payments`（胡牌输赢），`bonuses` 完全没进账 ⇒
  //   「赢家同时七皮 + 十杠」时 `bonusTotal=60` 但**四家 delta 求和仍是 0**（账没平），
  //   而且累计战绩分 / 战绩面板 / 后端落库全都少算了这笔。
  //   正确口径：每家实际付出 = 胡牌应付 + 该家应付的七皮/十杠；成就奖收款人是达成者自己。
  //   收支计算走共用的 `bonusDeltaOf()`，与荒庄局同源（见该函数的注释）。
  const perSeat = state.players.map((p) => {
    const isWinner = p.seat === seat;
    const pay = settlement.payments.find((x) => x.seat === p.seat);
    const winLoss = isWinner ? settlement.totalWin : -(pay ? pay.pay : 0);
    const delta = winLoss + bonusDeltaOf(bonuses, p.seat);
    const fan = isWinner ? settlement.winnerFan : pay ? pay.fan || 0 : 0;
    // 「杠口」用加权口径（老吴 23:38）—— 与十杠成就判定同源，
    // 否则统计面板显示的口数会与「有没有十杠」对不上。
    const gangs = countGangUnits(p.melds || [], state.ruleset);
    const huType = isWinner
      ? settlement.topType === 'goldTop' ? 'gold' : settlement.size === 'big' ? 'big' : 'small'
      : null;
    return { seat: p.seat, name: p.name, isWinner, delta, fan, gangs, huType };
  });
  state.result = {
    type: 'win',
    winner: seat,
    ...settlement,
    baoRoles,
    perSeat,
    bonuses,
    bonusTotal,
    text: settlement.text + bonusNote,
  };
  log(state, `—— 结算：${settlement.text}${bonusNote}`);
  return state;
}

function settleDraw(state) {
  state.phase = 'settled';
  state.reveal = null;
  state.claims = [];
  state.pendingXuGang = null;
  refreshAchievements(state); // 兜底刷新，确保终局快照里的成就标记是最新的
  // 荒庄局没有赢家 ⇒ 没有结算倍率可用，直接按「本局是风赖/原赖」取（与胡牌局同一个 helper）。
  // ⚠️ 老吴 2026-10-03：七皮/十杠发生在风赖/原赖局也要 ×2，**荒庄局同样算**（成就奖是独立账本）。
  const bonuses = computeSpecialBonuses(state.players, state.ruleset, laiMulOf(state));
  const bonusTotal = bonuses.reduce((a, b) => a + b.amount, 0);
  const bonusNote = bonusTotal > 0 ? `｜七皮/十杠 +${bonusTotal}` : '';
  // 结构化「本把每家战绩」（荒庄：无赢家，胡牌输赢恒 0；**但七皮/十杠照样要收付**）
  // ⚠️ 修之前这里 `delta: 0` 写死 ⇒ 荒庄局里达成七皮/十杠的账也不平（同一个 bug 的另一条路径）。
  const perSeat = state.players.map((p) => ({
    seat: p.seat,
    name: p.name,
    isWinner: false,
    // 荒庄没有赢家 ⇒ 胡牌输赢是 0，但成就奖收支要走同一套（共用 bonusDeltaOf）
    delta: bonusDeltaOf(bonuses, p.seat),
    fan: 0,
    // 同一套加权口径（老吴 23:38）—— 胡牌局与荒庄局必须一致
    gangs: countGangUnits(p.melds || [], state.ruleset),
    huType: null,
  }));
  state.result = {
    type: 'draw',
    reason: '牌墙摸尽',
    text: '荒庄' + bonusNote,
    perSeat,
    // 荒庄不判包胡/陪包，但字段保持存在（前端统一读 result.baoRoles）
    baoRoles: [],
    bonuses,
    bonusTotal,
  };
  log(state, `—— 牌墙摸尽，荒庄${bonusNote}`);
}

function log(state, message) {
  state.seq++;
  state.events.push({ seq: state.seq, message });
}

/* ------------------------------------------------------------------ */
/* 视图（只输出该玩家看得见的信息）                                      */
/* ------------------------------------------------------------------ */

export function viewFor(state, seat) {
  return {
    phase: state.phase,
    turn: state.turn,
    dealer: state.dealer,
    // 起手掷骰 [v1, v2]（1..6）：公开信息，前端据此显示骰子与点数。
    dice: state.dice ? [...state.dice] : null,
    wallLeft: state.wall.length,
    flipTile: state.flipTile,
    // ❗2026-10-29 安全修复（P0）：**不再下发 seed**。
    // 旧注释写「seed 是公开信息，不含手牌」——这个假设是错的：洗牌是
    // mulberry32(seed) + Fisher-Yates 的**确定性**算法，谁拿到 seed 就能复算出
    // 四家起手牌与整条牌墙（实测逐张一致）⇒ 等于全场透视挂。
    // 前端原本只用它做「成就播报去重」，改用 handTag（服务端随机、不可反推）。
    handTag: state.handTag ?? null,
    wildTile: state.wildTile,
    prevWildTile: state.prevWildTile, // 上一局癞子（用于「原赖」判定，客户端可对比展示）
    yuanLai: state.yuanLai, // 本局癞子与上局同 → 原赖
    fengLai: state.fengLai, // 本局癞子为风 → 风赖
    skinTiles: state.skinTiles,
    lastDiscard: state.lastDiscard,
    // 待抢的蓄杠（老吴 2026-10-02）：非 null 表示当前正处在「有人可以抢杠胡」的响应阶段。
    // 这是**公开信息** —— 补杠本身就是当众宣告的（否则别人无从抢起），
    // 且这个字段只说明「谁在补哪张」，不含任何别家暗牌。
    // 前端据此把提示条写成「抢杠胡」而不是含糊的「可以胡牌」。
    pendingXuGang: state.pendingXuGang ? { ...state.pendingXuGang } : null,
    // 下雨 / 陪包（老吴 2026-10-25，公开信息：谁包胡是当众宣告的）。按宣告先后排序。
    rains: state.rains.map((r) => ({
      color: r.color,
      owner: r.owner,
      baos: [...r.baos],
      // 还欠雨的义务人座位（手里仍有该花色的非包胡/非雨主玩家，且尚未被记陪包）
      owe: state.players
        .filter((p) => p.seat !== r.owner
          && !r.baos.includes(p.seat)
          && !r.penalties.includes(p.seat)
          && p.hand.some((t) => t >= r.color && t < r.color + 9))
        .map((p) => p.seat),
      penalized: [...r.penalties],
    })),
    // 全局弃牌流水 [{seat, tile}]，按出牌先后 —— 牌河「依次显示」用
    discardLog: state.discardLog,
    lastDraw: state.turn === seat ? state.lastDraw : null,
    // 终局结算快照（win / draw）；未结算时为 null，前端据此隐藏结算面板
    result: state.result,
    // 七皮 / 十杠「刚达成」播报（公开信息；金额仅提前展示，真正入账仍在结算时）
    achievements: (state.achievementEvents || []).map((e) => ({
      seq: e.seq,
      seat: e.seat,
      name: e.name,
      kind: e.kind,
      label: e.label,
      perPayer: e.perPayer,
      amount: e.amount,
      mul: e.mul,
      payers: e.payers.map((x) => ({ seat: x.seat, name: x.name, pay: x.pay })),
    })),
    // 胡牌摊牌确认进度（荒庄 / 未结算时为 null）。
    // pending=true 时四家手牌已经全部摊开，但结算弹窗要压住，等 confirmed 凑满四家。
    reveal: state.reveal
      ? {
          pending: !!state.reveal.pending,
          confirmed: [...state.reveal.confirmed],
          total: state.players.length,
          canConfirm: !!state.reveal.pending && !state.reveal.confirmed.includes(seat),
        }
      : null,
    me: {
      seat,
      // 自己的**公开**昵称（网络版即服务端发的真实 username；单机版是「你」）。
      // 只是为了前端画头像/昵称，不含任何别家信息 —— viewFor 的下发边界不变。
      name: state.players[seat].name,
      // 预设头像（emoji，公开信息）；null = 前端按名字首字本地生成
      avatar: state.players[seat].avatar ?? null,
      hand: [...state.players[seat].hand],
      melds: state.players[seat].melds,
      discards: state.players[seat].discards,
      opened: state.players[seat].opened,
      // 客户端据此渲染「可吃/可碰/可杠/可胡」提示；吃带多套 combos 时玩家可逐项选择
      legal: legalActions(state, seat).map((a) => {
        const o = { type: a.type, tile: a.tile ?? null };
        if (a.combos) o.combos = a.combos;
        return o;
      }),
    },
    others: state.players
      .filter((p) => p.seat !== seat)
      .map((p) => {
        const o = {
          seat: p.seat,
          name: p.name,
          avatar: p.avatar ?? null,
          handCount: p.hand.length,
          // ⚠️ 暗杠是暗牌：对局中别家暗杠的 4 张牌**不下发**（占位 HIDDEN_TILE，
          //    前端画牌背），否则「谁暗杠了什么」从网络包里就能看出来。
          //    摊牌（settled）与结算快照照常给真实牌面。
          melds: state.phase === 'settled'
            ? p.melds
            : p.melds.map((m) => (m.type === 'an' ? { ...m, tiles: m.tiles.map(() => HIDDEN_TILE) } : m)),
          discards: p.discards,
          opened: p.opened,
        };
        // ⚠️ 只有**终局摊牌**才下发别家手牌（`phase === 'settled'`）。
        //    对局中这个字段**根本不出现**，`viewFor` 不下发别家手牌的硬约定不变。
        if (state.phase === 'settled') o.hand = [...p.hand];
        return o;
      }),
  };
}

export { HU_LABELS, formatTiles, tileName, toCounts, RED_DRAGON, TILE_KINDS };
