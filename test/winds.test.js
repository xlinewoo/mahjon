/**
 * 摸风定座 + 方位映射 + 中央牌河数据源 的纯逻辑回归测试
 *
 * 背景（老吴 2026-09-30 前端改版）：
 *   · 首轮庄家不再是固定的座位 0，而是随机（摸风：牌最大者坐东并做庄）。
 *   · 四个玩家按方位（东南西北）排布，不再按「四行顺序」堆；你永远在下方。
 *   · 大家打出的牌集中到牌桌中央的公共牌河 —— 需要一份**全局**弃牌流水。
 *
 * 这些测试全部无 DOM，直接跑前端纯逻辑层（frontend/game-loop.js）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  drawWinds,
  drawWindKey,
  windsFromDealer,
  dirOf,
  DIR_ORDER,
} from '../src/engine/winds.js';
import {
  posOf,
  relOf,
  seatTag,
  buildSeatNames,
  POS_ORDER,
} from '../frontend/game-loop.js';
import { createGame, act, viewFor } from '../src/engine/game.js';
import { decide } from '../src/bot/simpleBot.js';
import { tileName, EAST, SOUTH, WEST, NORTH, RED_DRAGON, GREEN_DRAGON, WHITE_DRAGON, makeTile } from '../src/engine/tiles.js';

/* ---------------- 比牌权重 ---------------- */

test('摸风比牌权重：数字牌 > 字牌；数字按点数 9 最大；字牌 东>南>西>北>中>发>白', () => {
  const cmp = (a, b) => {
    const ka = drawWindKey(a);
    const kb = drawWindKey(b);
    for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  };

  // 数字牌全部大过字牌
  for (let n = 0; n < 27; n++) {
    for (const h of [EAST, SOUTH, WEST, NORTH, RED_DRAGON, GREEN_DRAGON, WHITE_DRAGON]) {
      assert.ok(cmp(n, h) > 0, `${tileName(n)} 应大于 ${tileName(h)}`);
    }
  }

  // 数字牌：点数为主序
  assert.ok(cmp(makeTile('wan', 9), makeTile('wan', 1)) > 0, '九万 > 一万');
  assert.ok(cmp(makeTile('tiao', 9), makeTile('tong', 9)) > 0, '同点数按 万<筒<条');
  assert.ok(cmp(makeTile('tong', 5), makeTile('wan', 5)) > 0, '五筒 > 五万');
  assert.equal(cmp(makeTile('wan', 5), makeTile('wan', 5)), 0, '同一张牌面应平局');

  // 字牌：东 > 南 > 西 > 北 > 中 > 发 > 白
  const honors = [EAST, SOUTH, WEST, NORTH, RED_DRAGON, GREEN_DRAGON, WHITE_DRAGON];
  for (let i = 1; i < honors.length; i++) {
    assert.ok(
      cmp(honors[i - 1], honors[i]) > 0,
      `${tileName(honors[i - 1])} 应大于 ${tileName(honors[i])}`,
    );
  }
});

/* ---------------- 摸风定座 ---------------- */

test('摸风定座不变量：方位唯一、庄家坐东、四家牌面互不相同、排名单调（2000 局）', () => {
  for (let seed = 1; seed <= 2000; seed++) {
    const w = drawWinds(seed);

    const dirs = Object.values(w.seatToDir);
    assert.equal(dirs.length, 4, `seed=${seed} 方位数不对`);
    assert.equal(new Set(dirs).size, 4, `seed=${seed} 方位有重复：${dirs.join(',')}`);
    assert.deepEqual([...dirs].sort(), [...DIR_ORDER].sort(), `seed=${seed} 方位集合不是东南西北`);

    // 庄家 = 东家
    assert.equal(w.seatToDir[w.dealer], '东', `seed=${seed} 庄家没坐东`);

    // 四家抽到的牌面互不相同（同牌面视为平局 → 直接洗牌抽，天然不同）
    const tiles = w.entries.map((e) => e.tile);
    assert.equal(new Set(tiles).size, 4, `seed=${seed} 摸风牌面重复：${tiles.join(',')}`);

    // entries 已按牌力降序
    for (let i = 1; i < 4; i++) {
      const a = drawWindKey(w.entries[i - 1].tile);
      const b = drawWindKey(w.entries[i].tile);
      const c = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
      assert.ok(c > 0, `seed=${seed} 摸风排名没按牌力降序`);
    }

    // entries 的 dir 与 seatToDir 自洽
    for (const e of w.entries) assert.equal(e.dir, w.seatToDir[e.seat], `seed=${seed} entries 与 seatToDir 不一致`);
  }
});

test('摸风可复现：同一 seed 抽两次结果完全一致', () => {
  for (const seed of [1, 7, 42, 999, 123456]) {
    const a = drawWinds(seed);
    const b = drawWinds(seed);
    assert.deepEqual(a.seatToDir, b.seatToDir, `seed=${seed} 方位不一致`);
    assert.deepEqual(a.entries, b.entries, `seed=${seed} 摸风牌不一致`);
    assert.equal(a.dealer, b.dealer, `seed=${seed} 庄家不一致`);
  }
});

test('摸风庄家分布均匀（4000 局，每家 20%~30%）', () => {
  const dist = [0, 0, 0, 0];
  for (let seed = 1; seed <= 4000; seed++) dist[drawWinds(seed).dealer]++;
  for (let s = 0; s < 4; s++) {
    const pct = (100 * dist[s]) / 4000;
    assert.ok(pct > 20 && pct < 30, `座位${s + 1} 坐庄率 ${pct.toFixed(1)}% 偏出 20~30%`);
  }
});

test('windsFromDealer 逆时针映射：庄家坐东，其余依次 北/西/南，无摸风牌面', () => {
  // 出牌逆时针：座位递增 → 东→北→西→南
  assert.deepEqual(windsFromDealer(0).seatToDir, { 0: '东', 1: '北', 2: '西', 3: '南' });
  assert.deepEqual(windsFromDealer(2).seatToDir, { 2: '东', 3: '北', 0: '西', 1: '南' });
  assert.equal(windsFromDealer(2).dealer, 2);
  assert.equal(windsFromDealer(2).entries, null);
});

/* ---------------- 方位 / 屏幕位置映射 ---------------- */

test('方位与屏幕位置映射：你永远在下方，下家在右、对家在上、上家在左', () => {
  assert.equal(posOf(0), 'bottom');
  assert.equal(posOf(1), 'right');
  assert.equal(posOf(2), 'top');
  assert.equal(posOf(3), 'left');
  assert.deepEqual(POS_ORDER, ['bottom', 'right', 'top', 'left']);
  assert.equal(relOf(0), '你');
  assert.equal(relOf(1), '下家');
  assert.equal(relOf(2), '对家');
  assert.equal(relOf(3), '上家');

  // 方位徽章跟着摸风结果旋转：座位→方位是「座位」的属性，与屏幕位置正交
  const seatToDir = { 0: '南', 1: '西', 2: '北', 3: '东' };
  assert.equal(dirOf(0, seatToDir), '南');
  assert.equal(dirOf(3, seatToDir), '东');
  assert.equal(seatTag(0, seatToDir), '南（你）');
  assert.equal(seatTag(3, seatToDir), '东·上家');
  assert.deepEqual(buildSeatNames(seatToDir), ['你', '西', '北', '东']);
});

test('方位映射兜底：没传 seatToDir 也要给出合法方位', () => {
  for (let s = 0; s < 4; s++) {
    assert.ok(DIR_ORDER.includes(dirOf(s, null)), `座位${s + 1} 兜底方位不合法`);
    assert.ok(DIR_ORDER.includes(dirOf(s, {})), `座位${s + 1} 空对象兜底方位不合法`);
  }
});

/* ---------------- 牌局全程牌河张数守恒（直接用引擎，不依赖单机驱动） ---------------- */

test('牌局全程牌河张数守恒：碰/吃/杠 拿走的牌不会留在中央牌河里', () => {
  // ⚠️ 必须用引擎**逐步**推进：game-loop.botStep() 一次可能让好几家打完，
  //    在它前后取差值会看到「一次 +3」，误判成 bug。
  let claimEvents = 0;
  for (let seed = 1; seed <= 40; seed++) {
    let st = createGame({ seed });
    let guard = 0;
    while (st.phase !== 'settled' && guard++ < 6000) {
      const before = st.players.reduce((a, p) => a + p.discards.length, 0);
      const beforeLog = st.discardLog.length;
      const a = decide(st, st.turn) || { type: 'pass', seat: st.turn };
      act(st, a);
      const after = st.players.reduce((acc, p) => acc + p.discards.length, 0);
      const afterLog = st.discardLog.length;

      // 核心不变量：各家 discards 之和 恒等于 全局流水长度
      assert.equal(after, afterLog, `seed=${seed} 牌河对不上：各家合计 ${after} vs 流水 ${afterLog}`);

      // 单步只会 +1（新打出）或 -1（被碰/吃/杠拿走），不存在别的跳变
      const delta = after - before;
      assert.ok(delta === 1 || delta === 0 || delta === -1, `seed=${seed} 单步牌河跳变 ${delta}`);
      assert.equal(afterLog - beforeLog, delta, `seed=${seed} 流水与各家 discards 变化幅度不一致`);
      if (delta === -1) claimEvents++;
    }
    assert.equal(st.phase, 'settled', `seed=${seed} 未跑完`);
  }
  assert.ok(claimEvents > 0, '样本里没抓到「牌被拿走」的情况，这条覆盖不到');
});
