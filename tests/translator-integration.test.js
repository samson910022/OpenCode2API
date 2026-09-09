import request from 'supertest';
import { jest } from '@jest/globals';

const sdkMocks = {
    configProviders: jest.fn(async () => ({
        data: { providers: [{ id: 'opencode', models: { 'kimi-k2.5': { name: 'Kimi' } } }] },
    })),
    configUpdate: jest.fn(async () => ({})),
    toolIds: jest.fn(async () => ({ data: [] })),
    sessionCreate: jest.fn(async () => ({ data: { id: 'xlat-session' } })),
    sessionPrompt: jest.fn(async () => ({ data: { parts: [] } })),
    sessionMessages: jest.fn(async () => ([
        { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Hello from wired translators!' }] },
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
const { TranslatorRegistry } = await import('../src/converters/registry.js');
const { registerAllTranslatorPairs } = await import('../src/converters/init.js');
const wire = await import('../src/converters/wire.js');

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

function wiredRegistry() {
    const r = new TranslatorRegistry();
    registerAllTranslatorPairs(r);
    return r;
}

describe('Phase 3 integration: live chat route output translates cross-protocol', () => {
    test('chat non-stream -> responses/messages preserve text + usage keys', async () => {
        const app = createApp(baseConfig({})).app;
        const res = await request(app).post('/v1/chat/completions').send({
            model: 'opencode/kimi-k2.5',
            messages: [{ role: 'user', content: 'hi' }],
        });
        expect(res.statusCode).toBe(200);
        const text = res.body.choices[0].message.content;
        expect(text).toContain('Hello from wired translators!');
        const r = wiredRegistry();
        const asResponses = wire.translateNonStreamSafe(r, 'openai', 'openai-response', 'm', {}, {}, res.body);
        expect(JSON.stringify(asResponses)).toContain('Hello from wired translators!');
        // Converted responses shape (not passthrough): output message + token keys.
        expect(asResponses).toHaveProperty('object', 'response');
        expect(asResponses).toHaveProperty('status', 'completed');
        expect(Array.isArray(asResponses.output)).toBe(true);
        expect(asResponses.output[0]).toMatchObject({ type: 'message', role: 'assistant' });
        expect(asResponses.usage).toHaveProperty('input_tokens');
        expect(asResponses.usage).toHaveProperty('output_tokens');
        const asMessages = wire.translateNonStreamSafe(r, 'openai', 'claude', 'm', {}, {}, res.body);
        expect(JSON.stringify(asMessages)).toContain('Hello from wired translators!');
        // Converted claude shape (not passthrough): content blocks + stop_reason.
        expect(asMessages).toHaveProperty('type', 'message');
        expect(asMessages.content[0]).toMatchObject({ type: 'text' });
        expect(asMessages).toHaveProperty('stop_reason');
        expect(asMessages.usage).toHaveProperty('input_tokens');
    });

    test('chat request translates to responses/claude request shape (wire parity)', () => {
        const r = wiredRegistry();
        const chatBody = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
        const asResponsesReq = wire.translateRequestSafe(r, 'openai', 'openai-response', 'm', chatBody, false);
        expect(asResponsesReq).toHaveProperty('input');
        const asClaudeReq = wire.translateRequestSafe(r, 'openai', 'claude', 'm', chatBody, false);
        expect(asClaudeReq).toHaveProperty('messages');
    });
});

describe('Phase 3 integration: live responses route output translates back', () => {
    test('responses non-stream -> chat preserves text', async () => {
        const app = createApp(baseConfig({})).app;
        const res = await request(app).post('/v1/responses').send({ model: 'opencode/kimi-k2.5', input: 'hi' });
        expect(res.statusCode).toBe(200);
        const r = wiredRegistry();
        const asChat = wire.translateNonStreamSafe(r, 'openai-response', 'openai', 'm', {}, {}, res.body);
        expect(JSON.stringify(asChat)).toContain('Hello from wired translators!');
        expect(asChat).toHaveProperty('choices');
    });

    test('error envelopes bypass (route-owned wire)', async () => {
        const app = createApp(baseConfig({})).app;
        const res = await request(app).post('/v1/chat/completions').send({ model: 'opencode/kimi-k2.5' });
        expect(res.statusCode).toBe(400);
        const r = wiredRegistry();
        expect(wire.isErrorEnvelope(res.body)).toBe(true);
        expect(wire.translateNonStreamSafe(r, 'openai', 'openai-response', 'm', {}, {}, res.body)).toBe(res.body);
    });
});

describe('Phase 3 integration: stream holder carries real chat chunks', () => {
    test('openai stream chunks -> responses deltas preserve text via one holder', () => {
        const r = wiredRegistry();
        const holder = wire.newStreamHolder();
        const c1 = wire.translateStreamSafe(r, 'openai', 'openai-response', 'm', {}, {}, { choices: [{ delta: { content: 'Hello ' } }] }, holder);
        expect(holder.translator).toBeDefined();
        const cached = holder.translator;
        const c2 = wire.translateStreamSafe(r, 'openai', 'openai-response', 'm', {}, {}, { choices: [{ delta: { content: 'world' }, finish_reason: 'stop' }] }, holder);
        // Same holder reused (no per-chunk state reset).
        expect(holder.translator).toBe(cached);
        expect(JSON.stringify([...c1, ...c2])).toContain('Hello');
        expect(JSON.stringify(c2)).toContain('world');
        // Responses stream event types (not chat passthrough).
        const types = [...c1, ...c2].map((e) => e && e.type);
        expect(types).toContain('response.output_text.delta');
        expect(types).toContain('response.completed');
    });
});

describe('Phase 4 integration: live messages route (wired path) translates out', () => {
    test('messages non-stream (via N×N inbound) -> chat preserves text', async () => {
        const app = createApp(baseConfig({})).app;
        const res = await request(app).post('/v1/messages').send({
            model: 'opencode/kimi-k2.5',
            max_tokens: 100,
            messages: [{ role: 'user', content: 'hi' }],
        });
        expect(res.statusCode).toBe(200);
        expect(res.body.type).toBe('message');
        const r = wiredRegistry();
        const asChat = wire.translateNonStreamSafe(r, 'claude', 'openai', 'm', {}, {}, res.body);
        expect(JSON.stringify(asChat)).toContain('Hello from wired translators!');
        expect(asChat).toHaveProperty('choices');
        const asResponses = wire.translateNonStreamSafe(r, 'claude', 'openai-response', 'm', {}, {}, res.body);
        expect(JSON.stringify(asResponses)).toContain('Hello from wired translators!');
        expect(asResponses).toHaveProperty('object', 'response');
        expect(asResponses).toHaveProperty('status', 'completed');
    });
});

describe('Phase 4 integration: live interactions route translates out', () => {
    test('interactions non-stream -> chat/responses/messages preserve text', async () => {
        const app = createApp(baseConfig({})).app;
        const res = await request(app).post('/v1beta/interactions').send({
            model: 'opencode/kimi-k2.5',
            input: 'Hello',
        });
        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('completed');
        const r = wiredRegistry();
        const asChat = wire.translateNonStreamSafe(r, 'interactions', 'openai', 'm', {}, {}, res.body);
        expect(JSON.stringify(asChat)).toContain('Hello from wired translators!');
        expect(asChat).toHaveProperty('choices');
        const asResponses = wire.translateNonStreamSafe(r, 'interactions', 'openai-response', 'm', {}, {}, res.body);
        expect(JSON.stringify(asResponses)).toContain('Hello from wired translators!');
        expect(asResponses).toHaveProperty('object', 'response');
        expect(asResponses).toHaveProperty('status', 'completed');
        const asMessages = wire.translateNonStreamSafe(r, 'interactions', 'claude', 'm', {}, {}, res.body);
        expect(JSON.stringify(asMessages)).toContain('Hello from wired translators!');
        expect(asMessages).toHaveProperty('type', 'message');
        expect(asMessages.content[0]).toMatchObject({ type: 'text' });
        expect(asMessages).toHaveProperty('stop_reason');
    });

    test('interactions error envelope bypasses (route-owned wire)', async () => {
        const app = createApp(baseConfig({})).app;
        const res = await request(app).post('/v1beta/interactions').send({ model: 'opencode/kimi-k2.5' });
        expect(res.statusCode).toBe(400);
        const r = wiredRegistry();
        expect(wire.isErrorEnvelope(res.body)).toBe(true);
        expect(wire.translateNonStreamSafe(r, 'interactions', 'openai', 'm', {}, {}, res.body)).toBe(res.body);
    });
});
