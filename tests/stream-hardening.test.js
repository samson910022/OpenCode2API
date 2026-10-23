import request from 'supertest';
import { jest } from '@jest/globals';

// Hardening for slow/overloaded hosts: /v1/responses must never sit at zero
// bytes silently (no headers, no error) when the backend is stuck.
const SESSION_ID = 'harden-session';

const sdkMocks = {
    configProviders: jest.fn(async () => ({
        data: { providers: [{ id: 'opencode', models: { 'big-pickle': { name: 'Big Pickle' } } }] }
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
            yield { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: SESSION_ID }, delta: 'Mock response' } };
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
        session: { create: sdkMocks.sessionCreate, prompt: sdkMocks.sessionPrompt, messages: sdkMocks.sessionMessages, delete: sdkMocks.sessionDelete },
        event: { subscribe: sdkMocks.eventSubscribe }
    }))
}));

const { createApp, withTimeout } = await import('../src/proxy.js');
const { createCollector } = await import('../src/stream/collector.js');

describe('withTimeout', () => {
    test('resolves with the value on success', async () => {
        await expect(withTimeout(Promise.resolve('ok'), 1000, 't')).resolves.toBe('ok');
    });

    test('rejects with a 504-mappable Request timeout message', async () => {
        const slow = new Promise(() => {});
        await expect(withTimeout(slow, 50, 'load tool overrides')).rejects.toThrow('Request timeout after 50ms (load tool overrides)');
    });

    test('a fast rejection wins with the real error, not a timeout', async () => {
        const started = Date.now();
        await expect(withTimeout(Promise.reject(new Error('invalid model')), 5000, 'resolve model'))
            .rejects.toThrow('invalid model');
        expect(Date.now() - started).toBeLessThan(1000);
    });

    test('a late rejection never surfaces as unhandled', async () => {
        let unhandled = null;
        const listener = (err) => { unhandled = err; };
        process.on('unhandledRejection', listener);
        try {
            let rejectLate;
            const loser = new Promise((_, reject) => { rejectLate = reject; });
            await expect(withTimeout(loser, 20, 't')).rejects.toThrow('Request timeout');
            rejectLate(new Error('boom-after-race'));
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(unhandled).toBeNull();
        } finally {
            process.removeListener('unhandledRejection', listener);
        }
    });
});

describe('POST /v1/responses stream hardening', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    const buildApp = (overrides = {}) => createApp({
        PORT: 10000, API_KEY: 'test-key',
        OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
        REQUEST_TIMEOUT_MS: 5000, RETRY_MAX_RETRIES: 0,
        DISABLE_TOOLS: true, DEBUG: false, ...overrides
    }).app;

    test('slow preflight still yields a complete SSE stream', async () => {
        sdkMocks.sessionCreate.mockImplementationOnce(async () => {
            await new Promise((resolve) => setTimeout(resolve, 400));
            return { data: { id: SESSION_ID } };
        });
        const res = await request(buildApp()).post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'big-pickle', input: 'hi', stream: true });
        expect(res.headers['content-type']).toContain('text/event-stream');
        expect(res.text).toContain('response.created');
        expect(res.text).toContain('response.completed');
        expect(res.text).toContain('data: [DONE]');
    });
    test('hung backend prompt surfaces a 504 timeout instead of stalling', async () => {
        sdkMocks.sessionPrompt.mockImplementationOnce(() => new Promise(() => {}));
        const started = Date.now();
        const res = await request(buildApp({ REQUEST_TIMEOUT_MS: 400 })).post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'big-pickle', input: 'hi' });
        expect(Date.now() - started).toBeLessThan(15000);
        expect(res.statusCode).toBe(504);
        expect(JSON.stringify(res.body)).not.toContain('"Object"');
    }, 20000);

    test('hung retry session.create surfaces a 504 instead of stalling', async () => {
        // Attempt 1 fails transiently (fast backoff via retry-after-ms),
        // then the retry's session.create hangs: must 504, not stall.
        sdkMocks.sessionCreate
            .mockImplementationOnce(async () => ({ data: { id: SESSION_ID } }))
            .mockImplementationOnce(() => new Promise(() => {}));
        sdkMocks.sessionPrompt.mockImplementationOnce(async () => {
            throw {
                name: 'CreditsError',
                data: {
                    message: '429: {"message":"Too many requests","type":"CreditsError"}',
                    responseHeaders: { 'retry-after-ms': '10' }
                }
            };
        });
        const started = Date.now();
        const res = await request(buildApp({ REQUEST_TIMEOUT_MS: 400, RETRY_MAX_RETRIES: 1 }))
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'big-pickle', input: 'hi' });
        expect(Date.now() - started).toBeLessThan(15000);
        expect(res.statusCode).toBe(504);
        expect(JSON.stringify(res.body)).not.toContain('"Object"');
    }, 20000);
});

describe('POST /v1/messages stream does not cancel itself', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('stream completes even though the request body closed long ago', async () => {
        const app = createApp({
            PORT: 10000, API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000, RETRY_MAX_RETRIES: 0,
            DISABLE_TOOLS: true, DEBUG: false
        }).app;
        const res = await request(app).post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .set('anthropic-version', '2023-06-01')
            .send({ model: 'big-pickle', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], stream: true });
        expect(res.headers['content-type']).toContain('text/event-stream');
        expect(res.text).toContain('message_stop');
    }, 20000);
});

describe('collector terminal state', () => {
    const run = (events, firstDeltaTimeoutMs = null) => {
        const client = {
            event: {
                subscribe: async () => ({
                    stream: (async function* () {
                        for (const event of events) {
                            if (typeof event.delay === 'number') {
                                await new Promise((resolve) => setTimeout(resolve, event.delay));
                            }
                            yield event;
                        }
                    })()
                })
            }
        };
        return createCollector({ client, logDebug: () => {} })
            .collectFromEvents('collector-session', 1000, null, firstDeltaTimeoutMs);
    };

    test('gives finish plus error priority over completion', async () => {
        const result = await run([
            { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'collector-session' }, delta: 'partial' } },
            { type: 'message.updated', properties: { info: { sessionID: 'collector-session', finish: 'stop', error: { name: 'MessageAbortedError' } } } }
        ]);
        expect(result.error).toMatchObject({ name: 'MessageAbortedError' });
        expect(result.noData).toBeUndefined();
    });

    test('marks a completed empty message as noData', async () => {
        const result = await run([
            { type: 'message.updated', properties: { info: { sessionID: 'collector-session', finish: 'stop' } } }
        ]);
        expect(result).toMatchObject({ content: '', reasoning: '', noData: true });
    });

    test('first-delta timeout keeps snapshot-only text and skips noData', async () => {
        const result = await run([
            {
                type: 'message.updated',
                properties: {
                    info: {
                        id: 'msg-1',
                        role: 'assistant',
                        sessionID: 'collector-session',
                        parts: [{ id: 'p1', messageID: 'msg-1', type: 'text', text: 'snapshot answer' }]
                    }
                }
            }
        ], 20);
        expect(result).toMatchObject({ content: 'snapshot answer', authoritative: true });
        expect(result.noData).toBeUndefined();
    });

    test.each([['tool'], ['tool-calls']])(
        'keeps the stream open when a turn finishes with %s',
        async (finish) => {
            const result = await run([
                { type: 'message.updated', properties: { info: { sessionID: 'collector-session', finish } } },
                {
                    delay: 150,
                    type: 'message.part.updated',
                    properties: { part: { type: 'text', sessionID: 'collector-session' }, delta: 'after the tool' }
                },
                { type: 'message.updated', properties: { info: { sessionID: 'collector-session', finish: 'stop' } } }
            ], 60);
            expect(result).toMatchObject({ content: 'after the tool' });
            expect(result.noData).toBeUndefined();
        }
    );
});

describe('collector ID-less tool tracking', () => {
    const run = (events, firstDeltaTimeoutMs = null) => {
        const client = {
            event: {
                subscribe: async () => ({
                    stream: (async function* () {
                        for (const event of events) {
                            if (typeof event.delay === 'number') {
                                await new Promise((resolve) => setTimeout(resolve, event.delay));
                            }
                            yield event;
                        }
                    })()
                })
            }
        };
        return createCollector({ client, logDebug: () => {} })
            .collectFromEvents('collector-session', 1000, null, firstDeltaTimeoutMs);
    };
    const noidPart = (tool, status) => ({
        type: 'message.part.updated',
        properties: {
            part: tool == null
                ? { type: 'tool', sessionID: 'collector-session', state: { status } }
                : { type: 'tool', tool, sessionID: 'collector-session', state: { status } },
        },
    });
    const textDelta = (delta) => ({
        type: 'message.part.updated',
        properties: { part: { type: 'text', sessionID: 'collector-session' }, delta },
    });
    const stop = () => ({
        type: 'message.updated',
        properties: { info: { sessionID: 'collector-session', finish: 'stop' } },
    });

    test('repeat pending snapshots of one ID-less tool resolve on its terminal', async () => {
        const result = await run([
            noidPart('web_fetch', 'pending'),
            noidPart('web_fetch', 'pending'),
            noidPart('web_fetch', 'pending'),
            noidPart('web_fetch', 'completed'),
            textDelta('done'),
            stop(),
        ]);
        expect(result).toMatchObject({ content: 'done' });
        expect(result.noData).toBeUndefined();
    });

    test('distinct ID-less tools stay active until each completes', async () => {
        const result = await run([
            noidPart('web_fetch', 'pending'),
            noidPart('bash', 'pending'),
            noidPart('web_fetch', 'completed'),
            // Intermediate stop while bash is still running must be ignored.
            stop(),
            textDelta('final'),
            noidPart('bash', 'completed'),
            stop(),
        ]);
        expect(result).toMatchObject({ content: 'final' });
        expect(result.noData).toBeUndefined();
    });

    test('replayed terminal snapshot does not clear a still-running tool', async () => {
        const result = await run([
            noidPart('web_fetch', 'pending'),
            noidPart('bash', 'pending'),
            noidPart('web_fetch', 'completed'),
            // Snapshot replay re-delivers the settled web_fetch terminal alongside
            // bash. Pending-first order matters: the replayed terminal is processed
            // last, so a naive drop-one-bucket fallback deletes bash's bucket.
            {
                type: 'message.updated',
                properties: {
                    info: {
                        sessionID: 'collector-session',
                        parts: [
                            { type: 'tool', tool: 'bash', state: { status: 'pending' } },
                            { type: 'tool', tool: 'web_fetch', state: { status: 'completed' } },
                        ],
                    },
                },
            },
            // Intermediate stop while bash is still running must be ignored.
            stop(),
            textDelta('final'),
            noidPart('bash', 'completed'),
            stop(),
        ]);
        expect(result).toMatchObject({ content: 'final' });
        expect(result.noData).toBeUndefined();
    });

    test('a stale full message snapshot cannot complete a newer running tool part', async () => {
        let terminalUpdateObserved = false;
        const toolPart = (status) => ({
            type: 'message.part.updated',
            properties: {
                part: {
                    id: 'tool-call-1',
                    messageID: 'assistant-1',
                    type: 'tool',
                    tool: 'bash',
                    state: { status },
                    sessionID: 'collector-session',
                },
            },
        });
        const client = {
            event: {
                subscribe: async () => ({
                    stream: (async function* () {
                        yield toolPart('running');
                        yield {
                            type: 'message.updated',
                            properties: {
                                info: {
                                    id: 'assistant-1',
                                    role: 'assistant',
                                    finish: 'stop',
                                    sessionID: 'collector-session',
                                    parts: [{
                                        id: 'tool-call-1',
                                        messageID: 'assistant-1',
                                        type: 'tool',
                                        tool: 'bash',
                                        state: { status: 'completed' },
                                    }],
                                },
                            },
                        };
                        await new Promise((resolve) => setTimeout(resolve, 30));
                        terminalUpdateObserved = true;
                        yield toolPart('completed');
                        yield {
                            type: 'message.updated',
                            properties: { info: { id: 'assistant-1', role: 'assistant', finish: 'stop', sessionID: 'collector-session' } },
                        };
                    })(),
                }),
            },
        };

        const result = await createCollector({ client, logDebug: () => {} }).collectFromEvents('collector-session', 1000);

        expect(terminalUpdateObserved).toBe(true);
        expect(result.finish).toBe('stop');
        expect(result.cut).toBeUndefined();
    });

    test('single-bucket mismatch clears without hanging (named pending, unnamed terminal)', async () => {
        const result = await run([
            noidPart('web_fetch', 'pending'),
            noidPart(undefined, 'completed'),
            textDelta('done'),
            stop(),
        ]);
        expect(result).toMatchObject({ content: 'done' });
        expect(result.noData).toBeUndefined();
    });

    test('single-bucket mismatch clears without hanging (unnamed pending, named terminal)', async () => {
        const result = await run([
            noidPart(undefined, 'pending'),
            noidPart('web_fetch', 'completed'),
            textDelta('done'),
            stop(),
        ]);
        expect(result).toMatchObject({ content: 'done' });
        expect(result.noData).toBeUndefined();
    });

    test('same-name concurrent ID-less tools share one bucket (documented limitation)', async () => {
        const result = await run([
            noidPart('web_fetch', 'pending'),
            noidPart('web_fetch', 'pending'),
            noidPart('web_fetch', 'completed'),
            textDelta('done'),
            stop(),
        ]);
        expect(result).toMatchObject({ content: 'done' });
        expect(result.noData).toBeUndefined();
    });
});

describe('collector event error and tool deltas', () => {
    const run = (events, signal) => {
        const client = {
            event: {
                subscribe: async () => ({
                    stream: (async function* () {
                        for (const event of events) yield event;
                    })()
                })
            }
        };
        return createCollector({ client, logDebug: () => {} })
            .collectFromEvents('collector-session', 1000, null, null, null, signal);
    };

    test('does not emit a tool part delta as assistant content', async () => {
        const result = await run([
            { type: 'message.part.updated', properties: { part: { id: 'tool-1', type: 'tool', sessionID: 'collector-session', state: { status: 'completed' } }, delta: 'LEAK' } },
            { type: 'message.updated', properties: { info: { sessionID: 'collector-session', finish: 'stop' } } }
        ]);
        expect(result).toMatchObject({ content: '', reasoning: '', noData: true });
        expect(JSON.stringify(result)).not.toContain('LEAK');
    });

    test('returns session.error as an error result', async () => {
        const result = await run([
            { type: 'session.error', properties: { sessionID: 'collector-session', error: { name: 'SessionBoom', data: { message: 'session failed' } } } }
        ]);
        expect(result.error).toMatchObject({ name: 'SessionBoom' });
        expect(result.noData).toBeUndefined();
    });

    test('cancels an active event wait through the supplied signal', async () => {
        const controller = new AbortController();
        const pending = new Promise(() => {});
        const client = {
            event: {
                subscribe: async () => ({
                    stream: (async function* () {
                        await pending;
                    })()
                })
            }
        };
        const resultPromise = createCollector({ client, logDebug: () => {} })
            .collectFromEvents('collector-session', 5000, null, null, null, controller.signal);
        controller.abort();
        await expect(resultPromise).resolves.toMatchObject({ cancelled: true });
    });
});

describe('collector authoritative snapshots', () => {
    const run = (events, onDelta = null) => {
        const client = {
            event: {
                subscribe: async () => ({
                    stream: (async function* () {
                        for (const event of events) yield event;
                    })()
                })
            }
        };
        return createCollector({ client, logDebug: () => {} })
            .collectFromEvents('collector-session', 1000, onDelta, null, null);
    };
    const textDelta = (partID, delta, messageID) => ({
        type: 'message.part.delta',
        properties: { sessionID: 'collector-session', partID, field: 'text', delta, ...(messageID ? { messageID } : {}) }
    });
    const stop = (parts) => ({
        type: 'message.updated',
        properties: {
            info: {
                sessionID: 'collector-session',
                finish: 'stop',
                ...(parts ? { parts } : {})
            }
        }
    });

    test('final part.text repairs a delta that never arrived', async () => {
        const result = await run([
            { type: 'message.part.updated', properties: { part: { id: 'p1', type: 'text', sessionID: 'collector-session' }, delta: 'Hello ' } },
            { type: 'message.part.updated', properties: { part: { id: 'p1', type: 'text', text: 'Hello world', sessionID: 'collector-session' } } },
            stop()
        ]);
        expect(result).toMatchObject({ content: 'Hello world', authoritative: true });
    });

    test('id-less final part.text still repairs a missing delta', async () => {
        const result = await run([
            { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'collector-session' }, delta: 'Hello ' } },
            { type: 'message.part.updated', properties: { part: { type: 'text', text: 'Hello world', sessionID: 'collector-session' } } },
            stop()
        ]);
        expect(result).toMatchObject({ content: 'Hello world', authoritative: true });
    });

    test('keeps multiple id-less text deltas in one stable bucket', async () => {
        const result = await run([
            { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'collector-session' }, delta: 'Hello ' } },
            { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'collector-session' }, delta: 'world' } },
            stop()
        ]);
        expect(result.content).toBe('Hello world');
        expect(result.authoritative).toBeUndefined();
    });

    test('message.updated info.parts snapshot replaces partial delta text', async () => {
        const result = await run([
            textDelta('p1', 'partial '),
            { type: 'message.part.updated', properties: { part: { id: 'p1', type: 'text', sessionID: 'collector-session' } } },
            textDelta('p1', 'answer'),
            stop([
                { id: 'p1', type: 'text', text: 'complete answer' }
            ])
        ]);
        expect(result).toMatchObject({ content: 'complete answer', authoritative: true });
        expect(result.content).not.toContain('partial');
    });

    test('keeps a delta that arrives before its part type is known', async () => {
        const result = await run([
            textDelta('p1', 'early '),
            { type: 'message.part.updated', properties: { part: { id: 'p1', type: 'text', sessionID: 'collector-session' } } },
            textDelta('p1', 'answer'),
            stop()
        ]);
        expect(result).toMatchObject({ content: 'early answer' });
        expect(result.authoritative).toBeUndefined();
    });

    test('a final snapshot wins over buffered deltas without duplicating text', async () => {
        const result = await run([
            textDelta('p1', 'early '),
            { type: 'message.part.updated', properties: { part: { id: 'p1', type: 'text', text: 'complete answer', sessionID: 'collector-session' } } },
            stop([{ id: 'p1', type: 'text', text: 'complete answer' }])
        ]);
        expect(result).toMatchObject({ content: 'complete answer', authoritative: true });
        expect(result.content.match(/complete/g)).toHaveLength(1);
        expect(result.content).not.toContain('early');
    });

    test('does not mark equal delta and snapshot text as authoritative', async () => {
        const result = await run([
            { type: 'message.part.updated', properties: { part: { id: 'p1', type: 'text', sessionID: 'collector-session' }, delta: 'Hello world' } },
            stop([{ id: 'p1', type: 'text', text: 'Hello world' }])
        ]);
        expect(result).toMatchObject({ content: 'Hello world' });
        expect(result.authoritative).toBeUndefined();
        expect(result.content.match(/Hello world/g)).toHaveLength(1);
    });

    test('ignores a user prompt snapshot and user text parts', async () => {
        const deltas = [];
        const client = {
            event: {
                subscribe: async () => ({
                    stream: (async function* () {
                        yield {
                            type: 'message.updated',
                            properties: {
                                info: {
                                    id: 'msg-user',
                                    sessionID: 'collector-session',
                                    role: 'user',
                                    parts: [{ id: 'user-text', messageID: 'msg-user', type: 'text', text: 'SECRET PROMPT' }]
                                }
                            }
                        };
                        yield {
                            type: 'message.updated',
                            properties: { info: { id: 'msg-assistant', sessionID: 'collector-session', role: 'assistant' } }
                        };
                        yield {
                            type: 'message.part.updated',
                            properties: { part: { id: 'user-text', messageID: 'msg-user', type: 'text', sessionID: 'collector-session', text: 'SECRET PROMPT' } }
                        };
                        yield textDelta('assistant-text', 'answer', 'msg-assistant');
                        yield {
                            type: 'message.part.updated',
                            properties: { part: { id: 'assistant-text', messageID: 'msg-assistant', type: 'text', text: 'answer', sessionID: 'collector-session' } }
                        };
                        yield stop();
                    })()
                })
            }
        };
        const result = await createCollector({ client, logDebug: () => {} })
            .collectFromEvents('collector-session', 1000, (delta) => deltas.push(delta), null, null);
        expect(result.content).toBe('answer');
        expect(result.content).not.toContain('SECRET');
        expect(deltas.join('')).not.toContain('SECRET');
    });

    test('a delayed user role filters a part that arrived before the role was known', async () => {
        const result = await run([
            { type: 'message.part.updated', properties: { part: { id: 'user-text', messageID: 'msg-user', type: 'text', sessionID: 'collector-session' }, delta: 'SECRET PROMPT' } },
            { type: 'message.updated', properties: { info: { id: 'msg-user', sessionID: 'collector-session', role: 'user' } } },
            { type: 'message.updated', properties: { info: { id: 'msg-assistant', sessionID: 'collector-session', role: 'assistant' } } },
            { type: 'message.part.updated', properties: { part: { id: 'assistant-text', messageID: 'msg-assistant', type: 'text', sessionID: 'collector-session' } } },
            textDelta('assistant-text', 'answer', 'msg-assistant'),
            stop()
        ]);
        expect(result.content).toBe('answer');
        expect(result.content).not.toContain('SECRET');
        expect(result.authoritative).toBe(true);
    });

    test('role-unknown legacy deltas are not called back and are purged when classified as user', async () => {
        const deltas = [];
        const client = {
            event: {
                subscribe: async () => ({
                    stream: (async function* () {
                        yield {
                            type: 'message.part.updated',
                            properties: {
                                part: { id: 'user-part', messageID: 'msg-user-late', type: 'text', sessionID: 'collector-session' },
                                delta: 'SECRET PROMPT',
                            },
                        };
                        expect(deltas).toEqual([]);
                        yield {
                            type: 'message.updated',
                            properties: { info: { id: 'msg-user-late', role: 'user', sessionID: 'collector-session' } },
                        };
                        expect(deltas).toEqual([]);
                        yield textDelta('user-part', 'SECRET PROMPT CONTINUATION');
                        expect(deltas).toEqual([]);
                        yield {
                            type: 'message.updated',
                            properties: { info: { id: 'msg-assistant-late', role: 'assistant', sessionID: 'collector-session' } },
                        };
                        yield {
                            type: 'message.part.updated',
                            properties: {
                                part: { id: 'assistant-part', messageID: 'msg-assistant-late', type: 'text', sessionID: 'collector-session' },
                                delta: 'Visible answer',
                            },
                        };
                        yield stop();
                    })(),
                }),
            },
        };
        const result = await createCollector({ client, logDebug: () => {} })
            .collectFromEvents('collector-session', 1000, (delta) => deltas.push(delta), null, null);

        expect(result.content).toBe('Visible answer');
        expect(result.content).not.toContain('SECRET PROMPT');
        expect(result.content).not.toContain('SECRET PROMPT CONTINUATION');
        expect(deltas.join('')).toBe('Visible answer');
    });

    test('releases buffered legacy deltas to the callback when the role becomes assistant', async () => {
        const deltas = [];
        const client = {
            event: {
                subscribe: async () => ({
                    stream: (async function* () {
                        yield {
                            type: 'message.part.updated',
                            properties: {
                                part: { id: 'assistant-part', messageID: 'msg-assistant-late', type: 'text', sessionID: 'collector-session' },
                                delta: 'Early answer',
                            },
                        };
                        expect(deltas).toEqual([]);
                        yield {
                            type: 'message.updated',
                            properties: { info: { id: 'msg-assistant-late', role: 'assistant', sessionID: 'collector-session' } },
                        };
                        expect(deltas).toEqual(['Early answer']);
                        yield stop();
                    })(),
                }),
            },
        };
        const result = await createCollector({ client, logDebug: () => {} })
            .collectFromEvents('collector-session', 1000, (delta) => deltas.push(delta), null, null);

        expect(result.content).toBe('Early answer');
        expect(deltas).toEqual(['Early answer']);
    });

    test('accepts an unrecognized legacy role as role-unknown rather than filtering its text', async () => {
        const deltas = [];
        const result = await run([
            {
                type: 'message.updated',
                properties: { info: { id: 'legacy-message', role: 'developer', sessionID: 'collector-session' } },
            },
            {
                type: 'message.part.updated',
                properties: {
                    part: { id: 'legacy-part', messageID: 'legacy-message', type: 'text', sessionID: 'collector-session' },
                    delta: 'Legacy role answer',
                },
            },
            stop(),
        ], (delta) => deltas.push(delta));

        expect(result.content).toBe('Legacy role answer');
        expect(result.authoritative).toBe(true);
        expect(deltas).toEqual([]);
    });

    test('keeps truly role-unknown legacy text only in the finalized result', async () => {
        const deltas = [];
        const client = {
            event: {
                subscribe: async () => ({
                    stream: (async function* () {
                        yield { type: 'message.part.updated', properties: { part: { id: 'legacy-part', messageID: 'role-never-known', type: 'text', sessionID: 'collector-session' }, delta: 'Legacy final text' } };
                        expect(deltas).toEqual([]);
                        yield stop();
                    })(),
                }),
            },
        };
        const result = await createCollector({ client, logDebug: () => {} })
            .collectFromEvents('collector-session', 1000, (delta) => deltas.push(delta), null, null);

        expect(result.content).toBe('Legacy final text');
        expect(deltas).toEqual([]);
    });

    test('keeps every part when one part snapshot is missing', async () => {
        const result = await run([
            { type: 'message.part.updated', properties: { part: { id: 'p1', messageID: 'msg-1', type: 'text', sessionID: 'collector-session' }, delta: 'Hello ' } },
            { type: 'message.part.updated', properties: { part: { id: 'p2', messageID: 'msg-1', type: 'text', sessionID: 'collector-session' }, delta: 'world' } },
            { type: 'message.part.updated', properties: { part: { id: 'p2', messageID: 'msg-1', type: 'text', text: 'world!', sessionID: 'collector-session' } } },
            stop()
        ]);
        expect(result.content).toBe('Hello world!');
        expect(result.authoritative).toBe(true);
    });

    test('a newer full part.text overrides a sticky info.parts snapshot', async () => {
        const result = await run([
            {
                type: 'message.updated',
                properties: {
                    info: {
                        id: 'msg-1',
                        role: 'assistant',
                        sessionID: 'collector-session',
                        parts: [{ id: 'p1', messageID: 'msg-1', type: 'text', text: 'old snapshot' }]
                    }
                }
            },
            { type: 'message.part.updated', properties: { part: { id: 'p1', messageID: 'msg-1', type: 'text', text: 'newer text', sessionID: 'collector-session' } } },
            stop()
        ]);
        expect(result.content).toBe('newer text');
        expect(result.content).not.toContain('old snapshot');
    });

    test('flushes an early delta whose numeric partID was stringified', async () => {
        const result = await run([
            { type: 'message.part.delta', properties: { sessionID: 'collector-session', partID: 7, field: 'text', delta: 'early ' } },
            { type: 'message.part.updated', properties: { part: { id: 7, messageID: 'msg-1', type: 'text', sessionID: 'collector-session' } } },
            { type: 'message.part.delta', properties: { sessionID: 'collector-session', messageID: 'msg-1', partID: 7, field: 'text', delta: 'answer' } },
            stop()
        ]);
        expect(result.content).toBe('early answer');
        expect(result.authoritative).toBeUndefined();
    });

    test('snapshot-only final part.text becomes content with zero deltas', async () => {
        const result = await run([
            { type: 'message.part.updated', properties: { part: { id: 'p1', messageID: 'msg-1', type: 'text', text: 'snapshot only', sessionID: 'collector-session' } } },
            stop()
        ]);
        expect(result.content).toBe('snapshot only');
        expect(result.authoritative).toBe(true);
    });

    test('combines snapshot prefix with subsequent deltas for the same part', async () => {
        const result = await run([
            { type: 'message.part.updated', properties: { part: { id: 'p1', messageID: 'msg-1', type: 'text', text: 'Hello', sessionID: 'collector-session' } } },
            { type: 'message.part.updated', properties: { part: { id: 'p1', messageID: 'msg-1', type: 'text', sessionID: 'collector-session' }, delta: ' world' } },
            stop()
        ]);
        expect(result.content).toBe('Hello world');
        expect(result.authoritative).toBe(true);
    });

    test('interleaved snapshot -> delta -> newer snapshot -> delta does not duplicate delta text', async () => {
        const result = await run([
            { type: 'message.part.updated', properties: { part: { id: 'p1', messageID: 'msg-1', type: 'text', text: 'Hello', sessionID: 'collector-session' } } },
            textDelta('p1', ' world', 'msg-1'),
            { type: 'message.part.updated', properties: { part: { id: 'p1', messageID: 'msg-1', type: 'text', text: 'Hello world', sessionID: 'collector-session' } } },
            textDelta('p1', '!', 'msg-1'),
            stop()
        ]);
        expect(result.content).toBe('Hello world!');
        expect(result.content).not.toBe('Hello world world!');
        expect(result.content).not.toContain('world world');
    });

    test('interleaved snapshot -> delta -> newer snapshot -> delta via message.part.updated delta', async () => {
        const result = await run([
            { type: 'message.part.updated', properties: { part: { id: 'p1', messageID: 'msg-1', type: 'text', text: 'Hello', sessionID: 'collector-session' } } },
            { type: 'message.part.updated', properties: { part: { id: 'p1', messageID: 'msg-1', type: 'text', sessionID: 'collector-session' }, delta: ' world' } },
            { type: 'message.part.updated', properties: { part: { id: 'p1', messageID: 'msg-1', type: 'text', text: 'Hello world', sessionID: 'collector-session' } } },
            { type: 'message.part.updated', properties: { part: { id: 'p1', messageID: 'msg-1', type: 'text', sessionID: 'collector-session' }, delta: '!' } },
            stop()
        ]);
        expect(result.content).toBe('Hello world!');
        expect(result.content).not.toBe('Hello world world!');
        expect(result.content).not.toContain('world world');
    });

    test('co-occurring part.text and delta on legacy OpenCode server events does not duplicate delta text', async () => {
        const result = await run([
            {
                type: 'message.part.updated',
                properties: {
                    part: { id: 'p1', messageID: 'msg-1', type: 'text', text: 'Initial', sessionID: 'collector-session' }
                }
            },
            {
                type: 'message.part.updated',
                properties: {
                    part: { id: 'p1', messageID: 'msg-1', type: 'text', text: 'Initial reply', sessionID: 'collector-session' },
                    delta: ' reply'
                }
            },
            stop()
        ]);
        expect(result.content).toBe('Initial reply');
        expect(result.content).not.toContain('reply reply');
    });

    test('flushes orphaned deltas whose part update was dropped', async () => {
        const result = await run([
            { type: 'message.part.delta', properties: { sessionID: 'collector-session', messageID: 'msg-1', partID: 'orphan', field: 'text', delta: 'orphan text' } },
            stop()
        ]);
        expect(result.content).toBe('orphan text');
    });

    test('purges an ID-less pending delta when a user snapshot identifies its part', async () => {
        const result = await run([
            textDelta('shared-part', 'SECRET USER TEXT'),
            {
                type: 'message.updated',
                properties: {
                    info: {
                        id: 'msg-user',
                        role: 'user',
                        sessionID: 'collector-session',
                    },
                },
            },
            {
                type: 'message.part.updated',
                properties: {
                    part: {
                        id: 'shared-part',
                        messageID: 'msg-user',
                        type: 'text',
                        text: 'SECRET USER TEXT',
                        sessionID: 'collector-session',
                    },
                },
            },
            { type: 'message.updated', properties: { info: { id: 'msg-assistant', role: 'assistant', sessionID: 'collector-session' } } },
            textDelta('assistant-part', 'answer', 'msg-assistant'),
            stop(),
        ]);
        expect(result.content).toBe('answer');
        expect(result.content).not.toContain('SECRET USER TEXT');
    });

    test('remembers user part IDs for ID-less deltas without purging unrelated legacy deltas', async () => {
        const deltas = [];
        const client = {
            event: {
                subscribe: async () => ({
                    stream: (async function* () {
                        yield textDelta('legacy-orphan', 'Legacy answer');
                        yield {
                            type: 'message.updated',
                            properties: {
                                info: {
                                    sessionID: 'collector-session',
                                    role: 'user',
                                    parts: [{ id: 'known-user-part', type: 'text', text: 'SECRET USER TEXT' }],
                                },
                            },
                        };
                        yield textDelta('known-user-part', 'SECRET USER TEXT');
                        yield stop();
                    })(),
                }),
            },
        };
        const result = await createCollector({ client, logDebug: () => {} })
            .collectFromEvents('collector-session', 1000, (delta) => deltas.push(delta), null, null);

        expect(result.content).toBe('Legacy answer');
        expect(result.content).not.toContain('SECRET USER TEXT');
        expect(deltas.join('')).not.toContain('SECRET USER TEXT');
    });

    test('ignores a stale assistant part from a previous turn', async () => {
        const result = await run([
            {
                type: 'message.part.updated',
                properties: {
                    part: {
                        id: 'old-part',
                        messageID: 'msg-old',
                        type: 'text',
                        text: 'OLD TEXT',
                        time: { created: Date.now() - 60000 },
                        sessionID: 'collector-session'
                    }
                }
            },
            { type: 'message.part.updated', properties: { part: { id: 'new-part', messageID: 'msg-new', type: 'text', sessionID: 'collector-session' }, delta: 'new answer' } },
            stop()
        ]);
        expect(result.content).toBe('new answer');
        expect(result.content).not.toContain('OLD TEXT');
    });

    test('ignores a timestamp-less mismatched-parent assistant turn when parts arrive first', async () => {
        const deltas = [];
        const client = {
            event: {
                subscribe: async () => ({
                    stream: (async function* () {
                        yield {
                            type: 'message.part.updated',
                            properties: {
                                part: {
                                    id: 'stale-part',
                                    messageID: 'assistant-stale',
                                    type: 'text',
                                    sessionID: 'collector-session',
                                },
                                delta: 'Stale answer',
                            },
                        };
                        yield {
                            type: 'message.updated',
                            properties: {
                                info: {
                                    id: 'assistant-stale',
                                    role: 'assistant',
                                    sessionID: 'collector-session',
                                },
                            },
                        };
                        yield {
                            type: 'message.updated',
                            properties: {
                                info: {
                                    id: 'assistant-stale',
                                    role: 'assistant',
                                    parentID: 'previous-user',
                                    finish: 'stop',
                                    sessionID: 'collector-session',
                                },
                            },
                        };
                    })(),
                }),
            },
        };
        const result = await createCollector({ client, logDebug: () => {} })
            .collectFromEvents('collector-session', 1000, (delta) => deltas.push(delta), null, null, undefined, 'current-user');

        expect(result.content).toBe('');
        expect(result.noData).toBe(true);
        expect(result.finish).toBeUndefined();
        expect(deltas).toEqual([]);
    });

    test.each([
        ['mismatched', { parentID: 'previous-user' }],
        ['missing', {}],
    ])('does not accept a timestamp-less completed assistant snapshot with %s parent metadata', async (_label, parent) => {
        const deltas = [];
        const client = {
            event: {
                subscribe: async () => ({
                    stream: (async function* () {
                        yield {
                            type: 'message.updated',
                            properties: {
                                info: {
                                    id: 'assistant-unverified',
                                    role: 'assistant',
                                    ...parent,
                                    finish: 'stop',
                                    sessionID: 'collector-session',
                                    parts: [{ id: 'unverified-part', type: 'text', text: 'UNVERIFIED ANSWER' }],
                                },
                            },
                        };
                    })(),
                }),
            },
        };
        const result = await createCollector({ client, logDebug: () => {} })
            .collectFromEvents('collector-session', 1000, (delta) => deltas.push(delta), null, null, undefined, 'current-user');

        expect(result.content).toBe('');
        expect(result.noData).toBe(true);
        expect(result.finish).toBeUndefined();
        expect(deltas).toEqual([]);
    });

    test('remembers stale part IDs for ID-less deltas without blocking an explicitly different message', async () => {
        const deltas = [];
        const sharedPartID = 'shared-stale-part';
        const currentUserID = 'current-user';
        const client = {
            event: {
                subscribe: async () => ({
                    stream: (async function* () {
                        yield {
                            type: 'message.updated',
                            properties: {
                                info: {
                                    id: 'assistant-old',
                                    role: 'assistant',
                                    parentID: 'previous-user',
                                    finish: 'stop',
                                    sessionID: 'collector-session',
                                    parts: [{ id: sharedPartID, type: 'text', text: 'STALE SNAPSHOT' }],
                                },
                            },
                        };
                        // The stale part metadata is already known; an ID-less
                        // delta cannot safely establish which message produced it.
                        yield textDelta(sharedPartID, ' STALE REINTRODUCTION');
                        yield {
                            type: 'message.part.updated',
                            properties: {
                                part: {
                                    id: sharedPartID,
                                    messageID: 'assistant-current',
                                    parentID: currentUserID,
                                    type: 'text',
                                    sessionID: 'collector-session',
                                },
                                delta: 'VALID ANSWER',
                            },
                        };
                        yield {
                            type: 'message.updated',
                            properties: {
                                info: {
                                    id: 'assistant-current',
                                    role: 'assistant',
                                    parentID: currentUserID,
                                    finish: 'stop',
                                    sessionID: 'collector-session',
                                },
                            },
                        };
                    })(),
                }),
            },
        };
        const result = await createCollector({ client, logDebug: () => {} })
            .collectFromEvents('collector-session', 1000, (delta) => deltas.push(delta), null, null, undefined, currentUserID);

        expect(result.content).toBe('VALID ANSWER');
        expect(result.content).not.toContain('STALE');
        expect(deltas).toEqual(['VALID ANSWER']);
    });
});

describe('collector continuation turn correlation', () => {
    const currentUserID = 'current-user';
    const collect = (events, onDelta = null) => {
        const client = {
            event: {
                subscribe: async () => ({
                    stream: (async function* () {
                        for (const event of events) yield event;
                    })(),
                }),
            },
        };
        return createCollector({ client, logDebug: () => {} }).collectFromEvents(
            'collector-session', 1000, onDelta, null, null, undefined, currentUserID,
        );
    };
    const stopMessage = (info) => ({
        type: 'message.updated',
        properties: { info: { sessionID: 'collector-session', finish: 'stop', ...info } },
    });
    const delta = (messageID, partID, text, extra = {}) => ({
        type: 'message.part.delta',
        properties: { sessionID: 'collector-session', messageID, partID, field: 'text', delta: text, ...extra },
    });

    test('quarantines an answer delta until exact parent metadata, then releases it once', async () => {
        const deltas = [];
        const client = {
            event: {
                subscribe: async () => ({
                    stream: (async function* () {
                        yield delta('assistant-current', 'answer-part', 'Answer');
                        expect(deltas).toEqual([]);
                        yield stopMessage({ id: 'assistant-current', role: 'assistant', parentID: currentUserID });
                        expect(deltas).toEqual(['Answer']);
                    })(),
                }),
            },
        };
        const result = await createCollector({ client, logDebug: () => {} }).collectFromEvents(
            'collector-session', 1000, (text) => deltas.push(text), null, null, undefined, currentUserID,
        );

        expect(result).toMatchObject({ content: 'Answer', finish: 'stop' });
        expect(result.assistantMessageId).toBe('assistant-current');
        expect(deltas).toEqual(['Answer']);
    });

    test('also quarantines legacy message.part.updated deltas until parent confirmation', async () => {
        const deltas = [];
        const client = {
            event: {
                subscribe: async () => ({
                    stream: (async function* () {
                        yield {
                            type: 'message.part.updated',
                            properties: {
                                part: { id: 'legacy-answer-part', messageID: 'assistant-current', type: 'text', sessionID: 'collector-session' },
                                delta: 'Legacy answer',
                            },
                        };
                        expect(deltas).toEqual([]);
                        yield stopMessage({ id: 'assistant-current', role: 'assistant', parentID: currentUserID });
                    })(),
                }),
            },
        };
        const result = await createCollector({ client, logDebug: () => {} }).collectFromEvents(
            'collector-session', 1000, (text) => deltas.push(text), null, null, undefined, currentUserID,
        );

        expect(result.content).toBe('Legacy answer');
        expect(deltas).toEqual(['Legacy answer']);
    });

    test('does not leak a part-parent-matched delta when message parent later mismatches', async () => {
        const deltas = [];
        const result = await collect([
            {
                type: 'message.part.updated',
                properties: {
                    part: {
                        id: 'contradictory-part',
                        messageID: 'assistant-current',
                        parentID: currentUserID,
                        type: 'text',
                        sessionID: 'collector-session',
                    },
                    delta: 'Must not leak',
                },
            },
            stopMessage({ id: 'assistant-current', role: 'assistant', parentID: 'previous-user' }),
        ], (text) => deltas.push(text));

        expect(result.content).toBe('');
        expect(result.finish).toBeUndefined();
        expect(result.noData).toBe(true);
        expect(deltas).toEqual([]);
    });

    test.each(['message.part.updated', 'message.part.delta'])(
        'rejects explicit mismatched part parent on %s despite a confirmed message parent',
        async (eventType) => {
            const deltas = [];
            const mismatchedPart = eventType === 'message.part.updated'
                ? {
                    type: eventType,
                    properties: {
                        part: {
                            id: 'wrong-parent-part',
                            messageID: 'assistant-current',
                            parentID: 'previous-user',
                            type: 'text',
                            sessionID: 'collector-session',
                        },
                        delta: 'MUST NOT ESCAPE',
                    },
                }
                : {
                    type: eventType,
                    properties: {
                        sessionID: 'collector-session',
                        messageID: 'assistant-current',
                        partID: 'wrong-parent-part',
                        parentID: 'previous-user',
                        field: 'text',
                        delta: 'MUST NOT ESCAPE',
                    },
                };
            const result = await collect([
                {
                    type: 'message.updated',
                    properties: { info: { id: 'assistant-current', role: 'assistant', parentID: currentUserID, sessionID: 'collector-session' } },
                },
                mismatchedPart,
                stopMessage({ id: 'assistant-current', role: 'assistant', parentID: currentUserID }),
            ], (text) => deltas.push(text));

            expect(result.content).toBe('');
            expect(result.content).not.toContain('MUST NOT ESCAPE');
            expect(deltas).toEqual([]);
            expect(result.error).toBeInstanceOf(Error);
            expect(result.error.message).toMatch(/correlation error/i);
        },
    );

    test.each(['message.part.updated', 'message.part.delta'])(
        'fails closed when ownerless %s contradicts the retained confirmed part owner',
        async (eventType) => {
            const conflictingPart = eventType === 'message.part.updated'
                ? {
                    type: eventType,
                    properties: {
                        part: {
                            id: 'retained-owner-part',
                            parentID: 'previous-user',
                            type: 'text',
                            sessionID: 'collector-session',
                        },
                        delta: 'MUST NOT SUCCEED',
                    },
                }
                : {
                    type: eventType,
                    properties: {
                        sessionID: 'collector-session',
                        partID: 'retained-owner-part',
                        parentID: 'previous-user',
                        field: 'text',
                        delta: 'MUST NOT SUCCEED',
                    },
                };
            const result = await collect([
                {
                    type: 'message.updated',
                    properties: {
                        info: {
                            id: 'assistant-current',
                            role: 'assistant',
                            parentID: currentUserID,
                            sessionID: 'collector-session',
                            parts: [{ id: 'retained-owner-part', type: 'text', text: 'STALE RAW CONTENT' }],
                        },
                    },
                },
                conflictingPart,
                stopMessage({ id: 'assistant-current', role: 'assistant', parentID: currentUserID }),
            ]);

            expect(result.error).toBeInstanceOf(Error);
            expect(result.error.message).toMatch(/correlation error/i);
            expect(result.content).toBe('');
            expect(result.content).not.toContain('STALE RAW CONTENT');
            expect(result.finish).toBeUndefined();
            expect(result.cut).toBeUndefined();
        },
    );

    test('fails closed when a confirmed message parent explicitly changes', async () => {
        const result = await collect([
            {
                type: 'message.updated',
                properties: { info: { id: 'assistant-current', role: 'assistant', parentID: currentUserID, sessionID: 'collector-session' } },
            },
            stopMessage({ id: 'assistant-current', role: 'assistant', parentID: 'previous-user' }),
        ]);

        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toMatch(/parent changed/i);
        expect(result.finish).toBeUndefined();
        expect(result.cut).toBeUndefined();
    });

    test('keeps the confirmed message parent when a later sparse update omits it', async () => {
        const result = await collect([
            {
                type: 'message.updated',
                properties: { info: { id: 'assistant-current', role: 'assistant', parentID: currentUserID, sessionID: 'collector-session' } },
            },
            stopMessage({ id: 'assistant-current', role: 'assistant' }),
        ]);

        expect(result.error).toBeUndefined();
        expect(result.finish).toBe('stop');
        expect(result.cut).toBeUndefined();
    });

    test('a quarantined text delta does not clear the first-delta timeout', async () => {
        const deltas = [];
        const client = {
            event: {
                subscribe: async () => ({
                    stream: (async function* () {
                        yield {
                            type: 'message.part.updated',
                            properties: {
                                part: { id: 'unverified-text-part', messageID: 'assistant-current', type: 'text', sessionID: 'collector-session' },
                                delta: 'Unverified answer',
                            },
                        };
                        await new Promise((resolve) => setTimeout(resolve, 50));
                        yield stopMessage({ id: 'assistant-current', role: 'assistant', parentID: currentUserID });
                    })(),
                }),
            },
        };
        const result = await createCollector({ client, logDebug: () => {} }).collectFromEvents(
            'collector-session', 500, (text) => deltas.push(text), 20, null, undefined, currentUserID,
        );

        expect(result).toMatchObject({ content: '', noData: true });
        expect(deltas).toEqual([]);
    });

    test('releasing a verified delta clears the first-delta timeout', async () => {
        const deltas = [];
        const client = {
            event: {
                subscribe: async () => ({
                    stream: (async function* () {
                        yield {
                            type: 'message.part.updated',
                            properties: {
                                part: { id: 'verified-text-part', messageID: 'assistant-current', type: 'text', sessionID: 'collector-session' },
                                delta: 'Verified answer',
                            },
                        };
                        yield {
                            type: 'message.updated',
                            properties: {
                                info: { id: 'assistant-current', role: 'assistant', parentID: currentUserID, sessionID: 'collector-session' },
                            },
                        };
                        await new Promise((resolve) => setTimeout(resolve, 50));
                        yield stopMessage({ id: 'assistant-current', role: 'assistant', parentID: currentUserID });
                    })(),
                }),
            },
        };
        const result = await createCollector({ client, logDebug: () => {} }).collectFromEvents(
            'collector-session', 500, (text) => deltas.push(text), 20, null, undefined, currentUserID,
        );

        expect(result).toMatchObject({ content: 'Verified answer', finish: 'stop' });
        expect(deltas).toEqual(['Verified answer']);
    });

    test('an unverified tool part cannot block a valid current-turn terminal', async () => {
        const result = await collect([
            {
                type: 'message.part.updated',
                properties: {
                    part: {
                        id: 'prior-tool-call',
                        messageID: 'assistant-prior',
                        type: 'tool',
                        tool: 'bash',
                        state: { status: 'running' },
                        sessionID: 'collector-session',
                    },
                },
            },
            stopMessage({ id: 'assistant-current', role: 'assistant', parentID: currentUserID }),
        ]);

        expect(result.finish).toBe('stop');
        expect(result.cut).toBeUndefined();
    });

    test('a quarantined tool becomes active only after exact parent confirmation', async () => {
        let continuedPastFirstStop = false;
        const client = {
            event: {
                subscribe: async () => ({
                    stream: (async function* () {
                        yield {
                            type: 'message.part.updated',
                            properties: {
                                part: {
                                    id: 'current-tool-call',
                                    messageID: 'assistant-current',
                                    type: 'tool',
                                    tool: 'bash',
                                    state: { status: 'running' },
                                    sessionID: 'collector-session',
                                },
                            },
                        };
                        yield stopMessage({ id: 'assistant-current', role: 'assistant', parentID: currentUserID });
                        continuedPastFirstStop = true;
                        yield {
                            type: 'message.part.updated',
                            properties: {
                                part: {
                                    id: 'current-tool-call',
                                    messageID: 'assistant-current',
                                    parentID: currentUserID,
                                    type: 'tool',
                                    tool: 'bash',
                                    state: { status: 'completed' },
                                    sessionID: 'collector-session',
                                },
                            },
                        };
                        yield stopMessage({ id: 'assistant-current', role: 'assistant', parentID: currentUserID });
                    })(),
                }),
            },
        };
        const result = await createCollector({ client, logDebug: () => {} }).collectFromEvents(
            'collector-session', 1000, null, null, null, undefined, currentUserID,
        );

        expect(continuedPastFirstStop).toBe(true);
        expect(result.finish).toBe('stop');
        expect(result.cut).toBeUndefined();
    });

    test('latest quarantined tool state wins before matching message finish', async () => {
        const client = {
            event: {
                subscribe: async () => ({
                    stream: (async function* () {
                        yield {
                            type: 'message.part.updated',
                            properties: {
                                part: {
                                    id: 'latest-tool-state',
                                    messageID: 'assistant-current',
                                    type: 'tool',
                                    tool: 'bash',
                                    state: { status: 'running' },
                                    sessionID: 'collector-session',
                                },
                            },
                        };
                        yield {
                            type: 'message.part.updated',
                            properties: {
                                part: {
                                    id: 'latest-tool-state',
                                    messageID: 'assistant-current',
                                    parentID: currentUserID,
                                    type: 'tool',
                                    tool: 'bash',
                                    state: { status: 'completed' },
                                    sessionID: 'collector-session',
                                },
                            },
                        };
                        yield stopMessage({ id: 'assistant-current', role: 'assistant', parentID: currentUserID });
                        await new Promise(() => {});
                    })(),
                }),
            },
        };
        const result = await createCollector({ client, logDebug: () => {} }).collectFromEvents(
            'collector-session', 150, null, null, 10, undefined, currentUserID,
        );

        expect(result.finish).toBe('stop');
        expect(result.cut).toBeUndefined();
        expect(result.idleTimeout).toBeUndefined();
    });

    test('non-continuation tool lifecycle still waits for its terminal state', async () => {
        const client = {
            event: {
                subscribe: async () => ({
                    stream: (async function* () {
                        yield {
                            type: 'message.part.updated',
                            properties: {
                                part: {
                                    id: 'ordinary-tool-state',
                                    type: 'tool',
                                    tool: 'bash',
                                    state: { status: 'running' },
                                    sessionID: 'collector-session',
                                },
                            },
                        };
                        yield stopMessage({ id: 'ordinary-assistant', role: 'assistant' });
                        yield {
                            type: 'message.part.updated',
                            properties: {
                                part: {
                                    id: 'ordinary-tool-state',
                                    type: 'tool',
                                    tool: 'bash',
                                    state: { status: 'completed' },
                                    sessionID: 'collector-session',
                                },
                            },
                        };
                        yield stopMessage({ id: 'ordinary-assistant', role: 'assistant' });
                    })(),
                }),
            },
        };
        const result = await createCollector({ client, logDebug: () => {} }).collectFromEvents(
            'collector-session', 1000,
        );

        expect(result.finish).toBe('stop');
        expect(result.cut).toBeUndefined();
    });

    test.each([
        ['missing', {}],
        ['mismatched', { parentID: 'previous-user' }],
    ])('does not expose or finish an unknown-role message with %s parent metadata', async (_label, parent) => {
        const deltas = [];
        const result = await collect([
            delta('developer-message', 'developer-part', 'UNVERIFIED'),
            stopMessage({ id: 'developer-message', role: 'developer', ...parent }),
        ], (text) => deltas.push(text));

        expect(result.content).toBe('');
        expect(result.finish).toBeUndefined();
        expect(result.noData).toBe(true);
        expect(deltas).toEqual([]);
    });

    test('accepts an unknown role only when its parent exactly matches the expected turn', async () => {
        const deltas = [];
        const result = await collect([
            delta('developer-message', 'developer-part', 'Developer answer'),
            stopMessage({ id: 'developer-message', role: 'developer', parentID: currentUserID }),
        ], (text) => deltas.push(text));

        expect(result).toMatchObject({ content: 'Developer answer', finish: 'stop' });
        expect(deltas).toEqual(['Developer answer']);
    });

    test('filters a legacy ID-less part delta after a stale snapshot classified its owner', async () => {
        const deltas = [];
        const result = await collect([
            stopMessage({
                id: 'assistant-old',
                role: 'assistant',
                parentID: 'previous-user',
                parts: [{ id: 'stale-shared-part', type: 'text', text: 'STALE SNAPSHOT' }],
            }),
            {
                type: 'message.part.updated',
                properties: {
                    part: { id: 'stale-shared-part', type: 'text', sessionID: 'collector-session' },
                    delta: 'STALE LEGACY DELTA',
                },
            },
            {
                type: 'message.part.updated',
                properties: {
                    part: { id: 'current-part', messageID: 'assistant-current', type: 'text', sessionID: 'collector-session' },
                    delta: 'Current answer',
                },
            },
            stopMessage({ id: 'assistant-current', role: 'assistant', parentID: currentUserID }),
        ], (text) => deltas.push(text));

        expect(result.content).toBe('Current answer');
        expect(result.content).not.toContain('STALE');
        expect(deltas).toEqual(['Current answer']);
    });

    test('an explicitly different message owner takes precedence over a reused user part ID', async () => {
        const result = await collect([
            {
                type: 'message.updated',
                properties: {
                    info: {
                        id: 'user-message', role: 'user', sessionID: 'collector-session',
                        parts: [{ id: 'reused-part', type: 'text', text: 'SECRET USER TEXT' }],
                    },
                },
            },
            {
                type: 'message.part.updated',
                properties: {
                    part: { id: 'reused-part', messageID: 'assistant-message', type: 'text', sessionID: 'collector-session' },
                    delta: 'Valid answer',
                },
            },
            stopMessage({ id: 'assistant-message', role: 'assistant', parentID: currentUserID }),
        ]);

        expect(result.content).toBe('Valid answer');
        expect(result.content).not.toContain('SECRET');
    });

    test('ownerless text and tool events are ignored when a part ID has multiple explicit owners', async () => {
        const deltas = [];
        const result = await collect([
            {
                type: 'message.updated',
                properties: {
                    info: {
                        id: 'user-message', role: 'user', sessionID: 'collector-session',
                        parts: [{ id: 'reused-part', type: 'text', text: 'SECRET USER TEXT' }],
                    },
                },
            },
            {
                type: 'message.updated',
                properties: {
                    info: {
                        id: 'assistant-message', role: 'assistant', parentID: currentUserID,
                        sessionID: 'collector-session', parts: [{ id: 'reused-part', type: 'text' }],
                    },
                },
            },
            {
                type: 'message.part.updated',
                properties: {
                    part: {
                        id: 'reused-part', messageID: 'assistant-message', type: 'text',
                        sessionID: 'collector-session',
                    },
                    delta: 'Verified answer',
                },
            },
            {
                type: 'message.part.updated',
                properties: {
                    part: {
                        id: 'reused-part', type: 'tool', tool: 'bash',
                        state: { status: 'running' }, sessionID: 'collector-session',
                    },
                },
            },
            {
                type: 'message.part.delta',
                properties: {
                    sessionID: 'collector-session', partID: 'reused-part',
                    field: 'text', delta: 'STALE OWNERLESS TEXT',
                },
            },
            stopMessage({
                id: 'assistant-message', role: 'assistant', parentID: currentUserID,
                parts: [{ id: 'reused-part', type: 'text', text: 'Verified answer' }],
            }),
        ], (text) => deltas.push(text));

        expect(result.content).toBe('Verified answer');
        expect(result.content).not.toContain('SECRET');
        expect(result.content).not.toContain('STALE');
        expect(result.finish).toBe('stop');
        expect(result.cut).toBeUndefined();
        expect(deltas).toEqual(['Verified answer']);
    });

    test.each([
        ['out-of-turn', { parentID: 'previous-user' }],
        ['timestamp-stale', { parentID: currentUserID, time: { created: Date.now() - 60_000 } }],
    ])('does not attribute ownerless reused part events after a %s snapshot', async (_label, staleInfo) => {
        const deltas = [];
        const sharedPartID = 'reused-stale-part';
        const uniquePartID = 'unique-current-part';
        const result = await collect([
            {
                type: 'message.updated',
                properties: {
                    info: {
                        id: 'assistant-stale',
                        role: 'assistant',
                        sessionID: 'collector-session',
                        ...staleInfo,
                        parts: [{ id: sharedPartID, type: 'text', text: 'STALE SNAPSHOT' }],
                    },
                },
            },
            {
                type: 'message.updated',
                properties: {
                    info: {
                        id: 'assistant-current',
                        role: 'assistant',
                        parentID: currentUserID,
                        sessionID: 'collector-session',
                        parts: [
                            { id: sharedPartID, type: 'text' },
                            { id: uniquePartID, type: 'text' },
                        ],
                    },
                },
            },
            {
                type: 'message.part.updated',
                properties: {
                    part: {
                        id: sharedPartID,
                        messageID: 'assistant-current',
                        type: 'text',
                        sessionID: 'collector-session',
                    },
                    delta: 'Current explicit answer',
                },
            },
            {
                type: 'message.part.delta',
                properties: {
                    sessionID: 'collector-session',
                    partID: uniquePartID,
                    field: 'text',
                    delta: ' plus unique ownerless text',
                },
            },
            {
                type: 'message.part.delta',
                properties: {
                    sessionID: 'collector-session',
                    partID: sharedPartID,
                    field: 'text',
                    delta: 'LEAKED OWNERLESS TEXT',
                },
            },
            {
                type: 'message.part.updated',
                properties: {
                    part: {
                        id: sharedPartID,
                        type: 'tool',
                        tool: 'bash',
                        state: { status: 'running' },
                        sessionID: 'collector-session',
                    },
                },
            },
            stopMessage({ id: 'assistant-current', role: 'assistant', parentID: currentUserID }),
        ], (text) => deltas.push(text));

        expect(result.content).toBe('Current explicit answer plus unique ownerless text');
        expect(result.content).not.toContain('STALE');
        expect(result.content).not.toContain('LEAKED');
        expect(result.finish).toBe('stop');
        expect(result.cut).toBeUndefined();
        expect(deltas).toEqual(['Current explicit answer', ' plus unique ownerless text']);
    });
});

describe('collector polling finish classification', () => {
    const run = (snapshots, timeoutMs = 1000, expectedCurrentUserMessageId) => {
        let call = 0;
        const client = {
            session: {
                messages: async () => {
                    const next = snapshots[Math.min(call, snapshots.length - 1)];
                    call += 1;
                    return next;
                }
            }
        };
        return createCollector({ client, logDebug: () => {} }).pollForAssistantResponse(
            'collector-session', timeoutMs, 1, undefined, expectedCurrentUserMessageId,
        );
    };
    const assistant = (info, text) => [{ info: { role: 'assistant', ...info }, parts: [{ type: 'text', text }] }];
    const priorTurnAndCurrentUser = (currentMessageID) => [
        { info: { id: 'assistant-old', role: 'assistant', parentID: 'msg-old-user', finish: 'stop' }, parts: [{ type: 'text', text: 'prior answer' }] },
        { info: { id: currentMessageID, role: 'user' }, parts: [{ id: 'user-part', type: 'text', text: 'current prompt' }] },
    ];

    test.each([['tool'], ['tool-calls']])(
        'does not finish on time.completed while a turn awaits %s',
        async (finish) => {
            const result = await run([
                assistant({ finish, time: { completed: 1 } }, 'Calling a tool.'),
                assistant({ finish: 'stop', time: { completed: 2 } }, 'Done: 42.')
            ]);
            expect(result.content).toBe('Done: 42.');
            expect(result.complete).toBe(true);
        }
    );

    test('still finishes on time.completed for a terminal turn', async () => {
        const result = await run([assistant({ time: { completed: 1 } }, 'Answer without a finish reason.')]);
        expect(result.content).toBe('Answer without a finish reason.');
        expect(result.complete).toBe(true);
    });

    test('returns a timeout partial with partial: true', async () => {
        const result = await run([assistant({ finish: 'tool' }, 'Still working')], 100);
        expect(result).toMatchObject({ content: 'Still working', partial: true });
        expect(result.complete).toBeUndefined();
    });

    test('ignores a prior completed assistant turn until the current continuation assistant appears', async () => {
        const currentMessageID = 'msg-current-turn';
        let call = 0;
        const snapshots = [
            priorTurnAndCurrentUser(currentMessageID),
            [
                ...priorTurnAndCurrentUser(currentMessageID),
                { info: { id: 'assistant-current', role: 'assistant', parentID: currentMessageID, finish: 'stop' }, parts: [{ type: 'text', text: 'current answer' }] },
            ],
        ];
        const client = {
            session: {
                messages: async () => snapshots[Math.min(call++, snapshots.length - 1)],
            },
        };
        const result = await createCollector({ client, logDebug: () => {} }).pollForAssistantResponse(
            'collector-session', 1000, 1, undefined, currentMessageID,
        );
        expect(result.content).toBe('current answer');
        expect(result.assistantMessageId).toBe('assistant-current');
        expect(call).toBeGreaterThan(1);
    });

    test('does not accept a prior completed assistant when the current assistant is absent', async () => {
        await expect(run([priorTurnAndCurrentUser('msg-current-turn')], 30, 'msg-current-turn'))
            .rejects.toThrow('Request timeout after 30ms');
    });

    test('does not accept a timestamp-less completed assistant without a positively matching parent', async () => {
        const currentMessageID = 'msg-current-turn';
        await expect(run([
            [
                { info: { id: 'assistant-no-parent', role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'stale answer' }] },
                { info: { id: currentMessageID, role: 'user' }, parts: [] },
            ],
        ], 30, currentMessageID)).rejects.toThrow('Request timeout after 30ms');
    });

    test.each(['pending', 'running'])('does not finish while a tool part is %s', async (status) => {
        let call = 0;
        const client = {
            session: {
                messages: async () => {
                    call += 1;
                    const finish = call === 1 ? 'stop' : 'stop';
                    return [{
                        info: { role: 'assistant', finish, time: { completed: call } },
                        parts: [
                            { type: 'text', text: call === 1 ? 'working' : 'done' },
                            { type: 'tool', id: 'tool-1', state: { status: call === 1 ? status : 'completed' } }
                        ]
                    }];
                }
            }
        };
        const result = await createCollector({ client, logDebug: () => {} }).pollForAssistantResponse('collector-session', 1000, 1);
        expect(result.content).toBe('done');
        expect(call).toBeGreaterThan(1);
    });

    test('bounds a hanging session.messages request', async () => {
        const client = { session: { messages: () => new Promise(() => {}) } };
        await expect(
            createCollector({ client, logDebug: () => {} }).pollForAssistantResponse('collector-session', 40, 1)
        ).rejects.toThrow('Request timeout after');
    });
});
