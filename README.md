# OpenCode2API

<p align="center">
  <img src="https://img.shields.io/badge/version-1.6.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/Node.js-18+-orange" alt="Node">
</p>

> **Language:** [English](./README.md) | [简体中文](./README.zh-CN.md)
>
> 📖 [Docs](./docs/README.md) | 🚀 [Quick Start](#quick-start) | 🐛 [Issues](https://github.com/samson910022/OpenCode2API/issues)

Turn a local [OpenCode](https://opencode.ai) runtime into an OpenAI-, Anthropic-, and Gemini-compatible API gateway. Use free models (Big Pickle, Ling, MiMo, Muse Spark, Nemotron) from any OpenAI, Anthropic, or Gemini client — the free lineup rotates, so query `/v1/models` for the live list.

---

## ✨ Features

| Feature | Description |
|:-----|:-----|
| 🟢 **OpenAI compatible** | `/v1/models`, `/v1/chat/completions`, `/v1/responses` |
| 🟣 **Anthropic compatible** | `/v1/messages` (with `tool_use` / `thinking` / SSE streaming) |
| 🔁 **Gemini compatible (thin)** | `POST /v1beta/interactions` (alias `POST /v1/interactions`, text + `google_search` grounding) |
| 🌐 **Server-side web search** | `/v1/responses` `tools: [{type: "web_search"}]` drives opencode websearch, returns `web_search_call` + honest `url_citation` |
| 🔑 **Multi-key auth** | `API_KEY` + `OPENCODE_API_KEYS` / `API_KEYS` merge; `Bearer` or `x-api-key`, any match passes; empty means no auth |
| 🔀 **Free-limit fallback proxy** | Direct-only until a 429 free-limit error engages `OPENCODE_UPSTREAM_PROXIES` (`failover-rr`, cooldown, loopback bypass) |
| 📡 **Streaming** | Full SSE streaming for Chat Completions, Responses, Messages, and Interactions APIs |
| 🧠 **Reasoning control** | Supports `reasoning_effort` and `reasoning: { "effort": "high" }` |
| 🐳 **Docker deploy** | One-command deploy, auto-starts the OpenCode backend |
| 🛡️ **Tool safety** | Tool calling disabled by default |
| 🔧 **External tool bridge** | External `tools` from clients are bridged by the proxy into OpenAI-compatible `tool_calls` / `function_call`, without hitting OpenCode built-in tools |
| 🌐 **Built-in web_fetch passthrough** | When a request carries no `tools` and the feature is explicitly enabled, only the OpenCode built-in `web_fetch` may participate in that request |

---

## 🚀 Quick Start

### Docker deploy (recommended)

```bash
# 1. Clone and configure
git clone https://github.com/samson910022/OpenCode2API.git
cd OpenCode2API
cp .env.example .env

# 2. Edit .env and set your config
# Required: API_KEY, OPENCODE_SERVER_PASSWORD

# 3. Start
docker compose up -d

# 4. Test
curl http://127.0.0.1:10000/health
```

> The default `docker-compose.yml` does not mount the host project directory into the container, because that would shadow the image's installed `node_modules` and force the container to rely on a host-side `npm install`. For live local-source reload, use a dedicated dev Compose override instead.

### Node.js (local dev)

```bash
# 1. Install the OpenCode CLI
npm install -g opencode-ai
# Linux/macOS: curl -fsSL https://opencode.ai/install | bash

# 2. Clone and run
git clone https://github.com/samson910022/OpenCode2API.git
cd OpenCode2API
npm install
cp config.json.example config.json
npm run build
npm start
```

---

## 💡 Usage Examples

### Chat Completions

```bash
curl -X POST http://127.0.0.1:10000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/big-pickle",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

### Responses API (with reasoning)

```bash
curl -N -X POST http://127.0.0.1:10000/v1/responses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/muse-spark-1.3-contributor-free",
    "input": "Say hi in one sentence",
    "reasoning": {"effort": "high"},
    "stream": true
  }'
```

### Chat Completions + external tools

```bash
curl -X POST http://127.0.0.1:10000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/big-pickle",
    "messages": [{"role": "user", "content": "Fetch the title of https://example.com"}],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "web_fetch",
          "description": "Fetch a URL and return its content summary",
          "parameters": {
            "type": "object",
            "properties": {
              "url": {"type": "string"}
            },
            "required": ["url"]
          }
        }
      }
    ]
  }'
```

### Responses API + external tools (streaming)

```bash
curl -N -X POST http://127.0.0.1:10000/v1/responses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/muse-spark-1.3-contributor-free",
    "input": "Look up the weather in Tokyo",
    "stream": true,
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "weather_lookup",
          "description": "Look up weather by city",
          "parameters": {
            "type": "object",
            "properties": {
              "city": {"type": "string"},
              "unit": {"type": "string"}
            },
            "required": ["city"]
          }
        }
      }
    ]
  }'
```

### Messages API (Anthropic compatible)

```bash
curl -X POST http://127.0.0.1:10000/v1/messages \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/muse-spark-1.3-contributor-free",
    "max_tokens": 1024,
    "system": "You are a helpful assistant.",
    "messages": [{"role": "user", "content": "Say hi in one sentence"}]
  }'
```

> You may use `x-api-key: YOUR_API_KEY` instead of `Authorization: Bearer`; `max_tokens` is required; on stream the API returns `message_start/content_block_start/content_block_delta/content_block_stop/message_delta/message_stop` (no `[DONE]`).

### Responses API + web_search grounding

```bash
curl -X POST http://127.0.0.1:10000/v1/responses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/muse-spark-1.3-contributor-free",
    "input": "What is the latest PostgreSQL release?",
    "tools": [{"type": "web_search"}]
  }'
```

> `web_search` (also `web_search_preview` / `web_search_*` / `google_search`) is an explicit grant: the proxy drives the opencode built-in `websearch` and returns `web_search_call` + `url_citation` annotations only for sources actually cited (no fabrication). `web_search` on chat/messages is rejected with 400 + a pointer to this endpoint.

### Interactions API (Gemini-compatible thin layer)

```bash
curl -X POST http://127.0.0.1:10000/v1beta/interactions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/muse-spark-1.3-contributor-free",
    "input": "What is the latest PostgreSQL release?",
    "tools": [{"type": "google_search"}]
  }'
```

> Alias `POST /v1/interactions`; supports `system_instruction`, `previous_interaction_id`, `store: false` (ephemeral), and SSE (`interaction.created` / `step.delta` / `interaction.completed`, no `[DONE]`). Client-executed function tools are rejected with 400 — use `/v1/responses` for those.

---

## 📦 Deployment Modes

| Mode | Description | Best for |
|:-----|:-----|:---------|
| 🐳 **Docker** | Full stack, auto-starts the OpenCode backend | Production, minimal config |
| 💻 **Standalone Node** | You manage the backend yourself | Development, custom integrations |

---

## ⚙️ Configuration

### Quick reference

| Env var | Default | Description |
|:--------|:-------|:------|
| `PORT` / `OPENCODE_PROXY_PORT` | `10000` | Proxy listen port |
| `OPENCODE_SERVER_PORT` | `10001` | OpenCode backend port |
| `API_KEY` | - | Bearer token secret |
| `API_KEYS` / `OPENCODE_API_KEYS` | `(none)` | Extra client keys, comma-separated; merged with `API_KEY`, any match passes; empty falls back to no auth |
| `BIND_HOST` | `0.0.0.0` | Bind address |
| `DISABLE_TOOLS` | `true` | Disable OpenCode tool calling |
| `OPENCODE_EXTERNAL_TOOLS_MODE` | `proxy-bridge` | External tool bridge mode; only `proxy-bridge` is supported |
| `OPENCODE_EXTERNAL_TOOLS_CONFLICT_POLICY` | `namespace` | Conflict isolation for external vs built-in tools; only `namespace` is supported |
| `OPENCODE_INTERNAL_WEB_FETCH_ENABLED` | `false` | Legacy shortcut; when no allowlist is configured, enabling it defaults the allowlist to `web_fetch` |
| `OPENCODE_INTERNAL_ALLOWED_TOOLS` | `(none)` | OpenCode built-in tools allowed when a request carries no `tools`, comma-separated |
| `OPENCODE_INTERNAL_TOOL_METRICS_ENABLED` | `true` | Emit debug/metric logs for internal-allowlist mode |
| `OPENCODE_TOOL_DISCOVERY_FIXTURE` | `(none)` | Fixed backend tool-ID list for integration tests / local debugging, comma-separated |
| `OPENCODE_HEALTH_DETAILS_ENABLED` | `true` | Whether `/health/details` is exposed |
| `OPENCODE_HEALTH_DETAILS_REQUIRE_AUTH` | `true` | Whether `/health/details` requires Bearer auth |
| `OPENCODE_METRICS_ENABLED` | `false` | Whether `/metrics` is exposed |
| `OPENCODE_METRICS_REQUIRE_AUTH` | `true` | Whether `/metrics` requires Bearer auth |
| `OPENCODE_USE_ISOLATED_HOME` | `false` | Use an isolated OpenCode config directory (`USE_ISOLATED_HOME` in `config.json`) |
| `OPENCODE_PROXY_PROMPT_MODE` | `standard` | Prompt handling mode |
| `OPENCODE_PROXY_OMIT_SYSTEM_PROMPT` | `false` | Drop the incoming system prompt |
| `OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS` | `false` | Auto-clean conversation storage |
| `OPENCODE_PROXY_CLEANUP_INTERVAL_MS` | `43200000` | Cleanup interval (ms) |
| `OPENCODE_PROXY_CLEANUP_MAX_AGE_MS` | `86400000` | Max retention (ms) |
| `OPENCODE_PROXY_REQUEST_TIMEOUT_MS` | `180000` | Request timeout (ms) |
| `OPENCODE_PROXY_RETRY_MAX_RETRIES` | `3` | Retries after the first attempt (0-5, total attempts 1+n; exponential backoff+jitter, honors `retry-after`) |
| `OPENCODE_UPSTREAM_PROXIES` | `(none)` | Fallback proxy URLs, comma-separated (`socks5://` preferred, `http(s)://` ok; file key `UPSTREAM_PROXIES`) |
| `OPENCODE_UPSTREAM_PROXY_STRATEGY` | `failover-rr` | `failover-rr` / `round-robin` (aliases) / `random`; rotates on consecutive free-limit 429s |
| `OPENCODE_UPSTREAM_PROXY_COOLDOWN_MS` | `300000` | How long an engaged proxy sticks before returning to direct (ms) |
| `OPENCODE_UPSTREAM_PROXY_NO_PROXY` | `localhost,127.0.0.1,::1` | Target hosts that never use the proxy (backend `127.0.0.1` always direct) |
| `OPENCODE_SERVER_URL` | `http://127.0.0.1:10001` | OpenCode backend address |
| `OPENCODE_SERVER_PASSWORD` | - | OpenCode backend password |
| `OPENCODE_PATH` | `opencode` | OpenCode binary path |
| `OPENCODE_ZEN_API_KEY` | - | Zen API key passthrough |
| `OPENCODE_PROXY_DEBUG` | `false` | Debug logs (`DEBUG` in `config.json`) |

> 📄 Full reference: [Configuration](./docs/configuration.md)

### Recommended production config

```env
API_KEY=your-secret-key
OPENCODE_SERVER_PASSWORD=your-password
DISABLE_TOOLS=true
OPENCODE_EXTERNAL_TOOLS_MODE=proxy-bridge
OPENCODE_EXTERNAL_TOOLS_CONFLICT_POLICY=namespace
OPENCODE_INTERNAL_ALLOWED_TOOLS=web_fetch
OPENCODE_INTERNAL_TOOL_METRICS_ENABLED=true
OPENCODE_TOOL_DISCOVERY_FIXTURE=
OPENCODE_HEALTH_DETAILS_ENABLED=true
OPENCODE_HEALTH_DETAILS_REQUIRE_AUTH=true
OPENCODE_METRICS_ENABLED=false
OPENCODE_METRICS_REQUIRE_AUTH=true
OPENCODE_PROXY_PROMPT_MODE=plugin-inject
OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=true
OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS=true
```

### External tool bridge

- External `tools` sent by clients are never registered as OpenCode built-in tools.
- The proxy virtualizes them for the model and reshapes model output into OpenAI-compatible `tool_calls` / `function_call`.
- Same-name conflicts are isolated via an internal namespace (e.g. a client-side `web_fetch` never triggers the in-container OpenCode tool).
- Internal namespace names (e.g. `external__web_fetch`) are proxy implementation details, not public API.

### Built-in tool allowlist

- When a request carries **no** `tools`, the proxy enters internal-allowlist mode and only enables the OpenCode built-in tools listed in `OPENCODE_INTERNAL_ALLOWED_TOOLS`.
- `OPENCODE_INTERNAL_WEB_FETCH_ENABLED=true` is only a legacy shortcut: when `OPENCODE_INTERNAL_ALLOWED_TOOLS` is unset, the allowlist defaults to `web_fetch`.
- The proxy reads the backend tool list and resolves the final set via exact or `.<tool>` / `/<tool>` suffix match.
- If nothing in the allowlist matches the backend tool list, the proxy falls back to the safe mode with all built-in tools disabled.
- With `OPENCODE_INTERNAL_TOOL_METRICS_ENABLED=true`, the proxy logs internal-allowlist debug/metric info (mode selection, backend discovery, allowlist hits, downgrade reasons) without logging tool outputs.
- `OPENCODE_TOOL_DISCOVERY_FIXTURE` bypasses the real `client.tool.ids()` with a fixed tool-ID list for integration tests / local debugging.
- Once a client explicitly passes `tools`, the request returns to the external-tool bridge path and OpenCode built-in tools stay disabled.

### Structured diagnostics & Prometheus metrics

- `/health` stays a lightweight health check.
- `/health/details` returns structured JSON diagnostics; exposure via `OPENCODE_HEALTH_DETAILS_ENABLED`, auth via `OPENCODE_HEALTH_DETAILS_REQUIRE_AUTH`.
- `/metrics` returns Prometheus text metrics; exposure via `OPENCODE_METRICS_ENABLED`, auth via `OPENCODE_METRICS_REQUIRE_AUTH`.
- `/metrics` currently exposes internal tool mode, tool discovery failures, fallback counts, and tool-ID cache size.

---

## 🔌 API Reference

### Endpoints

| Method | Path | Description |
|:-----|:-----|:-----|
| `GET` | `/health` | Health check |
| `GET` | `/health/details` | Structured diagnostics (configurable exposure/auth) |
| `GET` | `/metrics` | Prometheus metrics (configurable exposure/auth) |
| `GET` | `/v1/models` | List available models |
| `POST` | `/v1/chat/completions` | Chat Completions API |
| `POST` | `/v1/responses` | Responses API |
| `POST` | `/v1/messages` | Anthropic Messages API (`max_tokens` required, supports `x-api-key`) |
| `POST` | `/v1beta/interactions` | Gemini-compatible thin layer (text + `google_search` grounding, `previous_interaction_id`, `store`, SSE without `[DONE]`) |
| `POST` | `/v1/interactions` | Alias of `/v1beta/interactions` |

### Model name formats

- Direct: `opencode/big-pickle`
- Aliased: `gpt5-nano` (auto-resolved to `gpt-5-nano`)
- Prefixed: `opencode/gpt5-nano`

> 📖 See [API Reference](./docs/api-reference.md)

---

## 🔧 Troubleshooting

### Requests hang but `/v1/models` works
```bash
OPENCODE_USE_ISOLATED_HOME=false  # Let OpenCode reuse the local login state
```

### Model not found
- List models: `curl http://127.0.0.1:10000/v1/models`
- Confirm the model ID matches exactly

### No reasoning output
- Use the Responses API with `stream: true`
- Send `reasoning.effort` or `reasoning_effort`

> 📖 Full guide: [Troubleshooting](./docs/troubleshooting.md)

---

## 🔨 Development

```bash
# Typecheck (tsc --noEmit)
npm run typecheck

# Build (tsc -> dist/, entry dist/index.js)
npm run build

# Local dev (tsx watch, source entry index.ts)
npm run dev

# Production start (run build output)
npm start

# Run tests
npm test -- --runInBand

# Docker dev
docker compose up -d --build
```

> TypeScript sources: `index.ts` + `src/**/*.ts`; build output: `dist/` (`dist/index.js` is the runtime entry; local `dist/` is not committed and stays out of the Docker context).

---

## 📄 License

MIT · See [LICENSE](./LICENSE.md)

---

## 🙏 Acknowledgments

This project is independently maintained at [samson910022/OpenCode2API](https://github.com/samson910022/OpenCode2API),
forked from [TiaraBasori/opencode2api](https://github.com/TiaraBasori/opencode2api) and inspired by
[dxxzst/opencode-to-openai](https://github.com/dxxzst/opencode-to-openai) and
[lucasliet/opencode-openai-proxy](https://github.com/lucasliet/opencode-openai-proxy).
Upstream code remains under its original MIT license; see [LICENSE](./LICENSE.md).

本项目由 [samson910022/OpenCode2API](https://github.com/samson910022/OpenCode2API) 独立维护，复刻（Fork）自
[TiaraBasori/opencode2api](https://github.com/TiaraBasori/opencode2api)；另受以下开源项目启发：[dxxzst/opencode-to-openai](https://github.com/dxxzst/opencode-to-openai)、[lucasliet/opencode-openai-proxy](https://github.com/lucasliet/opencode-openai-proxy)。中文版见 [README.zh-CN.md](./README.zh-CN.md)。
