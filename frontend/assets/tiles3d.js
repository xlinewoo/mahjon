/**
 * 3D 牌面贴图适配层 —— 复用 2D 已有的牌面位图（assets/tiles-img.js）
 *
 * 背景（比例对不上，绝不能拉伸）：
 *   · 2D 牌面位图 viewBox 210:255 ≈ 0.8235（`frontend/assets/tiles.js`，`tiles-img.js` 是它的 WebP 栅格化）；
 *   · 3D 牌面几何 TILE_W:TILE_H = 0.045:0.062 ≈ 0.7258（`render3d.js` / `mahjong-3d`）。
 *   直接铺满会把图案纵向压扁 ~12%。这里按「宽度铺满、垂直居中、上下留底色」处理，
 *   等比缩放、不拉伸（老吴 2026-10-19 定）。
 *
 * 与 mahjong-3d 程序化贴图（faceCanvas）的关系：那是零美术资源的兜底；本模块是
 * 正式贴图来源。键位与引擎严格对齐：0-8 万 / 9-17 筒 / 18-26 条 / 27-30 东南西北 /
 * 31-33 中发白；另提供 'back' 牌背。
 */
import * as THREE from '../../mahjong-3d/vendor/three.module.js';
import { tileSkin3dUrl, getTileSkin3dId } from '../tile-skin3d.js';

/** 贴图画布尺寸：与 3D 牌面同比例（256/352 ≈ 0.727），保证贴图坐标不二次变形 */
const TEX_W = 256;
const TEX_H = 352;
/** 留边底色：与程序化牌面底色一致（#f6f0dd），让上下留边融入牌面而非突兀白边 */
const MARGIN = '#f6f0dd';

const cache = new Map();

/** 建一张（或取缓存）CanvasTexture；draw 拿到 ctx 与 ready()（异步图加载完成后触发重传） */
function makeTexture(key, draw) {
  if (cache.has(key)) return cache.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = TEX_W;
  canvas.height = TEX_H;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  cache.set(key, tex);
  // jsdom / 极老环境没有 2d context：跳过绘制（贴图留空白），不抛错
  if (ctx) draw(ctx, () => { tex.needsUpdate = true; });
  return tex;
}

function drawFace(ctx, uri, ready, mark = '') {
  const img = new Image();
  img.onload = () => {
    if (!img.naturalWidth) return;
    ctx.fillStyle = MARGIN;
    ctx.fillRect(0, 0, TEX_W, TEX_H);
    ctx.drawImage(img, 0, 0, TEX_W, TEX_H);
    if (mark === 'wild') stampBadge(ctx, '#1f9d55', '赖');   // 癞子：绿底白字「赖」（老吴 2026-10-28 八轮）
    else if (mark === 'skin') stampBadge(ctx, '#d21f2b', '皮'); // 皮子：红底白字「皮」
    else if (mark === 'zhong') stampBadge(ctx, '#2f6fdb');     // 红中：蓝块无字（保持）
    ready();
  };
  img.src = uri;
}

/**
 * 特殊牌角标：牌面左上角的圆角块；可选文字（绿色「赖」/ 红色「皮」）。
 * 癞子绿底「赖」、皮子红底「皮」、红中蓝块无字（老吴 2026-10-28 八轮）。
 * 直接烙进贴图，手牌 / 副露 / 牌河 / 桌心亮牌统一生效。
 */
function stampBadge(ctx, color, text = '') {
  const s = 36, x = 8, y = 8, r = 9;
  ctx.save();
  ctx.fillStyle = color;
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(x, y, s, s, r);
    ctx.fill();
  } else {
    ctx.fillRect(x, y, s, s);
  }
  if (text) {
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 24px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + s / 2, y + s / 2 + 1);
  }
  ctx.restore();
}

/** 某张牌的正面贴图。code: 0..33（引擎编码），容错到牌背。
 *  mark: '' | 'wild' | 'skin'（左上角红/蓝色块，无文字），按标记分开缓存。 */
export function faceTexture(code, mark = '') {
  const skin = getTileSkin3dId();
  const uri = tileSkin3dUrl(code);
  return makeTexture('face:' + skin + ':' + code + (mark ? ':' + mark : ''), (ctx, ready) => drawFace(ctx, uri, ready, mark));
}

/** 牌背贴图 */
export function backTexture() {
  const skin = getTileSkin3dId();
  return makeTexture('back:' + skin, (ctx, ready) => drawFace(ctx, tileSkin3dUrl('back'), ready));
}

/** 牌侧/牌底贴图：素色木纹底（无对应素材，平涂一色） */
export function sideTexture() {
  return makeTexture('side', (ctx) => {
    ctx.fillStyle = '#d8c9a8';
    ctx.fillRect(0, 0, TEX_W, TEX_H);
  });
}

/** 清空贴图缓存（测试 / 热重载用；正常不调用） */
export function clearTextureCache() {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}

export { TEX_W, TEX_H, MARGIN };
