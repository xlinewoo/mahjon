#!/usr/bin/env node
/**
 * 牌面映射对照表（视觉审计）—— 把「生成产物里每套皮肤的全部 34 张牌 + 牌背」
 * 按引擎编码顺序排成网格截图，供人工目视核对「牌面 ↔ 实际牌」映射。
 *
 * 背景（2026-10-23）：用户素材的编号体系是猜的（build-tile-art.mjs 的 CARDNUM / Z1），
 * 曾实机出现「北风显示成红中」「三条其实是二条」。这张表就是验收工具：
 *   node tools/verify-tile-map.mjs            # 截图到 .cache/tile-map-sheet.png
 *   open .cache/tile-map-sheet.png
 * 表里每格上方是引擎编码对应的**牌名**（应为什ㅅ么牌），下面是实际显示的图。
 * 名字与图案不一致 ⇒ 映射错了 ⇒ 修 build-tile-art.mjs 的素材编号表并重新生成。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchChrome, teardownChrome, sleep } from './lib/chrome.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, '.cache/tile-map-sheet.png');

const ROOT_URL = pathToFileURL(resolve(ROOT, 'frontend/assets')).href + '/';
const art2d = await import(ROOT_URL + 'tiles-art2d.js');
const art3d = await import(ROOT_URL + 'tiles-art3d.js');

/* 与 src/engine/tiles.js 一致的编码 → 名字（本地复制，避免连带引擎 import） */
const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const SUIT = { wan: '万', tong: '筒', tiao: '条' };
const HONOR = ['东风', '南风', '西风', '北风', '红中', '发财', '白板'];
const nameOf = (code) => (code >= 27 ? HONOR[code - 27] : CN[code % 9] + SUIT[code < 9 ? 'wan' : code < 18 ? 'tong' : 'tiao']);

const cell = (uri, label, w) =>
  `<div class="cell"><img src="${uri}" style="width:${w}px"><span>${label}</span></div>`;

function row(skinName, tiles, ids, w) {
  const head = `<tr><td class="skin" rowspan="${Math.ceil(ids.length / 17)}">${skinName}</td>`;
  let html = '';
  for (let r = 0; r * 17 < ids.length; r++) {
    const slice = ids.slice(r * 17, r * 17 + 17);
    html += (r === 0 ? head : '<tr>') + '<td class="row">'
      + slice.map((id) => cell(tiles[id], id === 'back' ? '牌背' : `${id} ${nameOf(Number(id))}`, w)).join('')
      + '</td></tr>';
  }
  return html;
}

const allCodes = [...Array(34).keys()];
const html = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 8px; font: 12px/1.2 Menlo, monospace; background: #fff; }
  table { border-collapse: collapse; }
  td { padding: 4px 6px; vertical-align: top; }
  .skin { font-weight: 700; writing-mode: vertical-rl; text-orientation: upright; background: #eee; }
  .row { display: flex; gap: 4px; }
  .cell { display: flex; flex-direction: column; align-items: center; gap: 2px; }
  .cell img { display: block; height: auto; border: 1px solid #ccc; }
  .cell span { font-size: 11px; color: #333; white-space: nowrap; }
  h2 { margin: 6px 0; font-size: 14px; }
</style>
<h2>2D 皮肤（tiles-art2d.js，引擎编码 0-33 顺序：万1-9 筒1-9 条1-9 东南西北中发白）</h2>
<table>${art2d.TILE_SKIN_2D_IDS.map((id) => row(art2d.TILE_SKINS_2D[id].name, art2d.TILE_SKINS_2D[id].tiles, [...allCodes, 'back'], 56)).join('')}</table>
<h2>3D 皮肤（tiles-art3d.js）</h2>
<table>${art3d.TILE_SKIN_3D_IDS.map((id) => row(art3d.TILE_SKINS_3D[id].name + '（' + id + '）', art3d.TILE_SKINS_3D[id].tiles, [...allCodes, 'back'], 56)).join('')}</table>
<div id="done">READY</div>`;

const pagePath = resolve(tmpdir(), 'mahjon-tile-map-sheet.html');
writeFileSync(pagePath, html);
mkdirSync(resolve(ROOT, '.cache'), { recursive: true });

const s = await launchChrome();
try {
  await s.cdp.send('Page.enable');
  await s.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await s.cdp.send('Page.navigate', { url: 'file://' + pagePath });
  for (let i = 0; i < 100; i++) {
    if (await s.cdp.eval('document.getElementById("done")?.textContent === "READY"').catch(() => false)) break;
    await sleep(100);
  }
  await sleep(300);
  const shot = await s.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('对照表已生成：' + OUT);
} finally {
  teardownChrome(s);
}
