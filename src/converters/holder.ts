/**
 * Shared stream-holder helper (single source; AGENTS.md §9).
 *
 * Streaming translators are stateful: callers MUST pass the same holder
 * object as `param` for every chunk of one stream. The translator instance
 * is cached on the holder. Passing no holder (undefined/null/primitive)
 * translates each call as an independent single-chunk stream — correct for
 * single-shot tests but NOT for multi-chunk streams.
 *
 * Mirrors Go `param *any`. All four pair init.ts files delegate here so the
 * contract cannot drift per-pair.
 */

export interface StreamHolder<T> {
    translator?: T;
}

/** Return the cached translator for this stream, creating it on first chunk. */
export function holderTranslatorOf<T>(param: unknown, model: string, create: (model: string) => T): T {
    if (param && typeof param === 'object') {
        const holder = param as StreamHolder<T>;
        if (!holder.translator) holder.translator = create(model);
        return holder.translator;
    }
    return create(model);
}

/** Allocate a fresh holder for one stream (one holder per stream). */
export function createStreamHolder<T>(): StreamHolder<T> {
    return {};
}
