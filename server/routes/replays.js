// 牌局回放：个人跨俱乐部列表 / 俱乐部列表 / 单把详情（含完整动作日志）
import { requireAuth } from '../auth.js';
import {
  listHandReplaysForUser,
  listHandReplaysForClub,
  listReplaySessionsForUser,
  listReplaySessionsForClub,
  getHandReplay,
  replayAccess,
} from '../db.js';
import { clubById, membershipOf } from './_helpers.js';

/**
 * 俱乐部回放的两个口径（2026-10-29，P1 安全项）
 *
 * 能看**别人的**牌局回放的，只有 owner / admin；普通成员只看自己参与过的。
 * 这个判定必须与 `replayAccess()`、`listHandReplaysForClub(..., onlyUserId)` 完全一致，
 * 否则会出现「列表能点进去、详情 403」或者反过来的错位。
 */
function replayScope(clubId, userId) {
  const m = membershipOf(clubId, userId);
  if (!m) return null;
  const manager = m.role === 'owner' || m.role === 'admin';
  return { manager, onlyUserId: manager ? null : userId };
}

/** 列表分页：默认 50，最多 100；非法值回落默认值。 */
function pageOf(query = {}) {
  const n = Number(query.limit);
  const o = Number(query.offset);
  const limit = Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 100) : 50;
  const offset = Number.isFinite(o) ? Math.max(Math.trunc(o), 0) : 0;
  return { limit, offset };
}

function withPage(rows, limit, offset) {
  const hasMore = rows.length > limit;
  return { replays: hasMore ? rows.slice(0, limit) : rows, limit, offset, hasMore };
}

function withSessionPage(sessions, limit, offset) {
  const hasMore = sessions.length > offset + limit;
  return {
    sessions: sessions.slice(offset, offset + limit),
    limit,
    offset,
    hasMore,
  };
}

export default async function replayRoutes(app) {
  // 个人维度：我在**所有俱乐部**打过的全部牌局
  app.get('/api/replays/mine', { preHandler: requireAuth }, async (req, reply) => {
    const { limit, offset } = pageOf(req.query);
    const rows = listHandReplaysForUser(req.user.id, limit + 1, offset);
    return reply.send(withPage(rows, limit, offset));
  });

  // 个人维度（按场）：我在所有俱乐部参与过的每一场
  app.get('/api/replays/sessions/mine', { preHandler: requireAuth }, async (req, reply) => {
    const { limit, offset } = pageOf(req.query);
    const sessions = listReplaySessionsForUser(req.user.id);
    return reply.send(withSessionPage(sessions, limit, offset));
  });

  // 俱乐部维度（按场）：该俱乐部所有牌桌的每一场
  app.get('/api/clubs/:id/replays/sessions', { preHandler: requireAuth }, async (req, reply) => {
    const clubId = Number(req.params.id);
    if (!clubById(clubId)) return reply.code(404).send({ error: '俱乐部不存在' });
    const scope = replayScope(clubId, req.user.id);
    if (!scope) return reply.code(403).send({ error: '不是俱乐部成员' });

    const { limit, offset } = pageOf(req.query);
    const sessions = listReplaySessionsForClub(clubId, scope.onlyUserId);
    // 把口径回给前端：普通成员看到的列表是「仅我参与的」，UI 可以据此改标题文案
    return reply.send({
      ...withSessionPage(sessions, limit, offset),
      clubId,
      scope: scope.manager ? 'club' : 'self',
    });
  });

  // 俱乐部维度：该俱乐部所有牌桌的全部牌局
  app.get('/api/clubs/:id/replays', { preHandler: requireAuth }, async (req, reply) => {
    const clubId = Number(req.params.id);
    if (!clubById(clubId)) return reply.code(404).send({ error: '俱乐部不存在' });
    const scope = replayScope(clubId, req.user.id);
    if (!scope) return reply.code(403).send({ error: '不是俱乐部成员' });

    const { limit, offset } = pageOf(req.query);
    const rows = listHandReplaysForClub(clubId, limit + 1, offset, scope.onlyUserId);
    return reply.send({
      ...withPage(rows, limit, offset),
      clubId,
      scope: scope.manager ? 'club' : 'self',
    });
  });

  // 单把详情：本人参与过，或该俱乐部的 owner/admin（2026-10-29 收紧：普通成员不再能看别人的牌局）
  app.get('/api/replays/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: '回放编号无效' });

    const access = replayAccess(id, req.user.id);
    if (!access) return reply.code(404).send({ error: '回放不存在' });
    if (!access.allowed) return reply.code(403).send({ error: '无权查看该回放' });

    const replay = getHandReplay(id);
    if (!replay) return reply.code(404).send({ error: '回放不存在' });
    return reply.send({ replay });
  });
}
