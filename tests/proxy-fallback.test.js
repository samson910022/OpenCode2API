import { jest } from '@jest/globals';
import request from 'supertest';
import {
    isFreeUsageLimitError,
    parseFreeLimitKind,
    normalizeBackendError,
} from '../src/errors/upstream.js';
import {
    createProxyPool,
    parseProxyList,
    parseProxyNoProxyList,
} from '../src/upstream-proxy/pool.js';
import {
    engageFallbackForFreeLimit,
    shouldFallbackToProxy,
} from '../src/upstream-proxy/fallback.js';

function freeUsageError() {
    // NOTE: no responseHeaders here — retry-after would force a 30s clamped
    // sleep in route retry loops and stall integration tests.
    return {
        name: 'APIError',
        data: {
            message: 'Rate limit exceeded. Please try again later.',
            statusCode: 429,
            isRetryable: true,
            responseBody: '{"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded."}}',
        },
    };
}

function goUsageError() {
    return {
        name: 'APIError',
        data: {
            message: '5-hour usage limit reached. Resets in 5 hours.',
            statusCode: 429,
            isRetryable: true,
            responseBody: '{"type":"error","error":{"type":"GoUsageLimitError"},"metadata":{"workspace":"wrk_x","limitName":"5 hour"}}',
        },
    };
}

describe('free-limit fingerprint', () => {
    test('matches 429 + FreeUsageLimitError / GoUsageLimitError', () => {
        expect(parseFreeLimitKind(freeUsageError())).toBe('free');
        expect(parseFreeLimitKind(goUsageError())).toBe('go');
        expect(isFreeUsageLimitError(freeUsageError())).toBe(true);
    });

    test('rejects non-quota errors', () => {
        expect(isFreeUsageLimitError(null)).toBe(false);
        expect(isFreeUsageLimitError({})).toBe(false);
        // plain 429 without class marker
        expect(isFreeUsageLimitError({ data: { message: 'slow down', statusCode: 429 } })).toBe(false);
        // 401 billing line is never a free-limit fallback
        expect(
            isFreeUsageLimitError({
                data: { message: 'Insufficient balance', statusCode: 401, responseBody: '{"error":{"type":"CreditsError"}}' },
            }),
        ).toBe(false);
        // 500 overload keeps the direct path
        expect(isFreeUsageLimitError({ data: { message: 'overloaded', statusCode: 500 } })).toBe(false);
        // message-text match still requires 429
        expect(isFreeUsageLimitError({ data: { message: 'Free usage exceeded, subscribe to Go', statusCode: 500 } })).toBe(false);
    });

    test('string statusCode and data.type markers are accepted', () => {
        expect(parseFreeLimitKind({ data: { message: 'x', statusCode: '429', type: 'FreeUsageLimitError' } })).toBe('free');
        expect(parseFreeLimitKind({ data: { message: 'x', statusCode: '429', code: 'GoUsageLimitError' } })).toBe('go');
        expect(parseFreeLimitKind({ data: { message: 'x', statusCode: '200', type: 'FreeUsageLimitError' } })).toBeNull();
    });

    test('normalizeBackendError preserves responseBody for post-normalize matching', () => {
        const normalized = normalizeBackendError(freeUsageError());
        expect(typeof normalized.responseBody).toBe('string');
        expect(normalized.responseBody).toContain('FreeUsageLimitError');
        expect(isFreeUsageLimitError(normalized)).toBe(true);
    });
});

describe('proxy list parsing', () => {
    test('comma string, arrays, dedupe, invalid filtered', () => {
        expect(parseProxyList('socks5://a:1080, http://b:8080')).toEqual(['socks5://a:1080', 'http://b:8080']);
        expect(parseProxyList(['socks5://a:1080', 'socks5://a:1080', 'ftp://x', '', 42])).toEqual(['socks5://a:1080']);
        expect(parseProxyList('')).toEqual([]);
        expect(parseProxyList(undefined)).toEqual([]);
        expect(parseProxyList('socks5h://u:p@h:1080')).toEqual(['socks5h://u:p@h:1080']);
    });

    test('socks-first stable ordering regardless of input order', () => {
        expect(parseProxyList('http://b:8080, socks5://a:1080')).toEqual(['socks5://a:1080', 'http://b:8080']);
        expect(parseProxyList('http://b:8080, https://c:8443, socks5://a:1080, socks5h://d:1080')).toEqual([
            'socks5://a:1080',
            'socks5h://d:1080',
            'http://b:8080',
            'https://c:8443',
        ]);
    });

    test('no-proxy defaults to loopback', () => {
        expect(parseProxyNoProxyList(undefined, ['localhost'])).toEqual(['localhost']);
        expect(parseProxyNoProxyList('', ['localhost'])).toEqual(['localhost']);
        expect(parseProxyNoProxyList('Example.COM, a', [])).toEqual(['example.com', 'a']);
    });

    test('strategy/cooldown normalize to truthful values', async () => {
        const pool = await import('../src/upstream-proxy/pool.js');
        expect(pool.normalizeProxyStrategy('random')).toBe('random');
        expect(pool.normalizeProxyStrategy(' ROUND-ROBIN ')).toBe('round-robin');
        expect(pool.normalizeProxyStrategy('turbo')).toBe('failover-rr');
        expect(pool.normalizeProxyStrategy('')).toBe('failover-rr');
        expect(pool.normalizeProxyCooldownMs(60000)).toBe(60000);
        expect(pool.normalizeProxyCooldownMs('15000')).toBe(15000);
        expect(pool.normalizeProxyCooldownMs('garbage')).toBe(300000);
        expect(pool.normalizeProxyCooldownMs(0)).toBe(300000);
        expect(pool.normalizeProxyCooldownMs(-5)).toBe(300000);
    });
});

describe('proxy pool (network-free)', () => {
    let savedFetch;
    let fetchCalls;
    beforeEach(() => {
        fetchCalls = [];
        savedFetch = globalThis.fetch;
        globalThis.fetch = jest.fn(async (...args) => {
            fetchCalls.push(args);
            return new Response('direct-ok');
        });
    });
    afterEach(() => {
        globalThis.fetch = savedFetch;
    });

    test('empty pool is direct-only and never engages', async () => {
        const pool = createProxyPool({});
        expect(pool.hasProxies()).toBe(false);
        expect(pool.engage('x')).toBeNull();
        expect(pool.isEngaged()).toBe(false);
        const res = await pool.proxiedFetch('https://example.com/api', {});
        expect(fetchCalls.length).toBe(1);
        expect(await res.text()).toBe('direct-ok');
    });

    test('loopback targets bypass even while engaged', async () => {
        const pool = createProxyPool({ proxies: 'http://10.0.0.1:8080', cooldownMs: 60000 });
        expect(pool.engage('free')).toContain('http://');
        expect(pool.isEngaged()).toBe(true);
        await pool.proxiedFetch('http://127.0.0.1:10001/health', {});
        await pool.proxiedFetch('http://localhost:10001/health', {});
        await pool.proxiedFetch('http://[::1]:10001/health', {});
        expect(fetchCalls.length).toBe(3);
        const status = pool.getStatus();
        expect(status.configured).toBe(1);
        expect(status.engaged).toBe(true);
        expect(status.current).toBe('http://10.0.0.1:8080');
    });

    test('engagement expires after cooldown', async () => {
        const pool = createProxyPool({ proxies: 'http://10.0.0.1:8080', cooldownMs: 30 });
        pool.engage('free');
        expect(pool.isEngaged()).toBe(true);
        await new Promise((r) => setTimeout(r, 60));
        expect(pool.isEngaged()).toBe(false);
        pool.disengage();
        expect(pool.getStatus().engaged).toBe(false);
    });

    test('proxy credentials never appear in status labels', () => {
        const pool = createProxyPool({ proxies: 'socks5://user:secret@10.0.0.9:1080' });
        expect(pool.engage('free')).toBe('socks5://10.0.0.9:1080');
        const status = pool.getStatus();
        expect(status.current).toBe('socks5://10.0.0.9:1080');
        expect(JSON.stringify(status)).not.toContain('secret');
        expect(JSON.stringify(status)).not.toContain('user@');
    });

    test('fallback glue respects pool presence and fingerprint', () => {
        const pool = createProxyPool({ proxies: 'socks5://10.0.0.2:1080' });
        expect(shouldFallbackToProxy(freeUsageError(), null)).toBe(false);
        expect(shouldFallbackToProxy(freeUsageError(), createProxyPool({}))).toBe(false);
        expect(shouldFallbackToProxy({ data: { statusCode: 500 } }, pool)).toBe(false);
        expect(shouldFallbackToProxy(freeUsageError(), pool)).toBe(true);
        expect(engageFallbackForFreeLimit(freeUsageError(), pool, () => {})).toBe(true);
        expect(pool.isEngaged()).toBe(true);
    });
});

// Route-level: free-limit on attempt 1 engages the pool and retries via proxy.
const sdkMocks = {
    configProviders: jest.fn(async () => ({
        data: { providers: [{ id: 'opencode', models: { 'kimi-k2.5': { name: 'Kimi' } } }] },
    })),
    configUpdate: jest.fn(async () => ({})),
    toolIds: jest.fn(async () => ({ data: [] })),
    sessionCreate: jest.fn(async () => ({ data: { id: 'fb-session' } })),
    sessionPrompt: jest.fn(async () => ({ data: { parts: [{ type: 'text', text: 'ok' }] } })),
    sessionMessages: jest.fn(async () => ([
        { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'recovered' }] },
    ])),
    sessionDelete: jest.fn(async () => ({})),
    eventSubscribe: jest.fn(async () => ({ stream: (async function* () {})() })),
};

jest.unstable_mockModule('@opencode-ai/sdk', () => ({
    createOpencodeClient: jest.fn(() => ({
        config: { providers: sdkMocks.configProviders, update: sdkMocks.configUpdate },
        tool: { ids: sdkMocks.toolIds },
        session: { create: sdkMocks.sessionCreate, prompt: sdkMocks.sessionPrompt, messages: sdkMocks.sessionMessages, delete: sdkMocks.sessionDelete },
        event: { subscribe: sdkMocks.eventSubscribe },
    })),
}));

jest.unstable_mockModule('http', () => ({
    default: {
        get: jest.fn((url, options, callback) => {
            const cb = typeof options === 'function' ? options : callback;
            cb({ statusCode: 200, headers: {}, on: jest.fn() });
            return { on: jest.fn(), destroy: jest.fn(), setTimeout: jest.fn() };
        }),
    },
}));

jest.unstable_mockModule('https', () => ({
    default: {
        get: jest.fn((url, options, callback) => {
            const cb = typeof options === 'function' ? options : callback;
            const res = { statusCode: 200, headers: {}, on: jest.fn() };
            cb(res);
            return { on: jest.fn(), destroy: jest.fn() };
        }),
    },
}));

const { createApp } = await import('../src/proxy.js');

describe('route fallback integration', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        sdkMocks.sessionPrompt.mockImplementation(async () => ({ data: { parts: [{ type: 'text', text: 'ok' }] } }));
    });

    test('messages non-stream retries via proxy after free-limit and reports engagement', async () => {
        sdkMocks.sessionPrompt.mockRejectedValueOnce(freeUsageError());
        const app = createApp({
            PORT: 10000,
            API_KEY: 'k1',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            RETRY_MAX_RETRIES: 1,
            UPSTREAM_PROXIES: ['http://10.0.0.1:8080'],
            UPSTREAM_PROXY_COOLDOWN_MS: 60000,
        }).app;
        const res = await request(app)
            .post('/v1/messages')
            .set('Authorization', 'Bearer k1')
            .send({ model: 'opencode/kimi-k2.5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
        expect(res.statusCode).toBe(200);
        expect(sdkMocks.sessionPrompt.mock.calls.length).toBeGreaterThanOrEqual(2);
        const details = await request(app).get('/health/details').set('Authorization', 'Bearer k1');
        expect(details.statusCode).toBe(200);
        expect(details.body.internal_tools.fallback_proxies.configured).toBe(1);
        expect(details.body.internal_tools.fallback_proxies.engaged).toBe(true);
    }, 30000);

    test('stream paths skip SSE while engaged (messages + chat)', async () => {
        // Arm engagement with one free-limit round-trip first.
        sdkMocks.sessionPrompt.mockRejectedValueOnce(freeUsageError());
        const app = createApp({
            PORT: 10000,
            API_KEY: 'k1',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            RETRY_MAX_RETRIES: 1,
            UPSTREAM_PROXIES: ['http://10.0.0.1:8080'],
            UPSTREAM_PROXY_COOLDOWN_MS: 60000,
        }).app;
        const arm = await request(app)
            .post('/v1/messages')
            .set('Authorization', 'Bearer k1')
            .send({ model: 'opencode/kimi-k2.5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
        expect(arm.statusCode).toBe(200);
        jest.clearAllMocks();
        const stream = await request(app)
            .post('/v1/messages')
            .set('Authorization', 'Bearer k1')
            .send({ model: 'opencode/kimi-k2.5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], stream: true });
        expect(stream.statusCode).toBe(200);
        expect(stream.text).toContain('message_stop');
        // Fallback never touches the event stream (SDK ignores custom fetch there).
        expect(sdkMocks.eventSubscribe).not.toHaveBeenCalled();
        jest.clearAllMocks();
        const chatStream = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer k1')
            .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'hi' }], stream: true });
        expect(chatStream.statusCode).toBe(200);
        expect(chatStream.text).toContain('data: [DONE]');
        expect(sdkMocks.eventSubscribe).not.toHaveBeenCalled();
        jest.clearAllMocks();
        const respStream = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer k1')
            .send({ model: 'opencode/kimi-k2.5', input: 'hi', stream: true });
        expect(respStream.statusCode).toBe(200);
        expect(respStream.text).toContain('response.completed');
        expect(sdkMocks.eventSubscribe).not.toHaveBeenCalled();
    }, 60000);

    test('without proxies the same error surfaces as 429 without engagement', async () => {
        sdkMocks.sessionPrompt.mockRejectedValueOnce(freeUsageError());
        sdkMocks.sessionMessages.mockResolvedValueOnce([
            { info: { role: 'assistant', error: freeUsageError(), finish: 'stop' }, parts: [] },
        ]);
        const app = createApp({
            PORT: 10000,
            API_KEY: 'k1',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 2000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            RETRY_MAX_RETRIES: 0,
        }).app;
        const res = await request(app)
            .post('/v1/messages')
            .set('Authorization', 'Bearer k1')
            .send({ model: 'opencode/kimi-k2.5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
        expect(res.statusCode).toBe(429);
        const details = await request(app).get('/health/details').set('Authorization', 'Bearer k1');
        expect(details.body.internal_tools.fallback_proxies.configured).toBe(0);
        expect(details.body.internal_tools.fallback_proxies.engaged).toBe(false);
    }, 30000);
});
