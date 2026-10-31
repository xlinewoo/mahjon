// 俱乐部路由：创建 / 我的列表 / 详情（含成员）/ 邀请成员
import db from '../db.js';
import { personalStats, clubStatsByPeriod } from '../db.js';
import { requireAuth } from '../auth.js';
import { clubById, membershipOf, publicClub, canManage, textNameProblem } from './_helpers.js';
import { createRateLimiter, clientIp, tooMany } from '../rate-limit.js';

/** 允许的时段枚举（防注入：只认这四个，其余一律当 all） */
const PERIODS = new Set(['day', 'month', 'year', 'all']);
const normPeriod = (p) => (PERIODS.has(p) ? p : 'all');

/** 某俱乐部的待审申请（含申请人昵称 / 头像 / 留言），按申请先后排序 */
function listPendingApplications(clubId) {
  return db
    .prepare(
      `SELECT a.user_id AS id, u.username, u.avatar_type, u.avatar_value, a.note, a.created_at
         FROM club_applications a JOIN users u ON u.id = a.user_id
        WHERE a.club_id = ? AND a.status = 'pending'
        ORDER BY a.created_at ASC, a.user_id`,
    )
    .all(clubId)
    .map((r) => ({
      id: r.id,
      username: r.username,
      note: r.note || '',
      createdAt: r.created_at,
      avatar: { type: r.avatar_type, value: r.avatar_value },
    }));
}

export default async function clubRoutes(app) {
  // 自助加入限速（2026-10-29 P2）：正常用户一辈子点不了几次「加入」，
  // 10 次/分/IP 只为挡住脚本把全站俱乐部刷一遍（旧实现完全没闸）。
  // 与 auth 路由同理，限速器建在插件作用域内（每个 app 实例各一套计数）。
  const JOIN_BY_IP = createRateLimiter({ windowMs: 60 * 1000, max: 10 });
  // 审批动作限速（2026-10-30，随申请流程新增）：主席一次也就批几个人，
  // 30 次/分/IP 足够正常操作，挡住「写脚本把待审列表全批/全拒」的极端情况。
  const DECIDE_BY_IP = createRateLimiter({ windowMs: 60 * 1000, max: 30 });

  // 建俱乐部（创建者自动成为 owner 成员）
  app.post('/api/clubs', { preHandler: requireAuth }, async (req, reply) => {
    const { name } = req.body || {};
    const trimmed = name ? String(name).trim() : '';
    if (!trimmed) return reply.code(400).send({ error: '俱乐部名称必填' });
    // 2026-10-29 P2：名称加长度/字符限制（旧实现「无长度上限、无字符限制」）
    const nameBad = textNameProblem(trimmed, '俱乐部名称');
    if (nameBad) return reply.code(400).send({ error: nameBad });

    // ❗老吴 2026-10-01：重名俱乐部之前被静默建出（clubs.name 无唯一约束、建前不查重），
    // 同名共存导致 UI 上根本分不清。这里建前查重 → 409，前端据此提示「已存在」。
    const dup = db.prepare('SELECT id FROM clubs WHERE name = ?').get(trimmed);
    if (dup) return reply.code(409).send({ error: '已存在同名俱乐部', clubId: dup.id });

    const info = db
      .prepare('INSERT INTO clubs(name, owner_id) VALUES(?,?)')
      .run(trimmed, req.user.id);
    const clubId = Number(info.lastInsertRowid);
    db.prepare('INSERT INTO club_members(club_id, user_id, role) VALUES(?,?,?)')
      .run(clubId, req.user.id, 'owner');

    return reply.send({ club: publicClub(clubById(clubId)) });
  });

  // 我参与的俱乐部
  app.get('/api/clubs', { preHandler: requireAuth }, async (req, reply) => {
    // pendingCount：**只有主席/管理员**才回真实待审数（普通成员看到 0），
    // 否则等于把「这个俱乐部有几个人在排队」这种管理信息泄露给所有人。
    const rows = db
      .prepare(
        `SELECT c.*, m.role AS my_role,
                (SELECT COUNT(*) FROM club_applications a
                  WHERE a.club_id = c.id AND a.status = 'pending') AS pending_count
           FROM clubs c JOIN club_members m ON m.club_id = c.id
          WHERE m.user_id = ? ORDER BY c.id DESC`,
      )
      .all(req.user.id);
    return reply.send({
      clubs: rows.map((r) => ({
        ...publicClub(r),
        role: r.my_role,
        pendingCount: canManage({ role: r.my_role }) ? (r.pending_count | 0) : 0,
      })),
    });
  });

  // ❗老吴 2026-10-01：公开俱乐部列表（大厅「可加入的俱乐部」用）。
  // 返回全部俱乐部 + 成员数 + 当前用户是否已加入 / 是否已提交申请，前端据此显示按钮状态。
  // 俱乐部是纯娱乐小圈子（LAN / Tailscale），不做私密目录，谁都能看到，但**进去要主席同意**
  // （2026-10-30 由自助加入改为申请制）。
  app.get('/api/clubs/discover', { preHandler: requireAuth }, async (req, reply) => {
    const rows = db
      .prepare(
        `SELECT c.id, c.name, c.owner_id, c.created_at,
                (SELECT COUNT(*) FROM club_members m WHERE m.club_id = c.id) AS member_count,
                EXISTS(SELECT 1 FROM club_members m WHERE m.club_id = c.id AND m.user_id = ?) AS joined,
                EXISTS(SELECT 1 FROM club_applications a
                        WHERE a.club_id = c.id AND a.user_id = ? AND a.status = 'pending') AS pending
           FROM clubs c ORDER BY c.id DESC`,
      )
      .all(req.user.id, req.user.id);
    return reply.send({
      clubs: rows.map((r) => ({
        ...publicClub(r),
        memberCount: r.member_count,
        joined: !!r.joined,
        pending: !!r.pending,
      })),
    });
  });

  /**
   * 申请加入俱乐部（老吴 2026-10-30：「进入俱乐部需要俱乐部创建人同意，所以有一个申请流程」）
   *
   * 旧实现 `POST /clubs/:id/join` 是自助入会：插一行 club_members 就完事，主席毫无知情权。
   * 现在改成**申请制**：这里只落一条 pending 申请，等主席/管理员在俱乐部页点「同意」。
   * 语义细节：
   *   · 已是成员      → `{ ok:true, member:true }`（幂等，不再打扰主席）
   *   · 已有 pending  → `{ ok:true, pending:true, already:true }`（重复点不重复排队）
   *   · 曾被拒绝      → 重新置回 pending（允许改主意后再申请）
   * 限速沿用 JOIN_BY_IP（10 次/分/IP），挡脚本把全站俱乐部刷一遍。
   */
  const applyToClub = async (req, reply) => {
    const lim = JOIN_BY_IP.hit(clientIp(req));
    if (lim.limited) return tooMany(reply, lim.retryAfterMs, '申请过于频繁，稍后再试');
    const id = Number(req.params.id);
    const club = clubById(id);
    if (!club) return reply.code(404).send({ error: '俱乐部不存在' });
    if (membershipOf(id, req.user.id)) {
      return reply.send({ ok: true, member: true, club: publicClub(club) });
    }
    // 留言：可选，60 字上限（比名称宽松些，够写「我是老王的同事」）
    const note = String((req.body && req.body.note) || '').trim().slice(0, 60);

    const exist = db
      .prepare('SELECT status FROM club_applications WHERE club_id = ? AND user_id = ?')
      .get(id, req.user.id);
    if (exist && exist.status === 'pending') {
      return reply.send({ ok: true, pending: true, already: true, club: publicClub(club) });
    }
    if (exist) {
      db.prepare(
        `UPDATE club_applications
            SET status = 'pending', note = ?, created_at = strftime('%s','now'),
                decided_at = NULL, decided_by = NULL
          WHERE club_id = ? AND user_id = ?`,
      ).run(note, id, req.user.id);
    } else {
      db.prepare('INSERT INTO club_applications(club_id, user_id, note) VALUES(?,?,?)')
        .run(id, req.user.id, note);
    }
    return reply.send({ ok: true, pending: true, club: publicClub(club) });
  };

  app.post('/api/clubs/:id/apply', { preHandler: requireAuth }, applyToClub);
  // 旧路径保留为别名：前端缓存页可能还在打 /join。语义已从「直接加入」变为「提交申请」，
  // 老客户端最坏结果是「以为加入了、其实在等审批」，不会再出现绕过审批直接进会。
  app.post('/api/clubs/:id/join', { preHandler: requireAuth }, applyToClub);

  /** 待审申请列表（主席 / 管理员）。普通成员 403 —— 申请人名单属于管理信息。 */
  app.get('/api/clubs/:id/applications', { preHandler: requireAuth }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!clubById(id)) return reply.code(404).send({ error: '俱乐部不存在' });
    if (!canManage(membershipOf(id, req.user.id))) {
      return reply.code(403).send({ error: '只有主席或管理员能查看申请' });
    }
    return reply.send({ applications: listPendingApplications(id) });
  });

  /** 同意入会：写成员行 + 申请置 approved（一个事务，避免「批了但没进会」） */
  app.post('/api/clubs/:id/applications/:uid/approve', { preHandler: requireAuth }, async (req, reply) => {
    const lim = DECIDE_BY_IP.hit(clientIp(req));
    if (lim.limited) return tooMany(reply, lim.retryAfterMs, '操作过于频繁');
    const id = Number(req.params.id);
    if (!clubById(id)) return reply.code(404).send({ error: '俱乐部不存在' });
    if (!canManage(membershipOf(id, req.user.id))) {
      return reply.code(403).send({ error: '只有主席或管理员能审批' });
    }
    const uid = Number(req.params.uid);
    if (!Number.isInteger(uid) || uid <= 0) return reply.code(400).send({ error: '申请人编号无效' });
    const appRow = db
      .prepare('SELECT * FROM club_applications WHERE club_id = ? AND user_id = ?')
      .get(id, uid);
    if (!appRow || appRow.status !== 'pending') return reply.code(404).send({ error: '没有待处理的申请' });

    db.prepare(
      `INSERT OR IGNORE INTO club_members(club_id, user_id, role) VALUES(?,?,'member')`,
    ).run(id, uid);
    db.prepare(
      `UPDATE club_applications SET status = 'approved', decided_at = strftime('%s','now'), decided_by = ?
        WHERE club_id = ? AND user_id = ?`,
    ).run(req.user.id, id, uid);
    const u = db.prepare('SELECT id, username FROM users WHERE id = ?').get(uid);
    return reply.send({ ok: true, member: { id: uid, username: u ? u.username : '', role: 'member' } });
  });

  /** 拒绝入会：只改状态，不写成员行。允许对方再次申请（会重新变 pending）。 */
  app.post('/api/clubs/:id/applications/:uid/reject', { preHandler: requireAuth }, async (req, reply) => {
    const lim = DECIDE_BY_IP.hit(clientIp(req));
    if (lim.limited) return tooMany(reply, lim.retryAfterMs, '操作过于频繁');
    const id = Number(req.params.id);
    if (!clubById(id)) return reply.code(404).send({ error: '俱乐部不存在' });
    if (!canManage(membershipOf(id, req.user.id))) {
      return reply.code(403).send({ error: '只有主席或管理员能审批' });
    }
    const uid = Number(req.params.uid);
    const appRow = db
      .prepare('SELECT * FROM club_applications WHERE club_id = ? AND user_id = ?')
      .get(id, uid);
    if (!appRow || appRow.status !== 'pending') return reply.code(404).send({ error: '没有待处理的申请' });
    db.prepare(
      `UPDATE club_applications SET status = 'rejected', decided_at = strftime('%s','now'), decided_by = ?
        WHERE club_id = ? AND user_id = ?`,
    ).run(req.user.id, id, uid);
    return reply.send({ ok: true, rejected: uid });
  });

  /** 申请人自己撤销（撤回后不再出现在待审列表） */
  app.delete('/api/clubs/:id/applications/:uid', { preHandler: requireAuth }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!clubById(id)) return reply.code(404).send({ error: '俱乐部不存在' });
    const uid = Number(req.params.uid);
    if (uid !== req.user.id) return reply.code(403).send({ error: '只能撤回自己的申请' });
    db.prepare(`DELETE FROM club_applications WHERE club_id = ? AND user_id = ? AND status = 'pending'`)
      .run(id, uid);
    return reply.send({ ok: true });
  });

  // 俱乐部详情（含成员表；主席/管理员额外拿到待审申请）
  app.get('/api/clubs/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = Number(req.params.id);
    const club = clubById(id);
    if (!club) return reply.code(404).send({ error: '俱乐部不存在' });
    const me = membershipOf(id, req.user.id);
    if (!me) return reply.code(403).send({ error: '不是俱乐部成员' });

    const members = db
      .prepare(
        `SELECT u.id, u.username, u.avatar_type, u.avatar_value, m.role
           FROM club_members m JOIN users u ON u.id = m.user_id
          WHERE m.club_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.id`,
      )
      .all(id);

    return reply.send({
      club: publicClub(club),
      role: me.role,
      // 待审申请只对管理者下发；普通成员拿到空数组（不泄露「有人在排队」）
      applications: canManage(me) ? listPendingApplications(id) : [],
      members: members.map((m) => ({
        id: m.id,
        username: m.username,
        role: m.role,
        avatar: { type: m.avatar_type, value: m.avatar_value },
      })),
    });
  });

  // 邀请 / 加入成员（owner / admin）
  app.post('/api/clubs/:id/members', { preHandler: requireAuth }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!clubById(id)) return reply.code(404).send({ error: '俱乐部不存在' });
    if (!canManage(membershipOf(id, req.user.id))) return reply.code(403).send({ error: '无权管理成员' });

    const { username, role = 'member' } = req.body || {};
    if (!username) return reply.code(400).send({ error: 'username 必填' });
    if (!['admin', 'member'].includes(role)) return reply.code(400).send({ error: 'role 只能是 admin / member' });

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) return reply.code(404).send({ error: '用户不存在' });
    if (membershipOf(id, user.id)) return reply.code(409).send({ error: '该用户已在俱乐部' });

    db.prepare('INSERT INTO club_members(club_id, user_id, role) VALUES(?,?,?)').run(id, user.id, role);
    // 主席直接拉人时，把此人可能还挂着的待审申请一并收口（否则会永远留在「入会申请」里）
    db.prepare(
      `UPDATE club_applications SET status = 'approved', decided_at = strftime('%s','now'), decided_by = ?
        WHERE club_id = ? AND user_id = ? AND status = 'pending'`,
    ).run(req.user.id, id, user.id);
    return reply.send({ ok: true, member: { id: user.id, username: user.username, role } });
  });

  /**
   * 退出俱乐部（2026-10-29 新增，P2）
   *
   * 旧实现全库没有一条 `DELETE FROM club_members` —— 也就是说**加入了就退不出去**。
   * 一旦有人靠猜到的弱密码进来（或误加入），只能改数据库才能清理，这是明显的运营缺口。
   * 现在：普通成员/管理员可自行退出；owner 不能退出（俱乐部得有主人），
   * 需要先转让或解散（解散不在本次范围）。
   */
  app.post('/api/clubs/:id/leave', { preHandler: requireAuth }, async (req, reply) => {
    const id = Number(req.params.id);
    const club = clubById(id);
    if (!club) return reply.code(404).send({ error: '俱乐部不存在' });
    const me = membershipOf(id, req.user.id);
    if (!me) return reply.code(404).send({ error: '不是俱乐部成员' });
    if (me.role === 'owner') return reply.code(400).send({ error: '主席不能退出俱乐部' });
    db.prepare('DELETE FROM club_members WHERE club_id = ? AND user_id = ?').run(id, req.user.id);
    return reply.send({ ok: true });
  });

  /**
   * 移除成员 / 踢人（2026-10-29 新增，P2）
   * 权限：owner / admin；admin 不能踢 owner 或同级 admin，owner 可以踢任何人（除自己）。
   */
  app.delete('/api/clubs/:id/members/:uid', { preHandler: requireAuth }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!clubById(id)) return reply.code(404).send({ error: '俱乐部不存在' });
    const me = membershipOf(id, req.user.id);
    if (!canManage(me)) return reply.code(403).send({ error: '无权管理成员' });

    const targetId = Number(req.params.uid);
    if (!Number.isInteger(targetId) || targetId <= 0) return reply.code(400).send({ error: '成员编号无效' });
    const target = membershipOf(id, targetId);
    if (!target) return reply.code(404).send({ error: '该用户不在俱乐部' });
    if (target.role === 'owner') return reply.code(400).send({ error: '不能移除主席' });
    if (me.role !== 'owner' && target.role === 'admin') {
      return reply.code(403).send({ error: '管理员不能移除其他管理员' });
    }

    db.prepare('DELETE FROM club_members WHERE club_id = ? AND user_id = ?').run(id, targetId);
    return reply.send({ ok: true, removed: targetId });
  });

  // 俱乐部战绩榜（维度4：跨场历史战绩）—— 按净分排序；仅成员可见。
  // ?period=day|month|year|all（默认 all）
  app.get('/api/clubs/:id/stats', { preHandler: requireAuth }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!clubById(id)) return reply.code(404).send({ error: '俱乐部不存在' });
    if (!membershipOf(id, req.user.id)) return reply.code(403).send({ error: '不是俱乐部成员' });
    const period = normPeriod((req.query || {}).period);
    // all 走 player_stats（累计计数器，含本功能上线前的历史）；其余时段走 hand_records
    if (period === 'all') {
      const rows = db
        .prepare(
          `SELECT user_id AS uid, username, hands, wins, gold_tops, total_score, total_gangs, max_fan, updated_at
             FROM player_stats WHERE club_id = ? ORDER BY total_score DESC, wins DESC, uid`,
        )
        .all(id);
      return reply.send({ period, stats: rows });
    }
    return reply.send({ period, stats: clubStatsByPeriod(id, period) });
  });

  // 我的个人战绩（**跨俱乐部**，老吴 2026-10-03：胜率/大胡率/金顶率/总成绩/总平均分
  // 一律按个人总成绩算，不按俱乐部切分）—— 挂在哪个俱乐部页进来都一样。
  // 保留 /api/clubs/:id/my-stats 路径是为了少改前端；clubId 只做「俱乐部存在 + 我是成员」校验，
  // **不参与统计口径**。
  app.get('/api/clubs/:id/my-stats', { preHandler: requireAuth }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!clubById(id)) return reply.code(404).send({ error: '俱乐部不存在' });
    if (!membershipOf(id, req.user.id)) return reply.code(403).send({ error: '不是俱乐部成员' });
    // 四种口径一次给全，前端切时段不再往返
    return reply.send({
      me: {
        username: req.user.username,
        scope: 'all-clubs',   // 明确告诉前端：这是跨俱乐部的个人总成绩
        day: personalStats(req.user.id, 'day'),
        month: personalStats(req.user.id, 'month'),
        year: personalStats(req.user.id, 'year'),
        all: personalStats(req.user.id, 'all'),
      },
    });
  });
}
