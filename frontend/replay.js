/**
 * 牌局回放（网络版 2D / 3D 共用）
 *
 * 数据来自服务端 /api/replays/*：每把牌保存了 seed / ruleset / 庄家 / 上一把癞子 /
 * 四家名字 / 全量动作日志。这里用同一套引擎 createGame + act 逐动作复算，
 * 再套上 render.js 现有的牌桌画法 —— 所以回放与真实对局不会出现两套规则。
 *
 * 回放模式下：
 *   · 四家手牌全程明牌（viewFor 只给张数，这里用完整 state 覆盖 others.hand）；
 *   · 可切换任意玩家主视角（setMySeat 后重绘，座位方位跟着旋转）；
 *   · 禁用出牌 / 响应 / 听牌 / 结算弹窗，只保留工具栏上的播放控制。
 */

import { createGame, act, viewFor } from '../src/engine/game.js';
import { windsFromDealer } from './game-loop.js';
import {
  setGame,
  setView,
  setMySeat,
  setModeLabel,
  setNewGameLabel,
  setMatchStats,
  getMatchStats,
  setReplayMode,
  setReplaySeatMeta,
  renderAll,
  addAfterRender,
} from './render.js';
import { $, flash } from './ui-utils.js';

/** 每个动作的播放间隔：接近真人平均出牌节奏，保证能看清每一张。 */
const STEP_MS = 800;
const TOKEN_KEY = 'mahjon:net:token';

const R = {
  getClub: () => null,
  getUser: () => null,
  onExit: () => {},
  replay: null,     // 详情对象（含 actions）
  session: null,    // 从场次列表进入时带上的整场（用于当前累计分）
  state: null,      // 当前回放到的引擎状态
  view: null,
  step: 0,
  maxStep: 0,
  mySeat: 0,
  timer: null,
  prevStats: null,
  barBound: false,
  overlay: null,
  listTitle: '',
  listSeq: 0,
  listKind: 'club',
  listSessions: [],
  listPath: '',
  listOffset: 0,
  listHasMore: false,
  returnSession: null,
  exitView: 'club',
};

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const token = () => {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
};

async function api(path) {
  const t = token();
  if (!t) throw new Error('请先登录');
  const res = await fetch(path, { headers: { authorization: `Bearer ${t}` } });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok) throw new Error((data && data.error) || `请求失败（${res.status}）`);
  return data;
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function resultText(replay) {
  const r = replay && replay.result;
  if (!r || !r.type) return '结果未知';
  if (r.type !== 'win') return '荒庄';
  const winner = replay.players && replay.players.find((p) => p.seat === r.winnerSeat);
  const name = winner ? winner.username : `座位${(r.winnerSeat ?? 0) + 1}`;
  return `${name} 胡${r.totalWin != null ? ` · ${r.totalWin} 分` : ''}`;
}

function playerNames(replay) {
  const names = (replay && replay.names) || [];
  return [0, 1, 2, 3].map((i) => names[i] || `座位${i + 1}`);
}

/** 一把回放的每家分数（优先逐家 delta；旧数据退回 payments 口径） */
function handScores(hand) {
  const out = [0, 0, 0, 0];
  if (!hand) return out;
  if (Array.isArray(hand.scores)) {
    for (const p of hand.scores) {
      const seat = Number(p && p.seat);
      if (Number.isInteger(seat) && seat >= 0 && seat < 4) out[seat] += Number(p.score) || 0;
    }
  }
  return out;
}

/**
 * 回放当前这一帧的「场次累计分」。
 * 场次列表已经算好整场总分，这里用「整场总分 - 当前把之后的各把」得到当前把结算后的分；
 * 若当前把还没打到结算，再把当前把本身的分数减掉，就是这把开始前的分。
 */
function currentSeatScores() {
  const zero = [0, 0, 0, 0];
  if (!R.replay) return zero;
  const session = R.session;
  const hands = (session && session.hands) || [];
  const totals = (session && session.players) || null;
  const idx = hands.findIndex((h) => h && h.id === R.replay.id);
  if (Array.isArray(totals) && idx >= 0) {
    const out = [0, 0, 0, 0];
    for (const p of totals) {
      const seat = Number(p && p.seat);
      if (Number.isInteger(seat) && seat >= 0 && seat < 4) out[seat] = Number(p.score) || 0;
    }
    for (let i = idx + 1; i < hands.length; i++) {
      const s = handScores(hands[i]);
      for (let seat = 0; seat < 4; seat++) out[seat] -= s[seat];
    }
    if (!(R.state && R.state.phase === 'settled')) {
      const s = handScores(hands[idx]);
      for (let seat = 0; seat < 4; seat++) out[seat] -= s[seat];
    }
    return out;
  }
  // 没有场次上下文（例如老入口直接打开单把）：只显示本把已结算的分数。
  if (R.state && R.state.phase === 'settled' && R.state.result && Array.isArray(R.state.result.perSeat)) {
    for (const p of R.state.result.perSeat) {
      const seat = Number(p && p.seat);
      if (Number.isInteger(seat) && seat >= 0 && seat < 4) zero[seat] += Number(p.delta) || 0;
    }
  }
  return zero;
}

/* ------------------------------------------------------------------ */
/* 列表                                                                */
/* ------------------------------------------------------------------ */

function ensureOverlay() {
  if (R.overlay) return R.overlay;
  const box = el('div', 'rp-overlay');
  box.id = 'replay-list';
  box.hidden = true;
  const card = el('div', 'rp-card');
  const head = el('div', 'rp-list-head');
  const title = el('h2', '', '牌局回放');
  title.id = 'rp-list-title';
  const close = el('button', 'lb-btn ghost', '关闭');
  close.type = 'button';
  close.addEventListener('click', closeList);
  head.appendChild(title);
  head.appendChild(close);
  const body = el('div', 'rp-list-body');
  body.id = 'rp-list-body';
  card.appendChild(head);
  card.appendChild(body);
  box.appendChild(card);
  box.addEventListener('click', (e) => { if (e.target === box) closeList(); });
  document.body.appendChild(box);
  R.overlay = box;
  return box;
}

function closeList() {
  if (R.overlay) R.overlay.hidden = true;
}

const signed = (n) => (n > 0 ? `+${n}` : String(n));

function fmtClock(ts) {
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtRange(start, end) {
  if (!start) return '';
  const tail = end && end > start + 59 ? ` – ${fmtClock(end)}` : '';
  return `${fmtTime(start)}${tail}`;
}

function scoreChips(players, className = '') {
  const box = el('div', `rp-scores ${className}`.trim());
  for (const p of players || []) {
    const chip = el('span', 'rp-score');
    if (p.score > 0) chip.classList.add('pos');
    else if (p.score < 0) chip.classList.add('neg');
    chip.textContent = `${p.username} ${signed(p.score)}`;
    box.appendChild(chip);
  }
  return box;
}

function listTitleFor(kind) {
  const club = R.getClub();
  return kind === 'mine'
    ? '我的回放 · 所有俱乐部'
    : `俱乐部回放 · ${club ? club.name : ''}`;
}

function renderSessionList() {
  const body = $('rp-list-body');
  $('rp-list-title').textContent = listTitleFor(R.listKind);
  body.innerHTML = '';
  if (!R.listSessions.length) {
    body.appendChild(el('div', 'lb-empty', '还没有可以回放的场次。打完一场后会自动保存。'));
    return;
  }
  const personal = R.listKind === 'mine';
  for (const s of R.listSessions) body.appendChild(sessionRow(s, personal));
  if (R.listHasMore) {
    const more = el('button', 'lb-btn ghost rp-more', '加载更多');
    more.type = 'button';
    more.addEventListener('click', async () => {
      more.disabled = true;
      more.textContent = '加载中…';
      try {
        const d = await api(`${R.listPath}?limit=50&offset=${R.listOffset}`);
        R.listSessions.push(...((d && d.sessions) || []));
        R.listOffset = (d && d.offset != null ? d.offset : R.listOffset) + ((d && d.sessions) || []).length;
        R.listHasMore = !!(d && d.hasMore);
        renderSessionList();
      } catch (e) {
        more.disabled = false;
        more.textContent = '加载更多';
        flash(e.message || '加载失败');
      }
    });
    body.appendChild(more);
  }
}

function backToSessionList() {
  R.returnSession = null;
  if (R.listSessions.length) {
    ensureOverlay().hidden = false;
    renderSessionList();
    return;
  }
  openReplayList(R.listKind).catch((e) => flash(e.message));
}

async function openReplayList(kind) {
  const club = R.getClub();
  if (kind === 'club' && !club) return flash('先进入一个俱乐部');
  const box = ensureOverlay();
  const title = $('rp-list-title');
  const body = $('rp-list-body');
  const seq = ++R.listSeq;
  const clubsView = $('clubs-view');
  R.listKind = kind;
  R.listSessions = [];
  R.listOffset = 0;
  R.listHasMore = false;
  R.returnSession = null;
  R.exitView = kind === 'mine' && clubsView && !clubsView.hidden ? 'clubs' : 'club';
  title.textContent = listTitleFor(kind);
  body.innerHTML = '';
  body.appendChild(el('div', 'lb-empty', '加载中…'));
  box.hidden = false;

  R.listPath = kind === 'mine'
    ? '/api/replays/sessions/mine'
    : `/api/clubs/${club.id}/replays/sessions`;

  try {
    const d = await api(`${R.listPath}?limit=50`);
    if (seq !== R.listSeq) return;
    R.listSessions = (d && d.sessions) || [];
    R.listOffset = (d && d.offset != null ? d.offset : 0) + R.listSessions.length;
    R.listHasMore = !!(d && d.hasMore);
    renderSessionList();
    // 2026-10-29 权限收紧的可见提示：普通成员在俱乐部维度只拿到「自己参与的场次」，
    // 不说明一句容易让人以为「回放丢了」。
    if (d && d.scope === 'self') {
      body.insertBefore(
        el('div', 'lb-empty', '仅显示我参与过的场次（别人的牌局只有主席 / 管理员可看）'),
        body.firstChild,
      );
    }
  } catch (e) {
    if (seq !== R.listSeq) return;
    body.innerHTML = '';
    body.appendChild(el('div', 'lb-empty', e.message || '加载失败'));
  }
}

function sessionRow(s, personal) {
  const b = el('button', 'rp-item');
  b.type = 'button';

  const title = el('div', 'rp-item-title');
  title.textContent = `${personal && s.clubName ? `${s.clubName} · ` : ''}${s.tableName || `牌桌 #${s.tableId}`}`;
  b.appendChild(title);

  const meta = el('div', 'rp-item-meta');
  meta.textContent = `${fmtRange(s.startTs, s.endTs)} · ${s.handCount} 把 · 点开选局`;
  b.appendChild(meta);
  b.appendChild(scoreChips(s.players));

  b.addEventListener('click', () => showSession(s));
  return b;
}

function showSession(s) {
  ensureOverlay().hidden = false;
  const title = $('rp-list-title');
  const body = $('rp-list-body');
  title.textContent = `${s.clubName ? `${s.clubName} · ` : ''}${s.tableName || `牌桌 #${s.tableId}`}`;
  body.innerHTML = '';

  const back = el('button', 'lb-btn ghost rp-back', '← 返回场次');
  back.type = 'button';
  back.addEventListener('click', backToSessionList);
  body.appendChild(back);

  const head = el('div', 'rp-session-head');
  head.appendChild(el('div', 'rp-session-title', `${fmtRange(s.startTs, s.endTs)} · 共 ${s.handCount} 把`));
  head.appendChild(scoreChips(s.players, 'rp-session-scores'));
  body.appendChild(head);
  body.appendChild(el('div', 'rp-section-label', '选择一把播放'));

  for (const hand of s.hands || []) {
    const b = el('button', 'rp-item rp-hand');
    b.type = 'button';
    const main = el('div', 'rp-hand-main');
    main.appendChild(el('div', 'rp-item-title', `第 ${hand.handNo} 把 · ${fmtTime(hand.ts)}`));
    main.appendChild(el('div', 'rp-item-meta', hand.text || '结果未知'));
    b.appendChild(main);
    b.appendChild(scoreChips(hand.scores, 'rp-hand-scores'));
    b.addEventListener('click', () => { openReplay(hand.id, s).catch((e) => flash(e.message)); });
    body.appendChild(b);
  }
}

/* ------------------------------------------------------------------ */
/* 播放器                                                              */
/* ------------------------------------------------------------------ */

function ensureBar() {
  // 回放控件不再占用 #play 顶部（否则把 #table3d 挤矮、3D 牌面变小）：
  //   · #rp-info   贴画布底部木纹区，纯文字显示「回放 · 俱乐部·牌桌·第X把·结果」
  //   · #rp-tools  钉在「右侧我的下家(E)头像」正下方（与对局托管条同槽位）
  // 两者都挂在 #table3d 内，随 3D 标签坐标定位（pinReplayControls）。
  if ($('rp-info') && $('rp-tools')) return $('rp-info');
  const host = document.getElementById('table3d') || $('play');
  const info = document.createElement('div');
  info.id = 'rp-info';
  info.innerHTML = '<span class="rp-prefix">回放</span><span id="rp-meta"></span>';
  const tools = document.createElement('div');
  tools.id = 'rp-tools';
  tools.innerHTML = `
      <label class="rp-seat">主视角 <select id="rp-seat"></select></label>
      <button class="lb-btn" id="rp-prev" type="button">上一步</button>
      <button class="lb-btn primary" id="rp-play" type="button">播放</button>
      <button class="lb-btn" id="rp-next" type="button">下一步</button>
      <span class="rp-step" id="rp-step"></span>
      <button class="lb-btn warn" id="rp-exit" type="button">退出</button>`;
  host.appendChild(info);
  host.appendChild(tools);
  if (!R.barBound) {
    R.barBound = true;
    $('rp-seat').addEventListener('change', (e) => {
      R.mySeat = Number(e.target.value) || 0;
      if (R.state) R.view = makeView(R.state);
      paint();
    });
    $('rp-prev').addEventListener('click', () => {
      pause();
      rebuild(Math.max(0, R.step - 1));
    });
    $('rp-next').addEventListener('click', () => {
      pause();
      if (R.step < R.maxStep) applyNext();
      paint();
    });
    $('rp-play').addEventListener('click', () => { R.timer ? pause() : play(); });
    $('rp-exit').addEventListener('click', exitPlayer);
  }
  return info;
}

/**
 * 读 3D 座位标签的**本地坐标**矩形（与 net3d-main.labelLocal 同源：解析
 * updateReplayLabels 写入的 translate，rotation-proof）。
 * @param {string} key 座位键 W/S/E/N（E = 我的右侧 = 我的下家）
 */
function r3LabelLocal(key) {
  const el = document.querySelector(`#table3d .r3d-seat-label[data-seat-key="${key}"]`);
  if (!el || el.hidden) return null;
  const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el.style.transform || '');
  if (!m) return null;
  return { x: +m[1], y: +m[2], w: el.offsetWidth || 64, h: el.offsetHeight || 66 };
}

/** 把回放工具箱 #rp-tools 钉到「右侧我的下家(E)头像」正下方（与对局托管条同槽）。 */
function pinReplayControls() {
  const tools = document.getElementById('rp-tools');
  const box = document.getElementById('table3d');
  if (!tools || !box || tools.hidden) return;
  const eL = r3LabelLocal('E');
  if (!eL) return;
  const bw = box.clientWidth || 0;
  const bh = box.clientHeight || 0;
  /* 先拿 E 手牌列的屏幕范围（老吴 2026-10-30 十五轮：下家整列被推到桌沿后，工具箱钉「E 卡左缘」
     会盖住手牌 —— 实测 1280 宽下工具条 1119~1259、手牌列 1159~1202 完全重叠）。 */
  let spanE = null;
  try {
    const r3 = window.__net3d && window.__net3d.renderer;
    spanE = r3 && typeof r3.seatHandSpan === 'function' ? r3.seatHandSpan('E') : null;
  } catch (_) { /* 渲染器还没挂上：退回旧对齐 */ }
  /* 可用横向空间：有手牌列时用「画布左缘 → 列左缘」整条（工具条会退到列左侧，宽度绰绰有余，
     否则 maxWidth 只有 ~90px 会把「主视角 xxx」那一行切掉）；无列信息时退回 E 卡右侧那条窄带。 */
  /* 上限 196（= 旧布局里「E 卡左缘 → 画布右缘」的宽度，实测正好让「主视角 xxx」占满一行、
     按钮换到第二行）：再宽就变成横贯半个牌桌的长条，并且会把「上一步」挤进第一行、把视角文字切掉。 */
  const maxW = Math.max(140, spanE ? Math.min(196, spanE.left - 24) : bw - eL.x - 6);
  tools.style.maxWidth = maxW + 'px';
  const th = tools.offsetHeight || 40;
  const tw = tools.offsetWidth || maxW;
  const top = eL.y + eL.h + 6;
  tools.style.position = 'absolute';
  if (spanE) {
    /* 右缘钉在「手牌列左缘 - 16」：工具条换行后宽度会变，用 left 定位的话「测到的宽」与
       「最终渲染的宽」差 10px 就压手牌（实测反复）；right 定位对宽度免疫。
       余量 6→16 是因为 right 的参照系是 #table3d 的 padding box、seatHandSpan 给的是视觉坐标，
       两者实测恒差 ~10px。 */
    tools.style.left = 'auto';
    tools.style.right = Math.max(4, bw - spanE.left + 16) + 'px';
  } else {
    // 理想：左缘对齐 E 卡；E 卡贴桌沿后装不下，就右缘对齐 E 卡右缘（不左飘、也不出屏）。
    const left = (eL.x + tw + 6 <= bw) ? eL.x : eL.x + eL.w - tw;
    tools.style.left = Math.max(4, Math.min(left, bw - tw - 6)) + 'px';
    tools.style.right = 'auto';
  }
  tools.style.top = Math.max(4, Math.min(top, bh - th - 4)) + 'px';
  tools.style.zIndex = '6';
}

// 回放每帧（renderAll 收尾）把工具箱钉到下家头像下；resize 时也重钉。
addAfterRender(() => {
  if (document.body.classList.contains('replay-mode')) pinReplayControls();
});
window.addEventListener('resize', () => requestAnimationFrame(pinReplayControls));

function makeView(state) {
  const v = viewFor(state, R.mySeat);
  const names = playerNames(R.replay);
  v.replay = true; // 渲染层据此：暗杠恒「一正三背」、结算弹窗照旧隐藏
  v.others = v.others.map((o) => {
    const p = state.players.find((x) => x.seat === o.seat);
    // 四家手牌完全显示 + 副露用真实牌（暗杠掩码在这里放开，显示仍是一正三背）
    return { ...o, name: names[o.seat] || o.name, hand: p ? [...p.hand] : [], melds: p ? p.melds : [] };
  });
  return v;
}

function paint() {
  if (!R.state) return;
  setReplaySeatMeta({ names: playerNames(R.replay), scores: currentSeatScores() });
  setMySeat(R.mySeat);
  setView(R.view);
  renderAll();
  updateBar();
}

function updateBar() {
  // 控件已拆成 #rp-info / #rp-tools（不再有 #replay-bar），守卫改用 #rp-info。
  if (!R.replay || !$('rp-info')) return;
  const r = R.replay;
  $('rp-meta').textContent = `${r.clubName || ''} · ${r.tableName || `牌桌 #${r.tableId}`} · 第 ${r.handNo} 把 · ${resultText(r)}`;
  $('rp-step').textContent = `${R.step} / ${R.maxStep}`;
  $('rp-prev').disabled = R.step <= 0;
  $('rp-next').disabled = R.step >= R.maxStep;
  const playBtn = $('rp-play');
  playBtn.textContent = R.timer ? '暂停' : '播放';
  playBtn.disabled = R.maxStep === 0;
}

function advance() {
  if (R.step >= R.maxStep) return false;
  const item = R.replay.actions[R.step];
  if (!item || !item.action) return false;
  try {
    act(R.state, { ...item.action, seat: item.seat });
  } catch (e) {
    flash(`回放到第 ${R.step + 1} 步失败：${(e && e.message) || e}`);
    return false;
  }
  R.step++;
  R.view = makeView(R.state);
  return true;
}

function applyNext() {
  const ok = advance();
  if (ok) paint();
  return ok;
}

function rebuild(step) {
  const r = R.replay;
  if (!r) return;
  const target = Math.max(0, Math.min(step, R.maxStep));
  const st = createGame({
    seed: r.seed,
    ruleset: r.ruleset,
    dealer: r.dealer,
    prevWildTile: r.prevWildTile,
    prevWinnerSeat: r.prevWinnerSeat == null ? null : r.prevWinnerSeat,
    names: playerNames(r),
  });
  R.state = st;
  R.step = 0;
  for (let i = 0; i < target; i++) {
    if (!advance()) break;
  }
  R.view = makeView(R.state);
  paint();
}

function play() {
  if (R.timer || !R.replay) return;
  if (R.step >= R.maxStep) rebuild(0);
  R.timer = setInterval(() => {
    if (!advance()) { pause(); return; }
    paint();
  }, STEP_MS);
  updateBar();
}

function pause() {
  if (R.timer) clearInterval(R.timer);
  R.timer = null;
  updateBar();
}

function driverFor(replay) {
  return {
    get seatToDir() { return windsFromDealer(replay.dealer).seatToDir; },
    get winds() { return windsFromDealer(replay.dealer); },
    actingSeat: () => (R.state && R.state.phase !== 'settled' ? R.state.turn : -1),
    isMyTurn: () => false,
    getView: () => R.view,
    getTenpai: () => null,
    get ruleset() { return replay.ruleset; },
    autoPassLocally: false,
    onAction: async () => {},
  };
}

async function openReplay(id, fromSession = null) {
  const d = await api(`/api/replays/${id}`);
  const replay = d && d.replay;
  if (!replay) throw new Error('回放不存在');

  closeList();
  R.returnSession = fromSession || null;
  R.session = fromSession || null;
  R.replay = replay;
  R.maxStep = (replay.actions || []).length;

  const user = R.getUser && R.getUser();
  const mine = user && (replay.players || []).find((p) => p.uid === user.id);
  R.mySeat = mine ? mine.seat : 0;

  // 先保存并暂停实时战绩聚合器，回放座位不显示上一场分数
  if (R.prevStats === null) R.prevStats = getMatchStats();
  setMatchStats(null);
  setReplayMode(true);
  setModeLabel('回放');
  setNewGameLabel('回放');

  document.body.classList.add('replay-mode');
  // 回放也是牌桌画面：竖屏手机照旧自动横屏（style.css 的 html.in-play 作用域）
  document.documentElement.classList.add('in-play');
  $('lobby').hidden = true;
  $('waiting').hidden = true;
  $('play').hidden = false;

  ensureBar();

  setGame(driverFor(replay));
  const sel = $('rp-seat');
  sel.innerHTML = '';
  const names = playerNames(replay);
  const dirs = windsFromDealer(replay.dealer).seatToDir;
  for (let seat = 0; seat < 4; seat++) {
    const o = el('option', '', `${names[seat]}（${dirs[seat]}）`);
    o.value = String(seat);
    sel.appendChild(o);
  }
  sel.value = String(R.mySeat);

  // 初始状态 = 发牌完成、第一个动作之前
  R.state = createGame({
    seed: replay.seed,
    ruleset: replay.ruleset,
    dealer: replay.dealer,
    prevWildTile: replay.prevWildTile,
    prevWinnerSeat: replay.prevWinnerSeat == null ? null : replay.prevWinnerSeat,
    names,
  });
  R.step = 0;
  R.view = makeView(R.state);
  paint();
}

function exitPlayer() {
  pause();
  const backSession = R.returnSession;
  R.returnSession = null;
  setReplayMode(false);
  document.body.classList.remove('replay-mode');
  // 控制条（#rp-info / #rp-tools）由 CSS 的 body:not(.replay-mode) 规则隐藏，
  // 上面已经 remove 了 replay-mode，这里不需要再手动 hidden（旧的 #replay-bar 已删）。
  $('play').hidden = true;
  // 退回放离开牌桌画面：摘掉自动横屏标记（随后 onExit→showLobby 也会再摘一次，幂等）
  document.documentElement.classList.remove('in-play');
  R.replay = null;
  R.session = null;
  R.state = null;
  R.view = null;
  R.step = 0;
  R.maxStep = 0;
  setReplaySeatMeta(null);
  if (R.prevStats !== null) {
    setMatchStats(R.prevStats);
    R.prevStats = null;
  }
  setNewGameLabel('准备下一局');
  if (backSession) {
    showSession(backSession);
    return;
  }
  R.onExit(R.exitView);
}

/* ------------------------------------------------------------------ */
/* 接线                                                                */
/* ------------------------------------------------------------------ */

/**
 * @param {{getClub?:Function,getUser?:Function,onExit?:Function}} opts
 */
export function initReplay(opts = {}) {
  if (opts.getClub) R.getClub = opts.getClub;
  if (opts.getUser) R.getUser = opts.getUser;
  if (opts.onExit) R.onExit = opts.onExit;

  const clubBtn = $('btn-replay-club');
  if (clubBtn) clubBtn.addEventListener('click', () => openReplayList('club').catch((e) => flash(e.message)));
  for (const id of ['btn-replay-mine', 'btn-replay-mine-global']) {
    const b = $(id);
    if (b) b.addEventListener('click', () => openReplayList('mine').catch((e) => flash(e.message)));
  }

  // 编程入口（net-lobby 捕获后可暴露给自动化出口；3D 页回放验证也用它）
  return { openReplayList, openReplay, exitPlayer };
}
