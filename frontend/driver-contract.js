/**
 * driver 契约（形式化，2026-10-24）—— render.js 只管画，谁提供 view、点了按钮怎么推进由 driver 决定。
 *
 * 三个实现必须对齐：
 *   · frontend/game-loop.js  纯逻辑层（座位→方位、方位名、结算文案），被各 driver 与渲染层共用
 *   · frontend/net-driver.js createNetDriver()   网络（socket.io，服务端权威）
 *   · frontend/replay.js     driverFor(replay)    回放（复算式驱动，动作安全降级）
 *
 * 此前契约只活在 net-driver.js 头部注释里，回放驱动已经出现过形状漂移；
 * 现在由 assertDriver 在 render.js 的 setGame 入口做一次形状护栏（缺成员只警告不抛错，
 * 契约是开发期护栏，不是运行期闸门——回放/降级场景允许部分成员为空）。
 */

/**
 * @typedef {object} Driver
 * @property {Record<number,string>} seatToDir        座位 → 方位（'东'|'南'|'西'|'北'）
 * @property {{dealer:number, entries?:Array|null}} winds 摸风结果；网络/回放 entries=null（不弹摸风面板）
 * @property {() => number} actingSeat               当前该谁行动；settled 返回 -1
 * @property {() => boolean} isMyTurn                是否轮到「我」（回放恒 false）
 * @property {() => object} getView                  我的视角快照（viewFor 的形状，见 src/engine/game.js）
 * @property {() => object|null} getTenpai           听牌分析（单机本地算 / 网络服务端下发 / 回放 null）
 * @property {object} ruleset                        房间规则（前端只用到 claimTimeoutMs 等）
 * @property {boolean} autoPassLocally               true = 前端负责「超时自动过」（单机）；false = 服务端兜底
 * @property {number} [MY_SEAT]                      我的引擎座位（0..3；net/回放驱动提供）
 * @property {(action: object) => Promise<void>} [act]  发动作（回放无此成员，动作为空操作）
 * @property {() => Promise<void>} [ready]           准备下一局（回放无此成员）
 * @property {() => Promise<void>} [detach]          离桌退订（回放无此成员）
 */

/** 契约必查成员：对象型 / 函数型 / 布尔型 */
export const DRIVER_CONTRACT_KEYS = [
  'seatToDir', 'winds', 'actingSeat', 'isMyTurn', 'getView', 'getTenpai', 'ruleset', 'autoPassLocally',
];

/**
 * 校验 driver 形状；缺成员 console.warn（带发生位置），原样返回 driver。
 * @param {Driver} driver
 * @param {string} [where] 诊断前缀（如 'setGame'）
 */
export function assertDriver(driver, where = '') {
  if (!driver || typeof console === 'undefined') return driver;
  const missing = [];
  for (const key of DRIVER_CONTRACT_KEYS) {
    const v = driver[key];
    const kind = key === 'ruleset' || key === 'seatToDir' || key === 'winds' ? 'value' : 'fn';
    const ok = kind === 'value' ? v != null : typeof v === 'function';
    if (!ok) missing.push(key);
  }
  if (missing.length) {
    console.warn(`[driver 契约]${where ? ' ' + where : ''} 缺少成员: ${missing.join(', ')}`);
  }
  return driver;
}
