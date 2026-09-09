/**
 * chat (openai) <-> responses (openai-response) request translators.
 *
 * Port of CLIProxyAPI
 * `internal/translator/openai/openai/responses/openai_openai-responses_request.go`
 * (`ConvertOpenAIResponsesRequestToOpenAIChatCompletions`) for the
 * responses->chat direction; the chat->responses direction is the symmetric
 * inverse (no direct Go counterpart — chat->chat is identity in
 * `openai/openai/chat-completions/openai_openai_request.go`).
 *
 * Pure functions only. `model` param always wins (registry fallback contract).
 */

import { asRecord } from '../../utils/guards.js';
import { asArray, normalizeArgs, str } from '../json.js';

/** Mirrors Go combineOpenAIResponsesReasoning (request.go:552-568). */
function combineReasoning(existing: string, incoming: string): string {
    const a = existing.trim();
    const b = incoming.trim();
    if (!a) return incoming;
    if (!b) return existing;
    if (a === '[reasoning unavailable]') return incoming;
    if (b === '[reasoning unavailable]' || a === b) return existing;
    return `${existing}\n\n${incoming}`;
}

/** Mirrors Go collectOpenAIResponsesReasoningContent (request.go:535-550). */
function collectReasoningText(item: Record<string, unknown>): string {
    const summary = item['summary'];
    if (Array.isArray(summary)) {
        const texts = summary
            .map((s) => {
                const r = asRecord(s);
                if (str(r['type']) !== 'summary_text') return '';
                return str(r['text']);
            })
            .filter(Boolean);
        if (texts.length) return texts.join('');
    }
    return '[reasoning unavailable]';
}

/** Mirrors Go qualifyResponsesNamespaceToolName (tools.go:268-280). */
function qualifyToolName(namespace: unknown, child: unknown): string {
    const ns = str(namespace).trim();
    const name = str(child).trim();
    if (!name || !ns || name.startsWith('mcp__')) return name;
    if (name.startsWith(ns)) return name;
    if (ns.endsWith('__')) return ns + name;
    return `${ns}__${name}`;
}

/**
 * Normalize chat image detail (Go normalizeChatImageDetail, request.go:505-523):
 * auto/low/high passthrough, original->high, missing->'' (unset).
 */
function normalizeImageDetail(detail: unknown): string {
    if (detail === undefined || detail === null || detail === '') return '';
    if (typeof detail !== 'string') return '';
    const d = detail.toLowerCase().trim();
    if (d === 'auto' || d === 'low' || d === 'high') return d;
    if (d === 'original') return 'high';
    return '';
}

function responsesToolToChatTool(tool: unknown): Record<string, unknown> | null {
    const t = asRecord(tool);
    const type = str(t['type']);
    if (type === 'function') {
        // Drop unnamed declarations: downstream validators reject empty names.
        if (!str(t['name'])) return null;
        return {
            type: 'function',
            function: {
                name: str(t['name']),
                description: str(t['description'] ?? ''),
                parameters: (t['parameters'] ?? { type: 'object', properties: {} }) as unknown,
            },
        };
    }
    if (type === 'custom') {
        // Codex freeform custom tools ride as function tools with a wrapped
        // {"input": string} schema; see Go mergeResponsesRequestChatTools.
        // `custom` may be a name string or a descriptor object. Unlike
        // function tools (dropped when unnamed — validators reject empty
        // names), custom tools always fall back to 'custom_tool' because the
        // shape itself implies a callable. NOTE: several unnamed customs
        // therefore share that one name and collapse via first-wins dedup
        // in pushTool — accepted: an unnamed declaration cannot be referenced
        // by any call, so nothing routable is lost.
        const custom = t['custom'];
        const customName = typeof custom === 'object' && custom !== null ? str(asRecord(custom)['name']) : str(custom);
        const name = str(t['name']) || customName || 'custom_tool';
        return {
            type: 'function',
            function: {
                name,
                description: str(t['description'] ?? ''),
                parameters: { type: 'object', properties: { input: { type: 'string' } } },
            },
        };
    }
    if (type === 'web_search' || type === 'web_search_preview') return null;
    return null;
}

function chatToolToResponsesTool(tool: unknown): Record<string, unknown> | null {
    const t = asRecord(tool);
    if (str(t['type']) !== 'function') return null;
    const fn = asRecord(t['function']);
    if (!str(fn['name'])) return null;
    return {
        type: 'function',
        name: str(fn['name']),
        description: str(fn['description'] ?? ''),
        parameters: (fn['parameters'] ?? { type: 'object', properties: {} }) as unknown,
    };
}

/**
 * responses.request -> chat.request.
 * Covers: instructions->system, input string/array (message, reasoning,
 * function_call(_output), custom_tool_call(_output)), tools, tool_choice,
 * max_output_tokens, reasoning.effort, text.format. Mirrors the Go converter
 * including strict assistant(tool_calls)->tool adjacency (deferred messages).
 */
export function convertResponsesRequestToChat(model: string, body: unknown, stream: boolean): unknown {
    const root = asRecord(body);
    const out: Record<string, unknown> = { model, messages: [], stream };
    const messages: Record<string, unknown>[] = [];

    const rawFormat = (() => {
        const tf = root['text'];
        if (tf && typeof tf === 'object' && !Array.isArray(tf)) {
            return (tf as Record<string, unknown>)['format'];
        }
        return undefined;
    })();
    if (rawFormat && typeof rawFormat === 'object') {
        const rf = rawFormat as Record<string, unknown>;
        const ft = str(rf['type']);
        if (ft === 'json_schema') {
            const js = asRecord(rf['json_schema'] ?? {});
            out['response_format'] = {
                type: 'json_schema',
                json_schema: {
                    name: str(js['name'] ?? rf['name'] ?? 'response'),
                    description: str(js['description'] ?? rf['description'] ?? ''),
                    strict: (js['strict'] ?? rf['strict'] ?? false) as unknown,
                    schema: (js['schema'] ?? rf['schema'] ?? { type: 'object' }) as unknown,
                },
            };
        } else if (ft === 'json_object' || ft === 'text') {
            out['response_format'] = { type: ft };
        }
    }

    const maxTokens = root['max_output_tokens'];
    if (typeof maxTokens === 'number') out['max_tokens'] = maxTokens;

    const instructions = root['instructions'];
    // Mirror Go Exists-check: emit system message when the key is present,
    // even when empty (request.go:61).
    if ('instructions' in root && typeof instructions === 'string') {
        messages.push({ role: 'system', content: instructions });
    }

    const input = root['input'];
    if (typeof input === 'string') {
        messages.push({ role: 'user', content: input });
    } else if (Array.isArray(input)) {
        const outputCallIds = new Set<string>();
        for (const item of input) {
            const it = asRecord(item);
            const t = str(it['type']);
            if (t === 'function_call_output' || t === 'custom_tool_call_output') {
                const id = str(it['call_id']).trim();
                if (id) outputCallIds.add(id);
            }
        }
        let pendingToolCalls: Record<string, unknown>[] = [];
        let pendingIds: string[] = [];
        let pendingReasoning = '';
        const awaiting = new Set<string>();
        const deferred: Record<string, unknown>[] = [];
        let mergeableAssistant = -1;
        const takeReasoning = (): string => {
            const r = pendingReasoning;
            pendingReasoning = '';
            return r;
        };
        const flushTools = (): void => {
            if (!pendingToolCalls.length) return;
            const reasoning = takeReasoning();
            let merged = false;
            if (mergeableAssistant >= 0 && mergeableAssistant === messages.length - 1) {
                const prev = messages[mergeableAssistant] as Record<string, unknown>;
                if (prev && prev['role'] === 'assistant' && prev['tool_calls'] === undefined) {
                    messages[mergeableAssistant] = { ...prev, tool_calls: pendingToolCalls };
                    if (reasoning) {
                        (messages[mergeableAssistant] as Record<string, unknown>)['reasoning_content'] = reasoning;
                    }
                    merged = true;
                }
            }
            if (!merged) {
                const m: Record<string, unknown> = { role: 'assistant', tool_calls: pendingToolCalls };
                if (reasoning) m['reasoning_content'] = reasoning;
                messages.push(m);
            }
            for (const id of pendingIds) if (id.trim()) awaiting.add(id);
            pendingToolCalls = [];
            pendingIds = [];
            mergeableAssistant = -1;
        };
        const hasAwaiting = (): boolean => {
            for (const id of awaiting) if (outputCallIds.has(id)) return true;
            return false;
        };
        const pushRegular = (m: Record<string, unknown>): number => {
            if (hasAwaiting()) {
                deferred.push(m);
                return -1;
            }
            messages.push(m);
            return messages.length - 1;
        };
        for (const item of input) {
            const it = asRecord(item);
            let t = str(it['type']);
            if (!t && str(it['role'])) t = 'message';
            if (t !== 'function_call' && t !== 'custom_tool_call') flushTools();
            if (t === 'message' || t === '') {
                let role = str(it['role']) || 'user';
                if (role === 'developer') role = 'user';
                mergeableAssistant = -1;
                // Flush buffered reasoning before a non-assistant message so it
                // is not silently attached to a later tool call (Go 156-164).
                if (role !== 'assistant' && pendingReasoning.trim()) {
                    const r = takeReasoning();
                    const rm: Record<string, unknown> = { role: 'assistant', content: '', reasoning_content: r };
                    if (hasAwaiting()) deferred.push(rm);
                    else messages.push(rm);
                }
                const msg: Record<string, unknown> = { role, content: [] };
                const content = it['content'];
                if (Array.isArray(content)) {
                    const parts: Record<string, unknown>[] = [];
                    for (const c of content) {
                        const cp = asRecord(c);
                        const ct = str(cp['type']) || 'input_text';
                        if (ct === 'input_text' || ct === 'output_text') {
                            parts.push({ type: 'text', text: str(cp['text']) });
                        } else if (ct === 'input_image') {
                            const url = str(cp['image_url']);
                            if (url) {
                                const part: Record<string, unknown> = { type: 'image_url', image_url: { url } };
                                const detail = normalizeImageDetail(cp['detail']);
                                if (detail) (part['image_url'] as Record<string, unknown>)['detail'] = detail;
                                parts.push(part);
                            }
                        }
                    }
                    msg['content'] = parts;
                } else if (typeof content === 'string') {
                    msg['content'] = content;
                }
                const idx = pushRegular(msg);
                if (role === 'assistant') mergeableAssistant = idx;
            } else if (t === 'reasoning') {
                pendingReasoning = combineReasoning(pendingReasoning, collectReasoningText(it));
                const rc = str(it['reasoning_content']);
                if (rc) pendingReasoning = combineReasoning(pendingReasoning, rc);
            } else if (t === 'function_call') {
                const rc = str(it['reasoning_content']);
                if (rc) pendingReasoning = combineReasoning(pendingReasoning, rc);
                pendingToolCalls.push({
                    id: str(it['call_id']),
                    type: 'function',
                    function: { name: qualifyToolName(it['namespace'], it['name']), arguments: normalizeArgs(it['arguments']) },
                });
                const id = str(it['call_id']).trim();
                if (id) pendingIds.push(id);
            } else if (t === 'function_call_output') {
                mergeableAssistant = -1;
                const callId = str(it['call_id']).trim();
                const output = it['output'];
                messages.push({
                    role: 'tool',
                    tool_call_id: callId,
                    content: typeof output === 'string' ? output : JSON.stringify(output ?? ''),
                });
                if (callId) awaiting.delete(callId);
                if (!awaiting.size && deferred.length) {
                    messages.push(...deferred.splice(0));
                }
            } else if (t === 'custom_tool_call') {
                const crc = str(it['reasoning_content']);
                if (crc) pendingReasoning = combineReasoning(pendingReasoning, crc);
                pendingToolCalls.push({
                    id: str(it['call_id']),
                    type: 'function',
                    function: {
                        name: qualifyToolName(it['namespace'], it['name']),
                        arguments: JSON.stringify({ input: str(it['input']) }),
                    },
                });
                const id = str(it['call_id']).trim();
                if (id) pendingIds.push(id);
            } else if (t === 'custom_tool_call_output') {
                mergeableAssistant = -1;
                const callId = str(it['call_id']).trim();
                const output = it['output'];
                messages.push({
                    role: 'tool',
                    tool_call_id: callId,
                    content: typeof output === 'string' ? output : JSON.stringify(output ?? ''),
                });
                if (callId) awaiting.delete(callId);
                if (!awaiting.size && deferred.length) {
                    messages.push(...deferred.splice(0));
                }
            } else {
                mergeableAssistant = -1;
            }
        }
        flushTools();
        if (pendingReasoning) {
            messages.push({ role: 'assistant', content: '', reasoning_content: pendingReasoning });
        }
        messages.push(...deferred.splice(0));
    }

    out['messages'] = messages;

    const tools = asArray(root['tools']);
    const chatTools: Record<string, unknown>[] = [];
    const seenToolNames = new Set<string>();
    const pushTool = (tool: unknown): void => {
        const mapped = responsesToolToChatTool(tool);
        if (!mapped) return;
        // First-wins dedup by chat name (Go mergeResponsesRequestChatTools).
        const name = str(asRecord(mapped['function'])['name']);
        if (name && seenToolNames.has(name)) return;
        if (name) seenToolNames.add(name);
        chatTools.push(mapped);
    };
    for (const tool of tools) pushTool(tool);
    // Codex Desktop delivers extra declarations via an "additional_tools" input
    // item (Go tools.go:81-99); merge them after top-level tools.
    // TODO(P4): full namespace-tree expansion (tools.go:25-80) + ambiguous
    // canonical reverse-map (tools.go:282-330); P1 flattens one level.
    if (Array.isArray(input)) {
        for (const item of input) {
            const it = asRecord(item);
            if (str(it['type']) !== 'additional_tools') continue;
            for (const tool of asArray(it['tools'])) pushTool(tool);
        }
    }
    if (chatTools.length) {
        out['tools'] = chatTools;
        if (root['parallel_tool_calls'] !== undefined) out['parallel_tool_calls'] = root['parallel_tool_calls'];
        if (root['tool_choice'] !== undefined) out['tool_choice'] = root['tool_choice'];
    }

    const reasoning = asRecord(root['reasoning']);
    const effort = str(reasoning['effort'] ?? root['reasoning_effort']).toLowerCase().trim();
    if (effort) out['reasoning_effort'] = effort;

    return out;
}

/**
 * chat.request -> responses.request (symmetric inverse; no Go counterpart).
 * Maps system->instructions, messages->input items, tool_calls->function_call,
 * tool->function_call_output, max_tokens->max_output_tokens.
 */
export function convertChatRequestToResponses(model: string, body: unknown, stream: boolean): unknown {
    const root = asRecord(body);
    const out: Record<string, unknown> = { model, stream };
    const input: Record<string, unknown>[] = [];

    for (const m of asArray(root['messages'])) {
        const msg = asRecord(m);
        const role = str(msg['role']) || 'user';
        if (role === 'system') {
            // Extract text from string or content-part arrays (matches the
            // textOf convention used by the other request translators).
            const content = msg['content'];
            const text = typeof content === 'string'
                ? content
                : Array.isArray(content)
                    ? content.map((p) => str(asRecord(p)['text'])).filter(Boolean).join('')
                    : JSON.stringify(content ?? '');
            out['instructions'] = out['instructions'] ? `${str(out['instructions'])}\n\n${text}` : text;
            continue;
        }
        const toolCalls = msg['tool_calls'];
        if (Array.isArray(toolCalls) && toolCalls.length) {
            const reasoning = str(msg['reasoning_content']);
            for (const tc of toolCalls) {
                const t = asRecord(tc);
                const fn = asRecord(t['function']);
                const item: Record<string, unknown> = {
                    type: 'function_call',
                    call_id: str(t['id']),
                    name: str(fn['name']),
                    arguments: normalizeArgs(fn['arguments']),
                };
                if (reasoning) item['reasoning_content'] = reasoning;
                input.push(item);
            }
            const content = msg['content'];
            if (typeof content === 'string' && content) {
                input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] });
            }
            continue;
        }
        if (role === 'tool') {
            input.push({
                type: 'function_call_output',
                call_id: str(msg['tool_call_id']),
                output: typeof msg['content'] === 'string' ? msg['content'] : JSON.stringify(msg['content'] ?? ''),
            });
            continue;
        }
        const content = msg['content'];
        if (typeof content === 'string') {
            input.push({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: content }] });
        } else if (Array.isArray(content)) {
            const parts: Record<string, unknown>[] = [];
            for (const p of content) {
                const part = asRecord(p);
                if (str(part['type']) === 'image_url') {
                    const iu = asRecord(part['image_url']);
                    // Preserve detail via the shared normalizer (Go
                    // request.go:207-209); responses side carries it on the
                    // input_image item itself. original->high, like the
                    // responses->chat direction.
                    const imageItem: Record<string, unknown> = { type: 'input_image', image_url: str(iu['url']) };
                    const detail = normalizeImageDetail(iu['detail']);
                    if (detail) imageItem['detail'] = detail;
                    parts.push(imageItem);
                } else {
                    parts.push({ type: 'input_text', text: str(part['text']) });
                }
            }
            input.push({ type: 'message', role, content: parts });
        }
    }

    out['input'] = input;

    const chatTools = asArray(root['tools']);
    const respTools: Record<string, unknown>[] = [];
    for (const tool of chatTools) {
        const mapped = chatToolToResponsesTool(tool);
        if (mapped) respTools.push(mapped);
    }
    if (respTools.length) {
        out['tools'] = respTools;
        if (root['parallel_tool_calls'] !== undefined) out['parallel_tool_calls'] = root['parallel_tool_calls'];
        if (root['tool_choice'] !== undefined) out['tool_choice'] = root['tool_choice'];
    }

    const maxTokens = root['max_tokens'];
    if (typeof maxTokens === 'number') out['max_output_tokens'] = maxTokens;
    const effort = str(root['reasoning_effort']).toLowerCase().trim();
    if (effort) out['reasoning'] = { effort };

    const responseFormat = asRecord(root['response_format']);
    const ft = str(responseFormat['type']);
    if (ft === 'json_schema') {
        const js = asRecord(responseFormat['json_schema']);
        out['text'] = {
            format: {
                type: 'json_schema',
                name: str(js['name'] ?? 'response'),
                description: str(js['description'] ?? ''),
                schema: (js['schema'] ?? { type: 'object' }) as unknown,
                strict: (js['strict'] ?? false) as unknown,
            },
        };
    } else if (ft === 'json_object') {
        out['text'] = { format: { type: 'json_object' } };
    }

    return out;
}
