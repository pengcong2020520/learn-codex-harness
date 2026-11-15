FROM node:24.19.0-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
ARG APT_MIRROR=
RUN if [ -n "$APT_MIRROR" ]; then sed -i "s#http://deb.debian.org#$APT_MIRROR#g" /etc/apt/sources.list.d/debian.sources; fi \
 && apt-get update && apt-get install -y --no-install-recommends chromium fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY scripts/layout-check.mjs scripts/layout-check.mjs
COPY shared/errors.mjs shared/errors.mjs
COPY server/modules/sharding/node-auth.mjs server/modules/sharding/node-auth.mjs
COPY server/design-check/*.mjs server/design-check/
USER node
CMD ["node", "server/design-check/service.mjs"]
