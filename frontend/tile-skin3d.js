/**
 * 3D 牌面皮肤选择。
 *
 * 与 2D 版分开，避免把 2D 的大图打进 net3d（反之亦然）。
 * 切换后由 render3d.reloadTextures() 清缓存并重建当前帧的贴图。
 */
import { TILE_SKINS_3D, TILE_SKIN_3D_IDS } from './assets/tiles-art3d.js';

const KEY = 'mahjon:tile-skin:3d';
const DEFAULT_ID = 'z1';

function read() {
  try {
    const id = localStorage.getItem(KEY);
    if (id && TILE_SKINS_3D[id]) return id;
  } catch { /* 隐私模式 / file:// 下可能不可用 */ }
  return DEFAULT_ID;
}

let currentId = read();

export function getTileSkin3dId() {
  return currentId;
}

export function getTileSkin3d() {
  return TILE_SKINS_3D[currentId] || TILE_SKINS_3D[DEFAULT_ID];
}

export function tileSkin3dUrl(code) {
  const tiles = getTileSkin3d().tiles;
  return tiles[code] || tiles.back;
}

export function setTileSkin3d(id) {
  if (!TILE_SKINS_3D[id]) return false;
  currentId = id;
  try { localStorage.setItem(KEY, id); } catch { /* 忽略持久化失败 */ }
  return true;
}

export function initTileSkin3dSelect(onChange) {
  const el = document.getElementById('tileskin');
  if (!el) return;
  el.innerHTML = '';
  for (const id of TILE_SKIN_3D_IDS) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = TILE_SKINS_3D[id].name;
    el.appendChild(opt);
  }
  el.value = currentId;
  el.addEventListener('change', () => {
    if (setTileSkin3d(el.value)) onChange?.(el.value);
  });
}
