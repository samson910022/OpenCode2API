// P4 TS: streaming collector (poll/event) + image fetch + prompt timeout (ported from P3 .js).
import http from 'http';
import https from 'https';
import { sleep } from '../backend/manager.js';
import { isValidSessionId } from '../session/ids.js';
import { withTimeout, DEFAULT_POLL_INTERVAL_MS } from '../config/proxy-config.js';
import type { ProxyClient } from '../types/client.js';
import type { CollectorHandle } from '../types/context.js';
import { asRecord } from '../utils/guards.js';

function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String((e as Record<string, unknown>)?.['message'] ?? e);
}

interface CollectorDeps {
  client: ProxyClient;
  logDebug: (...args: unknown[]) => void;
}

interface BackendPart {
  id?: unknown;
  type?: unknown;
  text?: unknown;
  tool?: unknown;
  state?: unknown;
  sessionID?: unknown;
  [key: string]: unknown;
}

interface BackendEvent {
  type?: unknown;
  properties?: unknown;
}

// --- Mutex Logic with Timeout ---
export async function getImageDataUri(url: unknown): Promise<string> {
  const urlStr = String(url ?? '');
  if (urlStr.startsWith('data:')) {
    return urlStr;
  }

  if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
    throw new Error(`Invalid URL scheme: ${urlStr}`);
  }

  return new Promise((resolve, reject) => {
    const protocol = urlStr.startsWith('https') ? https : http;

    const req = protocol.get(urlStr, { timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to fetch image: HTTP ${res.statusCode}`));
        return;
      }

      const contentType = (res.headers['content-type'] as string) || 'image/jpeg';
      const chunks: Buffer[] = [];

      res.on('data', (chunk: unknown) => chunks.push(chunk as Buffer));
      res.on('end', () => {
        try {
          const buffer = Buffer.concat(chunks);
          const base64 = buffer.toString('base64');
          resolve(`data:${contentType};base64,${base64}`);
        } catch (e: unknown) {
          reject(new Error(`Failed to encode image: ${toErrorMessage(e)}`));
        }
      });
    });

    req.on('error', (e: unknown) => reject(e instanceof Error ? e : new Error(String(e))));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Image fetch timeout'));
    });
  });
}

export function extractFromParts(parts: unknown): { content: string; reasoning: string; toolParts: BackendPart[] } {
  if (!Array.isArray(parts)) return { content: '', reasoning: '', toolParts: [] };
  const list = parts as BackendPart[];
  const content = list
    .filter((p) => (p as Record<string, unknown>)['type'] === 'text')
    .map((p) => String((p as Record<string, unknown>)['text'] ?? ''))
    .join('');
  const reasoning = list
    .filter((p) => (p as Record<string, unknown>)['type'] === 'reasoning')
    .map((p) => String((p as Record<string, unknown>)['text'] ?? ''))
    .join('');
  const toolParts = list.filter((p) => (p as Record<string, unknown>)['type'] === 'tool');
  return { content, reasoning, toolParts };
}

function extractMessagesList(messagesRes: unknown): unknown[] {
  const record = asRecord(messagesRes);
  const data: unknown = record['data'] ?? messagesRes;
  if (Array.isArray(data)) return data as unknown[];
  if (Array.isArray(messagesRes)) return messagesRes as unknown[];
  return [];
}

function createAbortError(): Error {
  const error = new Error('Request aborted');
  error.name = 'AbortError';
  return error;
}

function toolPartStatus(part: unknown): unknown {
  const record = asRecord(part);
  const state = asRecord(record['state']);
  return state['status'] ?? record['status'];
}

function isActiveToolPart(part: unknown): boolean {
  const status = toolPartStatus(part);
  return status === 'pending' || status === 'running';
}

function readSessionEventError(properties: unknown): unknown {
  const props = asRecord(properties);
  const direct = props['error'];
  if (direct != null) return direct;
  const data = asRecord(props['data']);
  if (data['error'] != null) return data['error'];
  const message = props['message'] ?? data['message'];
  if (message != null) {
    return { name: typeof props['name'] === 'string' ? props['name'] : 'SessionError', data: { message: String(message) } };
  }
  return { name: 'SessionError', data: { message: 'OpenCode session error' } };
}

async function readSessionMessages(
  client: ProxyClient,
  sessionId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) throw createAbortError();
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener = (): void => {};
  let request: Promise<unknown>;
  try {
    request = Promise.resolve(client.session.messages({ path: { id: sessionId }, signal: controller.signal }));
  } catch (error: unknown) {
    request = Promise.reject(error);
  }
  request.catch(() => {});
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Request timeout after ${timeoutMs}ms (poll messages)`));
    }, Math.max(1, timeoutMs));
  });
  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        const onExternalAbort = (): void => reject(createAbortError());
        removeAbortListener = (): void => signal.removeEventListener('abort', onExternalAbort);
        if (signal.aborted) onExternalAbort();
        else signal.addEventListener('abort', onExternalAbort, { once: true });
      })
    : null;
  try {
    return await Promise.race(abortPromise ? [request, timeoutPromise, abortPromise] : [request, timeoutPromise]);
  } catch (error: unknown) {
    if (signal?.aborted) throw createAbortError();
    throw error;
   } finally {
     if (timer !== undefined) clearTimeout(timer);
     removeAbortListener();
     signal?.removeEventListener('abort', onAbort);
   }

}

async function waitForPollDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await sleep(ms);
    return;
  }
  if (signal.aborted) throw createAbortError();
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(createAbortError());
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

/**
 * Create per-instance collector closing over the OpenCode client + logDebug
 * (same closure semantics as the original createApp inner functions).
 */
export function createCollector(deps: CollectorDeps): CollectorHandle {
  const { client, logDebug } = deps;
  async function promptWithTimeout(promptParams: unknown, timeoutMs: unknown): Promise<unknown> {
    // Single timeout implementation: withTimeout clears its timer and
    // swallows late rejections (old inline race leaked timers and could
    // surface unhandled rejections). Message keeps 'Request timeout' so
    // transformUpstreamError maps it to 504.
    return withTimeout(client.session.prompt(promptParams), timeoutMs, 'prompt backend');
  }

  async function pollForAssistantResponse(
    sessionId: string,
    timeoutMs: number,
    intervalMs: number = DEFAULT_POLL_INTERVAL_MS,
    signal?: AbortSignal,
    expectedCurrentUserMessageId?: string,
  ): Promise<{ content: string; reasoning: string; error: unknown; toolParts: unknown[]; partial?: boolean; complete?: boolean }> {
    // Drift signal only: backend-minted ses_* IDs should match the canonical
    // shape (see src/session/ids.ts). Never block on mismatch — the schema
    // itself accepts any startsWith("ses") value.
    if (!isValidSessionId(sessionId)) logDebug('Unexpected backend session ID format', { sessionId });
    const pollStart = Date.now();
    const startedAt = Date.now();
    // Best-effort snapshot of the most recent in-flight assistant message. Polling
    // observes partial messages: a reasoning model emits its reasoning part first and
    // the text part only afterwards, so returning on the first non-empty snapshot
    // truncates the answer to the reasoning alone. Keep the partial around purely as
    // a timeout fallback and otherwise wait for the message to actually finish.
    let lastPartial: { content: string; reasoning: string; error: null; toolParts: unknown[] } | null = null;
    while (Date.now() - startedAt < timeoutMs) {
      if (signal?.aborted) throw createAbortError();
      const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
       const messagesRes: unknown = await readSessionMessages(client, sessionId, remainingMs, signal);
       const responseError = asRecord(messagesRes)['error'];
       if (responseError != null) return { content: '', reasoning: '', error: responseError, toolParts: [] };
       const messages = extractMessagesList(messagesRes);

      if (Array.isArray(messages) && messages.length) {
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const entry = asRecord(messages[i]);
          const info = asRecord(entry['info']);
          if (info['role'] !== 'assistant') continue;
          if (
            expectedCurrentUserMessageId !== undefined &&
            info['parentID'] !== expectedCurrentUserMessageId
          ) continue;
          const { content, reasoning, toolParts } = extractFromParts(entry['parts'] ?? []);
          const error: unknown = info['error'] ?? null;
          // finish === 'tool' and 'tool-calls' mark an intermediate turn that pauses for a
          // tool result; the assistant is not done producing output yet, even when the
          // message snapshot already carries a completion timestamp.
           const finish: unknown = info['finish'];
           const time = asRecord(info['time']);
           const activeToolParts = toolParts.filter((part) => isActiveToolPart(part));
           const awaitingTool = finish === 'tool' || finish === 'tool-calls' || activeToolParts.length > 0;
           const finished = info['finish'] != null && !awaitingTool;
           const done = Boolean(finished || (!awaitingTool && time['completed']) || error);

          if (toolParts.length > 0) {
            logDebug('Polling found tool parts', {
              sessionId,
              count: toolParts.length,
              parts: toolParts.map((p) => {
                const pr = asRecord(p);
                const state = asRecord(pr['state']);
                return {
                  id: pr['id'],
                  tool: pr['tool'],
                  status: state['status'],
                  input: state['input'],
                };
              }),
            });
          }
          if (done) {
            if (error) {
              const errRecord = asRecord(error);
              console.error('[Proxy] OpenCode assistant error:', error);
              void errRecord;
            }
            logDebug('Polling completed', {
              sessionId,
              ms: Date.now() - pollStart,
              done,
              contentLen: content.length,
              reasoningLen: reasoning.length,
              error: error ? (asRecord(error)['name'] as unknown) : null,
            });
            return { content, reasoning, error, toolParts, complete: true };
          }
          if (content || reasoning || toolParts.length > 0) {
            lastPartial = { content, reasoning, error: null, toolParts };
          }
          break;
        }
      }
       const remainingAfterSnapshot = Math.max(1, timeoutMs - (Date.now() - startedAt));
       await waitForPollDelay(Math.min(intervalMs, remainingAfterSnapshot), signal);

    }
    if (lastPartial) {
      logDebug('Polling timeout with partial response', {
        sessionId,
        ms: Date.now() - pollStart,
        contentLen: lastPartial.content.length,
        reasoningLen: lastPartial.reasoning.length,
      });
      return { ...lastPartial, partial: true };
    }
    logDebug('Polling timeout', { sessionId, ms: Date.now() - pollStart });
    throw new Error(`Request timeout after ${timeoutMs}ms`);
  }

  async function collectFromEvents(
    sessionId: string,
    timeoutMs: number,
    onDelta?: ((delta: string, isReasoning?: boolean) => void) | null,
    firstDeltaTimeoutMs?: number | null,
    idleTimeoutMs?: number | null,
    signal?: AbortSignal,
    expectedCurrentUserMessageId?: string,
  ): Promise<Record<string, unknown>> {
    if (!isValidSessionId(sessionId)) logDebug('Unexpected backend session ID format', { sessionId });
    if (signal?.aborted) return { content: '', reasoning: '', cancelled: true };
    const controller = new AbortController();
    const CANCELLED = Symbol('collector-cancelled');
    let removeSubscribeAbortListener = (): void => {};
    const subscribePromise = Promise.resolve().then(() => client.event.subscribe({ signal: controller.signal }));
    subscribePromise.catch(() => {});
    const subscribeAbortPromise = new Promise<typeof CANCELLED>((resolve) => {
      const onAbort = (): void => {
        controller.abort();
        resolve(CANCELLED);
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      removeSubscribeAbortListener = (): void => signal?.removeEventListener('abort', onAbort);
    });
     let eventStreamResult: unknown;
     try {
       eventStreamResult = await Promise.race([subscribePromise, subscribeAbortPromise]);
     } finally {
       removeSubscribeAbortListener();
     }
     if (eventStreamResult === CANCELLED) return { content: '', reasoning: '', cancelled: true };

    const eventStream = asRecord(eventStreamResult)['stream'] as AsyncIterable<BackendEvent>;
    let finished = false;
    let terminalFinishSeen = false;
    let lastFinish: string | null = null;
      let content = '';
      let reasoning = '';
      let bufferedRoleUnknownDeltaSeen = false;
      let sawUserParts = false;
      let sawStaleMessageParts = false;
      let sawUnverifiedAssistantParts = false;
    let receivedDelta = false;
    let deltaChars = 0;
    let firstDeltaAt: number | null = null;
    // Tracks internal OpenCode tool calls that are still pending/running. While any
    // tool call is active, the stream must stay open even if no text deltas arrive
    // (the backend is executing the tool). Resolving early here is what previously
    // truncated streaming responses that relied on internal tool execution.
     const activeToolCallIds = new Set<string>();
      // ID-less backend tool parts carry no stable `id` (older servers / some
      // internal tools). A cumulative counter inflates here because
      // `message.part.updated` fires repeatedly for the same logical tool while
      // it stays pending (N pendings, 1 terminal) and `message.updated`
      // snapshots re-deliver the same part on every update — pinning the idle
      // exemption until REQUEST_TIMEOUT_MS. Track ID-less activity as a Set
      // keyed by tool name instead: idempotent on repeats, concurrent across
      // distinct tool names. Same-name concurrent ID-less tools share a bucket
      // (accepted: rarer than repeat snapshots; degrades to boolean, not hang).
      const activeNoidToolKeys = new Set<string>();
      // Terminals already observed. `message.updated` snapshots re-deliver the
      // same completed part on every update, so a replayed terminal must be
      // ignored instead of falling through to the mismatch path below (which
      // would delete an innocent still-running bucket).
      const settledNoidKeys = new Set<string>();
      const noidKeyFor = (pr: Record<string, unknown>): string => {
        const tool = pr['tool'];
        return typeof tool === 'string' && tool.trim() ? `noid:${tool.trim()}` : 'noid:unknown';
      };
      const hasActiveTools = (): boolean => activeToolCallIds.size > 0 || activeNoidToolKeys.size > 0;
      // Bucket count for debug logging only (not a tool count: same-name
      // concurrent ID-less tools share one bucket by design).
      const activeToolCount = (): number => activeToolCallIds.size + activeNoidToolKeys.size;
      const trackToolState = (part: unknown): void => {
        // Unknown statuses are ignored (neither active nor terminal) to avoid
        // false idle exemption.
        const pr = asRecord(part);
        if (pr['type'] !== 'tool') return;
        const status = toolPartStatus(pr);
        const id = typeof pr['id'] === 'string' ? (pr['id'] as string) : null;
        if (status === 'pending' || status === 'running') {
          if (id) activeToolCallIds.add(id);
          else {
            const key = noidKeyFor(pr);
            // A re-run of the same tool after completion is a new logical tool.
            settledNoidKeys.delete(key);
            activeNoidToolKeys.add(key);
          }
        } else if (status === 'completed' || status === 'error') {
          if (id) activeToolCallIds.delete(id);
          else {
            const key = noidKeyFor(pr);
            if (activeNoidToolKeys.has(key)) {
              activeNoidToolKeys.delete(key);
              settledNoidKeys.add(key);
            } else if (settledNoidKeys.has(key)) {
              // Replayed terminal snapshot for an already-settled tool: ignore.
            } else if (activeNoidToolKeys.size === 1) {
              // Single-bucket name mismatch between pending and terminal (e.g.
              // one side omits `tool`): clear the only bucket so a single
              // completion cannot pin the stream open forever.
              const first = activeNoidToolKeys.values().next();
              if (!first.done) {
                settledNoidKeys.add(first.value);
                activeNoidToolKeys.delete(first.value);
              }
            }
            // Multi-bucket ambiguity (size !== 1, unknown key): ignore rather
            // than deleting an innocent tool. Truncating an answer via an early
            // idle/stop is worse than waiting for the real terminal.
          }
        }
      };
     const startedAt = Date.now();
     let removeCollectAbortListener = (): void => {};

     const finishPromise = new Promise<Record<string, unknown>>((resolve, reject) => {

      const timeoutId = setTimeout(() => {
        if (finished) return;
        finished = true;
        clearAllTimers();
        controller.abort();
        reject(new Error(`Request timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const firstDeltaTimer = firstDeltaTimeoutMs
        ? setTimeout(() => {
            if (finished || receivedDelta) return;
            finished = true;
            clearAllTimers();
            controller.abort();
            logDebug('No event data received', { sessionId, ms: Date.now() - startedAt });
            const result = finalizeCollected();
            // A snapshot can produce content without any delta activity; only
            // report noData when reconciliation is also empty.
            if (!(result['content'] as string) && !(result['reasoning'] as string)) {
              result['noData'] = true;
            }
            resolve(result);
          }, firstDeltaTimeoutMs)
        : null;

       let idleTimer: ReturnType<typeof setTimeout> | null = null;

       const clearAllTimers = (): void => {
         clearTimeout(timeoutId);
         if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
         if (idleTimer) clearTimeout(idleTimer);
       };

       const onSignalAbort = (): void => {
         if (finished) return;
         finished = true;
         clearAllTimers();
         controller.abort();
         resolve({ content, reasoning, cancelled: true });
       };
       if (signal) {
         signal.addEventListener('abort', onSignalAbort, { once: true });
         removeCollectAbortListener = (): void => signal.removeEventListener('abort', onSignalAbort);
         if (signal.aborted) onSignalAbort();
       }
       const scheduleIdleTimer = (): void => {

        if (!idleTimeoutMs) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (finished) return;
          // A tool call is still executing on the backend. Keep the stream open
          // and wait instead of cutting the response short; the follow-up text
          // (or the final completion) will arrive once the tool finishes.
          if (hasActiveTools()) {
            logDebug('Event idle while internal tool call is active, continuing to wait', {
              sessionId,
              ms: Date.now() - startedAt,
              activeTools: activeToolCount(),
            });
            scheduleIdleTimer();
            return;
          }
          finished = true;
          clearAllTimers();
          controller.abort();
          logDebug('Event idle timeout', {
            sessionId,
            ms: Date.now() - startedAt,
            deltaChars,
          });
          resolve(finalizeCollected({
            idleTimeout: true,
            receivedDelta,
          }));
        }, idleTimeoutMs);
      };

       const trackToolActivity = (part: unknown): void => {
         trackToolState(part);

         // Tool activity means the session is still working; treat it as progress

        // so the idle timer does not terminate the stream mid-execution.
        receivedDelta = true;
        if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
        scheduleIdleTimer();
      };

      // Per-part reconciliation state. A turn can contain several text/reasoning
      // parts, so snapshots are tracked per part (messageID + partID, numeric IDs
      // stringified) instead of as one global joined snapshot. This prevents a
      // missing snapshot in part 1 from truncating part 2, and it keeps a sticky
      // `message.updated info.parts` snapshot from overriding a newer full
      // `message.part.updated part.text` (both write the same part state; the
      // later event wins).
      type StreamPartType = 'text' | 'reasoning';
      interface StreamPartState {
        type: StreamPartType;
        deltaText: string;
        snapshotText: string;
        deltasAfterSnapshot: string;
        unreleasedDeltas: { delta: string; sequence: number }[];
        order: number;
        messageID: string | null;
        partID: string | null;
        snapshotSeq: number;
        deltaSeq: number;
      }
      const partStates = new Map<string, StreamPartState>();
      // A `message.part.delta` can arrive before the part update that announces
      // its type. Keep those deltas (and their first-seen order) until the part
      // update arrives, then replay them into the now-typed part state.
      const pendingDeltaParts = new Map<string, { deltas: string[]; order: number; messageID: string | null; partID: string | null }>();
      // Message roles are keyed by the assistant/user message id. A missing id
      // uses the empty bucket, which covers legacy events that also omit
      // `messageID`; unknown roles are accepted so old backends keep working.
      const messageRoles = new Map<string, string>();
      const staleMessageIds = new Set<string>();
      const unverifiedAssistantMessageIds = new Set<string>();
      const assistantMessageParents = new Map<string, string>();
      const assistantPartParents = new Map<string, string>();
      const partMessageOwners = new Map<string, string>();
      const ambiguousPartMessageOwnerIds = new Set<string>();
      // Rejected and role-classified part IDs are scoped to their owner message.
      // ID-less events may use these sets conservatively, but an explicit message
      // identity always takes precedence when a backend reuses a part ID.
      const rejectedPartOwners = new Map<string, Set<string>>();
      const rejectedPartIdsWithoutOwner = new Set<string>();
      const userPartOwners = new Map<string, Set<string>>();
      const userPartIdsWithoutOwner = new Set<string>();
      const assistantPartOwners = new Map<string, Set<string>>();
      const assistantPartIdsWithoutOwner = new Set<string>();
      const quarantinedToolParts = new Map<
        string,
        { messageID: string | null; partID: string | null; part: unknown; sequence: number }
      >();
      // Full message snapshots can lag behind explicit per-part updates. Keep
      // the most recent tool part update so replayed snapshots cannot regress
      // a running tool to a stale completed state.
      interface LatestToolPartUpdate {
        messageID: string | null;
        partID: string | null;
        part: unknown;
        sequence: number;
      }
      const latestToolPartUpdates = new Map<string, LatestToolPartUpdate>();
      let partOrderCounter = 0;
      let eventSeq = 0;

      const readPartId = (value: unknown): string | null => {
        if (value == null || typeof value === 'boolean') return null;
        return String(value);
      };
      const rememberPartMessageOwner = (messageID: string | null, partID: string | null): void => {
        if (messageID == null || partID == null || ambiguousPartMessageOwnerIds.has(partID)) return;
        const previousOwner = partMessageOwners.get(partID);
        if (previousOwner == null) partMessageOwners.set(partID, messageID);
        else if (previousOwner !== messageID) {
          partMessageOwners.delete(partID);
          ambiguousPartMessageOwnerIds.add(partID);
        }
      };
      const isAmbiguousOwnerlessPart = (messageID: string | null, partID: string | null): boolean =>
        messageID == null && partID != null && ambiguousPartMessageOwnerIds.has(partID);
      const resolvePartMessageId = (messageID: string | null, partID: string | null): string | null => {
        if (messageID != null) return messageID;
        if (partID == null || ambiguousPartMessageOwnerIds.has(partID)) return null;
        return partMessageOwners.get(partID) ?? null;
      };
      const readPartMessageId = (record: Record<string, unknown>): string | null =>
        readPartId(record['messageID'] ?? record['messageId']);
      const readInfoMessageId = (info: Record<string, unknown>): string | null =>
        readPartId(info['id'] ?? info['messageID'] ?? info['messageId']);
      const readParentMessageId = (record: Record<string, unknown>): string | null =>
        readPartId(record['parentID'] ?? record['parentId'] ?? record['parent_id']);
      const idPartKey = (messageID: string | null, partID: string): string => `${messageID ?? ''}\u0000${partID}`;
      const toolPartKey = (messageID: string | null, part: unknown): string => {
        const record = asRecord(part);
        const owner = readPartMessageId(record) ?? messageID;
        const partID = readPartId(record['id']);
        const identity = partID ?? `noid:${noidKeyFor(record)}`;
        return idPartKey(owner, identity);
      };
      const latestToolUpdateFor = (
        messageID: string | null,
        partID: string | null,
        part: unknown,
      ): [string, LatestToolPartUpdate] | null => {
        const exactKey = toolPartKey(messageID, partID == null ? part : { ...asRecord(part), id: partID });
        if (partID == null) {
          const exact = latestToolPartUpdates.get(exactKey);
          return exact ? [exactKey, exact] : null;
        }
        let matching = [...latestToolPartUpdates.entries()].filter(([, update]) => update.partID === partID);
        if (messageID != null) {
          matching = matching.filter(([, update]) => update.messageID == null || update.messageID === messageID);
        } else {
          const unowned = matching.filter(([, update]) => update.messageID == null);
          if (unowned.length > 0) matching = unowned;
          else if (new Set(matching.map(([, update]) => update.messageID)).size > 1) matching = [];
        }
        return matching.reduce<[string, LatestToolPartUpdate] | null>(
          (current, candidate) => current == null || candidate[1].sequence > current[1].sequence ? candidate : current,
          null,
        );
      };
      const rememberToolPartUpdate = (messageID: string | null, part: unknown): void => {
        if (asRecord(part)['type'] !== 'tool') return;
        const record = asRecord(part);
        const partID = readPartId(record['id']);
        const owner = readPartMessageId(record) ?? messageID;
        const latest = latestToolUpdateFor(owner, partID, part);
        let key = latest?.[0] ?? toolPartKey(owner, part);
        if (latest?.[1].messageID == null && owner != null) {
          latestToolPartUpdates.delete(key);
          key = toolPartKey(owner, part);
        }
        latestToolPartUpdates.set(key, { messageID: owner ?? latest?.[1].messageID ?? null, partID, part, sequence: ++eventSeq });
      };
      const latestToolPart = (messageID: string | null, partID: string | null, part: unknown): unknown => {
        return latestToolUpdateFor(messageID, partID, part)?.[1].part ?? part;
      };
      const isPartOutsideExpectedTurn = (part: Record<string, unknown>): boolean => {
        const explicitParent = readParentMessageId(part);
        return expectedCurrentUserMessageId !== undefined && explicitParent != null && explicitParent !== expectedCurrentUserMessageId;
      };
      const ownersFor = (owners: Map<string, Set<string>>, partID: string): Set<string> => {
        let result = owners.get(partID);
        if (!result) {
          result = new Set<string>();
          owners.set(partID, result);
        }
        return result;
      };
      const rememberPartOwner = (owners: Map<string, Set<string>>, noOwner: Set<string>, messageID: string | null, partID: string): void => {
        if (messageID == null) noOwner.add(partID);
        else ownersFor(owners, partID).add(messageID);
      };
      const hasPartOwner = (owners: Map<string, Set<string>>, noOwner: Set<string>, messageID: string | null, partID: string): boolean => {
        if (messageID == null) return noOwner.has(partID) || (owners.get(partID)?.size ?? 0) > 0;
        return owners.get(partID)?.has(messageID) ?? false;
      };
      const rememberRejectedPart = (messageID: string | null, partID: string): void =>
        rememberPartOwner(rejectedPartOwners, rejectedPartIdsWithoutOwner, messageID, partID);
      const isRejectedPart = (messageID: string | null, partID: string | null): boolean =>
        partID != null && hasPartOwner(rejectedPartOwners, rejectedPartIdsWithoutOwner, messageID, partID);
      const rememberUserPart = (messageID: string | null, partID: string): void =>
        rememberPartOwner(userPartOwners, userPartIdsWithoutOwner, messageID, partID);
      const isUserPartId = (messageID: string | null, partID: string | null): boolean =>
        partID != null && hasPartOwner(userPartOwners, userPartIdsWithoutOwner, messageID, partID);
      const isAssistantPartId = (messageID: string | null, partID: string | null): boolean =>
        partID != null && hasPartOwner(assistantPartOwners, assistantPartIdsWithoutOwner, messageID, partID);
      const isPartOwnerOrUnassigned = (stateMessageID: string | null, messageID: string | null): boolean =>
        stateMessageID == null || (messageID != null && stateMessageID === messageID);
      const partKeyFor = (messageID: string | null, partID: string | null, type: StreamPartType): string =>
        partID != null ? `id\u0000${idPartKey(messageID, partID)}` : `noid\u0000${type}`;
      const resolveMessageRole = (messageID: string | null): string | undefined => {
        if (messageID == null) return undefined;
        const role = messageRoles.get(messageID);
        // Only user and assistant have special semantics. Preserve unrecognized
        // legacy role strings as role-unknown instead of treating them as a
        // known non-assistant message.
        return role === 'user' || role === 'assistant' ? role : undefined;
      };
      const isUserPart = (messageID: string | null): boolean => resolveMessageRole(messageID) === 'user';
      const roleForPart = (messageID: string | null, partID: string | null): string | undefined => {
        if (isUserPartId(messageID, partID)) return 'user';
        if (isAssistantPartId(messageID, partID)) return 'assistant';
        return resolveMessageRole(messageID);
      };
      const isAssistantPartState = (state: StreamPartState): boolean =>
        roleForPart(state.messageID, state.partID) !== 'user' &&
        (expectedCurrentUserMessageId === undefined
          ? roleForPart(state.messageID, state.partID) === 'assistant'
          : (state.messageID != null && assistantMessageParents.get(state.messageID) === expectedCurrentUserMessageId) ||
            (state.partID != null && assistantPartParents.get(idPartKey(state.messageID, state.partID)) === expectedCurrentUserMessageId));
      const isKnownNonAssistantPartState = (state: StreamPartState): boolean => {
        const role = roleForPart(state.messageID, state.partID);
        return role === 'user';
      };
      const findPartState = (messageID: string | null, partID: string | null): StreamPartState | undefined => {
        if (partID == null) return undefined;
        const direct = partStates.get(partKeyFor(messageID, partID, 'text'));
        if (direct) return direct;
        // An ownerless early delta can be attached once metadata supplies its
        // messageID. Never merge state from a different explicit owner.
        if (messageID != null) return partStates.get(partKeyFor(null, partID, 'text'));
        for (const state of partStates.values()) {
          if (state.partID === partID) return state;
        }
        return undefined;
      };
      const ensurePartState = (
        messageID: string | null,
        partID: string | null,
        type: StreamPartType,
        order?: number,
      ): StreamPartState => {
        let state = findPartState(messageID, partID);
        // ID-less parts fall back to one stable state per type.
        if (!state && partID == null) state = partStates.get(partKeyFor(messageID, null, type));
        if (!state) {
          state = {
            type,
            deltaText: '',
            snapshotText: '',
            deltasAfterSnapshot: '',
            unreleasedDeltas: [],
            order: order ?? ++partOrderCounter,
            messageID,
            partID,
            snapshotSeq: 0,
            deltaSeq: 0,
          };
          partStates.set(partKeyFor(messageID, partID, type), state);
        } else {
          state.type = type;
          if (state.messageID == null && messageID != null) state.messageID = messageID;
        }
        if (order !== undefined) state.order = order;
        return state;
      };
      const discardMessageParts = (messageID: string, partIds: Set<string> = new Set()): void => {
        staleMessageIds.add(messageID);
        unverifiedAssistantMessageIds.delete(messageID);
        sawStaleMessageParts = true;
        discardQuarantinedToolParts(messageID, partIds);
        for (const partID of partIds) rememberRejectedPart(messageID, partID);
        for (const [key, state] of partStates) {
          if (state.messageID === messageID || (state.messageID == null && state.partID != null && partIds.has(state.partID))) {
            if (state.partID != null) rememberRejectedPart(messageID, state.partID);
            partStates.delete(key);
          }
        }
        for (const [key, pending] of pendingDeltaParts) {
          if (pending.messageID === messageID || (pending.messageID == null && pending.partID != null && partIds.has(pending.partID))) {
            if (pending.partID != null) rememberRejectedPart(messageID, pending.partID);
            pendingDeltaParts.delete(key);
          }
        }
      };
      const discardUnownedParts = (partIds: Set<string>): void => {
        sawStaleMessageParts = true;
        discardQuarantinedToolParts(null, partIds);
        for (const partID of partIds) rememberRejectedPart(null, partID);
        for (const [key, state] of partStates) {
          if (state.messageID == null && state.partID != null && partIds.has(state.partID)) partStates.delete(key);
        }
        for (const [key, pending] of pendingDeltaParts) {
          if (pending.messageID == null && pending.partID != null && partIds.has(pending.partID)) pendingDeltaParts.delete(key);
        }
      };
      const discardPartData = (messageID: string | null, partID: string | null): void => {
        if (partID == null) return;
        rememberRejectedPart(messageID, partID);
        for (const [key, state] of partStates) {
          if (state.partID === partID && isPartOwnerOrUnassigned(state.messageID, messageID)) partStates.delete(key);
        }
        for (const [key, pending] of pendingDeltaParts) {
          if (pending.partID === partID && isPartOwnerOrUnassigned(pending.messageID, messageID)) pendingDeltaParts.delete(key);
        }
        for (const [key, toolPart] of quarantinedToolParts) {
          if (toolPart.partID === partID && isPartOwnerOrUnassigned(toolPart.messageID, messageID)) quarantinedToolParts.delete(key);
        }
      };
      const parentForMessage = (messageID: string | null, parentID: string | null): string | undefined =>
        parentID ?? (messageID == null ? undefined : assistantMessageParents.get(messageID));
      // Use enclosing metadata to correlate legacy parts, but still validate an
      // explicit part-level parent independently against the expected turn.
      const parentForPart = (messageID: string | null, partID: string | null): string | undefined => {
        const owner = resolvePartMessageId(messageID, partID);
        return (owner == null ? undefined : assistantMessageParents.get(owner)) ??
          (partID == null ? undefined : assistantPartParents.get(idPartKey(owner, partID)));
      };
      const quarantinedToolKey = (messageID: string | null, partID: string | null, part: unknown): string => {
        const tool = asRecord(part)['tool'];
        const identity = partID ?? `noid:${typeof tool === 'string' ? tool : 'unknown'}`;
        return idPartKey(messageID, identity);
      };
      const quarantineToolPart = (messageID: string | null, partID: string | null, part: unknown): void => {
        const latestPart = latestToolPart(messageID, partID, part);
        const owner = readPartMessageId(asRecord(latestPart)) ?? messageID;
        let key = quarantinedToolKey(owner, partID, latestPart);
        let retainedOwner = owner;
        if (partID != null) {
          const samePart = [...quarantinedToolParts.entries()].filter(([, queued]) => queued.partID === partID);
          const compatible = samePart.filter(([, queued]) =>
            owner == null ? queued.messageID == null : queued.messageID == null || queued.messageID === owner,
          );
          const match = owner == null && compatible.length !== 1
            ? undefined
            : compatible.sort((left, right) => right[1].sequence - left[1].sequence)[0];
          if (match) {
            key = match[0];
            retainedOwner = owner ?? match[1].messageID;
          }
        }
        const latestUpdate = latestToolUpdateFor(owner, partID, latestPart)?.[1];
        const sequence = latestUpdate?.sequence ?? ++eventSeq;
        const existing = quarantinedToolParts.get(key);
        if (existing && existing.sequence > sequence) return;
        quarantinedToolParts.set(key, { messageID: retainedOwner, partID, part: latestPart, sequence });
      };
      const discardQuarantinedToolParts = (messageID: string | null, partIds: Set<string>): void => {
        for (const [key, toolPart] of quarantinedToolParts) {
          if (
            (messageID != null && toolPart.messageID === messageID) ||
            (toolPart.messageID == null && toolPart.partID != null && partIds.has(toolPart.partID))
          ) {
            quarantinedToolParts.delete(key);
          }
        }
      };
      const releaseQuarantinedToolParts = (messageID: string | null, partIds: Set<string>): void => {
        for (const [key, toolPart] of quarantinedToolParts) {
          const matchesMessage = messageID != null && toolPart.messageID === messageID;
          const matchesPart =
            toolPart.partID != null &&
            partIds.has(toolPart.partID) &&
            isPartOwnerOrUnassigned(toolPart.messageID, messageID);
          if (!matchesMessage && !matchesPart) continue;
          quarantinedToolParts.delete(key);
          // This function is called only after the enclosing message's exact
          // parent has been confirmed as the expected continuation turn.
          trackToolActivity(latestToolPart(toolPart.messageID, toolPart.partID, toolPart.part));
        }
      };
      const isExpectedTurn = (messageID: string | null, parentID: string | null): boolean =>
        expectedCurrentUserMessageId === undefined || parentForMessage(messageID, parentID) === expectedCurrentUserMessageId;
      const isOutsideExpectedTurn = (messageID: string | null, parentID: string | null): boolean => {
        if (expectedCurrentUserMessageId === undefined) return false;
        const knownParent = parentForMessage(messageID, parentID);
        return knownParent !== undefined && knownParent !== expectedCurrentUserMessageId;
      };
      const noteDeltaActivity = (partType: unknown): void => {
        receivedDelta = true;
        if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
        scheduleIdleTimer();
        if (!firstDeltaAt) {
          firstDeltaAt = Date.now();
          logDebug('SSE first delta', {
            sessionId,
            ms: firstDeltaAt - startedAt,
            type: partType,
          });
        }
      };
      const emitTextDelta = (partType: StreamPartType, deltaStr: string): void => {
        if (partType === 'reasoning') {
          reasoning += deltaStr;
          if (onDelta) onDelta(deltaStr, true);
        } else {
          content += deltaStr;
          if (onDelta) onDelta(deltaStr, false);
        }
        deltaChars += deltaStr.length;
      };
      const recordPartDelta = (state: StreamPartState, delta: string, afterSnapshot = true): void => {
        state.deltaText += delta;
        if (afterSnapshot) state.deltasAfterSnapshot += delta;
        state.deltaSeq = ++eventSeq;
        if (isKnownNonAssistantPartState(state)) return;
        // Continuation deltas do not count as progress until their message/part
        // is positively correlated to the current user turn. Legacy non-
        // continuation streams retain their role-unknown compatibility path.
        if (expectedCurrentUserMessageId === undefined || isAssistantPartState(state)) {
          noteDeltaActivity(state.type);
        }
        if (isAssistantPartState(state)) {
          emitTextDelta(state.type, delta);
        } else {
          // Keep the collector's legacy fallback text internally while
          // withholding it from the route callback until its role is known.
          if (state.type === 'reasoning') reasoning += delta;
          else content += delta;
          deltaChars += delta.length;
          if (onDelta) bufferedRoleUnknownDeltaSeen = true;
          // Do not expose role-unknown legacy deltas to route callbacks. If a
          // later message update identifies this as assistant, release them;
          // if it identifies user, purge them. Truly legacy unknown-role text
          // remains available only through final reconciliation.
          state.unreleasedDeltas.push({ delta, sequence: state.deltaSeq });
        }
      };
      const releaseAssistantDeltas = (messageID: string | null, partIds: Set<string> = new Set()): void => {
        const ready: { state: StreamPartState; delta: string; sequence: number }[] = [];
        for (const state of partStates.values()) {
          const matchesMessage = messageID != null && state.messageID === messageID;
          const matchesPart = state.partID != null && partIds.has(state.partID) && isPartOwnerOrUnassigned(state.messageID, messageID);
          if (!matchesMessage && !matchesPart) continue;
          if (!isAssistantPartState(state) || state.unreleasedDeltas.length === 0) continue;
          for (const pending of state.unreleasedDeltas) ready.push({ state, ...pending });
          state.unreleasedDeltas = [];
        }
        ready.sort((left, right) => left.sequence - right.sequence);
        for (const item of ready) {
          // These deltas were quarantined before parent metadata arrived, so
          // start the first-delta/idle activity clocks only when they are valid.
          noteDeltaActivity(item.state.type);
          if (onDelta) onDelta(item.delta, item.state.type === 'reasoning');
        }
      };
      const appendPartDelta = (state: StreamPartState, delta: string): void => {
        recordPartDelta(state, delta);
      };
      // Delta events may omit `messageID` while the part update carries it (or
      // vice versa), so pending lookups fall back to the part id alone. Numeric
      // ids are already stringified by readPartId.
      const findPendingKey = (messageID: string | null, partID: string): string | null => {
        const exact = idPartKey(messageID, partID);
        if (pendingDeltaParts.has(exact)) return exact;
        if (messageID != null) {
          const withoutMessageId = idPartKey(null, partID);
          return pendingDeltaParts.has(withoutMessageId) ? withoutMessageId : null;
        }
        for (const [key, pending] of pendingDeltaParts) {
          if (pending.partID === partID) return key;
        }
        return null;
      };
      const flushPendingDeltas = (state: StreamPartState): void => {
        if (state.partID == null) return;
        const key = findPendingKey(state.messageID, state.partID);
        if (key == null) return;
        const pending = pendingDeltaParts.get(key);
        if (!pending) return;
        pendingDeltaParts.delete(key);
        pending.deltas.forEach((delta) => appendPartDelta(state, delta));
      };
      const releaseAssistantPendingDeltas = (messageID: string | null, partIds: Set<string>): void => {
        for (const pending of [...pendingDeltaParts.values()]) {
          const matchesMessage = messageID != null && pending.messageID === messageID;
          const matchesPart = pending.partID != null && partIds.has(pending.partID) && isPartOwnerOrUnassigned(pending.messageID, messageID);
          if (!matchesMessage && !matchesPart) continue;
          const state = ensurePartState(messageID ?? pending.messageID, pending.partID, 'text', pending.order);
          flushPendingDeltas(state);
        }
      };
      const rememberPartRole = (messageID: string | null, role: string | null): void => {
        if (role == null || messageID == null) return;
        messageRoles.set(messageID, role);
      };
      const isStaleAssistantSnapshot = (info: Record<string, unknown>, role: string | null): boolean => {
        if (role !== 'assistant') return false;
        const created = asRecord(info['time'])['created'];
        return typeof created === 'number' && created < startedAt - 1000;
      };
      const isStalePart = (part: Record<string, unknown>): boolean => {
        const timeRecord = asRecord(part['time']);
        const created =
          typeof timeRecord['created'] === 'number'
            ? timeRecord['created']
            : typeof part['time'] === 'number'
              ? (part['time'] as number)
              : null;
        return typeof created === 'number' && created < startedAt - 1000;
      };
      const applyPartSnapshot = (
        part: Record<string, unknown>,
        order?: number,
      ): void => {
        const type = part['type'];
        if (type !== 'text' && type !== 'reasoning') return;
        if (isStalePart(part)) return;
        const partID = readPartId(part['id']);
        const messageID = resolvePartMessageId(readPartMessageId(part), partID);
        if (isPartOutsideExpectedTurn(part)) {
          if (failOnConfirmedPartParentMismatch(messageID, part)) return;
          discardPartData(messageID, partID);
          return;
        }
        if (messageID && staleMessageIds.has(messageID)) return;
        if (isRejectedPart(messageID, partID)) return;
        rememberPartMessageOwner(messageID, partID);
        const partRole = roleForPart(messageID, partID);
        if (partRole === 'user') return;
        const pendingKey = partID != null ? findPendingKey(messageID, partID) : null;
        const pendingOrder = pendingKey != null ? pendingDeltaParts.get(pendingKey)?.order : undefined;
        const state = ensurePartState(messageID, partID, type, order ?? pendingOrder);
        flushPendingDeltas(state);
        const text = part['text'];
        // Only a newer non-empty full text replaces the snapshot. An omitted or
        // empty `text` (status-only update) must not erase a complete snapshot.
        if (typeof text === 'string' && text) {
          state.snapshotText = text;
          state.snapshotSeq = ++eventSeq;
          state.deltasAfterSnapshot = '';
        }
      };
      const choosePartText = (state: StreamPartState): string => {
        const { deltaText, snapshotText, deltasAfterSnapshot, snapshotSeq, deltaSeq } = state;
        if (snapshotText === '') return deltaText;
        if (deltaText === '') return snapshotText;
        if (snapshotText === deltaText) return snapshotText;
        if (snapshotText.startsWith(deltaText)) return snapshotText;
        if (deltaText.startsWith(snapshotText)) return deltaText;
        // If deltas arrived after snapshotText was set, deltas were continuing:
        if (deltaSeq > snapshotSeq) {
          return `${snapshotText}${deltasAfterSnapshot}`;
        }
        // Snapshot arrived after deltas: snapshot is the authoritative replacement:
        return snapshotText;
      };
      const finalizeCollected = (extra: Record<string, unknown> = {}): Record<string, unknown> => {
        if (pendingDeltaParts.size > 0) {
          for (const [, pending] of pendingDeltaParts) {
            const pendingRole = roleForPart(pending.messageID, pending.partID);
            if (pendingRole === 'user') continue;
            if (pending.messageID && staleMessageIds.has(pending.messageID)) continue;
            const state = ensurePartState(pending.messageID, pending.partID, 'text', pending.order);
            pending.deltas.forEach((delta) => recordPartDelta(state, delta));
          }
          pendingDeltaParts.clear();
        }

        const states = [...partStates.values()].filter(
          (state) =>
            !isKnownNonAssistantPartState(state) &&
            !(state.messageID && staleMessageIds.has(state.messageID)) &&
            !(state.messageID && unverifiedAssistantMessageIds.has(state.messageID)) &&
            !(expectedCurrentUserMessageId !== undefined && !isAssistantPartState(state)),
        );
        let finalContent = content;
        let finalReasoning = reasoning;
        let unresolvedRoleUnknownDeltas = false;
        if (states.length > 0) {
          const joinedFor = (type: StreamPartType): string =>
            states
              .filter((state) => state.type === type)
              .sort((left, right) => left.order - right.order)
              .map((state) => choosePartText(state))
              .join('');
          finalContent = joinedFor('text');
          finalReasoning = joinedFor('reasoning');
          unresolvedRoleUnknownDeltas = states.some(
            (state) => roleForPart(state.messageID, state.partID) == null && state.unreleasedDeltas.length > 0,
          );
        } else if (
          sawUserParts ||
          sawStaleMessageParts ||
          sawUnverifiedAssistantParts ||
          [...partStates.values()].some((state) => isKnownNonAssistantPartState(state))
        ) {
          // If the only observed states were user messages, clear any leaked content
          finalContent = '';
          finalReasoning = '';
        }
        const result: Record<string, unknown> = {
          content: finalContent,
          reasoning: finalReasoning,
          ...extra,
        };
        // `authoritative` means reconciliation repaired/replaced live deltas, or
        // finalization is the only safe point to expose role-unknown legacy text.
        // Equal text (or empty/empty) keeps routes on the raw path so streamed
        // tool artifacts stay available.
        if (
          finalContent !== content ||
          finalReasoning !== reasoning ||
          (Boolean(onDelta) && bufferedRoleUnknownDeltaSeen && unresolvedRoleUnknownDeltas)
        ) {
          result['authoritative'] = true;
        }
        return result;
      };

      function failCollector(error: Error): void {
        terminalFinishSeen = true;
        finished = true;
        clearAllTimers();
        controller.abort();
        // A correlation failure invalidates any previously reconciled raw text;
        // do not let it escape as a successful partial answer.
        content = '';
        reasoning = '';
        partStates.clear();
        pendingDeltaParts.clear();
        quarantinedToolParts.clear();
        resolve(finalizeCollected({ error }));
      }

      const failOnConfirmedPartParentMismatch = (
        messageID: string | null,
        part: Record<string, unknown>,
      ): boolean => {
        const explicitParent = readParentMessageId(part);
        if (
          expectedCurrentUserMessageId === undefined ||
          explicitParent == null ||
          explicitParent === expectedCurrentUserMessageId ||
          messageID == null ||
          assistantMessageParents.get(messageID) !== expectedCurrentUserMessageId
        ) {
          return false;
        }
        failCollector(new Error('Continuation correlation error: assistant part parent mismatch'));
        return true;
      };

      (async (): Promise<void> => {
        try {
          for await (const event of eventStream) {
             const evType: unknown = (event as Record<string, unknown>)['type'];
             const props = asRecord((event as Record<string, unknown>)['properties']);
             if (finished) break;
             if (evType === 'session.error' && (props['sessionID'] == null || props['sessionID'] === sessionId)) {
               const sessionError = readSessionEventError(props);
               terminalFinishSeen = true;
               finished = true;
               clearAllTimers();
               controller.abort();
               logDebug('SSE session error', { sessionId, ms: Date.now() - startedAt });
               resolve(finalizeCollected({ error: sessionError }));
               break;
             }
               if (evType === 'message.part.updated' && asRecord(props['part'])['sessionID'] === sessionId) {
                 const rawPart = asRecord(props['part']);
                 const explicitPartMessageID = readPartMessageId(rawPart) ?? readPartMessageId(props);
                 const partID = readPartId(rawPart['id']);
                 if (isAmbiguousOwnerlessPart(explicitPartMessageID, partID)) continue;
                 const part = explicitPartMessageID != null && readPartMessageId(rawPart) == null
                   ? { ...rawPart, messageID: explicitPartMessageID }
                   : rawPart;
                 const partType = part['type'];
                const partMessageID = resolvePartMessageId(explicitPartMessageID, partID);
                  if (isPartOutsideExpectedTurn(part)) {
                    if (failOnConfirmedPartParentMismatch(partMessageID, part)) break;
                    discardPartData(partMessageID, partID);
                   continue;
                }
                const knownParent = parentForPart(partMessageID, partID);
                 if (expectedCurrentUserMessageId !== undefined && knownParent != null && knownParent !== expectedCurrentUserMessageId) {
                   if (partMessageID != null) discardMessageParts(partMessageID, new Set(partID == null ? [] : [partID]));
                   else if (partID != null) discardUnownedParts(new Set([partID]));
                   continue;
                 }
                 rememberPartMessageOwner(partMessageID, partID);
                 const missingExpectedTurn = expectedCurrentUserMessageId !== undefined && knownParent !== expectedCurrentUserMessageId;
                if (missingExpectedTurn) {
                  sawUnverifiedAssistantParts = true;
                  if (partMessageID != null) unverifiedAssistantMessageIds.add(partMessageID);
                 }
                if (isRejectedPart(partMessageID, partID) || (partMessageID != null && staleMessageIds.has(partMessageID))) continue;
                if (isStalePart(part) || (partMessageID != null && staleMessageIds.has(partMessageID))) {
                  if (partMessageID != null && staleMessageIds.has(partMessageID)) {
                    discardMessageParts(partMessageID, new Set(partID == null ? [] : [partID]));
                  }
                  if (isStalePart(part) && partID != null) rememberRejectedPart(partMessageID, partID);
                  continue;
                }
                if (isUserPart(partMessageID) && partID != null) rememberUserPart(partMessageID, partID);
                if (isUserPart(partMessageID) || isUserPartId(partMessageID, partID)) {
                  sawUserParts = true;
                  for (const [key, state] of partStates) {
                    if (
                      (partID != null && state.partID === partID && isPartOwnerOrUnassigned(state.messageID, partMessageID)) ||
                      (partMessageID != null && state.messageID === partMessageID)
                    ) {
                      partStates.delete(key);
                   }
                 }
                  for (const [key, pending] of pendingDeltaParts) {
                    if (
                      (partID != null && pending.partID === partID && isPartOwnerOrUnassigned(pending.messageID, partMessageID)) ||
                      (partMessageID != null && pending.messageID === partMessageID)
                    ) {
                     pendingDeltaParts.delete(key);
                   }
                 }
               }
               // A user prompt's text/reasoning parts must never become assistant
               // answer/tool content. When the role is still unknown the part is
                // stored and filtered at finalize if the role later turns out user.
                const partRole = roleForPart(partMessageID, partID);
                if ((partType === 'text' || partType === 'reasoning') && partRole !== 'user') {
                  const textUpdated = typeof part['text'] === 'string' && Boolean(part['text']);
                  applyPartSnapshot(part);
                  if (finished) break;
                // Older OpenCode servers carried the streaming delta directly on
                // message.part.updated; newer servers emit message.part.delta.
                const delta: unknown = props['delta'];
                if (typeof delta === 'string' && delta) {
                  if (isRejectedPart(partMessageID, partID)) continue;
                  const state = ensurePartState(partMessageID, partID, partType);
                  recordPartDelta(state, delta, !textUpdated);
                }
              }
                 if (partRole !== 'user') {
                   rememberToolPartUpdate(partMessageID, part);
                   if (expectedCurrentUserMessageId === undefined || knownParent === expectedCurrentUserMessageId) {
                    trackToolActivity(latestToolPart(partMessageID, partID, part));
                  } else if (partType === 'tool') {
                    quarantineToolPart(partMessageID, partID, latestToolPart(partMessageID, partID, part));
                  }
                }

              continue;
            }
            if (evType === 'message.part.delta' && props['sessionID'] === sessionId) {
              const partID = readPartId(props['partID']);
              const delta: unknown = props['delta'];
              const field: unknown = props['field'];
              // Text and reasoning deltas both stream through field === 'text'.
              // Tool-input deltas surface via message.part.updated tool state.
             if (typeof delta === 'string' && delta && field === 'text' && partID != null) {
                const explicitPartMessageID = readPartMessageId(props);
                if (isAmbiguousOwnerlessPart(explicitPartMessageID, partID)) continue;
                const partMessageID = resolvePartMessageId(explicitPartMessageID, partID);
                const partRole = roleForPart(partMessageID, partID);
                if (isPartOutsideExpectedTurn(props)) {
                  if (failOnConfirmedPartParentMismatch(partMessageID, props)) break;
                  discardPartData(partMessageID, partID);
                  continue;
                }
                const knownParent = parentForPart(partMessageID, partID);
                if (expectedCurrentUserMessageId !== undefined && knownParent != null && knownParent !== expectedCurrentUserMessageId) {
                  if (partMessageID != null) discardMessageParts(partMessageID, new Set([partID]));
                  else discardUnownedParts(new Set([partID]));
                  continue;
                }
                rememberPartMessageOwner(partMessageID, partID);
                const missingExpectedTurn = expectedCurrentUserMessageId !== undefined && knownParent !== expectedCurrentUserMessageId;
                if (isRejectedPart(partMessageID, partID) || partRole === 'user' || (partMessageID != null && staleMessageIds.has(partMessageID))) {
                  continue;
                }
                if (missingExpectedTurn) {
                  sawUnverifiedAssistantParts = true;
                  if (partMessageID != null) unverifiedAssistantMessageIds.add(partMessageID);
                 }
                const state = findPartState(partMessageID, partID);
                if (state) {
                  appendPartDelta(state, delta);
                } else {
                  // Type not announced yet; keep the delta (numeric IDs already
                  // stringified) until the part update arrives.
                  if (!missingExpectedTurn) noteDeltaActivity(undefined);
                  const existingKey = findPendingKey(partMessageID, partID);
                  if (existingKey != null) {
                    pendingDeltaParts.get(existingKey)?.deltas.push(delta);
                  } else {
                    pendingDeltaParts.set(idPartKey(partMessageID, partID), {
                      deltas: [delta],
                      order: ++partOrderCounter,
                      messageID: partMessageID,
                      partID,
                    });
                  }
                }
              }
              continue;
            }
            if (evType === 'message.updated' && asRecord(props['info'])['sessionID'] === sessionId) {
                const info = asRecord(props['info']);
                const finish: unknown = info['finish'];
                const messageID = readInfoMessageId(info);
                const role = typeof info['role'] === 'string' ? (info['role'] as string) : null;
                const parentID = readParentMessageId(info);
                const previouslyConfirmedParent = messageID == null ? undefined : assistantMessageParents.get(messageID);
                if (
                  role !== 'user' &&
                  expectedCurrentUserMessageId !== undefined &&
                  previouslyConfirmedParent === expectedCurrentUserMessageId &&
                  parentID != null &&
                  parentID !== expectedCurrentUserMessageId
                ) {
                  failCollector(new Error('Continuation correlation error: assistant message parent changed'));
                  break;
                }
                if (messageID != null && parentID != null) {
                  assistantMessageParents.set(messageID, parentID);
                }
                if (role !== 'user' && expectedCurrentUserMessageId !== undefined && isOutsideExpectedTurn(messageID, parentID)) {
                  const partIds = new Set<string>(
                    (Array.isArray(info['parts']) ? info['parts'] as unknown[] : [])
                      .map((rawPart) => readPartId(asRecord(rawPart)['id']))
                      .filter((id): id is string => id != null),
                  );
                  if (messageID != null) {
                    for (const partID of partIds) rememberPartMessageOwner(messageID, partID);
                    discardMessageParts(messageID, partIds);
                  } else discardUnownedParts(partIds);
                  continue;
                }
                if (role !== 'user' && !isExpectedTurn(messageID, parentID)) {
                  sawUnverifiedAssistantParts = true;
                  if (messageID != null) unverifiedAssistantMessageIds.add(messageID);
                  rememberPartRole(messageID, role);
                  // Missing turn metadata is not evidence that this message
                  // belongs to the continuation. Keep its data quarantined, but
                  // do not let it emit or finish the expected turn.
                  if (Array.isArray(info['parts'])) {
                    (info['parts'] as unknown[]).forEach((rawPart) => {
                      const part = asRecord(rawPart);
                      const partID = readPartId(part['id']);
                      rememberPartMessageOwner(messageID, partID);
                      if (partID != null && role != null) {
                        rememberPartOwner(assistantPartOwners, assistantPartIdsWithoutOwner, messageID, partID);
                      }
                      const messagePart = messageID != null && readPartMessageId(part) == null
                        ? { ...part, messageID }
                        : part;
                      if (part['type'] === 'tool') {
                        quarantineToolPart(messageID, readPartId(part['id']), messagePart);
                      }
                      applyPartSnapshot(messagePart);
                    });
                  }
                  continue;
                }
                if (isStaleAssistantSnapshot(info, role)) {
                  logDebug('Ignoring stale assistant message snapshot', {
                    sessionId,
                    messageID,
                    created: asRecord(info['time'])['created'],
                  });
                  if (messageID != null) {
                    const partIds = new Set<string>(
                      (Array.isArray(info['parts']) ? info['parts'] as unknown[] : [])
                        .map((rawPart) => readPartId(asRecord(rawPart)['id']))
                        .filter((id): id is string => id != null),
                    );
                    for (const partID of partIds) rememberPartMessageOwner(messageID, partID);
                    discardMessageParts(messageID, partIds);
                  }
                  continue;
                }
                if (role !== 'user' && messageID != null) {
                  unverifiedAssistantMessageIds.delete(messageID);
                }
                rememberPartRole(messageID, role);
                const classifiedPartIds = new Set<string>();
                if (role != null) {
                  for (const rawPart of Array.isArray(info['parts']) ? info['parts'] as unknown[] : []) {
                    const rawPartRecord = asRecord(rawPart);
                    const partID = readPartId(asRecord(rawPart)['id']);
                    if (partID == null) continue;
                    if (isPartOutsideExpectedTurn(rawPartRecord)) {
                      if (failOnConfirmedPartParentMismatch(messageID, rawPartRecord)) break;
                      discardPartData(messageID, partID);
                      continue;
                    }
                    classifiedPartIds.add(partID);
                    rememberPartMessageOwner(messageID, partID);
                    if (role === 'user') rememberUserPart(messageID, partID);
                    else {
                      rememberPartOwner(assistantPartOwners, assistantPartIdsWithoutOwner, messageID, partID);
                      if (parentID != null) assistantPartParents.set(idPartKey(messageID, partID), parentID);
                    }
                  }
                }
                if (finished) break;
                // User prompt snapshots are never assistant output: skipping the
                // whole update also prevents a user `finish` from ending the turn.
                if (role === 'user') {
                  sawUserParts = true;
                  if (messageID != null) {
                    for (const [key, st] of partStates) {
                      if (st.messageID === messageID) {
                        if (st.partID != null) rememberUserPart(messageID, st.partID);
                        partStates.delete(key);
                      }
                    }
                  }
                  for (const partID of classifiedPartIds) {
                    for (const [key, st] of partStates) {
                      if (st.partID === partID && isPartOwnerOrUnassigned(st.messageID, messageID)) partStates.delete(key);
                    }
                  }
                  for (const [key, pending] of pendingDeltaParts) {
                    const matchesMessage = messageID != null && pending.messageID === messageID;
                    const matchesPart = pending.partID != null && classifiedPartIds.has(pending.partID) && isPartOwnerOrUnassigned(pending.messageID, messageID);
                    if (matchesMessage || matchesPart) {
                      if (pending.partID != null) rememberUserPart(messageID, pending.partID);
                      pendingDeltaParts.delete(key);
                    }
                  }
                  continue;
                }
                if (role === 'assistant' || expectedCurrentUserMessageId !== undefined) {
                  releaseAssistantDeltas(messageID, classifiedPartIds);
                  releaseAssistantPendingDeltas(messageID, classifiedPartIds);
                }
              if (typeof finish === 'string') lastFinish = finish;
              // An aborted or failed message never produces another delta. Without
              // this, the collector waits out the whole first-delta window before
              // polling rediscovers the same error.
              const infoError: unknown = info['error'];
              if (infoError != null) {
                terminalFinishSeen = true;
                finished = true;
                clearAllTimers();
                logDebug('SSE upstream message error', {
                  sessionId,
                  ms: Date.now() - startedAt,
                  error: (asRecord(infoError)['name'] as unknown) || 'UnknownError',
                });
                resolve(finalizeCollected({ error: infoError }));
                break;
              }
              // Reconcile active tool calls and per-part text snapshots from the
              // full message snapshot so we detect pending tools even when only
              // message.updated fires.
                if (Array.isArray(info['parts'])) {
                  const snapshotParts = info['parts'] as unknown[];
                  snapshotParts.forEach((rawPart, index) => {
                    const part = asRecord(rawPart);
                    // `info.parts` is ordered; the array index is authoritative for
                    // joining multiple text/reasoning parts.
                    const messagePart = {
                      ...part,
                      ...(messageID != null && readPartMessageId(part) == null ? { messageID } : {}),
                      ...(parentID != null && readParentMessageId(part) == null ? { parentID } : {}),
                    };
                    rememberPartMessageOwner(messageID, readPartId(part['id']));
                    if (isPartOutsideExpectedTurn(messagePart)) {
                      if (failOnConfirmedPartParentMismatch(messageID, messagePart)) return;
                      discardPartData(messageID, readPartId(part['id']));
                      return;
                    }
                    applyPartSnapshot(messagePart, index);
                    if (part['type'] === 'tool') {
                      if (expectedCurrentUserMessageId === undefined) {
                        trackToolState(latestToolPart(messageID, readPartId(part['id']), messagePart));
                      } else {
                        quarantineToolPart(messageID, readPartId(part['id']), messagePart);
                      }
                    }
                  });
                  if (finished) break;
                  if (role === 'assistant' || expectedCurrentUserMessageId !== undefined) {
                    releaseAssistantDeltas(messageID, classifiedPartIds);
                    releaseAssistantPendingDeltas(messageID, classifiedPartIds);
                  }
                // New parts observed after this snapshot must sort after it.
                partOrderCounter = Math.max(partOrderCounter, snapshotParts.length);
              }
              if (expectedCurrentUserMessageId !== undefined) {
                releaseQuarantinedToolParts(messageID, classifiedPartIds);
              }
              if (finish === 'tool' || finish === 'tool-calls') {
                // Assistant turn ended pending a tool call; keep waiting for the result.
                if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                scheduleIdleTimer();
                continue;
              }
              if (finish === 'stop') {
                // Only treat the stream as completed when no tool call is still
                // pending. OpenCode may emit an intermediate 'stop' snapshot while a
                // tool call is in flight; resolving on it would drop the final answer.
                if (hasActiveTools()) {
                  logDebug('Ignoring intermediate stop while tools are active', {
                    sessionId,
                    activeTools: activeToolCount(),
                  });
                  continue;
                }
                terminalFinishSeen = true;
                if (!finished) {
                  finished = true;
                  clearAllTimers();
                  logDebug('SSE completed', {
                    sessionId,
                    ms: Date.now() - startedAt,
                    deltaChars,
                  });
                  const result = finalizeCollected({ finish: 'stop' });
                  if (!(result['content'] as string) && !(result['reasoning'] as string)) {
                    result['noData'] = true;
                  }
                  resolve(result);
                }
                break;
              }
            }
          }
          if (!finished) {
            finished = true;
            clearAllTimers();
            logDebug('SSE eventStream ended naturally', {
              sessionId,
              ms: Date.now() - startedAt,
              terminalFinishSeen,
              deltaChars,
            });
            if (!terminalFinishSeen) {
              const result = finalizeCollected({ cut: true, ...(lastFinish ? { finish: lastFinish } : {}) });
              if (!(result['content'] as string) && !(result['reasoning'] as string)) {
                result['noData'] = true;
              }
              resolve(result);
            } else {
              const result = finalizeCollected({ ...(lastFinish ? { finish: lastFinish } : {}) });
              if (!(result['content'] as string) && !(result['reasoning'] as string)) {
                result['noData'] = true;
              }
              resolve(result);
            }
          }
        } catch (e: unknown) {
          if (!finished) {
            finished = true;
            clearAllTimers();
            reject(e);
          }
        }
      })();
    });

    try {
      return await finishPromise;
     } finally {
       removeCollectAbortListener();
       controller.abort();
     }

  }

  return { extractFromParts, promptWithTimeout, pollForAssistantResponse, collectFromEvents };
}
