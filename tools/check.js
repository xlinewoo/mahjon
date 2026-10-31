#!/usr/bin/env node
/**
 * 手动验牌工具 —— 喂一手牌进去，看引擎怎么判（武汉红中赖子杠）
 *
 * 用法：
 *   node tools/check.js "1万2万3万 4万5万6万 7筒8筒9筒 5条5条5条 5筒5筒"
 *   node tools/check.js "w123 w456 t789 s555 t55"          # 简写 w万 t筒 s条
 *   node tools/check.js "123万 456万 789筒 555条 55筒"       # 花色写一次
 *   node tools/check.js "1万 2万 3万 4万 5万 6万 7筒 8筒 9筒 5条5条5条 5筒5筒"
 *
 * 字牌写法：东 南 西 北 中 发 白（也认 东风 / 红中 / 发财 / 白板）
 *
 * 选项：
 *   --wild  <牌>      指定本局癞子（默认自动从 --flip 推）
 *   --flip  <牌>      指定翻出的底牌；癞子 = 它的下一张，皮子 = 它 + 红中
 *   --skin  <牌,牌>   追加皮子（红中一律算皮子）
 *   --preset <名>     kaikou 开口番 / koukou 口口番（默认 koukou）
 *   --melds <n>       已有 n 副露（吃/碰/明杠，特殊杠不算），默认 0
 *   --closed          按「还没开口」判（默认按已开口）
 *   --zimo            按自摸判
 *   --gangshang       按杠上开花判
 *   --haidi           按海底捞判
 *
 * 输入 14 张（或 14 - 3n 张）→ 判胡并列出番型与拆解；
 * 输入 13 张（或 13 - 3n 张）→ 做听牌分析。
 */

import { evaluateWin, HU_LABELS } from '../src/engine/score.js';
import { createRuleSet } from '../src/engine/rules.js';
import { deriveWild } from '../src/engine/game.js';
import { analyzeHand, wildCostOf, sequenceCount } from '../src/engine/win.js';
import { exposedMeldCount } from '../src/engine/melds.js';
import {
  makeTile,
  toCounts,
  tileName,
  formatTiles,
  isHonorTile,
  TILE_KINDS,
  WIN_HAND_SIZE,
  EAST,
  SOUTH,
  WEST,
  NORTH,
  RED_DRAGON,
  GREEN_DRAGON,
  WHITE_DRAGON,
} from '../src/engine/tiles.js';

/* ------------------------------------------------------------------ */
/* 牌串解析                                                            */
/* ------------------------------------------------------------------ */

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const HONOR_SYM = {
  E: EAST, S: SOUTH, W: WEST, N: NORTH,
  Z: RED_DRAGON, G: GREEN_DRAGON, B: WHITE_DRAGON,
};
/** 简写花色字母 → 引擎花色名（小写，避免和 ESWNZGB 这些字牌字母撞车） */
const SUIT_CODE = { w: 'wan', t: 'tong', s: 'tiao' };

/** 把中文牌名归一化成「数字 + wts」或单个字母 */
function normalize(raw) {
  return raw
    .replace(/东风/g, 'E').replace(/南风/g, 'S').replace(/西风/g, 'W').replace(/北风/g, 'N')
    .replace(/红中/g, 'Z').replace(/发财/g, 'G').replace(/白板/g, 'B')
    .replace(/东/g, 'E').replace(/南/g, 'S').replace(/西/g, 'W').replace(/北/g, 'N')
    .replace(/中/g, 'Z').replace(/发/g, 'G').replace(/白/g, 'B')
    .replace(/[一二三四五六七八九]/g, (c) => String(CN_NUM[c]))
    .replace(/万/g, 'w').replace(/筒/g, 't').replace(/条/g, 's');
}

/** 解析单个 token，支持 123w / w123 / 5w / E / ZZ / z3 等混写 */
function parseToken(tok) {
  // 紧挨数字的大写 W/T/S 当成花色（否则会被误认成 西/南风）
  const t0 = tok
    .replace(/([WTS])(?=\d)/g, (c) => c.toLowerCase())
    .replace(/(\d)([WTS])(?![A-Z])/g, (_, d, c) => d + c.toLowerCase());

  // z / zz / z3 → 红中（老写法兼容）
  if (/^z+$/i.test(t0)) return new Array(t0.length).fill(RED_DRAGON);
  const zn = /^z(\d+)$/i.exec(t0);
  if (zn) return new Array(Number(zn[1])).fill(RED_DRAGON);

  const out = [];
  const re = /(\d+)([wts])|([wts])(\d+)|([ESWNZGB])/g;
  let last = 0;
  let m;
  while ((m = re.exec(t0)) !== null) {
    if (m.index !== last) throw new Error(`认不出的写法：「${tok}」`);
    last = m.index + m[0].length;
    if (m[1]) {
      for (const ch of m[1]) out.push(makeTile(SUIT_CODE[m[2]], Number(ch)));
    } else if (m[4]) {
      for (const ch of m[4]) out.push(makeTile(SUIT_CODE[m[3]], Number(ch)));
    } else {
      out.push(HONOR_SYM[m[5]]);
    }
  }
  if (last !== t0.length) throw new Error(`认不出的写法：「${tok}」`);
  return out;
}

/** 解析整串手牌 */
export function parseHand(raw) {
  const text = normalize(String(raw));
  const tiles = [];
  for (const tok of text.split(/[\s,，、+|]+/).filter(Boolean)) {
    tiles.push(...parseToken(tok));
  }
  return tiles;
}

/** 解析单张牌名（用于 --wild / --flip / --skin） */
function parseOne(raw) {
  const tiles = parseHand(raw);
  if (tiles.length !== 1) throw new Error(`这里应该是一张牌：「${raw}」`);
  return tiles[0];
}

/* ------------------------------------------------------------------ */
/* 展示                                                                */
/* ------------------------------------------------------------------ */

function wildName(wildTile) {
  return wildTile === null || wildTile === undefined ? '（无）' : tileName(wildTile);
}

function describeDecomposition(d, wildTile) {
  const wn = wildName(wildTile);
  if (d.kind === 'sevenPairs') return `七对${d.hasQuad ? '（豪华，含四张相同）' : ''}`;

  const eye =
    d.eye.tile === null
      ? `${wn} ${wn}`
      : d.eye.wildCount === 1
        ? `${tileName(d.eye.tile)} + ${wn}`
        : `${tileName(d.eye.tile)} ${tileName(d.eye.tile)}`;

  const melds = d.melds.map((m) => {
    if (m.type === 'triplet') {
      if (m.tile === null) return `三张${wn}凑的刻子`;
      return m.wildCount === 0
        ? `${tileName(m.tile)}刻子`
        : `${tileName(m.tile)}刻子（补${m.wildCount}张${wn}）`;
    }
    if (m.wildCount === 0) {
      return `${tileName(m.tile)}${tileName(m.tile + 1)}${tileName(m.tile + 2)}顺子`;
    }
    const real = [m.tile, m.tile + 1, m.tile + 2].slice(0, 3 - m.wildCount).map(tileName).join('');
    return `${real} + ${m.wildCount}张${wn} 凑的顺子`;
  });

  return `将：${eye}\n             面子：${melds.join('　')}`;
}

function decomposeKey(d) {
  if (d.kind === 'sevenPairs') return 'sevenPairs';
  const eye = d.eye.tile === null ? 'w2' : `${d.eye.tile}:${d.eye.wildCount}`;
  const melds = d.melds
    .map((m) => `${m.type}:${m.tile ?? 'w'}:${m.wildCount}`)
    .sort()
    .join(',');
  return `${eye}|${melds}`;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = {
    preset: 'koukou',
    melds: 0,
    opened: true,
    wild: null,
    flip: null,
    extraSkin: [],
    context: { selfDraw: false, gangShangKaiHua: false, haiDiLao: false, qiangGangHu: false },
    rest: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--wild') opts.wild = argv[++i];
    else if (a === '--flip') opts.flip = argv[++i];
    else if (a === '--skin') opts.extraSkin.push(...String(argv[++i]).split(/[,，、]/).filter(Boolean));
    else if (a === '--preset') opts.preset = argv[++i];
    else if (a === '--melds') opts.melds = Number(argv[++i]);
    else if (a === '--closed') opts.opened = false;
    else if (a === '--zimo') opts.context.selfDraw = true;
    else if (a === '--gangshang') { opts.context.gangShangKaiHua = true; opts.context.selfDraw = true; }
    else if (a === '--haidi') { opts.context.haiDiLao = true; opts.context.selfDraw = true; }
    else if (!a.startsWith('--')) opts.rest.push(a);
  }
  return opts;
}

const USAGE = `用法：
  node tools/check.js "1万2万3万 4万5万6万 7筒8筒9筒 5条5条5条 5筒5筒"
  node tools/check.js "w123 w456 t789 s555 t55"
  node tools/check.js "123万 456万 789筒 555条 55筒"

选项：
  --wild  <牌>     指定癞子          --flip <牌>   指定翻出的底牌（自动推癞子）
  --skin  <牌,牌>  追加皮子          --preset <名> kaikou | koukou
  --melds <n>      已有 n 副露        --closed      按未开口判
  --zimo / --gangshang / --haidi     按自摸 / 杠上开花 / 海底捞判

14 张 → 判胡；13 张 → 听牌分析。`;

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(USAGE);
    return;
  }

  let opts;
  try {
    opts = parseArgs(args);
  } catch (e) {
    console.error(`参数错误：${e.message}`);
    process.exit(1);
  }

  if (!['kaikou', 'koukou'].includes(opts.preset)) {
    console.error(`未知预设：${opts.preset}（可选 kaikou / koukou）`);
    process.exit(1);
  }
  const ruleset = createRuleSet(opts.preset);

  // 定癞子与皮子
  let wildTile = null;
  let flipTile = null;
  try {
    if (opts.wild) wildTile = parseOne(opts.wild);
    if (opts.flip) {
      flipTile = parseOne(opts.flip);
      if (wildTile === null) wildTile = deriveWild(flipTile, ruleset); // 红中固定是皮，翻红中顺延发财
    }
  } catch (e) {
    console.error(`牌名解析失败：${e.message}`);
    process.exit(1);
  }

  const skinTiles = [];
  if (flipTile !== null) skinTiles.push(flipTile);
  for (const raw of opts.extraSkin) {
    try {
      const s = parseOne(raw);
      if (!skinTiles.includes(s)) skinTiles.push(s);
    } catch (e) {
      console.error(`皮子牌名解析失败：${e.message}`);
      process.exit(1);
    }
  }
  // 红中固定是皮：无论癞子是谁，一律进皮子集合
  if (!skinTiles.includes(RED_DRAGON)) skinTiles.push(RED_DRAGON);

  const raw = opts.rest.join(' ');
  let tiles;
  try {
    tiles = parseHand(raw);
  } catch (e) {
    console.error(`解析失败：${e.message}`);
    process.exit(1);
  }

  console.log(`\n手牌（${tiles.length} 张）：${formatTiles(tiles)}`);
  console.log(`规则：${ruleset.label}（${ruleset.preset}）｜开口=${opts.opened ? '已开口' : '未开口'}｜副露 ${opts.melds} 组`);
  console.log(`癞子：${wildName(wildTile)}${flipTile !== null ? `（翻出的是 ${tileName(flipTile)}）` : ''}`);
  console.log(`皮子：${skinTiles.length ? skinTiles.map(tileName).join('、') : '（无）'}`);

  const needWin = WIN_HAND_SIZE - 3 * opts.melds;
  const needWait = needWin - 1;

  const base = {
    melds: [],
    opened: opts.opened,
    context: opts.context,
    ruleset,
    wildTile,
    skinTiles,
  };

  if (tiles.length === needWin) {
    /* ---------------- 判胡 ---------------- */
    const r = evaluateWin({ ...base, counts: toCounts(tiles) });
    if (!r.legal) {
      console.log(`\n❌ 不能胡：${r.reason}`);
      return;
    }

    console.log('\n✅ 可以胡牌');
    console.log(`   ${r.size === 'big' ? '大胡' : '小胡（屁胡）'}` +
      `${r.types.length ? '：' + r.types.map((k) => HU_LABELS[k] ?? k).join(' + ') : ''}`);
    console.log(`   番底 ${r.baseFan}｜${r.hardWin ? '硬胡' : '软胡'}｜拆解用掉 ${r.wildUsed} 张${wildName(wildTile)}`);

    // 把所有拆解列出来（按癞子消耗从少到多，再让癞子集中在将上）
    const analysis = analyzeHand(toCounts(tiles), {
      exposedMelds: opts.melds,
      wildTile,
      allowSevenPairs: ruleset.allowSevenPairs,
    });
    const sorted = [...analysis.decompositions].sort((a, b) => {
      const c = wildCostOf(a) - wildCostOf(b);
      if (c !== 0) return c;
      return (b.eye?.wildCount ?? 0) - (a.eye?.wildCount ?? 0);
    });

    const seen = new Set();
    const unique = [];
    for (const d of sorted) {
      const k = decomposeKey(d);
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(d);
    }

    console.log('\n【拆解】');
    unique.slice(0, 3).forEach((d, i) => {
      const best = decomposeKey(d) === decomposeKey(r.decomposition);
      const tag = best ? '（算番采用）' : '（另一种等价拆法）';
      const seqs = sequenceCount(d);
      console.log(`  ${i + 1}. ${tag} 癞子消耗 ${wildCostOf(d)}｜顺子 ${seqs}`);
      console.log(`             ${describeDecomposition(d, wildTile)}`);
    });
    if (unique.length > 3) {
      console.log(`\n（引擎另外还找到 ${unique.length - 3} 种等价拆解，不影响番型，已省略）`);
    }
  } else if (tiles.length === needWait) {
    /* ---------------- 听牌分析 ---------------- */
    const counts = toCounts(tiles);
    const waits = [];
    for (let x = 0; x < TILE_KINDS; x++) {
      if (counts[x] >= 4) continue;
      const c = counts.slice();
      c[x]++;
      const r = evaluateWin({ ...base, counts: c });
      if (r.legal) waits.push({ tile: x, res: r });
    }

    if (waits.length === 0) {
      console.log('\n❌ 没听牌 —— 这手牌暂时胡不了任何一张。');
      return;
    }

    console.log(`\n🎯 听牌中！共 ${waits.length} 种：`);
    for (const { tile, res } of waits) {
      const mark = tile === wildTile ? '  ← 癞子本身' : skinTiles.includes(tile) ? '  ← 皮子（留手不能胡，不会真的听）' : '';
      const kind = res.size === 'big' ? `大胡·${res.types.map((k) => HU_LABELS[k] ?? k).join('+')}` : '小胡';
      console.log(`   ${tileName(tile).padEnd(4, '　')} → ${kind}（番底 ${res.baseFan}，${res.hardWin ? '硬胡' : '软胡'}）${mark}`);
    }
    console.log(`\n（这副是 ${opts.melds} 副露状态，还差 1 张成胡；皮子与红中留手会被闸门拦掉）`);
  } else {
    console.log(
      `\n❌ ${tiles.length} 张牌判不了：${opts.melds} 副露时应该喂 ${needWin} 张（判胡）或 ${needWait} 张（听牌）。\n` +
        `   想按别的手牌张数判，加 --melds <n> 指定副露数。`,
    );
  }
}

main();
