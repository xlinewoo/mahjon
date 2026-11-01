// 最小 service worker：仅用于满足 PWA「可安装」条件（安卓 Chrome 的「安装应用」提示）。
// 不做任何离线缓存——本游戏强依赖实时 WebSocket 牌局同步与账号 API，缓存只会惹祸。
// fetch 事件必须声明（Chrome 安装条件之一），但不拦截、不 respondWith，全部透传。
self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', () => {
  // 透传：浏览器按默认网络行为处理（含 WebSocket 握手与 API 请求）。
});
