import request from 'supertest';
import { jest } from '@jest/globals';

const simulatedTranscripts = new Map();
const simulatedForkContexts = new Map();
const sdkMocks = {
    configProviders: jest.fn(async () => ({
        data: { providers: [{ id: 'opencode', models: { 'kimi-k2.5': { name: 'Kimi' } } }] },
    })),
    configUpdate: jest.fn(async () => ({})),
    toolIds: jest.fn(async () => ({ data: ['websearch', 'webfetch'] })),
    sessionCreate: jest.fn(async () => ({ data: { id: 'parent-session' } })),
    sessionFork: jest.fn(async ({ path }) => {
        const childId = `child-${sdkMocks.sessionFork.mock.calls.length}`;
        const copiedContext = [...(simulatedTranscripts.get(path.id) ?? [])];
        simulatedTranscripts.set(childId, copiedContext);
        simulatedForkContexts.set(childId, structuredClone(copiedContext));
        return { data: { id: childId } };
    }),
    sessionPrompt: jest.fn(async ({ path, body }) => {
        const transcript = simulatedTranscripts.get(path.id) ?? [];
        for (const part of body.parts ?? []) {
            if (typeof part.text === 'string') transcript.push({ role: 'user', text: part.text });
        }
        transcript.push({ role: 'assistant', text: 'answer' });
        simulatedTranscripts.set(path.id, transcript);
        return {
            data: {
                info: {
                    id: `assistant-${path.id === 'parent-session' ? 'parent' : path.id}-checkpoint`,
                    role: 'assistant',
                    parentID: body.messageID,
                    finish: 'stop',
                },
                parts: [{ type: 'text', text: 'answer' }],
            },
        };
    }),
    sessionMessages: jest.fn(async ({ path }) => {
        const prompt = sdkMocks.sessionPrompt.mock.calls
            .map(([args]) => args)
            .findLast((args) => args?.path?.id === path.id);
        return [{
            info: {
                id: path.id === 'parent-session' ? 'assistant-parent-checkpoint' : `assistant-${path.id}-checkpoint`,
                role: 'assistant',
                parentID: prompt?.body?.messageID,
                finish: 'stop',
            },
            parts: [{ type: 'text', text: 'answer' }],
        }];
    }),
    sessionDelete: jest.fn(async () => ({})),
    eventSubscribe: jest.fn(async () => ({ stream: (async function* () {})() })),
};

jest.unstable_mockModule('@opencode-ai/sdk', () => ({
    createOpencodeClient: jest.fn(() => ({
        config: { providers: sdkMocks.configProviders, update: sdkMocks.configUpdate },
        tool: { ids: sdkMocks.toolIds },
        session: {
            create: sdkMocks.sessionCreate,
            fork: sdkMocks.sessionFork,
            prompt: sdkMocks.sessionPrompt,
            messages: sdkMocks.sessionMessages,
            delete: sdkMocks.sessionDelete,
        },
        event: { subscribe: sdkMocks.eventSubscribe },
    })),
}));

jest.unstable_mockModule('http', () => ({
    default: {
        get: jest.fn((_url, options, callback) => {
            const cb = typeof options === 'function' ? options : callback;
            cb({ statusCode: 200, headers: {}, on: jest.fn() });
            return { on: jest.fn(), destroy: jest.fn(), setTimeout: jest.fn() };
        }),
    },
}));

jest.unstable_mockModule('https', () => ({
    default: {
        get: jest.fn((_url, options, callback) => {
            const cb = typeof options === 'function' ? options : callback;
            cb({ statusCode: 200, headers: {}, on: jest.fn() });
            return { on: jest.fn(), destroy: jest.fn() };
        }),
    },
}));

const { createApp } = await import('../src/proxy.js');

function createTestApp() {
    return createApp({
        PORT: 10000,
        API_KEY: '',
        OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
        REQUEST_TIMEOUT_MS: 1000,
        DISABLE_TOOLS: true,
        DEBUG: false,
    });
}

describe('checkpoint-based continuation forks', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        simulatedTranscripts.clear();
        simulatedForkContexts.clear();
    });

    test('Responses forks every continuation from the same checkpoint and stores each child checkpoint', async () => {
        const { app, ctx } = createTestApp();
        const seed = await request(app).post('/v1/responses').send({ model: 'opencode/kimi-k2.5', input: 'seed' });
        expect(seed.statusCode).toBe(200);

        const first = await request(app).post('/v1/responses').send({
            input: 'follow-up one',
            previous_response_id: seed.body.id,
        });
        const second = await request(app).post('/v1/responses').send({
            input: 'follow-up two',
            previous_response_id: seed.body.id,
        });

        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(200);
        expect(sdkMocks.sessionFork.mock.calls).toEqual([
            [{ path: { id: 'parent-session' } }],
            [{ path: { id: 'parent-session' } }],
        ]);
        expect(sdkMocks.sessionPrompt.mock.calls.slice(1).map(([args]) => args.path.id)).toEqual(['child-1', 'child-2']);
        expect(sdkMocks.sessionPrompt.mock.calls.slice(1).map(([args]) => args.body.parts.map((part) => part.text))).toEqual([
            ['follow-up one'],
            ['follow-up two'],
        ]);
        expect(simulatedForkContexts.get('child-1')).toEqual([
            { role: 'user', text: 'seed' },
            { role: 'assistant', text: 'answer' },
        ]);
        expect(simulatedForkContexts.get('child-2')).toEqual(simulatedForkContexts.get('child-1'));
        expect(ctx.responseState.get(seed.body.id).checkpointId).toBe('assistant-parent-checkpoint');
        expect(ctx.responseState.get(first.body.id).checkpointId).toBe('assistant-child-1-checkpoint');
        expect(ctx.responseState.get(second.body.id).checkpointId).toBe('assistant-child-2-checkpoint');
        expect(sdkMocks.sessionDelete).not.toHaveBeenCalled();
    });

    test('Interactions forks every continuation from the same checkpoint and stores each child checkpoint', async () => {
        const { app, ctx } = createTestApp();
        const seed = await request(app).post('/v1beta/interactions').send({ model: 'opencode/kimi-k2.5', input: 'seed' });
        expect(seed.statusCode).toBe(200);

        const first = await request(app).post('/v1beta/interactions').send({
            model: 'opencode/kimi-k2.5',
            input: 'follow-up one',
            previous_interaction_id: seed.body.id,
        });
        const second = await request(app).post('/v1beta/interactions').send({
            model: 'opencode/kimi-k2.5',
            input: 'follow-up two',
            previous_interaction_id: seed.body.id,
        });

        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(200);
        expect(sdkMocks.sessionFork.mock.calls).toEqual([
            [{ path: { id: 'parent-session' } }],
            [{ path: { id: 'parent-session' } }],
        ]);
        expect(sdkMocks.sessionPrompt.mock.calls.slice(1).map(([args]) => args.path.id)).toEqual(['child-1', 'child-2']);
        expect(sdkMocks.sessionPrompt.mock.calls.slice(1).map(([args]) => args.body.parts.map((part) => part.text))).toEqual([
            ['follow-up one'],
            ['follow-up two'],
        ]);
        expect(simulatedForkContexts.get('child-1')).toEqual([
            { role: 'user', text: 'seed' },
            { role: 'assistant', text: 'answer' },
        ]);
        expect(simulatedForkContexts.get('child-2')).toEqual(simulatedForkContexts.get('child-1'));
        expect(ctx.responseState.get(seed.body.id).checkpointId).toBe('assistant-parent-checkpoint');
        expect(ctx.responseState.get(first.body.id).checkpointId).toBe('assistant-child-1-checkpoint');
        expect(ctx.responseState.get(second.body.id).checkpointId).toBe('assistant-child-2-checkpoint');
        expect(sdkMocks.sessionDelete).not.toHaveBeenCalled();
    });

    test.each([
        ['/v1/responses', { model: 'opencode/kimi-k2.5', input: 'follow-up', previous_response_id: 'no-checkpoint' }],
        ['/v1beta/interactions', { model: 'opencode/kimi-k2.5', input: 'follow-up', previous_interaction_id: 'no-checkpoint' }],
    ])('%s fails closed when the stored checkpoint is missing', async (path, body) => {
        const { app, ctx } = createTestApp();
        ctx.responseState.set('no-checkpoint', {
            sessionId: 'parent-session',
            model: 'opencode/kimi-k2.5',
            expiresAt: Date.now() + 60_000,
        });

        const response = await request(app).post(path).send(body);

        expect(response.statusCode).toBe(400);
        expect(sdkMocks.sessionFork).not.toHaveBeenCalled();
        expect(sdkMocks.sessionPrompt).not.toHaveBeenCalled();
        expect(sdkMocks.sessionDelete).not.toHaveBeenCalled();
    });

    test.each([
        ['/v1/responses', { model: 'opencode/kimi-k2.5', input: 'no assistant id' }],
        ['/v1beta/interactions', { model: 'opencode/kimi-k2.5', input: 'no assistant id' }],
    ])('%s does not retain a session when the completed turn has no assistant ID', async (path, body) => {
        const { app, ctx } = createTestApp();
        if (path === '/v1/responses') {
            sdkMocks.sessionPrompt.mockResolvedValueOnce({
                data: { parts: [{ type: 'text', text: 'answer without message metadata' }] },
            });
        } else {
            sdkMocks.sessionMessages.mockResolvedValueOnce([{
                info: { role: 'assistant', finish: 'stop' },
                parts: [{ type: 'text', text: 'answer without message metadata' }],
            }]);
        }

        const response = await request(app).post(path).send(body);

        expect(response.statusCode).toBe(200);
        expect(ctx.responseState.has(response.body.id)).toBe(false);
        expect(sdkMocks.sessionDelete).toHaveBeenCalledWith({ path: { id: 'parent-session' } });
    });

    test('expired lookup queues deletion until no live response state references the session, then retries failures', async () => {
        const { ctx } = createTestApp();
        ctx.responseState.set('expired-lookup', {
            sessionId: 'shared-expired-session',
            model: 'opencode/kimi-k2.5',
            expiresAt: Date.now() - 1,
        });
        ctx.responseState.set('live-reference', {
            sessionId: 'shared-expired-session',
            model: 'opencode/kimi-k2.5',
            expiresAt: Date.now() + 60_000,
        });
        sdkMocks.sessionDelete.mockRejectedValueOnce(new Error('temporary delete failure'));

        expect(ctx.getResponseState('expired-lookup')).toBeNull();
        expect(ctx.responseState.has('expired-lookup')).toBe(false);
        await ctx.sweepResponseState();
        expect(sdkMocks.sessionDelete).not.toHaveBeenCalled();

        ctx.responseState.get('live-reference').expiresAt = Date.now() - 1;
        await ctx.sweepResponseState();
        expect(sdkMocks.sessionDelete).toHaveBeenNthCalledWith(1, { path: { id: 'shared-expired-session' } });

        await ctx.sweepResponseState();
        expect(sdkMocks.sessionDelete).toHaveBeenCalledTimes(2);
        expect(sdkMocks.sessionDelete).toHaveBeenNthCalledWith(2, { path: { id: 'shared-expired-session' } });
    });

    test('retries deleting a continuation child after its first cleanup attempt fails', async () => {
        const { app } = createTestApp();
        const seed = await request(app).post('/v1/responses').send({ model: 'opencode/kimi-k2.5', input: 'seed' });
        expect(seed.statusCode).toBe(200);
        sdkMocks.sessionFork.mockResolvedValueOnce({ data: { id: 'continuation-child' } });
        sdkMocks.sessionPrompt.mockResolvedValueOnce({
            data: { parts: [{ type: 'text', text: 'answer without message metadata' }] },
        });
        sdkMocks.sessionDelete.mockRejectedValueOnce(new Error('temporary delete failure'));

        const continuation = await request(app).post('/v1/responses').send({
            input: 'follow-up',
            previous_response_id: seed.body.id,
        });

        expect(continuation.statusCode).toBe(200);
        expect(sdkMocks.sessionDelete).toHaveBeenCalledTimes(2);
        expect(sdkMocks.sessionDelete).toHaveBeenNthCalledWith(1, { path: { id: 'continuation-child' } });
        expect(sdkMocks.sessionDelete).toHaveBeenNthCalledWith(2, { path: { id: 'continuation-child' } });
        expect(sdkMocks.sessionDelete).not.toHaveBeenCalledWith({ path: { id: 'parent-session' } });
    });
});
