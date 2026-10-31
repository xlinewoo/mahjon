// Room 会话单元测试（进程内驱动，不依赖 socket）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room, RoomManager, SEATS } from '../ws/room.js';
import { createGame, act, legalActions } from '../../src/engine/game.js';
import { createRuleSet } from '../../src/engine/rules.js';
import { makeTile, WHITE_DRAGON } from '../../src/engine/tiles.js';

const TABLE = {
  id: 999,
  club_id: 1,
  name: '测试桌',
  owner_id: 1,
  rule_json: JSON.stringify({ preset: 'koukou' }),
  circle_count: 1,
};

const mkUser = (id) => ({ id, username: 'u' + id });

/** 起一桌开打（4 人入座 + 全 ready） */
function openedRoom(table = TABLE) {
  const room = new Room(table);
  for (let i = 1; i <= 4; i++) room.join(mkUser(i), 'sock' + i);
  for (let i = 1; i <= 4; i++) room.ready(i);
  return room;
}

/**
 * 胡牌摊牌确认：四家各点一次「确认」（老吴 2026-10-20 之后必须走这一步，
 * 否则 room 的连庄 / awaitingNext 不会推进）。荒庄没有摊牌阶段，直接跳过。
 */
function confirmAll(room) {
  let guard = 0;
  while (room.state.reveal && room.state.reveal.pending && guard++ < 4) {
    const seat = [0, 1, 2, 3].find((i) => !room.state.reveal.confirmed.includes(i));
    if (seat === undefined) break;
    room.applyAction(room.seats[seat].uid, { type: 'confirm' });
  }
}

/** 进程内驱动一整把：优先出牌 → 过 */
function driveHand(room) {
  let guard = 0;
  while (room.state.phase !== 'settled' && guard++ < 5000) {
    const seat = room.state.turn;
    const uid = room.seats[seat].uid;
    const legal = legalActions(room.state, seat);
    const a = legal.find((x) => x.type === 'discard') || legal.find((x) => x.type === 'pass') || legal[0];
    room.applyAction(uid, a);
  }
  confirmAll(room);
  return guard;
}

/**
 * 一人全程掉线、其余三家正常打的整把推进：
 * 轮到托管座位 → 交给 sweepOffline 代打；轮到在线座位 → 「优先出牌 → 过」。
 * 用来证明「有人掉线到底」不会把整桌卡死（sweepOffline 一步都推进不了就抛错）。
 */
function driveHandWithAbsent(room) {
  let guard = 0;
  let botSteps = 0;
  while (room.state.phase !== 'settled' && guard++ < 20000) {
    const seat = room.actingSeat();
    if (room.seats[seat] && room.seats[seat].absent) {
      const out = room.sweepOffline();
      if (out.steps === 0) throw new Error(`托管座位 ${seat} 一步都没推进（死锁）`);
      botSteps += out.steps;
    } else {
      const legal = legalActions(room.state, seat);
      const a = legal.find((x) => x.type === 'discard') || legal.find((x) => x.type === 'pass') || legal[0];
      room.applyAction(room.seats[seat].uid, a);
    }
  }
  confirmAll(room);
  return { guard, botSteps };
}

test('回放日志：newHand 记录发牌配置，applyAction 记录全量动作（含摊牌确认）', () => {
  const room = openedRoom();
  const log = room.replayLog;
  assert.ok(log, 'newHand 后应有回放日志');
  assert.equal(log.dealer, room.state.dealer);
  assert.equal(log.seed, room.state.seed);
  assert.equal(log.prevWildTile, null);
  assert.deepEqual(log.names, ['u1', 'u2', 'u3', 'u4']);
  assert.deepEqual(log.players.map((p) => p.uid), [1, 2, 3, 4]);

  driveHand(room);
  assert.ok(log.actions.length > 10, `动作日志应包含整把（实际 ${log.actions.length}）`);
  if (room.state.reveal) {
    assert.ok(log.actions.some((a) => a.action.type === 'confirm'), '摊牌确认也要进日志');
  }

  // 用日志独立复算，终局必须一致（回放播放器依赖这一点）
  const rebuilt = createGame({
    seed: log.seed,
    ruleset: log.ruleset,
    dealer: log.dealer,
    prevWildTile: log.prevWildTile,
    names: log.names,
  });
  for (const { seat, action } of log.actions) act(rebuilt, { ...action, seat });
  assert.deepEqual(rebuilt.result, room.state.result);
  assert.deepEqual(rebuilt.players.map((p) => p.hand), room.state.players.map((p) => p.hand));
});

test('4 人入座 + 全 ready 才开局；动作校验与轮转', () => {
  const room = new Room(TABLE);
  assert.equal(room.totalHands, 4, '1 圈 = 4 把');

  for (let i = 1; i <= 4; i++) {
    const r = room.join(mkUser(i), 'sock' + i);
    assert.equal(r.seat, i - 1);
  }
  assert.equal(room.join(mkUser(5), 'sock5').error, '牌桌已满');

  // 3 人 ready 不开局
  room.ready(1); room.ready(2); room.ready(3);
  assert.equal(room.started, false, '3 人 ready 不开局');
  // 第 4 人 ready 开局
  room.ready(4);
  assert.equal(room.started, true);
  assert.equal(room.state.phase, 'discard');
  assert.equal(room.handNo, 1);

  // 非当前回合者出牌 → 抛错
  const notTurn = room.state.turn === 0 ? 2 : 1;
  assert.throws(
    () => room.applyAction(room.seats[notTurn].uid, { type: 'discard', tile: room.state.players[notTurn].hand[0] }),
    /还没轮到你/,
  );
  // 不在座的 uid → 抛错
  assert.throws(() => room.applyAction(9999, { type: 'discard', tile: 0 }), /不在牌桌上/);
});

test('走完一把 → awaitingNext；连庄/顺移；圈满 → finished', () => {
  const room = new Room(TABLE);
  for (let i = 1; i <= 4; i++) room.join(mkUser(i), 'sock' + i);
  for (let i = 1; i <= 4; i++) room.ready(i);
  assert.equal(room.started, true);

  const dealer0 = room.state.dealer;
  const winner = driveHand(room);
  assert.ok(winner < 5000, '一把应在有限手数内结束');
  assert.equal(room.state.phase, 'settled');
  assert.equal(room.awaitingNext, true, '非末把 → 等待下一把');

  // 连庄规则：庄家胡才连庄，否则顺移
  const w = room.state.result?.winnerSeat;
  if (w === dealer0) assert.equal(room.dealer, dealer0, '庄家胡 → 连庄');
  else assert.equal(room.dealer, (dealer0 + 1) % 4, '非庄家胡/荒庄 → 庄家顺移');

  // 把剩下几把打完 → finished
  let played = room.handNo;
  while (!room.finished && played < 10) {
    for (let i = 1; i <= 4; i++) room.ready(i); // 四人再 ready 开下一把
    driveHand(room);
    played = room.handNo;
  }
  assert.equal(room.finished, true, '打满 totalHands 后整场结束');
  assert.equal(room.started, false);
});

test('断线保留座位，重连拿回原座位', () => {
  const room = new Room(TABLE);
  room.join(mkUser(1), 'sock1');
  room.join(mkUser(2), 'sock2');

  room.disconnect(1, 'sock1');
  const seat1 = room.seats[0];
  assert.equal(seat1.connected, false, '断线后标记未连接');
  assert.equal(seat1.uid, 1, '座位保留（供重连）');

  const re = room.join(mkUser(1), 'sock1b');
  assert.equal(re.reconnected, true);
  assert.equal(re.seat, 0, '重连拿回原座位');
  assert.equal(room.seats[0].connected, true);
  assert.equal(room.seats[0].socketId, 'sock1b');

  // 旧 socket 的断开不应影响已被新连接接管的座位
  room.disconnect(1, 'sock1');
  assert.equal(room.seats[0].connected, true, '旧 socket 断开被忽略');
});

test('视图带 others[].online：断线置 false、重连回 true（老吴 2026-10-30 头像灰化）', () => {
  const room = openedRoom();
  const onlineOf = (viewSeat, otherSeat) => {
    const v = room.viewFor(viewSeat);
    const o = (v.others || []).find((x) => x.seat === otherSeat);
    assert.ok(o, '别人的座位必须出现在 others 里');
    return o.online;
  };

  // 开局全员在线
  for (const s of [1, 2, 3]) assert.equal(onlineOf(0, s), true, `seat ${s} 初始在线`);
  assert.equal(onlineOf(1, 0), true);

  // seat 1 掉线 → 其余三家看到的都是「不在线」；他本人的视图看不到自己那一格
  room.disconnect(2, 'sock2');   // uid=2 坐的是 seat 1
  for (const s of [0, 1, 2, 3]) {
    if (s === 1) continue;
    assert.equal(onlineOf(s, 1), false, `视角 ${s} 应看到 seat 1 掉线`);
  }
  assert.equal(onlineOf(0, 2), true, '其他座位不受影响');

  // 重连 → 立刻恢复在线（服务端 join 会把 connected 置回 true）
  room.join(mkUser(2), 'sock2b');
  assert.equal(onlineOf(3, 1), true, '重连后恢复正常');

  // playersPayload 的 connected 与 online 必须同口径（前端两处数据源不能打架）
  room.disconnect(4, 'sock4');
  const payload = room.playersPayload();
  assert.equal(payload.players[3].connected, false);
  assert.equal(onlineOf(0, 3), false);
});

test('RoomManager：同一 tableId 复用同一 Room', () => {
  const rm = new RoomManager();
  const a = rm.getOrCreate(TABLE);
  const b = rm.getOrCreate(TABLE);
  assert.equal(a, b);
  assert.equal(rm.get(TABLE.id), a);
});

/* ============================================================
 * 手动托管（Room.setAbsent）+ 托管后代打
 *
 * 老吴 2026-10-02 后续需求：取消「断线自动托管」，改为某位在线玩家
 * **主动点「托管」按钮**才托管（Room.setAbsent / table:setAbsent）。
 * 一旦托管，sweepOffline 仍负责「代打 / 自动 ready」，这部分逻辑不变。
 * 定时器（setTimeout）只活在 ws/index.js，这里用假时钟覆盖「长断线」分支。
 * ============================================================ */

const T0 = 1_000_000; // 假时钟起点

// 2026-10-17：offlinePolicy 已随「自动托管 / 自动判离席」一并删除，其单测同时移除。

test('牌局未开始时不巡检：大厅里不 ready 是正常状态，不能判离席', () => {
  const room = new Room(TABLE);
  for (let i = 1; i <= 4; i++) room.join(mkUser(i), 'sock' + i);
  for (let i = 1; i <= 4; i++) room.disconnect(i, 'sock' + i);

  const out = room.sweepOffline(); // 一小时都不回来也不巡检（未开局）
  assert.deepEqual(out.absent, [], '未开局 → 不托管');
  assert.equal(out.steps, 0);
  assert.equal(room.seats.filter(Boolean).length, 4, '座位全部保留');
});

test('断线不会自动托管：光断线、不点按钮，牌局原地等待（不卡死、不代打）', () => {
  const room = openedRoom();
  const seat = room.actingSeat();
  room.seats[seat].connected = false;
  room.seats[seat].socketId = null;
  room.seats[seat].offlineSince = T0;

  // 即便远超原「托管阈值」很久，只要没人点按钮，就不托管、不代打
  const out = room.sweepOffline();
  assert.deepEqual(out.absent, [], '无人点按钮 → 不托管');
  assert.equal(out.steps, 0, '不代打');
  assert.equal(room.state.phase, 'discard', '牌局原地等待（掉线玩家的回合，等本人回来或他人托管）');
  assert.equal(room.seats[seat].absent, false);
});

test('主动点托管 → 由服务器代打（出牌阶段不再死锁）', () => {
  const room = openedRoom();
  const seat = room.actingSeat();
  const uid = room.seats[seat].uid;
  room.seats[seat].connected = false;
  room.seats[seat].offlineSince = T0;

  const r = room.setAbsent(uid, true);
  assert.equal(r.ok, true);
  assert.equal(r.seat, seat);
  assert.equal(room.seats[seat].absent, true, '点托管 → 标记 absent');

  let out = room.sweepOffline();
  assert.equal(out.steps, 1, '一次巡检只代打一步（逐张出牌，不一口气跳到结算）');
  let steps = out.steps;
  // 可能先杠再出牌（杠后仍由同一家补摸），多巡检几次；每次也只能走一步。
  for (let i = 0; i < 5 && room.actingSeat() === seat && room.state.phase !== 'settled'; i++) {
    out = room.sweepOffline();
    assert.equal(out.steps, 1, '后续巡检同样一次只走一步');
    steps += out.steps;
  }
  assert.notEqual(room.actingSeat(), seat, '回合已交出去（不再卡在掉线玩家）');
  assert.equal(room.seats[seat].botSteps, steps, '代打步数记在座位上');
});

test('一人掉线到底也能打完一把（手动托管后，不再“四个人卡死等一个”）', () => {
  const room = openedRoom();
  const seat = room.actingSeat();
  const uid = room.seats[seat].uid;
  room.seats[seat].connected = false;
  room.seats[seat].offlineSince = T0;
  room.setAbsent(uid, true); // 先由按钮托管
  assert.ok(room.seats[seat].absent);

  const { guard, botSteps } = driveHandWithAbsent(room);
  assert.ok(guard < 20000, '一把在有限手数内结束');
  assert.equal(room.state.phase, 'settled', '牌局正常结算，没有卡死');
  assert.ok(botSteps >= 5, `托管期间代打了 ${botSteps} 步`);
});

test('等下一把：真人点「准备下一局」即替托管座位 auto-ready → 立刻开新把（老吴 2026-10-19）', () => {
  const room = openedRoom();
  const seat = room.actingSeat();
  const uid = room.seats[seat].uid;
  room.seats[seat].connected = false;
  room.seats[seat].offlineSince = T0;
  room.setAbsent(uid, true);
  driveHandWithAbsent(room);
  assert.equal(room.state.phase, 'settled');
  assert.equal(room.awaitingNext, true);

  const before = room.handNo;
  // 其余三家点「准备下一局」：最后一位真人 ready 时，托管座位一并 auto-ready → 立即开
  for (let i = 0; i < SEATS; i++) if (i !== seat) room.ready(room.seats[i].uid);
  assert.equal(room.awaitingNext, false, '真人 ready 时托管座位自动 ready → 开下一把');
  assert.equal(room.handNo, before + 1);
  assert.equal(room.state.phase, 'discard');
});

test('等下一把：巡检兜底 —— 真人已 ready、只差托管座位未 ready 时，sweepOffline 替它 ready', () => {
  const room = openedRoom();
  const seat = room.actingSeat();
  const uid = room.seats[seat].uid;
  room.seats[seat].connected = false;
  room.setAbsent(uid, true);
  driveHandWithAbsent(room);
  assert.equal(room.awaitingNext, true);
  // 构造「真人已 ready、托管座位尚未 ready」（模拟巡检还没轮到它）
  for (let i = 0; i < SEATS; i++) room.seats[i].ready = i !== seat;
  const before = room.handNo;
  const out = room.sweepOffline();
  assert.equal(out.startedNext, true, '巡检替托管座位 ready → 开下一把');
  assert.equal(room.handNo, before + 1);
  assert.equal(room.awaitingNext, false);
});

test('整场结束后：真人点「准备下一局」即替机器人座位 ready → 开新场（不再卡死）', () => {
  const room = new Room(TABLE);
  room.join(mkUser(1), 's1');
  for (let i = 0; i < 3; i++) room.addBot(1);
  room.ready(1);

  // 打满 4 把（人类出牌；机器人由 sweepOffline 代打）
  let guard = 0;
  while (!room.finished && guard++ < 20) {
    let g = 0;
    while (room.state.phase !== 'settled' && g++ < 40000) {
      const seat = room.actingSeat();
      if (seat < 0) break;
      const s = room.seats[seat];
      if (s.bot || s.absent) { room.sweepOffline(); continue; }
      const legal = legalActions(room.state, seat);
      const a = legal.find((x) => x.type === 'discard') || legal.find((x) => x.type === 'pass') || legal[0];
      room.applyAction(s.uid, a);
    }
    confirmAll(room); // 胡牌摊牌：四家确认后才算真正结束
    if (!room.finished) room.ready(1); // 真人点「准备下一局」
  }
  assert.equal(room.finished, true, '打满 4 把 → 整场结束');
  assert.equal(room.started, false);

  const standings = room.standings();
  assert.equal(standings.length, 4);
  assert.ok(standings.every((p) => p.played === room.completedResults.length), '每家已打把数一致');
  assert.ok(standings.every((p) => Number.isInteger(p.dealtIn) && Number.isInteger(p.goldTops) && Number.isInteger(p.lianZhuang)), '总成绩含点炮/金顶/连庄计数');
  assert.equal(standings.reduce((n, p) => n + (p.net | 0), 0), 0, '四家总得分之和为 0');
  const winHands = room.completedResults.filter((h) => h.type === 'win');
  assert.equal(standings.reduce((n, p) => n + (p.wins | 0), 0), winHands.length, '胡牌次数合计 = 胡牌局数');
  assert.equal(
    standings.reduce((n, p) => n + (p.goldTops | 0), 0),
    winHands.filter((h) => h.topType === 'goldTop').length,
    '金顶次数合计 = 金顶局数',
  );
  assert.equal(
    standings.reduce((n, p) => n + (p.dealtIn | 0), 0),
    winHands.filter((h) => Number.isInteger(h.from) && h.from !== h.winnerSeat).length,
    '点炮次数合计 = 放炮局数',
  );
  assert.equal(
    standings.reduce((n, p) => n + (p.lianZhuang | 0), 0),
    winHands.filter((h) => h.winnerSeat === h.dealerSeat).length,
    '连庄次数合计 = 庄家胡牌局数',
  );

  const r = room.ready(1);
  assert.equal(r.event, 'started', '整场结束后真人 ready → 立即开新场');
  assert.equal(room.finished, false);
  assert.equal(room.started, true);
  assert.equal(room.handNo, 1, '新场从第 1 把开始');
  assert.equal(room.state.phase, 'discard');
});

test('手动托管后长断线再久也不作废：牌局继续、可打完、重连回原局（老吴 2026-10-02）', () => {
  const room = openedRoom();
  const seat = room.actingSeat();
  const uid = room.seats[seat].uid;
  room.seats[seat].connected = false;
  room.seats[seat].offlineSince = T0;
  room.setAbsent(uid, true);
  assert.ok(room.seats[seat].absent, '先由按钮托管');

  // 旧逻辑会按「解散阈值」判离席作废整场；新逻辑（2026-10-02）必须继续
  const out = room.sweepOffline();
  assert.equal(room.started, true, '牌局仍在继续（未作废）');
  assert.equal(room.seats[seat].uid, uid, '离席座位仍保留（供重连，未被请出）');
  assert.equal(room.seats[seat].absent, true, '仍处于托管态');

  // 托管座位能被一路代打到结算，证明「四个人卡死等一个」不再发生
  const { botSteps } = driveHandWithAbsent(room);
  assert.equal(room.state.phase, 'settled', '牌局正常结算');
  assert.ok(botSteps >= 5, `托管期间代打了 ${botSteps} 步`);

  // 玩家回来 → 撤销托管，控制权交还，从当前状态（已结算 / 下一把）继续
  const re = room.join(mkUser(uid), 'sockNew');
  assert.equal(re.reconnected, true);
  assert.equal(re.seat, seat);
  assert.equal(re.wasAbsent, true, '告知前端「刚才是托管状态」');
  assert.equal(room.seats[seat].absent, false, '重连即撤销托管');
  assert.equal(room.seats[seat].uid, uid, '重连后仍是同一个人、原位');
});

test('托管后本人重连 → 立即撤销托管，控制权交还', () => {
  const room = openedRoom();
  const seat = room.actingSeat();
  const uid = room.seats[seat].uid;
  room.disconnect(uid, 'sock' + (seat + 1));
  room.seats[seat].offlineSince = T0;
  room.setAbsent(uid, true);
  assert.ok(room.seats[seat].absent, '先托管');

  const re = room.join(mkUser(uid), 'sockNew');
  assert.equal(re.reconnected, true);
  assert.equal(re.seat, seat);
  assert.equal(re.wasAbsent, true, '告知前端「刚才是托管状态」');
  assert.equal(room.seats[seat].absent, false, '重连即撤销托管');
  assert.equal(room.seats[seat].offlineSince, null, '断线计时清零');
  assert.equal(room.seats[seat].connected, true);

  // 撤销后不能再被代打
  const before = room.state.seq;
  room.sweepOffline();
  assert.equal(room.state.seq, before, '玩家回来后再没有机器人替它动牌');
});

test('playersPayload 下发托管标志与代打步数', () => {
  const room = openedRoom();
  const seat = room.actingSeat();
  const uid = room.seats[seat].uid;
  room.seats[seat].connected = false;
  room.seats[seat].offlineSince = T0;
  room.setAbsent(uid, true);

  const p = room.playersPayload();
  assert.equal(p.players[seat].absent, true, '托管座位标记 absent');
  assert.equal(p.players[seat].connected, false);
  // 走一帧代打以产生 botSteps
  room.sweepOffline();
  const p2 = room.playersPayload();
  assert.ok(p2.players[seat].botSteps >= 1);
  assert.ok(p2.players.filter(Boolean).every((x) => typeof x.absent === 'boolean'), '每个座位都带 absent');
});

test('setAbsent：不存在的座位报错；重复托管 / 取消幂等', () => {
  const room = openedRoom();
  const seat = room.actingSeat();
  const uid = room.seats[seat].uid;
  assert.equal(room.setAbsent(99999, true).error, '座位不存在');
  assert.equal(room.setAbsent(uid, true).ok, true);
  assert.equal(room.setAbsent(uid, true).already, true, '重复托管幂等');
  assert.equal(room.setAbsent(uid, false).ok, true);
  assert.equal(room.setAbsent(uid, false).already, true, '重复取消幂等');
  assert.equal(room.seats[seat].absent, false);
});

/* ---------------- 机器人补位（单人验证用） ---------------- */

test('addBot：往空座补机器人（absent+ready+bot），单人 + 3 机器人也能开局', () => {
  const room = new Room(TABLE);
  room.join(mkUser(1), 'sock1');
  for (let i = 0; i < 3; i++) assert.equal(room.addBot(1).ok, true);
  assert.equal(room.addBot(1).error, '牌桌已满');

  for (let i = 1; i < 4; i++) {
    const s = room.seats[i];
    assert.equal(s.bot, true, '机器人标记 bot');
    assert.equal(s.absent, true, '机器人 = 已托管（服务器代打）');
    assert.equal(s.ready, true, '机器人 = 已准备（凑齐即开局）');
    assert.equal(s.socketId, null);
    assert.equal(s.connected, false);
  }
  // uid 唯一且不与真人 id 相撞（字符串 'bot:...'）
  const uids = room.seats.map((s) => s.uid);
  assert.equal(new Set(uids).size, SEATS);
  assert.ok(uids.slice(1).every((u) => typeof u === 'string' && u.startsWith('bot:')));
  // playersPayload 带 bot 标记
  assert.equal(room.playersPayload().players[1].bot, true);

  // 人类 ready → 四人齐（机器人已 ready）→ 开局
  assert.equal(room.ready(1).event, 'started');
  assert.equal(room.started, true);
  assert.equal(room.state.players.length, SEATS);
});

test('addBot：未入座 / 牌局已开始 → 拒绝', () => {
  const room = new Room(TABLE);
  assert.equal(room.addBot(1).error, '不在牌桌上');
  room.join(mkUser(1), 'sock1');
  for (let i = 0; i < 3; i++) room.addBot(1);
  room.ready(1); // 开局
  assert.equal(room.addBot(1).error, '牌局已开始，无法补位');
});

test('addBot：整把由 sweepOffline 代打机器人，人类只管自己（能打完）', () => {
  const room = new Room(TABLE);
  room.join(mkUser(1), 'sock1');
  for (let i = 0; i < 3; i++) room.addBot(1);
  room.ready(1);

  let guard = 0;
  while (room.state.phase !== 'settled' && guard++ < 20000) {
    const seat = room.state.turn;
    if (room.seats[seat].bot) { room.sweepOffline(); continue; }
    const legal = legalActions(room.state, seat);
    const a = legal.find((x) => x.type === 'discard') || legal.find((x) => x.type === 'pass') || legal[0];
    room.applyAction(room.seats[seat].uid, a);
  }
  confirmAll(room);
  assert.equal(room.state.phase, 'settled', '机器人陪打能正常打完一把');
  assert.ok(room.seats.filter((s) => s.bot).every((s) => s.botSteps > 0), '机器人都有代打步数');
});

test('特殊牌点「打出」→ 服务端改判为对应特殊杠，不进牌河', () => {
  const room = openedRoom();
  const s = room.state;
  const seat = s.turn;
  assert.equal(s.phase, 'discard');

  // 造一手含红中的 14 张牌：红中是皮子（不是癞子）
  s.wildTile = 27;
  s.skinTiles = [31];
  s.players[seat].hand = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 31];
  s.players[seat].melds = [];
  s.players[seat].discards = [];
  s.claims = [];
  s.claimIndex = 0;
  s.lastDiscard = null;
  s.mustDiscard = false;
  s.winDeclined = false;

  const legal = legalActions(s, seat);
  assert.ok(legal.some((a) => a.type === 'redgang' && a.tile === 31), '红中杠可做');
  assert.ok(!legal.some((a) => a.type === 'discard' && a.tile === 31), '红中不给打');

  room.applyAction(room.seats[seat].uid, { type: 'discard', tile: 31 });

  const p = s.players[seat];
  assert.ok(p.melds.some((m) => m.type === 'red' && m.tiles[0] === 31), '点「打出」变成红中杠');
  assert.ok(!p.discards.includes(31), '红中没有进牌河');
});

test('服务端拒绝「红中杠 + 北风 tile」：不能凭 type 相同杠掉别的牌', () => {
  const room = openedRoom();
  const s = room.state;
  const seat = s.turn;
  s.wildTile = 27;
  s.skinTiles = [31];
  s.players[seat].hand = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 30, 31];
  s.players[seat].melds = [];
  s.players[seat].discards = [];
  s.claims = [];
  s.claimIndex = 0;
  s.lastDiscard = null;
  s.mustDiscard = false;
  s.winDeclined = false;

  assert.ok(legalActions(s, seat).some((a) => a.type === 'redgang' && a.tile === 31));
  assert.throws(
    () => room.applyAction(room.seats[seat].uid, { type: 'redgang', tile: 30 }),
    /非法动作/,
  );
  assert.ok(!s.players[seat].melds.length, '被拒绝的动作不能产生副露');
  assert.ok(s.players[seat].hand.includes(30), '北风仍在手里');
});

test('Room 接受 noDraw 杠：动作与回放日志保留 noDraw，直接轮下家摸', () => {
  const room = openedRoom();
  const s = room.state;
  const seat = s.turn;
  s.wildTile = 27;
  s.skinTiles = [31];
  s.players[seat].hand = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 31];
  s.players[seat].melds = [];
  s.players[seat].discards = [];
  s.claims = [];
  s.claimIndex = 0;
  s.lastDiscard = null;
  s.lastDraw = 12;
  s.mustDiscard = false;
  s.winDeclined = false;
  const wallBefore = s.wall.length;

  room.applyAction(room.seats[seat].uid, { type: 'redgang', tile: 31, noDraw: true });

  const p = s.players[seat];
  assert.ok(p.melds.some((m) => m.type === 'red' && m.tiles[0] === 31), '红中杠成立');
  assert.equal(p.hand.length, 13, '14 - 1 = 13，不补牌');
  assert.equal(s.turn, (seat + 1) % 4, '不补牌 → 直接轮到下家');
  assert.equal(s.wall.length, wallBefore - 1, '只少下家摸的那 1 张');
  assert.equal(room.replayLog.actions.at(-1).action.noDraw, true, '回放日志保留 noDraw');
});


test('对局视图：**绝不下发 seed**（洗牌确定性 → 给 seed 等于给透视挂），改用 random handTag', () => {
  const room = openedRoom();
  const payload = room.statePayload(0);
  const view = payload.view;

  assert.equal(view.seed, undefined, 'view 里不能有 seed 字段');
  assert.ok(!('seed' in view), '连键都不能存在（避免前端某处又把它读出来发出去）');
  assert.equal(typeof view.handTag, 'string');
  assert.ok(view.handTag.length >= 16, 'handTag 应是随机串');

  // 同一局四家拿到的是同一个 handTag（前端据此去重），但换局必须变
  assert.equal(room.statePayload(1).view.handTag, view.handTag);
  const firstTag = view.handTag;

  // 走完一把再开下一把 → handTag 必须换
  driveHand(room);
  for (let i = 0; i < 4; i++) room.ready(room.seats[i].uid);
  const nextTag = room.statePayload(0).view.handTag;
  assert.notEqual(nextTag, firstTag, '新一局必须有新的 handTag');

  // 服务端仍然完整持有 seed（回放要靠它复算）
  assert.equal(typeof room.state.seed, 'number');
});

test('退出投票：三家全同意才结束，积分只算已完成的牌局', () => {
  const room = openedRoom();
  room.exitRequestCooldownMs = 0; // 该用例考投票逻辑，关掉「发起冷却」避免互相干扰
  driveHand(room); // 第 1 把完成
  assert.equal(room.awaitingNext, true);
  assert.equal(room.completedResults.length, 1);

  for (let i = 0; i < 4; i++) room.ready(room.seats[i].uid); // 开第 2 把（进行中）
  assert.equal(room.handNo, 2);
  assert.equal(room.state.phase === 'settled', false);

  const first = room.requestExit(room.seats[0].uid);
  assert.equal(first.event, 'requested');
  assert.equal(room.exitVotePayload().needed, 3, '另外三家都需要投票');

  const rejected = room.voteExit(room.seats[1].uid, false);
  assert.equal(rejected.event, 'rejected');
  assert.equal(room.exitRequest, null, '一人拒绝 → 请求作废');
  assert.equal(room.finished, false, '牌局继续');
  assert.equal(room.started, true);

  const again = room.requestExit(room.seats[0].uid);
  assert.equal(again.event, 'requested');
  assert.equal(room.voteExit(room.seats[1].uid, true).event, 'pending');
  assert.equal(room.voteExit(room.seats[2].uid, true).event, 'pending');
  assert.equal(room.finished, false, '还差一家，不能提前结束');
  const done = room.voteExit(room.seats[3].uid, true);
  assert.equal(done.event, 'exited');
  assert.equal(room.finished, true);
  assert.equal(room.started, false);
  assert.equal(room.exitRequest, null);
  assert.equal(done.final.reason, 'exit');
  assert.equal(done.final.bySeat, 0);
  assert.equal(done.final.completedHands, 1, '当前第 2 把没打完，不能计入');
  assert.equal(done.final.standings.length, 4);
  assert.equal(done.final.standings.reduce((s, p) => s + p.net, 0), 0, '四家净分之和为 0');
  assert.ok(done.final.standings.every((p) => p.played === 1 && p.wins <= 1));
});

test('大厅托管：托管视作已准备，四家齐时直接开局', () => {
  const room = new Room(TABLE);
  for (let i = 1; i <= 4; i++) room.join(mkUser(i), 'sock' + i);
  room.ready(1); room.ready(2); room.ready(3);
  assert.equal(room.started, false, '前三家 ready 不开局');

  const r = room.setAbsent(4, true);
  assert.equal(r.absent, true);
  assert.equal(r.event, 'started', '最后一家托管 → 视为 ready 并立即开局');
  assert.equal(room.started, true, '牌局真的开始了');
  assert.equal(room.state.phase, 'discard');
});

test('大厅取消托管：四家其实已全 ready 时也应立即补开局', () => {
  const room = new Room(TABLE);
  for (let i = 1; i <= 4; i++) room.join(mkUser(i), 'sock' + i);
  room.ready(1); room.ready(2); room.ready(3);
  room.seats[3].ready = true; // 模拟「全 ready 但没收到 started」的断线/时序场景
  assert.equal(room.started, false);

  const r = room.setAbsent(4, false);
  assert.equal(r.event, 'started', '取消托管也要补一次开局推进');
  assert.equal(room.started, true);
});

test('退出投票：发起人不能给自己投票；重复发起幂等', () => {
  const room = openedRoom();
  const a = room.requestExit(room.seats[0].uid);
  assert.equal(a.event, 'requested');
  const b = room.requestExit(room.seats[0].uid);
  assert.equal(b.already, true);
  assert.equal(room.voteExit(room.seats[0].uid, true).error, '发起人不能给自己投票');
  assert.equal(room.voteExit(room.seats[1].uid, true).event, 'pending');
  assert.equal(room.voteExit(room.seats[1].uid, true).event, 'pending', '重复同意不重复计数');
  assert.deepEqual(room.exitVotePayload().approvals, [1]);
});

test('退出投票：同一座位 5 秒内只能发起一次（防弹窗刷屏）；同一请求重复发起仍幂等', () => {
  const room = openedRoom();
  const a = room.requestExit(room.seats[0].uid);
  assert.equal(a.event, 'requested');
  // 已有请求在跑：重复发起按幂等返回，不报错
  const b = room.requestExit(room.seats[0].uid);
  assert.equal(b.already, true);

  // 被拒 → 立刻再发起：应被冷却挡住（这是 P2 修的刷屏路径）
  assert.equal(room.voteExit(room.seats[1].uid, false).event, 'rejected');
  const again = room.requestExit(room.seats[0].uid);
  assert.match(again.error || '', /发起太频繁/);

  // 换一个人发起不受影响（冷却按座位算）
  const other = room.requestExit(room.seats[2].uid);
  assert.equal(other.event, 'requested');
});

test('退出投票：机器人座位自动同意（单人 + 3 机器人也能退出）', () => {
  const room = new Room(TABLE);
  room.join(mkUser(1), 'sock1');
  for (let i = 0; i < 3; i++) room.addBot(1);
  room.ready(1);
  assert.equal(room.started, true);

  const r = room.requestExit(room.seats[0].uid);
  assert.equal(r.event, 'exited', '三个机器人视为全同意');
  assert.equal(room.finished, true);
  assert.equal(r.final.completedHands, 0);
  assert.equal(r.final.standings.length, 4);
});

test('退出投票：参与投票的座位断线 → 申请自动作废，避免弹窗永久挡住牌局', () => {
  const room = openedRoom();
  room.exitRequestCooldownMs = 0; // 同上：本用例要连续发起两次
  const req = room.requestExit(room.seats[0].uid);
  assert.equal(req.event, 'requested');
  const cancelled = room.cancelExit(room.seats[2].uid, 'disconnect');
  assert.equal(cancelled.bySeat, 2);
  assert.equal(cancelled.reason, 'disconnect');
  assert.equal(room.exitRequest, null);
  assert.equal(room.finished, false);
  assert.equal(room.started, true);

  const req2 = room.requestExit(room.seats[0].uid);
  assert.equal(req2.event, 'requested');
  const cancelled2 = room.cancelExit(room.seats[0].uid, 'leave');
  assert.equal(cancelled2.bySeat, 0);
  assert.equal(room.exitRequest, null);
});


test('claim 超时兜底：在线真人能胡时不替他「过」，断线后才放行', () => {
  const w = (n) => makeTile('wan', n);
  const t = (n) => makeTile('tong', n);
  const s = (n) => makeTile('tiao', n);

  const room = openedRoom();
  const st = createGame({
    seed: 81,
    ruleset: createRuleSet('koukou', { enforceMinFan: false }),
  });
  for (const p of st.players) {
    p.hand = [];
    p.melds = [];
    p.discards = [];
    p.opened = false;
  }
  st.flipTile = null;
  st.wildTile = WHITE_DRAGON;
  st.skinTiles = [];
  st.claims = [];
  st.claimIndex = 0;
  st.pendingXuGang = null;

  // 座位 0 打九条；座位 1 已开口且刚好胡九条（胡/过都给）。
  st.players[0].hand = [s(9), t(1), t(1), t(1), t(2), t(2), t(2), t(3), t(3), t(3), t(4), t(4), t(4)];
  st.players[1].opened = true;
  st.players[1].hand = [w(1), w(2), w(3), w(4), w(5), w(6), t(7), t(8), t(9), s(5), s(5), s(7), s(8)];
  st.players[2].opened = true;
  st.players[2].hand = [w(1), w(3), w(5), w(7), w(9), t(1), t(3), t(5), t(7), t(9), s(1), s(5), s(7)];
  st.players[3].hand = [t(6), t(7), t(8), t(9), t(9), t(9), w(7), w(8), w(9), w(1), w(1), w(1), w(2)];
  st.wall = [w(1), w(2), w(3)];
  st.turn = 0;
  st.phase = 'discard';

  act(st, { type: 'discard', seat: 0, tile: s(9) });
  assert.equal(st.phase, 'claim');
  assert.equal(st.turn, 1);
  assert.ok(legalActions(st, 1).some((a) => a.type === 'win'));

  room.state = st;
  room.seats[1].connected = true;
  room.seats[1].absent = false;
  assert.equal(room.autoResolveCurrent(), false, '在线真人能胡：不能自动过');
  assert.equal(st.phase, 'claim');
  assert.equal(st.turn, 1);

  room.seats[1].connected = false;
  assert.equal(room.autoResolveCurrent(), true, '断线后才兜底自动过');
  assert.equal(st.phase, 'discard');
  assert.equal(st.turn, 1, '放行后轮到下家（打牌者下家）摸牌');
});
