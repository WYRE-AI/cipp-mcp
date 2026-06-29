FROM node:26-alpine AS builder

ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"

WORKDIR /app

COPY package*.json ./

# --ignore-scripts prevents 'prepare'/'prebuild' from running before source is copied
RUN npm ci --ignore-scripts

COPY . .

RUN npm run build

FROM node:26-alpine AS production

# Pull latest Alpine package fixes (e.g. OpenSSL) even when the base layer is cached
RUN apk -U upgrade --no-cache

RUN addgroup -g 1001 -S cipp && \
    adduser -S cipp -u 1001 -G cipp

WORKDIR /app

COPY package*.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

# Prune dev deps in builder stage (avoids re-auth to registries in prod stage)
RUN npm prune --omit=dev && npm cache clean --force

# Remove the npm CLI from the runtime image (not needed at runtime; clears npm-bundled CVEs)
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

RUN mkdir -p /app/logs && chown -R cipp:cipp /app

USER cipp

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV LOG_FORMAT=json
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_PORT=8080
ENV MCP_HTTP_HOST=0.0.0.0
ENV AUTH_MODE=env

VOLUME ["/app/logs"]

CMD ["node", "dist/index.js"]

LABEL maintainer="engineering@wyre.ai"
LABEL version="${VERSION}"
LABEL description="CIPP MCP Server - Model Context Protocol server for CyberDrain Improved Partner Portal"
LABEL org.opencontainers.image.title="cipp-mcp"
LABEL org.opencontainers.image.description="Model Context Protocol server for CIPP M365 multi-tenant management"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.revision="${COMMIT_SHA}"
LABEL org.opencontainers.image.source="https://github.com/wyre-technology/cipp-mcp"
LABEL org.opencontainers.image.documentation="https://github.com/wyre-technology/cipp-mcp/blob/main/README.md"
LABEL org.opencontainers.image.url="https://github.com/wyre-technology/cipp-mcp/pkgs/container/cipp-mcp"
LABEL org.opencontainers.image.vendor="Wyre Technology"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL io.modelcontextprotocol.server.name="io.github.wyre-technology/cipp-mcp"
