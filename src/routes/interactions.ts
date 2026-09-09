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
import { withTimeout } from '../config/proxy-config.js';
import { computeRetryDelay } from '../retry/policy.js';
import { normalizeBackendError, transformUpstreamError } from '../errors/upstream.js';
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

export function registerInteractionsRoutes(app: Application, ctx: AppContext): void {
  const {
    client,
    config,
    REQUEST_TIMEOUT_MS,
    maxAttempts,
    resolveRequestedModel,
    logDebug,
    getResponseState,
    storeResponseState,
    buildSystemPrompt,
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
    // P3 bundle (direct unless the pool is already engaged).
    let activeClient = client;
    let activePromptWithTimeout = promptWithTimeout;
    let activePollForAssistantResponse = pollForAssistantResponse;
    let fallbackToProxy = false;
    if (proxyPool.isEngaged() && proxyClient) {
      activeClient = proxyClient;
      activePromptWithTimeout = proxyPromptWithTimeout;
      activePollForAssistantResponse = proxyPollForAssistantResponse;
    }
    const engageProxyFallback = (err: unknown): boolean => {
      if (!engageFallbackForFreeLimit(err, proxyPool) || !proxyClient) return false;
      activeClient = proxyClient;
      activePromptWithTimeout = proxyPromptWithTimeout;
      activePollForAssistantResponse = proxyPollForAssistantResponse;
      fallbackToProxy = true;
      return true;
    };
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

      const previousState =
        typeof previousInteractionId === 'string' && previousInteractionId
          ? getResponseState(previousInteractionId)
          : null;
      if (previousInteractionId && !previousState) {
        res.status(400).json({ error: { message: 'Invalid or expired previous_interaction_id', type: 'invalid_request_error' } });
        return;
      }

      const resolvedModel = (await withTimeout(
        resolveRequestedModel(typeof model === 'string' && model ? model : (previousState?.model ?? '')),
        REQUEST_TIMEOUT_MS,
        'resolve model',
      )) as unknown as { providerID: string; modelID: string };
      const pID = String(asRecord(resolvedModel)['providerID']);
      const mID = String(asRecord(resolvedModel)['modelID']);

      await ensureBackend(config);

      try {
        await activeClient.config.update({
          body: { activeModel: { providerID: pID, modelID: mID } },
        });
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

      let sessionId: string | null = previousState?.sessionId || null;
      // Only a session created by this request may be deleted by store:false;
      // deleting a reused parent session would orphan its stored state.
      let sessionNewlyCreated = false;
      if (!sessionId) {
        sessionId =
          ((asRecord(asRecord(await withTimeout(activeClient.session.create(), REQUEST_TIMEOUT_MS, 'create session'))['data'])['id'] as string | undefined) ?? null);
        if (!sessionId) throw new Error('Failed to create OpenCode session');
        sessionNewlyCreated = true;
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
        [systemText, ...systemTexts, hostedSearch.requested ? SEARCH_GROUNDING_INSTRUCTION : '']
          .filter(Boolean)
          .join('\n\n'),
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
      if (toolOverrides && Object.keys(toolOverrides).length > 0) {
        promptParams.body['tools'] = toolOverrides;
      }

      // Thin retry: free-limit errors engage the proxy pool and rotate the
      // session (bounded by maxAttempts like the other routes). Ordinary
      // errors throw immediately — no generic transient backoff here.
      const promptAndPoll = async (): Promise<{
        content: string;
        reasoning: string;
        error: unknown;
        toolParts?: unknown;
      }> => {
        let lastErr: unknown = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          if (res.destroyed || res.writableEnded) throw new Error('Client disconnected');
          if (attempt > 1) {
            try {
              await activeClient.session.delete({ path: { id: sessionId as string } });
            } catch (e: unknown) {
              logDebug('Failed to delete retried interaction session', { error: toErrorMessage(e) });
            }
            const retryRes = (await withTimeout(activeClient.session.create(), REQUEST_TIMEOUT_MS, 'create session')) as unknown;
            sessionId = (asRecord(asRecord(retryRes)['data'])['id'] as string | undefined) ?? null;
            if (!sessionId) throw new Error('Failed to create OpenCode session for retry');
            promptParams.path.id = sessionId;
            await sleep(computeRetryDelay(attempt - 1, lastErr));
          }
          try {
            await activePromptWithTimeout(promptParams, REQUEST_TIMEOUT_MS);
            const polled = await activePollForAssistantResponse(sessionId as string, REQUEST_TIMEOUT_MS);
            if (polled.error && !polled.content && !polled.reasoning) throw normalizeBackendError(polled.error);
            return polled;
          } catch (e: unknown) {
            lastErr = e;
            if (attempt < maxAttempts && engageProxyFallback(e)) continue;
            throw normalizeBackendError(e);
          }
        }
        throw normalizeBackendError(lastErr ?? new Error('Upstream provider error'));
      };

      const interactionId = `intr_${crypto.randomUUID()}`;
      const deleteEphemeralSession = async (): Promise<void> => {
        // Only sessions created by this request may be deleted; a reused
        // parent session stays alive for its stored continuation chain.
        if (store || !sessionNewlyCreated) return;
        try {
          await activeClient.session.delete({ path: { id: sessionId as string } });
        } catch (e: unknown) {
          logDebug('Failed to delete unstored interaction session', { error: toErrorMessage(e) });
        }
      };
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const flushHeaders = (res as unknown as { flushHeaders?: unknown }).flushHeaders;
        if (typeof flushHeaders === 'function') (flushHeaders as () => void).call(res);
        // Stream contract: interaction.created → step.delta* → interaction.completed
        // (no [DONE]; errors arrive as {type:'error'} like /v1/messages).
        let clientGone = false;
        res.once('close', () => {
          if (!res.writableEnded) clientGone = true;
        });
        const heartbeat = setInterval(() => {
          if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n');
        }, 15000);
        if (typeof heartbeat.unref === 'function') heartbeat.unref();
        const emit = (payload: unknown): void => {
          if (res.destroyed || res.writableEnded) return;
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        };
        try {
        emit({ type: 'interaction.created', interaction: { id: interactionId, status: 'in_progress', model: `${pID}/${mID}` } });
        const polled = await promptAndPoll();
        if (clientGone) {
          await deleteEphemeralSession();
          return;
        }
        const text = polled.content || '';
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
          emit({ type: 'interaction.completed', interaction: { id: interactionId, status: 'completed', output_text: text, steps } });
          if (store) storeResponseState(interactionId, sessionId as string, `${pID}/${mID}`);
          await deleteEphemeralSession();
        } finally {
          clearInterval(heartbeat);
        }
        res.end();
        return;
      }

      const polled = await promptAndPoll();
      const text = polled.content || '';
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
      if (store) storeResponseState(interactionId, sessionId as string, `${pID}/${mID}`);
      await deleteEphemeralSession();
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
        res.end();
      }
      return;
    }
  };

  app.post('/v1beta/interactions', (req: Request, res: Response): void => {
    void handle(req, res);
  });
  app.post('/v1/interactions', (req: Request, res: Response): void => {
    void handle(req, res);
  });
}
