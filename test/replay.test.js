// 回放确定性：同一 seed/ruleset/dealer/prevWildTile + 全量动作日志，必须复算出完全相同的终局。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, act, legalActions } from '../src/engine/game.js';
import { createRuleSet } from '../src/engine/rules.js';

const CONFIG = {
  seed: 20261021,
  ruleset: createRuleSet('koukou', { claimTimeoutMs: 800 }),
  dealer: 1,
  prevWildTile: 17,
  names: ['阿东', '阿南', '阿西', '阿北'],
};

function playOneHand() {
  const state = createGame(CONFIG);
  const actions = [];
  let guard = 0;
  while (state.phase !== 'settled' && guard++ < 5000) {
    const seat = state.turn;
    const legal = legalActions(state, seat);
    const a = legal.find((x) => x.type === 'discard')
      || legal.find((x) => x.type === 'pass')
      || legal[0];
    assert.ok(a, `座位 ${seat} 没有合法动作`);
    act(state, { ...a, seat });
    actions.push({ seat, action: a });
  }
  // 摊牌确认也是动作日志的一部分（服务端同样会记录）
  while (state.reveal && state.reveal.pending) {
    const seat = [0, 1, 2, 3].find((i) => !state.reveal.confirmed.includes(i));
    act(state, { type: 'confirm', seat });
    actions.push({ seat, action: { type: 'confirm' } });
  }
  return { state, actions };
}

test('回放引擎：seed + 动作日志可完整复算终局（含摊牌确认）', () => {
  const original = playOneHand();
  assert.equal(original.state.phase, 'settled');
  assert.ok(original.actions.length > 10);

  const replay = createGame(CONFIG);
  for (const { seat, action } of original.actions) act(replay, { ...action, seat });

  assert.equal(replay.phase, 'settled');
  assert.deepEqual(replay.result, original.state.result);
  assert.deepEqual(replay.players.map((p) => p.hand), original.state.players.map((p) => p.hand));
  assert.deepEqual(replay.wall, original.state.wall);
  assert.deepEqual(replay.discardLog, original.state.discardLog);
  assert.equal(!!(replay.reveal && replay.reveal.pending), false);
});
