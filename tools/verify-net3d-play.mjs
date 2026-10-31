#!/usr/bin/env node
/**
 * 3D 客户端「实战」验证（tools/verify-net3d-play.mjs）
 *
 * 目标：证明「/app/net」是一个能真正打完一把的网络客户端，而不只是能画桌子的壳。
 * 做法：
 *   ① 起真实服务端（REST + Socket.IO 同端口）；
 *   ② 注册 4 人、建俱乐部 + 牌桌；
 *   ③ 座位 0 = **真·无头 Chrome 打开的 /app/net 页面**（走真实大厅 → 入桌 → net-driver）；
 *      座位 1..3 = 三个 socket 陪打（只用自己那份 view 决策）；
 *   ④ 四人「准备」开局，页面用**真实驱动**打完一整把；
 *   ⑤ 全程断言 3D 场景随服务端 view 实时更新（手牌/弃牌张数、骰子点数、结算摊牌）。
 *
 * 为什么不是 jsdom：3D 需要 WebGL + canvas，jsdom 顶不住 → 必须真浏览器（tools/lib/chrome.mjs）。
 *
 * 用法：node tools/verify-net3d-play.mjs
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
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ✅ ${msg}`); } else { fail++; console.log(`  ❌ ${msg}`); } };
const rnd = () => Math.random().toString(36).slice(2, 8);

let BASE = '';

async function api(path, method = 'GET', body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch (_) { /* 非 JSON */ }
  return { status: res.status, data };
}

async function register(p) {
  const d = (await api('/api/auth/register', 'POST', { username: `${p}_${rnd()}`, password: 'pass1234' })).data;
  return { token: d.token, username: d.user.username, id: d.user.id };
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, { path: '/play', auth: { token }, transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}
const emitAck = (socket, ev, payload) => new Promise((resolve) => socket.emit(ev, payload, resolve));

/** 把 view 里的合法动作补全成能发出去的形状（吃要展成 tiles；seat 由服务端按握手身份补） */
function normalize(a) {
  if (!a) return null;
  const o = { type: a.type, tile: a.tile ?? null };
  if (a.type === 'chi') {
    if (a.tiles && a.tiles.length) o.tiles = a.tiles;
    else if (a.combos && a.combos[0]) o.tiles = a.combos[0];
    else return null;
  }
  return o;
}

/** 只用「自己那份 view」的陪打策略：能胡就胡 → 有碰/吃/杠就开 → 打孤张。见 verify-net-e2e 的论证。 */
function viewPick(view) {
  const legal = (view.me.legal || []).map(normalize).filter(Boolean);
  const by = (t) => legal.find((a) => a.type === t);
  if (by('win')) return by('win');
  for (const t of ['peng', 'zhi', 'an', 'xu', 'skingang', 'redgang', 'wildgang', 'chi']) {
    const a = by(t); if (a) return a;
  }
  const cnt = new Map();
  for (const t of view.me.hand) cnt.set(t, (cnt.get(t) || 0) + 1);
  let best = null, bestScore = 1e9;
  for (const a of legal) {
    if (a.type !== 'discard') continue;
    const c = cnt.get(a.tile) || 1;
    const score = c * 10 + (a.tile >= 27 ? -4 : a.tile % 9 === 0 || a.tile % 9 === 8 ? -1 : 0);
    if (score < bestScore) { bestScore = score; best = a; }
  }
  return best || by('pass') || legal[0];
}

/* ================================================================== */
const port = await freePort();
BASE = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), 'mj-net3dplay-'));

console.log('════════ /app/net 实战：真服务端 + 无头 3D 页面打完整一把 ════════');

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

let session = null;
const sockets = [];
try {
  // —— 等 /health ——
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(BASE + '/health')).ok; } catch { /* 还没起 */ }
    if (!up) await sleep(100);
  }
  if (!up) throw new Error('服务端没起来：' + serverLog.slice(-400));
  ok(true, `服务端就绪 ${BASE}`);

  // —— 前置：4 人 + 俱乐部 + 牌桌 ——
  const users = [];
  for (let i = 0; i < 4; i++) users.push(await register('p3d'));
  const club = (await api('/api/clubs', 'POST', { name: '3D俱乐部' }, users[0].token)).data.club;
  for (const u of users.slice(1)) await api(`/api/clubs/${club.id}/members`, 'POST', { username: u.username }, users[0].token);
  const table = (await api(`/api/clubs/${club.id}/tables`, 'POST',
    { name: '3D桌', circleCount: 1, rules: { preset: 'koukou' } }, users[0].token)).data.table;
  ok(!!(table && table.id), `前置就绪：4 人 + 俱乐部 #${club.id} + 牌桌 #${table.id}`);

  // —— 真·3D 页面（座位 0）——
  if (!findChrome()) throw new Error('找不到 Chrome');
  session = await launchChrome({ extraArgs: ['--enable-unsafe-swiftshader', '--window-size=1280,800'] });
  await session.cdp.send('Page.enable');
  // 注入错误钩子 + 预先写入登录令牌（boot() 会据此自动登录，免去驱动登录表单）
  await session.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs = [];
      addEventListener('error', (e) => window.__errs.push(String(e.message || e.error)));
      addEventListener('unhandledrejection', (e) => window.__errs.push('rej:' + String(e.reason)));
      try { localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(users[0].token)}); } catch (_) {}`,
  });
  await session.cdp.send('Page.navigate', { url: `${BASE}/app/net` });

  let booted = false;
  for (let i = 0; i < 200 && !booted; i++) { booted = await session.cdp.eval('!!window.__net3d && !!window.__net3d.state.user').catch(() => false); if (!booted) await sleep(100); }
  ok(booted, '3D 页面已加载并自动登录（token 从 localStorage 恢复）');
  const initErrs = await session.cdp.eval('window.__errs || []').catch(() => []);
  ok(initErrs.length === 0, `加载无未捕获错误${initErrs.length ? ' → ' + initErrs.join(' | ') : ''}`);

  // —— 页面入桌（座位 0）——
  await session.cdp.eval(`window.__net3d.enterTable(${table.id})`);
  let seated = false;
  for (let i = 0; i < 100 && !seated; i++) {
    seated = await session.cdp.eval('(() => { const r = window.__net3d.state.room; return !!(r && r.players && r.players.filter(Boolean).length >= 1); })()').catch(() => false);
    if (!seated) await sleep(100);
  }
  ok(seated, '页面已入桌（服务端广播 table:players）');

  // —— 三个陪打入座 1..3 ——
  for (let i = 1; i < 4; i++) {
    const s = await connect(users[i].token);
    const ack = await emitAck(s, 'table:join', { tableId: table.id });
    ok(ack.ok && ack.seat === i, `陪打 ${i} 入座 seat=${ack.seat}`);
    sockets.push(s);
  }
  const heroSeat = await session.cdp.eval('window.__net3d.driver ? window.__net3d.driver.MY_SEAT : -1');
  ok(heroSeat === 0 || heroSeat === -1, `页面座位 = ${heroSeat}（开局前驱动未建时为 -1，属正常）`);

  // —— 陪打自动应招 ——
  let botActs = 0;
  for (const s of sockets) {
    s.on('table:state', ({ view }) => {
      if (!view) return;
      // 胡牌摊牌：陪打也要点「确认」（老吴 2026-10-20）
      if (view.phase === 'settled') {
        const c = (view.me?.legal || []).find((x) => x.type === 'confirm');
        if (c) { botActs++; s.emit('action', c); }
        return;
      }
      if (!(view.me && view.me.legal && view.me.legal.length)) return;
      const a = viewPick(view);
      if (a) { botActs++; s.emit('action', a); }
    });
    s.on('error', () => {});
  }

  // —— 四人准备 → 开局 ——
  await session.cdp.eval('window.__net3d.readyUp()');
  for (const s of sockets) await emitAck(s, 'table:ready', {});

  let started = false;
  for (let i = 0; i < 150 && !started; i++) {
    started = await session.cdp.eval('(() => { const d = window.__net3d.driver; return !!(d && d.getView()); })()').catch(() => false);
    if (!started) await sleep(100);
  }
  ok(started, '四人齐 + 全准备 → 页面收到首帧 table:state（驱动已建）');

  const first = await session.cdp.eval(`(() => {
    const d = window.__net3d.driver, v = d.getView();
    const r = window.__net3d.renderer;
    return { seat: d.MY_SEAT, hand: v.me.hand.length, dealer: v.dealer, dice: v.dice, canvas: document.querySelectorAll('#table3d canvas').length };
  })()`);
  ok(first.hand === 13 || first.hand === 14, `首帧手牌 ${first.hand} 张（13 或庄家 14）`);
  ok(Array.isArray(first.dice) && first.dice.length === 2 && first.dice.every((v) => v >= 1 && v <= 6), `服务端下发骰子 ${JSON.stringify(first.dice)}`);
  ok(first.canvas >= 1, `3D 画布已挂在 #table3d（canvas=${first.canvas}）`);

  // —— 3D 皮肤切换：选项、即时换贴图、持久化 ——
  const skin = await session.cdp.eval(`(async () => {
    const sel = document.getElementById('tileskin');
    if (!sel) return { error: 'no select' };
    const opts = [...sel.options].map((o) => [o.value, o.textContent]);
    const faceUrl = () => {
      const r = window.__net3d.renderer, m = r.myHand[0];
      if (!m) return '';
      const mat = Array.isArray(m.material) ? m.material[4] : m.material;
      return mat && mat.map && mat.map.image ? mat.map.image.toDataURL() : '';
    };
    const before = faceUrl();
    const target = opts.find(([id]) => id !== sel.value);
    if (!target) return { error: 'only one skin', opts };
    sel.value = target[0];
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    let after = '';
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 20));
      after = faceUrl();
      if (after && after !== before) break;
    }
    return {
      opts, target: target[0], changed: !!after && after !== before, beforeLen: before.length,
      afterLen: after.length, stored: localStorage.getItem('mahjon:tile-skin:3d'),
    };
  })()`);
  ok(!skin.error, `3D 皮肤选项：${(skin.opts || []).map((x) => x[1]).join(' / ')}`);
  ok(skin.changed, `切换 3D 皮肤后贴图即时重建（${skin.beforeLen} → ${skin.afterLen}）`);
  ok(skin.stored === skin.target, `3D 皮肤选择已持久化（${skin.stored}）`);

  // —— 页面用真实驱动打完这一把（Node 侧按 view 决策，页面侧 driver.act 发招）——
  // 先装一个「按真实屏幕坐标 dispatch 指针事件」的助手 —— 用来验证**点手牌真的能出牌**
  // （老吴 2026-10-19 报的 bug：操作条浮在画布上挡住手牌，点不出牌）。
  await session.cdp.eval(`window.__ptr = {
    coords(i) { const r = window.__net3d.renderer, m = r.myHand[i]; if (!m) return null;
      const p = m.getWorldPosition(m.position.clone()); p.project(r.camera);
      const rect = r.renderer.domElement.getBoundingClientRect();
      return { x: rect.left + (p.x*0.5+0.5)*rect.width, y: rect.top + (-p.y*0.5+0.5)*rect.height }; },
    who(x, y) { const el = document.elementFromPoint(x, y); return el ? (el.id || el.className || el.tagName) : null; },
    fire(t, x, y) { const el = document.getElementById('table3d');
      el.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true })); },
    clickFirst() { const c = this.coords(0); if (!c) return { err: 'no tile' };
      const who = this.who(c.x, c.y);
      this.fire('pointermove', c.x, c.y); this.fire('pointerdown', c.x, c.y); this.fire('pointerup', c.x, c.y);
      return { who, x: Math.round(c.x), y: Math.round(c.y) }; },
    clickAt(i) { const c = this.coords(i); if (!c) return { err: 'no tile' };
      const who = this.who(c.x, c.y);
      this.fire('pointermove', c.x, c.y); const h = window.__net3d.renderer.getHovered();
      this.fire('pointerdown', c.x, c.y); this.fire('pointerup', c.x, c.y);
      return { who, x: Math.round(c.x), y: Math.round(c.y), hovered: h ? h.userData.code : null }; },
    // 返回「可出牌、且投影点确实落在画布内」的手牌下标（离边至少 8px）
    pickable() { const r = window.__net3d.renderer, v = window.__net3d.driver.getView();
      const rect = r.renderer.domElement.getBoundingClientRect(); const out = [];
      for (let i = 0; i < r.myHand.length; i++) {
        const m = r.myHand[i]; const code = m.userData.code;
        if (!r.isDiscardable(code)) continue;
        const p = m.getWorldPosition(m.position.clone()); p.project(r.camera);
        const x = rect.left + (p.x*0.5+0.5)*rect.width, y = rect.top + (-p.y*0.5+0.5)*rect.height;
        if (x > rect.left + 8 && x < rect.right - 8 && y > rect.top + 8 && y < rect.bottom - 8) out.push(i);
      }
      return out; },
    // 原子操作：判定 → 选一张可出的牌 → 真实指针点击（全过程同步，避免中途收到新帧）
    clickAny() { const r = window.__net3d.renderer, d = window.__net3d.driver;
      const v = d.getView();
      if (v.phase !== 'discard' || !d.isMyTurn()) return { skip: v.phase };
      const rect = r.renderer.domElement.getBoundingClientRect(); const cands = [];
      for (let i = 0; i < r.myHand.length; i++) {
        const m = r.myHand[i]; const code = m.userData.code;
        if (!r.isDiscardable(code)) continue;
        const p = m.getWorldPosition(m.position.clone()); p.project(r.camera);
        const x = rect.left + (p.x*0.5+0.5)*rect.width, y = rect.top + (-p.y*0.5+0.5)*rect.height;
        if (x > rect.left + 8 && x < rect.right - 8 && y > rect.top + 8 && y < rect.bottom - 8) cands.push({ code, x, y });
      }
      if (!cands.length) return { skip: 'no-cand' };
      const c = cands[Math.floor(cands.length / 2)];
      const who = this.who(c.x, c.y);
      if (!window.__actCalls) { window.__actCalls = []; const oa = d.act.bind(d); d.act = (a) => { window.__actCalls.push(a); return oa(a); }; }
      const n0 = window.__actCalls.length;
      this.fire('pointermove', c.x, c.y); const h = r.getHovered();
      // 两段式出牌（老吴 2026-10-24）：第一击＝选中，第二击同点＝打出
      this.fire('pointerdown', c.x, c.y); this.fire('pointerup', c.x, c.y);
      this.fire('pointerdown', c.x, c.y); this.fire('pointerup', c.x, c.y);
      return { code: c.code, who, hovered: h ? h.userData.code : null, actedN: window.__actCalls.length - n0, x: Math.round(c.x), y: Math.round(c.y) }; },
  };`);

  let heroActs = 0, snapshotTaken = false, snap = null, settled = false;
  let revealSnap = null; // 胡牌后「已摊牌、等确认」的那一帧
  let hudBad = 0, hudChecks = 0, hudMaxBtns = 0, hudOverlapBad = 0;
  let pointerTested = false, pointerOk = null, pointerInfo = '', pointerTries = 0;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const st = await session.cdp.eval(`(() => {
      const d = window.__net3d.driver; if (!d || !d.getView()) return null;
      const v = d.getView(); const r = window.__net3d.renderer;
      const controls = document.getElementById('controls');
      const btns = controls ? controls.querySelectorAll('button').length : 0;
      const nonDiscard = (v.me.legal || []).some((a) => a.type !== 'discard');
      const cv = document.querySelector('#table3d canvas');
      const cb = cv ? cv.getBoundingClientRect() : null;
      const cr = controls ? controls.getBoundingClientRect() : null;
      // 操作条是否压在画布上（浮层，正常情况下会；关键是别压到手牌，见下）
      const overlapsCanvas = !!(cb && cr && cr.height > 0 && cr.top < cb.bottom - 1);
      // 自家手牌：躺平(俯视 2D)+放大，且不贴画布下沿；同时记录手牌最高点屏幕 y
      let standing = 0, scaled = 0, minTop = Infinity, minBottom = Infinity;
      for (const m of r.myHand) {
        if (m.rotation.x < -1.2) standing++;   // 躺平（-PI/2≈-1.57）；2026-10-24 俯视改造：四家全躺平
        if (m.scale.x > 1.15) scaled++;
        const wp = m.getWorldPosition(m.position.clone()); wp.y += (0.062 * m.scale.y) / 2; wp.project(r.camera);
        if (cb) { minTop = Math.min(minTop, cb.top + (-wp.y * 0.5 + 0.5) * cb.height); }
        const wc = m.getWorldPosition(m.position.clone()); wc.project(r.camera);
        if (cb) minBottom = Math.min(minBottom, cb.top + (-wc.y * 0.5 + 0.5) * cb.height);
      }
      const total = r.myHand.length;
      const hand = {
        standing, scaled, total,
        marginBottom: Number.isFinite(minBottom) && cb ? Math.round(cb.bottom - minBottom) : null,
      };
      // 操作条底边 vs 手牌最高点：操作条应整体**在手牌上方**（底边 <= 手牌顶边）
      const ctrlAboveHand = !!(cr && cr.height > 0 && Number.isFinite(minTop) && cr.bottom <= minTop + 2);
      // —— 老吴 2026-10-19 新 UI 口径：只留按钮、无提示文字/文本框；锁定视角；整屏铺满；无滚动条 ——
      const hintEl = controls && controls.querySelector('.hint');
      const winEl = controls && controls.querySelector('.win-prompt');
      const cs = controls ? getComputedStyle(controls) : null;
      const playR = document.getElementById('play').getBoundingClientRect();
      const de = document.documentElement;
      // 癞子绿标：任取一张**明牌**的癞子贴图，采样左上角绿块内部（跨过圆角与文字；老吴 2026-10-28 八轮：绿底「赖」）
      let wildRed = null;
      if (r && Number.isInteger(v.wildTile)) {
        let wm = null;
        for (const k of ['S', 'E', 'N', 'W']) {
          for (const g of ['hand', 'meld', 'discard']) {
            for (const x of r.groups[k][g].children) {
              if (x.userData.faceUp && x.userData.code === v.wildTile) { wm = x; break; }
            }
            if (wm) break;
          }
          if (wm) break;
        }
        if (wm) {
          try {
            const mat = Array.isArray(wm.material) ? wm.material[4] : wm.material;
            const c = mat.map.image.getContext('2d');
            const p = c.getImageData(34, 10, 1, 1).data;
            wildRed = [p[0], p[1], p[2]];
          } catch (e) { wildRed = String(e); }
        }
      }
      const badge = document.getElementById('wild-badge');
      // 皮子红标：任取一张**明牌**皮子贴图，采样左上角红块内部（老吴 2026-10-28 八轮：红底「皮」）。
      // 注意：红中(31)也在 skinTiles 里，但红中恒为蓝块，故这里排除 31，只采真正的「皮」（非红中）。
      let skinBlue = null;
      if (r) {
        let sm = null;
        for (const k of ['S', 'E', 'N', 'W']) {
          for (const g of ['hand', 'meld', 'discard']) {
            for (const x of r.groups[k][g].children) {
              if (x.userData.faceUp && x.userData.code !== v.wildTile && x.userData.code !== 31
                && (v.skinTiles || []).includes(x.userData.code)) { sm = x; break; }
            }
            if (sm) break;
          }
          if (sm) break;
        }
        if (sm) {
          try {
            const mat = Array.isArray(sm.material) ? sm.material[4] : sm.material;
            const c = mat.map.image.getContext('2d');
            const p = c.getImageData(34, 10, 1, 1).data;
            skinBlue = [p[0], p[1], p[2]];
          } catch (e) { skinBlue = String(e); }
        }
      }
      // 红中无角标（老吴 2026-10-28 13:39 明确）：采样左上角，仅用于验证它不是蓝块（防回归）
      let zhongBlue = null;
      if (r) {
        let zm = null;
        for (const k of ['S', 'E', 'N', 'W']) {
          for (const g of ['hand', 'meld', 'discard']) {
            for (const x of r.groups[k][g].children) {
              if (x.userData.faceUp && x.userData.code === 31) { zm = x; break; }
            }
            if (zm) break;
          }
          if (zm) break;
        }
        if (zm) {
          try {
            const mat = Array.isArray(zm.material) ? zm.material[4] : zm.material;
            const c = mat.map.image.getContext('2d');
            const p = c.getImageData(34, 10, 1, 1).data;
            zhongBlue = [p[0], p[1], p[2]];
          } catch (e) { zhongBlue = String(e); }
        }
      }
      return {
        phase: v.phase, myTurn: d.isMyTurn(), handCount: v.me.hand.length,
        view: v, settleHidden: !!(document.getElementById('settle') && document.getElementById('settle').hidden),
        btnTexts: [...(controls ? controls.querySelectorAll('button') : [])].map((b) => b.textContent),
        counts: r ? r.counts() : null, dice: r ? r.diceValues : null,
        controlsInPlay: !!(controls && controls.closest('#play') && !controls.closest('#table')),
        controlsBtns: btns, nonDiscard, overlapsCanvas, hand, ctrlAboveHand,
        bar: cs ? {
          bg: cs.backgroundColor, border: cs.borderTopWidth, pad: cs.padding,
          hint: hintEl ? getComputedStyle(hintEl).display : null,
          win: winEl ? getComputedStyle(winEl).display : null,
        } : null,
        rot: r && r.controls ? [r.controls.enableRotate, r.controls.enableZoom, r.controls.enablePan] : null,
        fullBleed: !!(cb && playR && Math.abs(cb.width - innerWidth) <= 1
          && Math.abs(playR.width - innerWidth) <= 1 && Math.abs(playR.height - innerHeight) <= 1),
        noScroll: !!(de && de.scrollWidth <= innerWidth + 1 && de.scrollHeight <= innerHeight + 1),
        badge: badge ? { hidden: badge.hidden, text: badge.textContent.trim(), title: badge.getAttribute('title') || '' } : null,
        wild: v.wildTile, wildRed, skins: v.skinTiles || [], skinBlue, zhongBlue,
        handCodes: r && r.myHand ? r.myHand.map((m) => m.userData.code) : null,
      };
    })()`).catch(() => null);
    if (!st) { await sleep(50); continue; }

    // 操作条必须在 #play 内（不是落在隐藏的 2D 牌桌里），且**绝不能压在画布上**。
    // 有「非出牌」合法动作（碰/吃/杠/胡/过）时必须有按钮。
    if (st.phase !== 'settled') {
      if (!st.controlsInPlay) hudBad++;
      // 操作条现在是画布内的浮层（贴在手牌上方），允许压在画布上；但**绝不能压住手牌**
      if (st.controlsBtns > 0 && !st.ctrlAboveHand) hudOverlapBad++;
      if (st.nonDiscard) { hudChecks++; hudMaxBtns = Math.max(hudMaxBtns, st.controlsBtns); if (st.controlsBtns === 0) hudBad++; }
    }

    if (!snapshotTaken && st.phase === 'discard' && st.myTurn) { snapshotTaken = true; snap = st; }
    if (st.phase === 'settled') {
      // 胡牌摊牌：hero 先点「确认」；四家都确认完（pending=false）才弹结算页
      if (st.view.reveal && st.view.reveal.pending) {
        if (!revealSnap) {
          if (process.env.SHOT_DIR) {
            const vm = /^(\d+)x(\d+)$/.exec(process.env.SHOT_VIEWPORT || '');
            if (vm) await session.cdp.send('Emulation.setDeviceMetricsOverride', { width: +vm[1], height: +vm[2], deviceScaleFactor: 1, mobile: false });
            if (vm) await sleep(160);
            const shot = await session.cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
            if (shot && shot.data) writeFileSync(join(process.env.SHOT_DIR, 'reveal-3d.png'), Buffer.from(shot.data, 'base64'));
            if (vm) await session.cdp.send('Emulation.clearDeviceMetricsOverride');
          }
          revealSnap = {
            settleHidden: st.settleHidden,
            btnTexts: st.btnTexts,
            othersHand: st.view.others.map((o) => (Array.isArray(o.hand) ? o.hand.length : -1)),
            faces: st.counts ? ['E', 'N', 'W'].map((k) => st.counts.per[k].hand) : null,
          };
        }
        const c = (st.view.me.legal || []).find((a) => a.type === 'confirm');
        if (c) {
          try { await session.cdp.eval(`window.__net3d.driver.act(${JSON.stringify(c)})`); heroActs++; } catch (_) { /* 竞态 */ }
        }
        await sleep(25);
        continue;
      }
      settled = true;
      break;
    }

    if (st.myTurn) {
      // 首轮轮到我出牌时，改用**真实指针点击**出牌，验证手牌确实可点（回归 bug 1）
      if (!pointerTested && st.phase === 'discard') {
        if (pointerTries < 4) {
          const before = st.handCount;
          const beforeDisc = st.view.me.discards.length;
          const r = await session.cdp.eval('window.__ptr.clickAny()').catch((e) => ({ err: String(e) }));
          if (r && r.skip) { /* 状态已变，下一轮再试 */ }
          else {
            pointerTries++;
            // 服务端确认是异步的（等下一帧 table:state）。判据用**自家牌河的张数 +1**：
            // 手牌数会因「很快又轮到我摸牌」回到原值，牌河只会单调递增，不会误判。
            let afterDisc = beforeDisc;
            for (let k = 0; k < 25 && afterDisc <= beforeDisc; k++) {
              await sleep(100);
              afterDisc = await session.cdp.eval('(() => window.__net3d.driver.getView().me.discards.length)()');
            }
            if (afterDisc === beforeDisc + 1 && r.actedN >= 1) {
              pointerTested = true; pointerOk = true;
              pointerInfo = `点中=${r.who} 悬停=${r.hovered} 出牌code=${r.code} 牌河 ${beforeDisc}→${afterDisc} @(${r.x},${r.y})`;
            } else {
              pointerInfo = `尝试${pointerTries}: 点中=${r.who} 悬停=${r.hovered} 出牌code=${r.code} act=${r.actedN} 牌河 ${beforeDisc}→${afterDisc}`;
              if (pointerTries >= 4) { pointerTested = true; pointerOk = false; }
            }
            continue;
          }
        }
      }
      const a = viewPick(st.view);
      if (a) {
        try { await session.cdp.eval(`window.__net3d.driver.act(${JSON.stringify(a)})`); heroActs++; } catch (_) { /* 竞态：下一轮重来 */ }
        continue;
      }
    }
    await sleep(25);
  }

  ok(settled, `页面驱动打完这一把（出招 ${heroActs} 次 / 陪打应招 ${botActs} 次）`);
  ok(pointerTested && pointerOk === true, `真实指针两击手牌能出牌（${pointerInfo}）`);

  // —— 3D 场景「随 view 实时更新」的证据 ——
  if (snap) {
    ok(snap.counts && snap.counts.per.S.hand === snap.handCount, `3D 手牌网格 == view 手牌数（${snap.counts && snap.counts.per.S.hand} / ${snap.handCount}）`);
    ok(snap.dice && snap.dice.length === 2, `3D 骰子两颗（点数 ${JSON.stringify(snap.dice)}）`);
    ok(!!snap.counts && snap.counts.discard >= 0 && snap.counts.wall >= 0, `3D 弃牌/牌墙已铺（discard=${snap.counts && snap.counts.discard} wall=${snap.counts && snap.counts.wall}）`);
    ok(snap.controlsInPlay, '操作条被搬进 #table3d（不落在隐藏的 2D 牌桌里）');
    // 自家手牌必须**立着（略后仰）+ 放大**、且不贴画布下沿（老吴 2026-10-19：要立着、大一点、看得清）
    ok(snap.hand && snap.hand.standing === snap.hand.total && snap.hand.total > 0,
      `自家手牌躺平（俯视 2D，${snap.hand && snap.hand.standing}/${snap.hand && snap.hand.total}）`);
    ok(snap.hand && snap.hand.scaled === snap.hand.total,
      `自家手牌放大（${snap.hand && snap.hand.scaled}/${snap.hand && snap.hand.total}）`);
    ok(snap.hand && snap.hand.marginBottom > 15,
      `自家手牌不贴画布下沿（下边距 ${snap.hand && snap.hand.marginBottom}px）`);
    // 新 UI：操作条可能为空（无动作时），只要有按钮就必须在手牌上方
    ok(!snap.controlsBtns || snap.ctrlAboveHand,
      `操作条（有按钮时）浮在自家手牌**上方**（不压手牌；本帧按钮 ${snap.controlsBtns} 个）`);
    ok(snap.bar && snap.bar.bg === 'rgba(0, 0, 0, 0)' && snap.bar.border === '0px' && snap.bar.pad === '0px',
      `操作条无文本框（透明/无边框/无内边距：${snap.bar && snap.bar.bg} / ${snap.bar && snap.bar.border} / ${snap.bar && snap.bar.pad}）`);
    ok(snap.bar && snap.bar.hint === 'none' && (snap.bar.win === null || snap.bar.win === 'none'),
      `操作条不显示提示文字（hint=${snap.bar && snap.bar.hint} win=${snap.bar && snap.bar.win}）`);
    ok(snap.rot && snap.rot[0] === false && snap.rot[1] === false && snap.rot[2] === false,
      `3D 视角锁定（旋转/缩放/拖动 = ${JSON.stringify(snap.rot)}）`);
    ok(snap.fullBleed, '牌桌铺满整个视口（横屏/桌面都占满）');
    ok(snap.noScroll, '牌桌页没有滚动条（文档无横/纵溢出）');
    /* 2026-10-30 老吴：徽标**不要文字**，只留「牌面 + 一个赖字」；具体是哪张牌靠 picture
       本身看，牌名退化到 title / aria-label（悬停与读屏可读）。所以这里断言
       「文本恰好是单个赖字、牌名只出现在 title 里」，防止以后又长出「癞子 xx」长文案。 */
    ok(snap.badge && !snap.badge.hidden && snap.badge.text === '赖' && /癞子/.test(snap.badge.title),
      `左上角只用「牌面 + 赖」标记癞子（text=${JSON.stringify(snap.badge && snap.badge.text)}，title=${JSON.stringify(snap.badge && snap.badge.title)}）`);
    ok(!snap.wildRed || (snap.wildRed[1] > 120 && snap.wildRed[0] < snap.wildRed[1] && snap.wildRed[2] < snap.wildRed[1]),
      `癞子牌左上角有绿色「赖」标记（${snap.wildRed ? 'RGB ' + snap.wildRed.join(',') : '本帧无明牌癞子，跳过'}）`);
    ok(!snap.skinBlue || (snap.skinBlue[0] > 150 && snap.skinBlue[0] > snap.skinBlue[1] && snap.skinBlue[0] > snap.skinBlue[2]),
      `皮子牌左上角有红色「皮」标记（${snap.skinBlue ? 'RGB ' + snap.skinBlue.join(',') : '本帧无明牌皮子，跳过'}）`);
    ok(!snap.zhongBlue || !(snap.zhongBlue[2] > 150 && snap.zhongBlue[0] < 150 && snap.zhongBlue[1] < 160),
      `红中无蓝色角标（${snap.zhongBlue ? 'RGB ' + snap.zhongBlue.join(',') : '本帧无明牌红中，跳过'}）`);
    {
      const rank = (t) => (t === 31 ? 0 : t === snap.wild ? 2 : (snap.skins || []).includes(t) ? 1 : 3);
      // 新摸的牌单独放最右（老吴 2026-10-20）：其余按红中→皮子→赖子→普通排序
      const rest = [...snap.view.me.hand];
      const drawn = snap.view.lastDraw;
      const di = Number.isInteger(drawn) ? rest.indexOf(drawn) : -1;
      if (di >= 0) rest.splice(di, 1);
      rest.sort((a, b) => rank(a) - rank(b) || a - b);
      const want = di >= 0 ? [...rest, drawn] : rest;
      ok(snap.handCodes && JSON.stringify(snap.handCodes) === JSON.stringify(want),
        `手牌摆布：一般牌按序 + 新摸的牌最右（${snap.handCodes && snap.handCodes.join(',')}）`);
    }
  } else {
    ok(false, '未捕获到「轮到我」的 3D 帧（无法核对网格数量）');
  }
  ok(hudBad === 0, `操作条按钮渲染正确（非出牌回合检查 ${hudChecks} 次 / 最多 ${hudMaxBtns} 个按钮 / 异常 ${hudBad} 次）`);
  ok(hudOverlapBad === 0, `操作条不压住画布手牌区（压手牌帧 ${hudOverlapBad} 次）`);

  // —— 结算帧：3D 也把别家摊牌渲染出来 ——
  const fin = await session.cdp.eval(`(() => {
    const d = window.__net3d.driver, v = d.getView(), r = window.__net3d.renderer;
    const c = r ? r.counts() : null;
    return { phase: v.phase, result: v.result && v.result.type, othersHand: v.others.map((o) => (o.hand ? o.hand.length : -1)),
             counts: c, errs: (window.__errs || []).length };
  })()`);
  ok(fin.phase === 'settled', `结算帧 phase=${fin.phase}`);
  ok(fin.result === 'win' || fin.result === 'draw', `结算 result.type=${fin.result}`);
  if (fin.result === 'win') {
    ok(!!revealSnap, '胡牌后先进入摊牌确认阶段（不是直接弹结算页）');
    if (revealSnap) {
      ok(revealSnap.settleHidden, '四家确认前结算弹窗保持隐藏');
      ok(revealSnap.btnTexts.includes('确认'), `摊牌时操作条给出「确认」（${revealSnap.btnTexts.join('/') || '无'}）`);
      ok(revealSnap.othersHand.every((n) => n >= 0), `摊牌时四家手牌已展示（别家张数 ${JSON.stringify(revealSnap.othersHand)}）`);
    }
  }
  if (fin.counts) {
    const faces = ['E', 'N', 'W'].map((k) => fin.counts.per[k].hand);
    const expect = fin.othersHand;
    ok(faces.every((n, i) => expect[i] < 0 || n === expect[i]), `结算摊牌：3D 别家手牌网格 ${JSON.stringify(faces)} == view ${JSON.stringify(expect)}`);
  }
  ok(fin.errs === 0, `整把过程无未捕获错误（${fin.errs}）`);

  // —— 结算弹窗：精简（不显示本场明细）+ 844×390 也不出滚动条（老吴 2026-10-20）——
  await session.cdp.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const modal = await session.cdp.eval(`(() => {
    const card = document.getElementById('settle-card');
    const box = document.getElementById('settle');
    return {
      hidden: box ? box.hidden : null,
      sh: card ? card.scrollHeight : -1,
      ch: card ? card.clientHeight : -1,
      detail: !!(card && card.querySelector('.st-detail')),
      docOver: document.documentElement.scrollHeight - innerHeight,
      rectH: card ? Math.round(card.getBoundingClientRect().height) : -1,
      vw: innerWidth, vh: innerHeight,
      maxW: card ? getComputedStyle(card).maxWidth : null,
      listSh: (card && card.querySelector(':scope > .st-list')) ? card.querySelector(':scope > .st-list').scrollHeight : -1,
      listCh: (card && card.querySelector(':scope > .st-list')) ? card.querySelector(':scope > .st-list').clientHeight : -1,
      rows: card ? [...card.querySelectorAll('.st-row')].map((row) => {
        const t = row.querySelector('.st-tiles');
        const f = row.querySelector('.st-fan');
        const face = row.querySelector('.st-tiles .tile-face');
        return {
          fanInHead: !!f && !!f.closest('.st-head'),
          singleLine: t ? t.offsetHeight <= (face ? Math.round(face.getBoundingClientRect().height) + 6 : 40) : true,
          fits: t ? t.scrollWidth <= t.clientWidth + 1 : true,
        };
      }) : [],
    };
  })()`);
  ok(modal.hidden === false, `结算弹窗在 844×390 仍显示（${modal.vw}×${modal.vh}）`);
  ok(modal.detail === false, '结算弹窗不显示「本场结算明细」');
  ok(modal.sh <= modal.ch + 1, `结算弹窗无纵向滚动条（scroll ${modal.sh} <= client ${modal.ch}）`);
  ok(modal.rectH <= modal.vh - 10, `结算弹窗视觉高度 ${modal.rectH}px 在 ${modal.vh}px 视口内`);
  ok(modal.docOver <= 1, `结算时整页无滚动条（溢出 ${modal.docOver}px）`);
  // 老吴 2026-10-28：四家一个框架、每家两行（上行 头像+计番+收付，下行 牌面单行不换行）
  ok(modal.rows.length === 4, `结算窗四家各占两行版式（实际 ${modal.rows.length} 行）`);
  // 老吴 2026-10-28：CSS 旋转真机上 vw 是物理竖屏宽，任何 vw 钳制都会把卡片掐成 374px 窄条
  ok(modal.maxW === 'none', `结算卡无 vw/max-width 钳制（computed max-width=${modal.maxW}）`);
  ok(modal.rows.every((x) => x.fanInHead), '计番条目在第一行（头像+计番+收付同行）');
  ok(modal.rows.every((x) => x.singleLine), `每家牌面单行不换行（行高 ${JSON.stringify(modal.rows.map((x) => x.singleLine))}）`);
  ok(modal.rows.every((x) => x.fits), '每家牌面整行放得下（无横向溢出）');
  // 老吴 2026-10-28：一屏放下四家 —— 四家列表不得内部滚动
  ok(modal.listSh <= modal.listCh + 1, `四家列表一屏放完无内滚（scroll ${modal.listSh} <= client ${modal.listCh}）`);
  // 老吴 2026-10-28：style.css .modal-card 规则块曾被 @media 截断，白底/内边距全失效（弹窗透明）；
  // 同日稍后按老吴要求结算/战绩底色柔和化：白 → 暖米色 #f6f1e6（防复发门跟着改口径）
  const statsBg = await session.cdp.eval(`(() => {
    const b = document.getElementById('stats'), c = document.getElementById('stats-card');
    if (!b || !c) return 'missing';
    const prev = b.hidden; b.hidden = false;
    const bg = getComputedStyle(c).backgroundColor; const pad = getComputedStyle(c).paddingTop;
    b.hidden = prev;
    return bg + ' / pad ' + pad;
  })()`);
  ok(statsBg.startsWith('rgb(246, 241, 230)'), `战绩弹窗卡片暖米色底（${statsBg}）`);

  console.log(`\n总结：${fail ? '❌ 有失败' : '✅ 全部通过'}（${pass} 通过 / ${fail} 失败）`);
} catch (e) {
  console.error('FATAL', e && e.message ? e.message : e);
  fail++;
} finally {
  for (const s of sockets) { try { s.close(); } catch { /* 已关 */ } }
  teardownChrome(session);
  try { server.kill(); } catch { /* 已退 */ }
  await sleep(200);
  if (fail) console.error('server log tail:', serverLog.slice(-500));
}

process.exit(fail ? 2 : 0);
