#!/usr/bin/env node
/**
 * 网络版（net3d）视口量测：用无头 Chrome + CDP 在多种宽度下渲染 frontend/build/net3d.html，
 * 注入假 socket / 假 fetch，把「登录 → 俱乐部 → 进桌 → 准备 → 开局 → 抢杠胡 → 结算」
 * 整条路径走一遍，每段量一次横向溢出。
 *
 * 为什么不能用 `chrome --headless --window-size=390,...`：
 *   headless Chrome 会把窗口宽度**钳到最小 500px**，截出来是裁剪版，
 *   于是「明明是 390 视口」却被量成「无溢出」的假阴性。
 *   必须走 CDP 的 Emulation.setDeviceMetricsOverride 才能真正控制视口。
 *
 * 除了横向溢出，还查一条通用不变量：
 *   **带 `hidden` 属性的元素必须真的不参与布局**。作者样式里的 `display:flex`
 *   会压过浏览器默认的 `[hidden]{display:none}` → `el.hidden = true` 形同虚设。
 *   （老吴 2026-10-02 就这么撞上 `#waiting` 全屏遮罩常驻，网络版牌桌被整页盖住。）
 *
 * 为什么要跑两遍（桌面 / 移动）：
 *   · 桌面模式（mobile:false）不会替内容「兜底」→ `scrollWidth > innerWidth`
 *     就是**真实溢出量**，这是判定依据。
 *   · 移动模式（mobile:true）Chrome 会把 layout viewport 撑宽到内容的最小宽度，
 *     于是 `scrollWidth === innerWidth`，**看着没溢出**（假阴性）。
 *     但它撑到的那个数值恰好等于「内容最小宽度」，是很好的诊断信号：
 *     一旦 > 请求宽度，说明真机上整页会被缩小。
 *
 * 用法：
 *   node frontend/build.mjs
 *   node tools/viewport-check.mjs                      # 默认 390 / 720（高 860，竖屏）
 *   node tools/viewport-check.mjs 360 390 414 720
 *   node tools/viewport-check.mjs 844x390 667x375 800x360   # **手机横屏**（宽x高）
 *       ⚠️ 横屏只有 360~430 高，**纵向**比横向更容易撑破 → 每档同时量
 *       `scrollWidth-innerWidth`（横溢）与 `scrollHeight-innerHeight`（纵溢），任一 > 0 即失败。
 *       ❗**纵溢只在横屏算失败**（`w > h`）：竖屏那套「四家上下堆叠」本来就是 ~970px 高，
 *         在 860 高的视口里必然要滚 —— 那是竖屏的正常交互；横屏的硬要求才是「一屏放得下」。
 *       真机横屏档参考：375（iPhone SE2/3）·393/412/430（iPhone 15/安卓）·360（多数安卓）·320（老 SE1）。
 *   ROUNDS=5 node tools/viewport-check.mjs 844x390            # 每档连打 5 局（NET 模式下 ROUNDS 仅影响截图命名，不驱动对局）
 *   SHOT_DIR=/tmp/shots node tools/viewport-check.mjs
 *
 * 退出码 0 = 全部无溢出；1 = 有溢出；2 = 环境缺失。
 *
 * 注：本工具只量**网络版**页面（build/net3d.html）。单机版已废弃，相关驱动脚本已移除。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { createGame, act, viewFor, legalActions } from '../src/engine/game.js';
import { createRuleSet } from '../src/engine/rules.js';
import { analyzeTenpai } from '../src/engine/tenpai.js';
import { decide } from '../src/bot/simpleBot.js';
import { makeTile, WHITE_DRAGON } from '../src/engine/tiles.js';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
/** 网络版页面（frontend/build/net3d.html：大厅 + 牌桌 + 结算弹窗）。
 *  网络版没有「本地引擎自己打」这条链路，所以走另一条驱动：注入假 socket / 假 fetch，
 *  把大厅点到底、再推几帧真实引擎造的 table:state，逐段量横向溢出。 */
const BUILD_HTML = new URL('../frontend/build/net3d.html', import.meta.url).pathname;
const SHOT_DIR = process.env.SHOT_DIR || '/tmp/mahjon-shots';
/* CDP 端口默认**每轮现取一个空闲端口**（见 freePort()），`CDP_PORT=…` 可钉死。 */
const ROUNDS = Math.max(1, Number(process.env.ROUNDS || 3));
/* 🔴 NET 模式：本工具只服务于网络版（单机版已废弃）。 */

/**
 * 视口档：`宽` 或 `宽x高`（如 `390` / `844x390`）。
 * 不带高度时默认 860（沿用既有竖屏档），带高度就能量**手机横屏**（如 844x390 / 667x375）。
 */
const VIEWPORTS = process.argv.slice(2).map((s) => {
  const m = /^(\d+)(?:[x×](\d+))?$/i.exec(String(s).trim());
  if (!m) return null;
  return { w: Number(m[1]), h: Number(m[2] || 860) };
}).filter(Boolean);
if (VIEWPORTS.length === 0) VIEWPORTS.push({ w: 390, h: 860 }, { w: 720, h: 860 });
/** 兼容旧写法：只关心宽度的分支（报告标题等） */
const WIDTHS = VIEWPORTS.map((v) => v.w);

/**
 * 纵向溢出只在**横屏**档位算失败。
 * 原因：竖屏/桌面那套「四家上下堆叠」本来就是一千多像素高（实测 960~990），
 * 在 860 高的视口里**必然**要上下滚 —— 那是竖屏的正常交互，不是 bug。
 * 而手机横屏的硬要求恰恰相反：可用高度只有 360~430，必须**一屏放得下**。
 * 所以 `vOverflow` 只在 `w > h`（横屏）时报错，竖屏只打印出来当参考。
 */
const isLandscape = (w, h) => w > h;

if (!CHROME) {
  console.error('❌ 找不到 Chrome / Chromium。可设 CHROME_PATH=... 指定。');
  process.exit(2);
}
if (!existsSync(BUILD_HTML)) {
  console.error('❌ 找不到 ' + BUILD_HTML + '，先跑 `node frontend/build.mjs`。');
  process.exit(2);
}
/* 目录已在就不要再 mkdir：除了省一次系统调用，更因为某些沙箱/CI 环境
   （比如 WorkBuddy 的文件代理）会**无条件拒绝** mkdir 而不管它其实已存在，
   于是「目录明明在、脚本却起不来」。先判存在再建最稳。 */
if (!existsSync(SHOT_DIR)) mkdirSync(SHOT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 统一的 `Runtime.evaluate` 封装。两个作用：
 *  ① **把页内真正的错误带出来**。CDP 在页内脚本抛错时不设 `result.value`，
 *     而是给一个 `exceptionDetails`；老代码直接 `JSON.parse(result.value)`，于是
 *     在慢机器上只会看到那句毫无信息量的 `SyntaxError: "[object Object]" is not valid JSON`
 *     （真实原因往往是页面还没加载出来 → `q('#auth-name')` 是 null → TypeError）。
 *  ② 顺手把「返回的不是字符串」也讲清楚。
 */
async function evalIn(send, expression, { awaitPromise = false } = {}) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    const where = d.lineNumber != null ? ` (行 ${d.lineNumber + 1})` : '';
    throw new Error('页内脚本抛错' + where + '：' + (d.exception?.description || d.text || JSON.stringify(d)));
  }
  return r.result.value;
}

/**
 * 轮询等待某个元素出现，再往下走。
 * 为什么不能 `Page.navigate` 之后死等一个固定 ms：CPU 被别的重任务挤占时（无头 Chrome
 * 视口扫描与 e2e 并行跑过就撞过），固定 sleep 会不够长，页内脚本就在「文档还没解析出
 * 目标元素」的时候启动了。轮询「节点存在」在慢机器上更稳、在快机器上还更快。
 */
async function waitFor(send, expr, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await evalIn(send, `!!(${expr})`)) return true; } catch { /* 文档还没就绪 */ }
    await sleep(120);
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 网络版：注入假 socket + 假 fetch，然后按「登录 → 俱乐部 → 进桌 →
 * 开局帧 → 抢杠胡响应帧 → 结算帧」逐段走，并在每段量一次横向溢出。
 * 真实链路（REST/WS）已由 tools/verify-net-e2e.mjs 覆盖；这里只关心布局。
 * ------------------------------------------------------------------ */
const NET_STUB = `(() => {
  const handlers = new Map();
  const routes = [
    [/^\\/api\\/me$/, { user: { id: 1, username: 'hero' } }],
    [/^\\/api\\/auth\\/exists$/, { exists: true }],
    [/^\\/api\\/auth\\/(login|register)$/, { token: 'tok', user: { id: 1, username: 'hero' } }],
    [/^\\/api\\/clubs$/, { clubs: [{ id: 1, name: '武汉老友俱乐部（很长很长的名字用来压布局）', ownerId: 1, role: 'owner' }] }],
    [/^\\/api\\/clubs\\/\\d+$/, { club: { id: 1, name: '武汉老友俱乐部' }, members: [
      { id: 1, username: 'hero', role: 'owner' },
      { id: 2, username: '一个非常非常长的昵称用来撑破布局试试看', role: 'admin' },
    ] }],
    [/^\\/api\\/clubs\\/\\d+\\/tables$/, { tables: [
      { id: 9, name: '一号桌（周末晚场）', circleCount: 2, status: 'idle', rules: { preset: 'koukou' } },
    ] }],
    [/^\\/api\\/tables\\/\\d+$/, { table: { id: 9, clubId: 1, name: '一号桌（周末晚场）', circleCount: 2, status: 'idle', rules: { preset: 'koukou' } } }],
  ];
  window.fetch = async (url, opts) => {
    const path = String(url).replace(/^https?:\\/\\/[^/]+/, '');
    for (const [re, data] of routes) {
      if (re.test(path)) return { ok: true, status: 200, json: async () => data };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'NET_STUB 未声明：' + path }) };
  };
  window.__MAHJON_IO__ = () => {
    const h = new Map();
    const s = {
      id: 'fake',
      on(ev, fn) { if (!h.has(ev)) h.set(ev, new Set()); h.get(ev).add(fn); return s; },
      off(ev, fn) { const x = h.get(ev); if (x) x.delete(fn); return s; },
      emit(ev, p, cb) {
        if (typeof cb === 'function') {
          setTimeout(() => cb(ev === 'table:join' ? { ok: true, seat: 0, reconnected: false } : { ok: true }), 0);
        }
        return s;
      },
      fire(ev, p) { for (const fn of [...(h.get(ev) || [])]) fn(p); },
    };
    window.__sock = s;
    return s;
  };
})();`;

/** 页内驱动：逐段走大厅并在每段量一次溢出；帧数据由 Node 侧用真实引擎造好后注入 */
const netDriverSrc = (frames) => `(async () => {
  const q = (s, r = document) => r.querySelector(s);
  const qa = (s, r = document) => [...r.querySelectorAll(s)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const F = ${JSON.stringify(frames)};

  const ov = () => {
    const vw = window.innerWidth;
    /* 祖先可横向滚动 ⇒ 子元素超出不算 bug（同单机版 inScrollableX）：
       #me-hand{overflow-x:auto} 是有意设计，响应期 14 张装不下就该横滑。 */
    const inScrollableX = (el) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll')
          && p.scrollWidth > p.clientWidth + 1) return true;
      }
      return false;
    };
    const badEls = qa('body *').filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.right > vw + 0.5 && !inScrollableX(el);
    });
    const bad = badEls.slice(0, 6).map((el) => (el.id ? '#' + el.id : el.className || el.tagName));
    // 带 hidden 的元素不得仍在参与布局（否则「该藏的没藏住」，例如 #waiting 全屏遮罩）
    const hiddenLeak = qa('[hidden]').filter((el) => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }).map((el) => el.id || el.className || el.tagName);
    /* ❗纵向溢出的「元凶」清单：position:fixed 的元素**不参与** scrollHeight
       （它不产生文档滚动条），所以要分开列，否则会拿模态框去顶包。
       裸名 + bottom 值，排查时一眼看出是谁把页面撑高了。（本段在模板字面量里，禁反引号） */
    const nameOf = (el) => (el.id ? '#' + el.id : (typeof el.className === 'string' && el.className) || el.tagName);
    const vh = window.innerHeight;
    /* 顶栏高度单独量：网络版 .topbar 比单机版多一块 #room-status，
       它是「整页高 16px」的元凶（2026-10-01 实测定位）。（本段在模板字面量里，禁反引号） */
    const tbEl = document.querySelector('.topbar');
    const tbInfo = tbEl ? (Math.round(tbEl.getBoundingClientRect().height) + 'px@top' + Math.round(tbEl.getBoundingClientRect().top)
      + ' 左块=' + (tbEl.firstElementChild ? Math.round(tbEl.firstElementChild.getBoundingClientRect().height) + 'px' : '?')
      + ' 钮块=' + (tbEl.lastElementChild ? Math.round(tbEl.lastElementChild.getBoundingClientRect().height) + 'px' : '?')) : '无顶栏';
    const descends = (el) => { const r = el.getBoundingClientRect(); return r.height > 0 && r.bottom > vh + 0.5; };
    const vOffenders = qa('body *').filter((el) => {
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.position !== 'fixed' && descends(el);
    }).slice(0, 20).map((el) => { const r = el.getBoundingClientRect(); return nameOf(el) + '[' + Math.round(r.top) + '~' + Math.round(r.bottom) + ']'; });
    const fixedOver = qa('body *').filter((el) => {
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.position === 'fixed' && descends(el);
    }).slice(0, 6).map((el) => nameOf(el) + '@' + Math.round(el.getBoundingClientRect().bottom));
    return {
      vw, vh: window.innerHeight,
      scrollW: document.documentElement.scrollWidth,
      scrollH: document.documentElement.scrollHeight,
      overflow: document.documentElement.scrollWidth - vw,
      /* 🔴 同单机版：overflow 会被祖先裁剪吃掉（#app overflow-y:auto ⇒ overflow-x 降级 auto），
         所以横溢判据必须并上「元素右边界超视口」这一路。见上面 hOver 的说明。
         注意上面的 bad 是**字符串数组**（只留了名字，没有 right）⇒ 这里重新量一次。
         （本段在模板字面量里，禁反引号） */
      hOver: (() => {
        const maxRight = badEls.reduce((mx, el) => {
          const r = el.getBoundingClientRect();
          return r.right > mx ? r.right : mx;
        }, 0);
        return Math.max(document.documentElement.scrollWidth - vw, Math.round(maxRight) - vw, 0);
      })(),
      // 手机横屏真正会咬人的是**纵向**：高度只有 360~430，一屏放得下就要滚动
      vOverflow: document.documentElement.scrollHeight - window.innerHeight,
      offenders: bad, hiddenLeak, vOffenders, fixedOver, tbInfo,
    };
  };
  const vis = (id) => { const el = document.getElementById(id); return !!el && !el.hidden; };

  const stages = {};
  stages.auth = ov();

  q('#auth-name').value = 'hero';
  q('#auth-pass').value = 'pass1234';
  click(q('#btn-enter')); /* 2026-10-25 登录/注册合一后的按钮（旧 #btn-login 已删） */
  await sleep(140);
  stages.clubs = Object.assign({ visible: vis('clubs-view') }, ov());

  click(q('#clubs-list .lb-btn'));
  await sleep(140);
  stages.club = Object.assign({ visible: vis('club-view') }, ov());

  click(q('#tables-list .lb-btn'));
  await sleep(140);
  stages.lobbyTable = Object.assign({ visible: vis('table-view') }, ov());

  window.__sock.fire('table:players', F.players);
  await sleep(60);
  stages.lobbyReady = ov();

  // 长断线：托管徽章（「已托管 · 托管中」比「未准备」长，320px 下最容易挤爆）
  window.__sock.fire('table:players', F.playersHosted);
  await sleep(60);
  stages.lobbyHosted = ov();

  window.__sock.fire('table:state', F.mid);
  await sleep(160);
  stages.play = Object.assign({ visible: vis('play') }, ov());

  // 抢杠胡：提示条（金边）+ 胡 / 过 两个按钮 —— 宽度上最坏的一版
  window.__sock.fire('table:state', F.qiangGang);
  await sleep(160);
  stages.qiangGang = Object.assign({
    visible: vis('play'),
    prompt: !!q('.win-prompt'),
    qgClass: !!q('.win-prompt-qg'),
    settleShown: vis('settle'),
    btns: qa('#controls .act-btn').map((b) => b.textContent),
  }, ov());

  window.__sock.fire('table:state', F.settled);
  await sleep(180);
  stages.settle = Object.assign({ visible: vis('settle') }, ov());

  return JSON.stringify({
    stages,
    handTiles: qa('#me-hand .tile').length,
    backs: qa('.hand-backs .tile.back').length,
    modalRows: qa('#settle-card .st-row').length,
    modalTiles: qa('#settle-card .st-tiles .tile').length,
  });
})()`;

/** 造 NET 模式需要的三帧：players / 中间态 / 结算态（都用真实引擎） */
function netFrames() {
  const ruleset = createRuleSet('koukou', {});
  const names = ['你', '下家很长很长的昵称试试', '对家', '上家'];
  const step = (st) => {
    const a = decide(st, st.turn) || legalActions(st, st.turn)[0];
    if (a) act(st, a);
    return !!a;
  };
  const frameOf = (st) => ({
    seat: 0, handNo: 1, totalHands: 8, dealer: st.dealer, actingSeat: st.phase === 'settled' ? -1 : st.turn,
    ruleset: { preset: 'koukou', claimTimeoutMs: 8000, canPassWin: true, circleCount: 2 },
    tenpai: st.phase === 'settled' ? null : analyzeTenpai(st, 0),
    view: viewFor(st, 0),
  });

  const mid = createGame({ seed: 4242, ruleset, dealer: 0, names });
  for (let i = 0; i < 12 && mid.phase !== 'settled'; i++) step(mid);

  let win = null;
  for (let seed = 1; seed <= 80 && !win; seed++) {
    const st = createGame({ seed, ruleset, dealer: 0, names });
    let g = 0;
    while (st.phase !== 'settled' && g++ < 4000) if (!step(st)) break;
    if (st.phase === 'settled' && st.result && st.result.type === 'win') win = st;
  }
  const settled = win || mid;
  const settledFrame = frameOf(settled);
  // 本工具只量结算页布局；模拟四家已经确认完（真实流程见 verify-net3d-play / verify-ui）。
  if (settledFrame.view && settledFrame.view.reveal) settledFrame.view.reveal.pending = false;

  /* 抢杠胡响应帧：座位 0 能抢杠 → 控制区出现「🀄 抢杠胡！（…）点红色「胡」收分」提示条
     + 胡 / 过 两个按钮 + 倒计时。提示条带金边（`.win-prompt-qg`）比普通提示条多占 4px，
     文案也偏长 —— 是宽度上最容易出事的那一版，所以单列一段来量。 */
  const qiangGang = (() => {
    const T = (n) => makeTile('tong', n);
    const W = (n) => makeTile('wan', n);
    const S = (n) => makeTile('tiao', n);
    const st = createGame({ seed: 30, ruleset, dealer: 0, names });
    for (const p of st.players) { p.hand = []; p.melds = []; p.discards = []; p.opened = false; }
    st.flipTile = null; st.wildTile = WHITE_DRAGON; st.skinTiles = [];
    st.claims = []; st.claimIndex = 0; st.pendingXuGang = null;
    st.players[0].melds = [{ type: 'peng', tiles: [W(1), W(1), W(1)], from: 1 }];
    st.players[0].opened = true;
    st.players[0].hand = [T(1), T(2), W(4), W(5), W(6), W(7), W(8), W(9), S(5), S(5)];
    st.players[1].melds = [{ type: 'peng', tiles: [T(3), T(3), T(3)], from: 0 }];
    st.players[1].opened = true;
    st.players[1].hand = [T(3), W(1), W(1), W(1), S(8), S(8), S(8), W(9), S(1), S(2)];
    st.turn = 1; st.phase = 'discard';
    act(st, { type: 'xu', seat: 1, tile: T(3) });
    return frameOf(st);
  })();

  return {
    players: {
      tableId: 9, name: '一号桌（周末晚场）', started: true, awaitingNext: false, finished: false,
      handNo: 1, totalHands: 8, circleCount: 2, dealer: settled.dealer,
      players: [
        { seat: 0, uid: 1, username: 'hero', ready: true, connected: true, absent: false, botSteps: 0 },
        { seat: 1, uid: 2, username: '下家很长很长的昵称试试', ready: false, connected: true, absent: false, botSteps: 0 },
        { seat: 2, uid: 3, username: '对家', ready: true, connected: false, absent: false, botSteps: 0 },
        { seat: 3, uid: 4, username: '上家', ready: true, connected: true, absent: false, botSteps: 0 },
      ],
    },
    // 托管态：最长的昵称同时还是托管座位 —— 徽章文字叠在最长昵称上，最坏情况
    playersHosted: {
      tableId: 9, name: '一号桌（周末晚场）', started: true, awaitingNext: false, finished: false,
      handNo: 1, totalHands: 8, circleCount: 2, dealer: settled.dealer,
      players: [
        { seat: 0, uid: 1, username: 'hero', ready: true, connected: true, absent: false, botSteps: 0 },
        { seat: 1, uid: 2, username: '下家很长很长的昵称试试', ready: true, connected: false, absent: true, botSteps: 12 },
        { seat: 2, uid: 3, username: '对家', ready: true, connected: false, absent: false, botSteps: 0 },
        { seat: 3, uid: 4, username: '上家', ready: true, connected: true, absent: false, botSteps: 0 },
      ],
    },
    mid: frameOf(mid),
    qiangGang,
    settled: settledFrame,
  };
}

/** NET 模式主循环：每档宽度量一遍整条大厅路径 */
async function runNet(send) {
  await send('Page.addScriptToEvaluateOnNewDocument', { source: NET_STUB });
  const frames = netFrames();
  const fileUrl = 'file://' + BUILD_HTML;
  const report = [];
  let allOk = true;

  for (const { w, h } of VIEWPORTS) {
    for (const mobile of [false, true]) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile });
      await send('Page.navigate', { url: fileUrl });
      // 等大厅真正解析出来（`#auth-name` 是静态节点，不依赖 net-main.js 跑完）
      await waitFor(send, "document.querySelector('#auth-name')");
      const raw = (await evalIn(send, netDriverSrc(frames), { awaitPromise: true })) ?? '{}';
      const out = JSON.parse(raw);
      // 桌面模式（不兜底）的溢出量才算数；移动模式只看「被撑宽多少」
      if (!mobile) {
        report.push({ w, h, ...out });
        const land = isLandscape(w, h);
        for (const [k, s] of Object.entries(out.stages)) {
          // 同单机版口径：**纵溢只在横屏算失败**（竖屏/桌面那套布局本来就该上下滚）
          if (s.hOver > 0 || (land && s.vOverflow > 0)) allOk = false;
        }
      } else if (report.length) {
        const last = report[report.length - 1];
        if (last.w === w && !last.mobileW) last.mobileW = Math.max(...Object.values(out.stages).map((s) => s.scrollW));
      }
    }
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(`${SHOT_DIR}/net-w${w}x${h}.png`, Buffer.from(shot.data, 'base64'));
  }
  return { allOk, report, net: true };
}

/* ------------------------------------------------------------------ *
 * CDP
 * ------------------------------------------------------------------ */
function makeCdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  return (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

/**
 * 现取一个空闲端口给 CDP 用。
 * 为什么不用固定 9333：上一轮被中断（SIGTERM / 超时被 kill）时，无头 Chrome 会**活下来**继续占着端口，
 * 下一次运行就直接「连不上 Chrome devtools」—— 而这个沙箱里 `pgrep`/`pkill` 全都用不了
 * （`sysmond service not found`），根本清理不掉。改成每轮现取一个空闲端口，
 * 残留进程就再也挡不住新一轮了。（想固定端口仍可用 `CDP_PORT=9333`。）
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function connect(port) {
  /* ❗必须给无头 Chrome 一个**独立 profile 目录**。
     不给的话它会去用默认的 Chrome profile —— 而用户桌面上往往还开着真 Chrome，
     两者抢同一个 profile 锁 → 新起的无头实例压根起不来（症状是「连不上 Chrome devtools」，
     而且跑过几轮之后越来越容易复现）。每轮一个 UUID 目录，残留实例也各不干扰。 */
  const profile = `${SHOT_DIR}/chrome-profile-${randomUUID()}`;
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--allow-file-access-from-files', `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`, '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch { /* 端口还没起来 */ }
    await sleep(150);
  }
  if (!target) {
    chrome.kill();
    throw new Error(
      '连不上 Chrome devtools（端口 ' + port + '）。'
      + '常见原因：① 无头 Chrome 起不来（CPU 被别的重任务吃满，别和其它 e2e/视口扫描并行跑）；'
      + '② 目标 Chrome 根本不存在（可设 CHROME_PATH）。'
      + '本轮用的独立 profile：' + profile,
    );
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  return { chrome, ws, send: makeCdp(ws), profile };
}

/** 收尾：关掉无头 Chrome，并尽量删掉这一轮的独立 profile（删不掉也无所谓，try/catch 兜着）。 */
function teardown({ chrome, ws, profile }) {
  try { ws.close(); } catch { /* 已断 */ }
  try { chrome.kill(); } catch { /* 已退 */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* 沙箱可能不让删 */ }
}

async function main() {
  const port = process.env.CDP_PORT ? Number(process.env.CDP_PORT) : await freePort();
  const conn = await connect(port);
  const { send } = conn;
  await send('Page.enable');
  await send('Runtime.enable');
  // 网络版（net3d）逐段量横向溢出；真实 REST/WS 链路由 verify-net-e2e.mjs 覆盖。
  const r = await runNet(send);
  teardown(conn);
  return r;
}

/* ❗用 `let`：下面报告阶段会再把 allOk 置 false（比如检出 hidden 泄漏）。
   原先写的是 `const` —— 只因为那条分支一直没被触发过才没炸；一旦真检出泄漏就是
   `TypeError: Assignment to constant variable`，把「检查失败」变成「脚本崩了」。 */
let { allOk, report, net } = await main().catch((e) => { console.error(e); process.exit(1); });

if (net) {
  console.log('网络版页面（build/net3d.html）：大厅 → 牌桌 → 抢杠胡 → 结算 逐段量横向溢出\n');
  const LBL = { auth: '登录页', clubs: '俱乐部列表', club: '俱乐部详情', lobbyTable: '牌桌大厅', lobbyReady: '四人准备', lobbyHosted: '托管态', play: '牌桌（开局）', qiangGang: '抢杠胡提示', settle: '结算弹窗' };
  for (const s of report) {
    const land = isLandscape(s.w, s.h);
    const bad = Object.entries(s.stages).filter(([, v]) => v.hOver > 0 || (land && v.vOverflow > 0) || (v.hiddenLeak || []).length > 0);
    const mark = bad.length ? '❌' : '✅';
    console.log(`${mark} ${s.w}×${s.h}${land ? '（横屏·要求一屏放得下）' : ''}  手牌 ${s.handTiles} 张 · 牌背 ${s.backs} · 结算 ${s.modalRows} 家/${s.modalTiles} 张`);
    /* 有纵溢时把「谁把它撑高的」打出来（fixed 与非 fixed 分开）——
       否则只能靠猜。2026-10-01：568×320 网络版结算段纵溢 16px 就是这么定位的。 */
    for (const [k, v] of Object.entries(s.stages)) {
      if (!(v.vOverflow > 0)) continue;
      if ((v.vOffenders || []).length) console.log(`      ↳ ${LBL[k] || k} 非 fixed 撑高：${v.vOffenders.join(' / ')}`);
      if ((v.fixedOver || []).length) console.log(`      ↳ ${LBL[k] || k} fixed 超出视口（不计入纵溢）：${v.fixedOver.join(' / ')}`);
      if (v.tbInfo) console.log(`      ↳ ${LBL[k] || k} 顶栏：${v.tbInfo}`);
    }
    for (const [k, v] of Object.entries(s.stages)) {
      console.log(`   ${LBL[k] || k}：视口 ${v.vw}×${v.vh} · 横溢 ${v.overflow}px · 纵溢 ${v.vOverflow}px`
        + (land ? '' : '（竖屏允许上下滚，仅参考）')
        + (v.visible === false ? '（未显示！）' : '')
        + (v.offenders.length ? ' ← ' + v.offenders.join(' / ') : '')
        + ((v.hiddenLeak || []).length ? ' ← 带 hidden 却仍显示：' + v.hiddenLeak.join(' / ') : ''));
      if (v.visible === false) allOk = false;
      if ((v.hiddenLeak || []).length) allOk = false;
    }
    // 抢杠胡那一段另加结构不变量：提示条 + 金边样式 + 胡/过 双按钮 + 不弹结算
    const qg = s.stages.qiangGang || {};
    const qgOk = qg.prompt === true && qg.qgClass === true && qg.settleShown === false
      && Array.isArray(qg.btns) && qg.btns.includes('胡') && qg.btns.includes('过');
    console.log(`   ${qgOk ? '✅' : '❌'} 抢杠胡结构：提示条 ${qg.prompt ? '有' : '无'} · 金边 ${qg.qgClass ? '有' : '无'}`
      + ` · 结算弹窗 ${qg.settleShown ? '误弹！' : '未弹'} · 按钮 ${(qg.btns || []).join('/') || '无'}`);
    if (!qgOk) allOk = false;
    if (s.mobileW) console.log(`   移动模式最小内容宽度 ${s.mobileW}${s.mobileW > s.w ? '（> 请求宽度 → 真机整页会缩小）' : ''}`);
    console.log(`   截图：${SHOT_DIR}/net-w${s.w}x${s.h}.png`);
  }
  console.log(allOk
    ? `\n=== 网络版视口检查通过：各档位全段无横向/纵向溢出 ===`
    : `\n=== 网络版视口检查失败：存在溢出或视图未显示 ===`);
  process.exit(allOk ? 0 : 1);
}
