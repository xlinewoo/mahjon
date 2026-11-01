/**
 * 网络版**共享核心**（2026-10-24 抽取）—— 大厅（登录 → 俱乐部 → 牌桌 → 入座）+ 牌桌驱动接线。
 *
 * 此前这段逻辑在 net-main.js 与 net3d-main.js 各有一份逐字副本（约 1100 行 × 2，
 * 43 个同名函数），靠注释提醒「改一份记得同步另一份」，实际已经漂移过。现在：
 *   · net-main.js  （2D 入口） = bootNetLobby({ initSkin: 2D 皮肤选择器 })
 *   · net3d-main.js（3D 入口） = bootNetLobby({ initSkin: 3D 皮肤选择器, applyView: 喂 render3d })
 * 入口只保留**真正 3D/2D 有差异**的接线；皮肤选择器走注入是因为 tile-skin / tile-skin3d
 * 各自打包近 1MB 的素材，绝不能被共享模块连带打包进对面页面。
 *
 * 与单机版 frontend/main.js 是同一套画面：都调 ./render.js，只是 driver 不同 ——
 *   网络：createNetDriver()（socket.io，服务端权威；见 ./net-driver.js）
 *
 * 页面结构见 ./net.html（3D 版 net3d.html；牌桌部分的 id 与 index.html 完全一致）。
 * 被 server 的 `/app/net`、`/app/net3d` 直接送出。
 *
 * 流程：
 *   ① 登录/注册       POST /api/auth/{login,register} → token 存 localStorage
 *   ② 俱乐部           GET/POST /api/clubs
 *   ③ 牌桌             GET/POST /api/clubs/:id/tables · GET /api/tables/:id
 *   ④ 入座             socket.io `/play` → table:join → table:players/state
 *   ⑤ 打牌             action → 等服务端 table:state 回来 → setView → renderAll
 *   ⑥ 长断线           断线不再自动托管；某位在线玩家**主动点「托管」按钮**（table:setAbsent）
 *                      才托管该座位，服务端代打。table:absent（手动托管 / 取消时下发）/
 *                      table:resumed（本人回来撤销托管）—— 判定全在服务端，前端只做提示 + 复位本地视图
 */

import { io as ioImport } from 'socket.io-client';
import { dirOf, windsFromDealer } from './game-loop.js';
import { createNetDriver } from './net-driver.js';
import {
  init as initRender,
  setGame,
  setView,
  setMySeat,
  setModeLabel,
  setNewGameLabel,
  renderAll,
  resetSelection,
  setMatchStats,
} from './render.js';
import { createMatchStats } from './stats.js';
import { $, esc, flash } from './ui-utils.js';
import { initReplay } from './replay.js';
import { createExitGame } from './exit-game.js';

// 网络版「本场战绩」聚合器（维度1/2/3 的数据源）；维度4 走后端 SQLite，不在这里。
const matchStats = createMatchStats();
setMatchStats(matchStats);
let exitGame = null;

/**
 * socket.io 客户端工厂。
 * 默认用打包进来的 socket.io-client；页面上若预置了 `window.__MAHJON_IO__`
 * （冒烟测试注入假 socket / 将来换自定义传输）则优先用它。
 */
const ioFactory = (typeof window !== 'undefined' && window.__MAHJON_IO__) || ioImport;

/* $ / esc / flash 已下沉到 ui-utils.js（与 render.* 共用同一份）。 */

/** 大厅 / 牌桌两个视图下 render.js 与网络层共用的会话状态（3D 入口的调试出口也用它） */
export const S = {
  token: '',
  user: null,
  clubs: [],
  club: null,      // { id, name, role }
  table: null,     // GET /api/tables/:id 的 table
  tableId: null,   // 当前正在玩的牌桌（重连要带）
  socket: null,
  driver: null,
  room: null,      // 最近一帧 table:players
};

const LS_TOKEN = 'mahjon:net:token';

/** 入口注入的扩展点（bootNetLobby 时赋值） */
let lobbyOpts = {};
/** 回放编程入口（wire() 里 initReplay 的返回，bootNetLobby 的句柄经它暴露） */
let replayApi = null;

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** 写一行状态文字；ok=true 走绿色 */
function note(id, msg, ok = false) {
  const el = $(id);
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('ok', !!ok && !!msg);
}

const ROLE_NAME = { owner: '主席', admin: '管理员', member: '成员' };
const STATUS_NAME = { idle: '空闲', waiting: '等待中', playing: '进行中' };
const PRESET_NAME = { koukou: '口口番', kaikou: '开口即算' };

/* ------------------------------------------------------------------ */
/* 玩法规则设定面板（老吴 2026-10-01：每个牌桌的玩法规则要在建房时可选、在卡片上可见）
 * 后端 tables.js 已完整接收并存 `rule_json`，这里只是把房主真正会调的口径做成 UI。
 * 只暴露经过挑选的开关；其余 DEFAULTS 维持引擎默认，避免把内部调参旋钮暴露给房主。
 * 每条的 `def` 与 src/engine/rules.js 的 DEFAULTS 保持一致（镜像，非动态拉取）。
 * ❗`preset` / `circleCount` 是 table 级字段，不在这里渲染（沿用建房表单里已有的下拉）。 */
const RULE_FIELDS = {
  enforceMinFan:          { type: 'bool', def: true,  label: '起胡门槛' },
  minFanSmall:            { type: 'int',  def: 6, min: 0, max: 20, label: '小胡起胡番' },
  minFanBig:              { type: 'int',  def: 3, min: 0, max: 20, label: '大胡起胡番' },
  wildMode:               { type: 'enum', def: 'flip', options: [['flip', '翻牌定癞子'], ['none', '无癞子']], label: '癞子' },
  maxWildsForSmallHu:     { type: 'int',  def: 1, min: 0, max: 4,  label: '小胡手里最多癞子' },
  yuanLaiMul:             { type: 'int',  def: 2, min: 0, max: 8,  label: '原赖倍数（0=关）' },
  fengLaiMul:             { type: 'int',  def: 2, min: 0, max: 8,  label: '风赖倍数（0=关）' },
  qiPiShiGangEnabled:     { type: 'bool', def: true,  label: '七皮 / 十杠成就' },
  qingJiangBaoEnabled:    { type: 'bool', def: true,  label: '清/将一色包牌' },
  basicTwoKouEnabled:     { type: 'bool', def: true,  label: '基本两口' },
  basicTwoKouCount:       { type: 'int',  def: 2, min: 1, max: 8,  label: '基本两口张数' },
  basicTwoKouRequireHandSkin: { type: 'bool', def: true, label: '两口严格（手中须有皮）' },
  menGangExemptsSunny:    { type: 'bool', def: true,  label: '闷杠免阳光（暗杠不被翻倍）' },
  rainEnabled:            { type: 'bool', def: true,  label: '下雨 / 陪包（清将一色喂第三句）' },
  lianJinEnabled:         { type: 'bool', def: true,  label: '连金（连庄连续胡 +1 番）' },
  fanJinEnabled:          { type: 'bool', def: true,  label: '反金（下家/对家胡 +1 番）' },
  claimTimeoutMs:         { type: 'int',  def: 8000, min: 1000, max: 60000, label: '响应等待(ms)' },
};
const RULE_GROUPS = [
  { title: '基础', fields: ['enforceMinFan', 'minFanSmall', 'minFanBig'] },
  { title: '癞子 / 皮子', fields: ['wildMode', 'maxWildsForSmallHu'] },
  { title: '番 / 封顶 / 特殊', fields: ['yuanLaiMul', 'fengLaiMul', 'qiPiShiGangEnabled', 'qingJiangBaoEnabled', 'basicTwoKouEnabled', 'basicTwoKouCount', 'basicTwoKouRequireHandSkin', 'menGangExemptsSunny', 'rainEnabled', 'lianJinEnabled', 'fanJinEnabled'] },
  { title: '托管 / 超时', fields: ['claimTimeoutMs'] },
];

/** 把规则渲染成面板（rules 为空 → 用默认）。每个控件带 data-key，collectRulePanel 读回。 */
function renderRulePanel(container, rules) {
  if (!container) return;
  container.innerHTML = '';
  for (const g of RULE_GROUPS) {
    const fs = document.createElement('fieldset');
    fs.className = 'rule-group';
    const lg = document.createElement('legend');
    lg.textContent = g.title;
    fs.appendChild(lg);
    for (const key of g.fields) {
      const f = RULE_FIELDS[key];
      let val = rules ? rules[key] : undefined;
      // 七皮 / 十杠合并成一个开关：旧桌可能只有其中一个字段，默认按「开」显示，
      // 只有两者都明确关掉才算关。
      if (key === 'qiPiShiGangEnabled') {
        val = rules ? !(rules.qiPiEnabled === false && rules.shiGangEnabled === false) : f.def;
      }
      if (val === undefined) val = f.def;
      const row = document.createElement('div');
      row.className = 'rule-row';
      if (f.type === 'bool') {
        row.innerHTML = `<label><input type="checkbox" data-key="${key}" ${val ? 'checked' : ''}/> ${f.label}</label>`;
      } else if (f.type === 'enum') {
        const opts = f.options.map(([v, t]) => `<option value="${v}" ${v === val ? 'selected' : ''}>${t}</option>`).join('');
        row.innerHTML = `<label>${f.label} <select data-key="${key}">${opts}</select></label>`;
      } else { // int
        row.innerHTML = `<label>${f.label} <input type="number" data-key="${key}" value="${val}" min="${f.min}" max="${f.max}" /></label>`;
      }
      fs.appendChild(row);
    }
    container.appendChild(fs);
  }
}

/** 读回面板里的规则覆盖项（只回传面板覆盖的字段；preset 由调用方单独拼）。 */
function collectRulePanel(container) {
  const rules = {};
  if (!container) return rules;
  for (const el of container.querySelectorAll('[data-key]')) {
    const key = el.getAttribute('data-key');
    const f = RULE_FIELDS[key];
    if (!f) continue;
    if (key === 'qiPiShiGangEnabled') {
      // 合并开关落到引擎既有的两个字段；张数/口数不暴露 → 引擎默认 7 / 10。
      rules.qiPiEnabled = el.checked;
      rules.shiGangEnabled = el.checked;
    } else if (f.type === 'bool') rules[key] = el.checked;
    else if (f.type === 'int') rules[key] = Number(el.value);
    else rules[key] = el.value;
  }
  return rules;
}

/** 牌桌卡片上的规则摘要（让房主一眼看到这桌怎么打） */
function ruleSummary(rules) {
  rules = rules || {};
  const p = PRESET_NAME[rules.preset] || '口口番';
  const parts = [p];
  if (rules.enforceMinFan !== false) parts.push(`起胡 ${rules.minFanSmall ?? 6}/${rules.minFanBig ?? 3}`);
  else parts.push('无门槛');
  parts.push(rules.wildMode === 'none' ? '无癞子' : '有癞子');
  if (rules.yuanLaiMul > 0) parts.push(`原赖×${rules.yuanLaiMul}`);
  if (rules.fengLaiMul > 0) parts.push(`风赖×${rules.fengLaiMul}`);
  if (rules.qiPiEnabled !== false || rules.shiGangEnabled !== false) parts.push('七皮十杠');
  if (rules.basicTwoKouEnabled !== false) parts.push(`两口${rules.basicTwoKouCount ?? 2}`);
  if (rules.menGangExemptsSunny !== false) parts.push('闷杠免阳光');
  if (rules.rainEnabled !== false) parts.push('下雨陪包');
  if (rules.lianJinEnabled !== false) parts.push('连金');
  if (rules.fanJinEnabled !== false) parts.push('反金');
  return parts.join(' · ');
}

/** 房主改规则时的目标牌桌 id（null＝正常建房） */
let editTableId = null;

/* ------------------------------------------------------------------ */
/* REST                                                                */
/* ------------------------------------------------------------------ */

async function api(path, method = 'GET', body) {
  const hasBody = body !== undefined;
  const headers = {};
  // ❗老吴 2026-10-01 修的 bug：空 body 的 POST（如「加入俱乐部」）若硬带
  //    `Content-Type: application/json`，Fastify 会 400 `FST_ERR_CTP_EMPTY_JSON_BODY`。
  //    只在真有 body 时才设 JSON 头。
  if (hasBody) headers['Content-Type'] = 'application/json';
  if (S.token) headers.Authorization = 'Bearer ' + S.token;
  const res = await fetch(path, {
    method,
    headers,
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* 204 / 非 JSON */ }
  if (!res.ok) {
    if (res.status === 401) clearToken();
    throw new Error((data && (data.error || data.msg)) || `请求失败（HTTP ${res.status}）`);
  }
  return data || {};
}

function saveToken(t) {
  S.token = t;
  try { localStorage.setItem(LS_TOKEN, t); } catch (_) { /* 隐私模式禁写 → 忽略 */ }
}
function clearToken() {
  S.token = '';
  S.user = null;
  try { localStorage.removeItem(LS_TOKEN); } catch (_) { /* 忽略 */ }
}

/* ------------------------------------------------------------------ */
/* 「上次所在的牌桌」—— 断线/关页后重新进来直接回桌（老吴 2026-10-30）  */
/*                                                                     */
/* 断线重连（socket 自动重连）本来就回原座；但**页面被销毁**（手机切后台 */
/* 被系统回收、误关标签、锁屏后浏览器重载）时，boot() 只认 token，会停在  */
/* 「我的俱乐部」，用户还得再点两层才回到牌桌。这里把「当前牌桌」记进    */
/* localStorage，boot 时优先尝试直接回桌；只有回不去（牌桌没了 / 被踢 /   */
/* 座位满了）才落回俱乐部页。                                          */
/* ------------------------------------------------------------------ */
const LS_TABLE = 'mahjon:net:lastTable';
/** 记录多久内还算「刚才那桌」—— 隔天再开来一条旧记录会莫名跳进空桌 */
const LAST_TABLE_TTL_MS = 12 * 3600 * 1000;

function saveLastTable(tableId, clubId) {
  if (!Number.isInteger(Number(tableId))) return;
  try {
    localStorage.setItem(LS_TABLE, JSON.stringify({
      tableId: Number(tableId),
      clubId: Number(clubId) || null,
      at: Date.now(),
    }));
  } catch (_) { /* 隐私模式禁写 → 忽略 */ }
}
function clearLastTable() {
  try { localStorage.removeItem(LS_TABLE); } catch (_) { /* 忽略 */ }
}
function readLastTable() {
  let o = null;
  try { o = JSON.parse(localStorage.getItem(LS_TABLE) || 'null'); } catch (_) { o = null; }
  if (!o || !Number.isInteger(Number(o.tableId))) { clearLastTable(); return null; }
  // 玩到一半的牌局可以跨好几个小时，但超过 TTL 的记录基本是「昨天那桌」
  if (!o.at || Date.now() - o.at > LAST_TABLE_TTL_MS) { clearLastTable(); return null; }
  return { tableId: Number(o.tableId), clubId: Number(o.clubId) || null };
}
/** 还在牌桌上时刷新时间戳（长局不因为超过 TTL 被当成旧记录丢掉） */
function touchLastTable() {
  if (S.tableId) saveLastTable(S.tableId, S.table?.clubId ?? S.club?.id);
}

/* ------------------------------------------------------------------ */
/* 视图切换                                                            */
/* ------------------------------------------------------------------ */

/**
 * 大厅四个视图。键是短名（showLobby('clubs') 也能用），值是 net.html 里的元素 id。
 * ⚠️ 曾经这里直接拿短名去比对元素 id（'clubs' !== 'clubs-view'），结果一进大厅四个
 *    面板全被判成 hidden —— 界面整片空白。所以名称到 id 必须显式映射。
 */
const LOBBY_VIEWS = { auth: 'auth-view', avatarGate: 'avatar-gate-view', clubs: 'clubs-view', club: 'club-view', table: 'table-view' };

function showLobby(key) {
  const name = LOBBY_VIEWS[key] || key; // 允许直接传元素 id（'table-view'）
  document.body.classList.toggle('auth-open', name === LOBBY_VIEWS.auth);
  // 大厅/登录页不吃「竖屏自动横屏」（style.css 的 html.in-play 作用域，老吴 2026-10-24）
  document.documentElement.classList.remove('in-play');
  $('lobby').hidden = false;
  $('play').hidden = true;
  $('waiting').hidden = true;
  for (const id of Object.values(LOBBY_VIEWS)) {
    const el = $(id);
    if (el) el.hidden = id !== name;
  }
}

function showPlay() {
  // 进牌桌才允许竖屏自动横屏（与 showLobby 的 remove 成对）
  document.documentElement.classList.add('in-play');
  $('lobby').hidden = true;
  $('play').hidden = false;
  $('waiting').hidden = true;
}

/** 全屏过渡提示（开局了但本端还没收到首帧 state） */
function showWaiting(sub) {
  $('waiting').hidden = false;
  if (sub) $('waiting-sub').textContent = sub;
}

function renderWhoami() {
  const el = $('whoami');
  if (!el) return;
  const av = S.user && S.user.avatar && S.user.avatar.type === 'preset' && S.user.avatar.value
    ? `<img class="lb-avatar-img" src="/api/avatars/preset/${encodeURIComponent(S.user.avatar.value)}.webp" alt="">`
    : '';
  for (const sav of document.querySelectorAll('.js-avatar-save')) sav.hidden = !S.user;
  el.innerHTML = S.user
    ? `${av}<b>${esc(S.user.username)}</b><br />已登录${S.tableId ? ` · 牌桌 #${S.tableId}` : ''}`
    : '未登录';
}

/* ------------------------------------------------------------------ */
/* ① 头像库（老吴 2026-10-24）：注册时选用 + 已登录「更新头像」          */
/* ------------------------------------------------------------------ */

let pickedAvatar = null;

async function loadAvatarPicker() {
  // 所有 .avatar-picker 容器（换头像弹出层 + 注册后的门槛页）一起填充。
  // 预设头像库 = icon/ 图片（老吴 2026-10-25）：每个按钮是一张缩略图，id 记在 dataset 上。
  const boxes = [...document.querySelectorAll('.avatar-picker')].filter((b) => !b.dataset.loaded);
  if (!boxes.length) return;
  try {
    const d = await api('/api/avatars');
    const presets = (d && d.presets) || [];
    const urls = (d && d.urls) || {};
    for (const box of boxes) {
      box.dataset.loaded = '1';
      box.innerHTML = '';
      for (const id of presets) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'avatar-opt';
        b.title = '选这个头像';
        b.dataset.avatarId = id;
        if (id === pickedAvatar) b.classList.add('picked');
        const img = document.createElement('img');
        img.src = urls[id] || `/api/avatars/preset/${encodeURIComponent(id)}.webp`;
        img.alt = '';
        img.draggable = false;
        b.appendChild(img);
        b.addEventListener('click', () => {
          pickedAvatar = id;
          for (const o of document.querySelectorAll('.avatar-opt')) {
            o.classList.toggle('picked', o.dataset.avatarId === id);
          }
          const gateSave = $('btn-avatar-gate-save');
          if (gateSave) gateSave.disabled = false;
        });
        box.appendChild(b);
      }
    }
  } catch { /* 服务未起 / 离线：选择器留空，不影响登录 */ }
}

/** 大厅顶栏点头像 → 开/关换头像弹层（仅登录后可用） */
function toggleAvatarPop() {
  const pop = $('avatar-pop');
  if (!pop) return;
  pop.hidden = !pop.hidden || !S.user;
  if (!pop.hidden) loadAvatarPicker();
}

async function savePickedAvatar() {
  if (!S.user) return;
  if (!pickedAvatar) return note('status-auth', '先在上面点一个头像', true);
  try {
    const d = await api('/api/me/avatar', 'PUT', { type: 'preset', value: pickedAvatar });
    S.user.avatar = d.avatar;
    renderWhoami();
    const pop = $('avatar-pop');
    if (pop) pop.hidden = true;
    note('status-auth', '头像已更新，下次发牌生效', true);
  } catch (e) {
    note('status-auth', e.message);
  }
}

/* ------------------------------------------------------------------ */
/* ① 登录 / 注册                                                       */
/* ------------------------------------------------------------------ */

/**
 * 登录 / 注册合一（老吴 2026-10-25）：
 *   第一次点「进入」→ 查用户名：存在就直接登录；不存在 → 转注册模式，
 *   显示「再次输入密码确认」，第二次点「进入」才真正注册。
 *   注册成功 → 必须先选头像（avatar-gate）才能进大厅。
 */
let registerMode = false;
let pendingAvatarGate = false;

async function authSubmit() {
  const username = ($('auth-name').value || '').trim();
  const password = $('auth-pass').value || '';
  if (!username || !password) return note('status-auth', '昵称和密码都要填');

  if (!registerMode) {
    note('status-auth', '验证中…');
    let exists;
    try {
      const d = await api('/api/auth/exists', 'POST', { username });
      exists = !!d.exists;
    } catch (e) {
      return note('status-auth', e.message);
    }
    if (!exists) {
      registerMode = true;
      $('auth-confirm').hidden = false;
      note('status-auth', '新昵称，将注册新用户 —— 请再次输入密码确认，再点「进入」', true);
      return;
    }
    note('status-auth', '登录中…');
    try {
      const d = await api('/api/auth/login', 'POST', { username, password });
      finishAuth(d);
    } catch (e) {
      note('status-auth', e.message);
    }
    return;
  }

  // 注册模式：二次确认密码
  const confirm = $('auth-confirm').value || '';
  // 2026-10-29 与服务端 passwordProblem 同口径（8 位）；登录分支不校验长度，老账号不受影响
  if (password.length < 8) return note('status-auth', '密码至少 8 位');
  if (password !== confirm) return note('status-auth', '两次输入的密码不一致，请重新确认');
  note('status-auth', '注册中…');
  try {
    const d = await api('/api/auth/register', 'POST', { username, password });
    registerMode = false;
    pendingAvatarGate = true; // 新用户必须先选头像
    finishAuth(d);
  } catch (e) {
    note('status-auth', e.message);
  }
}

/** 登录/注册成功后的公共收尾：新注册用户先进选头像门槛，老账号直接进大厅 */
function finishAuth(d) {
  if (!d.token) throw new Error('服务端没有返回令牌');
  saveToken(d.token);
  S.user = d.user;
  $('auth-pass').value = '';
  $('auth-confirm').value = '';
  $('auth-confirm').hidden = true;
  note('status-auth', '');
  renderWhoami();
  if (pendingAvatarGate && !(S.user.avatar && S.user.avatar.value)) {
    pendingAvatarGate = false;
    showLobby('avatarGate');
    loadAvatarPicker();
    return;
  }
  pendingAvatarGate = false;
  showLobby('clubs');
  loadClubs();
}

async function logout() {
  // 2026-10-29：先让服务端把令牌作废（token_version +1），再清本地。
  // 只清本地的话，那枚 JWT 在服务端 7 天内都还是「有效令牌」——
  // 一旦它被人拿到（例如从 localStorage 复制），退出登录等于没退。
  const token = S.token;
  S.token = '';
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: token ? { Authorization: 'Bearer ' + token } : {},
    });
  } catch (_) { /* 离线 / 服务端不可达：本地照样退出，令牌到期自然失效 */ }
  clearToken();
  renderWhoami();
  S.clubs = [];
  S.club = null;
  showLobby('auth');
  note('status-auth', '已退出登录', true);
}

/* ------------------------------------------------------------------ */
/* ② 俱乐部                                                            */
/* ------------------------------------------------------------------ */

async function loadClubs() {
  try {
    const d = await api('/api/clubs');
    S.clubs = d.clubs || [];
  } catch (e) {
    note('status-clubs', e.message);
    return;
  }
  $('clubs-count').textContent = S.clubs.length ? `${S.clubs.length} 个` : '';
  const box = $('clubs-list');
  box.innerHTML = '';
  if (!S.clubs.length) {
    box.innerHTML = '<div class="lb-empty">还没有俱乐部，先在下面新建一个。</div>';
  } else {
    for (const c of S.clubs) {
      const el = document.createElement('div');
      el.className = 'lb-item';
      // 待审入会申请数（只有主席/管理员会拿到非 0）——在列表上就提醒，不用点进去才发现
      const pend = c.pendingCount ? ` · <b>${c.pendingCount} 条入会申请</b>` : '';
      el.innerHTML =
        `<div class="lb-item-main"><div class="lb-item-title">${esc(c.name)}</div>` +
        `<div class="lb-item-meta">${ROLE_NAME[c.role] || c.role} · 编号 ${c.id}${pend}</div></div>`;
      const btn = document.createElement('button');
      btn.className = 'lb-btn';
      btn.type = 'button';
      btn.textContent = '进入';
      btn.addEventListener('click', () => openClub(c.id).catch((e) => note('status-clubs', e.message)));
      el.appendChild(btn);
      box.appendChild(el);
    }
  }
  // ❗老吴 2026-10-01：进入大厅顺带拉「可加入的俱乐部」公开列表
  await loadDiscover();
}

// ❗老吴 2026-10-01：公开列表（大厅「可加入的俱乐部」）。列出**我尚未加入**的俱乐部。
// 2026-10-30 起入会改为申请制：按钮在「申请加入 → 等待同意 → 已申请」之间切换，
// 不再是一点就进（老吴：「进入俱乐部需要俱乐部创建人同意」）。
async function loadDiscover() {
  const box = $('discover-list');
  if (!box) return;
  try {
    const d = await api('/api/clubs/discover');
    const rows = (d.clubs || []).filter((c) => !c.joined);
    box.innerHTML = '';
    if (!rows.length) {
      box.innerHTML = '<div class="lb-empty">暂时没有其他俱乐部可加入。</div>';
      return;
    }
    for (const c of rows) {
      const el = document.createElement('div');
      el.className = 'lb-item';
      el.innerHTML =
        `<div class="lb-item-main"><div class="lb-item-title">${esc(c.name)}</div>` +
        `<div class="lb-item-meta">编号 ${c.id} · ${c.memberCount} 名成员` +
        `${c.pending ? ' · <b>申请已提交，等待主席同意</b>' : ''}</div></div>`;
      const btn = document.createElement('button');
      btn.className = 'lb-btn';
      btn.type = 'button';
      if (c.pending) {
        // 已申请：按钮变成「撤回申请」，避免用户反复点却什么也不发生
        btn.textContent = '撤回申请';
        btn.classList.add('ghost');
        btn.addEventListener('click', () => cancelApply(c.id).catch((e) => note('status-clubs', e.message)));
      } else {
        btn.textContent = '申请加入';
        btn.addEventListener('click', () => applyClub(c.id).catch((e) => note('status-clubs', e.message)));
      }
      el.appendChild(btn);
      box.appendChild(el);
    }
  } catch (e) {
    // 公开列表失败不应阻断「我的俱乐部」展示
  }
}

/** 提交入会申请（只排队，不会直接进会）；成功后刷新大厅，按钮变为「撤回申请」 */
async function applyClub(id) {
  note('status-clubs', '提交申请中…');
  try {
    const d = await api(`/api/clubs/${id}/apply`, 'POST', {});
    if (d && d.member) {
      // 已经是成员（例如主席刚好直接拉进来了）
      note('status-clubs', '你已经是该俱乐部成员', true);
      await loadClubs();
      return;
    }
    note('status-clubs', '申请已提交，等主席同意后即可进入', true);
    await loadDiscover();
  } catch (e) {
    note('status-clubs', e.message);
  }
}

/** 撤回自己还没被处理的申请 */
async function cancelApply(id) {
  try {
    const me = S.user && S.user.id;
    if (!me) return;
    await api(`/api/clubs/${id}/applications/${me}`, 'DELETE');
    note('status-clubs', '已撤回申请', true);
    await loadDiscover();
  } catch (e) {
    note('status-clubs', e.message);
  }
}

async function createClub() {
  const name = ($('club-name').value || '').trim();
  if (!name) return note('status-clubs', '先填俱乐部名称');
  note('status-clubs', '创建中…');
  try {
    const d = await api('/api/clubs', 'POST', { name });
    $('club-name').value = '';
    note('status-clubs', '');
    await loadClubs();
    note('status-clubs', `已创建「${d.club ? d.club.name : name}」`, true);
  } catch (e) {
    note('status-clubs', e.message);
  }
}

/* ------------------------------------------------------------------ */
/* ③ 俱乐部内部：成员 + 牌桌                                            */
/* ------------------------------------------------------------------ */

async function openClub(id) {
  note('status-clubs', '');
  const [detail, tables] = await Promise.all([api(`/api/clubs/${id}`), api(`/api/clubs/${id}/tables`)]);
  const mine = S.clubs.find((c) => c.id === id);
  S.club = {
    id,
    name: (detail.club && detail.club.name) || (mine && mine.name) || `俱乐部 ${id}`,
    role: detail.role || (mine ? mine.role : 'member'),
  };

  $('club-title').textContent = S.club.name;
  const members = detail.members || [];
  updateClubSub(members);
  renderMembers(members);
  // 入会申请区（2026-10-30）：服务端只对主席/管理员下发，普通成员拿到空数组且整块隐藏
  renderApplications(detail.applications || []);
  renderTables(tables.tables || []);
  // 成员区默认收起（老吴 2026-10-24）：每次进俱乐部都复位
  const membersBox = $('members-box');
  if (membersBox) membersBox.hidden = true;
  // ❗进俱乐部时退出「改规则」状态并把面板复位成默认（避免上一次的残留）
  endEditRulesOnOpen();
  showLobby('club-view');
}

/** 俱乐部标题下的摘要行（成员数 / 我的身份）——开俱乐部和审批后都要刷 */
function updateClubSub(members) {
  const sub = $('club-sub');
  if (!sub || !S.club) return;
  sub.innerHTML =
    `编号 ${S.club.id} · ${members.length} 名成员 · 我的身份：<b>${ROLE_NAME[S.club.role] || S.club.role}</b>`;
}

/**
 * 入会申请列表（老吴 2026-10-30：进俱乐部要创建人同意）
 * 主席/管理员每条都有「同意 / 拒绝」；普通成员整块不显示（后端也不会给数据）。
 */
function renderApplications(list) {
  const box = $('apps-box');
  const listEl = $('apps-list');
  if (!box || !listEl) return;
  const canManage = S.club && (S.club.role === 'owner' || S.club.role === 'admin');
  box.hidden = !canManage;
  if (!canManage) return;

  $('apps-count').textContent = list.length ? `${list.length} 条待审` : '暂无';
  listEl.innerHTML = '';
  if (!list.length) {
    listEl.innerHTML = '<div class="lb-empty">暂无待审申请。</div>';
    return;
  }
  for (const a of list) {
    const el = document.createElement('div');
    el.className = 'lb-item';
    const noteTxt = a.note ? ` · 留言：${esc(a.note)}` : '';
    el.innerHTML =
      `<div class="lb-item-main"><div class="lb-item-title">${esc(a.username)}</div>` +
      `<div class="lb-item-meta">申请加入${noteTxt}</div></div>`;

    // 两个按钮必须包在一个容器里：.lb-item 是 space-between，
    // 直接塞三个子元素会把「同意」摊到行中间（2026-10-30 实测截图发现）
    const act = document.createElement('div');
    act.className = 'lb-item-actions';

    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'lb-btn primary';
    yes.textContent = '同意';
    yes.addEventListener('click', () => decideApplication(a.id, true));

    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'lb-btn ghost';
    no.textContent = '拒绝';
    no.addEventListener('click', () => decideApplication(a.id, false));

    act.appendChild(yes);
    act.appendChild(no);
    el.appendChild(act);
    listEl.appendChild(el);
  }
}

/** 同意 / 拒绝一条申请；同意后成员表、摘要行、待审数一起刷新 */
async function decideApplication(uid, approve) {
  if (!S.club) return;
  try {
    await api(`/api/clubs/${S.club.id}/applications/${uid}/${approve ? 'approve' : 'reject'}`, 'POST', {});
    note('status-clubs', approve ? '已同意入会' : '已拒绝该申请', true);
    await refreshApplications();
    const detail = await api(`/api/clubs/${S.club.id}`);
    const members = detail.members || [];
    renderMembers(members);
    updateClubSub(members);
  } catch (e) {
    note('status-clubs', e.message);
  }
}

/** 单纯刷新待审列表（顶部「刷新」按钮 / 审批后调用） */
async function refreshApplications() {
  if (!S.club) return;
  try {
    const d = await api(`/api/clubs/${S.club.id}/applications`);
    renderApplications(d.applications || []);
  } catch (e) {
    // 非管理者会 403：保持原样，不弹错误打断操作
  }
}

/** 进俱乐部 / 切换俱乐部时，退出改规则状态并复位面板（不触发网络请求） */
function endEditRulesOnOpen() {
  editTableId = null;
  const btn = $('btn-create-table');
  if (btn) btn.textContent = '摆一桌';
  renderRulePanel($('rule-fields'), null);
}

function renderMembers(members) {
  const box = $('members-list');
  box.innerHTML = '';
  const canManage = S.club && (S.club.role === 'owner' || S.club.role === 'admin');
  const meId = S.user && S.user.id;
  for (const m of members) {
    const el = document.createElement('div');
    el.className = 'lb-item';
    el.innerHTML =
      `<div class="lb-item-main"><div class="lb-item-title">${esc(m.username)}</div>` +
      `<div class="lb-item-meta">${ROLE_NAME[m.role] || m.role}</div></div>`;
    // 2026-10-29 P2：踢人入口。旧实现里「加入了就移不掉」，只能改数据库。
    // 规则与后端 DELETE /api/clubs/:id/members/:uid 一致：
    // 主席谁都可移（除自己）；管理员不能移主席、也不能移其他管理员。
    const removable =
      canManage && m.id !== meId && m.role !== 'owner' &&
      !(S.club.role !== 'owner' && m.role === 'admin');
    if (removable) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lb-btn ghost';
      btn.textContent = '移除';
      btn.style.marginLeft = 'auto';
      btn.addEventListener('click', () => kickMember(m));
      el.appendChild(btn);
    }
    box.appendChild(el);
  }
  const leaveBtn = $('btn-leave-club');
  if (leaveBtn) leaveBtn.hidden = !S.club || S.club.role === 'owner';
  // 删除俱乐部（2026-10-31）：仅主席可见
  const delClubBtn = $('btn-delete-club');
  if (delClubBtn) delClubBtn.hidden = !S.club || S.club.role !== 'owner';
  $('invite-form').hidden = !canManage;
  if (!canManage) note('status-club', '只有主席 / 管理员能邀请成员', true);
}

/** 踢人（主席 / 管理员） */
async function kickMember(m) {
  if (!S.club) return;
  if (!confirm(`把「${m.username}」移出俱乐部？对方将看不到本俱乐部的牌桌与回放。`)) return;
  try {
    await api(`/api/clubs/${S.club.id}/members/${m.id}`, 'DELETE');
    note('status-club', `已移除 ${m.username}`, true);
    await openClub(S.club.id);
  } catch (e) {
    note('status-club', e.message);
  }
}

/** 退出俱乐部（主席不能退：俱乐部必须有主人） */
async function leaveClub() {
  if (!S.club) return;
  if (!confirm(`确定退出「${S.club.name}」？`)) return;
  const id = S.club.id;
  try {
    await api(`/api/clubs/${id}/leave`, 'POST');
    S.club = null;
    showLobby('clubs');
    await loadClubs();
    note('status-clubs', '已退出俱乐部', true);
  } catch (e) {
    note('status-club', e.message);
  }
}

/** 删除牌桌（房主；桌上有人的时候后端拒绝） */
async function deleteTable(t) {
  if (!S.club) return;
  if (!confirm(`确定删除牌桌「${t.name}」？该桌的回放会一并删除（个人累计战绩不受影响）。`)) return;
  try {
    await api(`/api/tables/${t.id}`, 'DELETE');
    note('status-club', `已删除牌桌「${t.name}」`, true);
    await openClub(S.club.id);
  } catch (e) {
    note('status-club', e.message);
  }
}

/** 删除俱乐部（主席；俱乐部内任一牌桌有人时后端拒绝）。级联删成员/申请/俱乐部战绩/牌桌，个人累计战绩保留 */
async function deleteClub() {
  if (!S.club) return;
  if (!confirm(`确定删除俱乐部「${S.club.name}」？\n所有成员与牌桌将一并删除，俱乐部战绩榜不再保留（你的个人累计战绩不受影响）。此操作不可撤销！`)) return;
  const id = S.club.id;
  try {
    await api(`/api/clubs/${id}`, 'DELETE');
    note('status-clubs', `已删除俱乐部「${S.club.name}」`, true);
    S.club = null;
    showLobby('clubs');
    await loadClubs();
  } catch (e) {
    note('status-club', e.message);
  }
}

function renderTables(tables) {
  $('tables-count').textContent = tables.length ? `${tables.length} 张` : '';
  // 摆桌是主席专属，且每俱乐部最多 4 桌（老吴 2026-10-24）：非主席/满员时收起建桌区并提示
  const isChair = !!(S.club && S.club.role === 'owner');
  const full = tables.length >= 4;
  const form = $('create-table-form');
  if (form) form.hidden = !isChair || full;
  const rules = $('create-rules');
  if (rules) rules.hidden = !isChair || full;
  const hint = $('create-hint');
  if (hint) {
    hint.hidden = isChair && !full;
    // 非主席优先说权限、主席才说桌数上限（两条同时成立时对成员解释权限更合理）
    hint.textContent = !isChair ? '只有俱乐部主席能摆桌。' : full ? '已达 4 桌上限，现有的桌打完前不能再摆。' : '';
  }
  const box = $('tables-list');
  box.innerHTML = '';
  if (!tables.length) {
    box.innerHTML = `<div class="lb-empty">${isChair ? '还没有牌桌，在下面摆一桌（1 圈 = 4 把）。' : '主席还没有摆桌。'}</div>`;
    return;
  }
  for (const t of tables) {
    const preset = (t.rules && t.rules.preset) || 'koukou';
    const isOwner = S.user && t.ownerId === S.user.id;
    const el = document.createElement('div');
    el.className = 'lb-item';
    el.innerHTML =
      `<div class="lb-item-main"><div class="lb-item-title">${esc(t.name)}</div>` +
      `<div class="lb-item-meta">${t.circleCount} 圈 · ${PRESET_NAME[preset] || preset} · ${STATUS_NAME[t.status] || t.status} · 编号 ${t.id}</div>` +
      `<div class="lb-item-meta rule-summary">${esc(ruleSummary(t.rules))}</div></div>`;
    const btn = document.createElement('button');
    btn.className = 'lb-btn primary';
    btn.type = 'button';
    btn.textContent = '进桌';
    btn.addEventListener('click', () => enterTable(t.id).catch((e) => note('status-club', e.message)));
    el.appendChild(btn);
    // ❗老吴 2026-10-01：房主 + 牌桌空闲（idle）才能改规则（后端 PATCH 也只允许 idle/waiting）
    if (isOwner && t.status === 'idle') {
      const editBtn = document.createElement('button');
      editBtn.className = 'lb-btn';
      editBtn.type = 'button';
      editBtn.textContent = '改规则';
      editBtn.addEventListener('click', () => startEditRules(t).catch((e) => note('status-club', e.message)));
      el.appendChild(editBtn);
    }
    // 2026-10-31：房主可删除牌桌；桌上有人的时候后端返回 409（不让删）
    if (isOwner) {
      const delBtn = document.createElement('button');
      delBtn.className = 'lb-btn warn';
      delBtn.type = 'button';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', () => deleteTable(t).catch((e) => note('status-club', e.message)));
      el.appendChild(delBtn);
    }
    box.appendChild(el);
  }
}

/** 维度4：跨场历史战绩（俱乐部战绩榜，后端 SQLite 持久化，跨多场累计） */
async function openHistory() {
  if (!S.club) return note('status-club', '先进入一个俱乐部');
  note('status-club', '加载战绩榜…');
  try {
    const d = await api(`/api/clubs/${S.club.id}/stats`);
    renderHistory(d.stats || []);
    const box = $('history');
    if (box) box.hidden = false;
    note('status-club', '');
  } catch (e) {
    note('status-club', e.message);
  }
}

function renderHistory(stats) {
  const card = $('history-card');
  if (!card) return;
  const th = (t) => { const e = document.createElement('th'); e.textContent = t; return e; };
  const td = (t) => { const e = document.createElement('td'); e.textContent = t; return e; };
  card.innerHTML = '';
  const h = document.createElement('h3');
  h.textContent = `跨场战绩榜 · ${S.club ? S.club.name : ''}`;
  card.appendChild(h);

  if (!stats.length) {
    const empty = document.createElement('div');
    empty.className = 'lb-empty';
    empty.textContent = '还没有任何对局记录。';
    card.appendChild(empty);
  } else {
    const sub = document.createElement('div');
    sub.className = 'stats-sub';
    sub.textContent = `共 ${stats.length} 名成员，按总净分排序`;
    card.appendChild(sub);

    const tbl = document.createElement('table');
    tbl.className = 'score-table';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    ['#', '昵称', '总净分', '胡', '金顶', '杠', '最高番', '局数'].forEach((t) => hr.appendChild(th(t)));
    thead.appendChild(hr);
    tbl.appendChild(thead);
    const tbody = document.createElement('tbody');
    stats.forEach((s, i) => {
      const r = document.createElement('tr');
      if (i === 0 && s.total_score > 0) r.className = 'leader';
      r.appendChild(td(String(i + 1)));
      r.appendChild(td(s.username));
      const net = td((s.total_score > 0 ? '+' : '') + s.total_score);
      net.className = s.total_score > 0 ? 'pos' : s.total_score < 0 ? 'neg' : '';
      r.appendChild(net);
      r.appendChild(td(String(s.wins)));
      r.appendChild(td(String(s.gold_tops)));
      r.appendChild(td(String(s.total_gangs)));
      r.appendChild(td(String(s.max_fan)));
      r.appendChild(td(String(s.hands)));
      tbody.appendChild(r);
    });
    tbl.appendChild(tbody);
    card.appendChild(tbl);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'stats-close';
  close.textContent = '关闭';
  close.addEventListener('click', () => { const b = $('history'); if (b) b.hidden = true; });
  card.appendChild(close);
}

/** 我的战绩（**跨俱乐部个人总成绩**，老吴 2026-10-03）—— 总成绩 / 胜率 / 大胡率 / 金顶率 / 总平均分 */
const PERIOD_LABEL = { day: '当日', month: '当月', year: '当年', all: '全部' };
let myStatsPeriod = 'all';
let myStatsCache = null;   // /my-stats 一次给全四种口径，切时段不再往返

async function openMyStats() {
  if (!S.club) return note('status-club', '先进入一个俱乐部');
  note('status-club', '加载我的战绩…');
  try {
    myStatsCache = null;
    renderMyStats();
    const box = $('mystats');
    if (box) box.hidden = false;
    const d = await api(`/api/clubs/${S.club.id}/my-stats`);
    myStatsCache = d.me || null;
    renderMyStats();
    note('status-club', '');
  } catch (e) {
    note('status-club', e.message);
  }
}

function renderMyStats() {
  const card = $('mystats-card');
  if (!card) return;
  card.innerHTML = '';

  const h = document.createElement('h3');
  h.textContent = '我的战绩';
  card.appendChild(h);

  const scope = document.createElement('div');
  scope.className = 'stats-tip';
  scope.textContent = '个人总成绩 · 不分俱乐部（在任何俱乐部打的都计入）';
  card.appendChild(scope);

  // 时段切换（日 / 月 / 年 / 全部）
  const tabs = document.createElement('div');
  tabs.className = 'stats-tabs';
  for (const key of ['day', 'month', 'year', 'all']) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'stats-tab' + (myStatsPeriod === key ? ' active' : '');
    b.textContent = PERIOD_LABEL[key];
    b.addEventListener('click', () => { myStatsPeriod = key; renderMyStats(); });
    tabs.appendChild(b);
  }
  card.appendChild(tabs);

  const s = myStatsCache && myStatsCache[myStatsPeriod];
  if (!s) {
    const loading = document.createElement('div');
    loading.className = 'stats-sub';
    loading.textContent = '加载中…';
    card.appendChild(loading);
  } else {
    const range = document.createElement('div');
    range.className = 'stats-sub';
    const fmt = (t) => (t ? new Date(t * 1000).toLocaleString('zh-CN', { hour12: false }) : '—');
    range.textContent = myStatsPeriod === 'all'
      ? `全部时间 · 共 ${s.hands} 把`
      : `${PERIOD_LABEL[myStatsPeriod]} ${fmt(s.from)} ~ ${fmt(s.to)}`;
    card.appendChild(range);

    const signed = (n, d = 0) => (n > 0 ? '+' : '') + Number(n).toFixed(d);
    const toneCls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

    // 头号数字：总成绩（累计净分）
    const net = document.createElement('div');
    net.className = 'stat-hero ' + toneCls(s.net);
    net.textContent = signed(s.net);
    const heroLab = document.createElement('div');
    heroLab.className = 'stat-hero-label';
    heroLab.textContent = '总成绩（累计净分）';
    card.appendChild(net);
    card.appendChild(heroLab);

    // 三个率 + 总平均分：老吴点名要的四个数，各占一格
    const grid = document.createElement('div');
    grid.className = 'stat-grid';
    const cell = (label, value, cls, tipText) => {
      const d = document.createElement('div');
      d.className = 'stat-cell';
      const v = document.createElement('b');
      v.textContent = value;
      if (cls) v.className = cls;          // 红涨绿跌挂在数值上（.stat-cell.pos 无样式）
      const l = document.createElement('span');
      l.textContent = label;
      d.appendChild(v);
      d.appendChild(l);
      if (tipText) d.title = tipText;   // 口径写进 title，避免界面上堆字
      return d;
    };
    grid.appendChild(cell('胜率', s.winRate + '%', '',
      `胡牌 ${s.wins} 把 ÷ 总局数 ${s.hands} 把`));
    grid.appendChild(cell('大胡率', s.bigHuRate + '%', '',
      `大胡 ${s.bigHus} 把 ÷ 总局数 ${s.hands} 把`));
    grid.appendChild(cell('金顶率', s.goldRate + '%', '',
      `金顶 ${s.goldTops} 把 ÷ 总局数 ${s.hands} 把`));
    grid.appendChild(cell('总平均分', signed(s.avgScore, 2), toneCls(s.avgScore),
      `总成绩 ${s.net} ÷ 总局数 ${s.hands} = 每局平均净分`));
    card.appendChild(grid);

    // 副指标：局数 / 胡牌 / 最高番 / 平均番 / 金顶 / 杠数
    const sub = document.createElement('div');
    sub.className = 'stat-grid';
    sub.appendChild(cell('总局数', s.hands));
    sub.appendChild(cell('胡牌', s.wins));
    sub.appendChild(cell('大胡', s.bigHus));
    sub.appendChild(cell('金顶', s.goldTops));
    sub.appendChild(cell('最高番', s.maxFan));
    sub.appendChild(cell('平均番', s.avgFan));
    sub.appendChild(cell('杠数', s.totalGangs));
    card.appendChild(sub);

    const tip = document.createElement('div');
    tip.className = 'stats-tip';
    tip.textContent = '三个率的分母都是该时段总局数（荒庄也计入）；总平均分 = 总成绩 ÷ 总局数。';
    card.appendChild(tip);

    if (s.hands === 0) {
      const empty = document.createElement('div');
      empty.className = 'stats-tip';
      empty.textContent = '该时段还没有对局记录。';
      card.appendChild(empty);
    }
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'stats-close';
  close.textContent = '关闭';
  close.addEventListener('click', () => { const b = $('mystats'); if (b) b.hidden = true; });
  card.appendChild(close);
}

/** 进入「改规则」：把该桌规则填进面板，建房按钮变「保存规则」 */
async function startEditRules(t) {
  editTableId = t.id;
  $('table-name').value = t.name;
  $('table-circle').value = String(t.circleCount);
  $('table-preset').value = (t.rules && t.rules.preset) || 'koukou';
  renderRulePanel($('rule-fields'), t.rules || null);
  $('btn-create-table').textContent = `保存规则（#${t.id}）`;
  note('status-club', '已载入该桌规则，改完点「保存规则」', true);
  $('rule-fields').closest('.rule-details').open = true;
  $('rule-fields').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** 退出改规则状态（保存成功后调用） */
function endEditRules() {
  editTableId = null;
  $('btn-create-table').textContent = '摆一桌';
  renderRulePanel($('rule-fields'), null);
}

async function createTable() {
  if (!S.club) return;
  const name = ($('table-name').value || '').trim();
  if (!name) return note('status-club', '先填牌桌名称');
  const circleCount = Number($('table-circle').value) || 1;
  const preset = $('table-preset').value || 'koukou';
  const rules = collectRulePanel($('rule-fields'));
  rules.preset = preset; // ❗后端 buildRuleSet 用 rules.preset 决定 openMode / 起胡门槛
  note('status-club', editTableId ? '保存中…' : '摆桌中…');
  try {
    if (editTableId) {
      // 改规则（仅房主 + idle/waiting，后端校验）
      await api(`/api/tables/${editTableId}/rules`, 'PATCH', { rules, circleCount });
      endEditRules();
      const d = await api(`/api/clubs/${S.club.id}/tables`);
      renderTables(d.tables || []);
      note('status-club', '规则已更新', true);
      return;
    }
    await api(`/api/clubs/${S.club.id}/tables`, 'POST', { name, circleCount, rules });
    $('table-name').value = '';
    const d = await api(`/api/clubs/${S.club.id}/tables`);
    renderTables(d.tables || []);
    note('status-club', '已摆好，点「进桌」入座', true);
  } catch (e) {
    note('status-club', e.message);
  }
}

async function addMember() {
  if (!S.club) return;
  const username = ($('member-name').value || '').trim();
  if (!username) return note('status-club', '先填成员昵称');
  const role = $('member-role').value || 'member';
  try {
    await api(`/api/clubs/${S.club.id}/members`, 'POST', { username, role });
    $('member-name').value = '';
    note('status-club', `已把 ${username} 加入俱乐部`, true);
    await openClub(S.club.id);
  } catch (e) {
    note('status-club', e.message);
  }
}

/* ------------------------------------------------------------------ */
/* ④ 入座 + 打牌                                                       */
/* ------------------------------------------------------------------ */

async function enterTable(tableId) {
  const d = await api(`/api/tables/${tableId}`);
  S.table = d.table;
  S.tableId = tableId;
  S.room = null;
  S.view = null;
  // 记下「我在哪桌」：页面被回收 / 误关后重新进来要能直接回桌（老吴 2026-10-30）
  saveLastTable(tableId, S.table.clubId ?? S.club?.id);

  const preset = (S.table.rules && S.table.rules.preset) || 'koukou';
  $('table-title').textContent = S.table.name;
  $('table-sub').innerHTML =
    `编号 ${tableId} · ${S.table.circleCount} 圈（${S.table.circleCount * 4} 把）· ${PRESET_NAME[preset] || preset} · 四人齐 + 全部「准备」即开局`;
  renderRoomBar();
  renderWhoami();
  showLobby('table-view');

  ensureSocket();
  // 把 ack 交给调用方：自动回桌要靠它判断「座位还在不在」，失败就退回俱乐部
  return await joinTable(tableId);
}

/**
 * 断线 / 重开页面后自动回桌（老吴 2026-10-30：不要停在俱乐部页）。
 * 依次尝试：本地记录 → 俱乐部上下文（离桌要能退回去）→ 直接进桌 + join。
 * 任何一步失败都清掉记录、安静落回俱乐部列表，绝不卡在「正在回桌」的半途。
 * @returns {Promise<boolean>} 是否真的回到了牌桌
 */
async function resumeLastTable() {
  const last = readLastTable();
  if (!last) return false;
  // 俱乐部上下文：不先设好，牌桌页里的「返回俱乐部 / 离桌」就得从头再查一遍
  const club = (S.clubs || []).find((c) => c.id === last.clubId);
  if (!club) { clearLastTable(); return false; }   // 俱乐部没了 / 已被移出
  S.club = { id: club.id, name: club.name, role: club.role };
  try {
    const ack = await enterTable(last.tableId);
    if (!ack || ack.error) throw new Error((ack && ack.error) || '入桌失败');
    note('status-table', ack.reconnected ? `已回到牌桌（座位 ${ack.seat}）` : '已进入牌桌', true);
    return true;
  } catch (e) {
    clearLastTable();
    S.club = null;
    S.tableId = null;
    S.table = null;
    showLobby('clubs');
    note('status-clubs', `上次的牌桌已不可用（${e.message}），已回到俱乐部列表`);
    return false;
  }
}

/** 建 socket（幂等）并接上所有服务端事件 */
function ensureSocket() {
  if (S.socket) return S.socket;
  const socket = ioFactory({ path: '/play', auth: { token: S.token } });
  S.socket = socket;

  socket.on('connect', () => {
    note('status-table', '已连接服务器', true);
    // 自动重连成功后必须重新 join 才能拿回座位与最新视图（服务端 join 幂等）
    if (!S.tableId) return;
    joinTable(S.tableId, true).then((ack) => {
      // 牌桌已经被解散 / 座位被别人占了：别把用户钉在一张假的牌桌上
      if (ack && ack.error) leaveTable().catch(() => showLobby('clubs'));
    });
  });
  socket.on('connect_error', (e) => note('status-table', '连接失败：' + ((e && e.message) || e)));
  socket.on('disconnect', (r) =>
    note('status-table', `连接断开（${r}），正在自动重连…`));
  socket.on('connected', (p) => {
    if (p && p.user) {
      S.user = p.user;
      renderWhoami();
    }
  });

  socket.on('table:players', (p) => {
    S.room = p;
    touchLastTable();   // 还在桌上 → 刷新「上次牌桌」时间戳（长局不因 TTL 被丢）
    renderRoomBar();
    renderHostControls();
    if (exitGame) exitGame.sync(p.exitVote || null);
    // 在线状态的唯一实时来源：断线/重连都会广播这一帧（不依赖下一帧 state）
    if (lobbyOpts.applyPlayers) lobbyOpts.applyPlayers(p);
    // 未开局 → 留在大厅看座位；已开局但还没收到 state → 过渡提示
    // 老吴 2026-10-31：终局最后一把的「本局结算」和「本场总结」必须继续浮在**游戏页**上
    // （此前 room 结算完 started=false 广播 players，这里无条件 showLobby 把背景切回
    //  大厅，结算页因此变成竖屏）。拦截条件：
    //  ① S.tableFinished —— table:finished 先于本帧 players 到达（server/ws/index.js
    //     emitSettled：先 emit table:finished 再 broadcastPlayers），打满局数时已置位；
    //  ② 结算窗(#settle)/本场总结(#exitsummary)还开着 —— 兜住投票散场（table:exited）
    //     等不走 table:finished 的路径。
    if (!p.started) {
      const st = $('settle');
      const sm = $('exitsummary');
      const settleOpen = !!(st && !st.hidden) || !!(sm && !sm.hidden);
      if (!S.tableFinished && !settleOpen) showLobby('table-view');
    } else if (!S.driver || !S.driver.getView()) showWaiting(`第 ${p.handNo}/${p.totalHands} 把，正在发牌…`);
  });
  socket.on('table:started', (p) => {
    // handNo===1 表示新一场开始（重开也会回到 1）→ 清空本场战绩累计
    if (p && p.handNo === 1) {
      matchStats.reset();
      if (exitGame) exitGame.reset();
      S.tableFinished = false;
      setNewGameLabel('准备下一局');
    }
    showWaiting(`第 ${p.handNo}/${p.totalHands} 把，正在发牌…`);
  });
  socket.on('table:state', onStatePayload);
  socket.on('table:handSettled', (p) => {
    note('status-table', `第 ${p.handNo} 把结束，点右上角「准备下一局」继续`, true);
    // 维度1/2/3：把这一把的 perSeat 喂给本场战绩聚合器
    if (p && p.result && Array.isArray(p.result.perSeat)) {
      matchStats.addHand(p.result.perSeat, p.handNo, p.result.type);
    }
  });
  socket.on('table:finished', (p) => {
    // 打满约定局数（老吴 2026-10-25）：结算窗按钮改「结束」，点击返回俱乐部首页
    S.tableFinished = true;
    setNewGameLabel('结束');
    renderAll(); // 结算窗已开着 → 立即重绘按钮文案（「准备下一局」→「结束」）
    note('status-table', `整场结束（共 ${p.totalHands} 把）—— 结算窗点「结束」返回俱乐部`, true);
    // 弹本场总成绩（总得分 / 胡牌 / 点炮 / 金顶）。
    // 老吴 2026-10-30：**先看完本局结算**再弹本场 —— showSummary 会在 #settle 还开着时先暂存，
    // 等玩家点掉本局结算（onNewGame 的「结束」分支）才真正弹出来。
    if (exitGame) {
      exitGame.showSummary({
        ...p,
        reason: 'finished',
        // 本场结算窗的按钮：点掉即离桌回俱乐部（此前它只是「返回牌桌」，牌桌其实已经结束了）
        onDone: () => leaveTable().catch(() => showLobby('clubs')),
      });
    }
  });

  // —— 退出游戏投票：发起 / 进度 / 拒绝 / 通过 / 自然结束作废 ——
  socket.on('table:exitRequested', (vote) => {
    if (exitGame) exitGame.sync(vote);
    if (vote) note('status-table', `${vote.fromName} 申请退出游戏，等待其他三家投票`, true);
  });
  socket.on('table:exitUpdated', (vote) => {
    if (exitGame) exitGame.sync(vote);
    if (vote) note('status-table', `退出申请：已同意 ${(vote.approvals || []).length}/${vote.needed || 3}`, true);
  });
  socket.on('table:exitRejected', (p) => {
    if (exitGame) exitGame.sync(null);
    flash(`${p.byName || '有玩家'} 不同意退出，牌局继续`);
    note('status-table', `${p.byName || '有玩家'} 不同意退出，牌局继续`);
  });
  socket.on('table:exitCancelled', (p) => {
    if (exitGame) exitGame.sync(null);
    const reason = (p && p.reason) || '';
    const msg = reason === 'disconnect'
      ? `${(p && p.byName) || '有玩家'} 断线，退出申请已取消`
      : reason === 'leave'
      ? `${(p && p.byName) || '有玩家'} 已离开，退出申请已取消`
      : '本场已自然结束，退出申请自动作废';
    note('status-table', msg, reason === 'finished');
  });
  socket.on('table:exited', (p) => {
    if (exitGame) exitGame.showSummary(p);
    /* 整场已被投票结束（老吴 2026-10-30）：这张桌不再有「进行中的牌局」，
       清掉回桌记录，免得下次开页面又把人拽回一张空桌。 */
    clearLastTable();
    if (S.driver) {
      try { S.driver.detach(); } catch (_) { /* 忽略 */ }
      S.driver = null;
    }
    S.view = null;
    note('status-table', `本场已结束（按已完成 ${p.completedHands || 0} 把结算）`, true);
  });

  // —— 长断线：手动托管 / 取消托管（服务端发起，前端只做提示 + 复位本地视图） ——
  socket.on('table:absent', (p) => {
    if (!p) return;
    // 手动取消托管：把座位交还给本人（或继续等其重连）
    if (p.manual && p.on === false) {
      const who = (p.usernames || []).join('、') || '该座位';
      note('status-table', `${who} 已取消托管，等待本人回来 / 继续`, true);
      return;
    }
    const who = (p && p.usernames) || [];
    if (!who.length) return;
    note('status-table', `${who.join('、')} 已被托管，由服务器代打（牌局继续）`, true);
  });
  socket.on('table:resumed', (p) => {
    if (!p) return;
    note('status-table', `${p.username} 已回到座位，托管结束`, true);
    // 本人回来时牌可能已被代打若干步 → 立刻补拉一帧最新视图，避免界面停在旧状态
    if (S.tableId && (!S.driver || p.seat === S.driver.MY_SEAT)) joinTable(S.tableId, true);
  });
  // 2026-10-17：删除 table:dissolved 处理 —— 服务端「自动判离席」已移除，该事件不再发出。
  socket.on('error', (e) => flash((e && e.msg) || '服务端错误'));
  return socket;
}

/**
 * 服务端每把牌的一帧状态。
 * 首帧用来创建 driver（后续帧喂给 driver.push，由它的监听器触发重绘）。
 */
function onStatePayload(p) {
  if (!p || typeof p.seat !== 'number' || !p.view) return;
  if (!S.driver) {
    S.driver = createNetDriver({ socket: S.socket, initial: p });
    setGame(S.driver);
    S.driver.onState(applyPayload);
    applyPayload(p);
    return;
  }
  S.driver.push(p);
}

function applyPayload(p) {
  setMySeat(p.seat);
  setModeLabel(`网络 · 第 ${p.handNo}/${p.totalHands} 把`);
  S.view = p.view;
  setView(p.view);
  renderAll();
  renderRoomBar();
  showPlay();
  // 入口扩展点：3D 版在这里把 view 喂给 render3d、更新癞子徽标、搬运 HUD
  if (lobbyOpts.applyView) lobbyOpts.applyView(p.view);
}

function joinTable(tableId, silent = false) {
  return new Promise((resolve) => {
    if (!S.socket) return resolve(null);
    S.socket.emit('table:join', { tableId: Number(tableId) }, (ack) => {
      if (!ack || ack.error) {
        const msg = (ack && ack.error) || '入桌失败';
        note('status-table', msg);
        flash(msg);
      } else if (!silent) {
        const seat = `已回到原座位（${ack.seat}）`;
        if (ack.wasAbsent) note('status-table', `${seat}，托管已撤销，牌局交还给你`, true);
        else note('status-table', ack.reconnected ? seat : `已入座（座位 ${ack.seat}）`, true);
      }
      resolve(ack);
    });
  });
}

/** 离开牌桌：退订驱动 + 通知服务端保留座位（服务端只标未连接，重连能回到原座位） */
async function leaveTable() {
  if (S.driver) {
    try { await S.driver.leave(); } catch (_) { /* 忽略 */ }
    S.driver = null;
  }
  // 主动离桌 = 不再自动回桌（否则下次开页面又被拽回这张桌）
  clearLastTable();
  S.tableId = null;
  S.room = null;
  S.view = null;
  S.table = null;
  if (exitGame) exitGame.reset();
  // 老吴 2026-10-28：离桌必须同步关掉结算弹窗 —— #settle 是 body 级弹窗，
  // showLobby 只切 #lobby/#play/#waiting 管不到它。留着的话它会盖在大厅上，
  // 再点一次「结束」就落进 readyUp() 报「还没进入牌桌」，且这个弹窗再也关不掉。
  // setView(null) 让 renderSettle 的既有逻辑（!v → box.hidden = true）兜底；
  // 这里不能调 renderAll()（view 为 null 时它读 state.view.phase 会崩），直接 hidden 立即生效。
  setView(null);
  const st = $('settle');
  if (st) st.hidden = true;
  if (S.club) await openClub(S.club.id).catch(() => showLobby('clubs'));
  else showLobby('clubs');
  renderWhoami();
}

/* ------------------------------------------------------------------ */
/* 准备下一局 / 重新开局                                                */
/* ------------------------------------------------------------------ */

/**
 * 经 socket 直接发「准备」（仅用 socket，不依赖 S.driver）。
 * 开局前（牌桌大厅）S.driver 还没创建，必须走这条路；与 net-driver.ready() 行为一致。
 */
function readyViaSocket(socket) {
  return new Promise((resolve, reject) => {
    socket.emit('table:ready', {}, (ack) => {
      if (ack && ack.error) reject(new Error(ack.error));
      else resolve(ack || {});
    });
  });
}

async function readyUp() {
  try {
    if (S.driver) {
      // 牌局进行中 / 已结算 → 走驱动（准备下一局）
      resetSelection();
      await S.driver.ready();
    } else if (S.socket && S.tableId) {
      // 牌桌大厅、尚未开局 → S.driver 此时为 null，直接发 ready
      await readyViaSocket(S.socket);
    } else {
      return flash('还没进入牌桌');
    }
    note('status-table', '已准备，等其他人…', true);
  } catch (e) {
    flash(e.message);
  }
}

/**
 * 单人验证便利：往空位补一个「服务端机器人」并自动准备，一个人也能开局看牌桌。
 * 仅在牌桌大厅（未开局）可用；机器人由服务端用 decide() 代打，行为与「托管」完全一致
 * （absent=true / ready=true），所以不新增任何对局规则分支。
 */
async function addBot() {
  try {
    if (!S.socket || !S.tableId) return flash('还没进入牌桌');
    if (S.driver && S.driver.getView()) return flash('牌局已开始，无法补位');
    const ack = await new Promise((resolve, reject) => {
      S.socket.emit('table:addBot', {}, (r) => (r && r.error ? reject(new Error(r.error)) : resolve(r || {})));
    });
    note('status-table', `已加入机器人（座位 ${(ack.seat ?? 0) + 1}）`, true);
  } catch (e) {
    flash(e.message);
  }
}

/* ------------------------------------------------------------------ */
/* 房间状态条（大厅座位 + 牌桌顶栏）                                     */
/* ------------------------------------------------------------------ */

/**
 * 某座位要不要显示「托管」按钮、显示什么文案。
 *   · 已托管      → 「取消托管」（把控制权交还本人 / 等其重连）
 *   · 断线未托管  → 「我要尿尿」（任何在线玩家都能托管这个断线座位，牌局得以继续）
 *   · 本人（在线）→ 「我要尿尿」自托管：我要走开一下，让服务器替我打
 *   · 其他在线玩家 → 不显示（不能托管在线的别人）
 *
 * ⚠️ 这三个函数必须是**模块顶层**声明：调用方在 `ensureSocket()` 里（第 803 行），
 *   早于 `renderRoomBar()`。早前它们被误放在 `renderRoomBar` 函数体内，
 *   esbuild 打包时把声明重命名为 `renderHostControls2` 却改不到调用点 →
 *   运行期 `renderHostControls is not defined`（由 NET viewport-check 抓出）。
 */
function hostControlFor(seat, p, myUid) {
  if (!p) return null;
  if (p.bot) return null; // 机器人不是「人」：不提供托管 / 取消托管
  if (p.absent) return { label: '取消托管', on: false };
  if (!p.connected) return { label: '我要尿尿', on: true };
  if (p.uid === myUid) return { label: '我要尿尿', on: true };
  return null;
}

/** 发起托管 / 取消托管（走 table:setAbsent；服务端做最终权限校验） */
function hostSeat(seat, on) {
  if (!S.socket) return;
  S.socket.emit('table:setAbsent', { seat, on }, (ack) => {
    if (!ack || ack.error) flash((ack && ack.error) || '托管操作失败');
  });
}

/** 牌桌顶栏的托管控制条（开局后常驻可见）：把可托管的座位列成按钮 */
function renderHostControls() {
  const box = $('host-controls');
  if (!box || !S.room) return;
  box.innerHTML = '';
  const myUid = S.user && S.user.id;
  let any = false;
  (S.room.players || []).forEach((p, seat) => {
    const h = hostControlFor(seat, p, myUid);
    if (!h) return;
    any = true;
    const btn = document.createElement('button');
    btn.className = 'host-btn' + (h.on ? '' : ' off');
    btn.type = 'button';
    btn.textContent = h.label;   // 老吴 2026-10-28：只显示「我要尿尿 / 取消托管」，不带用户名
    btn.addEventListener('click', () => hostSeat(seat, h.on));
    box.appendChild(btn);
  });
  box.hidden = !any;
}

function renderRoomBar() {
  const r = S.room;
  const seatsBox = $('table-seats');
  const statusBox = $('room-status');
  const btn = $('btn-ready');
  const botBtn = $('btn-add-bot');
  const exitBtn = $('exitgame');

  if (!r) {
    if (seatsBox) seatsBox.innerHTML = '';
    if (statusBox) statusBox.textContent = '';
    if (botBtn) botBtn.hidden = true;
    return;
  }

  const s2d = windsFromDealer(r.dealer || 0).seatToDir;
  const myUid = S.user && S.user.id;

  if (seatsBox) {
    seatsBox.innerHTML = '';
    for (let s = 0; s < 4; s++) {
      const p = r.players[s];
      const dir = dirOf(s, s2d);
      const el = document.createElement('div');
      el.className = 'lb-seat' + (p ? (p.connected ? '' : ' off') : ' empty');
      const badge = `<span class="dir-badge mini dir-${dir}">${dir}</span>`;
      if (!p) {
        el.innerHTML = `<div class="lb-seat-top">${badge}空位</div><div class="lb-seat-meta">等人入座…</div>`;
      } else {
        // 四态互斥：机器人 > 托管（服务器代打）> 断线（还在等本人回来）> 在线
        const isBot = !!p.bot;
        const state = isBot
          ? ' · <span class="lb-host">机器人</span>'
          : p.absent
          ? ' · <span class="lb-host">托管中</span>'
          : p.connected
          ? ''
          : ' · <span class="lb-off">断线</span>';
        const readyTxt = isBot
          ? '<span class="lb-ready">已准备</span>'
          : p.absent
          ? `<span class="lb-ready">已托管</span>`
          : p.ready
          ? '<span class="lb-ready">已准备</span>'
          : '未准备';
        const av = p.avatar && p.avatar.type === 'preset' ? `<span class="lb-avatar">${p.avatar.value}</span>` : '';
        el.innerHTML =
          `<div class="lb-seat-top">${badge}${isBot ? '🤖 ' : ''}${av}${esc(p.username)}${p.uid === myUid ? '（我）' : ''}</div>` +
          `<div class="lb-seat-meta">${readyTxt}${state}</div>`;
        // 托管按钮：断线座位（任何在线玩家可托管）/ 本人（自托管暂离）/ 已托管（取消托管）
        const h = hostControlFor(s, p, myUid);
        if (h) {
          const btn = document.createElement('button');
          btn.className = 'lb-host-btn';
          btn.type = 'button';
          btn.textContent = h.label;
          btn.addEventListener('click', () => hostSeat(s, h.on));
          el.appendChild(btn);
        }
      }
      seatsBox.appendChild(el);
    }
  }

  if (statusBox) {
    const names = r.players
      .filter(Boolean)
      .map((p) => `${esc(p.username)}${p.absent ? '🤖' : p.ready ? '✔' : '·'}`)
      .join('　');
    statusBox.innerHTML = `第 <b>${r.handNo}</b>/${r.totalHands} 把 · ${r.circleCount} 圈 · 庄：${dirOf(r.dealer || 0, s2d)}<br />${names}`;
  }

  if (btn) {
    const me = (S.user && r.players.find((p) => p && p.uid === S.user.id)) || null;
    const revealPending = !!(S.view && S.view.reveal && S.view.reveal.pending);
    // 整场打完 → 顶栏「准备」无意义，直接隐藏（结算窗走「结束」返回俱乐部）
    btn.hidden = !!r.finished;
    btn.disabled = !!(me && me.ready) || revealPending;
    btn.textContent = revealPending ? '请先确认摊牌' : me && me.ready ? '已准备（等人齐）' : r.started ? '准备下一局' : '准备';
  }

  // 「退出游戏」：只在牌局进行中/等下一把时出现；已有申请时禁用，避免重复发起。
  if (exitBtn) {
    exitBtn.hidden = !r.started || r.finished;
    exitBtn.disabled = !!r.exitVote;
  }

  // 「加机器人」：仅在大厅、我已入座、且还有空位时可用
  if (botBtn) {
    const myUid2 = S.user && S.user.id;
    const iSeated = S.user && r.players.some((p) => p && p.uid === myUid2);
    const hasEmpty = r.players.some((p) => !p);
    botBtn.hidden = !(!r.started && iSeated && hasEmpty);
  }
}

/* ------------------------------------------------------------------ */
/* 事件接线                                                            */
/* ------------------------------------------------------------------ */

function wire() {
  // 网络版：牌桌是四人共享的，结算弹窗那颗按钮只让自己「准备」，不是立刻重开
  setNewGameLabel('准备下一局');

  exitGame = createExitGame({
    getSocket: () => S.socket,
    getSeat: () => {
      if (S.driver) return S.driver.MY_SEAT;
      const i = (S.room && S.room.players || []).findIndex((p) => p && S.user && p.uid === S.user.id);
      return i >= 0 ? i : -1;
    },
    getRoom: () => S.room,
    onNote: (msg, ok) => note('status-table', msg, ok),
  });

  $('btn-enter').addEventListener('click', () => authSubmit());
  $('auth-confirm').addEventListener('keydown', (e) => { if (e.key === 'Enter') authSubmit(); });
  for (const b of document.querySelectorAll('.js-avatar-save')) {
    b.addEventListener('click', () => savePickedAvatar());
  }
  const gateSave = $('btn-avatar-gate-save');
  if (gateSave) {
    gateSave.addEventListener('click', async () => {
      if (!pickedAvatar) return note('status-gate', '先在上面点一个头像');
      try {
        const d = await api('/api/me/avatar', 'PUT', { type: 'preset', value: pickedAvatar });
        S.user.avatar = d.avatar;
        renderWhoami();
        note('status-gate', '');
        showLobby('clubs');
        await loadClubs();
      } catch (e) {
        note('status-gate', e.message);
      }
    });
  }
  $('whoami').addEventListener('click', () => toggleAvatarPop());
  loadAvatarPicker();
  $('auth-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') auth('login'); });
  $('btn-logout').addEventListener('click', logout);
  $('btn-create-club').addEventListener('click', createClub);
  $('club-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') createClub(); });
  $('btn-back-clubs').addEventListener('click', () => { S.club = null; showLobby('clubs'); loadClubs(); });
  // 入会申请「刷新」按钮（2026-10-30）：主席开页时别人刚提交的申请，点一下就能看到
  const refreshAppsBtn = $('btn-refresh-apps');
  if (refreshAppsBtn) refreshAppsBtn.addEventListener('click', () => refreshApplications());
  $('btn-back-clubs2').addEventListener('click', () => {
    leaveTable().catch(() => { S.club = null; showLobby('clubs'); });
  });
  $('btn-add-member').addEventListener('click', addMember);
  $('member-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') addMember(); });
  $('btn-create-table').addEventListener('click', createTable);
  $('table-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') createTable(); });
  $('btn-mystats').addEventListener('click', () => openMyStats().catch((e) => note('status-club', e.message)));
  $('btn-history').addEventListener('click', () => openHistory().catch((e) => note('status-club', e.message)));
  // 成员区展开/收起（默认收起，老吴 2026-10-24）
  const leaveClubBtn = $('btn-leave-club');
  if (leaveClubBtn) leaveClubBtn.addEventListener('click', leaveClub);
  const delClubBtn = $('btn-delete-club');
  if (delClubBtn) delClubBtn.addEventListener('click', deleteClub);
  $('btn-toggle-members').addEventListener('click', () => {
    const box = $('members-box');
    if (box) box.hidden = !box.hidden;
  });
  for (const id of ['history', 'mystats']) {
    const b = $(id);
    if (b) b.addEventListener('click', (e) => { if (e.target === b) b.hidden = true; });
  }
  $('btn-ready').addEventListener('click', () => readyUp());
  const botBtnEl = $('btn-add-bot');
  if (botBtnEl) botBtnEl.addEventListener('click', () => addBot());
  $('btn-leave').addEventListener('click', () => leaveTable().catch(() => showLobby('clubs')));
  const exitBtnEl = $('exitgame');
  if (exitBtnEl) exitBtnEl.addEventListener('click', () => exitGame && exitGame.request());

  // 牌桌驱动：render.js 只负责画，推进全部交给 net-driver
  replayApi = initReplay({
    getClub: () => S.club,
    getUser: () => S.user,
    onExit: (view) => showLobby(view === 'clubs' ? 'clubs' : 'club'),
  });

  if (lobbyOpts.initSkin) lobbyOpts.initSkin();

  initRender({
    onNewGame: () => {
      // 约定局数打完后（老吴 2026-10-25）：结算窗「结束」→ 离桌返回俱乐部首页
      if (S.tableFinished) {
        S.tableFinished = false;
        setNewGameLabel('准备下一局');
        // 老吴 2026-10-30：本场结束时**先本局、后本场** —— 这一下点击是「确认本局」，
        // 若本场总结算在排队，先把它弹出来（它的按钮负责真正离桌），不要直接回大厅。
        if (exitGame && exitGame.showPendingSummary()) return;
        leaveTable().catch(() => showLobby('clubs'));
        return;
      }
      readyUp();
    },
    onAction: async (action) => {
      if (!S.driver) throw new Error('还没进入牌桌');
      await S.driver.act(action); // 成功 → 服务端广播 table:state → applyPayload 重绘
    },
  });
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  wire();
  // 网络版没有摸风面板（驱动 winds.entries = null），#winds 在 net.html 里就是 hidden，
  // 这里**不要**调 render.js 的 renderWinds()——它在 setGame 之前会读 null.winds 直接抛错。

  const saved = (() => { try { return localStorage.getItem(LS_TOKEN) || ''; } catch (_) { return ''; } })();
  if (saved) {
    S.token = saved;
    try {
      const d = await api('/api/me');
      S.user = d.user;
      renderWhoami();
      /* 断线 / 页面被系统回收后重新进来（老吴 2026-10-30）：直接回上次那张牌桌，
         不要求用户再从「俱乐部 → 牌桌」点两层。回不去就安静留在俱乐部列表。
         ⚠️ 有回桌记录时**先别展开俱乐部页**：否则会先闪一下俱乐部列表再跳进牌桌，
         体感仍然是「进了页面停在俱乐部」。这里只挂一条 waiting 提示，
         等 resumeLastTable 拿到结果再决定给牌桌还是给列表。 */
      const last = readLastTable();
      if (last) {
        $('lobby').hidden = true;
        showWaiting('正在回到上一张牌桌…');
      } else {
        showLobby('clubs');
      }
      await loadClubs();
      if (last && !(await resumeLastTable())) showLobby('clubs');
      return;
    } catch (_) {
      clearToken(); // 令牌过期 → 回登录页
    }
  }
  renderWhoami();
  showLobby('auth');
}

/**
 * 启动网络大厅（2D / 3D 两个入口共用；谁 import 谁，素材就只进谁的包）。
 * @param {object} [opts]
 *   initSkin()   皮肤选择器接线（必注入：tile-skin / tile-skin3d 各带近 1MB 素材）
 *   applyView(v) 每帧视图 renderAll 之后的追加动作（3D 版喂 render3d / 搬 HUD）
 *   applyPlayers(p) 每帧 `table:players` 之后的追加动作（3D 版据此更新「谁掉线了」）
 * @returns {{S: object, applyPayload: Function, enterTable: Function, readyUp: Function}}
 *   调试 / 自动化出口用的句柄（window.__net3d 等从这里取）
 */
export function bootNetLobby(opts = {}) {
  lobbyOpts = opts;
  boot();
  return {
    S, applyPayload, enterTable, readyUp, resumeLastTable,
    openReplay: replayApi?.openReplay,
    // 自动化出口（getter：exitGame 是在 wire() 里才创建的，取的时候才求值）：
    //   `__net3d.exitGame` 用来断言「本场结束时先本局、后本场」的弹出顺序。
    get exitGame() { return exitGame; },
  };
}
