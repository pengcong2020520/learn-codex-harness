# 智能体服务与 Web 工作台共用的镜像：Node 24 + 本项目依赖（含 Codex 0.154.0 的程序）。
# 构建：docker compose --profile app build；国内服务器可以换成国内源：
#   NPM_REGISTRY=https://registry.npmmirror.com、APT_MIRROR=http://mirrors.tencentyun.com（写在 .env 里，compose 会传进来）
FROM node:24.19.0-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG APT_MIRROR=
# 容器里的项目路径。Codex 的历史记录里存的是绝对路径，迁移旧数据时设成与原部署路径相同，旧会话才能接着用。
ARG APP_DIR=/app
ENV NODE_ENV=production
# lsof：缓存清理要确认运行目录没有被进程占用；bubblewrap：Codex 的沙箱程序（本项目的工具不经它执行，装上避免启动报错）。
RUN if [ -n "$APT_MIRROR" ]; then sed -i "s#http://deb.debian.org#$APT_MIRROR#g" /etc/apt/sources.list.d/debian.sources; fi \
  && apt-get update && apt-get install -y --no-install-recommends lsof bubblewrap && rm -rf /var/lib/apt/lists/*
WORKDIR ${APP_DIR}
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --registry="$NPM_REGISTRY" && npm cache clean --force
COPY . .
# 数据、运行记录和工作区挂载到宿主（见 compose.yaml）；这里只建好目录并交给运行用户 node（uid 1000）。
RUN mkdir -p .data .runs workspace && chown node:node .data .runs workspace
USER node
EXPOSE 4317 14320
CMD ["node", "server/main.mjs"]
