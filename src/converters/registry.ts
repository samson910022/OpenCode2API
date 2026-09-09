/**
 * N×N translator registry.
 *
 * Port of CLIProxyAPI `sdk/translator/registry.go` (default-registry helpers
 * included as a module-level singleton). Semantics preserved:
 * - `register(from, to, request, response)` stores directed pairs.
 * - `translateRequest` falls back to the original payload when no pair is
 *   registered, still normalizing the top-level `model` field.
 * - `Has*` helpers report registered transforms without mutating state.
 * - Stream/non-stream/token-count translators fall back to passthrough.
 *
 * Deliberate deviation from Go: Go's `TranslateStream/NonStream/TokenCount`
 * look up `responses[to][from]` while `Has*` use `responses[from][to]`
 * (`registry.go:113-238`) because callers pass (upstream, client) order.
 * Here ALL lookups consistently use `[from][to]` = (source, target) so
 * `Has*` and `Translate*` agree; P1+ `init.ts` registrations must follow
 * this (source, target) contract.
 *
 * TODO(P1): middleware abort/error propagation (`pipeline.go:23,26` ctx/error
 * are omitted in P0; middleware currently cannot fail, only rewrite).
 *
 * Reference:
 * - github.com/router-for-me/CLIProxyAPI/sdk/translator/registry.go
 * - github.com/router-for-me/CLIProxyAPI/internal/translator/init.go
 */

import type { Format } from './formats.js';
import { asRecord } from '../utils/guards.js';
import type {
    RequestTransform,
    ResponseNonStreamTransform,
    ResponseStreamTransform,
    ResponseTokenCountTransform,
    ResponseTransform,
} from './translator-types.js';

function asNullableRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    // Reuse the shared guard for the object cast (AGENTS.md §9 single source).
    return asRecord(value);
}

export class TranslatorRegistry {
    private readonly requests = new Map<Format, Map<Format, RequestTransform>>();
    private readonly responses = new Map<Format, Map<Format, ResponseTransform>>();

    register(from: Format, to: Format, request: RequestTransform | null, response: ResponseTransform): void {
        let byTarget = this.requests.get(from);
        if (!byTarget) {
            byTarget = new Map<Format, RequestTransform>();
            this.requests.set(from, byTarget);
        }
        if (request) byTarget.set(to, request);

        let respByTarget = this.responses.get(from);
        if (!respByTarget) {
            respByTarget = new Map<Format, ResponseTransform>();
            this.responses.set(from, respByTarget);
        }
        respByTarget.set(to, response);
    }

    hasRequestTransformer(from: Format, to: Format): boolean {
        return this.requests.get(from)?.get(to) != null;
    }

    hasResponseTransformer(from: Format, to: Format): boolean {
        const fn = this.responses.get(from)?.get(to);
        if (!fn) return false;
        return fn.stream != null || fn.nonStream != null || fn.tokenCount != null;
    }

    hasStreamResponseTransformer(from: Format, to: Format): boolean {
        return this.responses.get(from)?.get(to)?.stream != null;
    }

    hasNonStreamResponseTransformer(from: Format, to: Format): boolean {
        return this.responses.get(from)?.get(to)?.nonStream != null;
    }

    translateRequest(from: Format, to: Format, model: string, body: unknown, stream: boolean): unknown {
        const fn = this.requests.get(from)?.get(to);
        if (fn) return fn(model, body, stream);
        // Fallback: preserve payload, normalize top-level model only.
        if (model) {
            const record = asNullableRecord(body);
            if (record && record['model'] !== model) {
                return { ...record, model };
            }
        }
        return body;
    }

    translateStream(
        from: Format,
        to: Format,
        model: string,
        originalRequest: unknown,
        translatedRequest: unknown,
        chunk: unknown,
        param?: unknown,
    ): unknown[] {
        // NOTE: CLIProxyAPI's Go TranslateStream looks up responses[to][from]
        // because its callers pass (upstream, client) order; here all lookups
        // consistently use responses[from][to] = (source, target) so Has* and
        // Translate* agree (see file header). P1+ registrations follow this.
        const stream = this.responses.get(from)?.get(to)?.stream;
        if (stream) return stream(model, originalRequest, translatedRequest, chunk, param);
        return [chunk];
    }

    translateNonStream(
        from: Format,
        to: Format,
        model: string,
        originalRequest: unknown,
        translatedRequest: unknown,
        body: unknown,
        param?: unknown,
    ): unknown {
        const fn: ResponseNonStreamTransform | null | undefined = this.responses.get(from)?.get(to)?.nonStream;
        if (fn) return fn(model, originalRequest, translatedRequest, body, param);
        return body;
    }

    translateTokenCount(from: Format, to: Format, count: number, fallback: unknown): unknown {
        const fn: ResponseTokenCountTransform | null | undefined = this.responses.get(from)?.get(to)?.tokenCount;
        if (fn) return fn(count);
        return fallback;
    }

    /** Directed-pair count, useful for tests/docs (mirrors init.go registration total). */
    size(): { requests: number; responses: number } {
        let requests = 0;
        let responses = 0;
        for (const byTarget of this.requests.values()) requests += byTarget.size;
        for (const byTarget of this.responses.values()) responses += byTarget.size;
        return { requests, responses };
    }
}

const defaultRegistry = new TranslatorRegistry();

export function defaultTranslatorRegistry(): TranslatorRegistry {
    return defaultRegistry;
}

export function registerTranslator(
    from: Format,
    to: Format,
    request: RequestTransform | null,
    response: ResponseTransform,
): void {
    defaultRegistry.register(from, to, request, response);
}
