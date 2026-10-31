/* 竖屏横显验证：hasTouch + 竖屏 viewport 下，容器旋转、canvas 横屏尺寸、点击事件映射正确 */
const path = require('path');
const { chromium } = require('playwright-core');

const EXE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = 'http://127.0.0.1:8789/index.html';
const OUT = path.join(__dirname, '_shot_portrait.png');
const VW = 390, VH = 844;   // 竖屏手机

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  [' + detail + ']' : ''));
  if (!ok) failed++;
};

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    viewport: { width: VW, height: VH },
    hasTouch: true, isMobile: true, deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__mj && window.__mj.dealDone, null, { timeout: 30000 });
  await page.waitForTimeout(300);

  const st = await page.evaluate(() => {
    const mj = window.__mj;
    const c = document.querySelector('canvas');
    const app = document.getElementById('app');
    return {
      adapt: document.body.classList.contains('portrait-adapt'),
      transform: c ? c.style.transform : '',
      appTransform: app.style.transform,
      cw: c ? c.clientWidth : 0,
      ch: c ? c.clientHeight : 0,
      hand: mj.hands.S.length,
      oppHands: ['E', 'N', 'W'].map(k => mj.hands[k].length),
      wallLeft: mj.wallLeft,
      disc: mj.discards.S.length,
      rotVisible: !!document.getElementById('btn-rot') && getComputedStyle(document.getElementById('btn-rot')).display,
    };
  });
  check('竖屏下启用横屏适配', st.adapt === true, 'body.portrait-adapt=' + st.adapt);
  check('canvas 旋转 90°', /rotate\(90deg\)/.test(st.transform || ''), st.transform + ' | app=' + st.appTransform);
  check('canvas 横屏逻辑尺寸', st.cw === VH && st.ch === VW, st.cw + 'x' + st.ch);
  check('退出按钮可见', st.rotVisible === 'block', String(st.rotVisible));
  check('配牌完成：庄14/闲13、墙剩83', st.hand === 14 && st.oppHands.join(',') === '13,13,13' && st.wallLeft === 83,
    `hand=${st.hand} opp=${st.oppHands} wall=${st.wallLeft}`);

  // 诊断：注入 canvas 侧事件记录
  await page.evaluate(() => {
    window.__evt = [];
    const c = document.querySelector('canvas');
    ['pointermove', 'pointerdown', 'pointerup'].forEach(t =>
      c.addEventListener(t, (e) => window.__evt.push(t + ':' + Math.round(e.clientX) + ',' + Math.round(e.clientY))));
  });
  // 动态取手牌投影点：屏幕 (sx,sy) -> 容器局部 (sy, W-sx)；选第 12 张避开偶数张中心缝
  const target = await page.evaluate(() => {
    const mj = window.__mj;
    const c = document.querySelector('canvas');
    const w = c.clientWidth, h = c.clientHeight;
    const m = mj.hands.S[11];
    const v = m.getWorldPosition(new mj.THREE.Vector3()).project(mj.camera);
    return { u: (v.x + 1) / 2 * w, v: (1 - v.y) / 2 * h, W: innerWidth };
  });
  const sx = Math.round(target.W - target.v), sy = Math.round(target.u);
  await page.mouse.move(sx, sy);
  await page.waitForTimeout(400);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(900);
  console.log('click screen =', sx + ',' + sy, '-> local =', Math.round(target.u) + ',' + Math.round(target.v));

  const st2 = await page.evaluate(() => ({
    hand: window.__mj.hands.S.length,
    disc: window.__mj.discards.S.length,
    wall: window.__mj.wallLeft,
  }));
  console.log('canvas events =', JSON.stringify((await page.evaluate(() => window.__evt)).slice(0, 6)));
  const proj = await page.evaluate(() => {
    const mj = window.__mj;
    const c = document.querySelector('canvas');
    const w = c.clientWidth, h = c.clientHeight;
    const pts = mj.hands.S.map((m) => {
      const v = m.getWorldPosition(new mj.THREE.Vector3()).project(mj.camera);
      return [Math.round((v.x + 1) / 2 * w), Math.round((1 - v.y) / 2 * h)];
    });
    return { w, h, pts };
  });
  console.log('canvas', proj.w + 'x' + proj.h, 'hand pts =', JSON.stringify(proj.pts));
  const rc = await page.evaluate(() => {
    const mj = window.__mj;
    const r = new mj.THREE.Raycaster();
    const out = {};
    for (const [nx, ny] of [[0, -0.451], [0, -0.487], [0, -0.3], [0.2, -0.451]]) {
      r.setFromCamera(new mj.THREE.Vector2(nx, ny), mj.camera);
      out[nx + ',' + ny] = r.intersectObjects(mj.hands.S, false).length;
    }
    return out;
  });
  console.log('manual raycast hits =', JSON.stringify(rc));
  const hov = await page.evaluate(() => {
    const m = window.__mj.getHovered();
    return m ? { inHand: m.userData.inHand, tile: m.userData.tile } : null;
  });
  console.log('hovered =', JSON.stringify(hov));
  check('竖屏下点击手牌出牌', st2.hand === st.hand - 1 && st2.disc === 1,
    'hand ' + st.hand + '->' + st2.hand + ', disc=' + st2.disc);

  await page.screenshot({ path: OUT });
  check('无控制台错误', errors.length === 0, errors.join(' | ') || 'clean');

  await browser.close();
  console.log(failed ? '\nRESULT: ' + failed + ' FAILED' : '\nRESULT: ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('RUNNER_ERROR', e); process.exit(2); });
