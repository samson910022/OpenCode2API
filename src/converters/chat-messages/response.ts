/**
 * messages (claude) <-> chat (openai) response translators.
 *
 * chat->messages ports CLIProxyAPI
 * `internal/translator/openai/claude/openai_claude_response.go`
 * (`ConvertOpenAIResponseToClaude{,NonStream}`: tool_use mapping,
 * thinking blocks, stop_reason mapping) at core-event fidelity;
 * messages->chat is the symmetric inverse.
 *
 * Wire: Anthropic SSE uses `event:` + `data:` lines with NO [DONE]
 * (route-owned); translators emit `{ event, data }` pairs only.
 */

import { buildAnthropicMessage, mapFinishToStopReason, sanitizeClaudeToolId } from '../anthropic.js';
import { asRecord } from '../../utils/guards.js';
import { num, str, targetId } from '../json.js';

function newMessageId(): string {
    try {
        if (typeof globalThis.crypto?.randomUUID === 'function') {
            return `msg_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
        }
    } catch {
        // fall through
    }
    return `msg_${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export interface AnthropicStreamEvent {
    event: string;
    data: unknown;
}

/** chat.completion -> messages.message (non-stream). */
export function convertChatResponseToMessagesNonStream(
    model: string,
    _originalRequest: unknown,
    _translatedRequest: unknown,
    body: unknown,
): unknown {
    const root = asRecord(body);
    const choices = Array.isArray(root['choices']) ? (root['choices'] as unknown[]) : [];
    const first = asRecord(choices[0]);
    const message = asRecord(first['message']);
    const finish = first['finish_reason'];
    const toolCalls = Array.isArray(message['tool_calls']) ? (message['tool_calls'] as unknown[]) : [];
    const usage = asRecord(root['usage']);
    // message.content may be string or parts array; extract text.
    const rawContent = message['content'];
    const text = typeof rawContent === 'string'
        ? rawContent
        : Array.isArray(rawContent)
            ? rawContent.map((p) => str(asRecord(p)['text'])).filter(Boolean).join('')
            : '';
    return buildAnthropicMessage({
        messageId: targetId(root['id'], 'msg_', newMessageId),
        model,
        text: text || undefined,
        reasoning: str(message['reasoning_content']) || undefined,
        toolCalls: toolCalls.map((tc) => {
            const t = asRecord(tc);
            return { id: sanitizeClaudeToolId(t['id']), function: t['function'] as { name?: unknown; arguments?: unknown } | null };
        }),
        stopReason: mapFinishToStopReason(finish, toolCalls.length),
        inputTokens: num(usage['prompt_tokens']),
        outputTokens: num(usage['completion_tokens']),
    });
}

/** messages.message -> chat.completion (non-stream). */
export function convertMessagesResponseToChatNonStream(
    model: string,
    _originalRequest: unknown,
    _translatedRequest: unknown,
    body: unknown,
): unknown {
    const root = asRecord(body);
    const content = Array.isArray(root['content']) ? (root['content'] as unknown[]) : [];
    let text = '';
    let reasoning = '';
    const toolCalls: Record<string, unknown>[] = [];
    for (const c of content) {
        const b = asRecord(c);
        const t = str(b['type']);
        if (t === 'text') text += str(b['text']);
        else if (t === 'thinking') reasoning += str(b['thinking']);
        else if (t === 'tool_use') {
            toolCalls.push({
                id: str(b['id']),
                type: 'function',
                function: { name: str(b['name']), arguments: JSON.stringify(b['input'] ?? {}) },
            });
        }
    }
    const usage = asRecord(root['usage']);
    const stop = str(root['stop_reason']);
    const finish = stop === 'tool_use' ? 'tool_calls' : stop === 'max_tokens' ? 'length' : 'stop';
    return {
        id: targetId(root['id'], 'chatcmpl-', () => `chatcmpl-${Date.now().toString(36)}`),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
            {
                index: 0,
                message: {
                    role: 'assistant',
                    content: text || null,
                    ...(reasoning ? { reasoning_content: reasoning } : {}),
                    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
                },
                finish_reason: finish,
            },
        ],
        usage: {
            prompt_tokens: num(usage['input_tokens']),
            completion_tokens: num(usage['output_tokens']),
            total_tokens: num(usage['input_tokens']) + num(usage['output_tokens']),
        },
    };
}

/**
 * Stateful chat-chunk -> Anthropic-SSE translator (one instance per stream).
 * Emits message_start / content_block_start(content text=0, tool_use=1..) /
 * content_block_delta / content_block_stop / message_delta / message_stop.
 * TODO(P4): thinking-delta events + signature passthrough + multi-choice.
 */
export function createChatToMessagesStreamTranslator(model: string, messageId?: string) {
    const id = messageId || newMessageId();
    let started = false;
    let textOpen = false;
    let textIndex = -1;
    let nextIndex = 0;
    const toolIndexOf = new Map<string, number>();
    const toolJsonOf = new Map<number, string>();
    // Deltas may arrive with index alone before the id shows up; buffer those
    // fragments per index until the id arrives, then emit start + replay.
    const pendingByIndex = new Map<number, { name: string; json: string }>();
    let stopped = false;
    let inputTokens = 0;

    return (chunk: unknown): AnthropicStreamEvent[] => {
        if (stopped) return [];
        const events: AnthropicStreamEvent[] = [];
        const root = asRecord(chunk);
        if (!started) {
            started = true;
            events.push({ event: 'message_start', data: { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } } });
        }
        const choices = Array.isArray(root['choices']) ? (root['choices'] as unknown[]) : [];
        const choice = asRecord(choices[0]);
        const delta = asRecord(choice['delta']);
        const usage = asRecord(root['usage']);
        if (num(usage['prompt_tokens'])) inputTokens = num(usage['prompt_tokens']);

        const openText = (): void => {
            if (!textOpen) {
                textOpen = true;
                textIndex = nextIndex++;
                events.push({ event: 'content_block_start', data: { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } } });
            }
        };

        const content = delta['content'];
        if (typeof content === 'string' && content) {
            openText();
            events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: content } } });
        }
        const toolCalls = delta['tool_calls'];
        if (Array.isArray(toolCalls)) {
            if (textOpen) {
                events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: textIndex } });
                textOpen = false;
            }
            for (const tc of toolCalls) {
                const t = asRecord(tc);
                const idx = typeof t['index'] === 'number' ? (t['index'] as number) : 0;
                const raw = str(t['id']).trim();
                const fn = asRecord(t['function']);
                const frag = str(fn['arguments']);
                const name = str(fn['name']);
                if (!raw) {
                    // No id yet: buffer fragments keyed by index.
                    const pending = pendingByIndex.get(idx) ?? { name: '', json: '' };
                    if (name && !pending.name) pending.name = name;
                    pending.json += frag;
                    pendingByIndex.set(idx, pending);
                    continue;
                }
                const rawId = sanitizeClaudeToolId(raw);
                const key = `${idx}:${rawId}`;
                let blockIx = toolIndexOf.get(key);
                if (blockIx === undefined) {
                    blockIx = nextIndex++;
                    toolIndexOf.set(key, blockIx);
                    const replayed = pendingByIndex.get(idx);
                    pendingByIndex.delete(idx);
                    toolJsonOf.set(blockIx, '');
                    events.push({
                        event: 'content_block_start',
                        data: { type: 'content_block_start', index: blockIx, content_block: { type: 'tool_use', id: rawId, name: name || replayed?.name || '', input: {} } },
                    });
                    const buffered = `${replayed?.json ?? ''}${frag}`;
                    if (buffered) {
                        toolJsonOf.set(blockIx, buffered);
                        events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: blockIx, delta: { type: 'input_json_delta', partial_json: buffered } } });
                    }
                    continue;
                }
                if (frag) {
                    toolJsonOf.set(blockIx, `${toolJsonOf.get(blockIx) ?? ''}${frag}`);
                    events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: blockIx, delta: { type: 'input_json_delta', partial_json: frag } } });
                }
            }
        }
        const finish = str(choice['finish_reason']);
        if (finish) {
            if (textOpen) {
                events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: textIndex } });
                textOpen = false;
            }
            // Flush id-less buffered fragments with generated ids instead of
            // dropping them when the provider never sent an id.
            for (const [idx, pending] of pendingByIndex) {
                const generatedId = sanitizeClaudeToolId('');
                const key = `${idx}:${generatedId}`;
                const blockIx = nextIndex++;
                toolIndexOf.set(key, blockIx);
                toolJsonOf.set(blockIx, pending.json);
                events.push({
                    event: 'content_block_start',
                    data: { type: 'content_block_start', index: blockIx, content_block: { type: 'tool_use', id: generatedId, name: pending.name, input: {} } },
                });
                if (pending.json) {
                    events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: blockIx, delta: { type: 'input_json_delta', partial_json: pending.json } } });
                }
            }
            pendingByIndex.clear();
            for (const [, blockIx] of toolIndexOf) {
                events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: blockIx } });
            }
            // Aligned with mapFinishToStopReason (anthropic.ts): any opened
            // tool block forces tool_use, regardless of the terminal finish
            // value, so streaming and non-stream agree on tool loops.
            const stopReason = mapFinishToStopReason(finish, toolIndexOf.size > 0);
            const outputTokens = num(usage['completion_tokens']);
            events.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { input_tokens: inputTokens, output_tokens: outputTokens } } });
            events.push({ event: 'message_stop', data: { type: 'message_stop' } });
            stopped = true;
        }
        return events;
    };
}

/**
 * Stateful Anthropic-events -> chat-chunks translator (one instance per stream).
 * Text-core inverse of createChatToMessagesStreamTranslator: text_delta ->
 * content, input_json_delta -> tool_calls fragments (index = block order),
 * message_delta stop_reason -> finish_reason.
 * TODO(P4+): thinking_delta/signature + cache usage legs.
 */
export function createMessagesToChatStreamTranslator(model: string, completionId?: string) {
    const id = completionId || `chatcmpl-${Date.now().toString(36)}`;
    let done = false;
    const blockOrder = new Map<number, number>();
    let nextToolIndex = 0;
    let inputTokens = 0;

    return (event: unknown): Record<string, unknown>[] => {
        if (done) return [];
        const ev = asRecord(event);
        const eventName = str(ev['event']);
        const data = asRecord(ev['data']);
        const created = Math.floor(Date.now() / 1000);
        if (eventName === 'message_start') {
            // Anthropic carries input tokens on start (delta only has output).
            inputTokens = num(asRecord(asRecord(data['message'])['usage'])['input_tokens']);
            return [];
        }
        if (eventName === 'content_block_delta') {
            const delta = asRecord(data['delta']);
            const dtype = str(delta['type']);
            if (dtype === 'text_delta' && str(delta['text'])) {
                return [{ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: str(delta['text']) }, finish_reason: null }] }];
            }
            if (dtype === 'input_json_delta' && str(delta['partial_json'])) {
                const blockIx = num(data['index']);
                let toolIx = blockOrder.get(blockIx);
                if (toolIx === undefined) {
                    toolIx = nextToolIndex++;
                    blockOrder.set(blockIx, toolIx);
                }
                return [{
                    id, object: 'chat.completion.chunk', created, model,
                    choices: [{ index: 0, delta: { tool_calls: [{ index: toolIx, type: 'function', function: { arguments: str(delta['partial_json']) } }] }, finish_reason: null }],
                }];
            }
            return [];
        }
        if (eventName === 'content_block_start') {
            const block = asRecord(data['content_block']);
            if (str(block['type']) === 'tool_use') {
                const blockIx = num(data['index']);
                if (!blockOrder.has(blockIx)) blockOrder.set(blockIx, nextToolIndex++);
                const toolIx = blockOrder.get(blockIx) ?? 0;
                return [{
                    id, object: 'chat.completion.chunk', created, model,
                    choices: [{ index: 0, delta: { tool_calls: [{ index: toolIx, id: str(block['id']), type: 'function', function: { name: str(block['name']), arguments: '' } }] }, finish_reason: null }],
                }];
            }
            return [];
        }
        if (eventName === 'message_delta') {
            done = true;
            const deltaBody = asRecord(data['delta']);
            const stop = str(deltaBody['stop_reason']);
            const finish = stop === 'tool_use' ? 'tool_calls' : stop === 'max_tokens' ? 'length' : 'stop';
            const outUsage = asRecord(data['usage']);
            const outputTokens = num(outUsage['output_tokens']);
            const chunk: Record<string, unknown> = { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: finish }] };
            chunk['usage'] = { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens };
            return [chunk];
        }
        return [];
    };
}
