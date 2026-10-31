/* 验证 file:// 协议下 ES Module 是否被拦截（模拟"手机直接打开 HTML 文件"） */
const { chromium } = require('playwright-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const TARGET = process.argv[2] || 'index.html';   // index.html=开发版(应失败) | mahjong-standalone.html=单文件版(应成功)
const URL = 'file:///C:/Users/Administrator/WorkBuddy/2026-10-18-16-15-34/mahjong-3d/' + TARGET;

(async () => {
  const browser = await chromium.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));

  await page.goto(URL, { waitUntil: 'load', timeout: 20000 });
  await page.waitForTimeout(3000);

  // 等待配牌完成（dealDone 置位），最多再等 12s
  await page.waitForFunction(() => window.__mj && window.__mj.dealDone === true, null, { timeout: 12000 }).catch(() => {});

  const diag = await page.evaluate(() => ({
    hasMj: !!window.__mj,
    canvas: !!document.querySelector('canvas'),
    fatal: (document.getElementById('fatal') || {}).textContent || null,
    hand: window.__mj ? window.__mj.hands.S.length : -1,
    dealDone: window.__mj ? !!window.__mj.dealDone : null,
    wallLeft: window.__mj ? window.__mj.wallLeft : null,
  }));
  console.log('file://', TARGET, '=>', JSON.stringify(diag));
  console.log('errors =', errors.length ? errors.join('\n') : '(none)');
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
