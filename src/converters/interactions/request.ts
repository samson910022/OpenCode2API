/**
 * interactions <-> {chat, responses, messages} request translators.
 *
 * Ports of CLIProxyAPI:
 * - chat: `openai/interactions/chat-completions/{openai_interactions_request.go
 *   (ConvertOpenAIRequestToInteractions),
 *   interactions_openai_request.go (ConvertInteractionsRequestToOpenAI)}`
 * - responses: `openai/interactions/responses/interactions_openai_responses_request.go`
 *   (`ConvertOpenAIResponsesRequestToInteractions` /
 *   `ConvertInteractionsRequestToOpenAIResponses`)
 * - messages: `claude/interactions/interactions_claude_request.go` +
 *   `interactions/claude/interactions_claude_request.go`
 *
 * Gateway semantics preserved: interactions carries TEXT ONLY plus
 * google_search grounding; function tools are route-rejected (400), so
 * translators DROP function declarations (documented, not erroring) and keep
 * google_search/web_search markers best-effort.
 *
 * Pure functions only.
 */

import { asRecord } from '../../utils/guards.js';
import { asArray, str } from '../json.js';

function textOf(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        return value
            .map((p) => {
                const part = asRecord(p);
                return str(part['text'] ?? part['content']);
            })
            .filter(Boolean)
            .join('');
    }
    const r = asRecord(value);
    return str(r['text'] ?? r['content']);
}

/** chat.messages[] -> interactions input[] (+instructions). */
function chatMessagesToInteractionsInput(messages: unknown): { input: Record<string, unknown>[]; instructions: string } {
    const input: Record<string, unknown>[] = [];
    const sys: string[] = [];
    for (const m of asArray(messages)) {
        const msg = asRecord(m);
        const role = str(msg['role']);
        if (role === 'system') {
            const t = textOf(msg['content']);
            if (t) sys.push(t);
            continue;
        }
        // Tool outputs carry result text: keep as role:tool (route
        // normalizeInteractionsInput preserves arbitrary roles), matching the
        // responses->interactions direction. Images leave an [image] marker so
        // presence is not silently lost (same as messages->interactions).
        if (role === 'tool') {
            const t = textOf(msg['content']);
            if (t) input.push({ role: 'tool', content: t });
            continue;
        }
        const t = chatContentToText(msg['content']);
        if (t) input.push({ role: role || 'user', content: t });
    }
    return { input, instructions: sys.join('\n\n') };
}

function chatContentToText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map((p) => {
            const part = asRecord(p);
            if (str(part['type']) === 'image_url') return '[image]';
            return str(part['text']);
        })
        .filter(Boolean)
        .join('');
}

function hasGoogleSearch(tools: unknown): boolean {
    return asArray(tools).some((t) => {
        const tool = asRecord(t);
        const type = str(tool['type']).toLowerCase();
        if (type === 'google_search' || type === 'web_search' || type === 'web_search_preview') return true;
        // Responses function tools carry the name at top level; messages
        // tools are bare {name, ...} without type/function wrappers.
        const name = str(asRecord(tool['function'])['name'] || tool['name']).toLowerCase();
        return name === 'google_search' || name === 'web_search';
    });
}

/** chat.request -> interactions.request. Function tools dropped (route 400s them). */
export function convertChatRequestToInteractions(model: string, body: unknown, stream: boolean): unknown {
    const root = asRecord(body);
    const { input, instructions } = chatMessagesToInteractionsInput(root['messages']);
    const out: Record<string, unknown> = { model, stream, input };
    // Route reads system_instruction (interactions.ts:130), not instructions.
    if (instructions) out['system_instruction'] = instructions;
    if (hasGoogleSearch(root['tools'])) out['tools'] = [{ type: 'google_search' }];
    return out;
}

/** interactions system instructions: string passthrough (guards.asRecord maps strings to {}). */
function interactionsInstructionsOf(root: Record<string, unknown>): string {
    const direct = root['instructions'];
    if (typeof direct === 'string' && direct) return direct;
    const sys = root['system_instruction'];
    if (typeof sys === 'string' && sys) return sys;
    if (sys && typeof sys === 'object' && !Array.isArray(sys)) {
        const text = textOf((sys as Record<string, unknown>)['parts'] ?? (sys as Record<string, unknown>)['content'] ?? (sys as Record<string, unknown>)['text']);
        if (text) return text;
    }
    return '';
}

/** interactions.request -> chat.request. google_search dropped (chat route 400s web_search). */
export function convertInteractionsRequestToChat(model: string, body: unknown, stream: boolean): unknown {
    const root = asRecord(body);
    const out: Record<string, unknown> = { model, stream };
    const messages: Record<string, unknown>[] = [];
    const instructions = interactionsInstructionsOf(root);
    if (instructions) messages.push({ role: 'system', content: instructions });
    for (const item of normalizeInput(root['input'])) {
        messages.push({ role: item.role || 'user', content: item.content });
    }
    out['messages'] = messages;
    return out;
}

function normalizeInput(input: unknown): { role: string; content: string }[] {
    if (typeof input === 'string') return input.trim() ? [{ role: 'user', content: input }] : [];
    if (!Array.isArray(input)) return [];
    const out: { role: string; content: string }[] = [];
    for (const item of input) {
        if (typeof item === 'string') {
            if (item.trim()) out.push({ role: 'user', content: item });
            continue;
        }
        const rec = asRecord(item);
        if (typeof rec['role'] === 'string') {
            const text = textOf(rec['content'] ?? rec['text']);
            if (text) out.push({ role: String(rec['role']), content: text });
        } else {
            // Bare typed shapes without role ({type:text/input_text/
            // output_text, text}) land here via textOf, mirroring route
            // normalizeInteractionsInput (interactions.ts:67-70).
            const text = textOf(rec['text'] ?? rec['content']);
            if (text) out.push({ role: 'user', content: text });
        }
    }
    return out;
}

/** responses.request -> interactions.request. */
export function convertResponsesRequestToInteractions(model: string, body: unknown, stream: boolean): unknown {
    const root = asRecord(body);
    const input = root['input'];
    const parts: Record<string, unknown>[] = [];
    if (typeof input === 'string' && input.trim()) {
        parts.push({ role: 'user', content: input });
    } else if (Array.isArray(input)) {
        for (const item of input) {
            const it = asRecord(item);
            const t = str(it['type']);
            if (t === 'message') {
                const role = str(it['role']) || 'user';
                const text = asArray(it['content'])
                    .map((c) => str(asRecord(c)['text']))
                    .filter(Boolean)
                    .join('');
                if (text) parts.push({ role, content: text });
            } else if (t === 'function_call' || t === 'custom_tool_call') {
                continue;
            } else if (t === 'function_call_output' || t === 'custom_tool_call_output') {
                const output = it['output'];
                const text = typeof output === 'string' ? output : JSON.stringify(output ?? '');
                if (text) parts.push({ role: 'tool', content: text });
            } else if (t === 'reasoning') {
                continue;
            }
        }
    }
    const out: Record<string, unknown> = { model, stream, input: parts };
    if (typeof root['instructions'] === 'string' && root['instructions']) out['system_instruction'] = root['instructions'];
    if (hasGoogleSearch(root['tools'])) out['tools'] = [{ type: 'google_search' }];
    return out;
}

/** interactions.request -> responses.request. */
export function convertInteractionsRequestToResponses(model: string, body: unknown, stream: boolean): unknown {
    const root = asRecord(body);
    const out: Record<string, unknown> = { model, stream };
    const instructions = interactionsInstructionsOf(root);
    if (instructions) out['instructions'] = instructions;
    const input: Record<string, unknown>[] = [];
    for (const item of normalizeInput(root['input'])) {
        input.push({ type: 'message', role: item.role, content: [{ type: 'input_text', text: item.content }] });
    }
    out['input'] = input;
    return out;
}

/** messages.request -> interactions.request. */
export function convertMessagesRequestToInteractions(model: string, body: unknown, stream: boolean): unknown {
    const root = asRecord(body);
    const parts: Record<string, unknown>[] = [];
    const system = root['system'];
    let instructions = typeof system === 'string' ? system : '';
    if (Array.isArray(system)) {
        instructions = system.map((b) => str(asRecord(b)['text'])).filter(Boolean).join('\n\n');
    }
    for (const m of asArray(root['messages'])) {
        const msg = asRecord(m);
        const role = str(msg['role']) || 'user';
        const content = msg['content'];
        const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : asArray(content);
        const texts = blocks
            .map((b) => {
                const block = asRecord(b);
                const t = str(block['type']);
                if (t === 'text') return str(block['text']);
                if (t === 'thinking') return str(block['thinking']);
                if (t === 'image') return '[image]';
                return '';
            })
            .filter(Boolean);
        if (texts.length) parts.push({ role, content: texts.join('\n\n') });
    }
    const out: Record<string, unknown> = { model, stream, input: parts };
    if (instructions) out['system_instruction'] = instructions;
    if (hasGoogleSearch(root['tools'])) out['tools'] = [{ type: 'google_search' }];
    return out;
}

/** interactions.request -> messages.request. */
export function convertInteractionsRequestToMessages(model: string, body: unknown, stream: boolean): unknown {
    const root = asRecord(body);
    const out: Record<string, unknown> = { model, stream };
    const instructions = interactionsInstructionsOf(root);
    if (instructions) out['system'] = instructions;
    out['messages'] = normalizeInput(root['input']).map((item) => ({
        role: item.role === 'assistant' ? 'assistant' : 'user',
        content: [{ type: 'text', text: item.content }],
    }));
    return out;
}
