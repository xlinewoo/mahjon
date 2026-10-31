// 删除俱乐部 / 删除牌桌 回归测试（Fastify inject，不占端口）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import db from '../db.js';
import { rooms } from '../ws/room.js';

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

test('删除牌桌：房主可删 / 非房主 403 / 不存在 404 / 桌上有人 409', async () => {
  const app = await createApp();
  const owner = await reg(app, 'own');
  const mate = await reg(app, 'mate');
  const c = await app.inject({ method: 'POST', url: '/api/clubs', headers: auth(owner.token), payload: { name: '删桌俱乐部' } });
  const clubId = c.json().club.id;
  const t = await app.inject({ method: 'POST', url: `/api/clubs/${clubId}/tables`, headers: auth(owner.token), payload: { name: '待删桌' } });
  const tableId = t.json().table.id;

  // 非房主删除 → 403
  const notOwner = await app.inject({ method: 'DELETE', url: `/api/tables/${tableId}`, headers: auth(mate.token) });
  assert.equal(notOwner.statusCode, 403, '非房主不得删除');

  // 不存在的牌桌 → 404
  const missing = await app.inject({ method: 'DELETE', url: `/api/tables/999999`, headers: auth(owner.token) });
  assert.equal(missing.statusCode, 404);

  // 模拟桌上有⼈（内存房间存在）→ 409
  rooms.rooms.set(tableId, { tableId, playersPayload: () => ({}) });
  const occupied = await app.inject({ method: 'DELETE', url: `/api/tables/${tableId}`, headers: auth(owner.token) });
  assert.equal(occupied.statusCode, 409, '桌上有人应被拒绝');
  rooms.rooms.delete(tableId); // 清理模拟

  // 房主删除（无人）→ 200，再查 → 404
  const del = await app.inject({ method: 'DELETE', url: `/api/tables/${tableId}`, headers: auth(owner.token) });
  assert.equal(del.statusCode, 200);
  const after = await app.inject({ method: 'GET', url: `/api/tables/${tableId}`, headers: auth(owner.token) });
  assert.equal(after.statusCode, 404, '删除后应查不到');

  await app.close();
});

test('删除俱乐部：主席可删 / 级联清成员与俱乐部战绩 / 个人累计战绩保留 / 桌有人 409', async () => {
  const app = await createApp();
  const owner = await reg(app, 'boss');
  const mate = await reg(app, 'mem');
  const c = await app.inject({ method: 'POST', url: '/api/clubs', headers: auth(owner.token), payload: { name: '待删俱乐部' } });
  const clubId = c.json().club.id;
  await app.inject({ method: 'POST', url: `/api/clubs/${clubId}/members`, headers: auth(owner.token), payload: { username: mate.username } });
  const t = await app.inject({ method: 'POST', url: `/api/clubs/${clubId}/tables`, headers: auth(owner.token), payload: { name: '桌A' } });
  const tableId = t.json().table.id;

  // 预先写入：① 俱乐部战绩榜（player_stats，应被删）② 该俱乐部每把流水（hand_records，应被删）
  //         ③ 个人累计战绩（user_career_stats，应保留）
  db.prepare('INSERT OR REPLACE INTO player_stats (club_id, user_id, username, hands, wins, gold_tops, total_score, total_gangs, max_fan) VALUES (?,?,?,5,2,1,30,3,8)')
    .run(clubId, mate.id, mate.username);
  db.prepare('INSERT INTO hand_records (club_id, user_id, username, ts, hand_no, delta, is_win, fan, gangs, hu_type) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(clubId, mate.id, mate.username, Math.floor(Date.now() / 1000), 1, 10, 1, 5, 1, 'big');
  db.prepare('INSERT OR REPLACE INTO user_career_stats (user_id, username, hands, wins, small_hus, big_hus, gold_tops, net, sum_fan, fan_hands, total_gangs, max_fan) VALUES (?,?,7,3,0,1,1,40,30,3,2,8)')
    .run(mate.id, mate.username);

  // 非主席（mate）删除 → 403
  const notBoss = await app.inject({ method: 'DELETE', url: `/api/clubs/${clubId}`, headers: auth(mate.token) });
  assert.equal(notBoss.statusCode, 403, '非主席不得删除俱乐部');

  // 模拟桌 A 有人 → 409
  rooms.rooms.set(tableId, { tableId, playersPayload: () => ({}) });
  const occupied = await app.inject({ method: 'DELETE', url: `/api/clubs/${clubId}`, headers: auth(owner.token) });
  assert.equal(occupied.statusCode, 409, '俱乐部内有牌桌有人应被拒绝');
  rooms.rooms.delete(tableId);

  // 主席删除 → 200
  const del = await app.inject({ method: 'DELETE', url: `/api/clubs/${clubId}`, headers: auth(owner.token) });
  assert.equal(del.statusCode, 200);

  // 级联验证
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM clubs WHERE id = ?').get(clubId).n, 0, '俱乐部应已删');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM club_members WHERE club_id = ?').get(clubId).n, 0, '成员应已清');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM club_applications WHERE club_id = ?').get(clubId).n, 0, '待审应已清');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tables WHERE club_id = ?').get(clubId).n, 0, '牌桌应已清');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM player_stats WHERE club_id = ?').get(clubId).n, 0, '俱乐部战绩榜应已清');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM hand_records WHERE club_id = ?').get(clubId).n, 0, '该俱乐部流水应已清');

  // 个人累计战绩保留（user_career_stats 无 club 外键）
  const career = db.prepare('SELECT hands, wins FROM user_career_stats WHERE user_id = ?').get(mate.id);
  assert.ok(career, '个人累计战绩应保留');
  assert.equal(career.hands, 7, '个人累计场次应保留');

  await app.close();
});
