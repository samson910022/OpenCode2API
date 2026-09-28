import request from 'supertest';
import { jest } from '@jest/globals';

const sdkMocks = {
    configProviders: jest.fn(async () => ({
        data: {
            providers: [{ id: 'opencode', models: { 'kimi-k2.5': { name: 'Kimi' } } }]
        }
    })),
    configUpdate: jest.fn(async () => ({})),
    toolIds: jest.fn(async () => ({ data: ['web_fetch', 'filesystem', 'bash'] })),
    sessionCreate: jest.fn(async () => ({ data: { id: 'alias-session' } })),
    sessionPrompt: jest.fn(async () => ({ data: { parts: [{ type: 'text', text: 'ok' }] } })),
    sessionMessages: jest.fn(async () => ([{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'ok' }] }])),
    sessionDelete: jest.fn(async () => ({})),
    eventSubscribe: jest.fn(async () => ({ stream: (async function* () {})() }))
};

jest.unstable_mockModule('@opencode-ai/sdk', () => ({
    createOpencodeClient: jest.fn(() => ({
        config: { providers: sdkMocks.configProviders, update: sdkMocks.configUpdate },
        tool: { ids: sdkMocks.toolIds },
        session: { create: sdkMocks.sessionCreate, prompt: sdkMocks.sessionPrompt, messages: sdkMocks.sessionMessages, delete: sdkMocks.sessionDelete },
        event: { subscribe: sdkMocks.eventSubscribe }
    }))
}));

jest.unstable_mockModule('http', () => ({
    default: {
        get: jest.fn((url, options, callback) => {
            const cb = typeof options === 'function' ? options : callback;
            const response = { statusCode: 200, headers: {}, on: jest.fn() };
            cb(response);
            return { on: jest.fn(), destroy: jest.fn(), setTimeout: jest.fn() };
        })
    }
}));

jest.unstable_mockModule('https', () => ({
    default: {
        get: jest.fn((url, options, callback) => {
            const cb = typeof options === 'function' ? options : callback;
            const res = {
                statusCode: 200,
                headers: { 'content-type': 'image/png' },
                on: jest.fn((event, handler) => {
                    if (event === 'data') handler(Buffer.from('fake-image-data'));
                    if (event === 'end') handler();
                })
            };
            cb(res);
            return { on: jest.fn(), destroy: jest.fn() };
        })
    }
}));

const { createApp } = await import('../src/proxy.js');
const { normalizeToolNameForMatch } = await import('../src/tool-runtime/registry.js');

function baseConfig(overrides = {}) {
    return {
        PORT: 10000,
        API_KEY: '',
        OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
        REQUEST_TIMEOUT_MS: 5000,
        DISABLE_TOOLS: true,
        DEBUG: false,
        ...overrides,
    };
}

describe('internal allowlist alias matching', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        sdkMocks.toolIds.mockResolvedValue({ data: ['web_fetch', 'filesystem', 'bash'] });
    });

    test('normalizeToolNameForMatch is separator/case insensitive', () => {
        expect(normalizeToolNameForMatch('web_fetch')).toBe('webfetch');
        expect(normalizeToolNameForMatch('webfetch')).toBe('webfetch');
        expect(normalizeToolNameForMatch('Web-Search')).toBe('websearch');
        expect(normalizeToolNameForMatch('')).toBe('');
    });

    test("allowlist 'webfetch' matches backend 'web_fetch'", async () => {
        const app = createApp(baseConfig({ INTERNAL_ALLOWED_TOOLS: ['webfetch'] })).app;
        const res = await request(app).post('/v1/chat/completions')
            .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'hi' }] });
        expect(res.statusCode).toBe(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.tools).toEqual({ web_fetch: true, filesystem: false, bash: false });
    });

    test("legacy 'web_fetch' still matches real backend 'webfetch'", async () => {
        sdkMocks.toolIds.mockResolvedValue({ data: ['webfetch', 'filesystem'] });
        const app = createApp(baseConfig({ INTERNAL_ALLOWED_TOOLS: ['web_fetch'] })).app;
        const res = await request(app).post('/v1/chat/completions')
            .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'hi' }] });
        expect(res.statusCode).toBe(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.tools).toEqual({ webfetch: true, filesystem: false });
    });

    test("allowlist 'websearch' matches backend 'websearch'", async () => {
        sdkMocks.toolIds.mockResolvedValue({ data: ['websearch', 'webfetch'] });
        const app = createApp(baseConfig({ INTERNAL_ALLOWED_TOOLS: ['websearch'] })).app;
        const res = await request(app).post('/v1/chat/completions')
            .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'hi' }] });
        expect(res.statusCode).toBe(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.tools).toEqual({ websearch: true, webfetch: false });
    });

    test('messages route honors request-level narrowing (parity with chat)', async () => {
        const app = createApp(baseConfig({ INTERNAL_ALLOWED_TOOLS: ['webfetch', 'filesystem'] })).app;
        const res = await request(app).post('/v1/messages')
            .send({
                model: 'opencode/kimi-k2.5',
                max_tokens: 100,
                messages: [{ role: 'user', content: 'hi' }],
                opencode: { internal_allowed_tools: ['filesystem'] },
            });
        expect(res.statusCode).toBe(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.tools).toEqual({ web_fetch: false, filesystem: true, bash: false });
    });
});

describe('tool discovery unavailable fails closed', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        sdkMocks.toolIds.mockReset();
        sdkMocks.toolIds.mockResolvedValue({ data: ['web_fetch', 'filesystem', 'bash'] });
    });

    test('disabled path rejects on ids rejection with 503 and cleans session', async () => {
        sdkMocks.toolIds.mockRejectedValueOnce(new Error('backend down'));
        const app = createApp(baseConfig({})).app;
        const res = await request(app).post('/v1/chat/completions')
            .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'hi' }] });
        expect(res.statusCode).toBe(503);
        expect(JSON.stringify(res.body)).toContain('tool_discovery_unavailable');
        expect(sdkMocks.sessionDelete).toHaveBeenCalled();
        expect(sdkMocks.sessionPrompt).not.toHaveBeenCalled();
    });

    test('disabled path rejects on error tuple with 503', async () => {
        sdkMocks.toolIds.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
        const app = createApp(baseConfig({})).app;
        const res = await request(app).post('/v1/chat/completions')
            .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'hi' }] });
        expect(res.statusCode).toBe(503);
        expect(JSON.stringify(res.body)).toContain('tool_discovery_unavailable');
        expect(sdkMocks.sessionDelete).toHaveBeenCalled();
    });

    test('disabled path rejects on malformed payload with 503', async () => {
        sdkMocks.toolIds.mockResolvedValueOnce({ data: { unexpected: true } });
        const app = createApp(baseConfig({})).app;
        const res = await request(app).post('/v1/chat/completions')
            .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'hi' }] });
        expect(res.statusCode).toBe(503);
        expect(JSON.stringify(res.body)).toContain('tool_discovery_unavailable');
    });

    test('disabled path rejects on empty array with 503', async () => {
        sdkMocks.toolIds.mockResolvedValueOnce({ data: [] });
        const app = createApp(baseConfig({})).app;
        const res = await request(app).post('/v1/chat/completions')
            .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'hi' }] });
        expect(res.statusCode).toBe(503);
        expect(JSON.stringify(res.body)).toContain('tool_discovery_unavailable');
    });

    test('external bridge path rejects on empty ids with 503', async () => {
        sdkMocks.toolIds.mockResolvedValueOnce({ data: [] });
        const app = createApp(baseConfig({})).app;
        const res = await request(app).post('/v1/chat/completions')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'hi' }],
                tools: [{ type: 'function', function: { name: 'lookup' } }],
            });
        expect(res.statusCode).toBe(503);
        expect(JSON.stringify(res.body)).toContain('tool_discovery_unavailable');
        expect(sdkMocks.sessionDelete).toHaveBeenCalled();
    });

    test('internal allowlist path rejects on rejection with 503', async () => {
        sdkMocks.toolIds.mockRejectedValueOnce(new Error('down'));
        const app = createApp(baseConfig({ INTERNAL_ALLOWED_TOOLS: ['webfetch'] })).app;
        const res = await request(app).post('/v1/chat/completions')
            .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'hi' }] });
        expect(res.statusCode).toBe(503);
        expect(JSON.stringify(res.body)).toContain('tool_discovery_unavailable');
    });

    test('messages disabled path rejects with anthropic shape and cleans session', async () => {
        sdkMocks.toolIds.mockResolvedValueOnce({ data: [] });
        const app = createApp(baseConfig({})).app;
        const res = await request(app).post('/v1/messages')
            .send({ model: 'opencode/kimi-k2.5', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] });
        expect(res.statusCode).toBe(503);
        expect(res.body.type).toBe('error');
        expect(res.body.error.type).toBe('tool_discovery_unavailable');
        expect(sdkMocks.sessionDelete).toHaveBeenCalled();
    });

    test('responses disabled path rejects with 503', async () => {
        sdkMocks.toolIds.mockResolvedValueOnce({ data: [] });
        const app = createApp(baseConfig({})).app;
        const res = await request(app).post('/v1/responses')
            .send({ model: 'opencode/kimi-k2.5', input: 'hi' });
        expect(res.statusCode).toBe(503);
        expect(JSON.stringify(res.body)).toContain('tool_discovery_unavailable');
    });

    test('operator allow continues on discovery failure and omits observably', async () => {
        sdkMocks.toolIds.mockRejectedValueOnce(new Error('down'));
        const app = createApp(baseConfig({ DISABLE_TOOLS: false })).app;
        const res = await request(app).post('/v1/chat/completions')
            .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'hi' }] });
        expect(res.statusCode).toBe(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.tools).toBeUndefined();
        const details = await request(app).get('/health/details');
        expect(details.statusCode).toBe(200);
        expect(details.body.internal_tools.tool_discovery.override_omitted_total).toBeGreaterThanOrEqual(1);
    });

    test('empty ids never poison cache', async () => {
        sdkMocks.toolIds.mockResolvedValueOnce({ data: [] });
        const app = createApp(baseConfig({})).app;
        const first = await request(app).post('/v1/chat/completions')
            .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'hi' }] });
        expect(first.statusCode).toBe(503);
        const details = await request(app).get('/health/details');
        expect(details.body.internal_tools.cache.tool_ids_cached).toBe(false);
        expect(details.body.internal_tools.tool_discovery.ids_count).toBe(0);
        expect(details.body.internal_tools.tool_discovery.source).toBe('none');
        sdkMocks.toolIds.mockReset();
        sdkMocks.toolIds.mockResolvedValue({ data: ['web_fetch'] });
        const fresh = createApp(baseConfig({})).app;
        const second = await request(fresh).post('/v1/chat/completions')
            .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'hi' }] });
        expect(second.statusCode).toBe(200);
    });

    test('failure circuit avoids hammering backend', async () => {
        sdkMocks.toolIds.mockRejectedValue(new Error('down'));
        const app = createApp(baseConfig({})).app;
        const first = await request(app).post('/v1/chat/completions')
            .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'hi' }] });
        expect(first.statusCode).toBe(503);
        const callsAfterFirst = sdkMocks.toolIds.mock.calls.length;
        const second = await request(app).post('/v1/chat/completions')
            .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'hi' }] });
        expect(second.statusCode).toBe(503);
        expect(sdkMocks.toolIds.mock.calls.length).toBe(callsAfterFirst);
    });
});

describe('tool discovery readiness', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        sdkMocks.toolIds.mockReset();
        sdkMocks.toolIds.mockResolvedValue({ data: ['web_fetch', 'filesystem', 'bash'] });
    });

    test('health stays liveness while details expose live readiness', async () => {
        const app = createApp(baseConfig({})).app;
        const live = await request(app).get('/health');
        expect(live.statusCode).toBe(200);
        expect(live.body.status).toBe('ok');
        const chat = await request(app).post('/v1/chat/completions')
            .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'hi' }] });
        expect(chat.statusCode).toBe(200);
        const details = await request(app).get('/health/details');
        expect(details.statusCode).toBe(200);
        const discovery = details.body.internal_tools.tool_discovery;
        expect(discovery.source).toBe('live');
        expect(discovery.live_verified).toBe(true);
        expect(discovery.ready).toBe(true);
        expect(discovery.ids_count).toBe(3);
        expect(typeof discovery.cache_age_ms).toBe('number');
        expect(discovery.last_success_at).toBeTruthy();
        expect(discovery.override_omitted_total).toBeDefined();
        expect(details.body.internal_tools.readiness.tool_discovery_ready).toBe(true);
    });

    test('fixture never poses as live proof', async () => {
        const app = createApp(baseConfig({ INTERNAL_TOOL_DISCOVERY_FIXTURE: ['web_fetch'] })).app;
        const chat = await request(app).post('/v1/chat/completions')
            .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'hi' }] });
        expect(chat.statusCode).toBe(200);
        expect(sdkMocks.toolIds).not.toHaveBeenCalled();
        const details = await request(app).get('/health/details');
        expect(details.statusCode).toBe(200);
        const discovery = details.body.internal_tools.tool_discovery;
        expect(discovery.source).toBe('fixture');
        expect(discovery.live_verified).toBe(false);
        expect(discovery.ready).toBe(false);
        expect(discovery.fixture_configured).toBe(true);
        expect(details.body.internal_tools.readiness.live_backend_verified).toBe(false);
    });

    test('no live backend reports not ready without faking', async () => {
        sdkMocks.toolIds.mockRejectedValue(new Error('down'));
        const app = createApp(baseConfig({})).app;
        const details = await request(app).get('/health/details');
        expect(details.statusCode).toBe(200);
        const discovery = details.body.internal_tools.tool_discovery;
        expect(discovery.source).toBe('none');
        expect(discovery.live_verified).toBe(false);
        expect(discovery.ready).toBe(false);
        expect(discovery.ids_count).toBe(0);
    });

    test('failure records last error without tool payload', async () => {
        sdkMocks.toolIds.mockRejectedValueOnce(new Error('connect refused'));
        const app = createApp(baseConfig({})).app;
        const failed = await request(app).post('/v1/chat/completions')
            .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'topsecretinput' }] });
        expect(failed.statusCode).toBe(503);
        const details = await request(app).get('/health/details');
        const discovery = details.body.internal_tools.tool_discovery;
        expect(discovery.last_error_at).toBeTruthy();
        expect(typeof discovery.last_error).toBe('string');
        expect(JSON.stringify(details.body)).not.toContain('topsecretinput');
    });

    test('metrics expose discovery readiness without secrets', async () => {
        const app = createApp(baseConfig({ METRICS_ENABLED: true, METRICS_REQUIRE_AUTH: false })).app;
        const chat = await request(app).post('/v1/chat/completions')
            .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'secretpayload' }] });
        expect(chat.statusCode).toBe(200);
        const res = await request(app).get('/metrics');
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain('opencode_internal_tool_discovery_ids_count');
        expect(res.text).toContain('opencode_internal_tool_discovery_cache_age_ms');
        expect(res.text).toContain('opencode_internal_tool_discovery_live_verified');
        expect(res.text).toContain('opencode_internal_tool_discovery_ready');
        expect(res.text).toContain('opencode_internal_tool_discovery_source_info');
        expect(res.text).toContain('opencode_internal_tool_discovery_last_success_timestamp_seconds');
        expect(res.text).toContain('opencode_internal_tool_discovery_last_error_timestamp_seconds');
        expect(res.text).toContain('opencode_internal_tool_overrides_omitted_total');
        expect(res.text).not.toContain('secretpayload');
    });
});
