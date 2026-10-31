// 网络对战后端入口：REST（账号/俱乐部/牌桌）+ Socket.IO（牌局同步，path=/play）
import { createApp } from './app.js';
import { attachSocket } from './ws/index.js';

const app = await createApp();

// Socket.IO 挂在 Fastify 底层 http server 上，与 REST 同端口
attachSocket(app.server);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

try {
  await app.listen({ port: PORT, host: HOST });
  console.log(`✅ 网络对战服务已启动：http://${HOST}:${PORT}`);
} catch (err) {
  console.error('启动失败：', err);
  process.exit(1);
}
