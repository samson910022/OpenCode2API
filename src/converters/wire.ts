/**
 * Route wiring helpers for the N×N translator registry (Phase 1接線基礎).
 *
 * Rules (AGENTS.md §5/§9 — routes own the wire):
 * - Error envelopes MUST bypass translators (converters assume valid
 *   requests). Use the *Safe wrappers here, never registry.translate* directly.
 * - SSE envelopes, `[DONE]` presence, the four error-exit shapes, and usage
 *   key names stay route-owned; translators only map JSON payloads.
 * - Translated `tools`/`tool_choice` MUST still flow through the proxy
 *   bridge (`external__*`) + internal allowlist (`server ∩ request`);
 *   `qualifyToolName` output is an upstream-namespace helper, not gateway auth.
 * - Translated `usage` is client-facing only; `/metrics` keeps
 *   collector-measured counts.
 *
 * Pure layer: no Express/SDK deps (only registry/formats/guards/holder).
 */

import type { Format } from './formats.js';
import type { TranslatorRegistry } from './registry.js';
import { defaultTranslatorRegistry } from './registry.js';
import { registerAllTranslatorPairs } from './init.js';
import { asRecord } from '../utils/guards.js';
import type { StreamHolder } from './holder.js';
import { createStreamHolder } from './holder.js';

/** Ensure the shared registry is initialized once (idempotent). */
export function ensureTranslatorsRegistered(registry: TranslatorRegistry = defaultTranslatorRegistry()): TranslatorRegistry {
    registerAllTranslatorPairs(registry);
    return registry;
}

/**
 * True when a payload is an error envelope (or error-event chunk) that must
 * bypass translators. Covers the four route error-exit shapes plus the
 * unwrapped TransformedUpstreamErrorBody ({message, type, code?}):
 * - chat non-stream JSON: {error: ...} or bare {message, type, ...}
 * - responses-stream: {type: 'response.failed', ...}
 * - messages-stream: {type: 'error'} / {event: 'error', ...}
 * - interactions-stream: {type: 'error'} / {event: 'error', ...}
 * - raw SSE strings containing an error event marker
 */
export function isErrorEnvelope(payload: unknown): boolean {
    if (typeof payload === 'string') {
        return payload.includes('event: error') || payload.includes('"type":"error"') || payload.includes('"type": "error"') || payload.includes('response.failed');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const r = asRecord(payload);
    // Wrapped envelopes: {error: {...}} / {error: 'msg'}. Falsy sentinels
    // (''/0/false) are not error envelopes.
    const wrapped = r['error'];
    if (wrapped !== undefined && wrapped !== null && wrapped !== false && wrapped !== 0 && wrapped !== '') return true;
    const type = r['type'];
    if (type === 'error' || type === 'response.failed') return true;
    if (r['event'] === 'error') return true;
    // Bare TransformedUpstreamErrorBody emitted unwrapped by routes
    // (chat.ts:919, responses.ts:1140, interactions.ts:420):
    // {message: '...', type: '<code>', code?, available_models?} with none of
    // the valid-payload markers (choices/output/content/data).
    const message = r['message'];
    if (
        typeof message === 'string' && message.length > 0 &&
        typeof type === 'string' && type.length > 0 &&
        r['choices'] === undefined && r['output'] === undefined && r['content'] === undefined && r['data'] === undefined
    ) {
        return true;
    }
    return false;
}

/**
 * Request translation with error bypass (error bodies pass through untouched).
 *
 * NOTE: only for pre-validation contexts. Post-validation inbound legs
 * (e.g. messages.ts after validateMessagesRequest) MUST use direct
 * `registry.translateRequest` instead — validation ignores extra fields, so
 * an adversarial `type:'error'` extra would bypass conversion here and cause
 * mode confusion downstream.
 */
export function translateRequestSafe(
    registry: TranslatorRegistry,
    from: Format,
    to: Format,
    model: string,
    body: unknown,
    stream: boolean,
): unknown {
    if (isErrorEnvelope(body)) return body;
    return registry.translateRequest(from, to, model, body, stream);
}

/** Non-stream response translation with error bypass. */
export function translateNonStreamSafe(
    registry: TranslatorRegistry,
    from: Format,
    to: Format,
    model: string,
    originalRequest: unknown,
    translatedRequest: unknown,
    body: unknown,
    param?: unknown,
): unknown {
    if (isErrorEnvelope(body)) return body;
    return registry.translateNonStream(from, to, model, originalRequest, translatedRequest, body, param);
}

/** Stream chunk translation with error bypass (error chunks pass through as-is). */
export function translateStreamSafe(
    registry: TranslatorRegistry,
    from: Format,
    to: Format,
    model: string,
    originalRequest: unknown,
    translatedRequest: unknown,
    chunk: unknown,
    param?: unknown,
): unknown[] {
    if (isErrorEnvelope(chunk)) return [chunk];
    return registry.translateStream(from, to, model, originalRequest, translatedRequest, chunk, param);
}

/** Allocate a fresh per-stream holder (one holder per stream; reuse across chunks). */
export function newStreamHolder<T>(): StreamHolder<T> {
    return createStreamHolder<T>();
}

export type { StreamHolder };
