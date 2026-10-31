// 鉴权工具：bcrypt 密码哈希 + JWT 签发/校验
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import db from './db.js';

// ❗不再有硬编码兜底密钥（2026-10-24 安全项）：忘配 JWT_SECRET 时改用**本次启动的随机密钥**，
//   所有令牌重启即失效——比一个全网皆知的 'dev-only-secret-change-me' 安全得多（后者任何人可伪造 token）。
//   生产环境务必通过环境变量注入持久密钥。
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = randomBytes(32).toString('hex');
  console.warn('[安全] 未配置 JWT_SECRET：本次启动使用随机临时密钥，重启后所有登录态失效（生产必须配置）');
}
const SALT_ROUNDS = 12;
const TOKEN_TTL = process.env.TOKEN_TTL || '7d';

export function hashPassword(pw) {
  return bcrypt.hash(pw, SALT_ROUNDS);
}

export function verifyPassword(pw, hash) {
  return bcrypt.compare(pw, hash);
}

export function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

export function verifyToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// 从请求头提取 Bearer token
export function tokenFromHeader(req) {
  const h = req.headers.authorization || '';
  return h.replace(/^Bearer\s+/i, '') || null;
}

/* ------------------------------------------------------------------ */
/* 令牌撤销（2026-10-29，P1 安全项）                                     */
/*                                                                     */
/* JWT 是无状态的：签出去就管不了。旧实现下 token 一旦泄露（例如任意一次   */
/* XSS 从 localStorage 偷走），在 7 天有效期内**无法踢下线**，也没有改密接口。*/
/* 这里给 users 加一列 token_version：                                   */
/*   · 签发时把当前版本写进载荷（tv）                                    */
/*   · 校验时拿库里的版本比对，不等即视为已撤销                          */
/*   · 改密 / 登出 → 版本 +1 ⇒ 该账号**所有**已签发令牌立刻失效           */
/* 代价是每次鉴权多一次主键查询（本地 SQLite，微秒级），换来可吊销，值得。  */
/* ------------------------------------------------------------------ */

export function tokenVersionOf(uid) {
  const row = db.prepare('SELECT token_version FROM users WHERE id = ?').get(uid);
  return row ? (row.token_version ?? 0) : null;
}

/** 令牌整体作废（改密 / 登出）。返回递增后的版本号。 */
export function bumpTokenVersion(uid) {
  db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(uid);
  return tokenVersionOf(uid);
}

/**
 * 校验令牌 **并** 比对版本；通过返回 `{ id, username }`，否则 null。
 * 与 `verifyToken` 的区别：后者只验签名（不碰库），适合「解析载荷」这类非鉴权场景。
 */
export function userFromToken(token) {
  const payload = verifyToken(token);
  if (!payload) return null;
  const row = db
    .prepare('SELECT id, username, token_version FROM users WHERE id = ?')
    .get(payload.uid);
  if (!row) return null;
  // 老令牌没有 tv 字段 → 视为版本 0（与老库默认值一致，不会一上线就把所有人踢掉）
  if ((payload.tv ?? 0) !== (row.token_version ?? 0)) return null;
  return { id: row.id, username: row.username };
}

/**
 * Fastify preHandler：校验 Bearer token（含撤销比对），成功注入 `req.user = { id, username }`。
 * 失败直接 401 返回（返回 reply 后 Fastify 不再进入 handler）。
 * 用法：`app.get('/x', { preHandler: requireAuth }, handler)`
 */
export async function requireAuth(req, reply) {
  const user = userFromToken(tokenFromHeader(req));
  if (!user) return reply.code(401).send({ error: '未登录' });
  req.user = user;
}
