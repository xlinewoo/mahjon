/**
 * 渲染层的**弹窗 / 覆盖面板** —— 从 `render.js` 拆出（2026-10-17）
 *
 * 收纳三类互不相干、各自完整的覆盖层渲染：
 *   · 统计弹窗            `showStats` / 本场战绩（维度1）/ 分析报表（维度3）
 *   · 单局结算明细表      `buildDetailTable`（维度2，被 render.js 的结算弹窗引用）
 *   · 胡牌提示面板        `showTenpai`（`currentTenpai` 同时给顶栏按钮判可用）
 *
 * 它们只读 `render-state.js` 里的共享状态（game / view / mySeat / matchStats / statsTab），
 * 不反向依赖 render.js —— 于是 render.js 的结算弹窗 / 听牌按钮可以 import 本模块的导出。
 */
import { state } from './render-state.js';
import { $, esc } from './ui-utils.js';
import { makeTileEl, thEl, tdEl } from './render-widgets.js';

/* ------------------------------------------------------------------ */
/* 统计弹窗：本场战绩 + 分析报表（维度1 / 维度3）                         */
/* ------------------------------------------------------------------ */

/* thEl / tdEl 已移到 render-widgets.js（无状态小组件） */

/** 打开统计弹窗（顶栏「战绩」按钮） */
export function showStats() {
  const box = $('stats');
  if (!box) return;
  renderStatsContent();
  box.hidden = false;
}
function hideStats() { const b = $('stats'); if (b) b.hidden = true; }

/** 切到指定分页（'score' | 'report'）并就地重绘内容（不关弹窗） */
function setStatsTab(tab) {
  state.statsTab = tab;
  renderStatsContent();
}

function renderStatsContent() {
  const card = $('stats-card');
  if (!card) return;
  card.innerHTML = '';

  const h = document.createElement('h3');
  h.textContent = '本场统计';
  card.appendChild(h);

  // 分页切换
  const tabs = document.createElement('div');
  tabs.className = 'stats-tabs';
  const mkTab = (key, label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'stats-tab' + (state.statsTab === key ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', () => setStatsTab(key));
    return b;
  };
  tabs.appendChild(mkTab('score', '本场战绩'));
  tabs.appendChild(mkTab('report', '分析报表'));
  card.appendChild(tabs);

  if (state.statsTab === 'score') renderScoreboardInto(card);
  else renderReportInto(card);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'stats-close';
  close.textContent = '关闭';
  close.addEventListener('click', hideStats);
  card.appendChild(close);
}

/* —— 维度1：牌桌战绩面板（整场累积） —— */
function renderScoreboardInto(card) {
  if (!state.matchStats) return;
  const { hands, players } = state.matchStats.getMatchStats();
  const sub = document.createElement('div');
  sub.className = 'stats-sub';
  sub.textContent = `共 ${hands} 把 · 按净分排序`;
  card.appendChild(sub);

  const tbl = document.createElement('table');
  tbl.className = 'score-table';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  ['#', '玩家', '净分', '胡', '杠', '最高番', '胜率', '金顶'].forEach((t) => hr.appendChild(thEl(t)));
  thead.appendChild(hr);
  tbl.appendChild(thead);
  const tbody = document.createElement('tbody');
  players.forEach((p, i) => {
    const r = document.createElement('tr');
    if (i === 0 && p.net > 0) r.className = 'leader';
    r.appendChild(tdEl(String(i + 1)));
    r.appendChild(tdEl(p.name));
    const netTd = tdEl((p.net > 0 ? '+' : '') + p.net);
    netTd.className = p.net > 0 ? 'pos' : p.net < 0 ? 'neg' : '';
    r.appendChild(netTd);
    r.appendChild(tdEl(String(p.wins)));
    r.appendChild(tdEl(String(p.gangs)));
    r.appendChild(tdEl(String(p.maxFan)));
    r.appendChild(tdEl(p.winRate + '%'));
    r.appendChild(tdEl(String(p.huGold)));
    tbody.appendChild(r);
  });
  tbl.appendChild(tbody);
  card.appendChild(tbl);

  const tip = document.createElement('div');
  tip.className = 'stats-tip';
  tip.textContent = '净分＝赢家收分 − 输家付分累计；金顶＝金顶胡次数。';
  card.appendChild(tip);

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'stats-reset';
  reset.textContent = '清零本场';
  reset.addEventListener('click', () => {
    if (!state.matchStats) return;
    state.matchStats.reset();
    renderStatsContent();
    const sb = $('statsbtn');
    if (sb) sb.disabled = true;
  });
  card.appendChild(reset);
}

/* —— 维度3：分析报表（纯 SVG 图表，零依赖） —— */
function renderReportInto(card) {
  if (!state.matchStats) return;
  const { players } = state.matchStats.getMatchStats();
  const bySeat = players.slice().sort((a, b) => a.seat - b.seat);

  const addChart = (title, svg, legendHtml) => {
    const wrap = document.createElement('div');
    wrap.className = 'rpt-chart';
    const t = document.createElement('div');
    t.className = 'rpt-title';
    t.textContent = title;
    wrap.appendChild(t);
    const box = document.createElement('div');
    box.className = 'rpt-svg-box';
    box.innerHTML = svg;
    wrap.appendChild(box);
    if (legendHtml) {
      const lg = document.createElement('div');
      lg.className = 'rpt-legend';
      lg.innerHTML = legendHtml;
      wrap.appendChild(lg);
    }
    card.appendChild(wrap);
  };

  addChart('净分排行', netBarSvg(players));
  addChart(
    '胡牌类型（屁胡 / 大胡 / 金顶）',
    huStackedSvg(players),
    '<span class="lg lg-small">屁胡</span><span class="lg lg-big">大胡</span><span class="lg lg-gold">金顶</span>',
  );
  addChart('杠数对比', hbarsSvg(bySeat.map((p) => ({ label: p.name, value: p.gangs })), '#5b7c99'));
  addChart('最高番', hbarsSvg(bySeat.map((p) => ({ label: p.name, value: p.maxFan })), '#e8a317'));
}

/** 净分双向条形图：正（赢）红、负（输）绿，沿用 .st-money 红涨绿跌口径 */
function netBarSvg(players) {
  const W = 320, rowH = 30, padTop = 8, labelW = 64, axisX = W / 2;
  const maxAbs = Math.max(1, ...players.map((p) => Math.abs(p.net)));
  const scale = (W / 2 - labelW - 12) / maxAbs;
  const H = padTop * 2 + players.length * rowH;
  let s = `<svg viewBox="0 0 ${W} ${H}" class="rpt-svg" preserveAspectRatio="xMidYMid meet" role="img">`;
  s += `<line x1="${axisX}" y1="${padTop - 4}" x2="${axisX}" y2="${H - padTop + 4}" stroke="#ccc" stroke-width="1"/>`;
  players.forEach((p, i) => {
    const y = padTop + i * rowH + 4;
    s += `<text x="4" y="${y + 14}" font-size="12" fill="#333">${esc(p.name)}</text>`;
    const w = Math.abs(p.net) * scale;
    const x = p.net >= 0 ? axisX : axisX - w;
    const color = p.net >= 0 ? '#c0392b' : '#1f7a4d';
    if (w > 0.5) s += `<rect x="${x}" y="${y}" width="${w}" height="18" rx="3" fill="${color}"/>`;
    const label = (p.net > 0 ? '+' : '') + p.net;
    s += `<text x="${p.net >= 0 ? x + w + 4 : x - 4}" y="${y + 14}" font-size="11" fill="#333" text-anchor="${p.net >= 0 ? 'start' : 'end'}">${label}</text>`;
  });
  s += `</svg>`;
  return s;
}

/** 通用非负横向条形图 */
function hbarsSvg(items, color) {
  const W = 320, rowH = 26, padTop = 6, labelW = 64;
  const maxV = Math.max(1, ...items.map((i) => i.value));
  const barMax = W - labelW - 38;
  const scale = barMax / maxV;
  const H = padTop * 2 + items.length * rowH;
  let s = `<svg viewBox="0 0 ${W} ${H}" class="rpt-svg" preserveAspectRatio="xMidYMid meet" role="img">`;
  items.forEach((it, i) => {
    const y = padTop + i * rowH + 3;
    s += `<text x="4" y="${y + 12}" font-size="11" fill="#333">${esc(it.label)}</text>`;
    s += `<rect x="${labelW}" y="${y}" width="${Math.max(0, it.value * scale)}" height="15" rx="3" fill="${color}"/>`;
    s += `<text x="${labelW + it.value * scale + 4}" y="${y + 12}" font-size="10" fill="#666">${it.value}</text>`;
  });
  s += `</svg>`;
  return s;
}

/** 胡牌类型堆叠条形图 */
function huStackedSvg(players) {
  const W = 320, rowH = 28, padTop = 6, labelW = 64;
  const maxTotal = Math.max(1, ...players.map((p) => p.huSmall + p.huBig + p.huGold));
  const barMax = W - labelW - 10;
  const scale = barMax / maxTotal;
  const H = padTop * 2 + players.length * rowH;
  const colors = { small: '#9bbf9b', big: '#2c7be5', gold: '#e8a317' };
  let s = `<svg viewBox="0 0 ${W} ${H}" class="rpt-svg" preserveAspectRatio="xMidYMid meet" role="img">`;
  players.forEach((p, i) => {
    const y = padTop + i * rowH + 4;
    s += `<text x="4" y="${y + 13}" font-size="11" fill="#333">${esc(p.name)}</text>`;
    let x = labelW;
    const segs = [['small', p.huSmall], ['big', p.huBig], ['gold', p.huGold]];
    for (const [k, v] of segs) {
      if (!v) continue;
      const w = v * scale;
      s += `<rect x="${x}" y="${y}" width="${w}" height="16" fill="${colors[k]}"/>`;
      if (w > 10) s += `<text x="${x + w / 2}" y="${y + 12}" font-size="9" fill="#fff" text-anchor="middle">${v}</text>`;
      x += w;
    }
  });
  s += `</svg>`;
  return s;
}

/* —— 维度2：单局结算明细（结算弹窗内，本场每把的每家净分） —— */
export function buildDetailTable(detail) {
  const stats = state.matchStats.getMatchStats();
  const seats = stats.players.slice().sort((a, b) => a.seat - b.seat);
  const nameOf = (seat) => {
    const s = seats.find((x) => x.seat === seat);
    return s ? s.name : `家${seat + 1}`;
  };
  const tbl = document.createElement('table');
  tbl.className = 'detail-table';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  hr.appendChild(thEl('把次'));
  for (const s of seats) hr.appendChild(thEl(nameOf(s.seat)));
  thead.appendChild(hr);
  tbl.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const d of detail) {
    const r = document.createElement('tr');
    const ht = document.createElement('td');
    ht.textContent = d.handNo + (d.type === 'draw' ? '·荒' : '');
    r.appendChild(ht);
    for (const s of seats) {
      const cell = d.rows.find((x) => x.seat === s.seat);
      const td = document.createElement('td');
      td.textContent = cell ? (cell.delta > 0 ? '+' : '') + cell.delta : '–';
      if (cell) {
        if (cell.delta > 0) td.classList.add('pos');
        else if (cell.delta < 0) td.classList.add('neg');
        if (cell.huType) td.classList.add('win-cell');
      }
      r.appendChild(td);
    }
    tbody.appendChild(r);
  }
  tbl.appendChild(tbody);
  return tbl;
}

/* ------------------------------------------------------------------ */
/* 胡牌提示面板（旧注释见下方 showTenpai）                              */
/* ------------------------------------------------------------------ */

/**
 * 「听牌」按钮只在**真的听了牌**时才出现（差一张 + 至少有一张能胡）。
 * 老吴原话：「听牌以后有一个提示按钮，点击以后显示可以胡的牌及所剩张数」。
 */
export function currentTenpai() {
  if (state.view.phase === 'settled') return null;
  const r = state.game.getTenpai();
  if (!r.tenpai || !r.waits.length) return null;
  return r;
}

export function showTenpai() {
  const r = currentTenpai();
  const card = $('tenpai-card');
  card.textContent = '';
  if (!r) { $('tenpai').hidden = true; return; }

  const title = document.createElement('h3');
  title.textContent = '胡牌提示';
  card.appendChild(title);

  const sub = document.createElement('div');
  sub.className = 'tp-sub';
  sub.textContent = r.mode === 'ready'
    ? '轮到你出牌 —— 下面列出「打哪张就能听牌」，以及能胡的牌还剩几张（明牌估算，别家手牌未计入）'
    : '能胡的牌 + 剩余张数按「牌河 + 各家吃碰杠 + 自己手牌」等明牌估算，别家手牌是暗牌未计入';
  card.appendChild(sub);

  const list = document.createElement('div');
  list.className = 'tp-list';

  /** 一张「听牌」小卡：牌面 + 名字 + 剩几张 + 自摸/点炮 */
  const waitChip = (w) => {
    const box = document.createElement('span');
    box.className = 'tp-chip';
    box.appendChild(makeTileEl(w.tile, state.view, { small: true }));
    const name = document.createElement('span');
    name.className = 'tp-name';
    name.textContent = w.name;
    box.appendChild(name);
    const n = document.createElement('span');
    n.className = 'tp-remain';
    n.textContent = `剩 ${w.remain}`;
    box.appendChild(n);
    const tags = document.createElement('span');
    tags.className = 'tp-tags';
    tags.textContent = w.selfDraw && w.discard ? '自摸/点炮'
      : w.selfDraw ? '仅自摸' : '仅点炮';
    box.appendChild(tags);
    return box;
  };

  if (r.mode === 'ready') {
    // 满手：按「打哪张」分组
    for (const d of r.byDiscard) {
      const row = document.createElement('div');
      row.className = 'tp-row tp-row-ready';
      const head = document.createElement('div');
      head.className = 'tp-head';
      head.appendChild(makeTileEl(d.tile, state.view, {}));
      const txt = document.createElement('span');
      txt.className = 'tp-discard';
      txt.textContent = `打 ${d.name} → 听 ${d.waits.length} 张`;
      head.appendChild(txt);
      row.appendChild(head);
      const chips = document.createElement('div');
      chips.className = 'tp-chips';
      for (const w of d.waits) chips.appendChild(waitChip(w));
      row.appendChild(chips);
      list.appendChild(row);
    }
  } else {
    for (const w of r.waits) {
      const row = document.createElement('div');
      row.className = 'tp-row';
      row.appendChild(makeTileEl(w.tile, state.view, {}));
      const name = document.createElement('span');
      name.className = 'tp-name';
      name.textContent = w.name;
      row.appendChild(name);
      const n = document.createElement('span');
      n.className = 'tp-remain';
      n.textContent = `剩 ${w.remain} 张`;
      row.appendChild(n);
      const tags = document.createElement('span');
      tags.className = 'tp-tags';
      tags.textContent = w.selfDraw && w.discard ? '自摸 / 点炮'
        : w.selfDraw ? '仅自摸' : '仅点炮';
      row.appendChild(tags);
      list.appendChild(row);
    }
  }
  card.appendChild(list);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'tp-close';
  close.textContent = '关闭';
  close.addEventListener('click', () => { $('tenpai').hidden = true; });
  card.appendChild(close);

  $('tenpai').hidden = false;
}
