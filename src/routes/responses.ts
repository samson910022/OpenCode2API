// P4 TS: POST /v1/responses (ported from P3 .js, behavior identical).
import crypto from 'crypto';
import { makeId } from '../converters/json.js';
import {
  ADDITIONAL_TOOLS_ITEM_TYPE,
  collectAdditionalToolSources,
  expandToolDeclarationSources,
  findExternalToolByExactName,
  resolveExternalToolName,
} from '../tool-runtime/registry.js';
import { qualifyToolName } from '../converters/chat-responses/request.js';
import { EXTERNAL_TOOL_PREFIX } from '../tool-runtime/contracts.js';
import { preflightExternalToolChoice } from '../tool-runtime/router.js';
import { computeRetryDelay } from '../retry/policy.js';
import { ensureActiveModel } from '../backend/active-model.js';
import {
  assertToolCallArtifactIntegrity,
  createDuplicateToolCallIdError,
  stripExternalToolCallMarkupFromJoinedText,
  parseExternalToolCallsFromJoinedText,
  mergeToolCallArtifacts,
  createToolCallFilter,
  createExternalToolCallStreamParser,
} from '../tool-runtime/parser.js';
import {
  isMalformedExternalToolCallError,
  resolveAuthoritativeStreamSource,
} from '../tool-runtime/stream-source.js';
import { isTransientUpstreamError, normalizeBackendError, transformUpstreamError, createInvalidRequestError, createToolDiscoveryUnavailableError } from '../errors/upstream.js';
import { engageFallbackForFreeLimit } from '../upstream-proxy/fallback.js';
import {
  buildCitationAnnotations,
  buildWebSearchCallItems,
  detectHostedSearchTools,
  extractSearchEvidence,
  SEARCH_GROUNDING_INSTRUCTION,
} from '../search/grounding.js';
import {
  withTimeout,
  DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS,
  DEFAULT_EVENT_IDLE_TIMEOUT_MS,
} from '../config/proxy-config.js';
import { sleep, ensureBackend } from '../backend/manager.js';
import type { Application, Request, Response } from 'express';
import type { AppContext } from '../types/context.js';
import type { ExternalToolEntry } from '../tool-runtime/registry.js';
import type { ResponseToolCallState } from '../types/backend.js';
import type { FinalToolCall } from '../tool-runtime/parser.js';
import type { AuthoritativeStreamSource } from '../tool-runtime/stream-source.js';
import { asRecord, toErrorMessage } from '../utils/guards.js';
import { getContinuationTenantId, getIdempotencyControl } from '../idempotency/middleware.js';

function readDataMessage(e: unknown): string {
  const r = asRecord(e);
  const data = asRecord(r['data']);
  const dm: unknown = data['message'];
  if (typeof dm === 'string') return dm;
  const m: unknown = r['message'];
  if (typeof m === 'string') return m;
  return 'unknown';
}

interface NormalizedInputMessage {
  role: string;
  content: string;
  isToolCalls?: boolean;
}

interface ResponsesOutputEntry {
  index: number;
  id: string;
  type: string;
  addedItem: Record<string, unknown>;
  doneItem: Record<string, unknown> | null;
  emittedDone: boolean;
}

class ResponsesOutputAssembler {
  private readonly entries: ResponsesOutputEntry[] = [];
  private readonly byKey = new Map<string, ResponsesOutputEntry>();

  announce(item: Record<string, unknown>): ResponsesOutputEntry {
    const id = String(item['id'] ?? '');
    const type = String(item['type'] ?? '');
    const key = `${type}:${id}`;
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const entry: ResponsesOutputEntry = {
      index: this.entries.length,
      id,
      type,
      addedItem: item,
      doneItem: null,
      emittedDone: false,
    };
    this.entries.push(entry);
    this.byKey.set(key, entry);
    return entry;
  }

  get(type: string, id: string): ResponsesOutputEntry | null {
    return this.byKey.get(`${type}:${id}`) ?? null;
  }

  has(type: string, id: string): boolean {
    return this.byKey.has(`${type}:${id}`);
  }

  complete(type: string, id: string, item: Record<string, unknown>): ResponsesOutputEntry | null {
    const entry = this.get(type, id);
    if (!entry) return null;
    if (!entry.doneItem) entry.doneItem = item;
    return entry;
  }

  markDone(entry: ResponsesOutputEntry): void {
    entry.emittedDone = true;
  }

  list(): readonly ResponsesOutputEntry[] {
    return this.entries;
  }

  output(): Record<string, unknown>[] {
    return this.entries
      .filter((entry) => entry.emittedDone && entry.doneItem !== null)
      .map((entry) => entry.doneItem as Record<string, unknown>);
  }
}

interface ResponsesStreamState {
  id: string;
  createdAt: number;
  model: string;
  tools: unknown[];
  parallelToolCalls: boolean;
  sequenceNumber: number;
  output: ResponsesOutputAssembler;
  nextSequence: () => number;
  emit: (payload: unknown) => void;
  emitCreated: () => void;
  adoptResolvedModel: (resolvedModel: string) => void;
  finalize: (() => void) | null;
  createdEmitted: boolean;
}

interface ResponsesResponseIdentity {
  id: string;
  createdAt: number;
  model: string;
  tools: unknown[];
  parallelToolCalls: boolean;
}

function buildResponsesResponseEnvelope(identity: ResponsesResponseIdentity): Record<string, unknown> {
  return {
    id: identity.id,
    object: 'response',
    created: identity.createdAt,
    created_at: identity.createdAt,
    model: identity.model,
    tools: identity.tools,
    parallel_tool_calls: identity.parallelToolCalls,
  };
}

const RESPONSES_OUTPUT_TYPE_ORDER = ['web_search_call', 'reasoning', 'message', 'function_call', 'custom_tool_call'];

/**
 * Map a Responses input role onto the OpenCode channel it may use. `developer`
 * has no system channel here: it rides the user channel and keeps its own
 * `DEVELOPER:` label, so a developer turn is never mistaken for the user's.
 */
function responsesInputRole(role: unknown): string {
  if (typeof role !== 'string' || !role) return 'user';
  return role;
}

function orderResponsesOutputItems(items: Record<string, unknown>[]): Record<string, unknown>[] {
  const rank = (item: Record<string, unknown>): number => {
    const index = RESPONSES_OUTPUT_TYPE_ORDER.indexOf(String(item['type']));
    return index === -1 ? RESPONSES_OUTPUT_TYPE_ORDER.length : index;
  };
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => rank(left.item) - rank(right.item) || left.index - right.index)
    .map((entry) => entry.item);
}

export function registerResponsesRoutes(app: Application, ctx: AppContext): void {
  const {
    client,
    config,
    REQUEST_TIMEOUT_MS,
    DISABLE_TOOLS,
    maxAttempts,
    resolveRequestedModel,
    logDebug,
    getResponseState,
    storeResponseState,
    buildSystemPrompt,
    selectPromptToolOverrides,
    normalizeReasoningEffort,
    normalizeTextContent,
    normalizeToolArguments,
    normalizeToolResultContent,
    createRequestToolContext,
    finalizeValidatedToolCalls,
    finalizeStreamToolCalls,
    createForcedToolCallRequester,
    trackToolMode,
    getToolOverridesForMode,
    promptWithTimeout,
    collectFromEvents,
    pollForAssistantResponse,
    TOOL_MODE,
    proxyPool,
    proxyClient,
    proxyPromptWithTimeout,
    proxyPollForAssistantResponse,
  } = ctx;

  app.post('/v1/responses', async (req: Request, res: Response): Promise<void> => {
     const idempotency = getIdempotencyControl(req);
     let responsesKeepalive: ReturnType<typeof setInterval> | null = null;
     let responsesResClosed: Promise<boolean> | null = null;
     const responsesAbortController = new AbortController();
     responsesResClosed = new Promise<boolean>((resolve) =>
       res.once('close', () => {
         const disconnected = !(res as unknown as { writableFinished?: boolean }).writableFinished;
         if (disconnected) responsesAbortController.abort();
         resolve(disconnected);
       }),
     );
     const assertResponsesCanPrompt = (): void => {
       if (responsesAbortController.signal.aborted || res.destroyed || res.writableEnded) {
         throw new Error('Client disconnected');
       }
     };

    const stopResponsesKeepalive = (): void => {
      if (responsesKeepalive) {
        clearInterval(responsesKeepalive);
        responsesKeepalive = null;
      }
    };
    // P3 fallback bundle: direct by default; adopts the proxy bundle when
    // this request hits a free-limit error (or the pool is already engaged).
    // NOTE: declared outside try so the terminal catch can read the flag.
    let activeClient = client;
    let activePromptWithTimeout = promptWithTimeout;
    let activePollForAssistantResponse = pollForAssistantResponse;
    let fallbackToProxy = false;
    let fallbackServed = false;
    let ownedResponsesSessionId: string | null = null;
    let responsesCleanupScheduled = false;
    let responsesStreamState: ResponsesStreamState | null = null;
    const cleanupOwnedResponsesSessionNow = async (): Promise<void> => {
      const ownedSessionId = ownedResponsesSessionId;
      if (!ownedSessionId) return;
      try {
        await activeClient.session.delete({ path: { id: ownedSessionId } });
        if (ownedResponsesSessionId === ownedSessionId) ownedResponsesSessionId = null;
      } catch (error: unknown) {
        logDebug('Failed to cleanup owned responses session', { sessionId: ownedSessionId, error: toErrorMessage(error) });
      }
    };
    const cleanupOwnedResponsesSession = async (): Promise<void> => {
      if (!ownedResponsesSessionId) return;
      if (idempotency?.submitted) {
        // Keep a possibly submitted child available for unknown-outcome
        // reconciliation. Delete only after the full wire response is cached.
        if (!responsesCleanupScheduled) {
          responsesCleanupScheduled = true;
          idempotency.onCompleted(() => cleanupOwnedResponsesSessionNow());
        }
        return;
      }
      await cleanupOwnedResponsesSessionNow();
    };
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
    const initializeResponsesStream = (
      requestedModel: unknown,
      previousModel: unknown,
      requestTools: unknown[],
      parallelToolCalls: boolean,
    ): ResponsesStreamState => {
      const initialModel =
        typeof requestedModel === 'string' && requestedModel
          ? requestedModel
          : typeof previousModel === 'string' && previousModel
            ? previousModel
            : 'unknown';
      const state: ResponsesStreamState = {
        id: idempotency?.publicId ?? `resp_${crypto.randomUUID()}`,
        createdAt: Math.floor(Date.now() / 1000),
        model: initialModel,
        tools: requestTools,
        parallelToolCalls,
        sequenceNumber: 0,
        output: new ResponsesOutputAssembler(),
        nextSequence: () => 0,
        emit: () => undefined,
        emitCreated: () => undefined,
        adoptResolvedModel: () => undefined,
        finalize: null,
        createdEmitted: false,
      };
      const emit = (payload: unknown): void => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      state.nextSequence = () => state.sequenceNumber++;
      state.emit = emit;
      state.emitCreated = () => {
        if (state.createdEmitted) return;
        emit({
          type: 'response.created',
          sequence_number: state.nextSequence(),
          response: {
            ...buildResponsesResponseEnvelope(state),
            status: 'in_progress',
            output: [],
            error: null,
            incomplete_details: null,
            usage: null,
          },
        });
        state.createdEmitted = true;
      };
      state.adoptResolvedModel = (resolvedModel: string) => {
        state.model = resolvedModel;
        if (!idempotency?.reconciling) state.emitCreated();
      };
      idempotency?.setPublicId(state.id);
      responsesStreamState = state;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      const flushHeaders = (res as unknown as { flushHeaders?: unknown }).flushHeaders;
      if (!idempotency?.reconciling && typeof flushHeaders === 'function') (flushHeaders as () => void).call(res);
      if (!idempotency?.reconciling) {
        responsesKeepalive = setInterval(() => {
          if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n');
        }, 15000);
      }
       return state;
    };
    const getResponsesResClosed = (): Promise<boolean> | null => responsesResClosed;
    if (proxyPool.isEngaged()) switchToProxyBundle();
    try {
      const body = asRecord((req as unknown as { body: unknown }).body);
      const model: unknown = body['model'];
      const input: unknown = body['input'];
      const reasoning_effort: unknown = body['reasoning_effort'];
      const requestReasoning: unknown = body['reasoning'];
      const max_output_tokens: unknown = body['max_output_tokens'];
      const toolsRaw: unknown = body['tools'];
      const tools: unknown[] = Array.isArray(toolsRaw) ? (toolsRaw as unknown[]) : [];
      const parallelToolCalls: boolean =
        typeof body['parallel_tool_calls'] === 'boolean' ? body['parallel_tool_calls'] : true;
      const tool_choice: unknown = body['tool_choice'];
      const instructions: unknown = body['instructions'];
      const temperature: unknown = body['temperature'];
      const top_p: unknown = body['top_p'];
      const streamRaw: unknown = body['stream'];
      const stream = Boolean(streamRaw);
      const rejectInvalidRequest = (message: string, code: string): void => {
        if (stream) throw createInvalidRequestError(message, code);
        res.status(400).json({ error: { message, type: 'invalid_request_error', code } });
      };
      const chatMessages: unknown = body['messages'];
      const prompt: unknown = body['prompt'];
      const previousResponseId: unknown = body['previous_response_id'];
      const requestOpencodeConfig: unknown = body['opencode'];

      const tenantId = getContinuationTenantId(req);
      const store = body['store'] !== false;
      const previousState =
        typeof previousResponseId === 'string' && previousResponseId ? getResponseState(previousResponseId, tenantId) : null;
      if (stream) responsesStreamState = initializeResponsesStream(model, previousState?.model, tools, parallelToolCalls);
      if (!idempotency?.reconciling && previousResponseId && (!previousState || !previousState.checkpointId)) {
        rejectInvalidRequest('Invalid or expired previous_response_id', 'invalid_previous_response_id');
        return;
      }

      const reasoningLevel = normalizeReasoningEffort(
        (reasoning_effort as string) || (asRecord(requestReasoning)['effort'] as string),
        null,
      );

      // P4: hosted search tools (web_search/google_search) are explicit client
      // grants for server-side grounding: keep them out of the external
      // function registry and drive opencode `websearch` instead.
      const fromChatMessages = Array.isArray(chatMessages) && (chatMessages as unknown[]).length;
      const rawResponsesInput: unknown = fromChatMessages ? chatMessages : input;
      const additionalToolSources = collectAdditionalToolSources(
        rawResponsesInput,
        fromChatMessages ? 'messages' : 'input',
      );
      const additionalToolDeclarations = additionalToolSources.flatMap((source) =>
        Array.isArray(source.tools) ? (source.tools as unknown[]) : [],
      );
      const hostedSearch = detectHostedSearchTools([...tools, ...additionalToolDeclarations]);
      const declarationExpansion = expandToolDeclarationSources([{ path: 'tools', tools }, ...additionalToolSources]);
      const customToolNames = new Set(declarationExpansion.customToolNames);
      if (declarationExpansion.issues.length) {
        const issues = declarationExpansion.issues;
        const message = issues
          .slice(0, 5)
          .map((issue) => issue.message)
          .join(' ');
        rejectInvalidRequest(message, issues[0].code);
        return;
      }
      const requestToolContext = createRequestToolContext(declarationExpansion.tools, tool_choice, requestOpencodeConfig);
      let toolMode: string = requestToolContext.mode;
      let internalToolContext = requestToolContext.internal;
      if (hostedSearch.requested && toolMode === TOOL_MODE.DISABLED) {
        toolMode = TOOL_MODE.INTERNAL_ALLOWLIST;
        internalToolContext = {
          ...internalToolContext,
          allowedToolNames: ['websearch'],
          requestedAllowlist: null,
          deniedRequestedTools: [],
          resolutionPath: 'hosted-search-grant',
          resultingMode: toolMode,
          metricsEnabled: internalToolContext.metricsEnabled,
        };
      } else if (hostedSearch.requested && toolMode === TOOL_MODE.INTERNAL_ALLOWLIST) {
        if (!internalToolContext.allowedToolNames.includes('websearch')) {
          internalToolContext = {
            ...internalToolContext,
            allowedToolNames: [...internalToolContext.allowedToolNames, 'websearch'],
            resolutionPath: 'hosted-search-grant',
            resultingMode: toolMode,
          };
        }
      } else if (hostedSearch.requested && toolMode === TOOL_MODE.EXTERNAL_BRIDGE) {
        // Metadata only: the overrides union below already grants websearch,
        // but without this trackToolMode/health would under-report it.
        if (!internalToolContext.allowedToolNames.includes('websearch')) {
          internalToolContext = {
            ...internalToolContext,
            allowedToolNames: [...internalToolContext.allowedToolNames, 'websearch'],
          };
        }
      }
      trackToolMode(toolMode, {
        configuredAllowlist: internalToolContext.allowedToolNames,
        requestedAllowlist: internalToolContext.requestedAllowlist,
        deniedRequestedTools: internalToolContext.deniedRequestedTools,
        resolutionPath: internalToolContext.resolutionPath,
        resultingMode: internalToolContext.resultingMode,
        route: '/v1/responses',
      });
      logDebug('Responses API request', {
        model,
        reasoning_effort: (reasoning_effort as string) || asRecord(requestReasoning)['effort'],
        reasoningLevel,
        max_output_tokens,
        toolMode,
        internalAllowedTools: internalToolContext.allowedToolNames,
        requestedInternalTools: internalToolContext.requestedAllowlist,
        deniedRequestedTools: internalToolContext.deniedRequestedTools,
        resolutionPath: internalToolContext.resolutionPath,
        resultingMode: internalToolContext.resultingMode,
      });
      const externalToolContext = requestToolContext.external;
      const externalToolRegistry: ExternalToolEntry[] = externalToolContext.registry;
      const toolChoicePreflight = preflightExternalToolChoice(tool_choice, externalToolRegistry);
      if (!toolChoicePreflight.ok) {
        rejectInvalidRequest(toolChoicePreflight.message, toolChoicePreflight.code);
        return;
      }
      const externalToolChoice = toolChoicePreflight.normalized;
      const assistantToolCalls = new Map<string, string>();
      for (const entry of previousState?.toolCalls ?? []) {
        if (entry.name) assistantToolCalls.set(entry.callId, entry.name);
      }

      const rememberAssistantToolCall = (toolCallId: unknown, toolName: unknown): void => {
        if (!toolCallId || !toolName || typeof toolCallId !== 'string' || typeof toolName !== 'string') return;
        assistantToolCalls.set(toolCallId, toolName);
      };

      const buildResponsesToolResultLine = (item: unknown = {}): string | null => {
        const ir = asRecord(item);
        const text = normalizeToolResultContent(
          ir['content'] ?? ir['output'] ?? ir['result'] ?? ir['text'],
        );
        const callIdRaw: unknown = ir['call_id'] ?? ir['tool_call_id'];
        const remembered = assistantToolCalls.get(String(callIdRaw ?? ''));
        const declaredName = typeof ir['name'] === 'string' ? (ir['name'] as string).trim() : '';
        if (typeof callIdRaw === 'string' && callIdRaw && !remembered && !declaredName) {
          throw createInvalidRequestError(
            `Unknown tool call id "${callIdRaw}". Provide the matching function_call item or a tool name.`,
            'unknown_tool_call_id',
          );
        }
        const mappedTool =
          (declaredName ? resolveExternalToolName(externalToolRegistry, declaredName, ir['namespace']) : null) ||
          (remembered ? resolveExternalToolName(externalToolRegistry, remembered) : null);
        const toolName =
          mappedTool?.namespacedName ||
          remembered ||
          declaredName ||
          `${EXTERNAL_TOOL_PREFIX}unknown`;
        const toolCallId =
          typeof ir['call_id'] === 'string'
            ? (ir['call_id'] as string)
            : typeof ir['tool_call_id'] === 'string'
              ? (ir['tool_call_id'] as string)
              : `call_${String(toolName).replace(/[^a-zA-Z0-9_]/g, '_')}`;
        rememberAssistantToolCall(toolCallId, toolName);
        return `TOOL_RESULT: ${JSON.stringify({ tool_call_id: toolCallId, name: toolName, content: text })}`;
      };

      const buildResponsesAssistantToolCallsLine = (item: unknown = {}): string | null => {
        const ir = asRecord(item);
        const toolCallsRaw: unknown = ir['tool_calls'];
        let sourceCalls: unknown[];
        if (Array.isArray(toolCallsRaw)) sourceCalls = toolCallsRaw as unknown[];
        else if (ir['type'] === 'function_call' || ir['type'] === 'custom_tool_call') sourceCalls = [item];
        else sourceCalls = [];
        if (!sourceCalls.length) return null;
        const serializedToolCalls = sourceCalls
          .map((toolCall: unknown, index: number) => {
            const tcr = asRecord(toolCall);
            const fn = asRecord(tcr['function']);
            const rawName: unknown = fn['name'] ?? tcr['name'];
            const namespace: unknown = tcr['namespace'] ?? ir['namespace'];
            const mappedTool = resolveExternalToolName(externalToolRegistry, rawName, namespace);
            const namespacedName =
              mappedTool?.namespacedName ??
              (typeof rawName === 'string' ? qualifyToolName(namespace, rawName) : '');
            if (!namespacedName) return null;
            const toolCallId =
              typeof tcr['call_id'] === 'string'
                ? (tcr['call_id'] as string)
                : typeof tcr['id'] === 'string'
                  ? (tcr['id'] as string)
                  : `call_${index + 1}`;
            const argsJson =
              tcr['type'] === 'custom_tool_call'
                ? JSON.stringify({ input: typeof tcr['input'] === 'string' ? (tcr['input'] as string) : '' })
                : normalizeToolArguments(fn['arguments'] ?? tcr['arguments']);
            rememberAssistantToolCall(toolCallId, namespacedName);
            return { id: toolCallId, name: namespacedName, arguments: argsJson };
          })
          .filter((v): v is { id: string; name: string; arguments: string } => v !== null);
        if (!serializedToolCalls.length) return null;
        return `ASSISTANT: <function_calls>${JSON.stringify(serializedToolCalls)}</function_calls>`;
      };

      const buildResponsesToolCallState = (toolCalls: unknown): ResponseToolCallState[] => {
        const calls: ResponseToolCallState[] = [];
        if (!Array.isArray(toolCalls)) return calls;
        for (const toolCall of toolCalls as unknown[]) {
          const record = asRecord(toolCall);
          const fn = asRecord(record['function']);
          const clientName = typeof fn['name'] === 'string' ? (fn['name'] as string) : '';
          const callId = typeof record['id'] === 'string' ? (record['id'] as string) : '';
          if (!callId || !clientName) continue;
          calls.push({
            callId,
            name: findExternalToolByExactName(externalToolRegistry, clientName)?.namespacedName ?? clientName,
          });
        }
        return calls;
      };

      const buildStoredResponseToolCalls = (toolCalls: unknown): ResponseToolCallState[] => {
        const merged = new Map<string, ResponseToolCallState>();
        for (const entry of previousState?.toolCalls ?? []) merged.set(entry.callId, entry);
        for (const entry of buildResponsesToolCallState(toolCalls)) merged.set(entry.callId, entry);
        return [...merged.values()];
      };

      const buildResponsesInputMessages = (rawItems: unknown): NormalizedInputMessage[] => {
        const normalized: NormalizedInputMessage[] = [];
        if (!Array.isArray(rawItems)) return normalized;
        for (const item of rawItems as unknown[]) {
          if (!item) continue;
          const ir = asRecord(item);
          if (ir['type'] === ADDITIONAL_TOOLS_ITEM_TYPE) continue;
          if (
            ir['type'] === 'function_call_output' ||
            ir['type'] === 'custom_tool_call_output' ||
            ir['type'] === 'tool_result' ||
            ir['role'] === 'tool'
          ) {
            const toolResultLine = buildResponsesToolResultLine(item);
            if (toolResultLine) normalized.push({ role: 'tool', content: toolResultLine });
            continue;
          }
          if (ir['type'] === 'function_call' || ir['type'] === 'custom_tool_call') {
            const line = buildResponsesAssistantToolCallsLine(item);
            if (line) normalized.push({ role: 'assistant', content: line, isToolCalls: true });
            continue;
          }
          const toolCallsRaw: unknown = ir['tool_calls'];
          if (ir['role'] === 'assistant' && Array.isArray(toolCallsRaw) && (toolCallsRaw as unknown[]).length) {
            const line = buildResponsesAssistantToolCallsLine(item);
            if (line) normalized.push({ role: 'assistant', content: line, isToolCalls: true });
          }
          if (ir['type'] === 'message') {
            const content = normalizeTextContent(ir['content']);
            if (content) normalized.push({ role: responsesInputRole(ir['role']), content });
            continue;
          }
          if (ir['type'] === 'input_text') {
            if (ir['text']) normalized.push({ role: 'user', content: String(ir['text']) });
            continue;
          }
          const text = normalizeTextContent(ir['content'] ?? ir['text']);
          if (text) normalized.push({ role: responsesInputRole(ir['role']), content: text });
        }
        return normalized;
      };

      let messages: NormalizedInputMessage[] = [];
      try {
        if (Array.isArray(chatMessages) && (chatMessages as unknown[]).length) {
          messages = buildResponsesInputMessages(chatMessages);
        } else if (typeof prompt === 'string' && prompt.trim()) {
          messages = [{ role: 'user', content: prompt }];
        } else if (typeof input === 'string') {
          messages = [{ role: 'user', content: input }];
        } else if (Array.isArray(input)) {
          messages = buildResponsesInputMessages(input);
        } else if (input && typeof input === 'object') {
          const ir = asRecord(input);
          if (['message', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'tool_result'].includes(String(ir['type']))) {
            messages = buildResponsesInputMessages([input]);
          } else {
            const content = normalizeTextContent(ir['content'] ?? ir['text']);
            if (content) {
              messages = [{ role: responsesInputRole(ir['role']), content }];
            }
          }
        }
      } catch (inputError) {
        const code = (inputError as Error & { code?: string }).code;
        if (typeof code === 'string' && code) {
          rejectInvalidRequest(toErrorMessage(inputError), code);
          return;
        }
        throw inputError;
      }

      if (!messages.length) {
        rejectInvalidRequest('input is required', 'input_required');
        return;
      }

      const resolvedModel = (await withTimeout(
        resolveRequestedModel(model ?? idempotency?.model ?? previousState?.model),
        REQUEST_TIMEOUT_MS,
        'resolve model',
      )) as unknown as { providerID: string; modelID: string };
      const pID = String(asRecord(resolvedModel)['providerID']);
      const mID = String(asRecord(resolvedModel)['modelID']);
      idempotency?.setModel(`${pID}/${mID}`);
      if (responsesStreamState) responsesStreamState.adoptResolvedModel(`${pID}/${mID}`);

      await ensureBackend(config);

      // Change-only: every PUT disposes the backend project instance.
      try {
        await ensureActiveModel(activeClient, pID, mID);
      } catch {
        // ignore
      }

      let sessionId: string | null = idempotency?.reconciling ? idempotency.childSessionId : null;
      if (idempotency?.reconciling) {
        // Unknown retries reuse the exact recorded child and never fork again.
        if (!sessionId) throw new Error('Idempotency reconciliation is missing its child session');
        // This is a request-owned child, not the parent continuation session.
        // Keep it until the wire result is captured unless it becomes stored state.
        ownedResponsesSessionId = sessionId;
      } else if (previousState) {
        const forkRes = (await withTimeout(
          activeClient.session.fork({
            path: { id: previousState.sessionId },
          }),
          REQUEST_TIMEOUT_MS,
          'fork continuation session',
        )) as unknown;
        sessionId = (asRecord(asRecord(forkRes)['data'])['id'] as string | undefined) ?? null;
        if (!sessionId) throw new Error('Failed to fork OpenCode continuation session');
        ownedResponsesSessionId = sessionId;
      } else {
        const sessionRes = (await withTimeout(activeClient.session.create(), REQUEST_TIMEOUT_MS, 'create session')) as unknown;
        sessionId = (asRecord(asRecord(sessionRes)['data'])['id'] as string | undefined) ?? null;
        if (!sessionId) {
          throw new Error('Failed to create OpenCode session');
        }
        ownedResponsesSessionId = sessionId;
      }

      const parts: Record<string, unknown>[] = [];
      const systemChunks: string[] = [];
      let fullPromptText = '';
      const formatResponsesRoleLine = (role: unknown, text: unknown): string =>
        `${String(role || 'user').toUpperCase()}: ${String(text ?? '')}`;
      for (const msg of messages) {
        if (msg.role === 'system') {
          if (msg.content) systemChunks.push(msg.content);
          continue;
        }
        if (!msg.content) continue;
        const text =
          msg.role === 'tool' || msg.content.startsWith('ASSISTANT: ') || msg.content.startsWith('TOOL_RESULT: ')
            ? msg.content
            : msg.role === 'user'
              ? msg.content
              : formatResponsesRoleLine(msg.role, msg.content);
        parts.push({ type: 'text', text });
        fullPromptText += `${text}\n\n`;
      }

      const systemWithGuard = buildSystemPrompt(
        [instructions, ...systemChunks].filter(Boolean).join('\n\n'),
        [externalToolContext.prompt, hostedSearch.requested ? SEARCH_GROUNDING_INSTRUCTION : ''].filter(Boolean).join('\n\n'),
        reasoningLevel,
        toolMode,
        internalToolContext.allowedToolNames,
      );

      const baseToolOverrides = (await withTimeout(
        getToolOverridesForMode(toolMode, internalToolContext),
        REQUEST_TIMEOUT_MS,
        'load tool overrides',
      )) as Record<string, boolean> | null;
      // P4: union the websearch grant onto any mode (bridge/disabled modes
      // otherwise force all-false and would switch the grounding tool back
      // off). Only `true` grants merge — never copy `false` entries, which
      // would extinguish an existing allowlist (e.g. webfetch) or a backend
      // without websearch (all-false disabled fallback).
      let toolOverrides = baseToolOverrides;
      if (hostedSearch.requested) {
        const searchOverrides = (await withTimeout(
          getToolOverridesForMode(TOOL_MODE.INTERNAL_ALLOWLIST, {
            allowedToolNames: ['websearch'],
          }),
          REQUEST_TIMEOUT_MS,
          'load search overrides',
        )) as Record<string, boolean> | null;
        if (searchOverrides) {
          const merged: Record<string, boolean> = { ...(baseToolOverrides ?? {}) };
          for (const [id, granted] of Object.entries(searchOverrides)) {
            if (granted === true) merged[id] = true;
          }
          toolOverrides = merged;
        } else if (DISABLE_TOOLS) {
          await cleanupOwnedResponsesSession();
          if (stream) {
            throw createToolDiscoveryUnavailableError();
          }
          res.status(503).json({
            error: {
              message: 'Tool discovery unavailable; backend tool IDs could not be verified',
              type: 'tool_discovery_unavailable',
              code: 'tool_discovery_unavailable',
            },
          });
          return;
        }
      }
      // Fail-closed by design (see chat.ts): null or verified-empty both 503.
      if (DISABLE_TOOLS && (!toolOverrides || Object.keys(toolOverrides).length === 0)) {
        await cleanupOwnedResponsesSession();
        if (stream) {
          throw createToolDiscoveryUnavailableError();
        }
        res.status(503).json({
          error: {
            message: 'Tool discovery unavailable; backend tool IDs could not be verified',
            type: 'tool_discovery_unavailable',
            code: 'tool_discovery_unavailable',
          },
        });
        return;
      }
      const makeForcedResponsesToolCallRequester = (): (() => Promise<Record<string, unknown> | null>) =>
        createForcedToolCallRequester({
          mode: externalToolChoice.mode,
          sessionId: sessionId as string,
          systemWithGuard,
          requiredTool: externalToolChoice.requiredTool ?? externalToolRegistry[0]?.namespacedName,
          providerID: pID,
          modelID: mID,
          toolOverrides,
          requestTimeoutMs: REQUEST_TIMEOUT_MS,
          forbidThinkBlock: false,
          signal: responsesAbortController.signal,
          requireTerminalCompletion: Boolean(idempotency),
          assertCanPrompt: assertResponsesCanPrompt,
          ...(idempotency
            ? {
                beforePrompt: (forcedSessionId: string, userMessageId: string): void => {
                  idempotency.markSubmitted(forcedSessionId, userMessageId, `${pID}/${mID}`);
                },
              }
            : {}),
        });
      let requestForcedResponsesToolCall = makeForcedResponsesToolCallRequester();
      const confirmForcedResponsesToolCall = (forcedResponse: Record<string, unknown>): void => {
        if (!idempotency) return;
        const assistantMessageId = forcedResponse['assistantMessageId'];
        const userMessageId = forcedResponse['userMessageId'];
        const hasActiveToolState = Array.isArray(forcedResponse['toolParts']) &&
          (forcedResponse['toolParts'] as unknown[]).some((part) => {
            const partRecord = asRecord(part);
            const state = asRecord(partRecord['state']);
            const status = state['status'] ?? partRecord['status'];
            return partRecord['type'] === 'tool' && (status === 'pending' || status === 'running');
          });
        if (
          forcedResponse['complete'] !== true ||
          typeof assistantMessageId !== 'string' ||
          !assistantMessageId ||
          typeof idempotency.userMessageId !== 'string' ||
          !idempotency.userMessageId ||
          userMessageId !== idempotency.userMessageId ||
          hasActiveToolState
        ) {
          throw new Error('Idempotency forced tool result is incomplete or does not identify the exact assistant turn');
        }
        idempotency.confirmResult(idempotency.userMessageId, assistantMessageId);
      };

      const promptParams: { path: { id: string }; body: Record<string, unknown> } = {
        path: { id: sessionId as string },
        body: {
          model: { providerID: pID, modelID: mID },
          ...(systemWithGuard ? { system: systemWithGuard } : {}),
          parts: externalToolContext.reminder ? [...parts, { type: 'text', text: externalToolContext.reminder }] : parts,
          ...(max_output_tokens ? { max_tokens: max_output_tokens } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
          ...(top_p !== undefined ? { top_p } : {}),
        },
      };
      promptParams.body.messageID = idempotency?.reconciling
        ? idempotency.userMessageId
        : makeId('msg_');
      if (typeof promptParams.body.messageID !== 'string' || !promptParams.body.messageID) {
        throw new Error('Idempotency reconciliation is missing its user message ID');
      }
      const hasConfirmedIdempotencyResult = (): boolean => Boolean(
        idempotency?.resultConfirmed &&
        typeof idempotency.confirmedAssistantMessageId === 'string' &&
        idempotency.confirmedAssistantMessageId.trim(),
      );
      const assertIdempotencyResultConfirmed = (): void => {
        if (idempotency?.submitted && !hasConfirmedIdempotencyResult()) {
          throw new Error('Idempotency result is not confirmed for the exact assistant turn');
        }
      };
      const isExactTerminalPoll = (result: unknown): boolean => {
        const poll = asRecord(result);
        return poll['complete'] === true &&
          poll['partial'] !== true &&
          typeof poll['assistantMessageId'] === 'string' &&
          poll['assistantMessageId'].trim().length > 0 &&
          typeof idempotency?.userMessageId === 'string' &&
          poll['userMessageId'] === idempotency.userMessageId;
      };
      const confirmExactTerminalPoll = (result: unknown): void => {
        if (!idempotency?.submitted) return;
        if (!isExactTerminalPoll(result)) {
          throw new Error('Idempotency result is incomplete or does not identify the exact assistant turn');
        }
        const poll = asRecord(result);
        idempotency.confirmResult(idempotency.userMessageId as string, poll['assistantMessageId'] as string);
      };
      // Stage-5: strip false entries for free-tier suspects (any false gates; true-only sent, all-false omitted).
      const promptToolOverrides = selectPromptToolOverrides(toolOverrides, pID, mID);
      if (promptToolOverrides) {
        promptParams.body['tools'] = promptToolOverrides;
      }

      let content = '';
      let reasoning = '';
      const buildResponsesMessageOutputItem = (
        text: unknown,
        messageId: string = `msg_${crypto.randomUUID()}`,
        annotations: unknown[] = [],
      ): Record<string, unknown> | null => {
        if (!text || (typeof text === 'string' && !text)) return null;
        if (typeof text === 'string' && !text.trim()) return null;
        if (!text) return null;
        return {
          id: messageId,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text,
              annotations,
            },
          ],
        };
      };

      /**
       * Freeform payload of a custom tool call. A missing or non-string `input`
       * is an argument error, not an empty string: the declared schema makes
       * `input` required, and emitting `""` would hand the client a custom call
       * the model never made.
       */
      const customToolInputOf = (args: unknown, callName: string): string => {
        if (typeof args === 'string') {
          try {
            return customToolInputOf(JSON.parse(args), callName);
          } catch {
            return args;
          }
        }
        const value = args && typeof args === 'object' && !Array.isArray(args) ? asRecord(args)['input'] : undefined;
        if (typeof value === 'string') return value;
        throw createInvalidRequestError(
          `Custom tool call ${callName} requires a string "input" argument.`,
          'invalid_custom_tool_input',
        );
      };

      const buildResponsesCustomToolCallItem = (
        callId: string,
        name: string,
        args: unknown,
        status: string,
      ): Record<string, unknown> => ({
        id: callId,
        type: 'custom_tool_call',
        status,
        call_id: callId,
        name,
        input: status === 'completed' ? customToolInputOf(args, name) : '',
      });

      if (stream) {
        if (res.destroyed || res.writableEnded) {
          stopResponsesKeepalive();
          try {
            if (!res.destroyed) res.end();
          } catch {
            // ignore
          }
          return;
        }
        const responseState = responsesStreamState;
        if (!responseState) throw new Error('Responses stream state was not initialized');
        const responseId = responseState.id;
        const contentIndex = 0;
        const outputItemId = `msg_${crypto.randomUUID()}`;
        const reasoningItemId = 'reasoning-0';
        const nextSeq = (): number => responseState.nextSequence();
        const emit = (payload: unknown): void => responseState.emit(payload);

        const outputAssembler = responseState.output;
        let announcedContent = false;
        const ensureOutputScaffold = (): ResponsesOutputEntry => {
          let entry = outputAssembler.get('message', outputItemId);
          if (!entry) {
            entry = outputAssembler.announce({
              id: outputItemId,
              type: 'message',
              status: 'in_progress',
              role: 'assistant',
              content: [],
            });
            emit({
              type: 'response.output_item.added',
              sequence_number: nextSeq(),
              output_index: entry.index,
              item: entry.addedItem,
            });
          }
          if (!announcedContent) {
            emit({
              type: 'response.content_part.added',
              sequence_number: nextSeq(),
              output_index: entry.index,
              content_index: contentIndex,
              item_id: outputItemId,
              part: { type: 'output_text', text: '', annotations: [] },
            });
            announcedContent = true;
          }
          return entry;
        };
        const ensureReasoningScaffold = (): ResponsesOutputEntry => {
          let entry = outputAssembler.get('reasoning', reasoningItemId);
          if (entry) return entry;
          entry = outputAssembler.announce({
            id: reasoningItemId,
            type: 'reasoning',
            status: 'in_progress',
            summary: [{ type: 'summary_text', text: '' }],
          });
          emit({
            type: 'response.output_item.added',
            sequence_number: nextSeq(),
            output_index: entry.index,
            item: entry.addedItem,
          });
          return entry;
        };
        const finalizeOutputItems = (
          finalContent: string = content,
          finalReasoning: string = reasoning,
          annotations: unknown[] = [],
        ): void => {
          const messageEntry = outputAssembler.get('message', outputItemId);
          if (messageEntry) {
            const messageItem = buildResponsesMessageOutputItem(finalContent, outputItemId, annotations) ?? {
              id: outputItemId,
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: finalContent, annotations }],
            };
            outputAssembler.complete('message', outputItemId, messageItem);
          }
          const reasoningEntry = outputAssembler.get('reasoning', reasoningItemId);
          if (reasoningEntry) {
            outputAssembler.complete('reasoning', reasoningItemId, {
              id: reasoningItemId,
              type: 'reasoning',
              status: 'completed',
              summary: [{ type: 'summary_text', text: finalReasoning }],
            });
          }
          for (const entry of outputAssembler.list()) {
            if (entry.emittedDone) continue;
            if (!entry.doneItem) {
              if (entry.type === 'function_call') {
                outputAssembler.complete(entry.type, entry.id, {
                  ...entry.addedItem,
                  status: 'completed',
                  arguments: '',
                });
              } else if (entry.type === 'custom_tool_call') {
                outputAssembler.complete(entry.type, entry.id, {
                  ...entry.addedItem,
                  status: 'completed',
                  input: '',
                });
              } else if (entry.type === 'web_search_call') {
                outputAssembler.complete(entry.type, entry.id, {
                  ...entry.addedItem,
                  status: 'completed',
                });
              }
            }
            const doneItem = entry.doneItem;
            if (!doneItem) continue;
            if (entry.type === 'message' && announcedContent) {
              const doneContent = Array.isArray(doneItem['content']) ? doneItem['content'] : [];
              const part = asRecord(doneContent[0]);
              emit({
                type: 'response.output_text.done',
                sequence_number: nextSeq(),
                output_index: entry.index,
                content_index: contentIndex,
                item_id: entry.id,
                text: String(part['text'] ?? ''),
              });
              emit({
                type: 'response.content_part.done',
                sequence_number: nextSeq(),
                output_index: entry.index,
                content_index: contentIndex,
                item_id: entry.id,
                part,
              });
            } else if (entry.type === 'reasoning') {
              emit({
                type: 'response.reasoning_summary_text.done',
                sequence_number: nextSeq(),
                output_index: entry.index,
                item_id: entry.id,
                summary_index: 0,
                text: finalReasoning,
              });
            } else if (entry.type === 'function_call') {
              emit({
                type: 'response.function_call_arguments.done',
                sequence_number: nextSeq(),
                output_index: entry.index,
                item_id: entry.id,
                arguments: String(doneItem['arguments'] ?? ''),
              });
            } else if (entry.type === 'custom_tool_call') {
              emit({
                type: 'response.custom_tool_call_input.done',
                sequence_number: nextSeq(),
                output_index: entry.index,
                item_id: entry.id,
                input: String(doneItem['input'] ?? ''),
              });
            }
            emit({
              type: 'response.output_item.done',
              sequence_number: nextSeq(),
              output_index: entry.index,
              item: doneItem,
            });
            outputAssembler.markDone(entry);
          }
        };
        responseState.finalize = () => finalizeOutputItems();
        // Intentional: buffer while any external tool contract is declared so tool
        // markup is never streamed before classification. Pure-text turns also batch.
        const shouldBufferExternalStream = externalToolRegistry.length > 0;
        const deferVisibleOutput = shouldBufferExternalStream || hostedSearch.requested || Boolean(idempotency);
        let filterContentDelta = createToolCallFilter({ disableTools: DISABLE_TOOLS, forceStrip: shouldBufferExternalStream, registry: externalToolRegistry });
        let filterReasoningDelta = createToolCallFilter({ disableTools: DISABLE_TOOLS, forceStrip: shouldBufferExternalStream, registry: externalToolRegistry });
        let parseContentToolCalls = createExternalToolCallStreamParser(externalToolRegistry);
        let parseReasoningToolCalls = createExternalToolCallStreamParser(externalToolRegistry);
        const streamedToolCalls: FinalToolCall[] = [];
        let rawContent = '';
        let rawReasoning = '';
        const emitResponsesFunctionCall = (toolCall: FinalToolCall): void => {
          const record = toolCall as unknown as Record<string, unknown>;
          const fn = asRecord(record['function']);
          const callId = String(record['id'] ?? '');
          const args = typeof fn['arguments'] === 'string' ? fn['arguments'] : '';
          if (outputAssembler.has('function_call', callId)) throw createDuplicateToolCallIdError();
          const doneItem = {
            id: callId,
            type: 'function_call',
            status: 'completed',
            call_id: callId,
            name: fn['name'],
            arguments: args,
          };
          const addedItem = {
            id: callId,
            type: 'function_call',
            status: 'in_progress',
            call_id: callId,
            name: fn['name'],
            arguments: '',
          };
          const entry = outputAssembler.announce(addedItem);
          emit({
            type: 'response.output_item.added',
            sequence_number: nextSeq(),
            output_index: entry.index,
            item: addedItem,
          });
          emit({
            type: 'response.function_call_arguments.delta',
            sequence_number: nextSeq(),
            output_index: entry.index,
            item_id: callId,
            delta: args,
          });
          outputAssembler.complete('function_call', callId, doneItem);
        };
        const emitResponsesCustomToolCall = (toolCall: FinalToolCall): void => {
          const record = toolCall as unknown as Record<string, unknown>;
          const fn = asRecord(record['function']);
          const callId = String(record['id'] ?? '');
          const name = String(fn['name'] ?? '');
          if (outputAssembler.has('custom_tool_call', callId)) throw createDuplicateToolCallIdError();
          const addedItem = buildResponsesCustomToolCallItem(callId, name, '', 'in_progress');
          const doneItem = buildResponsesCustomToolCallItem(callId, name, fn['arguments'], 'completed');
          const entry = outputAssembler.announce(addedItem);
          emit({
            type: 'response.output_item.added',
            sequence_number: nextSeq(),
            output_index: entry.index,
            item: addedItem,
          });
          emit({
            type: 'response.custom_tool_call_input.delta',
            sequence_number: nextSeq(),
            output_index: entry.index,
            item_id: callId,
            delta: String(doneItem['input'] ?? ''),
          });
          outputAssembler.complete('custom_tool_call', callId, doneItem);
        };
        const appendVisibleDelta = (filtered: string, isReasoning: boolean): void => {
          if (!filtered) return;
          if (isReasoning) reasoning += filtered;
          else content += filtered;
        };
        const writeVisibleDelta = (filtered: string, isReasoning: boolean): void => {
          if (!filtered) return;
          if (isReasoning) {
            const entry = ensureReasoningScaffold();
            emit({
              type: 'response.reasoning_summary_text.delta',
              sequence_number: nextSeq(),
              output_index: entry.index,
              item_id: reasoningItemId,
              summary_index: 0,
              delta: filtered,
            });
          } else {
            const entry = ensureOutputScaffold();
            announcedContent = true;
            emit({
              type: 'response.output_text.delta',
              sequence_number: nextSeq(),
              output_index: entry.index,
              content_index: contentIndex,
              item_id: outputItemId,
              delta: filtered,
            });
          }
        };
        const sendResponsesDelta = (delta: string, isReasoning: boolean = false): void => {
          if (!delta) return;
          if (isReasoning) rawReasoning += delta;
          else rawContent += delta;
          const parsedDeltaToolCalls = isReasoning ? parseReasoningToolCalls(delta) : parseContentToolCalls(delta);
          parsedDeltaToolCalls.forEach((toolCall) => streamedToolCalls.push(toolCall));
          const filtered = isReasoning ? filterReasoningDelta(delta) : filterContentDelta(delta);
          if (!filtered) return;
          appendVisibleDelta(filtered, isReasoning);
          if (!deferVisibleOutput) writeVisibleDelta(filtered, isReasoning);
        };
         // Only the suffix past the raw prefix is safe to replay. A divergent
         // snapshot (raw "AC", snapshot "ABC") would duplicate visible text if
         // appended whole; tool calls can still be parsed from the snapshot.
         const unsentSuffix = (full: unknown, raw: string): string => {
           const text = typeof full === 'string' ? full : '';
           if (!text) return '';
           if (!raw) return text;
           return text.startsWith(raw) ? text.slice(raw.length) : '';
         };
         // Snapshot replay is display-only: tool calls are parsed once from the
         // authoritative source. Feeding snapshot text through the delta parser
         // would create streamed artifacts with empty arguments and mix stale
         // partial calls into the final merge.
         const replaySnapshotText = (snapshotContent: unknown, snapshotReasoning: unknown): void => {
           const remainingContent = unsentSuffix(snapshotContent, rawContent);
           const remainingReasoning = unsentSuffix(snapshotReasoning, rawReasoning);
           if (!remainingContent && !remainingReasoning) return;
           // Keep the buffered raw text in sync so the later static strip of
           // `rawContent`/`rawReasoning` does not erase the replayed suffix.
           if (remainingContent) rawContent += remainingContent;
           if (remainingReasoning) rawReasoning += remainingReasoning;
           const visible = stripExternalToolCallMarkupFromJoinedText(
             externalToolRegistry,
             remainingReasoning,
             remainingContent,
           );
           if (!visible.content && !visible.reasoning) return;
           appendVisibleDelta(visible.reasoning, true);
           appendVisibleDelta(visible.content, false);
           if (!deferVisibleOutput) {
             writeVisibleDelta(visible.reasoning, true);
             writeVisibleDelta(visible.content, false);
           }
         };

        let streamSearchToolParts: unknown[] = [];
        const keepStreamToolParts = (polled: { toolParts?: unknown }): void => {
          if (hostedSearch.requested && Array.isArray(polled.toolParts) && polled.toolParts.length > 0) {
            streamSearchToolParts = polled.toolParts;
          }
        };
        let recoverySnapshot: { content: string; reasoning: string; error: unknown; toolParts?: unknown; assistantMessageId?: string; userMessageId?: string; partial?: boolean; complete?: boolean } | null = null;
        let recoveryPromise: Promise<{ content: string; reasoning: string; error: unknown; toolParts?: unknown; assistantMessageId?: string; userMessageId?: string; partial?: boolean; complete?: boolean }> | null = null;
        let currentAssistantMessageId: string | null = null;
        const isContinuation = Boolean(previousState?.sessionId);
        const hasRecoveryEvidence = (snapshot: { content: string; reasoning: string; toolParts?: unknown }): boolean =>
          Boolean(
            snapshot.content ||
              snapshot.reasoning ||
              (Array.isArray(snapshot.toolParts) && snapshot.toolParts.length > 0),
          );
        const pollRecoverySnapshot = (): Promise<{ content: string; reasoning: string; error: unknown; toolParts?: unknown; assistantMessageId?: string; userMessageId?: string; partial?: boolean; complete?: boolean }> => {
          if (!recoveryPromise) {
            recoveryPromise = activePollForAssistantResponse(
              sessionId as string,
              REQUEST_TIMEOUT_MS,
              undefined,
              responsesAbortController.signal,
              idempotency?.submitted
                ? (idempotency.userMessageId ?? undefined)
                : isContinuation ? String(promptParams.body['messageID']) : undefined,
              Boolean(idempotency),
            );
          }
          return recoveryPromise;
        };
        let collected: Record<string, unknown> | null = null;
        let lastStreamAttemptError: unknown = null;
        let promptSubmitted = false;
        let promptPromise: Promise<unknown> | null = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          collected = null;
          let promptError: unknown = null;
          if (attempt > 1) {
            if (fallbackToProxy) switchToProxyBundle();
            await ensureActiveModel(activeClient, pID, mID).catch(() => {});
            const retriedSessionId = sessionId;
            if (!isContinuation && !idempotency?.submitted) {
              promptSubmitted = false;
              if (retriedSessionId && ownedResponsesSessionId === retriedSessionId) {
                await cleanupOwnedResponsesSession();
                if (ownedResponsesSessionId === retriedSessionId) {
                  throw new Error('Failed to cleanup retried OpenCode session');
                }
              }
              const retrySessionRes = (await withTimeout(
                activeClient.session.create(),
                REQUEST_TIMEOUT_MS,
                'create session',
              )) as unknown;
              sessionId = (asRecord(asRecord(retrySessionRes)['data'])['id'] as string | undefined) ?? null;
              if (!sessionId) throw new Error('Failed to create OpenCode session for retry');
              ownedResponsesSessionId = sessionId;
              promptParams.path.id = sessionId;
            } else {
              if (promptPromise) {
                await promptPromise.catch(() => {});
              }
            }
            requestForcedResponsesToolCall = makeForcedResponsesToolCallRequester();
            content = '';
            reasoning = '';
            rawContent = '';
            rawReasoning = '';
            streamedToolCalls.length = 0;
            filterContentDelta = createToolCallFilter({
              disableTools: DISABLE_TOOLS,
              forceStrip: shouldBufferExternalStream,
              registry: externalToolRegistry,
            });
            filterReasoningDelta = createToolCallFilter({
              disableTools: DISABLE_TOOLS,
              forceStrip: shouldBufferExternalStream,
              registry: externalToolRegistry,
            });
            parseContentToolCalls = createExternalToolCallStreamParser(externalToolRegistry);
            parseReasoningToolCalls = createExternalToolCallStreamParser(externalToolRegistry);
            recoverySnapshot = null;
            recoveryPromise = null;
            fallbackServed = false;
            await sleep(computeRetryDelay(attempt - 1, lastStreamAttemptError));
          }
          try {
            if (idempotency?.reconciling) {
              const reconciled = await activePollForAssistantResponse(
                sessionId as string,
                REQUEST_TIMEOUT_MS,
                undefined,
              responsesAbortController.signal,
              idempotency.userMessageId ?? undefined,
              true,
            );
              if (reconciled.error != null) {
                if (isExactTerminalPoll(reconciled)) {
                  confirmExactTerminalPoll(reconciled);
                  throw normalizeBackendError(reconciled.error);
                }
                throw new Error('Idempotency reconciliation has no confirmed assistant result');
              }
              if (
                !isExactTerminalPoll(reconciled)
              ) {
                throw new Error('Idempotency reconciliation has no confirmed assistant result');
              }
              confirmExactTerminalPoll(reconciled);
              recoverySnapshot = reconciled;
              currentAssistantMessageId = reconciled.assistantMessageId ?? null;
              keepStreamToolParts(reconciled);
              responsesStreamState?.emitCreated();
              replaySnapshotText(reconciled.content, reconciled.reasoning);
              collected = {
                content: reconciled.content,
                reasoning: reconciled.reasoning,
                toolParts: reconciled.toolParts,
                assistantMessageId: reconciled.assistantMessageId,
                userMessageId: reconciled.userMessageId,
                complete: reconciled.complete,
                finish: 'stop',
              };
            } else if (fallbackToProxy) {
              // SSE subscribe ignores custom fetch (SDK gap): prompt through the
              // proxy bundle; the poll below fills content/reasoning.
              if (!((isContinuation || idempotency?.submitted) && promptSubmitted)) {
                if (isContinuation) {
                  promptSubmitted = true;
                }
                if (idempotency) {
                  idempotency.markSubmitted(
                    sessionId as string,
                    String(promptParams.body['messageID']),
                    `${pID}/${mID}`,
                  );
                }
                promptSubmitted = true;
                assertResponsesCanPrompt();
                const promptResult = await activePromptWithTimeout(promptParams, REQUEST_TIMEOUT_MS);
                const promptInfo = asRecord(asRecord(asRecord(promptResult)['data'])['info']);
                const promptMessageId = promptInfo['id'] ?? promptInfo['messageID'] ?? promptInfo['messageId'];
          if (typeof promptMessageId === 'string' && promptMessageId) currentAssistantMessageId = promptMessageId;
                promptSubmitted = true;
              }
              const pres = await pollRecoverySnapshot();
              if (idempotency?.submitted) confirmExactTerminalPoll(pres);
              if (pres.error != null) {
                collected = { error: pres.error };
              } else if (pres.partial === true) {
                collected = { error: new Error('Recovery poll returned incomplete response') };
              } else if (!hasRecoveryEvidence(pres) && externalToolChoice.mode !== 'required') {
                collected = { error: new Error('Recovery poll returned empty response') };
              } else {
                recoverySnapshot = pres;
                currentAssistantMessageId = pres.assistantMessageId ?? currentAssistantMessageId;
                keepStreamToolParts(pres);
                if (pres.content || pres.reasoning) {
                  replaySnapshotText(pres.content, pres.reasoning);
                  fallbackServed = true;
                }
                collected = {
                  content: pres.content,
                  reasoning: pres.reasoning,
                  toolParts: pres.toolParts,
                  assistantMessageId: pres.assistantMessageId,
                  userMessageId: pres.userMessageId,
                  complete: pres.complete,
                };
              }
            } else {
              const collectPromise = collectFromEvents(
                sessionId as string,
                REQUEST_TIMEOUT_MS,
                sendResponsesDelta,
                DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS,
                DEFAULT_EVENT_IDLE_TIMEOUT_MS,
                responsesAbortController.signal,
                idempotency?.submitted
                  ? (idempotency.userMessageId ?? undefined)
                  : isContinuation ? String(promptParams.body['messageID']) : undefined,
              );

              const safeCollect = collectPromise.catch((err: unknown) => ({ __error: err }));
              if ((isContinuation || idempotency?.submitted) && promptSubmitted) {
                // Do NOT prompt again!
              } else {
                if (isContinuation || idempotency) {
                  promptSubmitted = true;
                }
                if (idempotency) {
                  idempotency.markSubmitted(
                    sessionId as string,
                    String(promptParams.body['messageID']),
                    `${pID}/${mID}`,
                  );
                }
                assertResponsesCanPrompt();
                promptPromise = activePromptWithTimeout(promptParams, REQUEST_TIMEOUT_MS)
                  .then((promptResult: unknown) => {
                    const promptInfo = asRecord(asRecord(asRecord(promptResult)['data'])['info']);
                    const promptMessageId = promptInfo['id'] ?? promptInfo['messageID'] ?? promptInfo['messageId'];
                if (typeof promptMessageId === 'string' && promptMessageId) currentAssistantMessageId = promptMessageId;
                    promptSubmitted = true;
                  })
                  .catch((err: unknown) => {
                    promptError = err;
                    logDebug('Responses prompt error:', toErrorMessage(err));
                  });
              }
              const closePromise = getResponsesResClosed();
              const raced = closePromise
                ? await Promise.race([safeCollect, closePromise.then(() => ({ __cancelled: true }))])
                : await safeCollect;
              const racedRecord = asRecord(raced);
              if (racedRecord['__cancelled']) {
                stopResponsesKeepalive();
                try {
                  if (!res.destroyed) res.end();
                } catch {
                  // ignore
                }
                return;
              }
              collected = raced as Record<string, unknown>;
            }
          } catch (e: unknown) {
            collected = { __error: e };
          }

          const collectedRecord = asRecord(collected);
          if (typeof collectedRecord['assistantMessageId'] === 'string') {
            currentAssistantMessageId = collectedRecord['assistantMessageId'] as string;
          }
          let attemptError: unknown = promptError ?? (collectedRecord['error'] ?? collectedRecord['__error'] ?? null);
          if (!attemptError && (collectedRecord['noData'] || collectedRecord['cut'] || collectedRecord['idleTimeout'])) {
            try {
              const recovery = await pollRecoverySnapshot();
              if (recovery.error != null) {
                attemptError = recovery.error;
              } else if (recovery.partial === true) {
                attemptError = new Error('Recovery poll returned incomplete response');
              } else if (!hasRecoveryEvidence(recovery)) {
                if (streamedToolCalls.length === 0 && externalToolChoice.mode !== 'required') {
                  attemptError = new Error('Recovery poll returned empty response');
                }
              } else {
                recoverySnapshot = recovery;
                keepStreamToolParts(recovery);
                replaySnapshotText(recovery.content, recovery.reasoning);
                currentAssistantMessageId = recovery.assistantMessageId ?? currentAssistantMessageId;
                collected = {
                  content: recovery.content,
                  reasoning: recovery.reasoning,
                  toolParts: recovery.toolParts,
                  assistantMessageId: recovery.assistantMessageId,
                };
              }
            } catch (pollErr: unknown) {
              attemptError = pollErr;
            }
          }
          const nothingStreamed = !rawContent && !rawReasoning && streamedToolCalls.length === 0;
          if (idempotency?.submitted && attemptError) {
            const recovered = await pollRecoverySnapshot();
            confirmExactTerminalPoll(recovered);
            if (recovered.error != null) throw normalizeBackendError(recovered.error);
            recoverySnapshot = recovered;
            currentAssistantMessageId = recovered.assistantMessageId ?? currentAssistantMessageId;
            keepStreamToolParts(recovered);
            collected = recovered;
            attemptError = null;
          } else if (isContinuation && attemptError) {
            throw normalizeBackendError(attemptError);
          }
          if (attemptError && nothingStreamed && attempt < maxAttempts && engageProxyFallback(attemptError)) {
            lastStreamAttemptError = attemptError;
            continue;
          }
          if (attemptError && nothingStreamed && attempt < maxAttempts && isTransientUpstreamError(attemptError)) {
            console.warn(
              `[Proxy] Transient upstream error in responses stream (attempt ${attempt}/${maxAttempts}), retrying:`,
              readDataMessage(attemptError),
            );
            lastStreamAttemptError = attemptError;
            continue;
          }
          break;
        }

        const collectedR = asRecord(collected);
        if (responsesAbortController.signal.aborted || collectedR['cancelled']) {
          stopResponsesKeepalive();
          return;
        }
        if (collectedR['error'] != null) {
          throw normalizeBackendError(collectedR['error']);
        }
          const hasValidEventTerminal = Boolean(
            collected &&
            !collectedR['__error'] &&
           !collectedR['noData'] &&
           !collectedR['idleTimeout'] &&
           !collectedR['cut'] &&
           !collectedR['cancelled'] &&
           collectedR['finish'] !== 'tool' &&
           collectedR['finish'] !== 'tool-calls' &&
           (rawContent ||
             rawReasoning ||
             streamedToolCalls.length > 0 ||
             content ||
             reasoning ||
              collectedR['content'] ||
              collectedR['reasoning']),
          );
          const hasValidConfirmedEventTerminal = Boolean(
            hasValidEventTerminal &&
            collectedR['finish'] === 'stop' &&
            typeof collectedR['assistantMessageId'] === 'string' &&
            collectedR['assistantMessageId'].trim().length > 0 &&
            collectedR['userMessageId'] === idempotency?.userMessageId,
          );
          const hasValidTerminal = idempotency?.submitted
            ? hasValidConfirmedEventTerminal || isExactTerminalPoll(collectedR)
            : hasValidEventTerminal;
          if (idempotency?.submitted && hasValidConfirmedEventTerminal) {
            idempotency.confirmResult(
              idempotency.userMessageId as string,
              collectedR['assistantMessageId'] as string,
            );
          } else if (idempotency?.submitted && isExactTerminalPoll(collectedR)) {
            confirmExactTerminalPoll(collectedR);
          }
          const recoverSnapshot = async (
            fallbackError: unknown = null,
          ): Promise<{ content: string; reasoning: string; error: unknown; toolParts?: unknown; assistantMessageId?: string; userMessageId?: string; partial?: boolean; complete?: boolean } | null> => {
           if (responsesAbortController.signal.aborted) return null;
            let polled: { content: string; reasoning: string; error: unknown; toolParts?: unknown; assistantMessageId?: string; userMessageId?: string; partial?: boolean; complete?: boolean };
           try {
             polled = await pollRecoverySnapshot();
           } catch (error: unknown) {
             if (responsesAbortController.signal.aborted) return null;
             if (fallbackError != null) throw normalizeBackendError(fallbackError);
             throw normalizeBackendError(error);
           }
             if (idempotency?.submitted) confirmExactTerminalPoll(polled);
             if (polled.error != null) {
               throw polled.error;
             }
           if (polled.partial === true) throw new Error('Recovery poll returned incomplete response');
            if (!hasRecoveryEvidence(polled)) {
             if (fallbackError != null) throw normalizeBackendError(fallbackError);
              return null;
            }
            recoverySnapshot = polled;
           currentAssistantMessageId = polled.assistantMessageId ?? currentAssistantMessageId;
           return polled;
         };
         const needsRecovery = Boolean(
           collectedR['__error'] || collectedR['noData'] || collectedR['idleTimeout'] || collectedR['cut'] || !hasValidTerminal,
         );
         if (needsRecovery) {
           if (collectedR['__error'] && !fallbackToProxy) engageProxyFallback(collectedR['__error']);
           const polled = await recoverSnapshot(collectedR['__error']);
           if (polled) {
             keepStreamToolParts(polled);
             replaySnapshotText(polled.content, polled.reasoning);
           }
         } else if (collected && ((collectedR['content'] as string) || (collectedR['reasoning'] as string))) {
           replaySnapshotText(collectedR['content'], collectedR['reasoning']);
         }

         if (hostedSearch.requested && streamSearchToolParts.length === 0) {
           try {
             const evPoll = await activePollForAssistantResponse(
              sessionId as string,
              Math.min(15000, REQUEST_TIMEOUT_MS),
              undefined,
              responsesAbortController.signal,
               idempotency?.submitted
                 ? (idempotency.userMessageId ?? undefined)
                 : isContinuation ? String(promptParams.body['messageID']) : undefined,
               Boolean(idempotency),
             );
             if (Array.isArray(evPoll.toolParts)) streamSearchToolParts = evPoll.toolParts;
           } catch {
           }
         }

         if (responsesAbortController.signal.aborted) return;

         let polledForToolCalls: { content: string; reasoning: string; error: unknown; toolParts?: unknown; assistantMessageId?: string; partial?: boolean } | null = null;
         if (externalToolRegistry.length > 0 && !hasValidTerminal && !recoveryPromise) {
           const polled = await recoverSnapshot();
           if (polled) {
             polledForToolCalls = polled;
             if (shouldBufferExternalStream) {
               replaySnapshotText(polled.content, polled.reasoning);
             }
           }
         }

           if (!hasValidTerminal && !recoverySnapshot && !fallbackServed) {
             if (streamedToolCalls.length === 0 && externalToolChoice.mode !== 'required') {
               throw new Error('Stream ended without valid terminal');
             }
           }


         const flushedReasoningCalls = parseReasoningToolCalls.flush ? parseReasoningToolCalls.flush() : [];
         const flushedContentCalls = parseContentToolCalls.flush ? parseContentToolCalls.flush() : [];
         const flushedReasoningText = filterReasoningDelta.flush ? filterReasoningDelta.flush() : '';
         const flushedContentText = filterContentDelta.flush ? filterContentDelta.flush() : '';
         appendVisibleDelta(flushedReasoningText, true);
         appendVisibleDelta(flushedContentText, false);
         const recoveryForParse = recoverySnapshot as { content: string; reasoning: string; error: unknown; toolParts?: unknown } | null;
         const parseJoined = (reasoningText: string, contentText: string): FinalToolCall[] =>
           externalToolRegistry.length > 0
             ? parseExternalToolCallsFromJoinedText(externalToolRegistry, reasoningText, contentText)
             : [];
         const callsFromText = (source: AuthoritativeStreamSource): FinalToolCall[] =>
           externalToolRegistry.length > 0
             ? parseJoined(source.reasoning, source.content)
             : [];
         const callsFromRaw = (source: AuthoritativeStreamSource): FinalToolCall[] =>
           externalToolRegistry.length > 0
             ? mergeToolCallArtifacts(
                 streamedToolCalls,
                 flushedReasoningCalls,
                 flushedContentCalls,
                 parseJoined(source.reasoning, source.content),
               )
             : [];
         // One authoritative source group: snapshot when available, otherwise
         // the raw delta text. Never validate both groups independently.
         let authoritativeSource = resolveAuthoritativeStreamSource({
           collected: collectedR,
           polledSnapshot: polledForToolCalls ?? recoveryForParse,
           rawContent,
           rawReasoning,
         });
         const streamSource = (): string[][] => [[authoritativeSource.reasoning, authoritativeSource.content]];

         if (shouldBufferExternalStream) {
           const visible = stripExternalToolCallMarkupFromJoinedText(
             externalToolRegistry,
             authoritativeSource.reasoning,
             authoritativeSource.content,
           );
           reasoning = visible.reasoning;
           content = visible.content;
         } else if (deferVisibleOutput) {
           reasoning = authoritativeSource.reasoning;
           content = authoritativeSource.content;
         } else {
           if (rawContent && authoritativeSource.content && !authoritativeSource.content.startsWith(rawContent)) {
             throw new Error('Stream content diverged from authoritative snapshot');
           }
           if (rawReasoning && authoritativeSource.reasoning && !authoritativeSource.reasoning.startsWith(rawReasoning)) {
             throw new Error('Stream reasoning diverged from authoritative snapshot');
           }
           writeVisibleDelta(flushedReasoningText, true);
           writeVisibleDelta(flushedContentText, false);
         }

         let parsedToolCalls: FinalToolCall[] = authoritativeSource.fromSnapshot
           ? callsFromText(authoritativeSource)
           : callsFromRaw(authoritativeSource);
         const repairFromSnapshot = async (): Promise<boolean> => {
           if (externalToolRegistry.length === 0) return false;
           // Reuse the first recovery snapshot (partial timeout snapshots are
           // valid repair evidence when they carry a complete call). Only poll
           // when no recovery attempt has been made.
           let snapshot = polledForToolCalls ?? recoverySnapshot;
           if (!snapshot) {
             if (recoveryPromise) return false;
             try {
               snapshot = await recoverSnapshot();
             } catch {
               return false;
             }
           }
           if (!snapshot || snapshot.error != null) return false;
           const repairedSource: AuthoritativeStreamSource = {
             content: String(snapshot.content ?? ''),
             reasoning: String(snapshot.reasoning ?? ''),
             kind: 'polled-snapshot',
             fromSnapshot: true,
           };
           const snapshotCalls = parseJoined(repairedSource.reasoning, repairedSource.content);
           if (snapshotCalls.length === 0) return false;
           try {
             assertToolCallArtifactIntegrity(snapshotCalls, externalToolRegistry, [
               [repairedSource.reasoning, repairedSource.content],
             ]);
           } catch {
             return false;
           }
           polledForToolCalls = snapshot;
           authoritativeSource = repairedSource;
           parsedToolCalls = snapshotCalls;
           if (shouldBufferExternalStream) {
             const visible = stripExternalToolCallMarkupFromJoinedText(
               externalToolRegistry,
               authoritativeSource.reasoning,
               authoritativeSource.content,
             );
             reasoning = visible.reasoning;
             content = visible.content;
           }
           return true;
         };
         let validatedStreamedToolCalls: FinalToolCall[];
         try {
           try {
             assertToolCallArtifactIntegrity(parsedToolCalls, externalToolRegistry, streamSource());
           } catch (integrityError) {
             if (!isMalformedExternalToolCallError(integrityError) || !(await repairFromSnapshot())) {
               throw integrityError;
             }
            }
            if (parsedToolCalls.length === 0 && externalToolChoice.mode === 'required' && !idempotency?.reconciling) {
               const forcedResponse = await requestForcedResponsesToolCall();
               if (forcedResponse) {
                 confirmForcedResponsesToolCall(forcedResponse);
                 currentAssistantMessageId =
                   typeof forcedResponse['assistantMessageId'] === 'string'
                     ? (forcedResponse['assistantMessageId'] as string)
                     : currentAssistantMessageId;
                 if (forcedResponse['error'] != null) throw normalizeBackendError(forcedResponse['error']);
                const forcedReasoning = typeof forcedResponse['reasoning'] === 'string' ? forcedResponse['reasoning'] as string : '';
                const forcedContent = typeof forcedResponse['content'] === 'string' ? forcedResponse['content'] as string : '';
                parsedToolCalls = mergeToolCallArtifacts(parsedToolCalls, parseJoined(forcedReasoning, forcedContent));
               authoritativeSource = {
                 content: `${authoritativeSource.content}${forcedContent}`,
                 reasoning: `${authoritativeSource.reasoning}${forcedReasoning}`,
                 kind: authoritativeSource.kind,
                 fromSnapshot: authoritativeSource.fromSnapshot,
               };
               assertToolCallArtifactIntegrity(parsedToolCalls, externalToolRegistry, streamSource());
             }
           }
           validatedStreamedToolCalls = finalizeStreamToolCalls(
             parsedToolCalls,
             externalToolRegistry,
             externalToolChoice,
             streamSource(),
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
              await cleanupOwnedResponsesSession();
              stopResponsesKeepalive();
              const toolMessage = toErrorMessage(toolError);
              const serverError = { message: toolMessage, type: 'server_error', code: toolCode };
              if (responsesStreamState) {
                try {
                  const streamState = responsesStreamState;
                  if (!streamState.createdEmitted) streamState.emitCreated();
                  if (streamState.finalize) {
                    try {
                      streamState.finalize();
                    } catch (finalizeError: unknown) {
                      logDebug('Failed to finalize errored response stream', { error: toErrorMessage(finalizeError) });
                    }
                  }
                  streamState.emit({
                    type: 'response.failed',
                    sequence_number: streamState.nextSequence(),
                    response: {
                      ...buildResponsesResponseEnvelope(streamState),
                      completed_at: null,
                      status: 'failed',
                      output: streamState.output.output(),
                      error: serverError,
                      incomplete_details: null,
                      usage: null,
                    },
                  });
                  res.write('data: [DONE]\n\n');
                } catch (writeError: unknown) {
                  logDebug('Failed to report error on open response stream', { error: toErrorMessage(writeError) });
                }
                res.end();
              } else if (!res.headersSent) {
                res.status(502).json({ error: serverError });
              }
              return;
            }
            throw toolError;
          }
         const joinedSafe = stripExternalToolCallMarkupFromJoinedText(
           externalToolRegistry,
           reasoning,
           content,
           true,
         );
         const safeContent = joinedSafe.content;
         const safeReasoning = joinedSafe.reasoning;
           if (!safeContent.trim() && !safeReasoning.trim() && validatedStreamedToolCalls.length === 0) {
             throw new Error('Upstream returned no assistant data');
           }
           assertIdempotencyResultConfirmed();
           const streamEvidence = hostedSearch.requested
            ? extractSearchEvidence(streamSearchToolParts)
            : { queries: [] as string[], sources: [] as { url: string; title: string }[] };
          const streamSearchCallItems = buildWebSearchCallItems(streamEvidence);
          const emitWebSearchCallItem = (item: { id: string; type: string; status: string; action: unknown }): void => {
            const callId = String(item.id);
            if (outputAssembler.has('web_search_call', callId)) return;
            const addedItem = {
              id: callId,
              type: 'web_search_call',
              status: 'in_progress',
            };
            const entry = outputAssembler.announce(addedItem);
            emit({
              type: 'response.output_item.added',
              sequence_number: nextSeq(),
              output_index: entry.index,
              item: addedItem,
            });
            emit({
              type: 'response.web_search_call.searching',
              sequence_number: nextSeq(),
              output_index: entry.index,
              item_id: callId,
            });
            emit({
              type: 'response.web_search_call.completed',
              sequence_number: nextSeq(),
              output_index: entry.index,
              item_id: callId,
            });
            outputAssembler.complete('web_search_call', callId, { ...item });
          };
          streamSearchCallItems.forEach((item) => emitWebSearchCallItem(item));

          if (deferVisibleOutput) {
            assertIdempotencyResultConfirmed();
            writeVisibleDelta(safeReasoning, true);
            writeVisibleDelta(safeContent, false);
          }

          validatedStreamedToolCalls.forEach((toolCall) => {
            const record = toolCall as unknown as Record<string, unknown>;
            const fn = asRecord(record['function']);
            const emitCall = customToolNames.has(String(fn['name'] ?? ''))
              ? emitResponsesCustomToolCall
              : emitResponsesFunctionCall;
            emitCall({
              id: String(record['id']),
              type: 'function',
              function: { name: fn['name'], arguments: fn['arguments'] },
            } as unknown as FinalToolCall);
          });

          const streamAnnotations = buildCitationAnnotations(safeContent, streamEvidence.sources);
          finalizeOutputItems(safeContent, safeReasoning, streamAnnotations);
          const streamOutput = outputAssembler.output();
          const promptTokens = Math.ceil(fullPromptText.length / 4);
         const completionTokens = Math.ceil(content.length / 4);
         const reasoningTokens = Math.ceil(reasoning.length / 4);
         const completedAt = Math.floor(Date.now() / 1000);
         const response = {
           ...buildResponsesResponseEnvelope(responseState),
           completed_at: completedAt,
           status: 'completed',
           reasoning: safeReasoning ? { effort: reasoningLevel, summary: safeReasoning.substring(0, 100) } : undefined,
           output: streamOutput,
           error: null,
           incomplete_details: null,
           usage: {
             input_tokens: promptTokens,
             output_tokens: completionTokens + reasoningTokens,
             total_tokens: promptTokens + completionTokens + reasoningTokens,
             input_tokens_details: { cached_tokens: 0 },
             output_tokens_details: { reasoning_tokens: reasoningTokens },
           },
         };
           const stateStored = store && currentAssistantMessageId
             ? storeResponseState(
                 responseId,
                 sessionId,
                 `${pID}/${mID}`,
                 buildStoredResponseToolCalls(validatedStreamedToolCalls),
                 currentAssistantMessageId,
                 tenantId,
               )
            : false;
          if (stateStored) {
            if (ownedResponsesSessionId === sessionId) ownedResponsesSessionId = null;
          } else {
            await cleanupOwnedResponsesSession();
          }
           assertIdempotencyResultConfirmed();
           emit({ type: 'response.completed', sequence_number: nextSeq(), response });
          res.write('data: [DONE]\n\n');
         stopResponsesKeepalive();
         res.end();
         return;
      }

      let responseRes: unknown = null;
      let responseParts: unknown[] = [];
      let promptContent = '';
      let promptReasoning = '';
      let promptParsedToolCalls: FinalToolCall[] = [];
      let polledFilled = false;
      let lastResponsesAttemptError: unknown = null;
      let searchToolParts: unknown[] = [];
      const isNonStreamContinuation = Boolean(previousState?.sessionId);
      let promptSubmitted = false;
      let currentAssistantMessageId: string | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (responsesAbortController.signal.aborted || res.writableEnded || res.destroyed) {
          logDebug('Client gone, stop retrying', { sessionId, attempt });
          return;
        }
        if (attempt > 1) {
          if (fallbackToProxy) switchToProxyBundle();
          await ensureActiveModel(activeClient, pID, mID).catch(() => {});
          if (!isNonStreamContinuation && !idempotency?.submitted) {
            promptSubmitted = false;
            const retriedSessionId = sessionId;
            if (retriedSessionId && ownedResponsesSessionId === retriedSessionId) {
              await cleanupOwnedResponsesSession();
              if (ownedResponsesSessionId === retriedSessionId) {
                throw new Error('Failed to cleanup retried OpenCode session');
              }
            }
            const retrySessionRes = (await withTimeout(activeClient.session.create(), REQUEST_TIMEOUT_MS, 'create session')) as unknown;
            sessionId = (asRecord(asRecord(retrySessionRes)['data'])['id'] as string | undefined) ?? null;
            if (!sessionId) throw new Error('Failed to create OpenCode session for retry');
            ownedResponsesSessionId = sessionId;
            promptParams.path.id = sessionId;
          }
          requestForcedResponsesToolCall = makeForcedResponsesToolCallRequester();
          await sleep(computeRetryDelay(attempt - 1, lastResponsesAttemptError));
        }
        let polledResponse: { content: string; reasoning: string; error: unknown; toolParts?: unknown; assistantMessageId?: string; userMessageId?: string; partial?: boolean; complete?: boolean } | null = null;
        try {
          if (idempotency?.reconciling) {
            polledResponse = await activePollForAssistantResponse(
              sessionId as string,
              REQUEST_TIMEOUT_MS,
              undefined,
              responsesAbortController.signal,
              idempotency.userMessageId ?? undefined,
              true,
            );
            if (polledResponse.error != null) {
              if (isExactTerminalPoll(polledResponse)) {
                confirmExactTerminalPoll(polledResponse);
                throw normalizeBackendError(polledResponse.error);
              }
              throw new Error('Idempotency reconciliation has no confirmed assistant result');
            }
            if (
              !isExactTerminalPoll(polledResponse)
            ) {
              throw new Error('Idempotency reconciliation has no confirmed assistant result');
            }
            confirmExactTerminalPoll(polledResponse);
            currentAssistantMessageId = polledResponse.assistantMessageId ?? null;
          } else if ((isNonStreamContinuation || idempotency?.submitted) && promptSubmitted) {
            polledResponse = await activePollForAssistantResponse(
              sessionId as string,
              REQUEST_TIMEOUT_MS,
              undefined,
              responsesAbortController.signal,
              idempotency?.submitted
                ? (idempotency.userMessageId ?? undefined)
                : isNonStreamContinuation ? String(promptParams.body['messageID']) : undefined,
              Boolean(idempotency),
            );
            currentAssistantMessageId = polledResponse.assistantMessageId ?? currentAssistantMessageId;
          } else {
            if (isNonStreamContinuation || idempotency) {
              promptSubmitted = true;
            }
            if (idempotency) {
              idempotency.markSubmitted(
                sessionId as string,
                String(promptParams.body['messageID']),
                `${pID}/${mID}`,
              );
            }
            assertResponsesCanPrompt();
            responseRes = await activePromptWithTimeout(promptParams, REQUEST_TIMEOUT_MS);
            promptSubmitted = true;
            if (idempotency) assertResponsesCanPrompt();
            const promptData = asRecord(asRecord(responseRes)['data']);
            const promptInfo = asRecord(promptData['info']);
            const promptMessageId = promptInfo['id'] ?? promptInfo['messageID'] ?? promptInfo['messageId'];
            if (typeof promptMessageId === 'string' && promptMessageId) currentAssistantMessageId = promptMessageId;
            const dataParts: unknown = promptData['parts'];
            responseParts = Array.isArray(dataParts) ? (dataParts as unknown[]) : [];
            promptContent = responseParts
              .filter((p) => asRecord(p)['type'] === 'text')
              .map((p) => String(asRecord(p)['text'] ?? ''))
              .join('\n');
            promptReasoning = responseParts
              .filter((p) => asRecord(p)['type'] === 'reasoning')
              .map((p) => String(asRecord(p)['text'] ?? ''))
              .join('\n');
            promptParsedToolCalls =
              externalToolRegistry.length > 0
                ? parseExternalToolCallsFromJoinedText(externalToolRegistry, promptReasoning, promptContent)
                : [];
            if (idempotency) {
              const promptTime = asRecord(promptInfo['time']);
              const promptFinish = promptInfo['finish'];
              const hasActiveToolPart = responseParts.some((part) => {
                const partRecord = asRecord(part);
                const state = asRecord(partRecord['state']);
                const status = state['status'] ?? partRecord['status'];
                return partRecord['type'] === 'tool' && (status === 'pending' || status === 'running');
              });
              const finishIsIntermediate = promptFinish === 'tool' || promptFinish === 'tool-calls';
              const explicitTerminal = !finishIsIntermediate &&
                ((promptFinish != null) || Boolean(promptTime['completed']));
              const exactTurn =
                promptInfo['role'] === 'assistant' &&
                promptInfo['parentID'] === idempotency.userMessageId &&
                typeof promptMessageId === 'string' &&
                promptMessageId.length > 0;
              if (promptInfo['error'] != null || !explicitTerminal || !exactTurn || hasActiveToolPart) {
                // Prompt return values may contain a still-growing snapshot.
                // Reconcile only the exact submitted user turn before
                // returning text when the snapshot is incomplete or errored.
                responseParts = [];
                promptContent = '';
                promptReasoning = '';
                promptParsedToolCalls = [];
                polledResponse = await activePollForAssistantResponse(
                  sessionId as string,
                  REQUEST_TIMEOUT_MS,
                  undefined,
                  responsesAbortController.signal,
                  idempotency.userMessageId ?? undefined,
                  true,
                );
                currentAssistantMessageId = polledResponse.assistantMessageId ?? currentAssistantMessageId;
              }
            }
            const needsRequiredToolFollowup = Boolean(
              idempotency?.submitted &&
              externalToolChoice.mode === 'required' &&
              promptParsedToolCalls.length === 0 &&
              (promptContent || promptReasoning),
            );
            if ((promptContent || promptReasoning) && (!idempotency?.submitted || needsRequiredToolFollowup)) break;
            if (!polledResponse) {
              polledResponse = await activePollForAssistantResponse(
                sessionId as string,
                REQUEST_TIMEOUT_MS,
                undefined,
                responsesAbortController.signal,
                  idempotency?.submitted
                    ? (idempotency.userMessageId ?? undefined)
                    : isNonStreamContinuation ? String(promptParams.body['messageID']) : undefined,
                  Boolean(idempotency),
                );
              currentAssistantMessageId = polledResponse.assistantMessageId ?? currentAssistantMessageId;
            }
          }
        } catch (loopError: unknown) {
          if (isNonStreamContinuation || idempotency?.submitted) {
            throw normalizeBackendError(loopError);
          }
          if (attempt < maxAttempts && engageProxyFallback(loopError)) {
            lastResponsesAttemptError = loopError;
            continue;
          }
          if (attempt < maxAttempts && isTransientUpstreamError(loopError)) {
            console.warn(
              `[Proxy] Transient upstream error (attempt ${attempt}/${maxAttempts}), retrying:`,
              readDataMessage(loopError),
            );
            lastResponsesAttemptError = loopError;
            continue;
          }
          throw normalizeBackendError(loopError);
        }
        if (idempotency?.submitted && polledResponse) confirmExactTerminalPoll(polledResponse);
        const polledEmpty = Boolean(
          polledResponse &&
            !polledResponse.content &&
            !polledResponse.reasoning &&
            !(Array.isArray(polledResponse.toolParts) && polledResponse.toolParts.length > 0),
        );
        const polledError =
          polledResponse?.error ??
          (polledResponse?.partial === true
            ? new Error('Polling returned incomplete response')
            : polledEmpty && externalToolChoice.mode !== 'required'
              ? new Error('Polling returned empty response')
              : null);
        if (polledResponse && polledError != null) {
            if (isNonStreamContinuation || idempotency?.submitted) {
              throw normalizeBackendError(polledError);
          }
          if (attempt < maxAttempts && engageProxyFallback(polledError)) {
            lastResponsesAttemptError = polledError;
            continue;
          }
          if (attempt < maxAttempts && isTransientUpstreamError(polledError)) {
            console.warn(
              `[Proxy] Transient upstream error (attempt ${attempt}/${maxAttempts}), retrying:`,
              readDataMessage(polledError),
            );
            lastResponsesAttemptError = polledError;
            continue;
          }
          throw normalizeBackendError(polledError);
        }
        if (polledResponse) {
          content = polledResponse.content || content;
          reasoning = polledResponse.reasoning || reasoning;
          currentAssistantMessageId = polledResponse.assistantMessageId ?? currentAssistantMessageId;
          polledFilled = true;
          if (Array.isArray(polledResponse.toolParts) && polledResponse.toolParts.length > 0) {
            searchToolParts = polledResponse.toolParts;
          }
        }
        break;
      }

      // P4: the loop breaks early once prompt parts carry text, skipping the
      // poll that surfaces server-side tool executions. One capped best-effort
      // read so grounding evidence is not lost when the answer came with the prompt.
      if (hostedSearch.requested && searchToolParts.length === 0 && sessionId) {
        try {
           const evPoll = await activePollForAssistantResponse(
             sessionId as string,
             Math.min(15000, REQUEST_TIMEOUT_MS),
             undefined,
              responsesAbortController.signal,
              idempotency?.submitted
                ? (idempotency.userMessageId ?? undefined)
                : isNonStreamContinuation ? String(promptParams.body['messageID']) : undefined,
              Boolean(idempotency),
            );

          if (Array.isArray(evPoll.toolParts) && evPoll.toolParts.length > 0) {
            searchToolParts = evPoll.toolParts;
          }
        } catch {
          // ignore — citations are best-effort
        }
      }

      if (!polledFilled) {
        content = promptContent;
        reasoning = promptReasoning;
      }

      let promptBasedToolCalls: FinalToolCall[] = promptParsedToolCalls;
      if (polledFilled) {
                    promptBasedToolCalls =
           externalToolRegistry.length > 0
             ? parseExternalToolCallsFromJoinedText(externalToolRegistry, reasoning, content)
             : [];
      }

      if (!content && !reasoning && responseRes && promptBasedToolCalls.length === 0) {
        const data: unknown = asRecord(responseRes)['data'];
        if (typeof data === 'string') content = data;
        else {
          const dr = asRecord(data);
          content = typeof dr['message'] === 'string' ? (dr['message'] as string) : JSON.stringify(data);
        }
      }

       let parsedToolCalls: FinalToolCall[] =
         promptBasedToolCalls.length > 0
           ? promptBasedToolCalls
           : externalToolRegistry.length > 0
             ? parseExternalToolCallsFromJoinedText(externalToolRegistry, reasoning, content)
             : [];
        let validatedToolCalls: FinalToolCall[] = [];
        try {
          assertToolCallArtifactIntegrity(parsedToolCalls, externalToolRegistry, [reasoning, content]);
          if (parsedToolCalls.length === 0 && externalToolChoice.mode === 'required' && !idempotency?.reconciling) {
             const forcedResponse = await requestForcedResponsesToolCall();
             if (forcedResponse) {
               confirmForcedResponsesToolCall(forcedResponse);
               currentAssistantMessageId =
                 typeof forcedResponse['assistantMessageId'] === 'string'
                   ? (forcedResponse['assistantMessageId'] as string)
                   : currentAssistantMessageId;
               if (forcedResponse['error'] != null) throw normalizeBackendError(forcedResponse['error']);
               content = String(forcedResponse['content'] ?? content);
              reasoning = String(forcedResponse['reasoning'] ?? reasoning);
              parsedToolCalls = parseExternalToolCallsFromJoinedText(externalToolRegistry, reasoning, content);
              assertToolCallArtifactIntegrity(parsedToolCalls, externalToolRegistry, [reasoning, content]);
            }
          }
          validatedToolCalls = finalizeStreamToolCalls(
            parsedToolCalls,
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
           await cleanupOwnedResponsesSession();
           res.status(502).json({
             error: {
               message: toErrorMessage(toolError),
               type: 'server_error',
               code: toolCode,
             },
           });
           return;
         }
         throw toolError;
       }
      const joinedSafe = stripExternalToolCallMarkupFromJoinedText(
        externalToolRegistry,
        reasoning,
        content,
        true,
      );
      const safeContent = joinedSafe.content;
      const safeReasoning = joinedSafe.reasoning;

      // P4: server-side grounding evidence → web_search_call items + citations.
      const searchEvidence = hostedSearch.requested
        ? extractSearchEvidence(searchToolParts)
        : { queries: [] as string[], sources: [] as { url: string; title: string }[] };
      const searchCallItems = buildWebSearchCallItems(searchEvidence);
      const citationAnnotations = buildCitationAnnotations(safeContent, searchEvidence.sources);

      const promptTokens = Math.ceil(fullPromptText.length / 4);
      const completionTokens = Math.ceil(content.length / 4);
      const reasoningTokens = Math.ceil(reasoning.length / 4);
      const output: Record<string, unknown>[] = [];
      searchCallItems.forEach((item) => output.push(item as unknown as Record<string, unknown>));
      const messageOutputItem = buildResponsesMessageOutputItem(safeContent, undefined, citationAnnotations);
      if (messageOutputItem) output.push(messageOutputItem);
      validatedToolCalls.forEach((toolCall) => {
        const record = toolCall as unknown as Record<string, unknown>;
        const fn = asRecord(record['function']);
        const callId = String(record['id']);
        const name = String(fn['name'] ?? '');
        if (customToolNames.has(name)) {
          output.push(buildResponsesCustomToolCallItem(callId, name, fn['arguments'], 'completed'));
          return;
        }
        output.push({
          id: callId,
          type: 'function_call',
          status: 'completed',
          call_id: callId,
          name: fn['name'],
          arguments: fn['arguments'],
        });
      });
      const orderedOutput = orderResponsesOutputItems(output);

      const responseId = idempotency?.publicId ?? `resp_${crypto.randomUUID()}`;
      idempotency?.setPublicId(responseId);
      const createdAt = Math.floor(Date.now() / 1000);
      const response = {
        ...buildResponsesResponseEnvelope({
          id: responseId,
          createdAt,
          model: `${pID}/${mID}`,
          tools,
          parallelToolCalls,
        }),
        status: 'completed',
        reasoning: safeReasoning ? { effort: reasoningLevel, summary: safeReasoning.substring(0, 100) } : undefined,
        output: orderedOutput,
        error: null,
        incomplete_details: null,
        usage: {
          input_tokens: promptTokens,
          output_tokens: completionTokens + reasoningTokens,
          total_tokens: promptTokens + completionTokens + reasoningTokens,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: reasoningTokens },
        },
      };

       const stateStored = store && currentAssistantMessageId
         ? storeResponseState(
             responseId,
             sessionId,
             `${pID}/${mID}`,
             buildStoredResponseToolCalls(validatedToolCalls),
             currentAssistantMessageId,
             tenantId,
           )
        : false;
      if (stateStored) {
        if (ownedResponsesSessionId === sessionId) ownedResponsesSessionId = null;
      } else {
        await cleanupOwnedResponsesSession();
      }

       assertIdempotencyResultConfirmed();
       res.json(response);
      return;
    } catch (error: unknown) {
      stopResponsesKeepalive();
      console.error('[Proxy] Responses API Error:', toErrorMessage(error));
      const isUnconfirmedStreamingReconciliation =
        idempotency?.reconciling && Boolean(asRecord((req as unknown as { body: unknown }).body)['stream']);
      if (
        idempotency?.submitted &&
        !idempotency.resultConfirmed &&
        !responsesAbortController.signal.aborted &&
        !res.headersSent &&
        !res.destroyed &&
        !isUnconfirmedStreamingReconciliation
      ) {
        res.removeHeader('Content-Type');
        res.status(503).json({
          error: {
            type: 'idempotency_error',
            code: 'idempotency_reconciliation_pending',
            message: 'The previous outcome is still uncertain; retry the same request to reconcile it',
            retryable: true,
          },
        });
        return;
      }
      if (!fallbackToProxy) engageProxyFallback(error);
      const transformed = transformUpstreamError(error);
      if (responsesStreamState) {
        try {
          const streamState = responsesStreamState;
          if (!streamState.createdEmitted) streamState.emitCreated();
          if (streamState.finalize) {
            try {
              streamState.finalize();
            } catch (finalizeError: unknown) {
              logDebug('Failed to finalize errored response stream', { error: toErrorMessage(finalizeError) });
            }
          }
          const failedPayload = {
            type: 'response.failed',
            sequence_number: streamState.nextSequence(),
            response: {
              ...buildResponsesResponseEnvelope(streamState),
              completed_at: null,
              status: 'failed',
              output: streamState.output.output(),
              error: transformed.error,
              incomplete_details: null,
              usage: null,
            },
          };
          streamState.emit(failedPayload);
          res.write('data: [DONE]\n\n');
        } catch (writeError: unknown) {
          logDebug('Failed to report error on open response stream', { error: toErrorMessage(writeError) });
        }
        if (!res.writableEnded && !res.destroyed) {
          res.end();
        }
        return;
      }
      if (!res.headersSent) {
        res.status(transformed.statusCode).json(transformed.error);
        return;
      }
      if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
      return;
    } finally {
      stopResponsesKeepalive();
      await cleanupOwnedResponsesSession();
    }
  });
}
