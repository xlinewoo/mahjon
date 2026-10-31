// 路由共用小工具（俱乐部成员 / 权限）
import db from '../db.js';

export function clubById(id) {
  return db.prepare('SELECT * FROM clubs WHERE id = ?').get(id);
}

export function membershipOf(clubId, userId) {
  return db.prepare('SELECT * FROM club_members WHERE club_id = ? AND user_id = ?').get(clubId, userId);
}

export function publicClub(row) {
  return { id: row.id, name: row.name, ownerId: row.owner_id, createdAt: row.created_at };
}

/**
 * 名称校验（俱乐部名 / 牌桌名共用，2026-10-29 P2）
 *
 * 旧实现：只判空 —— 长度随便填、字符随便填（可以塞 10 万个字符，也可以塞一坨 HTML）。
 * 现在补两道上限：**长度 1~24**（前端 input 也是 maxlength=24）+ **禁控制字符与尖括号**。
 * 前端已做 HTML 转义，这里再从源头掐掉一批「看起来像标签」的输入，
 * 避免把纯前端转义当成唯一防线。
 */
export function textNameProblem(raw, label = '名称') {
  const s = String(raw ?? '').trim();
  if (!s) return `${label}不能为空`;
  if (s.length > 24) return `${label}最多 24 个字符`;
  if (/[\u0000-\u001f\u007f<>]/.test(s)) return `${label}不能包含控制字符或 < >`;
  return null;
}

/** owner / admin 才能管理成员 */
export function canManage(member) {
  return !!member && (member.role === 'owner' || member.role === 'admin');
}
