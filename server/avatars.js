// 头像：预设集 + 上传落盘
// 第三方 URL 头像为可开关的扩展点（ALLOW_THIRD_PARTY_AVATAR，默认关闭），符合自托管/合规取向。
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { writeFile, readFile } from 'node:fs/promises';
import { dirname, resolve, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 与 db.js 共用同一数据根：DATA_DIR 覆盖，默认 server/data
const dataDir = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : resolve(__dirname, 'data');
export const avatarsDir = resolve(dataDir, 'avatars');
try {
  mkdirSync(avatarsDir, { recursive: true });
} catch (e) {
  // 受管/沙箱环境下 broker 可能偶发拒绝 mkdir（CODEBUDDY_BROKER_DENY）。
  // 目录已存在时无害；目录真的不存在时下面 saveUploadedAvatar 写入会明确报错。
  if (e && e.code !== 'CODEBUDDY_BROKER_DENY') throw e;
}

/**
 * 预设头像库（老吴 2026-10-25：icon/ 文件夹的图片，经 tools/build-avatar-presets.mjs
 * 规范化为 96×96 WebP，落在 server/assets/avatars/，经 /api/avatars/preset/<id>.webp 服务）。
 * id = 去扩展名的文件名；清单在 server/assets/avatars/index.json（构建脚本产出）。
 */
const presetDir = resolve(__dirname, 'assets', 'avatars');
export const avatarsPresetDir = presetDir;

let _presetIds = [];
try {
  _presetIds = JSON.parse(readFileSync(join(presetDir, 'index.json'), 'utf8'));
} catch {
  // 构建产物缺失（未跑 tools/build-avatar-presets.mjs）→ 空库，注册头像可不选
  _presetIds = [];
}

export const AVATAR_PRESETS = _presetIds;
export const presetAvatarUrl = (id) => `/api/avatars/preset/${encodeURIComponent(String(id))}.webp`;

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
export const ALLOWED_MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

export const allowThirdPartyAvatar = () => process.env.ALLOW_THIRD_PARTY_AVATAR === 'true';

/**
 * 按**文件魔数**判断真实图片类型（2026-10-29，P2 安全项）。
 *
 * 旧实现只信客户端 multipart 里声明的 `mimetype` —— 那是攻击者随便填的字符串。
 * 塞一个 `<svg onload=...>` 改名成 .png 上传，服务端就把它当 png 存下来，
 * 再由 /api/avatars/file/<name> 以 image/png 吐给所有玩家（同一批 localStorage token
 * 的受害者会被盗号）。现在：先看字节，再看声明，两边必须同时落在白名单里。
 */
export function sniffImageType(buf) {
  if (!buf || buf.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // GIF: "GIF87a" / "GIF89a"
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  // WebP: "RIFF" .... "WEBP"
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** 保存上传头像 → 文件名 `<uid>.<ext>`（同 uid 覆盖旧的） */
export async function saveUploadedAvatar(uid, buffer, mimetype) {
  const ext = ALLOWED_MIME_EXT[mimetype];
  if (!ext) throw new Error('不支持的图片格式（仅 png / jpg / webp / gif）');
  if (!buffer || buffer.length === 0) throw new Error('空文件');
  if (buffer.length > MAX_AVATAR_BYTES) throw new Error('图片过大（上限 2MB）');
  const real = sniffImageType(buffer);
  if (!real || real !== mimetype) {
    throw new Error('文件内容不是合法的 png / jpg / webp / gif 图片');
  }
  const name = `${uid}${ext}`;
  await writeFile(resolve(avatarsDir, name), buffer);
  return name;
}

/** 读取头像文件；防目录穿越：只接受纯文件名（basename 必须等于原名） */
export async function readAvatarFile(name) {
  const raw = String(name);
  if (basename(raw) !== raw) return null; // 含路径分隔符 → 拒绝
  try {
    return await readFile(resolve(avatarsDir, raw));
  } catch {
    return null;
  }
}

/** 读取预设头像文件（<id>.webp）；同样只接受纯文件名 */
export function readPresetAvatarFile(name) {
  const raw = String(name);
  if (basename(raw) !== raw || raw.includes('..')) return null;
  try {
    return readFileSync(resolve(presetDir, raw));
  } catch {
    return null;
  }
}

/** 由文件名推断 Content-Type */
export function mimeOfName(name) {
  const ext = ('.' + String(name).split('.').pop()).toLowerCase();
  const hit = Object.entries(ALLOWED_MIME_EXT).find(([, e]) => e === ext);
  return hit ? hit[0] : ext === '.webp' ? 'image/webp' : 'application/octet-stream';
}
