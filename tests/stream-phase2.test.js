import request from 'supertest';
import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';

const SESSION_ID = 'phase2-session';

const sdkMocks = {
    configProviders: jest.fn(async () => ({
        data: {
            providers: [{
                id: 'opencode',
                models: {
                    'big-pickle': { name: 'Big Pickle' },
                    'kimi-k2.5': { name: 'Kimi' }
                }
            }]
        }
    })),
    configUpdate: jest.fn(async () => ({})),
    toolIds: jest.fn(async () => ({ data: ['web_fetch', 'filesystem', 'bash'] })),
    sessionCreate: jest.fn(async () => ({ data: { id: SESSION_ID } })),
    sessionPrompt: jest.fn(async () => ({ data: { parts: [{ type: 'text', text: 'Mock response' }] } })),
    sessionMessages: jest.fn(async () => ([
        { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Mock response' }] }
    ])),
    sessionDelete: jest.fn(async () => ({})),
    eventSubscribe: jest.fn(async () => ({
        stream: (async function* () {
            yield { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: SESSION_ID }, delta: 'Hello' } };
            yield { type: 'message.updated', properties: { info: { sessionID: SESSION_ID, finish: 'stop' } } };
        })()
    }))
};

jest.unstable_mockModule('https', () => ({
    default: {
        get: jest.fn((url, options, callback) => {
            const res = { statusCode: 200, headers: {}, on: jest.fn() };
            callback(res);
            return { on: jest.fn(), destroy: jest.fn() };
        })
    }
}));

jest.unstable_mockModule('http', () => ({
    default: {
        get: jest.fn((url, options, callback) => {
            const res = { statusCode: 200, headers: {}, on: jest.fn() };
            callback(res);
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
const { createCollector } = await import('../src/stream/collector.js');

describe('Phase 2: SSE Framing, Keepalives, Headers, and Wire Integrity', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    const buildApp = (overrides = {}) => createApp({
        PORT: 10000,
        API_KEY: 'test-key',
        OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
        REQUEST_TIMEOUT_MS: 5000,
        RETRY_MAX_RETRIES: 0,
        DISABLE_TOOLS: true,
        DEBUG: false,
        ...overrides
    }).app;

    describe('1. X-Accel-Buffering: no header', () => {
        test('POST /v1/chat/completions carries X-Accel-Buffering: no when streaming', async () => {
            const res = await request(buildApp())
                .post('/v1/chat/completions')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }], stream: true });
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toContain('text/event-stream');
            expect(res.headers['x-accel-buffering']).toBe('no');
        });

        test('POST /v1/messages carries X-Accel-Buffering: no when streaming', async () => {
            const res = await request(buildApp())
                .post('/v1/messages')
                .set('Authorization', 'Bearer test-key')
                .set('anthropic-version', '2023-06-01')
                .send({ model: 'big-pickle', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], stream: true });
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toContain('text/event-stream');
            expect(res.headers['x-accel-buffering']).toBe('no');
        });

        test('POST /v1/responses carries X-Accel-Buffering: no when streaming', async () => {
            const res = await request(buildApp())
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'big-pickle', input: 'hi', stream: true });
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toContain('text/event-stream');
            expect(res.headers['x-accel-buffering']).toBe('no');
        });

        test('POST /v1/interactions carries X-Accel-Buffering: no when streaming', async () => {
            const res = await request(buildApp())
                .post('/v1/interactions')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'big-pickle', input: 'hi', stream: true });
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toContain('text/event-stream');
            expect(res.headers['x-accel-buffering']).toBe('no');
        });

        test('POST /v1beta/interactions carries X-Accel-Buffering: no when streaming', async () => {
            const res = await request(buildApp())
                .post('/v1beta/interactions')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'big-pickle', input: 'hi', stream: true });
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toContain('text/event-stream');
            expect(res.headers['x-accel-buffering']).toBe('no');
        });
    });

    describe('2. Keepalive framing', () => {
        test('route files do not contain double-newline keepalives/heartbeats', () => {
            const routeFiles = ['chat.ts', 'messages.ts', 'responses.ts', 'interactions.ts'];
            for (const file of routeFiles) {
                const content = fs.readFileSync(path.join(process.cwd(), 'src/routes', file), 'utf8');
                expect(content).not.toContain("': keepalive\\n\\n'");
                expect(content).not.toContain("': keep-alive\\n\\n'");
                expect(content).not.toContain("': heartbeat\\n\\n'");
            }
        });
    });

    describe('3. Anthropic Content Block Closing Before Error', () => {
        test('mid-stream text block error emits content_block_stop before event: error and no [DONE]', async () => {
            sdkMocks.eventSubscribe.mockImplementationOnce(async () => ({
                stream: (async function* () {
                    yield {
                        type: 'message.part.updated',
                        properties: { part: { id: 'p1', type: 'text', sessionID: SESSION_ID }, delta: 'Hello text' }
                    };
                    yield {
                        type: 'session.error',
                        properties: { sessionID: SESSION_ID, error: { message: 'midstream error occurred' } }
                    };
                })()
            }));

            const res = await request(buildApp())
                .post('/v1/messages')
                .set('Authorization', 'Bearer test-key')
                .set('anthropic-version', '2023-06-01')
                .send({ model: 'big-pickle', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], stream: true });

            expect(res.text).toContain('content_block_start');
            expect(res.text).toContain('content_block_stop');
            expect(res.text).toContain('event: error');
            expect(res.text).not.toContain('[DONE]');

            const blockStopPos = res.text.indexOf('event: content_block_stop');
            const errorPos = res.text.indexOf('event: error');
            expect(blockStopPos).toBeGreaterThan(-1);
            expect(errorPos).toBeGreaterThan(-1);
            expect(blockStopPos).toBeLessThan(errorPos);
        });

        test('mid-stream reasoning/thinking block error emits content_block_stop before event: error', async () => {
            sdkMocks.eventSubscribe.mockImplementationOnce(async () => ({
                stream: (async function* () {
                    yield {
                        type: 'message.part.updated',
                        properties: { part: { id: 'p1', type: 'reasoning', sessionID: SESSION_ID }, delta: 'Thinking deep thoughts' }
                    };
                    yield {
                        type: 'session.error',
                        properties: { sessionID: SESSION_ID, error: { message: 'thinking crash' } }
                    };
                })()
            }));

            const res = await request(buildApp())
                .post('/v1/messages')
                .set('Authorization', 'Bearer test-key')
                .set('anthropic-version', '2023-06-01')
                .send({ model: 'big-pickle', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], stream: true });

            expect(res.text).toContain('content_block_start');
            expect(res.text).toContain('"type":"thinking"');
            expect(res.text).toContain('content_block_stop');
            expect(res.text).toContain('event: error');

            const blockStopPos = res.text.indexOf('event: content_block_stop');
            const errorPos = res.text.indexOf('event: error');
            expect(blockStopPos).toBeGreaterThan(-1);
            expect(errorPos).toBeGreaterThan(-1);
            expect(blockStopPos).toBeLessThan(errorPos);
        });
    });

    describe('4. Outer Catch Stream Closure & Wire Integrity', () => {
        test('chat streaming error wire shape: data: {"error":{...}} then close without [DONE]', async () => {
            sdkMocks.eventSubscribe.mockImplementationOnce(async () => ({
                stream: (async function* () {
                    yield {
                        type: 'session.error',
                        properties: { sessionID: SESSION_ID, error: { message: 'Immediate chat backend error' } }
                    };
                })()
            }));

            const res = await request(buildApp())
                .post('/v1/chat/completions')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }], stream: true });

            expect(res.text).toContain('data: {"error":');
            expect(res.text).not.toContain('data: [DONE]');
        });

        test('responses streaming error wire shape: response.failed then data: [DONE]', async () => {
            sdkMocks.eventSubscribe.mockImplementationOnce(async () => ({
                stream: (async function* () {
                    yield {
                        type: 'session.error',
                        properties: { sessionID: SESSION_ID, error: { message: 'Responses backend error' } }
                    };
                })()
            }));

            const res = await request(buildApp())
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'big-pickle', input: 'hi', stream: true });

            expect(res.text).toContain('response.failed');
            expect(res.text).toContain('data: [DONE]');
        });

        test('interactions streaming error wire shape: data: {"type":"error",...} then close without [DONE]', async () => {
            sdkMocks.sessionPrompt.mockImplementationOnce(async () => {
                throw new Error('Interactions failure');
            });

            const res = await request(buildApp())
                .post('/v1/interactions')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'big-pickle', input: 'hi', stream: true });

            expect(res.text).toContain('data: {"type":"error"');
            expect(res.text).not.toContain('[DONE]');
        });

        test.each([
            ['chat', '/v1/chat/completions', { model: 'big-pickle', stream: true, messages: [{ role: 'user', content: 'hi' }] }],
            ['messages', '/v1/messages', { model: 'big-pickle', stream: true, max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }],
            ['responses', '/v1/responses', { model: 'big-pickle', stream: true, input: 'hi' }],
            ['interactions', '/v1/interactions', { model: 'big-pickle', stream: true, input: 'hi' }]
        ])('%s outer catch ends connection when backend throws error after headersSent', async (_name, endpoint, payload) => {
            sdkMocks.eventSubscribe.mockImplementationOnce(async () => {
                throw new Error('Fatal subscription failure after headersSent');
            });
            sdkMocks.sessionPrompt.mockImplementationOnce(async () => {
                throw new Error('Fatal prompt failure after headersSent');
            });
            sdkMocks.sessionMessages.mockImplementationOnce(async () => {
                throw new Error('Fatal recovery poll failure after headersSent');
            });
            const res = await request(buildApp())
                .post(endpoint)
                .set('Authorization', 'Bearer test-key')
                .set('anthropic-version', '2023-06-01')
                .send(payload);
            expect(res.headers['content-type']).toContain('text/event-stream');
            expect(res.text).toContain('error');
        });
    });

    describe('5. Collector: Natural iterator completion finalizes and clears timers', () => {
        const run = (events, firstDeltaTimeoutMs = null, idleTimeoutMs = null) => {
            const client = {
                event: {
                    subscribe: async () => ({
                        stream: (async function* () {
                            for (const event of events) {
                                yield event;
                            }
                        })()
                    })
                }
            };
            return createCollector({ client, logDebug: () => {} })
                .collectFromEvents('collector-session', 1000, null, firstDeltaTimeoutMs, idleTimeoutMs);
        };

        test('resolves with cut: true and noData: true when stream iterator finishes with no events', async () => {
            const result = await run([]);
            expect(result).toMatchObject({
                content: '',
                reasoning: '',
                cut: true,
                noData: true
            });
        });

        test('resolves with cut: true and partial content when stream iterator ends without terminal finish', async () => {
            const result = await run([
                {
                    type: 'message.part.updated',
                    properties: {
                        part: { id: 'p1', type: 'text', sessionID: 'collector-session' },
                        delta: 'Incomplete sentence without stop'
                    }
                }
            ]);
            expect(result).toMatchObject({
                content: 'Incomplete sentence without stop',
                cut: true
            });
            expect(result.noData).toBeUndefined();
        });

        test('resolves cleanly without cut when terminal stop is received', async () => {
            const result = await run([
                {
                    type: 'message.part.updated',
                    properties: {
                        part: { id: 'p1', type: 'text', sessionID: 'collector-session' },
                        delta: 'Complete sentence'
                    }
                },
                {
                    type: 'message.updated',
                    properties: {
                        info: { sessionID: 'collector-session', finish: 'stop' }
                    }
                }
            ]);
            expect(result).toMatchObject({
                content: 'Complete sentence',
                finish: 'stop'
            });
            expect(result.cut).toBeUndefined();
        });

        test('resolves with finish: tool when iterator ends after tool finish', async () => {
            const result = await run([
                {
                    type: 'message.part.updated',
                    properties: {
                        part: { id: 'p1', type: 'text', sessionID: 'collector-session' },
                        delta: 'Tool call output'
                    }
                },
                {
                    type: 'message.updated',
                    properties: {
                        info: { sessionID: 'collector-session', finish: 'tool' }
                    }
                }
            ]);
            expect(result).toMatchObject({
                content: 'Tool call output',
                finish: 'tool'
            });
            expect(result.cut).toBeUndefined();
        });

        test('natural iterator completion clears timeoutId, firstDeltaTimer, and idleTimer', async () => {
            const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
            try {
                await run([
                    {
                        type: 'message.part.updated',
                        properties: { part: { id: 'p1', type: 'text', sessionID: 'collector-session' }, delta: 'chunk' }
                    }
                ], 500, 500);
                expect(clearTimeoutSpy).toHaveBeenCalled();
            } finally {
                clearTimeoutSpy.mockRestore();
            }
        });
    });
});
