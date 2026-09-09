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

/**
 * Keep a response id only when it already carries the target protocol prefix
 * (clients branch on resp_/chatcmpl-/msg_/intr_); otherwise generate a fresh
 * one so translated bodies never leak a foreign prefix downstream.
 */
export function targetId(id: unknown, prefix: string, generate: () => string): string {
    if (typeof id === 'string' && id.startsWith(prefix) && id.length > prefix.length) return id;
    return generate();
}
