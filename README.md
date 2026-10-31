# 武汉红中赖子杠麻将 · 3D 网络版

基于**服务端权威引擎**（零依赖、可单测）的武汉麻将实时对战。4 名真人通过浏览器连入同一房间，服务端判定一切，前端仅做渲染与动画。规则口径以 `src/engine/rules.js` 为准，引擎测试覆盖全部边界。

---

## 一、游戏规则

### 1.1 用牌与特殊牌
- 一副 **136 张**：万 / 条 / 筒 各 1–9（序数牌）+ 东南西北中发白（字牌），各 4 张。
- **红中**：固定杠牌，**不能吃、不能碰、不能胡**，但可单独杠（红中杠 +1 番）；持有红中时本局不得胡牌。
- **癞子（赖子）**：每局翻底牌按规则推进确定，是**万能牌**——可在手牌里顶任意牌凑顺子 / 刻子 / 将；但**不能折算成面子、不算开口、不能暗杠**。
- **皮子**：癞子往回数 2 张，再加红中，共 3 种；持有不能胡、不吃不碰、可单独杠。

### 1.2 定座与出牌方向（摸风定座）
- 四家入座后各抽一张牌比大小，**最大者坐东做庄**；点数相同则重抽，直至分出大小。
- 出牌方向**逆时针：东 → 北 → 西 → 南**；首盘从东家开始出牌。
- 每局（含续庄）复用同一庄家，无需重复摸风。
- 玩家自身恒在**主视觉（屏幕下方）**，其余三家依次在右 / 上 / 左，对应方位随座位轮转。

### 1.3 胡牌与牌型
- **小胡**：需 2 / 5 / 8 作将；手里癞子不超过 1 张。
- **大胡（5 种牌型）**：碰碰胡 / 清一色 / 将一色 / 风一色 / 全求人。
- **大胡（3 种情境）**：杠上开花 / 海底捞（尾墩第 7 墩）/ 抢杠胡。每种 +3 番底，可累计。
- 武汉麻将**无七对、无门前清**。
- **可胡可过**：自摸 / 点炮 / 抢杠三种来路一律成立，可选择「过」。

### 1.4 番数与计分
- 分段计分表（非 2ⁿ 相乘）；起胡门槛：小胡 6 番 / 大胡 3 番，三家都够才许胡。
- 每家输分按「该家自身番 + 赢家总番」查表；**金顶**（三家全封顶或风一色）每家付封顶分。
- 附加番：庄 / 自摸 / 放冲 / 硬胡 各 +1；吃碰每口 +1；冲杠 · 蓄杠 · 暗杠 · 癞子杠 每口 +2；红中杠 · 皮子杠 每口 +1。
- 大胡**不算**庄家番；原赖 / 风赖 不额外加番，改为该家应付分 ×2（乘在查表之后）。

### 1.5 成就（封顶触发，牌局继续）
- **七皮**：杠出来的红中 + 皮子合计 7 张，达成者从其余三家各收 10 分 × 番倍率。
- **十杠**：加权杠口累计 10 口（蓄杠 · 暗杠 · 癞子杠各 2 口），奖金同七皮。

### 1.6 其他关键规则
- **抢杠胡**：蓄杠可被抢（明杠不可），被抢者承包独付。
- **包牌**：抢杠包 / 全求人点炮包（放炮者全手将时免）/ 清将一色第三句包。
- **基本两口**：非赢家须杠出 2 张皮 / 红中，否则有人胡牌时包胡（确实凑不出不包）。
- **乱将 / 乱风**：全手牌（含副露）全 2 / 5 / 8 → 将一色；全字牌 → 风一色（风一色直接金顶）。

---

## 二、可配置参数

服务通过环境变量配置。复制模板后按需修改（`.env` 已被 `.gitignore` 排除，不会入库）：

```bash
cp .env.example .env
```

| 变量 | 默认 | 说明 |
|---|---|---|
| `JWT_SECRET` | `change-me-...` | **生产必改**，登录令牌签名密钥；生成 `openssl rand -hex 32`；改了旧 token 全失效 |
| `TOKEN_TTL` | `7d` | 登录令牌有效期 |
| `PORT` | `3000` | 容器内 / 裸机监听端口 |
| `HOST` | `0.0.0.0` | 监听地址；只本机调试可设 `127.0.0.1` |
| `DATA_DIR` | `server/data` | 数据目录（账号库 + 头像）；Docker 内固定 `/data`，务必挂卷 |
| `CORS_ORIGIN` | 空（回显来源） | 前后端不同源时填白名单，逗号分隔 |
| `ALLOW_THIRD_PARTY_AVATAR` | `false` | 是否允许头像填第三方 URL |
| `TZ` | 系统 | 时区，建议 `Asia/Shanghai` |
| `MAHJON_PORT` | `3000` | **Docker 专用** 宿主机端口映射（如 13000） |
| `DATA_PATH` | 空 | **Docker 专用** 数据卷绑定目录；留空用具名卷 `mahjon-data` |
| `NPM_REGISTRY` | 官方源 | 构建期 npm 源，国内建议 `https://registry.npmmirror.com` |

**运行环境要求**
- **Node >= 20**，推荐 **22 LTS**；Node 22 启动需带 `--experimental-sqlite`（仓库的 `npm start`、Dockerfile、systemd 单元已带此标志）。
- 数据落本地 SQLite（`node:sqlite`），无外部数据库依赖。

---

## 三、部署方式

### 3.1 本地开发与自测
```bash
npm install
npm run build          # 生成 frontend/build/net3d.html
npm start              # = node --experimental-sqlite server/index.js
```
浏览器打开 `http://localhost:3000/` 即进入 3D 网络版；`/?debug=1` 或 `/console` 进入验证台（注册 / 登录 / 俱乐部 / 牌桌 / 一键模拟开局）。
Socket.IO 端点为 **`/play`**（非默认 `/socket.io`），反代必须放行其 WebSocket 升级头。

入口路由（`server/app.js`，全部指向 3D 网络版产物）：

| 路径 | 内容 |
|---|---|
| `/` | 3D 网络版（默认游戏入口） |
| `/app` · `/app/net` · `/app/net3d` · `/net3d.html` | 同一份 3D 网络版产物的别名（方便本地调试直接开） |
| `/console` · `/?debug=1` | 验证台 |
| `/health` | 健康检查，返回 `{"ok":true,...}` |
| `/play` | Socket.IO 端点 |

### 3.2 Docker Compose（服务器 / NAS 首选）
```bash
cp .env.example .env && vi .env     # 至少把 JWT_SECRET 改成 openssl rand -hex 32 的结果
docker compose up -d --build
```
- **群晖 DSM 7.x**：Container Manager → 项目 → 选 `docker-compose.yml` 用「使用 docker-compose.yml」。数据目录属主需 `chown -R 1000:1000`。
- **威联通 QTS**：Container Station → 应用程序 → 粘贴 / 上传 `docker-compose.yml`。
- 容器内以 uid 1000 运行，绑定目录属主必须是 1000，否则 SQLite 报 `SQLITE_CANTOPEN`。

### 3.3 裸机 Linux（systemd）
```bash
sudo deploy/install.sh          # 自动建用户 / 装依赖 / 装服务并启动
journalctl -u mahjon -f         # 跟日志
```
适用有 systemd 的发行版（Debian / Ubuntu / CentOS / Rocky / Arch）；群晖 / 威联通无 systemd，请走 Docker。

### 3.4 网络访问
| 方式 | 做法 |
|---|---|
| 局域网 | 直接 `http://<内网IP>:3000` |
| 异地（无公网 IP） | Tailscale / ZeroTier，访问虚拟 IP:3000 |
| 域名 + HTTPS | Nginx / 群晖反代 + Let's Encrypt；反代须放行 `/play` 的 WebSocket 升级头与长超时（建议 `proxy_read_timeout 3600s`） |

### 3.5 数据备份 / 升级
- 备份只需数据目录（`mahjon.db` + 头像）；SQLite WAL 模式需 `mahjon.db` / `.db-wal` / `.db-shm` 一起拷。
- 升级：`docker compose up -d --build`，或裸机重跑 `sudo deploy/install.sh`；数据目录不受影响。

> 完整部署细节（Nginx 反代示例、排障 FAQ、一页速查）见 [`docs/deploy.md`](docs/deploy.md)。
