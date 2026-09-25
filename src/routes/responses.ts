// P4 TS: POST /v1/responses (ported from P3 .js, behavior identical).
import crypto from 'crypto';
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
import {
  assertToolCallArtifactIntegrity,
  createDuplicateToolCallIdError,
  stripExternalToolCallMarkupFromJoinedText,
  parseExternalToolCallsFromJoinedText,
  mergeToolCallArtifacts,
  createToolCallFilter,
  createExternalToolCallStreamParser,
} from '../tool-runtime/parser.js';
import { isTransientUpstreamError, normalizeBackendError, transformUpstreamError, createInvalidRequestError } from '../errors/upstream.js';
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
import { asRecord, toErrorMessage } from '../utils/guards.js';

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
     let responsesKeepalive: ReturnType<typeof setInterval> | null = null;
     let responsesResClosed: Promise<boolean> | null = null;
     const responsesAbortController = new AbortController();

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
    let ownedResponsesSessionId: string | null = null;
    let responsesStreamState: ResponsesStreamState | null = null;
    const cleanupOwnedResponsesSession = async (): Promise<void> => {
      const ownedSessionId = ownedResponsesSessionId;
      ownedResponsesSessionId = null;
      if (!ownedSessionId) return;
      try {
        await activeClient.session.delete({ path: { id: ownedSessionId } });
      } catch (error: unknown) {
        logDebug('Failed to cleanup owned responses session', { sessionId: ownedSessionId, error: toErrorMessage(error) });
      }
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
        id: `resp_${crypto.randomUUID()}`,
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
        state.emitCreated();
      };
      responsesStreamState = state;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const flushHeaders = (res as unknown as { flushHeaders?: unknown }).flushHeaders;
      if (typeof flushHeaders === 'function') (flushHeaders as () => void).call(res);
      responsesKeepalive = setInterval(() => {
        if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n');
      }, 15000);
      responsesResClosed = new Promise<boolean>((resolve) =>
        res.once('close', () => {
          if (!res.writableEnded) {
            responsesAbortController.abort();
            resolve(true);
          }
        }),
      );
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

      const previousState =
        typeof previousResponseId === 'string' && previousResponseId ? getResponseState(previousResponseId) : null;
      if (stream) responsesStreamState = initializeResponsesStream(model, previousState?.model, tools, parallelToolCalls);
      if (previousResponseId && !previousState) {
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

      if (!messages.length) {
        rejectInvalidRequest('input is required', 'input_required');
        return;
      }

      const resolvedModel = (await withTimeout(
        resolveRequestedModel(model ?? previousState?.model),
        REQUEST_TIMEOUT_MS,
        'resolve model',
      )) as unknown as { providerID: string; modelID: string };
      const pID = String(asRecord(resolvedModel)['providerID']);
      const mID = String(asRecord(resolvedModel)['modelID']);
      if (responsesStreamState) responsesStreamState.adoptResolvedModel(`${pID}/${mID}`);

      await ensureBackend(config);

      try {
        await activeClient.config.update({
          body: { activeModel: { providerID: pID, modelID: mID } },
        });
      } catch {
        // ignore
      }

      let sessionId: string | null = previousState?.sessionId || null;
      if (!sessionId) {
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
        }
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
        });
      let requestForcedResponsesToolCall = makeForcedResponsesToolCallRequester();

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
        const shouldBufferExternalStream = externalToolRegistry.length > 0;
        const deferVisibleOutput = shouldBufferExternalStream || hostedSearch.requested;
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
          } else if (filtered.trim()) {
            const entry = ensureOutputScaffold();
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
         const unsentSuffix = (full: unknown, raw: string): string => {
           const text = typeof full === 'string' ? full : '';
           if (!text) return '';
           if (!raw) return text;
           return text.startsWith(raw) ? text.slice(raw.length) : text;
         };

        let collected: Record<string, unknown> | null = null;
        try {
          if (fallbackToProxy) {
            // SSE subscribe ignores custom fetch (SDK gap): prompt through the
            // proxy bundle; the poll below (line ~614) fills content/reasoning.
            await activePromptWithTimeout(promptParams, REQUEST_TIMEOUT_MS);
          } else {
            const collectPromise = collectFromEvents(
              sessionId as string,
              REQUEST_TIMEOUT_MS,
              sendResponsesDelta,
               DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS,
               DEFAULT_EVENT_IDLE_TIMEOUT_MS,
               responsesAbortController.signal,
             );

             const safeCollect = collectPromise.catch((err: unknown) => ({ __error: err }));
             activeClient.session.prompt(promptParams).catch((err: unknown) => logDebug('Responses prompt error:', toErrorMessage(err)));
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

          const collectedR = asRecord(collected);
          if (responsesAbortController.signal.aborted || collectedR['cancelled']) {
            stopResponsesKeepalive();
            return;
          }
          if (collectedR['error'] != null) {

           throw normalizeBackendError(collectedR['error']);
         }
        let streamSearchToolParts: unknown[] = [];
        const keepStreamToolParts = (polled: { toolParts?: unknown }): void => {
          if (hostedSearch.requested && Array.isArray(polled.toolParts) && polled.toolParts.length > 0) {
            streamSearchToolParts = polled.toolParts;
          }
        };
         let recoverySnapshot: { content: string; reasoning: string; error: unknown; toolParts?: unknown } | null = null;
         let recoveryPromise: Promise<{ content: string; reasoning: string; error: unknown; toolParts?: unknown }> | null = null;
         const pollRecoverySnapshot = (): Promise<{ content: string; reasoning: string; error: unknown; toolParts?: unknown }> => {
           if (!recoveryPromise) {
             recoveryPromise = activePollForAssistantResponse(
               sessionId as string,
               REQUEST_TIMEOUT_MS,
               undefined,
               responsesAbortController.signal,
             );
           }
           return recoveryPromise;
         };
         const hasPartialOutput = (): boolean => Boolean(
           rawContent || rawReasoning || streamedToolCalls.length > 0 || content || reasoning,
         );
         const hasValidTerminal = Boolean(
           collected &&
           !collectedR['__error'] &&
           !collectedR['noData'] &&
           !collectedR['idleTimeout'] &&
           !collectedR['cancelled'] &&
           (rawContent || rawReasoning || streamedToolCalls.length > 0 || content || reasoning),
         );
         const recoverSnapshot = async (
           fallbackError: unknown = null,
         ): Promise<{ content: string; reasoning: string; error: unknown; toolParts?: unknown } | null> => {
           if (responsesAbortController.signal.aborted) return null;
           let polled: { content: string; reasoning: string; error: unknown; toolParts?: unknown };
           try {
             polled = await pollRecoverySnapshot();
           } catch (error: unknown) {
             if (responsesAbortController.signal.aborted) return null;
             if (hasPartialOutput()) {
               logDebug('Ignoring responses recovery poll failure after partial stream output', { error: toErrorMessage(error) });
               return null;
             }
             if (fallbackError != null) throw normalizeBackendError(fallbackError);
             throw normalizeBackendError(error);
           }
           if (polled.error != null) throw normalizeBackendError(polled.error);
           if (
             fallbackError != null &&
             !polled.content &&
             !polled.reasoning &&
             !(Array.isArray(polled.toolParts) && polled.toolParts.length > 0)
           ) throw normalizeBackendError(fallbackError);
           recoverySnapshot = polled;
           return polled;
         };
         const needsRecovery = Boolean(
           collectedR['__error'] || collectedR['noData'] || collectedR['idleTimeout'] || !hasValidTerminal,
         );
         if (needsRecovery) {
           if (collectedR['__error'] && !fallbackToProxy) engageProxyFallback(collectedR['__error']);
           const polled = await recoverSnapshot(collectedR['__error']);
           if (polled) {
             keepStreamToolParts(polled);
             const remainingReasoning = unsentSuffix(polled.reasoning, rawReasoning);
             const remainingContent = unsentSuffix(polled.content, rawContent);
             if (remainingReasoning) sendResponsesDelta(remainingReasoning, true);
             if (remainingContent) sendResponsesDelta(remainingContent, false);
           }
         } else if (collected && ((collectedR['content'] as string) || (collectedR['reasoning'] as string))) {
           const remainingReasoning = unsentSuffix(collectedR['reasoning'], rawReasoning);
           const remainingContent = unsentSuffix(collectedR['content'], rawContent);
           if (remainingReasoning) sendResponsesDelta(remainingReasoning, true);
           if (remainingContent) sendResponsesDelta(remainingContent, false);
         }

         if (hostedSearch.requested && streamSearchToolParts.length === 0) {
           try {
             const evPoll = await activePollForAssistantResponse(
               sessionId as string,
               Math.min(15000, REQUEST_TIMEOUT_MS),
               undefined,
               responsesAbortController.signal,
             );
             if (Array.isArray(evPoll.toolParts)) streamSearchToolParts = evPoll.toolParts;
           } catch {
           }
         }

         if (responsesAbortController.signal.aborted) return;

         let polledForToolCalls: { content: string; reasoning: string; error: unknown; toolParts?: unknown } | null = null;
         if (externalToolRegistry.length > 0 && !hasValidTerminal && !recoveryPromise) {
           const polled = await recoverSnapshot();
           if (polled) {
             polledForToolCalls = polled;
             if (shouldBufferExternalStream) {
               const remainingReasoning = unsentSuffix(polled.reasoning, rawReasoning);
               const remainingContent = unsentSuffix(polled.content, rawContent);
               if (remainingReasoning) sendResponsesDelta(remainingReasoning, true);
               if (remainingContent) sendResponsesDelta(remainingContent, false);
             }
           }
         }


         const flushedReasoningCalls = parseReasoningToolCalls.flush ? parseReasoningToolCalls.flush() : [];
         const flushedContentCalls = parseContentToolCalls.flush ? parseContentToolCalls.flush() : [];
         const flushedReasoningText = filterReasoningDelta.flush ? filterReasoningDelta.flush() : '';
         const flushedContentText = filterContentDelta.flush ? filterContentDelta.flush() : '';
         appendVisibleDelta(flushedReasoningText, true);
         appendVisibleDelta(flushedContentText, false);
         if (shouldBufferExternalStream) {
           const visible = stripExternalToolCallMarkupFromJoinedText(
             externalToolRegistry,
             rawReasoning,
             rawContent,
           );
           reasoning = visible.reasoning;
           content = visible.content;
         } else if (!deferVisibleOutput) {
           writeVisibleDelta(flushedReasoningText, true);
           writeVisibleDelta(flushedContentText, false);
         }

          const recoveryForParse = recoverySnapshot as { content: string; reasoning: string; error: unknown; toolParts?: unknown } | null;
          const snapshotReasoning = polledForToolCalls?.reasoning ?? recoveryForParse?.reasoning ?? (typeof collectedR['reasoning'] === 'string' ? collectedR['reasoning'] as string : rawReasoning);
          const snapshotContent = polledForToolCalls?.content ?? recoveryForParse?.content ?? (typeof collectedR['content'] === 'string' ? collectedR['content'] as string : rawContent);

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
           const forcedResponse = await requestForcedResponsesToolCall();
           if (forcedResponse) {
             const forcedReasoning = typeof forcedResponse['reasoning'] === 'string' ? forcedResponse['reasoning'] as string : '';
             const forcedContent = typeof forcedResponse['content'] === 'string' ? forcedResponse['content'] as string : '';
             parsedToolCalls = mergeToolCallArtifacts(parsedToolCalls, parseJoined(forcedReasoning, forcedContent));
             assertToolCallArtifactIntegrity(parsedToolCalls, externalToolRegistry, [forcedReasoning, forcedContent]);
           }
         }
         const validatedStreamedToolCalls = finalizeStreamToolCalls(
           parsedToolCalls,
           externalToolRegistry,
           externalToolChoice,
           streamSource,
         );
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
         emit({ type: 'response.completed', sequence_number: nextSeq(), response });
         res.write('data: [DONE]\n\n');
         storeResponseState(responseId, sessionId, `${pID}/${mID}`, buildStoredResponseToolCalls(validatedStreamedToolCalls));
         if (ownedResponsesSessionId === sessionId) ownedResponsesSessionId = null;
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
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (res.writableEnded || res.destroyed) {
          logDebug('Client gone, stop retrying', { sessionId, attempt });
          return;
        }
        if (attempt > 1) {
          const retriedSessionId = sessionId;
          if (ownedResponsesSessionId === retriedSessionId) ownedResponsesSessionId = null;
          // A `previous_response_id` parent session is shared with earlier turns; only
          // a session this request created may be discarded on retry.
          if (retriedSessionId && retriedSessionId !== previousState?.sessionId) {
            try {
              await activeClient.session.delete({ path: { id: retriedSessionId } });
            } catch (e: unknown) {
              logDebug('Failed to delete retried session', { sessionId, error: toErrorMessage(e) });
            }
          }
          const retrySessionRes = (await withTimeout(activeClient.session.create(), REQUEST_TIMEOUT_MS, 'create session')) as unknown;
          sessionId = (asRecord(asRecord(retrySessionRes)['data'])['id'] as string | undefined) ?? null;
          if (!sessionId) throw new Error('Failed to create OpenCode session for retry');
          ownedResponsesSessionId = sessionId;
          promptParams.path.id = sessionId;
          requestForcedResponsesToolCall = makeForcedResponsesToolCallRequester();
          await sleep(computeRetryDelay(attempt - 1, lastResponsesAttemptError));
        }
        let polledResponse: { content: string; reasoning: string; error: unknown; toolParts?: unknown } | null = null;
        try {
          responseRes = await activePromptWithTimeout(promptParams, REQUEST_TIMEOUT_MS);
          const dataParts: unknown = asRecord(asRecord(responseRes)['data'])['parts'];
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
          if (promptContent || promptReasoning) break;
           polledResponse = await activePollForAssistantResponse(
             sessionId as string,
             REQUEST_TIMEOUT_MS,
             undefined,
             responsesAbortController.signal,
           );

        } catch (loopError: unknown) {
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
                  if (polledResponse && polledResponse.error != null) {
          if (attempt < maxAttempts && engageProxyFallback(polledResponse.error)) {
            lastResponsesAttemptError = polledResponse.error;
            continue;
          }
          if (attempt < maxAttempts && isTransientUpstreamError(polledResponse.error)) {
            console.warn(
              `[Proxy] Transient upstream error (attempt ${attempt}/${maxAttempts}), retrying:`,
              readDataMessage(polledResponse.error),
            );
            lastResponsesAttemptError = polledResponse.error;
            continue;
          }
          throw normalizeBackendError(polledResponse.error);
        }
        if (polledResponse) {
          content = polledResponse.content || content;
          reasoning = polledResponse.reasoning || reasoning;
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
       assertToolCallArtifactIntegrity(parsedToolCalls, externalToolRegistry, [reasoning, content]);
      if (parsedToolCalls.length === 0 && externalToolChoice.mode === 'required') {
        const forcedResponse = await requestForcedResponsesToolCall();
        if (forcedResponse) {
          content = String(forcedResponse['content'] ?? content);
          reasoning = String(forcedResponse['reasoning'] ?? reasoning);
          parsedToolCalls = parseExternalToolCallsFromJoinedText(externalToolRegistry, reasoning, content);
          assertToolCallArtifactIntegrity(parsedToolCalls, externalToolRegistry, [reasoning, content]);
        }
      }
      const { validCalls: validatedToolCalls } = finalizeValidatedToolCalls(parsedToolCalls, externalToolRegistry);
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

      const responseId = `resp_${crypto.randomUUID()}`;
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

      storeResponseState(responseId, sessionId, `${pID}/${mID}`, buildStoredResponseToolCalls(validatedToolCalls));
      if (ownedResponsesSessionId === sessionId) ownedResponsesSessionId = null;

      res.json(response);
      return;
    } catch (error: unknown) {
      stopResponsesKeepalive();
      console.error('[Proxy] Responses API Error:', toErrorMessage(error));
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
        res.end();
        return;
      }
      res.status(transformed.statusCode).json(transformed.error);
      return;
    } finally {
      await cleanupOwnedResponsesSession();
    }
  });
}
