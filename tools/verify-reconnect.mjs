#!/usr/bin/env node
/**
 * 「断线重进直接回桌」+「掉线玩家头像置灰」端到端验证（真实 Chrome + 真实 socket + 临时数据目录）。
 *
 * 覆盖老吴 2026-10-30 的两条需求：
 *   ① 页面被回收 / 误关后重新打开，**直接回到原来那张牌桌**，不停在俱乐部列表；
 *      牌桌已经不可用时要安静退回俱乐部，不能卡在「回桌中」；
 *   ② 玩家不在线时，他的座位头像显示为**黑白**；重连后立刻恢复彩色。
 *
 * 做法：临时目录起服务（不碰线上库）→ 注册 4 号 + 建俱乐部/牌桌 →
 * 真实 3D 页面（座位 0）+ 3 个 socket 陪打 → 开局后 `Page.reload()` 模拟重进 →
 * 断言落点、DOM、localStorage 记录 → 断开一个 socket 验灰头像 → 重连验复原。
 *
 * 用法：node tools/verify-reconnect.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, teardownChrome } from './lib/chrome.mjs';

const PORT = 3012;
const DATA = mkdtempSync(join(tmpdir(), 'mahjon-reconnect-'));
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN_KEY = 'mahjon:net:token';
const LAST_TABLE_KEY = 'mahjon:net:lastTable';
const SHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.cache');

const rnd = () => Math.random().toString(36).slice(2, 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const fails = [];
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  ✅ ' + msg); } else { fails.push(msg); console.log('  ❌ ' + msg); }
};

async function api(path, method = 'GET', body, token) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, data: data || {} };
}

const reg = async (p) => {
  const d = (await api('/api/auth/register', 'POST', { username: `${p}_${rnd()}`, password: 'pass1234' })).data;
  return { token: d.token, username: d.user.username, id: d.user.id };
};

/* ---- 起服务（临时数据目录，退出即删） ---- */
const env = {
  ...process.env,
  PORT: String(PORT),
  DATA_DIR: DATA,
  HOST: '127.0.0.1',
  JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret-00',
  NODE_ENV: 'test',
};
delete env.npm_config_prefix;
const child = spawn(process.execPath, ['--experimental-sqlite', 'server/index.js'], {
  env, stdio: ['ignore', 'pipe', 'pipe'], cwd: process.cwd(),
});
child.stdout.on('data', () => {});
child.stderr.on('data', (b) => process.stderr.write('[srv] ' + b));

const waitUp = async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok || r.status < 500) return; } catch { /* 还没起 */ }
    await sleep(150);
  }
  throw new Error('服务未启动');
};

let chrome = null;
const sockets = [];
let exitCode = 0;
try {
  await waitUp();

  /* ---- 四个账号 + 俱乐部 + 牌桌 ---- */
  const users = [];
  for (let i = 0; i < 4; i++) users.push(await reg('rc' + i));
  // 都换成预设头像图（字母头像灰度前后几乎看不出差别，验「黑白」必须用彩色图）
  const presets = JSON.parse(readFileSync(new URL('../server/assets/avatars/index.json', import.meta.url), 'utf8'));
  for (let i = 0; i < 4; i++) {
    await api('/api/me/avatar', 'PUT', { type: 'preset', value: presets[i % presets.length] }, users[i].token);
  }
  const club = (await api('/api/clubs', 'POST', { name: '重连验证' + rnd() }, users[0].token)).data.club;
  for (const u of users.slice(1)) {
    await api(`/api/clubs/${club.id}/members`, 'POST', { username: u.username }, users[0].token);
  }
  const table = (await api(`/api/clubs/${club.id}/tables`, 'POST',
    { name: '重连桌', circleCount: 1, rules: { preset: 'koukou' } }, users[0].token)).data.table;
  ok(!!table.id, `牌桌已建（#${table.id}）`);

  mkdirSync(SHOT_DIR, { recursive: true });

  /* ---- 真实 3D 页面（座位 0） ---- */
  chrome = await launchChrome({ extraArgs: ['--enable-unsafe-swiftshader', '--window-size=1280,800'] });
  const s = chrome;
  await s.cdp.send('Page.enable');
  await s.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs = [];
      addEventListener('error', (e) => window.__errs.push(String(e.message || e.error)));
      addEventListener('unhandledrejection', (e) => window.__errs.push('rej:' + String(e.reason)));
      try { localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(users[0].token)}); } catch (_) {}
      /* 老吴 2026-10-30「不要停留在俱乐部页面」：光看最终态不够 —— 先闪一下俱乐部列表
         再跳进牌桌，体感同样是「进去了停在俱乐部」。这里逐帧采样：
         只要出现过「俱乐部列表可见 且 牌桌不可见」，就记上一笔。 */
      window.__sawClubsBeforePlay = false;
      try {
        if (sessionStorage.getItem('__watchClubs') === '1') {
          const tick = () => {
            const c = document.getElementById('clubs-view');
            const p = document.getElementById('play');
            if (c && p && !c.hidden && p.hidden) window.__sawClubsBeforePlay = true;
            if (!window.__sawClubsBeforePlay) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }
      } catch (_) {}`,
  });
  const gotoNet = async () => {
    await s.cdp.send('Page.navigate', { url: `${BASE}/app/net` });
    for (let i = 0; i < 250; i++) {
      const ready = await s.cdp.eval('!!(window.__net3d && window.__net3d.state.user)').catch(() => false);
      if (ready) return true;
      await sleep(100);
    }
    return false;
  };
  ok(await gotoNet(), '3D 页面加载并自动登录');

  /* ---- 入桌 + 三家陪打 + 开局 ---- */
  const { io } = await import('../node_modules/socket.io-client/build/esm/index.js');
  const driveSock = (sock) => {
    sock.on('table:state', ({ view } = {}) => {
      if (!view || !view.me) return;
      if (view.phase === 'settled') {
        const c = (view.me.legal || []).find((x) => x.type === 'confirm');
        if (c) sock.emit('action', c);
        return;
      }
      const legal = view.me.legal || [];
      const a = legal.find((x) => x.type === 'discard') || legal.find((x) => x.type === 'pass') || legal[0];
      if (a) sock.emit('action', a);
    });
  };
  const openSocket = async (u) => {
    const sock = io(BASE, { path: '/play', auth: { token: u.token }, transports: ['websocket'] });
    await new Promise((res, rej) => { sock.on('connect', res); sock.on('connect_error', rej); });
    const ack = await new Promise((res) => sock.emit('table:join', { tableId: table.id }, res));
    driveSock(sock);
    return { sock, ack };
  };

  await s.cdp.eval(`window.__net3d.enterTable(${table.id})`);
  await sleep(600);
  for (let i = 1; i < 4; i++) {
    const { sock } = await openSocket(users[i]);
    sockets.push({ sock, user: users[i], seat: i });
    await new Promise((res) => sock.emit('table:ready', {}, res));
    await sleep(120);
  }
  await s.cdp.eval('window.__net3d.readyUp()');
  let started = false;
  for (let i = 0; i < 200 && !started; i++) {
    started = await s.cdp.eval('!!(window.__net3d.state.view && window.__net3d.state.view.phase)').catch(() => false);
    if (!started) await sleep(100);
  }
  ok(started, '四家就绪 → 开局（页面已拿到首帧视图）');
  await sleep(800);

  const shotTable = await s.cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(SHOT_DIR, 'reconnect-before.png'), Buffer.from(shotTable.data, 'base64'));

  /* ================================================================
   * ① 重进页面 → 直接回桌
   * ================================================================ */
  const beforeReload = await s.cdp.eval(`(() => {
    let last = null;
    try { last = JSON.parse(localStorage.getItem(${JSON.stringify(LAST_TABLE_KEY)}) || 'null'); } catch (_) {}
    return { tableId: window.__net3d.state.tableId, last };
  })()`);
  ok(beforeReload.tableId === table.id, `在桌时记下 S.tableId（${beforeReload.tableId}）`);
  ok(beforeReload.last && beforeReload.last.tableId === table.id && beforeReload.last.clubId === club.id,
    `localStorage 记了「上次牌桌」(${JSON.stringify(beforeReload.last)})`);

  /* 打上「盯一眼有没有闪俱乐部列表」的标记，再重载 */
  await s.cdp.eval("(() => { try { sessionStorage.setItem('__watchClubs', '1'); } catch (_) {} })()");
  await s.cdp.send('Page.reload');
  // 重进后等待：自动回桌 + 拿回座位（room 帧 / view 帧任一到）
  let resumed = null;
  for (let i = 0; i < 250; i++) {
    resumed = await s.cdp.eval(`(() => {
      const n = window.__net3d;
      if (!n || !n.state.user) return null;
      const q = (id) => document.getElementById(id);
      return {
        tableId: n.state.tableId,
        clubId: n.state.club && n.state.club.id,
        roomSeats: n.state.room && n.state.room.players ? n.state.room.players.filter(Boolean).length : 0,
        playVisible: q('play') ? !q('play').hidden : false,
        clubsVisible: q('clubs-view') ? !q('clubs-view').hidden : false,
        tableViewVisible: q('table-view') ? !q('table-view').hidden : false,
        canvas: !!document.querySelector('#table3d canvas'),
        errs: window.__errs || [],
      };
    })()`).catch(() => null);
    if (resumed && resumed.tableId === table.id && resumed.roomSeats === 4) break;
    await sleep(100);
  }
  ok(!!resumed, '重进后页面完成启动');
  ok(resumed && resumed.tableId === table.id, `重进**直接回到牌桌** #${table.id}（没有停在俱乐部页）`);
  ok(resumed && resumed.clubsVisible === false, '俱乐部列表没有停留在前台');
  ok(resumed && resumed.playVisible === true, '牌桌视图已展开（#play 可见）');
  ok(resumed && resumed.roomSeats === 4, `座位已自动接回（players=${resumed && resumed.roomSeats}）`);
  ok(resumed && resumed.clubId === club.id, `俱乐部上下文一并恢复（S.club=#${resumed && resumed.clubId}，「返回俱乐部」不用再查）`);
  const flash = await s.cdp.eval("window.__sawClubsBeforePlay === true");
  ok(flash === false, '重进过程中俱乐部列表**一帧都没露过**（不是先闪列表再跳牌桌）');
  await s.cdp.eval("(() => { try { sessionStorage.removeItem('__watchClubs'); } catch (_) {} })()");
  ok(resumed && resumed.canvas, '3D 画布已就绪');

  const shotResume = await s.cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(SHOT_DIR, 'reconnect-resumed.png'), Buffer.from(shotResume.data, 'base64'));

  /* ================================================================
   * ② 掉线头像置灰 → 重连恢复彩色
   * ================================================================ */
  const readLabels = `(() => [...document.querySelectorAll('#table3d .r3d-seat-label')].map((n) => ({
    key: n.dataset.seatKey,
    offline: n.classList.contains('offline'),
    filter: (() => { const a = n.querySelector('.avatar'); return a ? getComputedStyle(a).filter : ''; })(),
  })))()`;

  const onlineAll = await s.cdp.eval(readLabels);
  ok(onlineAll.length === 4, `四张座位卡齐全（${onlineAll.map((x) => x.key).join('/')}）`);
  ok(onlineAll.every((x) => !x.offline), '开局全员在线 → 没有一张卡是灰的');

  // 断开「下家」（seat 1；我用座位 0，所以本地键是 E）
  const target = sockets[0];
  target.sock.disconnect();
  let gray = null;
  for (let i = 0; i < 100; i++) {
    gray = await s.cdp.eval(`(() => {
      const labels = ${readLabels};
      return {
        labels,
        room: (window.__net3d.state.room && window.__net3d.state.room.players || [])
          .map((p) => (p ? { seat: p.seat, connected: p.connected } : null)),
      };
    })()`);
    if (gray.labels.some((x) => x.offline)) break;
    await sleep(100);
  }
  const eLabel = gray.labels.find((x) => x.key === 'E');
  ok(gray.room && gray.room[1] && gray.room[1].connected === false, 'table:players 报出该座位断线');
  ok(!!eLabel && eLabel.offline, '掉线玩家的座位卡带上 offline 类');
  ok(!!eLabel && /grayscale\(1\)/.test(eLabel.filter), `该头像被置灰（filter=${eLabel && eLabel.filter}）`);
  ok(gray.labels.filter((x) => x.offline).length === 1, '只有掉线那一家变灰，其他三家照旧');

  const shotGray = await s.cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(SHOT_DIR, 'reconnect-offline.png'), Buffer.from(shotGray.data, 'base64'));

  // 重连（同 token 新 socket，服务端把座位还给他）
  const back = await openSocket(target.user);
  sockets[0] = { sock: back.sock, user: target.user, seat: 1 };
  ok(!!back.ack && !back.ack.error && back.ack.reconnected === true, `断线者重连拿回座位（${JSON.stringify(back.ack)}）`);

  let back2 = null;
  for (let i = 0; i < 100; i++) {
    back2 = await s.cdp.eval(readLabels);
    if (back2.every((x) => !x.offline)) break;
    await sleep(100);
  }
  ok(back2 && back2.every((x) => !x.offline), '重连后头像立刻恢复彩色（offline 类被撤掉）');
  const restoreFilter = back2 && back2.find((x) => x.key === 'E');
  ok(!!restoreFilter && !/grayscale/.test(restoreFilter.filter), `颜色恢复（filter=${restoreFilter && restoreFilter.filter}）`);

  /* ================================================================
   * ③ 负向：记录指向一张不存在的牌桌 → 安静退回俱乐部，不卡住
   * ================================================================ */
  const fallback = await s.cdp.eval(`(async () => {
    localStorage.setItem(${JSON.stringify(LAST_TABLE_KEY)}, JSON.stringify({ tableId: 987654, clubId: ${club.id}, at: Date.now() }));
    const r = await window.__net3d.resumeLastTable();
    const q = (id) => document.getElementById(id);
    return {
      resumed: r,
      tableId: window.__net3d.state.tableId,
      clubsVisible: q('clubs-view') ? !q('clubs-view').hidden : false,
      note: (q('status-clubs') || {}).textContent || '',
      lastCleared: localStorage.getItem(${JSON.stringify(LAST_TABLE_KEY)}) === null,
      errs: window.__errs || [],
    };
  })()`);
  ok(fallback.resumed === false, '坏记录不会把用户钉在假牌桌上');
  ok(fallback.clubsVisible === true && fallback.tableId === null, '回落到俱乐部列表（S.tableId 已清空）');
  ok(fallback.lastCleared, '坏记录已被清除，下次启动不再重试');
  ok(/不可用/.test(fallback.note), `界面给了提示：「${fallback.note}」`);

  ok((fallback.errs || []).length === 0,
    `全程无未捕获 JS 错误${(fallback.errs || []).length ? ' → ' + fallback.errs.join(' | ') : ''}`);
} catch (e) {
  console.error('\n💥 脚本异常：', e);
  fails.push('脚本异常：' + (e && e.message));
} finally {
  if (chrome) teardownChrome(chrome);
  for (const { sock } of sockets) { try { sock.disconnect(); } catch { /* 已断 */ } }
  try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
  rmSync(DATA, { recursive: true, force: true });
}

console.log(fails.length
  ? `\n❌ 重连 / 掉线头像：${pass} 通过 / ${fails.length} 失败\n   ${fails.join('\n   ')}`
  : `\n✅ 重连 / 掉线头像：${pass} 通过 / 0 失败`);
exitCode = fails.length ? 1 : 0;
process.exitCode = exitCode;
