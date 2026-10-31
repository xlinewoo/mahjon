/**
 * 极简「起一个无头 Chrome 并连上它」的公共模块（零依赖）。
 *
 * 为什么要有这个：`tools/build-tile-images.mjs`（牌面 → WebP）和
 *   `tools/fetch-felt.mjs`（绿垫 → WebP）都需要「headless Chrome + 裸 CDP」，
 *   参数组合踩过三个坑，抽一份出来省得各写各的再各踩一遍。
 *
 * 三个必踩的坑（都实际撞过，注释留着别改）：
 *   ① 一定要 `--no-sandbox --disable-dev-shm-usage`，少了沙箱里根本起不来；
 *   ② 必须连 `/json/list` 里 **type==='page'** 的 target。
 *      `/json/version` 的 `webSocketDebuggerUrl` 是 **browser 级**端点，
 *      连上去发 `Page.*` / `Runtime.*` 会得到 method not found；
 *   ③ 必须给独立 `--user-data-dir`，否则会跟用户桌面上开着的真 Chrome 抢 profile 锁。
 *      另外 Node 22 的**全局 WebSocket** 是 DOM 风格（`onmessage`/`onopen`），
 *      不是 socket.io 的 `on('message')` —— 写错会得到 `ws.on is not a function`。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { rmSync, existsSync } from 'node:fs';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

/** 找一个存在的 Chrome；没有就返回 null（调用方自己报错退出） */
export function findChrome() {
  return CHROME_CANDIDATES.filter(Boolean).find((p) => existsSync(p)) || null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 取一个空闲端口（CDP 用） */
export function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

/** CDP 极简客户端：`send(method, params)` → Promise<result>，出错 reject */
export class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.waits = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (!m.id || !this.waits.has(m.id)) return;
      const { res, rej } = this.waits.get(m.id);
      this.waits.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    };
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waits.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 页内求值，把真正的错误带出来（否则只会看到 "[object Object] is not valid JSON"） */
  async eval(expression, { awaitPromise = true } = {}) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页内脚本抛错：' + (d.exception?.description || d.text || JSON.stringify(d)));
    }
    return r.result.value;
  }

  close() { try { this.ws.close(); } catch { /* 已关 */ } }
}

/**
 * 起 Chrome 并连上它的页面 target。
 * @returns {{cdp: CDP, proc: ChildProcess, profile: string, port: number}}
 */
export async function launchChrome({ extraArgs = [] } = {}) {
  const chrome = findChrome();
  if (!chrome) throw new Error('找不到 Chrome / Chromium（设 CHROME_PATH 指向可执行文件）');
  const port = await freePort();
  const profile = `/tmp/mj-chrome-${randomBytes(5).toString('hex')}`;
  const proc = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--allow-file-access-from-files', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`, ...extraArgs, 'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
        .find((t) => t.type === 'page');
    } catch { /* 端口还没起来 */ }
    if (!target) await sleep(150);
  }
  if (!target) {
    proc.kill();
    throw new Error(
      `连不上 Chrome devtools（端口 ${port}）。常见原因：① 无头 Chrome 起不来`
      + '（别和其它 e2e / 视口扫描并行跑，CPU 会被吃满）；② 目标 Chrome 不存在（设 CHROME_PATH）。'
      + '本轮 profile：' + profile,
    );
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  return { cdp: new CDP(ws), proc, profile, port };
}

/** 关浏览器 + 尽力删 profile（沙箱可能拒绝删，吞掉即可，残留一个 /tmp 目录无害） */
export function teardownChrome(s) {
  if (!s) return;
  try { s.cdp.close(); } catch { /* 已断 */ }
  try { s.proc.kill(); } catch { /* 已退 */ }
  try { rmSync(s.profile, { recursive: true, force: true }); } catch { /* 沙箱可能不让删 */ }
}
