// 牌局回放 API：个人跨俱乐部 / 俱乐部列表 / 详情权限 / 动作日志
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { saveHandReplay } from '../db.js';

const rnd = () => Math.random().toString(36).slice(2, 8);

async function reg(app, prefix) {
  const username = `${prefix}_${rnd()}`;
  const res = await app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { username, password: 'pass1234' },
  });
  const body = res.json();
  return { username, token: body.token, id: body.user.id };
}

const auth = (token) => ({ authorization: `Bearer ${token}` });

test('回放 API：个人跨俱乐部 / 俱乐部维度 / 成员与参与者权限', async () => {
  const app = await createApp();
  const owner = await reg(app, 'owner');
  const mate = await reg(app, 'mate');
  const outsider = await reg(app, 'out');

  const c = await app.inject({
    method: 'POST', url: '/api/clubs', headers: auth(owner.token),
    payload: { name: `回放俱乐部_${rnd()}` },
  });
  const clubId = c.json().club.id;
  await app.inject({
    method: 'POST', url: `/api/clubs/${clubId}/members`, headers: auth(owner.token),
    payload: { username: mate.username },
  });
  const t = await app.inject({
    method: 'POST', url: `/api/clubs/${clubId}/tables`, headers: auth(owner.token),
    payload: { name: '回放桌', circleCount: 1 },
  });
  const tableId = t.json().table.id;

  const replayId = saveHandReplay({
    clubId,
    tableId,
    tableName: '回放桌',
    handNo: 1,
    seed: 123456,
    dealer: 0,
    prevWildTile: null,
    names: [owner.username, mate.username, '机器人1', '机器人2'],
    ruleset: { preset: 'koukou' },
    actions: [{ seat: 0, action: { type: 'discard', tile: 11 } }],
    result: { type: 'win', winnerSeat: 0, totalWin: 8 },
    players: [
      { seat: 0, uid: owner.id, username: owner.username, bot: false },
      { seat: 1, uid: mate.id, username: mate.username, bot: false },
      { seat: 2, uid: null, username: '机器人1', bot: true },
      { seat: 3, uid: null, username: '机器人2', bot: true },
    ],
  });
  assert.ok(replayId > 0);

  // 个人维度：两人都能看到自己参与的这一把；非参与者看不到
  const mineOwner = await app.inject({ method: 'GET', url: '/api/replays/mine', headers: auth(owner.token) });
  assert.equal(mineOwner.statusCode, 200);
  assert.equal(mineOwner.json().replays[0].id, replayId);
  assert.equal(mineOwner.json().replays[0].clubName, c.json().club.name);

  const mineMate = await app.inject({ method: 'GET', url: '/api/replays/mine', headers: auth(mate.token) });
  assert.equal(mineMate.json().replays[0].id, replayId);

  const mineOut = await app.inject({ method: 'GET', url: '/api/replays/mine', headers: auth(outsider.token) });
  assert.equal(mineOut.json().replays.length, 0);

  // 俱乐部维度：成员可见，非成员 403
  const clubList = await app.inject({ method: 'GET', url: `/api/clubs/${clubId}/replays`, headers: auth(mate.token) });
  assert.equal(clubList.statusCode, 200);
  assert.equal(clubList.json().replays[0].id, replayId);

  const clubOut = await app.inject({ method: 'GET', url: `/api/clubs/${clubId}/replays`, headers: auth(outsider.token) });
  assert.equal(clubOut.statusCode, 403);

  // 详情：参与者可看（即使不是成员）；俱乐部成员也可看；外人 403
  const detail = await app.inject({ method: 'GET', url: `/api/replays/${replayId}`, headers: auth(mate.token) });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().replay.seed, 123456);
  assert.equal(detail.json().replay.actions[0].action.tile, 11);
  assert.equal(detail.json().replay.players.length, 4);

  const detailOut = await app.inject({ method: 'GET', url: `/api/replays/${replayId}`, headers: auth(outsider.token) });
  assert.equal(detailOut.statusCode, 403);

  const anon = await app.inject({ method: 'GET', url: '/api/replays/mine' });
  assert.equal(anon.statusCode, 401);

  await app.close();
});

test('回放场次：同桌 hand_no 重置切场，场次总分/个人与俱乐部维度正确', async () => {
  const app = await createApp();
  const owner = await reg(app, 'sess_owner');
  const mate = await reg(app, 'sess_mate');
  const outsider = await reg(app, 'sess_out');

  const clubRes = await app.inject({
    method: 'POST', url: '/api/clubs', headers: auth(owner.token),
    payload: { name: `场次俱乐部_${rnd()}` },
  });
  const clubId = clubRes.json().club.id;
  await app.inject({
    method: 'POST', url: `/api/clubs/${clubId}/members`, headers: auth(owner.token),
    payload: { username: mate.username },
  });
  const tableRes = await app.inject({
    method: 'POST', url: `/api/clubs/${clubId}/tables`, headers: auth(owner.token),
    payload: { name: '场次桌', circleCount: 4 },
  });
  const tableId = tableRes.json().table.id;
  const names = [owner.username, mate.username, '机器人1', '机器人2'];
  const players = [
    { seat: 0, uid: owner.id, username: owner.username, bot: false },
    { seat: 1, uid: mate.id, username: mate.username, bot: false },
    { seat: 2, uid: null, username: '机器人1', bot: true },
    { seat: 3, uid: null, username: '机器人2', bot: true },
  ];
  const base = {
    clubId, tableId, tableName: '场次桌', seed: 777, dealer: 0, prevWildTile: null,
    names, ruleset: { preset: 'koukou' }, actions: [], players,
  };

  const first = saveHandReplay({
    ...base, handNo: 1, ts: 1000,
    result: { type: 'win', winnerSeat: 0, totalWin: 8, payments: [{ seat: 1, pay: 8 }] },
  });
  const second = saveHandReplay({
    ...base, handNo: 2, ts: 1060,
    result: { type: 'win', winnerSeat: 1, totalWin: 4, payments: [{ seat: 0, pay: 4 }] },
  });
  // 本把带七皮/十杠附加账本：payments 只有 2 分，但 perSeat.delta 合计是 30/-10/-10/-10。
  // 场次总分必须优先用 perSeat，否则回放列表会漏掉成就奖。
  const third = saveHandReplay({
    ...base, handNo: 1, ts: 2000,
    result: {
      type: 'win', winnerSeat: 0, totalWin: 2, payments: [{ seat: 1, pay: 2 }],
      perSeat: [
        { seat: 0, delta: 30 }, { seat: 1, delta: -10 },
        { seat: 2, delta: -10 }, { seat: 3, delta: -10 },
      ],
    },
  });

  const clubSessions = await app.inject({
    method: 'GET', url: `/api/clubs/${clubId}/replays/sessions`, headers: auth(mate.token),
  });
  assert.equal(clubSessions.statusCode, 200);
  const list = clubSessions.json().sessions;
  assert.equal(list.length, 2, '同一桌 hand_no 从 1 重新开始应切成两场');
  assert.equal(list[0].handCount, 1, '最新一场只有 1 把');
  assert.equal(list[0].hands[0].id, third);
  assert.equal(list[1].handCount, 2, '上一场应有 2 把');
  assert.deepEqual(list[1].hands.map((h) => h.id), [first, second], '场次内按时间正序');
  assert.equal(list[1].hands[0].text.includes(owner.username), true, '每把带胡牌摘要');

  const scoreOf = (session, seat) => session.players.find((p) => p.seat === seat).score;
  assert.equal(scoreOf(list[1], 0), 4, 'owner：+8 -4 = +4');
  assert.equal(scoreOf(list[1], 1), -4, 'mate：-8 +4 = -4');
  assert.equal(scoreOf(list[0], 0), 30, '含七皮/十杠的 perSeat 必须进总分');
  assert.equal(scoreOf(list[0], 1), -10);

  const mine = await app.inject({
    method: 'GET', url: '/api/replays/sessions/mine?limit=1', headers: auth(owner.token),
  });
  assert.equal(mine.statusCode, 200);
  assert.equal(mine.json().sessions.length, 1);
  assert.equal(mine.json().hasMore, true);
  assert.equal(mine.json().sessions[0].hands[0].id, third);

  const mateMine = await app.inject({
    method: 'GET', url: '/api/replays/sessions/mine', headers: auth(mate.token),
  });
  assert.equal(mateMine.json().sessions.length, 2);
  assert.equal(mateMine.json().sessions[1].players.find((p) => p.seat === 1).score, -4);
  assert.equal(mine.json().sessions[0].players.find((p) => p.seat === 0).score, 30);

  const outMine = await app.inject({
    method: 'GET', url: '/api/replays/sessions/mine', headers: auth(outsider.token),
  });
  assert.equal(outMine.json().sessions.length, 0);
  const outClub = await app.inject({
    method: 'GET', url: `/api/clubs/${clubId}/replays/sessions`, headers: auth(outsider.token),
  });
  assert.equal(outClub.statusCode, 403);

  await app.close();
});
