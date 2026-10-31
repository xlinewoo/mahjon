// Socket.IO 网关（namespace /play）：握手鉴权 + 按 tableId 路由到 Room + 广播
//
// 事件（客户端 → 服务端）：auth(握手) / table:join / table:ready / action / reconnect / table:leave /
//                          table:setAbsent / table:addBot / table:exitRequest / table:exitVote
// 事件（服务端 → 客户端）：connected / table:players / table:started / table:state /
//                          table:handSettled / table:finished / error
//                          + 长断线：table:absent（手动托管 / 取消时下发） / table:resumed（本人重连撤销托管）
//                          + 退出投票：table:exitRequested / table:exitUpdated / table:exitRejected /
//                                     table:exitCancelled / table:exited
import { Server } from 'socket.io';
import db, { recordHandStats, recordHandRows, recordCareerStats, saveHandReplay, inTransaction } from '../db.js';
import { userFromToken } from '../auth.js';
import { RoomManager, SEATS } from './room.js';

// 已托管座位「周期巡检」间隔：轮到托管座位 / 等下一把时，按此间隔驱动代打与自动 ready。
// 取代过去按 dissolveMs 倒计时才巡检的做法（那会让托管轮次最多延迟到判离席点才动牌）。
const ABSENT_POLL_MS = 1000;
// 托管座位「出牌」节拍：一张一张地打，别一口气推进到结算（老吴 2026-10-20）。
const BOT_STEP_MS = 650;

// 胡牌摊牌确认的超时兜底：真人一直不点「确认」时，服务端替他确认，
// 避免整桌卡在摊牌界面（老吴 2026-10-20：四家都确认后才弹结算页）。
const REVEAL_CONFIRM_MS = 10000;

export function attachSocket(httpServer) {
  // CORS：默认回显来源（局域网 / 自托管够用）。生产可设
  // CORS_ORIGIN=https://你的域名（多个用逗号分隔）收紧到白名单。
  const corsOrigin = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean)
    : true;
  const io = new Server(httpServer, { path: '/play', cors: { origin: corsOrigin } });
  const rooms = new RoomManager();

  const tableRow = (id) => db.prepare('SELECT * FROM tables WHERE id = ?').get(id);
  const isMember = (clubId, uid) =>
    !!db.prepare('SELECT 1 AS x FROM club_members WHERE club_id = ? AND user_id = ?').get(clubId, uid);
  const setStatus = (id, status) => db.prepare('UPDATE tables SET status = ? WHERE id = ?').run(status, id);

  const replyErr = (socket, msg, cb) => {
    if (typeof cb === 'function') cb({ error: msg });
    socket.emit('error', { msg });
  };

  /**
   * 单连接动作节流（2026-10-29，P2 安全项）：令牌桶。
   *
   * 旧实现对入站事件**没有任何节流**：一个脚本每秒发几百个 action / join / addBot，
   * 服务端每次都要跑一遍引擎校验、失败还要广播全桌状态 —— 一个人就能把整桌卡死。
   * 真人出牌节奏顶多 2~3 次/秒，10 次/秒稳态 + 30 次突发完全够用。
   * 被限速的请求直接丢弃（连广播都不发），否则「广播本身」仍是放大器。
   */
  const ACTION_RATE_PER_SEC = 10;
  const ACTION_BURST = 30;
  const allowAction = (socket) => {
    const now = Date.now();
    const b = socket.data.bucket || (socket.data.bucket = { tokens: ACTION_BURST, ts: now });
    b.tokens = Math.min(ACTION_BURST, b.tokens + ((now - b.ts) / 1000) * ACTION_RATE_PER_SEC);
    b.ts = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
  /**
   * 被限速时的回绝：**只回 ack，不逐条 emit**。
   * 限速时客户端每秒可能发几百条，逐条 emit error 本身又是一层放大器。
   */
  const refuseThrottled = (socket, cb) => {
    if (typeof cb === 'function') cb({ error: '操作过于频繁，请稍候' });
  };

  const broadcastPlayers = (room) => io.to(`table:${room.tableId}`).emit('table:players', room.playersPayload());

  // 结算后把本把战绩增量写入俱乐部战绩榜（附加账本；失败不影响牌局）
  const recordStats = (room) => {
    const row = tableRow(room.tableId);
    if (!row) return;
    const result = room.state && room.state.result;
    if (!result || !Array.isArray(result.perSeat)) return;
    const seats = room.seats;
    const rows = result.perSeat.map((p) => ({
      // 机器人补位座（uid 是 'bot:...'）不是真人 → 置空，别撞 users 外键，也别记账
      uid: seats[p.seat] && !seats[p.seat].bot ? seats[p.seat].uid : null,
      username: p.name,
      delta: p.delta,
      fan: p.fan,
      gangs: p.gangs,
      isWinner: p.isWinner,
      huType: p.huType,
    }));
    recordHandStats(row.club_id, rows);
    // 逐把流水：个人「当日 / 当月 / 当年」统计的数据源（附加账本，失败不影响牌局）
    recordHandRows(row.club_id, room.handNo, rows);
    // 个人跨俱乐部生涯累计：「全部」口径的数据源（不看 club_id）
    recordCareerStats(rows);
  };

  // 把房间里的完整动作日志落成可回放的一把牌。失败只记日志，不影响牌局/结算。
  const recordReplay = (room) => {
    const log = room.replayLog;
    const result = room.state && room.state.result;
    if (!log || !result) return;
    try {
      room.lastReplayId = saveHandReplay({
        clubId: room.clubId,
        tableId: room.tableId,
        tableName: room.name,
        handNo: room.handNo,
        seed: log.seed,
        dealer: log.dealer,
        prevWildTile: log.prevWildTile,
        prevWinnerSeat: log.prevWinnerSeat == null ? null : log.prevWinnerSeat,
        names: log.names,
        ruleset: log.ruleset,
        actions: log.actions,
        result,
        players: log.players,
        ts: Math.floor(Date.now() / 1000),
      });
    } catch (e) {
      console.error('[牌局回放] 保存失败：', (e && e.message) || e);
    }
  };

  /** 退出投票通过：整场立即结束（当前未打完的这把不算），清掉所有对局定时器。 */
  const finishExitGame = (room, final) => {
    setStatus(room.tableId, 'idle');
    clearTimeout(room._claimTimer);
    clearTimeout(room._sweepTimer);
    clearTimeout(room._revealTimer);
    room._claimTimer = null;
    room._sweepTimer = null;
    room._revealTimer = null;
    room.replayLog = null; // 当前这把没打完，不落回放
    io.to(`table:${room.tableId}`).emit('table:exited', final);
    broadcastPlayers(room);
  };

  const broadcastState = (room) => {
    for (let seat = 0; seat < SEATS; seat++) {
      const p = room.seats[seat];
      if (!p || !p.socketId) continue;
      io.to(p.socketId).emit('table:state', room.statePayload(seat));
    }
    armClaimTimer(room);
    armSweep(room);
    armRevealTimer(room);
  };

  /**
   * 一把「真正结束」后的事件（结算事件 / 整场结束）。
   * 胡牌要等四家确认完（reveal.pending=false）才调到这里；荒庄直接调。
   * 用 `_settledHandNo` 去重，防巡检 + 动作 + 超时兜底三条路径重复发/重复记账。
   */
  const emitSettled = (room) => {
    if (room._settledHandNo === room.handNo) return;
    room._settledHandNo = room.handNo;
    // 回放必须覆盖**每一把**，包括整场最后一把（原 recordStats 只在 else 分支调用）。
    // 回放尽力而为：内部自吞错，不影响账本（与既有语义一致）。
    recordReplay(room);
    // 三张战绩表合并为**一个事务**（2026-10-24）：此前 recordHandStats / recordHandRows /
    // recordCareerStats 各写各的事务，部分失败会留下互相矛盾的账本；
    // inTransaction 已可重入，内层嵌套事务自动交给这里统一提交/回滚。
    // 最后一把也要进战绩账本（以前只在 else 分支调用，整场最后一把会被漏记）。
    inTransaction(() => recordStats(room));
    if (room.finished) {
      setStatus(room.tableId, 'idle');
      clearTimeout(room._claimTimer);
      clearTimeout(room._sweepTimer);
      clearTimeout(room._revealTimer);
      if (room.exitRequest) {
        room.exitRequest = null;
        io.to(`table:${room.tableId}`).emit('table:exitCancelled', { reason: 'finished' });
      }
      io.to(`table:${room.tableId}`).emit('table:finished', {
        reason: 'finished',
        handNo: room.handNo,
        totalHands: room.totalHands,
        completedHands: room.completedResults.length,
        standings: room.standings(),
      });
    } else {
      io.to(`table:${room.tableId}`).emit('table:handSettled', {
        handNo: room.handNo,
        nextDealer: room.dealer,
        result: room.state.result,
      });
    }
    broadcastPlayers(room);
  };

  // 摊牌确认超时兜底：到点仍有人没点「确认」→ 服务端替他确认（含在线的真人）。
  function armRevealTimer(room) {
    clearTimeout(room._revealTimer);
    room._revealTimer = null;
    if (!room.state || !room.state.reveal || !room.state.reveal.pending) return;
    room._revealTimer = setTimeout(() => {
      try {
        if (!room.state || !room.state.reveal || !room.state.reveal.pending) return;
        for (let seat = 0; seat < SEATS; seat++) {
          if (room.state.reveal.confirmed.includes(seat)) continue;
          const p = room.seats[seat];
          if (!p) continue;
          // 单个座位异常不能卡住其余三家的兜底确认（否则计时器已清、整桌死等）。
          try { room.applyAction(p.uid, { type: 'confirm' }); }
          catch (e) { console.error('[摊牌确认] 座位兜底失败：', seat, (e && e.message) || e); }
        }
        broadcastState(room);
        if (room.state.phase === 'settled' && !(room.state.reveal && room.state.reveal.pending)) {
          emitSettled(room);
        }
      } catch (e) {
        console.error('[摊牌确认] 兜底异常：', (e && e.message) || e);
      }
    }, REVEAL_CONFIRM_MS);
    room._revealTimer.unref?.();
  }

  // 服务端兜底：claim 阶段超时自动「过」，防止某家掉线卡死整桌
  function armClaimTimer(room) {
    clearTimeout(room._claimTimer);
    if (!room.state || room.state.phase !== 'claim') return;
    const ms = room.state.ruleset.claimTimeoutMs || 8000;
    room._claimTimer = setTimeout(() => {
      try {
        if (!room.state || room.state.phase !== 'claim') return;
        if (room.autoResolveCurrent()) {
          broadcastState(room);
        } else {
          // 在线真人能胡：不替他过，但保留巡检；等他点胡/过、断线或托管后再处理。
          armClaimTimer(room);
        }
      } catch {
        /* 忽略兜底过程中的异常，避免进程崩溃 */
      }
    }, ms);
    room._claimTimer.unref?.();
  }

  /**
   * 离席巡检定时器 —— **只决定「什么时候再看一眼」**，判定与推进全在
   * `room.sweepOffline()`（纯决策、可用假时间戳单测）。
   *
   * 间隔取「最近一个到期时间」，不按固定频率空转；没有断线者、或牌局尚未开始
   * （大厅里干坐着不 ready 是正常状态）就完全不挂定时器。
   */
  /**
   * 内存回收（2026-10-24 修 Room 泄漏）：Room 持有整副牌墙、四家手牌与全量回放日志，
   * `RoomManager.remove` 此前从未被调用 ⇒ rooms Map 只增不减，是长跑进程唯一确定的
   * 无界增长点。规则：**整场已结束、或从没开局**，且没有任何在线座位 → 清定时器并删房。
   * 牌局进行中绝不删（「断线再久也不结束牌局、重连拿回原座」的语义不变，见 armSweep 挂起逻辑）。
   * 已删房间的在途定时器由 runSweep 的 `rooms.get` 守卫自行终止，无需额外处理。
   */
  function maybeDropRoom(room) {
    const vacant = room.seats.every((s) => !s || !s.connected);
    if (!vacant || (room.started && !room.finished)) return;
    clearTimeout(room._claimTimer);
    clearTimeout(room._sweepTimer);
    clearTimeout(room._revealTimer);
    room._claimTimer = null;
    room._sweepTimer = null;
    room._revealTimer = null;
    rooms.remove(room.tableId);
  }

  function armSweep(room) {
    clearTimeout(room._sweepTimer);
    room._sweepTimer = null;
    if (room.finished) return;
    if (!room.started && !room.awaitingNext) return;
    const revealPending = !!(room.state && room.state.reveal && room.state.reveal.pending);
    const absent = room.absentSeats();
    if (absent.length === 0) return;
    // 没有任何在线玩家时整桌「挂起」：不再驱动任何离席巡检
    // （既避免无人观战时服务器替所有人自走，也避免空桌定时空转）。
    // 任一人重连时 joinTable 会重新 armSweep 唤醒。
    if (!room.seats.some((s) => s && s.connected)) return;

    // 只驱动「已托管」座位（由 table:setAbsent 手动触发）；
    // 未托管的断线者只等本人重连或他人点「托管」按钮，不自动代打、不挂定时器空转。
    let delay = Infinity;
    for (const i of absent) {
      if (room.awaitingNext
          || (revealPending && room.state && !room.state.reveal.confirmed.includes(i))) {
        // 等下一把 / 摊牌还没替它确认：按巡检间隔处理
        delay = Math.min(delay, ABSENT_POLL_MS);
      } else if (room.actingSeat() === i) {
        // 轮到托管座位：按出牌节拍逐张推进
        delay = Math.min(delay, BOT_STEP_MS);
      }
      // 已托管但非其回合、非等下一把：靠 broadcastState 的 re-arm 在回合/阶段
      // 变化时再触发，这里不定时空转
    }
    if (!Number.isFinite(delay)) return;
    // 下限 300ms：即便房主把阈值调得极小（联调里 claimTimeoutMs=200），也只是
    // 300ms 巡检一次，不会自旋打满 CPU
    room._sweepTimer = setTimeout(() => runSweep(room), Math.max(300, delay));
    room._sweepTimer.unref?.();
  }

  function runSweep(room) {
    if (!rooms.get(room.tableId)) return; // 房间已被移除
    let out;
    try {
      out = room.sweepOffline();
    } catch (e) {
      console.error('[离席巡检] 异常：', (e && e.message) || e);
      armSweep(room);
      return;
    }

    if (out.steps || out.startedNext || out.settled) {
      broadcastPlayers(room);
      broadcastState(room); // 内部会重新 armSweep / armRevealTimer
      if (out.settled) emitSettled(room);
    } else {
      armSweep(room); // 本轮无变化：手动续上下一次巡检
    }
  }

  // 握手鉴权：客户端在 io(url, { auth: { token } }) 里带 JWT
  // 2026-10-29：改用 userFromToken —— 除验签外还比对 token_version，
  // 这样「改密 / 登出」后已建立的与新建的连接都会被拒（socket 断开由前端重新登录兜底）。
  io.use((socket, next) => {
    const payload = userFromToken(socket.handshake.auth?.token);
    if (!payload) return next(new Error('unauthorized'));
    // 头像随用户走（预设 emoji / 上传文件名），座位卡与 3D 牌桌 HUD 都要用
    const urow = db.prepare('SELECT avatar_type, avatar_value FROM users WHERE id = ?').get(payload.id);
    socket.data.user = {
      id: payload.id,
      username: payload.username,
      avatar: urow ? { type: urow.avatar_type, value: urow.avatar_value } : null,
    };
    next();
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    socket.emit('connected', { user });

    const joinTable = (tableId, cb) => {
      if (!allowAction(socket)) return refuseThrottled(socket, cb);
      const row = tableRow(Number(tableId));
      if (!row) return replyErr(socket, '牌桌不存在', cb);
      if (!isMember(row.club_id, user.id)) return replyErr(socket, '不是该俱乐部成员', cb);

      // 幽灵座位修复（2026-10-24）：换桌前先从旧桌断开。此前直接覆盖 socket.data.tableId，
      // 旧桌座位的 connected=true 永不清理，而超时代打对「在线真人」拒绝代过
      // ⇒ 旧桌可能永久卡死在响应阶段。
      if (socket.data.tableId != null && socket.data.tableId !== row.id) {
        const oldRoom = rooms.get(socket.data.tableId);
        if (oldRoom) {
          const cancelled = oldRoom.cancelExit(user.id, 'leave');
          oldRoom.disconnect(user.id, socket.id);
          if (cancelled) {
            io.to(`table:${oldRoom.tableId}`).emit('table:exitCancelled', cancelled);
          }
          broadcastPlayers(oldRoom);
          if (rooms.get(oldRoom.tableId)) {
            armSweep(oldRoom);
            maybeDropRoom(oldRoom);
          }
        }
      }

      const room = rooms.getOrCreate(row);
      const res = room.join(user, socket.id);
      if (res.error) return replyErr(socket, res.error, cb);

      socket.data.tableId = room.tableId;
      socket.data.seat = res.seat;
      socket.join(`table:${room.tableId}`);
      if (row.status === 'idle') setStatus(row.id, 'waiting');

      if (typeof cb === 'function') {
        cb({ ok: true, seat: res.seat, reconnected: res.reconnected, wasAbsent: !!res.wasAbsent });
      }
      if (res.wasAbsent) {
        // 本人回来了 → 撤销托管，通知全桌（牌从机器人手里交还给人）
        io.to(`table:${room.tableId}`).emit('table:resumed', { seat: res.seat, username: user.username });
      }
      broadcastPlayers(room);
      // 重连/中途加入：直接补发最新视图
      if (room.state) socket.emit('table:state', room.statePayload(res.seat));
      armSweep(room); // 断线者回来了 → 清掉离席倒计时
    };

    socket.on('table:join', ({ tableId } = {}, cb) => joinTable(tableId, cb));
    // reconnect 与 join 语义相同（幂等），单独留事件名兼容设计文档
    socket.on('reconnect', ({ tableId } = {}, cb) => joinTable(tableId, cb));

    socket.on('table:ready', (payload, cb) => {
      if (!allowAction(socket)) return refuseThrottled(socket, cb);
      const room = rooms.get(socket.data.tableId);
      if (!room) return replyErr(socket, '未加入牌桌', cb);
      try {
        const r = room.ready(user.id);
        if (r.event === 'started') {
          setStatus(room.tableId, 'playing');
          io.to(`table:${room.tableId}`).emit('table:started', {
            handNo: room.handNo,
            dealer: room.state.dealer,
            totalHands: room.totalHands,
          });
        } else if (r.event === 'next') {
          io.to(`table:${room.tableId}`).emit('table:started', {
            handNo: room.handNo,
            dealer: room.state.dealer,
            totalHands: room.totalHands,
          });
        }
        broadcastPlayers(room);
        broadcastState(room);
        if (typeof cb === 'function') cb({ ok: true, event: r.event });
      } catch (e) {
        replyErr(socket, e.message, cb);
      }
    });

    // 单人验证：往空座补一个「服务端机器人」（仅大厅阶段，未开局）。
    // 机器人等价于「已托管 + 已准备」，故补位后若四人齐 + 全 ready 就直接开局。
    socket.on('table:addBot', (payload, cb) => {
      if (!allowAction(socket)) return refuseThrottled(socket, cb);
      const room = rooms.get(socket.data.tableId);
      if (!room) return replyErr(socket, '未加入牌桌', cb);
      const r = room.addBot(user.id);
      if (r.error) return replyErr(socket, r.error, cb);
      if (!room.started && room._allReady()) {
        room.start();
        setStatus(room.tableId, 'playing');
        io.to(`table:${room.tableId}`).emit('table:started', {
          handNo: room.handNo,
          dealer: room.state.dealer,
          totalHands: room.totalHands,
        });
      }
      broadcastPlayers(room);
      broadcastState(room);
      if (typeof cb === 'function') cb({ ok: true, seat: r.seat });
    });

    socket.on('action', (action, cb) => {
      if (!allowAction(socket)) return refuseThrottled(socket, cb);
      const room = rooms.get(socket.data.tableId);
      if (!room) return replyErr(socket, '未加入牌桌', cb);
      try {
        room.applyAction(user.id, action || {});
        broadcastState(room);
        // 胡牌：四家确认完（reveal.pending=false）才算结算完成；荒庄直接走到这里。
        if (room.state.phase === 'settled'
            && !(room.state.reveal && room.state.reveal.pending)) {
          emitSettled(room);
        }
        if (typeof cb === 'function') cb({ ok: true });
      } catch (e) {
        const msg = (e && e.message) || String(e);
        // 先回错误 ack / error，再广播最新 state：
        // ① 让 net-driver 先收到 ack.error 并 reject（否则会被随后到达的 state 误判成功）；
        // ② 任何被拒动作（含过期按钮的「非法动作：win」）都强制客户端回到服务端真状态，
        //    避免旧的「胡」按钮一直留在界面上、连点继续报非法。
        replyErr(socket, msg, cb);
        try { broadcastState(room); } catch { /* 牌桌可能已销毁 */ }
      }
    });

    socket.on('table:leave', (payload, cb) => {
      if (!allowAction(socket)) return refuseThrottled(socket, cb);
      const room = rooms.get(socket.data.tableId);
      if (room) {
        socket.leave(`table:${room.tableId}`);
        const cancelled = room.cancelExit(user.id, 'leave');
        room.disconnect(user.id, socket.id);
        if (cancelled) {
          io.to(`table:${room.tableId}`).emit('table:exitCancelled', cancelled);
        }
        broadcastPlayers(room);
        if (rooms.get(room.tableId)) {
          armSweep(room); // 主动离开同样进入离席倒计时
          maybeDropRoom(room);
        }
      }
      socket.data.tableId = null;
      socket.data.seat = null;
      if (typeof cb === 'function') cb({ ok: true });
    });

    // 手动托管 / 取消托管（老吴 2026-10-02 后续：取消「断线自动托管」）。
    // 只允许托管「本人」或「已断线的座位」；在线的其他玩家不可被托管。
    socket.on('table:setAbsent', ({ seat, on } = {}, cb) => {
      if (!allowAction(socket)) return refuseThrottled(socket, cb);
      const room = rooms.get(socket.data.tableId);
      if (!room) return replyErr(socket, '未加入牌桌', cb);
      const target = room.seats[seat];
      if (!target) return replyErr(socket, '座位不存在', cb);
      const iAm = target.uid === user.id;
      const isOffline = !target.connected;
      if (!iAm && !isOffline) return replyErr(socket, '不能托管在线的其他玩家', cb);
      const r = room.setAbsent(target.uid, !!on);
      if (r.error) return replyErr(socket, r.error, cb);
      io.to(`table:${room.tableId}`).emit('table:absent', {
        seats: [r.seat],
        usernames: [target.username],
        autoPlay: true,
        manual: true,
        on: !!on,
      });
      // 托管 / 取消托管也可能让「四家齐 + 全 ready」达成：补发开局，避免卡在大厅。
      if (r.event === 'started' || r.event === 'next') {
        setStatus(room.tableId, 'playing');
        io.to(`table:${room.tableId}`).emit('table:started', {
          handNo: room.handNo,
          dealer: room.state.dealer,
          totalHands: room.totalHands,
        });
      }
      broadcastPlayers(room);
      broadcastState(room);
      if (typeof cb === 'function') cb({ ok: true, seat: r.seat, absent: r.absent });
      if (r.absent) armSweep(room); // 托管后立即驱动代打 / 自动 ready
    });

    // 退出游戏：发起人之外的三家全同意才结束本场；任何一家拒绝 → 牌局继续。
    socket.on('table:exitRequest', (payload, cb) => {
      if (!allowAction(socket)) return refuseThrottled(socket, cb);
      const room = rooms.get(socket.data.tableId);
      if (!room) return replyErr(socket, '未加入牌桌', cb);
      const r = room.requestExit(user.id);
      if (r.error) return replyErr(socket, r.error, cb);
      if (r.event === 'exited') {
        finishExitGame(room, r.final);
      } else {
        io.to(`table:${room.tableId}`).emit('table:exitRequested', r.vote);
        broadcastPlayers(room);
      }
      if (typeof cb === 'function') cb({ ok: true, event: r.event, vote: r.vote || null });
    });

    socket.on('table:exitVote', ({ agree } = {}, cb) => {
      if (!allowAction(socket)) return refuseThrottled(socket, cb);
      const room = rooms.get(socket.data.tableId);
      if (!room) return replyErr(socket, '未加入牌桌', cb);
      const r = room.voteExit(user.id, !!agree);
      if (r.error) return replyErr(socket, r.error, cb);
      if (r.event === 'exited') {
        finishExitGame(room, r.final);
      } else if (r.event === 'rejected') {
        io.to(`table:${room.tableId}`).emit('table:exitRejected', {
          bySeat: r.bySeat,
          byName: r.byName,
        });
        broadcastPlayers(room);
      } else {
        io.to(`table:${room.tableId}`).emit('table:exitUpdated', r.vote);
        broadcastPlayers(room);
      }
      if (typeof cb === 'function') cb({ ok: true, event: r.event });
    });

    socket.on('disconnect', () => {
      const room = rooms.get(socket.data.tableId);
      if (room) {
        const cancelled = room.cancelExit(user.id, 'disconnect');
        room.disconnect(user.id, socket.id);
        if (cancelled) {
          io.to(`table:${room.tableId}`).emit('table:exitCancelled', cancelled);
        }
        broadcastPlayers(room);
        if (rooms.get(room.tableId)) {
          armSweep(room); // 断线 → 挂上巡检（房间若因空置被回收则不再挂）
          maybeDropRoom(room);
        }
      }
    });
  });

  return { io, rooms };
}
