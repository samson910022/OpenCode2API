/**
 * Shared JSON scalar helpers for the N×N converters (single source; do not
 * duplicate per file). For unknown-guards use `src/utils/guards.ts`.
 */

export function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

export function num(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

/** Normalize tool-call arguments to a JSON string ({} for missing). */
export function normalizeArgs(args: unknown): string {
    if (args === undefined || args === null || args === '') return '{}';
    if (typeof args === 'string') return args;
    try {
        return JSON.stringify(args);
    } catch {
        return '{}';
    }
}
