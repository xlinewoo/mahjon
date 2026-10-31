# syntax=docker/dockerfile:1
#
# 武汉麻将 网络对战服务 —— 生产镜像
# 用法：
#   docker build -t mahjon:latest .
#   docker run -d --name mahjon -p 3000:3000 \
#     -e JWT_SECRET=$(openssl rand -hex 32) \
#     -v /your/data/path:/data mahjon:latest
#
# 说明：
#   - 数据（SQLite + 头像）固定落 /data 卷，容器重建不丢
#   - node:sqlite 在 Node 22 需 --experimental-sqlite 标志（Node 24 起免标志，亦可直接去掉）
#   - 国内网络加速：docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com .

# ---------- 阶段 1：安装生产依赖 ----------
# 单独一层，把编译工具链留在构建阶段，不进入最终镜像
FROM node:22-slim AS deps
WORKDIR /app

# npm 源可替换（国内建议 npmmirror）
ARG NPM_REGISTRY=https://registry.npmjs.org/
RUN npm config set registry "$NPM_REGISTRY"

# bcrypt 是原生模块：优先拉预编译二进制，拉不到就本地编译，故备好工具链
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---------- 阶段 2：运行时 ----------
FROM node:22-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

# tini 作为 PID 1，保证 docker stop / compose down 能优雅退出而不是硬杀
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY server ./server
# /app 路由用的单机版前端（单文件内联）。改了前端源码请先在宿主机跑：
#   node frontend/build.mjs
COPY frontend/build ./frontend/build

# 数据卷：SQLite(mahjon.db) + 上传头像
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

# 非 root 运行
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--experimental-sqlite", "server/index.js"]
