# P5: multi-stage — builder compiles TS -> dist, runtime ships only prod deps + dist.
# Local `dist/` stays in .dockerignore (never enters context); the runtime
# COPY --from=builder bypasses the ignore because it copies from the build
# stage filesystem, not from the build context.
FROM node:lts-slim AS builder

WORKDIR /build

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY index.ts ./
COPY src ./src
RUN npm run build

# ---------------- runtime ----------------
FROM node:lts-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    && dpkgArch="$(dpkg --print-architecture | awk -F- '{ print $NF }')" \
    && curl -Lo /usr/local/bin/gosu "https://github.com/tianon/gosu/releases/download/1.17/gosu-$dpkgArch" \
    && chmod +x /usr/local/bin/gosu \
    && gosu --version \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g opencode-ai

RUN mkdir -p /home/node/.local/share/opencode \
    && mkdir -p /home/node/.config/opencode \
    && mkdir -p /home/node/project \
    && chown -R node:node /home/node

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /home/node/project

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /build/dist ./dist
RUN chown -R node:node /home/node/project

EXPOSE 10000 10001

ENV OPENCODE_SERVER_PASSWORD=
ENV API_KEY=
ENV API_KEYS=
ENV OPENCODE_API_KEYS=
ENV BIND_HOST=0.0.0.0
ENV DISABLE_TOOLS=true
ENV OPENCODE_DISABLE_TOOLS=
ENV OPENCODE_PROXY_MANAGE_BACKEND=false
ENV OPENCODE_PATH=opencode
ENV OPENCODE_ZEN_API_KEY=
ENV OPENCODE_EXTERNAL_TOOLS_MODE=proxy-bridge
ENV OPENCODE_EXTERNAL_TOOLS_CONFLICT_POLICY=namespace
ENV OPENCODE_INTERNAL_WEB_FETCH_ENABLED=false
ENV OPENCODE_INTERNAL_ALLOWED_TOOLS=
ENV OPENCODE_INTERNAL_TOOL_METRICS_ENABLED=true
ENV OPENCODE_TOOL_DISCOVERY_FIXTURE=
ENV OPENCODE_HEALTH_DETAILS_ENABLED=true
ENV OPENCODE_HEALTH_DETAILS_REQUIRE_AUTH=true
ENV OPENCODE_METRICS_ENABLED=false
ENV OPENCODE_METRICS_REQUIRE_AUTH=true
ENV OPENCODE_USE_ISOLATED_HOME=false
ENV OPENCODE_PROXY_DEBUG=false
ENV OPENCODE_PROXY_PROMPT_MODE=standard
ENV OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=false
ENV OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS=false
ENV OPENCODE_PROXY_CLEANUP_INTERVAL_MS=43200000
ENV OPENCODE_PROXY_CLEANUP_MAX_AGE_MS=86400000
ENV OPENCODE_PROXY_REQUEST_TIMEOUT_MS=180000
ENV OPENCODE_PROXY_RETRY_MAX_RETRIES=3
ENV OPENCODE_UPSTREAM_PROXIES=
ENV OPENCODE_UPSTREAM_PROXY_STRATEGY=failover-rr
ENV OPENCODE_UPSTREAM_PROXY_COOLDOWN_MS=300000
ENV OPENCODE_UPSTREAM_PROXY_NO_PROXY=localhost,127.0.0.1,::1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "10001"]
