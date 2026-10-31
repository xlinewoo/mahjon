/**
 * 七皮 / 十杠「刚达成」播报。
 *
 * 引擎在成就由 false → true 的那一刻把事件写进 view.achievements（金额与终局
 * computeSpecialBonuses 同源）。这里只负责：按 seed+seq 去重，在各家门前弹一次，
 * 2.8 秒后自动消失。真正入账仍在结算时，不能在这里改分。
 */
import { state } from './render-state.js';

const POS = ['bottom', 'right', 'top', 'left'];
const seen = new Set();
let initialized = false;
let layer = null;

export function resetAchievementNotices() {
  seen.clear();
  initialized = false;
  if (layer) layer.innerHTML = '';
}

export function renderAchievementNotices(view) {
  if (!view || state.replay) return;
  const events = view.achievements || [];
  if (!initialized) {
    initialized = true;
    for (const e of events) seen.add(eventKey(view, e));
    return;
  }
  const fresh = events.filter((e) => !seen.has(eventKey(view, e)));
  if (!fresh.length) return;
  for (const e of fresh) seen.add(eventKey(view, e));
  announce(view, fresh);
}

function eventKey(view, e) {
  // 2026-10-29：服务端不再下发 seed（洗牌确定性 ⇒ 给 seed 等于给透视挂），
  // 改用不可反推的 handTag 区分「同局 vs 下一局」；handTag 缺失时退化为牌面组合。
  const tag = view.handTag != null ? view.handTag : `${view.flipTile ?? ''}#${view.dealer ?? ''}`;
  return `${tag}:${e.seq}:${e.kind}`;
}

function ensureLayer() {
  if (layer && layer.isConnected) return layer;
  layer = document.createElement('div');
  layer.id = 'achv-layer';
  document.body.appendChild(layer);
  return layer;
}

function anchorFor(pos) {
  const node = document.getElementById(`seat-${pos}`);
  const rect = node ? node.getBoundingClientRect() : null;
  if (rect && rect.width > 20 && rect.height > 20) {
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }
  const host = document.getElementById('table3d');
  const r = host && host.getBoundingClientRect().width > 20
    ? host.getBoundingClientRect()
    : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  const table = {
    bottom: { fx: 0.5, fy: 0.82 },
    right: { fx: 0.86, fy: 0.52 },
    top: { fx: 0.5, fy: 0.18 },
    left: { fx: 0.14, fy: 0.52 },
  }[pos];
  return { x: r.left + r.width * table.fx, y: r.top + r.height * table.fy };
}

function announce(view, events) {
  const perSeat = [null, null, null, null];
  for (const e of events) {
    if (!perSeat[e.seat]) perSeat[e.seat] = [];
    perSeat[e.seat].push({ text: `${e.label} +${e.amount}`, gain: true });
    for (const p of e.payers || []) {
      if (!perSeat[p.seat]) perSeat[p.seat] = [];
      perSeat[p.seat].push({ text: `${e.label} -${p.pay}`, gain: false });
    }
  }

  const mySeat = (view.me && view.me.seat) || 0;
  for (let seat = 0; seat < 4; seat++) {
    const lines = perSeat[seat];
    if (!lines || !lines.length) continue;
    const pos = POS[((seat - mySeat) % 4 + 4) % 4];
    const at = anchorFor(pos);
    const box = document.createElement('div');
    box.className = `achv-toast achv-${pos}`;
    box.style.left = `${at.x}px`;
    box.style.top = `${at.y}px`;
    const same = ensureLayer().querySelectorAll(`.achv-toast.achv-${pos}`).length;
    if (same) box.style.marginTop = `${same * 38}px`;
    for (const line of lines) {
      const row = document.createElement('div');
      row.className = 'achv-line ' + (line.gain ? 'gain' : 'pay');
      row.textContent = line.text;
      box.appendChild(row);
    }
    ensureLayer().appendChild(box);
    setTimeout(() => box.remove(), 2800);
  }
}
