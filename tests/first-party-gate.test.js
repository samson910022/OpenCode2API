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
        // Isolation check: padded with transient-looking text ("try again
        // later" alone WOULD match), so only the gate branch can yield false.
        // Name is neutral ('APIError' matches no signature).
        const padded = { name: 'APIError', data: { message: `${GATE_MESSAGE} - please try again later` } };
        expect(isTransientUpstreamError(padded)).toBe(false);
    });

    test('gate error does not engage proxy fallback', () => {
        expect(parseFreeLimitKind(GATE_ERROR)).toBeNull();
    });

    test('structured FreeTierError (live Zen shape) maps 403 + fail-fast', () => {
        // Live shape: backend wraps Zen's body; the class appears in
        // responseBody (and name/code/type), prose anchor in data.message.
        const live = {
            name: 'APIError',
            data: {
                message: GATE_MESSAGE,
                statusCode: 403,
                isRetryable: false,
                responseBody:
                    '{"type":"error","error":{"type":"FreeTierError","message":"free tier can only be used from within OpenCode"}}',
            },
        };
        expect(normalizeBackendError(live).statusCode).toBe(403);
        expect(transformUpstreamError(live).statusCode).toBe(403);
        expect(isTransientUpstreamError(live)).toBe(false);
        // Bare structured class without prose still classifies by type.
        const typed = { name: 'FreeTierError', data: { message: 'boom' } };
        expect(transformUpstreamError(typed).error.type).toBe('permission_denied');
        expect(isTransientUpstreamError(typed)).toBe(false);
    });

    test('incidental "within" phrasing is not a gate (no false-positive 403)', () => {
        // Would previously match the over-broad "free tier...+within" pattern.
        const quota = normalizeBackendError({ name: 'RateLimitError', data: { message: 'Free tier rate limit reached within 60 seconds' } });
        expect(quota.statusCode).toBe(429);
        expect(transformUpstreamError({ name: 'RateLimitError', data: { message: 'Free tier rate limit reached within 60 seconds' } }).error.type).toBe(
            'rate_limit_exceeded',
        );
        // Bare "from within" without the gate anchor stays out of 403.
        const incidental = transformUpstreamError({ name: 'APIError', data: { message: 'Error originated from within the model context' } });
        expect(incidental.statusCode).not.toBe(403);
        expect(incidental.error.type).not.toBe('permission_denied');
    });
});
