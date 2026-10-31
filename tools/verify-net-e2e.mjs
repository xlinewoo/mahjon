#!/usr/bin/env node
/**
 * 网络版前端验证（两段）
 *
 * A 段（真实协议）：真起 4 个 socket.io 客户端连**真实服务端**，其中一个用
 *   `frontend/net-driver.js`（＝网络版前端真正用的驱动），其余三个用「出牌优先」的
 *   简易策略陪打；断言驱动契约与真实 `table:state` 载荷完全对齐：
 *     · getView() === 载荷 view（驱动不掺私货、不自己算牌）
 *     · actingSeat() === 载荷 actingSeat === view.turn
 *     · isMyTurn() ⇔ me.legal 非空（legalActions 兼任回合闸门）
 *     · seatToDir[dealer] === '东'，winds.entries === null（网络版不弹摸风面板）
 *     · 非我回合 act() 必须 reject（服务端权威，别想抢牌）
 *     · ruleset.claimTimeoutMs 下发、autoPassLocally === false
 *     · 打完一把 → 结算帧（含摊牌手牌）→ ready() 开下一把（handNo 递增）
 *     · 断线重连：换新 socket + 新驱动，拿回原座位与最新帧
 *
 * B 段（UI）：把 `frontend/build/net3d.html` 丢进 jsdom，用 `window.__MAHJON_IO__` 注入假
 *   socket、用假 fetch 喂大厅接口，走「登录 → 俱乐部 → 进桌 → 收 table:state」的真实
 *   页面路径，断言大厅/牌桌/结算三段渲染，且 jsErrors = 0。
 *   其中**抢杠胡**单列一段：能抢时必须给出「胡 / 过」两个按钮、**不先弹结算**，
 *   点「胡」发出 win 动作、等结果帧回来才结算（老吴 2026-10-02 报的缺陷的回归锁）。
 *
 * 用法：
 *   node frontend/build.mjs
 *   PORT=3000 node --experimental-sqlite server/index.js &     # A 段需要
 *   node tools/verify-net-e2e.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { io } from 'socket.io-client';

import { createNetDriver } from '../frontend/net-driver.js';
import { createGame, act, viewFor, legalActions } from '../src/engine/game.js';
import { createRuleSet } from '../src/engine/rules.js';
import { analyzeTenpai } from '../src/engine/tenpai.js';
import { decide } from '../src/bot/simpleBot.js';
import { makeTile, WHITE_DRAGON } from '../src/engine/tiles.js';

const require = createRequire(import.meta.url);
const NODE_MODULES = process.env.NODE_MODULES_DIR
  || '/Users/CCBFT_Work/.workbuddy/binaries/node/workspace/node_modules';
const { JSDOM, VirtualConsole } = require(`${NODE_MODULES}/jsdom`);

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const WS = process.env.WS || 'http://127.0.0.1:3000';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; console.log(`  ❌ ${msg}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => Math.random().toString(36).slice(2, 8);

/* ------------------------------------------------------------------ */
/* 通用                                                                */
/* ------------------------------------------------------------------ */

async function api(path, method = 'GET', body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch (_) { /* 非 JSON */ }
  return { status: res.status, data };
}

const register = async (p) => {
  const d = (await api('/api/auth/register', 'POST', { username: `${p}_${rnd()}`, password: 'pass1234' })).data;
  return { token: d.token, username: d.user.username, id: d.user.id };
};

function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = io(WS, { path: '/play', auth: { token }, transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

const emitAck = (socket, ev, payload) => new Promise((resolve) => socket.emit(ev, payload, resolve));

/**
 * 把「视角里的动作」补全成能发给服务端的动作。
 * ⚠️ `viewFor` 为了不泄内部结构，把 `legal` 压成了 `{type, tile}` / `{type, tile, combos}`：
 *    · 没有 `seat` —— 服务端会按握手身份补，但引擎侧 act() 必须自己补；
 *    · 吃的候选在 `combos[]` 里，真正发出去要展成 `{type:'chi', tile, tiles:[...]}`
 *      （render.js 的吃按钮就是这么发的）。
 */
function normalize(a, seat) {
  if (!a) return null;
  const o = { ...a, seat };
  if (o.type === 'chi') {
    if (!o.tiles || !o.tiles.length) {
      if (o.combos && o.combos[0]) o.tiles = o.combos[0];
      else return null;
    }
  }
  delete o.combos;
  return o;
}

/**
 * 「只有 view 的网络客户端」能用的陪打策略：
 *   能胡就胡 → 有碰 / 吃 / 杠就开 → 打自己手里出现次数最少的那张（孤张字牌优先）。
 *
 * 为什么必须开门：实测 200 局，纯「有张就打」= 0 胡 / 200 荒庄（手牌永远凑不成型）；
 * 加上开门 + 孤张优先 = 182 胡 / 18 荒庄、零卡死。网络版客户端拿不到完整 state，
 * 只能用自己那份 view 做决策，所以这条策略正是「真实客户端能力上限」的近似。
 */
function viewPick(view, seat) {
  const legal = (view.me.legal || []).map((a) => normalize(a, seat)).filter(Boolean);
  const by = (t) => legal.find((a) => a.type === t);

  if (by('win')) return by('win');
  for (const t of ['peng', 'zhi', 'an', 'xu', 'skingang', 'redgang', 'wildgang', 'chi']) {
    const a = by(t);
    if (a) return a;
  }

  const cnt = new Map();
  for (const t of view.me.hand) cnt.set(t, (cnt.get(t) || 0) + 1);
  let best = null;
  let bestScore = 1e9;
  for (const a of legal) {
    if (a.type !== 'discard') continue;
    const c = cnt.get(a.tile) || 1;
    // 出现次数少的先打；字牌孤张再往前排；幺九其次
    const score = c * 10 + (a.tile >= 27 ? -4 : a.tile % 9 === 0 || a.tile % 9 === 8 ? -1 : 0);
    if (score < bestScore) { bestScore = score; best = a; }
  }
  return best || by('pass') || legal[0];
}

/** 引擎侧（有完整 state）的兜底策略：能胡就胡 → 出牌 → 过 → 第一个 */
const pick = (legal) =>
  legal.find((a) => a.type === 'win') || legal.find((a) => a.type === 'discard')
  || legal.find((a) => a.type === 'pass') || legal[0];

/* ================================================================== */
/* A 段：真实服务端 + net-driver                                       */
/* ================================================================== */

async function phaseA() {
  console.log('════════ A 段：真实服务端 + net-driver（驱动契约） ════════');

  // —— 前置：4 人 + 俱乐部 + 牌桌 ——
  const users = [];
  for (let i = 0; i < 4; i++) users.push(await register('net'));
  const club = (await api('/api/clubs', 'POST', { name: 'NET俱乐部_' + rnd() }, users[0].token)).data.club;
  for (const u of users.slice(1)) {
    await api(`/api/clubs/${club.id}/members`, 'POST', { username: u.username }, users[0].token);
  }
  const table = (await api(`/api/clubs/${club.id}/tables`, 'POST',
    { name: 'NET桌', circleCount: 1, rules: { preset: 'koukou' } }, users[0].token)).data.table;
  ok(!!(table && table.id), `前置就绪：4 人 + 俱乐部 #${club && club.id} + 牌桌 #${table && table.id}`);

  // —— 入座 ——
  const sockets = [];
  for (let i = 0; i < 4; i++) {
    const s = await connect(users[i].token);
    const ack = await emitAck(s, 'table:join', { tableId: table.id });
    ok(ack.ok && ack.seat === i, `玩家${i} 入座 seat=${ack.seat}`);
    sockets.push(s);
  }

  // —— hero（座位 0）用真驱动；首帧载荷到达时建驱动 ——
  const heroSocket = sockets[0];
  let driver = null;
  let firstFrame = null;      // 首帧（契约断言用，别被后续帧覆盖）
  let frames = 0;
  let settledPayload = null;
  let startedPayload = null;
  let handSettled = false;

  heroSocket.on('table:state', (p) => {
    frames++;
    // ⚠️ 未开局的 ready 阶段服务端也会广播 table:state，但那时 view = null
    //    （Room.state 还不存在）。前端 net-main 同样以 `!p.view` 为门槛——驱动不能在
    //    「没有牌局」时就被创建，否则 getView() 返回 null 会让 renderAll 直接崩。
    if (!p.view) return;
    if (!firstFrame) firstFrame = p;
    if (!driver) driver = createNetDriver({ socket: heroSocket, initial: p });
    else driver.push(p);
  });
  heroSocket.on('table:started', (p) => { startedPayload = p; });
  heroSocket.on('table:handSettled', (p) => { settledPayload = p; handSettled = true; });
  heroSocket.on('table:finished', (p) => { settledPayload = settledPayload || p; handSettled = true; });
  heroSocket.on('error', () => { /* 「还没轮到你」等并发噪声 */ });

  // —— 三个陪打客户端：只用自己那份 view 决策（＝真实网络客户端的能力上限） ——
  let botActions = 0;
  for (let i = 1; i < 4; i++) {
    const s = sockets[i];
    s.on('table:handSettled', () => { handSettled = true; });
    s.on('table:finished', () => { handSettled = true; });
    s.on('table:state', ({ view }) => {
      if (!view) return;
      // 胡牌摊牌：陪打也要点「确认」（老吴 2026-10-20）
      if (view.phase === 'settled') {
        const c = (view.me?.legal || []).find((x) => x.type === 'confirm');
        if (c) { botActions++; s.emit('action', c); }
        return;
      }
      if (!(view.me && view.me.legal && view.me.legal.length)) return;
      const a = viewPick(view);
      if (a) { botActions++; s.emit('action', a); }
    });
    s.on('error', () => {});
  }

  // —— 开局前：驱动未建，不该有任何视图 ——
  await sleep(150);
  ok(driver === null && firstFrame === null, '开局前未下发 table:state（驱动尚未创建）');

  // —— 4 人 ready 开局 ——
  for (let i = 0; i < 4; i++) await emitAck(sockets[i], 'table:ready', {});
  await sleep(300);
  ok(!!startedPayload && startedPayload.totalHands === 4,
    `开局：table:started（总把数 ${startedPayload && startedPayload.totalHands}，庄 ${startedPayload && startedPayload.dealer}）`);
  ok(!!driver, '收到首帧 table:state 后已创建 net-driver');

  // —— 驱动契约断言（钉在当前帧；此刻 hero 还没出过手，无人能抢先行动） ——
  const cur = driver.getPayload();
  const v0 = driver.getView();
  ok(!!v0 && v0.phase === 'discard', `getView() 有牌局状态（phase=${v0 && v0.phase}）`);
  ok(driver.MY_SEAT === cur.seat && cur.seat === 0, `MY_SEAT 跟随服务端分配（${driver.MY_SEAT}）`);
  ok(driver.getView() === cur.view, 'getView() 就是服务端那帧 view（驱动不改写）');
  ok(driver.actingSeat() === cur.actingSeat && v0.turn === cur.actingSeat,
    `actingSeat() === 载荷 actingSeat === view.turn（${driver.actingSeat()} / ${cur.actingSeat} / ${v0.turn}，第 ${frames} 帧）`);
  ok(cur === firstFrame, `此刻仍停在首帧（未出过手，共 ${frames} 帧）`);
  ok(driver.seatToDir[firstFrame.dealer] === '东',
    `座位→方位由 dealer 推出：庄家(${firstFrame.dealer}) = ${driver.seatToDir[firstFrame.dealer]}`);
  ok(driver.dealerSeat === firstFrame.dealer, `dealerSeat 与载荷一致（${driver.dealerSeat}）`);
  ok(!!driver.winds && driver.winds.entries === null, 'winds.entries === null（网络版不弹摸风面板）');
  ok(!!driver.ruleset && driver.ruleset.claimTimeoutMs === 8000, `ruleset 下发 claimTimeoutMs=${driver.ruleset && driver.ruleset.claimTimeoutMs}`);
  // 2026-10-17：长断线的「自动托管 / 自动判离席」已移除，rulesetSummary 不再下发 offline* 字段
  ok(driver.ruleset.offlineAbsentMs === undefined && driver.ruleset.offlineDissolveMs === undefined,
    '不再下发 offlineAbsentMs / offlineDissolveMs（自动判离席已移除）');
  ok(driver.autoPassLocally === false, 'autoPassLocally === false（超时自动过交给服务端兜底）');
  const tp = driver.getTenpai();
  ok(!!tp && typeof tp.tenpai === 'boolean' && Array.isArray(tp.waits),
    `getTenpai() 由服务端下发（tenpai=${tp && tp.tenpai}，waits=${tp && tp.waits.length}）`);
  ok(driver.isMyTurn() === (v0.me.legal.length > 0),
    `isMyTurn() ⇔ me.legal 非空（isMyTurn=${driver.isMyTurn()}，legal=${v0.me.legal.length}）`);

  // —— 驱动 hero 打完这一把 ——
  let actions = 0;
  let timedOut = false;
  let rejectTested = false;

  async function heroDrive() {
    let guard = 0;
    while (!handSettled) {
      const p = driver.getPayload();
      if (p && p.view.phase === 'settled') {
        // 摊牌确认：hero 自己点「确认」，等 table:handSettled 事件（别提前 break）
        const c = (p.view.me.legal || []).find((a) => a.type === 'confirm');
        if (c) {
          try { await driver.act(c); actions++; } catch (_) { /* 下一轮重来 */ }
          await sleep(20);
          if (++guard > 8000) throw new Error('hero 驱动循环保护');
          continue;
        }
        await sleep(20);
        if (++guard > 8000) throw new Error('hero 驱动循环保护');
        continue;
      }
      if (driver.isMyTurn()) {
        const a = viewPick(driver.getView(), driver.MY_SEAT);
        if (a) {
          try { await driver.act(a); actions++; } catch (_) { /* 竞态：下一轮重来 */ }
          continue;
        }
      } else if (!rejectTested && p && p.view.phase === 'discard') {
        // 不是我的回合却硬发动作 → 服务端必须拒
        rejectTested = true;
        let rejected = '';
        try { await driver.act({ type: 'discard', tile: p.view.me.hand[0] }); }
        catch (e) { rejected = e.message; }
        ok(/还没轮到你|非法动作/.test(rejected), `非我回合 act() 被拒：${rejected || '（没有报错！）'}`);
      }
      await sleep(12);
      if (++guard > 8000) throw new Error('hero 驱动循环保护');
    }
  }

  await Promise.race([heroDrive(), sleep(45000).then(() => { timedOut = true; })]);
  ok(handSettled && !timedOut,
    `第一把打完（hero 出招 ${actions} 次 / 陪打 ${botActions} 次）${timedOut ? '（45s 超时）' : ''}`);

  const sv = driver.getView();
  const r0 = sv && sv.result;
  ok(!!sv && sv.phase === 'settled', `结算帧到达（phase=${sv && sv.phase}）`);
  ok(!!r0 && (r0.type === 'win' || r0.type === 'draw'), `结算帧含 result（type=${r0 && r0.type}）`);
  if (r0 && r0.type === 'win') {
    ok(Array.isArray(r0.payments) && r0.payments.length === 3, `赢家局结算给三家 payments（${r0.payments.length} 家）`);
    ok(r0.winnerSeat === 0 || r0.winnerSeat === 1 || r0.winnerSeat === 2 || r0.winnerSeat === 3,
      `结算含 winnerSeat=${r0.winnerSeat}（${r0.selfDraw ? '自摸' : '点炮'}）`);
  } else {
    ok(true, '本把荒庄 → 无 payments 属正常（赢家局结算形状在 B 段用真实引擎稳定覆盖）');
  }
  ok((sv.others || []).every((o) => Array.isArray(o.hand)), '结算帧下发别家手牌（摊牌）；对局中不下发');
  // 服务端广播次序是 table:state（先）→ table:handSettled（后，见 ws/index.js），
  // heroDrive 一看到 settled 的 state 就退出，可能抢在事件到达前 → 这里补等一下，别把次序当契约。
  for (let i = 0; i < 40 && !settledPayload; i++) await sleep(50);
  ok(!!settledPayload && settledPayload.handNo === 1, `table:handSettled（第 ${settledPayload && settledPayload.handNo} 把）`);

  // —— ready() 开下一把 ——
  const nextState = new Promise((resolve) => {
    const h = (p) => { if (p.handNo === 2) { heroSocket.off('table:state', h); resolve(p); } };
    heroSocket.on('table:state', h);
  });
  await driver.ready();
  for (let i = 1; i < 4; i++) sockets[i].emit('table:ready', {});
  const p2 = await Promise.race([nextState, sleep(8000).then(() => null)]);
  ok(!!p2 && p2.handNo === 2, `ready() 后开下一把（handNo=${p2 && p2.handNo}）`);
  ok(!!p2 && p2.view.phase === 'discard' && p2.view.me.hand.length >= 13,
    `第二把已发牌（手牌 ${p2 && p2.view.me.hand.length} 张，庄 ${p2 && p2.dealer}）`);
  ok(!!p2 && driver.getPayload() === p2, '驱动已跟上第 2 把（getPayload 指向最新帧）');

  // —— 断线重连：换新 socket + 新驱动，应拿回原座位与最新帧 ——
  heroSocket.disconnect();
  await sleep(200);
  const s0b = await connect(users[0].token);
  const resent = new Promise((resolve) => {
    const h = (p) => { s0b.off('table:state', h); resolve(p); };
    s0b.on('table:state', h);
  });
  const ack0 = await emitAck(s0b, 'reconnect', { tableId: table.id });
  const rp = await Promise.race([resent, sleep(6000).then(() => null)]);
  ok(ack0.ok && ack0.seat === 0 && ack0.reconnected === true, `重连拿回原座位（seat=${ack0.seat}）`);
  ok(!!rp && rp.seat === 0 && rp.handNo === 2, `重连补发最新帧（第 ${rp && rp.handNo} 把，座位 ${rp && rp.seat}）`);
  const d2 = createNetDriver({ socket: s0b, initial: rp });
  ok(!!d2.getView() && d2.getView().me.hand.length === rp.view.me.hand.length, '新驱动可直接接管重连后的帧');
  d2.detach();

  ok(frames > 10, `本次共收到 ${frames} 帧 table:state（按座位裁剪后逐座下发）`);

  // —— 退出游戏：一人拒绝则继续；三家全同意才结束，并下发已完成牌局的积分 ——
  let exitFinal = null;
  let exitRejected = null;
  let exitRequested = null;
  s0b.on('table:exited', (p) => { exitFinal = p; });
  s0b.on('table:exitRejected', (p) => { exitRejected = p; });
  sockets[1].on('table:exitRequested', (p) => { exitRequested = p; });

  const reqAck = await emitAck(s0b, 'table:exitRequest', {});
  ok(reqAck.ok && reqAck.event === 'requested', `发起退出申请 → ack requested（${reqAck.event || reqAck.error}）`);
  await sleep(120);
  ok(!!exitRequested && exitRequested.fromSeat === 0 && exitRequested.needed === 3,
    `其余三家收到 table:exitRequested（from=${exitRequested && exitRequested.fromSeat}，needed=${exitRequested && exitRequested.needed}）`);

  const rejAck = await emitAck(sockets[1], 'table:exitVote', { agree: false });
  await sleep(120);
  ok(rejAck.ok && exitRejected && exitRejected.bySeat === 1,
    `一家「不同意」→ table:exitRejected（bySeat=${exitRejected && exitRejected.bySeat}）`);
  ok(exitFinal === null, '有人拒绝时牌局不结束');

  // 2026-10-29（P2）：退出申请加了 5 秒冷却（防弹窗刷屏）。
  // 这里先验证「立刻重发会被挡」，再等过冷却验证「确实能重新发起」。
  const reqTooSoon = await emitAck(s0b, 'table:exitRequest', {});
  ok(!reqTooSoon.ok && /频繁/.test(reqTooSoon.error || ''), `冷却期内重发被拒（${reqTooSoon.error || '竟然成功了'}）`);
  await sleep(5300);
  const req2 = await emitAck(s0b, 'table:exitRequest', {});
  ok(req2.ok && req2.event === 'requested', '冷却结束后可重新发起退出申请');
  const voted = [];
  const playersAtEnd = new Promise((resolve) => {
    const h = (p) => { if (p && p.started === false) { s0b.off('table:players', h); resolve(p); } };
    s0b.on('table:players', h);
  });
  voted.push(await emitAck(sockets[1], 'table:exitVote', { agree: true }));
  voted.push(await emitAck(sockets[2], 'table:exitVote', { agree: true }));
  await sleep(80);
  ok(exitFinal === null, '只同意两家时仍不结束');
  voted.push(await emitAck(sockets[3], 'table:exitVote', { agree: true }));
  const endP = await Promise.race([playersAtEnd, sleep(3000).then(() => null)]);
  await sleep(120);
  ok(!!exitFinal && exitFinal.reason === 'exit' && exitFinal.completedHands >= 1,
    `三家全同意 → table:exited（已完成 ${exitFinal && exitFinal.completedHands} 把）`);
  ok(!!exitFinal && Array.isArray(exitFinal.standings) && exitFinal.standings.length === 4,
    '退出结算下发四家排名');
  ok(!!exitFinal && exitFinal.standings.reduce((n, p) => n + (p.net | 0), 0) === 0,
    '退出积分四家净分之和为 0');
  ok(!!endP && endP.started === false && endP.exitVote === null,
    'table:players 标记整场结束、退出投票清零');
  ok(voted.every((a) => a.ok), '三家的 table:exitVote ack 均成功');

  for (const s of [...sockets, s0b]) { try { s.disconnect(); } catch (_) { /* 忽略 */ } }
}

/* ================================================================== */
/* B 段：build/net3d.html 的 jsdom 冒烟                                   */
/* ================================================================== */

const BUILD_HTML = new URL('../frontend/build/net3d.html', import.meta.url).pathname;

/** 用真实引擎造一帧 table:state（等价 server/ws/room.js statePayload） */
function frameOf(state, seat, ruleset) {
  return {
    seat,
    handNo: 1,
    totalHands: 4,
    dealer: state.dealer,
    actingSeat: state.phase === 'settled' ? -1 : state.turn,
    // 与 server/ws/room.js 的 rulesetSummary() 保持一致（含长断线阈值）
    ruleset: {
      preset: 'koukou',
      claimTimeoutMs: ruleset.claimTimeoutMs,
      canPassWin: true,
      circleCount: 1,
      offlineAutoPlay: true,
      offlineAbsentMs: 24000,
      offlineDissolveMs: 120000,
    },
    tenpai: state.phase === 'settled' ? null : analyzeTenpai(state, seat),
    view: viewFor(state, seat),
  };
}

/**
 * 模拟「四家都确认完」的结算帧（老吴 2026-10-20：胡牌先摊牌，确认完才弹结算页）。
 * 本文件这一段只验证结算弹窗的渲染，不需要再走一遍确认交互。
 */
function confirmedFrame(state, seat, ruleset) {
  const p = frameOf(state, seat, ruleset);
  if (p.view && p.view.reveal) p.view.reveal.pending = false;
  if (p.view && p.view.me) p.view.me.legal = (p.view.me.legal || []).filter((a) => a.type !== 'confirm');
  return p;
}

const newState = (seed, ruleset) =>
  createGame({ seed, ruleset, dealer: 0, names: ['你', '下游', '对家', '上风'] });

/** 引擎侧推进一步。这里用内置机器人 decide()（和 tools/simulate.js 同一套脑子，
 *  实测 200 局 192 胡 / 8 荒庄）——本段目的就是稳定拿到「赢家局」的结算形状。 */
function stepOnce(state) {
  const seat = state.turn;
  const legal = legalActions(state, seat);
  const a = decide(state, seat) || pick(legal);
  if (!a) return false;
  act(state, a);
  return true;
}

function driveToSettled(state, max = 4000) {
  let g = 0;
  while (state.phase !== 'settled' && g++ < max) if (!stepOnce(state)) break;
  return state;
}

/** 推进若干手后停在「某人该出牌」的中间态 */
function driveMid(state, acts = 8) {
  let n = 0;
  let g = 0;
  while (g++ < 400 && (n < acts || state.phase === 'claim')) {
    if (state.phase === 'settled') break;
    if (!stepOnce(state)) break;
    if (state.phase === 'discard') n++;
  }
  return state;
}

/* ---- 抢杠胡夹具（与 test/game.test.js 的定点用例同构） ---- */

const tg = (n) => makeTile('tong', n);
const wg = (n) => makeTile('wan', n);
const sg = (n) => makeTile('tiao', n);

/**
 * 造一个「hero（座位 0）能抢杠胡」的真实局面，并推进到**响应阶段**。
 *
 * 老吴 2026-10-02 报的缺陷：能抢杠时页面**直接弹结算**，既没机会点「胡」，也没有「过」。
 * 这里用真引擎把那个瞬间复刻出来，交给 jsdom 渲染 —— 页面必须给出「抢杠胡」提示 + 胡/过
 * 两个按钮，且**不能**先把结算弹窗弹出来。
 *
 * 夹具与 test/game.test.js「抢杠胡：被抢的那家承包」一致，只把「能抢的那家」从 seat2
 * 换成 seat0 —— 页面里 hero 恒为座位 0，只有这样才能拿到 win / pass 选项：
 *   · seat1 碰过三筒、手里捏着第四张 → 蓄杠（可被抢）
 *   · seat0 手里 t1 t2，等着 t3 凑 123 筒
 */
function buildQiangGang(ruleset) {
  const state = createGame({ seed: 30, ruleset, dealer: 0, names: ['你', '下游', '对家', '上风'] });
  for (const p of state.players) {
    p.hand = []; p.melds = []; p.discards = []; p.opened = false;
  }
  state.flipTile = null;
  state.wildTile = WHITE_DRAGON; // 手牌里不出现白板 → 「无癞子」
  state.skinTiles = [];
  state.claims = [];
  state.claimIndex = 0;
  state.pendingXuGang = null;

  state.players[0].melds = [{ type: 'peng', tiles: [wg(1), wg(1), wg(1)], from: 1 }];
  state.players[0].opened = true;
  state.players[0].hand = [tg(1), tg(2), wg(4), wg(5), wg(6), wg(7), wg(8), wg(9), sg(5), sg(5)];

  state.players[1].melds = [{ type: 'peng', tiles: [tg(3), tg(3), tg(3)], from: 0 }];
  state.players[1].opened = true;
  state.players[1].hand = [tg(3), wg(1), wg(1), wg(1), sg(8), sg(8), sg(8), wg(9), sg(1), sg(2)];

  state.turn = 1;
  state.phase = 'discard';
  act(state, { type: 'xu', seat: 1, tile: tg(3) }); // → 进 claim，等座位 0 抢杠
  return state;
}

async function phaseB() {
  console.log('════════ B 段：build/net3d.html 的 jsdom 冒烟 ════════');

  const html = readFileSync(BUILD_HTML, 'utf8');
  const jsErrors = [];
  // 3D 页在 jsdom 里的两类**环境噪音**（非页面 bug，页面已兜底）：
  //   · jsdom 没有 canvas 实现 → 每次 getContext('2d') 记一条 "Not implemented"；
  //   · jsdom 没有 WebGL → THREE 记 "Error creating WebGL context"（render3d 已 try/catch 降级）。
  const isEnvNoise = (m) =>
    /Not implemented: HTMLCanvasElement/.test(m) || /Error creating WebGL context/.test(m);
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => jsErrors.push(String((e && e.message) || e)));
  vc.on('error', (...a) => jsErrors.push('console.error: ' + a.join(' ')));

  // —— 假 socket：记录发出去的帧，允许从外部「推」服务端事件 ——
  const handlers = new Map();
  const sent = [];
  const fakeSocket = {
    id: 'fake-socket',
    on(ev, fn) { if (!handlers.has(ev)) handlers.set(ev, new Set()); handlers.get(ev).add(fn); return fakeSocket; },
    off(ev, fn) { const s = handlers.get(ev); if (s) s.delete(fn); return fakeSocket; },
    emit(ev, payload, cb) {
      sent.push({ ev, payload });
      const ack = ev === 'table:join' ? { ok: true, seat: 0, reconnected: false } : { ok: true };
      if (typeof cb === 'function') setTimeout(() => cb(ack), 0);
      return fakeSocket;
    },
    /** 服务端 → 客户端 */
    fire(ev, payload) { for (const fn of [...(handlers.get(ev) || [])]) fn(payload); },
    connected: true,
  };

  // —— 假 fetch：把大厅需要的接口都喂上 ——
  const TABLE = { id: 9, clubId: 1, name: '冒烟桌', ownerId: 1, circleCount: 1, status: 'idle', rules: { preset: 'koukou' } };
  const CLUB = { id: 1, name: '冒烟俱乐部', ownerId: 1, role: 'owner' };
  const ROUTES = [
    [/^\/api\/me$/, () => ({ user: { id: 1, username: 'hero' } })],
    [/^\/api\/auth\/exists$/, () => ({ exists: true })],
    [/^\/api\/auth\/(login|register)$/, () => ({ token: 'tok-1', user: { id: 1, username: 'hero' } })],
    [/^\/api\/clubs$/, () => ({ clubs: [CLUB] })],
    [/^\/api\/clubs\/\d+$/, () => ({ club: { id: 1, name: '冒烟俱乐部' }, members: [{ id: 1, username: 'hero', role: 'owner' }] })],
    [/^\/api\/clubs\/\d+\/tables$/, () => ({ tables: [TABLE] })],
    [/^\/api\/tables\/\d+$/, () => ({ table: TABLE })],
  ];
  const fetchLog = [];

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    url: 'http://127.0.0.1:3000/app/net',
    beforeParse: (w) => {
      w.__MAHJON_IO__ = () => fakeSocket;
      w.fetch = async (url, opts = {}) => {
        const path = String(url).replace(/^https?:\/\/[^/]+/, '');
        fetchLog.push({ path, method: opts.method || 'GET' });
        for (const [re, fn] of ROUTES) {
          if (re.test(path)) {
            const data = fn(path.match(re));
            return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
          }
        }
        return { ok: false, status: 404, json: async () => ({ error: '冒烟未声明该接口：' + path }) };
      };
    },
  });

  const { window } = dom;
  const doc = window.document;
  const $ = (id) => doc.getElementById(id);
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const visible = (id) => { const el = $(id); return !!el && !el.hidden; };
  const clickEl = (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const clickId = (id) => clickEl($(id));

  await sleep(60);

  // ① 未登录 → 登录页
  ok(visible('auth-view') && !visible('clubs-view'), '未登录时显示登录页');

  // ② 登录 → 俱乐部列表
  $('auth-name').value = 'hero';
  $('auth-pass').value = 'pass1234';
  clickId('btn-enter');
  await sleep(60);
  ok(visible('clubs-view'), '登录后进入俱乐部列表页');
  ok(fetchLog.some((f) => f.path === '/api/auth/login' && f.method === 'POST'), '登录走了 POST /api/auth/login');
  ok($('clubs-list').children.length === 1 && txt($('clubs-list')).includes('冒烟俱乐部'), '俱乐部列表渲染出 1 项');
  ok(txt($('whoami')).includes('hero'), '顶栏显示当前用户');

  // ③ 进俱乐部
  clickEl($('clubs-list').querySelector('.lb-btn'));
  await sleep(60);
  ok(visible('club-view'), '进入俱乐部详情页');
  ok($('members-list').children.length === 1, '成员列表渲染');
  ok(!$('invite-form').hidden, 'owner 身份可见「邀请成员」表单');
  ok($('tables-list').children.length === 1, '牌桌列表渲染出 1 项');
  ok(txt($('tables-list')).includes('1 圈') && txt($('tables-list')).includes('口口番'), '牌桌条目带圈数 + 预设名');

  // ④ 进桌 → 建 socket + table:join
  clickEl($('tables-list').querySelector('.lb-btn'));
  await sleep(60);
  ok(visible('table-view'), '进入牌桌大厅（未开局）');
  ok(fetchLog.some((f) => /^\/api\/tables\/9$/.test(f.path)), '进桌走了 GET /api/tables/9');
  ok(sent.some((s) => s.ev === 'table:join' && s.payload.tableId === 9), '已发 table:join');

  // ⑤ 未开局：四座位 + 准备按钮
  fakeSocket.fire('table:players', {
    tableId: 9, name: '冒烟桌', started: false, awaitingNext: false, finished: false,
    handNo: 0, totalHands: 4, circleCount: 1, dealer: 0,
    players: [
      { seat: 0, uid: 1, username: 'hero', ready: false, connected: true },
      { seat: 1, uid: 2, username: '下游', ready: true, connected: true },
      { seat: 2, uid: 3, username: '对家', ready: false, connected: true },
      null,
    ],
  });
  await sleep(30);
  const seatEls = [...$('table-seats').querySelectorAll('.lb-seat')];
  ok(seatEls.length === 4, `大厅渲染 4 个座位格（实际 ${seatEls.length}）`);
  ok(seatEls.filter((e) => e.classList.contains('empty')).length === 1, '空位标记正确（1 个空位）');
  ok(txt($('table-seats')).includes('已准备'), '已准备状态可见');
  const dirs = [...$('table-seats').querySelectorAll('.dir-badge')].map(txt);
  ok(dirs.length === 4, '四座位各有方位徽章');
  ok(new Set(dirs).size === 4, `方位互不重复：${dirs.join('/')}`);

  // ⑤a 开局前点「准备」—— 回归锁：S.driver 此时为 null，旧代码误报「未进入牌桌」、
  //     根本不发 table:ready；修复后应在大厅直接经 socket 发 ready（与 net-driver.ready 一致）。
  const beforeReady = sent.length;
  clickId('btn-ready');
  await sleep(40);
  ok(sent.slice(beforeReady).some((s) => s.ev === 'table:ready'),
    '开局前点「准备」→ 发出 table:ready（修复 S.driver=null 误杀「未进入牌桌」）');
  ok(txt($('status-table')).includes('已准备'), '点准备后状态条提示「已准备」（不再闪「未进入牌桌」）');

  // 模拟服务端回 table:players（hero 已准备）→ 按钮应置灰显示「已准备（等人齐）」
  fakeSocket.fire('table:players', {
    tableId: 9, name: '冒烟桌', started: false, awaitingNext: false, finished: false,
    handNo: 0, totalHands: 4, circleCount: 1, dealer: 0,
    players: [
      { seat: 0, uid: 1, username: 'hero', ready: true, connected: true },
      { seat: 1, uid: 2, username: '下游', ready: true, connected: true },
      { seat: 2, uid: 3, username: '对家', ready: false, connected: true },
      null,
    ],
  });
  await sleep(30);
  const readyBtn = $('btn-ready');
  ok(readyBtn.disabled, '服务端回 ready 后「准备」按钮置灰');
  ok(txt(readyBtn).includes('已准备'), `按钮文案变「已准备（等人齐）」（实际「${txt(readyBtn)}」）`);

  // ⑥ 开局 → table:state → 牌桌渲染（中间态：正常出牌阶段）
  const ruleset = createRuleSet('koukou', {});
  const mid = driveMid(newState(4242, ruleset), 8);
  fakeSocket.fire('table:players', {
    tableId: 9, name: '冒烟桌', started: true, awaitingNext: false, finished: false,
    handNo: 1, totalHands: 4, circleCount: 1, dealer: mid.dealer,
    players: [
      { seat: 0, uid: 1, username: 'hero', ready: true, connected: true },
      { seat: 1, uid: 2, username: '下游', ready: true, connected: true },
      { seat: 2, uid: 3, username: '对家', ready: true, connected: true },
      { seat: 3, uid: 4, username: '上风', ready: true, connected: true },
    ],
  });
  fakeSocket.fire('table:state', frameOf(mid, 0, ruleset));
  await sleep(80);

  ok(visible('play') && !visible('lobby'), '收到首帧 table:state 后切到牌桌视图');
  ok(mid.phase === 'discard', `中间态停在出牌阶段（${mid.phase}）`);
  // 3D 页（老吴 2026-10-25）：2D 表面整体跳过 —— 座位容器必须为空，牌桌由 3D 画布接管；
  // 操作条 / 顶栏 / 房间状态条照常。2D 座位卡与牌河的渲染断言随 2D 网络版一并退役。
  ok(['seat-top', 'seat-left', 'seat-right', 'seat-bottom', 'center'].every((id) => {
    const el = $(id);
    return !el || el.innerHTML === '';
  }), '2D 表面为空（3D 页不渲染 2D 座位/牌河）');
  ok(txt($('seatline')).startsWith('网络 · 第 1/4 把'), `顶栏模式标签：${txt($('seatline')).slice(0, 24)}…`);
  ok(txt($('room-status')).includes('第 1/4 把'), `牌桌顶栏有房间状态条：${txt($('room-status')).slice(0, 20)}…`);
  ok(!!$('controls').querySelector('.hint'), '控制区渲染了提示行');

  // ⑦ 结算帧 → 结算弹窗。用真实引擎扫一个「确实有人胡牌」的种子，把赢家局结算形状稳定覆盖。
  let winState = null;
  for (let seed = 1; seed <= 80 && !winState; seed++) {
    const st = driveToSettled(newState(seed, ruleset));
    if (st.phase === 'settled' && st.result && st.result.type === 'win') winState = st;
  }
  ok(!!winState, `扫到「有人胡牌」的种子（seed 1..80 内，result.type=win）`);
  if (winState) {
    ok(winState.result.payments.length === 3, `赢家局结算给三家 payments（${winState.result.payments.length} 家）`);
    // 老吴 2026-10-20：胡牌先摊牌，四家确认完才弹结算页。
    const revealFrame = frameOf(winState, 0, ruleset);
    fakeSocket.fire('table:state', revealFrame);
    await sleep(80);
    ok(!visible('settle'), '胡牌后先摊牌，未确认前不弹结算页');
    // 3D 页：摊牌改在协议层断言（view 下发别家手牌）；桌面翻牌由 3D 渲染器负责
    const revealView = revealFrame.view;
    ok((revealView.others || []).every((o) => Array.isArray(o.hand) && o.hand.length > 0),
      '摊牌帧协议层下发别家手牌（others[].hand）');
    ok([...$('controls').querySelectorAll('.act-btn')].some((b) => txt(b) === '确认'), '摊牌阶段操作条给出「确认」');
    ok($('btn-ready').disabled && txt($('btn-ready')).includes('先确认'), `摊牌阶段「准备下一局」禁用（实际「${txt($('btn-ready'))}」）`);
    const before = sent.length;
    fakeSocket.fire('table:state', confirmedFrame(winState, 0, ruleset));
    await sleep(80);
    ok(visible('settle'), '四家确认后弹出结算弹窗');
    ok(sent.length === before, '结算帧不触发任何自动发包（纯渲染）');
    const card = txt($('settle-card'));
    ok(card.length > 10, `结算弹窗有内容：${card.slice(0, 30)}…`);
    const rows = [...$('settle-card').querySelectorAll('.st-row')];
    ok(rows.length === 4, `结算弹窗按方位列四家（${rows.length} 行）`);
    ok(rows.filter((r) => r.classList.contains('is-winner')).length === 1, '结算弹窗标出唯一赢家');
    ok(card.includes('赢家'), '赢家标签可见');
    const fanTotals = [...$('settle-card').querySelectorAll('.st-fan-total')].map(txt);
    ok(fanTotals.length === 4 && fanTotals.every((t) => /^\d+ 番$/.test(t)),
      `四家都给出「N 番」：${fanTotals.join(' / ')}`);
    ok([...$('settle-card').querySelectorAll('.st-tiles .tile')].length >= 30, '结算弹窗摊开四家的牌');
    const winRow = rows.find((r) => r.querySelector('.st-flag.win'));
    const winTiles = winRow ? [...winRow.querySelectorAll('.st-tiles .tile')] : [];
    const lastWinTile = winTiles[winTiles.length - 1];
    ok(Number.isInteger(winState.result.winTile), `结算结果带最后进张 winTile=${winState.result.winTile}`);
    ok(!!lastWinTile && lastWinTile.classList.contains('st-hu-tile'),
      '赢家牌面最后一张标为胡牌张');
    ok(!!lastWinTile && Number(lastWinTile.dataset.tile) === winState.result.winTile,
      `赢家牌面最后一张就是进张（${lastWinTile && lastWinTile.dataset.tile} = ${winState.result.winTile}）`);
    ok(/番/.test(card), '结算弹窗展示番数（老吴口径：只给番名 + 番数）');
    ok(!card.includes('查表') && !card.includes('effFan'), '结算弹窗不展示算番细节（无「查表 / effFan」字样）');
  }

  // ⑧ 抢杠胡：必须给「胡 / 过」两个选择，**不能**直接跳结算（老吴 2026-10-02 报的缺陷）
  //    根因：原先抢杠在 `doXuGang` 里当场判定结算、压根不进响应阶段 → 客户端既没有
  //    win/pass 可选，也没有任何数据把提示条写成「抢杠胡」。现在抢杠走 claim 阶段，
  //    下面这组断言把它钉死在页面上（引擎侧由 test/game.test.js 的定点用例覆盖）。
  const qgState = buildQiangGang(ruleset);
  ok(qgState.phase === 'claim' && !!qgState.pendingXuGang && qgState.pendingXuGang.seat === 1,
    '抢杠夹具就绪：补杠者 seat1 蓄杠三筒，hero（座位 0）能抢');

  const beforeQg = sent.length;
  fakeSocket.fire('table:state', frameOf(qgState, 0, ruleset));
  await sleep(80);

  ok(!visible('settle'), '抢杠响应阶段**不弹**结算弹窗 —— 老吴报的缺陷就是不给人点');
  const qgControls = $('controls');
  const qgPrompt = qgControls.querySelector('.win-prompt');
  ok(!!qgPrompt, '响应阶段渲染出「能胡」提示条');
  ok(!!qgPrompt && qgPrompt.classList.contains('win-prompt-qg'), '提示条带抢杠专属样式（win-prompt-qg）');
  ok(txt(qgPrompt).includes('抢杠胡'), `提示条写明是「抢杠胡」：${txt(qgPrompt)}`);
  ok(!txt(qgPrompt).includes('可以胡牌！'), '不再退化成含糊的「可以胡牌！」');
  const qgBtns = [...qgControls.querySelectorAll('.act-btn')].map(txt);
  ok(qgBtns.includes('胡'), `给出「胡」按钮（按钮：${qgBtns.join('/') || '无'}）`);
  ok(qgBtns.includes('过'), '**同时给出「过」按钮** —— 老吴说的「这个界面没有过的按钮」');
  ok(txt(qgControls).includes('继续补杠'), '提示语说明点「过」= 让补杠者把杠补完');
  ok(!visible('auto-pass-tip'), '能胡时**不**出现自动过倒计时（避免超时把胡牌过掉）');
  ok(sent.length === beforeQg, '响应帧本身不发任何包（纯渲染）');

  // 点「胡」→ 前端只把意图发给服务端，**仍不弹结算**（结算是服务端裁定的结果）
  const qgWinBtn = [...qgControls.querySelectorAll('.act-btn')].find((b) => txt(b) === '胡');
  clickEl(qgWinBtn);
  await sleep(40);
  ok(sent.slice(beforeQg).some((s) => s.ev === 'action' && s.payload && s.payload.type === 'win'),
    '点「胡」发出了 win 动作（不抢服务端的裁定权）');
  ok(!visible('settle'), '点「胡」之后仍未结算 —— 等结果帧回来才弹');

  // 服务端把结果帧推回 → 这时才弹结算，且标明「抢杠胡 / 承包」
  act(qgState, { type: 'win', seat: 0 }); // 模拟服务端执行了这个 win
  fakeSocket.fire('table:state', confirmedFrame(qgState, 0, ruleset));
  await sleep(80);
  ok(visible('settle'), '结果帧到达后才弹出结算弹窗（＝点胡以后才结算）');
  const qgCard = txt($('settle-card'));
  ok(qgCard.includes('承包'), `抢杠胡结算标明「承包」（被抢者独付）：${qgCard.slice(0, 40)}…`);
  ok(qgCard.includes('抢杠'), '结算番型里有「抢杠胡」');

  // ⑨ 长断线：托管徽章 / 判离席复位
  //    三态必须互斥：托管（服务器已在代打）> 断线（还在等本人）> 在线
  fakeSocket.fire('table:players', {
    tableId: 9, name: '冒烟桌', started: true, awaitingNext: false, finished: false,
    handNo: 1, totalHands: 4, circleCount: 1, dealer: mid.dealer,
    players: [
      { seat: 0, uid: 1, username: 'hero', ready: true, connected: true, absent: false, botSteps: 0 },
      { seat: 1, uid: 2, username: '下游', ready: true, connected: false, absent: true, botSteps: 7 },
      { seat: 2, uid: 3, username: '对家', ready: true, connected: true, absent: false, botSteps: 0 },
      { seat: 3, uid: 4, username: '上风', ready: false, connected: false, absent: false, botSteps: 0 },
    ],
  });
  await sleep(30);
  const seatBox = $('table-seats');
  const seatTxt = txt(seatBox);
  const allSeatEls = [...seatBox.querySelectorAll('.lb-seat')];
  ok(allSeatEls.length === 4, '托管态下仍渲染 4 个座位格');
  ok(seatTxt.includes('托管中'), `托管座位显示「托管中」（${seatTxt.replace(/\s+/g, ' ').slice(0, 56)}…）`);
  ok(seatBox.querySelectorAll('.lb-host').length === 1, '「托管中」只标在真的托管座位上（1 个）');
  ok(allSeatEls[1].querySelector('.lb-off') === null, '托管 > 断线：已托管座位不再重复显示「断线」');
  ok(!!allSeatEls[3].querySelector('.lb-off'), '只断线未到阈值的座位仍显示「断线」');
  ok(txt($('room-status')).includes('🤖'), '房间状态条用 🤖 区分托管座位');
  ok(txt($('room-status')).includes('✔'), '房间状态条上已准备座位仍是 ✔');
  const hostLabels = [...seatBox.querySelectorAll('.lb-host-btn')].map(txt);
  ok(hostLabels.includes('我要尿尿'), `托管按钮改叫「我要尿尿」（${hostLabels.join('/')}）`);
  ok(hostLabels.includes('取消托管'), '已托管座位仍显示「取消托管」');

  // ⑩ 退出游戏：发起 → 其他三家投票 → 拒绝则继续 / 全同意则按已完成牌局结算
  ok(!$('exitgame').hidden, '牌局进行中显示「退出」按钮');
  const beforeExitReq = sent.length;
  clickId('exitgame');
  await sleep(30);
  ok(sent.slice(beforeExitReq).some((s) => s.ev === 'table:exitRequest'), '点「退出」发出 table:exitRequest');

  fakeSocket.fire('table:exitRequested', {
    fromSeat: 2, fromName: '对家', approvals: [3], rejects: [], needed: 3, completedHands: 1,
  });
  await sleep(30);
  ok(visible('exitvote'), '其他玩家发起退出 → 弹出投票框');
  const voteTxt = txt($('exitvote-card'));
  ok(voteTxt.includes('对家') && voteTxt.includes('1/3'), `投票框显示发起人与进度（${voteTxt.replace(/\s+/g, ' ').slice(0, 32)}…）`);
  const voteBtns = [...$('exitvote-card').querySelectorAll('button')].map(txt);
  ok(voteBtns.includes('同意结束') && voteBtns.includes('不同意'), `投票框给出「同意结束 / 不同意」（${voteBtns.join('/')}）`);
  const beforeVote = sent.length;
  clickEl([...$('exitvote-card').querySelectorAll('button')].find((b) => txt(b) === '同意结束'));
  await sleep(30);
  const voteSent = sent.slice(beforeVote).find((s) => s.ev === 'table:exitVote');
  ok(!!voteSent && voteSent.payload.agree === true, '点「同意结束」发出 table:exitVote {agree:true}');

  fakeSocket.fire('table:exitRejected', { bySeat: 1, byName: '下游' });
  await sleep(30);
  ok(!visible('exitvote'), '有人不同意 → 投票框收起');
  ok(txt($('status-table')).includes('牌局继续'), `状态条提示牌局继续（${txt($('status-table'))}）`);

  fakeSocket.fire('table:exited', {
    reason: 'exit', bySeat: 2, byName: '对家', handNo: 2, completedHands: 1,
    standings: [
      { seat: 0, name: 'hero', net: 6, wins: 0, gangs: 1, maxFan: 3, played: 1 },
      { seat: 1, name: '下游', net: -2, wins: 1, gangs: 0, maxFan: 2, played: 1 },
      { seat: 2, name: '对家', net: -2, wins: 0, gangs: 0, maxFan: 0, played: 1 },
      { seat: 3, name: '上风', net: -2, wins: 0, gangs: 0, maxFan: 0, played: 1 },
    ],
  });
  await sleep(30);
  ok(visible('exitsummary'), '三家全同意 → 弹出本场结束积分');
  const exitTxt = txt($('exitsummary-card'));
  ok(exitTxt.includes('本场结束') && exitTxt.includes('按已完成的 1 把'), `结算标题与已完成把数正确（${exitTxt.replace(/\s+/g, ' ').slice(0, 30)}…）`);
  ok(exitTxt.includes('当前未打完的一把不计入'), '明确当前未打完的牌局不计入');
  const exitRows = [...$('exitsummary-card').querySelectorAll('tbody tr')];
  ok(exitRows.length === 4, `退出结算按四家列积分（${exitRows.length} 行）`);
  ok(txt(exitRows[0]).includes('hero') && txt(exitRows[0]).includes('+6'), '按净分降序展示已完成的积分');

  // ⑩b 打满设定局数（老吴 2026-10-30 改流程）：**先弹出本局结算，确认后再弹本场总成绩**。
  //    上一段 ⑩ 已经把本场按退出结掉了，这里重新推一帧「本局已结算」的现场作为起点。
  const closeSummary = [...$('exitsummary-card').querySelectorAll('button')].find((b) => txt(b) === '返回牌桌');
  if (closeSummary) clickEl(closeSummary);
  await sleep(30);
  fakeSocket.fire('table:state', confirmedFrame(qgState, 0, ruleset));
  await sleep(80);
  ok(visible('settle'), '重新回到「本局已结算」现场（本局结算开着）');
  fakeSocket.fire('table:finished', {
    reason: 'finished', handNo: 4, totalHands: 4, completedHands: 4,
    standings: [
      { seat: 0, name: 'hero', net: 12, wins: 2, dealtIn: 0, goldTops: 1, lianZhuang: 2, gangs: 1, maxFan: 8, played: 4 },
      { seat: 1, name: '下游', net: -4, wins: 1, dealtIn: 1, goldTops: 0, lianZhuang: 0, gangs: 0, maxFan: 4, played: 4 },
      { seat: 2, name: '对家', net: -4, wins: 1, dealtIn: 1, goldTops: 0, lianZhuang: 0, gangs: 0, maxFan: 3, played: 4 },
      { seat: 3, name: '上风', net: -4, wins: 0, dealtIn: 2, goldTops: 0, lianZhuang: 0, gangs: 0, maxFan: 0, played: 4 },
    ],
  });
  await sleep(50);
  ok(visible('settle') && !visible('exitsummary'),
    '打满局数 → 先看本局结算，本场总成绩**不抢在前面**（老吴 2026-10-30）');
  const endBtn = [...$('settle-card').querySelectorAll('button')].find((b) => txt(b) === '结束');
  ok(!!endBtn, `整场打完 → 结算窗按钮改「结束」（实际：${endBtn ? txt(endBtn) : '无按钮'}）`);
  if (endBtn) { clickEl(endBtn); await sleep(60); }
  ok(visible('exitsummary'), '确认本局（点「结束」）→ 才弹出本场总成绩');
  const finalTxt = txt($('exitsummary-card'));
  ok(finalTxt.includes('本场总成绩') && finalTxt.includes('4 把已打完'), `总成绩标题与把数正确（${finalTxt.replace(/\s+/g, ' ').slice(0, 30)}…）`);
  ok(finalTxt.includes('总得分') && finalTxt.includes('胡牌') && finalTxt.includes('点炮') && finalTxt.includes('金顶') && finalTxt.includes('连庄'), '总成绩列含总得分/胡牌/点炮/金顶/连庄');
  const finalRows = [...$('exitsummary-card').querySelectorAll('thead th')].map(txt);
  ok(finalRows.join('/') === '#/玩家/总得分/胡牌/点炮/金顶/连庄', `总成绩表头正确（${finalRows.join('/')}）`);
  const heroFinal = [...$('exitsummary-card').querySelectorAll('tbody tr')].find((tr) => txt(tr).includes('hero'));
  ok(!!heroFinal && txt(heroFinal).includes('+12') && txt(heroFinal).includes('2') && txt(heroFinal).includes('1'),
    `总成绩行展示总得分/胡牌/金顶（${heroFinal && txt(heroFinal)}）`);
  ok(!!heroFinal && txt(heroFinal).trim().endsWith('2'), `总成绩行展示连庄次数（${heroFinal && txt(heroFinal)}）`);
  const finalRowTexts = [...$('exitsummary-card').querySelectorAll('tbody tr')].map(txt);
  ok(finalRowTexts.filter((t) => t.includes('大赢家')).length === 1, '最高分标出大赢家');
  ok(finalRowTexts.filter((t) => t.includes('大输家')).length === 3, '最低分并列 → 三家都标大输家');

  // ⑩c 本场结算的按钮（老吴 2026-10-30）：既然牌桌已经打完，按钮就该是「返回俱乐部」，
  //     点掉它才离桌 —— 老版这里只是「返回牌桌」，牌桌其实已经不存在了。
  const leaveBtn = [...$('exitsummary-card').querySelectorAll('button')].find((b) => txt(b) === '返回俱乐部');
  ok(!!leaveBtn, `本场结算按钮为「返回俱乐部」（实际：${leaveBtn ? txt(leaveBtn) : ([...$('exitsummary-card').querySelectorAll('button')].map(txt).join('/') || '无按钮')}）`);
  if (leaveBtn) {
    clickEl(leaveBtn);
    await sleep(80);
    ok(visible('club-view') && !visible('play'), '点「返回俱乐部」→ 离桌返回俱乐部首页');
    // 老吴 2026-10-28：离桌必须同步关掉结算弹窗 —— 否则弹窗盖在大厅上，
    // 再点一次就落进 readyUp() 报「还没进入牌桌」且弹窗关不掉。现在两张窗都要收干净。
    ok(!visible('settle'), '离桌 → 本局结算弹窗同步关闭（不残留盖在大厅上）');
    ok(!visible('exitsummary'), '离桌 → 本场结算弹窗也关闭');
  }

  // ⑪ 全局：没有 JS 异常
  // 2026-10-17：`table:dissolved`（服务端自动判离席）已随死管线一并移除，
  //   故原「判离席 → 回大厅」那一段断言删除；托管徽章（⑨）仍照测。
  const pageErrors = jsErrors.filter((m) => !isEnvNoise(m));
  ok(pageErrors.length === 0, `jsErrors = 0${pageErrors.length ? ' → ' + pageErrors.slice(0, 3).join(' | ') : ''}`);

  dom.window.close();
}

/* ================================================================== */

async function main() {
  console.log('武汉红中赖子杠 · 网络版前端验证（驱动契约 + 页面冒烟）');
  await phaseA();
  await phaseB();
  console.log(`\n════════ 总结：${fail === 0 ? '✅ 全部通过' : '❌ 有失败'} （${pass} 通过 / ${fail} 失败）════════`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  const s = String((e && e.stack) || e);
  if (s.includes('ECONNREFUSED') || s.includes('fetch failed')) {
    console.error('\n❌ 连不上服务端 —— A 段需要先起服务：');
    console.error('   PORT=3000 node --experimental-sqlite server/index.js');
    process.exit(1);
  }
  console.error('❌ 运行异常：', e);
  process.exit(1);
});
