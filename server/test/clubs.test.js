// 俱乐部 / 牌桌 REST 回归测试（Fastify inject，不占端口）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';

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

test('俱乐部 / 牌桌全链路：建俱乐部→邀成员→建桌(规则规整)→查详情→改规则→权限', async () => {
  const app = await createApp();
  const owner = await reg(app, 'owner');
  const mate = await reg(app, 'mate');
  const outsider = await reg(app, 'out');

  // 建俱乐部
  const c = await app.inject({ method: 'POST', url: '/api/clubs', headers: auth(owner.token), payload: { name: '测试俱乐部' } });
  assert.equal(c.statusCode, 200);
  const clubId = c.json().club.id;

  // 我的俱乐部里应能看到，角色 owner
  const mine = await app.inject({ method: 'GET', url: '/api/clubs', headers: auth(owner.token) });
  assert.equal(mine.json().clubs.find((x) => x.id === clubId).role, 'owner');

  // 邀成员
  const inv = await app.inject({ method: 'POST', url: `/api/clubs/${clubId}/members`, headers: auth(owner.token), payload: { username: mate.username } });
  assert.equal(inv.statusCode, 200);

  // 重复邀 → 409
  const dup = await app.inject({ method: 'POST', url: `/api/clubs/${clubId}/members`, headers: auth(owner.token), payload: { username: mate.username } });
  assert.equal(dup.statusCode, 409);

  // 建桌：规则经 createRuleSet 规整（claimTimeoutMs 取整、fan 深合并不丢字段）
  const t = await app.inject({
    method: 'POST', url: `/api/clubs/${clubId}/tables`, headers: auth(owner.token),
    payload: { name: '1号桌', circleCount: 2, rules: { preset: 'koukou', claimTimeoutMs: 9000.4 } },
  });
  assert.equal(t.statusCode, 200);
  const table = t.json().table;
  assert.equal(table.rules.preset, 'koukou');
  assert.equal(table.rules.claimTimeoutMs, 9000);
  assert.equal(typeof table.rules.fan.selfDraw, 'number', 'fan 深合并后 selfDraw 不能被抹掉');
  assert.equal(table.circleCount, 2);

  // 成员可查桌详情
  const detail = await app.inject({ method: 'GET', url: `/api/tables/${table.id}`, headers: auth(mate.token) });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().table.id, table.id);

  // 非成员 → 403
  const out = await app.inject({ method: 'GET', url: `/api/tables/${table.id}`, headers: auth(outsider.token) });
  assert.equal(out.statusCode, 403);

  // 未登录 → 401
  const anon = await app.inject({ method: 'POST', url: '/api/clubs', payload: { name: 'x' } });
  assert.equal(anon.statusCode, 401);

  // 非房主改规则 → 403
  const notOwner = await app.inject({ method: 'PATCH', url: `/api/tables/${table.id}/rules`, headers: auth(mate.token), payload: { rules: { preset: 'kaikou' } } });
  assert.equal(notOwner.statusCode, 403);

  // 房主改规则 → 生效
  const patch = await app.inject({ method: 'PATCH', url: `/api/tables/${table.id}/rules`, headers: auth(owner.token), payload: { rules: { preset: 'kaikou' } } });
  assert.equal(patch.statusCode, 200);
  assert.equal(patch.json().table.rules.preset, 'kaikou');

  await app.close();
});

test('建桌参数校验：非法预设 400 / 圈数越界 400 / 空名 400', async () => {
  const app = await createApp();
  const owner = await reg(app, 'owner');
  const c = await app.inject({ method: 'POST', url: '/api/clubs', headers: auth(owner.token), payload: { name: 'C' } });
  const clubId = c.json().club.id;

  const badPreset = await app.inject({ method: 'POST', url: `/api/clubs/${clubId}/tables`, headers: auth(owner.token), payload: { name: 't', rules: { preset: 'nope' } } });
  assert.equal(badPreset.statusCode, 400);

  const badCircle = await app.inject({ method: 'POST', url: `/api/clubs/${clubId}/tables`, headers: auth(owner.token), payload: { name: 't', circleCount: 99 } });
  assert.equal(badCircle.statusCode, 400);

  const noName = await app.inject({ method: 'POST', url: `/api/clubs/${clubId}/tables`, headers: auth(owner.token), payload: { name: '' } });
  assert.equal(noName.statusCode, 400);

  await app.close();
});

test('重名查重 + 公开列表 + 入会申请（2026-10-30 改为申请制，需主席同意）', async () => {
  const app = await createApp();
  const owner = await reg(app, 'owner');
  const mate = await reg(app, 'mate');
  const outsider = await reg(app, 'out');

  // 建第一个俱乐部
  const c1 = await app.inject({ method: 'POST', url: '/api/clubs', headers: auth(owner.token), payload: { name: '老吴棋牌室' } });
  assert.equal(c1.statusCode, 200);
  const clubId = c1.json().club.id;

  // 重名 → 409（之前会被静默建出第二个同名俱乐部）
  const dup = await app.inject({ method: 'POST', url: '/api/clubs', headers: auth(mate.token), payload: { name: '老吴棋牌室' } });
  assert.equal(dup.statusCode, 409, '重名应被拒绝');
  assert.ok(dup.json().clubId, '409 应回带已存在的俱乐部 id');

  // 他人：我的俱乐部里看不到（设计如此）
  const mateMine = await app.inject({ method: 'GET', url: '/api/clubs', headers: auth(mate.token) });
  assert.equal(mateMine.json().clubs.find((x) => x.id === clubId), undefined, '非成员不应出现在「我的俱乐部」');

  // 他人：公开列表能看到、且 joined=false
  const disc = await app.inject({ method: 'GET', url: '/api/clubs/discover', headers: auth(mate.token) });
  const d = disc.json().clubs.find((x) => x.id === clubId);
  assert.ok(d, '公开列表应能看到该俱乐部');
  assert.equal(d.joined, false);
  assert.equal(d.memberCount, 1, '成员数应为 1（仅房主）');

  // 自助加入已废弃（2026-10-30）：现在是**申请制**，提交申请不会直接进会
  const apply = await app.inject({ method: 'POST', url: `/api/clubs/${clubId}/apply`, headers: auth(mate.token), payload: { note: '我是同事' } });
  assert.equal(apply.statusCode, 200);
  assert.equal(apply.json().pending, true, '应回 pending：等主席同意');
  assert.equal(apply.json().member, undefined, '不应直接成为成员');

  // 申请中：仍不在「我的俱乐部」、进不去俱乐部详情，但公开列表 pending=true
  const pendingMine = await app.inject({ method: 'GET', url: '/api/clubs', headers: auth(mate.token) });
  assert.equal(pendingMine.json().clubs.find((x) => x.id === clubId), undefined, '未获同意前不得出现在「我的俱乐部」');
  const pendingDetail = await app.inject({ method: 'GET', url: `/api/clubs/${clubId}`, headers: auth(mate.token) });
  assert.equal(pendingDetail.statusCode, 403, '未获同意前不得进入俱乐部');
  const discP = await app.inject({ method: 'GET', url: '/api/clubs/discover', headers: auth(mate.token) });
  assert.equal(discP.json().clubs.find((x) => x.id === clubId).pending, true, '公开列表应标记「已申请」');

  // 重复申请幂等：already=true，不重复排队
  const apply2 = await app.inject({ method: 'POST', url: `/api/clubs/${clubId}/apply`, headers: auth(mate.token) });
  assert.equal(apply2.json().already, true, '重复申请应幂等');

  // 主席看到 1 条待审，且能拿到留言
  const ownerDetail = await app.inject({ method: 'GET', url: `/api/clubs/${clubId}`, headers: auth(owner.token) });
  const apps = ownerDetail.json().applications || [];
  assert.equal(apps.length, 1, '主席应看到 1 条待审申请');
  assert.equal(apps[0].username, mate.username);
  assert.equal(apps[0].note, '我是同事');

  // 我的俱乐部列表：主席看到 pendingCount=1，普通成员看到 0（不泄露排队情况）
  const ownerMine = await app.inject({ method: 'GET', url: '/api/clubs', headers: auth(owner.token) });
  assert.equal(ownerMine.json().clubs.find((x) => x.id === clubId).pendingCount, 1);

  // 第三方不能审批（不是管理者）
  const outApply = await app.inject({ method: 'GET', url: `/api/clubs/${clubId}/applications`, headers: auth(outsider.token) });
  assert.equal(outApply.statusCode, 403, '非成员不得查看申请');

  // 主席同意 → 真正入会，待审清空
  const approve = await app.inject({ method: 'POST', url: `/api/clubs/${clubId}/applications/${mate.id}/approve`, headers: auth(owner.token) });
  assert.equal(approve.statusCode, 200);

  // 加入后：我的俱乐部能看到、公开列表里 joined=true（被过滤掉不再显示「申请」）
  const mateMine2 = await app.inject({ method: 'GET', url: '/api/clubs', headers: auth(mate.token) });
  assert.ok(mateMine2.json().clubs.find((x) => x.id === clubId), '同意后应在「我的俱乐部」出现');
  const disc2 = await app.inject({ method: 'GET', url: '/api/clubs/discover', headers: auth(mate.token) });
  assert.equal(disc2.json().clubs.find((x) => x.id === clubId).joined, true);
  const ownerDetail2 = await app.inject({ method: 'GET', url: `/api/clubs/${clubId}`, headers: auth(owner.token) });
  assert.equal((ownerDetail2.json().applications || []).length, 0, '审批后待审应清空');
  assert.ok(mate.username && ownerDetail2.json().members.some((m) => m.username === mate.username), '同意后成员表应有该用户');

  // 已是成员再申请 → member=true（幂等，不打扰主席）
  const apply3 = await app.inject({ method: 'POST', url: `/api/clubs/${clubId}/apply`, headers: auth(mate.token) });
  assert.equal(apply3.json().member, true);

  // 未登录访问公开列表 → 401
  const anon = await app.inject({ method: 'GET', url: '/api/clubs/discover' });
  assert.equal(anon.statusCode, 401);

  await app.close();
});

test('入会申请：拒绝后可重申 / 本人可撤销 / 非管理者不能审批', async () => {
  const app = await createApp();
  const owner = await reg(app, 'own2');
  const a1 = await reg(app, 'a1');
  const a2 = await reg(app, 'a2');

  const c = await app.inject({ method: 'POST', url: '/api/clubs', headers: auth(owner.token), payload: { name: '申请制俱乐部' } });
  const clubId = c.json().club.id;

  // ① 申请 → 主席拒绝 → 仍不是成员，且申请从待审列表消失
  await app.inject({ method: 'POST', url: `/api/clubs/${clubId}/apply`, headers: auth(a1.token) });
  const rej = await app.inject({ method: 'POST', url: `/api/clubs/${clubId}/applications/${a1.id}/reject`, headers: auth(owner.token) });
  assert.equal(rej.statusCode, 200);
  const afterRej = await app.inject({ method: 'GET', url: `/api/clubs/${clubId}`, headers: auth(a1.token) });
  assert.equal(afterRej.statusCode, 403, '被拒绝后仍然进不去');
  const pend1 = await app.inject({ method: 'GET', url: `/api/clubs/${clubId}/applications`, headers: auth(owner.token) });
  assert.equal(pend1.json().applications.length, 0, '拒绝后待审列表应为空');

  // ② 被拒后可以重新申请（状态回到 pending）
  const reapply = await app.inject({ method: 'POST', url: `/api/clubs/${clubId}/apply`, headers: auth(a1.token) });
  assert.equal(reapply.json().pending, true);
  assert.equal(reapply.json().already, undefined, '重新申请不是 already');
  const pend2 = await app.inject({ method: 'GET', url: `/api/clubs/${clubId}/applications`, headers: auth(owner.token) });
  assert.equal(pend2.json().applications.length, 1);

  // ③ 本人撤销 → 待审清空
  const cancel = await app.inject({ method: 'DELETE', url: `/api/clubs/${clubId}/applications/${a1.id}`, headers: auth(a1.token) });
  assert.equal(cancel.statusCode, 200);
  const pend3 = await app.inject({ method: 'GET', url: `/api/clubs/${clubId}/applications`, headers: auth(owner.token) });
  assert.equal(pend3.json().applications.length, 0, '撤销后待审应为空');

  // ④ 别人不能替人撤销
  await app.inject({ method: 'POST', url: `/api/clubs/${clubId}/apply`, headers: auth(a1.token) });
  const wrongCancel = await app.inject({ method: 'DELETE', url: `/api/clubs/${clubId}/applications/${a1.id}`, headers: auth(a2.token) });
  assert.equal(wrongCancel.statusCode, 403, '只能撤回自己的申请');

  // ⑤ 非管理者不能审批（a2 尚未入会，连申请列表都看不到）
  const notManager = await app.inject({ method: 'POST', url: `/api/clubs/${clubId}/applications/${a1.id}/approve`, headers: auth(a2.token) });
  assert.equal(notManager.statusCode, 403, '非管理者不得审批');

  // ⑥ 不存在的申请 / 已处理的申请 → 404
  const noApp = await app.inject({ method: 'POST', url: `/api/clubs/${clubId}/applications/${a2.id}/approve`, headers: auth(owner.token) });
  assert.equal(noApp.statusCode, 404, '没有待审记录时应 404');

  // ⑦ 主席直接拉人时，把该用户挂着的待审申请一并收口（不会永远留在待审里）
  const inv = await app.inject({ method: 'POST', url: `/api/clubs/${clubId}/members`, headers: auth(owner.token), payload: { username: a1.username } });
  assert.equal(inv.statusCode, 200);
  const pend4 = await app.inject({ method: 'GET', url: `/api/clubs/${clubId}/applications`, headers: auth(owner.token) });
  assert.equal(pend4.json().applications.length, 0, '直接拉人后待审应清空');

  await app.close();
});
