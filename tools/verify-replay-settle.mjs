#!/usr/bin/env node
/**
 * 探针：验证「回放播完一把后弹只读结算汇总，样式同对局页」。
 *   ① 起真实服务端（临时端口 + 临时 DATA_DIR）
 *   ② 4 个 socket 陪打打完一整把（服务端自动存回放）
 *   ③ 取回放 id → 无头 Chrome 自动登录 → 调 window.__net3d.openReplay(id)
 *   ④ 拖到终局 → 断言 #settle 可见 + 4 家行 + 关闭按钮 + 计番/手牌结构 → 截图
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { findChrome, launchChrome, teardownChrome, freePort, sleep } from './lib/chrome.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN_KEY = 'mahjon:net:token';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };
const rnd = () => Math.random().toString(36).slice(2, 8);

async function api(BASE, path, method = 'GET', body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}
function connect(BASE, token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { path: '/play', auth: { token }, transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}
const emitAck = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
function normalize(a) {
  if (!a) return null;
  const o = { type: a.type, tile: a.tile ?? null };
  if (a.type === 'chi') { if (a.tiles && a.tiles.length) o.tiles = a.tiles; else if (a.combos && a.combos[0]) o.tiles = a.combos[0]; else return null; }
  return o;
}
function viewPick(view) {
  const legal = (view.me.legal || []).map(normalize).filter(Boolean);
  const by = (t) => legal.find((a) => a.type === t);
  if (by('win')) return by('win');
  for (const t of ['peng', 'zhi', 'an', 'xu', 'skingang', 'redgang', 'wildgang', 'chi']) { const a = by(t); if (a) return a; }
  const cnt = new Map(); for (const t of view.me.hand) cnt.set(t, (cnt.get(t) || 0) + 1);
  let best = null, bs = 1e9;
  for (const a of legal) {
    if (a.type !== 'discard') continue;
    const c = cnt.get(a.tile) || 1;
    const sc = c * 10 + (a.tile >= 27 ? -4 : a.tile % 9 === 0 || a.tile % 9 === 8 ? -1 : 0);
    if (sc < bs) { bs = sc; best = a; }
  }
  return best || by('pass') || legal[0];
}

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), 'mj-repsettle-'));
const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });

let session = null;
try {
  let up = false; for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(BASE + '/health')).ok; } catch {} if (!up) await sleep(100); }
  if (!up) throw new Error('server down: ' + log.slice(-400));
  ok(true, `服务端就绪 ${BASE}`);

  // 前置：4 人 + 俱乐部 + 牌桌
  const users = [];
  for (let i = 0; i < 4; i++) {
    const d = (await api(BASE, '/api/auth/register', 'POST', { username: `rs_${i}_${rnd()}`, password: 'pass1234' })).data;
    users.push({ token: d.token, username: d.user.username, id: d.user.id });
  }
  const club = (await api(BASE, '/api/clubs', 'POST', { name: 'RS俱乐部_' + rnd() }, users[0].token)).data.club;
  for (const u of users.slice(1)) await api(BASE, `/api/clubs/${club.id}/members`, 'POST', { username: u.username }, users[0].token);
  const table = (await api(BASE, `/api/clubs/${club.id}/tables`, 'POST', { name: 'RS桌', circleCount: 1, rules: { preset: 'koukou' } }, users[0].token)).data.table;
  ok(!!(club && table), `前置：4 人 + 俱乐部 #${club.id} + 牌桌 #${table.id}`);

  // 4 socket 全部自动应招（含座位 0，不经过 net-driver）
  const sockets = [];
  let handSettled = false, dead = 0, started = false;
  for (let i = 0; i < 4; i++) {
    const s = await connect(BASE, users[i].token);
    const jak = await emitAck(s, 'table:join', { tableId: table.id });
    console.log(`  · 玩家${i} join ack = ${JSON.stringify(jak)}`);
    s.on('table:started', () => { started = true; });
    s.on('table:handSettled', () => { handSettled = true; });
    s.on('table:finished', () => { handSettled = true; });
    s.on('table:state', ({ view }) => {
      if (!view) return;
      if (view.phase === 'settled') {
        const c = (view.me?.legal || []).find((x) => x.type === 'confirm');
        if (c) { dead++; s.emit('action', c); }
        return;
      }
      if (!(view.me && view.me.legal && view.me.legal.length)) return;
      const a = viewPick(view);
      if (a) { dead++; s.emit('action', a); }
    });
    s.on('error', (e) => { console.log(`  · 玩家${i} socket error: ${e}`); });
    sockets.push(s);
  }
  await sleep(150);
  await emitAck(sockets[0], 'table:ready', {});
  for (let i = 1; i < 4; i++) await emitAck(sockets[i], 'table:ready', {});
  for (let i = 0; i < 50; i++) { if (started) break; await sleep(100); }
  console.log(`  · 游戏开局 = ${started}`);
  let timed = false;
  for (let i = 0; i < 600 && !handSettled; i++) await sleep(100);
  if (!handSettled) timed = true;
  ok(handSettled && !timed, `完整一把打完（陪打出招 ${dead} 次）${timed ? '（超时）' : ''}`);

  // 取回放 id
  const sess = (await api(BASE, '/api/replays/sessions/mine', 'GET', null, users[0].token)).data;
  const hands = (sess && sess.sessions && sess.sessions[0] && sess.sessions[0].hands) || [];
  const handId = hands[0] && hands[0].id;
  ok(Number.isInteger(handId), `取到回放 id=${handId}（共 ${hands.length} 把）`);
  if (!Number.isInteger(handId)) throw new Error('无回放，无法验证');

  // 无头 Chrome 打开回放
  if (!findChrome()) throw new Error('找不到 Chrome');
  session = await launchChrome({ extraArgs: ['--enable-unsafe-swiftshader', '--window-size=1280,800'] });
  await session.cdp.send('Page.enable');
  await session.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs = []; addEventListener('error', (e) => window.__errs.push(String(e.message || e.error)));
      addEventListener('unhandledrejection', (e) => window.__errs.push('rej:' + String(e.reason)));
      try { localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(users[0].token)}); } catch (_) {}`,
  });
  await session.cdp.send('Page.navigate', { url: `${BASE}/app/net` });
  let booted = false;
  for (let i = 0; i < 200 && !booted; i++) { booted = await session.cdp.eval('!!window.__net3d && !!window.__net3d.state.user').catch(() => false); if (!booted) await sleep(100); }
  ok(booted, '页面已加载并自动登录');

  // 打开回放
  await session.cdp.eval(`window.__net3d.openReplay(${handId})`);
  // 等回放加载（rp-next 可用、maxStep>0）
  let loaded = false;
  for (let i = 0; i < 100 && !loaded; i++) {
    loaded = await session.cdp.eval(`(() => { const b = document.getElementById('rp-next'); return !!(b && !b.disabled); })()`).catch(() => false);
    if (!loaded) await sleep(100);
  }
  ok(loaded, '回放加载完成（可前进）');

  // 拖到终局：反复点 rp-next 直到禁用
  await session.cdp.eval(`(() => { let n = 0; const b = document.getElementById('rp-next');
    while (b && !b.disabled && n < 500) { b.click(); n++; } return n; })()`);
  await sleep(400);

  await sleep(600);
  const info = await session.cdp.eval(`(() => {
    const box = document.getElementById('settle');
    const card = document.getElementById('settle-card');
    const rows = document.querySelectorAll('#settle-card .st-row');
    const chips = document.querySelectorAll('#settle-card .st-fan .st-chip');
    const tiles = document.querySelectorAll('#settle-card .st-tiles .tile');
    const names = document.querySelectorAll('#settle-card .st-name');
    const h3 = card ? card.querySelector('h3') : null;
    const btn = card ? card.querySelector('.st-again') : null;
    const bg = card ? getComputedStyle(card).backgroundColor : '';
    const cs = box ? getComputedStyle(box) : null;
    const cr = card ? card.getBoundingClientRect() : null;
    const cx = cr ? Math.round(cr.left + cr.width/2) : -1;
    const cy = cr ? Math.round(cr.top + cr.height/2) : -1;
    const hit = (cx>=0 && cy>=0) ? (document.elementFromPoint(cx, cy) || {}).id || (document.elementFromPoint(cx,cy)||{}).className || '?' : 'n/a';
    const replayBar = document.getElementById('replay-bar');
    const rbHidden = replayBar ? replayBar.hidden : 'no-bar';
    const attrHidden = box ? box.getAttribute('hidden') : 'no-box';
    // 强制去掉 hidden 后再读计算样式，区分「属性没去掉」还是「CSS 压制」
    let forcedDisplay = 'n/a';
    if (box) { box.removeAttribute('hidden'); forcedDisplay = getComputedStyle(box).display; box.hidden = false; }
    return {
      hidden: box ? box.hidden : true, attrHidden,
      display: cs ? cs.display : '?', forcedDisplay,
      visibility: cs ? cs.visibility : '?', zIndex: cs ? cs.zIndex : '?',
      rows: rows.length, chips: chips.length, tiles: tiles.length, names: names.length,
      h3: h3 ? h3.textContent : null, btnText: btn ? btn.textContent : null, bg,
      cardRect: cr ? { x: Math.round(cr.x), y: Math.round(cr.y), w: Math.round(cr.width), h: Math.round(cr.height) } : null,
      centerHit: hit, replayBarHidden: rbHidden,
    };
  })()`);
  ok(!info.hidden, `回放终局弹结算弹窗（hidden=${info.hidden}）`);
  ok(info.rows === 4, `四家一屏行数=${info.rows}（期望 4）`);
  ok(info.chips >= 1, `计番条目存在（st-chip=${info.chips}）`);
  ok(info.tiles >= 30, `手牌/副露牌面存在（tile=${info.tiles}）`);
  ok(info.h3 && (info.h3.startsWith('本局结束') || info.h3.startsWith('荒庄')), `节标题=${info.h3}`);
  ok(info.btnText === '关闭', `回放用「关闭」按钮（实际=${info.btnText}）`);
  ok(info.bg === 'rgb(246, 241, 230)', `柔和米色底复用（${info.bg}）`);
  console.log('  · #settle info = ' + JSON.stringify(info));
  const errs = await session.cdp.eval('window.__errs || []').catch(() => []);
  ok(errs.length === 0, `回放过程无 JS 错误${errs.length ? ' → ' + errs.join(' | ') : ''}`);

  const shot = await session.cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync('/tmp/mahjon-shots/replay-settle.png', Buffer.from(shot.data, 'base64'));
  console.log('  📸 /tmp/mahjon-shots/replay-settle.png');
} catch (e) {
  fail++; console.log('  ❌ 异常：' + (e && e.stack || e));
} finally {
  if (session) teardownChrome(session);
  server.kill('SIGKILL');
}
console.log(`\n总结：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
