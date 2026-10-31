/* 无头验证：标准配牌流程（掷骰定起手 → 三轮两墩 → 庄家跳牌 → 三家各一张）
   + 牌墙环几何（每家门 17 墩/方环/角相接/墩距靠紧/墙在手牌前方）+ 出牌全链路断言 */
const { chromium } = require('playwright-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = 'http://127.0.0.1:8789/index.html';
const OUT = 'C:/Users/Administrator/WorkBuddy/2026-10-18-16-15-34/mahjong-3d/_shot.png';

(async () => {
  const browser = await chromium.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,800'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push('[console] ' + m.text()); });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('favicon')) errors.push('[http ' + r.status() + '] ' + r.url()); });
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  // 掷骰 + 配牌动画约 4s，等dealDone
  await page.waitForFunction(() => window.__mj && window.__mj.dealDone, null, { timeout: 30000 });
  await page.waitForTimeout(400);

  const canvasCount = await page.evaluate(() => document.querySelectorAll('canvas').length);

  // 1) 配牌完成态：张数 / 骰子映射 / 环序 / 跳牌结构 / 几何
  const deal = await page.evaluate(() => {
    const mj = window.__mj;
    const V = () => new mj.THREE.Vector3();
    const wp = (m) => m.getWorldPosition(V());
    const n = mj.diceResult[0] + mj.diceResult[1];
    const start = mj.diceStartRing(n);
    const st = (i) => mj.wallRing[i];
    const meshOf = (i, l) => st(i).meshes[l];
    const posOf = (i, l) => { const m = meshOf(i, l); return m ? wp(m) : null; };
    // 环序核对：S(16→0) W(0→16) N(16→0) E(0→16)
    const ringSeq = mj.RING.map(r => r.seat + ':' + r.d);
    const expect = [];
    for (let d = 16; d >= 0; d--) expect.push('S:' + d);
    for (let d = 0; d <= 16; d++) expect.push('W:' + d);
    for (let d = 16; d >= 0; d--) expect.push('N:' + d);
    for (let d = 0; d <= 16; d++) expect.push('E:' + d);
    // 骰子→起手家映射（2..12）
    const seatMap = {};
    for (let k = 2; k <= 12; k++) seatMap[k] = mj.diceSeat(k);
    // 墩距/层距
    const gap = mj.wallSlotPos('S', 1, 0)[0] - mj.wallSlotPos('S', 0, 0)[0];
    const layerGap = mj.wallSlotPos('S', 0, 1)[1] - mj.wallSlotPos('S', 0, 0)[1];
    // 角上相接：用槽位几何算（对局中角墩可能已被摸走，活 mesh 会为 null）
    const TW = 0.045, TH = 0.062;
    const slotWorld = (seat, d, layer) => {
      const v = new mj.THREE.Vector3(...mj.wallSlotPos(seat, d, layer));
      mj.seatGroups[seat].localToWorld(v);
      return v;
    };
    const cornerSW = { sWest: slotWorld('S', 0, 0).x - TW / 2, wInner: slotWorld('W', 0, 0).x + TH / 2,
      zA: [slotWorld('S', 0, 0).z - TH / 2, slotWorld('S', 0, 0).z + TH / 2],
      zB: [slotWorld('W', 0, 0).z - TW / 2, slotWorld('W', 0, 0).z + TW / 2] };
    const cornerSE = { sEast: slotWorld('S', 16, 0).x + TW / 2, eInner: slotWorld('E', 16, 0).x - TH / 2,
      zA: [slotWorld('S', 16, 0).z - TH / 2, slotWorld('S', 16, 0).z + TH / 2],
      zB: [slotWorld('E', 16, 0).z - TW / 2, slotWorld('E', 16, 0).z + TW / 2] };
    const cornerNE = { nEast: slotWorld('N', 0, 0).x + TW / 2, eInner: slotWorld('E', 0, 0).x - TH / 2,
      zA: [slotWorld('N', 0, 0).z - TH / 2, slotWorld('N', 0, 0).z + TH / 2],
      zB: [slotWorld('E', 0, 0).z - TW / 2, slotWorld('E', 0, 0).z + TW / 2] };
    const cornerNW = { nWest: slotWorld('N', 16, 0).x - TW / 2, wInner: slotWorld('W', 16, 0).x + TH / 2,
      zA: [slotWorld('N', 16, 0).z - TH / 2, slotWorld('N', 16, 0).z + TH / 2],
      zB: [slotWorld('W', 16, 0).z - TW / 2, slotWorld('W', 16, 0).z + TW / 2] };
    // 环整体范围（全部 68 墩槽位）
    const allSlots = [];
    for (const r of mj.RING) for (let l = 0; l < 2; l++) allSlots.push(slotWorld(r.seat, r.d, l));
    // 手牌/墙世界位置（S 家，墙用槽位）
    const handS = mj.hands.S.map(wp);
    // 配牌日志
    const log = mj.dealLog.map(e => e.seat);
    const logRing = mj.dealLog.map(e => e.ring);
    const logLayer = mj.dealLog.map(e => e.layer);
    // 跳牌相关墩的剩余
    const left = (i) => (st(i).meshes[0] ? 1 : 0) + (st(i).meshes[1] ? 1 : 0);
    // 全部牌守恒：手里 53 + 墙里 83 = 136，且无重复
    const handTiles = mj.SEATS.flatMap(s => mj.hands[s.key].map(m => m.userData.tile.id)).sort();
    const wallTiles = mj.wallRing.flatMap(k => k.meshes.filter(Boolean).map(m => m.userData.tile.id)).sort();
    // 手牌面朝：自家亮开、对家背面
    const sFaceUp = mj.hands.S.every(m => m.material[4] !== m.material[5]);
    const oppFaceDown = ['E', 'N', 'W'].every(k => mj.hands[k].every(m => m.material[4] === m.material[5]));
    return {
      dice: mj.diceResult, n, start,
      hands: Object.fromEntries(mj.SEATS.map(s => [s.key, mj.hands[s.key].length])),
      wallLeft: mj.wallLeft,
      wallBySeat: Object.fromEntries(mj.SEATS.map(s => [s.key, mj.seatWallCount(s.key)])),
      drawPtr: mj.drawPtr,
      ringLen: mj.wallRing.length,
      ringSeqOK: ringSeq.join(',') === expect.join(','),
      stacksPerSeat: Object.fromEntries(mj.SEATS.map(s => [s.key, mj.wallRing.filter(k => k.seat === s.key).length])),
      seatMap,
      logLen: log.length,
      logSeq: log.join(''),
      logRing: logRing.join(','), logLayer: logLayer.join(''),
      tiaoSkipLeft: left((start + 25) % 68),
      tiaoUsedLeft: [24, 25, 26, 27].map(o => left((start + o) % 68)),
      handTiles, wallTiles,
      sFaceUp, oppFaceDown,
      gap, layerGap,
      cornerSW, cornerSE, cornerNE, cornerNW,
      handZ: handS.length ? Math.max(...handS.map(p => p.z)) : null,
      wallZ: slotWorld('S', 0, 0).z,
      wallMaxAbsX: Math.max(...allSlots.map(p => Math.abs(p.x))),
      wallMaxAbsZ: Math.max(...allSlots.map(p => Math.abs(p.z))),
      contentHalf: mj.contentHalf,
      seatPos: mj.seatPos,
      wallHalf: mj.wallHalf,
      handMaxAbsX: Math.max(...mj.SEATS.flatMap(s => mj.hands[s.key].map(m => Math.abs(wp(m).x)))),
    };
  });

  // 2) 摸牌：墙 -1、手牌 +1，且来自摸牌指针那墩的上层
  await page.click('#btn-draw');
  await page.waitForTimeout(700);
  const afterDraw = await page.evaluate(() => {
    const mj = window.__mj;
    return { wallLeft: mj.wallLeft, hand: mj.hands.S.length };
  });

  // 3) 对家出牌 ×5：对手手牌 -1、对手弃牌 +1（翻面亮牌）
  for (let i = 0; i < 5; i++) { await page.click('#btn-opp'); await page.waitForTimeout(250); }
  const afterOpp = await page.evaluate(() => {
    const mj = window.__mj;
    const V = () => new mj.THREE.Vector3();
    const oppDisc = ['E', 'N', 'W'].flatMap(k => mj.discards[k].map(m => m.getWorldPosition(V())));
    return {
      oppHands: ['E', 'N', 'W'].map(k => mj.hands[k].length),
      oppDisc: oppDisc.length,
      oppDiscFaceUp: ['E', 'N', 'W'].every(k => mj.discards[k].every(m => m.material[4] !== m.material[5])),
      oppDiscFlat: ['E', 'N', 'W'].every(k => mj.discards[k].every(m => Math.abs(m.rotation.x + Math.PI / 2) < 1e-6)),
      oppDiscInRing: oppDisc.every(p => Math.abs(p.x) < mj.wallHalf[0] - 0.001 && Math.abs(p.z) < mj.wallHalf[1] - 0.001),
    };
  });

  // 4) 副露：吃(3)/碰(3)/杠(4)
  for (let i = 0; i < 3; i++) { await page.click('#btn-meld'); await page.waitForTimeout(600); }
  const meldState = await page.evaluate(() => {
    const mj = window.__mj;
    const V = () => new mj.THREE.Vector3();
    const all = mj.melds.S.flatMap(m => m.meshes);
    return {
      count: mj.melds.S.length,
      sizes: mj.melds.S.map(m => m.meshes.length),
      types: mj.melds.S.map(m => m.type),
      flat: all.every(x => Math.abs(x.rotation.x + Math.PI / 2) < 1e-6),
      faceUp: all.every(x => x.material[4] !== x.material[5]),
      wallLeft: mj.wallLeft,
    };
  });

  // 5) 自己点一张手牌出牌
  const target = await page.evaluate(() => {
    const mj = window.__mj;
    const c = document.querySelector('canvas');
    const w = c.clientWidth, h = c.clientHeight;
    const m = mj.hands.S[11];
    const v = m.getWorldPosition(new mj.THREE.Vector3()).project(mj.camera);
    return { x: Math.round((v.x + 1) / 2 * w), y: Math.round((1 - v.y) / 2 * h) };
  });
  await page.mouse.move(target.x, target.y);
  await page.waitForTimeout(300);
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(800);
  await page.screenshot({ path: OUT });

  const afterDiscard = await page.evaluate(() => {
    const mj = window.__mj;
    const V = () => new mj.THREE.Vector3();
    const d = mj.discards.S.map(m => m.getWorldPosition(V()));
    return {
      hand: mj.hands.S.length,
      myDisc: mj.discards.S.length,
      myDiscFaceUp: mj.discards.S.every(m => m.material[4] !== m.material[5]),
      discInRing: d.every(p => Math.abs(p.x) < mj.wallHalf[0] - 0.001 && Math.abs(p.z) < mj.wallHalf[1] - 0.001),
    };
  });

  const hud = await page.evaluate(() => document.getElementById('hud-tl').innerText + ' | ' + document.getElementById('hud-tr').innerText);

  // ---------- 汇总断言 ----------
  const pass = [], fail = [];
  const check = (name, ok, detail) => (ok ? pass : fail).push(`${name}: ${detail}`);

  // 骰子与起手判定
  const expectSeatMap = { 2: 'E', 3: 'N', 4: 'W', 5: 'S', 6: 'E', 7: 'N', 8: 'W', 9: 'S', 10: 'E', 11: 'N', 12: 'W' };
  check('骰子和∈2..12', deal.n >= 2 && deal.n <= 12, String(deal.n));
  check('点数和→起手家(5,9=庄/2,6,10=下/3,7,11=对/4,8,12=上)',
    Object.keys(expectSeatMap).every(k => deal.seatMap[k] === expectSeatMap[k]), JSON.stringify(deal.seatMap));
  check('起手墩=该家右手第n墩', deal.start === mjBase(deal.n), `n=${deal.n} start=${deal.start}`);
  function mjBase(n) { const b = { S: 0, W: 17, N: 34, E: 51 }; return b[expectSeatMap[n]] + n - 1; }

  // 牌墙环
  check('总墩数=68(每家门17墩×4)', deal.ringLen === 68 && Object.values(deal.stacksPerSeat).every(v => v === 17), JSON.stringify(deal.stacksPerSeat));
  check('环序=S(16→0)W(0→16)N(16→0)E(0→16)', deal.ringSeqOK, deal.ringSeqOK ? 'ok' : 'mismatch');
  check('墩距靠紧(=牌宽0.045)', Math.abs(deal.gap - 0.045) < 1e-9, String(deal.gap));
  check('墩内两张全厚摞(层距0.026)', Math.abs(deal.layerGap - 0.026) < 1e-9, String(deal.layerGap));
  check('SW角面接触(S西面=W内面)', Math.abs(deal.cornerSW.sWest - deal.cornerSW.wInner) < 1e-6 &&
    deal.cornerSW.zA[1] > deal.cornerSW.zB[0] && deal.cornerSW.zA[0] < deal.cornerSW.zB[1],
    `S西面=${deal.cornerSW.sWest.toFixed(4)} W内面=${deal.cornerSW.wInner.toFixed(4)} z重叠=[${deal.cornerSW.zA.map(v => v.toFixed(3))}]×[${deal.cornerSW.zB.map(v => v.toFixed(3))}]`);
  check('SE角面接触(S东面=E内面)', Math.abs(deal.cornerSE.sEast - deal.cornerSE.eInner) < 1e-6 &&
    deal.cornerSE.zA[1] > deal.cornerSE.zB[0] && deal.cornerSE.zA[0] < deal.cornerSE.zB[1],
    `S东面=${deal.cornerSE.sEast.toFixed(4)} E内面=${deal.cornerSE.eInner.toFixed(4)}`);
  check('NE角面接触(N东面=E内面)', Math.abs(deal.cornerNE.nEast - deal.cornerNE.eInner) < 1e-6 &&
    deal.cornerNE.zA[1] > deal.cornerNE.zB[0] && deal.cornerNE.zA[0] < deal.cornerNE.zB[1],
    `N东面=${deal.cornerNE.nEast.toFixed(4)} E内面=${deal.cornerNE.eInner.toFixed(4)}`);
  check('NW角面接触(N西面=W内面)', Math.abs(deal.cornerNW.nWest - deal.cornerNW.wInner) < 1e-6 &&
    deal.cornerNW.zA[1] > deal.cornerNW.zB[0] && deal.cornerNW.zA[0] < deal.cornerNW.zB[1],
    `N西面=${deal.cornerNW.nWest.toFixed(4)} W内面=${deal.cornerNW.wInner.toFixed(4)}`);
  check('牌墙在手牌前方(朝桌心)', deal.handZ > deal.wallZ + 0.02, `handZ=${deal.handZ.toFixed(3)} wallZ=${deal.wallZ.toFixed(3)}`);
  check('墙不超内容边界', deal.wallMaxAbsX <= deal.contentHalf[0] + 1e-6 && deal.wallMaxAbsZ <= deal.contentHalf[1] + 1e-6,
    `maxX=${deal.wallMaxAbsX.toFixed(3)} maxZ=${deal.wallMaxAbsZ.toFixed(3)} content=${deal.contentHalf.map(v => v.toFixed(3))}`);
  check('各家手牌不超内容边界', deal.handMaxAbsX <= deal.contentHalf[0] + 1e-6, `maxX=${deal.handMaxAbsX.toFixed(3)}`);

  // 配牌结果
  check('配牌张数：庄14/闲13×3', deal.hands.S === 14 && deal.hands.E === 13 && deal.hands.N === 13 && deal.hands.W === 13, JSON.stringify(deal.hands));
  check('配牌共取53张', deal.logLen === 53, String(deal.logLen));
  check('牌墙剩83张', deal.wallLeft === 83, String(deal.wallLeft));
  check('各家墙合计=83', Object.values(deal.wallBySeat).reduce((a, b) => a + b, 0) === 83, JSON.stringify(deal.wallBySeat));
  check('牌守恒(手53+墙83=136，34种牌型各4张)', (() => {
    const all = [...deal.handTiles, ...deal.wallTiles];
    const cnt = {};
    all.forEach(id => cnt[id] = (cnt[id] || 0) + 1);
    return all.length === 136 && Object.keys(cnt).length === 34 && Object.values(cnt).every(v => v === 4);
  })(), `total=${deal.handTiles.length + deal.wallTiles.length} 牌型=${new Set([...deal.handTiles, ...deal.wallTiles]).size}`);
  // 取牌顺序：三轮 [S,E,N,W]×2墩(每墩上下各一张=4) → 庄跳牌2张 → E,N,W 各1张
  const expectLog = [];
  for (let r = 0; r < 3; r++) for (const s of ['S', 'E', 'N', 'W']) for (let k = 0; k < 4; k++) expectLog.push(s);
  expectLog.push('S', 'S', 'E', 'N', 'W');
  check('取牌顺序=三轮两墩+跳牌+三单张', deal.logSeq === expectLog.join(''), deal.logSeq);
  const rings = deal.logRing.split(',').map(Number);
  const ringsOK = rings.slice(0, 48).every((r, i) => r === (deal.start + Math.floor(i / 2)) % 68) &&
    rings[48] === (deal.start + 24) % 68 && rings[49] === (deal.start + 26) % 68 &&
    rings[50] === (deal.start + 24) % 68 && rings[51] === (deal.start + 25) % 68 && rings[52] === (deal.start + 25) % 68;
  check('取牌环序：庄24上/26上(跳牌)→下家24底→对家25上→上家25底', ringsOK, deal.logRing);
  check('层序：跳牌两上层 + 单张0,1,0（24底/25上/25底）', deal.logLayer.slice(48) === '11010', deal.logLayer.slice(48));
  check('被跳过的中间墩摸光(0张)', deal.tiaoSkipLeft === 0, String(deal.tiaoSkipLeft));
  check('24/25摸光、26剩墩底、27完整', JSON.stringify(deal.tiaoUsedLeft) === '[0,0,1,2]', JSON.stringify(deal.tiaoUsedLeft));
  check('摸牌指针=起手+26墩(26剩墩底，下一张即摸)', deal.drawPtr === (deal.start + 26) % 68, `ptr=${deal.drawPtr} expect=${(deal.start + 26) % 68}`);
  check('自家手牌亮开', deal.sFaceUp, String(deal.sFaceUp));
  check('对家手牌背面紧凑', deal.oppFaceDown, String(deal.oppFaceDown));

  // 交互链路
  check('摸牌：墙-1 手牌+1', afterDraw.wallLeft === 82 && afterDraw.hand === 15, `wall=${afterDraw.wallLeft} hand=${afterDraw.hand}`);
  check('对家出牌：手牌-1×5 弃牌+5', afterOpp.oppHands.reduce((a, b) => a + b, 0) === 39 - 5 && afterOpp.oppDisc === 5,
    `hands=${afterOpp.oppHands} disc=${afterOpp.oppDisc}`);
  check('对家弃牌翻面亮牌', afterOpp.oppDiscFaceUp, String(afterOpp.oppDiscFaceUp));
  check('对家弃牌平放', afterOpp.oppDiscFlat, String(afterOpp.oppDiscFlat));
  check('对家弃牌在环内侧(桌心)', afterOpp.oppDiscInRing, String(afterOpp.oppDiscInRing));
  check('副露3副', meldState.count === 3, String(meldState.count));
  check('副露张数3/3/4', meldState.sizes.join(',') === '3,3,4', meldState.sizes.join(','));
  check('副露类型吃碰杠', meldState.types.join(',') === 'chow,pung,kong', meldState.types.join(','));
  check('副露平放亮牌', meldState.flat && meldState.faceUp, `flat=${meldState.flat} faceUp=${meldState.faceUp}`);
  check('副露10张后墙=72', meldState.wallLeft === 72, String(meldState.wallLeft));
  check('点击出牌生效', afterDiscard.hand === 14 && afterDiscard.myDisc === 1, `hand=${afterDiscard.hand} disc=${afterDiscard.myDisc}`);
  check('自己弃牌翻面且在环内侧', afterDiscard.myDiscFaceUp && afterDiscard.discInRing, `faceUp=${afterDiscard.myDiscFaceUp} inRing=${afterDiscard.discInRing}`);
  check('canvas存在', canvasCount >= 1, String(canvasCount));

  console.log('PASS(' + pass.length + ') =', pass.join('\n  '));
  if (fail.length) console.log('FAIL(' + fail.length + ') =', fail.join('\n  '));
  console.log('HUD =', JSON.stringify(hud));
  console.log('errors =', errors.length ? errors.join('\n') : '(none)');
  await browser.close();
  if (fail.length || errors.length) process.exit(2);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
