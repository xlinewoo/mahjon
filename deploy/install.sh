#!/usr/bin/env bash
#
# 武汉麻将 网络对战服务 —— 裸机 Linux 一键安装 / 升级
#
#   用法（在仓库根目录执行，需 root）：
#     sudo deploy/install.sh
#
#   可选环境变量（也可写在命令行前）：
#     PORT=3000              监听端口
#     APP_DIR=/opt/mahjon    程序目录
#     DATA_DIR=/var/lib/mahjon   数据目录（SQLite + 头像）
#     SVC_USER=mahjon        运行服务的系统用户
#     HTTP_PROXY_/NPM_REGISTRY    npm 源，国内建议 https://registry.npmmirror.com
#
#   可选参数：
#     --install-node   本机没有 Node >=20 时，用 NodeSource 自动装一个
#     --no-start       只装不改 systemd 状态（用于灰度 / 手工控制）
#
#   本脚本幂等：重复执行即为「升级」（覆盖代码 + 重装依赖，数据目录不动）。
#   注意：群晖 DSM / 威联通 QTS 没有 systemd，请改用 Docker，见 docs/deploy.md。

set -euo pipefail

PORT="${PORT:-3000}"
APP_DIR="${APP_DIR:-/opt/mahjon}"
DATA_DIR="${DATA_DIR:-/var/lib/mahjon}"
SVC_USER="${SVC_USER:-mahjon}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org/}"
INSTALL_NODE=0
DO_START=1

while [ $# -gt 0 ]; do
  case "$1" in
    --install-node) INSTALL_NODE=1 ;;
    --no-start) DO_START=0 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "未知参数：$1（用 --help 查看）" >&2; exit 2 ;;
  esac
  shift
done

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_DIR="/etc/mahjon"
ENV_FILE="$ENV_DIR/mahjon.env"
SVC_FILE="/etc/systemd/system/mahjon.service"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 0. 前置检查 ----------
[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo $0 $*"
[ -f "$SRC_DIR/package.json" ] || die "找不到 package.json，请在仓库根目录运行本脚本"
[ -f "$SRC_DIR/server/index.js" ] || die "找不到 server/index.js，仓库不完整"

if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
  warn "本机没有可用的 systemd（群晖 / 威联通 / 部分容器里就是这样）。"
  warn "这类 NAS 请改用 Docker 部署，步骤见 docs/deploy.md 的「群晖」一节。"
  die "已中止：无 systemd，无法安装系统服务"
fi

# ---------- 1. 找 Node（>=20）----------
find_node() {
  local cand
  for cand in \
    "${NODE_BIN:-}" \
    "$(command -v node 2>/dev/null || true)" \
    /usr/local/bin/node /usr/bin/node /snap/bin/node \
    /usr/local/nodejs/bin/node
  do
    [ -n "$cand" ] && [ -x "$cand" ] && { printf '%s' "$cand"; return 0; }
  done
  # nvm / fnm 装在家目录的情形
  for cand in /root/.nvm/versions/node/*/bin/node /home/*/.nvm/versions/node/*/bin/node; do
    [ -x "$cand" ] && { printf '%s' "$cand"; return 0; }
  done
  return 1
}

install_node_nodesource() {
  say "本机无 Node，尝试用 NodeSource 安装 Node 22.x"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y -qq nodejs
  elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    (command -v dnf >/dev/null 2>&1 && dnf install -y nodejs) || yum install -y nodejs
  else
    die "不认识的发行版，请手动安装 Node >=20 后重跑本脚本（推荐 nvm 或 NodeSource）"
  fi
}

NODE_BIN="$(find_node || true)"
if [ -z "${NODE_BIN:-}" ]; then
  if [ "$INSTALL_NODE" -eq 1 ]; then
    install_node_nodesource
    NODE_BIN="$(find_node || true)"
  fi
fi
[ -n "${NODE_BIN:-}" ] || die "未找到 Node。请安装 Node >=20（或用 --install-node 自动装）"
NPM_BIN="$(dirname "$NODE_BIN")/npm"
[ -x "$NPM_BIN" ] || NPM_BIN="$(command -v npm || true)"
[ -n "${NPM_BIN:-}" ] || die "找到 node 但没找到 npm"

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
NODE_VER="$("$NODE_BIN" -p 'process.versions.node')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node 版本过低（当前 $NODE_VER，需 >=20）"

# node:sqlite 在 Node 22 需要 --experimental-sqlite；Node 24+ 已稳定，带上也无害
SQLITE_FLAG="--experimental-sqlite"
say "使用 Node：$NODE_BIN（$NODE_VER）"

# ---------- 2. 建系统用户 ----------
if id "$SVC_USER" >/dev/null 2>&1; then
  say "系统用户 $SVC_USER 已存在，复用"
else
  say "创建系统用户 $SVC_USER"
  useradd --system --create-home --shell /usr/sbin/nologin "$SVC_USER" 2>/dev/null \
    || useradd --system --create-home --shell /sbin/nologin "$SVC_USER"
fi

# ---------- 3. 同步代码到 APP_DIR ----------
say "同步代码 → $APP_DIR"
mkdir -p "$APP_DIR"
tar -C "$SRC_DIR" \
  --exclude='./node_modules' \
  --exclude='./server/data' \
  --exclude='./.git' \
  --exclude='./.workbuddy' \
  --exclude='./test' \
  --exclude='./server/test' \
  --exclude='./tools' \
  --exclude='./.env' \
  --exclude='*.log' \
  -cf - . | tar -C "$APP_DIR" -xf -

# ---------- 4. 装生产依赖 ----------
say "安装生产依赖（npm ci --omit=dev）"
(
  cd "$APP_DIR"
  "$NPM_BIN" config set registry "$NPM_REGISTRY"
  "$NPM_BIN" ci --omit=dev --no-audit --no-fund
)
"$NPM_BIN" cache clean --force >/dev/null 2>&1 || true

# ---------- 5. 数据目录 ----------
say "准备数据目录 $DATA_DIR"
mkdir -p "$DATA_DIR"
chown -R "$SVC_USER:$SVC_USER" "$DATA_DIR"
chown -R "$SVC_USER:$SVC_USER" "$APP_DIR"

# ---------- 6. 环境变量文件 ----------
mkdir -p "$ENV_DIR"
if [ -f "$ENV_FILE" ]; then
  say "环境变量文件已存在，保留不动：$ENV_FILE"
else
  say "生成环境变量文件 $ENV_FILE（含随机 JWT_SECRET）"
  SECRET="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  cat > "$ENV_FILE" <<EOF
# 武汉麻将 服务环境变量 —— 由 deploy/install.sh 生成
# 改完执行：systemctl restart mahjon
PORT=$PORT
HOST=0.0.0.0
DATA_DIR=$DATA_DIR
JWT_SECRET=$SECRET
TOKEN_TTL=7d
CORS_ORIGIN=
ALLOW_THIRD_PARTY_AVATAR=false
EOF
  chmod 600 "$ENV_FILE"
  chown root:root "$ENV_FILE"
fi

# ---------- 7. 写 systemd 单元 ----------
say "安装 systemd 单元 → $SVC_FILE"
sed -e "s#^User=.*#User=$SVC_USER#" \
    -e "s#^Group=.*#Group=$SVC_USER#" \
    -e "s#^WorkingDirectory=.*#WorkingDirectory=$APP_DIR#" \
    -e "s#^Documentation=.*#Documentation=file:$APP_DIR/docs/deploy.md#" \
    -e "s#^ExecStart=.*#ExecStart=$NODE_BIN $SQLITE_FLAG server/index.js#" \
    -e "s#^ReadWritePaths=.*#ReadWritePaths=$DATA_DIR#" \
    "$SRC_DIR/deploy/mahjon.service" > "$SVC_FILE"
chmod 644 "$SVC_FILE"

systemctl daemon-reload

if [ "$DO_START" -eq 1 ]; then
  say "启用并启动服务"
  systemctl enable mahjon >/dev/null 2>&1 || true
  systemctl restart mahjon
  sleep 2
  if systemctl is-active --quiet mahjon; then
    say "服务已运行 ✅"
  else
    warn "服务未处于 active，最近日志："
    journalctl -u mahjon -n 30 --no-pager || true
    die "启动失败，请按上面日志排查"
  fi
else
  say "已跳过启动（--no-start）。手动启动：systemctl restart mahjon"
fi

# ---------- 8. 自检 ----------
say "自检 /health"
if "$NODE_BIN" -e "
  const p=process.env.PORT||'$PORT';
  fetch('http://127.0.0.1:'+p+'/health').then(r=>r.json()).then(j=>{console.log(JSON.stringify(j));process.exit(j.ok?0:1)}).catch(e=>{console.error(e.message);process.exit(1)})
" ; then
  say "健康检查通过 ✅"
else
  warn "健康检查未通过（服务可能仍在启动，或端口 $PORT 被占用）"
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<EOF

────────────────────────────────────────────
 部署完成
   程序目录 : $APP_DIR
   数据目录 : $DATA_DIR
   环境变量 : $ENV_FILE
   监听端口 : $PORT

 验证台   : http://${IP:-<主机IP>}:$PORT/
 单机牌桌 : http://${IP:-<主机IP>}:$PORT>/app

 常用命令 :
   systemctl status mahjon        # 看状态
   journalctl -u mahjon -f        # 跟日志
   systemctl restart mahjon       # 重启（改完 $ENV_FILE 后执行）
   sudo $APP_DIR/deploy/install.sh   # 升级（拉新代码后重跑）

 备份：直接打包 $DATA_DIR 即可（mahjon.db + avatars/）
────────────────────────────────────────────
EOF
