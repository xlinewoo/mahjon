// 单张牌桌的对战会话：4 座位 / ready / act 转发 / 按座位 viewFor / 断线重连
//
// 服务端权威：本类持有唯一 `state`，所有变更都经 `act()` 纯函数推进；
// 对外只发 `viewFor(state, seat)` 的裁剪结果（绝不下发别家手牌）。
import { createGame, act, viewFor, legalActions } from '../../src/engine/game.js';
import { createRuleSet } from '../../src/engine/rules.js';
import { analyzeTenpai } from '../../src/engine/tenpai.js';
import { decide } from '../../src/bot/simpleBot.js';
import { drawWinds } from '../../src/engine/winds.js';
import { randomBytes } from 'node:crypto';

export const SEATS = 4;

/**
 * 退出投票冷却（同一座位两次发起之间的最小间隔）：防一个人把全桌弹窗刷爆。
 * 取 5 秒：正常人被拒后去群里说句话再点，远不止 5 秒；而刷屏者最多只能 12 次/分钟。
 */
const EXIT_REQUEST_COOLDOWN_MS = 5 * 1000;

export class Room {
  constructor(tableRow) {
    this.tableId = tableRow.id;
    this.clubId = tableRow.club_id;
    this.name = tableRow.name;
    this.ownerId = tableRow.owner_id;
    this.rulesOverrides = JSON.parse(tableRow.rule_json || '{}');
    this.circleCount = tableRow.circle_count || 1;
    this.totalHands = this.circleCount * 4; // 1 圈 = 4 把（东南西北各坐庄一次）

    // { uid, username, ready, socketId, connected, offlineSince, absent }
    //   offlineSince —— 断线时刻（ms）；在线为 null。重连必须清空，否则会被误判托管
    //   absent       —— 已转「托管」（服务器代打）；本人重连即撤销
    this.seats = [null, null, null, null];
    this.state = null;
    this.handNo = 0;
    this.dealer = 0;
    this.prevWildTile = null;
    this.started = false;
    this.awaitingNext = false; // 本把已结算，等四家再 ready 开下一把
    this.finished = false;
    this.baseSeed = null;
    this._claimTimer = null;
    this._sweepTimer = null; // 离席巡检定时器（由 ws/index.js 挂载与清理）
    this._revealTimer = null; // 摊牌确认超时兜底（由 ws/index.js 挂载）
    this._settledHandNo = 0; // 已发过「结算事件」的把次（防重复记账）
    // 已完成牌的结算结果（退出投票时按这些累计，不含当前没打完的这把）
    this.completedResults = [];
    // 退出游戏投票：{ fromSeat, approvals:number[], rejects:number[] } 或 null
    this.exitRequest = null;
    // 发起退出的冷却（ms）；可覆写，单测里置 0 便于连续构造场景
    this.exitRequestCooldownMs = EXIT_REQUEST_COOLDOWN_MS;
    // 当前这把的回放日志：newHand() 记录发牌配置，applyAction() 逐条追加动作。
    // 结算时由 ws 层落库；不参与对局逻辑。
    this.replayLog = null;
    // 规则集缓存（2026-10-24）：此前 getter 每次都 createRuleSet 新建对象，
    // 每帧广播 × 4 座位 = 每动作白造 4 个 RuleSet。rulesOverrides 只在构造时注入，
    // 这里缓存一份即可。规则集摘要（rulesetSummary）同理。
    this._ruleset = createRuleSet(this.rulesOverrides.preset || 'koukou', this.rulesOverrides);
    this._rulesetSummary = null;
    // 听牌分析缓存：键 = `把次:状态版本号`，按座位各存一份。
    // 每座位每次广播重算 0.91ms（p90 2.74ms）× 4 —— 缓存后同帧四座位只算一次。
    this._tenpaiCache = { key: '', map: new Map() };
  }

  get ruleset() {
    return this._ruleset;
  }

  /** 某座位的听牌分析（按 (handNo, state.rev) 缓存；同帧四座位各只算一次） */
  tenpaiFor(seat) {
    const key = `${this.handNo}:${this.state.rev || 0}`;
    if (this._tenpaiCache.key !== key) {
      this._tenpaiCache = { key, map: new Map() };
    }
    let t = this._tenpaiCache.map.get(seat);
    if (t === undefined) {
      t = analyzeTenpai(this.state, seat);
      this._tenpaiCache.map.set(seat, t);
    }
    return t;
  }

  seatOfUid(uid) {
    return this.seats.findIndex((s) => s && s.uid === uid);
  }

  /**
   * 入座（已入座者为幂等重连）。
   * 重连回来即**撤销托管**：清 `offlineSince`、落 `absent=false`，控制权还给人。
   * `returnedFrom` 报告「托管/断线期间被服务器代打了多少步」，前端可提示。
   */
  join(user, socketId) {
    const idx = this.seatOfUid(user.id);
    if (idx >= 0) {
      const s = this.seats[idx];
      const wasAbsent = !!s.absent;
      s.socketId = socketId;
      s.connected = true;
      s.offlineSince = null;
      s.absent = false;
      s.botSteps = 0;
      if (user.avatar) s.avatar = user.avatar; // 重连顺带刷新头像（可能中途换过）
      return { seat: idx, reconnected: true, wasAbsent };
    }
    if (this.started && !this.awaitingNext) return { error: '牌局已开始，无法加入' };
    const empty = this.seats.findIndex((s) => s === null);
    if (empty < 0) return { error: '牌桌已满' };
    this.seats[empty] = {
      uid: user.id,
      username: user.username,
      avatar: user.avatar ?? null,
      ready: false,
      socketId,
      connected: true,
      offlineSince: null,
      absent: false,
      botSteps: 0,
    };
    return { seat: empty, reconnected: false, wasAbsent: false };
  }

  /** 断线：保留座位与 state（供重连），标记未连接并记下断线时刻（触发离席巡检） */
  disconnect(uid, socketId) {
    const i = this.seatOfUid(uid);
    if (i < 0) return;
    if (this.seats[i].socketId !== socketId) return; // 已被新连接接管，忽略旧 socket 的断开
    this.seats[i].connected = false;
    this.seats[i].socketId = null;
    // 幂等：重复断开（如 leave 后又 disconnect）不刷新计时起点，
    // 否则反复抖动会把离席判定无限推迟
    if (!this.seats[i].offlineSince) this.seats[i].offlineSince = Date.now();
  }

  /**
   * 手动托管 / 取消托管（老吴 2026-10-02 后续需求：取消「断线自动托管」，改由玩家主动点按钮）。
   *
   * 只有「本人」或「已断线的座位」可被托管；在线的其他玩家不可被托管
   * （权限在网络层 table:setAbsent 处把关，这里只校验座位存在）。
   * 托管即把该座位标记 `absent`（服务器按机器人策略代打）。
   *
   * 大厅阶段（牌局未开始）或「等下一把」阶段托管 → 同时视为已准备：
   * 否则断线者永远不 ready，四家凑不齐，牌局开不了 / 下一把开不了。
   *
   * 返回 { ok, seat, absent } 或 { error }。
   */
  setAbsent(uid, on) {
    const seat = this.seatOfUid(uid);
    if (seat < 0) return { error: '座位不存在' };
    const s = this.seats[seat];
    let already = false;
    if (on) {
      if (s.absent) {
        already = true;
      } else {
        s.absent = true;
        // 大厅阶段（牌局未开始）或「等下一把」阶段托管 → 视为已准备，凑齐即能开局 / 开下一把
        if (!this.started || this.awaitingNext) s.ready = true;
      }
    } else {
      if (!s.absent) {
        already = true;
      } else {
        s.absent = false;
      }
    }
    // 🔴 点「托管」/「取消托管」本身不会走 table:ready，所以这里补一次「四家齐且全 ready」推进；
    // 否则大厅里最后一家靠托管变 ready 后，牌局会永远停在「已准备但不开局」。
    const event = this.maybeAdvance();
    return { ok: true, seat, absent: !!s.absent, already, event };
  }

  /** 大厅 / 等下一把：四家齐且全 ready → 立即开局 / 开下一把；返回 'started' | 'next' | null */
  maybeAdvance() {
    if (!this.started) {
      if (this._allReady()) {
        this.start();
        return 'started';
      }
      return null;
    }
    if (this.awaitingNext && this._allReady()) {
      this.awaitingNext = false;
      this.newHand();
      return 'next';
    }
    return null;
  }

  /* ==================== 长断线策略（离席巡检） ==================== */

  /* 2026-10-17：删除 offlineMsOf / offlinePolicy —— 自动托管与自动判离席均已移除
     （见 sweepOffline 的注释）。定时器在 ws/index.js，改用固定间隔 ABSENT_POLL_MS，
     不再按 claimTimeoutMs 倍数推导。 */

  hasAbsent() {
    return this.seats.some((s) => s && s.absent);
  }

  absentSeats() {
    return this.seats.map((s, i) => (s && s.absent ? i : -1)).filter((i) => i >= 0);
  }

  /**
   * 离席巡检 —— **纯决策，自己不含任何定时器**（定时器在 ws/index.js）。
   *
   * 之所以要把「决策」和「定时」拆开：定时器不可测（要真等 24s），
   * 而这里只要传一个 `now` 就能把 24s / 120s 的整条时间轴瞬间走完，
   * 于是 room.test.js 能用假时间戳覆盖「托管」「自动 ready」「判离席」全部分支。
   *
   * 返回发生了什么（调用方据此决定广播/发事件/改 DB）：
   *   { absent: number[], steps: number, startedNext: boolean, settled: boolean }
   *
   * 判定顺序（不可调换）：**先判解散，再判托管，最后才代打**。
   * 反过来会出现「刚托管就被解散」的无谓广播。
   */
  sweepOffline() {
    const out = { absent: [], steps: 0, startedNext: false, settled: false };
    if (this.finished) return out;
    // 牌局没开始、也不在「等下一把」→ 不巡检。
    // 大厅里干坐着不 ready 是正常状态，不是离席；否则四个人刚坐下就被判解散。
    // （与 ws/index.js 的 armSweep 保持同一门槛，两边必须一致）
    if (!this.started && !this.awaitingNext) return out;

    // ① 自动判离席（长断线作废整场）已移除（老吴 2026-10-02）：断线再久也不作废，
    //    玩家重连即回到原牌局继续。2026-10-17 连「将来手动解散」的 dead code
    //    （dissolveByOffline / out.dissolve / table:dissolved）也一并删除。

    // ② **自动托管已取消（老吴 2026-10-02 后续需求）**：断线不再自动转托管，
    //    必须由某位在线玩家**主动点「托管」按钮**才托管（见 ws/index.js 的
    //    `table:setAbsent` / Room.setAbsent）。断线者只是「断线等待」，
    //    不会在无人确认下被机器人接管。已处于 absent 的座位继续由下面步骤代打。
    //    （`out.absent` 不再由本方法产出，改由 setAbsent 成功后单独广播。）

    if (!this.hasAbsent()) return out;
    // 无人观战时不再替离线者代打：避免空桌自走；任一人重连后由 joinTable 重新唤醒。
    if (!this.seats.some((s) => s && s.connected)) return out;

    // ③ 胡牌摊牌确认：托管 / 机器人座位立即替本人点「确认」。
    //    在线的真人仍由自己点（或等 ws 层的超时兜底），不抢。
    if (this.state && this.state.reveal && this.state.reveal.pending) {
      let steps = 0;
      for (const s of this.seats) {
        if (!s || !s.absent || this.state.reveal.confirmed.includes(s.seat)) continue;
        try {
          this.applyAction(s.uid, { type: 'confirm' });
          steps++;
        } catch {
          /* 单个座位异常不影响其它座位 */
        }
      }
      out.steps += steps;
      out.settled = !this.state.reveal.pending;
      return out;
    }

    // ④ 等下一把期间：托管座位自动 ready，凑齐四家就开新把
    if (this.awaitingNext) {
      for (const s of this.seats) if (s && s.absent) s.ready = true;
      if (this._allReady()) {
        this.awaitingNext = false;
        this.newHand();
        out.startedNext = true;
      }
      return out;
    }

    // ⑤ 牌局进行中：轮到托管座位就替它走**一步**。
    //    一次巡检只出一张/做一个响应，由 ws 层按 BOT_STEP_MS 续下一次巡检；
    //    这样 3 个机器人陪打时客户端能逐张看到牌，而不是一口气跳到结算
    //    （老吴 2026-10-20：「全部是机器人托管也要一张一张出牌」）。
    const seat = this.actingSeat();
    if (seat < 0) return out;
    const s = this.seats[seat];
    if (!s || !s.absent) return out;
    let a = null;
    try {
      a = decide(this.state, seat);
    } catch {
      a = null;
    }
    if (!a) return out;
    try {
      this.applyAction(s.uid, a);
    } catch {
      return out; // 极端情况下机器人策略给出的动作被引擎拒绝 → 停手，交给响应超时兜底
    }
    s.botSteps = (s.botSteps || 0) + 1;
    out.steps++;
    // 胡牌只是进入摊牌确认，不算「真正结束」；四个座位确认完才发结算事件。
    if (this.state.phase === 'settled') {
      out.settled = !(this.state.reveal && this.state.reveal.pending);
    }
    return out;
  }

  /* 2026-10-17：删除 dissolveByOffline（判离席/请出座位）—— 自动判离席已移除，
     该方法不再被任何路径调用（原调用点在 ws/index.js 的 out.dissolve 分支，已一并删除）。 */

  /* ==================== 退出游戏投票 ==================== */

  /**
   * 发起「退出游戏」：需要另外三家**全部同意**才结束本场。
   * 机器人座位自动视为同意（它们不是人，无法投票）；真人都必须各自同意。
   * 已有请求时不允许第二个人插队（先处理当前请求）。
   */
  requestExit(uid) {
    if (!this.started || this.finished) return { error: '牌局未进行' };
    const seat = this.seatOfUid(uid);
    if (seat < 0) return { error: '不在牌桌上' };
    // 已有投票在跑：重复发起按「幂等」处理（不受冷却影响，否则同一请求会变成报错）
    if (this.exitRequest) {
      if (this.exitRequest.fromSeat === seat) {
        return { ok: true, already: true, vote: this.exitVotePayload() };
      }
      return { error: '已有玩家发起退出，请先同意或拒绝' };
    }
    // 2026-10-29（P2）：新发起才判冷却。旧实现里「被拒/作废 → 立刻再发起」无门槛，
    // 一个人就能把全桌弹窗刷到没法打牌；现在同一座位 5 秒内只能发起一次。
    // 冷却**按座位**独立计算：A 刷屏不该把 B 的发起权也锁掉
    const now = Date.now();
    if (this._lastExitReqAt && this._lastExitReqAt.seat === seat
        && now - this._lastExitReqAt.at < this.exitRequestCooldownMs) {
      const wait = Math.ceil((this.exitRequestCooldownMs - (now - this._lastExitReqAt.at)) / 1000);
      return { error: `发起太频繁，请 ${wait} 秒后再试` };
    }
    this._lastExitReqAt = { seat, at: now };

    const approvals = [];
    for (let i = 0; i < SEATS; i++) {
      const s = this.seats[i];
      if (i !== seat && s && s.bot) approvals.push(i);
    }
    this.exitRequest = { fromSeat: seat, approvals, rejects: [] };
    if (this._exitPassed()) {
      return { event: 'exited', final: this._finishExit() };
    }
    return { event: 'requested', vote: this.exitVotePayload() };
  }

  /** 另外三家逐家投票；任意一家拒绝 → 请求作废，牌局继续。 */
  voteExit(uid, agree) {
    if (!this.exitRequest) return { error: '当前没有退出请求' };
    if (this.finished) { this.exitRequest = null; return { error: '牌局已结束' }; }
    const seat = this.seatOfUid(uid);
    if (seat < 0) return { error: '不在牌桌上' };
    if (seat === this.exitRequest.fromSeat) return { error: '发起人不能给自己投票' };

    if (!agree) {
      const byName = this.seats[seat]?.username || `座位${seat + 1}`;
      this.exitRequest = null;
      return { event: 'rejected', bySeat: seat, byName };
    }
    if (!this.exitRequest.approvals.includes(seat)) this.exitRequest.approvals.push(seat);
    if (this._exitPassed()) {
      return { event: 'exited', final: this._finishExit() };
    }
    return { event: 'pending', vote: this.exitVotePayload() };
  }

  /** 座位断线/主动离开时作废投票，避免其他三家被弹窗永久挡住。 */
  cancelExit(uid, reason = 'disconnect') {
    if (!this.exitRequest) return null;
    const seat = this.seatOfUid(uid);
    if (seat < 0) return null;
    const byName = this.seats[seat]?.username || `座位${seat + 1}`;
    this.exitRequest = null;
    return { bySeat: seat, byName, reason };
  }

  _exitPassed() {
    if (!this.exitRequest) return false;
    return this.seats.every((s, i) => {
      if (i === this.exitRequest.fromSeat) return true;
      if (!s || s.bot) return true;
      return this.exitRequest.approvals.includes(i);
    });
  }

  exitVotePayload() {
    const r = this.exitRequest;
    if (!r) return null;
    return {
      fromSeat: r.fromSeat,
      fromName: this.seats[r.fromSeat]?.username || `座位${r.fromSeat + 1}`,
      approvals: [...r.approvals],
      rejects: [...r.rejects],
      needed: SEATS - 1,
      completedHands: this.completedResults.length,
    };
  }

  /** 结束本场并给出「已完成牌局」的累计积分；当前没打完的这把一律不算。 */
  _finishExit() {
    // 若本把已经结算（摊牌确认中）→ 它算「已完成」；还没打完的当前把不算。
    if (this.state && this.state.phase === 'settled') this._recordCompletedResult();
    const bySeat = this.exitRequest ? this.exitRequest.fromSeat : -1;
    const byName = bySeat >= 0 ? (this.seats[bySeat]?.username || `座位${bySeat + 1}`) : '';
    const final = {
      reason: 'exit',
      bySeat,
      byName,
      handNo: this.handNo,
      completedHands: this.completedResults.length,
      standings: this.standings(),
    };
    this.exitRequest = null;
    this.finished = true;
    this.started = false;
    this.awaitingNext = false;
    this._clearReady();
    return final;
  }

  /**
   * 本场累计排名（只算真正打完并确认的牌局）。
   *   · net     总得分（含七皮/十杠等附加账本）
   *   · wins    胡牌次数
   *   · dealtIn 点炮次数（自己打出的牌被别人胡）
   *   · goldTops 金顶次数（自己胡出金顶的局数）
   *   · lianZhuang 连庄次数（自己坐庄时胡牌 → 庄家继续坐庄）
   * 退出投票与打满设定局数都用同一套口径。
   */
  standings() {
    const rows = this.seats.map((s, seat) => ({
      seat,
      name: s ? s.username : `座位${seat + 1}`,
      net: 0,
      wins: 0,
      dealtIn: 0,
      goldTops: 0,
      lianZhuang: 0,
      gangs: 0,
      maxFan: 0,
      played: this.completedResults.length,
    }));
    for (const h of this.completedResults) {
      for (const p of h.perSeat || []) {
        const r = rows[p.seat];
        if (!r) continue;
        r.net += p.delta | 0;
        r.gangs += p.gangs | 0;
        r.maxFan = Math.max(r.maxFan, p.fan | 0);
        if (p.isWinner) r.wins += 1;
      }
      if (h.type === 'win') {
        const winner = h.winnerSeat;
        if (Number.isInteger(winner) && winner >= 0 && winner < rows.length && h.topType === 'goldTop') {
          rows[winner].goldTops += 1;
        }
        if (Number.isInteger(winner) && winner >= 0 && winner < rows.length && winner === h.dealerSeat) {
          rows[winner].lianZhuang += 1;
        }
        const from = h.from;
        if (Number.isInteger(from) && from >= 0 && from < rows.length && from !== winner) {
          rows[from].dealtIn += 1;
        }
      }
    }
    rows.sort((a, b) => b.net - a.net || b.wins - a.wins || a.seat - b.seat);
    return rows;
  }

  /** 记录一把真正结束的牌（胡牌须四家确认完；荒庄直接算）。 */
  _recordCompletedResult() {
    const result = this.state && this.state.result;
    if (!result || !Array.isArray(result.perSeat)) return;
    if (this.completedResults.some((h) => h.handNo === this.handNo)) return;
    this.completedResults.push({
      handNo: this.handNo,
      type: result.type,
      winnerSeat: Number.isInteger(result.winnerSeat) ? result.winnerSeat : result.winner,
      dealerSeat: Number.isInteger(result.dealerSeat) ? result.dealerSeat : this.dealer,
      from: Number.isInteger(result.from) ? result.from : null,
      topType: result.topType || null,
      perSeat: result.perSeat.map((p) => ({
        seat: p.seat,
        delta: p.delta,
        isWinner: p.isWinner,
        fan: p.fan,
        gangs: p.gangs,
        huType: p.huType,
      })),
    });
  }

  _allReady() {
    return this.seats.every((s) => s && s.ready);
  }

  _clearReady() {
    for (const s of this.seats) if (s) s.ready = false;
  }

  /**
   * 往空位补一个「服务端机器人」（单人验证便利）。
   *
   * 只在**牌局未开始**的大厅阶段可用；机器人等价于「已托管 + 已准备」：
   *   absent=true（服务器用 decide() 代打）、ready=true（凑齐即开局）、bot=true（UI 显示 🤖）。
   * uid 用 `bot:<tableId>:<seat>` 这种**唯一字符串**，绝不与任何真实用户 id 相撞；
   * 但它不是真人 → 记账时必须置空（见 ws/index.js recordStats），否则会撞 users 外键。
   *
   * 返回 { ok, seat } 或 { error }；开局与否由调用方（ws/index.js）决定并广播。
   */
  addBot(uid) {
    if (this.started) return { error: '牌局已开始，无法补位' };
    const i = this.seatOfUid(uid);
    if (i < 0) return { error: '不在牌桌上' };
    const empty = this.seats.findIndex((s) => s === null);
    if (empty < 0) return { error: '牌桌已满' };
    this.seats[empty] = {
      uid: `bot:${this.tableId}:${empty}`,
      username: `机器人${empty + 1}`,
      ready: true,
      socketId: null,
      connected: false,
      offlineSince: null,
      absent: true,
      bot: true,
      botSteps: 0,
    };
    return { ok: true, seat: empty };
  }

  /** 点「开始」；4 人齐 + 全 ready → 开局 / 开下一把 */
  ready(uid) {
    const i = this.seatOfUid(uid);
    if (i < 0) throw new Error('不在牌桌上');
    // 胡牌摊牌阶段先让四家点「确认」，别让「准备下一局」抢在结算页之前开下一把。
    if (this.state && this.state.reveal && this.state.reveal.pending) {
      throw new Error('请先确认本局结算');
    }
    this.seats[i].ready = true;

    // 「等下一把」或「整场已结束、等开新场」：托管 / 机器人座位**立即**自动 ready，
    // 不等巡检定时器（否则真人点了「准备下一局」要干等 ~1s 才开，甚至整场结束后永远开不了）。
    if (this.awaitingNext || this.finished) {
      for (const s of this.seats) if (s && s.absent) s.ready = true;
    }

    if (!this.started) {
      // 大厅首次开局，或整场结束后的「开新场」（finished 时 started 已置 false）
      if (this._allReady()) {
        this.start();
        return { event: 'started' };
      }
      return { event: 'ready' };
    }
    if (this.awaitingNext) {
      if (this._allReady()) {
        this.awaitingNext = false;
        this.newHand();
        return { event: 'next' };
      }
      return { event: 'ready' };
    }
    return { event: 'ready' };
  }

  start(opts = {}) {
    this.finished = false;
    this.awaitingNext = false;
    this.handNo = 0;
    this._settledHandNo = 0;
    this.completedResults = [];
    this.exitRequest = null;
    this.prevWildTile = null;
    this.prevWinnerSeat = null;
    this.baseSeed = opts.seed ?? null;
    // 首盘摸风定座：四家各抽一张牌比大小，最大者坐东做庄（出牌逆时针 东→北→西→南）。
    // baseSeed 给定则用它派生（可复现），否则随机。
    this.dealer = drawWinds(this.baseSeed != null ? this.baseSeed : (Date.now() % 1e9)).dealer;
    this.started = true;
    this.newHand();
  }

  newHand() {
    this._clearReady();
    clearTimeout(this._revealTimer);
    this._revealTimer = null;
    this.handNo++;
    const seed = this.baseSeed != null ? (this.baseSeed + this.handNo * 7919) % 1e9 : Date.now() % 1e9;
    const prevWildTile = this.prevWildTile;
    // 连金 / 反金（老吴 2026-10-24）：取**紧邻上一局**的赢家；荒庄（result.type !== 'win'）即断线
    const prevWinnerSeat = this.state && this.state.result && this.state.result.type === 'win'
      ? this.state.result.winner
      : null;
    const names = this.seats.map((s, i) => (s ? s.username : `座位${i + 1}`));
    const avatars = this.seats.map((s) => (s && s.avatar ? s.avatar : null));
    const ruleset = this.ruleset;
    this.state = createGame({
      seed,
      ruleset,
      dealer: this.dealer,
      prevWildTile,
      prevWinnerSeat,
      names,
      avatars,
      // 2026-10-29：对外只用这个随机局标识（前端做「成就播报去重」）。
      // seed 仍留在服务端算牌墙，**绝不下发** —— 洗牌是确定性的，给 seed 等于给透视挂。
      handTag: randomBytes(12).toString('hex'),
    });
    this.prevWildTile = this.state.wildTile;
    this.prevWinnerSeat = prevWinnerSeat;
    this.replayLog = {
      seed,
      dealer: this.dealer,
      prevWildTile,
      prevWinnerSeat,
      names: [...names],
      // 深拷贝：ruleset 是纯配置对象，落库后不能再受后续房间规则变更影响
      ruleset: JSON.parse(JSON.stringify(ruleset)),
      actions: [],
      players: this.seats.map((s, i) => ({
        seat: i,
        uid: s && !s.bot ? s.uid : null,
        username: s ? s.username : names[i],
        bot: !!(s && s.bot),
      })),
      startedAt: Date.now(),
    };
  }

  /** 处理某玩家动作：回合校验 → act 推进 → 结算推进 */
  applyAction(uid, action = {}) {
    const revealPending = !!(this.state && this.state.reveal && this.state.reveal.pending);
    if (!this.state || (this.state.phase === 'settled' && !revealPending)) {
      throw new Error('牌局未进行');
    }
    const seat = this.seatOfUid(uid);
    if (seat < 0) throw new Error('不在牌桌上');

    const legal = legalActions(this.state, seat);
    if (legal.length === 0) {
      // 回放只记录**成功**动作，所以「点了胡却被拒」在事后回放里完全看不到。
      // 这里把拒绝现场打到服务端日志，便于按时间对账（不记录手牌/令牌）。
      const st = this.state;
      const claim = st.phase === 'claim' && st.claims && st.claims[st.claimIndex];
      console.warn('[action-rejected]', JSON.stringify({
        tableId: this.tableId,
        handNo: this.handNo,
        uid,
        seat,
        type: action.type,
        phase: st.phase,
        turn: st.turn,
        claimSeat: claim ? claim.seat : null,
        claimOptions: claim ? claim.options.map((o) => o.type) : null,
        lastDraw: st.lastDraw,
        lastDiscard: st.lastDiscard,
        at: new Date().toISOString(),
      }));
      throw new Error('还没轮到你');
    }
    // 红中/皮子/癞子不能进牌河：老客户端仍可能发 discard，服务端认作对应特殊杠
    // （act 里也会再改判一次，见 src/engine/game.js）。
    const specialGang = action.type === 'discard' && this.state.ruleset.specialTilesNoDiscard !== false
      ? legal.find((a) => a.tile === action.tile
        && (a.type === 'redgang' || a.type === 'skingang' || a.type === 'wildgang'))
      : null;
    // 这些动作会**按 action.tile 从手里删牌**，所以牌值必须和合法动作逐张对上；
    // 只校验 type 的话，「红中杠 + 北风 tile」也能把北风当红中杠掉（老吴 2026-10-22 实测）。
    // 注意：chi / zhi / peng 的牌值由 state.lastDiscard 决定，bot 的 chi 甚至不带 tile，
    // 所以不在这条严格比对里。
    const tileMustMatch = new Set(['discard', 'an', 'xu', 'redgang', 'skingang', 'wildgang']);
    const ok = !!specialGang || legal.some((a) => {
      if (a.type !== action.type) return false;
      if (tileMustMatch.has(a.type) && a.tile !== action.tile) return false;
      return true;
    });
    if (!ok) throw new Error('非法动作：' + action.type);

    act(this.state, { ...action, seat });
    // 回放：记录服务端真正接受的动作（真人 / 托管 / 超时兜底 / 摊牌确认都走这里）。
    // 特殊牌 discard 被 act 改判成杠也没关系：回放时引擎会按同样规则再改判一次。
    if (this.replayLog) {
      this.replayLog.actions.push({
        seat,
        action: JSON.parse(JSON.stringify(action)),
      });
    }
    // 胡牌摊牌确认：四家都确认完（reveal.pending=false）才算真正结束，
    // 这时才做连庄/换庄与「等下一把」判定。确认期间不推进。
    if (this.state.phase === 'settled' && !(this.state.reveal && this.state.reveal.pending)) {
      this._onHandSettled();
    }
  }

  /** 结算后：连庄判定 + 是否整场结束 */
  _onHandSettled() {
    this._recordCompletedResult();
    const winner = this.state.result?.winnerSeat;
    // 老吴口径：庄家**胡牌**才连庄；否则庄家顺移（荒庄也顺移）
    if (winner === undefined || winner === null || winner !== this.dealer) {
      this.dealer = (this.dealer + 1) % SEATS;
    }
    if (this.handNo >= this.totalHands) {
      this.finished = true;
      this.started = false;
      this._clearReady();
    } else {
      this.awaitingNext = true;
    }
  }

  /** 服务端兜底自动过（claim 阶段超时），防某家掉线卡死整桌 */
  autoResolveCurrent() {
    if (!this.state || this.state.phase !== 'claim') return false;
    const seat = this.state.turn;
    const legal = legalActions(this.state, seat);
    const win = legal.find((x) => x.type === 'win');
    const pass = legal.find((x) => x.type === 'pass');
    // 在线真人能胡时，超时兜底不能替他「过」——否则 8 秒到点刚好点「胡」
    // 就会撞上「还没轮到你」。断线/托管座位仍由巡检代打，不会卡桌。
    const human = this.seats[seat] && this.seats[seat].connected && !this.seats[seat].absent;
    if (win && human) return false;
    const a = pass || win;
    if (!a) return false;
    this.applyAction(this.seats[seat].uid, a);
    return true;
  }

  viewFor(seat) {
    const v = this.state ? viewFor(this.state, seat) : null;
    if (!v) return v;
    /* 在线状态（老吴 2026-10-30「玩家不在线时头像显示黑白」）：
       `connected` 只存在 Room.seats 里，引擎视图没有这个概念 —— 在房间这一层补一列
       `others[].online`，前端据此把该家头像置灰。属于**公开信息**（谁在不在线，
       桌上本来就看得见），且只影响头像样式，不碰任何牌面数据。
       注意 `viewFor` 关掉的别家手牌约定不变：这里只加字段，不改牌。 */
    if (Array.isArray(v.others)) {
      v.others = v.others.map((o) => {
        const s = this.seats[o.seat];
        return { ...o, online: !!(s && s.connected) };
      });
    }
    return v;
  }

  /**
   * 当前该谁行动：settled → -1，其余取 `state.turn`。
   * 引擎在进入响应阶段时就把 `state.turn` 设成了 `claims[claimIndex].seat`（见 game.js
   * 的 beginClaims / doPass），所以出牌与响应两个阶段可以统一用 `turn` 表达 —— 与前端
   * 单机驱动 `actingSeat()` 同口径，两边必须一致，否则座位高亮与「等待 X 家」会错位。
   */
  actingSeat() {
    if (!this.state || this.state.phase === 'settled') return -1;
    return this.state.turn;
  }

  /** 前端渲染需要的房间级配置（只挑 UI 用得到的，不下发整份 RuleSet） */
  rulesetSummary() {
    this._rulesetSummary ??= {
      preset: this.rulesOverrides.preset || 'koukou',
      claimTimeoutMs: this._ruleset.claimTimeoutMs,
      canPassWin: this._ruleset.canPassWin,
      circleCount: this.circleCount,
    };
    return this._rulesetSummary;
  }

  /**
   * 单座位的状态载荷（`table:state` 的 body）。
   *
   * 除 `viewFor(seat)` 之外额外补三样东西 —— 它们都**不含别家暗牌**，只是把前端
   * 单机版能自己算、网络版算不了的部分放到服务端算：
   *   · `actingSeat` —— 客户端拿不到 `claims`，无法自行判定响应阶段该谁
   *   · `dealer`     —— 前端据此推「座位→方位」映射（庄家坐东，依次南/西/北）
   *   · `tenpai`     —— 听牌分析必须有完整引擎状态；实测 0.91ms/次（p90 2.74ms），
   *                     放进广播比让客户端再往返一次更划算
   */
  statePayload(seat) {
    // claim 阶段：把「本 seat 在响应队列里能做的选项」一并下发（myClaims）。
    // 只含自己能做的（自家手牌 + 当前弃牌即可算出的东西，本就不该泄露别家），
    // 客户端据此在响应阶段**始终渲染**吃/碰/杠/胡按钮，但非本家回合时置灰禁用
    // （点了服务端 legalActions 仍按 actingSeat 拒绝，落 [action-rejected] 日志兜底）。
    // 老吴 2026-10-26：修「网络对局吃家在碰家考虑时根本看不到吃按钮」。
    const inClaim = this.state && this.state.phase === 'claim'
      && Array.isArray(this.state.claims) && this.state.claims.length > 0;
    const myClaim = inClaim ? this.state.claims.find((c) => c.seat === seat) : null;
    return {
      seat,
      handNo: this.handNo,
      totalHands: this.totalHands,
      dealer: this.state ? this.state.dealer : this.dealer,
      actingSeat: this.actingSeat(),
      ruleset: this.rulesetSummary(),
      tenpai: this.state && this.state.phase !== 'settled' ? this.tenpaiFor(seat) : null,
      myClaims: myClaim ? myClaim.options.map((o) => ({ ...o })) : [],
      view: this.viewFor(seat),
    };
  }

  playersPayload() {
    return {
      tableId: this.tableId,
      name: this.name,
      started: this.started,
      awaitingNext: this.awaitingNext,
      finished: this.finished,
      handNo: this.handNo,
      totalHands: this.totalHands,
      circleCount: this.circleCount,
      dealer: this.state ? this.state.dealer : this.dealer,
      exitVote: this.exitVotePayload(),
      players: this.seats.map((s, i) =>
        s
          ? {
              seat: i,
              uid: s.uid,
              username: s.username,
              avatar: s.avatar ?? null,
              ready: s.ready,
              connected: s.connected,
              // 托管标记：前端据此在座位旁显示「托管」徽章（区别于「断线」）
              absent: !!s.absent,
              // 机器人补位标记：前端显示 🤖 且不提供「托管」按钮
              bot: !!s.bot,
              botSteps: s.botSteps || 0,
            }
          : null,
      ),
    };
  }
}

export class RoomManager {
  constructor() {
    this.rooms = new Map();
  }
  getOrCreate(tableRow) {
    let room = this.rooms.get(tableRow.id);
    if (!room) {
      room = new Room(tableRow);
      this.rooms.set(tableRow.id, room);
    }
    return room;
  }
  get(id) {
    return this.rooms.get(id);
  }
  remove(id) {
    this.rooms.delete(id);
  }
}
