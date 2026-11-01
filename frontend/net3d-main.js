/**
 * 网络版入口（**3D**）—— 大厅与牌桌逻辑全部在 ./net-lobby.js（与 2D 版共用）。
 *
 * 本文件只做 3D 呈现的接线（老吴 2026-10-19 定，2026-10-24 抽出共享核心后本文件
 * 从 ~1330 行缩到这里）：牌桌区用 render3d 的 3D 画布（#table3d）呈现，
 * 2D 牌桌（#table）由 net3d.css 隐藏但仍保留给 render.js 取节点；操作条挪到画布上。
 */
import { bootNetLobby, S } from './net-lobby.js';
import { addAfterRender, getView, set2dTableVisible } from './render.js';
import { state } from './render-state.js';
import { flash } from './ui-utils.js';
import { createRender3d, tileName } from './render3d.js';
import { initTileSkin3dSelect, tileSkin3dUrl } from './tile-skin3d.js';

/* ------------------------------------------------------------------ */
/* 3D 牌桌（本页专属）                                                  */
/*                                                                     */
/* 做法：大厅/房间/按钮/结算/听牌等全部沿用 2D 那套（render.js 仍照常   */
/* 渲染，只是 #table 被 CSS 隐藏），真正露出来的是 render3d 的 3D 画布。 */
/* 这样既满足「3D 由 view 驱动」，又不丢现有的操作条、结算、战绩等 UI。 */
/* ------------------------------------------------------------------ */
let render3d = null;

/* render.js 每次 renderAll 收尾都调 relocateHud：doAction 的 finally 也会重绘一次，
没有这个钩子时操作条会被 renderMySeat 塞回隐藏的 2D 座位，3D 里就"消失"了。 */
addAfterRender(() => relocateHud());

// 视口尺寸变化：render3d 内部 onResize→applySize→updateReplayLabels 重投影标签，
// HUD 钉位随之刷新（下一帧执行，保证读到新 transform；老吴 2026-10-28 十轮）。
globalThis.addEventListener('resize', () => requestAnimationFrame(pinFloaters));

addAfterRender(() => {
  if (typeof document === 'undefined' || !document.body.classList.contains('replay-mode')) return;
  const v = getView();
  if (!v || !v.me) return;
  const r3 = ensure3d();
  if (!r3) return;
  r3.render(v, { MY_SEAT: v.me.seat });
  r3.applySize();
  updateWildBadge(v); // 回放也亮癞子徽标（位置在牌桌左侧）
  updateCenterHud(v); // 回放也亮中央指示器/下方信息条
});

/** 懒创建 3D 渲染器并挂到 #table3d（幂等） */
function ensure3d() {
  if (render3d) return render3d;
  const host = document.getElementById('table3d');
  if (!host) return null;
  render3d = createRender3d({
    onAction: async (action) => {
      if (!S.driver) throw new Error('还没进入牌桌');
      await S.driver.act(action);
    },
    onMessage: (msg) => flash(msg),
  });
  render3d.mount(host);
  return render3d;
}

/**
 * 标签卡的**本地坐标**矩形（rotation-proof，老吴 2026-10-28 十轮）：
 * 手机竖屏下 body 被 CSS rotate(90deg)，getBoundingClientRect() 返回**视觉视口**坐标，
 * 而 style.top/left 作用在**未旋转的本地坐标系**里 —— 两者混用会把 HUD 钉出屏外。
 * 这就是「战绩/托管按钮消失、不补牌开关不显示」在手机上必现、桌面上正常不了的根因
 * （桌面无旋转只是碰巧对上）。updateReplayLabels 写入的 transform translate(x,y) 就是
 * 本地坐标，直接解析它 + offsetWidth/Height，全程同一坐标系。
 */
function labelLocal(key) {
  const el = document.querySelector(`#table3d .r3d-seat-label[data-seat-key="${key}"]`);
  if (!el || el.hidden) return null;
  const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el.style.transform || '');
  if (!m) return null;
  return { x: +m[1], y: +m[2], w: el.offsetWidth || 64, h: el.offsetHeight || 66 };
}

/** 常显「不补牌」开关（老吴 2026-10-28 十轮）：原来只在有特殊杠可选时才出现（render.js
 *  条件构建、文案「杠不摸牌」），现在 3D 桌面要**常显**、文案「不补牌」、钉在
 *  上家W/本家S 头像卡中间。直接读写 state.gangNoDraw（与 2D 开关同源，动作侧
 *  withGangNoDraw 照常生效）；非本家出牌回合 render.js 会复位 false，这里每帧同步勾选态。 */
function ensureNodrawToggle() {
  let el = document.getElementById('nodraw-toggle');
  if (el) return el;
  el = document.createElement('label');
  el.className = 'gang-nodraw';   // 复用 #table3d > .gang-nodraw 固定槽样式
  el.id = 'nodraw-toggle';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.addEventListener('change', () => { state.gangNoDraw = cb.checked; });
  const text = document.createElement('span');
  text.textContent = '不补牌';
  el.append(cb, text);
  return el;
}

/** 按标签本地坐标钉 HUD：① 不补牌开关（W/S 卡之间）② 菜单（E 卡正上方）③ 托管条（E 卡正下方） */
function pinFloaters() {
  const canvasBox = document.getElementById('table3d');
  if (!canvasBox) return;
  const bw = canvasBox.clientWidth || 0;
  const bh = canvasBox.clientHeight || 0;
  // ① 不补牌开关：左列 W 卡下缘与 S 卡上缘之间；无对局/回放时藏起
  const wL = labelLocal('W');
  const sL = labelLocal('S');
  const tg = ensureNodrawToggle();
  const cb = tg.querySelector('input');
  if (cb) cb.checked = !!state.gangNoDraw;
  const inGame = !!(wL && sL && bw && bh) && !state.replay;
  tg.hidden = !inGame;
  if (inGame) {
    if (tg.parentNode !== canvasBox) canvasBox.appendChild(tg);
    const tw = tg.offsetWidth || 84;
    const th = tg.offsetHeight || 26;
    const top = (wL.y + wL.h + sL.y) / 2 - th / 2;
    // 右缘与 W 卡右缘对齐（开关比卡宽 → 向左伸出），避开 W 手牌列
    tg.style.left = Math.max(2, wL.x + wL.w - tw) + 'px';
    tg.style.top = Math.max(2, Math.min(top, bh - th - 2)) + 'px';
  }
  // ② 菜单（⋯）：E 头像卡正上方（菜单展开向下长出，盖卡/牌属瞬态浮层，可接受）
  const menuBox = document.querySelector('#play .topbar-btns');
  if (menuBox) {
    const eL = labelLocal('E');
    if (eL) {
      menuBox.style.top = Math.max(4, eL.y - 36) + 'px';
      menuBox.style.left = Math.max(4, Math.min(eL.x + eL.w / 2 - 17, bw - 38)) + 'px';
    } else {
      menuBox.style.top = Math.max(4, Math.round(bh / 2 - 36)) + 'px';
      menuBox.style.left = Math.max(4, bw - 40) + 'px';
    }
  }
  // ③ 托管条：E 头像卡正下方（老吴 2026-10-30 十七轮「我要尿尿的按钮往下移动一点，
  //    现在和头像有点互相干扰」）—— 与卡片拉开 26px，并**右缘对齐卡片右缘**：
  //    旧版钉左缘，条宽 88 > 卡宽 64，左边 24px 伸到卡外、压在下家手牌列上（实测 1186~1209 重叠）。
  //    现在宽度收成卡宽（见 net3d.css），只占卡片那一列。
  const host = document.getElementById('host-controls');
  if (host && !host.hidden) {
    host.style.position = 'absolute';
    const eL = labelLocal('E');
    if (eL) {
      const hw = host.offsetWidth || 0;
      const top = eL.y + eL.h + 26;
      host.style.top = Math.max(4, Math.min(top, bh - host.offsetHeight - 4)) + 'px';
      host.style.left = Math.max(4, Math.min(eL.x + eL.w - hw, bw - hw - 6)) + 'px';
      host.style.right = 'auto';
      host.style.zIndex = '6';
    } else {
      host.style.top = Math.max(4, Math.round(bh / 2 - host.offsetHeight / 2)) + 'px';
      host.style.left = '';
      host.style.right = '6px';
    }
  }
}

/**
 * 把 render.js 塞进 2D 座位里的「操作条 / 自动过倒计时」挪到 3D 画布上。
 *   • `#controls` 挪进 `#table3d`，绝对定位于**自家手牌正上方**（吃/碰/杠/胡/过；老吴 2026-10-19）；
 *   • `#auto-pass-tip` 也留在画布内浮动（纯信息提示，CSS 给了 pointer-events:none）。
 * render.js 每帧 renderAll 都会把它们塞回 `#seat-bottom`，所以这里每帧都要挪。
 * 位置由 render3d 写进容器的 CSS 变量 --hand-top（见 net3d.css）动态贴合手牌。
 */
function relocateHud() {
  const canvasBox = document.getElementById('table3d');
  const controls = document.getElementById('controls');
  if (canvasBox && controls && controls.parentNode !== canvasBox) canvasBox.appendChild(controls);
  const tip = document.getElementById('auto-pass-tip');
  if (canvasBox && tip && tip.parentNode !== canvasBox) canvasBox.appendChild(tip);
  const host = document.getElementById('host-controls');
  if (canvasBox && host && host.parentNode !== canvasBox) canvasBox.appendChild(host);
  const menuBox = document.querySelector('#play .topbar-btns');
  if (canvasBox && menuBox && menuBox.parentNode !== canvasBox) {
    menuBox.style.position = 'absolute';
    canvasBox.appendChild(menuBox);
  }
  // 钉位全部走 labelLocal（本地坐标，rotation-proof）；标签已在 applyView 的
  // r3.render/applySize 里定位完毕，这里坐标是新鲜的。
  pinFloaters();
}

/**
 * 「谁掉线了」→ 3D 座位卡头像置灰（老吴 2026-10-30）。
 * 数据源是 `table:players` 的 connected：服务端在断线/重连时都会广播这一帧，
 * 所以不依赖下一帧 state 也能立刻变灰 / 复原。渲染器还没建时先存着，建好后补推。
 * 回放没有 socket，onlineMap 恒为 null ⇒ 全部按在线处理。
 */
let onlineMap = null;
function applyPlayers(p) {
  const map = {};
  for (const pl of (p && p.players) || []) {
    if (pl && Number.isInteger(pl.seat)) map[pl.seat] = !!pl.connected;
  }
  onlineMap = map;
  if (render3d) render3d.setOnline(map);
}

/** 左上角「癞子是哪张」提示：牌面小图 + 牌面左上角「赖」角标；无癞子时隐藏。
 *  2026-10-30 老吴：「赖子的徽标不需要文字，只需要一个“赖”字加牌面即可」
 *  —— 去掉「癞子 三条」这行字（牌面图已经说清是哪张），牌名挪到 title / aria-label，
 *  悬停与读屏仍可读到，但不占视觉。
 *  2026-10-31 老吴再改：去掉左侧整个「赖」字块，改为在**牌面左上角**叠一个小「赖」角标
 *  （CSS 定位在 .wild-badge 上，JS 只负责生成 <img> + <i>）。 */
function updateWildBadge(view) {
  const el = document.getElementById('wild-badge');
  if (!el) return;
  const w = view && view.wildTile;
  if (!Number.isInteger(w)) {
    el.hidden = true;
    el.textContent = '';
    el.removeAttribute('title');
    el.removeAttribute('aria-label');
    return;
  }
  el.hidden = false;
  const name = tileName(w);
  // 老吴 2026-11-01：徽标牌面改用 3D 皮肤资源（tileSkin3dUrl），与 3D 手牌同源，
  // 不再用 2D 的 yawnoc 栅格集（TILE_SVGS），避免「同张牌两套画风」的割裂感。
  el.innerHTML = `<img src="${tileSkin3dUrl(w)}" alt="" /><i class="wild-tag">赖</i>`;
  el.title = `癞子 ${name}`;
  el.setAttribute('aria-label', `癞子 ${name}`);
}

// 3D 页彻底不要 2D 表面（游戏与回放都是，老吴 2026-10-25）：
// body 标记给 CSS 用（replay-mode 的 2D 表面规则对 3D 页失效），渲染开关给 render.js 用。
document.body.classList.add('mode-3d');
set2dTableVisible(false);

// 右上角菜单钮（老吴 2026-10-24）：胡牌提示/战绩/退出 收进「⋯」，点开纵向菜单。
const btnsBox = document.querySelector('#play .topbar-btns');
if (btnsBox && !document.getElementById('btn-menu')) {
  const menuBtn = document.createElement('button');
  menuBtn.id = 'btn-menu';
  menuBtn.type = 'button';
  menuBtn.title = '菜单';
  menuBtn.textContent = '⋯';
  btnsBox.insertBefore(menuBtn, btnsBox.firstChild);
  const closeMenu = () => btnsBox.classList.remove('menu-open');
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    btnsBox.classList.toggle('menu-open');
  });
  // 点任意菜单项后收起（捕获阶段：先于按钮自身处理器执行，不受其 stopPropagation 影响）；
  // 点页面其他地方也收起。
  btnsBox.addEventListener('click', (e) => {
    if (e.target !== menuBtn) setTimeout(closeMenu, 0);
  }, true);
  document.addEventListener('pointerdown', (e) => {
    if (!btnsBox.contains(e.target)) closeMenu();
    else if (e.target !== menuBtn && (e.target.disabled || e.target === btnsBox)) closeMenu();
    // ↑ 禁用项（如未听牌的胡牌提示）不派发 click；pointer-events:none 后点按落到容器上，一并收起
  });
}

// 全屏按钮（老吴 2026-10-24）：Android/桌面走 Fullscreen API；
// iPhone Safari 不支持页面全屏 —— 提示「添加到主屏幕」（manifest 已配好）。
const fsBtn = document.getElementById('btn-fullscreen');
if (fsBtn) fsBtn.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) { await document.exitFullscreen(); return; }
    if (document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } else {
      flash('iPhone：Safari 分享 →「添加到主屏幕」，从主屏图标进入即无地址栏');
    }
  } catch (e) {
    flash('全屏被浏览器拒绝，可再点一次；iPhone 请用「添加到主屏幕」');
  }
});

/* ---- 中央指示器 + 下方信息条（老吴 2026-10-24 空间优化） ----
   中央：左＝第几把 | 东南西北罗盘（箭头指向当前摸/出牌玩家）| 右＝牌墙剩余张数
   下方：一行高显示 第X/Y把 · 第N圈（替代原顶部信息行） */
/* 罗盘四字 = **固定真实方向**：上北、下南、左西、右东（下标 = 相对位置 0下 1右 2上 3左）。
   ⚠️ 老吴 2026-10-30：旧版把「该位置玩家的风位」填进这四个格（庄家坐东 → 东落在下方、
   西落在上方），看着就是「东、西颠倒」。方位盘只该表示方向，不随谁坐哪旋转；
   「谁在行动」由箭头 + 高亮表示。 */
const CI_COMPASS = ['南', '东', '北', '西'];
function ensureCenterHud() {
  const box = document.getElementById('table3d');
  if (!box) return null;
  if (!document.getElementById('center-indicator')) {
    const ci = document.createElement('div');
    ci.id = 'center-indicator';
    ci.hidden = true;
    ci.innerHTML = '<span class="ci-hand"></span>'
      + '<div class="ci-compass"><i class="ci-arrow"></i>'
      + '<span class="ci-w w0"></span><span class="ci-w w1"></span><span class="ci-w w2"></span><span class="ci-w w3"></span>'
      + '</div><span class="ci-wall"></span>';
    box.appendChild(ci);
    // 2026-10-27 老吴：底部「第X/Y把·第N圈」信息条压手牌，已撤 —— 信息并入中央指示器
    // 左格（ci-hand 扩为 第X/Y把·第N圈）。原 #hand-info 元素与 CSS 一并废弃。
  }
  return { ci: document.getElementById('center-indicator') };
}
const centerHud = ensureCenterHud();

/** 每帧更新中央指示器与下方信息条（对局与回放共用） */
function updateCenterHud(view) {
  if (!centerHud || !view || !view.me) return;
  const mySeat = view.me.seat;
  const turn = Number.isInteger(view.turn) ? view.turn : -1;
  const rel = (s) => (s - mySeat + 4) % 4;          // 0=我(下) 1=右 2=上 3=左
  // 罗盘四字固定为真实方向（上北下南左西右东）；当前行动家那一侧高亮，箭头指向行动家
  const arrow = centerHud.ci.querySelector('.ci-arrow');
  for (let r = 0; r < 4; r++) {
    const el = centerHud.ci.querySelector('.ci-w.w' + r);
    const seat = (mySeat + r) % 4;
    el.textContent = CI_COMPASS[r];
    el.classList.toggle('now', seat === turn);
  }
  // 箭头指向行动家：0(下=我)=180°、1(右)=90°、2(上)=0°、3(左)=270°。
  // 🔴 CSS rotate 顺时针为正：从「下」推向「右」是 -90°（老吴 2026-10-24 实测：
  //    原公式 rel*90+180 把左右弄反了——上下对、东西反）。
  if (arrow) arrow.style.transform = `rotate(${(180 - rel(turn) * 90 + 360) % 360}deg)`;
  // 左右文字：第X/Y把·第N圈（原底部信息条并入，2026-10-27）/ 牌墙剩余
  const room = S && S.room;
  const handNo = room && room.handNo;
  centerHud.ci.querySelector('.ci-hand').textContent = handNo
    ? `第${handNo}/${room.totalHands || '?'}把·第${Math.floor((handNo - 1) / 4) + 1}圈`
    : '';
  const wall = Number.isInteger(view.wallLeft) ? view.wallLeft : null;
  centerHud.ci.querySelector('.ci-wall').textContent = wall != null ? `余${wall}张` : '';
  centerHud.ci.hidden = !(handNo || wall != null) && turn < 0 ? true : false;
}

const lobby = bootNetLobby({
  initSkin: () => initTileSkin3dSelect(() => {
    if (render3d) render3d.reloadTextures();
  }),
  applyView: (view) => {
    const r3 = ensure3d();
    if (r3) {
      r3.setOnline(onlineMap);   // 首次建渲染器时把已知的在线状态补上
      r3.render(view, S.driver);
      r3.applySize();
    }
    updateWildBadge(view);
    updateCenterHud(view);
    relocateHud();
  },
  applyPlayers,
});

// 调试/自动化出口（无头冒烟用；不影响页面逻辑）
window.__net3d = {
  ensure3d,
  applyPayload: lobby.applyPayload,
  applyPlayers,                   // 自动化：注入在线状态（不连 socket 也能验灰头像）
  enterTable: lobby.enterTable,   // 自动化：直接进桌（跳过点击俱乐部/牌桌）
  resumeLastTable: lobby.resumeLastTable, // 自动化：验「重进直接回桌」
  readyUp: lobby.readyUp,         // 自动化：点「准备」
  get state() { return S; },
  get renderer() { return render3d; },
  get driver() { return S.driver; },
  openReplay: lobby.openReplay, // 自动化：直接打开某把回放
  get exitGame() { return lobby.exitGame; }, // 自动化：验「先本局、后本场」的结算顺序
};
