// 鉴权链路测试：注册 -> 登录 -> 当前用户；覆盖异常分支。
// 用 Fastify app.inject（内存级，不监听端口，可在沙箱内验证 REST 逻辑）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { AVATAR_PRESETS } from '../avatars.js';

test('health 返回 ok', async () => {
  const app = await createApp();
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.payload).ok, true);
  await app.close();
});

test('register -> login -> me 全链路', async () => {
  const app = await createApp();
  await app.ready();

  const username = 'tester_' + Date.now();
  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: 'pass1234', avatar: { type: 'preset', value: AVATAR_PRESETS[0] } },
  });
  assert.equal(reg.statusCode, 200);
  const regBody = JSON.parse(reg.payload);
  assert.ok(regBody.token, '注册应返回 token');
  assert.equal(regBody.user.username, username);
  assert.deepEqual(regBody.user.avatar, { type: 'preset', value: AVATAR_PRESETS[0] });

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: 'pass1234' },
  });
  assert.equal(login.statusCode, 200);
  const loginBody = JSON.parse(login.payload);
  assert.ok(loginBody.token, '登录应返回 token');

  const wrongPw = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: 'bad' },
  });
  assert.equal(wrongPw.statusCode, 401);

  const me = await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { authorization: 'Bearer ' + loginBody.token },
  });
  assert.equal(me.statusCode, 200);
  assert.equal(JSON.parse(me.payload).user.username, username);

  const meNoToken = await app.inject({ method: 'GET', url: '/api/me' });
  assert.equal(meNoToken.statusCode, 401);

  const dup = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: 'pass1234' },
  });
  assert.equal(dup.statusCode, 409, '重复用户名应 409');

  await app.close();
});

test('注册参数校验', async () => {
  const app = await createApp();
  await app.ready();

  const noPw = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'x' },
  });
  assert.equal(noPw.statusCode, 400);

  const shortPw = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'y' + Date.now(), password: '12' },
  });
  assert.equal(shortPw.statusCode, 400);

  await app.close();
});
