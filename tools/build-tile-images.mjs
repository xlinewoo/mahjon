#!/usr/bin/env node
/**
 * 牌面 SVG → WebP 位图（老吴 2026-10-03「桌面改成图片模式」· 牌面部分）
 *
 * 为什么不换素材库（踩过一遍的教训，别再走回头路）：
 *   先试了 CC0 的 `FluffyStuff/riichi-mahjong-tiles`：合成好、35 张齐、只有 298KB，
 *   但它是**日式 riichi 牌**——图案天生只占牌面上半部分（实测 Man1 非空区 (74,98,523,756)、
 *   Sou1 (7,14,591,792)，都在上半/中部），而本项目牌面最大只渲染 **50px 高**
 *   ⇒ 图案只剩 20 来 px，点数根本看不清。换成 `samoheen/mahjong-tiles` 同样构图问题。
 *   ⇒ **保留现有 `tiles.js` 的牌面设计**（清晰度已验证、34 种齐、key 与引擎严格对齐），
 *     只把**渲染介质**从矢量换成位图。构图与配色一律不动 ⇒ 视觉零回归。
 *
 * 怎么做的（零新依赖）：
 *   headless Chrome 里把 SVG 当 `<img>` 画进 canvas：
 *     ① 先画到 3 倍大的离屏 canvas（超采样，让 Chrome 用 SVG 矢量渲染器出高质量边缘）；
 *     ② 再高质量缩到目标尺寸的正式 canvas；
 *     ③ `canvas.toDataURL('image/webp', q)` —— **浏览器原生 WebP 编码**，
 *        不需要 cairosvg / Pillow / sharp（cairosvg 在本机缺 libcairo，装不了）。
 *   ——CDP 客户端沿用 tools/viewport-check.mjs 的裸连接思路。
 *
 * 输出：`frontend/assets/tiles-img.js` —— 与 `tiles.js` **同构**（导出 `TILE_SVGS`，
 *   键 "0".."33" + "back"，值为 `data:image/webp;base64,...`），
 *   所以 `frontend/render.js` 只需改一行 import，别的什么都不用动。
 *
 * 尺寸依据（已核实）：`frontend/style.css` 里 `.tile-face` 的 height 是**固定值**
 *   （50 / 30 / 26 / 22 / 18px），全文件**没有**任何 `transform: scale` / `zoom`，
 *   所以牌面最大实际渲染 41px 宽（50 × 0.8235），2x 高分屏也只要 82px
 *   ⇒ TILE_W=128 有 1.5 倍余量，够用。
 *
 * 保持不变（红线，勿动）：
 *   · 源 SVG 的 viewBox 比例是 210:255 = **0.82353**（不是 3:4！），按它算高度，绝不拉伸；
 *   · `.tile-face` 的固定高度与 box-shadow 厚度逻辑照旧 —— 立体感仍由 CSS 负责，
 *     位图只提供牌面本身。
 *
 * 用法：
 *   node tools/build-tile-images.mjs                # 默认 128px 宽 / q82 / 3x 超采样
 *   TILE_W=96 node tools/build-tile-images.mjs      # 更省体积（约 -45%，清晰度仍够 2x 屏）
 *   TILE_W=160 TILE_QUALITY=90 node tools/build-tile-images.mjs   # 更清晰
 */
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, launchChrome, teardownChrome } from './lib/chrome.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../frontend/assets/tiles.js');
const OUT = resolve(HERE, '../frontend/assets/tiles-img.js');

/** 输出单张宽度（px）。牌面最大渲染 41px 宽，2x 屏 = 82px，128 留足余量。 */
const TILE_W = Number(process.env.TILE_W || 128);
/** WebP 质量。牌面是大白底 + 粗笔画，压缩率极高，82 几乎看不出损失。 */
const QUALITY = Number(process.env.TILE_QUALITY || 82);
/** 超采样倍率：SVG 是矢量，先按 SCALE 倍画再缩到 TILE_W，边缘更干净。 */
const SCALE = Number(process.env.TILE_SCALE || 3);

/** 源 SVG 的 viewBox 比例（210:255）。全部 35 张实测一致，硬编码前有 assert 兜底。 */
const VB_RATIO = 210 / 255;

if (!findChrome()) {
  console.error('❌ 找不到 Chrome/Chromium，设 CHROME_PATH 指向可执行文件');
  process.exit(2);
}

/* ---------------- 取源 SVG ---------------- */
const { TILE_SVGS } = await import(`file://${SRC}?t=${Date.now()}`);
const keys = Object.keys(TILE_SVGS);
if (!keys.length) { console.error('❌ tiles.js 里没有 TILE_SVGS'); process.exit(1); }

/** `data:image/svg+xml;base64,xxx` → 裸 SVG 文本 */
function svgText(dataUri) {
  const m = /^data:image\/svg\+xml;base64,(.*)$/s.exec(dataUri);
  if (!m) return dataUri;
  return Buffer.from(m[1], 'base64').toString('utf8');
}

// 兜底断言：比例变了就报错，绝不静默拉伸
for (const k of keys) {
  const vb = /viewBox="([^"]+)"/.exec(svgText(TILE_SVGS[k]));
  const w = Number(vb[1].split(/\s+/)[2]);
  const h = Number(vb[1].split(/\s+/)[3]);
  if (Math.abs(w / h - VB_RATIO) > 1e-3) {
    console.error(`❌ ${k} 的 viewBox 比例是 ${(w / h).toFixed(4)}，与硬编码的 ${VB_RATIO.toFixed(4)} 不符`);
    console.error('   ⇒ 请同步改脚本里的 VB_RATIO，否则牌面会被拉伸变形');
    process.exit(1);
  }
}

const W = TILE_W;
const H = Math.round(TILE_W / VB_RATIO);
console.log(`牌面 ${keys.length} 张（${keys.filter((k) => k !== 'back').length} 种 + 牌背）`);
console.log(`输出 ${W}×${H}（比例 ${VB_RATIO.toFixed(4)}）· WebP q${QUALITY} · ${SCALE}x 超采样\n`);

/**
 * 页内脚本：SVG 文本 → WebP data URI
 * 在页面里做「3 倍超采样画布 → 高质量缩放 → 原生 WebP 编码」，全程不出浏览器。
 */
const DRIVER = `(async () => {
  const [svgText, w, h, scale, q] = ${JSON.stringify(['__SVG__', W, H, SCALE, QUALITY])};
  const url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgText)));
  const img = new Image();
  img.src = url;
  try { await img.decode(); } catch (e) { return 'ERR_DECODE ' + e.message; }
  if (!img.naturalWidth) return 'ERR_EMPTY';

  const big = document.createElement('canvas');
  big.width = w * scale; big.height = h * scale;
  const bx = big.getContext('2d');
  bx.imageSmoothingEnabled = true; bx.imageSmoothingQuality = 'high';
  bx.drawImage(img, 0, 0, big.width, big.height);

  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ox = out.getContext('2d');
  ox.imageSmoothingEnabled = true; ox.imageSmoothingQuality = 'high';
  ox.drawImage(big, 0, 0, w, h);

  const uri = out.toDataURL('image/webp', q);
  if (!uri.startsWith('data:image/webp')) return 'ERR_NO_WEBP ' + uri.slice(0, 40);
  // 量一下非透明像素占比，抓「图案被压到角落」这类合成事故
  const d = ox.getImageData(0, 0, w, h).data;
  let opaque = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 16) opaque++;
  return JSON.stringify({ uri, fill: +(opaque / (w * h)).toFixed(4) });
})()`;

const PAGE_HTML = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#2a7}</style><body>rasterizer</body>`;

let session;
const out = {};
try {
  session = await launchChrome();
  await session.cdp.send('Page.enable');
  await session.cdp.send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(PAGE_HTML) });

  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const expr = DRIVER.replace('"__SVG__"', JSON.stringify(svgText(TILE_SVGS[k])));
    const v = await session.cdp.eval(expr);   // eval() 负责把页内错误带出来
    if (typeof v !== 'string' || !v.startsWith('{')) throw new Error(`${k} 栅格化失败：${v}`);
    const { uri, fill } = JSON.parse(v);
    out[k] = uri;
    process.stdout.write(`  ${String(i + 1).padStart(2)}/${keys.length} ${k.padEnd(4)} ${String(Math.round((uri.length - 23) * 0.75)).padStart(6)}B  填充 ${(fill * 100).toFixed(1)}%\r`);
  }
} finally {
  teardownChrome(session);
}

const total = Object.values(out).reduce((s, u) => s + Math.round((u.length - 23) * 0.75), 0);
console.log(`\n  35 张原始合计 ${(total / 1024).toFixed(1)} KB`);

const banner = `/* 自动生成，勿手改 —— 由 tools/build-tile-images.mjs 从 tiles.js 栅格化而来。
 * 键与引擎 src/engine/tiles.js 的 tile 编号严格一一对应：0-8 万 / 9-17 筒 / 18-26 条 /
 * 27-30 东南西北 / 31-33 中发白 / back 牌背。
 * 源 SVG 的 viewBox 比例 210:255，输出 ${W}×${H} WebP（q${QUALITY}）。
 * 导出与 assets/tiles.js **完全同构**（含 tileSvg()），所以 render.js 只需改 import 路径。 */
`;
writeFileSync(OUT, `${banner}export const TILE_SVGS = {\n${
  Object.entries(out).map(([k, v]) => `  ${k === 'back' ? 'back' : JSON.stringify(k)}: ${JSON.stringify(v)},`).join('\n')
}\n};\n\n// 取某张牌的 data-URI（code 0..33，或 'back'）\nexport function tileSvg(code) {\n  return TILE_SVGS[code] || TILE_SVGS.back;\n}\n`);

console.log(`  base64 内联后 ${(total / 1024 * 1.34).toFixed(1)} KB → ${OUT.replace(process.cwd() + '/', '')}`);
console.log(`  下一步：改 frontend/render.js 的 import（tiles.js → tiles-img.js）`);
