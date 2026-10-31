/**
 * 2D 牌面皮肤选择。
 *
 * 资源由 tools/build-tile-art.mjs 从素材目录生成到 assets/tiles-art2d.js；
 * 本模块只管「当前选哪套 + 记住选择」，不碰渲染状态。
 * 3D 版如果也要多皮肤，另建同名模块，避免把 2D 的大图打进 net3d。
 */
import { TILE_SKINS_2D, TILE_SKIN_2D_IDS } from './assets/tiles-art2d.js';

const KEY = 'mahjon:tile-skin:2d';
const DEFAULT_ID = 'stereo';

function read() {
  try {
    const id = localStorage.getItem(KEY);
    if (id && TILE_SKINS_2D[id]) return id;
  } catch { /* 隐私模式 / file:// 下可能不可用 */ }
  return DEFAULT_ID;
}

let currentId = read();

export function getTileSkinId() {
  return currentId;
}

export function getTileSkin() {
  return TILE_SKINS_2D[currentId] || TILE_SKINS_2D[DEFAULT_ID];
}

export function tileSkinUrl(code) {
  const tiles = getTileSkin().tiles;
  return tiles[code] || tiles.back;
}

export function setTileSkin(id) {
  if (!TILE_SKINS_2D[id]) return false;
  currentId = id;
  try { localStorage.setItem(KEY, id); } catch { /* 忽略持久化失败 */ }
  return true;
}

/** 填充顶栏下拉框；onChange 只在用户真正切换时调用（初始化不触发重绘）。 */
export function initTileSkinSelect(onChange) {
  const el = document.getElementById('tileskin');
  if (!el) return;
  el.innerHTML = '';
  for (const id of TILE_SKIN_2D_IDS) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = TILE_SKINS_2D[id].name;
    el.appendChild(opt);
  }
  el.value = currentId;
  el.addEventListener('change', () => {
    if (setTileSkin(el.value)) onChange?.(el.value);
  });
}
