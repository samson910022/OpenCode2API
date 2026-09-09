/**
 * messages (claude) <-> chat (openai) request translators.
 *
 * messages->chat wraps the existing pure layer `../anthropic.js`
 * (itself borrowed from CLIProxyAPI `openai/claude` + LiteLLM adapter);
 * chat->messages is the symmetric inverse, informed by CLIProxyAPI
 * `internal/translator/claude/openai/chat-completions/claude_openai_request.go`
 * (`ConvertOpenAIRequestToClaude`: system extraction, thinking/effort mapping).
 *
 * Pure functions only.
 */

import {
    anthropicMessagesToChatMessages,
    anthropicThinkingToReasoningEffort,
    anthropicToolChoiceToChat,
    anthropicToolsToChatTools,
    extractSystemText,
} from '../anthropic.js';
import { asRecord } from '../../utils/guards.js';
import { asArray, str } from '../json.js';

/** messages.request -> chat.request (thin wrapper over anthropic.ts). */
export function convertMessagesRequestToChat(model: string, body: unknown, stream: boolean): unknown {
    const root = asRecord(body);
    const out: Record<string, unknown> = { model, stream };
    const system = extractSystemText(root['system']);
    const messages = anthropicMessagesToChatMessages(root['messages']);
    // System rides as a real system message (upstream role:system), not user.
    // (anthropic.ts ChatMessage role union omits system; cast at the boundary.)
    if (system) messages.unshift({ role: 'system', content: system } as unknown as (typeof messages)[number]);
    out['messages'] = messages;
    const tools = anthropicToolsToChatTools(root['tools']);
    if (tools.length) out['tools'] = tools;
    const choice = anthropicToolChoiceToChat(root['tool_choice']);
    if (choice !== undefined) out['tool_choice'] = choice;
    const effort = messagesThinkingToReasoningEffort(root['thinking']);
    if (effort) out['reasoning_effort'] = effort;
    if (typeof root['max_tokens'] === 'number') out['max_tokens'] = root['max_tokens'];
    if (typeof root['temperature'] === 'number') out['temperature'] = root['temperature'];
    if (typeof root['top_p'] === 'number') out['top_p'] = root['top_p'];
    if (Array.isArray(root['stop_sequences'])) out['stop'] = root['stop_sequences'];
    return out;
}

/**
 * Thinking -> reasoning_effort, extending anthropicThinkingToReasoningEffort
 * with adaptive/auto variants (Go claude_openai_request.go:57-98 core):
 * adaptive/auto + output_config.effort|effort passthrough, none/disabled -> none.
 */
function messagesThinkingToReasoningEffort(thinking: unknown): string | null {
    if (!thinking || typeof thinking !== 'object' || Array.isArray(thinking)) return null;
    const th = thinking as Record<string, unknown>;
    const type = str(th['type']).toLowerCase();
    if (type === 'disabled') return 'none';
    if (type === 'adaptive' || type === 'auto') {
        const cfg = asRecord(th['output_config']);
        const effort = str(cfg['effort'] ?? th['effort']).toLowerCase().trim();
        if (effort === 'max' || effort === 'high' || effort === 'medium' || effort === 'low' || effort === 'min') return effort;
        return 'auto';
    }
    return anthropicThinkingToReasoningEffort(thinking);
}

/** chat.request -> messages.request (symmetric inverse). */
export function convertChatRequestToMessages(model: string, body: unknown, stream: boolean): unknown {
    const root = asRecord(body);
    const out: Record<string, unknown> = { model, stream };
    const systemParts: string[] = [];
    const messages: Record<string, unknown>[] = [];
    for (const m of asArray(root['messages'])) {
        const msg = asRecord(m);
        const role = str(msg['role']);
        if (role === 'system') {
            const content = msg['content'];
            const text = typeof content === 'string'
                ? content
                : Array.isArray(content)
                    ? content.map((p) => str(asRecord(p)['text'])).filter(Boolean).join('')
                    : JSON.stringify(content ?? '');
            systemParts.push(text);
            continue;
        }
        const content = msg['content'];
        const blocks: Record<string, unknown>[] = [];
        if (typeof content === 'string' && content) blocks.push({ type: 'text', text: content });
        else if (Array.isArray(content)) {
            for (const p of content) {
                const part = asRecord(p);
                if (str(part['type']) === 'image_url') {
                    const iu = asRecord(part['image_url']);
                    const url = str(iu['url']);
                    if (url.startsWith('data:')) {
                        const comma = url.indexOf(',');
                        const meta = url.slice(5, comma);
                        const data = comma >= 0 ? url.slice(comma + 1) : '';
                        const mime = meta.split(';')[0] || 'application/octet-stream';
                        blocks.push({ type: 'image', source: { type: 'base64', media_type: mime, data } });
                    } else if (url) {
                        blocks.push({ type: 'image', source: { type: 'url', url } });
                    }
                } else if (str(part['text'])) {
                    blocks.push({ type: 'text', text: str(part['text']) });
                }
            }
        }
        const toolCalls = msg['tool_calls'];
        if (Array.isArray(toolCalls)) {
            for (const tc of toolCalls) {
                const t = asRecord(tc);
                const fn = asRecord(t['function']);
                let input: unknown = {};
                try {
                    input = JSON.parse(str(fn['arguments']) || '{}') as unknown;
                } catch {
                    input = {};
                }
                blocks.push({ type: 'tool_use', id: str(t['id']), name: str(fn['name']), input });
            }
        }
        if (role === 'tool') {
            // tool content may be string or content-part array; extract text
            // and preserve is_error via ERROR: prefix (mirrors anthropic.ts).
            const raw = msg['content'];
            let text: string;
            if (typeof raw === 'string') text = raw;
            else if (Array.isArray(raw)) {
                text = raw
                    .map((p) => {
                        const part = asRecord(p);
                        if (str(part['type']) === 'image') return '[image]';
                        return str(part['text']);
                    })
                    .filter(Boolean)
                    .join('\n');
            } else text = JSON.stringify(raw ?? '');
            messages.push({
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: str(msg['tool_call_id']), content: text }],
            });
            continue;
        }
        if (!blocks.length) continue;
        messages.push({ role: role === 'assistant' ? 'assistant' : 'user', content: blocks });
    }
    if (systemParts.length) out['system'] = systemParts.join('\n\n');
    out['messages'] = messages;
    const tools = asArray(root['tools']);
    if (tools.length) {
        out['tools'] = tools
            .map((t) => {
                const tool = asRecord(t);
                const fn = asRecord(tool['function']);
                if (!str(fn['name'])) return null;
                return {
                    name: str(fn['name']),
                    description: str(fn['description'] ?? ''),
                    input_schema: (fn['parameters'] ?? { type: 'object' }) as unknown,
                };
            })
            .filter(Boolean);
    }
    if (root['tool_choice'] !== undefined) {
        const choice = root['tool_choice'];
        if (typeof choice === 'string') {
            if (choice === 'auto') out['tool_choice'] = { type: 'auto' };
            else if (choice === 'none') out['tool_choice'] = { type: 'none' };
            else if (choice === 'required') out['tool_choice'] = { type: 'any' };
            else out['tool_choice'] = { type: 'auto' };
        } else {
            const c = asRecord(choice);
            const fn = asRecord(c['function']);
            if (str(fn['name'])) out['tool_choice'] = { type: 'tool', name: str(fn['name']) };
        }
    }
    const effort = str(root['reasoning_effort']).toLowerCase();
    if (effort === 'none') {
        out['thinking'] = { type: 'disabled' };
    } else if (effort === 'auto') {
        // Go ConvertOpenAIRequestToClaudeWithCompat: auto -> adaptive.
        out['thinking'] = { type: 'adaptive' };
    } else if (effort === 'high' || effort === 'medium' || effort === 'low' || effort === 'max' || effort === 'min') {
        const budget = effort === 'high' || effort === 'max' ? 24000 : effort === 'medium' ? 8000 : 4000;
        out['thinking'] = { type: 'enabled', budget_tokens: budget };
    }
    if (typeof root['max_tokens'] === 'number') out['max_tokens'] = root['max_tokens'];
    return out;
}
