/* 移动端复现：iPhone 尺寸 + 移动 UA + 触摸，收集错误并截图 */
const { chromium } = require('playwright-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const TARGET = process.argv[2] || 'index.html';
const URL = 'http://127.0.0.1:8789/' + TARGET;
const OUT = 'C:/Users/Administrator/WorkBuddy/2026-10-18-16-15-34/mahjong-3d/_shot_mobile.png';

(async () => {
  const browser = await chromium.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 3).join('\n')));

  // WebGL2 能力探测
  const webgl2 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  });
  const roundRectOK = await page.evaluate(() => typeof CanvasRenderingContext2D.prototype.roundRect === 'function');

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForFunction(() => window.__mj && window.__mj.dealDone, null, { timeout: 30000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: OUT });

  // 页面自检出口
  const diag = await page.evaluate(() => {
    const mj = window.__mj;
    const c = document.querySelector('canvas');
    return {
      hasMj: !!mj,
      canvas: !!c,
      canvasSize: c ? [c.width, c.height] : null,
      hand: mj ? mj.hands.S.length : -1,
      oppHands: mj ? ['E', 'N', 'W'].map(k => mj.hands[k].length) : null,
      wallTotal: mj ? mj.wallLeft : -1,
      dice: mj ? mj.diceResult : null,
      bodyBg: getComputedStyle(document.body).backgroundColor,
    };
  });

  console.log('webgl2 =', webgl2, '| roundRect =', roundRectOK);
  console.log('diag =', JSON.stringify(diag));
  console.log('errors =', errors.length ? errors.join('\n') : '(none)');
  await browser.close();
  if (errors.length) process.exit(2);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
