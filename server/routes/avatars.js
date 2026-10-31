// 头像路由：预设列表 / 上传（multipart）/ 选预设或 URL / 读取上传文件
import db from '../db.js';
import { requireAuth } from '../auth.js';
import {
  AVATAR_PRESETS,
  MAX_AVATAR_BYTES,
  ALLOWED_MIME_EXT,
  saveUploadedAvatar,
  readAvatarFile,
  readPresetAvatarFile,
  presetAvatarUrl,
  mimeOfName,
  allowThirdPartyAvatar,
} from '../avatars.js';

export default async function avatarRoutes(app) {
  // 头像元信息（预设集 + 每个预设的 url + 上传限制 + 第三方开关）
  app.get('/api/avatars', async () => ({
    presets: AVATAR_PRESETS,
    urls: Object.fromEntries(AVATAR_PRESETS.map((id) => [id, presetAvatarUrl(id)])),
    upload: { maxBytes: MAX_AVATAR_BYTES, types: Object.keys(ALLOWED_MIME_EXT) },
    thirdPartyEnabled: allowThirdPartyAvatar(),
  }));

  // 预设头像文件（<id>.webp；防目录穿越，只收纯文件名）
  app.get('/api/avatars/preset/:file', async (req, reply) => {
    const buf = readPresetAvatarFile(req.params.file);
    if (!buf) return reply.code(404).send({ error: '头像不存在' });
    reply.type(mimeOfName(req.params.file)).send(buf);
  });

  // 上传头像（multipart/form-data，字段名 file）
  app.post('/api/me/avatar', { preHandler: requireAuth }, async (req, reply) => {
    if (!req.isMultipart || !req.isMultipart()) return reply.code(400).send({ error: '请用 multipart/form-data 上传（字段名 file）' });
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: '缺少文件（字段名 file）' });

    let name;
    try {
      name = await saveUploadedAvatar(req.user.id, await data.toBuffer(), data.mimetype);
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
    db.prepare('UPDATE users SET avatar_type = ?, avatar_value = ? WHERE id = ?').run('upload', name, req.user.id);
    return reply.send({ avatar: { type: 'upload', value: name }, url: `/api/avatars/file/${name}` });
  });

  // 选预设 / 自定义 URL（JSON）
  app.put('/api/me/avatar', { preHandler: requireAuth }, async (req, reply) => {
    const { type, value } = req.body || {};

    if (type === 'preset') {
      if (!AVATAR_PRESETS.includes(String(value))) return reply.code(400).send({ error: '未知的预设头像' });
      db.prepare('UPDATE users SET avatar_type = ?, avatar_value = ? WHERE id = ?').run('preset', String(value), req.user.id);
      return reply.send({ avatar: { type: 'preset', value: String(value) } });
    }

    if (type === 'url') {
      if (!allowThirdPartyAvatar()) return reply.code(403).send({ error: '第三方头像未启用（ALLOW_THIRD_PARTY_AVATAR=false）' });
      if (!/^https?:\/\//i.test(String(value))) return reply.code(400).send({ error: 'URL 需以 http(s):// 开头' });
      db.prepare('UPDATE users SET avatar_type = ?, avatar_value = ? WHERE id = ?').run('url', String(value), req.user.id);
      return reply.send({ avatar: { type: 'url', value: String(value) } });
    }

    return reply.code(400).send({ error: 'type 只能是 preset / url（上传请走 multipart POST）' });
  });

  // 读取上传的头像文件
  app.get('/api/avatars/file/:name', async (req, reply) => {
    const buf = await readAvatarFile(req.params.name);
    if (!buf) return reply.code(404).send({ error: '头像不存在' });
    reply.type(mimeOfName(req.params.name)).send(buf);
  });
}
