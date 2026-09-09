/**
 * responses (openai-response) <-> messages (claude) request translators.
 *
 * Direct directed pairs (no chat pivot at runtime), informed by CLIProxyAPI
 * `claude/openai/responses/*` + `openai/claude/*`: instructions<->system,
 * input items<->content blocks, function_call<->tool_use,
 * function_call_output<->tool_result, reasoning<->thinking, tools, tool_choice.
 *
 * Pure functions only.
 */

import { asRecord } from '../../utils/guards.js';
import { asArray, str } from '../json.js';

function parseJsonObject(text: string): unknown {
    try {
        const v = JSON.parse(text || '{}') as unknown;
        return v && typeof v === 'object' ? v : {};
    } catch {
        return {};
    }
}

/** responses.request -> messages.request. */
export function convertResponsesRequestToMessages(model: string, body: unknown, stream: boolean): unknown {
    const root = asRecord(body);
    const out: Record<string, unknown> = { model, stream };
    if ('instructions' in root && typeof root['instructions'] === 'string') {
        out['system'] = root['instructions'];
    }
    const messages: Record<string, unknown>[] = [];
    const input = root['input'];
    const pushUser = (content: unknown[]): void => {
        if (content.length) messages.push({ role: 'user', content });
    };
    if (typeof input === 'string' && input) {
        pushUser([{ type: 'text', text: input }]);
    } else if (Array.isArray(input)) {
        for (const item of input) {
            const it = asRecord(item);
            const t = str(it['type']) || (str(it['role']) ? 'message' : '');
            if (t === 'message') {
                const role = str(it['role']) === 'assistant' ? 'assistant' : 'user';
                const blocks: Record<string, unknown>[] = [];
                for (const c of asArray(it['content'])) {
                    const cp = asRecord(c);
                    const ct = str(cp['type']);
                    if (ct === 'input_text' || ct === 'output_text') blocks.push({ type: 'text', text: str(cp['text']) });
                    else if (ct === 'input_image') blocks.push(inputImageToMessagesBlock(cp));
                }
                if (blocks.length) messages.push({ role, content: blocks });
            } else if (t === 'reasoning') {
                const summary = asArray(it['summary'])
                    .map((s) => str(asRecord(s)['text']))
                    .filter(Boolean)
                    .join('');
                if (summary) messages.push({ role: 'assistant', content: [{ type: 'thinking', thinking: summary }] });
            } else if (t === 'function_call' || t === 'custom_tool_call') {
                messages.push({
                    role: 'assistant',
                    content: [{ type: 'tool_use', id: str(it['call_id']), name: str(it['name']), input: t === 'function_call' ? parseJsonObject(str(it['arguments'])) : { input: str(it['input']) } }],
                });
            } else if (t === 'function_call_output' || t === 'custom_tool_call_output') {
                pushUser([{ type: 'tool_result', tool_use_id: str(it['call_id']), content: toolOutputToMessagesContent(it['output']) }]);
            }
        }
    }
    out['messages'] = messages;
    const tools = asArray(root['tools']);
    if (tools.length) {
        out['tools'] = tools
            .map((tool) => {
                const t = asRecord(tool);
                if (str(t['type']) !== 'function' || !str(t['name'])) return null;
                return { name: str(t['name']), description: str(t['description'] ?? ''), input_schema: (t['parameters'] ?? { type: 'object' }) as unknown };
            })
            .filter(Boolean);
    }
    const mappedChoice = mapResponsesToolChoiceToMessages(root['tool_choice']);
    if (mappedChoice !== undefined) out['tool_choice'] = mappedChoice;
    if (typeof root['max_output_tokens'] === 'number') out['max_tokens'] = root['max_output_tokens'];
    const reasoning = asRecord(root['reasoning']);
    const effort = str(reasoning['effort']).toLowerCase().trim();
    if (effort === 'none') out['thinking'] = { type: 'disabled' };
    else if (effort === 'auto') out['thinking'] = { type: 'adaptive' };
    else if (effort) out['thinking'] = { type: 'enabled', budget_tokens: effort === 'high' ? 24000 : effort === 'medium' ? 8000 : 4000 };
    return out;
}

/** input_image content -> messages image block (data: URLs become base64 sources). */
function inputImageToMessagesBlock(cp: Record<string, unknown>): Record<string, unknown> {
    const url = str(cp['image_url']);
    if (url.startsWith('data:')) {
        const comma = url.indexOf(',');
        const meta = url.slice(5, comma < 0 ? undefined : comma);
        const data = comma >= 0 ? url.slice(comma + 1) : '';
        const mime = meta.split(';')[0] || 'application/octet-stream';
        return { type: 'image', source: { type: 'base64', media_type: mime, data } };
    }
    return { type: 'image', source: { type: 'url', url } };
}

/** function output -> messages tool_result content (arrays/images expanded like chat side). */
function toolOutputToMessagesContent(output: unknown): unknown {
    if (typeof output === 'string') return output;
    if (Array.isArray(output)) {
        const texts = output
            .map((p) => {
                const part = asRecord(p);
                if (str(part['type']) === 'image') return '[image]';
                return str(part['text'] ?? part['output_text'] ?? '');
            })
            .filter(Boolean);
        if (texts.length) return texts.join('\n');
    }
    return JSON.stringify(output ?? '');
}

/** responses tool_choice -> messages tool_choice (string passthrough + object mapping). */
function mapResponsesToolChoiceToMessages(choice: unknown): unknown {
    if (choice === undefined) return undefined;
    if (typeof choice === 'string') {
        const c = choice.toLowerCase();
        if (c === 'auto' || c === 'none' || c === 'required') return c === 'required' ? { type: 'any' } : { type: c };
        return { type: 'auto' };
    }
    const r = asRecord(choice);
    if (str(r['type']) === 'function' && r['function'] !== undefined) {
        const fn = asRecord(r['function']);
        if (str(fn['name'])) return { type: 'tool', name: str(fn['name']) };
    }
    if (str(r['type']) === 'tool' && str(r['name'])) return { type: 'tool', name: str(r['name']) };
    if (str(r['type'])) return { type: str(r['type']) };
    return { type: 'auto' };
}

/** messages tool_choice -> responses tool_choice. */
function mapMessagesToolChoiceToResponses(choice: unknown): unknown {
    if (typeof choice === 'string') return choice;
    const r = asRecord(choice);
    const t = str(r['type']).toLowerCase();
    if (t === 'auto') return 'auto';
    if (t === 'none') return 'none';
    if (t === 'any') return 'required';
    if (t === 'tool' && str(r['name'])) return { type: 'function', function: { name: str(r['name']) } };
    return 'auto';
}

/** messages.request -> responses.request. */
export function convertMessagesRequestToResponses(model: string, body: unknown, stream: boolean): unknown {
    const root = asRecord(body);
    const out: Record<string, unknown> = { model, stream };
    const system = root['system'];
    if (typeof system === 'string' && system) out['instructions'] = system;
    else if (Array.isArray(system)) {
        const text = system.map((b) => str(asRecord(b)['text'])).filter(Boolean).join('\n\n');
        if (text) out['instructions'] = text;
    }
    const input: Record<string, unknown>[] = [];
    for (const m of asArray(root['messages'])) {
        const msg = asRecord(m);
        const role = str(msg['role']) === 'assistant' ? 'assistant' : 'user';
        const content = msg['content'];
        const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : asArray(content);
        for (const b of blocks) {
            const block = asRecord(b);
            const t = str(block['type']);
            if (t === 'text') {
                input.push({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: str(block['text']) }] });
            } else if (t === 'thinking') {
                input.push({ type: 'reasoning', summary: [{ type: 'summary_text', text: str(block['thinking']) }] });
            } else if (t === 'image') {
                const src = asRecord(block['source']);
                // base64 sources become data: URLs so no bytes are lost.
                if (str(src['type']) === 'base64' && str(src['data'])) {
                    const mime = str(src['media_type']) || 'application/octet-stream';
                    input.push({ type: 'message', role, content: [{ type: 'input_image', image_url: `data:${mime};base64,${str(src['data'])}` }] });
                } else {
                    input.push({ type: 'message', role, content: [{ type: 'input_image', image_url: str(src['url'] ?? src['data'] ?? '') }] });
                }
            } else if (t === 'tool_use') {
                input.push({ type: 'function_call', call_id: str(block['id']), name: str(block['name']), arguments: JSON.stringify(block['input'] ?? {}) });
            } else if (t === 'tool_result') {
                const raw = block['content'];
                const output = typeof raw === 'string'
                    ? raw
                    : Array.isArray(raw)
                        ? raw.map((p) => str(asRecord(p)['text'])).filter(Boolean).join('\n') || JSON.stringify(raw)
                        : JSON.stringify(raw ?? '');
                input.push({ type: 'function_call_output', call_id: str(block['tool_use_id']), output });
            }
        }
    }
    out['input'] = input;
    const tools = asArray(root['tools']);
    if (tools.length) {
        out['tools'] = tools
            .map((tool) => {
                const t = asRecord(tool);
                if (!str(t['name'])) return null;
                return { type: 'function', name: str(t['name']), description: str(t['description'] ?? ''), parameters: (t['input_schema'] ?? { type: 'object' }) as unknown };
            })
            .filter(Boolean);
    }
    if (root['tool_choice'] !== undefined) out['tool_choice'] = mapMessagesToolChoiceToResponses(root['tool_choice']);
    if (typeof root['max_tokens'] === 'number') out['max_output_tokens'] = root['max_tokens'];
    const thinking = asRecord(root['thinking']);
    const thinkingType = str(thinking['type']).toLowerCase();
    if (thinkingType === 'disabled') {
        out['reasoning'] = { effort: 'none' };
    } else if (thinkingType === 'adaptive' || thinkingType === 'auto') {
        out['reasoning'] = { effort: 'auto' };
    } else if (thinkingType === 'enabled') {
        const budget = thinking['budget_tokens'];
        out['reasoning'] = { effort: typeof budget === 'number' && budget >= 24000 ? 'high' : typeof budget === 'number' && budget >= 8000 ? 'medium' : 'low' };
    }
    return out;
}
