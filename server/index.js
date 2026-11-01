// 网络对战后端入口：REST（账号/俱乐部/牌桌）+ Socket.IO（牌局同步，path=/play）
import { createApp } from './app.js';
import { attachSocket } from './ws/index.js';
import { readFileSync, existsSync } from 'node:fs';

// 复用路由器申请的 Let's Encrypt 证书（域名 xlinewoo.eu.org / *.xlinewoo.eu.org）。
// 证书由部署脚本从路由器同步进容器 /opt/mahjon/tls/；路径可用环境变量覆盖。
// 找不到证书时回退到纯 HTTP（容错，避免证书缺失直接起不来）。
function loadTls() {
  const cert = process.env.MAHJON_TLS_CERT || '/opt/mahjon/tls/fullchain.pem';
  const key = process.env.MAHJON_TLS_KEY || '/opt/mahjon/tls/privkey.pem';
  if (!existsSync(cert) || !existsSync(key)) {
    console.log('[tls] 未找到证书，回退到 HTTP 模式');
    return null;
  }
  try {
    return { cert: readFileSync(cert), key: readFileSync(key) };
  } catch (e) {
    console.error('[tls] 读取证书失败，回退 HTTP：', e.message);
    return null;
  }
}

const tls = loadTls();
const app = await createApp(tls ? { https: tls } : {});

// Socket.IO 挂在 Fastify 底层 server 上（http 或 https，取决于是否注入证书），与 REST 同端口
attachSocket(app.server);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

try {
  await app.listen({ port: PORT, host: HOST });
  console.log(`✅ 网络对战服务已启动：${tls ? 'https' : 'http'}://${HOST}:${PORT}`);
} catch (err) {
  console.error('启动失败：', err);
  process.exit(1);
}
