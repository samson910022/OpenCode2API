# ⚙️ 配置详解

<p align="center">
  <img src="https://img.shields.io/badge/version-1.6.0-blue" alt="Version">
</p>

---

## 📌 配置方式

> 配置优先级：**环境变量 > config.json > 默认值**

---

## 🔧 环境变量

### 核心配置

| 变量 | 默认值 | 说明 |
|:-----|:-------|:-----|
| `PORT` / `OPENCODE_PROXY_PORT` | `10000` | 代理服务端口 |
| `OPENCODE_SERVER_PORT` | `10001` | OpenCode 后端服务端口 |
| `API_KEY` | - | Bearer Token 认证密钥 |
| `API_KEYS` / `OPENCODE_API_KEYS` | - | 多 client keys（逗号分隔，任一通过；与 `API_KEY` 合并；为空回退免认证） |
| `BIND_HOST` | `0.0.0.0` | 绑定地址（`BIND_HOST` 优先，`OPENCODE_PROXY_BIND_HOST` 为后备） |
| `OPENCODE_SERVER_URL` | `http://127.0.0.1:10001` | OpenCode 后端地址 |
| `OPENCODE_SERVER_PASSWORD` | - | OpenCode 后端密码 |

### 功能配置

| 变量 | 默认值 | 说明 |
|:-----|:-------|:-----|
| `OPENCODE_DISABLE_TOOLS` / `DISABLE_TOOLS` | `true` | 禁用 OpenCode 工具调用（兼容别名；`OPENCODE_DISABLE_TOOLS` 优先，二者无效值都会让位给下一顺位：canonical env > legacy env > `config.json` > 默认） |
| `OPENCODE_EXTERNAL_TOOLS_MODE` | `proxy-bridge` | 外部工具桥接模式；当前仅支持 `proxy-bridge` |
| `OPENCODE_EXTERNAL_TOOLS_CONFLICT_POLICY` | `namespace` | 外部工具冲突隔离策略；当前仅支持 `namespace` |
| `OPENCODE_INTERNAL_WEB_FETCH_ENABLED` | `false` | 兼容旧开关；未显式配置 allowlist 时，启用后默认放行 `web_fetch` |
| `OPENCODE_INTERNAL_ALLOWED_TOOLS` | `(none)` | 当请求未传入 `tools` 时允许使用的 OpenCode 内置工具列表，逗号分隔（例 `websearch,webfetch`；`web_fetch` 等旧写法仍可匹配，大小写/分隔符不敏感） |
| `OPENCODE_INTERNAL_TOOL_METRICS_ENABLED` | `true` | 输出 internal allowlist 模式的调试/指标日志 |
| `OPENCODE_TOOL_DISCOVERY_FIXTURE` | `(none)` | 集成测试/本地调试用的固定后端工具 ID 列表，逗号分隔 |
| `OPENCODE_HEALTH_DETAILS_ENABLED` | `true` | 控制 `/health/details` 是否暴露 |
| `OPENCODE_HEALTH_DETAILS_REQUIRE_AUTH` | `true` | 控制 `/health/details` 是否要求 Bearer 认证 |
| `OPENCODE_METRICS_ENABLED` | `false` | 控制 Prometheus `/metrics` 是否暴露 |
| `OPENCODE_METRICS_REQUIRE_AUTH` | `true` | 控制 `/metrics` 是否要求 Bearer 认证 |
| `OPENCODE_USE_ISOLATED_HOME` | `false` | 使用隔离的 OpenCode 配置目录（`config.json` 中用短键 `USE_ISOLATED_HOME`） |
| `OPENCODE_PROXY_PROMPT_MODE` | `standard` | 提示词处理模式（`config.json` 中用短键 `PROMPT_MODE`） |
| `OPENCODE_PROXY_OMIT_SYSTEM_PROMPT` | `false` | 忽略传入的 system prompt（`config.json` 中用短键 `OMIT_SYSTEM_PROMPT`） |
| `OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS` | `false` | 自动清理会话存储（`config.json` 中用短键 `AUTO_CLEANUP_CONVERSATIONS`） |
| `OPENCODE_PROXY_CLEANUP_INTERVAL_MS` | `43200000` | 清理间隔 (毫秒)（`config.json` 中用短键 `CLEANUP_INTERVAL_MS`） |
| `OPENCODE_PROXY_CLEANUP_MAX_AGE_MS` | `86400000` | 最大存储时间 (毫秒)（`config.json` 中用短键 `CLEANUP_MAX_AGE_MS`） |
| `OPENCODE_PROXY_REQUEST_TIMEOUT_MS` | `180000` | 请求超时时间 (毫秒)（`config.json` 中用短键 `REQUEST_TIMEOUT_MS`） |
| `OPENCODE_PROXY_RETRY_MAX_RETRIES` | `3` | 首次失败后重试次数 (0-5，总尝试 1+n；退避指数+jitter 并优先 `retry-after`)（`config.json` 中用短键 `RETRY_MAX_RETRIES`） |

> 重试退避移植自上游 `session/retry.ts`（`2s×2ⁿ⁻¹` +25% jitter），但 `retry-after` 等待 clamp 在 30s（上游近无界；网关面对自带超时的客户端不宜久睡）。旧部署注意：默认总尝试由 3 次变为 1+3=4 次，如需接近旧次数可设 `2`。

### 免费额度 fallback 代理

平时直连、零开销；仅当上游返回免费/Go 配额耗尽（`429 + FreeUsageLimitError/GoUsageLimitError`）时自动切到代理并按冷却粘滞，普通 5xx 不触发。

> 两跳模型：代理作用于网关 → OpenCode 后端这一跳。若后端是远端地址（`OPENCODE_SERVER_URL` 非 loopback），切换出口 IP 可命中新的匿名/IP 配额；若是默认本地托管后端（`127.0.0.1`，恒直连 bypass），fallback 退化为同后端直接重试 + engaged 状态标记——此时如需改变后端 → Zen 的出口 IP，需给后端进程配 `HTTP(S)_PROXY`（`spawn` 会继承环境）。

| 变量 | 默认值 | 说明 |
|:-----|:-------|:-----|
| `OPENCODE_UPSTREAM_PROXIES` | `(none)` | 逗号分隔的代理 URL（`socks5://` 优先，亦支持 `http(s)://`；`config.json` 中用短键 `UPSTREAM_PROXIES` 数组） |
| `OPENCODE_UPSTREAM_PROXY_STRATEGY` | `failover-rr` | `failover-rr` / `round-robin` / `random`（连续限流即轮换下一个） |
| `OPENCODE_UPSTREAM_PROXY_COOLDOWN_MS` | `300000` |  engaged 粘滞时长（毫秒），到期回直连 |
| `OPENCODE_UPSTREAM_PROXY_NO_PROXY` | `localhost,127.0.0.1,::1` | 永不走代理的目标 host（默认后端 `127.0.0.1` 恒直连） |

> 注意：`GET /health/details` 的 `internal_tools.fallback_proxies` 可观察 engaged 状态；`/metrics` 有 `opencode_fallback_proxy_engaged` gauge。流式 SSE 不走自定义 fetch（上游 SDK 缺口），fallback 自动降级为轮询。

### 调试配置

| 变量 | 默认值 | 说明 |
|:-----|:-------|:-----|
| `OPENCODE_PROXY_DEBUG` | `false` | 开启调试日志（`config.json` 中用短键 `DEBUG`） |
| `OPENCODE_PROXY_MANAGE_BACKEND` | `false` | 是否由代理拉起本地后端（`config.json` 中用短键 `MANAGE_BACKEND`；prod/`index.ts` 默认 `false`，library/`buildProxyConfig` 默认 `true`——已知双入口差异） |
| `OPENCODE_PATH` | `opencode` | OpenCode 可执行文件路径 |
| `OPENCODE_ZEN_API_KEY` | - | Zen API Key 透传 |

---

## 📄 config.json 示例

```json
{
    "PORT": 10000,
    "API_KEY": "your-secret-api-key",
    "API_KEYS": ["key-alpha", "key-beta"],
    "BIND_HOST": "0.0.0.0",
    "DISABLE_TOOLS": true,
    "EXTERNAL_TOOLS_MODE": "proxy-bridge",
    "EXTERNAL_TOOLS_CONFLICT_POLICY": "namespace",
    "INTERNAL_WEB_FETCH_ENABLED": false,
    "INTERNAL_ALLOWED_TOOLS": ["web_fetch"],
    "INTERNAL_TOOL_METRICS_ENABLED": true,
    "INTERNAL_TOOL_DISCOVERY_FIXTURE": [],
    "HEALTH_DETAILS_ENABLED": true,
    "HEALTH_DETAILS_REQUIRE_AUTH": true,
    "METRICS_ENABLED": false,
    "METRICS_REQUIRE_AUTH": true,
    "USE_ISOLATED_HOME": false,
    "PROMPT_MODE": "standard",
    "OMIT_SYSTEM_PROMPT": false,
    "AUTO_CLEANUP_CONVERSATIONS": false,
    "CLEANUP_INTERVAL_MS": 43200000,
    "CLEANUP_MAX_AGE_MS": 86400000,
    "DEBUG": false,
    "OPENCODE_SERVER_URL": "http://127.0.0.1:10001",
    "OPENCODE_SERVER_PASSWORD": "",
    "OPENCODE_PATH": "opencode",
    "ZEN_API_KEY": "",
    "MANAGE_BACKEND": false,
    "REQUEST_TIMEOUT_MS": 180000,
    "RETRY_MAX_RETRIES": 3,
    "UPSTREAM_PROXIES": [],
    "UPSTREAM_PROXY_STRATEGY": "failover-rr",
    "UPSTREAM_PROXY_COOLDOWN_MS": 300000,
    "UPSTREAM_PROXY_NO_PROXY": ["localhost", "127.0.0.1", "::1"]
}
```

---

## 🛠️ 外部工具桥接

OpenCode2API 现在支持把外部客户端传入的 OpenAI-compatible `tools` 桥接到代理层，而不是把这些工具直接暴露为 OpenCode 内置工具。

### 当前支持的模式

| 配置项 | 支持值 | 说明 |
|:------|:------|:-----|
| `OPENCODE_EXTERNAL_TOOLS_MODE` | `proxy-bridge` | 由代理虚拟化外部工具，并返回 OpenAI-compatible tool calling 结果（`config.json` 中用短键 `EXTERNAL_TOOLS_MODE`） |
| `OPENCODE_EXTERNAL_TOOLS_CONFLICT_POLICY` | `namespace` | 使用代理内部命名空间隔离同名冲突（`config.json` 中用短键 `EXTERNAL_TOOLS_CONFLICT_POLICY`） |

### 工具冲突策略

- 外部客户端工具优先以“代理桥接”的方式参与对话。
- OpenCode 内置工具仍按现有 `DISABLE_TOOLS` 机制管理，不会因为客户端传入同名工具而被误触发。
- 代理内部会使用类似 `external__web_fetch` 的命名空间名避免冲突。
- 这些内部命名空间名称不会作为公开 API 的一部分暴露给客户端。

### 内置工具 allowlist

- 当请求 **未传入** `tools` 时，代理会进入 internal allowlist 模式，只允许 `OPENCODE_INTERNAL_ALLOWED_TOOLS` 中声明的 OpenCode 内置工具。
- `OPENCODE_INTERNAL_WEB_FETCH_ENABLED=true` 仅用于兼容旧配置：如果未显式配置 allowlist，则默认把 allowlist 视为 `web_fetch`。
- 代理会读取后端工具列表，并通过精确匹配、`.<tool>` / `/<tool>` 后缀匹配或大小写/分隔符不敏感匹配（如 `web_fetch` ↔ `webfetch`）解析最终可用工具。
- 要启用上游搜索（`opencode`/`opencode-go` provider 自带 `websearch`，免额外 key）：`OPENCODE_INTERNAL_ALLOWED_TOOLS=websearch,webfetch`，模型用 `opencode-go/<model>`，并确保后端 `permission.websearch=allow`（默认 agent 已放行，无人值守勿设 `ask`）。
- 如果配置的 allowlist 在后端工具列表中一个也没有匹配到，代理会自动回退到“全部内置工具禁用”的安全模式。
- `OPENCODE_INTERNAL_TOOL_METRICS_ENABLED=true` 时，会输出 internal allowlist 模式的调试/指标日志，记录模式选择、后端工具发现、allowlist 命中情况和降级原因，但不会记录工具输出内容。
- `OPENCODE_TOOL_DISCOVERY_FIXTURE` 可在集成测试或本地调试时绕过真实 `client.tool.ids()`，直接提供固定工具 ID 列表。
- 一旦客户端传入 `tools`，请求立即切回外部工具桥接模式，所有 OpenCode 内置工具继续保持禁用。

### 请求级 allowlist 覆盖 (Request-Level Override)

在请求未传入 `tools` 的前提下，客户端可以在请求体中传入自定义字段 `opencode.internal_allowed_tools` 来覆盖服务端的默认内置工具列表。
出于安全隔离原则，请求级覆盖**只能缩小（求交集），不能扩大**服务端的 allowlist 权限：
- 如果请求了服务端未开启的内置工具，该工具会被自动忽略。
- `effective_allowlist = intersection(server_allowlist, request_allowlist)`

**示例：**
```json
{
  "model": "opencode/muse-spark-1.3-contributor-free",
  "messages": [{"role": "user", "content": "Fetch this URL"}],
  "opencode": {
    "internal_allowed_tools": ["web_fetch"]
  }
}
```

### 结构化健康诊断接口

可以通过 `GET /health/details` 接口获取代理内部的运行状态与指标。这不仅有助于问题排查，也是用于编写集成行为测试的重要依据。
- `OPENCODE_HEALTH_DETAILS_ENABLED=false` 时，接口返回 `404`。
- `OPENCODE_HEALTH_DETAILS_REQUIRE_AUTH=true` 时，接口要求 Bearer 认证；否则返回 `401`。
返回值格式如下：
```json
{
  "status": "ok",
  "proxy": true,
  "internal_tools": {
    "config": {
      "allowed_tools": ["web_fetch", "filesystem"],
      "metrics_enabled": true,
      "discovery_fixture": ["web_fetch", "filesystem", "bash"]
    },
    "metrics": {
      "externalBridgeRequests": 12,
      "internalAllowlistRequests": 8,
      "disabledRequests": 21,
      "discoveryFailures": 1,
      "fallbackToDisabled": 2
    },
    "cache": {
      "tool_ids_cached": true,
      "tool_id_count": 3,
      "age_ms": 12000
    },
    "audit": {
      "available": true,
      "fields": [
        "requestedAllowlist",
        "allowedToolNames",
        "deniedRequestedTools",
        "resolutionPath",
        "resultingMode"
      ]
    }
  }
}
```

### Prometheus 指标接口

可以通过 `GET /metrics` 获取 Prometheus 文本格式指标。
- `OPENCODE_METRICS_ENABLED=false` 时，接口返回 `404`。
- `OPENCODE_METRICS_REQUIRE_AUTH=true` 时，接口要求 Bearer 认证；否则返回 `401`。
当前暴露的核心指标包括：
- `opencode_internal_tool_mode_requests_total{mode="external_bridge"}`
- `opencode_internal_tool_mode_requests_total{mode="internal_allowlist"}`
- `opencode_internal_tool_mode_requests_total{mode="disabled"}`
- `opencode_internal_tool_discovery_failures_total`
- `opencode_internal_tool_fallback_disabled_total`
- `opencode_internal_tool_cache_ids`

### 推荐生产配置

```bash
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


---

## 🎯 Prompt Mode 说明

| 模式 | 说明 |
|:-----|:-----|
| **standard** (默认) | 标准模式，完整处理提示词 |
| **plugin-inject** | 插件注入模式，减小模型侧提示词大小，通常与 `OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=true` 配合使用 |

---

## ⭐ 推荐配置

### 🐳 Docker 生产环境

```bash
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


### 💻 本地开发

```bash
DISABLE_TOOLS=false
OPENCODE_PROXY_DEBUG=true
```
