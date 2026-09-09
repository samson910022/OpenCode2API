# Architecture

> **Language:** English only for now (Chinese translation tracked).
>
> 📖 [Docs Index](./README.md) | 🏠 [Main README](../README.md)

This note describes the runtime shape of opencode2api, where the
duplication hotspots are, and how to extend the gateway without breaking
wire behavior. It is a companion to `AGENTS.md` §9.

---

## 1. Runtime shape

```
index.ts (env > file > default merge + bootstrap)
  └─> startProxy(opts) [src/proxy.ts]
        ├─> buildProxyConfig(opts) [src/config/proxy-config.ts]
        └─> createApp(config) [src/proxy.ts]
              ├─> registerSystemRoutes   [src/routes/system.ts]    (models / health / metrics, no lock)
              ├─> registerChatRoutes     [src/routes/chat.ts]      (POST /v1/chat/completions, request lock)
              ├─> registerResponsesRoutes[src/routes/responses.ts] (POST /v1/responses, cancel race)
              ├─> registerInteractionsRoutes[src/routes/interactions.ts] (POST /v1beta|/v1/interactions, Gemini thin layer)
              └─> registerMessagesRoutes [src/routes/messages.ts] (POST /v1/messages, Anthropic converters first)
```

Cross-cutting helpers (all routes depend on them one-way; no cycles):

| Layer | File | Role |
|:------|:-----|:-----|
| Backend | `src/backend/manager.ts` | lifecycle + request lock/queue + `opencode` binary lookup |
| Stream | `src/stream/collector.ts` | prompt → poll → collect-from-events SSE pipeline |
| Errors | `src/errors/upstream.ts` | `normalizeBackendError`, `transformUpstreamError`, `isTransient*` |
| Retry | `src/retry/policy.ts` | pure `resolveMaxRetries` / backoff+jitter / `retry-after` parsing |
| Converters | `src/converters/` (N×N registry) | pure protocol↔protocol shapes; see §4 |
| Tool runtime | `src/tool-runtime/` | `contracts → registry → router → parser → validator → policy` |
| Guards | `src/utils/guards.ts` | shared `asRecord` / `toErrorMessage` (single source) |

`retry/policy`, `converters/*`, and `errors/upstream` are pure
(no Express/SDK imports) — keep them that way.

## 2. Request template (all four main routes)

Every `POST` route repeats the same template with small per-protocol
differences:

1. `resolveRequestedModel` (under `withTimeout`)
2. `createRequestToolContext` + `trackToolMode`
3. `buildSystemPrompt` (system + external prompt + reasoning + tool mode)
4. `ensureBackend` → `client.config.update({ activeModel })` → `session.create`
5. `getToolOverridesForMode` → prompt → poll/collect → render
6. usage estimate (`Math.ceil(len / 4)` or `estimateTokens`) + session cleanup

Known intentional differences — do not "unify" them without approval:
stream `flushHeaders` timing (responses flushes before preflight, chat /
messages after), `lock()` wrapping (chat + messages only), cancel via
`res 'close'`, `forbidThinkBlock` per route, and the four error-exit
shapes (chat non-stream JSON; responses-stream `response.failed` SSE +
`[DONE]`; messages-stream `error` event without `[DONE]`;
interactions-stream `interaction.completed` / `error` event without `[DONE]`).

## 3. Extension points

- **New route:** add `src/routes/xxx.ts` exporting
  `registerXxxRoutes(app, ctx)`, wire it in `src/proxy.ts` before the
  404 fallback, add request/response types under `src/types/`. Copy the
  §2 template; do not refactor the existing four routes in the same
  change.
- **New converter** (e.g. another vendor protocol): add a pure module
  under `src/converters/<pair>/` (`request.ts` / `response.ts` / `init.ts`
  with `register*Pair`), wire it in `src/converters/init.ts`
  (`registerAllTranslatorPairs`), and add `tests/translator-*.test.js`.
  Keep route glue (choice mapping, id round-trip) in the route file.
- **New tool dialect:** extend `src/tool-runtime/parser.ts` (regex +
  extractor + registration in the collector) and add fixtures to
  `tests/parser-foreign-formats.test.js`. The ambiguity policy is
  registry-gated — loosening it turns prose into phantom tool calls.
- **New policy dimension:** add constants in `contracts.ts`, read them
  in `policy.ts` via the existing context, and thread config through
  `ProxyConfig` + `index.ts` merge + `proxy-config.ts` merge + the
  six-way matrix (`AGENTS.md` §4).

## 4. No-touch list (needs explicit approval + regression tests)

Timeout/retry constants, `transformUpstreamError` mappings,
`isTransientUpstreamError` matchers, parser ambiguity policy, prompt
guard text/order, model alias rules, policy evaluation order, backend
spawn/jail/HOME isolation, collector `finish === 'tool'` /
idle-exemption logic, and bool-fallthrough semantics. See `AGENTS.md`
§9 for the full list.

## 5. N×N translator registry (`src/converters/`)

Port of CLIProxyAPI `sdk/translator/` (`registry.go` / `pipeline.go` /
`formats.go` / `types.go`) plus per-pair translators under
`internal/translator/`. Four formats — `openai` (chat), `openai-response`
(responses), `claude` (messages), `interactions` — give 12 directed request
pairs and 12 directed response pairs (stream + non-stream), all registered
explicitly in `src/converters/init.ts` (`registerAllTranslatorPairs`;
no Go-style blank-import side effects so Jest ESM ordering stays
deterministic).

Rules that keep the port safe:

- Translators are pure JSON→JSON (no Express/SDK). Shared guards come
  from `src/utils/guards.ts`.
- Wire stays route-owned: SSE envelopes, `[DONE]` presence, the four
  error-exit shapes, and usage key names are never normalized by the
  registry. Error bodies must bypass translators (converters assume valid
  requests).
- Lookup contract differs from Go on purpose: Go reads
  `responses[to][from]` in `TranslateStream/NonStream` while `Has*` reads
  `[from][to]`; here everything is `[from][to]` = (source, target) so
  `Has*` and `Translate*` agree (see `registry.ts` header).
- Stream state rides `param` holder objects (one per stream), mirroring
  Go `param *any`; callers must reuse the holder across chunks.
- Fidelity is recorded in `src/converters/fidelity.ts`: the three forward
  edges out of chat (→ responses / messages / interactions) are FULL
  fidelity; the other nine stream edges are TEXT-CORE (text deltas +
  terminal mapping, zero-filled usage). TokenCount translators are
  intentionally unregistered — counting stays in the collector.
- `usage.ts` maps usage legs with zero-filled unknowns; interactions
  responses never carry tokens (`grounding_tool_count` only).

## 6. Roadmap (accepted, not yet implemented)

- Extract shared `preflight(ctx, body)` (resolve model → tool context →
  system prompt → ensureBackend → create session → tool overrides).
- Extract a `stream-kit` (SSE headers + 15s keepalive + filter/parser
  pair + collect + flush/parse + usage) with per-route differences kept
  as parameters, not unified.
- Extract `withSessionRetry(maxAttempts, fn)` for the non-stream
  delete → create → `computeRetryDelay` sleep skeleton.
- Unify the three config-merge dialects behind one module **without**
  changing the documented default drifts (`AGENTS.md` §4) — defaults
  change behavior and need their own tested proposal.
