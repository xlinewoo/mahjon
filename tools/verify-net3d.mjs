#!/usr/bin/env node
/**
 * 3D 网络版冒烟验证（tools/verify-net3d.mjs）
 *
 * ① 无头 Chrome 打开构建产物 frontend/build/net3d.html：
 *    断言无未捕获错误、初始停在大厅登录页、注入一帧合成 view 后 3D 画布出现且整桌网格正确。
 * ② Fastify 路由：GET /app/net3d 与 /net3d.html 返回 200 且是 HTML。
 *
 * 用法：node tools/verify-net3d.mjs
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, resolve, normalize, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, launchChrome, teardownChrome, freePort, sleep } from './lib/chrome.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png' };

const VIEW = {
  phase: 'discard', turn: 0, dealer: 0, wallLeft: 80, dice: [3, 6], flipTile: 2, wildTile: 3,
  skinTiles: [1, 2, 31], lastDiscard: null, discardLog: [],
  me: { seat: 0, name: '我', hand: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], melds: [{ type: 'peng', tiles: [18, 18, 18], from: 1 }], discards: [20, 21], opened: false, legal: [{ type: 'discard', tile: 0 }] },
  others: [
    { seat: 1, name: '下', handCount: 13, melds: [], discards: [30], opened: false },
    { seat: 2, name: '对', handCount: 13, melds: [], discards: [], opened: false },
    { seat: 3, name: '上', handCount: 13, melds: [], discards: [5, 6], opened: false },
  ],
};

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(req.url.split('?')[0]);
    const file = resolve(ROOT, '.' + normalize(p));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('nf'); }
});

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail: String(detail) });

if (!findChrome()) { console.error('❌ 找不到 Chrome'); process.exit(2); }
const port = await freePort();
await new Promise((r) => server.listen(port, '127.0.0.1', r));

let session;
try {
  session = await launchChrome({ extraArgs: ['--enable-unsafe-swiftshader', '--window-size=1280,800'] });
  await session.cdp.send('Page.enable');
  await session.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__errs = [];
    addEventListener('error', (e) => window.__errs.push(String(e.message || e.error)));
    addEventListener('unhandledrejection', (e) => window.__errs.push('rej:' + String(e.reason)));` });
  await session.cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/frontend/build/net3d.html` });

  let booted = false;
  for (let i = 0; i < 200; i++) {
    booted = await session.cdp.eval('!!window.__net3d').catch(() => false);
    if (booted) break;
    await sleep(100);
  }
  check('net3d 已启动', booted, booted);
  const initErrs = await session.cdp.eval('window.__errs || []').catch(() => []);
  if (!booted || initErrs.length) console.log('initErrs =', JSON.stringify(initErrs));

  const lobby = await session.cdp.eval(`(() => ({
    authVisible: !document.getElementById('auth-view').hidden,
    playHidden: document.getElementById('play').hidden,
    errs: window.__errs,
  }))()`);
  check('初始停在大厅登录页', lobby.authVisible === true && lobby.playHidden === true, JSON.stringify(lobby));
  check('加载无未捕获错误', lobby.errs.length === 0, lobby.errs.join(' | '));

  const facts = await session.cdp.eval(`(() => {
    document.getElementById('lobby').hidden = true;
    document.getElementById('play').hidden = false;
    const r = window.__net3d.ensure3d();
    r.render(${JSON.stringify(VIEW)}, { MY_SEAT: 0 });
    r.applySize();
    const c = r.counts();
    const host = document.getElementById('table3d');
    return {
      canvas: host.querySelectorAll('canvas').length,
      per: c.per, wall: c.wall, markers: c.markers, dice: c.dice, diceValues: JSON.stringify(r.diceValues || []),
      webgl: !!r.renderer,
      errs: window.__errs,
    };
  })()`);
  check('3D 画布已挂载', facts.canvas >= 1, facts.canvas);
  check('我的手牌 14 张', facts.per.S.hand === 14, facts.per.S.hand);
  check('他家各 13 张背面', facts.per.E.hand === 13 && facts.per.N.hand === 13 && facts.per.W.hand === 13, JSON.stringify(facts.per));
  check('我的副露 3 张', facts.per.S.meld === 3, facts.per.S.meld);
  check('弃牌数正确(2/1/0/2)', facts.per.S.discard === 2 && facts.per.E.discard === 1 && facts.per.N.discard === 0 && facts.per.W.discard === 2, JSON.stringify(facts.per));
  check('牌墙 80 张', facts.wall === 80, facts.wall);
  // 2026-10-30 二十轮（老吴）：骰子不上桌 —— 只验「点数照收、桌上 0 颗」
  check('骰子不上桌但点数照收 [3,6]', facts.dice === 0 && facts.diceValues === '[3,6]', `${facts.dice} ${facts.diceValues}`);
  check('注入渲染后无错误', facts.errs.length === 0, facts.errs.join(' | '));

  const pass = checks.filter((c) => c.ok).length;
  console.log(`net3d 冒烟：PASS ${pass}/${checks.length}` + (facts.webgl ? '（WebGL 可用）' : '（无 WebGL，仅验场景图）'));
  for (const c of checks.filter((x) => !x.ok)) console.log('  FAIL', c.name, '→', c.detail);
} catch (e) {
  console.error('FATAL', e);
  checks.push({ ok: false });
} finally {
  teardownChrome(session);
  server.close();
}

/* ---------------- ② Fastify 路由 ---------------- */
let routeFail = 0;
try {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'mj-net3d-'));
  const { createApp } = await import('../server/app.js');
  const app = await createApp();
  const r1 = await app.inject({ method: 'GET', url: '/app/net3d' });
  const r2 = await app.inject({ method: 'GET', url: '/net3d.html' });
  const r3 = await app.inject({ method: 'GET', url: '/app/net' });
  const r4 = await app.inject({ method: 'GET', url: '/app/net2d' });
  const isHtml = (r) => r.statusCode === 200 && /text\/html/.test(r.headers['content-type'] || '');
  const is3d = (r) => r.body.includes('id="table3d"');
  check('GET /app/net3d → 200 HTML', isHtml(r1), `${r1.statusCode} ${r1.headers['content-type']}`);
  check('GET /net3d.html → 200 HTML', isHtml(r2), `${r2.statusCode} ${r2.headers['content-type']}`);
  check('GET /app/net → 200 且是 3D 版（默认已切换）', isHtml(r3) && is3d(r3), `${r3.statusCode} 3d=${is3d(r3)}`);
  check('GET /app/net2d → 200 且是 2D 版（保留备选）', isHtml(r4) && !is3d(r4), `${r4.statusCode} 3d=${is3d(r4)}`);
  await app.close();
} catch (e) {
  console.error('路由检查 FATAL', e.message);
  routeFail = 1;
}

const failed = checks.filter((c) => !c.ok).length;
const routeChecks = checks.slice(-4);
console.log(`路由检查：${routeFail ? 'FAIL' : (routeChecks.every((c) => c.ok) ? 'PASS 4/4' : 'FAIL')}`);
process.exit(failed || routeFail ? 2 : 0);
