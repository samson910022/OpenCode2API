# 🔌 API 参考

<p align="center">
  <img src="https://img.shields.io/badge/version-1.6.0-blue" alt="Version">
</p>

> 📖 [Docs Index](./README.md) | 🏠 [Main README](../README.md)

---

## 📋 基础信息

| 项目 | 值 |
|:-----|:---|
| **Base URL** | `http://127.0.0.1:10000` |
| **API Version** | `v1` |
| **认证方式** | Bearer Token (当 `API_KEY` 配置时必需) |

---

## 🔑 认证

```bash
# 带认证
curl -H "Authorization: Bearer YOUR_API_KEY" ...

# 不带认证 (未配置 API_KEY 时)
curl ...
```

---

## 📡 端点

### ✅ 健康检查

```http
GET /health
```

**响应示例:**

```json
{
  "status": "ok",
  "proxy": true
}
```

---

### 📋 模型列表

```http
GET /v1/models
```

> 需要认证：当配置了 `API_KEY` / `API_KEYS` / `OPENCODE_API_KEYS` 任一时，需 `Authorization: Bearer` 或 `x-api-key`；均未配置时免认证。

**响应示例:**

```json
{
  "object": "list",
  "data": [
    {
      "id": "opencode/big-pickle",
      "object": "model",
      "created": 1704067200,
      "owned_by": "opencode"
    }
  ]
}
```

---

### 💬 Chat Completions

```http
POST /v1/chat/completions
```

**请求体:**

| 参数 | 类型 | 必填 | 说明 |
|:-----|:-----|:-----|:-----|
| `model` | string | ✅ | 模型 ID |
| `messages` | array | ✅ | 消息数组 |
| `tools` | array | - | 外部工具定义数组，遵循 OpenAI-compatible function tools 结构 |
| `tool_choice` | string/object | - | 工具选择策略；会按代理桥接语义处理 |
| `stream` | boolean | - | 是否流式输出 |
| `temperature` | number | - | 温度 (0-2) |
| `top_p` | number | - | 核采样 (0-1) |
| `max_tokens` | number | - | 最大 token 数 |
| `reasoning_effort` | string | - | 推理强度 |

**示例:**

```bash
curl -X POST http://127.0.0.1:10000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/big-pickle",
    "messages": [{"role": "user", "content": "你好!"}],
    "stream": false
  }'
```

**带外部工具的示例:**

```bash
curl -X POST http://127.0.0.1:10000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/big-pickle",
    "messages": [
      {"role": "user", "content": "读取 https://example.com 并告诉我标题"}
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "web_fetch",
          "description": "Fetch a web page and summarize it",
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

当模型决定调用工具时，非流式响应会返回标准 `message.tool_calls`；流式响应会返回 `chat.completion.chunk` 中的 `delta.tool_calls`。

---

### 🧠 Responses API

```http
POST /v1/responses
```

**请求体:**

| 参数 | 类型 | 必填 | 说明 |
|:-----|:-----|:-----|:-----|
| `model` | string | ✅ | 模型 ID |
| `input` | string | ✅* | 输入文本 |
| `prompt` | string | ✅* | 提示词 |
| `messages` | array | ✅* | 消息数组 |
| `tools` | array | - | 外部工具定义数组，遵循 OpenAI-compatible function tools 结构 |
| `stream` | boolean | - | 是否流式输出 |
| `reasoning_effort` | string | - | 推理强度 |

> * 至少需要提供 `input`、`prompt` 或 `messages` 其中之一

**示例:**

```bash
curl -N -X POST http://127.0.0.1:10000/v1/responses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/muse-spark-1.3-contributor-free",
    "input": "打招呼",
    "reasoning": {"effort": "high"},
    "stream": true
  }'
```

**带外部工具的示例:**

```bash
curl -X POST http://127.0.0.1:10000/v1/responses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/muse-spark-1.3-contributor-free",
    "input": "东京现在天气怎么样？",
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

非流式 `responses` 响应会在 `response.output` 中返回 `type: "function_call"` 项；流式模式会发送 function_call 生命周期和参数增量事件。`previous_response_id` 续写会将完整父 session fork 为隔离子 session，不会向父 session 追加本轮消息；工具调用元数据只保留最近 128 条（超出时丢弃最旧、保留最新；按 response ID 链作用域保存，内存态、30min TTL + 60s 清扫，重启动失）。`function_call_output` 的 `call_id` 不在 state 且无 `name` 时返回 400 `unknown_tool_call_id`。

**服务端联网搜索（`web_search`）:**

```bash
curl -X POST http://127.0.0.1:10000/v1/responses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode-go/kimi-k2.5-free",
    "input": "PostgreSQL 最新版本是多少？",
    "tools": [{"type": "web_search"}]
  }'
```

`tools: [{"type": "web_search"}]`（亦接受 `web_search_preview` / `web_search_*` 版本化 / `google_search`）是显式授权：代理将其从外部 function 注册表剔除，转驱动 opencode 内置 `websearch`（需后端暴露该工具；可用性取决于模型/后端），并在输出中返回 `type: "web_search_call"` 项（含真实执行的 `action.query`）与 `url_citation` 引用（仅标注答案中实际出现的来源 URL，无编造）。流式模式会发送 `response.web_search_call.searching/completed` 事件，最终 `response.completed` 携带完整引用。注意：`/v1beta|/v1/interactions` 仅接受字面 `google_search` / `web_search` / `web_search_preview`（版本化 `web_search_YYYYMMDD` 在此会 400）。

### 🔁 Interactions API（Gemini 兼容薄层）

```http
POST /v1beta/interactions
POST /v1/interactions
```

| 参数 | 类型 | 必填 | 说明 |
|:-----|:-----|:-----|:-----|
| `model` / `agent` | string | ✅（二选一） | 模型 ID（`agent` 暂仅占位） |
| `input` | string \| array | ✅ | 输入文本/消息 |
| `system_instruction` | string | - | 系统指令 |
| `tools` | array | - | 仅支持 `{type: "google_search"}`（等价 `web_search`），其余 function 工具返回 400 |
| `previous_interaction_id` | string | - | 续写上轮会话（等价 responses 的 `previous_response_id`） |
| `stream` | boolean | - | SSE：`interaction.created` / `step.delta` / `interaction.completed`（无 `[DONE]`，错误为 `{type:'error'}` 事件；15s heartbeat） |
| `store` | boolean | - | `false` 则不持久化；仅删除本请求新建或 fork 的子会话，父会话保留且不会被本轮修改 |

响应为 `Interaction` 资源：`{id, status, model, output_text, steps[], usage: {grounding_tool_count}}`，其中 `steps` 含 `google_search_call{queries}`、`google_search_result{sources}`（标注为 opencode websearch 代理结果，非 Google 原生）、`model_output{text, annotations}`。文本往返与 `web_search` 接地逻辑复用 Responses 管线；限流错误的重试与代理 fallback 和其余路由一致（engage + 换 session，最多 `maxAttempts` 次），普通错误直接返回。

### Continuation 幂等与重试

`POST /v1/responses`、`POST /v1beta/interactions` 与别名 `POST /v1/interactions` 支持可选的 `Idempotency-Key` 请求头。建议每个逻辑操作使用唯一 key，并在超时或断线后用**相同 key 与相同 JSON 请求体**重试。作用域按认证租户（API key 的摘要；未启用鉴权时共用匿名租户）、端点、父 ID（`previous_response_id` / `previous_interaction_id`）及 key 隔离；两个 Interactions 路径是同一端点，故共享幂等记录。Responses 与 Interactions 之间、不同父 ID 之间、不同 API key 租户之间不会共享记录。

- 同一作用域内 key 对应不同 payload 时返回 `409`，错误码 `idempotency_key_reused`；同一请求仍在处理中时返回可重试的 `409 idempotency_in_progress`。请求体按 JSON 规范化后比较，对象属性顺序不影响 payload hash。
- 已确认完成的 JSON 或 SSE 响应会缓存并**从头精确重播**：包括原 HTTP 状态、相关响应头与完整响应 body。SSE 重试不是从断点续传，而是重放原始流的全部字节及终止事件。
- 如果 prompt 已提交但结果尚未确认，结果会标记为未知。使用相同 key 重试只会轮询/调和已记录的子 session 与消息；不会再次提交 prompt，也不会因为未确认而创建另一个子 session。尚未确认时可能收到 `503 idempotency_reconciliation_pending`，稍后继续用原 key 和原 payload 查询。
- 带 continuation parent ID 的新操作会从完整父 session fork 一个隔离子 session；本轮写入 child，不修改 parent。这样允许多个分支独立续写。
- Idempotency ledger 是**进程内存态**。已完成/确定失败的可重播记录目前固定保留 60 分钟（代码保留时长下限为 30 分钟，当前没有配置项）；未完成请求中的 `in_progress` 记录不会按 TTL 淘汰，断线且尚未提交 prompt 时会被放弃，已提交但结果未确认时则转为 `unknown`。`unknown` 记录不会自动过期或淘汰，只能在成功调和后释放，无法调和时会保留到服务重启，并可能使该租户后续新 key 遇到容量限制。服务重启会丢失全部记录；多进程/多副本之间不共享记录。因此它能防止同一进程生命周期内的重复执行，不能替代跨重启或分布式的持久化幂等存储。

### 🧭 推荐提示模板（OpenClaw / Claude Code）

在真实运行环境中，如果你希望第一跳**稳定先产出 tool call**，推荐把“调用工具”和“基于工具结果继续回答”拆成两步，而不是混在同一句里。

**推荐第一跳提示：**

```text
Call weather_lookup for Tokyo now. Do not answer directly.
```

或中文：

```text
现在调用 weather_lookup 查询 Tokyo。不要直接回答。
```

收到 `tool_calls` / `function_call` 后，再把工具结果回灌，并追加第二跳提示：

```text
Great, now answer the original request using the tool result.
```

或中文：

```text
很好，现在基于工具结果回答原始问题。
```

### 为什么推荐两段式提示

- 第一跳只负责**稳定产出工具调用**
- 第二跳只负责**基于工具结果生成最终回答**
- 这样比把“先调工具再回答”写在同一条用户消息里更稳定，尤其适合 OpenClaw、Claude Code 这类 agent 客户端

### 推荐的 agent 行为

1. 先发送严格的 tool-only 提示
2. 如果收到 `tool_calls` / `function_call`，执行工具
3. 回灌工具结果
4. 再发送第二跳提示要求模型整合工具结果回答

> 这个两段式模式是当前 `opencode2api` 外部工具桥接的推荐集成方式。

### 🌊 流式工具调用

```bash
curl -N -X POST http://127.0.0.1:10000/v1/responses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/muse-spark-1.3-contributor-free",
    "input": "查询东京天气",
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
              "city": {"type": "string"}
            },
            "required": ["city"]
          }
        }
      }
    ]
  }'
```

当启用流式模式时：

- Chat Completions 会在 `chat.completion.chunk` 中返回 `delta.tool_calls`
- Responses API 会返回 `response.output_item.added`、`response.function_call_arguments.delta`、`response.function_call_arguments.done`、`response.output_item.done` 等事件
- Messages API 会返回 `message_start`、`content_block_start`、`content_block_delta`（`text_delta`/`thinking_delta`/`input_json_delta`）、`content_block_stop`、`message_delta`、`message_stop`（无 `[DONE]`）

> 注意：代理内部会使用命名空间隔离同名工具，但这些内部名称不会作为公开 API 返回给客户端。

---

### 🟣 Messages API（Anthropic 兼容）

`POST /v1/messages`。认证可用 `Authorization: Bearer` 或 `x-api-key`；`max_tokens` 必填；首条 message 须为 `user`。

| 字段 | 说明 |
|:-----|:-----|
| `model` | 模型 ID（支持 `opencode/` 前缀或裸名） |
| `max_tokens` | 必填，最大输出 tokens |
| `system` | string 或 `[{type:'text', text}]` |
| `messages` | `user`/`assistant` 数组，content 支持 `text`、`image`（base64/url）、`tool_use`、`tool_result` |
| `tools` | `[{name, description, input_schema}]`（`input_schema` 即 JSON Schema） |
| `tool_choice` | `{type:'auto'|'any'|'tool'|'none', name?}`（`any`≈强制调用） |
| `thinking` | `{type:'enabled', budget_tokens}` 映射为推理强度（`disabled`→关闭） |
| `stream` | bool，流式返回 Anthropic SSE 事件 |
| `temperature` / `top_p` / `stop_sequences` | 透传（`stop_sequences`→`stop`）；`top_k` 暂忽略 |

**示例:**

```bash
curl -X POST http://127.0.0.1:10000/v1/messages \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/muse-spark-1.3-contributor-free",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "用一句话打招呼"}]
  }'
```

**带工具的示例:**

```bash
curl -X POST http://127.0.0.1:10000/v1/messages \
  -H "x-api-key: YOUR_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/muse-spark-1.3-contributor-free",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "查询东京天气"}],
    "tools": [
      {
        "name": "weather_lookup",
        "description": "Look up weather by city",
        "input_schema": {
          "type": "object",
          "properties": {"city": {"type": "string"}},
          "required": ["city"]
        }
      }
    ]
  }'
```

工具调用以 `content: [{type:'tool_use', id, name, input}]` 返回（`stop_reason: 'tool_use'`），下一轮把 `tool_use` + `tool_result` 回灌进 `messages` 即可继续。`thinking` 以无签名 `thinking` block 返回（多轮透传签名暂为占位空串）。

---

## 🔧 推理强度

| 输入值 | 映射结果 |
|:-------|:---------|
| `minimal` | `none` |
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `xhigh` | `high` |

---

## ⚠️ 错误响应

### 401 Unauthorized

chat / models / responses / interactions（OpenAI 形状）:

```json
{
  "error": {
    "message": "Unauthorized"
  }
}
```

messages（Anthropic 形状）:

```json
{
  "type": "error",
  "error": {
    "type": "authentication_error",
    "message": "Unauthorized"
  }
}
```

### 404 Not Found

```json
{
  "error": {
    "message": "Model not found",
    "type": "invalid_request_error",
    "code": "model_not_found"
  }
}
```

### 500 Internal Server Error

```json
{
  "error": {
    "message": "Internal server error",
    "type": "server_error",
    "code": "internal_error"
  }
}
```

> 后端偶发 `500 {"message":"Aborted","type":"internal_error","code":"MessageAbortedError"}` 为上游 session 瞬断（非代理超时；代理超时为 504 `Request timeout`），直接重试同一请求即可；`isTransient` 不覆盖该签名，故不自动重试。
