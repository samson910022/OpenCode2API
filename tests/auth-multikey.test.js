import request from 'supertest';
import { jest } from '@jest/globals';

const sdkMocks = {
    configProviders: jest.fn(async () => ({
        data: {
            providers: [{ id: 'opencode', models: { 'kimi-k2.5': { name: 'Kimi' } } }]
        }
    })),
    configUpdate: jest.fn(async () => ({})),
    toolIds: jest.fn(async () => ({ data: [] })),
    sessionCreate: jest.fn(async () => ({ data: { id: 'mk-session' } })),
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

const { createApp } = await import('../src/proxy.js');
const { buildProxyConfig } = await import('../src/config/proxy-config.js');

function baseConfig(overrides = {}) {
    return {
        PORT: 10000,
        OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
        REQUEST_TIMEOUT_MS: 5000,
        DISABLE_TOOLS: true,
        DEBUG: false,
        ...overrides,
    };
}

describe('multi-key auth (A)', () => {
    beforeEach(() => { jest.clearAllMocks(); });

    test('any key in API_KEYS passes on /v1/models', async () => {
        const app = createApp(baseConfig({ API_KEYS: ['k1', 'k2'] })).app;
        for (const k of ['k1', 'k2']) {
            const res = await request(app).get('/v1/models').set('Authorization', `Bearer ${k}`);
            expect(res.statusCode).toBe(200);
        }
        const bad = await request(app).get('/v1/models').set('Authorization', 'Bearer nope');
        expect(bad.statusCode).toBe(401);
        expect(bad.body).toEqual({ error: { message: 'Unauthorized' } });
    });

    test('x-api-key header works and legacy API_KEY merges', async () => {
        const app = createApp(baseConfig({ API_KEY: 'legacy', API_KEYS: ['k1'] })).app;
        const r1 = await request(app).get('/v1/models').set('x-api-key', 'legacy');
        expect(r1.statusCode).toBe(200);
        const r2 = await request(app).get('/v1/models').set('x-api-key', 'k1');
        expect(r2.statusCode).toBe(200);
    });

    test('Bearer scheme is case-insensitive and trims whitespace', async () => {
        const app = createApp(baseConfig({ API_KEYS: ['k1'] })).app;
        const res = await request(app).get('/v1/models').set('Authorization', 'bearer   k1  ');
        expect(res.statusCode).toBe(200);
    });

    test('empty config falls back to no-auth (unchanged)', async () => {
        const app = createApp(baseConfig({ API_KEY: '', API_KEYS: [] })).app;
        const res = await request(app).get('/v1/models');
        expect(res.statusCode).toBe(200);
    });

    test('/v1/messages keeps Anthropic 401 shape', async () => {
        const app = createApp(baseConfig({ API_KEYS: ['k1'] })).app;
        const res = await request(app).post('/v1/messages')
            .send({ model: 'opencode/kimi-k2.5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
        expect(res.statusCode).toBe(401);
        expect(res.body.type).toBe('error');
        expect(res.body.error.type).toBe('authentication_error');
    });

    test('/health/details honors multi-key via shared verifier', async () => {
        const app = createApp(baseConfig({
            API_KEYS: ['k1', 'k2'],
            HEALTH_DETAILS_ENABLED: true,
            HEALTH_DETAILS_REQUIRE_AUTH: true,
        })).app;
        const ok = await request(app).get('/health/details').set('Authorization', 'Bearer k2');
        expect(ok.statusCode).toBe(200);
        const bad = await request(app).get('/health/details');
        expect(bad.statusCode).toBe(401);
    });

    test('buildProxyConfig resolves API_KEYS from opts and env', async () => {
        const c1 = buildProxyConfig({ API_KEYS: 'a, b, a, ' });
        expect(c1.API_KEYS).toEqual(['a', 'b']);
        expect(c1.API_KEY).toBe('a');
        // List-first merge order: explicit list wins positionally over legacy single.
        const c1b = buildProxyConfig({ API_KEYS: 'b', API_KEY: 'a' });
        expect(c1b.API_KEYS).toEqual(['b', 'a']);
        expect(c1b.API_KEY).toBe('b');
        const saved = {
            canonical: process.env.OPENCODE_API_KEYS,
            alias: process.env.API_KEYS,
            single: process.env.API_KEY,
        };
        delete process.env.OPENCODE_API_KEYS;
        delete process.env.API_KEY;
        process.env.API_KEYS = 'e1,e2';
        try {
            const c2 = buildProxyConfig({});
            expect(c2.API_KEYS).toEqual(['e1', 'e2']);
            // Canonical and alias merge; empty never blocks.
            process.env.OPENCODE_API_KEYS = 'c0';
            const c3 = buildProxyConfig({});
            expect(c3.API_KEYS).toEqual(['c0', 'e1', 'e2']);
            process.env.OPENCODE_API_KEYS = '';
            const c4 = buildProxyConfig({});
            expect(c4.API_KEYS).toEqual(['e1', 'e2']);
            // Explicit empty opts isolate from ambient env.
            const c5 = buildProxyConfig({ API_KEYS: '' });
            expect(c5.API_KEYS).toEqual([]);
        } finally {
            if (saved.canonical === undefined) delete process.env.OPENCODE_API_KEYS;
            else process.env.OPENCODE_API_KEYS = saved.canonical;
            if (saved.alias === undefined) delete process.env.API_KEYS;
            else process.env.API_KEYS = saved.alias;
            if (saved.single === undefined) delete process.env.API_KEY;
            else process.env.API_KEY = saved.single;
        }
    });

    test('Bearer with empty token is 401 when keys configured', async () => {
        const app = createApp(baseConfig({ API_KEYS: ['k1'] })).app;
        for (const h of ['Bearer', 'Bearer   ']) {
            const res = await request(app).get('/v1/models').set('Authorization', h);
            expect(res.statusCode).toBe(401);
        }
    });

    test('either header may match (legacy OR semantics)', async () => {
        const app = createApp(baseConfig({ API_KEYS: ['k1'] })).app;
        const res = await request(app).get('/v1/models')
            .set('Authorization', 'Bearer wrong')
            .set('x-api-key', 'k1');
        expect(res.statusCode).toBe(200);
    });

    test('legacy APIKEY_1 indexed env is never read', async () => {
        const saved = process.env.APIKEY_1;
        process.env.APIKEY_1 = 'evil-indexed';
        try {
            const app = createApp(baseConfig({ API_KEY: '', API_KEYS: [] })).app;
            const open = await request(app).get('/v1/models');
            expect(open.statusCode).toBe(200);
            const evil = await request(app).get('/v1/models').set('Authorization', 'Bearer evil-indexed');
            expect(evil.statusCode).toBe(200); // no-auth mode: everything passes, indexed key grants nothing special
            const locked = createApp(baseConfig({ API_KEYS: ['real'] })).app;
            const rejected = await request(locked).get('/v1/models').set('Authorization', 'Bearer evil-indexed');
            expect(rejected.statusCode).toBe(401);
        } finally {
            if (saved === undefined) delete process.env.APIKEY_1;
            else process.env.APIKEY_1 = saved;
        }
    });

    test('pure key helpers: objects, non-strings, arrays', async () => {
        const { parseApiKeyList, mergeApiKeySources, buildEffectiveApiKeys } = await import('../src/auth/keys.js');
        expect(parseApiKeyList([{ key: ' a ' }, { key: '' }, { nokey: 'x' }, 1, true, null])).toEqual(['a']);
        expect(parseApiKeyList(42)).toEqual([]);
        expect(mergeApiKeySources('b,a', 'a,c')).toEqual(['b', 'a', 'c']);
        expect(buildEffectiveApiKeys('single', 'm1,m2')).toEqual(['m1', 'm2', 'single']);
    });
});
