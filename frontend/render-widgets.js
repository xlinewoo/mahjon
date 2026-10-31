/**
 * 前端渲染层的**无状态**小组件 —— 从 `render.js` 拆出的第一批「纯搬运」。
 *
 * 这批函数的共同点：**不读也不写 render.js 的模块状态**（game / view / mySeat …
 * 一概不碰），输入全靠参数、输出一个 DOM 节点或字符串。因此可以安全外提：
 * 行为与拆分前逐字节一致，`tools/verify-ui.mjs` 仍应绿。
 *
 * ⚠️ 有状态的渲染（renderHand / renderSettle / renderWinds …）**仍留在 render.js**，
 *    它们读 `game` / `view` / `mySeat` 等闭包变量，搬出去得先引入共享 state 模块。
 *    本文件只放「不碰状态」的部分；后续若继续拆，按同一判据（是否读模块状态）切分。
 *
 * 牌面统一入口仍是 `makeTileEl(tile, v, opts)`（opts: small|river|tiny|dir|last|match|
 * onClick|onDblClick）。新增尺寸要在 style.css 补 `.tile.<name> .tile-face { height }`。
 */
import { tileName, isHonorTile, RED_DRAGON } from '../src/engine/tiles.js';
import { sortMeldsForDisplay } from '../src/engine/melds.js';
import { HIDDEN_TILE } from '../src/engine/game.js';
import { tileSkinUrl } from './tile-skin.js';

/* ------------------------------------------------------------------ */
/* 牌面                                                                */
/* ------------------------------------------------------------------ */

export function makeTileEl(tile, v, opts = {}) {
  const el = document.createElement('span');
  let cls = 'tile';
  if (opts.small) cls += ' small';
  if (opts.river) cls += ' river';
  if (opts.tiny) cls += ' tiny';
  const isWild = v.wildTile !== null && v.wildTile !== undefined && tile === v.wildTile;
  // 红中不需要角标（老吴 2026-10-28 13:39 明确）；即便在皮子集合里也不加红「皮」角标。
  const isSkin = !isWild && tile !== RED_DRAGON && !!(v.skinTiles && v.skinTiles.includes(tile));
  if (isWild) cls += ' wild';
  if (isSkin) cls += ' skin';
  if (isHonorTile(tile)) cls += ' honor';
  if (opts.last) cls += ' last';
  if (opts.match) cls += ' river-match';
  el.className = cls;
  el.dataset.tile = String(tile);

  const img = document.createElement('img');
  img.className = 'tile-face';
  img.src = tileSkinUrl(tile);
  img.alt = tileName(tile);
  img.draggable = false;
  el.appendChild(img);

  // 癞子 / 皮子角标（老吴 2026-10-28：癞子绿、皮子红；2D 块小不写字，颜色即信号；
  // 红中不需要角标，故此处不输出。3D 牌面另加「赖/皮」文字）。
  if (isWild) {
    el.appendChild(badge('', 'wild'));
  } else if (isSkin) {
    el.appendChild(badge('', 'skin'));
  }

  // 牌河里标「这是哪家打出来的」
  if (opts.dir) el.appendChild(dirDot(opts.dir));

  if (opts.onClick) el.addEventListener('click', () => opts.onClick(tile));
  if (opts.onDblClick) el.addEventListener('dblclick', () => opts.onDblClick(tile));
  return el;
}

/** 牌背（对手暗牌用：只展示张数、不露牌面，老吴 2026-10-01） */
export function makeTileBack() {
  const el = document.createElement('span');
  el.className = 'tile back';
  const img = document.createElement('img');
  img.className = 'tile-face';
  img.src = tileSkinUrl('back');
  img.alt = '牌背';
  img.draggable = false;
  el.appendChild(img);
  return el;
}

/** 角标（纯色块，无文字）：癞子绿、皮子红、红中蓝（老吴 2026-10-28 八轮） */
export function badge(text, kind) {
  const i = document.createElement('i');
  i.className = 'badge' + (kind ? ' ' + kind : '');
  i.textContent = text;
  return i;
}

/** 牌河里的方位小字（东南西北） */
export function dirDot(dir) {
  const i = document.createElement('i');
  i.className = 'dir-dot dir-' + dir;
  i.textContent = dir;
  return i;
}

/* ------------------------------------------------------------------ */
/* 头像                                                                */
/* ------------------------------------------------------------------ */
/**
 * 头像：**本地按名字首字生成**，不引外部图片、不造假数据。
 *   · 单机版：没有账号体系，头像字就是「你 /东 / 南 / 西 / 北」（引擎里 players[].name）。
 *   · 网络版：players[].name 就是**真昵称**（服务端 room.js 用 seats[].username 建局），
 *     所以头像是真实昵称首字 —— 与参考图的圆形头像一致，且零新增字段、零协议改动。
 * ⚠️ 后端虽有 avatar_type/avatar_value + server/avatars.js，但 viewFor 不下发它，
 *    要真上传头像得改协议 + 每帧带图，代价远大于收益；老吴也没要求，先不做。
 */
export function avatarEl(name, avatar) {
  const s = String(name == null ? '' : name).trim();
  const ch = s ? Array.from(s)[0] : '?';
  const a = document.createElement('span');
  /* 预设头像库（老吴 2026-10-24）：preset = emoji、upload = 上传文件；
     没有头像时退回「按名字首字生成」的老行为（单机 / 旧数据兜底）。 */
  if (avatar && avatar.type === 'preset' && avatar.value) {
    // 预设头像库（老吴 2026-10-25）：icon/ 图片规范化为 WebP，按 id 经服务端路由取图
    a.className = 'avatar avatar-img';
    const img = document.createElement('img');
    img.src = '/api/avatars/preset/' + encodeURIComponent(String(avatar.value)) + '.webp';
    img.alt = s || '头像';
    img.draggable = false;
    a.appendChild(img);
    a.title = s || '玩家';
    return a;
  }
  if (avatar && avatar.type === 'upload' && avatar.value) {
    a.className = 'avatar avatar-img';
    const img = document.createElement('img');
    img.src = '/api/avatars/file/' + encodeURIComponent(String(avatar.value));
    img.alt = s || '头像';
    img.draggable = false;
    a.appendChild(img);
    a.title = s || '玩家';
    return a;
  }
  /* 配色按名字散列到 5 档中性色（同一名字永远同色）。
     ⚠️刻意不给方位色 —— 旁边已有 .dir-badge 表达东南西北，
     再用一套方位色就成了「红东 + 蓝东」两个圆牌并排（截图里确实这样），看着像重复信息。
     自己是第 0 档（癞子金），一眼能认出哪个是自己。 */
  let h = 0;
  for (const c of s) h = (h * 31 + c.codePointAt(0)) >>> 0;
  a.className = 'avatar av-' + (s === '你' ? 0 : h % 4);
  a.textContent = ch;
  a.title = s || '玩家';
  return a;
}

/* ------------------------------------------------------------------ */
/* 副露                                                                */
/* ------------------------------------------------------------------ */

export const MELD_LABELS = {
  chi: '吃',
  peng: '碰',
  zhi: '杠',
  xu: '杠',
  an: '暗',
  red: '红中',
  skin: '皮',
  wild: '赖',
};

export function renderMelds(container, melds, v, size) {
  container.innerHTML = '';
  if (!melds || melds.length === 0) return;
  // 暗杠显示（老吴 2026-10-24）：对局中**自己的暗杠首张正面、其余三张背面**；
  // 别家暗杠 view 里是掩码（HIDDEN_TILE）→ 四张全背面。摊牌/结算（settled）
  // 时 view 下发真实牌面，全部亮出。
  // 回放（v.replay，老吴 2026-10-24）：**恒定一正三背** —— 即使摊牌/结算也不翻面。
  const settled = !!(v && v.phase === 'settled');
  const replay = !!(v && v.replay);
  for (const m of sortMeldsForDisplay(melds)) {
    const group = document.createElement('span');
    group.className = 'meld';
    const label = document.createElement('span');
    label.className = 'meld-label';
    label.textContent = MELD_LABELS[m.type] || '';
    group.appendChild(label);
    m.tiles.forEach((t, i) => {
      let showFace = true;
      if (t === HIDDEN_TILE) showFace = false;
      else if (m.type === 'an' && replay) showFace = i === 0;
      else if (m.type === 'an') showFace = settled ? true : i === 0;
      group.appendChild(showFace ? makeTileEl(t, v, { [size || 'small']: true }) : makeTileBack());
    });
    container.appendChild(group);
  }
}

/* ------------------------------------------------------------------ */
/* 手牌特殊牌杠（红中 / 皮子 / 癞子）                                   */
/* ------------------------------------------------------------------ */

/** 三种「特殊牌」的杠，老吴 2026-09-30：双击这类牌 = 杠 */
export const SPECIAL_GANG_LABEL = { redgang: '红中杠', skingang: '皮子杠', wildgang: '癞子杠' };

/** 手里这张特殊牌有没有对应的杠动作 */
export function specialGangFor(tile, legal) {
  return legal.find((a) => SPECIAL_GANG_LABEL[a.type] && a.tile === tile) || null;
}

/* ------------------------------------------------------------------ */
/* 通用小工具                                                          */
/* ------------------------------------------------------------------ */

/* esc 已下沉到 ui-utils.js（单机 / 网络共用同一份，null-safe）。 */

export function tagEl(text, cls) {
  const s = document.createElement('span');
  s.className = 'st-flag ' + (cls || '');
  s.textContent = text;
  return s;
}

/** 表格小工具（统计弹窗与结算明细共用） */
export function thEl(text) { const e = document.createElement('th'); e.textContent = text; return e; }
export function tdEl(text) { const e = document.createElement('td'); e.textContent = text; return e; }
