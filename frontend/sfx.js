/**
 * 极简音效（零素材、Web Audio 程序合成，老吴 2026-11-20）：
 *   摸牌 / 出牌 / 吃碰杠 / 胡牌 / 金币 五种，够一整局的情绪反馈。
 * 设计约束：
 *   · 无外部音频文件 —— 保持「单文件零依赖」的构建取向；
 *   · 首次发声时才 lazily 创建 AudioContext（移动端必须用户手势后才能出声）；
 *   · 静音开关持久化在 localStorage，顶栏按钮由 net3d-main / main 接线；
 *   · 任何异常吞掉 —— 音效永远不能把牌局搞挂。
 */

const KEY = 'mahjon:sound';
let ctx = null;
let muted = false;
try { muted = localStorage.getItem(KEY) === 'off'; } catch { /* 隐私模式 */ }

function ac() {
  if (ctx) return ctx;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return null;
  try { ctx = new AC(); } catch { return null; }
  return ctx;
}

/** 短促的「嗒」：带通滤波的噪声脉冲，模拟麻将牌撞击 */
function clack(t0, gain = 0.5, freq = 2400) {
  const c = ac();
  if (!c) return;
  const dur = 0.05;
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    const p = 1 - i / d.length;
    d[i] = (Math.random() * 2 - 1) * p * p;
  }
  const src = c.createBufferSource();
  src.buffer = buf;
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq;
  bp.Q.value = 1.2;
  const g = c.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  src.connect(bp).connect(g).connect(c.destination);
  src.start(t0);
}

/** 单音音符（正弦 + 轻微衰减包络） */
function tone(t0, freq, dur = 0.18, gain = 0.16, type = 'sine') {
  const c = ac();
  if (!c) return;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(g).connect(c.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

const FX = {
  draw(t) { clack(t, 0.25, 1800); },
  discard(t) { clack(t, 0.5, 2400); clack(t + 0.045, 0.3, 3200); },
  claim(t) { clack(t, 0.55, 2000); clack(t + 0.06, 0.5, 2600); tone(t + 0.1, 660, 0.22, 0.12, 'triangle'); },
  win(t) {
    // 上行琶音：麻将胡牌的经典「锵锵锵锵」
    [523, 659, 784, 1046].forEach((f, i) => tone(t + i * 0.09, f, 0.26, 0.18, 'triangle'));
    clack(t + 0.36, 0.6, 2200);
  },
  coin(t) {
    [1318, 1568].forEach((f, i) => tone(t + i * 0.07, f, 0.3, 0.12, 'sine'));
    clack(t + 0.05, 0.25, 3600);
  },
  emote(t) { tone(t, 880, 0.1, 0.08, 'sine'); tone(t + 0.08, 1174, 0.12, 0.08, 'sine'); },
};

export const sfx = {
  /** 播放一个音效（静音 / 无 AudioContext 时静默忽略） */
  play(name) {
    if (muted) return;
    try {
      const c = ac();
      if (!c) return;
      if (c.state === 'suspended') c.resume();
      const fn = FX[name];
      if (fn) fn(c.currentTime + 0.01);
    } catch { /* 音效永不影响牌局 */ }
  },
  get muted() { return muted; },
  toggle() {
    muted = !muted;
    try { localStorage.setItem(KEY, muted ? 'off' : 'on'); } catch { /* 忽略 */ }
    return muted;
  },
};
