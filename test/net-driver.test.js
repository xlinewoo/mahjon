/**
 * 网络驱动动作时序：`table:state` 不能单独证明「我的动作成功」。
 *
 * 真实故障：服务端 8 秒自动「过」与玩家点「胡」同时发生，自动过先广播
 * state；旧驱动把这一帧当成胡牌成功，随后 ack 才报「还没轮到你」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNetDriver } from '../frontend/net-driver.js';

class FakeSocket {
  constructor() {
    this.handlers = new Map();
    this.lastAction = null;
  }
  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(fn);
  }
  off(event, fn) {
    this.handlers.get(event)?.delete(fn);
  }
  emit(event, action, cb) {
    if (event === 'action') this.lastAction = { action, cb };
  }
  fire(event, payload) {
    for (const fn of this.handlers.get(event) || []) fn(payload);
  }
}

const frame = (over = {}) => ({
  seat: 0,
  handNo: 1,
  dealer: 0,
  actingSeat: 0,
  ruleset: { claimTimeoutMs: 8000 },
  view: { phase: 'claim', turn: 0, me: { legal: [{ type: 'win' }] } },
  ...over,
});

const tick = () => new Promise((r) => setImmediate(r));

test('先到 state、后到成功 ack：动作在 ack 之前不能算成功', async () => {
  const socket = new FakeSocket();
  const driver = createNetDriver({ socket, initial: frame(), actionTimeoutMs: 1000 });
  let outcome = 'pending';
  const p = driver.act({ type: 'win' });
  p.then(() => { outcome = 'ok'; }, () => { outcome = 'error'; });

  socket.fire('table:state', frame({ actingSeat: 1 }));
  await tick();
  assert.equal(outcome, 'pending');

  socket.lastAction.cb({ ok: true });
  await p;
  assert.equal(outcome, 'ok');
  assert.equal(driver.getPayload().actingSeat, 1);
});

test('state 后到失败 ack：必须以失败收场，不能被 state 抢先 resolve', async () => {
  const socket = new FakeSocket();
  const driver = createNetDriver({ socket, initial: frame(), actionTimeoutMs: 1000 });
  let outcome = 'pending';
  const p = driver.act({ type: 'win' });
  p.then(() => { outcome = 'ok'; }, () => { outcome = 'error'; });

  socket.fire('table:state', frame({ actingSeat: 1, view: { phase: 'discard', turn: 1 } }));
  await tick();
  assert.equal(outcome, 'pending');

  socket.lastAction.cb({ error: '还没轮到你' });
  await assert.rejects(p, /还没轮到你/);
  assert.equal(outcome, 'error');
});

test('先到成功 ack、后到 state：等 state 到达后再 resolve', async () => {
  const socket = new FakeSocket();
  const driver = createNetDriver({ socket, initial: frame(), actionTimeoutMs: 1000 });
  let outcome = 'pending';
  const p = driver.act({ type: 'win' });
  p.then(() => { outcome = 'ok'; }, () => { outcome = 'error'; });

  socket.lastAction.cb({ ok: true });
  await tick();
  assert.equal(outcome, 'pending');

  socket.fire('table:state', frame({ actingSeat: 2 }));
  await p;
  assert.equal(outcome, 'ok');
  assert.equal(driver.getPayload().actingSeat, 2);
});
