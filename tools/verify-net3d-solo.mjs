#!/usr/bin/env node
/**
 * 3D 客户端「单人实战」验证（tools/verify-net3d-solo.mjs）
 *
 * 验证「加机器人」补位：一个人 + 点 3 次按钮，就能在真服务端上打完一把 3D 牌局。
 *   ① 起真实服务端；注册 1 人、建俱乐部 + 牌桌；
 *   ② 真·无头 Chrome 开 /app/net（座位 0），进桌；
 *   ③ **点页面上的「加机器人」按钮 3 次** → 三个空位变成服务器机器人（🤖 / 已准备）；
 *   ④ 点「准备」→ 四人齐 → 开局；
 *   ⑤ 页面用真实 net-driver 打完这一把（其余三家由服务端代打）。
 *
 * 用法：node tools/verify-net3d-solo.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
function viewPick(view) {
  const legal = (view.me.legal || []).map(normalize).filter(Boolean);
  const by = (t) => legal.find((a) => a.type === t);
  if (by('win')) return by('win');
  for (const t of ['peng', 'zhi', 'an', 'xu', 'skingang', 'redgang', 'wildgang', 'chi']) { const a = by(t); if (a) return a; }
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
const dataDir = mkdtempSync(join(tmpdir(), 'mj-net3dsolo-'));
console.log('════════ /app/net 单人实战：「加机器人」×3 → 打完一把 ════════');

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

let session = null;
try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(BASE + '/health')).ok; } catch { /* 还没起 */ }
    if (!up) await sleep(100);
  }
  if (!up) throw new Error('服务端没起来：' + serverLog.slice(-400));
  ok(true, `服务端就绪 ${BASE}`);

  const u = (await api('/api/auth/register', 'POST', { username: `solo_${rnd()}`, password: 'pass1234' })).data;
  const club = (await api('/api/clubs', 'POST', { name: 'SOLO俱乐部' }, u.token)).data.club;
  const table = (await api(`/api/clubs/${club.id}/tables`, 'POST',
    { name: 'SOLO桌', circleCount: 1, rules: { preset: 'koukou' } }, u.token)).data.table;
  ok(!!(table && table.id), `前置就绪：1 人 + 俱乐部 #${club.id} + 牌桌 #${table.id}`);

  if (!findChrome()) throw new Error('找不到 Chrome');
  session = await launchChrome({ extraArgs: ['--enable-unsafe-swiftshader', '--window-size=1280,800'] });
  await session.cdp.send('Page.enable');
  await session.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs = [];
      addEventListener('error', (e) => window.__errs.push(String(e.message || e.error)));
      addEventListener('unhandledrejection', (e) => window.__errs.push('rej:' + String(e.reason)));
      try { localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(u.token)}); } catch (_) {}`,
  });
  await session.cdp.send('Page.navigate', { url: `${BASE}/app/net` });

  let booted = false;
  for (let i = 0; i < 200 && !booted; i++) { booted = await session.cdp.eval('!!window.__net3d && !!window.__net3d.state.user').catch(() => false); if (!booted) await sleep(100); }
  ok(booted, '3D 页面已加载并自动登录');

  await session.cdp.eval(`window.__net3d.enterTable(${table.id})`);
  let seated = false;
  for (let i = 0; i < 100 && !seated; i++) {
    seated = await session.cdp.eval('(() => { const r = window.__net3d.state.room; return !!(r && r.players && r.players.filter(Boolean).length >= 1); })()').catch(() => false);
    if (!seated) await sleep(100);
  }
  ok(seated, '页面已入桌');

  // 「加机器人」按钮应可见（大厅 + 已入座 + 有空位）
  const btnVisible = await session.cdp.eval('(() => { const b = document.getElementById("btn-add-bot"); return !!b && !b.hidden; })()');
  ok(btnVisible === true, '「加机器人」按钮在大厅可见');

  // 点 3 次，补满空位
  for (let i = 0; i < 3; i++) {
    await session.cdp.eval('document.getElementById("btn-add-bot").click()');
    await sleep(250);
  }
  let full = false;
  for (let i = 0; i < 60 && !full; i++) {
    full = await session.cdp.eval('(() => { const r = window.__net3d.state.room; return !!(r && r.players.filter(Boolean).length === 4); })()').catch(() => false);
    if (!full) await sleep(100);
  }
  ok(full, '三位机器人都已入座（四人齐）');

  const seatInfo = await session.cdp.eval(`(() => {
    const r = window.__net3d.state.room;
    const seats = document.querySelectorAll('#table-seats .lb-seat');
    return {
      bots: r.players.filter((p) => p && p.bot).length,
      botReady: r.players.filter((p) => p && p.bot).every((p) => p.ready && p.absent),
      uiText: Array.from(seats).map((s) => s.textContent).join(' | '),
      btnHidden: document.getElementById('btn-add-bot').hidden,
    };
  })()`);
  ok(seatInfo.bots === 3 && seatInfo.botReady, `服务端 3 个机器人且标记已托管+已准备（${seatInfo.bots} 个）`);
  ok(/机器人/.test(seatInfo.uiText), '座位卡片显示「机器人」');
  ok(seatInfo.btnHidden === true, '满座后「加机器人」按钮自动隐藏');

  // 人类准备 → 开局
  await session.cdp.eval('document.getElementById("btn-ready").click()');
  let started = false;
  for (let i = 0; i < 150 && !started; i++) {
    started = await session.cdp.eval('(() => { const d = window.__net3d.driver; return !!(d && d.getView()); })()').catch(() => false);
    if (!started) await sleep(100);
  }
  ok(started, '点「准备」→ 四人齐 + 全准备 → 开局（页面收到首帧 table:state）');

  // 打完这一把（人类出牌；其余由服务端代打）
  let heroActs = 0, settled = false, handSnap = null;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const st = await session.cdp.eval(`(() => {
      const d = window.__net3d.driver; if (!d || !d.getView()) return null;
      const v = d.getView(); const r = window.__net3d.renderer;
      return { phase: v.phase, myTurn: d.isMyTurn(), view: v,
        counts: r ? r.counts() : null, dice: r ? r.diceValues : null };
    })()`).catch(() => null);
    if (!st) { await sleep(50); continue; }
    if (!handSnap && st.phase === 'discard' && st.myTurn) handSnap = st;
    if (st.phase === 'settled') {
      // 胡牌摊牌：人类点「确认」；三家机器人由服务端自动确认，四家齐了才弹结算页
      if (st.view.reveal && st.view.reveal.pending) {
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
      const a = viewPick(st.view);
      if (a) { try { await session.cdp.eval(`window.__net3d.driver.act(${JSON.stringify(a)})`); heroActs++; } catch (_) { /* 竞态 */ } continue; }
    }
    await sleep(25);
  }
  ok(settled, `打完这一把（人类出招 ${heroActs} 次，其余三家服务端代打）`);
  if (handSnap) {
    // 碰后摸到第 4 张：操作条必须有「蓄杠」按钮，并弹一次「可蓄杠」提示（老吴 2026-10-20）
    const inj = await session.cdp.eval(`(async () => {
      const d = window.__net3d.driver;
      const p = d.getPayload();
      const v = JSON.parse(JSON.stringify(p.view));
      v.phase = 'discard'; v.turn = p.seat;
      // 蓄杠必须用**手里真有的牌**：render.js 的 actionConsistent('xu') 要求 hand.includes(tile)，
      // 写死 tile:5 时「这一手恰好没有六万」就会被过滤掉 ⇒ 按钮与「可蓄杠」toast 一起消失（用例靠运气取牌）。
      const hand = (v.me.hand || []).slice();
      v.me.legal = [{ type: 'xu', tile: hand[0] ?? 5 }];
      window.__net3d.applyPayload({ ...p, view: v });
      // 操作条在 3D 里由 relocateHud 下一帧才搬到 #table3d 并落定尺寸，
      // 同步读 DOM 会读到一个还没刷新的旧按钮集（偶发「没有蓄杠按钮」）。
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const btns = [...document.querySelectorAll('#controls button')].map((b) => b.textContent);
      const flashEl = document.getElementById('flash');
      const out = { btns, flash: flashEl ? flashEl.textContent : '' };
      window.__net3d.applyPayload(p);
      return out;
    })()`).catch((e) => ({ err: String(e) }));
    // 按钮文案自带牌名（「蓄杠·三万」），老版断言按 === '蓄杠' 比较 —— 标签改版后就恒为假，
    // 这里按前缀匹配（产品口径见 render.js 的 actionBtn 文案）。
    const isXu = (t) => typeof t === 'string' && t.startsWith('蓄杠');
    ok(Array.isArray(inj.btns) && inj.btns.some(isXu), `3D 操作条能渲染「蓄杠」（${(inj.btns || []).join('/') || inj.err}）`);
    ok(/可蓄杠/.test(inj.flash || ''), `碰后摸到第 4 张有「可蓄杠」提示（${inj.flash}）`);
    // 2026-10-30 二十轮（老吴）：「牌河中不要显示骰子」→ 桌上 0 颗（点数仍随 view 下发）
    ok(handSnap.counts && handSnap.counts.dice === 0, `3D 桌上不再摆骰子（${JSON.stringify(handSnap.dice)}）`);
    ok(handSnap.counts && handSnap.counts.per.S.hand === handSnap.view.me.hand.length,
      `3D 手牌网格 == view 手牌数（${handSnap.counts && handSnap.counts.per.S.hand} / ${handSnap.view.me.hand.length}）`);

    // 回归（老吴 2026-10-22）：杠完若手里还有可杠的牌，操作条必须继续显示。
    // 根因是 doAction() 的 finally 又调一次 renderAll()，把 #controls 塞回隐藏的 2D 座位；
    // 这里用假 act 模拟「点杠 → 等回执 → finally 重绘」，只在动作真正结束后看父节点。
    const afterAction = await session.cdp.eval(`(async () => {
      const d = window.__net3d.driver;
      const p = d.getPayload();
      const v = JSON.parse(JSON.stringify(p.view));
      v.phase = 'discard'; v.turn = p.seat;
      // 蓄杠必须用**手里真有的牌**：render.js 的 actionConsistent('xu') 要求 hand.includes(tile)，
      // 写死 tile:5 时「这一手恰好没有六万」就会被过滤掉 ⇒ 按钮与「可蓄杠」toast 一起消失（用例靠运气取牌）。
      const hand = (v.me.hand || []).slice();
      v.me.legal = [{ type: 'xu', tile: hand[0] ?? 5 }];
      window.__net3d.applyPayload({ ...p, view: v });
      const box = document.getElementById('controls');
      const beforeIn3d = !!box.closest('#table3d');
      const btn = [...box.querySelectorAll('button')].find((b) => b.textContent.startsWith('蓄杠'));
      const origAct = d.act;
      let called = 0;
      d.act = () => { called++; return new Promise((r) => setTimeout(r, 40)); };
      if (btn) btn.click();
      await new Promise((r) => setTimeout(r, 140));
      const afterIn3d = !!box.closest('#table3d');
      const afterParent = box.parentElement ? (box.parentElement.id || box.parentElement.className) : '';
      const afterBtns = [...box.querySelectorAll('button')].map((b) => b.textContent);
      d.act = origAct;
      window.__net3d.applyPayload(p);
      return { beforeIn3d, afterIn3d, afterParent, afterBtns, called };
    })()`).catch((e) => ({ err: String(e) }));
    ok(afterAction.beforeIn3d === true, '动作前操作条在 3D 画布内');
    ok(afterAction.called === 1, `点「蓄杠」确实走了 doAction 管线（${afterAction.called || afterAction.err}）`);
    ok(afterAction.afterIn3d === true,
      `动作结束后操作条仍在 #table3d（实际父节点：${afterAction.afterParent || '无'}）`);
    ok(Array.isArray(afterAction.afterBtns) && afterAction.afterBtns.some((t) => t.startsWith('蓄杠')),
      `动作结束后仍显示剩余可杠按钮（${(afterAction.afterBtns || []).join('/') || afterAction.err}）`);
  }
  const fin = await session.cdp.eval(`(() => {
    const d = window.__net3d.driver, v = d.getView();
    return { phase: v.phase, result: v.result && v.result.type, errs: (window.__errs || []).length };
  })()`);
  ok(fin.phase === 'settled' && (fin.result === 'win' || fin.result === 'draw'), `结算帧 phase=${fin.phase} result=${fin.result}`);
  ok(fin.errs === 0, `整把无未捕获错误（${fin.errs}）`);

  // —— 点「准备下一局」→ 下一把应立即开局（回归 bug 2：点了没反应 / 单人卡死）——
  await session.cdp.eval('document.getElementById("newgame").click()');
  let nextStarted = false;
  for (let i = 0; i < 30 && !nextStarted; i++) {
    await sleep(100);
    nextStarted = await session.cdp.eval('(() => window.__net3d.driver.getView().phase !== "settled")()').catch(() => false);
  }
  ok(nextStarted, '点「准备下一局」→ 下一把立即开局（机器人座位随即 auto-ready）');

  console.log(`\n总结：${fail ? '❌ 有失败' : '✅ 全部通过'}（${pass} 通过 / ${fail} 失败）`);
} catch (e) {
  console.error('FATAL', e && e.message ? e.message : e);
  fail++;
} finally {
  teardownChrome(session);
  try { server.kill(); } catch { /* 已退 */ }
  await sleep(200);
  if (fail) console.error('server log tail:', serverLog.slice(-500));
}
process.exit(fail ? 2 : 0);
