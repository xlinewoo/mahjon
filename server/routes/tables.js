// 牌桌路由：建桌（含规则配置）/ 桌列表 / 桌详情 / 改规则
import db from '../db.js';
import { requireAuth } from '../auth.js';
import { createRuleSet } from '../../src/engine/rules.js';
import { clubById, membershipOf, publicClub, textNameProblem } from './_helpers.js';
import { rooms } from '../ws/room.js';

function publicTable(row) {
  return {
    id: row.id,
    clubId: row.club_id,
    name: row.name,
    ownerId: row.owner_id,
    circleCount: row.circle_count,
    status: row.status,
    rules: JSON.parse(row.rule_json || '{}'),
    createdAt: row.created_at,
  };
}

/** 用引擎 createRuleSet 规整 + 校验房主提交的规则；非法抛错 */
function buildRuleSet(rules = {}) {
  const preset = rules.preset || 'koukou';
  return createRuleSet(preset, rules);
}

function tableRow(id) {
  return db.prepare('SELECT * FROM tables WHERE id = ?').get(id);
}

export default async function tableRoutes(app) {
  // 建桌（老吴 2026-10-24：创建人＝俱乐部主席，只有主席能摆桌；每俱乐部最多 4 桌）
  app.post('/api/clubs/:id/tables', { preHandler: requireAuth }, async (req, reply) => {
    const clubId = Number(req.params.id);
    const club = clubById(clubId);
    if (!club) return reply.code(404).send({ error: '俱乐部不存在' });
    const membership = membershipOf(clubId, req.user.id);
    if (!membership) return reply.code(403).send({ error: '不是俱乐部成员' });
    if (membership.role !== 'owner') return reply.code(403).send({ error: '只有俱乐部主席能摆桌' });
    const existing = db.prepare('SELECT COUNT(*) AS n FROM tables WHERE club_id = ?').get(clubId).n;
    if (existing >= 4) {
      return reply.code(400).send({ error: `每个俱乐部最多摆 4 桌（已有 ${existing} 桌）` });
    }

    const { name, rules = {}, circleCount = 1 } = req.body || {};
    if (!name || !String(name).trim()) return reply.code(400).send({ error: '牌桌名称必填' });
    // 2026-10-29 P2：牌桌名同样加长度/字符限制（原来只判空）
    const nameBad = textNameProblem(String(name).trim(), '牌桌名称');
    if (nameBad) return reply.code(400).send({ error: nameBad });
    const cc = Number(circleCount);
    if (!Number.isInteger(cc) || cc < 1 || cc > 10) return reply.code(400).send({ error: '圈数须为 1-10 的整数' });

    let ruleset;
    try {
      ruleset = buildRuleSet(rules);
    } catch (e) {
      return reply.code(400).send({ error: '规则不合法：' + e.message });
    }

    const info = db
      .prepare('INSERT INTO tables(club_id, name, owner_id, rule_json, circle_count, status) VALUES(?,?,?,?,?,?)')
      .run(clubId, String(name).trim(), req.user.id, JSON.stringify(ruleset), cc, 'idle');

    return reply.send({ table: publicTable(tableRow(Number(info.lastInsertRowid))) });
  });

  // 俱乐部下的牌桌列表
  app.get('/api/clubs/:id/tables', { preHandler: requireAuth }, async (req, reply) => {
    const clubId = Number(req.params.id);
    if (!clubById(clubId)) return reply.code(404).send({ error: '俱乐部不存在' });
    if (!membershipOf(clubId, req.user.id)) return reply.code(403).send({ error: '不是俱乐部成员' });
    const rows = db.prepare('SELECT * FROM tables WHERE club_id = ? ORDER BY id DESC').all(clubId);
    return reply.send({ club: publicClub(clubById(clubId)), tables: rows.map(publicTable) });
  });

  // 桌详情（含完整规则）
  app.get('/api/tables/:id', { preHandler: requireAuth }, async (req, reply) => {
    const row = tableRow(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: '牌桌不存在' });
    if (!membershipOf(row.club_id, req.user.id)) return reply.code(403).send({ error: '不是该俱乐部成员' });
    return reply.send({ table: publicTable(row) });
  });

  // 改规则（仅房主；牌局进行中不可改）
  app.patch('/api/tables/:id/rules', { preHandler: requireAuth }, async (req, reply) => {
    const row = tableRow(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: '牌桌不存在' });
    if (row.owner_id !== req.user.id) return reply.code(403).send({ error: '只有房主能改规则' });
    if (!['idle', 'waiting'].includes(row.status)) return reply.code(409).send({ error: '牌局进行中不能改规则' });

    const { rules = {}, circleCount } = req.body || {};
    let ruleset;
    try {
      ruleset = buildRuleSet(rules);
    } catch (e) {
      return reply.code(400).send({ error: '规则不合法：' + e.message });
    }
    let cc = row.circle_count;
    if (circleCount !== undefined) {
      cc = Number(circleCount);
      if (!Number.isInteger(cc) || cc < 1 || cc > 10) return reply.code(400).send({ error: '圈数须为 1-10 的整数' });
    }
    db.prepare('UPDATE tables SET rule_json = ?, circle_count = ? WHERE id = ?')
      .run(JSON.stringify(ruleset), cc, row.id);
    return reply.send({ ok: true, table: publicTable(tableRow(row.id)) });
  });

  /**
   * 删除牌桌（2026-10-31 新增）：仅房主；桌上有任何人时拒绝。
   * 「桌上有人」以内存房间是否存在为准（`rooms.get(tableId)`）——DB 的 tables.status
   * 区分不了「已入座未开局」与「空桌」，所以用房间单例判定。
   * 级联删该桌回放（hand_replays，外键 table_id）；**保留 hand_records**（个人战绩，
   * 且 hand_records 无 table_id 列、不受本操作外键影响）。
   */
  app.delete('/api/tables/:id', { preHandler: requireAuth }, async (req, reply) => {
    const row = tableRow(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: '牌桌不存在' });
    if (row.owner_id !== req.user.id) return reply.code(403).send({ error: '只有房主能删除牌桌' });
    // 桌上有任何人（已入座/进行中）→ 拒绝删除
    if (rooms.get(row.id)) return reply.code(409).send({ error: '牌桌还有人在玩，请等人离桌后再删' });
    db.prepare('DELETE FROM hand_replays WHERE table_id = ?').run(row.id);
    db.prepare('DELETE FROM tables WHERE id = ?').run(row.id);
    return reply.send({ ok: true });
  });
}
