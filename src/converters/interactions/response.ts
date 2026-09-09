/**
 * interactions <-> {chat, responses, messages} response translators
 * (non-stream core + chat->interactions stream core).
 *
 * Ports of CLIProxyAPI:
 * - `openai/interactions/chat-completions/openai_interactions_response.go`
 *   (ConvertInteractionsResponseToOpenAI{,NonStream}) and
 *   `interactions_openai_response.go` (ConvertOpenAIResponseToInteractions{,NonStream})
 * - `openai/interactions/responses/interactions_openai_responses_response.go`
 * - `claude/interactions/` + `interactions/claude/` response files (core shapes)
 *
 * Gateway wire preserved: interaction bodies carry NO token usage — only
 * `usage.grounding_tool_count: [{type, count}]` (routes/interactions.ts:412);
 * translated responses never ran grounding, so count is 0. Stream is
 * created->step.delta(500-slice)->completed with NO [DONE] (route-owned).
 *
 * NOTE vs upstream Go: CLIProxyAPI interactions translators passthrough token
 * usage plus `[DONE]`/event_type envelopes for Google backends; this
 * gateway adapts to the LOCAL route wire (grounding count + bare data:),
 * so events intentionally differ from Go while request field mapping follows it.
 * Stream completed events carry no usage object, matching the route
 * (interactions.ts:376 emits interaction{id,status,output_text,steps} only;
 * usage appears solely in non-stream bodies, interactions.ts:412).
 */

import { asRecord } from '../../utils/guards.js';
import { str, targetId } from '../json.js';

function newInteractionId(): string {
    try {
        if (typeof globalThis.crypto?.randomUUID === 'function') {
            return `intr_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
        }
    } catch {
        // fall through
    }
    return `intr_${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function chatTextOf(body: unknown): string {
    const root = asRecord(body);
    const choices = Array.isArray(root['choices']) ? (root['choices'] as unknown[]) : [];
    const message = asRecord(asRecord(choices[0])['message']);
    const content = message['content'];
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((p) => str(asRecord(p)['text'])).filter(Boolean).join('');
    }
    return '';
}

/** chat.completion -> interaction (non-stream). Tool calls dropped (no function tools). */
export function convertChatResponseToInteractionsNonStream(
    model: string,
    _originalRequest: unknown,
    _translatedRequest: unknown,
    body: unknown,
): unknown {
    return {
        id: targetId(asRecord(body)['id'], 'intr_', newInteractionId),
        status: 'completed',
        model,
        output_text: chatTextOf(body),
        steps: [],
        usage: { grounding_tool_count: [{ type: 'google_search', count: 0 }] },
    };
}

/** interaction -> chat.completion (non-stream). */
export function convertInteractionsResponseToChatNonStream(
    model: string,
    _originalRequest: unknown,
    _translatedRequest: unknown,
    body: unknown,
): unknown {
    const root = asRecord(body);
    return {
        id: targetId(root['id'], 'chatcmpl-', () => `chatcmpl-${Date.now().toString(36)}`),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: str(root['output_text']) || null }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
}

function responsesTextOf(body: unknown): string {
    const root = asRecord(body);
    const output = Array.isArray(root['output']) ? (root['output'] as unknown[]) : [];
    let text = '';
    for (const item of output) {
        const it = asRecord(item);
        if (str(it['type']) !== 'message') continue;
        for (const c of Array.isArray(it['content']) ? (it['content'] as unknown[]) : []) {
            if (str(asRecord(c)['type']) === 'output_text') text += str(asRecord(c)['text']);
        }
    }
    return text;
}

/** responses.response -> interaction (non-stream). */
export function convertResponsesResponseToInteractionsNonStream(
    model: string,
    _originalRequest: unknown,
    _translatedRequest: unknown,
    body: unknown,
): unknown {
    return {
        id: targetId(asRecord(body)['id'], 'intr_', newInteractionId),
        status: 'completed',
        model,
        output_text: responsesTextOf(body),
        steps: [],
        usage: { grounding_tool_count: [{ type: 'google_search', count: 0 }] },
    };
}

/** interaction -> responses.response (non-stream). */
export function convertInteractionsResponseToResponsesNonStream(
    model: string,
    _originalRequest: unknown,
    _translatedRequest: unknown,
    body: unknown,
): unknown {
    const root = asRecord(body);
    const text = str(root['output_text']);
    return {
        id: targetId(root['id'], 'resp_', () => `resp_${Date.now().toString(36)}`),
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        model,
        status: 'completed',
        output: text ? [{ type: 'message', id: 'msg_0', role: 'assistant', content: [{ type: 'output_text', text }] }] : [],
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    };
}

function messagesTextOf(body: unknown): string {
    const root = asRecord(body);
    const content = Array.isArray(root['content']) ? (root['content'] as unknown[]) : [];
    // Text-only contract: thinking blocks are reasoning traces, never
    // user-visible output — drop them instead of concatenating.
    return content
        .map((c) => {
            const b = asRecord(c);
            if (str(b['type']) !== 'text') return '';
            return str(b['text']);
        })
        .filter(Boolean)
        .join('');
}

/** messages.message -> interaction (non-stream). */
export function convertMessagesResponseToInteractionsNonStream(
    model: string,
    _originalRequest: unknown,
    _translatedRequest: unknown,
    body: unknown,
): unknown {
    return {
        id: targetId(asRecord(body)['id'], 'intr_', newInteractionId),
        status: 'completed',
        model,
        output_text: messagesTextOf(body),
        steps: [],
        usage: { grounding_tool_count: [{ type: 'google_search', count: 0 }] },
    };
}

/** interaction -> messages.message (non-stream). */
export function convertInteractionsResponseToMessagesNonStream(
    model: string,
    _originalRequest: unknown,
    _translatedRequest: unknown,
    body: unknown,
): unknown {
    const root = asRecord(body);
    const text = str(root['output_text']);
    return {
        id: targetId(root['id'], 'msg_', () => `msg_${Date.now().toString(36)}`),
        type: 'message',
        role: 'assistant',
        model,
        content: text ? [{ type: 'text', text }] : [],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
    };
}

export interface InteractionStreamEvent {
    type: string;
    [key: string]: unknown;
}

/**
 * Stateful chat-chunk -> interaction-events translator (one instance per stream).
 * Mirrors route wire (interactions.ts:335-376): interaction.created ->
 * step.delta (500-char slices) -> interaction.completed. Completed is deferred
 * until the terminal chunk carrying finish_reason.
 */
export function createChatToInteractionsStreamTranslator(model: string, interactionId?: string) {
    const id = interactionId || newInteractionId();
    let created = false;
    let completed = false;
    let buffer = '';
    let fullText = '';

    const flushDeltas = (): InteractionStreamEvent[] => {
        const events: InteractionStreamEvent[] = [];
        while (buffer.length >= 500) {
            events.push({ type: 'step.delta', interaction_id: id, delta: buffer.slice(0, 500) });
            buffer = buffer.slice(500);
        }
        return events;
    };

    return (chunk: unknown): InteractionStreamEvent[] => {
        if (completed) return [];
        const events: InteractionStreamEvent[] = [];
        if (!created) {
            created = true;
            events.push({ type: 'interaction.created', interaction: { id, status: 'in_progress', model } });
        }
        const root = asRecord(chunk);
        const choices = Array.isArray(root['choices']) ? (root['choices'] as unknown[]) : [];
        const delta = asRecord(asRecord(choices[0])['delta']);
        const content = delta['content'];
        if (typeof content === 'string' && content) {
            buffer += content;
            fullText += content;
            events.push(...flushDeltas());
        }
        const finish = str(asRecord(choices[0])['finish_reason']);
        if (finish) {
            if (buffer) {
                events.push({ type: 'step.delta', interaction_id: id, delta: buffer });
                buffer = '';
            }
            // Route non-stream carries the full text (interactions.ts:410);
            // stream completed mirrors it instead of emitting ''.
            // steps: [] mirrors the no-grounding case (route appends
            // model_output/grounding steps only when search ran).
            events.push({ type: 'interaction.completed', interaction: { id, status: 'completed', output_text: fullText, steps: [] } });
            completed = true;
        }
        return events;
    };
}

/**
 * Text-core stream translators for the remaining interactions edges.
 * P4 covers text deltas + terminal mapping; grounding-step streaming and
 * tool deltas are P4+ (route executes grounding server-side).
 * TODO(P4+): google_search_call searching/completed step events, per-step indices.
 */
export function createInteractionsToChatStreamTranslator(model: string, completionId?: string) {
    const id = completionId || `chatcmpl-${Date.now().toString(36)}`;
    let done = false;
    return (event: unknown): Record<string, unknown>[] => {
        if (done) return [];
        const ev = asRecord(event);
        const type = str(ev['type']);
        const created = Math.floor(Date.now() / 1000);
        if (type === 'step.delta' && str(ev['delta'])) {
            return [{ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: str(ev['delta']) }, finish_reason: null }] }];
        }
        if (type === 'interaction.completed') {
            done = true;
            // Source carries no tokens: zero-filled chat usage leg.
            return [{ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }];
        }
        return [];
    };
}

/** interaction events -> responses events (text-core). */
export function createInteractionsToResponsesStreamTranslator(model: string, responseId?: string) {
    const id = responseId || `resp_${Date.now().toString(36)}`;
    let created = false;
    let seq = 0;
    let completed = false;
    return (event: unknown): Record<string, unknown>[] => {
        if (completed) return [];
        const ev = asRecord(event);
        const out: Record<string, unknown>[] = [];
        if (!created) {
            created = true;
            out.push({ type: 'response.created', sequence_number: seq++, response: { id, object: 'response', model, status: 'in_progress' } });
        }
        if (str(ev['type']) === 'step.delta' && str(ev['delta'])) {
            out.push({ type: 'response.output_text.delta', sequence_number: seq++, item_id: 'msg_0', output_index: 0, content_index: 0, delta: str(ev['delta']) });
        }
        if (str(ev['type']) === 'interaction.completed') {
            completed = true;
            out.push({ type: 'response.completed', sequence_number: seq++, response: { id, object: 'response', model, status: 'completed', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
        }
        return out;
    };
}

/** interaction events -> Anthropic SSE (text-core). */
export function createInteractionsToMessagesStreamTranslator(model: string, messageId?: string) {
    const id = messageId || `msg_${Date.now().toString(36)}`;
    let started = false;
    let textIx = -1;
    let stopped = false;
    return (event: unknown): { event: string; data: unknown }[] => {
        if (stopped) return [];
        const ev = asRecord(event);
        const out: { event: string; data: unknown }[] = [];
        if (!started) {
            started = true;
            out.push({ event: 'message_start', data: { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } } });
        }
        if (str(ev['type']) === 'step.delta' && str(ev['delta'])) {
            // Lazy text block (matches chat/responses->messages): empty
            // streams emit no content block at all.
            if (textIx < 0) {
                textIx = 0;
                out.push({ event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
            }
            out.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: str(ev['delta']) } } });
        }
        if (str(ev['type']) === 'interaction.completed') {
            stopped = true;
            if (textIx >= 0) out.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: textIx } });
            out.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 0, output_tokens: 0 } } });
            out.push({ event: 'message_stop', data: { type: 'message_stop' } });
        }
        return out;
    };
}

/** responses events -> interaction events (text-core). */
export function createResponsesToInteractionsStreamTranslator(model: string, interactionId?: string) {
    const id = interactionId || newInteractionId();
    let created = false;
    let completed = false;
    let fullText = '';
    return (event: unknown): InteractionStreamEvent[] => {
        if (completed) return [];
        const ev = asRecord(event);
        const out: InteractionStreamEvent[] = [];
        if (!created) {
            created = true;
            out.push({ type: 'interaction.created', interaction: { id, status: 'in_progress', model } });
        }
        if (str(ev['type']) === 'response.output_text.delta' && str(ev['delta'])) {
            fullText += str(ev['delta']);
            out.push({ type: 'step.delta', interaction_id: id, delta: str(ev['delta']) });
        }
        if (str(ev['type']) === 'response.completed') {
            completed = true;
            out.push({ type: 'interaction.completed', interaction: { id, status: 'completed', output_text: fullText, steps: [] } });
        }
        return out;
    };
}

/** Anthropic SSE -> interaction events (text-core). */
export function createMessagesToInteractionsStreamTranslator(model: string, interactionId?: string) {
    const id = interactionId || newInteractionId();
    let created = false;
    let completed = false;
    let fullText = '';
    return (event: unknown): InteractionStreamEvent[] => {
        if (completed) return [];
        const ev = asRecord(event);
        const out: InteractionStreamEvent[] = [];
        if (!created) {
            created = true;
            out.push({ type: 'interaction.created', interaction: { id, status: 'in_progress', model } });
        }
        if (str(ev['event']) === 'content_block_delta') {
            const text = str(asRecord(asRecord(ev['data'])['delta'])['text']);
            if (text) {
                fullText += text;
                out.push({ type: 'step.delta', interaction_id: id, delta: text });
            }
        }
        if (str(ev['event']) === 'message_stop') {
            completed = true;
            out.push({ type: 'interaction.completed', interaction: { id, status: 'completed', output_text: fullText, steps: [] } });
        }
        return out;
    };
}
