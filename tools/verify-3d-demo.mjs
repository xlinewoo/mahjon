#!/usr/bin/env node
/**
 * 3D 客户端（mahjong-3d/index.html）冒烟验证（tools/verify-3d-demo.mjs）
 *
 * 目的：确认「牌面贴图改为复用 tiles-img 位图」后，开发版仍能正常起场景、发牌完成，
 *   且牌面贴图确实是加载后的 256×352 位图（而非空白）。
 *
 * 开发版是 ES Module，file:// 下会被 CORS 拦，所以这里起一个最小静态服务器再用无头 Chrome 打开。
 *
 * 用法：node tools/verify-3d-demo.mjs
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, launchChrome, teardownChrome, freePort, sleep } from './lib/chrome.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const file = resolve(ROOT, '.' + normalize(urlPath));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});

if (!findChrome()) { console.error('❌ 找不到 Chrome（设 CHROME_PATH）'); process.exit(2); }
const port = await freePort();
await new Promise((r) => server.listen(port, '127.0.0.1', r));

let session;
let failed = 0;
try {
  session = await launchChrome({ extraArgs: ['--enable-unsafe-swiftshader', '--window-size=1280,800'] });
  await session.cdp.send('Page.enable');
  await session.cdp.send('Runtime.enable');
  await session.cdp.send('Log.enable');

  const errs = [];
  // 用 addScriptToEvaluateOnNewDocument 在页面脚本之前注入错误收集器
  // （直接在 navigate 之前 eval 会被导航清掉，等于没收集）
  await session.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__errs = [];
    addEventListener('error', (e) => window.__errs.push(String(e.message || e.error)));
    addEventListener('unhandledrejection', (e) => window.__errs.push('rej:' + String(e.reason)));` });

  await session.cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/mahjong-3d/index.html` });

  let ready = false;
  for (let i = 0; i < 400; i++) {
    ready = await session.cdp.eval('!!(window.__mj && window.__mj.dealDone)').catch(() => false);
    if (ready) break;
    await sleep(100);
  }

  const facts = await session.cdp.eval(`(() => {
    const mj = window.__mj;
    if (!mj) return { ok: false };
    const tex = mj.hands.S[0].material[4].map;
    const img = tex && tex.image;
    let nonMargin = null, w = 0, h = 0;
    if (img && img.getContext) {
      w = img.width; h = img.height;
      const d = img.getContext('2d').getImageData(0, 0, w, h).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        // 留边底色 #f6f0dd = (246,240,221)
        if (Math.abs(d[i] - 246) > 6 || Math.abs(d[i+1] - 240) > 6 || Math.abs(d[i+2] - 221) > 6) n++;
      }
      nonMargin = +(n / (w * h)).toFixed(3);
    }
    return {
      ok: true,
      canvas: document.querySelectorAll('canvas').length,
      handS: mj.hands.S.length, handE: mj.hands.E.length,
      wallLeft: mj.wallLeft,
      isCanvasTex: !!(tex && tex.isCanvasTexture),
      w, h, nonMargin,
      errs: window.__errs || [],
    };
  })()`);

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail: String(detail) });
  check('页面无未捕获错误', facts.ok && facts.errs.length === 0, facts.errs.join(' | '));
  check('canvas 存在', facts.canvas >= 1, facts.canvas);
  check('配牌完成：庄 14 / 闲 13', facts.handS === 14 && facts.handE === 13, `${facts.handS}/${facts.handE}`);
  check('牌墙剩 83', facts.wallLeft === 83, facts.wallLeft);
  check('牌面贴图是 CanvasTexture', facts.isCanvasTex === true, facts.isCanvasTex);
  check('贴图尺寸 256×352', facts.w === 256 && facts.h === 352, `${facts.w}×${facts.h}`);
  check('牌面已绘制（非留边像素 > 50%）', facts.nonMargin > 0.5, facts.nonMargin);

  const pass = checks.filter((c) => c.ok).length;
  const fail = checks.filter((c) => !c.ok);
  console.log(`3D demo 冒烟：PASS ${pass}/${checks.length}`);
  for (const c of fail) console.log('  FAIL', c.name, '→', c.detail);
  if (!fail.length) console.log('  （贴图非留边像素占比', facts.nonMargin, '）');
  failed = fail.length;
} catch (e) {
  console.error('FATAL', e);
  failed = 1;
} finally {
  teardownChrome(session);
  server.close();
}
process.exit(failed ? 2 : 0);
