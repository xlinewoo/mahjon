/**
 * 听牌分析 —— 老吴 2026-09-30 需求：
 *
 * > 「听牌以后有一个提示按钮，点击以后显示可以胡的牌及所剩张数
 * >   （按牌河中和各家吃碰以后，所有明牌估算剩余的张数）」
 *
 * 设计要点：
 *   · **只认 13 张**（手牌 + 副露 = 13，即「差一张」）。吃/碰后是 14 张、必须打出去，
 *     那种局面不算听牌 —— 与 `state.mustDiscard` 口径一致。
 *   · 判定**复用引擎的 `canWinWith`**（红中/皮子/开口/起胡门槛全部照走），
 *     否则提示出来的牌和真正能胡的牌会对不上。
 *   · 「所剩张数」= `4 − 明牌张数`。明牌 = 全局弃牌流水（牌河）+ 四家副露（吃碰杠）
 *     + 自己手牌 + 翻出的那张底牌。**别家手牌是暗牌，不算** → 所以这是**上界估计**。
 */

import { TILE_KINDS, tileName, toCounts } from './tiles.js';
import { canWinWith, handNeeded } from './game.js';

/**
 * 某张牌在「明牌」里已经露了几张（0..4）。
 * 暗牌（别家手牌、牌墙）不计 —— 所以调用方拿到的 `remain` 是**最多还有几张**。
 */
export function visibleCount(state, seat, tile) {
  let n = 0;
  for (const d of state.discardLog || []) if (d.tile === tile) n++;
  for (const p of state.players) {
    for (const m of p.melds || []) {
      for (const t of m.tiles || []) if (t === tile) n++;
    }
  }
  for (const t of state.players[seat].hand) if (t === tile) n++;
  if (state.flipTile === tile) n++;
  return n;
}

/**
 * 分析某家的听牌情况。
 *
 * ❗ 两种局面都要覆盖（2026-09-30 实测才发现的坑）：
 *   · **wait**（手牌 = `need − 1`，差一张）—— 已经听了，直接列可胡的牌。
 *   · **ready**（手牌 = `need`，满手）—— 轮到自己出牌时**永远是满手**（刚摸到 / 刚吃碰完），
 *     只支持 wait 的话按钮**永远不出现**。所以这里逐张试打：哪张打出去能听、听什么。
 *
 * @returns {{
 *   tenpai: boolean, mode: 'wait'|'ready'|'none', total: number, need: number,
 *   waits: Array<{tile, name, remain, selfDraw, discard}>,
 *   byDiscard: Array<{tile: number, name: string, waits: Array}>
 * }}
 *   tenpai —— 有听牌信息可展示（wait：真的听了；ready：存在「打某张就能听」的打法）
 *   waits  —— ready 模式下是所有打法的**并集**
 */
export function analyzeTenpai(state, seat) {
  const p = state.players[seat];

  // ⚠️ 「差几张」必须用引擎自己的 `handNeeded` 判，不能拿「手牌 + 副露张数」去凑 ——
  //    一副杠存了 4 张牌却只占 3 个位子，红中/皮子/癞子杠只占 1 个位子，那样数会多算。
  const need = handNeeded(state, seat); // 成牌时手牌应有几张
  const total = p.hand.length;

  /** 给定一手「差一张」的牌，列出所有可胡的牌 */
  const waitsFor = (hand) => {
    const prev = (seat + 3) % 4; // 上家：点炮来源（闸门只看 selfDraw 与牌型，来源不影响判定）
    const out = [];
    for (let tile = 0; tile < TILE_KINDS; tile++) {
      const visible = visibleCount(state, seat, tile);
      if (visible >= 4) continue; // 4 张全露了，不可能再出现

      const counts = toCounts([...hand, tile]);
      /* ⚠️ `winTile` 必须显式传成**正在试的这张牌** —— 见字胡判定（老吴 2026-10-01）
         要按「进张靠不靠癞子顶」来判。不传的话引擎会用 `state.lastDraw`，
         试的是东风、判的却是上一张摸的牌 → 提示会给出实际点炮被拦的牌。 */
      const selfRes = canWinWith(state, seat, counts, { selfDraw: true, winTile: tile });
      const dianRes = canWinWith(state, seat, counts, { selfDraw: false, from: prev, winTile: tile });
      const selfDraw = !!selfRes.legal;
      const discard = !!dianRes.legal;
      if (!selfDraw && !discard) continue;

      out.push({ tile, name: tileName(tile), remain: 4 - visible, selfDraw, discard });
    }
    return out;
  };

  /* ---- ① 差一张：直接列听牌 ---- */
  if (total === need - 1) {
    return { tenpai: true, mode: 'wait', total, need, waits: waitsFor(p.hand), byDiscard: [] };
  }

  /* ---- ② 满手（轮到自己出牌时的常态）：逐张试打，看打完哪张能听 ---- */
  if (total === need) {
    const byDiscard = [];
    const seen = new Set();
    for (const tile of p.hand) {
      if (seen.has(tile)) continue;
      seen.add(tile);
      const rest = p.hand.slice();
      rest.splice(rest.indexOf(tile), 1);
      const w = waitsFor(rest);
      if (w.length) byDiscard.push({ tile, name: tileName(tile), waits: w });
    }
    if (byDiscard.length === 0) {
      return { tenpai: false, mode: 'ready', total, need, waits: [], byDiscard: [] };
    }
    // 汇总成并集（剩余张数与「打哪张」无关，所以同一张牌 remain 都一样；这里只合并可胡方式）
    const map = new Map();
    for (const d of byDiscard) {
      for (const w of d.waits) {
        const cur = map.get(w.tile);
        if (!cur) map.set(w.tile, { ...w });
        else {
          cur.selfDraw = cur.selfDraw || w.selfDraw;
          cur.discard = cur.discard || w.discard;
        }
      }
    }
    return {
      tenpai: true,
      mode: 'ready',
      total,
      need,
      waits: [...map.values()].sort((a, b) => a.tile - b.tile),
      byDiscard,
    };
  }

  /* ---- ③ 其它（不该出现）：既不是差一张也不是满手 ---- */
  return { tenpai: false, mode: 'none', total, need, waits: [], byDiscard: [] };
}
