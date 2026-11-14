# 固定 Node 基础镜像；协调客户端使用 etcd3。
FROM node:24.19.0-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG APT_MIRROR=
# 必须与宿主部署路径相同：Codex 原生历史保存绝对路径。
ARG CONTAINER_APP_DIR
RUN case "$CONTAINER_APP_DIR" in /*) ;; *) echo '缺少 CONTAINER_APP_DIR：请先运行配置向导（npm run setup）生成 .env' >&2; exit 1 ;; esac
ENV NODE_ENV=production
# 备份在宿主机调用 postgres 容器里的客户端，本镜像不安装数据库命令行工具。
RUN if [ -n "$APT_MIRROR" ]; then sed -i "s#http://deb.debian.org#$APT_MIRROR#g" /etc/apt/sources.list.d/debian.sources; fi \
 && apt-get update && apt-get install -y --no-install-recommends lsof bubblewrap \
 && rm -rf /var/lib/apt/lists/*
WORKDIR ${CONTAINER_APP_DIR}
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --registry="$NPM_REGISTRY" && npm cache clean --force
COPY . .
RUN mkdir -p .data .runs workspace backups && chown node:node .data .runs workspace backups
USER node
EXPOSE 4340 4341 4342
CMD ["node", "server/main.mjs"]
