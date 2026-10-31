# 网络对战模式 · 技术设计（阶段 0–4 蓝图）

> 服务端权威，复用现有 engine：`act(state, action)` 纯函数推进、`viewFor(state, seat)` 按座位下发视图。
> 网络层只做「收意图 → 推进 → 广播视图」。单机版（`frontend/`）保持不变。

## 1. 总体架构

```
浏览器/客户端 ──HTTPS(S)──▶ Fastify REST（账号/俱乐部/牌桌/规则）
        │
        └──WebSocket(Socket.IO /play)──▶ 牌桌会话 Room（每桌一个，持有 state）
                                            │ 调 act() 推进
                                            │ 调 viewFor() 按座位裁剪
                                            └──▶ 广播 table:state
```

- 鉴权：JWT（access token 短期）。REST 与 WS 都校验。
- 持久化：SQLite 单文件（`server/data/mahjon.db`）。运行时牌局状态存内存（按 tableId 索引），用于断线重连。
- 合规红线不变：**不做充值 / 金币 / 兑换**。

## 2. 目录结构

```
server/
  index.js            # Fastify 入口 + 挂载 REST/Socket
  db.js               # SQLite 初始化 + 表迁移
  auth.js             # bcrypt 注册/登录校验、JWT 签发/校验中间件
  avatars.js          # 预设头像集 + 上传落盘
  routes/
    auth.js           # 注册/登录/登出/me/改头像
    clubs.js          # 俱乐部 CRUD + 成员管理
    tables.js         # 牌桌 CRUD + 规则配置
  ws/
    index.js          # Socket.IO 网关：鉴权、按 tableId 路由到 Room
    room.js           # 单张牌桌游戏会话（座位、ready、state、act 转发、重连）
src/engine/...        # 直接复用（act / viewFor / rules / createRuleSet）
docs/netplay-design.md
```

## 3. 数据模型（SQLite）

```sql
users(
  id INTEGER PK,
  username TEXT UNIQUE,
  password_hash TEXT,
  avatar_type TEXT,        -- 'preset' | 'upload' | 'url'
  avatar_value TEXT,       -- preset:id | upload:文件名 | url:https...
  created_at INTEGER
);

clubs(
  id INTEGER PK,
  name TEXT,
  owner_id INTEGER,        -- users.id
  created_at INTEGER
);

club_members(
  club_id INTEGER,
  user_id INTEGER,
  role TEXT,               -- 'owner' | 'admin' | 'member'
  PRIMARY KEY(club_id, user_id)
);

tables(
  id INTEGER PK,
  club_id INTEGER,
  name TEXT,
  owner_id INTEGER,        -- 建桌者（房主）
  rule_json TEXT,          -- 完整 rules 对象（createRuleSet 规整后的）
  circle_count INTEGER,    -- 打几圈（默认 1 圈=4 把，按轮庄计）
  status TEXT,             -- 'idle' | 'waiting' | 'playing' | 'finished'
  created_at INTEGER
);
-- 运行时牌局状态不落库（内存），仅断线重连用；如需持久化再加 table_runtime 表。
```

## 4. 鉴权

- 注册：`bcrypt.hash(pw, 12)` 存 `password_hash`；用户名唯一校验。
- 登录：校验密码 → 签发 JWT（`{uid, username}`，`exp` 短期，如 7d；可选 refresh）。
- 中间件：`Authorization: Bearer <jwt>` 解出 `uid`，注入 `req.user`；WS 握手时从 `auth.token` 校验。
- 登出：客户端丢弃 token（无服务端黑名单，短期 token 足够）。

## 5. REST API

```
POST /api/auth/register   {username, password, avatar:{type,value}}  → {token, user}
POST /api/auth/login      {username, password}                       → {token, user}
GET  /api/me              → user（含头像）
POST /api/me/avatar       multipart 上传图片（type=upload）           → {avatar}
POST /api/clubs           {name}                                    → club（创建者=owner）
GET  /api/clubs           → 我参与的俱乐部列表
POST /api/clubs/:id/members {username, role?}                        → 邀请/加入（owner/admin）
GET  /api/clubs/:id/tables → 该俱乐部牌桌列表
POST /api/clubs/:id/tables {name, rules, circleCount}                → table（房主）
GET  /api/tables/:id      → 牌桌详情（含 rules）
PATCH /api/tables/:id/rules {rules}                                  → 更新规则（waiting 状态可改）
```

## 6. Socket.IO 事件协议（namespace `/play`）

客户端 → 服务端：
- `auth`        `{token}`
- `table:join`  `{tableId}`            —— 进入牌桌等候区
- `table:ready` `{}`                   —— 点「开始」（4 人齐 + 全 ready 才开局）
- `action`      `{type, ...}`          —— 出牌/吃/碰/杠/胡/过，原样透传给 `act(state, a)`
- `reconnect`   `{tableId, token}`     —— 断线重连

服务端 → 客户端：
- `table:players`  `{seats:[{userId,username,avatar,ready,seatIndex}]}`
- `table:started`  `{state 初始化信息}`
- `table:state`    `{view}`            —— 每步 `viewFor` 结果，按座位裁剪
- `action:result`  `{view, by, action}`
- `reconnect:ok`   `{view, seatIndex}` —— 重连成功拉取最新视图
- `error`          `{msg}`

> `viewFor` 已保证不下发别家手牌，只暴露张数；`phase==='settled'` 才给 `o.hand`。

## 7. 规则配置 ↔ rules.js 映射

- 前端提交 `rules` 对象（含记分表 `scoring.table`、各项开关、庄家/门槛等）。
- 服务端用 `createRuleSet(overrides)` 规整 + 校验（`rules.js` 的 `DEFAULTS` / `sanitize`），非法值回落默认。
- 存 `rule_json`；开局时 `createRuleSet(JSON.parse(rule_json))` 得到 `ruleset`。
- 牌桌专属：每桌独立 `ruleset` 实例（非全局常量），与单机版口径一致。
- `circleCount`：打几圈（每圈 4 把，东南西北各坐庄一次）；庄家胡牌 `gangFlag` 连庄（沿用 engine 逻辑）。

## 8. 轮庄与圈数

- 4 人进入同一牌桌并全部 `ready` → 服务端初始化 `state`，按座位顺序（或复用摸风定座）分配东南西北。
- 庄家胡牌 → 连庄（`nextDealer` 不变）；否则庄家下移（南→西→北→东）。
- 完成 `circleCount` 圈后 `status='finished'`，牌桌回到 `idle` 可再开。

## 9. 断线重连

- 服务端按 `tableId` 持有 Room 运行时（含 `state` 与各座位 `lastView`）。
- 玩家断线：Socket 断开，但 Room 与 `state` 保留；标记该座位 `disconnected`。
- 重连：`reconnect` 带 token → 校验 → 按 `uid` 找回座位 → 下发 `reconnect:ok {view}`（最新 `viewFor`）。
- 若断线时该玩家处于「需操作」阶段（claim 等待过/动作），重连后服务端把未决动作重新下发给该座位，客户端恢复操作界面。
- 长时间未重连（如 > N 分钟）可由房主踢出或判该局流局（后续迭代细化）。

## 10. 头像策略（选型结论）

- **预设（默认实现）**：服务端提供一组预设头像（emoji/图形 id 列表），注册/改头像时选 `preset:id`。
- **上传（实现）**：`POST /api/me/avatar` 上传图片，落地 `server/data/avatars/<uid>.<ext>`，DB 记 `avatar_type='upload', avatar_value=文件名`。
- **第三方 URL（扩展点）**：`avatar_type='url'` 字段保留，配置开关 `ALLOW_THIRD_PARTY_AVATAR` 默认 `false`（自托管/合规取向，无外部账号体系）。

## 11. 执行顺序与验证

1. **阶段0**：`server/` 骨架 + SQLite 建表 + 鉴权（bcrypt/JWT）+ REST 路由 + Socket 网关占位。验证：`node server/index.js` 起服务、`curl` 注册/登录拿 token。
2. **阶段1**：账号档案接口 + 头像（预设+上传）。验证：注册→登录→`/api/me` 返回头像；上传返回路径。
3. **阶段2**：俱乐部/牌桌 CRUD + 规则配置（接 `createRuleSet`）。验证：建俱乐部→建桌→配规则→`GET` 回显一致。
4. **阶段3**：Room 会话 + `table:join/ready/action` + `act/viewFor` 广播；4 人入桌开局。验证：用 4 个 ws 客户端脚本模拟 4 人走完一局。
5. **阶段4**：断线重连 + 抖动容错。验证：开局中断线→重连拉回最新 `view`；claim 阶段断线重连后能继续操作。

> 每阶段跑通后再进下一阶段；引擎纯函数（act/viewFor/rules）已在单机版测试守护，网络层只做胶水与广播。

## 12. 实现状态（2026-10-01）

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | SQLite 建表 + 鉴权（bcrypt/JWT）+ REST 骨架 | ✅ 已实现 |
| 1 | 账号档案（`/api/me`）+ 头像（预设 / 上传落盘 / URL 扩展点） | ✅ 已实现 |
| 2 | 俱乐部 / 牌桌 CRUD + 规则配置（接 `createRuleSet`） | ✅ 已实现 |
| 3 | Room 会话 + `table:join/ready/action` + `act/viewFor` 广播；4 人开局；多局轮庄/连庄/圈数 | ✅ 已实现 |
| 4 | 断线重连（保留 state，按 uid 找回座位） | ✅ 已实现 |

**已落地文件**

- REST：`server/routes/auth.js`、`server/routes/avatars.js`、`server/routes/clubs.js`、`server/routes/tables.js`、`server/routes/_helpers.js`、`server/auth.js`（含 `requireAuth` 中间件）、`server/avatars.js`（预设集 + 上传落盘 + 防目录穿越）。
- WS：`server/ws/room.js`（`Room` / `RoomManager`）、`server/ws/index.js`（Socket.IO 网关，`path=/play`），挂载于 `server/index.js`（`attachSocket(app.server)`）。
- 验证台：`server/public/console.html`（`GET /`），含账号 / 俱乐部 / 牌桌 / **一键模拟 4 人开局（真实 WS）**。

**口径落实**

- 4 人齐 + 全 `ready` 才开局；前 3 人 ready 不开局。
- 每桌独立 `ruleset`（`createRuleSet(rule_json)`）。
- 1 圈 = 4 把（东南西北各坐庄一次），`totalHands = circleCount × 4`。
- **连庄**：庄家胡牌则连庄（`dealer` 不变），否则顺移；**荒庄也顺移**（按老吴「庄家胡牌才延续当庄」字面）。
- 服务端兜底（两级）：
  1. `claim` 阶段超时（`claimTimeoutMs`，默认 8000ms）自动「过」—— 只覆盖**响应阶段**。
  2. **离席巡检**（`offlineAbsentMul` / `offlineDissolveMul`）—— 覆盖**出牌阶段**与**等下一把**这两处
     `claimTimeoutMs` 管不到的死锁：断线 ≥ `claimTimeoutMs × 3`（24s）转**托管**（服务器按
     `src/bot/simpleBot.js` 策略代打，牌局继续）；断线 ≥ `claimTimeoutMs × 15`（120s）判**离席**
     （请出离席者、本场作废、在线者原地留位）。判定全在 `Room.sweepOffline(now)`（纯决策、无定时器），
     定时器只在 `ws/index.js` 的 `armSweep()`，见 `server/test/room.test.js` 的假时间戳用例。
- 断线：座位与 `state` 保留（仅标 `connected=false` + 记 `offlineSince`），`reconnect` 按 `uid` 找回
  座位并补发最新 `viewFor`，同时**撤销托管**（`ack.wasAbsent` 告知前端「刚才是托管状态」）。
- 长断线相关事件（服务端 → 客户端）：`table:absent`（刚转托管，带 `seats` / `usernames` / `autoPlay`）、
  `table:resumed`（本人回来、托管撤销）、`table:dissolved`（判离席，带 `reason` / `evicted`）。
  `table:players` 的每个座位多了 `absent` / `botSteps`。

**启动 / 验证命令**

```bash
PORT=3000 node --experimental-sqlite server/index.js   # 起服务；浏览器开 http://127.0.0.1:3000
node --experimental-sqlite --test server/test/*.test.js # 后端回归（auth/clubs/room/avatar）
node tools/netplay-e2e.mjs                              # 4 个真实 WS 客户端端到端（含断线重连 + 长断线）
node tools/verify-net-e2e.mjs                           # 网络版前端：驱动契约 A 段 + net.html jsdom 冒烟 B 段
NET=1 node tools/viewport-check.mjs 320 360 390 414 720 # 无头 Chrome 逐段量横向溢出（含托管态）
```

**头像接口**：`GET /api/avatars`（预设集 + 上传限制 + 第三方开关）、`POST /api/me/avatar`（multipart，字段 `file`，≤2MB，png/jpg/webp/gif → `server/data/avatars/<uid>.<ext>`）、`PUT /api/me/avatar`（`{type:'preset'|'url', value}`，URL 受 `ALLOW_THIRD_PARTY_AVATAR` 控制默认关闭）、`GET /api/avatars/file/:name`（读取，防目录穿越）。

**待办**：Docker 镜像真机构建验证（本机沙箱无 docker）；跨局「原赖 → 分数 ×2」的玩家提示。
