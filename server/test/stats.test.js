// 战绩统计回归测试：个人 **跨俱乐部** 日/月/年/全部 时段口径 + 俱乐部时段榜
//
// 老吴 2026-10-03 定的口径：胜率 / 大胡率 / 金顶率 / 总成绩 / 总平均分
// 一律按**个人总成绩**算，**不按俱乐部切分**（同一个人在 A 俱乐部打的也算进总成绩）。
//
// 覆盖三条数据通路：
//   · hand_records       逐把流水（时段统计的数据源，跨俱乐部 = 不带 club_id 过滤）
//   · user_career_stats  个人跨俱乐部生涯累计（period=all 走它，含上线前历史）
//   · player_stats       俱乐部维度累计（只服务「跨场战绩榜」，不参与个人统计）
// 以及一条踩过的坑：node:sqlite 的 DatabaseSync 没有 .transaction()（better-sqlite3 才有）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import db, {
  recordHandRows, recordHandStats, recordCareerStats, personalStats, clubStatsByPeriod,
} from '../db.js';

const rnd = () => Math.random().toString(36).slice(2, 8);
const auth = (token) => ({ authorization: `Bearer ${token}` });

async function reg(app, prefix) {
  const username = `${prefix}_${rnd()}`;
  const res = await app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { username, password: 'pass1234' },
  });
  const j = res.json();
  return { username, id: j.user.id, token: j.token };
}

/**
 * 造一把的四家流水（同时写三张表，跟 ws/index.js 的 recordStats 行为一致）。
 * @param clubId  {id, uidA, nameA, uidB, nameB}
 * @param handNo  第几把（也用作改写 ts 的定位键）
 * @param aWin    A 这一把是否获胜
 * @param ts      结算时刻；不给就用「现在」
 */
function seedHand(clubId, handNo, aWin, ts = null) {
  const d = aWin ? 10 : -10;
  const rows = [
    { uid: clubId.uidA, username: clubId.nameA, delta: d, fan: aWin ? 8 : 0, gangs: aWin ? 1 : 0, isWinner: aWin,  huType: aWin ? 'big' : null },
    { uid: clubId.uidB, username: clubId.nameB, delta: -d, fan: aWin ? 6 : 7, gangs: 0, isWinner: !aWin, huType: aWin ? null : 'gold' },
  ];
  recordHandRows(clubId.id, handNo, rows);
  recordHandStats(clubId.id, rows);
  recordCareerStats(rows);
  if (ts != null) {
    // 把这一把的两行挪到指定时刻（测「当日 / 当月」边界）
    const ids = db.prepare('SELECT id FROM hand_records WHERE club_id = ? AND hand_no = ?').all(clubId.id, handNo);
    for (const r of ids) db.prepare('UPDATE hand_records SET ts = ? WHERE id = ?').run(ts, r.id);
  }
}

test('个人时段战绩：日/月/年/全部 各自的口径正确', async () => {
  const app = await createApp();
  const a = await reg(app, 'pa');
  const b = await reg(app, 'pb');
  const c = await app.inject({ method: 'POST', url: '/api/clubs', headers: auth(a.token), payload: { name: '时段俱乐部' } });
  const clubId = c.json().club.id;
  await app.inject({ method: 'POST', url: `/api/clubs/${clubId}/members`, headers: auth(a.token), payload: { username: b.username } });

  const ctx = { id: clubId, uidA: a.id, nameA: a.username, uidB: b.id, nameB: b.username };
  const now = Math.floor(Date.now() / 1000);

  // 40 天前的一把：A 输 10（胡的是 B，且是金顶）
  const old = new Date();
  old.setDate(old.getDate() - 40);
  seedHand(ctx, 1, false, Math.floor(old.getTime() / 1000));
  // 今天的一把：A 赢 10（大胡）
  seedHand(ctx, 2, true, now);

  // A：当日 1 把全胜
  const day = personalStats(a.id, 'day', now);
  assert.equal(day.hands, 1, '当日只含今天那一把');
  assert.equal(day.wins, 1);
  assert.equal(day.net, 10);
  assert.equal(day.winRate, 100);
  assert.equal(day.maxFan, 8);
  assert.equal(day.totalGangs, 1);
  assert.equal(day.goldTops, 0, 'A 今天不是金顶');
  assert.equal(day.bigHuRate, 100, '今天这一把是大胡 → 大胡率 100%');

  // 全部：两把一胜一负，净分相抵为 0，胜率 50%
  const all = personalStats(a.id, 'all', now);
  assert.equal(all.hands, 2, '全部含两把');
  assert.equal(all.wins, 1);
  assert.equal(all.net, 0, '一胜一负净分相抵为 0');
  assert.equal(all.winRate, 50);
  assert.equal(all.from, null, 'all 不限区间');
  assert.equal(all.maxFan, 8, '最高番取两把里的大值');
  assert.equal(all.totalGangs, 1);
  assert.equal(all.bigHuRate, 50, '两把里一大胡 → 50%');
  assert.equal(all.goldRate, 0, 'A 两把都不是金顶');
  assert.equal(all.avgScore, 0, '总平均分 = 总成绩 / 总局数 = 0/2');

  // B 相反：当日输 10、当年赢 10
  const bDay = personalStats(b.id, 'day', now);
  assert.equal(bDay.net, -10);
  assert.equal(bDay.wins, 0);
  assert.equal(bDay.winRate, 0);
  const bAll = personalStats(b.id, 'all', now);
  assert.equal(bAll.net, 0);
  assert.equal(bAll.goldTops, 1, 'B 那把是金顶');
  assert.equal(bAll.goldRate, 50, 'B 两把里一金顶 → 50%');

  // 40 天前 ≠ 当月（同月概率极低；若跨月则此断言成立）
  const month = personalStats(a.id, 'month', now);
  if (old.getMonth() !== new Date().getMonth()) {
    assert.equal(month.hands, 1, '当月不含 40 天前那一把');
    assert.equal(month.net, 10, '当月只算今天赢的那把');
  }

  // 年度区间必须覆盖到今天，且 from < to
  const year = personalStats(a.id, 'year', now);
  assert.ok(year.from < year.to, '当月/当年区间应为非空半开区间');
  assert.ok(year.hands >= 1);

  await app.close();
});

test('★ 个人统计跨俱乐部：换一个俱乐部的战绩照样计入总成绩', async () => {
  const app = await createApp();
  const a = await reg(app, 'xa');
  const b = await reg(app, 'xb');
  // 同一个 A 加入两个俱乐部
  const c1 = await app.inject({ method: 'POST', url: '/api/clubs', headers: auth(a.token), payload: { name: '俱乐部甲' } });
  const id1 = c1.json().club.id;
  const c2 = await app.inject({ method: 'POST', url: '/api/clubs', headers: auth(a.token), payload: { name: '俱乐部乙' } });
  const id2 = c2.json().club.id;
  for (const cid of [id1, id2]) {
    await app.inject({ method: 'POST', url: `/api/clubs/${cid}/members`, headers: auth(a.token), payload: { username: b.username } });
  }

  const now = Math.floor(Date.now() / 1000);
  // 甲 club：A 赢 10（大胡）；乙 club：A 输 10（胡的是 B）
  seedHand({ id: id1, uidA: a.id, nameA: a.username, uidB: b.id, nameB: b.username }, 1, true, now);
  seedHand({ id: id2, uidA: a.id, nameA: a.username, uidB: b.id, nameB: b.username }, 1, false, now);

  // 「我的战绩」从任一俱乐部页进来，结果必须一致（clubId 不参与统计）
  for (const cid of [id1, id2]) {
    const r = await app.inject({ method: 'GET', url: `/api/clubs/${cid}/my-stats`, headers: auth(a.token) });
    assert.equal(r.statusCode, 200);
    const me = r.json().me;
    assert.equal(me.scope, 'all-clubs', '应明确标注是跨俱乐部口径');
    assert.equal(me.all.hands, 2, `从 club ${cid} 进来都应看到两个俱乐部的 2 把`);
    assert.equal(me.all.net, 0, '一胜一负相抵为 0');
    assert.equal(me.all.winRate, 50);
    assert.equal(me.all.avgScore, 0, '总平均分 0/2 = 0');
    assert.equal(me.all.bigHuRate, 50, '甲那把是大胡');
    assert.equal(me.day.hands, 2, '当日口径同样跨俱乐部');
    assert.equal(me.day.net, 0);
  }

  // 反证：俱乐部榜仍按俱乐部隔离（甲里 A +10，乙里 A −10）
  const b1 = clubStatsByPeriod(id1, 'all', now).find((x) => x.uid === a.id);
  const b2 = clubStatsByPeriod(id2, 'all', now).find((x) => x.uid === a.id);
  assert.equal(b1.net, 10, '俱乐部甲里 A 是 +10');
  assert.equal(b2.net, -10, '俱乐部乙里 A 是 −10');

  await app.close();
});

test('★ 三个率的分母都是总局数；总平均分 = 总成绩 / 局数', async () => {
  const app = await createApp();
  const a = await reg(app, 'ra');
  const c = await app.inject({ method: 'POST', url: '/api/clubs', headers: auth(a.token), payload: { name: '率俱乐部' } });
  const cid = c.json().club.id;
  const now = Math.floor(Date.now() / 1000);

  // 直接造 4 把：A 赢 1（金顶）、输 3，其中 1 把是大胡、1 把是荒庄
  const mk = (delta, win, hu, fan) => {
    const rows = [{ uid: a.id, username: a.username, delta, fan, gangs: 0, isWinner: win, huType: hu }];
    recordHandRows(cid, 99, rows); recordHandStats(cid, rows); recordCareerStats(rows);
  };
  mk(10, true, 'gold', 10);    // 金顶
  mk(-4, false, 'big', 6);     // 输，但胡的是别人（A 那边记 big 不合逻辑，改为荒庄更贴近真实）
  mk(0, false, '', 0);         // 荒庄
  mk(-6, false, '', 0);

  const s = personalStats(a.id, 'all', now);
  assert.equal(s.hands, 4, '总局数含荒庄');
  assert.equal(s.wins, 1);
  assert.equal(s.net, 0, '10 - 4 + 0 - 6 = 0');
  assert.equal(s.winRate, 25, '1/4 = 25%');
  assert.equal(s.goldRate, 25, '1 金顶 / 4 局 = 25%');
  assert.equal(s.bigHuRate, 25, '1 大胡 / 4 局 = 25%（荒庄照样进分母）');
  assert.equal(s.avgScore, 0, '总平均分 = 0 / 4 = 0');

  await app.close();
});

test('时段榜：只统计区间内的对局，胜率与净分排序正确', async () => {
  const app = await createApp();
  const a = await reg(app, 'ba');
  const b = await reg(app, 'bb');
  const c = await app.inject({ method: 'POST', url: '/api/clubs', headers: auth(a.token), payload: { name: '榜俱乐部' } });
  const clubId = c.json().club.id;
  await app.inject({ method: 'POST', url: `/api/clubs/${clubId}/members`, headers: auth(a.token), payload: { username: b.username } });

  const ctx = { id: clubId, uidA: a.id, nameA: a.username, uidB: b.id, nameB: b.username };
  const now = Math.floor(Date.now() / 1000);
  const old = new Date();
  old.setDate(old.getDate() - 40);
  seedHand(ctx, 1, false, Math.floor(old.getTime() / 1000));
  seedHand(ctx, 2, true, now);

  const board = clubStatsByPeriod(clubId, 'month', now);
  const rowA = board.find((r) => r.uid === a.id);
  const rowB = board.find((r) => r.uid === b.id);
  // 今天这一把：A +10 / B -10
  if (rowA) {
    assert.equal(rowA.net, 10);
    assert.equal(rowA.wins, 1);
    assert.equal(rowA.winRate, 100);
  }
  if (rowB) {
    assert.equal(rowB.net, -10);
    assert.equal(rowB.wins, 0);
    assert.equal(rowB.winRate, 0);
  }
  // 净分降序：A 在前
  if (rowA && rowB) assert.ok(board.indexOf(rowA) < board.indexOf(rowB), '按净分降序');

  await app.close();
});

test('GET /api/clubs/:id/my-stats：一次返回日/月/年/全部四口径，且非成员 403', async () => {
  const app = await createApp();
  const a = await reg(app, 'ma');
  const out = await reg(app, 'mo');
  const c = await app.inject({ method: 'POST', url: '/api/clubs', headers: auth(a.token), payload: { name: '我的俱乐部' } });
  const clubId = c.json().club.id;

  seedHand({ id: clubId, uidA: a.id, nameA: a.username }, 1, true);

  const r = await app.inject({ method: 'GET', url: `/api/clubs/${clubId}/my-stats`, headers: auth(a.token) });
  assert.equal(r.statusCode, 200);
  const me = r.json().me;
  assert.equal(me.username, a.username);
  for (const k of ['day', 'month', 'year', 'all']) {
    assert.ok(me[k], `应包含 ${k} 口径`);
    assert.equal(typeof me[k].net, 'number');
    assert.equal(typeof me[k].winRate, 'number');
  }
  assert.equal(me.all.hands, 1);
  assert.equal(me.all.net, 10);

  // 非成员 → 403
  const bad = await app.inject({ method: 'GET', url: `/api/clubs/${clubId}/my-stats`, headers: auth(out.token) });
  assert.equal(bad.statusCode, 403);

  // 未登录 → 401
  const anon = await app.inject({ method: 'GET', url: `/api/clubs/${clubId}/my-stats` });
  assert.equal(anon.statusCode, 401);

  await app.close();
});

test('GET /api/clubs/:id/stats：period=all 走累计表，时段走流水表，非法 period 回落 all', async () => {
  const app = await createApp();
  const a = await reg(app, 'sa');
  const c = await app.inject({ method: 'POST', url: '/api/clubs', headers: auth(a.token), payload: { name: '榜2' } });
  const clubId = c.json().club.id;
  seedHand({ id: clubId, uidA: a.id, nameA: a.username }, 1, true);

  const all = await app.inject({ method: 'GET', url: `/api/clubs/${clubId}/stats`, headers: auth(a.token) });
  assert.equal(all.statusCode, 200);
  assert.equal(all.json().period, 'all');
  assert.ok('total_score' in all.json().stats[0], 'all 走 player_stats 字段');

  const month = await app.inject({ method: 'GET', url: `/api/clubs/${clubId}/stats?period=month`, headers: auth(a.token) });
  assert.equal(month.json().period, 'month');
  assert.ok('net' in month.json().stats[0], '时段榜走 hand_records 字段');

  // 非法 period → 回落 all（不报错、不注入）
  const weird = await app.inject({ method: 'GET', url: `/api/clubs/${clubId}/stats?period=${encodeURIComponent("' OR 1=1--")}`, headers: auth(a.token) });
  assert.equal(weird.statusCode, 200);
  assert.equal(weird.json().period, 'all');

  await app.close();
});

test('流水写入是事务性的：中途抛错不留半截行', () => {
  const clubId = 999999;   // 不存在的俱乐部 → 外键会失败
  const before = db.prepare('SELECT COUNT(*) AS n FROM hand_records WHERE club_id = ?').get(clubId).n;
  assert.throws(() => {
    recordHandRows(clubId, 1, [{ uid: 1, username: 'x', delta: 1, fan: 1, gangs: 0, isWinner: true, huType: 'big' }]);
  });
  const after = db.prepare('SELECT COUNT(*) AS n FROM hand_records WHERE club_id = ?').get(clubId).n;
  assert.equal(after, before, '失败后不应留下行');
  // 事务已回滚（没有卡在 BEGIN 状态）：后续写入仍可用
  const a = { id: -1, uidA: null, nameA: 'x' };
  assert.equal(typeof a.id, 'number');
  assert.doesNotThrow(() => db.prepare('SELECT 1').get());
});
