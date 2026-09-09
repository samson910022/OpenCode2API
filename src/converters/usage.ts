/**
 * Cross-protocol usage mappers (pure).
 *
 * The four wire shapes stay distinct (AGENTS.md §9 — routes own them):
 * - chat:        {prompt_tokens, completion_tokens, total_tokens}
 * - responses:   {input_tokens, output_tokens, total_tokens}
 * - messages:    {input_tokens, output_tokens} (no total)
 * - interactions:{grounding_tool_count: [{type, count}]} (no tokens)
 *
 * Translators zero-fill unknown legs (a translated response never ran the
 * source's meter) instead of inventing tokens. Token-estimate heuristic
 * (len/4) lives in routes/collector and is intentionally not reused here.
 */

import { asRecord } from '../utils/guards.js';
import { num } from './json.js';

export interface ChatUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

export interface ResponsesUsage {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
}

export interface MessagesUsage {
    input_tokens: number;
    output_tokens: number;
}

export interface InteractionsUsage {
    grounding_tool_count: { type: string; count: number }[];
}

export function usageToChat(usage: unknown): ChatUsage {
    const u = asRecord(usage);
    const prompt = num(u['prompt_tokens'] ?? u['input_tokens']);
    const completion = num(u['completion_tokens'] ?? u['output_tokens']);
    const total = num(u['total_tokens'] ?? (prompt + completion));
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

export function usageToResponses(usage: unknown): ResponsesUsage {
    const u = asRecord(usage);
    const input = num(u['input_tokens'] ?? u['prompt_tokens']);
    const output = num(u['output_tokens'] ?? u['completion_tokens']);
    return { input_tokens: input, output_tokens: output, total_tokens: num(u['total_tokens'] ?? (input + output)) };
}

export function usageToMessages(usage: unknown): MessagesUsage {
    const u = asRecord(usage);
    return { input_tokens: num(u['input_tokens'] ?? u['prompt_tokens']), output_tokens: num(u['output_tokens'] ?? u['completion_tokens']) };
}

export function usageToInteractions(usage: unknown): InteractionsUsage {
    const u = asRecord(usage);
    const raw = u['grounding_tool_count'];
    if (Array.isArray(raw)) {
        // Zero-count entries are kept by design (zero-filled contract):
        // presence of the tool key matters, not just positive counts.
        const entries = raw.map((e) => {
            const r = asRecord(e);
            return { type: typeof r['type'] === 'string' ? (r['type'] as string) : 'google_search', count: num(r['count']) };
        });
        if (entries.length) return { grounding_tool_count: entries };
    }
    return { grounding_tool_count: [{ type: 'google_search', count: 0 }] };
}
