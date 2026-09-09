import request from 'supertest';
import { jest } from '@jest/globals';

const SEARCH_OUTPUT = 'PostgreSQL 18.3 was released. Notes: https://www.postgresql.org/docs/release/18.3/ .';
const ANSWER_WITH_URL = 'Latest is PostgreSQL 18.3, see https://www.postgresql.org/docs/release/18.3/ for notes.';

const sdkMocks = {
    configProviders: jest.fn(async () => ({
        data: { providers: [{ id: 'opencode', models: { 'kimi-k2.5': { name: 'Kimi' } } }] },
    })),
    configUpdate: jest.fn(async () => ({})),
    toolIds: jest.fn(async () => ({ data: ['websearch', 'webfetch'] })),
    sessionCreate: jest.fn(async () => ({ data: { id: 'intr-session' } })),
    sessionPrompt: jest.fn(async () => ({ data: { parts: [] } })),
    sessionMessages: jest.fn(async () => ([
        {
            info: { role: 'assistant', finish: 'stop' },
            parts: [
                { type: 'text', text: ANSWER_WITH_URL },
                {
                    type: 'tool',
                    id: 'call_search_1',
                    tool: 'websearch',
                    state: { status: 'completed', input: { query: 'latest PostgreSQL release' }, output: SEARCH_OUTPUT },
                },
            ],
        },
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
        API_KEY: '',
        OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
        REQUEST_TIMEOUT_MS: 5000,
        DISABLE_TOOLS: true,
        DEBUG: false,
        ...overrides,
    };
}

describe('POST /v1beta/interactions', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        sdkMocks.toolIds.mockResolvedValue({ data: ['websearch', 'webfetch'] });
    });

    test('plain text input returns interaction with model_output step', async () => {
        const app = createApp(baseConfig({})).app;
        const res = await request(app).post('/v1beta/interactions').send({
            model: 'opencode/kimi-k2.5',
            input: 'Hello',
        });
        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('completed');
        expect(res.body.id).toMatch(/^intr_/);
        expect(res.body.output_text).toContain('PostgreSQL');
        const out = res.body.steps.find((s) => s.type === 'model_output');
        expect(out).toBeDefined();
        expect(out.annotations).toEqual([]);
    });

    test('google_search tools drive websearch and surface steps', async () => {
        const app = createApp(baseConfig({})).app;
        const res = await request(app).post('/v1beta/interactions').send({
            model: 'opencode/kimi-k2.5',
            input: 'Latest PostgreSQL release?',
            tools: [{ type: 'google_search' }],
        });
        expect(res.statusCode).toBe(200);
        const call = res.body.steps.find((s) => s.type === 'google_search_call');
        expect(call).toEqual({ type: 'google_search_call', queries: ['latest PostgreSQL release'] });
        const result = res.body.steps.find((s) => s.type === 'google_search_result');
        expect(result.sources[0].url).toBe('https://www.postgresql.org/docs/release/18.3/');
        const out = res.body.steps.find((s) => s.type === 'model_output');
        expect(out.annotations.length).toBeGreaterThan(0);
        expect(res.body.usage.grounding_tool_count).toEqual([{ type: 'google_search', count: 1 }]);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.tools.websearch).toBe(true);
    });

    test('/v1 alias behaves identically', async () => {
        const app = createApp(baseConfig({})).app;
        const res = await request(app).post('/v1/interactions').send({ model: 'opencode/kimi-k2.5', input: 'hi' });
        expect(res.statusCode).toBe(200);
        expect(res.body.id).toMatch(/^intr_/);
    });

    test('previous_interaction_id continues the session; store:false skips persistence', async () => {
        const app = createApp(baseConfig({})).app;
        const first = await request(app).post('/v1beta/interactions').send({ model: 'opencode/kimi-k2.5', input: 'hi' });
        const second = await request(app).post('/v1beta/interactions').send({
            model: 'opencode/kimi-k2.5',
            input: 'follow-up',
            previous_interaction_id: first.body.id,
        });
        expect(second.statusCode).toBe(200);
        // stored session reused: only one session.create across both calls
        expect(sdkMocks.sessionCreate.mock.calls.length).toBe(1);
        const bad = await request(app).post('/v1beta/interactions').send({
            model: 'opencode/kimi-k2.5',
            input: 'hi',
            previous_interaction_id: 'intr_missing',
        });
        expect(bad.statusCode).toBe(400);
        const ephemeral = await request(app).post('/v1beta/interactions').send({
            model: 'opencode/kimi-k2.5',
            input: 'hi',
            store: false,
        });
        expect(ephemeral.statusCode).toBe(200);
        expect(sdkMocks.sessionDelete).toHaveBeenCalled();
    });

    test('store:false with previous_interaction_id keeps the shared parent session', async () => {
        const app = createApp(baseConfig({})).app;
        const first = await request(app).post('/v1beta/interactions').send({ model: 'opencode/kimi-k2.5', input: 'hi' });
        expect(first.statusCode).toBe(200);
        jest.clearAllMocks();
        const second = await request(app).post('/v1beta/interactions').send({
            model: 'opencode/kimi-k2.5',
            input: 'follow-up',
            previous_interaction_id: first.body.id,
            store: false,
        });
        expect(second.statusCode).toBe(200);
        // Reused parent session must survive an ephemeral continuation.
        expect(sdkMocks.sessionDelete).not.toHaveBeenCalled();
        expect(sdkMocks.sessionCreate).not.toHaveBeenCalled();
    });

    test('validation: model/agent required, input required, function tools rejected', async () => {
        const app = createApp(baseConfig({})).app;
        expect((await request(app).post('/v1beta/interactions').send({ input: 'hi' })).statusCode).toBe(400);
        expect((await request(app).post('/v1beta/interactions').send({ model: 'm' })).statusCode).toBe(400);
        const fn = await request(app).post('/v1beta/interactions').send({
            model: 'opencode/kimi-k2.5',
            input: 'hi',
            tools: [{ type: 'function', function: { name: 'x' } }],
        });
        expect(fn.statusCode).toBe(400);
    });

    test('stream emits created/delta/completed without SSE subscription', async () => {
        const app = createApp(baseConfig({})).app;
        const res = await request(app).post('/v1beta/interactions').send({
            model: 'opencode/kimi-k2.5',
            input: 'hi',
            stream: true,
        });
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain('interaction.created');
        expect(res.text).toContain('step.delta');
        expect(res.text).toContain('interaction.completed');
        expect(sdkMocks.eventSubscribe).not.toHaveBeenCalled();
    });

    test('free-limit engages fallback and retries via proxy within the same request', async () => {
        sdkMocks.sessionPrompt.mockRejectedValueOnce({
            name: 'APIError',
            data: {
                message: 'Rate limit exceeded. Please try again later.',
                statusCode: 429,
                isRetryable: true,
                responseBody: '{"error":{"type":"FreeUsageLimitError"}}',
            },
        });
        const app = createApp(baseConfig({ RETRY_MAX_RETRIES: 1, UPSTREAM_PROXIES: ['http://10.0.0.1:8080'] })).app;
        const res = await request(app).post('/v1beta/interactions').send({ model: 'opencode/kimi-k2.5', input: 'hi' });
        expect(res.statusCode).toBe(200);
        expect(sdkMocks.sessionPrompt.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    test('agent-only falls back to default model resolution', async () => {
        const app = createApp(baseConfig({})).app;
        const res = await request(app).post('/v1beta/interactions').send({ agent: 'deep-research-preview', input: 'hi' });
        expect(res.statusCode).toBe(200);
        expect(res.body.model).toBe('opencode/kimi-k2.5');
    });

    test('auth applies like other routes', async () => {
        const app = createApp(baseConfig({ API_KEY: 's3cret' })).app;
        expect((await request(app).post('/v1beta/interactions').send({ model: 'm', input: 'hi' })).statusCode).toBe(401);
        const ok = await request(app).post('/v1beta/interactions').set('Authorization', 'Bearer s3cret').send({ model: 'opencode/kimi-k2.5', input: 'hi' });
        expect(ok.statusCode).toBe(200);
    });
});
