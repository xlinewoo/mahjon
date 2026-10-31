#!/usr/bin/env node
/**
 * 头像库生成（老吴 2026-10-25）：icon/ 文件夹 → 规范化 96×96 WebP。
 *
 *   node tools/build-avatar-presets.mjs
 *
 * 产出：
 *   · server/assets/avatars/<id>.webp   —— 规范化头像（经 /api/avatars/preset/<id>.webp 服务）
 *   · server/assets/avatars/index.json  —— 预设 id 清单（server/avatars.js 启动时读取）
 *
 * id = 去扩展名的文件名（如 "1"、"101z"）；排序按自然序（1, 2, …, 10 而不是 1, 10, 2）。
 * 换/加头像：把图丢进 icon/ 重跑本脚本即可。headless Chrome 出图（零依赖，同 build-tile-art）。
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, teardownChrome, sleep } from './lib/chrome.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'icon');
const OUT_DIR = resolve(ROOT, 'server', 'assets', 'avatars');

const files = readdirSync(SRC).filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
if (!files.length) throw new Error('icon/ 里没有图片');
const natural = (a) => a.replace(/\d+/g, (m) => m.padStart(6, '0'));
files.sort((a, b) => natural(a).localeCompare(natural(b)));
const ids = files.map((f) => f.replace(/\.(jpe?g|png|webp)$/i, ''));
console.log(`icon/ 共 ${files.length} 张`);

const page = `<!doctype html><meta charset="utf-8"><canvas id="c"></canvas><script>
const c = document.getElementById('c');
const x = c.getContext('2d');
window.__done = 0;
window.__convert = (dataUrl) => new Promise((res) => {
  const i = new Image();
  i.onload = () => {
    c.width = 96; c.height = 96;
    // cover 裁切：短边贴满、居中
    const s = Math.min(i.width, i.height);
    const sx = (i.width - s) / 2, sy = (i.height - s) / 2;
    x.clearRect(0, 0, 96, 96);
    x.drawImage(i, sx, sy, s, s, 0, 0, 96, 96);
    res(c.toDataURL('image/webp', 0.85));
  };
  i.onerror = () => res(null);
  i.src = dataUrl;
});
window.__ready = true;
</script>`;

const pagePath = resolve(tmpdir(), 'mahjon-avatar-build.html');
writeFileSync(pagePath, page);
mkdirSync(OUT_DIR, { recursive: true });

const s = await launchChrome({ extraArgs: ['--allow-file-access-from-files'] });
try {
  await s.cdp.send('Page.enable');
  await s.cdp.send('Page.navigate', { url: 'file://' + pagePath });
  for (let i = 0; i < 80 && !(await s.cdp.eval('window.__ready === true').catch(() => false)); i++) await sleep(100);
  const manifest = [];
  for (let i = 0; i < files.length; i++) {
    const buf = readFileSync(resolve(SRC, files[i]));
    const mime = /\.png$/i.test(files[i]) ? 'image/png' : 'image/jpeg';
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
    const out = await s.cdp.eval(`window.__convert(${JSON.stringify(dataUrl)})`);
    if (!out) { console.error(`跳过（解码失败）：${files[i]}`); continue; }
    writeFileSync(resolve(OUT_DIR, `${ids[i]}.webp`), Buffer.from(out.split(',')[1], 'base64'));
    manifest.push(ids[i]);
    if ((i + 1) % 32 === 0) console.log(`  ${i + 1}/${files.length}`);
  }
  writeFileSync(resolve(OUT_DIR, 'index.json'), JSON.stringify(manifest));
  console.log(`✅ ${manifest.length} 个预设头像 → ${OUT_DIR}`);
} finally {
  teardownChrome(s);
}
