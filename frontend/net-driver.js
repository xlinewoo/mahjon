/**
 * 网络对战驱动（socket.io）—— 与 ./game-loop.js 的纯逻辑层（座位/方位/结算文案）配合，共用同一份 driver 契约
 *
 * 单机版：本地引擎推进（humanAct → botStep → 同步拿到新 view）
 * 网络版：把动作发给服务端，等 `table:state` 回来才有新 view（服务端权威）
 *
 * 为了能让 ./render.js 一行不改地复用，本驱动必须提供完全一样的接口：
 *   seatToDir / winds / actingSeat() / isMyTurn() / getView() / getTenpai() /
 *   ruleset / autoPassLocally
 *
 * 与单机版的差异：
 *   · `winds.entries = null`  → 网络版不弹「摸风定座」面板（定座由服务端在 Room 里决定）
 *   · `dealer` 可能每把变 → `seatToDir` 用 getter 按当前 dealer 现算（庄家坐东，依次南/西/北）
 *   · `actingSeat` / `tenpai` 由服务端下发（客户端拿不到 `claims`，也算不了听牌）
 *   · `autoPassLocally = false` → 超时自动「过」交给服务端兜底（见 server/ws/index.js armClaimTimer），
 *     前端只显示倒计时，不重复发动作（否则两边各发一次，第二次会被判「还没轮到你」）
 *
 * 服务端载荷（`table:state`）形状见 server/ws/room.js `statePayload()`：
 *   { seat, handNo, totalHands, dealer, actingSeat, ruleset, tenpai, view }
 *
 * 本模块**零 DOM 依赖**，可直接在 Node 里用真实 socket.io-client 跑端到端验证
 * （见 tools/verify-net-e2e.mjs）。
 */

import { DIR_ORDER, windsFromDealer } from './game-loop.js';

/** 听牌分析的「空结果」——服务端在 settled 阶段不下发 tenpai，前端要能安全地当"没听牌"处理 */
export const EMPTY_TENPAI = { tenpai: false, waits: [], mode: null, byDiscard: [] };

/** 与单机版默认值一致；服务端 rulesetSummary() 会覆盖 */
const DEFAULT_RULESET = {
  preset: 'koukou',
  claimTimeoutMs: 8000,
  canPassWin: true,
  circleCount: 1,
};

/**
 * @param {object} opts
 *   socket      socket.io 客户端实例（必填）
 *   initial     首帧 `table:state` 载荷（可选；不给就等第一次广播）
 *   actionTimeoutMs 单个动作等回执/等 state 的超时（默认 12s，比服务端 8s 兜底长）
 * @returns {object} 对局控制器（render.js 的 driver 契约 + 网络版额外能力）
 */
export function createNetDriver(opts = {}) {
  const { socket, initial = null, actionTimeoutMs = 12000 } = opts;
  if (!socket) throw new Error('createNetDriver 需要一个 socket.io 客户端实例');

  let payload = initial && typeof initial.seat === 'number' ? initial : null;
  let waiters = [];               // 等「下一个 table:state」的 promise
  const listeners = new Set();    // 每次新载荷都回调（net-lobby 用它重绘）
  let lastError = '';

  /** 当前 dealer：载荷没来之前用 0（东）兜底，保证 UI 永远拿得到方位标签 */
  const dealerNow = () => (payload ? payload.dealer : 0);

  // 方位映射按 dealer 缓存：renderAll 里每张牌都要查一次 seatToDir，别每次新建对象
  let dirCacheKey = null;
  let dirCache = null;
  function seatToDirNow() {
    const d = dealerNow();
    if (dirCacheKey !== d || !dirCache) {
      dirCache = windsFromDealer(d).seatToDir;
      dirCacheKey = d;
    }
    return dirCache;
  }

  function settle(p) {
    if (!p || typeof p.seat !== 'number') return;
    payload = p;
    // ⚠️ 不能「收到任意 state 就 resolve 动作」：服务端 8 秒自动「过」也会广播
    // state，若恰好在玩家点「胡」之后到达，会把还没被服务端处理的胡牌误判成
    // 成功（随后 ack.error 又报「还没轮到你」）。动作必须等 ack 成功才算落地。
    const ready = [];
    for (const w of waiters) {
      w.state = p;
      if (w.ackOk) ready.push(w);
    }
    for (const w of ready) {
      waiters = waiters.filter((x) => x !== w);
      clearTimeout(w.timer);
      w.resolve(w.state);
    }
    if (p.view && p.view.phase === 'discard') lastError = '';
    for (const fn of [...listeners]) {
      try { fn(p); } catch (_) { /* 监听器异常不该拖垮驱动 */ }
    }
  }

  function fail(msg) {
    lastError = msg || '服务端错误';
    const pending = waiters;
    waiters = [];
    for (const w of pending) {
      clearTimeout(w.timer);
      w.reject(new Error(lastError));
    }
  }

  /* ---------------- socket 订阅 ---------------- */
  const onState = (p) => { try { settle(p); } catch (_) { /* 忽略畸形载荷 */ } };
  const onError = (e) => fail((e && (e.msg || e.message)) || '服务端错误');
  const onDisconnect = () => fail('与服务器断开连接');
  socket.on('table:state', onState);
  socket.on('error', onError);
  socket.on('disconnect', onDisconnect);

  /** 解开订阅（离开牌桌时调用；不调的话旧驱动会继续吃新载荷） */
  function detach() {
    socket.off('table:state', onState);
    socket.off('error', onError);
    socket.off('disconnect', onDisconnect);
    listeners.clear();
  }

  /* ---------------- 动作 ---------------- */
  /**
   * 发一个动作并等「下一帧 state」。
   * 服务端处理顺序是：applyAction → broadcastState（先发包）→ ack（后发），所以正常
   * 情况下 `table:state` 先到、ack 只是校验。任一侧出错都让这个 Promise reject，
   * render.js 的 doAction() 会把它弹成一条一闪提示。
   */
  function act(action) {
    return new Promise((resolve, reject) => {
      if (!payload) return reject(new Error('牌局尚未开始'));
      if (!action || typeof action.type !== 'string') return reject(new Error('非法动作'));
      const w = { resolve, reject, timer: null, state: null, ackOk: false };
      const finish = () => {
        waiters = waiters.filter((x) => x !== w);
        clearTimeout(w.timer);
      };
      w.timer = setTimeout(() => {
        finish();
        reject(new Error('等待服务端响应超时'));
      }, actionTimeoutMs);
      w.timer.unref?.();
      waiters.push(w);
      socket.emit('action', action, (ack) => {
        if (ack && ack.error) {
          finish();
          reject(new Error(ack.error));
          return;
        }
        // 服务端顺序是「先 broadcastState，再 ack」；若 state 已到，ack 成功
        // 就是最后一个条件。若还没到（极端慢链路），等下一帧再 resolve。
        w.ackOk = true;
        if (w.state) {
          finish();
          resolve(w.state);
        }
      });
    });
  }

  /** 点「准备」（开局 / 下一把）；只等 ack，新 state 走正常广播 → 监听器重绘 */
  function ready() {
    return new Promise((resolve, reject) => {
      socket.emit('table:ready', {}, (ack) => {
        if (ack && ack.error) reject(new Error(ack.error));
        else resolve(ack || {});
      });
    });
  }

  /** 离开牌桌（服务端保留座位供重连，这里只是退订 + 通知） */
  function leave() {
    return new Promise((resolve) => {
      socket.emit('table:leave', {}, () => resolve());
      detach();
      payload = null;
    });
  }

  return {
    /* ---- render.js 要求的 driver 契约 ---- */
    get MY_SEAT() { return payload ? payload.seat : 0; },
    get seatToDir() { return seatToDirNow(); },
    get winds() { return { dealer: dealerNow(), seatToDir: seatToDirNow(), entries: null }; },
    get dealerSeat() { return dealerNow(); },
    get ruleset() { return (payload && payload.ruleset) || DEFAULT_RULESET; },
    autoPassLocally: false, // 超时自动「过」由服务端兜底

    actingSeat() {
      return payload && typeof payload.actingSeat === 'number' ? payload.actingSeat : -1;
    },
    /** 本家在响应阶段的「潜在可响应选项」（claim 阶段下发；非本家回合也带，用于常显按钮）。
     *  不含别家信息（只含自己能做的吃/碰/杠/胡），缺省为空数组。 */
    get myClaims() {
      return payload && Array.isArray(payload.myClaims) ? payload.myClaims : [];
    },
    isMyTurn() {
      if (!payload || !payload.view) return false;
      if (payload.view.phase === 'settled') return false;
      return payload.actingSeat === payload.seat;
    },
    getView() { return payload ? payload.view : null; },
    getTenpai() { return (payload && payload.tenpai) || EMPTY_TENPAI; },

    /* ---- 网络版额外能力 ---- */
    act,
    ready,
    leave,
    detach,
    DIR_ORDER,
    /** 手动喂一帧载荷（重连补帧 / 无 socket 的离线回放用） */
    push: settle,
    getPayload: () => payload,
    /** 订阅每帧载荷；返回退订函数 */
    onState(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get lastError() { return lastError; },
  };
}
