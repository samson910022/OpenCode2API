import request from 'supertest';
import { jest } from '@jest/globals';

// Hosted-search routing guards (chat/messages 400-guide) + 401 wire shapes.
const sdkMocks = {
    configProviders: jest.fn(async () => ({
        data: { providers: [{ id: 'opencode', models: { 'kimi-k2.5': { name: 'Kimi' } } }] },
    })),
    configUpdate: jest.fn(async () => ({})),
    toolIds: jest.fn(async () => ({ data: ['websearch', 'webfetch'] })),
    sessionCreate: jest.fn(async () => ({ data: { id: 'route-session' } })),
    sessionPrompt: jest.fn(async () => ({ data: { parts: [{ type: 'text', text: 'ok' }] } })),
    sessionMessages: jest.fn(async () => ([
        { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'ok' }] },
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

function baseConfig(overrides = {}) {
    return {
        PORT: 10000,
        API_KEY: 'k1',
        OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
        REQUEST_TIMEOUT_MS: 5000,
        DISABLE_TOOLS: true,
        DEBUG: false,
        ...overrides,
    };
}

describe('hosted-search routing guards', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        sdkMocks.toolIds.mockResolvedValue({ data: ['websearch', 'webfetch'] });
    });

    test('chat completions rejects web_search with a pointer, not silent drop', async () => {
        const app = createApp(baseConfig({ API_KEY: '' })).app;
        const res = await request(app).post('/v1/chat/completions').send({
            model: 'opencode/kimi-k2.5',
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ type: 'web_search' }],
        });
        expect(res.statusCode).toBe(400);
        expect(res.body.error.type).toBe('invalid_request_error');
        expect(res.body.error.message).toContain('/v1/responses');
        expect(sdkMocks.sessionCreate).not.toHaveBeenCalled();
    });

    test('messages rejects Anthropic web_search with a pointer', async () => {
        const app = createApp(baseConfig({ API_KEY: '' })).app;
        const res = await request(app).post('/v1/messages').send({
            model: 'opencode/kimi-k2.5',
            max_tokens: 100,
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ type: 'web_search_20260222', name: 'web_search', max_uses: 3 }],
        });
        expect(res.statusCode).toBe(400);
        expect(res.body.type).toBe('error');
        expect(res.body.error.type).toBe('invalid_request_error');
        const google = await request(app).post('/v1/messages').send({
            model: 'opencode/kimi-k2.5',
            max_tokens: 100,
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ type: 'google_search' }],
        });
        expect(google.statusCode).toBe(400);
    });

    test('plain function tools still bridge on chat/messages', async () => {
        const app = createApp(baseConfig({ API_KEY: '' })).app;
        const chat = await request(app).post('/v1/chat/completions').send({
            model: 'opencode/kimi-k2.5',
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
        });
        expect(chat.statusCode).toBe(200);
    });
});

describe('401 wire shapes', () => {
    test('chat/responses/interactions share the generic shape; messages keeps Anthropic shape', async () => {
        const app = createApp(baseConfig({})).app;
        const chat = await request(app).post('/v1/chat/completions').send({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
        expect(chat.statusCode).toBe(401);
        expect(chat.body).toEqual({ error: { message: 'Unauthorized' } });
        const resp = await request(app).post('/v1/responses').send({ model: 'm', input: 'hi' });
        expect(resp.statusCode).toBe(401);
        expect(resp.body).toEqual({ error: { message: 'Unauthorized' } });
        const intr = await request(app).post('/v1beta/interactions').send({ model: 'm', input: 'hi' });
        expect(intr.statusCode).toBe(401);
        expect(intr.body).toEqual({ error: { message: 'Unauthorized' } });
        const msg = await request(app).post('/v1/messages').send({ model: 'm', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] });
        expect(msg.statusCode).toBe(401);
        expect(msg.body).toEqual({ type: 'error', error: { type: 'authentication_error', message: 'Unauthorized' } });
    });

    test('/metrics honors multi-key auth', async () => {
        const app = createApp(baseConfig({ API_KEYS: ['k1', 'k2'], METRICS_ENABLED: true, METRICS_REQUIRE_AUTH: true })).app;
        const bad = await request(app).get('/metrics');
        expect(bad.statusCode).toBe(401);
        const ok = await request(app).get('/metrics').set('x-api-key', 'k2');
        expect(ok.statusCode).toBe(200);
        expect(ok.text).toContain('opencode_fallback_proxy_configured');
    });
});
