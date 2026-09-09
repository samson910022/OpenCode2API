/**
 * N×N translator pipeline with middleware support.
 *
 * Port of CLIProxyAPI `sdk/translator/pipeline.go`. Envelopes carry format +
 * model + stream flags so middleware can inspect or rewrite either direction.
 * Terminal handlers delegate to {@link TranslatorRegistry}.
 * Stream terminal mirrors Go (`pipeline.go:88`): single `translateStream`
 * call over `body`, result stored as `chunks`.
 *
 * NOTE (wiring status): production routes do NOT use this pipeline yet —
 * they call the registry directly via `wire.ts` Safe wrappers
 * (error-bypass + per-stream holders). This class is exercised by
 * `tests/translator-registry.test.js` and reserved for future P1+ wiring.
 * Do not wire it into routes without a dedicated review: middleware can
 * rewrite `tools`/`system`/`model`, so any future use MUST document that
 * middleware never touches tools/system and MUST propagate errors
 * (see TODO below).
 *
 * TODO(P1): error-propagating middleware (`ResponseHandler` returning
 * `Result`/`throw`) to match Go `pipeline.go:23,26` ctx/error signatures.
 *
 * Reference:
 * - github.com/router-for-me/CLIProxyAPI/sdk/translator/pipeline.go
 */

import type { Format } from './formats.js';
import type { TranslatorRegistry } from './registry.js';
import { defaultTranslatorRegistry } from './registry.js';

export interface RequestEnvelope {
    format: Format;
    model: string;
    stream: boolean;
    body: unknown;
}

export interface ResponseEnvelope {
    format: Format;
    model: string;
    stream: boolean;
    body: unknown;
    chunks: unknown[];
}

export type RequestHandler = (req: RequestEnvelope) => RequestEnvelope;
export type ResponseHandler = (resp: ResponseEnvelope) => ResponseEnvelope;
export type RequestMiddleware = (req: RequestEnvelope, next: RequestHandler) => RequestEnvelope;
export type ResponseMiddleware = (resp: ResponseEnvelope, next: ResponseHandler) => ResponseEnvelope;

export class TranslatorPipeline {
    private readonly registry: TranslatorRegistry;
    private readonly requestMiddleware: RequestMiddleware[] = [];
    private readonly responseMiddleware: ResponseMiddleware[] = [];

    constructor(registry?: TranslatorRegistry) {
        this.registry = registry ?? defaultTranslatorRegistry();
    }

    useRequest(mw: RequestMiddleware): void {
        if (mw) this.requestMiddleware.push(mw);
    }

    useResponse(mw: ResponseMiddleware): void {
        if (mw) this.responseMiddleware.push(mw);
    }

    translateRequest(from: Format, to: Format, req: RequestEnvelope): RequestEnvelope {
        const terminal: RequestHandler = (input) => ({
            ...input,
            format: to,
            body: this.registry.translateRequest(from, to, input.model, input.body, input.stream),
        });
        const handler = this.requestMiddleware.reduceRight<RequestHandler>(
            (next, mw) => (r) => mw(r, next),
            terminal,
        );
        return handler(req);
    }

    translateResponse(
        from: Format,
        to: Format,
        resp: ResponseEnvelope,
        originalRequest: unknown,
        translatedRequest: unknown,
        param?: unknown,
    ): ResponseEnvelope {
        const terminal: ResponseHandler = (input) => {
            if (input.stream) {
                // Translate every buffered chunk through the same holder so
                // stateful translators see the whole stream in order. When no
                // chunks are buffered, fall back to translating the body once
                // (single-chunk envelope, mirrors Go pipeline.go:88).
                const sources = input.chunks.length ? input.chunks : [input.body];
                const chunks: unknown[] = [];
                for (const chunk of sources) {
                    chunks.push(
                        ...this.registry.translateStream(
                            from,
                            to,
                            input.model,
                            originalRequest,
                            translatedRequest,
                            chunk,
                            param,
                        ),
                    );
                }
                return { ...input, format: to, chunks };
            }
            return {
                ...input,
                format: to,
                body: this.registry.translateNonStream(
                    from,
                    to,
                    input.model,
                    originalRequest,
                    translatedRequest,
                    input.body,
                    param,
                ),
            };
        };
        const handler = this.responseMiddleware.reduceRight<ResponseHandler>(
            (next, mw) => (r) => mw(r, next),
            terminal,
        );
        return handler(resp);
    }
}
