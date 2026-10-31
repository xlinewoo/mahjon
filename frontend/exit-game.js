/**
 * 网络版「退出游戏」投票 UI。
 *
 * 规则（服务端权威，见 server/ws/room.js requestExit / voteExit）：
 *   · 发起人之外的三家全部同意 → 整场立即结束；
 *   · 任意一家不同意 → 请求作废，牌局继续；
 *   · 结束时的积分只算本桌**已经完成**的牌局，当前没打完的这把不算。
 *
 * 本模块只负责弹窗与按钮，不发规则判定；投票状态同时会随 table:players 下发，
 * 所以断线重连后也能从 `exitVote` 恢复投票界面。
 */
import { $, esc, flash } from './ui-utils.js';

export function createExitGame(opts = {}) {
  const {
    getSocket = () => null,
    getSeat = () => -1,
    getRoom = () => null,
    onNote = () => {},
  } = opts;

  let vote = null;
  let summary = null;
  /** 被「本局结算还没关」挡住的**本场**结算，等本局窗一关就弹（老吴 2026-10-30） */
  let pendingFinal = null;
  let settleWatch = null;

  const playerName = (seat) => {
    const room = getRoom();
    const p = room && room.players && room.players[seat];
    return (p && p.username) || `座位${Number(seat) + 1}`;
  };

  const hideVote = () => {
    const box = $('exitvote');
    if (box) box.hidden = true;
  };
  const hideSummary = () => {
    summary = null;
    const box = $('exitsummary');
    if (box) box.hidden = true;
  };

  function renderVote() {
    if (summary) return;
    const box = $('exitvote');
    const card = $('exitvote-card');
    if (!box || !card) return;
    if (!vote) { hideVote(); return; }

    const mySeat = getSeat();
    const fromSeat = Number(vote.fromSeat);
    const fromName = vote.fromName || playerName(fromSeat);
    const approvals = Array.isArray(vote.approvals) ? vote.approvals : [];
    const needed = Math.max(3, Number(vote.needed) || 3);
    const n = approvals.length;
    const iAgreed = approvals.includes(mySeat);
    const isRequester = mySeat === fromSeat;

    card.innerHTML = '';
    const h = document.createElement('h3');
    h.textContent = isRequester ? '退出游戏申请已发出' : '退出游戏';
    card.appendChild(h);

    const text = document.createElement('div');
    text.className = 'exit-vote-text';
    if (isRequester) {
      text.innerHTML = `你已申请结束本场，需另外三家全部同意（<b>${n}/${needed}</b>）。<br />`
        + '若有一家不同意，牌局继续。';
    } else {
      text.innerHTML = `<b>${esc(fromName)}</b> 申请退出游戏，需另外三家全部同意（<b>${n}/${needed}</b>）。<br />`
        + '三家都同意后本场立即结束；任意一家不同意则牌局继续。';
    }
    card.appendChild(text);

    if (Number.isInteger(vote.completedHands)) {
      const done = document.createElement('div');
      done.className = 'exit-note';
      done.textContent = `结束时按已完成 ${vote.completedHands} 把的积分统计；当前这把没打完，不计入。`;
      card.appendChild(done);
    }

    if (isRequester) {
      const wait = document.createElement('div');
      wait.className = 'exit-note';
      wait.textContent = '等待其他三家投票…';
      card.appendChild(wait);
    } else if (iAgreed) {
      const wait = document.createElement('div');
      wait.className = 'exit-note';
      wait.textContent = `你已同意，等待其他玩家（${n}/${needed}）…`;
      card.appendChild(wait);
    } else if (mySeat >= 0) {
      const actions = document.createElement('div');
      actions.className = 'exit-vote-actions';
      const no = document.createElement('button');
      no.type = 'button';
      no.className = 'exit-btn-reject';
      no.textContent = '不同意';
      no.addEventListener('click', () => sendVote(false, no));
      const yes = document.createElement('button');
      yes.type = 'button';
      yes.className = 'exit-btn-agree';
      yes.textContent = '同意结束';
      yes.addEventListener('click', () => sendVote(true, yes));
      actions.append(no, yes);
      card.appendChild(actions);
    }

    box.hidden = false;
  }

  function sendVote(agree, btn) {
    const socket = getSocket();
    if (!socket) return;
    if (btn) { btn.disabled = true; btn.textContent = agree ? '已同意…' : '已拒绝…'; }
    socket.emit('table:exitVote', { agree: !!agree }, (ack) => {
      if (ack && ack.error) {
        flash(ack.error);
        if (btn) { btn.disabled = false; btn.textContent = agree ? '同意结束' : '不同意'; }
      }
    });
  }

  function request() {
    const socket = getSocket();
    if (!socket) { flash('还没进入牌桌'); return; }
    socket.emit('table:exitRequest', {}, (ack) => {
      if (!ack || ack.error) flash((ack && ack.error) || '发起退出失败');
      else if (ack.event === 'requested') onNote('已发起退出申请，等待其他三家同意…', true);
    });
  }

  function sync(next) {
    vote = next || null;
    if (vote) renderVote();
    else hideVote();
  }

  function showSummary(final) {
    // 老吴 2026-10-30：「本场次结束时，先弹出本局的结算，确认后再弹出本场次的结算信息。」
    //   —— 打满约定局数那一帧，#settle（本局结算）正开着，直接弹本场窗会**盖在**它上面，
    //      本局等于没看。所以先暂存，等 #settle 关掉（玩家点了「结束」）再弹。
    //   ⚠️ 只对 reason==='finished' 生效：投票退出是**中途散场**（当前这把不计），
    //      没有「先看完本局」这回事，而且那时 #settle 可能再也不会被关（view 已置空），
    //      暂存就等于永远不弹。退出路径：收起残留的本局窗，立刻弹本场。
    const f = final || {};
    if (f.reason !== 'finished') {
      const st = $('settle');
      if (st) st.hidden = true;
      renderSummary(f);
      return;
    }
    watchRoundSettle();
    if (roundSettleOpen()) { pendingFinal = f; return; }
    renderSummary(f);
  }

  /** 本局结算窗（#settle）此刻是否还开着 */
  function roundSettleOpen() {
    const box = $('settle');
    return !!(box && !box.hidden);
  }

  /** 盯住本局结算窗：它一关，就把暂存的本场结算补上。
   *  用 MutationObserver 而不是接管那个按钮 —— 本局窗的按钮归 render.js 管，
   *  这里只在「hidden 变成 true」这个事实上挂钩子，两边互不侵入（回放/单机版也安全）。 */
  function watchRoundSettle() {
    if (settleWatch) return;
    const box = $('settle');
    if (!box || typeof MutationObserver === 'undefined') return;
    settleWatch = new MutationObserver(() => {
      if (!pendingFinal || roundSettleOpen()) return;
      const f = pendingFinal;
      pendingFinal = null;
      renderSummary(f);
    });
    settleWatch.observe(box, { attributes: true, attributeFilter: ['hidden'] });
  }

  /** 本场结算有没有在排队（本场已结束、但本局结算还没确认） */
  function hasPendingSummary() {
    return !!pendingFinal;
  }

  /** 立刻把排队的本场结算弹出来（本局窗的「结束」按钮走这条路：这一下就是「确认本局」）
   *  ⚠️ 不在这里 manually 把 #settle 设 hidden：一旦后面任何 renderAll 跑到，renderSettle 会
   *  按「phase 仍是 settled」把它重新打开（两张窗又叠一起）。本场结算窗本身在 DOM 里排在
   *  #settle 之后、同为 z-index 800 ⇒ 它天然盖在上面；关掉它时走 onDone 离桌，由 leaveTable
   *  统一把 #settle 收掉（那里本来就有这条兜底）。
   *  @returns {boolean} 是否真的弹了 */
  function showPendingSummary() {
    if (!pendingFinal) return false;
    const f = pendingFinal;
    pendingFinal = null;
    renderSummary(f);
    return true;
  }

  function renderSummary(final) {
    summary = final || {};
    hideVote();
    const box = $('exitsummary');
    const card = $('exitsummary-card');
    if (!box || !card) return;
    card.innerHTML = '';

    const finished = summary.reason === 'finished';
    const n = Number(summary.completedHands) || 0;

    const h = document.createElement('h3');
    h.textContent = finished ? '本场总成绩' : '本场结束';
    card.appendChild(h);

    const sub = document.createElement('div');
    sub.className = 'stats-sub';
    if (finished) {
      const total = Number(summary.totalHands) || n;
      sub.textContent = `本桌设定的 ${total} 把已打完，按本场 ${n} 把统计各家总成绩。`;
    } else {
      const byName = summary.byName || '玩家';
      sub.textContent = `${byName} 申请退出，其他三家一致同意；按已完成的 ${n} 把结算。`;
    }
    card.appendChild(sub);

    const note = document.createElement('div');
    note.className = 'exit-note';
    if (finished) {
      note.textContent = '点炮 = 自己打出的牌被别人胡；金顶 = 自己胡出金顶的次数；连庄 = 自己坐庄时胡牌（庄家胡牌即连庄）。';
    } else {
      note.textContent = n > 0 ? '当前未打完的一把不计入积分。' : '还没有已完成的牌局，四家均为 0 分。';
    }
    card.appendChild(note);

    const standings = Array.isArray(summary.standings) ? summary.standings : [];
    if (standings.length) {
      const nets = standings.map((p) => p.net | 0);
      const maxNet = Math.max(...nets);
      const minNet = Math.min(...nets);
      // 并列第一/倒数第一都标；全 0 或没有正/负分时不硬凑大赢家/大输家。
      const markWinners = maxNet > 0;
      const markLosers = minNet < 0;
      const tbl = document.createElement('table');
      tbl.className = 'score-table exit-score-table';
      const thead = document.createElement('thead');
      const hr = document.createElement('tr');
      const heads = finished
        ? ['#', '玩家', '总得分', '胡牌', '点炮', '金顶', '连庄']
        : ['#', '玩家', '净分', '胡', '杠', '最高番'];
      for (const t of heads) {
        const th = document.createElement('th');
        th.textContent = t;
        hr.appendChild(th);
      }
      thead.appendChild(hr);
      tbl.appendChild(thead);
      const tbody = document.createElement('tbody');
      standings.forEach((p, i) => {
        const tr = document.createElement('tr');
        const net = p.net | 0;
        if (i === 0 && net > 0) tr.className = 'leader';
        const cells = finished
          ? [String(i + 1), p.name, (net > 0 ? '+' : '') + net,
              String(p.wins | 0), String(p.dealtIn | 0), String(p.goldTops | 0), String(p.lianZhuang | 0)]
          : [String(i + 1), p.name, (net > 0 ? '+' : '') + net,
              String(p.wins | 0), String(p.gangs | 0), String(p.maxFan | 0)];
        cells.forEach((v, k) => {
          const td = document.createElement('td');
          if (k === 1) {
            td.textContent = v;
            if (markWinners && net === maxNet) {
              const badge = document.createElement('span');
              badge.className = 'exit-rank-badge winner';
              badge.textContent = '大赢家';
              td.appendChild(badge);
            }
            if (markLosers && net === minNet) {
              const badge = document.createElement('span');
              badge.className = 'exit-rank-badge loser';
              badge.textContent = '大输家';
              td.appendChild(badge);
            }
          } else {
            td.textContent = v;
          }
          if (k === 2) td.className = net > 0 ? 'pos' : net < 0 ? 'neg' : '';
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody);
      // 表格单独包一层：横屏矮屏时要在这里内部滚动（给 <table> 自己加 overflow 会把表格
      // 变成块、列宽全错），标题/说明/按钮则固定不动（见 net3d.css 的 #exitsummary 段）。
      const wrap = document.createElement('div');
      wrap.className = 'exit-table-wrap';
      wrap.appendChild(tbl);
      card.appendChild(wrap);
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'stats-close';
    // 本场结束后还留在牌桌上看本场结算 → 按钮是「返回俱乐部」（点掉就离桌）；
    // 投票退出的老路径（服务端已把牌局关掉）仍是「返回牌桌」。
    const onDone = typeof summary.onDone === 'function' ? summary.onDone : null;
    close.textContent = onDone ? '返回俱乐部' : '返回牌桌';
    close.addEventListener('click', () => {
      hideSummary();
      if (onDone) { try { onDone(); } catch (_) { /* 离桌失败不拦 */ } }
    });
    card.appendChild(close);
    box.hidden = false;
  }

  function reset() {
    vote = null;
    pendingFinal = null;
    hideVote();
    hideSummary();
  }

  return {
    request, sync, showSummary, reset, hideSummary,
    hasPendingSummary, showPendingSummary,
    get vote() { return vote; },
  };
}
