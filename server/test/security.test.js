// 安全回归（2026-10-29 审计修复项）：限速 / 令牌撤销 / 回放权限 / 成员管理 / 响应头 / 头像魔数
//
// 每个 test 各建一个 app —— 限速器是**插件作用域**的，各测各的桶，不会互相打满。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { saveHandReplay } from '../db.js';

const rnd = () => Math.random().toString(36).slice(2, 8);

async function reg(app, prefix, password = 'pass1234') {
  const username = `${prefix}_${rnd()}`;
  const res = await app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { username, password },
  });
  assert.equal(res.statusCode, 200, '注册应成功：' + res.payload);
  const body = res.json();
  return { username, password, token: body.token, id: body.user.id };
}

const auth = (t) => ({ authorization: `Bearer ${t}` });
const login = (app, username, password) => app.inject({
  method: 'POST', url: '/api/auth/login', payload: { username, password },
});
const me = (app, token) => app.inject({ method: 'GET', url: '/api/me', headers: auth(token) });

/* ------------------------------------------------------------------ */
/* ① 登录限速：成功登录不再清零别人的失败计数                            */
/* ------------------------------------------------------------------ */

test('登录限速：猜满 8 次即锁；用自己账号登录成功**不会**清掉受害者的计数', async () => {
  const app = await createApp();
  const victim = await reg(app, 'victim');
  const attacker = await reg(app, 'attacker');
  await app.ready();

  for (let i = 0; i < 8; i++) {
    const r = await login(app, victim.username, 'wrong-pass-' + i);
    assert.equal(r.statusCode, 401, `第 ${i + 1} 次错误密码应是 401`);
  }
  const locked = await login(app, victim.username, 'wrong-pass-x');
  assert.equal(locked.statusCode, 429, '超过阈值应 429');
  assert.ok(Number(locked.headers['retry-after']) > 0, '应带 retry-after');

  // 关键回归：旧实现在这里 clearAuthFails(req) 会把**该 IP** 的计数整体清零，
  // 于是「猜 8 次 → 登录自己的号 → 再猜 8 次」可以无限循环。
  const selfOk = await login(app, attacker.username, attacker.password);
  assert.equal(selfOk.statusCode, 200, '攻击者用自己的账号可以正常登录');

  const stillLocked = await login(app, victim.username, 'wrong-pass-y');
  assert.equal(stillLocked.statusCode, 429, '别人登录成功不能把受害者的桶清零');

  await app.close();
});

test('登录限速：同一 IP 对自己账号输错后再输对，应恢复正常（只清自己那把钥匙）', async () => {
  const app = await createApp();
  const u = await reg(app, 'typo');
  await app.ready();

  for (let i = 0; i < 3; i++) await login(app, u.username, 'nope-' + i);
  const ok = await login(app, u.username, u.password);
  assert.equal(ok.statusCode, 200, '3 次手滑后输对应放行');
  assert.ok(ok.json().token);

  // 清掉的是 ip|user 这一把钥匙，所以之后又能继续（这里只验「没被永久锁」）
  const againBad = await login(app, u.username, 'nope-again');
  assert.equal(againBad.statusCode, 401, '清零后重新计数，不是 429');

  await app.close();
});

/* ------------------------------------------------------------------ */
/* ② 令牌可撤销：登出 / 改密                                            */
/* ------------------------------------------------------------------ */

test('登出：旧令牌立即失效（token_version +1），重新登录拿到的新令牌可用', async () => {
  const app = await createApp();
  const u = await reg(app, 'logout');
  await app.ready();

  assert.equal((await me(app, u.token)).statusCode, 200);

  const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: auth(u.token) });
  assert.equal(out.statusCode, 200);

  assert.equal((await me(app, u.token)).statusCode, 401, '登出后旧令牌必须失效');

  const again = await login(app, u.username, u.password);
  assert.equal(again.statusCode, 200);
  assert.equal((await me(app, again.json().token)).statusCode, 200, '新令牌可用');

  await app.close();
});

test('改密：验旧密码、旧令牌全废、当前会话补发新令牌、新密码可登录', async () => {
  const app = await createApp();
  const u = await reg(app, 'pwchg');
  await app.ready();

  const wrongOld = await app.inject({
    method: 'POST', url: '/api/auth/password', headers: auth(u.token),
    payload: { oldPassword: 'not-my-password', newPassword: 'brandNew123' },
  });
  assert.equal(wrongOld.statusCode, 401);

  const tooShort = await app.inject({
    method: 'POST', url: '/api/auth/password', headers: auth(u.token),
    payload: { oldPassword: u.password, newPassword: '1234567' },
  });
  assert.equal(tooShort.statusCode, 400, '新密码不足 8 位应拒绝');

  const same = await app.inject({
    method: 'POST', url: '/api/auth/password', headers: auth(u.token),
    payload: { oldPassword: u.password, newPassword: u.password },
  });
  assert.equal(same.statusCode, 400, '新旧密码相同应拒绝');

  const ok = await app.inject({
    method: 'POST', url: '/api/auth/password', headers: auth(u.token),
    payload: { oldPassword: u.password, newPassword: 'brandNew123' },
  });
  assert.equal(ok.statusCode, 200);
  assert.ok(ok.json().token, '改密后应补发新令牌');

  assert.equal((await me(app, u.token)).statusCode, 401, '改密后旧令牌必须失效');
  assert.equal((await me(app, ok.json().token)).statusCode, 200, '补发的新令牌可用');

  assert.equal((await login(app, u.username, u.password)).statusCode, 401, '旧密码不能再用');
  assert.equal((await login(app, u.username, 'brandNew123')).statusCode, 200, '新密码可登录');

  await app.close();
});

/* ------------------------------------------------------------------ */
/* ③ 回放权限：普通成员不能读别人的牌局                                  */
/* ------------------------------------------------------------------ */

test('回放权限：普通成员看不到别人的牌局；主席可看全量；列表同口径过滤', async () => {
  const app = await createApp();
  const owner = await reg(app, 'r_owner');
  const mate = await reg(app, 'r_mate');
  const peek = await reg(app, 'r_peek'); // 只加入俱乐部、没参与牌局
  await app.ready();

  const clubRes = await app.inject({
    method: 'POST', url: '/api/clubs', headers: auth(owner.token),
    payload: { name: `权限俱乐部_${rnd()}` },
  });
  const clubId = clubRes.json().club.id;
  for (const u of [mate, peek]) {
    await app.inject({
      method: 'POST', url: `/api/clubs/${clubId}/members`, headers: auth(owner.token),
      payload: { username: u.username },
    });
  }
  const tableRes = await app.inject({
    method: 'POST', url: `/api/clubs/${clubId}/tables`, headers: auth(owner.token),
    payload: { name: '权限桌', circleCount: 1 },
  });
  const tableId = tableRes.json().table.id;

  const replayId = saveHandReplay({
    clubId,
    tableId,
    tableName: '权限桌',
    handNo: 1,
    seed: 424242,
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

  // 参与者（同时是普通成员）：能看
  const mateDetail = await app.inject({ method: 'GET', url: `/api/replays/${replayId}`, headers: auth(mate.token) });
  assert.equal(mateDetail.statusCode, 200);
  assert.equal(mateDetail.json().replay.seed, 424242);

  // 纯成员（加入过、没打过）：**不能**看别人的底牌 —— 这是本次收紧的核心
  const peekDetail = await app.inject({ method: 'GET', url: `/api/replays/${replayId}`, headers: auth(peek.token) });
  assert.equal(peekDetail.statusCode, 403);

  const peekList = await app.inject({ method: 'GET', url: `/api/clubs/${clubId}/replays`, headers: auth(peek.token) });
  assert.equal(peekList.statusCode, 200, '列表本身仍可访问');
  assert.equal(peekList.json().replays.length, 0, '但只应列出自己参与的牌局（这里是 0 把）');
  assert.equal(peekList.json().scope, 'self');

  // 主席：全量
  const ownerList = await app.inject({ method: 'GET', url: `/api/clubs/${clubId}/replays`, headers: auth(owner.token) });
  assert.equal(ownerList.json().replays[0].id, replayId);
  assert.equal(ownerList.json().scope, 'club');

  const ownerSessions = await app.inject({
    method: 'GET', url: `/api/clubs/${clubId}/replays/sessions`, headers: auth(owner.token),
  });
  assert.equal(ownerSessions.json().sessions.length, 1, '主席能看到这一场');

  const peekSessions = await app.inject({
    method: 'GET', url: `/api/clubs/${clubId}/replays/sessions`, headers: auth(peek.token),
  });
  assert.equal(peekSessions.json().sessions.length, 0, '普通成员看不到别人的场次');

  await app.close();
});

/* ------------------------------------------------------------------ */
/* ④ 俱乐部：名称上限 / 退出 / 踢人                                      */
/* ------------------------------------------------------------------ */

test('俱乐部：名称有长度与字符上限', async () => {
  const app = await createApp();
  const owner = await reg(app, 'cname');
  await app.ready();

  const long = await app.inject({
    method: 'POST', url: '/api/clubs', headers: auth(owner.token),
    payload: { name: '长'.repeat(25) },
  });
  assert.equal(long.statusCode, 400, '超 24 字符应拒绝');

  const tag = await app.inject({
    method: 'POST', url: '/api/clubs', headers: auth(owner.token),
    payload: { name: '<img src=x onerror=alert(1)>' },
  });
  assert.equal(tag.statusCode, 400, '含尖括号应拒绝');

  const ok = await app.inject({
    method: 'POST', url: '/api/clubs', headers: auth(owner.token),
    payload: { name: '正常名称' },
  });
  assert.equal(ok.statusCode, 200);

  await app.close();
});

test('俱乐部：成员可退出、主席不能退；主席可踢人且被踢者立刻失去访问', async () => {
  const app = await createApp();
  const owner = await reg(app, 'm_owner');
  const mate = await reg(app, 'm_mate');
  const stray = await reg(app, 'm_stray');
  await app.ready();

  const clubRes = await app.inject({
    method: 'POST', url: '/api/clubs', headers: auth(owner.token),
    payload: { name: `成员俱乐部_${rnd()}` },
  });
  const clubId = clubRes.json().club.id;

  // 2026-10-30 起改为申请制：申请不等于入会，必须主席同意
  const joinByApproval = async (u) => {
    const ap = await app.inject({
      method: 'POST', url: `/api/clubs/${clubId}/apply`, headers: auth(u.token),
      payload: { note: '同事' },
    });
    assert.equal(ap.statusCode, 200, '提交申请应成功：' + ap.payload);
    assert.equal(ap.json().pending, true);
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/clubs/${clubId}`, headers: auth(u.token) })).statusCode,
      403, '未审批前不应能进会',
    );
    const ok = await app.inject({
      method: 'POST', url: `/api/clubs/${clubId}/applications/${u.id}/approve`, headers: auth(owner.token),
    });
    assert.equal(ok.statusCode, 200, '主席审批应成功：' + ok.payload);
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/clubs/${clubId}`, headers: auth(u.token) })).statusCode,
      200, '审批后应能进会',
    );
  };
  for (const u of [mate, stray]) await joinByApproval(u);

  // 自助退出
  const leave = await app.inject({ method: 'POST', url: `/api/clubs/${clubId}/leave`, headers: auth(stray.token) });
  assert.equal(leave.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/api/clubs/${clubId}`, headers: auth(stray.token) })).statusCode, 403);

  // 主席不能退出（俱乐部必须有主人）
  const ownerLeave = await app.inject({ method: 'POST', url: `/api/clubs/${clubId}/leave`, headers: auth(owner.token) });
  assert.equal(ownerLeave.statusCode, 400);

  // 主席踢人
  const kick = await app.inject({ method: 'DELETE', url: `/api/clubs/${clubId}/members/${mate.id}`, headers: auth(owner.token) });
  assert.equal(kick.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/api/clubs/${clubId}`, headers: auth(mate.token) })).statusCode, 403, '被踢后立刻 403');

  // 普通成员不能踢人（被踢后重新走申请+审批，身份回到 member）
  await joinByApproval(mate);
  const byMember = await app.inject({ method: 'DELETE', url: `/api/clubs/${clubId}/members/${owner.id}`, headers: auth(mate.token) });
  assert.equal(byMember.statusCode, 403);

  await app.close();
});

/* ------------------------------------------------------------------ */
/* ⑤ 安全响应头                                                         */
/* ------------------------------------------------------------------ */

test('安全响应头：CSP / nosniff / X-Frame-Options 就位（HTML 才有 CSP）', async () => {
  const app = await createApp();
  await app.ready();

  const page = await app.inject({ method: 'GET', url: '/app/net' });
  assert.equal(page.statusCode, 200);
  const csp = page.headers['content-security-policy'];
  assert.ok(csp, 'HTML 必须带 CSP');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal(page.headers['referrer-policy'], 'no-referrer');

  // JSON 接口不需要 CSP，但 nosniff 必须有（API 响应也可能被当资源加载）
  const api = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(api.headers['x-content-type-options'], 'nosniff');
  assert.equal(api.headers['content-security-policy'], undefined);

  await app.close();
});

/* ------------------------------------------------------------------ */
/* ⑥ 头像：文件魔数校验                                                  */
/* ------------------------------------------------------------------ */

function multipartBody(boundary, filename, mimetype, bytes) {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimetype}\r\n\r\n`,
      'utf8',
    ),
    Buffer.from(bytes),
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);
}

test('头像上传：声明的 mimetype 与文件真实魔数不符 → 拒绝（防「伪 PNG」藏脚本）', async () => {
  const app = await createApp();
  const u = await reg(app, 'sniff');
  await app.ready();

  const boundary = '----wbSecBoundary' + rnd();
  const html = Buffer.from('<html><script>alert(document.cookie)</script></html>', 'utf8');
  const fake = await app.inject({
    method: 'POST', url: '/api/me/avatar',
    headers: { ...auth(u.token), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: multipartBody(boundary, 'evil.png', 'image/png', html),
  });
  assert.equal(fake.statusCode, 400, '内容不是 PNG 就必须拒');

  // 真 PNG 仍可上传（回归：别把正常路径也堵了）
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8];
  const real = await app.inject({
    method: 'POST', url: '/api/me/avatar',
    headers: { ...auth(u.token), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: multipartBody(boundary, 'ok.png', 'image/png', png),
  });
  assert.equal(real.statusCode, 200);

  await app.close();
});
