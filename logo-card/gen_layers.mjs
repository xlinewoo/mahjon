#!/usr/bin/env node
// 柒鞗會 logo 卡四层生成：subject（金字竖排）/ background（绿呢）/ lineart（深色轮廓）
import { writeFileSync } from 'node:fs';
import { launchChrome, teardownChrome, sleep } from '/Users/CCBFT_Work/Code/Mahjon/tools/lib/chrome.mjs';

const OUT = '/Users/CCBFT_Work/Code/Mahjon/logo-card/assets';
const s = await launchChrome({ extraArgs: ['--allow-file-access-from-files'] });
try {
  await s.cdp.send('Page.enable');
  const page = `<!doctype html><meta charset="utf-8"><canvas id="c" width="1024" height="1536"></canvas><script>
  const c = document.getElementById('c');
  const x = c.getContext('2d');
  const FONT = '700 300px "Songti SC", "STSong", "STHeiti", serif';
  window.__bg = () => {
    x.clearRect(0, 0, 1024, 1536);
    x.fillStyle = '#124b33'; x.fillRect(0, 0, 1024, 1536);
    const g = x.createRadialGradient(512, 640, 80, 512, 768, 1100);
    g.addColorStop(0, 'rgba(30,122,78,.55)'); g.addColorStop(1, 'rgba(5,30,20,.72)');
    x.fillStyle = g; x.fillRect(0, 0, 1024, 1536);
    x.strokeStyle = 'rgba(255,255,255,.035)'; x.lineWidth = 1.5;
    for (let d = -1536; d < 3072; d += 44) {
      x.beginPath(); x.moveTo(d, 0); x.lineTo(d + 1536, 1536); x.stroke();
      x.beginPath(); x.moveTo(d + 1536, 0); x.lineTo(d, 1536); x.stroke();
    }
    const v = x.createRadialGradient(512, 768, 420, 512, 768, 1150);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.5)');
    x.fillStyle = v; x.fillRect(0, 0, 1024, 1536);
    return c.toDataURL('image/png');
  };
  window.__subject = () => {
    x.clearRect(0, 0, 1024, 1536);
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = FONT;
    const chars = ['柒', '鞗', '會'];
    const ys = [330, 690, 1050];
    for (let k = 0; k < chars.length; k++) {
      const ch = chars[k], y = ys[k];
      // 深色浮雕底
      x.fillStyle = 'rgba(10,20,12,.55)';
      x.fillText(ch, 512 + 10, y + 14);
      // 金字渐变
      const g = x.createLinearGradient(0, y - 170, 0, y + 170);
      g.addColorStop(0, '#ffe9ad'); g.addColorStop(.42, '#f0c96a');
      g.addColorStop(.62, '#c9932f'); g.addColorStop(1, '#8a5a1e');
      x.save();
      x.shadowColor = 'rgba(0,0,0,.6)'; x.shadowBlur = 26; x.shadowOffsetY = 10;
      x.fillStyle = g;
      x.fillText(ch, 512, y);
      x.restore();
      x.lineWidth = 3; x.strokeStyle = 'rgba(255,240,200,.35)';
      x.strokeText(ch, 512, y);
    }
    return c.toDataURL('image/png');
  };
  window.__lineart = () => {
    x.clearRect(0, 0, 1024, 1536);
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, 1024, 1536);
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = FONT;
    const chars = ['柒', '鞗', '會'];
    const ys = [330, 690, 1050];
    x.lineWidth = 4; x.strokeStyle = '#161616';
    for (let k = 0; k < chars.length; k++) x.strokeText(chars[k], 512, ys[k]);
    return c.toDataURL('image/png');
  };
  window.__ready = true;
  </script>`;
  const path = '/tmp/mj-logo-layers.html';
  writeFileSync(path, page);
  await s.cdp.send('Page.navigate', { url: 'file://' + path });
  for (let i = 0; i < 60 && !(await s.cdp.eval('window.__ready === true').catch(() => false)); i++) await sleep(100);
  for (const [name, fn] of [['background', '__bg'], ['subject', '__subject'], ['lineart', '__lineart']]) {
    const data = await s.cdp.eval(`${fn}()`);
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(data.split(',')[1], 'base64'));
    console.log(name + '.png ✓');
  }
} finally { teardownChrome(s); }
