#!/usr/bin/env node
/**
 * 入会申请流程端到端验证（真实 HTTP，临时数据目录）
 * 用法：node __apply-e2e.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 3011;
const DATA = mkdtempSync(join(tmpdir(), 'mahjon-apply-'));
const BASE = `http://127.0.0.1:${PORT}`;
const rnd = () => Math.random().toString(36).slice(2, 8);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

async function api(path, method = 'GET', body, token) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const reg = async (p) => {
  const d = (await api('/api/auth/register', 'POST', { username: `${p}_${rnd()}`, password: 'pass1234' })).data;
  return { token: d.token, username: d.user.username, id: d.user.id };
};

const env = { ...process.env, PORT: String(PORT), DATA_DIR: DATA, HOST: '127.0.0.1', JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret-00', NODE_ENV: 'test' };
delete env.npm_config_prefix;
const child = spawn(process.execPath, ['--experimental-sqlite', 'server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: process.cwd() });
child.stdout.on('data', () => {});
child.stderr.on('data', (b) => process.stderr.write('[srv] ' + b));

const waitUp = async () => {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok || r.status < 500) return; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('服务未启动');
};

try {
  await waitUp();
  console.log('\n【1】主席建俱乐部，成员提交申请');
  const owner = await reg('ap_owner');
  const bob = await reg('ap_bob');
  const cat = await reg('ap_cat');
  const club = (await api('/api/clubs', 'POST', { name: `申请制俱乐部_${rnd()}` }, owner.token)).data.club;
  ok(!!club.id, `建俱乐部 id=${club.id}`);

  const ap1 = await api(`/api/clubs/${club.id}/apply`, 'POST', { note: '我是老王同事' }, bob.token);
  ok(ap1.status === 200 && ap1.data.pending === true && !ap1.data.member, '提交申请 → pending，未直接入会');
  ok((await api(`/api/clubs/${club.id}`, 'GET', null, bob.token)).status === 403, '未审批前访问俱乐部 → 403');

  const disc = (await api('/api/clubs/discover', 'GET', null, bob.token)).data.clubs.find((c) => c.id === club.id);
  ok(disc && disc.joined === false && disc.pending === true, '公开列表：joined=false / pending=true（前端按钮变「撤回申请」）');

  console.log('\n【2】主席侧：待审列表 / 越权拦截');
  const list = (await api(`/api/clubs/${club.id}/applications`, 'GET', null, owner.token)).data.applications;
  ok(list.length === 1 && list[0].id === bob.id, `主席看到 1 条申请（${list[0]?.username}）`);
  ok(list[0].note === '我是老王同事', '申请留言透传');
  ok((await api(`/api/clubs/${club.id}/applications`, 'GET', null, bob.token)).status === 403, '申请人自己查待审列表 → 403');

  const mineO = (await api('/api/clubs', 'GET', null, owner.token)).data.clubs.find((c) => c.id === club.id);
  ok(mineO.pendingCount === 1, `主席「我的俱乐部」pendingCount=1`);

  await api(`/api/clubs/${club.id}/apply`, 'POST', {}, cat.token);

  console.log('\n【3】重复申请幂等 / 本人撤回');
  const ap2 = await api(`/api/clubs/${club.id}/apply`, 'POST', {}, bob.token);
  ok(ap2.data.already === true, '重复申请 → already=true（不重复排队）');
  const cancel = await api(`/api/clubs/${club.id}/applications/${bob.id}`, 'DELETE', null, bob.token);
  ok(cancel.status === 200, `本人撤回申请 200（实际 ${cancel.status} ${JSON.stringify(cancel.data)}）`);
  ok((await api(`/api/clubs/${club.id}/applications`, 'GET', null, owner.token)).data.applications.length === 1, '撤回后待审只剩 1 条');

  console.log('\n【4】同意 / 拒绝');
  const ap3 = await api(`/api/clubs/${club.id}/apply`, 'POST', {}, bob.token);
  ok(ap3.data.pending === true && !ap3.data.already, '撤回后可重新申请');
  ok((await api(`/api/clubs/${club.id}/applications/${bob.id}/approve`, 'POST', {}, bob.token)).status === 403, '申请人自己批自己 → 403');

  const approve = await api(`/api/clubs/${club.id}/applications/${bob.id}/approve`, 'POST', {}, owner.token);
  ok(approve.status === 200, '主席同意 200');
  const bobView = await api(`/api/clubs/${club.id}`, 'GET', null, bob.token);
  ok(bobView.status === 200 && bobView.data.role === 'member', '同意后即可进会，身份 member');
  ok(bobView.data.applications.length === 0, '普通成员拿不到待审列表（空数组，不泄露管理信息）');

  const reject = await api(`/api/clubs/${club.id}/applications/${cat.id}/reject`, 'POST', {}, owner.token);
  ok(reject.status === 200, '主席拒绝 200');
  ok((await api(`/api/clubs/${club.id}`, 'GET', null, cat.token)).status === 403, '被拒绝者仍 403');
  ok((await api(`/api/clubs/${club.id}/applications`, 'GET', null, owner.token)).data.applications.length === 0, '拒绝后待审清空');

  console.log('\n【5】旧路径 /join 已降级为申请（不再绕过审批）');
  const old = await api('/api/clubs/' + club.id + '/join', 'POST', {}, cat.token);
  ok(old.data.pending === true && !old.data.member, '/join 只落申请，不直接入会');
  ok((await api(`/api/clubs/${club.id}`, 'GET', null, cat.token)).status === 403, '/join 后仍需审批');

  console.log('\n【6】踢人后重新申请');
  await api(`/api/clubs/${club.id}/applications/${cat.id}/approve`, 'POST', {}, owner.token);
  ok((await api(`/api/clubs/${club.id}`, 'GET', null, cat.token)).status === 200, '同意后进会');
  const kick2 = await api(`/api/clubs/${club.id}/members/${cat.id}`, 'DELETE', null, owner.token);
  ok(kick2.status === 200, `踢人 200（实际 ${kick2.status} ${JSON.stringify(kick2.data)}）`);
  const afterKick = await api(`/api/clubs/${club.id}`, 'GET', null, cat.token);
  ok(afterKick.status === 403, `被踢后立刻 403（实际 ${afterKick.status} role=${afterKick.data?.role}）`);
  const re = await api(`/api/clubs/${club.id}/apply`, 'POST', {}, cat.token);
  ok(re.data.pending === true, '被踢后可重新申请（approved → pending）');
} catch (e) {
  fail++;
  console.error('脚本异常：', e.message);
} finally {
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 400));
  try { rmSync(DATA, { recursive: true, force: true }); } catch {}
  console.log(`\n===== 通过 ${pass} · 失败 ${fail} =====`);
  process.exit(fail ? 1 : 0);
}
