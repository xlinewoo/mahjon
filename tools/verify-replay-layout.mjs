#!/usr/bin/env node
/**
 * 探针：验证回放页布局重构（老吴 2026-10-29）—— 严格与对局页一致、不占顶部、牌面放大。
 *   ① 起真实服务端（临时端口 + 临时 DATA_DIR）
 *   ② 4 个 socket 陪打打完一整把（服务端自动存回放）
 *   ③ 取回放 id → 无头 Chrome 自动登录 → 调 window.__net3d.openReplay(id)
 *   ④ 前进若干步（播放中）断言布局：
 *      - #replay-bar 已不存在（不再占顶部）
 *      - #table3d 贴顶并占满 #play 高度（顶部腾出 → 牌面放大）
 *      - #rp-info 在画布底部木纹区、可见
 *      - #rp-tools 钉在「右侧下家(E)头像」正下方、可见、左缘对齐
 *   ⑤ 拖到终局，回归断言 #settle 只读结算仍正常弹出
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
const dataDir = mkdtempSync(join(tmpdir(), 'mj-replaylayout-'));
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
    const d = (await api(BASE, '/api/auth/register', 'POST', { username: `rl_${i}_${rnd()}`, password: 'pass1234' })).data;
    users.push({ token: d.token, username: d.user.username, id: d.user.id });
  }
  const club = (await api(BASE, '/api/clubs', 'POST', { name: 'RL俱乐部_' + rnd() }, users[0].token)).data.club;
  for (const u of users.slice(1)) await api(BASE, `/api/clubs/${club.id}/members`, 'POST', { username: u.username }, users[0].token);
  const table = (await api(BASE, `/api/clubs/${club.id}/tables`, 'POST', { name: 'RL桌', circleCount: 1, rules: { preset: 'koukou' } }, users[0].token)).data.table;
  ok(!!(club && table), `前置：4 人 + 俱乐部 #${club.id} + 牌桌 #${table.id}`);

  // 4 socket 全部自动应招
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
  let loaded = false;
  for (let i = 0; i < 100 && !loaded; i++) {
    loaded = await session.cdp.eval(`(() => { const b = document.getElementById('rp-next'); return !!(b && !b.disabled); })()`).catch(() => false);
    if (!loaded) await sleep(100);
  }
  ok(loaded, '回放加载完成（可前进）');

  // 前进 8 步（停在播放中，验证布局）
  await session.cdp.eval(`(() => { const b = document.getElementById('rp-next'); for (let i = 0; i < 8 && b && !b.disabled; i++) b.click(); })()`);
  await sleep(500);

  const layout = await session.cdp.eval(`(() => {
    const play = document.getElementById('play');
    const td = document.getElementById('table3d');
    const bar = document.getElementById('replay-bar');
    const info = document.getElementById('rp-info');
    const tools = document.getElementById('rp-tools');
    const eLabel = document.querySelector('#table3d .r3d-seat-label[data-seat-key="E"]');
    const r = (el) => el ? el.getBoundingClientRect() : null;
    const pr = r(play), tr = r(td), ir = r(info), tr2 = r(tools), er = r(eLabel);
    return {
      hasTopBar: !!bar,
      playTop: pr ? Math.round(pr.top) : -1, playH: pr ? Math.round(pr.height) : -1,
      tdTop: tr ? Math.round(tr.top) : -1, tdH: tr ? Math.round(tr.height) : -1, tdBottom: tr ? Math.round(tr.bottom) : -1,
      info: info ? { vis: getComputedStyle(info).display !== 'none', top: ir ? Math.round(ir.top) : -1, bottom: ir ? Math.round(ir.bottom) : -1 } : null,
      tools: tools ? { vis: getComputedStyle(tools).display !== 'none', top: tr2 ? Math.round(tr2.top) : -1, left: tr2 ? Math.round(tr2.left) : -1, right: tr2 ? Math.round(tr2.right) : -1 } : null,
      eBottom: er ? Math.round(er.bottom) : -1, eLeft: er ? Math.round(er.left) : -1, eRight: er ? Math.round(er.right) : -1,
      hand: (() => {
        const r3 = window.__net3d && window.__net3d.renderer;
        const sp = r3 && r3.seatHandSpan ? r3.seatHandSpan('E') : null;
        return sp ? { left: Math.round(sp.left), right: Math.round(sp.right) } : null;
      })(),
      metaText: ((document.getElementById('rp-meta') || {}).textContent || '').trim(),
    };
  })()`);
  console.log('  · layout = ' + JSON.stringify(layout));

  ok(!layout.hasTopBar, '顶部不再有 #replay-bar 占位（不再压小牌面）');
  ok(layout.tdTop <= 2, `#table3d 贴顶（tdTop=${layout.tdTop}，原被顶部 bar 挤下）`);
  ok(layout.tdH >= layout.playH - 16, `#table3d 占满 #play 高度（tdH=${layout.tdH} / playH=${layout.playH}）→ 牌面放大（余量为 #play 固有边距，与对局页一致）`);
  ok(layout.info && layout.info.vis, '底部信息条 #rp-info 可见');
  ok(layout.info && layout.info.bottom >= layout.tdBottom - 4, `#rp-info 贴画布底部木纹区（infoBottom=${layout.info.bottom} / tdBottom=${layout.tdBottom}）`);
  ok(layout.info && layout.info.top > layout.tdTop + layout.tdH / 2, `#rp-info 位于画布下半（infoTop=${layout.info.top}）`);
  ok(!!layout.metaText && layout.metaText.includes('把'), `底部信息条有正文（meta="${layout.metaText}"）`);
  ok(layout.tools && layout.tools.vis, '工具箱 #rp-tools 可见');
  ok(layout.tools && layout.eBottom > 0 && layout.tools.top > layout.eBottom, `#rp-tools 在下家(E)头像正下方（toolsTop=${layout.tools.top} > eBottom=${layout.eBottom}）`);
  /* 老吴 2026-10-30 十五轮：下家卡被推到桌沿后，「左缘对齐」在物理上已不可能
     （工具条宽 ≈150、E 卡左缘到画布右缘只剩 ~90），改为「左缘对齐；装不下就右缘对齐 E 卡右缘」。 */
  ok(!!layout.hand, '能取到下家手牌列的屏幕范围（renderer.seatHandSpan）');
  ok(layout.tools && (!layout.hand || layout.tools.right <= layout.hand.left - 2
      || layout.tools.left >= layout.hand.right + 2),
    `#rp-tools 不压住下家手牌列（tools ${layout.tools.left}~${layout.tools.right} / 手牌 ${layout.hand && layout.hand.left}~${layout.hand && layout.hand.right}）`);

  const shot = await session.cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync('/tmp/mahjon-shots/replay-layout.png', Buffer.from(shot.data, 'base64'));
  console.log('  📸 /tmp/mahjon-shots/replay-layout.png');

  // 回归：拖到终局，确认只读结算仍正常弹出（之前的 settle 功能没被破坏）
  await session.cdp.eval(`(() => { let n = 0; const b = document.getElementById('rp-next');
    while (b && !b.disabled && n < 500) { b.click(); n++; } return n; })()`);
  await sleep(800);
  const settle = await session.cdp.eval(`(() => {
    const box = document.getElementById('settle');
    const card = document.getElementById('settle-card');
    const cs = box ? getComputedStyle(box) : null;
    const btn = card ? card.querySelector('.st-again') : null;
    return { hidden: box ? box.hidden : true, display: cs ? cs.display : '?',
      rows: document.querySelectorAll('#settle-card .st-row').length,
      btnText: btn ? btn.textContent : null };
  })()`);
  console.log('  · settle(regress) = ' + JSON.stringify(settle));
  ok(!settle.hidden && settle.display !== 'none', `终局只读结算仍弹出（display=${settle.display}）`);
  ok(settle.rows === 4, `四家行仍在（rows=${settle.rows}）`);
  ok(settle.btnText === '关闭', `仍是「关闭」按钮（实际=${settle.btnText}）`);

  const errs = await session.cdp.eval('window.__errs || []').catch(() => []);
  ok(errs.length === 0, `回放过程无 JS 错误${errs.length ? ' → ' + errs.join(' | ') : ''}`);
} catch (e) {
  fail++; console.log('  ❌ 异常：' + (e && e.stack || e));
} finally {
  if (session) teardownChrome(session);
  server.kill('SIGKILL');
}
console.log(`\n总结：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
