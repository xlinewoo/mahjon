#!/usr/bin/env node
/**
 * 牌桌绿垫背景图：下载 CC 素材 → 转 WebP → 写进 CSS（老吴 2026-10-03「桌面改成图片模式」· 背景部分）
 *
 * 素材：OpenGameArt 的 `green_mat_texture_-_base_texture.png`
 *   https://opengameart.org/content/green-mat-texture
 *   作者 Vircon32，许可 **CC-BY 4.0**（可商用，但**必须署名** → 已写进 README 与产物页脚）。
 *   640×360，实测**无缝可平铺**（左右缘像素差 0.00，上下缘 9.22 vs 内部相邻差 6.61，同量级）。
 *
 * 为什么最后选「拉成大图」而不是「小图平铺」：
 *   320×180 平铺 base64 只要 3.9KB，但竖屏 390×860 会平铺 5~6 次 —— 绒布纹理重复感明显。
 *   1280×720 拉满铺（cover）零接缝，实测 q78 只 58.7KB（base64 78.7KB），
 *   换来的是「怎么都看不出是贴图」的干净桌面 —— 值。
 *
 * 为什么用 Chrome 转码而不是 Pillow / sharp：
 *   本机 cairosvg 缺 libcairo 装不上；而 `canvas.toDataURL('image/webp')` 是**浏览器原生**编码，
 *   零依赖。项目已有裸 CDP 基建（tools/lib/chrome.mjs）。
 *
 * 只改背景层，**不动任何布局 / 盒模型**（高度固定是硬红线，见 style.css 顶部注释）。
 *
 * 用法：
 *   node tools/fetch-felt.mjs              # 下载 + 转码 + 写 frontend/assets/felt.css
 *   FELT_QUALITY=84 node tools/fetch-felt.mjs
 *   FELT_SIZE=960x540 node tools/fetch-felt.mjs   # 想再省点体积
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, teardownChrome } from './lib/chrome.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CACHE = resolve(ROOT, '.cache/felt');
const OUT_CSS = resolve(ROOT, 'frontend/assets/felt.css');

const SRC_URL = 'https://opengameart.org/sites/default/files/green_mat_texture_-_base_texture.png';
const CREDIT = 'Green mat texture by Vircon32 (OpenGameArt), CC-BY 4.0';

const [OW, OH] = (process.env.FELT_SIZE || '1280x720').split('x').map(Number);
const QUALITY = Number(process.env.FELT_QUALITY || 78);

/* ---------------- ① 下载（缓存到 .cache，不重复拉） ---------------- */
try { mkdirSync(CACHE, { recursive: true }); } catch { /* 沙箱可能拒绝 mkdir；已在则无害 */ }
const srcPng = resolve(CACHE, 'green-mat.png');
if (!existsSync(srcPng)) {
  process.stdout.write(`下载 ${SRC_URL} … `);
  const r = await fetch(SRC_URL, { redirect: 'follow' });
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 1000) throw new Error(`下载内容异常（只有 ${buf.length} 字节，多半是错误页）`);
  writeFileSync(srcPng, buf);
  console.log(`${(buf.length / 1024).toFixed(1)} KB`);
} else {
  console.log(`复用缓存 ${srcPng.replace(ROOT + '/', '')}`);
}

/* ---------------- ② Chrome 缩放 + 原生 WebP 编码 → base64 ----------------
 * ⚠️ 源 PNG 必须做成 **data URI** 再喂给页内 Image，不能给 file:// 路径 ——
 *    页面本身是 `data:text/html`，那是**另一个源**，`img.decode()` 直接抛
 *    "The source image cannot be decoded"（跨源，连 file://→file:// 都不行）。 */
const PAGE = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#0d5137">felt</body>`;
const DRIVER = (dataUri, w, h, q) => `(async () => {
  const img = new Image();
  img.src = ${JSON.stringify(dataUri)};
  try { await img.decode(); } catch (e) { return 'ERR_DECODE ' + e.message; }
  const c = document.createElement('canvas');
  c.width = ${w}; c.height = ${h};
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, ${w}, ${h});
  const uri = c.toDataURL('image/webp', ${q});
  if (!uri.startsWith('data:image/webp')) return 'ERR_NO_WEBP ' + uri.slice(0, 40);
  return uri;
})()`;

const pngDataUri = `data:image/png;base64,${readFileSync(srcPng).toString('base64')}`;
console.log(`源图 ${(readFileSync(srcPng).length / 1024).toFixed(1)} KB → 以 data URI 传入页内`);

let session;
let dataUri;
try {
  session = await launchChrome();
  await session.cdp.send('Page.enable');
  await session.cdp.send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(PAGE) });
  const v = await session.cdp.eval(DRIVER(pngDataUri, OW, OH, QUALITY));
  if (typeof v !== 'string' || !v.startsWith('data:image/webp')) throw new Error(`转码失败：${v}`);
  dataUri = v;
} finally {
  teardownChrome(session);
}

const bytes = Math.round((dataUri.length - 'data:image/webp;base64,'.length) * 0.75);
console.log(`转码 ${OW}×${OH} WebP q${QUALITY} → ${(bytes / 1024).toFixed(1)} KB（内联后 ${(bytes * 1.34 / 1024).toFixed(1)} KB）`);

/* ---------------- ③ 写成一份可被 style.css @import 的 CSS ---------------- */
writeFileSync(OUT_CSS, `/* 自动生成，勿手改 —— 由 tools/fetch-felt.mjs 生成。
 * 素材：${CREDIT}
 * ${SRC_URL}
 * 说明：本文件只提供 --felt-bg（一个 data URI）+ 背景铺法，
 *      由 frontend/style.css 的 body {} 通过 var() 引用（见「台呢」那段）。
 *      想换质感：改 FELT_SIZE / FELT_QUALITY 重跑脚本即可。 */
:root {
  --felt-bg: url("${dataUri}");
}
`);

console.log(`已写入 ${OUT_CSS.replace(ROOT + '/', '')}`);
console.log(`署名（CC-BY 4.0 义务，已同时写进 README）：${CREDIT}`);
