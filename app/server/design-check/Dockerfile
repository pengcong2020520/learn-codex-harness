FROM node:24.19.0-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS prototype
WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmjs.org
COPY server/design-check/template/package*.json server/design-check/template/
RUN npm ci --prefix server/design-check/template --registry="$NPM_REGISTRY" --no-audit --no-fund && npm cache clean --force
COPY server/design-check/template/ server/design-check/template/
RUN npm --prefix server/design-check/template run build

FROM node:24.19.0-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS browser
ARG APT_MIRROR=
RUN if [ -n "$APT_MIRROR" ]; then sed -i "s#http://deb.debian.org#$APT_MIRROR#g" /etc/apt/sources.list.d/debian.sources; fi \
 && apt-get update && apt-get install -y --no-install-recommends chromium fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=prototype /app/server/design-check/template server/design-check/template
COPY scripts/layout-check.mjs scripts/walkthrough.mjs scripts/
COPY scripts/walkthrough/ scripts/walkthrough/
COPY shared/errors.mjs shared/errors.mjs
COPY server/modules/sharding/node-auth.mjs server/modules/sharding/node-auth.mjs
COPY server/design-check/*.mjs server/design-check/
USER node
CMD ["node", "server/design-check/service.mjs"]
