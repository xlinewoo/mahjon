// 最终交付截图：掷骰态 + 配牌完成态（file:// 单文件版）
const { chromium } = require('playwright-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto('file:///C:/Users/Administrator/WorkBuddy/2026-10-18-16-15-34/mahjong-3d/mahjong-standalone.html',
    { waitUntil: 'load', timeout: 20000 });
  // 掷骰态：等骰子出现（发牌动画开始前）
  await page.waitForFunction(() => window.__mj && window.__mj.diceMeshes && window.__mj.diceMeshes.length > 0, { timeout: 15000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: '_shot_final_dice.png' });
  const dice = await page.evaluate(() => window.__mj.diceResult);
  // 配牌完成态
  await page.waitForFunction(() => window.__mj && window.__mj.dealDone, { timeout: 40000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: '_shot_final_deal.png' });
  const st = await page.evaluate(() => {
    const mj = window.__mj;
    const sides = {};
    for (const s of mj.SEATS) sides[s.key] = mj.wallRing.filter(k => k.seat === s.key)
      .reduce((a, k) => a + (k.meshes[0] ? 1 : 0) + (k.meshes[1] ? 1 : 0), 0);
    const half = [];
    mj.wallRing.forEach((k, i) => { const l = (k.meshes[0] ? 1 : 0) + (k.meshes[1] ? 1 : 0); if (l === 1) half.push(k.seat + 'd' + k.d); });
    return { hands: [mj.hands.S.length, mj.hands.E.length, mj.hands.N.length, mj.hands.W.length],
      wallLeft: mj.wallLeft, drawPtr: mj.drawPtr, sides, half };
  });
  console.log('dice =', JSON.stringify(dice), '| hands =', JSON.stringify(st.hands),
    '| wallLeft =', st.wallLeft, '| drawPtr =', st.drawPtr);
  console.log('sides =', JSON.stringify(st.sides), '| half =', JSON.stringify(st.half));
  console.log('errors =', errors.length ? errors.join('\n') : '(none)');
  await browser.close();
  process.exit(errors.length ? 2 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
