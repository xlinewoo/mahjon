/**
 * 确定性伪随机数生成器（mulberry32）
 *
 * 用途：牌墙洗牌必须可复现。给定同一个 seed，整局牌序完全一致，
 * 这样才能做到「战绩可回放、牌局可复算」，排查争议牌也靠它。
 * 严禁在引擎内部直接使用 Math.random。
 */

/**
 * 创建一个 mulberry32 随机源
 * @param {number} seed 32 位无符号整数种子
 * @returns {{ next: () => number, int: (maxExclusive: number) => number, shuffle: <T>(arr: T[]) => T[] }}
 */
export function createRng(seed) {
  let a = seed >>> 0;

  /** 返回 [0, 1) 的浮点数 */
  function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** 返回 [0, maxExclusive) 的整数 */
  function int(maxExclusive) {
    if (maxExclusive <= 0) throw new Error('maxExclusive 必须为正数');
    return Math.floor(next() * maxExclusive);
  }

  /** Fisher-Yates 洗牌，原地打乱并返回同一数组 */
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = int(i + 1);
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  return { next, int, shuffle };
}

/**
 * 由字符串生成稳定的 32 位种子，方便用 "room-123" 之类做种子
 * @param {string} str
 * @returns {number}
 */
export function seedFromString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
