import request from 'supertest';
import { jest } from '@jest/globals';
import {
    buildCitationAnnotations,
    buildWebSearchCallItems,
    detectHostedSearchTools,
    extractSearchEvidence,
    extractUrls,
    stripHostedSearchTools,
} from '../src/search/grounding.js';

const SEARCH_OUTPUT = 'PostgreSQL 18.3 was released. Notes: https://www.postgresql.org/docs/release/18.3/ .';
const ANSWER_WITH_URL = 'Latest is PostgreSQL 18.3, see https://www.postgresql.org/docs/release/18.3/ for notes.';

const sdkMocks = {
    configProviders: jest.fn(async () => ({
        data: { providers: [{ id: 'opencode', models: { 'kimi-k2.5': { name: 'Kimi' } } }] },
    })),
    configUpdate: jest.fn(async () => ({})),
    toolIds: jest.fn(async () => ({ data: ['websearch', 'webfetch'] })),
    sessionCreate: jest.fn(async () => ({ data: { id: 'ws-session' } })),
    sessionPrompt: jest.fn(async () => ({ data: { parts: [{ type: 'text', text: 'ok' }] } })),
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
    eventSubscribe: jest.fn(async () => {
        const sessionId = 'ws-session';
        const mockEvents = [
            { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: sessionId }, delta: ANSWER_WITH_URL } },
            { type: 'message.updated', properties: { info: { sessionID: sessionId, finish: 'stop' } } },
        ];
        return {
            stream: (async function* () {
                for (const event of mockEvents) yield event;
            })(),
        };
    }),
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
            const res = { statusCode: 200, headers: { 'content-type': 'image/png' }, on: jest.fn((e, h) => { if (e === 'data') h(Buffer.from('x')); if (e === 'end') h(); }) };
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

describe('grounding pure helpers', () => {
    test('detect/strip hosted search tools', () => {
        expect(detectHostedSearchTools([{ type: 'web_search' }]).requested).toBe(true);
        expect(detectHostedSearchTools([{ type: 'Google_Search' }]).requested).toBe(true);
        expect(detectHostedSearchTools([{ type: 'function', function: { name: 'x' } }]).requested).toBe(false);
        expect(detectHostedSearchTools('nope').requested).toBe(false);
        const mixed = [{ type: 'web_search' }, { type: 'function', function: { name: 'f' } }];
        expect(stripHostedSearchTools(mixed)).toHaveLength(1);
    });

    test('extractSearchEvidence only trusts completed websearch parts', () => {
        const ev = extractSearchEvidence([
            { type: 'tool', tool: 'websearch', state: { status: 'completed', input: { query: 'q1' }, output: SEARCH_OUTPUT } },
            { type: 'tool', tool: 'websearch', state: { status: 'pending', input: { query: 'q2' }, output: '' } },
            { type: 'tool', tool: 'webfetch', state: { status: 'completed', input: {}, output: 'https://other.example/x' } },
            { type: 'text', text: 'hi' },
        ]);
        expect(ev.queries).toEqual(['q1']);
        expect(ev.sources.map((s) => s.url)).toEqual(['https://www.postgresql.org/docs/release/18.3/']);
    });

    test('buildWebSearchCallItems + citations (honest indices only)', () => {
        const ev = { queries: ['q1'], sources: [{ url: 'https://a.example/1', title: 'a.example' }] };
        expect(buildWebSearchCallItems(ev)).toEqual([
            { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'q1' } },
        ]);
        const text = 'see https://a.example/1 now, not https://missing.example/';
        const ann = buildCitationAnnotations(text, ev.sources);
        expect(ann).toHaveLength(1);
        expect(ann[0]).toMatchObject({ type: 'url_citation', url: 'https://a.example/1' });
        expect(text.slice(ann[0].start_index, ann[0].end_index)).toBe('https://a.example/1');
        expect(buildCitationAnnotations('no urls here', ev.sources)).toEqual([]);
        expect(extractUrls('a https://x.example/1, b https://x.example/1.')).toEqual(['https://x.example/1']);
    });
});

describe('POST /v1/responses web_search grounding', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        sdkMocks.toolIds.mockResolvedValue({ data: ['websearch', 'webfetch'] });
    });

    test('non-stream returns web_search_call + url_citation and enables websearch upstream', async () => {
        // Empty prompt parts: the answer (with tool evidence) arrives via poll,
        // mirroring a real tool-loop turn.
        sdkMocks.sessionPrompt.mockResolvedValueOnce({ data: { parts: [] } });
        const app = createApp(baseConfig({})).app;
        const res = await request(app).post('/v1/responses').send({
            model: 'opencode/kimi-k2.5',
            input: 'What is the latest PostgreSQL release?',
            tools: [{ type: 'web_search' }],
        });
        expect(res.statusCode).toBe(200);
        const searchCalls = res.body.output.filter((o) => o.type === 'web_search_call');
        expect(searchCalls).toHaveLength(1);
        expect(searchCalls[0].action).toEqual({ type: 'search', query: 'latest PostgreSQL release' });
        const message = res.body.output.find((o) => o.type === 'message');
        expect(message).toBeDefined();
        const annotations = message.content[0].annotations;
        expect(annotations.length).toBeGreaterThan(0);
        expect(annotations[0]).toMatchObject({ type: 'url_citation', url: 'https://www.postgresql.org/docs/release/18.3/' });
        // upstream prompt carried websearch:true
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.tools.websearch).toBe(true);
    });

    test('web_search unions onto an existing allowlist without extinguishing it', async () => {
        const app = createApp(baseConfig({ INTERNAL_ALLOWED_TOOLS: ['webfetch'] })).app;
        const res = await request(app).post('/v1/responses').send({
            model: 'opencode/kimi-k2.5',
            input: 'Search the docs.',
            tools: [{ type: 'web_search' }],
        });
        expect(res.statusCode).toBe(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.tools.websearch).toBe(true);
        expect(promptCall.body.tools.webfetch).toBe(true);
    });

    test('no web_search tools → no search items, annotations stay empty', async () => {
        const app = createApp(baseConfig({})).app;
        const res = await request(app).post('/v1/responses').send({
            model: 'opencode/kimi-k2.5',
            input: 'Hello',
        });
        expect(res.statusCode).toBe(200);
        expect(res.body.output.some((o) => o.type === 'web_search_call')).toBe(false);
        const message = res.body.output.find((o) => o.type === 'message');
        expect(message.content[0].annotations).toEqual([]);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.tools?.websearch).not.toBe(true);
    });

    test('stream emits web_search_call events and completed output carries them', async () => {
        const app = createApp(baseConfig({})).app;
        const res = await request(app).post('/v1/responses').send({
            model: 'opencode/kimi-k2.5',
            input: 'What is the latest PostgreSQL release?',
            tools: [{ type: 'web_search' }],
            stream: true,
        });
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain('response.web_search_call.completed');
        const completedLine = res.text.split('\n').find((l) => l.includes('response.completed'));
        expect(completedLine).toBeDefined();
        const completed = JSON.parse(completedLine.slice(5).trim());
        const searchCalls = completed.response.output.filter((o) => o.type === 'web_search_call');
        expect(searchCalls).toHaveLength(1);
        const message = completed.response.output.find((o) => o.type === 'message');
        expect(message.content[0].annotations.length).toBeGreaterThan(0);
    });
});
