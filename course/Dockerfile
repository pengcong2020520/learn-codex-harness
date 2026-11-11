# 仓库根目录作为构建上下文；课程运行只需要 Node 内置模块。
FROM node:24.19.0-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
ENV NODE_ENV=production
WORKDIR /course
COPY --chown=node:node course/web/server.mjs ./web/server.mjs
COPY --chown=node:node course/web/shared/ ./web/shared/
COPY --chown=node:node course/web/public/ ./web/public/
# 阶段数据由 compose 只读挂载；s00–s02 无实时服务，不需要复制源码。
RUN mkdir -p /stages
USER node
EXPOSE 14320
CMD ["node", "web/server.mjs"]
