# syntax=docker/dockerfile:1.7

ARG VERSION=dev
FROM node:24-bookworm-slim AS build
WORKDIR /src

COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts
COPY server/package.json server/package-lock.json ./server/
RUN npm ci --prefix server --ignore-scripts

COPY packages/server-node/package.json packages/server-node/esbuild.config.mjs ./packages/server-node/
COPY packages/server-node/src ./packages/server-node/src
COPY server/src ./server/src
RUN npm run build:server-node

FROM node:24-bookworm-slim AS runtime
ARG VERSION
LABEL org.opencontainers.image.title="YAOS Server" \
      org.opencontainers.image.description="Self-hosted schema-4 YAOS synchronization server" \
      org.opencontainers.image.source="https://github.com/kavinsood/yaos" \
      org.opencontainers.image.version="${VERSION}"
ENV NODE_ENV=production \
    YAOS_NODE_HOST=0.0.0.0 \
    YAOS_NODE_PORT=8787 \
    YAOS_NODE_DATA_DIR=/data
WORKDIR /app

COPY --from=build --chown=node:node /src/packages/server-node/dist/server.mjs ./dist/server.mjs
COPY --from=build --chown=node:node /src/node_modules/ws ./node_modules/ws
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.YAOS_NODE_PORT + '/health/ready').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1));"]
ENTRYPOINT ["node", "dist/server.mjs"]
