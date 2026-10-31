#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, teardownChrome, sleep } from './lib/chrome.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, process.env.MAHJONG_ART_DIR || '148麻将子拆分');
const ZIP010 = resolve(ROOT, '010麻将图标/单个PNG格式.zip');
const TWO_D = resolve(SRC, '2D3D麻将分开');
const GLYPHS = resolve(SRC, '2D麻将分开');
const THREE_D = resolve(SRC, '3D麻将和一起');
const OUT_2D = resolve(ROOT, 'frontend/assets/tiles-art2d.js');
const OUT_3D = resolve(ROOT, 'frontend/assets/tiles-art3d.js');

const CARDNUM = [
  1, 2, 3, 4, 5, 6, 7, 8, 9,
  19, 20, 21, 22, 23, 24, 25, 26, 27,
  10, 11, 12, 13, 14, 15, 16, 17, 18,
  28, 29, 30, 31, 32, 33, 34,
];
// ⚠️ 两套素材的编号顺序**不同**（2026-10-23 逐张目视核实，别凭 README 记忆改）：
//   · 2dmj_cardnum_*（立体牌）是 万1-9 / 条10-18 / 筒19-27 → 需要 CARDNUM 重排；
//   · zip 里的 01_* / 02_* 都是 万1-9 / **筒10-18 / 条19-27**（01_10=一筒圆、
//     01_19=一条鸟、01_20=二条，01_82.. 同序偏移 +81）→ **顺序直读**，与引擎编码一致。
//     曾经把 01_* 也按 CARDNUM 处理，结果「简约·蓝 / 简约·棕」两套皮**筒条互换**
//     （真实二筒显示成二条、三筒显示成三条）——就是「三条其实是二条」错觉的根源。
// 3D 素材的字牌编号不是「东南西北中发白」：41=中、42=东、43=西、44=南、45=北。
// 引擎编码要求 27..33 = 东/南/西/北/中/发/白，所以这里必须显式重排（老吴 2026-10-23
// 实机发现：3D 里看起来是红中的牌其实是东风，真红中反而显示成北风）。
const Z1 = [
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 23, 24, 25, 26, 27, 28, 29,
  31, 32, 33, 34, 35, 36, 37, 38, 39,
  42, 44, 43, 45, 41, 46, 47,
];

function pngData(path) {
  return 'data:image/png;base64,' + readFileSync(path).toString('base64');
}

function zipPng(name) {
  const buf = execFileSync('unzip', ['-p', ZIP010, `*${name}.png`], { maxBuffer: 1 << 24 });
  return 'data:image/png;base64,' + Buffer.from(buf).toString('base64');
}

const source = {
  face: pngData(resolve(TWO_D, '2dmj_card_me_face_1.png')),
  back: pngData(resolve(TWO_D, '2dmj_card_me_back_1.png')),
  stereo: CARDNUM.map((n) => pngData(resolve(TWO_D, `2dmj_cardnum_mahjong_${n}.png`))),
  lay1: null,
  lay3: null,
  // 01_* / 02_* 都是「万/筒/条」顺序 ⇒ 顺序直读；flatBrown 是第二组（偏移 +81）
  flatBlue: Array.from({ length: 34 }, (_, i) => zipPng(`01_${String(i + 1).padStart(2, '0')}`)),
  flatCream: Array.from({ length: 34 }, (_, i) => zipPng(`02_${String(i + 1).padStart(2, '0')}`)),
  flatBrown: Array.from({ length: 34 }, (_, i) => zipPng(`01_${String(i + 82).padStart(2, '0')}`)),
  faces3d: {
    z1: Z1.map((n) => pngData(resolve(THREE_D, `mj_z1/mj_z1_${n}.png`))),
    z2: Z1.map((n) => pngData(resolve(THREE_D, `mj_z2/mj_z2_${n}.png`))),
  },
  back3d: {
    z1: pngData(resolve(THREE_D, 'mj_b_z1.png')),
    z2: pngData(resolve(THREE_D, 'mj_b_z2.png')),
  },
};

const lay = (dir) => {
  const out = [];
  for (const [suit, count] of [['wan', 9], ['tong', 9], ['tiao', 9], ['zi', 7]]) {
    for (let i = 1; i <= count; i++) out.push(pngData(resolve(GLYPHS, `${dir}/${suit}${i}.png`)));
  }
  return out;
};
source.lay1 = lay('lay1');
source.lay3 = lay('lay3');

const page = `<!doctype html><meta charset="utf-8"><canvas id="c"></canvas><script>
const SRC = ${JSON.stringify(source)};
const c = document.getElementById('c');
const x = c.getContext('2d');
function img(src) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });
}
async function compose(code, glyphs) {
  c.width = 84; c.height = 118;
  x.clearRect(0, 0, c.width, c.height);
  x.drawImage(await img(SRC.face), 0, 0);
  if (code !== 'back') {
    const g = await img(glyphs[code]);
    x.drawImage(g, Math.round((84 - g.width) / 2), Math.round((118 - g.height) / 2) - 2);
  }
  return c.toDataURL('image/webp', 0.92);
}
async function full(code, list) {
  c.width = 128; c.height = 168;
  x.clearRect(0, 0, c.width, c.height);
  x.drawImage(await img(code === 'back' ? SRC.back : list[code]), 0, 0, c.width, c.height);
  return c.toDataURL('image/webp', 0.88);
}
async function back2d() {
  c.width = 84; c.height = 118;
  x.clearRect(0, 0, c.width, c.height);
  x.drawImage(await img(SRC.back), 0, 0);
  return c.toDataURL('image/webp', 0.92);
}
async function make3d(uri) {
  c.width = 90; c.height = 130;
  x.fillStyle = '#f6f0dd';
  x.fillRect(0, 0, c.width, c.height);
  x.drawImage(await img(uri), 0, 0, c.width, c.height);
  return c.toDataURL('image/webp', 0.92);
}
async function build() {
  const skins = {};
  const ids = [];
  async function add(id, name, make) {
    const tiles = {};
    for (let code = 0; code < 34; code++) tiles[code] = await make(code);
    tiles.back = await back2d();
    skins[id] = { name, tiles };
    ids.push(id);
  }
  await add('stereo', '立体牌', (code) => compose(code, SRC.stereo));
  await add('calliWhite', '书法·白', (code) => compose(code, SRC.lay1));
  await add('calliRed', '书法·红', (code) => compose(code, SRC.lay3));
  await add('flatBlue', '简约·蓝', (code) => full(code, SRC.flatBlue));
  await add('flatCream', '简约·米', (code) => full(code, SRC.flatCream));
  await add('flatBrown', '简约·棕', (code) => full(code, SRC.flatBrown));
  const skins3d = {};
  const ids3d = [];
  for (const [id, name] of [['z1', '立体·白'], ['z2', '立体·绿']]) {
    const tiles = { back: await make3d(SRC.back3d[id]) };
    for (let code = 0; code < 34; code++) tiles[code] = await make3d(SRC.faces3d[id][code]);
    skins3d[id] = { name, tiles };
    ids3d.push(id);
  }
  return { skins, ids, skins3d, ids3d };
}
window.__build = build;
window.__ready = true;
</script>`;

const s = await launchChrome({ extraArgs: ['--allow-file-access-from-files'] });
try {
  await s.cdp.send('Page.enable');
  const pagePath = resolve(tmpdir(), 'mahjon-tile-art-build.html');
  writeFileSync(pagePath, page);
  await s.cdp.send('Page.navigate', { url: 'file://' + pagePath });
  for (let i = 0; i < 80; i++) {
    if (await s.cdp.eval('window.__ready === true').catch(() => false)) break;
    await sleep(100);
  }
  if (!(await s.cdp.eval('window.__ready === true'))) throw new Error('页面未就绪');
  const art = await s.cdp.eval('window.__build()');
  const banner = '/* 自动生成，勿手改；由 tools/build-tile-art.mjs 从 148麻将子拆分 / 010麻将图标 生成 */\n';
  writeFileSync(
    OUT_2D,
    `${banner}export const TILE_SKINS_2D = ${JSON.stringify(art.skins)};\nexport const TILE_SKIN_2D_IDS = ${JSON.stringify(art.ids)};\n`,
  );
  writeFileSync(
    OUT_3D,
    `${banner}export const TILE_SKINS_3D = ${JSON.stringify(art.skins3d)};\nexport const TILE_SKIN_3D_IDS = ${JSON.stringify(art.ids3d)};\n`,
  );
  console.log(`2D: ${OUT_2D} (${art.ids.length} 套)`);
  console.log(`3D: ${OUT_3D} (${art.ids3d.length} 套)`);
} finally {
  teardownChrome(s);
}
