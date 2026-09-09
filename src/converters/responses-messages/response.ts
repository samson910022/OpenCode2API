/**
 * responses <-> messages response translators (non-stream core).
 *
 * Direct mapping: responses output items (message/function_call) <->
 * Anthropic content blocks (text/thinking/tool_use); usage
 * input/output/total <-> input/output tokens. Stream translators are P4
 * (responses events <-> Anthropic SSE need the P1/P2 state machines composed).
 */

import { asRecord } from '../../utils/guards.js';
import { num, str } from '../json.js';

function newId(prefix: string): string {
    try {
        if (typeof globalThis.crypto?.randomUUID === 'function') {
            return `${prefix}${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
        }
    } catch {
        // fall through
    }
    return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** responses.response -> messages.message. */
export function convertResponsesResponseToMessagesNonStream(
    model: string,
    _originalRequest: unknown,
    _translatedRequest: unknown,
    body: unknown,
): unknown {
    const root = asRecord(body);
    const output = Array.isArray(root['output']) ? (root['output'] as unknown[]) : [];
    const content: Record<string, unknown>[] = [];
    for (const item of output) {
        const it = asRecord(item);
        const t = str(it['type']);
        if (t === 'message') {
            for (const c of Array.isArray(it['content']) ? (it['content'] as unknown[]) : []) {
                const cp = asRecord(c);
                if (str(cp['type']) === 'output_text' && str(cp['text'])) content.push({ type: 'text', text: str(cp['text']) });
            }
        } else if (t === 'reasoning') {
            const summary = Array.isArray(it['summary']) ? (it['summary'] as unknown[]) : [];
            const text = summary.map((s) => str(asRecord(s)['text'])).filter(Boolean).join('');
            if (text) content.push({ type: 'thinking', thinking: text, signature: '' });
        } else if (t === 'function_call') {
            let input: unknown = {};
            try {
                input = JSON.parse(str(it['arguments']) || '{}') as unknown;
            } catch {
                input = {};
            }
            content.push({ type: 'tool_use', id: str(it['call_id'] ?? it['id']), name: str(it['name']), input });
        }
    }
    const usage = asRecord(root['usage']);
    return {
        id: str(root['id']) || newId('msg_'),
        type: 'message',
        role: 'assistant',
        model,
        content,
        stop_reason: content.some((c) => c['type'] === 'tool_use') ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: num(usage['input_tokens']), output_tokens: num(usage['output_tokens']) },
    };
}

/** messages.message -> responses.response. */
export function convertMessagesResponseToResponsesNonStream(
    model: string,
    _originalRequest: unknown,
    _translatedRequest: unknown,
    body: unknown,
): unknown {
    const root = asRecord(body);
    const content = Array.isArray(root['content']) ? (root['content'] as unknown[]) : [];
    const output: Record<string, unknown>[] = [];
    const textParts: string[] = [];
    for (const c of content) {
        const b = asRecord(c);
        const t = str(b['type']);
        if (t === 'text') textParts.push(str(b['text']));
        else if (t === 'thinking') output.push({ type: 'reasoning', summary: [{ type: 'summary_text', text: str(b['thinking']) }] });
        else if (t === 'tool_use') {
            output.push({ type: 'function_call', call_id: str(b['id']), id: str(b['id']), name: str(b['name']), arguments: JSON.stringify(b['input'] ?? {}) });
        }
    }
    if (textParts.join('')) {
        output.unshift({ type: 'message', id: 'msg_0', role: 'assistant', content: [{ type: 'output_text', text: textParts.join('') }] });
    }
    const usage = asRecord(root['usage']);
    return {
        id: str(root['id']) || newId('resp_'),
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        model,
        status: 'completed',
        output,
        usage: {
            input_tokens: num(usage['input_tokens']),
            output_tokens: num(usage['output_tokens']),
            total_tokens: num(usage['input_tokens']) + num(usage['output_tokens']),
        },
    };
}

/**
 * Text-core stream translators between responses events and Anthropic SSE.
 * Full tool-arg streaming composition is P4+; P4 covers text deltas +
 * terminal mapping so the matrix has no missing directed stream edge.
 * TODO(P4+): function_call_arguments <-> input_json deltas, thinking/summary
 * deltas, per-block indices.
 */
export function createResponsesToMessagesStreamTranslator(model: string, messageId?: string) {
    const id = messageId || newId('msg_');
    let started = false;
    let textIx = -1;
    let nextIx = 0;
    let stopped = false;
    let outputTokens = 0;
    let inputTokens = 0;
    return (event: unknown): { event: string; data: unknown }[] => {
        if (stopped) return [];
        const ev = asRecord(event);
        const type = str(ev['type']);
        const out: { event: string; data: unknown }[] = [];
        if (!started) {
            started = true;
            out.push({ event: 'message_start', data: { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } } });
        }
        if (type === 'response.output_text.delta' && str(ev['delta'])) {
            // Lazy text block (matches chat->messages): empty streams emit
            // no content block at all.
            if (textIx < 0) {
                textIx = nextIx++;
                out.push({ event: 'content_block_start', data: { type: 'content_block_start', index: textIx, content_block: { type: 'text', text: '' } } });
            }
            out.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: textIx, delta: { type: 'text_delta', text: str(ev['delta']) } } });
        }
        if (type === 'response.completed') {
            stopped = true;
            const resp = asRecord(ev['response']);
            const completedUsage = asRecord(resp['usage']);
            outputTokens = num(completedUsage['output_tokens']);
            inputTokens = num(completedUsage['input_tokens']);
            if (textIx >= 0) out.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: textIx } });
            out.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: inputTokens, output_tokens: outputTokens } } });
            out.push({ event: 'message_stop', data: { type: 'message_stop' } });
        }
        return out;
    };
}

/** Anthropic SSE -> responses events (text-core inverse). */
export function createMessagesToResponsesStreamTranslator(model: string, responseId?: string) {
    const id = responseId || newId('resp_');
    let created = false;
    let seq = 0;
    let completed = false;
    let outputTokens = 0;
    return (event: unknown): Record<string, unknown>[] => {
        if (completed) return [];
        const ev = asRecord(event);
        const out: Record<string, unknown>[] = [];
        if (!created) {
            created = true;
            out.push({ type: 'response.created', sequence_number: seq++, response: { id, object: 'response', model, status: 'in_progress' } });
        }
        if (str(ev['event']) === 'content_block_delta' && str(asRecord(asRecord(ev['data'])['delta'])['text'])) {
            out.push({ type: 'response.output_text.delta', sequence_number: seq++, item_id: 'msg_0', output_index: 0, content_index: 0, delta: str(asRecord(asRecord(ev['data'])['delta'])['text']) });
        }
        if (str(ev['event']) === 'message_delta') {
            outputTokens = num(asRecord(asRecord(ev['data'])['usage'])['output_tokens']);
        }
        if (str(ev['event']) === 'message_stop') {
            completed = true;
            out.push({ type: 'response.completed', sequence_number: seq++, response: { id, object: 'response', model, status: 'completed', usage: { input_tokens: 0, output_tokens: outputTokens, total_tokens: outputTokens } } });
        }
        return out;
    };
}
