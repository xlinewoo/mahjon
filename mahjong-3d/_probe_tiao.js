// 探针：验证新配牌规则（补单张从被跳过墩的前一张开始）
// 强制骰子 4+4=8 → 上家(W)起手、start=24
const { chromium } = require('playwright-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  // 强制 Math.random=0.55 → v1=v2=4（1+floor(0.55*6)=4）
  await page.addInitScript(() => { Math.random = () => 0.55; });
  await page.goto('http://127.0.0.1:8789/index.html', { waitUntil: 'load', timeout: 20000 });
  await page.waitForFunction(() => window.__mj && window.__mj.dealDone, { timeout: 30000 });
  const st = await page.evaluate(() => {
    const mj = window.__mj;
    const R = mj.wallRing, left = i => { const k = R[i]; return (k.meshes[0] ? 1 : 0) + (k.meshes[1] ? 1 : 0); };
    const start = mj.dealPlan(mj.diceResult[0] + mj.diceResult[1]).start;
    const log = mj.dealLog;
    const rings = log.map(t => t.ring), layers = log.map(t => t.layer);
    const half = [];
    for (let i = 0; i < R.length; i++) if (left(i) === 1) half.push(i);
    const drained = [];
    for (let i = 0; i < R.length; i++) if (left(i) === 0) drained.push(i);
    const sides = {};
    for (const s of mj.SEATS) sides[s.key] = mj.wallRing.filter(k => k.seat === s.key)
      .reduce((a, k) => a + (k.meshes[0] ? 1 : 0) + (k.meshes[1] ? 1 : 0), 0);
    return {
      dice: mj.diceResult, start,
      logLen: log.length,
      logRing: rings.join(','), logLayer: layers.join(''),
      left24to27: [0, 1, 2, 3].map(o => left((start + 24 + o) % 68)),
      half, drainedCount: drained.length,
      hands: [mj.hands.S.length, mj.hands.E.length, mj.hands.N.length, mj.hands.W.length],
      wallLeft: mj.wallLeft, drawPtr: mj.drawPtr, sides,
    };
  });
  const n = st.dice[0] + st.dice[1];
  const rings = st.logRing.split(',').map(Number);
  const expPtr = (st.start + 26) % 68;
  const checks = [
    ['骰子=4+4=8', st.dice[0] === 4 && st.dice[1] === 4 && n === 8, JSON.stringify(st.dice)],
    ['起手 start=24（上家W，右手第8墩）', st.start === 24, String(st.start)],
    ['取牌 53 步', st.logLen === 53, String(st.logLen)],
    ['前三轮 48 次 = start+0..23 每墩两次', rings.slice(0, 48).every((r, i) => r === (st.start + Math.floor(i / 2)) % 68), ''],
    ['跳牌环序 = 24,26（上层）', rings[48] === (st.start + 24) % 68 && rings[49] === (st.start + 26) % 68, rings.slice(48, 50).join(',')],
    ['补单张环序 = 24,25,25（下24底/对25上/上25底）', rings[50] === (st.start + 24) % 68 && rings[51] === (st.start + 25) % 68 && rings[52] === (st.start + 25) % 68, rings.slice(50, 53).join(',')],
    ['层序 = 跳牌1,1 + 单张0,1,0', st.logLayer.slice(48) === '11010', st.logLayer.slice(48)],
    ['start+24 摸光(0)', st.left24to27[0] === 0, String(st.left24to27[0])],
    ['start+25 被跳过墩摸光(0)', st.left24to27[1] === 0, String(st.left24to27[1])],
    ['start+26 跳牌第二墩剩墩底(1)', st.left24to27[2] === 1, String(st.left24to27[2])],
    ['start+27 完整(2)', st.left24to27[3] === 2, String(st.left24to27[3])],
    ['全墙仅 1 个半截墩（26墩底，紧邻摸牌指针）', st.half.length === 1 && st.half[0] === (st.start + 26) % 68, JSON.stringify(st.half)],
    ['摸光墩数 = 26（24+跳牌2）', st.drainedCount === 26, String(st.drainedCount)],
    ['drawPtr = start+26', st.drawPtr === expPtr, `ptr=${st.drawPtr} expect=${expPtr}`],
    ['手牌 = 庄14 闲13×3', st.hands.join(',') === '14,13,13,13', st.hands.join(',')],
    ['墙剩 83', st.wallLeft === 83, String(st.wallLeft)],
    ['各家墙合计 83', Object.values(st.sides).reduce((a, b) => a + b, 0) === 83, JSON.stringify(st.sides)],
  ];
  let fail = 0;
  for (const [name, ok, detail] of checks) {
    if (!ok) fail++;
    console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (ok ? '' : ' | got: ' + detail));
  }
  await page.screenshot({ path: '_probe_tiao.png' });
  await page.screenshot({ path: '_probe_tiao_corner.png', clip: { x: 620, y: 50, width: 620, height: 400 } });
  console.log('sides =', JSON.stringify(st.sides), '| errors =', errors.length ? errors.join('\n') : '(none)');
  await browser.close();
  process.exit(fail || errors.length ? 2 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
