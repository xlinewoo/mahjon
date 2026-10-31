// 应用工厂：创建并配置 Fastify 实例（不在此处 listen，便于测试用 app.inject）
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import authRoutes from './routes/auth.js';
import avatarRoutes from './routes/avatars.js';
import clubRoutes from './routes/clubs.js';
import tableRoutes from './routes/tables.js';
import replayRoutes from './routes/replays.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const consoleHtml = readFileSync(resolve(__dirname, 'public/console.html'), 'utf8');
/** 前端产物（`node frontend/build.mjs` 生成）：3D 网络版单文件内联，无需静态目录 */
const builtHtml = {
  // ⚠️ 2026-10-19：默认「网络版」已切换为 **3D 客户端**（Three.js 牌桌，数据驱动；
  //    服务端权威不变）。2D 网络版已于 2026-10-25 下线删除（老吴拍板：3D 页不要 2D 部分）。
  '/app': resolve(__dirname, '..', 'frontend', 'build', 'net3d.html'),      // 3D 网络版（默认入口）
  '/app/net': resolve(__dirname, '..', 'frontend', 'build', 'net3d.html'),  // 网络版（3D 牌桌）
  '/app/net3d': resolve(__dirname, '..', 'frontend', 'build', 'net3d.html'),// 3D 网络版（显式别名，同 /app/net）
};

export async function createApp() {
  const app = Fastify({ logger: false });

  /**
   * 安全响应头（2026-10-29，P2 安全项）
   *
   * 之前一个都没有：无 CSP ⇒ XSS 没有第二道防线；无 X-Frame-Options ⇒ 可被任意站点
   * iframe 套住做点击劫持；无 nosniff ⇒ 上传的「伪图片」可能被浏览器当脚本执行。
   *
   * CSP 说明：
   *   · script-src 必须带 'unsafe-inline' —— 前端是 esbuild 打成的**单文件内联**产物，
   *     没有外链 js 可加 nonce/hash（改了构建方式就没这问题，暂不值当）。
   *   · connect-src 放 ws:/wss: —— Socket.IO 走同源 WebSocket。
   *   · frame-ancestors 'self' —— 登录页用 iframe 嵌本站的 /logo-card，必须留同源。
   */
  const CSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'SAMEORIGIN');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('permissions-policy', 'geolocation=(), microphone=(), camera=()');
    const ct = String(reply.getHeader('content-type') || '');
    if (ct.includes('text/html')) reply.header('content-security-policy', CSP);
    // HSTS 只在真 HTTPS 下发（局域网 http 明文访问发了也没用，反而容易在调试时把自己锁死）
    if (req.protocol === 'https') {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    return payload;
  });

  app.get('/health', async () => ({ ok: true, ts: Date.now() }));

  // 首页 = 正常游戏入口（老吴 2026-10-28：电脑/手机打开 / 都进 3D 网络版，不再落验证台）；
  // 验证台改为**显式进入**：/console 或 /?debug=1（加参数进调试页）。
  const serveConsole = async (req, reply) => {
    reply.header('cache-control', 'no-cache');
    reply.type('text/html; charset=utf-8').send(consoleHtml);
  };
  // serveGame 在**请求时**才解引用 serveBuilt（下面才定义，模块顶层提前调用会 TDZ 报错）
  const serveGame = (req, reply) => serveBuilt('/app/net')(req, reply);
  app.get('/', async (req, reply) => {
    const dbg = req.query && (req.query.debug === '1' || req.query.debug === 'true');
    return dbg ? serveConsole(req, reply) : serveGame(req, reply);
  });
  app.get('/console', serveConsole);

  // 前端页面：单文件内联（含牌面 base64 与 socket.io-client），部署后无需任何外部静态资源
  // 柒鞗會 logo 卡观看器（老吴 2026-10-25）：静态服务 logo-card/web/，登录页 iframe 嵌入
  const logoWebDir = resolve(__dirname, '..', 'logo-card', 'web');
  const LOGO_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.glb': 'model/gltf-binary', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bin': 'application/octet-stream' };
  const serveLogoFile = (rel) => {
    const file = resolve(logoWebDir, rel);
    if (!file.startsWith(logoWebDir) || !existsSync(file)) return null;
    const ext = ('.' + file.split('.').pop()).toLowerCase();
    return { file, type: LOGO_TYPES[ext] || 'application/octet-stream' };
  };
  app.get('/logo-card', (req, reply) => {
    const hit = serveLogoFile('index.html');
    if (!hit) return reply.code(404).send({ error: 'logo 观看器未构建' });
    return reply.type(hit.type).send(readFileSync(hit.file));
  });
  app.get('/logo-card/*', (req, reply) => {
    const rel = decodeURIComponent(req.url.replace(/^\/logo-card\//, '').split('?')[0]) || 'index.html';
    const hit = serveLogoFile(rel);
    if (!hit) return reply.code(404).send({ error: 'not found' });
    return reply.type(hit.type).send(readFileSync(hit.file));
  });

  const serveBuilt = (path) => async (req, reply) => {
    const file = builtHtml[path];
    if (!existsSync(file)) {
      return reply.code(404).send({ error: '前端尚未构建，请先运行：node frontend/build.mjs' });
    }
    // ❗单文件页面必须每次回源校验（老吴 2026-10-24）：手机浏览器对无缓存头的 HTML
    //   会疏忽缓存，更新后用户拿到的还是旧页面（「修复了但手机没变化」的根源）。
    reply.header('cache-control', 'no-cache');
    reply.type('text/html; charset=utf-8').send(readFileSync(file, 'utf8'));
  };
  app.get('/app', serveBuilt('/app'));
  app.get('/app/net', serveBuilt('/app/net'));
  app.get('/app/net3d', serveBuilt('/app/net3d'));
  // PWA manifest（手机「添加到主屏幕」后无地址栏；见 net3d.html head）
  app.get('/manifest.webmanifest', async (req, reply) => {
    reply.header('cache-control', 'no-cache');
    reply.type('application/manifest+json; charset=utf-8')
      .send(readFileSync(resolve(__dirname, 'public', 'manifest.webmanifest'), 'utf8'));
  });
  // 兼容直接访问骨架名（便于本地开发时用 /net.html 打开调试）
  app.get('/net3d.html', serveBuilt('/app/net3d'));


  await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
  await app.register(authRoutes);
  await app.register(avatarRoutes);
  await app.register(clubRoutes);
  await app.register(tableRoutes);
  await app.register(replayRoutes);

  return app;
}
