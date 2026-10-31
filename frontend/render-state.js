/**
 * 渲染层的**共享状态**（single source of truth）
 *
 * 为什么单列一个模块：
 *   `render.js` 从 1600+ 行往外拆时，被外提的渲染组（手牌 / 座位 / 结算 / 摸风 /
 *   统计…）都要读同一批「当前这帧是什么」的状态 —— 谁给的 game、draw 的哪份 view、
 *   选了哪张手牌、我坐哪、当前统计分页…。若让每个渲染模块各自持有一份，必然跑偏。
 *   所以把这份状态收拢到这里，`render.js` / `render-modals.js` 及后续拆出的渲染模块
 *   一律 `import { state, $ }` 读写，保证**只有一处**。
 *
 * 约定：
 *   · 本模块**只存状态，不写渲染逻辑**（元素查找 `$` / 转义 `esc` / 提示 `flash`
 *     这些公共小工具见 `ui-utils.js`）。
 *   · 对外公开的 setter 仍留在 `render.js`（`setGame` / `setView` / `setMySeat` …），
 *     引导入口（`main.js` / `net-lobby.js`，3D 入口 `net3d-main.js`）的用法完全不变。
 *   · 其它模块请**直接读写 `state.xxx`**，不要再定义同名的模块级 `let`。
 */

export const state = {
  /** 外部注入的驱动：网络 createNetDriver()（回放用 driverFor） */
  game: null,
  /** 当前这一帧的我的视角快照（setView 注入） */
  view: null,
  /** 选中的手牌（用于出牌确认） */
  selectedTile: null,
  /** 牌河展示模式：'seq' = 依次（按出牌先后） | 'seat' = 按家分组 */
  riverMode: 'seq',
  /**
   * 我坐哪个座位。人类视角恒为 0（本机约定）；网络版由服务端分配（0..3），入座后必须 setMySeat()，
   * 否则四方位环、牌河分组、「你」的标签都会指向错误的座位。
   */
  mySeat: 0,
  /** 顶栏「单机版 · 你=东 …」里的模式名 */
  modeLabel: '单机版',
  /**
   * 结算弹窗底部那颗按钮的文案。单机版＝「再来一局」；网络版要改成「准备下一局」
   * （牌桌是四人共享的，一个人点了只是自己 ready，不是立刻重开）。
   */
  newGameLabel: '再来一局',
  /** 外部注入的推进钩子；默认空实现，保证未 init 时也不会炸 */
  hooks: {
    onNewGame: () => {},
    onAction: async () => {},
  },
  /** 「单场战绩」聚合器（frontend/stats.js）；单机 / 网络各注入一个 */
  matchStats: null,
  /** 统计弹窗当前所在的分页：'score' = 本场战绩，'report' = 分析报表 */
  statsTab: 'score',
  /** 回放模式：禁用出牌/响应/倒计时/结算弹窗，只按回放帧绘制 */
  replay: false,
  /**
   * 是否渲染隐藏的 2D 牌桌表面（座位卡/中央牌河）。3D 网络版（net3d）设为 false ——
   * 2D 表面只服务于 2D 页面；3D 页若也渲染它，回放/对局会出现「2D 挤占 3D」的布局
   * （老吴 2026-10-25：3D 页彻底不要 2D 部分，游戏与回放都是）。
   * 注意：操作条/结算弹窗/听牌/倒计时/成就播报**不属于** 2D 表面，3D 页照常使用。
   */
  show2dTable: true,
  /** 回放时四家的真名/当前累计分（由 replay.js 每帧注入；非回放为 null） */
  replayNames: null,
  replayScores: null,
  gangNoDraw: false,
  actionPending: false,
};
