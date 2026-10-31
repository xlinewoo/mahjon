/**
 * 前端 DOM 渲染层 —— 武汉红中赖子杠（**单机 / 网络对战共用**）
 *
 * 本模块**不做任何对局推进**，只负责「拿到一份 state.view 就把它画出来」。
 * 谁提供 state.view、点了按钮之后怎么推进，全部由外部注入的 driver 决定：
 *
 *   · 网络版  frontend/net-lobby.js（入口 net3d-main.js）—— driver = createNetDriver()（socket.io，服务端权威）
 *   · 回放    frontend/replay.js —— driverFor(replay)（复算式驱动，动作安全降级）
 *
 * driver 契约（二者必须完全一致）：
 *   seatToDir     座位 → 方位（'东'|'南'|'西'|'北'）
 *   winds         摸风结果 { dealer, entries }（网络版 entries=null → 不弹摸风面板）
 *   actingSeat()  当前该谁行动；settled 时 -1
 *   isMyTurn()    是否轮到我
 *   getView()     我的视角快照
 *   getTenpai()   听牌分析结果（单机本地算 / 网络由服务端下发）
 *   ruleset       房间规则（只用到 claimTimeoutMs）
 *   autoPassLocally  是否由前端负责「超时自动过」（单机 true；网络 false → 服务端兜底）
 *
 * 依赖：../src/engine/tiles.js（牌的编号与名字）、../src/engine/score.js（番型名）、
 *       ./game-loop.js（方位与结算文案的纯函数）、./assets/tiles-img.js（牌面**位图**）。
 *       全部内联进单文件 HTML 后，双击 file:// 即可在浏览器 / 微信 H5 打开。
 *
 * 牌面为什么是位图而不是 SVG（老吴 2026-10-03「桌面改成图片模式」）：
 *   `./assets/tiles-img.js` 与旧的 `./assets/tiles.js` **同构**（同键、同导出），
 *   由 `tools/build-tile-images.mjs` 从 SVG 栅格化而来 —— 图案与配色完全没变，
 *   只是渲染介质换成 128×155 WebP，35 张合计 133KB（比内联 SVG 还小 34%）。
 *   想改牌面设计就改 `tiles.js` 然后重跑那个脚本，**别手改 tiles-img.js**。
 *
 * 布局（老吴 2026-09-30 口径）：
 *   · 四个玩家按**方位**环形排布，不是四行顺序排列。
 *   · 方位由「摸风定座」决定：四家各抽一张，牌最大者坐东**并做庄**，其余依次南/西/北。
 *     （比牌：数字牌 > 字牌；数字按点数 9 最大、同点按万<筒<西… 见 game-loop.drawWindKey）
 *   · 你永远在下方；下家在右、对家在上、上家在左（出牌逆时针）。
 *     因此坐在哪一家的**方位徽章**会随摸风结果旋转。
 *   · 大家打出的牌统一汇到**牌桌中央的公共牌河**，默认按出牌先后「依次」铺开；
 *     点右上角按钮可切成「按家分组」。
 */

import {
  DIR_ORDER,
  seatLabel as rawSeatLabel,
  winnerHeadline,
  dirOf,
  relOf,
} from './game-loop.js';
import { tileName, RED_DRAGON } from '../src/engine/tiles.js';
import { HU_LABELS } from '../src/engine/score.js';
import {
  makeTileEl,
  makeTileBack,
  avatarEl,
  renderMelds,
  specialGangFor,
  tagEl,
} from './render-widgets.js';
import { state } from './render-state.js';
import { assertDriver } from './driver-contract.js';
import { $, esc, flash } from './ui-utils.js';
import { renderAchievementNotices, resetAchievementNotices } from './achievements.js';
import {
  showStats,
  showTenpai,
  buildDetailTable,
  currentTenpai,
} from './render-modals.js';

/* ------------------------------------------------------------------ */
/* 模块状态 —— 已抽到 render-state.js（渲染层共享状态，单一来源）         */
/*   本模块内部一律通过 `state.xxx` 读写；对外仍暴露同名 setter，          */
/*   引导入口（main.js / net-lobby.js）的 API 完全不变。                   */
/* ------------------------------------------------------------------ */

/** 注入驱动与钩子（各引导入口在启动时调用一次） */
export function init(h) {
  state.hooks = { ...state.hooks, ...h };
}

/* 每次 renderAll 收尾后的附加动作。3D 版用它把 #controls 重新锚回 #table3d：
   doAction() 成功后的 finally 会再调用一次 renderAll()，而 `renderMySeat` 会把操作条
   塞回隐藏的 2D 座位；若只依赖 applyPayload 里的 relocateHud，这一帧就会留在隐藏区。 */
const afterRenderHooks = [];
export function addAfterRender(fn) {
  if (typeof fn === 'function' && !afterRenderHooks.includes(fn)) afterRenderHooks.push(fn);
  return () => {
    const i = afterRenderHooks.indexOf(fn);
    if (i >= 0) afterRenderHooks.splice(i, 1);
  };
}

export function setGame(g) { state.game = assertDriver(g, 'setGame'); resetAchievementNotices(); }

/** 3D 网络版入口调用：关掉隐藏的 2D 牌桌表面渲染（座位卡/中央牌河），其余照常 */
export function set2dTableVisible(on) { state.show2dTable = !!on; }
export function setView(v) { state.view = v; }
export function getView() { return state.view; }
export function setMySeat(n) { state.mySeat = Number(n) || 0; }
export function setModeLabel(s) { state.modeLabel = s; }
export function setNewGameLabel(s) { state.newGameLabel = s || '再来一局'; }
export function resetSelection() { state.selectedTile = null; }
export function setReplayMode(on) {
  state.replay = !!on;
  state.gangNoDraw = false;
  if (!on) { state.replayNames = null; state.replayScores = null; }
}
export function setReplaySeatMeta(meta) {
  state.replayNames = meta && Array.isArray(meta.names) ? meta.names.slice() : null;
  state.replayScores = meta && Array.isArray(meta.scores) ? meta.scores.map(Number) : null;
}
export function getMatchStats() { return state.matchStats; }

/* ------------------------------------------------------------------ */
/* 统计（维度1/2/3：牌桌战绩面板 / 单局结算明细 / 分析报表）              */
/*   本模块只渲染，不持有数据——由 driver（main.js / net-lobby.js）注入      */
/*   一个 createMatchStats() 实例，每把结算后调用 addHand 喂数据。          */
/* ------------------------------------------------------------------ */

/** 外部注入「单场战绩」聚合器（单机会 / 网络版各创建一个并注入） */
export function setMatchStats(ms) { state.matchStats = ms; }


/* ------------------------------------------------------------------ */
/* 牌面 / 角标 —— makeTileEl / makeTileBack / badge / dirDot            */
/*   已移到 render-widgets.js（无状态小组件），此处从该模块 import。     */
/* ------------------------------------------------------------------ */

/** 方位徽章（东南西北 圆牌） */
function dirBadgeEl(seat) {
  const dir = dirOf(seat, state.game.seatToDir);
  const b = document.createElement('span');
  b.className = 'dir-badge dir-' + dir;
  b.textContent = dir;
  b.title = `方位：${dir}`;
  return b;
}

/* ------------------------------------------------------------------ */
/* 头像 + 累计战绩分（老吴 2026-10-03「照参考图改界面」）               */
/* ------------------------------------------------------------------ */
/* avatarEl 已移到 render-widgets.js（无状态小组件） */

/**
 * 累计战绩分徽章。
 * 数据源 = `state.matchStats`（frontend/stats.js，与「战绩」面板**同一个**聚合器），
 * 所以牌桌上的分和战绩面板里的分**必然一致**，不会出现两套口径。
 * ⚠️ 这里显示的是**本场净分**（真实对局成绩），不是金币 ——
 *    项目红线明确「不做充值/金币/兑换」，且引擎里根本没有金币字段，
 *    造假数字等于给用户看一个永远变不了的假账户。
 */
function seatScoreEl(seat) {
  const el = document.createElement('span');
  el.className = 'seat-score';
  let net = 0;
  let played = 0;
  const replay = state.replay && Array.isArray(state.replayScores);
  if (replay) {
    // 回放没有实时 matchStats，分数由 replay.js 按场次累计注入；
    // 即使尚未结算也要显示 0，不能像实时对局那样把徽章藏起来。
    net = Number(state.replayScores[seat]) || 0;
    played = 1;
  } else if (state.matchStats) {
    const ms = state.matchStats.getMatchStats();
    played = ms.hands;
    const hit = ms.players.find((p) => p.seat === seat);
    if (hit) net = hit.net | 0;
  }
  if (!played) {
    /* 一把没打时**不留空位也不画破折号** —— 参考图那种干净的头像条更接近，
       而徽章一旦常驻「—」，四家并排就像四个空标签。
       用 visibility 而非 display：座位行宽高不变（高度固定红线），只是看不见。 */
    el.textContent = '';
    el.classList.add('is-empty');
    el.title = '本场还没有已结算的牌局';
    return el;
  }
  el.classList.remove('is-empty');
  el.textContent = (net > 0 ? '+' : '') + net;
  /* ❗别写 `classList.add(net > 0 ? 'pos' : net < 0 ? 'neg' : '')` ——
     net 恰为 0 时会add('') 抛 `SyntaxError: The token provided must not be empty`，
     而它发生在 renderAll 里 → 整帧渲染中断 → 结算弹窗关不掉、摸风面板也不弹。
     老吴 2026-10-03 撞的就是这个（verify-ui 报「重新开局没重新摸风」，看着像摸风的锅）。 */
  if (net > 0) el.classList.add('pos');
  else if (net < 0) el.classList.add('neg');
  el.title = replay
    ? `回放当前累计净分：${net > 0 ? '+' : ''}${net}分`
    : `本场 ${played} 把累计净分：${net > 0 ? '+' : ''}${net}分`;
  return el;
}

/** 头像 + 昵称 + 累计分，合成一个 `.seat-id` 格 */
function seatIdEl(name, who, seat, avatar, active) {
  const box = document.createElement('span');
  box.className = 'seat-id';
  const av = avatarEl(name, avatar);
  if (active) av.classList.add('thinking');
  box.appendChild(av);
  const w = document.createElement('span');
  w.className = 'who';
  w.textContent = who;
  box.appendChild(w);
  box.appendChild(seatScoreEl(seat));
  return box;
}

/* ------------------------------------------------------------------ */
/* 副露                                                                */
/* ------------------------------------------------------------------ */

/* MELD_LABELS / renderMelds 已移到 render-widgets.js（无状态小组件） */

/* ------------------------------------------------------------------ */
/* 手牌（我的）                                                         */
/* ------------------------------------------------------------------ */

/* SPECIAL_GANG_LABEL / specialGangFor 已移到 render-widgets.js（无状态小组件） */

/** 我的当前下雨义务：按宣告顺序，第一场「我是义务人、手里还有该花色、尚未被记陪包」的雨。
 *  renderHand（描边）与 renderControls（提示）共用。 */
function myRainOf(v) {
  const myRains = Array.isArray(v && v.rains) ? v.rains : [];
  const hand = (v && v.me && v.me.hand) || [];
  return myRains.find((rn) => rn.owner !== state.mySeat
    && !rn.baos.includes(state.mySeat)
    && !rn.penalized.includes(state.mySeat)
    && hand.some((tc) => tc >= rn.color && tc < rn.color + 9)) ?? null;
}

function renderHand(container, v) {
  container.innerHTML = '';
  const canDiscard = !state.replay && v.phase === 'discard' && v.turn === state.mySeat;
  // 红中 → 皮子 → 赖子 → 普通，组内按牌值升序（老吴 2026-10-20 摆布口径）
  const skinSet = new Set(v.skinTiles || []);
  const rank = (t) => (t === 31 ? 0 : t === v.wildTile ? 2 : skinSet.has(t) ? 1 : 3);
  // 出牌阶段：刚摸的牌先从手牌里拆出来，独立放最右；打牌后手牌变 13 张自然按序（特殊牌仍最左）
  let hand = [...v.me.hand];
  let drawn = null;
  if (canDiscard && v.lastDraw != null) {
    const di = hand.indexOf(v.lastDraw);
    if (di >= 0) { drawn = v.lastDraw; hand.splice(di, 1); }
  }
  hand.sort((a, b) => rank(a) - rank(b) || a - b);
  const myRain = myRainOf(v);
  const rainColor = myRain ? myRain.color : null;
  const inRainSuit = (t) => rainColor !== null && rainColor !== undefined && t >= rainColor && t < rainColor + 9;
  const mkTile = (t, extra) => {
    const el = makeTileEl(t, v, {
      onClick: canDiscard ? () => onSelectTile(t) : null,
      onDblClick: canDiscard ? () => onPlayTile(t) : null,
    });
    if (canDiscard) el.classList.add('clickable');
    if (state.selectedTile === t) el.classList.add('selected');
    if (inRainSuit(t)) el.classList.add('rain-tile');
    if (extra) el.classList.add(extra);
    return el;
  };
  for (const t of hand) container.appendChild(mkTile(t));
  if (drawn != null) {
    const sep = document.createElement('span');
    sep.className = 'hand-draw-sep';
    container.appendChild(sep);
    container.appendChild(mkTile(drawn, 'drawn'));
  }
}

function onSelectTile(tile) {
  state.selectedTile = state.selectedTile === tile ? null : tile;
  renderAll();
}

/**
 * 双击手牌 —— 老吴 2026-10-27 口径（2026-09-30 旧口径作废）：
 *   · **红中 / 皮子 / 癞子 → 杠**（红中杠 / 皮子杠 / 癞子杠，都是「一张就能杠」；
 *     这三种牌规则上不能进牌河，杠是唯一动作）
 *   · 其余牌（含蓄杠 / 暗杠 / 冲杠的第 4 张）→ **直接打出**；
 *     杠一律点操作条上的「蓄杠 / 暗杠 / 杠」按钮（老吴：蓄杠双击误杠出去）
 * 红中/皮子/癞子不能进牌河（规则 specialTilesNoDiscard）；只有对应杠被规则关掉时，
 * 才允许按普通牌打出去。单击选中再点「出牌」的老路保留给普通牌。
 */
/**
 * 特殊杠动作必须和**当前这帧手牌/皮子/癞子**对得上，否则不展示、也不执行。
 * 防的是旧帧 / 错帧残留的「红中杠」：手里没有红中时，这个动作根本不该存在。
 */
function actionConsistent(a, v) {
  if (!a || !v) return false;
  const hand = (v.me && v.me.hand) || [];
  if (a.type === 'redgang') return a.tile === RED_DRAGON && hand.includes(RED_DRAGON);
  if (a.type === 'wildgang') return a.tile != null && a.tile === v.wildTile && hand.includes(a.tile);
  if (a.type === 'skingang') {
    return a.tile != null && a.tile !== RED_DRAGON && a.tile !== v.wildTile
      && (v.skinTiles || []).includes(a.tile) && hand.includes(a.tile);
  }
  if (a.type === 'an') return a.tile != null && hand.filter((t) => t === a.tile).length >= 4;
  if (a.type === 'xu') return a.tile != null && hand.includes(a.tile);
  return true;
}

function onPlayTile(tile) {
  const legal = ((state.view && state.view.me && state.view.me.legal) || [])
    .filter((a) => actionConsistent(a, state.view));
  // 有胡时禁止「顺手双击出牌」：必须先点「胡」，或点「过」放弃后再出牌。
  // 否则双击手牌会先把自己打成下一家回合，紧接着点胡就报「还没轮到你」。
  if (legal.some((a) => a.type === 'win')) {
    flash('能胡：请点「胡」，或点「过」后再出牌');
    return;
  }
  const gang = specialGangFor(tile, legal);
  if (gang) {
    doAction(gang);
    return;
  }
  const discard = legal.find((a) => a.type === 'discard' && a.tile === tile);
  if (discard) {
    doAction(discard);
    return;
  }
  flash(`${tileName(tile)} 现在打不出去`);
}

/* flash 已下沉到 ui-utils.js（与网络层共用同一份，见该文件注释）。 */

/* ------------------------------------------------------------------ */
/* 座位卡片（上 / 左 / 右 三家）                                         */
/* ------------------------------------------------------------------ */

/** 该座位是否正在行动（含出牌与响应两个阶段） */
function isActing(seat) {
  return state.game.actingSeat() === seat;
}

function seatMetaText(p) {
  return `剩 ${p.handCount} 张 · 打 ${p.discards.length}`;
}

function buildSeatHead(seat, { who, name, metaText, opened, active, dealer, avatar }) {
  const head = document.createElement('div');
  head.className = 'seat-head';
  head.appendChild(dirBadgeEl(seat));
  // 回放要看真名；实时对局仍显示「你 / 上家 / 对家 / 下家」。
  const replayName = state.replay && state.replayNames ? state.replayNames[seat] : null;
  const shownWho = replayName || who;
  // 头像 + 昵称 + 累计战绩分（name 缺失时退回 who，保证永远有头像）；
  // 轮到该座位行动时头像外圈流光（「他在思考」，老吴 2026-10-24）
  const idBox = seatIdEl(name || shownWho, shownWho, seat, avatar, active);
  if (replayName) idBox.title = `座位 ${seat + 1}${who && who !== replayName ? `（${who}）` : ''}`;
  head.appendChild(idBox);

  if (dealer) {
    const f = document.createElement('span');
    f.className = 'flag';
    f.textContent = '庄';
    head.appendChild(f);
  }

  const m = document.createElement('span');
  m.className = 'meta';
  m.textContent = metaText;
  head.appendChild(m);

  if (opened) {
    const f = document.createElement('span');
    f.className = 'flag';
    f.textContent = '已开口';
    head.appendChild(f);
  }
  if (active) {
    const f = document.createElement('span');
    f.className = 'turn-dot';
    f.textContent = '●行动中';
    head.appendChild(f);
  }
  return head;
}

function renderOtherSeat(el, seat, v) {
  el.innerHTML = '';
  const p = v.others.find((x) => x.seat === seat);
  if (!p) return;
  const active = isActing(seat);
  el.classList.toggle('active', active);
  el.appendChild(
    buildSeatHead(seat, {
      who: relOf(seat, state.mySeat),
      name: p.name,
      avatar: p.avatar,
      metaText: seatMetaText(p),
      opened: p.opened,
      active,
      dealer: v.dealer === seat,
    }),
  );
  const body = document.createElement('div');
  body.className = 'seat-body';

  // 老吴 2026-10-02：吃碰杠单独放在「牌上方」的区，不要和手牌堆在一起
  const meldsZone = document.createElement('div');
  meldsZone.className = 'melds-zone';
  const melds = document.createElement('div');
  melds.className = 'melds-row';
  renderMelds(melds, p.melds, v, 'tiny');
  meldsZone.appendChild(melds);

  // 老吴 2026-10-02：手牌按所坐方位真实摆成一行（上/下=横排，左/右=竖排）
  const handZone = document.createElement('div');
  handZone.className = 'hand-zone';
  // 老吴 2026-10-01：对家暗牌以「牌背」展示（只看张数，不露牌面）
  const backs = document.createElement('div');
  backs.className = 'hand-backs';
  if (Array.isArray(p.hand)) {
    // 终局摊牌（胡牌后先摊牌、等四家确认）：把别家手牌直接翻在桌面上，
    // 而不是只显示牌背 —— 老吴 2026-10-20「先在桌面上把四家的牌都展示出来」。
    backs.classList.add('revealed');
    for (const t of [...p.hand].sort((a, b) => a - b)) {
      backs.appendChild(makeTileEl(t, v, { tiny: true }));
    }
  } else {
    const n = p.handCount || 0;
    for (let i = 0; i < n; i++) backs.appendChild(makeTileBack());
  }
  handZone.appendChild(backs);

  body.appendChild(meldsZone);
  body.appendChild(handZone);
  el.appendChild(body);
}

/* ------------------------------------------------------------------ */
/* 我的座位                                                            */
/* ------------------------------------------------------------------ */

function renderMySeat(el, v) {
  /* ❗先把「操作区」和「自动过倒计时」**取出来再清空**。
     老吴 2026-10-01：这两个节点由 `#app` 搬进了本座位（按钮要显示在手牌上方），
     而 `el.innerHTML = ''` 会把已经搬进来的它们一起删掉 —— 但 JS 引用还在，
     清空后重新 append 即可（先取引用、后清空、再挂回，顺序不能反）。 */
  const controlsBox = document.getElementById('controls');
  const passTip = document.getElementById('auto-pass-tip');

  el.innerHTML = '';
  const active = isActing(state.mySeat);
  el.classList.toggle('active', active);

  el.appendChild(
    buildSeatHead(state.mySeat, {
      who: '你',
      name: v.me.name,
      avatar: v.me.avatar,
      metaText: `剩 ${v.me.hand.length} 张 · 打 ${v.me.discards.length}`,
      opened: v.me.opened,
      active,
      dealer: v.dealer === state.mySeat,
    }),
  );

  const body = document.createElement('div');
  body.className = 'seat-body';

  // 老吴 2026-10-02：吃碰杠单独放在「牌上方」的区，不要和手牌堆在一起
  const meldsZone = document.createElement('div');
  meldsZone.className = 'melds-zone';
  const melds = document.createElement('div');
  melds.className = 'melds-row';
  renderMelds(melds, v.me.melds, v, 'small');
  meldsZone.appendChild(melds);

  const title = document.createElement('div');
  title.className = 'me-title';
  title.textContent = '我的手牌';

  // 老吴 2026-10-02：手牌按所坐方位真实摆成一行（我永远在下方=横排）
  const handZone = document.createElement('div');
  handZone.className = 'hand-zone';
  const hand = document.createElement('div');
  hand.id = 'me-hand';
  renderHand(hand, v);
  handZone.appendChild(hand);

  body.appendChild(meldsZone);
  /* 老吴 2026-10-01：吃 / 碰 / 杠 / 胡 / 过 一律显示在**我的手牌正上方**，
     不再挂在牌桌外面（原来 #controls 是 #app 的子节点，落在整张桌子的下方）。 */
  if (controlsBox) body.appendChild(controlsBox);
  if (passTip) body.appendChild(passTip);
  body.appendChild(title);
  body.appendChild(handZone);
  el.appendChild(body);
}

/* ------------------------------------------------------------------ */
/* 中央：公共牌河 + 牌桌信息                                             */
/* ------------------------------------------------------------------ */

/** 四家的弃牌，按座位收集（自己从 v.me 取，因为 v.others 不含自己） */
function collectRivers(v) {
  const mine = { seat: state.mySeat, tiles: v.me.discards || [] };
  const others = v.others.map((p) => ({ seat: p.seat, tiles: p.discards || [] }));
  return [mine, ...others].sort((a, b) => a.seat - b.seat);
}

/** 按出牌先后铺开（每张牌带方位角标） */
function renderRiverSeq(board, v) {
  const log = v.discardLog || [];
  if (!log.length) {
    board.innerHTML = '<div class="river-empty">牌河还是空的</div>';
    return;
  }
  const row = document.createElement('div');
  row.className = 'river-row';
  const tiles = document.createElement('div');
  tiles.className = 'river-tiles';
  log.forEach((d, i) => {
    tiles.appendChild(
      makeTileEl(d.tile, v, {
        river: true,
        dir: dirOf(d.seat, state.game.seatToDir),
        last: i === log.length - 1,
        match: state.selectedTile !== null && d.tile === state.selectedTile,
      }),
    );
  });
  row.appendChild(tiles);
  board.appendChild(row);
}

/** 按家分组（按出牌顺序，从你开始 → 下家 → 对家 → 上家） */
function renderRiverBySeat(board, v) {
  const rivers = collectRivers(v);
  const ordered = [0, 1, 2, 3].map((k) => rivers.find((r) => r.seat === (state.mySeat + k) % 4)).filter(Boolean);
  const lastEntry = (v.discardLog || [])[v.discardLog.length - 1] || null;
  let any = false;
  for (const r of ordered) {
    if (!r.tiles.length) continue;
    any = true;
    const row = document.createElement('div');
    row.className = 'river-row';
    const label = document.createElement('span');
    label.className = 'river-label';
    label.appendChild(dirBadgeEl(r.seat));
    label.appendChild(document.createTextNode(r.seat === state.mySeat ? '你' : relOf(r.seat, state.mySeat)));
    row.appendChild(label);
    const tiles = document.createElement('div');
    tiles.className = 'river-tiles';
    r.tiles.forEach((t, i) => {
      const isLast = lastEntry && lastEntry.seat === r.seat && i === r.tiles.length - 1;
      tiles.appendChild(makeTileEl(t, v, {
        river: true,
        last: !!isLast,
        match: state.selectedTile !== null && t === state.selectedTile,
      }));
    });
    row.appendChild(tiles);
    board.appendChild(row);
  }
  if (!any) board.innerHTML = '<div class="river-empty">牌河还是空的</div>';
}

function renderCenter(el, v) {
  el.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'center-head';

  const items = [];
  const mk = (label) => {
    const s = document.createElement('span');
    s.className = 'center-item';
    const b = document.createElement('b');
    b.textContent = label;
    s.appendChild(b);
    return s;
  };

  // 癞子
  const wild = mk('癞子');
  if (v.wildTile !== null && v.wildTile !== undefined) wild.appendChild(makeTileEl(v.wildTile, v, {}));
  else wild.appendChild(document.createTextNode('（无）'));
  items.push(wild);

  // 皮子
  const skin = mk('皮子');
  if (v.skinTiles && v.skinTiles.length) {
    for (const t of v.skinTiles) skin.appendChild(makeTileEl(t, v, {}));
  } else {
    skin.appendChild(document.createTextNode('（无）'));
  }
  items.push(skin);

  // 原赖 / 风赖
  const tags = [];
  if (v.yuanLai) tags.push('原赖');
  if (v.fengLai) tags.push('风赖');
  if (tags.length) {
    const s = document.createElement('span');
    s.className = 'center-item';
    const t = document.createElement('span');
    t.className = 'tag';
    t.textContent = tags.join(' ');
    s.appendChild(t);
    items.push(s);
  }

  // 牌墙
  const wall = mk('牌墙');
  wall.appendChild(document.createTextNode(`${v.wallLeft} 张`));
  items.push(wall);

  // 庄家（用方位表示）
  const dl = mk('庄家');
  const chip = document.createElement('span');
  chip.className = 'dealer-chip';
  chip.textContent = `${dirOf(v.dealer, state.game.seatToDir)}${v.dealer === state.mySeat ? '（你）' : `·${relOf(v.dealer, state.mySeat)}`}`;
  dl.appendChild(chip);
  items.push(dl);

  // 最近打出
  // ⚠️ 不能只用 v.lastDiscard —— 引擎在下一家摸牌时会把它清成 null（`state.lastDiscard = null`），
  //    所以那样写大多数时候这一行根本不显示。兜底取全局流水的最后一张（= 牌河里最新的一张；
  //    响应阶段那张被碰/吃/杠的牌此时还在河里，正是我们要提示的）。
  const logTail = v.discardLog && v.discardLog.length ? v.discardLog[v.discardLog.length - 1] : null;
  const lastInfo = v.lastDiscard && v.lastDiscard.tile !== undefined ? v.lastDiscard : logTail;
  if (lastInfo) {
    const last = mk('最近打出');
    last.appendChild(makeTileEl(lastInfo.tile, v, { dir: dirOf(lastInfo.from ?? lastInfo.seat, state.game.seatToDir) }));
    items.push(last);
  }

  items.forEach((x) => head.appendChild(x));
  el.appendChild(head);

  const board = document.createElement('div');
  board.className = 'river-board';
  if (state.riverMode === 'seat') renderRiverBySeat(board, v);
  else renderRiverSeq(board, v);
  el.appendChild(board);

  // 老吴 2026-10-03：中央倒计时转盘（参考图那个大数字）。
  // ⚠️ 纯绝对定位（见 style.css 的 .center-dial），**不占布局、不新增网格行**，
  //    所以它出现/消失都不会动页面高度。数字由 updateResponseTimer 每 250ms 刷。
  const dial = document.createElement('div');
  dial.className = 'center-dial';
  dial.id = 'center-dial';
  dial.hidden = true;              // 默认没有倒计时；updateResponseTimer 决定显隐
  dial.innerHTML = '<b>0</b>';
  el.appendChild(dial);
}

/* ------------------------------------------------------------------ */
/* 控制按钮                                                            */
/* ------------------------------------------------------------------ */

function actionBtn(text, cls, onClick, disabled) {
  const b = document.createElement('button');
  b.className = 'act-btn ' + (cls || '');
  b.textContent = text;
  if (disabled) {
    // 非本家回合：响应按钮常显但置灰、不可点 —— 老吴 2026-10-26 修「碰家考虑时吃按钮消失」
    b.classList.add('pending');
    b.disabled = true;
  } else {
    b.disabled = !!state.actionPending;
    b.addEventListener('click', onClick);
  }
  return b;
}

/** 动作去重签名：chi 带 combos 需一并比较（网络版 myClaims 与 v.me.legal 据此合并） */
function actionSig(a) {
  if (a.type === 'chi') return 'chi:' + a.tile + ':' + JSON.stringify(a.combos || []);
  return a.type + ':' + (a.tile != null ? a.tile : '');
}

let lastGangPromptKey = '';

const NORMAL_GANG_TYPES = new Set(['xu', 'an', 'zhi']);
const GANG_TYPES = new Set(['xu', 'an', 'zhi', 'redgang', 'skingang', 'wildgang']);
/** 「杠后不摸牌」只对红中杠 / 皮子杠 / 癞子杠成立（老吴 2026-10-24）：
 *  特殊杠只走 1 张牌 = 等价于打出一张，不补摸直接过手；暗杠 / 蓄杠 / 明杠必须补摸。 */
const NODRAW_GANG_TYPES = new Set(['redgang', 'skingang', 'wildgang']);
/** 操作条上的杠按钮：暗杠/蓄杠/明杠带牌名（同型多张，防杠错）；
 *  特殊杠（红中/皮子/癞子杠）恒定一张，不带后缀（老吴 2026-10-24：皮子杠后面的牌名不要）。 */
function gangActionLabel(a) {
  const base = gangLabel(a);
  if (NODRAW_GANG_TYPES.has(a.type)) return base;
  return a.tile != null ? `${base}·${tileName(a.tile)}` : base;
}

function gangLabel(a) {
  if (a.type === 'xu') return '蓄杠';
  if (a.type === 'an') return '暗杠';
  if (a.type === 'zhi') return '杠';
  if (a.type === 'redgang') return '红中杠';
  if (a.type === 'skingang') return '皮子杠';
  if (a.type === 'wildgang') return '癞子杠';
  return '';
}

/** 本次动作是否带「杠后不摸牌」；按钮和双击手牌共用同一个开关。 */
function withGangNoDraw(action) {
  if (!action || !NODRAW_GANG_TYPES.has(action.type) || !state.gangNoDraw) return action;
  if (!state.view || state.view.phase !== 'discard' || state.view.turn !== state.mySeat) return action;
  return { ...action, noDraw: true };
}

function renderControls(container, v) {
  container.innerHTML = '';
  if (state.replay) {
    // 回放也保留提示行，让座位区与正常对局布局一致（老吴 2026-10-24）
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = v.phase === 'settled'
      ? '本局结束'
      : `等待 ${dirOf(state.game.actingSeat(), state.game.seatToDir) || ''} 家…`;
    container.appendChild(hint);
    return;
  }
  const legal = (v.me.legal || []).filter((a) => actionConsistent(a, v));
  // 网络对局（claim 阶段）：把「本家能做的响应」(state.game.myClaims) 也并入展示 ——
  // 当前回合可点的（在 legal 里）正常启用；非本家回合但本家能做的渲染为置灰「待响应」按钮
  // （点了服务端按 actingSeat 拒绝，落 [action-rejected] 日志，即「点了无效」）。
  // 老吴 2026-10-26：修「碰家考虑时吃按钮根本不出现 → 不存在手快抢吃」。
  const potential = (v.phase === 'claim' && state.game && Array.isArray(state.game.myClaims))
    ? state.game.myClaims
    : [];
  const legalSig = new Set(legal.map(actionSig));
  const extra = potential.filter((a) => a.type !== 'pass' && !legalSig.has(actionSig(a)));
  // 「杠后不摸牌」开关只在有特殊杠（红中/皮子/癞子）可选时出现 —— 暗杠/蓄杠/明杠必须补摸
  const nodrawGangActions = legal.filter((a) => NODRAW_GANG_TYPES.has(a.type));
  const myDiscardTurn = v.phase === 'discard' && v.turn === state.mySeat;
  if (!myDiscardTurn) state.gangNoDraw = false;

  if (nodrawGangActions.length) {
    const wrap = document.createElement('label');
    wrap.className = 'gang-nodraw';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!state.gangNoDraw;
    cb.disabled = !!state.actionPending;
    cb.addEventListener('change', () => {
      state.gangNoDraw = cb.checked;
      renderAll();
    });
    const text = document.createElement('span');
    text.textContent = '杠不摸牌';   // 2026-10-24 老吴：去掉括号说明文字
    wrap.append(cb, text);
    container.appendChild(wrap);
  }

  // 胡牌摊牌确认（老吴 2026-10-20）：四家手牌先摊在桌上，各家点「确认」；
  // 最后一家确认后才弹结算页。这里只显示进度 + 本人那颗「确认」按钮。
  if (v.phase === 'settled' && v.reveal && v.reveal.pending) {
    const total = v.reveal.total || 4;
    const n = (v.reveal.confirmed || []).length;
    const info = document.createElement('div');
    info.className = 'reveal-prompt';
    info.textContent = n >= total ? '四家已全部确认' : `摊牌确认中（${n}/${total}）`;
    container.appendChild(info);
    const confirm = legal.find((a) => a.type === 'confirm');
    if (confirm) {
      container.appendChild(actionBtn('确认', 'primary', () => doAction(confirm)));
    } else {
      const wait = document.createElement('div');
      wait.className = 'reveal-prompt reveal-wait';
      wait.textContent = '你已确认，等待其他玩家…';
      container.appendChild(wait);
    }
    return;
  }

  // 可杠提示（老吴 2026-10-20：碰后摸到第 4 张，操作条按钮太不起眼）：
  // 轮到自家出牌且出现杠动作时，弹一次 toast；按钮仍在操作条上（点它执行）。
  // 用「手牌数 + 已打张数 + 杠动作」去重，悬停/选中重绘不会反复弹。
  if (v.phase === 'discard' && v.turn === state.mySeat) {
    // 只提示普通杠（蓄杠/暗杠/冲杠）；红中/皮子/癞子杠按钮本来就很显眼，避免每回合刷屏
    const gangs = legal.filter((a) => NORMAL_GANG_TYPES.has(a.type));
    if (gangs.length) {
      const key = [v.me.hand.length, (v.me.discards || []).length,
        ...gangs.map((a) => `${a.type}:${a.tile}`).sort()].join('|');
      if (key !== lastGangPromptKey) {
        lastGangPromptKey = key;
        const a = gangs[0];
        const label = gangLabel(a);
        flash(`可${label}：${tileName(a.tile)}（点上方「${label}」）`);
      }
    }
  }

  // 胡牌提示（老吴 2026-10-01）：能胡时主动、显眼地提示，不再只是混在按钮里。
  // 三种来路：自摸（discard 阶段、刚摸到 v.lastDraw）、点炮（claim 阶段、刚打出 v.lastDiscard.tile）、
  // 抢杠胡（claim 阶段 + v.pendingXuGang，此时**没有** lastDiscard —— 进张是被加杠的那张）。
  const winAction = legal.find((a) => a.type === 'win');
  if (winAction) {
    const prompt = document.createElement('div');
    prompt.className = 'win-prompt';
    const qg = v.pendingXuGang;
    let whoTxt = '';
    let tileTxt = '';
    if (qg) {
      // 抢杠胡：被抢的那家正在补杠，胡的牌就是被加杠的那张
      tileTxt = tileName(qg.tile);
      whoTxt = `${dirOf(qg.seat, state.game.seatToDir)} 蓄杠`;
      prompt.classList.add('win-prompt-qg');
    } else if (v.phase === 'discard' && v.lastDraw != null) {
      tileTxt = tileName(v.lastDraw);
      whoTxt = '自摸';
    } else if (v.lastDiscard && v.lastDiscard.tile != null) {
      tileTxt = tileName(v.lastDiscard.tile);
      whoTxt = dirOf(v.lastDiscard.from, state.game.seatToDir) + ' 打出';
    }
    const mid = whoTxt && tileTxt ? `（${whoTxt} ${tileTxt}）` : (tileTxt ? `（${tileTxt}）` : (whoTxt ? `（${whoTxt}）` : ''));
    const head = qg ? '抢杠胡！' : '可以胡牌！';
    prompt.innerHTML = `🀄 <strong>${head}</strong>${mid}　点红色「胡」收分`;
    container.appendChild(prompt);
  }

  // 出牌确认 / 取消（仅我出牌阶段）
  if (v.phase === 'discard' && v.turn === state.mySeat && state.selectedTile !== null) {
    const t = legal.find((a) => a.type === 'discard' && a.tile === state.selectedTile);
    if (t) {
      container.appendChild(actionBtn(`出牌：${tileName(state.selectedTile)}`, 'primary', () => doAction(t)));
      container.appendChild(
        actionBtn('取消', 'ghost', () => {
          state.selectedTile = null;
          renderAll();
        }),
      );
    }
  }

  // 其余动作：胡、碰、吃（多方案）、各类杠、过
  // displayActions = 当前回合可点的(legal) + 本家能做的但非本家回合(extra, 置灰)
  const displayActions = legal
    .map((a) => ({ a, disabled: false }))
    .concat(extra.map((a) => ({ a, disabled: true })));
  for (const { a, disabled } of displayActions) {
    if (a.type === 'discard') continue; // 出牌走手牌点选
    const go = disabled ? () => {} : () => doAction(a);
    if (a.type === 'win') {
      // 老吴 2026-09-30：不需要「自摸」这个按钮，一律叫「胡」
      // （是不是自摸由引擎判定并在结算里体现，按钮文案不区分）
      container.appendChild(actionBtn('胡', 'win', go, disabled));
    } else if (a.type === 'peng') {
      container.appendChild(actionBtn('碰', 'act', go, disabled));
    } else if (a.type === 'chi') {
      (a.combos || []).forEach((combo) => {
        const txt = '吃 ' + combo.map((c) => tileName(c)).join('');
        container.appendChild(
          actionBtn(txt, 'act', disabled ? () => {} : () => doAction({ type: 'chi', seat: state.mySeat, tile: a.tile, tiles: combo }), disabled),
        );
      });
    } else if (a.type === 'zhi') {
      // 按钮叫「杠」，不叫「冲杠」—— 「冲杠」是本地自造词，武汉没这个说法（老吴 2026-10-03）。
      // 内部 type 仍是 'zhi'（判定规则没变），只改按钮文案。
      container.appendChild(actionBtn(gangActionLabel(a) + (state.gangNoDraw ? '（不补牌）' : ''), 'act', go, disabled));
    } else if (a.type === 'an') {
      container.appendChild(actionBtn(gangActionLabel(a) + (state.gangNoDraw ? '（不补牌）' : ''), 'act', go, disabled));
    } else if (a.type === 'xu') {
      container.appendChild(actionBtn(gangActionLabel(a) + (state.gangNoDraw ? '（不补牌）' : ''), 'act', go, disabled));
    } else if (a.type === 'wildgang') {
      container.appendChild(actionBtn(gangActionLabel(a) + (state.gangNoDraw ? '（不补牌）' : ''), 'act', go, disabled));
    } else if (a.type === 'redgang') {
      container.appendChild(actionBtn(gangActionLabel(a) + (state.gangNoDraw ? '（不补牌）' : ''), 'act', go, disabled));
    } else if (a.type === 'skingang') {
      container.appendChild(actionBtn(gangActionLabel(a) + (state.gangNoDraw ? '（不补牌）' : ''), 'act', go, disabled));
    } else if (a.type === 'pass') {
      container.appendChild(actionBtn('过', 'ghost', go, disabled));
    }
  }

  const hint = document.createElement('div');
  hint.className = 'hint';
  if (v.phase === 'settled') hint.textContent = '本局结束';
  else if (state.game.isMyTurn()) {
    if (v.phase === 'discard') {
      // 老吴 2026-09-30：有胡时也要允许「过」不胡 → 能胡时提示里有「过」这一项
      const canWin = legal.some((a) => a.type === 'win');
      hint.textContent = canWin
        ? '轮到你：可「胡」或点「过」不胡；也可双击手牌出牌'
        : '轮到你：双击手牌出牌；红中 / 皮子 / 癞子双击即杠';
    } else if (myRainOf(v)) {
      // 下雨义务（老吴 2026-10-25 修订③）：出牌时手里有该花色却未出 → 当场记陪包
      const rn = myRainOf(v);
      const suitName = rn.color === 0 ? '万' : rn.color === 9 ? '筒' : '条';
      hint.textContent = `【下雨】手中有${suitName}必须先打${suitName}，未下雨将陪包`;
    } else if ((v.rains || []).some((rn) => rn.penalized.includes(state.mySeat))) {
      hint.textContent = '【下雨】你未下雨，已被记陪包';
    } else {
      hint.textContent = v.pendingXuGang
        ? '轮到你：可以「抢杠胡」，或点「过」让他继续补杠'
        : '轮到你：选择吃 / 碰 / 杠 / 胡，或「过」不胡';
    }
  } else hint.textContent = `等待 ${dirOf(state.game.actingSeat(), state.game.seatToDir)} 家…`;
  container.appendChild(hint);
}

/* ------------------------------------------------------------------ */
/* 结算弹窗                                                            */
/*   老吴 2026-09-30 口径：「有赢家胡牌以后，弹出窗口，展示四家的牌，      */
/*   并分别显示各家的番数（如杠几番、开口几番）即可，不用展示算番细节」    */
/* ------------------------------------------------------------------ */

/* esc 已移到 render-widgets.js（无状态小组件） */

/** 座位 → 展示名（方位·相对称呼，转义后） */
function seatLabel(seat, r) {
  return esc(rawSeatLabel(seat, r, state.mySeat, state.game && state.game.seatToDir));
}

/** 本局是原赖 / 风赖（或两者同时）→ 展示名 */
function mulSourceName(r) {
  if (r.yuanLai && r.fengLai) return '原赖/风赖';
  if (r.yuanLai) return '原赖';
  if (r.fengLai) return '风赖';
  return '';
}

/* tagEl 已移到 render-widgets.js（无状态小组件） */

/** 一家的番数条目（赢家看 winnerFanDetails，输家看 payments[].fanDetails） */
function fanDetailsOf(seat, r) {
  if (seat === r.winnerSeat) return r.winnerFanDetails || [];
  const p = (r.payments || []).find((x) => x.seat === seat);
  return (p && p.fanDetails) || [];
}

/** 一家的番数合计 */
function fanTotalOf(seat, r) {
  if (seat === r.winnerSeat) return r.winnerFan ?? 0;
  const p = (r.payments || []).find((x) => x.seat === seat);
  return p ? p.fan : 0;
}

/** 一家的收付：赢家收钱，输家付钱；荒庄为 null */
function payOf(seat, r) {
  if (r.type !== 'win') return null;
  if (seat === r.winnerSeat) return r.totalWin ?? 0;
  const p = (r.payments || []).find((x) => x.seat === seat);
  return p ? p.pay : 0;
}

/** 按方位顺序（东→南→西→北）排四家，和牌桌/摸风面板一致 */
function seatsByDir() {
  const idx = (s) => DIR_ORDER.indexOf(dirOf(s, state.game.seatToDir));
  return [0, 1, 2, 3].sort((a, b) => idx(a) - idx(b));
}

/** 结算里的一家：方位 + 称呼 + 手牌/副露 + 番数条目 + 收付 */
function settleRow(seat, v, r) {
  const mine = seat === state.mySeat;
  const other = mine ? null : (v.others || []).find((x) => x.seat === seat);
  const hand = [...(mine ? v.me.hand || [] : (other && other.hand) || [])].sort((a, b) => a - b);
  const melds = (mine ? v.me.melds : other && other.melds) || [];

  // 赢家手牌补上最后胡的那张，并固定放在最右（老吴 2026-10-22）。
  // 自摸的牌已经在 14 张手牌里 → 先摘出来再放末尾；点炮/抢杠的手牌是 13 张 → 直接追加。
  let winTile = null;
  if (seat === r.winnerSeat) {
    winTile = Number.isInteger(r.winTile) ? r.winTile : null;
    if (winTile === null && r.selfDraw && Number.isInteger(v.lastDraw)) winTile = v.lastDraw;
    if (winTile === null && !r.selfDraw && v.lastDiscard && Number.isInteger(v.lastDiscard.tile)) {
      winTile = v.lastDiscard.tile;
    }
    if (winTile !== null && r.selfDraw) {
      const at = hand.indexOf(winTile);
      if (at >= 0) hand.splice(at, 1);
    }
  }

  const row = document.createElement('div');
  row.className = 'st-row' + (mine ? ' is-me' : '') + (seat === r.winnerSeat ? ' is-winner' : '');

  /* ---- 头部 ---- */
  const head = document.createElement('div');
  head.className = 'st-head';
  head.appendChild(dirBadgeEl(seat));

  const who = document.createElement('span');
  who.className = 'st-who';
  who.textContent = mine ? '你' : relOf(seat, state.mySeat);
  head.appendChild(who);

  // 玩家名称（老吴 2026-10-28：结算里要能看到真实用户名，不能只有方位/相对称呼）。
  // 网络版 view.me/others[].name = 服务端 username；单机版自己的 name 是「你」→ 不重复显示。
  const pname = mine ? (v.me && v.me.name) : (other && other.name);
  if (pname && pname !== '你' && pname !== who.textContent) {
    const nm = document.createElement('span');
    nm.className = 'st-name';
    nm.textContent = pname;
    head.appendChild(nm);
  }

  if (v.dealer === seat) head.appendChild(tagEl('庄'));
  if (seat === r.winnerSeat) head.appendChild(tagEl('赢家', 'win'));
  // 「未开口 / 被阳光」标签：未开口且没有红中/皮子/癞子杠才翻倍（暗杠不豁免）。
  // 否则「6 番却付 40 分」没法自己看懂（这是玩家状态，不是算番细节）。
  // ⚠️ 只在**这一笔真的被翻倍**时才标：金顶局 / 包牌局的 pay 会被整笔改写（金顶一律 10 分），
  //    那两种情况下「被阳光翻倍」并没有作用到金额上，标出来反而误导。
  const payRec = (r.payments || []).find((x) => x.seat === seat);
  const unopenedDoubled =
    !!payRec && payRec.sunny === true && r.topType !== 'goldTop' && !r.bao && !r.baozhuang;
  if (unopenedDoubled) head.appendChild(tagEl('未开口', 'unopened'));

  // 包胡 / 陪包（老吴 2026-10-30）：「有包胡或者陪包时，在结算页面相关玩家后标注出来」。
  // 依据是引擎归一过的 `result.baoRoles`（[{seat, kind:'bao'|'pei', amount}]），
  // 不从「付了多少分」倒推 —— 三家全掏的局里三家的 pay 一样，只有这个字段分得清责任。
  const baoRole = (r.baoRoles || []).find((x) => x.seat === seat);
  if (baoRole) {
    const pei = baoRole.kind === 'pei';
    head.appendChild(tagEl(pei ? '陪包' : '包胡', pei ? 'pei-bao' : 'bao-hu'));
  }

  // 计番条目并入第一行（老吴 2026-10-28：每个玩家两行 —— 上行 头像+计番+收付，下行 手牌）。
  // .st-fan 包装元素保留（verify-ui 以 `.st-fan .st-chip` 取证），只是挪进 .st-head。
  const fanWrap = document.createElement('div');
  fanWrap.className = 'st-fan';
  const fanSum = fanTotalOf(seat, r);
  const sum = document.createElement('span');
  sum.className = 'st-fan-total';
  sum.textContent = `${fanSum} 番`;
  fanWrap.appendChild(sum);

  const details = fanDetailsOf(seat, r);
  if (details.length) {
    for (const d of details) {
      const c = document.createElement('span');
      c.className = 'st-chip' + (d.key === 'bigHuBase' || d.key === 'smallHuBase' ? ' base' : '');
      c.textContent = `${d.name} ${d.fan}`;
      fanWrap.appendChild(c);
    }
  } else {
    const none = document.createElement('span');
    none.className = 'st-none';
    none.textContent = '无附加番';
    fanWrap.appendChild(none);
  }
  if (seat === r.winnerSeat && r.size) {
    fanWrap.appendChild(tagEl(r.size === 'big' ? '大胡' : '小胡', 'size'));
  }
  head.appendChild(fanWrap);

  const pay = payOf(seat, r);
  if (pay !== null) {
    const money = document.createElement('span');
    money.className = 'st-money' + (seat === r.winnerSeat ? ' gain' : pay > 0 ? ' lose' : '');
    money.textContent = seat === r.winnerSeat ? `收 +${pay} 分` : `付 ${pay} 分`;
    head.appendChild(money);
  }
  // 七皮 / 十杠成就奖（老吴 2026-10-25）：独立小账本，逐家标注「谁收多少、谁付多少」——
  // 否则「我打了十杠」的玩家只看到自己付 10，看不到三家各付金顶的进账。
  for (const b of r.bonuses || []) {
    if (b.seat === seat) {
      head.appendChild(tagEl(`${b.label} 收 +${b.amount}`, 'bonus-gain'));
    } else {
      const payed = (b.payers || []).find((x) => x.seat === seat);
      if (payed) head.appendChild(tagEl(`${b.label} 付 ${payed.pay}`, 'bonus-pay'));
    }
  }
  row.appendChild(head);

  /* ---- 牌：副露 + 手牌 ---- */
  const tiles = document.createElement('div');
  tiles.className = 'st-tiles';
  if (melds.length) {
    const m = document.createElement('span');
    m.className = 'st-melds';
    renderMelds(m, melds, v, 'tiny');
    tiles.appendChild(m);
  }
  for (const t of hand) tiles.appendChild(makeTileEl(t, v, { tiny: true }));
  if (winTile !== null) {
    const el = makeTileEl(winTile, v, { tiny: true });
    el.classList.add('st-hu-tile');
    el.title = '胡牌';
    tiles.appendChild(el);
  }
  row.appendChild(tiles);

  return row;
}

/** 结算弹窗内容（胡牌 / 荒庄两种）
 * 对局页与回放页共用：回放到达终局时也弹**同款只读汇总**（老吴 2026-10-29）。
 * 回放是复算播放、不等真人摊牌确认，故忽略 v.reveal.pending 门。 */
function renderSettle() {
  const box = $('settle');
  const v = state.view;
  // 非终局一律隐藏（回放未播到结算 / 已回拖到结算前都走这里）
  if (!box || !v || v.phase !== 'settled' || !v.result) {
    if (box) {
      box.hidden = true;
      const c = $('settle-card');
      c.innerHTML = '';
      c.style.zoom = '';
      c.style.height = '';
      c.style.maxHeight = '';
    }
    return;
  }
  const isReplay = state.replay;
  // 实时对局：四家摊牌确认（v.reveal.pending）完成前先不弹；回放忽略此门
  if (!isReplay && v.reveal && v.reveal.pending) {
    box.hidden = true;
    return;
  }
  const r = v.result;
  const card = $('settle-card');
  card.innerHTML = '';
  card.style.zoom = '';
  card.style.height = '';
  card.style.maxHeight = '';

  const h = document.createElement('h3');
  h.textContent = r.type === 'win' ? '本局结束' : '荒庄（流局）';
  card.appendChild(h);

  if (r.type === 'win') {
    // ⚠️ 文案：「你 胡牌（东·下家 点炮）」，绝不能写成「你 点炮胡牌」
    //    —— 「点炮」的主语是放炮那家，不是赢家（老吴 2026-09-30 报的 bug）。
    const hl = document.createElement('div');
    hl.className = 'st-headline';
    hl.textContent = winnerHeadline(r, state.mySeat, state.game && state.game.seatToDir);
    card.appendChild(hl);

    const bits = [];
    if (r.types && r.types.length) bits.push('番型：' + r.types.map((t) => HU_LABELS[t] || t).join(' + '));
    if (r.topType === 'goldTop') bits.push('金顶');
    if (r.baozhuang) bits.push(`承包：${seatLabel(r.baozhuang.seat, r)} 独付 ${r.baozhuang.amount} 分`);
    if (r.bao) bits.push(`包牌：${seatLabel(r.bao.seat, r)} 独付 ${r.bao.amount} 分`);
    if (Array.isArray(r.rainPayers) && r.rainPayers.length) {
      const baoNames = r.rainPayers.filter((x) => x.kind === 'bao').map((x) => x.name);
      const peiNames = r.rainPayers.filter((x) => x.kind === 'pei').map((x) => x.name);
      const parts = [];
      if (baoNames.length) parts.push(`包胡 ${baoNames.join('、')}`);
      if (peiNames.length) parts.push(`${peiNames.join('、')} 未下雨陪包`);
      if (parts.length) bits.push(`下雨：${parts.join('，')}（各付 ${r.rainPayers[0].amount}）`);
    }
    if ((r.mul ?? 1) > 1) bits.push(`${mulSourceName(r)}：本局分数 ×${r.mul}`);
    if (bits.length) {
      const sub = document.createElement('div');
      sub.className = 'st-sub';
      sub.textContent = bits.join('　·　');
      card.appendChild(sub);
    }
  }

  const list = document.createElement('div');
  list.className = 'st-list';
  for (const seat of seatsByDir()) list.appendChild(settleRow(seat, v, r));

  // 「本局战况」节标题（老吴 2026-10-28）：放在四家牌况框架上方。
  // 矮屏档 h3 会被隐藏（省一行高度给牌面），所以荒庄状态要并进这里；
  // ⚠️ verify-ui/viewport-check 以 h3 文本 `本局结束` 开头做等待判定，h3 文案不能改。
  const sec = document.createElement('div');
  sec.className = 'st-section';
  sec.textContent = r.type === 'win' ? '本局战况' : '荒庄（流局） · 本局战况';
  card.appendChild(sec);
  card.appendChild(list);

  if (r.type === 'win' && r.totalWin != null) {
    const total = document.createElement('div');
    total.className = 'st-total';
    total.textContent = `共 ${r.totalWin} 分`;
    card.appendChild(total);
  }
  if (r.bonuses && r.bonuses.length) {
    const b = document.createElement('div');
    b.className = 'st-sub';
    b.textContent = '成就奖金：' + r.bonuses.map((x) => {
      const payers = (x.payers || []).map((p) => `${p.name}付${p.pay}`).join('、');
      return `${x.name}·${x.label} 收 ${x.amount} 分（${payers}）`;
    }).join('，');
    card.appendChild(b);
  }

  const btn = document.createElement('button');
  btn.className = 'st-again';
  btn.type = 'button';
  if (isReplay) {
    // 回放只读汇总：不放「准备下一局」（会误开真实牌桌），改为「关闭」回看牌桌/进度条
    btn.textContent = '关闭';
    btn.addEventListener('click', () => { box.hidden = true; });
  } else {
    btn.textContent = state.newGameLabel;
    btn.addEventListener('click', newGame);
  }
  card.appendChild(btn);

  box.hidden = false;
  fitSettleCard(card);
}

/**
 * 结算弹窗自适应（老吴 2026-10-20：横屏矮屏也不要滚动条）。
 * 内容超出时用 CSS zoom 等比缩小（改变布局尺寸，不像 transform 那样留出溢出的占位）；
 * 桌面/竖屏内容放得下时不动。跑两帧：牌面字体/图片落定后高度可能再涨一点。
 */
function fitSettleCard(card) {
  // 3D 页不走「整卡 zoom 缩小」（老吴 2026-10-24：那正是结算牌面小的帮凶）——
  // 结算卡改为 弹性布局 + 列表内滚 + 92% 限高（百分比按旋转后的可视高算，dvh 会按物理竖屏高算错），
  // 按钮钉在卡内底部，永不溢出屏外。
  if (document.body.classList.contains('mode-3d')) return;
  const fit = () => {
    card.style.zoom = '';
    card.style.height = '';
    card.style.maxHeight = '';
    const need = card.scrollHeight;
    const avail = card.clientHeight;
    if (need > avail + 1 && avail > 0) {
      const k = Math.max(0.5, avail / need);
      card.style.zoom = k.toFixed(3);
      // zoom 会把卡片自身一起缩小：给足高度（=内容高 + 余量），
      // 缩放后的外框仍落在 avail 附近，内部不会再有滚动条。
      card.style.maxHeight = 'none';
      card.style.height = (need + 4) + 'px';
    }
  };
  fit();
  requestAnimationFrame(fit);
}

/* ------------------------------------------------------------------ */
/* 摸风定座面板                                                        */
/* ------------------------------------------------------------------ */

function renderSeatLine() {
  const parts = [];
  for (let k = 0; k < 4; k++) {
    const seat = (state.mySeat + k) % 4;
    const tag = seat === state.mySeat ? '你' : relOf(seat, state.mySeat);
    parts.push(`${tag}=${dirOf(seat, state.game.seatToDir)}`);
  }
  $('seatline').textContent = `${state.modeLabel} · ${parts.join(' · ')}`;
}



/* ------------------------------------------------------------------ */
/* 总渲染                                                              */
/* ------------------------------------------------------------------ */

function renderAll() {
  renderSeatLine();
  if (state.show2dTable !== false) {
    renderOtherSeat($('seat-top'), (state.mySeat + 2) % 4, state.view);
    renderOtherSeat($('seat-left'), (state.mySeat + 3) % 4, state.view);
    renderOtherSeat($('seat-right'), (state.mySeat + 1) % 4, state.view);
    renderMySeat($('seat-bottom'), state.view);
    renderCenter($('center'), state.view);
  } else {
    // 3D 模式（老吴 2026-10-25）：2D 表面整体跳过，不渲染也不留内容 ——
    // 操作条由 relocateHud 常驻 3D 画布，不再每帧搬回 2D 座位。
    for (const id of ['seat-top', 'seat-left', 'seat-right', 'seat-bottom', 'center']) {
      const el = document.getElementById(id);
      if (el && el.innerHTML) el.innerHTML = '';
    }
  }
  renderControls($('controls'), state.view);
  renderSettle();
  // 老吴 2026-10-01「页面高度固定」：#newgame 按钮**始终占位**，只是未到结算时置灰禁用。
  // 否则结算才出现的按钮会把顶栏挤宽 → 座位行文案换行 → 顶栏变高 → 牌桌被偷走十几像素。
  const ng = $('newgame');
  ng.disabled = state.view.phase !== 'settled'
    || !!(state.view.reveal && state.view.reveal.pending);
  // 战绩按钮同样「始终占位」，只有本场已有至少一把结算数据时才可点
  const sb = $('statsbtn');
  if (sb) sb.disabled = !(state.matchStats && state.matchStats.hasData());
  renderTenpaiButton();
  updateResponseTimer(state.view);
  renderAchievementNotices(state.view);
  for (const fn of afterRenderHooks) {
    try { fn(); } catch (_) { /* 附加渲染钩子异常不应拖垮主渲染 */ }
  }
}

/* ------------------------------------------------------------------ */
/* 8 秒不响应自动「过」（老吴 2026-10-01：原 claimTimeoutMs 仅服务端预留，   */
/* 单机版前端没驱动 → 未生效。这里在前端按同一语义实现：轮到人类响应且       */
/* 可「过」时倒计时 claimTimeoutMs，超时自动 pass，与引擎注释口径一致）      */
/* ------------------------------------------------------------------ */
let responseTimer = null;
let responseTick = null;
let responseDeadline = 0;
let responseTotalMs = 0;

/** 收起中央倒计时转盘（clearResponseTimer 统一调，避免残留上一局的圈） */
function hideDial() {
  const d = $('center-dial');
  if (d) { d.hidden = true; d.classList.remove('warn'); }
}

function clearResponseTimer() {
  if (responseTimer) { clearTimeout(responseTimer); responseTimer = null; }
  if (responseTick) { clearInterval(responseTick); responseTick = null; }
  responseDeadline = 0;
  responseTotalMs = 0;
  const tip = $('auto-pass-tip');
  if (tip) tip.hidden = true;
  hideDial();
}

function updateResponseTimer(v) {
  clearResponseTimer();
  if (state.replay) return;
  // 仅「轮到人类响应且存在『过』动作」时启动：claim 阶段必然有过；
  // 自摸可过（能胡时点「过」不胡）也覆盖。纯出牌阶段（必须出牌、无过）不动。
  const legal = (v.me && v.me.legal) || [];
  const passAction = legal.find((a) => a.type === 'pass');
  if (!state.game.isMyTurn() || !passAction) return;
  // 有胡可选时**绝不自动「过」**：8 秒倒计时原本会把已经够胡的玩家推进到
  // 弃牌/下家回合，随后再点「胡」就会看到「还没轮到你」。要过胡必须自己点「过」。
  if (legal.some((a) => a.type === 'win')) return;
  const ms = (state.game.ruleset && state.game.ruleset.claimTimeoutMs) || 8000;
  // 网络版由服务端兜底自动过（armClaimTimer），前端只显示倒计时、不重复发动作 ——
  // 否则两边各发一次 pass，第二次会被服务端判「还没轮到你」而报错。
  const localAuto = state.game.autoPassLocally !== false;
  responseDeadline = Date.now() + ms;
  responseTotalMs = ms;

  // 老吴 2026-10-03：中央大转盘（参考图那个倒计时）。
  // ⚠️ 无论 tip / dial 谁存在，这个 paint 都必须挂上 —— 否则网络版 tip 恒在，
  //    但万一哪天 tip 被隐藏，转盘就会僵住不动。paint 本身做双重判空。
  const tip = $('auto-pass-tip');
  const dial = $('center-dial');
  const dialNum = dial ? dial.querySelector('b') : null;
  const paint = () => {
    const left = Math.max(0, Math.ceil((responseDeadline - Date.now()) / 1000));
    if (tip) tip.textContent = `⏱ ${left} 秒后自动「过」`;
    if (dial && dialNum) {
      dialNum.textContent = String(left);
      // 环形进度：剩余比例 × 360°。≤3 秒开始脉冲提醒。
      const ratio = responseTotalMs ? Math.max(0, (responseDeadline - Date.now()) / responseTotalMs) : 0;
      dial.style.setProperty('--dial-deg', `${Math.round(ratio * 360)}deg`);
      dial.classList.toggle('warn', left <= 3);
    }
  };
  if (tip) tip.hidden = false;
  if (dial) dial.hidden = false;
  paint();
  responseTick = setInterval(paint, 250);

  if (!localAuto) return; // 网络版：倒计时照走，超时动作交给服务端
  responseTimer = setTimeout(() => {
    clearResponseTimer();
    // 二次校验：仍轮到人类且仍可过（期间状态未变）才代过，避免误触
    const cur = state.game.getView();
    if (state.game.isMyTurn() && (cur.me.legal || []).some((a) => a.type === 'pass')) {
      doAction(passAction);
    }
  }, ms);
}

/* ------------------------------------------------------------------ */
/* 听牌提示（老吴 2026-09-30）                                          */
/* ------------------------------------------------------------------ */


function renderTenpaiButton() {
  const btn = $('tenpaibtn');
  if (state.replay) { btn.hidden = true; $('tenpai').hidden = true; return; }
  const r = currentTenpai();
  // 老吴 2026-10-01「页面高度固定」：胡牌提示按钮**始终占位**，仅未听牌时置灰禁用，
  // 否则听牌时按钮出现会把顶栏挤宽 → 座位行文案换行 → 顶栏变高 → 牌桌随之抖动。
  btn.hidden = false;
  btn.disabled = !r;
  btn.textContent = r ? `胡牌提示 ${r.waits.length}` : '胡牌提示';
  if (!r) $('tenpai').hidden = true;
}


/* ------------------------------------------------------------------ */
/* 动作                                                                */
/* ------------------------------------------------------------------ */

/**
 * 玩家点了某个动作。这里**只做转发** —— 真正的推进由外部驱动负责：
 *   单机：humanAct → botStep → setView → renderAll（同步）
 *   网络：emit('action') → 等服务端 table:state 回来 → setView → renderAll（异步）
 * 之所以统一成 async，是因为网络版必须等一个往返；单机版 awaited 一个已 resolve
 * 的 Promise 没有额外开销。失败（如服务端判非法）时弹一条一闪提示，不静默吞掉。
 */
/** 当前视图里是否还存在这个动作（防旧按钮 / 旧计时器把过期动作发出去）。 */
function actionStillLegal(action) {
  const legal = state.view && state.view.me && state.view.me.legal;
  if (!Array.isArray(legal)) return true;
  return legal.some((a) => {
    if (a.type !== action.type) return false;
    if (a.tile != null && action.tile != null && a.tile !== action.tile) return false;
    return true;
  });
}

async function doAction(action) {
  if (state.actionPending) return;
  if (!actionConsistent(action, state.view) || !actionStillLegal(action)) {
    state.selectedTile = null;
    flash('这手已失效，已按最新牌局继续');
    renderAll();
    return;
  }
  state.actionPending = true;
  state.selectedTile = null;
  const outgoing = withGangNoDraw(action);
  renderAll();
  try {
    const ret = state.hooks.onAction(outgoing);
    if (ret && typeof ret.then === 'function') await ret;
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (/还没轮到你|当前没有可胡的牌|非法动作|本轮已经过|刚吃\/碰过/.test(msg)) {
      flash('这手已失效，已按最新牌局继续');
    } else {
      flash('操作失败：' + msg);
    }
  } finally {
    state.actionPending = false;
    renderAll();
  }
}

function newGame() {
  state.selectedTile = null;
  state.actionPending = false;
  state.gangNoDraw = false;
  state.hooks.onNewGame();
}

/* ------------------------------------------------------------------ */
/* 启动（事件接线；具体驱动由引导入口 init() 注入）                      */
/* ------------------------------------------------------------------ */

$('newgame').addEventListener('click', newGame);
$('tenpaibtn').addEventListener('click', showTenpai);
$('statsbtn').addEventListener('click', showStats);
// 点弹窗遮罩（非卡片区）关闭统计弹窗
$('stats').addEventListener('click', (e) => { if (e.target === $('stats')) hideStats(); });
// 结算弹窗在 844×390 / 桌面之间切换时，重新做一次等比适配（老吴 2026-10-20）
globalThis.addEventListener('resize', () => {
  const box = $('settle');
  if (box && !box.hidden) fitSettleCard($('settle-card'));
});
$('rivermode').addEventListener('click', () => {
  state.riverMode = state.riverMode === 'seq' ? 'seat' : 'seq';
  $('rivermode').textContent = state.riverMode === 'seq' ? '牌河：依次' : '牌河：按家';
  renderCenter($('center'), state.view);
});

// setMatchStats 已在上面用 `export function` 就地导出，这里不要重复列
export { renderAll, showTenpai, showStats };

