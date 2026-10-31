#!/usr/bin/env node
/**
 * 网络对战端到端验证（真实 HTTP + 真实 WebSocket）
 *
 * 覆盖：
 *   ① 注册 4 人 → 建俱乐部 → 邀人 → 建桌（含规则）
 *   ② 4 个 ws 客户端 join；前 3 人 ready 不开局，第 4 人 ready 才开局（table:started）
 *   ③ 逐手驱动走完第一把（自动挑合法动作），断言收到 table:handSettled
 *   ④ 断线重连：断掉一个客户端 → 重连 → 拿回原座位与最新视图
 *   ⑤ 长断线：一人彻底跑掉 → 由**其他在线玩家主动点「托管」按钮**（不再自动）
 *              → 服务器代打（牌局继续）；长断线再久也不作废（2026-10-02 取消「判离席」）
 *
 * 用法：先起服务 `PORT=3000 node --experimental-sqlite server/index.js`，再
 *   node tools/netplay-e2e.mjs
 */
import { io } from 'socket.io-client';

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const WS = process.env.WS || 'http://127.0.0.1:3000';
const rnd = () => Math.random().toString(36).slice(2, 8);

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; console.log(`  ❌ ${msg}`); }
};

async function api(path, method = 'GET', body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

const register = async (p) => {
  const d = (await api('/api/auth/register', 'POST', { username: `${p}_${rnd()}`, password: 'pass1234' })).data;
  return { token: d.token, username: d.user.username };
};

/** 挑一个动作走棋（优先出牌 → 过 → 第一个），保证牌局能推进 */
function pick(legal) {
  return legal.find((a) => a.type === 'discard') || legal.find((a) => a.type === 'pass') || legal[0];
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = io(WS, { path: '/play', auth: { token }, transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

const waitEvent = (socket, ev, ms = 8000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`等待 ${ev} 超时`)), ms);
    socket.once(ev, (payload) => { clearTimeout(t); resolve(payload); });
  });

const emitAck = (socket, ev, payload) =>
  new Promise((resolve) => socket.emit(ev, payload, resolve));

/** 轮询等条件成立（离席阈值是时间驱动的，只能等真实时间过去） */
async function waitUntil(fn, ms = 5000, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return fn();
}

async function main() {
  console.log('武汉红中赖子杠 · 网络对战 端到端验证');
  console.log('════════ ① REST 前置：4 人 + 俱乐部 + 牌桌 ════════');
  const users = [];
  for (let i = 0; i < 4; i++) users.push(await register('e2e'));
  const [u0, u1, u2, u3] = users;

  /* 俱乐部名**必须带随机后缀**：服务端对同名俱乐部返回 409「已存在同名俱乐部」，
     而用户名已经是随机的、俱乐部名却曾硬编码成 'E2E俱乐部' ——
     结果就是**同一个库里跑第二遍必然失败**，而且报错停在下一行
     `club.id` 上（"Cannot read properties of undefined (reading 'id')"），
     真正的 409 原因被完全掩盖，极难定位（老吴 2026-10-03 撞过）。
     现在名字跟着 rnd() 走，脚本可重复跑；顺手把状态码也打出来，别再猜。 */
  const clubRes = await api('/api/clubs', 'POST', { name: `E2E俱乐部_${rnd()}` }, u0.token);
  const club = clubRes.data?.club;
  ok(!!club?.id, `建俱乐部成功 (id=${club?.id}${club?.id ? '' : ' · HTTP ' + clubRes.status + ' ' + JSON.stringify(clubRes.data)})`);
  for (const u of [u1, u2, u3]) {
    const r = await api(`/api/clubs/${club.id}/members`, 'POST', { username: u.username }, u0.token);
    ok(r.status === 200, `邀请 ${u.username} 入俱乐部`);
  }
  const table = (await api(`/api/clubs/${club.id}/tables`, 'POST', { name: 'E2E桌', circleCount: 1, rules: { preset: 'koukou' } }, u0.token)).data.table;
  ok(!!table?.id, `建桌成功 (id=${table?.id}, 圈数=${table?.circleCount})`);

  console.log('════════ ② 4 人入桌 + ready 开局 ════════');
  // 监听必须在开局广播之前注册，否则会漏掉首帧 table:state
  let started = 0;
  let settled = null;
  let actions = 0;
  let resolveSettled;
  const settledP = new Promise((r) => { resolveSettled = r; });

  const sockets = [];
  for (let i = 0; i < 4; i++) {
    const s = await connect(users[i].token);
    const ack = await emitAck(s, 'table:join', { tableId: table.id });
    ok(ack.ok && ack.seat === i, `玩家${i} 入座 seat=${ack.seat}`);

    s.on('table:started', () => started++);
    // 驱动：轮到我就挑一个合法动作出（优先出牌 → 过）
    s.on('table:state', ({ view }) => {
      if (!view) return;
      // 胡牌摊牌：四家都要点「确认」才会收到 table:handSettled（老吴 2026-10-20）
      if (view.phase === 'settled') {
        const c = (view.me?.legal || []).find((x) => x.type === 'confirm');
        if (c) { actions++; s.emit('action', c); }
        return;
      }
      const legal = view.me?.legal || [];
      if (legal.length === 0) return;
      const a = pick(legal);
      if (!a) return;
      actions++;
      s.emit('action', a);
    });
    s.on('table:handSettled', (p) => { settled = p; resolveSettled(p); });
    s.on('table:finished', (p) => { settled = settled || p; resolveSettled(p); });
    s.on('error', () => {}); // 忽略“还没轮到你”等并发噪声
    sockets.push(s);
  }

  // 前 3 人 ready 不应开局
  for (let i = 0; i < 3; i++) await emitAck(sockets[i], 'table:ready', {});
  await new Promise((r) => setTimeout(r, 300));
  ok(started === 0, '3 人 ready 时不开局（需 4 人齐）');

  // 第 4 人 ready → 开局
  const startedPayload = waitEvent(sockets[0], 'table:started').catch(() => null);
  await emitAck(sockets[3], 'table:ready', {});
  const sp = await startedPayload;
  ok(!!sp, '第 4 人 ready 后收到 table:started（整体开局）');
  ok(sp && sp.totalHands === 4, `总把数 = 圈数×4 = ${sp?.totalHands}`);

  console.log('════════ ③ 逐手驱动走完第一把 ════════');
  let timedOut = false;
  await Promise.race([
    settledP,
    new Promise((resolve) => {
      const t = setTimeout(() => { timedOut = true; resolve(); }, 30000);
      t.unref?.();
    }),
  ]);
  ok(!!settled && !timedOut, `第一把打完并收到结算事件（共驱动 ${actions} 手）${timedOut ? '（30s 超时）' : ''}`);

  console.log('════════ ④ 断线重连 ════════');
  // 断掉 socket[2]，保留 Room.state；重连后应拿回 seat=2
  sockets[2].disconnect();
  await new Promise((r) => setTimeout(r, 300));
  const s2b = await connect(users[2].token);
  const stateAfter = waitEvent(s2b, 'table:state', 6000).catch(() => null);
  const ack2 = await emitAck(s2b, 'reconnect', { tableId: table.id });
  ok(ack2.ok && ack2.seat === 2 && ack2.reconnected === true, `重连拿回原座位 seat=${ack2.seat}`);
  const st = await stateAfter;
  ok(!!st && st.seat === 2, '重连后收到本人最新视图（座位正确）');
  ok(!!st?.view, '重连视图含牌局状态（可继续操作）');

  // 收尾（本桌的第 1 把已打完，后面不再用）
  sockets.forEach((s) => { try { s.disconnect(); } catch {} });
  try { s2b.disconnect(); } catch {}

  /* ================================================================
   * ⑤ 长断线：一个人跑了，牌局不能跟着停产，也不能被作废
   *    claimTimeoutMs 只兜「响应阶段」；「出牌阶段」轮到掉线玩家时，
   *    原来会永远卡住。这里验证三件事（2026-10-02 后续：取消自动托管）：
   *      · 断线后**由另一位在线玩家主动点「托管」** → 服务器代打，其余三家继续
   *      · 长断线再久 → 不判离席（老吴 2026-10-02：牌局不结束），座位保留
   *      · 玩家重连 → 撤销托管、拿回原位、从当前状态继续
   * ================================================================ */
  console.log('════════ ⑤ 长断线：托管代打 + 长断线不结束 + 重连续局 ════════');

  const u4 = await register('e2e5');
  const invite4 = await api(`/api/clubs/${club.id}/members`, 'POST', { username: u4.username }, u0.token);
  ok(invite4.status === 200, '邀请第 5 位成员（用来补离席者腾出的座位）');

  const fastRules = {
    preset: 'koukou',
    claimTimeoutMs: 200,
    offlineAbsentMul: 1, // ⚠️ 已废弃（不再自动托管）；保留仅为规则可解析
    offlineDissolveMul: 15, // ⚠️ 已废弃（2026-10-02 取消自动判离席）
  };
  const fastTable = (
    await api(`/api/clubs/${club.id}/tables`, 'POST', { name: '长断线桌', circleCount: 1, rules: fastRules }, u0.token)
  ).data.table;
  ok(!!fastTable?.id, `建长断线测试桌 (id=${fastTable?.id})`);
  ok(
    fastTable.rules.claimTimeoutMs === 200 && fastTable.rules.offlineAbsentMul === 1,
    `规则按原样规整（claimTimeoutMs=${fastTable.rules.claimTimeoutMs}, absentMul=${fastTable.rules.offlineAbsentMul}）`,
  );

  const fSocks = [];
  const frames = [0, 0, 0, 0];
  let absentEvt = null;
  let dissolvedEvt = null;
  let lastPlayers = null;
  let playersAfterDissolve = null;
  // 从 1 号视角盯 0 号的「动作数」：牌河变长或换把都算一次，
  // 只记增不记减（吃/碰会把别人的牌河 pop 掉，不是单调的）
  let seat0Acts = 0;
  let seenD0 = -1;
  let seenHand = -1;

  for (let i = 0; i < 4; i++) {
    const s = await connect(users[i].token);
    const ack = await emitAck(s, 'table:join', { tableId: fastTable.id });
    ok(ack.ok && ack.seat === i, `长断线桌 玩家${i} 入座 seat=${ack.seat}`);
    s.on('table:state', ({ view }) => {
      frames[i]++;
      if (!view || view.phase === 'settled') return;
      const legal = view.me?.legal || [];
      if (!legal.length) return;
      s.emit('action', pick(legal));
    });
    s.on('table:absent', (p) => { absentEvt = p; });
    s.on('table:dissolved', (p) => { dissolvedEvt = p; });
    s.on('table:players', (p) => { lastPlayers = p; if (dissolvedEvt) playersAfterDissolve = p; });
    s.on('error', () => {});
    if (i === 1) {
      s.on('table:state', (p) => {
        const o = ((p.view && p.view.others) || []).find((x) => x.seat === 0);
        if (o) {
          const d = (o.discards || []).length;
          if (seenD0 >= 0 && d > seenD0) seat0Acts++;
          seenD0 = d;
        }
        if (seenHand >= 0 && p.handNo > seenHand) seat0Acts++;
        seenHand = p.handNo;
      });
    }
    fSocks.push(s);
  }

  for (let i = 0; i < 4; i++) await emitAck(fSocks[i], 'table:ready', {});
  ok(await waitUntil(() => frames[1] > 0, 3000), '长断线桌已开局并收到首帧');

  // 0 号彻底断开（不再重连）——这正是过去会把整桌卡死的场景
  const actsBefore = seat0Acts;
  const framesBefore = frames[1];
  fSocks[0].disconnect();

  // ① 主动点「托管」：由另一位在线玩家（1 号）对该断线座位发起托管
  //    （2026-10-02 后续：取消自动托管，改为手动按钮；这里用 table:setAbsent 模拟点击）
  const hostAck = await emitAck(fSocks[1], 'table:setAbsent', { seat: 0, on: true });
  ok(hostAck.ok && hostAck.seat === 0 && hostAck.absent === true, '1 号主动托管掉线的 0 号（手动托管成功）');
  ok(await waitUntil(() => !!absentEvt, 5000), '收到「托管」通知（manual）');
  ok(
    absentEvt && absentEvt.seats.includes(0) && absentEvt.usernames.includes(users[0].username),
    `托管名单是掉线的 0 号（${JSON.stringify(absentEvt?.usernames)}）`,
  );
  ok(absentEvt && absentEvt.manual === true && absentEvt.on === true, '通知带 manual/on 标记，前端区分手动托管');
  ok(
    lastPlayers && lastPlayers.players[0] && lastPlayers.players[0].absent === true,
    'table:players 下发 players[0].absent = true',
  );

  // ② 托管真的在替它打牌 —— 这是「不卡死」的直接证据
  ok(
    await waitUntil(() => seat0Acts > actsBefore, 6000),
    `掉线玩家由服务器代打（1 号视角观测到 0 号动作数 ${actsBefore} → ${seat0Acts}）`,
  );
  ok(frames[1] > framesBefore, `其余三家持续收到 table:state（${framesBefore} → ${frames[1]} 帧）`);

  // ③ 长断线再久也不作废：超过原「判离席」阈值（3s）后，牌局仍在推进、无 table:dissolved
  //    （老吴 2026-10-02：客户端断开再久，牌局不结束）
  ok(
    await waitUntil(() => frames[1] > framesBefore + 3, 8000),
    `长断线期间牌局持续推进（1 号收到 ${framesBefore} → ${frames[1]} 帧，未因判离席停摆）`,
  );
  // 等过原解散阈值后再确认：绝不应收到 table:dissolved
  await new Promise((r) => setTimeout(r, 2500));
  ok(dissolvedEvt === null, '超过原判离席阈值仍无 table:dissolved（牌局不结束）');
  ok(
    lastPlayers && lastPlayers.players[0] && lastPlayers.players[0].seat === 0 && lastPlayers.players[0].absent === true,
    '离席者座位始终保留（未被请出），仅处于托管态',
  );

  // ④ 座位不释放 → 外人不能补位；原玩家重连拿回原位、牌局从当前状态继续（核心需求）
  const fifth = await connect(u4.token);
  const ackFull = await emitAck(fifth, 'table:join', { tableId: fastTable.id });
  ok(!ackFull.ok, '牌桌仍满（0 号座位未释放，外人不能补）：第 5 人加入被拒');
  ok(lastPlayers && lastPlayers.players[0] && lastPlayers.players[0] !== null, '0 号座位仍被原玩家占着（未释放）');
  fifth.disconnect();

  const reSeat = await connect(users[0].token);
  const reAck = await emitAck(reSeat, 'reconnect', { tableId: fastTable.id });
  ok(reAck.ok && reAck.seat === 0 && reAck.reconnected === true, `0 号重连拿回原座位 seat=${reAck.seat}`);
  ok(reAck.wasAbsent === true, '重连被告知「刚才是托管状态」');
  ok(!!reAck, '控制权交还，从当前牌局继续（未作废、未重置）');

  [...fSocks.filter(Boolean), fifth].forEach((s) => { try { s.disconnect(); } catch {} });

  console.log(`\n════════ 总结：${fail === 0 ? '✅ 全部通过' : '❌ 有失败'} （${pass} 通过 / ${fail} 失败）════════`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('❌ 运行异常：', e);
  process.exit(1);
});
