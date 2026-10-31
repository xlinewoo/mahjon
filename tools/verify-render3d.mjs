#!/usr/bin/env node
/**
 * 3D 牌桌渲染器无头验证（tools/verify-render3d.mjs）
 *
 * 做法：用 esbuild 把一段「探针」入口打成 IIFE，内联进临时 HTML，
 *   用 tools/lib/chrome.mjs 起无头 Chrome 打开它，喂合成 view，断言整桌网格数量/
 *   正反面/座位映射/出牌合法性。全程零新增依赖。
 *
 * ⚠️ 无头 Chrome 常常没有可用的 WebGL；此时 renderer=null，但场景图仍会构建，
 *   计数类断言照常有效（本脚本不依赖 GPU）。
 *
 * 用法：node tools/verify-render3d.mjs
 */
import { createRequire } from 'node:module';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findChrome, launchChrome, teardownChrome, sleep } from './lib/chrome.mjs';

const require = createRequire(import.meta.url);
const { build } = require('/Users/CCBFT_Work/.workbuddy/binaries/node/workspace/node_modules/esbuild');

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, '../frontend');

const PROBE = `
import { createRender3d, tileName } from './render3d.js';
const host = document.createElement('div');
host.id = 'r3d';
host.style.cssText = 'position:fixed;inset:0';
document.body.appendChild(host);
const r = createRender3d({ shadows: false, onAction: (a) => { window.__actions.push(a); }, onMessage: () => {} });
r.mount(host);
window.__r3d = r;
window.__tileName = tileName;
window.__actions = [];
`;

/** 合成一帧 view：给定各家手牌/副露/弃牌/墙余/座位 */
function makeView(o) {
  return {
    phase: o.phase || 'discard',
    turn: o.turn != null ? o.turn : 0,
    dealer: o.dealer != null ? o.dealer : 0,
    wallLeft: o.wallLeft != null ? o.wallLeft : 83,
    dice: o.dice === undefined ? [2, 5] : o.dice,
    flipTile: 2,
    wildTile: 3,
    skinTiles: [1, 2, 31],
    lastDiscard: null,
    discardLog: [],
    me: {
      seat: o.seat,
      name: '我',
      hand: o.myHand,
      melds: o.myMelds || [],
      discards: o.myDiscards || [],
      opened: false,
      legal: o.legal || [],
    },
    others: [1, 2, 3].map((s) => ({
      seat: s,
      name: 'P' + s,
      handCount: 13,
      melds: (o.otherMelds && o.otherMelds[s]) || [],
      discards: (o.otherDiscards && o.otherDiscards[s]) || [],
      opened: false,
    })),
  };
}

const CASES = {
  mine: {
    seat: 0,
    myHand: [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 27],
    myMelds: [{ type: 'peng', tiles: [18, 18, 18], from: 1 }],
    myDiscards: [12, 13, 14],
    otherMelds: { 1: [{ type: 'chi', tiles: [20, 21, 22], from: 0 }] },
    otherDiscards: { 1: [30, 31], 2: [5], 3: [] },
    wallLeft: 70,
    legal: [{ type: 'discard', tile: 0 }, { type: 'discard', tile: 27 }],
  },
};

function assertCase(actual) {
  const fail = [];
  const eq = (name, a, b) => { if (a !== b) fail.push(`${name}: 期望 ${b}，实际 ${a}`); };
  eq('我的手牌数', actual.per.S.hand, 14);
  eq('下家背面数', actual.per.E.hand, 13);
  eq('对家背面数', actual.per.N.hand, 13);
  eq('上家背面数', actual.per.W.hand, 13);
  eq('我的手牌全部正面', actual.myHandFaceUp, true);
  eq('他家全部背面', actual.othersFaceDown, true);
  eq('副露全部正面', actual.meldsFaceUp, true);
  eq('我的副露张数', actual.per.S.meld, 3);
  eq('下家副露张数', actual.per.E.meld, 3);
  eq('我的弃牌数', actual.per.S.discard, 3);
  eq('下家弃牌数', actual.per.E.discard, 2);
  eq('对家弃牌数', actual.per.N.discard, 1);
  eq('牌墙张数', actual.wall, 70);
  eq('牌墙每墩两张', actual.wall % 2, 0);
  // 2026-10-30 二十轮（老吴）：桌上不再摆癞子指示牌，改由左上角「赖」徽标说明
  eq('癞子不再摆到桌上（只在左上角徽标）', actual.wildMarked, false);
  eq('牌河首张在左上角（x=-0.30）', actual.riverStartX, -0.3);
  eq('牌河第二张在首张右侧', actual.riverSecondX > actual.riverStartX, true);
  eq('牌河单张已放大（>=1.15x）', actual.riverScale >= 1.15, true);
  eq('牌河/桌心不再有彩色圆环', actual.markerShapes.every((t) => t === 'BoxGeometry'), true);
  // 2026-10-30 二十轮（老吴）：「牌河中不要显示骰子」→ 桌上一颗都不摆，点数仍照收
  eq('骰子不上桌（0 颗）', actual.dice, 0);
  eq('骰子点数下传 [2,5]', actual.diceValues, '[2,5]');
  eq('骰子面值朝上姿态正确', actual.diceRestOk, true);
  eq('可打出 tile=0', actual.discardable0, true);
  eq('可打出 tile=27', actual.discardable27, true);
  eq('不可打出 tile=5', actual.discardable5, false);
  eq('牌名 0=一万', actual.name0, '一万');
  eq('牌名 26=九条', actual.name26, '九条');
  eq('牌名 31=红中', actual.name31, '红中');
  return fail;
}

/* ---------------- 打包探针 ---------------- */
const built = await build({
  stdin: { contents: PROBE, resolveDir: FRONTEND, sourcefile: 'r3d-probe.js', loader: 'js' },
  bundle: true, format: 'iife', platform: 'browser', target: ['es2018'],
  write: false, absWorkingDir: FRONTEND, logLevel: 'warning',
});
const js = built.outputFiles[0].text.replace(/<\/script>/g, '<\\/script>');

const dir = mkdtempSync(join(tmpdir(), 'r3d-'));
const htmlPath = join(dir, 'probe.html');
writeFileSync(htmlPath,
  `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}</style><body><script>${js}</script></body>`);

if (!findChrome()) { console.error('❌ 找不到 Chrome（设 CHROME_PATH）'); process.exit(2); }

let session;
let failed = 0;
try {
  session = await launchChrome({ extraArgs: ['--enable-unsafe-swiftshader', '--window-size=1280,800'] });
  await session.cdp.send('Page.enable');
  await session.cdp.send('Page.navigate', { url: pathToFileURL(htmlPath).href });
  for (let i = 0; i < 100; i++) {
    if (await session.cdp.eval('!!window.__r3d')) break;
    await sleep(100);
  }

  const hasWebGL = await session.cdp.eval('!!window.__r3d.renderer');
  console.log('WebGL 可用:', hasWebGL);

  // 渲染一帧并采集断言所需事实
  const view = makeView(CASES.mine);
  await session.cdp.eval(`window.__renderView = ${JSON.stringify(view)};`);
  const facts = await session.cdp.eval(`(() => {
    const r = window.__r3d;
    r.render(window.__renderView, { MY_SEAT: ${CASES.mine.seat} });
    const c = r.counts();
    const keyFaceUp = (mesh) => mesh.userData.faceUp;
    const per = {};
    for (const k of ['S','E','N','W']) per[k] = { hand: c.per[k].hand, meld: c.per[k].meld, discard: c.per[k].discard, wall: c.per[k].wall };
    const myHandFaceUp = r.myHand.every(m => keyFaceUp(m));
    const othersFaceDown = ['E', 'N', 'W'].every((k) => r.groups[k].hand.children.every((m) => m.userData.faceUp === false));
    const meldsFaceUp = ['S', 'E'].every((k) => r.groups[k].meld.children.every((m) => m.userData.faceUp === true));
    // 骰子：点位在 1..6，且 mesh 的 rotation 恰为「该点朝上」的姿态
    const dv = r.diceValues || [];
    const diceRestOk = dv.length === 2 && dv.every((v, i) => {
      const [rx, ry, rz] = r.diceRestRot(v);
      const dm = r.scene.children.find((o) => o.type === 'Group' && o.children.some((c) => c.userData && c.userData.dieIndex === i));
      const m = dm && dm.children.find((c) => c.userData && c.userData.dieIndex === i);
      return !!m && Math.abs(m.rotation.x - rx) < 1e-6 && Math.abs(m.rotation.y - ry) < 1e-6 && Math.abs(m.rotation.z - rz) < 1e-6;
    });
    return {
      per, wall: c.wall, markers: c.markers, dice: c.dice, diceValues: JSON.stringify(dv), diceRestOk,
      myHandFaceUp, othersFaceDown, meldsFaceUp,
      handCodes: r.myHand.map((m) => m.userData.code),
      discardable0: r.isDiscardable(0), discardable27: r.isDiscardable(27), discardable5: r.isDiscardable(5),
      name0: window.__tileName(0), name26: window.__tileName(26), name31: window.__tileName(31),
      wildMarked: !!c.wild,
      riverStartX: r.river.children[0] ? r.river.children[0].position.x : null,
      riverSecondX: r.river.children[1] ? r.river.children[1].position.x : null,
      riverScale: r.river.children[0] ? r.river.children[0].scale.x : null,
      markerShapes: r.markers.children.map((m) => m.geometry && m.geometry.type),
    };
  })()`);

  const fail = assertCase(facts);
  // 手牌摆布：红中 → 皮子 → 赖子 → 普通（组内升序，老吴 2026-10-20）
  const skinSet = new Set(view.skinTiles);
  const rank = (t) => (t === 31 ? 0 : t === view.wildTile ? 2 : skinSet.has(t) ? 1 : 3);
  const wantOrder = [...view.me.hand].sort((a, b) => rank(a) - rank(b) || a - b);
  if (JSON.stringify(facts.handCodes) !== JSON.stringify(wantOrder)) {
    fail.push(`手牌顺序应为红中→皮子→赖子→普通：期望 ${JSON.stringify(wantOrder)}，实际 ${JSON.stringify(facts.handCodes)}`);
  }
  console.log('counts =', JSON.stringify(facts.per));
  console.log('wall =', facts.wall, '· markers =', facts.markers, '· dice =', facts.diceValues, '· WebGL =', hasWebGL);

  // 角标：等贴图异步加载完，采样（34,10）—— 圆角色块内部、文字上方。
  //   癞子 3 → 红块；皮子 1 → 蓝块；红中 31（下家牌河）→ 蓝块（均无文字）。
  await sleep(500);
  const pix = await session.cdp.eval(`(() => {
    const r = window.__r3d;
    const sample = (m) => {
      try {
        const mat = Array.isArray(m.material) ? m.material[4] : m.material;
        const c = mat.map.image.getContext('2d');
        const p = c.getImageData(34, 10, 1, 1).data;
        return [p[0], p[1], p[2]];
      } catch (e) { return String(e); }
    };
    const wild = r.myHand.find((x) => x.userData.code === 3);
    const skin = r.myHand.find((x) => x.userData.code === 1);
    const hong = r.river.children.find((x) => x.userData.code === 31);
    return { wild: wild && sample(wild), skin: skin && sample(skin), hong: hong && sample(hong) };
  })()`);
  const isRed = (p) => Array.isArray(p) && p[0] > 150 && p[1] < 140;
  const isBlue = (p) => Array.isArray(p) && p[2] > 150 && p[0] < 150;
  if (!isRed(pix.wild)) fail.push(`癞子牌左上角应有红色标记，实际像素 ${JSON.stringify(pix.wild)}`);
  // 点特殊牌 = 对应特殊杠（老吴 2026-10-20：红中/皮子/癞子不能进牌河）
  const clickRes = await session.cdp.eval(`(() => {
    const r = window.__r3d;
    const v = JSON.parse(JSON.stringify(window.__renderView));
    v.phase = 'discard'; v.turn = 0;
    v.me.hand = [1, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
    v.me.legal = [{ type: 'skingang', tile: 1 }, { type: 'discard', tile: 5 }];
    window.__actions.length = 0;
    r.render(v, { MY_SEAT: 0 });
    r.applySize();
    const fire = (code) => {
      const m = r.myHand.find((x) => x.userData.code === code);
      if (!m) return { err: 'no mesh ' + code };
      const el = r.renderer.domElement, rect = el.getBoundingClientRect();
      const p = m.getWorldPosition(m.position.clone()); p.project(r.camera);
      const x = rect.left + (p.x * 0.5 + 0.5) * rect.width;
      const y = rect.top + (-p.y * 0.5 + 0.5) * rect.height;
      el.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
      el.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true }));
      el.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: y, bubbles: true }));
      return { hovered: r.getHovered() && r.getHovered().userData.code };
    };
    const skin = fire(1);
    const skinActs = window.__actions.slice();
    window.__actions.length = 0;
    const normal = fire(5);
    return { skin, skinActs, normal, normalActs: window.__actions.slice() };
  })()`);
  if (!clickRes.skinActs.some((a) => a.type === 'skingang' && a.tile === 1)) {
    fail.push(`点击皮子应发皮子杠，实际 ${JSON.stringify(clickRes.skinActs)}（hover=${clickRes.skin && clickRes.skin.hovered}）`);
  }
  if (clickRes.skinActs.some((a) => a.type === 'discard')) fail.push('点击皮子不应出牌（不能进牌河）');
  if (!clickRes.normalActs.some((a) => a.type === 'discard' && a.tile === 5)) {
    fail.push(`点击普通牌应出牌，实际 ${JSON.stringify(clickRes.normalActs)}（hover=${clickRes.normal && clickRes.normal.hovered}）`);
  }

  if (!isBlue(pix.skin)) fail.push(`皮子牌左上角应有蓝色标记，实际像素 ${JSON.stringify(pix.skin)}`);
  if (!isBlue(pix.hong)) fail.push(`红中牌左上角应有蓝色标记，实际像素 ${JSON.stringify(pix.hong)}`);

  // 悬停手牌 5 → 牌河里同牌面的牌放大；移开恢复（老吴 2026-10-20）
  const hoverRes = await session.cdp.eval(`(() => {
    const r = window.__r3d;
    const el = r.renderer.domElement, rect = el.getBoundingClientRect();
    const m = r.myHand.find((x) => x.userData.code === 5);
    const riverTile = r.river.children.find((x) => x.userData.code === 5);
    if (!m || !riverTile) return { err: 'missing hand/river 5' };
    const at = (mesh) => {
      const p = mesh.getWorldPosition(mesh.position.clone()); p.project(r.camera);
      return [rect.left + (p.x * 0.5 + 0.5) * rect.width, rect.top + (-p.y * 0.5 + 0.5) * rect.height];
    };
    const fire = (xy) => el.dispatchEvent(new PointerEvent('pointermove', { clientX: xy[0], clientY: xy[1], bubbles: true }));
    fire([0, 0]);
    const base = riverTile.userData.baseScale;
    fire(at(m));
    const hi = riverTile.scale.x;
    fire([0, 0]);
    return { base, hi, back: riverTile.scale.x, hovered: r.getHovered() && r.getHovered().userData.code };
  })()`);
  if (hoverRes.err) fail.push(`悬停高亮测试准备失败：${hoverRes.err}`);
  else {
    if (!(hoverRes.hi > hoverRes.base * 1.1)) {
      fail.push(`悬停手牌 5 时牌河同牌面应放大：base=${hoverRes.base} hi=${hoverRes.hi}（hover=${hoverRes.hovered}）`);
    }
    if (Math.abs(hoverRes.back - hoverRes.base) > 1e-6) {
      fail.push(`移开手牌后牌河应恢复：base=${hoverRes.base} back=${hoverRes.back}`);
    }
  }

  // 新摸的牌先单独放最右（老吴 2026-10-20）：本轮 lastDraw 应在 myHand 末尾、且与前一张有空档
  const drawRes = await session.cdp.eval(`(() => {
    const r = window.__r3d;
    const v = JSON.parse(JSON.stringify(window.__renderView));
    v.phase = 'discard'; v.turn = 0; v.lastDraw = 5;
    v.me.hand = [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 27];
    r.render(v, { MY_SEAT: 0 });
    const codes = r.myHand.map((m) => m.userData.code);
    const xs = r.myHand.map((m) => m.position.x);
    const lastMesh = r.myHand[r.myHand.length - 1];
    return {
      n: codes.length, last: codes[codes.length - 1], lastX: xs[xs.length - 1], prevX: xs[xs.length - 2],
      drawnFlag: !!(lastMesh && lastMesh.userData.drawn),
    };
  })()`);
  if (drawRes.n !== 14 || drawRes.last !== 5 || !drawRes.drawnFlag) {
    fail.push(`新摸的牌应单独放最右并标记 drawn：n=${drawRes.n} last=${drawRes.last} flag=${drawRes.drawnFlag}`);
  }
  if (!(drawRes.lastX - drawRes.prevX > 0.075)) {
    fail.push(`新摸的牌与手牌之间应留空档，实际间距 ${(drawRes.lastX - drawRes.prevX).toFixed(4)}`);
  }

  // view.dice 为空（如单机/旧帧）→ 骰子必须隐藏
  const noDice = await session.cdp.eval(`(() => {
    const r = window.__r3d;
    const v = JSON.parse(JSON.stringify(window.__renderView)); v.dice = null;
    r.render(v, { MY_SEAT: 0 });
    return { dice: r.counts().dice, values: r.diceValues };
  })()`);
  if (noDice.dice !== 0 || noDice.values !== null) {
    fail.push(`view.dice=null 时骰子应隐藏，实际 dice=${noDice.dice} values=${JSON.stringify(noDice.values)}`);
  }

  if (fail.length) { failed = fail.length; console.log('FAIL(' + fail.length + '):\n  ' + fail.join('\n  ')); }
  else console.log('PASS: 3D 渲染器断言全绿');
} catch (e) {
  console.error('FATAL', e);
  failed = 1;
} finally {
  teardownChrome(session);
}
process.exit(failed ? 2 : 0);
