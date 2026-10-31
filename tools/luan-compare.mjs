#!/usr/bin/env node
/**
 * 对照测量：乱将 / 乱风（老吴 2026-09-30 第 2 条缺陷）
 *
 *   「将一色、风一色都不需要按顺子、刻子的规则，全手牌只要全是将牌或者风牌
 *     就可以胡牌，即乱将乱风就可以」
 *
 * 开关：`luanJiangEnabled` / `luanFengEnabled`（默认都开，见 rules.js）。
 *
 * 为什么要单独量：这两个开关**放宽了胡牌形状**，最可能的副作用是金顶率与平均番上升
 * （将一色 = 14 张全是 2/5/8；风一色 = 14 张全字牌，本身都是「类型数×3 番」的大胡）。
 * 老吴上一轮刚因为「金顶概率过高」翻过案（原赖/风赖不加番改乘分），
 * 所以这里必须给出**同一批种子下的前后对照**，而不是只说「改好了」。
 *
 * 用法：
 *   node tools/luan-compare.mjs                 # 默认 400 局，口口番
 *   node tools/luan-compare.mjs 400 --preset kaikou
 *   node tools/luan-compare.mjs --seed 20260930
 */
import { createGame, act } from '../src/engine/game.js';
import { decide } from '../src/bot/simpleBot.js';
import { createRuleSet, RULE_PRESETS } from '../src/engine/rules.js';

const MAX_STEPS = 6000;

/** ⚠️ 键必须与 score.js 里 `types.push('xxx')` 的字面量**逐字一致**（camelCase，pengpengHu 不是 pengPengHu） */
const LABEL = {
  pengpengHu: '碰碰胡',
  qingYiSe: '清一色',
  jiangYiSe: '将一色',
  fengYiSe: '风一色',
  quanQiuRen: '全求人',
  gangShangKaiHua: '杠上开花',
  haiDiLao: '海底捞',
  qiangGangHu: '抢杠胡',
  qiPi: '七皮',
  shiGang: '十杠',
};

function parseArgs(argv) {
  const opts = { rounds: Number(argv[0] && !argv[0].startsWith('--') ? argv[0] : 400), seed: 1000, preset: 'koukou' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--seed') opts.seed = Number(argv[++i]);
    else if (argv[i] === '--preset') opts.preset = argv[++i];
    else if (argv[i] === '--rounds') opts.rounds = Number(argv[++i]);
  }
  return opts;
}

function runBatch({ rounds, seed, preset, overrides }) {
  const ruleset = createRuleSet(preset, overrides);
  const st = {
    rounds, wins: 0, draw: 0, gold: 0, big: 0,
    fanSum: 0, types: new Map(), fanDist: new Map(),
  };
  for (let i = 0; i < rounds; i++) {
    let state = createGame({ seed: (seed + i * 7919) >>> 0, ruleset });
    let steps = 0;
    while (state.phase !== 'settled' && steps < MAX_STEPS) {
      steps++;
      const a = decide(state, state.turn);
      if (!a) break;
      state = act(state, a);
    }
    const r = state.result;
    if (!r || r.winner == null) { st.draw++; continue; }
    st.wins++;
    if (r.topType === 'goldTop') st.gold++;
    if (r.size === 'big') st.big++;
    st.fanSum += r.winnerFan ?? 0;
    st.fanDist.set(r.winnerFan, (st.fanDist.get(r.winnerFan) || 0) + 1);
    for (const t of r.types || []) st.types.set(t, (st.types.get(t) || 0) + 1);
  }
  return st;
}

const opts = parseArgs(process.argv.slice(2));
if (!RULE_PRESETS[opts.preset]) {
  console.error(`未知预设：${opts.preset}（可选 ${Object.keys(RULE_PRESETS).join(' / ')}）`);
  process.exit(1);
}

/** 关 = 旧口径（将/风一色必须成顺子刻子）；开 = 新口径（乱将乱风） */
const ARM_OFF = { luanJiangEnabled: false, luanFengEnabled: false };
const ARM_ON = { luanJiangEnabled: true, luanFengEnabled: true };

console.log(`\n=== 乱将 / 乱风 对照（${opts.preset} · 同一批种子 seed=${opts.seed} 起 · ${opts.rounds} 局）===\n`);

const off = runBatch({ ...opts, overrides: ARM_OFF });
const on = runBatch({ ...opts, overrides: ARM_ON });

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + '%' : '—');
const num = (n, d) => (d ? (n / d).toFixed(2) : '—');

const rows = [
  ['荒庄局', off.draw, on.draw, (x) => x],
  ['胡牌局', off.wins, on.wins, (x) => x],
  ['金顶局', off.gold, on.gold, (x) => pct(x, opts.rounds)],
  ['大胡局', off.big, on.big, (x) => x],
  ['平均赢家番', off.fanSum, on.fanSum, (x) => num(x, opts.rounds)],
];
/** 中日韩字符占 2 列宽 —— 直接 padEnd 会错位 */
const W = (str) => [...str].reduce((a, ch) => a + (ch.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
const padL = (str, n) => str + ' '.repeat(Math.max(0, n - W(str)));
const padR = (str, n) => ' '.repeat(Math.max(0, n - W(str))) + str;

const KW = 14, CW = 14;
console.log('  ' + padL('指标', KW) + padR('关（旧）', CW) + padR('开（新）', CW) + padR('差值', 10));
console.log('  ' + '-'.repeat(58));
for (const [k, a, b, fmt] of rows) {
  const fa = Number(fmt(a)); const fb = Number(fmt(b));
  const d = Number.isFinite(fa) && Number.isFinite(fb) ? (fb - fa >= 0 ? '+' : '') + (fb - fa).toFixed(1) : '—';
  console.log('  ' + padL(String(k), KW) + padR(String(fmt(a)), CW) + padR(String(fmt(b)), CW) + padR(String(d), 10));
}

console.log('\n  牌型出现局数（占胡牌局）：');
const all = [...new Set([...off.types.keys(), ...on.types.keys()])]
  .sort((x, y) => (on.types.get(y) || 0) - (on.types.get(x) || 0));
for (const t of all) {
  const a = off.types.get(t) || 0;
  const b = on.types.get(t) || 0;
  console.log(`    ${padL(LABEL[t] || t, 12)} 关 ${String(a).padStart(4)} (${pct(a, off.wins)})`
    + `   开 ${String(b).padStart(4)} (${pct(b, on.wins)})${b !== a ? '   ← 变化' : ''}`);
}

const diffFans = [...new Set([...off.fanDist.keys(), ...on.fanDist.keys()])].sort((x, y) => x - y)
  .filter((k) => (off.fanDist.get(k) || 0) !== (on.fanDist.get(k) || 0));
if (diffFans.length) {
  console.log('\n  总番分布（仅列有差异的档）：');
  for (const k of diffFans) {
    console.log(`    ${String(k).padStart(3)} 番：${String(off.fanDist.get(k) || 0).padStart(4)} → ${String(on.fanDist.get(k) || 0).padStart(4)}`);
  }
}

console.log('\n  说明：');
console.log('    · 「关」= luanJiangEnabled / luanFengEnabled = false（旧：将/风一色仍须成顺子刻子）');
console.log('    · 「开」= 新口径：全手牌全是 2/5/8（将）或全是字牌（风）即可，不看顺子刻子，但**张数必须正好 14**');
console.log('    · 风一色 / 字一色在本引擎同源 → 仍受「全字牌必须自摸」闸门约束，见 src/engine/rules.js 注释');
console.log('');
