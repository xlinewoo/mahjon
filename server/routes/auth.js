// 账号路由：注册 / 登录 / 当前用户 / 登出 / 改密
import db from '../db.js';
import {
  hashPassword,
  verifyPassword,
  signToken,
  userFromToken,
  tokenFromHeader,
  tokenVersionOf,
  bumpTokenVersion,
} from '../auth.js';
import { AVATAR_PRESETS } from '../avatars.js';
import { createRateLimiter, clientIp, tooMany } from '../rate-limit.js';

/* ------------------------------------------------------------------ */
/* 输入校验                                                            */
/* ------------------------------------------------------------------ */

const MIN_PASSWORD = 8;
// bcrypt 只取前 72 字节，超出部分静默丢弃 → 直接拒绝，避免「设了长密码但只有前 72 字节生效」
const MAX_PASSWORD_BYTES = 72;

/** 密码策略（注册 / 改密共用）；返回错误文案或 null */
function passwordProblem(pw) {
  const s = String(pw ?? '');
  if (s.length < MIN_PASSWORD) return `密码至少 ${MIN_PASSWORD} 位`;
  if (Buffer.byteLength(s, 'utf8') > MAX_PASSWORD_BYTES) {
    return `密码过长（最多 ${MAX_PASSWORD_BYTES} 字节）`;
  }
  return null;
}

/** 注册输入校验（用户名长度/字符集、密码策略、头像必须来自预设库） */
function validateRegister({ username, password, avatar }) {
  const name = String(username ?? '').trim();
  if (!name) return '用户名和密码必填';
  if (name.length < 2 || name.length > 24) return '用户名需 2~24 个字符';
  // 汉字/字母/数字/下划线/点/连字符，杜绝纯符号与控制字符
  if (!/^[\w\u4e00-\u9fa5.\-]+$/.test(name)) return '用户名只能含汉字、字母、数字、_ . -';
  const pwBad = passwordProblem(password);
  if (pwBad) return pwBad;
  if (avatar != null) {
    if (avatar.type !== 'preset' || !AVATAR_PRESETS.includes(String(avatar.value))) {
      return '头像必须是预设库里的一个（列表见 /api/avatars）';
    }
  }
  return null;
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    avatar: { type: row.avatar_type, value: row.avatar_value },
  };
}

/** 签发令牌：必须带上当前 token_version，否则改密/登出后自己也被踢 */
function issueToken(row) {
  const tv = row.token_version ?? 0;
  return signToken({ uid: row.id, username: row.username, tv });
}

export default async function authRoutes(app) {
  /**
   * 限速（2026-10-29 重做，P1 安全项）
   *
   * ⚠️ 限速器建在**插件作用域内**（不是模块级单例）：每个 app 实例一套计数，
   *    单测里每个 test 各 new 一个 app，互不把对方的桶打满。
   *
   * 旧实现只有一个「按 IP 记失败」的桶，且**登录成功会无条件清零**——攻击者只要有自己的
   * 账号，就能「猜 9 次 → 登录自己的号清零 → 无限循环」，限速形同虚设。
   *
   * 现在分三层，全部**只清自己那一把钥匙**，不互相清零：
   *   ① ip|用户名   8 次/15 分  —— 挡住「换代理池也猜同一个账号」的定向爆破
   *   ② 用户名      20 次/15 分 —— 挡住「多 IP 分布式猜同一个账号」
   *   ③ ip          40 次/15 分 —— 挡住「一个 IP 广撒网猜一堆账号」
   * 成功登录只 reset ①（同一 IP 对自己账号手滑几次后输对，理应恢复；别人的计数不受影响）。
   */
    const W = 15 * 60 * 1000;
    const LOGIN_BY_IP_USER = createRateLimiter({ windowMs: W, max: 8 });
    const LOGIN_BY_USER = createRateLimiter({ windowMs: W, max: 20 });
    const LOGIN_BY_IP = createRateLimiter({ windowMs: W, max: 40 });
    // 30 次/小时/IP：够一屋子人各自用手机注册，又挡住脚本批量建号（bcrypt cost=12 也顺带
  // 让每次注册都要花 CPU，30 次/小时远不足以打满）。
  const REGISTER_BY_IP = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 30 });
    const EXISTS_BY_IP = createRateLimiter({ windowMs: 60 * 1000, max: 60 });
    const PWCHANGE_BY_USER = createRateLimiter({ windowMs: W, max: 10 });

    const loginKeys = (req, username) => {
    const ip = clientIp(req);
    const user = String(username ?? '').trim();
    return { ipUser: `${ip}|${user}`, user, ip };
  };

  /** 登录前检查三层桶（只读，不计数）；任一命中即返回该桶状态 */
  const loginBlocked = (req, username) => {
    const k = loginKeys(req, username);
    for (const [limiter, key] of [
      [LOGIN_BY_IP_USER, k.ipUser],
      [LOGIN_BY_USER, k.user],
      [LOGIN_BY_IP, k.ip],
    ]) {
      const r = limiter.peek(key);
      if (r.limited) return r;
    }
    return null;
  }

  /** 登录失败：三层桶各记一次 */
  const recordLoginFail = (req, username) => {
    const k = loginKeys(req, username);
    LOGIN_BY_IP_USER.hit(k.ipUser);
    LOGIN_BY_USER.hit(k.user);
    LOGIN_BY_IP.hit(k.ip);
  }

  /** 登录成功：只清「本 IP + 本账号」这一把钥匙（不清聚合桶，否则爆破计数被连带抹掉） */
  const recordLoginOk = (req, username) => {
    const k = loginKeys(req, username);
    LOGIN_BY_IP_USER.reset(k.ipUser);
  }

  // 注册：用户名 + 密码 + 头像（预设库二选一，默认 preset）
  app.post('/api/auth/register', async (req, reply) => {
    const reg = REGISTER_BY_IP.hit(clientIp(req));
    if (reg.limited) return tooMany(reply, reg.retryAfterMs, '注册过于频繁');
    const { username, password, avatar } = req.body || {};
    const invalid = validateRegister({ username, password, avatar });
    if (invalid) return reply.code(400).send({ error: invalid });

    const name = String(username).trim();
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(name)) {
      return reply.code(409).send({ error: '用户名已存在' });
    }

    const avatarType = (avatar && avatar.type) || 'preset';
    const avatarValue = (avatar && avatar.value) || '';
    const passwordHash = await hashPassword(password);
    const info = db
      .prepare('INSERT INTO users(username, password_hash, avatar_type, avatar_value) VALUES(?,?,?,?)')
      .run(name, passwordHash, avatarType, avatarValue);

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid));
    return reply.send({ token: issueToken(row), user: publicUser(row) });
  });

  // 用户名是否存在（登录页据此决定「直接登录」还是「转注册 + 确认密码」）。
  // 只回一个布尔：用户名在俱乐部成员列表里本就公开可见，无额外枚举风险；
  // 但仍加限速（60 次/分/IP），避免被当「全站用户名探测器」批量扫（P1）。
  app.post('/api/auth/exists', async (req, reply) => {
    const lim = EXISTS_BY_IP.hit(clientIp(req));
    if (lim.limited) return tooMany(reply, lim.retryAfterMs, '查询过于频繁');
    const name = String((req.body || {}).username ?? '').trim();
    if (!name) return reply.code(400).send({ error: '用户名必填' });
    return reply.send({ exists: !!db.prepare('SELECT id FROM users WHERE username = ?').get(name) });
  });

  // 登录
  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = req.body || {};
    if (!username || !password) return reply.code(400).send({ error: '用户名和密码必填' });

    const blocked = loginBlocked(req, username);
    if (blocked && blocked.limited) return tooMany(reply, blocked.retryAfterMs);

    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim());
    if (!row) {
      recordLoginFail(req, username);
      return reply.code(401).send({ error: '用户名或密码错误' });
    }

    const ok = await verifyPassword(password, row.password_hash);
    if (!ok) {
      recordLoginFail(req, username);
      return reply.code(401).send({ error: '用户名或密码错误' });
    }

    recordLoginOk(req, username);
    return reply.send({ token: issueToken(row), user: publicUser(row) });
  });

  // 当前登录用户（用于前端启动后拉档案）
  app.get('/api/me', async (req, reply) => {
    const user = userFromToken(tokenFromHeader(req));
    if (!user) return reply.code(401).send({ error: '未登录' });
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    if (!row) return reply.code(401).send({ error: '用户不存在' });
    return reply.send({ user: publicUser(row) });
  });

  /**
   * 登出（2026-10-29 新增，P1）：token_version +1 ⇒ **该账号已签发的所有令牌立即失效**。
   * 不是「只登出当前这台设备」—— JWT 无状态，做不到单设备吊销（除非另建设备表）。
   * 语义上按「我在别处可能泄露了 → 全部踢下线」更安全。
   */
  app.post('/api/auth/logout', async (req, reply) => {
    const user = userFromToken(tokenFromHeader(req));
    if (!user) return reply.code(401).send({ error: '未登录' });
    bumpTokenVersion(user.id);
    return reply.send({ ok: true });
  });

  /**
   * 改密（2026-10-29 新增，P1）：验旧密码 → 校验新密码策略 → 换哈希 → 令牌全部作废，
   * 并给当前会话补发一枚新令牌（否则改完自己也被踢出去）。
   */
  app.post('/api/auth/password', async (req, reply) => {
    const user = userFromToken(tokenFromHeader(req));
    if (!user) return reply.code(401).send({ error: '未登录' });

    const lim = PWCHANGE_BY_USER.hit(String(user.id));
    if (lim.limited) return tooMany(reply, lim.retryAfterMs, '改密尝试过于频繁');

    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) return reply.code(400).send({ error: '旧密码与新密码都必填' });
    const bad = passwordProblem(newPassword);
    if (bad) return reply.code(400).send({ error: bad });

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    if (!row) return reply.code(401).send({ error: '用户不存在' });

    const ok = await verifyPassword(oldPassword, row.password_hash);
    if (!ok) return reply.code(401).send({ error: '旧密码不正确' });
    if (String(oldPassword) === String(newPassword)) {
      return reply.code(400).send({ error: '新密码不能与旧密码相同' });
    }

    const hash = await hashPassword(newPassword);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
    bumpTokenVersion(user.id); // 旧令牌（含其他设备）全部失效
    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    return reply.send({ ok: true, token: issueToken(fresh), tv: tokenVersionOf(user.id) });
  });
}
