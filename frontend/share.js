/**
 * 「分享本局」战绩图（2026-11-20）：把结算摘要画到 canvas 上生成一张图，
 * 弹窗里展示 <img> —— 手机上长按图片即可保存 / 转发（微信自带浏览器同样支持）。
 * 只读当前结算帧（state.view / state.view.result），不动牌局。
 */
import { state } from './render-state.js';
import { $ } from './ui-utils.js';

const W = 720;
const H = 960;
const WINDS = ['东', '南', '西', '北'];

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function buildShareCard(v, r) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');

  // 底：绿毡 + 暗角感（两层渐变模拟）
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#0e4a30');
  bg.addColorStop(1, '#072b1c');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);

  // 金标题
  g.textAlign = 'center';
  g.fillStyle = '#ffd34d';
  g.font = '700 40px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  g.fillText('武汉红中赖子杠 · 本局结算', W / 2, 92);
  g.fillStyle = 'rgba(255,211,77,.55)';
  g.font = '400 22px -apple-system, sans-serif';
  const d = new Date();
  g.fillText(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}  柒鞗會`, W / 2, 128);

  // 结果摘要行
  g.fillStyle = '#fff';
  g.font = '700 30px -apple-system, "PingFang SC", sans-serif';
  const headline = r.type === 'win'
    ? (r.topType === 'goldTop' ? '胡牌 · 金顶！' : '胡牌')
    : '荒庄（流局）';
  g.fillText(headline, W / 2, 196);

  // 四家分数卡
  const s2d = (state.game && state.game.seatToDir) || {};
  const payOf = (seat) => {
    if (r.type !== 'win') return null;
    if (seat === r.winnerSeat) return r.totalWin ?? 0;
    const p = (r.payments || []).find((x) => x.seat === seat);
    return p ? p.pay : 0;
  };
  const me = v.me || {};
  const cardY = 240;
  const cardH = 130;
  let y = cardY;
  for (let seat = 0; seat < 4; seat++) {
    const isMe = seat === state.mySeat;
    const other = isMe ? null : (v.others || []).find((x) => x.seat === seat);
    const name = isMe ? (me.name || '你') : ((other && other.name) || `座位${seat + 1}`);
    const dir = s2d[seat] != null ? WINDS[s2d[seat]] || WINDS[seat] : WINDS[seat];
    const pay = payOf(seat);

    // 卡片底
    const isWinner = seat === r.winnerSeat;
    g.fillStyle = isWinner ? 'rgba(255,211,77,.14)' : 'rgba(255,255,255,.08)';
    roundRect(g, 60, y, W - 120, cardH - 18, 16);
    g.fill();
    if (isWinner) {
      g.strokeStyle = '#ffd34d';
      g.lineWidth = 2;
      roundRect(g, 60, y, W - 120, cardH - 18, 16);
      g.stroke();
    }

    // 方位徽标
    g.fillStyle = isWinner ? '#d21f2b' : 'rgba(255,255,255,.18)';
    g.beginPath();
    g.arc(108, y + (cardH - 18) / 2, 26, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.font = '700 26px sans-serif';
    g.textAlign = 'center';
    g.fillText(dir, 108, y + (cardH - 18) / 2 + 9);

    // 名字
    g.textAlign = 'left';
    g.fillStyle = '#fff';
    g.font = '700 26px -apple-system, "PingFang SC", sans-serif';
    let nm = name.length > 9 ? name.slice(0, 9) + '…' : name;
    if (isMe) nm = `${nm}（你）`;
    g.fillText(nm, 148, y + 44);

    // 分数
    g.textAlign = 'right';
    if (pay != null) {
      g.font = '700 30px -apple-system, sans-serif';
      if (seat === r.winnerSeat) {
        g.fillStyle = '#7ee2a8';
        g.fillText(`收 +${pay} 分`, W - 90, y + 48);
      } else {
        g.fillStyle = pay > 0 ? '#ff9f92' : 'rgba(255,255,255,.7)';
        g.fillText(pay > 0 ? `付 ${pay} 分` : '付 0 分', W - 90, y + 48);
      }
    } else {
      g.fillStyle = 'rgba(255,255,255,.7)';
      g.font = '400 24px sans-serif';
      g.fillText('流局', W - 90, y + 48);
    }
    y += cardH;
  }

  // 底部水印
  g.textAlign = 'center';
  g.fillStyle = 'rgba(255,255,255,.4)';
  g.font = '400 20px sans-serif';
  g.fillText('武汉红中赖子杠 · 3D 网络版', W / 2, H - 40);

  return c.toDataURL('image/png');
}

/** 打开分享弹窗（幂等）：展示生成的图 + 长按保存提示 */
export function showShare() {
  const v = state.view;
  const r = v && v.result;
  if (!v || !r) return;
  let box = document.getElementById('share-modal');
  if (!box) {
    box = document.createElement('div');
    box.id = 'share-modal';
    box.className = 'modal';
    box.hidden = true;
    const card = document.createElement('div');
    card.className = 'modal-card share-card';
    card.innerHTML = '<h3>分享本局</h3>'
      + '<div class="share-hint">长按下面的图片保存到相册，或转发给朋友</div>'
      + '<img class="share-img" alt="本局结算图" />'
      + '<button type="button" class="tp-close">关闭</button>';
    card.querySelector('button').addEventListener('click', () => { box.hidden = true; });
    box.addEventListener('click', (e) => { if (e.target === box) box.hidden = true; });
    box.appendChild(card);
    document.body.appendChild(box);
  }
  const img = box.querySelector('.share-img');
  img.src = buildShareCard(v, r);
  box.hidden = false;
}
