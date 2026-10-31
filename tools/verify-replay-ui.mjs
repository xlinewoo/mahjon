#!/usr/bin/env node
/**
 * 回放 UI 验证（3D，2026-10-25 重写）—— 2D 网络版已下线，回放只在 3D 页存在。
 *
 * 流程：注册 4 个账号（两个带头像）→ 建俱乐部/牌桌 → 真实 3D 页面（座位 0）+
 * 3 个 socket 陪打，双方自动出牌打完一把 → 打开该把回放 → 断言：
 *   · 回放模式生效、回放条可步进；
 *   · **3D 独占**：2D 表面（座位卡/牌河）为空且隐藏，3D 画布可见；
 *   · 座位 HUD 四家齐全（含头像）；
 *   · 全程无未捕获错误。
 *
 * 前置：服务已启动（默认 127.0.0.1:3000）。Chrome 走 swiftshader 软渲染。
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { launchChrome, teardownChrome } from './lib/chrome.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const TOKEN_KEY = 'mahjon:net:token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => Math.random().toString(36).slice(2, 8);

let pass = 0;
const fails = [];
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✅ ' + msg); } else { fails.push(msg); console.log('  ❌ ' + msg); } };

async function api(path, method = 'GET', body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const users = [];
for (let i = 0; i < 4; i++) {
  const d = (await api('/api/auth/register', 'POST', { username: `rp${i}_${rnd()}`, password: 'pass1234' })).data;
  users.push({ token: d.token, username: d.user.username, id: d.user.id });
}
// 头像预设已是 icon/ 图片库（2026-10-25 起 emoji 预设废弃，preset 值必须是
// server/assets/avatars/index.json 里的真实 id，否则服务端拒绝 → 首字回退）
const presets = JSON.parse(readFileSync(new URL('../server/assets/avatars/index.json', import.meta.url), 'utf8'));
await api('/api/me/avatar', 'PUT', { type: 'preset', value: presets[0] }, users[0].token);
await api('/api/me/avatar', 'PUT', { type: 'preset', value: presets[1] }, users[1].token);
const club = (await api('/api/clubs', 'POST', { name: '回放验证' + rnd() }, users[0].token)).data.club;
for (const u of users.slice(1)) {
  await api(`/api/clubs/${club.id}/members`, 'POST', { username: u.username }, users[0].token);
}
const table = (await api(`/api/clubs/${club.id}/tables`, 'POST',
  { name: '回放桌', circleCount: 1, rules: { preset: 'koukou' } }, users[0].token)).data.table;

const { io } = await import('../node_modules/socket.io-client/build/esm/index.js');
const sockets = [];
const s = await launchChrome({ extraArgs: ['--enable-unsafe-swiftshader', '--window-size=1280,800'] });
try {
  await s.cdp.send('Page.enable');
  await s.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs = [];
      addEventListener('error', (e) => window.__errs.push(String(e.message || e.error)));
      addEventListener('unhandledrejection', (e) => window.__errs.push('rej:' + String(e.reason)));
      try { localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(users[0].token)}); } catch (_) {}`,
  });
  await s.cdp.send('Page.navigate', { url: `${BASE}/app/net` });
  let booted = false;
  for (let i = 0; i < 200 && !booted; i++) {
    booted = await s.cdp.eval('!!window.__net3d && !!window.__net3d.state.user').catch(() => false);
    if (!booted) await sleep(100);
  }
  ok(booted, '3D 页面加载并自动登录');

  await s.cdp.eval(`window.__net3d.enterTable(${table.id})`);
  await sleep(500);
  // 页内自驱动：轮到英雄就出牌/过/确认（能跑完一把即可，不求牌效）
  await s.cdp.eval(`(() => {
    setInterval(() => {
      try {
        const d = window.__net3d.driver; if (!d) return;
        const v = d.getView(); if (!v) return;
        if (v.phase === 'settled') { const c = (v.me?.legal || []).find((x) => x.type === 'confirm'); if (c) d.act(c); return; }
        if (!d.isMyTurn()) return;
        const legal = v.me.legal || [];
        const a = legal.find((x) => x.type === 'discard') || legal.find((x) => x.type === 'pass')
          || legal.find((x) => x.type === 'pass') || legal[0];
        // 竞态兜底：轮询到出手的瞬间状态可能已变化，服务端拒绝是正确行为，吞掉即可
        if (a) { const p = d.act(a); if (p && p.catch) p.catch(() => {}); }
      } catch (_) {}
    }, 400);
  })()`);
  for (let i = 1; i < 4; i++) {
    const sock = io(BASE, { path: '/play', auth: { token: users[i].token }, transports: ['websocket'] });
    sockets.push(sock);
    await new Promise((res) => sock.on('connect', res));
    await new Promise((res) => sock.emit('table:join', { tableId: table.id }, res));
    await new Promise((res) => sock.emit('table:ready', {}, res));
    sock.on('table:state', ({ view }) => {
      if (!view) return;
      if (view.phase === 'settled') { const c = (view.me?.legal || []).find((x) => x.type === 'confirm'); if (c) sock.emit('action', c); return; }
      if (!(view.me && view.me.legal && view.me.legal.length)) return;
      const legal = view.me.legal;
      const a = legal.find((x) => x.type === 'discard') || legal.find((x) => x.type === 'pass')
        || legal.find((x) => x.type === 'pass') || legal[0];
      if (a) sock.emit('action', a);
    });
    await sleep(150);
  }
  await s.cdp.eval('window.__net3d.readyUp()');
  for (let i = 0; i < 200; i++) {
    if (await s.cdp.eval('!!window.__net3d.state.view').catch(() => false)) break;
    await sleep(100);
  }
  await sleep(2000);

  // —— 对局中断言：3D 独占 + HUD 头像 ——
  const play = await s.cdp.eval(`(() => {
    const q = (id) => document.getElementById(id);
    return {
      table2dEmpty: ['seat-top', 'seat-left', 'seat-right', 'seat-bottom', 'center'].every((id) => !q(id) || q(id).innerHTML === ''),
      canvas: !!document.querySelector('#table3d canvas'),
      avatars: [...document.querySelectorAll('#table3d .r3d-seat-label .avatar')].map((n) => {
        const img = n.querySelector('img');
        return img ? img.getAttribute('src') : n.textContent;
      }),
      errs: window.__errs || [],
    };
  })()`);
  ok(play.table2dEmpty, '对局中：2D 表面为空（3D 页不渲染 2D 座位/牌河）');
  ok(play.canvas, '对局中：3D 画布存在');
  ok(play.avatars.length === 4, `座位 HUD 四家齐全（${play.avatars.join(' ')}）`);
  const presetSrc = (i) => `/api/avatars/preset/${presets[i]}.webp`;
  ok(play.avatars.includes(presetSrc(0)) && play.avatars.includes(presetSrc(1)),
    `设置了头像的玩家显示预设图头像（${presets[0]} / ${presets[1]}）`);
  const shot1 = await s.cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(new URL('../.cache/verify-replay-play.png', import.meta.url), Buffer.from(shot1.data, 'base64'));

  // —— 等这把结束 → 打开回放 ——
  for (let i = 0; i < 600; i++) {
    const done = await s.cdp.eval(`(() => { const v = window.__net3d.state.view; return !!(v && v.phase === 'settled'); })()`).catch(() => false);
    if (done) break;
    await sleep(300);
  }
  await sleep(1000);
  const rid = await s.cdp.eval(`(async () => {
    const t = localStorage.getItem('mahjon:net:token');
    const d = await (await fetch('/api/replays/mine', { headers: { Authorization: 'Bearer ' + t } })).json();
    return d.replays && d.replays[0] ? d.replays[0].id : null;
  })()`);
  ok(!!rid, `回放已落库（id=${rid}）`);
  if (rid) {
    await s.cdp.eval(`window.__net3d.openReplay(${rid})`);
    await sleep(2000);
    for (let i = 0; i < 8; i++) { await s.cdp.eval(`document.getElementById('rp-next')?.click()`); await sleep(300); }
    const rep = await s.cdp.eval(`(() => {
      const q = (id) => document.getElementById(id);
      const t2 = q('table');
      return {
        replayMode: document.body.classList.contains('replay-mode'),
        table2dDisplay: t2 ? getComputedStyle(t2).display : 'absent',
        table2dEmpty: ['seat-top', 'seat-left', 'seat-right', 'seat-bottom', 'center'].every((id) => !q(id) || q(id).innerHTML === ''),
        canvasVisible: (() => { const c = document.querySelector('#table3d canvas'); return c ? c.offsetHeight > 200 : false; })(),
        // 2026-10-29：控件条已拆成 #rp-info（底部木纹信息）+ #rp-tools（下家头像下按钮），
        // 旧的 #replay-bar 早已删除；这里改判新元素，否则永远红。
        bar: ['rp-info', 'rp-tools'].every((id) => {
          const n = q(id);
          return n && !n.hidden && getComputedStyle(n).display !== 'none';
        }),
        step: q('rp-step') ? q('rp-step').textContent : null,
        errs: window.__errs || [],
      };
    })()`);
    ok(rep.replayMode, '回放模式生效');
    ok(rep.table2dDisplay === 'none' && rep.table2dEmpty, '回放中：2D 表面隐藏且为空（不被 2D 挤占）');
    ok(rep.canvasVisible, '回放中：3D 画布可见且占满');
    ok(rep.bar, `回放条正常（步进 ${rep.step}）`);
    ok(rep.errs.length === 0, `全程无未捕获错误${rep.errs.length ? ' → ' + rep.errs.join(' | ') : ''}`);
    const shot2 = await s.cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(new URL('../.cache/verify-replay-view.png', import.meta.url), Buffer.from(shot2.data, 'base64'));
  }
} finally {
  teardownChrome(s);
  for (const sock of sockets) sock.disconnect();
}
console.log(fails.length ? `\n❌ 回放 UI：${pass} 通过 / ${fails.length} 失败` : `\n✅ 回放 UI：${pass} 通过 / 0 失败`);
process.exitCode = fails.length ? 1 : 0;
