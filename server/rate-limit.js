// 内存限速器（固定窗口计数）
//
// 定位：**单体自托管**的粗粒度防线，只为挡住暴力破解 / 批量注册 / 接口刷量，
// 不做分布式一致性（多实例部署时各算各的，需要换成 Redis 之类）。
// 进程重启即清空 —— 这是有意的：宁可重启后从零开始，也不要引入持久化状态。

/**
 * @param {object} opts
 * @param {number} opts.windowMs 窗口长度（毫秒）
 * @param {number} opts.max      窗口内允许的次数上限
 * @param {number} [opts.maxKeys] 键数量上限（超了顺手清一遍过期项，防 Map 无界增长）
 */
export function createRateLimiter({ windowMs, max, maxKeys = 2000 }) {
  /** @type {Map<string, {count:number, until:number}>} */
  const store = new Map();

  const sweep = (t) => {
    for (const [k, v] of store) if (v.until <= t) store.delete(k);
  };

  /** 只看状态、不计数 */
  const peek = (key) => {
    const rec = store.get(key);
    if (!rec) return { limited: false, retryAfterMs: 0, count: 0 };
    const t = Date.now();
    if (rec.until <= t) {
      store.delete(key);
      return { limited: false, retryAfterMs: 0, count: 0 };
    }
    return {
      limited: rec.count >= max,
      retryAfterMs: Math.max(0, rec.until - t),
      count: rec.count,
    };
  };

  /** 记一次（无论成败），返回计数后的状态 */
  const hit = (key, weight = 1) => {
    const t = Date.now();
    let rec = store.get(key);
    if (!rec || rec.until <= t) rec = { count: 0, until: t + windowMs };
    rec.count += weight;
    store.set(key, rec);
    if (store.size > maxKeys) sweep(t);
    return {
      limited: rec.count >= max,
      retryAfterMs: Math.max(0, rec.until - t),
      count: rec.count,
    };
  };

  const reset = (key) => store.delete(key);

  return { peek, hit, reset, max, windowMs };
}

/** 取客户端地址；反代后端请配 Fastify trustProxy，否则这里拿到的是代理 IP。 */
export function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/** 429 的标准响应体（带 retryAfter 秒数，前端可提示「X 分钟后再试」） */
export function tooMany(reply, retryAfterMs, msg = '尝试过于频繁，请稍后再试') {
  const sec = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return reply
    .code(429)
    .header('retry-after', String(sec))
    .send({ error: `${msg}（约 ${Math.ceil(sec / 60)} 分钟后重试）`, retryAfter: sec });
}
