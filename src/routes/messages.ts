// P4 TS: POST /v1/messages (Anthropic, ported from P3 .js, behavior identical).
import crypto from 'crypto';
import { findExternalToolByName } from '../tool-runtime/registry.js';
import { EXTERNAL_TOOL_PREFIX } from '../tool-runtime/contracts.js';
import { preflightExternalToolChoice } from '../tool-runtime/router.js';
import { computeRetryDelay } from '../retry/policy.js';
import {
  validateMessagesRequest,
  mapFinishToStopReason,
  buildAnthropicMessage,
  sseEvent,
  estimateTokens,
} from '../converters/anthropic.js';
import { defaultTranslatorRegistry } from '../converters/registry.js';
import { ensureTranslatorsRegistered } from '../converters/wire.js';
import { resolveMessagesReasoningLevel } from '../converters/chat-messages/request.js';
import {
  assertToolCallArtifactIntegrity,
  stripExternalToolCallMarkupFromJoinedText,
  parseExternalToolCallsFromJoinedText,
  mergeToolCallArtifacts,
  createToolCallFilter,
  createExternalToolCallStreamParser,
} from '../tool-runtime/parser.js';
import { isTransientUpstreamError, normalizeBackendError, transformUpstreamError } from '../errors/upstream.js';
import { engageFallbackForFreeLimit } from '../upstream-proxy/fallback.js';
import { detectHostedSearchTools } from '../search/grounding.js';
import {
  withTimeout,
  DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS,
  DEFAULT_EVENT_IDLE_TIMEOUT_MS,
} from '../config/proxy-config.js';
import { sleep, lock, ensureBackend } from '../backend/manager.js';
import { getImageDataUri } from '../stream/collector.js';
import type { Application, Request, Response } from 'express';
import type { AppContext } from '../types/context.js';
import type { FinalToolCall } from '../tool-runtime/parser.js';
import { asRecord, toErrorMessage } from '../utils/guards.js';

export function registerMessagesRoutes(app: Application, ctx: AppContext): void {
  const {
    client,
    config,
    REQUEST_TIMEOUT_MS,
    DISABLE_TOOLS,
    maxAttempts,
    resolveRequestedModel,
    logDebug,
    buildSystemPrompt,
    selectPromptToolOverrides,
    normalizeReasoningEffort,
    normalizeTextContent,
    normalizeToolArguments,
    createRequestToolContext,
    finalizeValidatedToolCalls,
    finalizeStreamToolCalls,
    toPublicToolCalls,
    createForcedToolCallRequester,
    trackToolMode,
    getToolOverridesForMode,
    promptWithTimeout,
    collectFromEvents,
    pollForAssistantResponse,
    proxyPool,
    proxyClient,
    proxyPromptWithTimeout,
    proxyPollForAssistantResponse,
    translators,
  } = ctx;
  const activeTranslators = translators ?? ensureTranslatorsRegistered(defaultTranslatorRegistry());

  app.post('/v1/messages', async (req: Request, res: Response): Promise<void> => {
    try {
      await lock(async (): Promise<void> => {
         let sessionId: string | null = null;
         let keepaliveInterval: ReturnType<typeof setInterval> | null = null;
         const requestAbortController = new AbortController();
         let disconnectedSessionCleaned = false;

        // P3 fallback bundle: direct by default; adopts the proxy bundle when
        // this request hits a free-limit error (or the pool is already engaged).
        let activeClient = client;
        let activePromptWithTimeout = promptWithTimeout;
        let activePollForAssistantResponse = pollForAssistantResponse;
        let fallbackToProxy = false;
        const switchToProxyBundle = (): boolean => {
          if (!proxyClient) return false;
          activeClient = proxyClient;
          activePromptWithTimeout = proxyPromptWithTimeout;
          activePollForAssistantResponse = proxyPollForAssistantResponse;
          fallbackToProxy = true;
          return true;
        };
        const engageProxyFallback = (err: unknown): boolean => {
          if (!engageFallbackForFreeLimit(err, proxyPool)) return false;
          return switchToProxyBundle();
        };
        if (proxyPool.isEngaged()) switchToProxyBundle();
        try {
          const rawBody: unknown = (req as unknown as { body: unknown }).body;
          const validationError = validateMessagesRequest(rawBody);
          if (validationError) {
            res.status(validationError.statusCode).json(validationError.body);
            return;
          }
          const body = asRecord(rawBody);
          const model: unknown = body['model'];
          const system: unknown = body['system'];
          const messagesRaw: unknown = body['messages'];
          const toolsRaw: unknown = body['tools'];
          const tools: unknown[] = Array.isArray(toolsRaw) ? (toolsRaw as unknown[]) : [];
          // Anthropic server-side web_search would be silently dropped by the
          // function-tool bridge; fail loudly with a pointer instead. Uses the
          // shared helper (covers versioned types like web_search_20260222)
          // plus the bare `web_search` name for name-only defs.
          const hasHostedSearch =
            detectHostedSearchTools(tools).requested ||
            tools.some((def: unknown) => {
              const r = asRecord(def);
              return typeof r['name'] === 'string' && String(r['name']) === 'web_search';
            });
          if (hasHostedSearch) {
            res.status(400).json({
              type: 'error',
              error: {
                type: 'invalid_request_error',
                message:
                  'web_search is not supported on /v1/messages; use POST /v1/responses with tools:[{type:"web_search"}] or POST /v1beta/interactions with tools:[{type:"google_search"}]',
              },
            });
            return;
          }
          const tool_choice: unknown = body['tool_choice'];
          const requestStream: unknown = body['stream'];
          const temperature: unknown = body['temperature'];
          const top_p: unknown = body['top_p'];
          const top_k: unknown = body['top_k'];
          const max_tokens: unknown = body['max_tokens'];
          const stop_sequences: unknown = body['stop_sequences'];
          const thinking: unknown = body['thinking'];
          const stream = Boolean(requestStream);
          const requestOpencodeConfig: unknown = body['opencode'];
          const disableParallelRaw = body['disable_parallel_tool_use'];
          const choiceDisableParallel = asRecord(tool_choice)['disable_parallel_tool_use'];
          const parallelToolCalls: boolean = disableParallelRaw === true || choiceDisableParallel === true ? false : true;
          // Phase 2 wiring: inbound claude.request -> chat.request via the wired
          // N×N registry (thin wrapper over the same anthropic.ts pure layer,
          // so shapes match). Direct registry call (not the Safe wrapper):
          // requests are validated above and never error envelopes; an extra
          // `type:'error'` field must not bypass conversion (mode confusion).
          // Translated tools still flow through createRequestToolContext below
          // (external__* bridge + server ∩ request), unchanged.
          const translatedChatRequest = asRecord(
            activeTranslators.translateRequest(
              'claude',
              'openai',
              typeof model === 'string' ? model : '',
              {
                model,
                system,
                messages: messagesRaw,
                tools,
                tool_choice,
                thinking,
                max_tokens,
                temperature,
                top_p,
                stop_sequences,
              },
              stream,
            ),
          );
          const chatMessages = (
            Array.isArray(translatedChatRequest['messages']) ? (translatedChatRequest['messages'] as unknown[]) : []
          ) as unknown as Array<{ role?: unknown; content?: unknown }>;
          const chatTools = Array.isArray(translatedChatRequest['tools']) ? (translatedChatRequest['tools'] as unknown[]) : [];
          const chatToolChoice = translatedChatRequest['tool_choice'];
          // Strict legacy parity via the testable gate (collapses the whole
          // adaptive/auto family to the legacy fallback; translator itself
          // stays Go-faithful).
          const translatedEffort = translatedChatRequest['reasoning_effort'];
          const reasoningLevel = resolveMessagesReasoningLevel(thinking, translatedEffort, normalizeReasoningEffort);

          const requestParams: Record<string, unknown> = {
            temperature: typeof temperature === 'number' ? temperature : 0.7,
            max_tokens: typeof max_tokens === 'number' ? max_tokens : null,
            top_p: typeof top_p === 'number' ? top_p : 1.0,
            stop: Array.isArray(stop_sequences) ? stop_sequences : null,
            reasoning_effort: reasoningLevel,
          };
          if (top_k !== undefined) logDebug('Ignoring top_k (no opencode equivalent)', { top_k });

          const resolvedModel = (await withTimeout(resolveRequestedModel(model), REQUEST_TIMEOUT_MS, 'resolve model')) as unknown as {
            providerID: string;
            modelID: string;
          };
          const pID = String(asRecord(resolvedModel)['providerID']);
          const mID = String(asRecord(resolvedModel)['modelID']);
          const publicModel = `${pID}/${mID}`;

          const requestToolContext = createRequestToolContext(chatTools, chatToolChoice, requestOpencodeConfig);
          const toolMode: string = requestToolContext.mode;
          const externalToolContext = requestToolContext.external;
          const externalToolRegistry = externalToolContext.registry;
          const toolChoicePreflight = preflightExternalToolChoice(chatToolChoice, externalToolRegistry);
          if (!toolChoicePreflight.ok) {
            res.status(400).json({
              type: 'error',
              error: {
                type: 'invalid_request_error',
                message: toolChoicePreflight.message,
              },
            });
            return;
          }
          const externalToolChoice = toolChoicePreflight.normalized;
          const internalToolContext = requestToolContext.internal;
          trackToolMode(toolMode, { route: '/v1/messages' });

          const parts: Record<string, unknown>[] = [];
          const systemChunks: string[] = [];
          const assistantToolCalls = new Map<string, string>();
          const formatRoleLine = (role: unknown, name: unknown, text: unknown): string =>
            `${String(role).toUpperCase()}${name ? `(${String(name)})` : ''}: ${String(text ?? '')}`;
          for (const m of chatMessages) {
            const mr = asRecord(m);
            const role = String(mr['role'] ?? 'user').toLowerCase();
            const content: unknown = mr['content'];
            if (role === 'system') {
              const text = normalizeTextContent(content);
              if (text) systemChunks.push(text);
              continue;
            }
            const toolCallsRaw: unknown = mr['tool_calls'];
            if (role === 'assistant' && Array.isArray(toolCallsRaw) && (toolCallsRaw as unknown[]).length) {
              const serialized = ((toolCallsRaw as unknown[]) as unknown[])
                .map((tc: unknown, i: number) => {
                  const tcr = asRecord(tc);
                  const fn = asRecord(tcr['function']);
                  const rawName: unknown = fn['name'] ?? tcr['name'];
                  const mapped = findExternalToolByName(externalToolRegistry, rawName);
                  return {
                    id: typeof tcr['id'] === 'string' ? (tcr['id'] as string) : `toolu_${i + 1}`,
                    name: (mapped?.namespacedName ?? (fn['name'] as string) ?? (tcr['name'] as string)) as string,
                    arguments: normalizeToolArguments(fn['arguments'] ?? tcr['arguments']),
                  };
                })
                .filter((tc) => (tc as { name: unknown }).name);
              serialized.forEach((tc) => {
                const s = tc as { id: string; name: string };
                assistantToolCalls.set(s.id, s.name);
              });
              if (serialized.length) parts.push({ type: 'text', text: `ASSISTANT: <function_calls>${JSON.stringify(serialized)}</function_calls>` });
            }
            if (role === 'tool') {
              const text = normalizeTextContent(content);
              const mapped =
                findExternalToolByName(externalToolRegistry, mr['name']) ||
                findExternalToolByName(externalToolRegistry, assistantToolCalls.get(String(mr['tool_call_id'] ?? '')));
              const toolName =
                mapped?.namespacedName ||
                assistantToolCalls.get(String(mr['tool_call_id'] ?? '')) ||
                (typeof mr['name'] === 'string' ? (mr['name'] as string) : `${EXTERNAL_TOOL_PREFIX}unknown`);
              parts.push({
                type: 'text',
                text: `TOOL_RESULT: ${JSON.stringify({ tool_call_id: mr['tool_call_id'] ?? toolName, name: toolName, content: text })}`,
              });
              continue;
            }
            if (!content) continue;
            if (typeof content === 'string') {
              parts.push({ type: 'text', text: formatRoleLine(role, mr['name'], content) });
            } else if (Array.isArray(content)) {
              for (const part of content as unknown[]) {
                if (!part) continue;
                const pr = asRecord(part);
                if (pr['type'] === 'text') parts.push({ type: 'text', text: formatRoleLine(role, mr['name'], (pr['text'] as string) || '') });
                else if (pr['type'] === 'image_url') {
                  const imageUrlRaw: unknown = pr['image_url'];
                  const imageUrl =
                    typeof imageUrlRaw === 'string' ? imageUrlRaw : (asRecord(imageUrlRaw)['url'] as string | undefined);
                  if (imageUrl) {
                    try {
                      const dataUri = await getImageDataUri(imageUrl);
                      parts.push({ type: 'file', mime: String(dataUri.split(';')[0]?.split(':')[1]), url: dataUri, filename: 'image' });
                    } catch (e: unknown) {
                      logDebug('Skipping image', { error: toErrorMessage(e) });
                    }
                  }
                }
              }
            }
          }
          if (!parts.length) {
            res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: 'messages must include at least one text message' } });
            return;
          }

          const systemWithGuard = buildSystemPrompt(
            systemChunks.join('\n\n'),
            externalToolContext.prompt,
            requestParams['reasoning_effort'],
            toolMode,
            internalToolContext.allowedToolNames,
          );
          await ensureBackend(config);
          try {
            await activeClient.config.update({ body: { activeModel: { providerID: pID, modelID: mID } } });
          } catch (e: unknown) {
            logDebug('Failed to set active model', { error: toErrorMessage(e) });
          }
          const sessionRes = (await withTimeout(activeClient.session.create(), REQUEST_TIMEOUT_MS, 'create session')) as unknown;
          sessionId = (asRecord(asRecord(sessionRes)['data'])['id'] as string | undefined) ?? null;
          if (!sessionId) throw new Error('Failed to create OpenCode session');

          const promptParams: { path: { id: string }; body: Record<string, unknown> } = {
            path: { id: sessionId },
            body: {
              model: { providerID: pID, modelID: mID },
              system: systemWithGuard,
              parts: externalToolContext.reminder ? [...parts, { type: 'text', text: externalToolContext.reminder }] : parts,
              ...(requestParams['max_tokens'] ? { max_tokens: requestParams['max_tokens'] } : {}),
              ...(requestParams['temperature'] !== undefined ? { temperature: requestParams['temperature'] } : {}),
              ...(requestParams['top_p'] !== undefined ? { top_p: requestParams['top_p'] } : {}),
              ...(requestParams['stop'] ? { stop: requestParams['stop'] } : {}),
            },
          };
          const toolOverrides = (await withTimeout(
            getToolOverridesForMode(toolMode, internalToolContext),
            REQUEST_TIMEOUT_MS,
            'load tool overrides',
          )) as Record<string, boolean> | null;
          if (DISABLE_TOOLS && (!toolOverrides || Object.keys(toolOverrides).length === 0)) {
            try {
              await activeClient.session.delete({ path: { id: sessionId as string } });
            } catch (cleanupError: unknown) {
              logDebug('Failed to cleanup session after tool discovery unavailable', { error: toErrorMessage(cleanupError) });
            }
            res.status(503).json({
              type: 'error',
              error: {
                type: 'tool_discovery_unavailable',
                message: 'Tool discovery unavailable; backend tool IDs could not be verified',
              },
            });
            return;
          }
          // Stage-5: strip false entries for free-tier suspects (any false gates; true-only sent, all-false omitted).
          const promptToolOverrides = selectPromptToolOverrides(toolOverrides, pID, mID);
          if (promptToolOverrides) promptParams.body['tools'] = promptToolOverrides;

          const fullPromptText = parts.map((p) => String(p['text'] ?? '')).join('\n\n');
          const messageId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
          const inputTokens = estimateTokens(fullPromptText + (systemWithGuard || ''));

          const makeForcedMessagesToolCallRequester = (): (() => Promise<Record<string, unknown> | null>) =>
            createForcedToolCallRequester({
              mode: externalToolChoice.mode,
              sessionId: sessionId as string,
              systemWithGuard,
              requiredTool: externalToolChoice.requiredTool ?? externalToolRegistry[0]?.namespacedName,
              providerID: pID,
              modelID: mID,
              toolOverrides,
              requestTimeoutMs: REQUEST_TIMEOUT_MS,
              forbidThinkBlock: true,
            });
          let requestForcedMessagesToolCall = makeForcedMessagesToolCallRequester();

          const finalizeAnthropic = (
            content: unknown,
            reasoning: unknown,
            validatedToolCalls: unknown,
          ): Record<string, unknown> => {
            const joinedSafe = stripExternalToolCallMarkupFromJoinedText(
              externalToolRegistry,
              reasoning,
              content,
              true,
            );
            const safeContent = joinedSafe.content;
            const safeReasoning = joinedSafe.reasoning;
            const publicCalls = toPublicToolCalls(validatedToolCalls);
            const anthropicTools = publicCalls.map((tc) => {
              const tcr = tc as unknown as Record<string, unknown>;
              const fn = asRecord(tcr['function']);
              let input: unknown = {};
              try {
                input = JSON.parse(String(fn['arguments'] || '{}')) as unknown;
              } catch {
                input = {};
              }
              return { id: tcr['id'], function: { name: fn['name'], arguments: fn['arguments'] }, _input: input };
            });
            const outputTokens = estimateTokens(safeContent + safeReasoning + JSON.stringify(anthropicTools));
            const stopReason = mapFinishToStopReason('stop', anthropicTools.length > 0);
            return buildAnthropicMessage({
              messageId,
              model: publicModel,
              text: safeContent || '',
              reasoning: safeReasoning || '',
              toolCalls: anthropicTools as unknown as Array<{ id?: unknown; name?: unknown; function?: { name?: unknown; arguments?: unknown } | null }>,
              stopReason,
              inputTokens,
              outputTokens,
            }) as unknown as Record<string, unknown>;
          };

          if (!stream) {
            let content = '';
            let reasoning = '';
            let error: unknown = null;
            for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
              if (res.writableEnded || res.destroyed) {
                logDebug('Client gone, stop retrying', { sessionId, attempt });
                return;
              }
              if (attempt > 1) {
                try {
                  await activeClient.session.delete({ path: { id: sessionId } });
                } catch {
                  // ignore
                }
                const r = (await withTimeout(activeClient.session.create(), REQUEST_TIMEOUT_MS, 'create session')) as unknown;
                sessionId = (asRecord(asRecord(r)['data'])['id'] as string | undefined) ?? null;
                if (!sessionId) throw new Error('Failed to create OpenCode session for retry');
                promptParams.path.id = sessionId;
                requestForcedMessagesToolCall = makeForcedMessagesToolCallRequester();
                await sleep(computeRetryDelay(attempt - 1, error));
              }
              try {
                await activePromptWithTimeout(promptParams, REQUEST_TIMEOUT_MS);
                 const collected = await activePollForAssistantResponse(
                   sessionId as string,
                   REQUEST_TIMEOUT_MS,
                   undefined,
                   requestAbortController.signal,
                 );

                content = collected.content || '';
                reasoning = collected.reasoning || '';
                error = collected.error || null;
              } catch (promptError: unknown) {
                content = '';
                reasoning = '';
                error = promptError;
              }
              if (error && !content && !reasoning && attempt < maxAttempts && engageProxyFallback(error)) continue;
              if (error && !content && !reasoning && attempt < maxAttempts && isTransientUpstreamError(error)) continue;
              break;
            }
                          if (error != null) {
              const t = transformUpstreamError(error);
              res.status(t.statusCode).json({
                type: 'error',
                error: {
                  type: t.error.type || 'api_error',
                  message: t.error.message || 'Upstream error',
                  ...(t.error.code ? { code: t.error.code } : {}),
                },
              });
              return;
            }
             let parsed: FinalToolCall[] =
               externalToolRegistry.length > 0 ? parseExternalToolCallsFromJoinedText(externalToolRegistry, reasoning, content) : [];
             let validCalls: FinalToolCall[] = [];
             try {
               assertToolCallArtifactIntegrity(parsed, externalToolRegistry, [reasoning, content]);
               if (parsed.length === 0 && externalToolChoice.mode === 'required') {
                 const forcedResponse = await requestForcedMessagesToolCall();
                 if (forcedResponse) {
                   content = String(forcedResponse['content'] ?? content);
                   reasoning = String(forcedResponse['reasoning'] ?? reasoning);
                   parsed = parseExternalToolCallsFromJoinedText(externalToolRegistry, reasoning, content);
                   assertToolCallArtifactIntegrity(parsed, externalToolRegistry, [reasoning, content]);
                 }
               }
               validCalls = finalizeStreamToolCalls(
                 parsed,
                 externalToolRegistry,
                 externalToolChoice,
                 [reasoning, content],
                 parallelToolCalls,
               ) as unknown as FinalToolCall[];
             } catch (toolError) {
               const toolCode = (toolError as Error & { code?: string }).code;
               const failClosedCodes = [
                 'parallel_external_tool_calls',
                 'external_tool_choice_none',
                 'external_tool_choice_required',
                 'invalid_external_tool_call',
                 'external_tool_policy_blocked',
                 'external_tool_choice_mismatch',
                 'duplicate_external_tool_call_id',
                 'malformed_external_tool_call',
               ];
               if (toolCode && failClosedCodes.includes(toolCode)) {
                 try {
                   if (sessionId) await activeClient.session.delete({ path: { id: sessionId } });
                 } catch (_cleanupError) {
                   void _cleanupError;
                 }
                 res.status(502).json({
                   type: 'error',
                   error: {
                     type: 'api_error',
                     message: toErrorMessage(toolError),
                     code: toolCode,
                   },
                 });
                 return;
               }
               throw toolError;
             }
             res.json(finalizeAnthropic(content, reasoning, validCalls));
            return;
          }

                      res.setHeader('Content-Type', 'text/event-stream');
           res.setHeader('Cache-Control', 'no-cache');
           res.setHeader('Connection', 'keep-alive');
           const flushHeaders = (res as unknown as { flushHeaders?: unknown }).flushHeaders;
           if (typeof flushHeaders === 'function') (flushHeaders as () => void).call(res);
           keepaliveInterval = setInterval(() => {
            if (!res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n');
          }, 15000);
           const resClosed = new Promise<boolean>((resolve) =>
             res.once('close', () => {
               if (!res.writableEnded) {
                 requestAbortController.abort();
                 resolve(true);
               }
             }),
           );

          let streamedText = '';
          let streamedReasoning = '';
          let rawContent = '';
          let rawReasoning = '';
           const streamedToolCalls: FinalToolCall[] = [];
           const shouldBufferExternalStream = externalToolRegistry.length > 0;
           const filterContent = createToolCallFilter({ disableTools: DISABLE_TOOLS, forceStrip: shouldBufferExternalStream, registry: externalToolRegistry });
           const filterReasoning = createToolCallFilter({ disableTools: DISABLE_TOOLS, forceStrip: shouldBufferExternalStream, registry: externalToolRegistry });
           const parseContent = createExternalToolCallStreamParser(externalToolRegistry);
           const parseReason = createExternalToolCallStreamParser(externalToolRegistry);
          let textBlockOpen = false;
          let thinkingBlockOpen = false;
          let nextBlockIndex = 0;
          let textIndex: number | null = null;
          let thinkingIndex: number | null = null;
          const ensureTextIndex = (): number => {
            if (textIndex === null) textIndex = nextBlockIndex++;
            return textIndex;
          };
          const ensureThinkingIndex = (): number => {
            if (thinkingIndex === null) thinkingIndex = nextBlockIndex++;
            return thinkingIndex;
          };
          res.write(
            sseEvent('message_start', {
              type: 'message_start',
              message: { id: messageId, type: 'message', role: 'assistant', model: publicModel, content: [], stop_reason: null, usage: { input_tokens: inputTokens, output_tokens: 0 } },
            }),
          );
          const sendTextDelta = (delta: string): void => {
            if (!delta) return;
            const idx = ensureTextIndex();
            if (!textBlockOpen) {
              res.write(sseEvent('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } }));
              textBlockOpen = true;
            }
            streamedText += delta;
            res.write(sseEvent('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: delta } }));
          };
          const sendReasoningDelta = (delta: string): void => {
            if (!delta) return;
            const idx = ensureThinkingIndex();
            if (!thinkingBlockOpen) {
              res.write(sseEvent('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '', signature: '' } }));
              thinkingBlockOpen = true;
            }
            streamedReasoning += delta;
            res.write(sseEvent('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: delta } }));
          };
          const sendDelta = (delta: string, isReasoning: boolean = false): void => {
            if (!delta) return;
            if (isReasoning) rawReasoning += delta;
            else rawContent += delta;
            const parsedCalls = isReasoning ? parseReason(delta) : parseContent(delta);
            parsedCalls.forEach((tc) => streamedToolCalls.push(tc));
             const filtered = isReasoning ? filterReasoning(delta) : filterContent(delta);
             if (!filtered) return;
             if (shouldBufferExternalStream) {
               if (isReasoning) streamedReasoning += filtered;
               else streamedText += filtered;
             } else if (isReasoning) sendReasoningDelta(filtered);
             else sendTextDelta(filtered);
          };
           let collected: Record<string, unknown> | null = null;
           let polledSnapshot: { content: string; reasoning: string; error: unknown; toolParts?: unknown } | null = null;
           let snapshotPolled = false;
           let snapshotPromise: Promise<{ content: string; reasoning: string; error: unknown; toolParts?: unknown }> | null = null;
           const pollSnapshot = async (): Promise<{ content: string; reasoning: string; error: unknown; toolParts?: unknown }> => {
             snapshotPolled = true;
             if (!snapshotPromise) {
                 snapshotPromise = activePollForAssistantResponse(
                   sessionId as string,
                   REQUEST_TIMEOUT_MS,
                   undefined,
                   requestAbortController.signal,
                 );

             }
             return snapshotPromise;
           };
          // Recovery snapshots repeat what the event stream already delivered, so only the
          // suffix past the raw prefix may be replayed. A snapshot the raw prefix does not
          // match is still sent in full rather than dropped.
           const unsentSuffix = (full: unknown, raw: string): string => {
             const text = typeof full === 'string' ? full : '';
             if (!text) return '';
             if (!raw) return text;
             return text.startsWith(raw) ? text.slice(raw.length) : text;
           };
           const hasPartialOutput = (): boolean => {
             const current = asRecord(collected);
             return Boolean(rawContent || rawReasoning || streamedToolCalls.length > 0 || current['content'] || current['reasoning']);
           };
           const recoverSnapshot = async (
             fallbackError: unknown = null,
           ): Promise<{ content: string; reasoning: string; error: unknown; toolParts?: unknown } | null> => {
             if (res.destroyed || res.writableEnded) return null;
             let snapshot: { content: string; reasoning: string; error: unknown; toolParts?: unknown };
             try {
               snapshot = await pollSnapshot();
             } catch (error: unknown) {
               if (res.destroyed || res.writableEnded) return null;
               if (hasPartialOutput()) {
                 logDebug('Ignoring messages recovery poll failure after partial stream output', { error: toErrorMessage(error) });
                 return null;
               }
               if (fallbackError != null) throw normalizeBackendError(fallbackError);
               throw normalizeBackendError(error);
             }
             if (snapshot.error != null) throw normalizeBackendError(snapshot.error);
             if (
               fallbackError != null &&
               !snapshot.content &&
               !snapshot.reasoning &&
               !(Array.isArray(snapshot.toolParts) && snapshot.toolParts.length > 0)
             ) throw normalizeBackendError(fallbackError);
             return snapshot;
           };

          if (fallbackToProxy) {
            // SSE subscribe ignores custom fetch (SDK gap): prompt+poll
            // through the proxy bundle instead of the event stream.
            try {
              await activePromptWithTimeout(promptParams, REQUEST_TIMEOUT_MS);
               const pres = await pollSnapshot();
               polledSnapshot = pres;
               if (pres.error != null) throw normalizeBackendError(pres.error);
              if (res.destroyed || res.writableEnded) {
                if (keepaliveInterval) clearInterval(keepaliveInterval);
                return;
              }
              // Raw text: sendDelta parses tool calls and filters display markup.
              const presContent = unsentSuffix(pres.content, rawContent);
              const presReasoning = unsentSuffix(pres.reasoning, rawReasoning);
              if (presContent) sendDelta(presContent, false);
              if (presReasoning) sendDelta(presReasoning, true);
              collected = { content: pres.content, reasoning: pres.reasoning };
            } catch (e: unknown) {
              throw normalizeBackendError(e);
            }
          } else {
            const collectPromise = collectFromEvents(
              sessionId as string,
              REQUEST_TIMEOUT_MS,
              sendDelta,
               DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS,
               DEFAULT_EVENT_IDLE_TIMEOUT_MS,
               requestAbortController.signal,
             ).catch((err: unknown) => ({ __error: err }));

            activeClient.session.prompt(promptParams).catch((err: unknown) => logDebug('Prompt error:', toErrorMessage(err)));
            const raced = (await Promise.race([collectPromise, resClosed.then(() => ({ __cancelled: true }))])) as Record<string, unknown>;
            collected = raced;
             if (raced['__cancelled'] || requestAbortController.signal.aborted) {
               if (keepaliveInterval) clearInterval(keepaliveInterval);
               try {
                 if (sessionId) {
                   await activeClient.session.delete({ path: { id: sessionId } });
                   disconnectedSessionCleaned = true;
                 }
               } catch (e: unknown) {
                 logDebug('Failed to cleanup cancelled messages session', { error: toErrorMessage(e) });
               }
               try {
                 if (!res.destroyed) res.end();
               } catch {
                 // ignore
               }
               return;
             }
             if (raced['error'] != null) throw normalizeBackendError(raced['error']);
              const recoveryRecord = asRecord(collected);
              const hasValidTerminal = Boolean(
                collected &&
                !recoveryRecord['__error'] &&
                !recoveryRecord['noData'] &&
                !recoveryRecord['idleTimeout'] &&
                !recoveryRecord['cancelled'] &&
                (rawContent || rawReasoning || streamedToolCalls.length > 0 || recoveryRecord['content'] || recoveryRecord['reasoning']),
              );
              if (recoveryRecord['__error']) {
                if (!fallbackToProxy) engageProxyFallback(recoveryRecord['__error']);
                const snapshot = await recoverSnapshot(recoveryRecord['__error']);

               if (snapshot) {
                 polledSnapshot = snapshot;
                 const remainingContent = unsentSuffix(snapshot.content, rawContent);
                 const remainingReasoning = unsentSuffix(snapshot.reasoning, rawReasoning);
                 if (remainingContent) sendDelta(remainingContent, false);
                 if (remainingReasoning) sendDelta(remainingReasoning, true);
               }
              } else if (recoveryRecord['noData'] || recoveryRecord['idleTimeout']) {

               const snapshot = await recoverSnapshot();
               if (snapshot) {
                 polledSnapshot = snapshot;
                 const remainingContent = unsentSuffix(snapshot.content, rawContent);
                 const remainingReasoning = unsentSuffix(snapshot.reasoning, rawReasoning);
                 if (remainingContent) sendDelta(remainingContent, false);
                 if (remainingReasoning) sendDelta(remainingReasoning, true);
               }
             }
             if (externalToolRegistry.length > 0 && !hasValidTerminal && !snapshotPolled) {
               const snapshot = await recoverSnapshot();
               if (snapshot) {
                 polledSnapshot = snapshot;
                 const remainingReasoning = unsentSuffix(snapshot.reasoning, rawReasoning);
                 const remainingContent = unsentSuffix(snapshot.content, rawContent);
                 if (remainingReasoning) sendDelta(remainingReasoning, true);
                 if (remainingContent) sendDelta(remainingContent, false);
               }
             }
           }
           if (requestAbortController.signal.aborted || res.destroyed || res.writableEnded) {
             if (sessionId && !disconnectedSessionCleaned) {
               try {
                 await activeClient.session.delete({ path: { id: sessionId } });
                 disconnectedSessionCleaned = true;
               } catch (e: unknown) {
                 logDebug('Failed to cleanup disconnected messages session', { error: toErrorMessage(e) });
               }
             }
             return;
           }

            const flushedReasoningCalls = parseReason.flush ? parseReason.flush() : [];
           const flushedContentCalls = parseContent.flush ? parseContent.flush() : [];
           const flushedReasoningText = filterReasoning.flush ? filterReasoning.flush() : '';
           const flushedContentText = filterContent.flush ? filterContent.flush() : '';
           if (shouldBufferExternalStream) {
             const visible = stripExternalToolCallMarkupFromJoinedText(
               externalToolRegistry,
               rawReasoning,
               rawContent,
             );
             streamedReasoning = visible.reasoning;
             streamedText = visible.content;
           } else {
             if (flushedReasoningText) sendReasoningDelta(flushedReasoningText);
             if (flushedContentText) sendTextDelta(flushedContentText);
           }

           const collectedR = asRecord(collected);
           if (collectedR['error'] != null) throw normalizeBackendError(collectedR['error']);
           const snapshotReasoning = polledSnapshot?.reasoning ?? (typeof collectedR['reasoning'] === 'string' ? collectedR['reasoning'] as string : rawReasoning);
           const snapshotContent = polledSnapshot?.content ?? (typeof collectedR['content'] === 'string' ? collectedR['content'] as string : rawContent);
           const parseJoined = (reasoningText: string, contentText: string): FinalToolCall[] =>
             externalToolRegistry.length > 0
               ? parseExternalToolCallsFromJoinedText(externalToolRegistry, reasoningText, contentText)
               : [];
           const streamSource = [
             [snapshotReasoning, snapshotContent],
             [rawReasoning, rawContent]
           ];
           let parsedToolCalls: FinalToolCall[] = externalToolRegistry.length > 0
             ? mergeToolCallArtifacts(
                 streamedToolCalls,
                 flushedReasoningCalls,
                 flushedContentCalls,
                 parseJoined(snapshotReasoning, snapshotContent),
                 parseJoined(rawReasoning, rawContent),
               )
             : [];
           assertToolCallArtifactIntegrity(parsedToolCalls, externalToolRegistry, streamSource);
           if (parsedToolCalls.length === 0 && externalToolChoice.mode === 'required') {
             const forcedResponse = await requestForcedMessagesToolCall();
             if (forcedResponse) {
               const forcedReasoning = typeof forcedResponse['reasoning'] === 'string' ? forcedResponse['reasoning'] as string : '';
               const forcedContent = typeof forcedResponse['content'] === 'string' ? forcedResponse['content'] as string : '';
               parsedToolCalls = mergeToolCallArtifacts(parsedToolCalls, parseJoined(forcedReasoning, forcedContent));
               assertToolCallArtifactIntegrity(parsedToolCalls, externalToolRegistry, [forcedReasoning, forcedContent]);
             }
           }
            const finalValidated = finalizeStreamToolCalls(
              parsedToolCalls,
              externalToolRegistry,
              externalToolChoice,
              streamSource,
              parallelToolCalls,
            );
           if (!streamedText.trim() && !streamedReasoning.trim() && finalValidated.length === 0) {
             throw new Error('Upstream returned no assistant data');
           }
           if (shouldBufferExternalStream) {
             if (streamedReasoning) {
               const idx = ensureThinkingIndex();
               if (!thinkingBlockOpen) {
                 res.write(sseEvent('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '', signature: '' } }));
                 thinkingBlockOpen = true;
               }
               res.write(sseEvent('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: streamedReasoning } }));
             }
             if (streamedText) {
               const idx = ensureTextIndex();
               if (!textBlockOpen) {
                 res.write(sseEvent('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } }));
                 textBlockOpen = true;
               }
               res.write(sseEvent('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: streamedText } }));
             }
           }
           if (textBlockOpen) res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: textIndex }));
           if (thinkingBlockOpen) res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: thinkingIndex }));
           let toolBlockIndex = nextBlockIndex;
           for (const tc of toPublicToolCalls(finalValidated)) {
             const tcr = tc as unknown as Record<string, unknown>;
             const fn = asRecord(tcr['function']);
             res.write(
               sseEvent('content_block_start', {
                 type: 'content_block_start',
                 index: toolBlockIndex,
                 content_block: { type: 'tool_use', id: tcr['id'], name: fn['name'], input: {} },
               }),
             );
             res.write(
               sseEvent('content_block_delta', {
                 type: 'content_block_delta',
                 index: toolBlockIndex,
                 delta: { type: 'input_json_delta', partial_json: (fn['arguments'] as string) || '{}' },
               }),
             );
             res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: toolBlockIndex }));
             toolBlockIndex += 1;
           }
           const outputTokens = estimateTokens(streamedText + streamedReasoning);
           const stopReason = mapFinishToStopReason('stop', finalValidated.length > 0);
           res.write(
             sseEvent('message_delta', {
               type: 'message_delta',
               delta: { stop_reason: stopReason, stop_sequence: null },
               usage: { output_tokens: outputTokens },
             }),
           );
            res.write(sseEvent('message_stop', { type: 'message_stop' }));
            if (requestAbortController.signal.aborted || res.destroyed) {
              if (sessionId && !disconnectedSessionCleaned) {
                try {
                  await activeClient.session.delete({ path: { id: sessionId } });
                  disconnectedSessionCleaned = true;
                } catch (e: unknown) {
                  logDebug('Failed to cleanup disconnected messages session', { error: toErrorMessage(e) });
                }
              }
              return;
            }
            if (keepaliveInterval) clearInterval(keepaliveInterval);

           res.end();
           return;
        } catch (error: unknown) {
          if (keepaliveInterval) clearInterval(keepaliveInterval);
          if (!fallbackToProxy) engageProxyFallback(error);
          if (sessionId) {
             try {
               await activeClient.session.delete({ path: { id: sessionId } });
               if (requestAbortController.signal.aborted) disconnectedSessionCleaned = true;
             } catch (e: unknown) {

              logDebug('Failed to cleanup messages session on error', { error: toErrorMessage(e) });
            }
          }
          if (!res.headersSent) {
            const t = transformUpstreamError(error);
            res.status(t.statusCode).json({
              type: 'error',
              error: {
                type: t.error.type || 'api_error',
                message: t.error.message || toErrorMessage(error) || 'Upstream error',
                ...(t.error.code ? { code: t.error.code } : {}),
              },
            });
            return;
          }
          try {
            const t = transformUpstreamError(error);
            res.write(
              sseEvent('error', {
                type: 'error',
                error: { type: t.error.type || 'api_error', message: t.error.message, ...(t.error.code ? { code: t.error.code } : {}) },
              }),
            );
          } catch {
            // ignore
          }
          res.end();
          return;
        }
      }, REQUEST_TIMEOUT_MS + 20000);
    } catch (error: unknown) {
      if (!res.headersSent)
        res.status(500).json({ type: 'error', error: { type: 'api_error', message: toErrorMessage(error) } });
    }
  });
}
