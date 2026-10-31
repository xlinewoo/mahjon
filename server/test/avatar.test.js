// 头像（预设 + 上传）回归测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';

const rnd = () => Math.random().toString(36).slice(2, 8);

async function reg(app, prefix) {
  const username = `${prefix}_${rnd()}`;
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password: 'pass1234' } });
  const body = res.json();
  return { username, token: body.token, id: body.user.id };
}
const auth = (t) => ({ authorization: `Bearer ${t}` });

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

test('头像：预设列表 / 选预设 / URL 默认关闭 / 上传读取 / 目录穿越 / 非法格式', async () => {
  const app = await createApp();
  const u = await reg(app, 'avatar');

  // 预设列表
  const list = await app.inject({ method: 'GET', url: '/api/avatars' });
  assert.equal(list.statusCode, 200);
  const presets = list.json().presets;
  assert.ok(Array.isArray(presets) && presets.length > 0, '应有预设集');
  assert.equal(list.json().thirdPartyEnabled, false, '第三方头像默认关闭');

  // 选预设：非法 400
  const badPreset = await app.inject({ method: 'PUT', url: '/api/me/avatar', headers: auth(u.token), payload: { type: 'preset', value: '😈' } });
  assert.equal(badPreset.statusCode, 400);
  // 选预设：合法 200
  const okPreset = await app.inject({ method: 'PUT', url: '/api/me/avatar', headers: auth(u.token), payload: { type: 'preset', value: presets[0] } });
  assert.equal(okPreset.statusCode, 200);
  assert.equal(okPreset.json().avatar.value, presets[0]);

  // URL：默认关闭 → 403
  const urlOff = await app.inject({ method: 'PUT', url: '/api/me/avatar', headers: auth(u.token), payload: { type: 'url', value: 'https://example.com/a.png' } });
  assert.equal(urlOff.statusCode, 403);

  // 上传 multipart
  const boundary = '----wbTestBoundary' + rnd();
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8];
  const up = await app.inject({
    method: 'POST', url: '/api/me/avatar',
    headers: { ...auth(u.token), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: multipartBody(boundary, 'a.png', 'image/png', png),
  });
  assert.equal(up.statusCode, 200);
  assert.equal(up.json().avatar.type, 'upload');
  assert.equal(up.json().avatar.value, `${u.id}.png`);

  // 读取上传文件 → 字节一致
  const read = await app.inject({ method: 'GET', url: `/api/avatars/file/${u.id}.png` });
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.rawPayload, Buffer.from(png));

  // 目录穿越 → 404
  const trav = await app.inject({ method: 'GET', url: '/api/avatars/file/..%2F..%2Fmahjon.db' });
  assert.equal(trav.statusCode, 404);

  // 不支持的格式 → 400
  const badExt = await app.inject({
    method: 'POST', url: '/api/me/avatar',
    headers: { ...auth(u.token), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: multipartBody(boundary, 'a.txt', 'text/plain', [1, 2, 3]),
  });
  assert.equal(badExt.statusCode, 400);

  // 未登录上传 → 401
  const anon = await app.inject({
    method: 'POST', url: '/api/me/avatar',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: multipartBody(boundary, 'a.png', 'image/png', png),
  });
  assert.equal(anon.statusCode, 401);

  await app.close();
});
