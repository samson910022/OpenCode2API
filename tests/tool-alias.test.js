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
