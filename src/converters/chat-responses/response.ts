/**
 * chat <-> responses response translators.
 *
 * chat->responses direction ports CLIProxyAPI
 * `internal/translator/openai/openai/responses/openai_openai-responses_response.go`
 * (response.completed deferred until [DONE], function_call_arguments.delta
 * streaming, late usage buffering). responses->chat is the symmetric inverse.
 *
 * Pure functions only. SSE envelopes (`data:` / `[DONE]`) stay in routes —
 * translators emit event payload objects only, preserving wire contracts.
 */

import { asRecord } from '../../utils/guards.js';
import { usageToChat } from '../usage.js';

function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function newResponseId(): string {
    try {
        if (typeof globalThis.crypto?.randomUUID === 'function') {
            return `resp_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
        }
    } catch {
        // fall through
    }
    return `resp_${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
}

interface ChatToolCallLike {
    id: string;
    name: string;
    args: string;
}

/** chat.completion (non-stream) -> responses.response (non-stream). */
export function convertChatResponseToResponsesNonStream(
    model: string,
    _originalRequest: unknown,
    _translatedRequest: unknown,
    body: unknown,
): unknown {
    const root = asRecord(body);
    const choices = Array.isArray(root['choices']) ? (root['choices'] as unknown[]) : [];
    const first = asRecord(choices[0]);
    const message = asRecord(first['message']);
    const finish = str(first['finish_reason']);
    const text = str(message['content']);
    const rawCalls = Array.isArray(message['tool_calls']) ? (message['tool_calls'] as unknown[]) : [];
    const calls: ChatToolCallLike[] = rawCalls.map((tc) => {
        const t = asRecord(tc);
        const fn = asRecord(t['function']);
        return { id: str(t['id']), name: str(fn['name']), args: str(fn['arguments']) || '{}' };
    });
    const usage = asRecord(root['usage']);

    const output: Record<string, unknown>[] = [];
    if (text) {
        output.push({
            type: 'message',
            id: 'msg_0',
            role: 'assistant',
            content: [{ type: 'output_text', text }],
        });
    }
    for (const c of calls) {
        output.push({ type: 'function_call', call_id: c.id, id: c.id, name: c.name, arguments: c.args });
    }

    let incomplete: Record<string, unknown> | null = null;
    if (finish === 'length') incomplete = { reason: 'max_output_tokens' };
    else if (finish === 'content_filter') incomplete = { reason: 'content_filter' };

    return {
        id: str(root['id']) || newResponseId(),
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        model,
        status: incomplete ? 'incomplete' : 'completed',
        ...(incomplete ? { incomplete_details: incomplete } : {}),
        output,
        usage: {
            input_tokens: num(usage['prompt_tokens']),
            output_tokens: num(usage['completion_tokens']),
            total_tokens: num(usage['total_tokens']),
        },
    };
}

/** responses.response (non-stream) -> chat.completion (non-stream). */
export function convertResponsesResponseToChatNonStream(
    model: string,
    _originalRequest: unknown,
    _translatedRequest: unknown,
    body: unknown,
): unknown {
    const root = asRecord(body);
    const output = Array.isArray(root['output']) ? (root['output'] as unknown[]) : [];
    let text = '';
    const toolCalls: Record<string, unknown>[] = [];
    for (const item of output) {
        const it = asRecord(item);
        const t = str(it['type']);
        if (t === 'message') {
            const content = it['content'];
            if (Array.isArray(content)) {
                for (const c of content) {
                    const cp = asRecord(c);
                    if (str(cp['type']) === 'output_text') text += str(cp['text']);
                }
            }
        } else if (t === 'function_call') {
            toolCalls.push({
                id: str(it['call_id'] ?? it['id']),
                type: 'function',
                function: { name: str(it['name']), arguments: str(it['arguments']) || '{}' },
            });
        }
    }
    const usage = asRecord(root['usage']);
    const finish = toolCalls.length ? 'tool_calls' : 'stop';
    return {
        id: str(root['id']) || `chatcmpl-${Date.now().toString(36)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
            {
                index: 0,
                message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
                finish_reason: finish,
            },
        ],
        usage: {
            prompt_tokens: num(usage['input_tokens']),
            completion_tokens: num(usage['output_tokens']),
            total_tokens: num(usage['total_tokens']),
        },
    };
}

export interface ResponsesStreamEvent {
    type: string;
    [key: string]: unknown;
}

/**
 * Stateful chat-chunk -> responses-events translator (one instance per stream).
 * Mirrors the Go `oaiToResponsesState` aggregation: response.created first,
 * per-tool-call output_item.added/args-delta/done, message text delta, and
 * response.completed deferred until the terminal chunk carrying finish_reason
 * (and late usage when present).
 */
export function createChatToResponsesStreamTranslator(model: string, responseId?: string) {
    const id = responseId || newResponseId();
    let created = false;
    let seq = 0;
    let msgItemAdded = false;
    let contentAdded = false;
    const funcAdded = new Set<string>();
    const funcDone = new Set<string>();
    const funcArgs = new Map<string, string>();
    const funcNameOf = new Map<string, string>();
    const funcOutIx = new Map<string, number>();
    let msgText = '';
    // OpenAI streams the tool_call id only on the first delta for an index;
    // later deltas carry index alone — bind identity by index (Go keeps
    // FuncCallIDs/FuncOutputIx per index for the same reason).
    const indexKey = new Map<number, string>();
    let completed = false;
    // TODO(P4): full Go oaiToResponsesState port — multi-choice output-index
    // allocation (response.go:483-520), custom_tool_call branch selected from
    // the original request's custom tool names, reasoning/summary events
    // (661-726), and response.in_progress state (433-455). P1 covers the
    // single-assistant text + function_call core with deferred completed.

    const createdEvents = (): ResponsesStreamEvent[] => [
        { type: 'response.created', sequence_number: seq++, response: { id, object: 'response', model, status: 'in_progress' } },
    ];

    return (chunk: unknown): ResponsesStreamEvent[] => {
        if (completed) return [];
        const events: ResponsesStreamEvent[] = [];
        if (!created) {
            created = true;
            events.push(...createdEvents());
        }
        const root = asRecord(chunk);
        const choices = Array.isArray(root['choices']) ? (root['choices'] as unknown[]) : [];
        const delta = asRecord(asRecord(choices[0])['delta']);
        const finish = str(asRecord(choices[0])['finish_reason']);
        const content = delta['content'];
        const text = typeof content === 'string' ? content : '';
        if (text) {
            msgText += text;
            if (!msgItemAdded) {
                msgItemAdded = true;
                events.push({ type: 'response.output_item.added', sequence_number: seq++, output_index: 0, item: { type: 'message', id: 'msg_0', role: 'assistant', content: [] } });
            }
            if (!contentAdded) {
                contentAdded = true;
                events.push({ type: 'response.content_part.added', sequence_number: seq++, item_id: 'msg_0', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } });
            }
            events.push({ type: 'response.output_text.delta', sequence_number: seq++, item_id: 'msg_0', output_index: 0, content_index: 0, delta: text });
        }
        const toolCalls = delta['tool_calls'];
        if (Array.isArray(toolCalls)) {
            for (const tc of toolCalls) {
                const t = asRecord(tc);
                const idx = typeof t['index'] === 'number' ? (t['index'] as number) : 0;
                const rawId = str(t['id']);
                const fn = asRecord(t['function']);
                const name = str(fn['name']);
                const args = str(fn['arguments']);
                // Bind by index: first chunk carries the id, continuations reuse it.
                let key: string;
                if (rawId) {
                    key = `${idx}:${rawId}`;
                    indexKey.set(idx, key);
                } else {
                    key = indexKey.get(idx) ?? `${idx}:call_${idx}`;
                    indexKey.set(idx, key);
                }
                const callId = key.split(':')[1] ?? key;
                if (!funcAdded.has(key)) {
                    funcAdded.add(key);
                    funcArgs.set(key, '');
                    funcNameOf.set(key, name);
                    funcOutIx.set(key, idx + 1);
                    events.push({
                        type: 'response.output_item.added',
                        sequence_number: seq++,
                        output_index: idx + 1,
                        item: { type: 'function_call', id: callId, call_id: callId, name, arguments: '' },
                    });
                }
                if (args) {
                    funcArgs.set(key, `${funcArgs.get(key) ?? ''}${args}`);
                    events.push({
                        type: 'response.function_call_arguments.delta',
                        sequence_number: seq++,
                        item_id: callId,
                        output_index: idx + 1,
                        delta: args,
                    });
                }
                void name;
            }
        }
        if (finish) {
            for (const key of funcAdded) {
                if (!funcDone.has(key)) {
                    funcDone.add(key);
                    const callId = key.split(':')[1] ?? key;
                    const outIx = funcOutIx.get(key) ?? 0;
                    events.push({ type: 'response.function_call_arguments.done', sequence_number: seq++, item_id: callId, output_index: outIx, arguments: funcArgs.get(key) ?? '' });
                    events.push({ type: 'response.output_item.done', sequence_number: seq++, output_index: outIx, item: { type: 'function_call', id: callId, call_id: callId, name: funcNameOf.get(key) ?? '', arguments: funcArgs.get(key) ?? '' } });
                }
            }
            if (msgItemAdded) {
                events.push({ type: 'response.output_text.done', sequence_number: seq++, item_id: 'msg_0', output_index: 0, content_index: 0, text: msgText });
                if (contentAdded) events.push({ type: 'response.content_part.done', sequence_number: seq++, item_id: 'msg_0', output_index: 0, content_index: 0, part: { type: 'output_text', text: msgText } });
                events.push({ type: 'response.output_item.done', sequence_number: seq++, output_index: 0, item: { type: 'message', id: 'msg_0' } });
            }
            const usage = asRecord(root['usage']);
            const incomplete = finish === 'length' || finish === 'content_filter';
            events.push({
                type: 'response.completed',
                sequence_number: seq++,
                response: {
                    id,
                    object: 'response',
                    model,
                    status: incomplete ? 'incomplete' : 'completed',
                    ...(incomplete ? { incomplete_details: { reason: finish === 'length' ? 'max_output_tokens' : 'content_filter' } } : {}),
                    usage: {
                        input_tokens: num(usage['prompt_tokens']),
                        output_tokens: num(usage['completion_tokens']),
                        total_tokens: num(usage['total_tokens']),
                    },
                },
            });
            completed = true;
        }
        return events;
    };
}

/**
 * Stateful responses-events -> chat-chunks translator (one instance per stream).
 * Text-core inverse of createChatToResponsesStreamTranslator: output_text
 * deltas become content deltas, function_call_arguments deltas become
 * tool_calls[0] fragments, response.completed becomes the terminal finish
 * chunk (late usage mapped via usageToChat).
 * TODO(P4+): multi-tool index allocation + custom_tool_call branches.
 */
export function createResponsesToChatStreamTranslator(model: string, completionId?: string) {
    const id = completionId || `chatcmpl-${Date.now().toString(36)}`;
    let done = false;
    let sawTools = false;

    return (event: unknown): Record<string, unknown>[] => {
        if (done) return [];
        const ev = asRecord(event);
        const type = str(ev['type']);
        if (type === 'response.output_text.delta') {
            const delta = str(ev['delta']);
            if (!delta) return [];
            return [{ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] }];
        }
        if (type === 'response.function_call_arguments.delta') {
            sawTools = true;
            const frag = str(ev['delta']);
            const itemId = str(ev['item_id']);
            if (!frag) return [];
            return [{
                id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
                choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: itemId || undefined, type: 'function', function: { arguments: frag } }] }, finish_reason: null }],
            }];
        }
        if (type === 'response.completed') {
            done = true;
            const resp = asRecord(ev['response']);
            const usage = usageToChat(resp['usage']);
            return [{
                id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
                choices: [{ index: 0, delta: {}, finish_reason: sawTools ? 'tool_calls' : str(resp['status']) === 'incomplete' ? 'length' : 'stop' }],
                usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.total_tokens },
            }];
        }
        return [];
    };
}
