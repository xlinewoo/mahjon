# 部署指南 —— 武汉麻将 网络对战服务

本服务是 **REST（Fastify 5）+ WebSocket（Socket.IO，路径 `/play`）同端口**的单进程应用，
数据落本地 SQLite（`node:sqlite`）+ 头像文件，**无外部依赖**。因此部署只有三种形态：

| 场景 | 推荐方式 | 数据位置 | 需要 root | 自动化 |
|---|---|---|---|---|
| Linux 服务器 / 云主机 | **Docker Compose** | Docker 卷 或 绑定目录 | 建议 | `docker compose up -d --build` |
| 群晖 NAS（DSM 7.x） | **Container Manager → 项目** | `/volume1/docker/mahjon/data` | 否（SSH 改权限要） | 导入 `docker-compose.yml` |
| 威联通 NAS（QTS） | **Container Station → 应用程序** | `/share/Container/mahjon/data` | 否 | 粘贴 `docker-compose.yml` |
| 裸机 Linux（有 systemd） | **systemd 服务** | `/var/lib/mahjon` | 是 | `sudo deploy/install.sh` |

> ⚠️ 群晖 / 威联通**没有 systemd**，不要用 `deploy/install.sh`，走 Docker。

---

## 0. 通用约定（三种方式都一样）

### 0.1 端口
应用**永远监听容器内的 3000**（可用 `PORT` 改）。宿主机映射端口随你：

- Docker：`MAHJON_PORT`（默认 3000）→ 写成 `"13000:3000"` 就是外部访问 13000。
- 裸机：`PORT` 直接就是对外端口。

访问入口：

| 路径 | 内容 |
|---|---|
| `/` | **3D 网络对战**（默认即游戏；老吴 2026-10-28：电脑/手机同入口，验证台不再占首页） |
| `/console` 或 `/?debug=1` | 验证台（注册/登录/俱乐部/牌桌/一键模拟 4 人开局） |
| `/app` | **单机版牌桌**（单文件内联，含牌面 base64，无需外部资源） |
| `/app/net` | **网络对战大厅 + 牌桌**（与 `/` 同一份 3D 产物；四人各自开一个就是四人桌） |
| `/health` | 健康检查（返回 `{"ok":true,...}`） |
| `/api/*` | REST 接口 |
| `/play` | Socket.IO 端点（**不是默认的 `/socket.io`**，反代必须放行） |

> `/app` 与 `/app/net` 都是 `node frontend/build.mjs` 的产物（`frontend/build/index.html` / `net.html`）。
> 忘了打包会返回 404 并提示先跑打包命令。`/net.html` 是 `/app/net` 的别名，方便本地开发直接开。

### 0.2 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址；只给本机反代用可设 `127.0.0.1` |
| `DATA_DIR` | `server/data` | **数据目录**，容器里固定 `/data`，务必挂卷 |
| `JWT_SECRET` | `dev-only-secret-change-me` | **生产必改**，改了旧 token 全失效（需重登） |
| `TOKEN_TTL` | `7d` | 登录有效期 |
| `CORS_ORIGIN` | 空 = 回显来源 | 前后端不同源时填白名单，逗号分隔 |
| `ALLOW_THIRD_PARTY_AVATAR` | `false` | 是否允许头像填第三方 URL |
| `TZ` | 系统 | 时区，如 `Asia/Shanghai`（影响日志时间） |
| `NPM_REGISTRY` | 官方源 | 仅构建期，国内建议 `https://registry.npmmirror.com` |

### 0.3 Node 版本与 `node:sqlite`
- 要求 **Node >= 20**；推荐 **22 LTS**。
- 本项目用 Node 内置 `node:sqlite`（避开原生 addon 在部分环境的兼容问题）。
- **Node 22 必须加启动标志 `--experimental-sqlite`**（会打印一条 ExperimentalWarning，正常，不用管）；
  Node 24+ 已稳定免标志，但**带上也无害**。本仓库的 `npm start`、Dockerfile、systemd 单元都已带该标志。
- 本服务**不需要** `better-sqlite3`。

### 0.4 生成密钥
```bash
openssl rand -hex 32
```

---

## 1. Docker / Compose（Linux 服务器首选）

### 1.1 一次性启动
```bash
git clone <你的仓库> mahjon && cd mahjon      # 或直接把源码拷过来
cp .env.example .env
# 编辑 .env：至少把 JWT_SECRET 换成 openssl rand -hex 32 的结果
vi .env
docker compose up -d --build
```

打开 `http://<主机IP>:3000/` 就是验证台；`/app` 是单机牌桌；`/app/net` 是网络对战（四人各开一个浏览器即可）。

### 1.2 国内加速构建
```bash
docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com
docker compose up -d
```
（也可把 `NPM_REGISTRY=` 写进 `.env`，compose 会自动透传。）

### 1.3 数据放哪
默认用具名卷 `mahjon-data`（`docker volume ls` 可见）。想直接看到文件（便于 NAS 备份）就改绑定目录：

```bash
# .env
DATA_PATH=/srv/mahjon/data
```
```bash
mkdir -p /srv/mahjon/data && sudo chown -R 1000:1000 /srv/mahjon/data
docker compose up -d
```

> 容器内以 **uid 1000（node 用户）** 运行，绑定目录属主必须是 1000，否则 SQLite 会 `SQLITE_CANTOPEN`。
> 若目录属主不能改，可在 `docker-compose.yml` 里加 `user: "<uid>:<gid>"` 指定别的用户。

### 1.4 常用运维
```bash
docker compose logs -f            # 跟日志
docker compose restart            # 重启
docker compose down               # 停（数据卷保留）
docker compose up -d --build      # 拉新代码后升级
docker compose exec mahjon sh     # 进容器
```

### 1.5 不用 compose 的最简写法
```bash
docker build -t mahjon:latest .
docker run -d --name mahjon --restart unless-stopped -p 3000:3000 \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  -e TZ=Asia/Shanghai \
  -v /srv/mahjon/data:/data \
  mahjon:latest
```

---

## 2. 群晖 NAS（DSM 7.x · Container Manager）

> 以 DSM 7.2 + Container Manager 为例，菜单名各版本略有差异，逻辑一致。

### 2.1 准备源码与目录
用 File Station 建共享文件夹（例如 `docker`），把整个项目放进去：
```
/volume1/docker/mahjon/          ← 项目根（含 docker-compose.yml）
/volume1/docker/mahjon/data/     ← 数据目录（会被挂进容器 /data）
```

### 2.2 建项目
**Container Manager → 项目 → 新增**：
- 名称：`mahjon`
- 路径：选 `/volume1/docker/mahjon`
- 来源：**选择「使用 docker-compose.yml」**（若界面提供「创建」则用默认，把本仓库的 `docker-compose.yml` 粘进去）

然后 **下一步 → 完成**，它会自动构建并启动（NAS 需能访问 npm 源；国内建议先改 `NPM_REGISTRY`）。

### 2.3 权限（关键一步）
DSM 共享文件夹属主通常是你的管理员账号（常见 `uid=1026`），而容器里跑的是 `uid=1000`。二选一：

**方案 A：改属主（推荐）**
控制面板 → 终端机与 SNMP → 启用 SSH，然后：
```bash
sudo chown -R 1000:1000 /volume1/docker/mahjon/data
```

**方案 B：让容器用 DSM 管理员身份运行**
在 `docker-compose.yml` 的 `mahjon:` 下取消注释并填你的 uid/gid：
```yaml
    user: "1026:100"
```
（`id` 命令可查当前用户 uid/gid。）

### 2.4 端口
若 NAS 的 3000 被占用，改 `.env` 里 `MAHJON_PORT=13000`，然后重建项目。
DSM 自身占用 5000/5001，别混。

### 2.5 升级
File Station 覆盖源码 → Container Manager 里对该项目点 **「重新构建」**（或「操作 → 重建」）。

### 2.6 群晖反向代理 + 域名 + HTTPS
控制面板 → **登录门户 → 高级 → 反向代理 → 新增**：

| 项 | 值 |
|---|---|
| 来源 协议 | HTTPS |
| 来源 主机名 | `mahjong.你的域名.com` |
| 来源 端口 | 443 |
| 目标 协议 | HTTP |
| 目标 主机名 | `localhost` |
| 目标 端口 | `3000`（或你映射的 MAHJON_PORT） |

`/play`（Socket.IO）**走同一个 443 即可**，DSM 反代默认转发 WebSocket 升级头，无需额外设置。

证书：控制面板 → 安全性 → 证书 → 新增 → **Let's Encrypt**（需 80 端口可达，或用 DNS 验证）。
端口转发：路由器把外网 443 → NAS 443。

---

## 3. 威联通 NAS（QTS · Container Station）

1. App Center 装 **Container Station**。
2. 建共享目录 `/share/Container/mahjon`，把项目放进去，另建 `/share/Container/mahjon/data`。
3. Container Station → **应用程序 → 创建 → 粘贴/上传 docker-compose.yml**（内容与本仓库一致）。
4. 权限同理：SSH 进去 `chown -R 1000:1000 /share/Container/mahjon/data`，或加 `user: "<uid>:<gid>"`。
5. QTS 有自带反向代理（**控制台 → 应用程序 → 反向代理**），配置方式与群晖类似。

---

## 4. 裸机 Linux（systemd）

适用：Debian/Ubuntu/CentOS/Rocky/Arch 等**有 systemd** 的常规发行版。**不适用**群晖/威联通。

```bash
cd mahjon
sudo deploy/install.sh
```

脚本会依次做：
1. 校验 Node >= 20（没有就报错；加 `--install-node` 用 NodeSource 自动装 Node 22）
2. 建系统用户 `mahjon`
3. 把代码同步到 `/opt/mahjon`（**自动排除 `server/data`、`test`、`tools`、`node_modules`**）
4. `npm ci --omit=dev`
5. 建 `/var/lib/mahjon` 并授权
6. 生成 `/etc/mahjon/mahjon.env`（含随机 `JWT_SECRET`，权限 600）
7. 按本机真实 node 路径改写 `deploy/mahjon.service` → 安装到 `/etc/systemd/system/`
8. `systemctl enable --now mahjon`，并做一次 `/health` 自检

### 可调参数
```bash
sudo PORT=8080 APP_DIR=/opt/mahjon DATA_DIR=/var/lib/mahjon \
     NPM_REGISTRY=https://registry.npmmirror.com \
     deploy/install.sh
sudo deploy/install.sh --install-node     # 自动装 Node
sudo deploy/install.sh --no-start         # 只装不启动
```

### 运维
```bash
systemctl status mahjon        # 状态
journalctl -u mahjon -f        # 跟日志
systemctl restart mahjon       # 重启（改完 /etc/mahjon/mahjon.env 后执行）
sudo /opt/mahjon/deploy/install.sh   # 升级（先更新源码再重跑，幂等）
```

### 服务加固
单元文件已启用：`NoNewPrivileges`、`PrivateTmp`、`ProtectSystem=strict`、`ProtectHome`，
并把 `ReadWritePaths` 限定到 `DATA_DIR` —— 即**除数据目录外文件系统只读**。
换 `DATA_DIR` 时脚本会自动同步改写这一行。

### 不用 systemd（老 sysvinit / 容器里手跑）
```bash
npm ci --omit=dev
JWT_SECRET=xxx DATA_DIR=/data PORT=3000 npm start
```

---

## 5. 网络访问方式

| 方式 | 怎么做 | 适用 |
|---|---|---|
| 局域网 | 直接访问 `http://192.168.x.x:3000` | 家里/公司内网 |
| Tailscale / ZeroTier | 装好后访问 `http://<虚拟IP>:3000`，**无需公网 IP、无需开端口** | 异地牌友，最省事 |
| 域名 + 反代 | Nginx / 群晖反代 + Let's Encrypt | 想要固定域名与 HTTPS |
| 公网直连 | 路由器端口转发到 3000（**建议同时开反代上 HTTPS**） | 不推荐裸 HTTP 暴露 |

### Nginx 反代示例（含 WebSocket）
```nginx
server {
    listen 443 ssl http2;
    server_name mahjong.example.com;

    ssl_certificate     /etc/letsencrypt/live/mahjong.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mahjong.example.com/privkey.pem;

    client_max_body_size 3m;          # 头像上传上限 2MB，留点余量

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # ⬇ Socket.IO（/play）必需：升级头 + 关缓冲 + 长超时
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

> **两个坑**：① 忘了 `Upgrade/Connection` 头 → 能登录但一进牌桌就断；
> ② `proxy_read_timeout` 太短（默认 60s）→ 玩家思考时连接被掐。
> 走域名时把 `.env` 的 `CORS_ORIGIN` 设为你的域名更安全。

---

## 6. 备份 / 迁移 / 升级

**要备份的只有数据目录**（账号、俱乐部、牌桌、头像）：
```bash
# Docker（具名卷）
docker run --rm -v mahjon-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/mahjon-data-$(date +%F).tgz -C /data .
# 绑定目录 / 裸机
tar czf mahjon-data-$(date +%F).tgz -C /var/lib/mahjon .
```

> SQLite 处于 WAL 模式，`mahjon.db`、`mahjon.db-wal`、`mahjon.db-shm` **要一起拷**。
> 想要绝对一致，先 `docker compose stop`（或 `systemctl stop mahjon`）再打包。

**迁移**：新机器装好 → 停服 → 数据目录整体覆盖 → 起服。

**升级**：`docker compose up -d --build`，或裸机 `sudo deploy/install.sh`。数据目录不受影响。

---

## 7. 排障 FAQ

| 现象 | 原因 / 处理 |
|---|---|
| 启动报 `Cannot find module 'node:sqlite'` 或 `SQLite is not defined` | Node 版本太低或缺标志。确认 ≥20，启动命令带 `--experimental-sqlite`（Node 24+ 可省） |
| 日志有 `ExperimentalWarning: SQLite is an experimental feature` | **正常**，Node 22 的提示，不影响功能 |
| `npm ci` 卡在 bcrypt / 报 `node-gyp` 错 | 缺编译工具。Docker 镜像已内置；裸机装 `python3 make g++`（Debian：`apt install -y build-essential python3`）；或换 `NPM_REGISTRY` 提速 |
| 容器起来又退出 | 看 `docker compose logs`。最常见是 `server/data` 权限（属主非 1000）或端口占用 |
| 数据「重启就没了」 | `DATA_DIR` 没挂卷。确认 compose 里有 `- xxx:/data` 且 `DATA_DIR=/data` |
| `SQLITE_CANTOPEN` / 无法写库 | 数据目录不可写。`chown -R 1000:1000 <数据目录>` 或指定 `user:` |
| 能登录，进牌桌就断连 | 反代没转发 WebSocket。补齐 `Upgrade`/`Connection` 头与 `proxy_read_timeout` |
| Socket.IO 报 404 | 客户端连的路径不对。本项目端点是 **`/play`**，客户端脚本是 `/play/socket.io.js` |
| 端口被占（NAS 上常见） | 改 `MAHJON_PORT`（Docker）或 `PORT`（裸机） |
| 日志时间不对 | 设 `TZ=Asia/Shanghai` |
| 忘了 `JWT_SECRET` | 容器里换个新的重启即可，代价是所有人要重新登录 |
| 想彻底重置 | 停服 → 删数据目录下的 `mahjon.db*` 与 `avatars/` → 起服（表会自动重建） |

---

## 8. 一页速查

```bash
# ── Docker ──
cp .env.example .env && vi .env        # 改 JWT_SECRET
docker compose up -d --build
docker compose logs -f

# ── 裸机 Linux ──
sudo deploy/install.sh
journalctl -u mahjon -f

# ── 自检 ──
curl -s http://127.0.0.1:3000/health
# 验证台 http://<IP>:3000/     单机牌桌 http://<IP>:3000/app     网络对战 http://<IP>:3000/app/net
```
