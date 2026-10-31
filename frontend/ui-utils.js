/**
 * 前端**公共小工具** —— 单机 / 网络两套引导入口与各渲染模块共用（2026-10-17）
 *
 * 这三样此前在 `render.js` 与 `net-main.js`（现 net-lobby.js）里各抄了一份（`$` / `esc` / `flash`），
 * 口径还不完全一致（`esc` 对 null 处理不同；`flash` 超时 1.6s vs 1.8s，且各持一个
 * timer，同一颗 `#flash` 元素被两套 timer 抢——先响的那次会被后设的覆盖）。此处收拢成一份：
 *   · `esc`   取更稳的 **null-safe** 版（undefined/null → 空串，不会渲染出 "undefined"）。
 *   · `flash` 统一 **1600ms**（原 render.js 口径）并**共用同一个 timer**，消除抢元素隐患。
 */

/** 元素查找 */
export const $ = (id) => document.getElementById(id);

/**
 * HTML 转义（用于拼 innerHTML 字符串；null/undefined → ''）
 *
 * 2026-10-29：补齐 `'` 与 `` ` `` —— 旧版只转 `& < > "`，一旦有人把用户名/俱乐部名插进
 * **单引号包裹**的属性（`data-name='${esc(x)}'`），带单引号的输入就能闭合属性注入。
 * 目前代码里都是双引号属性，但转义函数不该依赖「调用方恰好用双引号」这种约定。
 */
export const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"'`]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;',
  }[c]));

let flashTimer = null;
/** 底部控制条上的一次性提示（默认 1.6 秒后自动消失） */
export function flash(msg, ms = 1600) {
  const el = $('flash');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.hidden = true; }, ms);
}
