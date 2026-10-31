#!/usr/bin/env node
// 柒鞗會 横排 2D 卡面（老吴 2026-10-25）：1536×1024，横排金字 + 绿呢 + 卡框文字
import { writeFileSync } from 'node:fs';
import { launchChrome, teardownChrome, sleep } from '/Users/CCBFT_Work/Code/Mahjon/tools/lib/chrome.mjs';

const OUT = '/Users/CCBFT_Work/Code/Mahjon/logo-card/web/hero.webp';
const s = await launchChrome({ extraArgs: ['--allow-file-access-from-files'] });
try {
  await s.cdp.send('Page.enable');
  const page = `<!doctype html><meta charset="utf-8"><canvas id="c" width="1536" height="1024"></canvas><script>
  const c = document.getElementById('c');
  const x = c.getContext('2d');
  const W = 1536, H = 1024;
  window.__render = () => {
    // —— 绿呢底 ——
    x.fillStyle = '#124b33'; x.fillRect(0, 0, W, H);
    const g = x.createRadialGradient(W/2, H/2 - 60, 80, W/2, H/2, 1050);
    g.addColorStop(0, 'rgba(30,122,78,.5)'); g.addColorStop(1, 'rgba(5,30,20,.7)');
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    x.strokeStyle = 'rgba(255,255,255,.035)'; x.lineWidth = 1.5;
    for (let d = -H; d < W + H; d += 44) {
      x.beginPath(); x.moveTo(d, 0); x.lineTo(d + H, H); x.stroke();
      x.beginPath(); x.moveTo(d + H, 0); x.lineTo(d, H); x.stroke();
    }
    // —— 金框（圆角双线）——
    x.strokeStyle = 'rgba(240,200,120,.9)'; x.lineWidth = 4;
    r(18, 18, W - 36, H - 36, 26); x.stroke();
    x.strokeStyle = 'rgba(240,200,120,.35)'; x.lineWidth = 1.5;
    r(30, 30, W - 60, H - 60, 18); x.stroke();
    function r(rx, ry, rw, rh, rad) {
      x.beginPath();
      x.moveTo(rx + rad, ry);
      x.arcTo(rx + rw, ry, rx + rw, ry + rh, rad);
      x.arcTo(rx + rw, ry + rh, rx, ry + rh, rad);
      x.arcTo(rx, ry + rh, rx, ry, rad);
      x.arcTo(rx, ry, rx + rw, ry, rad);
      x.closePath();
    }
    // —— 卡框文字（上：副题 / 下：连接方式与对战）——
    x.textBaseline = 'alphabetic';
    x.fillStyle = 'rgba(240,200,120,.92)';
    x.font = '400 26px "Songti SC", "STSong", "STHeiti", serif';
    x.textAlign = 'left';
    x.fillText('武汉红中赖子杠', 56, 78);
    x.textAlign = 'right';
    x.fillText('柒鞗會 · 麻將俱樂部', W - 56, 78);
    x.strokeStyle = 'rgba(240,200,120,.5)'; x.lineWidth = 2;
    x.beginPath(); x.moveTo(56, 108); x.lineTo(W - 56, 108); x.stroke();
    // （老吴 2026-10-24：底部「局域网/Tailscale/公网 · 網絡對戰」两行与分隔线整体移除，
    //   登录页只留顶部品牌行与主体金字）
    // —— 主体：柒鞗會 横排大字（金渐变 + 浮雕）——
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = '700 340px "Songti SC", "STSong", "STHeiti", serif';
    const chars = ['柒', '鞗', '會'];
    const xs = [W/2 - 430, W/2, W/2 + 430];
    const yC = H/2 - 40;
    for (let k = 0; k < chars.length; k++) {
      const ch = chars[k], cx = xs[k];
      x.fillStyle = 'rgba(10,20,12,.55)';
      x.fillText(ch, cx + 10, yC + 14);
      const gg = x.createLinearGradient(0, yC - 170, 0, yC + 170);
      gg.addColorStop(0, '#ffe9ad'); gg.addColorStop(.42, '#f0c96a');
      gg.addColorStop(.62, '#c9932f'); gg.addColorStop(1, '#8a5a1e');
      x.save();
      x.shadowColor = 'rgba(0,0,0,.6)'; x.shadowBlur = 26; x.shadowOffsetY = 10;
      x.fillStyle = gg;
      x.fillText(ch, cx, yC);
      x.restore();
      x.lineWidth = 3; x.strokeStyle = 'rgba(255,240,200,.35)';
      x.strokeText(ch, cx, yC);
    }
    // —— 星点 ——
    for (let i = 0; i < 90; i++) {
      x.fillStyle = 'rgba(255,240,200,' + (0.04 + Math.random() * 0.1) + ')';
      x.beginPath();
      x.arc(40 + Math.random() * (W - 80), 40 + Math.random() * (H - 80), Math.random() * 1.6 + 0.4, 0, 7);
      x.fill();
    }
    return c.toDataURL('image/webp', 0.9);
  };
  window.__ready = true;
  </script>`;
  const path = '/tmp/mj-hero-landscape.html';
  writeFileSync(path, page);
  await s.cdp.send('Page.navigate', { url: 'file://' + path });
  for (let i = 0; i < 60 && !(await s.cdp.eval('window.__ready === true').catch(() => false)); i++) await sleep(100);
  const data = await s.cdp.eval('window.__render()');
  writeFileSync(OUT, Buffer.from(data.split(',')[1], 'base64'));
  console.log('hero.webp（横排 1536×1024）✓');
} finally { teardownChrome(s); }
