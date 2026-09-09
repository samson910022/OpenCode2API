/**
 * N×N stream fidelity ledger.
 *
 * Three forward edges out of chat are FULL fidelity (tool-arg aggregation,
 * per-index allocation, terminal usage, holder-contract state machines):
 * chat -> responses / messages / interactions.
 *
 * The remaining nine reverse/composed edges are TEXT-CORE: text deltas +
 * terminal mapping with zero-filled usage legs. Tool-arg deltas, thinking /
 * signature streaming, and grounding-step streaming on those edges are
 * explicitly out of scope (marked TODO(P4+) at each translator) — they
 * exist so no directed stream edge is missing, not as full-fidelity ports.
 *
 * TokenCount translators are intentionally UNREGISTERED on all edges: this
 * gateway counts via the collector len/4 estimate in routes, unlike
 * CLIProxyAPI where TokenCount serves billing/limits
 * (cf. openai/claude/init.go ClaudeTokenCount). Registry tokenCount calls
 * therefore use the documented fallback.
 */

import type { Format } from './formats.js';
import { FormatClaude, FormatInteractions, FormatOpenAI, FormatOpenAIResponse } from './formats.js';

export type StreamFidelity = 'full' | 'text-core';

export const STREAM_FIDELITY: Readonly<Record<string, StreamFidelity>> = {
    [`${FormatOpenAI}->${FormatOpenAIResponse}`]: 'full',
    [`${FormatOpenAI}->${FormatClaude}`]: 'full',
    [`${FormatOpenAI}->${FormatInteractions}`]: 'full',
    [`${FormatOpenAIResponse}->${FormatOpenAI}`]: 'text-core',
    [`${FormatClaude}->${FormatOpenAI}`]: 'text-core',
    [`${FormatClaude}->${FormatOpenAIResponse}`]: 'text-core',
    [`${FormatOpenAIResponse}->${FormatClaude}`]: 'text-core',
    [`${FormatInteractions}->${FormatOpenAI}`]: 'text-core',
    [`${FormatInteractions}->${FormatOpenAIResponse}`]: 'text-core',
    [`${FormatInteractions}->${FormatClaude}`]: 'text-core',
    [`${FormatOpenAIResponse}->${FormatInteractions}`]: 'text-core',
    [`${FormatClaude}->${FormatInteractions}`]: 'text-core',
};

export function streamFidelityOf(from: Format, to: Format): StreamFidelity | undefined {
    return STREAM_FIDELITY[`${from}->${to}`];
}

export const TOKEN_COUNT_REGISTERED = false;
