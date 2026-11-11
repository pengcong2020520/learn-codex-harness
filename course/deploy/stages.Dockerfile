# 构建上下文为仓库/部署根目录；专用 ignore 文件阻止本机数据进入构建上下文。
FROM node:24.19.0-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG APT_MIRROR=
ARG CONTAINER_STAGES_DIR=/stages
ENV NODE_ENV=production CONTAINER_STAGES_DIR=${CONTAINER_STAGES_DIR}
RUN if [ -n "$APT_MIRROR" ]; then sed -i "s#http://deb.debian.org#$APT_MIRROR#g" /etc/apt/sources.list.d/debian.sources; fi \
  && apt-get update && apt-get install -y --no-install-recommends lsof bubblewrap && rm -rf /var/lib/apt/lists/*
WORKDIR ${CONTAINER_STAGES_DIR}
COPY stages/s03-service/ ./s03-service/
COPY stages/s04-events-messages/ ./s04-events-messages/
COPY stages/s05-agent-assembly/ ./s05-agent-assembly/
COPY stages/s06-tools/ ./s06-tools/
COPY stages/s07-memory/ ./s07-memory/
COPY stages/s08-data-layer/ ./s08-data-layer/
COPY stages/s09-knowledge-layer/ ./s09-knowledge-layer/
COPY stages/s10-skill-workflow/ ./s10-skill-workflow/
COPY stages/s11-model-gateway/ ./s11-model-gateway/
RUN for stage in s03-service s04-events-messages s05-agent-assembly s06-tools s07-memory s08-data-layer s09-knowledge-layer s10-skill-workflow s11-model-gateway; do \
    (cd "$stage" && npm ci --omit=dev --no-audit --no-fund --registry="$NPM_REGISTRY" && mkdir -p .data .runs workspace && chown node:node .data .runs workspace) || exit 1; \
  done && npm cache clean --force
COPY course/deploy/*.mjs /opt/stages-deploy/
USER node
CMD ["node", "/opt/stages-deploy/run-stages.mjs"]
