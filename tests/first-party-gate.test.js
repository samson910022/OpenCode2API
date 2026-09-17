import {
    normalizeBackendError,
    transformUpstreamError,
    isTransientUpstreamError,
    parseFreeLimitKind,
} from '../src/errors/upstream.js';

// First-party free-tier gate (server-side, closed-source inference service):
// "OpenCode's free tier can only be used from within OpenCode" + Python
// Traceback, with no numeric status attached. Must surface as 403 (not
// 500/502), never retry, and never engage proxy fallback.
const GATE_MESSAGE =
    "OpenCode's free tier can only be used from within OpenCode\nTraceback (most recent call last):\n  File \"inference.py\", line 1, in <module>";

const GATE_ERROR = { name: 'PermissionError', data: { message: GATE_MESSAGE } };

describe('first-party gate plumbing', () => {
    test('normalizeBackendError infers 403 without a numeric status', () => {
        const err = normalizeBackendError(GATE_ERROR);
        expect(err.statusCode).toBe(403);
        expect(err.message).toContain('from within OpenCode');
    });

    test('transformUpstreamError maps the gate to 403 permission_denied', () => {
        const out = transformUpstreamError(GATE_ERROR);
        expect(out.statusCode).toBe(403);
        expect(out.error.type).toBe('permission_denied');
        expect(out.error.code).toBe('permission_denied');
        expect(out.error.message).toContain('from within OpenCode');
    });

    test('explicit 403 status with gate message also maps to 403', () => {
        const out = transformUpstreamError({ name: 'PermissionError', data: { message: GATE_MESSAGE, statusCode: 403 } });
        expect(out.statusCode).toBe(403);
        expect(out.error.type).toBe('permission_denied');
    });

    test('gate error is never transient (no retry burn)', () => {
        expect(isTransientUpstreamError(GATE_ERROR)).toBe(false);
        expect(isTransientUpstreamError(normalizeBackendError(GATE_ERROR))).toBe(false);
    });

    test('gate error does not engage proxy fallback', () => {
        expect(parseFreeLimitKind(GATE_ERROR)).toBeNull();
    });
});
