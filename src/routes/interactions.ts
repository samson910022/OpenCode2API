// P5: Gemini Interactions-compatible thin layer over opencode sessions.
//
// Maps a minimal Interactions subset onto the same backend primitives the
// other routes use (resolveRequestedModel / prompt+poll / websearch grant):
//   POST /v1beta/interactions  (alias: POST /v1/interactions)
//   { model|agent, input, system_instruction, tools:[{type:google_search}],
//     previous_interaction_id, stream, store }
//
// Scope notes (thin by design):
// - Text I/O + google_search grounding only. Client-executed function tools
//   are rejected (400) — use /v1/responses for the external-tool bridge.
// - Bounded retry for free-limit errors only (engage proxy pool + rotate the
//   session, capped by maxAttempts like the other routes); ordinary errors
//   throw immediately with no generic transient backoff.
// - `store:false` skips persistence and deletes the session after responding.
import crypto from 'crypto';
import { makeId } from '../converters/json.js';
import { withTimeout } from '../config/proxy-config.js';
import { computeRetryDelay } from '../retry/policy.js';
import { ensureActiveModel } from '../backend/active-model.js';
import { isTransientUpstreamError, normalizeBackendError, transformUpstreamError } from '../errors/upstream.js';
import { engageFallbackForFreeLimit } from '../upstream-proxy/fallback.js';
import {
  buildCitationAnnotations,
  buildWebSearchCallItems,
  detectHostedSearchTools,
  extractSearchEvidence,
  SEARCH_GROUNDING_INSTRUCTION,
} from '../search/grounding.js';
import { ensureBackend, sleep } from '../backend/manager.js';
import type { Application, Request, Response } from 'express';
import type { AppContext } from '../types/context.js';
import { asRecord, toErrorMessage } from '../utils/guards.js';
import { getContinuationTenantId, getIdempotencyControl } from '../idempotency/middleware.js';

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as unknown[])
      .map((part) => {
        if (typeof part === 'string') return part;
        const pr = asRecord(part);
        if (typeof pr['text'] === 'string') return pr['text'] as string;
        return '';
      })
      .join('');
  }
  return '';
}

/** Minimal input mapping: string | chat-like messages | text parts. */
function normalizeInteractionsInput(input: unknown): Array<{ role: string; content: string }> {
  if (typeof input === 'string') {
    return input.trim() ? [{ role: 'user', content: input }] : [];
  }
  if (!Array.isArray(input)) return [];
  const out: Array<{ role: string; content: string }> = [];
  for (const item of input as unknown[]) {
    if (typeof item === 'string') {
      if (item.trim()) out.push({ role: 'user', content: item });
      continue;
    }
    const rec = asRecord(item);
    if (typeof rec['role'] === 'string') {
      const text = textOfContent(rec['content'] ?? rec['text']);
      if (text) out.push({ role: String(rec['role']), content: text });
      continue;
    }
    const type = typeof rec['type'] === 'string' ? String(rec['type']) : '';
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      const text = textOfContent(rec['text'] ?? rec['content']);
      if (text) out.push({ role: 'user', content: text });
    }
    // user_input/model_output/thought/function_* steps: text-carrying shapes
    // land above via role/content; anything else is ignored (logged by caller).
  }
  return out;
}

function normalizeSystemInstruction(value: unknown): string {
  if (typeof value === 'string') return value;
  const rec = asRecord(value);
  return textOfContent(rec['parts'] ?? rec['content'] ?? rec['text']);
}

function createAbortError(): Error {
  const error = new Error('Request aborted');
  error.name = 'AbortError';
  return error;
}

async function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw createAbortError();
  let removeAbortListener = (): void => {};
  const abortPromise = new Promise<never>((_, reject) => {
    const onAbort = (): void => reject(createAbortError());
    removeAbortListener = (): void => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, abortPromise]);
  } catch (error: unknown) {
    if (signal.aborted) throw createAbortError();
    throw error;
  } finally {
    removeAbortListener();
  }
}

export function registerInteractionsRoutes(app: Application, ctx: AppContext): void {
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
    stripFunctionCalls,
    createRequestToolContext,
    getToolOverridesForMode,
    trackToolMode,
    TOOL_MODE,
    promptWithTimeout,
    pollForAssistantResponse,
    proxyPool,
    proxyClient,
    proxyPromptWithTimeout,
    proxyPollForAssistantResponse,
  } = ctx;

   const handle = async (req: Request, res: Response): Promise<void> => {
     const idempotency = getIdempotencyControl(req);
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
     const requestAbortController = new AbortController();
     let clientGone = false;
     let interactionCreated = false;
      const ownedSessionIds = new Set<string>();
     // P3 bundle (direct unless the pool is already engaged).

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
      const deleteOwnedSession = async (id: string): Promise<void> => {
        if (!ownedSessionIds.has(id)) return;
        const maxDeleteAttempts = 2;
        for (let attempt = 1; attempt <= maxDeleteAttempts; attempt += 1) {
          try {
            await activeClient.session.delete({ path: { id } });
            ownedSessionIds.delete(id);
            return;
          } catch (e: unknown) {
            logDebug('Failed to delete owned interaction session', {
              sessionId: id,
              attempt,
              error: toErrorMessage(e),
            });
            if (attempt === maxDeleteAttempts || !isTransientUpstreamError(e)) return;
          }
        }
      };
     const cleanupOwnedSessionsNow = async (exceptId?: string): Promise<void> => {
       for (const id of [...ownedSessionIds]) {
         if (id !== exceptId) await deleteOwnedSession(id);
       }
     };
     const cleanupOwnedSessions = async (exceptId?: string): Promise<void> => {
       if (!idempotency?.submitted) {
         await cleanupOwnedSessionsNow(exceptId);
         return;
       }
       // Keep a possibly submitted child available for unknown-outcome
       // reconciliation. Delete it only after a complete response is cached.
       const retainedChild = idempotency.childSessionId;
       for (const id of [...ownedSessionIds]) {
         if (id !== exceptId && id !== retainedChild) await deleteOwnedSession(id);
       }
       idempotency.onCompleted(() => cleanupOwnedSessionsNow(exceptId));
     };
    const engageProxyFallback = (err: unknown): boolean => {
      if (!engageFallbackForFreeLimit(err, proxyPool)) return false;
      return switchToProxyBundle();
    };
    if (proxyPool.isEngaged()) switchToProxyBundle();
    const onClientClose = (): void => {
      if (res.writableEnded) return;
      clientGone = true;
      requestAbortController.abort();
    };
    res.once('close', onClientClose);
    try {
      const body = asRecord((req as unknown as { body: unknown }).body);
      const model: unknown = body['model'];
      const agent: unknown = body['agent'];
      const input: unknown = body['input'];
      const systemInstruction: unknown = body['system_instruction'];
      const toolsRaw: unknown = body['tools'];
      const tools: unknown[] = Array.isArray(toolsRaw) ? (toolsRaw as unknown[]) : [];
      const stream = body['stream'] === true;
      const store = body['store'] !== false;

      const previousInteractionId: unknown = body['previous_interaction_id'];

      if (!model && !agent) {
        res.status(400).json({ error: { message: 'model or agent is required', type: 'invalid_request_error' } });
        return;
      }
      if (!model && agent) {
        logDebug('Interactions agent-only request; falling back to default model resolution', { agent });
      }
      const messages = normalizeInteractionsInput(input);
      if (messages.length === 0) {
        res.status(400).json({ error: { message: 'input is required', type: 'invalid_request_error' } });
        return;
      }
      const unsupported = (tools as unknown[]).filter((def) => {
        const t = typeof asRecord(def)['type'] === 'string' ? String(asRecord(def)['type']).toLowerCase() : '';
        return t !== 'google_search' && t !== 'web_search' && t !== 'web_search_preview';
      });
      if (unsupported.length > 0) {
        res.status(400).json({
          error: {
            message: 'unsupported tools: only google_search (web_search) grounding is available on this endpoint',
            type: 'invalid_request_error',
          },
        });
        return;
      }
      const hostedSearch = detectHostedSearchTools(
        (tools as unknown[]).map((def) => {
          const t = typeof asRecord(def)['type'] === 'string' ? String(asRecord(def)['type']).toLowerCase() : '';
          return t === 'google_search' ? { type: 'web_search' } : def;
        }),
      );

       const tenantId = getContinuationTenantId(req);
       const previousState =
        typeof previousInteractionId === 'string' && previousInteractionId
          ? getResponseState(previousInteractionId, tenantId)
          : null;
       if (!idempotency?.reconciling && previousInteractionId && (!previousState || !previousState.checkpointId)) {
         res.status(400).json({ error: { message: 'Invalid or expired previous_interaction_id', type: 'invalid_request_error', code: 'invalid_previous_interaction_id' } });
        return;
      }

      const resolvedModel = (await withTimeout(
         resolveRequestedModel(typeof model === 'string' && model ? model : (idempotency?.model ?? previousState?.model ?? '')),
        REQUEST_TIMEOUT_MS,
        'resolve model',
      )) as unknown as { providerID: string; modelID: string };
      const pID = String(asRecord(resolvedModel)['providerID']);
      const mID = String(asRecord(resolvedModel)['modelID']);
      idempotency?.setModel(`${pID}/${mID}`);

      await ensureBackend(config);

      try {
        await ensureActiveModel(activeClient, pID, mID);
      } catch {
        // ignore
      }

      // Text-only turn: no function tools, so the bridge never engages.
      const requestToolContext = createRequestToolContext([], undefined, undefined);
      let toolMode: string = requestToolContext.mode;
      let internalToolContext = requestToolContext.internal;
      if (hostedSearch.requested) {
        toolMode = TOOL_MODE.INTERNAL_ALLOWLIST;
        internalToolContext = {
          ...internalToolContext,
          allowedToolNames: [...new Set([...internalToolContext.allowedToolNames, 'websearch'])],
          resolutionPath: 'hosted-search-grant',
          resultingMode: toolMode,
        };
      }
      // P1-P4 parity: internal-tool traffic stays observable.
      trackToolMode(toolMode, {
        route: stream ? '/v1beta/interactions(stream)' : '/v1beta/interactions',
      });

      const systemText = normalizeSystemInstruction(systemInstruction);

      const baseToolOverrides = (await withTimeout(
        getToolOverridesForMode(toolMode, internalToolContext),
        REQUEST_TIMEOUT_MS,
        'load tool overrides',
      )) as Record<string, boolean> | null;
      let toolOverrides = baseToolOverrides;
      if (hostedSearch.requested) {
        const searchOverrides = (await withTimeout(
          getToolOverridesForMode(TOOL_MODE.INTERNAL_ALLOWLIST, { allowedToolNames: ['websearch'] }),
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
      // Fail-closed by design (see chat.ts): null or verified-empty both 503.
      if (DISABLE_TOOLS && (!toolOverrides || Object.keys(toolOverrides).length === 0)) {
        res.status(503).json({
          error: {
            message: 'Tool discovery unavailable; backend tool IDs could not be verified',
            type: 'tool_discovery_unavailable',
            code: 'tool_discovery_unavailable',
          },
        });
        return;
      }

       let sessionId: string | null = idempotency?.reconciling ? idempotency.childSessionId : null;
      // Both new sessions and continuation forks belong to this request until
      // response state storage succeeds; the stored parent is never mutated.
        if (idempotency?.reconciling) {
          // Unknown retries reuse the exact recorded child and never fork again.
          if (!sessionId) throw new Error('Idempotency reconciliation is missing its child session');
          ownedSessionIds.add(sessionId);
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
        ownedSessionIds.add(sessionId);
      } else {
        const sessionRes = (await withTimeout(
          activeClient.session.create(),
          REQUEST_TIMEOUT_MS,
          'create session',
        )) as unknown;
        sessionId = (asRecord(asRecord(sessionRes)['data'])['id'] as string | undefined) ?? null;
        if (!sessionId) throw new Error('Failed to create OpenCode session');
        ownedSessionIds.add(sessionId);
      }

      const parts: Record<string, unknown>[] = [];
      const systemTexts: string[] = [];
      let fullPromptText = '';
      for (const msg of messages) {
        if (msg.role === 'system') {
          systemTexts.push(msg.content);
          continue;
        }
        const text = msg.role === 'user' ? msg.content : `${msg.role.toUpperCase()}: ${msg.content}`;
        parts.push({ type: 'text', text });
        fullPromptText += `${text}\n\n`;
      }
      const systemWithGuard = buildSystemPrompt(
        [systemText, ...systemTexts].filter(Boolean).join('\n\n'),
        hostedSearch.requested ? SEARCH_GROUNDING_INSTRUCTION : '',
        null,
        toolMode,
        internalToolContext.allowedToolNames,
      );
      const promptParams: { path: { id: string }; body: Record<string, unknown> } = {
        path: { id: sessionId as string },
        body: {
          model: { providerID: pID, modelID: mID },
          ...(systemWithGuard ? { system: systemWithGuard } : {}),
          parts,
        },
      };
       promptParams.body.messageID = idempotency?.reconciling
         ? idempotency.userMessageId
         : makeId('msg_');
       if (typeof promptParams.body.messageID !== 'string' || !promptParams.body.messageID) {
         throw new Error('Idempotency reconciliation is missing its user message ID');
       }
      // Stage-5: strip false entries for free-tier suspects (any false gates; true-only sent, all-false omitted).
      const promptToolOverrides = selectPromptToolOverrides(toolOverrides, pID, mID);
      if (promptToolOverrides) {
        promptParams.body['tools'] = promptToolOverrides;
      }

      // Upstream retry: free-limit errors engage the proxy pool and rotate the
      // session; transient 5xx / rate-limit errors retry with exponential backoff
      // (bounded by maxAttempts like the other routes).
      const parentSessionId = previousState?.sessionId ?? null;
      let promptSubmitted = false;
      const promptAndPoll = async (): Promise<{
        content: string;
        reasoning: string;
         error: unknown;
         toolParts?: unknown;
          assistantMessageId?: string;
          userMessageId?: string;
          partial?: boolean;
         complete?: boolean;
       }> => {
         if (idempotency?.reconciling) {
           const polled = await activePollForAssistantResponse(
             sessionId as string,
             REQUEST_TIMEOUT_MS,
             undefined,
               requestAbortController.signal,
               idempotency.userMessageId ?? undefined,
               true,
             );
             confirmExactTerminalPoll(polled);
             if (polled.error != null) throw normalizeBackendError(polled.error);
            return polled;
         }
        let lastErr: unknown = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          let confirmedTerminalAssistantError = false;
          if (requestAbortController.signal.aborted || res.destroyed || res.writableEnded) {
            throw new Error('Client disconnected');
          }
          if (attempt > 1) {
            if (fallbackToProxy) switchToProxyBundle();
            await ensureActiveModel(activeClient, pID, mID).catch(() => {});
             if (!parentSessionId && !idempotency?.submitted) {
              promptSubmitted = false;
              const currentId = sessionId as string;
              if (currentId) await deleteOwnedSession(currentId);
              const retryRes = (await withTimeout(activeClient.session.create(), REQUEST_TIMEOUT_MS, 'create session')) as unknown;
              sessionId = (asRecord(asRecord(retryRes)['data'])['id'] as string | undefined) ?? null;
              if (!sessionId) throw new Error('Failed to create OpenCode session for retry');
              ownedSessionIds.add(sessionId);
              promptParams.path.id = sessionId;
            }

            await awaitWithAbort(sleep(computeRetryDelay(attempt - 1, lastErr)), requestAbortController.signal);
          }
          try {
             if (!((parentSessionId || idempotency?.submitted) && promptSubmitted)) {
               if (parentSessionId) {
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
               await awaitWithAbort(activePromptWithTimeout(promptParams, REQUEST_TIMEOUT_MS), requestAbortController.signal);
              promptSubmitted = true;
            }
            const polled = await activePollForAssistantResponse(
              sessionId as string,
              REQUEST_TIMEOUT_MS,
              undefined,
              requestAbortController.signal,
                idempotency?.submitted
                  ? (idempotency.userMessageId ?? undefined)
                  : parentSessionId ? String(promptParams.body['messageID']) : undefined,
                Boolean(idempotency),
             );

              if (idempotency?.submitted) confirmExactTerminalPoll(polled);
              if (polled.error != null) {
                if (idempotency?.submitted) confirmedTerminalAssistantError = true;
                throw normalizeBackendError(polled.error);
              }
            if (polled.partial === true) throw new Error('Polling returned incomplete response');
            if (
              !polled.content &&
              !polled.reasoning &&
              !(Array.isArray(polled.toolParts) && polled.toolParts.length > 0)
            ) {
              throw new Error('Polling returned empty response');
            }
             return polled;
          } catch (e: unknown) {
            lastErr = e;
            if (confirmedTerminalAssistantError) throw normalizeBackendError(e);
            if (parentSessionId) {
              throw normalizeBackendError(e);
            }
            if (attempt < maxAttempts && engageProxyFallback(e)) continue;
            if (attempt < maxAttempts && isTransientUpstreamError(e)) {
              console.warn(
                `[Proxy] Transient upstream error in interactions (attempt ${attempt}/${maxAttempts}), retrying:`,
                toErrorMessage(e),
              );
              continue;
            }
            throw normalizeBackendError(e);
          }
        }
        throw normalizeBackendError(lastErr ?? new Error('Upstream provider error'));
      };

       const interactionId = idempotency?.publicId ?? `intr_${crypto.randomUUID()}`;
       idempotency?.setPublicId(interactionId);
       const deleteEphemeralSession = async (force: boolean = false): Promise<void> => {
         // Only sessions created by this request may be deleted; a reused
         // parent session stays alive for its stored continuation chain.
         if (!force && store) return;
         await cleanupOwnedSessions();
      };
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
         res.setHeader('X-Accel-Buffering', 'no');
         const flushHeaders = (res as unknown as { flushHeaders?: unknown }).flushHeaders;
         if (!idempotency?.reconciling && typeof flushHeaders === 'function') (flushHeaders as () => void).call(res);
        // Stream contract: interaction.created → step.delta* → interaction.completed
        // (no [DONE]; errors arrive as {type:'error'} like /v1/messages).
         const heartbeat = setInterval(() => {

           if (!idempotency?.reconciling && !res.destroyed && !res.writableEnded) res.write(': heartbeat\n');
        }, 15000);
        if (typeof heartbeat.unref === 'function') heartbeat.unref();
        const emit = (payload: unknown): void => {
          if (res.destroyed || res.writableEnded) return;
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        };
        try {
          if (!idempotency?.reconciling) {
            emit({ type: 'interaction.created', interaction: { id: interactionId, status: 'in_progress', model: `${pID}/${mID}` } });
            interactionCreated = true;
          }
           const polled = await promptAndPoll();
           assertIdempotencyResultConfirmed();
          if (idempotency?.reconciling) {
            emit({ type: 'interaction.created', interaction: { id: interactionId, status: 'in_progress', model: `${pID}/${mID}` } });
            interactionCreated = true;
          }
         if (clientGone) {
           await deleteEphemeralSession(true);
           return;
         }

        // Parity with chat/responses/messages: strip tool-call markup when
        // DISABLE_TOOLS so a free-tier strip (no false entries in the tools map,
        // see selectPromptToolOverrides) cannot leak call syntax to clients.
        // stripFunctionCalls is a no-op unless DISABLE_TOOLS=true.
         const text = stripFunctionCalls(polled.content || '');
          if (!text.trim()) throw new Error('Interactions response contained no visible text');
           // Chunked deltas keep clients alive on long answers.
          for (let i = 0; i < text.length; i += 500) {
            emit({ type: 'step.delta', interaction_id: interactionId, delta: text.slice(i, i + 500) });
          }
          const evidence = hostedSearch.requested ? extractSearchEvidence(polled.toolParts ?? []) : { queries: [] as string[], sources: [] as { url: string; title: string }[] };
          const searchCalls = buildWebSearchCallItems(evidence);
          const annotations = buildCitationAnnotations(text, evidence.sources);
          const steps: Record<string, unknown>[] = [];
          searchCalls.forEach((item) => {
            steps.push({ type: 'google_search_call', queries: [item.action.query] });
          });
          if (evidence.sources.length > 0) {
            steps.push({
              type: 'google_search_result',
              sources: evidence.sources,
              note: 'surrogate grounding via opencode websearch (exa/parallel), not Google',
            });
          }
          steps.push({ type: 'model_output', text, annotations });
          if (store) {
            const stateStored = polled.assistantMessageId
               ? storeResponseState(interactionId, sessionId as string, `${pID}/${mID}`, [], polled.assistantMessageId, tenantId)
              : false;
            if (stateStored) ownedSessionIds.delete(sessionId as string);
            await cleanupOwnedSessions();
          }
           assertIdempotencyResultConfirmed();
           emit({ type: 'interaction.completed', interaction: { id: interactionId, status: 'completed', output_text: text, steps } });
          await deleteEphemeralSession();

        } finally {
          clearInterval(heartbeat);
        }
        res.end();
        return;
      }

       const polled = await promptAndPoll();
       assertIdempotencyResultConfirmed();
      // Same parity strip as the stream path above.
      const text = stripFunctionCalls(polled.content || '');
      if (!text.trim()) throw new Error('Interactions response contained no visible text');
      const evidence = hostedSearch.requested ? extractSearchEvidence(polled.toolParts ?? []) : { queries: [] as string[], sources: [] as { url: string; title: string }[] };
      const searchCalls = buildWebSearchCallItems(evidence);
      const annotations = buildCitationAnnotations(text, evidence.sources);
      const steps: Record<string, unknown>[] = [];
      searchCalls.forEach((item) => {
        steps.push({ type: 'google_search_call', queries: [item.action.query] });
      });
      if (evidence.sources.length > 0) {
        steps.push({
          type: 'google_search_result',
          sources: evidence.sources,
          note: 'surrogate grounding via opencode websearch (exa/parallel), not Google',
        });
      }
      steps.push({ type: 'model_output', text, annotations });
      const groundingCount = searchCalls.length;
      if (store) {
        const stateStored = polled.assistantMessageId
           ? storeResponseState(interactionId, sessionId as string, `${pID}/${mID}`, [], polled.assistantMessageId, tenantId)
          : false;
        if (stateStored) ownedSessionIds.delete(sessionId as string);
        await cleanupOwnedSessions();
      }
      await deleteEphemeralSession();

       assertIdempotencyResultConfirmed();
       res.json({
        id: interactionId,
        status: 'completed',
        model: `${pID}/${mID}`,
        output_text: text,
        steps,
        usage: { grounding_tool_count: [{ type: 'google_search', count: groundingCount }] },
      });
      return;
      } catch (error: unknown) {
         await cleanupOwnedSessions();
        if (clientGone) {
          return;
        }
        const isUnconfirmedStreamingReconciliation =
          idempotency?.reconciling && asRecord((req as unknown as { body: unknown }).body)['stream'] === true;
        if (
          idempotency?.submitted &&
          !hasConfirmedIdempotencyResult() &&
          !res.headersSent &&
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
        if (isUnconfirmedStreamingReconciliation && !res.destroyed && !res.writableEnded) {
          const transformed = transformUpstreamError(error);
          console.error('[Proxy] Interactions API Error:', toErrorMessage(error));
          if (!res.headersSent) {
            res.status(200);
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
          }
          if (!interactionCreated) {
            res.write(`data: ${JSON.stringify({
              type: 'interaction.created',
              interaction: {
                id: idempotency?.publicId ?? `intr_${crypto.randomUUID()}`,
                status: 'in_progress',
                model: idempotency?.model ?? 'unknown',
              },
            })}\n\n`);
            interactionCreated = true;
          }
          res.write(`data: ${JSON.stringify({ type: 'error', error: transformed.error })}\n\n`);
          res.end();
          return;
        }
        if (
          asRecord((req as unknown as { body: unknown }).body)['stream'] === true &&
          idempotency?.reconciling &&
          idempotency.resultConfirmed &&
          !res.destroyed &&
          !res.writableEnded
        ) {
          const transformed = transformUpstreamError(error);
          console.error('[Proxy] Interactions API Error:', toErrorMessage(error));
          if (!interactionCreated) {
            res.write(`data: ${JSON.stringify({
              type: 'interaction.created',
              interaction: {
                id: idempotency.publicId ?? `intr_${crypto.randomUUID()}`,
                status: 'in_progress',
                model: idempotency.model ?? 'unknown',
              },
            })}\n\n`);
            interactionCreated = true;
          }
          res.write(`data: ${JSON.stringify({ type: 'error', error: transformed.error })}\n\n`);
          res.end();
          return;
        }
        if (!fallbackToProxy) engageProxyFallback(error);

      console.error('[Proxy] Interactions API Error:', toErrorMessage(error));
      const transformed = transformUpstreamError(error);
      if (!res.headersSent) {
        res.status(transformed.statusCode).json(transformed.error);
      } else {
        try {
          res.write(`data: ${JSON.stringify({ type: 'error', error: transformed.error })}\n\n`);
        } catch {
          // ignore
        }
        if (!res.writableEnded && !res.destroyed) {
          res.end();
        }
      }
      return;
    } finally {
      res.removeListener('close', onClientClose);
    }
  };

  app.post(['/v1beta/interactions', '/v1/interactions'], (req: Request, res: Response): void => {
    void handle(req, res).catch((err: unknown) => {
      const transformed = transformUpstreamError(err);
      if (!res.headersSent) {
        res.status(transformed.statusCode).json(transformed.error);
      } else if (!res.writableEnded && !res.destroyed) {
        try {
          res.write(`data: ${JSON.stringify({ type: 'error', error: transformed.error })}\n\n`);
        } catch {
          // ignore
        }
        res.end();
      }
    });
  });
}
