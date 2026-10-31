#!/usr/bin/env node
/**
 * 四人机器人模拟对局 —— 武汉红中赖子杠（136 张）
 *
 * 用途：验证规则引擎在真实牌局里能不能跑通、能不能胡、番算得对不对。
 *
 * 用法：
 *   node tools/simulate.js                          # 跑 1 局，打印完整过程（口口番）
 *   node tools/simulate.js --rounds 200             # 跑 200 局，只出统计
 *   node tools/simulate.js --preset kaikou          # 换开口番
 *   node tools/simulate.js --compare --rounds 200   # 开口番 vs 口口番 并排对照
 *   node tools/simulate.js --verbose --rounds 3     # 每局都打印过程
 *   node tools/simulate.js --seed 12345             # 指定起始种子
 *
 * 对照组开关（用来验证每条规则开关真的生效）：
 *   --no-must-open     关掉「必须开口才能胡」
 *   --no-chi           关掉吃
 *   --no-wild          关掉癞子（wildMode=none）
 *   --no-skin-block    关掉「皮子留手不能胡」
 *   --no-red-block     关掉「红中留手不能胡」
 *   --enforce-min-fan  打开「N 番起胡」
 */

import { createGame, act } from '../src/engine/game.js';
import { decide, DEFAULT_STYLE } from '../src/bot/simpleBot.js';
import { createRuleSet, RULE_PRESETS } from '../src/engine/rules.js';
import { formatTiles, tileName } from '../src/engine/tiles.js';
import { HU_LABELS } from '../src/engine/score.js';

const MAX_STEPS = 6000;

/* ------------------------------------------------------------------ */
/* 参数解析                                                            */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = {
    rounds: 1,
    seed: 20260928,
    verbose: false,
    quiet: false,
    compare: false,
    preset: 'koukou',
    overrides: {},
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rounds') opts.rounds = Number(argv[++i]);
    else if (a === '--seed') opts.seed = Number(argv[++i]);
    else if (a === '--preset') opts.preset = argv[++i];
    else if (a === '--verbose') { opts.verbose = true; opts.explicitVerbose = true; }
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--compare') opts.compare = true;
    else if (a === '--no-must-open') opts.overrides.mustOpen = false;
    else if (a === '--no-chi') opts.overrides.chiAllowed = false;
    else if (a === '--no-wild') opts.overrides.wildMode = 'none';
    else if (a === '--no-skin-block') opts.overrides.skinInHandBlocksWin = false;
    else if (a === '--no-red-block') opts.overrides.redDragonInHandBlocksWin = false;
    else if (a === '--enforce-min-fan') opts.overrides.enforceMinFan = true;
    else if (a === '--seven-pairs') opts.overrides.allowSevenPairs = true;
    else if (a.startsWith('--')) {
      console.error(`未知参数：${a}`);
      process.exit(1);
    }
  }

  if (!RULE_PRESETS[opts.preset]) {
    console.error(`未知预设：${opts.preset}（可选 ${Object.keys(RULE_PRESETS).join(' / ')}）`);
    process.exit(1);
  }
  // 多局默认只看统计；只有显式 --verbose 才逐局打印
  if (opts.rounds > 1 && !opts.explicitVerbose) opts.verbose = false;
  // 单局默认打全过程；--quiet 可压掉
  opts.showRound = opts.verbose || (opts.rounds === 1 && !opts.quiet);
  return opts;
}

function presetLabel(preset, overrides) {
  const base = RULE_PRESETS[preset].label;
  const bits = [];
  if (overrides.mustOpen === false) bits.push('不须开口');
  if (overrides.chiAllowed === false) bits.push('不可吃');
  if (overrides.wildMode === 'none') bits.push('无癞子');
  if (overrides.skinInHandBlocksWin === false) bits.push('皮子可留手');
  if (overrides.redDragonInHandBlocksWin === false) bits.push('红中可留手');
  if (overrides.enforceMinFan) bits.push('N番起胡');
  return bits.length ? `${base}（${bits.join('、')}）` : base;
}

/* ------------------------------------------------------------------ */
/* 单局                                                                */
/* ------------------------------------------------------------------ */

function playOne(seed, ruleset) {
  let state = createGame({ seed, ruleset });
  const opening = state.players.map((p) => [...p.hand]);

  let steps = 0;
  while (state.phase !== 'settled' && steps < MAX_STEPS) {
    steps++;
    const action = decide(state, state.turn);
    if (!action) throw new Error(`座位 ${state.turn} 无决策（phase=${state.phase}, seed=${seed}）`);
    state = act(state, action);
  }

  if (state.phase !== 'settled') {
    throw new Error(`seed=${seed} 超过 ${MAX_STEPS} 步仍未结束，可能存在死循环`);
  }
  return { state, opening, steps };
}

/* ------------------------------------------------------------------ */
/* 输出：单局                                                          */
/* ------------------------------------------------------------------ */

function printRound(index, { state, opening, steps }, ruleset) {
  const names = state.players.map((p) => p.name);
  console.log(`\n══════ 第 ${index} 局  seed=${state.seed}  庄家=${names[state.dealer]} ══════`);
  console.log(
    `规则：${presetLabel(ruleset.preset, ruleset)}｜136 张｜必须开口=${ruleset.mustOpen ? '是' : '否'}｜计分=${ruleset.scoring}${ruleset.scoring === 'table' ? `（封顶${ruleset.capScore}/金顶${ruleset.goldScore}）` : `（封顶${ruleset.cap}）`}`,
  );
  console.log(
    `本局：翻出 ${state.flipTile === null ? '（无）' : tileName(state.flipTile)}｜` +
      `癞子 ${state.wildTile === null ? '（无）' : tileName(state.wildTile)}｜` +
      `皮子 ${state.skinTiles.length ? state.skinTiles.map(tileName).join('、') : '（无）'}`,
  );

  console.log('\n【起手牌】');
  for (let i = 0; i < state.players.length; i++) {
    const tag = i === state.dealer ? '(庄)' : '    ';
    console.log(`  ${names[i]}${tag} ${formatTiles(opening[i])}`);
  }

  console.log('\n【对局过程】');
  for (const e of state.events) {
    console.log(`  ${String(e.seq).padStart(3, ' ')}. ${e.message}`);
  }

  const r = state.result;
  console.log('\n【结算】');
  if (r.type === 'draw') {
    console.log(`  荒庄（${r.reason}）｜共 ${steps} 步｜牌墙剩 ${state.wall.length} 张`);
  } else {
    const how = r.selfDraw ? '自摸' : `点炮（放炮：${r.fromName}）`;
    console.log(`  ${r.winnerName} 胡牌 · ${how} · ${steps} 步`);
    console.log(`  牌型：${r.text}`);
    if (r.baozhuang) console.log(`  承包：${r.baozhuang.name} 独付 ${r.baozhuang.amount}`);
  }

  console.log('\n【终局手牌】');
  for (const p of state.players) {
    const m = p.melds.length
      ? ` 副露[${p.melds.map((x) => `${x.type}:${x.tiles.map(tileName).join('')}`).join(' ')}]`
      : '';
    console.log(
      `  ${p.name}: ${formatTiles(p.hand)}${m}  开口=${p.opened ? '是' : '否'}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* 统计                                                                */
/* ------------------------------------------------------------------ */

function collect(results, ruleset) {
  const total = results.length;
  const s = {
    ruleset,
    total,
    wins: 0,
    draws: 0,
    selfDraw: 0,
    bigHu: 0,
    closedWins: 0,
    hardWins: 0,
    gangShang: 0,
    bao: 0,
    goldTop: 0,
    brightTop: 0,
    unopenedEnds: 0,
    winnerFanSum: 0,
    winnerFanMax: 0,
    paySum: 0,
    payMax: 0,
    totalWinSum: 0,
    stepsSum: 0,
    stepsMax: 0,
    types: new Map(),
    waits: [],
  };

  for (const r of results) {
    s.stepsSum += r.steps;
    s.stepsMax = Math.max(s.stepsMax, r.steps);
    const st = r.state;
    for (const p of st.players) if (!p.opened) s.unopenedEnds++;

    const res = st.result;
    if (res.type === 'draw') {
      s.draws++;
      continue;
    }

    s.wins++;
    if (res.selfDraw) s.selfDraw++;
    if (res.size === 'big') s.bigHu++;
    if (res.hardWin) s.hardWins++;
    if (res.types.includes('gangShangKaiHua')) s.gangShang++;
    if (res.baozhuang) s.bao++;
    if (res.topType === 'goldTop') s.goldTop++;
    if (res.topType === 'brightTop') s.brightTop++;
    if (!st.players[res.winner].opened) s.closedWins++;

    s.winnerFanSum += res.winnerFan;
    s.winnerFanMax = Math.max(s.winnerFanMax, res.winnerFan);
    s.totalWinSum += res.totalWin;
    for (const p of res.payments) {
      s.paySum += p.pay;
      s.payMax = Math.max(s.payMax, p.pay);
    }
    for (const k of res.types) s.types.set(k, (s.types.get(k) ?? 0) + 1);
  }

  return s;
}

const pct = (n, d) => (d === 0 ? '  —  ' : `${((n / d) * 100).toFixed(1)}%`);
const f2 = (n) => n.toFixed(2);

function printSummary(s) {
  const r = s.ruleset;
  console.log('\n══════════════ 汇总 ══════════════');
  console.log(`规则口径        ${presetLabel(r.preset, r)}`);
  console.log(`用牌 / 癞子     136 张｜wildMode=${r.wildMode}｜必须开口=${r.mustOpen ? '是' : '否'}｜可吃=${r.chiAllowed ? '是' : '否'}`);
  console.log(`总局数          ${s.total}`);
  console.log(`胡牌局数        ${s.wins}  (${pct(s.wins, s.total)})`);
  console.log(`  自摸          ${s.selfDraw}  (${pct(s.selfDraw, s.wins)} 的胡牌局)`);
  console.log(`  点炮          ${s.wins - s.selfDraw}`);
  console.log(`  大胡          ${s.bigHu}  (${pct(s.bigHu, s.wins)})`);
  console.log(`  硬胡          ${s.hardWins}  (${pct(s.hardWins, s.wins)})`);
  console.log(`  杠上开花      ${s.gangShang}`);
  console.log(`  承包（抢杠）  ${s.bao}`);
  console.log(`  门清胡        ${s.closedWins}  (${pct(s.closedWins, s.wins)})  ← 必须开口时必然为 0`);
  console.log(`荒庄局数        ${s.draws}  (${pct(s.draws, s.total)})`);
  console.log(`赢家平均番数    ${s.wins ? f2(s.winnerFanSum / s.wins) : '—'}　最大 ${s.winnerFanMax}`);
  console.log(`单笔平均输分    ${s.wins ? f2(s.paySum / (s.wins * 3)) : '—'}　最大 ${s.payMax}`);
  console.log(`单局平均总收入  ${s.wins ? f2(s.totalWinSum / s.wins) : '—'}`);
  console.log(`金顶 / 光明顶   ${s.goldTop} / ${s.brightTop}`);
  console.log(`终局未开口人次  ${s.unopenedEnds}`);
  console.log(`平均步数        ${f2(s.stepsSum / s.total)}　最大 ${s.stepsMax}`);

  const sorted = [...s.types.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length) {
    console.log('\n大胡番型命中次数：');
    for (const [k, v] of sorted) {
      console.log(`  ${(HU_LABELS[k] ?? k).padEnd(12, ' ')} ${v}  (${pct(v, s.wins)})`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 对照实验                                                            */
/* ------------------------------------------------------------------ */

function printCompare(arms) {
  const rows = [
    ['胡牌率', (s) => pct(s.wins, s.total)],
    ['荒庄率', (s) => pct(s.draws, s.total)],
    ['自摸占胡牌', (s) => pct(s.selfDraw, s.wins)],
    ['大胡占胡牌', (s) => pct(s.bigHu, s.wins)],
    ['硬胡占胡牌', (s) => pct(s.hardWins, s.wins)],
    ['门清胡占胡牌', (s) => pct(s.closedWins, s.wins)],
    ['金顶+光明顶', (s) => String(s.goldTop + s.brightTop)],
    ['承包次数', (s) => String(s.bao)],
    ['赢家平均番数', (s) => (s.wins ? f2(s.winnerFanSum / s.wins) : '—')],
    ['单笔平均输分', (s) => (s.wins ? f2(s.paySum / (s.wins * 3)) : '—')],
    ['单笔最大输分', (s) => String(s.payMax)],
    ['单局平均总收入', (s) => (s.wins ? f2(s.totalWinSum / s.wins) : '—')],
    ['平均步数', (s) => f2(s.stepsSum / s.total)],
    ['终局未开口人次', (s) => String(s.unopenedEnds)],
  ];

  const W = 15;
  const head = ['指标', ...arms.map((a) => a.label)];
  const widths = head.map((h, i) =>
    Math.max(strWidth(h), ...rows.map((rw) => strWidth(i === 0 ? rw[0] : rw[1](arms[i - 1].stat)))),
  );

  console.log('\n══════════════ 对照实验 ══════════════');
  console.log(head.map((h, i) => pad(h, widths[i])).join(' │ '));
  console.log(widths.map((w) => '─'.repeat(w)).join('─┼─'));
  for (const [name, fn] of rows) {
    const cells = [name, ...arms.map((a) => fn(a.stat))];
    console.log(cells.map((c, i) => pad(c, widths[i])).join(' │ '));
  }
}

/** 简易宽度计算：中文算 2 个字符宽 */
function strWidth(str) {
  let n = 0;
  for (const ch of String(str)) n += /[\u2E80-\uFFFD]/.test(ch) ? 2 : 1;
  return n;
}
function pad(str, width) {
  return String(str) + ' '.repeat(Math.max(0, width - strWidth(str)));
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function runArm(label, ruleset, opts) {
  const results = [];
  for (let i = 0; i < opts.rounds; i++) {
    const r = playOne(opts.seed + i, ruleset);
    results.push(r);
    if (opts.verbose) printRound(i + 1, r, ruleset);
  }
  return { label, stat: collect(results, ruleset), results };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const mk = (preset, extra = {}) => createRuleSet(preset, { ...opts.overrides, ...extra });

  if (opts.compare) {
    const arms = [
      runArm(presetLabel('kaikou', opts.overrides), mk('kaikou'), opts),
      runArm(presetLabel('koukou', opts.overrides), mk('koukou'), opts),
    ];
    printSummary(arms[0].stat);
    printSummary(arms[1].stat);
    printCompare(arms);
    console.log(`\n机器人策略参数：${JSON.stringify(DEFAULT_STYLE)}`);
    return;
  }

  const ruleset = mk(opts.preset);
  if (opts.rounds === 1) {
    const r = playOne(opts.seed, ruleset);
    if (opts.showRound) printRound(1, r, ruleset);
    printSummary(collect([r], ruleset));
  } else {
    const arm = runArm(presetLabel(opts.preset, opts.overrides), ruleset, opts);
    printSummary(arm.stat);
  }
  console.log(`\n机器人策略参数：${JSON.stringify(DEFAULT_STYLE)}`);
}

main();
