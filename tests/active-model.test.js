import request from 'supertest';
import { jest } from '@jest/globals';
import { ensureActiveModel } from '../src/backend/active-model.js';
import { resetActiveModelCache } from '../src/backend/active-model.js';

// Contract: the backend disposes its whole project instance on EVERY
// PUT config (native ConfigHttpApi.update has no changed-check), aborting
// in-flight session work. The proxy must only PUT set-active-model when the
// model actually changed for that backend client.

function fakeClient(impl) {
    return { config: { update: impl } };
}

describe('ensureActiveModel unit', () => {
    test('PUTs once for repeated identical models on the same client', async () => {
        const update = jest.fn(async () => ({}));
        const client = fakeClient(update);
        await ensureActiveModel(client, 'opencode', 'm1');
        await ensureActiveModel(client, 'opencode', 'm1');
        expect(update).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledWith({
            body: { activeModel: { providerID: 'opencode', modelID: 'm1' } }
        });
    });

    test('PUTs again when the model changes', async () => {
        const update = jest.fn(async () => ({}));
        const client = fakeClient(update);
        await ensureActiveModel(client, 'opencode', 'm1');
        await ensureActiveModel(client, 'opencode', 'm2');
        expect(update).toHaveBeenCalledTimes(2);
        expect(update).toHaveBeenLastCalledWith({
            body: { activeModel: { providerID: 'opencode', modelID: 'm2' } }
        });
    });

    test('provider change counts as a change', async () => {
        const update = jest.fn(async () => ({}));
        const client = fakeClient(update);
        await ensureActiveModel(client, 'opencode', 'm1');
        await ensureActiveModel(client, 'other', 'm1');
        expect(update).toHaveBeenCalledTimes(2);
    });

    test('failed PUTs are not cached (next call retries)', async () => {
        const update = jest.fn(async () => ({}));
        update.mockRejectedValueOnce(new Error('backend exploded'));
        const client = fakeClient(update);
        await expect(ensureActiveModel(client, 'opencode', 'm1')).rejects.toThrow('backend exploded');
        await ensureActiveModel(client, 'opencode', 'm1');
        expect(update).toHaveBeenCalledTimes(2);
    });

    test('distinct clients track independently', async () => {
        const updateA = jest.fn(async () => ({}));
        const updateB = jest.fn(async () => ({}));
        await ensureActiveModel(fakeClient(updateA), 'opencode', 'm1');
        await ensureActiveModel(fakeClient(updateB), 'opencode', 'm1');
        expect(updateA).toHaveBeenCalledTimes(1);
        expect(updateB).toHaveBeenCalledTimes(1);
    });

    test('resetActiveModelCache forces the next PUT (backend respawn)', async () => {
        const update = jest.fn(async () => ({}));
        const client = fakeClient(update);
        await ensureActiveModel(client, 'opencode', 'm1');
        await ensureActiveModel(client, 'opencode', 'm1');
        expect(update).toHaveBeenCalledTimes(1);
        resetActiveModelCache();
        await ensureActiveModel(client, 'opencode', 'm1');
        expect(update).toHaveBeenCalledTimes(2);
    });

    test('concurrent same-model callers share one PUT (no TOCTOU storm)', async () => {
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const update = jest.fn(() => gate.then(() => ({})));
        const client = fakeClient(update);
        const both = Promise.all([
            ensureActiveModel(client, 'opencode', 'm1'),
            ensureActiveModel(client, 'opencode', 'm1'),
        ]);
        await Promise.resolve();
        await Promise.resolve();
        release();
        await both;
        expect(update).toHaveBeenCalledTimes(1);
    });

    test('failure rolls back only its own intent, preserving a newer one', async () => {
        let releaseA;
        const gateA = new Promise((resolve) => { releaseA = resolve; });
        const update = jest.fn((args) => {
            const m = args && args.body && args.body.activeModel && args.body.activeModel.modelID;
            return m === 'm1' ? gateA.then(() => { throw new Error('m1 failed'); }) : Promise.resolve({});
        });
        const client = fakeClient(update);
        const p1 = ensureActiveModel(client, 'opencode', 'm1');
        await Promise.resolve();
        await Promise.resolve();
        await ensureActiveModel(client, 'opencode', 'm2');
        releaseA();
        await expect(p1).rejects.toThrow('m1 failed');
        // m2 intent survived m1's rollback: no extra PUT.
        await ensureActiveModel(client, 'opencode', 'm2');
        expect(update).toHaveBeenCalledTimes(2);
    });
});

const sdkMocks = {
    configProviders: jest.fn(async () => ({
        data: {
            providers: [{ id: 'opencode', models: { 'muse-spark-1.3-contributor-free': { name: 'Muse Spark' } } }]
        }
    })),
    configUpdate: jest.fn(async () => ({})),
    toolIds: jest.fn(async () => ({ data: [] })),
    sessionCreate: jest.fn(async () => ({ data: { id: 'active-model-session' } })),
    sessionPrompt: jest.fn(async () => ({ data: { parts: [{ type: 'text', text: 'hi' }] } })),
    sessionMessages: jest.fn(async () => ([
        { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'hi' }] }
    ])),
    sessionDelete: jest.fn(async () => ({})),
    eventSubscribe: jest.fn(async () => ({
        stream: (async function* () {
            yield { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'active-model-session' }, delta: 'hi' } };
            yield { type: 'message.updated', properties: { info: { sessionID: 'active-model-session', finish: 'stop' } } };
        })()
    }))
};

jest.unstable_mockModule('http', () => ({
    default: {
        get: jest.fn((url, options, callback) => {
            const response = { statusCode: 200, headers: {}, on: jest.fn() };
            callback(response);
            return { on: jest.fn(), destroy: jest.fn(), setTimeout: jest.fn() };
        })
    }
}));

jest.unstable_mockModule('@opencode-ai/sdk', () => ({
    createOpencodeClient: jest.fn(() => ({
        config: { providers: sdkMocks.configProviders, update: sdkMocks.configUpdate },
        tool: { ids: sdkMocks.toolIds },
        session: {
            create: sdkMocks.sessionCreate,
            prompt: sdkMocks.sessionPrompt,
            messages: sdkMocks.sessionMessages,
            delete: sdkMocks.sessionDelete
        },
        event: { subscribe: sdkMocks.eventSubscribe }
    }))
}));

const { createApp } = await import('../src/proxy.js');

describe('ensureActiveModel route wiring', () => {
    test('two identical chat requests PUT set-active-model only once', async () => {
        const app = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: false,
            DEBUG: false
        }).app;
        const body = {
            model: 'opencode/muse-spark-1.3-contributor-free',
            messages: [{ role: 'user', content: 'hi' }]
        };
        const first = await request(app).post('/v1/chat/completions').set('Authorization', 'Bearer test-key').send(body);
        expect(first.statusCode).toEqual(200);
        const second = await request(app).post('/v1/chat/completions').set('Authorization', 'Bearer test-key').send(body);
        expect(second.statusCode).toEqual(200);
        expect(sdkMocks.configUpdate).toHaveBeenCalledTimes(1);
    });

    test.each([
        ['responses', '/v1/responses', { model: 'opencode/muse-spark-1.3-contributor-free', input: 'hi' }],
        ['messages', '/v1/messages', { model: 'opencode/muse-spark-1.3-contributor-free', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }],
        ['interactions', '/v1beta/interactions', { model: 'opencode/muse-spark-1.3-contributor-free', input: 'hi' }],
    ])('%s skips the second PUT for an unchanged model', async (_name, path, body) => {
        const app = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: false,
            DEBUG: false
        }).app;
        sdkMocks.configUpdate.mockClear();
        const first = await request(app).post(path).set('Authorization', 'Bearer test-key').send(body);
        expect(first.statusCode).toEqual(200);
        const second = await request(app).post(path).set('Authorization', 'Bearer test-key').send(body);
        expect(second.statusCode).toEqual(200);
        expect(sdkMocks.configUpdate).toHaveBeenCalledTimes(1);
    });
});
