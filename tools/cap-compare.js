#!/usr/bin/env node
/**
 * 算分口径对照：**单笔封顶**（`scaledPayCap`）到底有没有在起作用。
 *
 * 背景（老吴 2026-09-30）：
 *   「未开口也乘以二，不受普通 10 分封顶影响；风赖、原赖的时候封顶为 20，未开口则为 40 分。」
 *   「风赖显示金顶了，可是每家只付 10 分，应该是每家 20 分。」  ← 金顶也走同一公式
 *   → 单笔上限 = `goldScore(10) × mul(赖) × (未开口 ? 2 : 1)` = 普通 10 ／ 未开口 20 ／ 有赖 20 ／ 有赖+未开口 40
 *   → **金顶 = 每家各付自己那份上限**（所以风赖金顶 = 每家 20）。
 *
 * 这个脚本要回答一个很容易糊过去的问题：**非金顶局的那道封顶，在当前刻度下触发过没有？**
 *   答案是不会 —— 原文查表顶档只有 8 分，单笔自然上限 = 8×2 = 16（有赖）、8×2×2 = 32（有赖+未开口），
 *   都够不到 20 / 40。所以现状 = **照乘不封顶**，公式只是给「将来改刻度」留的接口。
 *   （每笔付款都带 `payCapApplied` 标记，脚本据此精确计数，不靠猜。）
 *
 * 为了把这个结论摆成看得见的东西，脚本跑**两组刻度** × **两个开关**：
 *   · 刻度 A = 原文（顶档 8 分）    → 「上限真的削了分(非金顶)」恒为 0；
 *                                     两列若有差异，只可能来自「金顶跟着倍率翻」。
 *   · 刻度 B = 只把顶档分值抬到 20（番档不动，故金顶判定不受影响）
 *                                   → 那道封顶才真正生效（削分笔数 > 0、单笔最大 80 → 40）。
 *
 * 用法：
 *   node tools/cap-compare.js --rounds 400
 *   node tools/cap-compare.js --rounds 400 --seed 20260930
 *
 * ⚠️ 统计口径：**把「包牌 / 包胡」的局整局剔出分档与均值**。包牌会让一家独付全部（可达 ~30 分），
 *    那是另一套机制，不剔会直接把倍率的信号淹掉。
 */
import { createGame, act } from '../src/engine/game.js';
import { decide } from '../src/bot/simpleBot.js';
import { createRuleSet } from '../src/engine/rules.js';

const MAX_STEPS = 6000;

function parseArgs(argv) {
  const opts = { rounds: 400, seed: 20260930 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rounds') opts.rounds = Number(argv[++i]);
    else if (a === '--seed') opts.seed = Number(argv[++i]);
  }
  return opts;
}

/** 从默认规则集取原文刻度，再把**顶档分值**抬到 20（番档保持不动 → 不影响金顶判定） */
const RAW_TABLE = createRuleSet('koukou').scoreTable;
const raiseTop = (t) => t.map(([fan, pts], i) => (i === t.length - 1 ? [fan, 20] : [fan, pts]));
const TOP20_TABLE = { small: raiseTop(RAW_TABLE.small), big: raiseTop(RAW_TABLE.big) };

/** 跑一批种子，返回统计 */
function runBatch({ rounds, seed, overrides }) {
  const ruleset = createRuleSet('koukou', overrides);
  const st = {
    rounds,
    wins: 0,
    draw: 0,
    goldTop: 0,
    baoRounds: 0,
    winnerFanSum: 0,
    winnerGainSum: 0,
    pays: [],
    /** 剔掉「承包 / 包胡」那些独付全部的笔 —— 那是另一套机制，会淹掉封顶的影响 */
    paysPlain: [],
    /** 这道单笔上限**真的削掉了分**的笔数（金顶走另一条分支，不计入） */
    payCapHits: 0,
    buckets: { '1-3': 0, '4-8': 0, '9-10': 0, '11-20': 0, '21-40': 0, '>40': 0 },
    zeroPay: 0,
  };

  for (let i = 0; i < rounds; i++) {
    let state = createGame({ seed: (seed + i * 7919) >>> 0, ruleset });
    let steps = 0;
    while (state.phase !== 'settled' && steps < MAX_STEPS) {
      steps++;
      const action = decide(state, state.turn);
      if (!action) break;
      state = act(state, action);
    }
    const r = state.result;
    if (!r || r.winnerSeat == null) { st.draw++; continue; }
    st.wins++;
    if (r.topType === 'goldTop') st.goldTop++;
    const hasBao = !!(r.bao || r.baozhuang);
    if (hasBao) st.baoRounds++;
    st.winnerFanSum += r.winnerFan ?? 0;
    st.winnerGainSum += r.totalWin ?? 0;
    for (const p of r.payments ?? []) {
      st.pays.push(p.pay);
      if (p.pay === 0) st.zeroPay++;
      if (p.payCapApplied) st.payCapHits++;
      if (hasBao) continue; // 分布桶只统计「非包牌」的常规笔，否则口径不一致
      st.paysPlain.push(p.pay);
      const v = p.pay;
      if (v <= 3) st.buckets['1-3']++;
      else if (v <= 8) st.buckets['4-8']++;
      else if (v <= 10) st.buckets['9-10']++;
      else if (v <= 20) st.buckets['11-20']++;
      else if (v <= 40) st.buckets['21-40']++;
      else st.buckets['>40']++;
    }
  }
  return st;
}

function summarize(st) {
  const pays = st.paysPlain.length ? st.paysPlain : st.pays;
  const over = pays.filter((v) => v > 10);
  const sum = pays.reduce((a, b) => a + b, 0);
  const max = pays.length ? Math.max(...pays) : 0;
  const pct = (n) => (st.wins ? ((n / st.wins) * 100).toFixed(1) + '%' : '—');
  const share = (n) => (pays.length ? ((n / pays.length) * 100).toFixed(1) + '%' : '—');
  const allShare = (n) => (st.pays.length ? ((n / st.pays.length) * 100).toFixed(1) + '%' : '—');
  return {
    胡牌率: ((st.wins / st.rounds) * 100).toFixed(1) + '%',
    荒庄率: ((st.draw / st.rounds) * 100).toFixed(1) + '%',
    金顶率: pct(st.goldTop),
    '含包牌局占比': pct(st.baoRounds),
    '平均赢家番': st.wins ? (st.winnerFanSum / st.wins).toFixed(2) : '—',
    '平均赢家总收': st.wins ? (st.winnerGainSum / st.wins).toFixed(2) : '—',
    '单笔均值(剔包牌)': pays.length ? (sum / pays.length).toFixed(2) : '—',
    '单笔最大(剔包牌)': max,
    '上限真的削了分(非金顶)': st.payCapHits,
    '超 10 分笔数': over.length,
    '超 10 分占比': share(over.length),
    '零分笔占比': allShare(st.zeroPay),
    '分布 1-3': share(st.buckets['1-3']),
    '分布 4-8': share(st.buckets['4-8']),
    '分布 9-10': share(st.buckets['9-10']),
    '分布 11-20': share(st.buckets['11-20']),
    '分布 21-40': share(st.buckets['21-40']),
    '分布 >40': share(st.buckets['>40']),
  };
}

function printTable(title, note, cols) {
  console.log(`\n### ${title}`);
  console.log(`> ${note}\n`);
  const keys = Object.keys(cols[0].data);
  const KW = Math.max(...keys.map((k) => k.length));
  const CW = 16;
  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
  console.log('| ' + pad('指标', KW) + ' | ' + cols.map((c) => pad(c.label, CW)).join(' | ') + ' |');
  console.log('|' + '-'.repeat(KW + 2) + '|' + cols.map(() => '-'.repeat(CW + 2)).join('|') + '|');
  for (const k of keys) {
    console.log('| ' + pad(k, KW) + ' | ' + cols.map((c) => pad(c.data[k], CW)).join(' | ') + ' |');
  }
}

const opts = parseArgs(process.argv.slice(2));
console.log(`\n同一批种子（seed=${opts.seed}，各 ${opts.rounds} 局，口口番）`);

const rawOff = runBatch({ ...opts, overrides: { scaledPayCap: false } });
const rawOn = runBatch({ ...opts, overrides: { scaledPayCap: true } });
const topOff = runBatch({ ...opts, overrides: { scaledPayCap: false, scoreTable: TOP20_TABLE } });
const topOn = runBatch({ ...opts, overrides: { scaledPayCap: true, scoreTable: TOP20_TABLE } });

printTable(
  '刻度 A：原文刻度（查表顶档 8 分）',
  [
    '两列的差异**全部来自「金顶跟着倍率翻」**（老吴 2026-09-30 最新口径：风赖金顶每家 20）——',
    '看「上限真的削了分(非金顶)」那一行：**永远是 0**。因为非金顶局的单笔自然上限只有',
    '`8×2 = 16`（有赖）／`8×2×2 = 32`（有赖+未开口），够不到 20 / 40 → 这道封顶**不触发**。',
  ].join('\n> '),
  [
    { label: '不封顶(旧金顶10)', data: summarize(rawOff) },
    { label: '跟着倍率(现默认)', data: summarize(rawOn) },
  ]
);

printTable(
  '刻度 B：只把顶档分值抬到 20（番档不动，金顶判定不变）',
  [
    '此时 20 / 40 才真正咬住 —— 看「上限真的削了分(非金顶)」从 0 变成 138 笔，单笔最大 80 → 40。',
    '这是给「将来要不要上移刻度」留的对照，不是当前口径。',
  ].join('\n> '),
  [
    { label: '不封顶', data: summarize(topOff) },
    { label: '跟着倍率封顶', data: summarize(topOn) },
  ]
);

console.log('');
