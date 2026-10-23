import request from 'supertest';
import { jest } from '@jest/globals';

const sdkMocks = {
    configProviders: jest.fn(async () => ({
        data: {
            providers: [{
                id: 'opencode',
                models: {
                    'kimi-k2.5': { name: 'Kimi k2.5' }
                }
            }]
        }
    })),
    configUpdate: jest.fn(async () => ({})),
    toolIds: jest.fn(async () => ({ data: ['web_fetch', 'filesystem', 'bash'] })),
    sessionCreate: jest.fn(async () => ({ data: { id: 'default-session' } })),
    sessionPrompt: jest.fn(async () => ({ data: { parts: [] } })),
    sessionMessages: jest.fn(async () => ([
        { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Default response' }] }
    ])),
    sessionDelete: jest.fn(async () => ({})),
    eventSubscribe: jest.fn(async () => ({
        stream: (async function* () {
            yield { type: 'message.updated', properties: { info: { sessionID: 'default-session', finish: 'stop' } } };
        })()
    }))
};

const httpMocks = {
    get: jest.fn((_url, _options, callback) => {
        const cb = typeof _options === 'function' ? _options : callback;
        cb({ statusCode: 200, headers: {}, on: jest.fn() });
        return { on: jest.fn(), destroy: jest.fn(), setTimeout: jest.fn() };
    })
};

jest.unstable_mockModule('http', () => ({
    default: {
        get: httpMocks.get
    }
}));

jest.unstable_mockModule('https', () => ({
    default: {
        get: jest.fn((_url, _options, callback) => {
            const cb = typeof _options === 'function' ? _options : callback;
            cb({ statusCode: 200, headers: {}, on: jest.fn() });
            return { on: jest.fn(), destroy: jest.fn() };
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

const { isTransientUpstreamError } = await import('../src/errors/upstream.js');
const { createApp } = await import('../src/proxy.js');
const { lock, notifyBackendReconnect, clearBackendReconnectListeners } = await import('../src/backend/manager.js');

function freeUsageError() {
    return {
        name: 'APIError',
        data: {
            message: 'Rate limit exceeded. Please try again later.',
            statusCode: 429,
            isRetryable: true,
            responseBody: '{"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded."}}',
        },
    };
}

function baseConfig(overrides = {}) {
    return {
        PORT: 10000,
        API_KEY: '',
        OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
        REQUEST_TIMEOUT_MS: 3000,
        RETRY_MAX_RETRIES: 2,
        DISABLE_TOOLS: true,
        ...overrides
    };
}

describe('isTransientUpstreamError', () => {
    test('matches { data: { statusCode: 503 } }', () => {
        expect(isTransientUpstreamError({ data: { statusCode: 503 } })).toBe(true);
    });

    test('matches "Endpoint is unavailable."', () => {
        expect(isTransientUpstreamError({ message: 'Endpoint is unavailable.' })).toBe(true);
        expect(isTransientUpstreamError({ data: { message: 'Endpoint is unavailable.' } })).toBe(true);
        expect(isTransientUpstreamError(new Error('Endpoint is unavailable.'))).toBe(true);
        expect(isTransientUpstreamError({ data: { statusCode: 503, message: 'Endpoint is unavailable.' } })).toBe(true);
    });

    test('does not match non-transient errors', () => {
        expect(isTransientUpstreamError({ data: { statusCode: 400 } })).toBe(false);
        expect(isTransientUpstreamError({ message: 'invalid request parameters' })).toBe(false);
        expect(isTransientUpstreamError({ message: 'context length exceeded', data: { statusCode: 503 } })).toBe(false);
    });

    test('rejects HTTP 400, 403, 404 even if message has "endpoint is unavailable", but accepts 503 and exact "endpoint is unavailable"', () => {
        expect(isTransientUpstreamError({ statusCode: 400, message: 'Endpoint is unavailable.' })).toBe(false);
        expect(isTransientUpstreamError({ data: { statusCode: 400, message: 'Endpoint is unavailable.' } })).toBe(false);
        expect(isTransientUpstreamError({ statusCode: 403, message: 'Endpoint is unavailable.' })).toBe(false);
        expect(isTransientUpstreamError({ data: { statusCode: 403 }, message: 'Endpoint is unavailable.' })).toBe(false);
        expect(isTransientUpstreamError({ statusCode: 404, message: 'Endpoint is unavailable.' })).toBe(false);
        expect(isTransientUpstreamError({ data: { statusCode: 404 }, message: 'Endpoint is unavailable.' })).toBe(false);
        expect(isTransientUpstreamError(new Error('400: Endpoint is unavailable.'))).toBe(false);
        expect(isTransientUpstreamError(new Error('404: Endpoint is unavailable.'))).toBe(false);
        expect(isTransientUpstreamError({ data: { statusCode: 503 } })).toBe(true);
        expect(isTransientUpstreamError({ statusCode: 503 })).toBe(true);
        expect(isTransientUpstreamError({ message: 'Endpoint is unavailable.' })).toBe(true);
        expect(isTransientUpstreamError(new Error('Endpoint is unavailable.'))).toBe(true);
        expect(isTransientUpstreamError({ message: 'Some other error: Endpoint is unavailable. Check endpoint' })).toBe(false);
    });
});

describe('Streaming Retries on 503 Transient Error', () => {
    let app;
    let ctx;

    beforeEach(() => {
        jest.clearAllMocks();
        const created = createApp(baseConfig({}));
        app = created.app;
        ctx = created.ctx;
    });

    test.each([
        ['Chat non-stream', '/v1/chat/completions', { model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'look up' }], tools: [{ type: 'function', function: { name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: {} } } }], tool_choice: 'required' }],
        ['Chat stream', '/v1/chat/completions', { model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'look up' }], tools: [{ type: 'function', function: { name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: {} } } }], tool_choice: 'required', stream: true }],
        ['Responses non-stream', '/v1/responses', { model: 'opencode/kimi-k2.5', input: 'look up', tools: [{ type: 'function', name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: {} } }], tool_choice: 'required' }],
        ['Responses stream', '/v1/responses', { model: 'opencode/kimi-k2.5', input: 'look up', tools: [{ type: 'function', name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: {} } }], tool_choice: 'required', stream: true }],
    ])('%s allows the required-tool fallback after an empty completed poll, then fails closed', async (label, path, body) => {
        sdkMocks.sessionPrompt.mockResolvedValue({ data: { parts: [] } });
        sdkMocks.sessionMessages.mockResolvedValue([
            { info: { id: 'empty-assistant', role: 'assistant', finish: 'stop' }, parts: [] },
        ]);
        if (body.stream) {
            sdkMocks.eventSubscribe.mockImplementationOnce(async () => ({
                stream: (async function* () {
                    yield {
                        type: 'message.updated',
                        properties: {
                            info: { id: 'empty-assistant', role: 'assistant', sessionID: 'default-session', finish: 'stop', parts: [] },
                        },
                    };
                })(),
            }));
        }

        const response = await request(app).post(path).send(body);
        const output = response.text || JSON.stringify(response.body);

        expect(output).toContain('external_tool_choice_required');
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(2);
        expect(output).not.toContain('response.completed');
        expect(response.body?.status).not.toBe('completed');
    });

    test.each([
        ['Responses non-stream continuation', '/v1/responses', { model: 'opencode/kimi-k2.5', input: 'second turn', previous_response_id: 'stored-response', stream: false }],
        ['Responses stream continuation', '/v1/responses', { model: 'opencode/kimi-k2.5', input: 'second turn', previous_response_id: 'stored-response', stream: true }],
        ['Interactions non-stream continuation', '/v1beta/interactions', { model: 'opencode/kimi-k2.5', input: 'second turn', previous_interaction_id: 'stored-interaction', stream: false }],
        ['Interactions stream continuation', '/v1beta/interactions', { model: 'opencode/kimi-k2.5', input: 'second turn', previous_interaction_id: 'stored-interaction', stream: true }],
    ])('%s polls past the previous assistant until the current message parent is complete', async (_label, path, body) => {
        const sessionId = 'continuation-route-session';
        const stateId = body.previous_response_id ?? body.previous_interaction_id;
        ctx.storeResponseState(stateId, sessionId, 'opencode/kimi-k2.5');
        let currentMessageID = null;
        let pollCount = 0;
        sdkMocks.sessionPrompt.mockImplementation(async (params) => {
            currentMessageID = params.body.messageID;
            return { data: { parts: [] } };
        });
        sdkMocks.sessionMessages.mockImplementation(async () => {
            pollCount += 1;
            const messages = [
                {
                    info: { id: 'assistant-prior', role: 'assistant', parentID: 'msg-prior-user', finish: 'stop' },
                    parts: [{ type: 'text', text: 'prior turn answer' }],
                },
                {
                    info: { id: currentMessageID, role: 'user' },
                    parts: [{ id: 'current-user-part', type: 'text', text: 'second turn' }],
                },
            ];
            if (pollCount > 1) {
                messages.push({
                    info: { id: 'assistant-current', role: 'assistant', parentID: currentMessageID, finish: 'stop' },
                    parts: [{ type: 'text', text: 'current turn answer' }],
                });
            }
            return messages;
        });

        const response = await request(app).post(path).send(body);
        const output = response.text || JSON.stringify(response.body);
        expect(response.status).toBe(200);
        expect(output).toContain('current turn answer');
        expect(output).not.toContain('prior turn answer');
        expect(pollCount).toBeGreaterThan(1);
        expect(output).not.toMatch(/"type"\s*:\s*"(?:response\.failed|error)"/);
        if (body.stream) {
            if (path === '/v1/responses') {
                const frames = response.text
                    .split('\n')
                    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
                    .map((line) => JSON.parse(line.slice(6)));
                expect(frames.at(-1)?.type).toBe('response.completed');
                expect(response.text).toContain('data: [DONE]');
                expect(response.text).not.toContain('response.failed');
            } else {
                expect(response.text).toContain('"type":"interaction.completed"');
                expect(response.text).not.toContain('"type":"error"');
                expect(response.text).not.toContain('[DONE]');
            }
        } else {
            expect(response.body.status).toBe('completed');
            expect(response.body.error == null).toBe(true);
        }
    });

    test.each([
        ['Responses non-stream continuation', '/v1/responses', { model: 'opencode/kimi-k2.5', input: 'second turn', previous_response_id: 'empty-response-parent', stream: false }],
        ['Interactions non-stream continuation', '/v1beta/interactions', { model: 'opencode/kimi-k2.5', input: 'second turn', previous_interaction_id: 'empty-interaction-parent', stream: false }],
    ])('%s fails closed on an empty completed assistant poll snapshot', async (_label, path, body) => {
        const sessionId = 'empty-continuation-session';
        const stateId = body.previous_response_id ?? body.previous_interaction_id;
        ctx.storeResponseState(stateId, sessionId, 'opencode/kimi-k2.5');
        let currentMessageID;
        sdkMocks.sessionPrompt.mockImplementation(async (params) => {
            currentMessageID = params.body.messageID;
            return { data: { parts: [] } };
        });
        sdkMocks.sessionMessages.mockImplementation(async () => ([
            { info: { id: currentMessageID, role: 'user' }, parts: [] },
            {
                info: { id: 'assistant-empty', role: 'assistant', parentID: currentMessageID, finish: 'stop' },
                parts: [],
            },
        ]));

        const response = await request(app).post(path).send(body);

        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.body.status).not.toBe('completed');
        expect(response.body).not.toHaveProperty('output_text');
        expect(JSON.stringify(response.body)).toContain('Polling returned empty response');
    });

    test('Responses non-stream fails closed on an ordinary empty completed poll snapshot', async () => {
        sdkMocks.sessionPrompt.mockResolvedValue({ data: { parts: [] } });
        sdkMocks.sessionMessages.mockResolvedValue([
            { info: { id: 'ordinary-empty-assistant', role: 'assistant', finish: 'stop' }, parts: [] },
        ]);

        const response = await request(app)
            .post('/v1/responses')
            .send({ model: 'opencode/kimi-k2.5', input: 'ordinary request', stream: false });

        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.body.status).not.toBe('completed');
        expect(response.body).not.toHaveProperty('output_text');
        expect(JSON.stringify(response.body)).toContain('Polling returned empty response');
    });

    test('Responses streaming continuation releases a pre-metadata text delta exactly once', async () => {
        const sessionId = 'pre-metadata-stream-continuation-session';
        ctx.storeResponseState('pre-metadata-stream-parent', sessionId, 'opencode/kimi-k2.5');
        let currentMessageID;
        sdkMocks.sessionPrompt.mockImplementation(async (params) => {
            currentMessageID = params.body.messageID;
            return { data: { parts: [] } };
        });
        sdkMocks.eventSubscribe.mockImplementation(async () => ({
            stream: (async function* () {
                yield {
                    type: 'message.part.delta',
                    properties: {
                        sessionID: sessionId,
                        messageID: 'assistant-current',
                        partID: 'answer-part',
                        field: 'text',
                        delta: 'Continuation answer',
                    },
                };
                yield {
                    type: 'message.updated',
                    properties: {
                        info: {
                            id: 'assistant-current',
                            role: 'assistant',
                            parentID: currentMessageID,
                            finish: 'stop',
                            sessionID: sessionId,
                        },
                    },
                };
            })(),
        }));

        const response = await request(app)
            .post('/v1/responses')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'current turn',
                stream: true,
                previous_response_id: 'pre-metadata-stream-parent',
            });

        const frames = response.text
            .split('\n')
            .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
            .map((line) => JSON.parse(line.slice(6)));
        const textDeltas = frames
            .filter((frame) => frame.type === 'response.output_text.delta')
            .map((frame) => frame.delta);

        expect(response.status).toBe(200);
        expect(textDeltas).toEqual(['Continuation answer']);
        expect(frames.at(-1)?.type).toBe('response.completed');
        expect(response.text).toContain('data: [DONE]');
        expect(response.text).not.toContain('response.failed');
    });

    test('Responses streaming continuation fails closed on a mismatched part parent after message confirmation', async () => {
        const sessionId = 'part-parent-mismatch-session';
        ctx.storeResponseState('part-parent-mismatch-parent', sessionId, 'opencode/kimi-k2.5');
        let currentMessageID;
        sdkMocks.sessionPrompt.mockImplementation(async (params) => {
            currentMessageID = params.body.messageID;
            return { data: { parts: [] } };
        });
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => ({
            stream: (async function* () {
                yield {
                    type: 'message.updated',
                    properties: {
                        info: {
                            id: 'assistant-correlated',
                            role: 'assistant',
                            parentID: currentMessageID,
                            sessionID: sessionId,
                        },
                    },
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: {
                            id: 'mismatched-part',
                            messageID: 'assistant-correlated',
                            parentID: 'another-user-message',
                            type: 'text',
                            sessionID: sessionId,
                        },
                        delta: 'uncorrelated text',
                    },
                };
            })(),
        }));

        const response = await request(app).post('/v1/responses').send({
            model: 'opencode/kimi-k2.5',
            input: 'continuation',
            stream: true,
            previous_response_id: 'part-parent-mismatch-parent',
        });

        expect(response.text).toContain('response.failed');
        expect(response.text).toContain('Continuation correlation error');
        expect(response.text).not.toContain('response.completed');
        expect(response.text).not.toContain('uncorrelated text');
    });

    test('Responses streaming continuation fails closed when a confirmed message parent explicitly changes', async () => {
        const sessionId = 'message-parent-mismatch-session';
        ctx.storeResponseState('message-parent-mismatch-parent', sessionId, 'opencode/kimi-k2.5');
        let currentMessageID;
        sdkMocks.sessionPrompt.mockImplementation(async (params) => {
            currentMessageID = params.body.messageID;
            return { data: { parts: [] } };
        });
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => ({
            stream: (async function* () {
                yield {
                    type: 'message.updated',
                    properties: {
                        info: {
                            id: 'assistant-correlated',
                            role: 'assistant',
                            parentID: currentMessageID,
                            sessionID: sessionId,
                        },
                    },
                };
                yield {
                    type: 'message.updated',
                    properties: {
                        info: {
                            id: 'assistant-correlated',
                            role: 'assistant',
                            parentID: 'another-user-message',
                            sessionID: sessionId,
                            finish: 'stop',
                            parts: [{ type: 'text', text: 'uncorrelated text' }],
                        },
                    },
                };
            })(),
        }));

        const response = await request(app).post('/v1/responses').send({
            model: 'opencode/kimi-k2.5',
            input: 'continuation',
            stream: true,
            previous_response_id: 'message-parent-mismatch-parent',
        });

        expect(response.text).toContain('response.failed');
        expect(response.text).toContain('Continuation correlation error');
        expect(response.text).not.toContain('response.completed');
    });

    test('Responses streaming continuation accepts a sparse update that omits its retained parent', async () => {
        const sessionId = 'sparse-parent-update-session';
        ctx.storeResponseState('sparse-parent-update-parent', sessionId, 'opencode/kimi-k2.5');
        let currentMessageID;
        sdkMocks.sessionPrompt.mockImplementation(async (params) => {
            currentMessageID = params.body.messageID;
            return { data: { parts: [] } };
        });
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => ({
            stream: (async function* () {
                yield {
                    type: 'message.updated',
                    properties: {
                        info: {
                            id: 'assistant-sparse',
                            role: 'assistant',
                            parentID: currentMessageID,
                            sessionID: sessionId,
                        },
                    },
                };
                yield {
                    type: 'message.updated',
                    properties: {
                        info: {
                            id: 'assistant-sparse',
                            role: 'assistant',
                            sessionID: sessionId,
                            finish: 'stop',
                            parts: [{ type: 'text', text: 'sparse continuation answer' }],
                        },
                    },
                };
            })(),
        }));

        const response = await request(app).post('/v1/responses').send({
            model: 'opencode/kimi-k2.5',
            input: 'continuation',
            stream: true,
            previous_response_id: 'sparse-parent-update-parent',
        });

        expect(response.text).toContain('response.completed');
        expect(response.text).toContain('sparse continuation answer');
        expect(response.text).not.toContain('response.failed');
    });

    test('Responses streaming continuation does not succeed from a timestamp-less assistant with a mismatched parent', async () => {
        const sessionId = 'stale-stream-continuation-session';
        const created = createApp(baseConfig({ REQUEST_TIMEOUT_MS: 40, RETRY_MAX_RETRIES: 0 }));
        app = created.app;
        ctx = created.ctx;
        ctx.storeResponseState('stale-stream-parent', sessionId, 'opencode/kimi-k2.5');

        sdkMocks.sessionPrompt.mockImplementation(async () => ({ data: { parts: [] } }));
        sdkMocks.eventSubscribe.mockImplementation(async () => ({
            stream: (async function* () {
                // Exercise ordering where deltas precede the assistant metadata
                // that identifies this as a previous turn.
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: {
                            id: 'stale-part',
                            messageID: 'assistant-stale',
                            type: 'text',
                            sessionID: sessionId,
                        },
                        delta: 'STALE ANSWER',
                    },
                };
                yield {
                    type: 'message.updated',
                    properties: {
                        info: {
                            id: 'assistant-stale',
                            role: 'assistant',
                            parentID: 'previous-user-message',
                            finish: 'stop',
                            sessionID: sessionId,
                        },
                    },
                };
            })(),
        }));
        sdkMocks.sessionMessages.mockImplementation(async () => ([{
            info: {
                id: 'assistant-stale',
                role: 'assistant',
                parentID: 'previous-user-message',
                finish: 'stop',
            },
            parts: [{ type: 'text', text: 'STALE ANSWER' }],
        }]));

        const response = await request(app)
            .post('/v1/responses')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'current turn',
                stream: true,
                previous_response_id: 'stale-stream-parent',
            });

        expect(response.headers['content-type']).toContain('text/event-stream');
        expect(response.text).toContain('response.failed');
        expect(response.text).not.toContain('STALE ANSWER');
        expect(response.text).not.toContain('response.completed');
        expect(response.text).not.toContain('response.output_text.delta');
    });

    test('Responses stream retries 503 transient error on attempt 1 and succeeds on attempt 2 before any output', async () => {
        let sessionCount = 0;
        sdkMocks.sessionCreate.mockImplementation(async () => {
            sessionCount += 1;
            return { data: { id: `resp-session-${sessionCount}` } };
        });

        sdkMocks.eventSubscribe.mockImplementation(async () => {
            const currentSession = `resp-session-${sessionCount}`;
            return {
                stream: (async function* () {
                    if (currentSession === 'resp-session-1') {
                        yield {
                            type: 'session.error',
                            properties: {
                                sessionID: 'resp-session-1',
                                error: {
                                    name: 'APIError',
                                    data: {
                                        statusCode: 503,
                                        message: 'Endpoint is unavailable.',
                                        responseHeaders: { 'retry-after-ms': '5' }
                                    }
                                }
                            }
                        };
                    } else {
                        yield {
                            type: 'message.part.updated',
                            properties: {
                                part: { type: 'text', sessionID: 'resp-session-2' },
                                delta: 'Hello from responses attempt 2'
                            }
                        };
                        yield {
                            type: 'message.updated',
                            properties: {
                                info: { sessionID: 'resp-session-2', finish: 'stop' }
                            }
                        };
                    }
                })()
            };
        });

        const res = await request(app)
            .post('/v1/responses')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'hello',
                stream: true
            });

        expect(res.status).toBe(200);
        expect(sessionCount).toBe(2);
        expect(res.text).toContain('Hello from responses attempt 2');
        expect(sdkMocks.sessionDelete).toHaveBeenCalledWith({ path: { id: 'resp-session-1' } });
    });

    test('Messages stream retries 503 transient error on attempt 1 and succeeds on attempt 2 before any output', async () => {
        let sessionCount = 0;
        sdkMocks.sessionCreate.mockImplementation(async () => {
            sessionCount += 1;
            return { data: { id: `msg-session-${sessionCount}` } };
        });

        sdkMocks.eventSubscribe.mockImplementation(async () => {
            const currentSession = `msg-session-${sessionCount}`;
            return {
                stream: (async function* () {
                    if (currentSession === 'msg-session-1') {
                        yield {
                            type: 'session.error',
                            properties: {
                                sessionID: 'msg-session-1',
                                error: {
                                    name: 'APIError',
                                    data: {
                                        statusCode: 503,
                                        message: 'Endpoint is unavailable.',
                                        responseHeaders: { 'retry-after-ms': '5' }
                                    }
                                }
                            }
                        };
                    } else {
                        yield {
                            type: 'message.part.updated',
                            properties: {
                                part: { type: 'text', sessionID: 'msg-session-2' },
                                delta: 'Hello from messages attempt 2'
                            }
                        };
                        yield {
                            type: 'message.updated',
                            properties: {
                                info: { sessionID: 'msg-session-2', finish: 'stop' }
                            }
                        };
                    }
                })()
            };
        });

        const res = await request(app)
            .post('/v1/messages')
            .send({
                model: 'opencode/kimi-k2.5',
                max_tokens: 100,
                messages: [{ role: 'user', content: 'hello' }],
                stream: true
            });

        expect(res.status).toBe(200);
        expect(sessionCount).toBe(2);
        expect(res.text).toContain('Hello from messages attempt 2');
        expect(sdkMocks.sessionDelete).toHaveBeenCalledWith({ path: { id: 'msg-session-1' } });
    });

    test('Interactions retries 503 transient error on attempt 1 and succeeds on attempt 2', async () => {
        let sessionCount = 0;
        sdkMocks.sessionCreate.mockImplementation(async () => {
            sessionCount += 1;
            return { data: { id: `intr-session-${sessionCount}` } };
        });

        sdkMocks.sessionPrompt.mockImplementation(async () => {
            if (sessionCount === 1) {
                const err = new Error('Endpoint is unavailable.');
                err.data = { statusCode: 503, message: 'Endpoint is unavailable.', responseHeaders: { 'retry-after-ms': '5' } };
                throw err;
            }
            return { data: { parts: [] } };
        });

        sdkMocks.sessionMessages.mockImplementation(async () => ([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [{ type: 'text', text: 'Hello from interactions attempt 2' }]
            }
        ]));

        const res = await request(app)
            .post('/v1beta/interactions')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'hello'
            });

        expect(res.status).toBe(200);
        expect(sessionCount).toBe(2);
        expect(res.body.output_text).toBe('Hello from interactions attempt 2');
        expect(sdkMocks.sessionDelete).toHaveBeenCalledWith({ path: { id: 'intr-session-1' } });
    });
});

describe('Fail Closed Immediately (No Retry) on Partial Stream Error', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createApp(baseConfig({})).app;
    });

    test('Chat completions streaming fails closed without retry after partial output', async () => {
        let sessionCount = 0;
        sdkMocks.sessionCreate.mockImplementation(async () => {
            sessionCount += 1;
            return { data: { id: `chat-partial-${sessionCount}` } };
        });

        sdkMocks.eventSubscribe.mockImplementation(async () => ({
            stream: (async function* () {
                yield {
                    type: 'message.updated',
                    properties: { info: { id: 'chat-assistant', role: 'assistant', sessionID: 'chat-partial-1' } }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: { id: 'chat-part', messageID: 'chat-assistant', type: 'text', sessionID: 'chat-partial-1' },
                        delta: 'First chat chunk'
                    }
                };
                yield {
                    type: 'session.error',
                    properties: {
                        sessionID: 'chat-partial-1',
                        error: {
                            name: 'APIError',
                            data: { statusCode: 503, message: 'Endpoint is unavailable.' }
                        }
                    }
                };
            })()
        }));

        const res = await request(app)
            .post('/v1/chat/completions')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'hello' }],
                stream: true
            });

        expect(sessionCount).toBe(1);
        expect(res.text).toContain('First chat chunk');
        expect(res.text).toContain('error');
    });

    test('Responses streaming fails closed without retry after partial output', async () => {
        let sessionCount = 0;
        sdkMocks.sessionCreate.mockImplementation(async () => {
            sessionCount += 1;
            return { data: { id: `resp-partial-${sessionCount}` } };
        });

        sdkMocks.eventSubscribe.mockImplementation(async () => ({
            stream: (async function* () {
                yield {
                    type: 'message.updated',
                    properties: { info: { id: 'responses-assistant', role: 'assistant', sessionID: 'resp-partial-1' } }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: { id: 'responses-part', messageID: 'responses-assistant', type: 'text', sessionID: 'resp-partial-1' },
                        delta: 'First responses chunk'
                    }
                };
                yield {
                    type: 'session.error',
                    properties: {
                        sessionID: 'resp-partial-1',
                        error: {
                            name: 'APIError',
                            data: { statusCode: 503, message: 'Endpoint is unavailable.' }
                        }
                    }
                };
            })()
        }));

        const res = await request(app)
            .post('/v1/responses')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'hello',
                stream: true
            });

        expect(sessionCount).toBe(1);
        expect(res.text).toContain('response.output_text.delta');
        expect(res.text).toContain('response.failed');
        expect(res.text).toContain('[DONE]');
    });

    test('Messages streaming fails closed without retry after partial output', async () => {
        let sessionCount = 0;
        sdkMocks.sessionCreate.mockImplementation(async () => {
            sessionCount += 1;
            return { data: { id: `msg-partial-${sessionCount}` } };
        });

        sdkMocks.eventSubscribe.mockImplementation(async () => ({
            stream: (async function* () {
                yield {
                    type: 'message.updated',
                    properties: { info: { id: 'messages-assistant', role: 'assistant', sessionID: 'msg-partial-1' } }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: { id: 'messages-part', messageID: 'messages-assistant', type: 'text', sessionID: 'msg-partial-1' },
                        delta: 'First messages chunk'
                    }
                };
                yield {
                    type: 'session.error',
                    properties: {
                        sessionID: 'msg-partial-1',
                        error: {
                            name: 'APIError',
                            data: { statusCode: 503, message: 'Endpoint is unavailable.' }
                        }
                    }
                };
            })()
        }));

        const res = await request(app)
            .post('/v1/messages')
            .send({
                model: 'opencode/kimi-k2.5',
                max_tokens: 100,
                messages: [{ role: 'user', content: 'hello' }],
                stream: true
            });

        expect(sessionCount).toBe(1);
        expect(res.text).toContain('content_block_delta');
        expect(res.text).toContain('event: error');
    });
});

describe('Model Resolution Fast-Fail & Lock Separation', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createApp(baseConfig({})).app;
    });

    test('Unknown model on /v1/chat/completions fails fast with 404 without waiting for lock', async () => {
        let releaseLock;
        const lockHeldPromise = new Promise((resolve) => {
            releaseLock = resolve;
        });

        let lockAcquired = false;
        const lockHolder = lock(async () => {
            lockAcquired = true;
            await lockHeldPromise;
        });

        while (!lockAcquired) {
            await new Promise((r) => setTimeout(r, 10));
        }

        try {
            const start = Date.now();
            const res = await request(app)
                .post('/v1/chat/completions')
                .send({
                    model: 'opencode/nonexistent-model-xyz',
                    messages: [{ role: 'user', content: 'hello' }]
                });
            const elapsed = Date.now() - start;

            expect(res.status).toBe(404);
            expect(res.body.code).toBe('model_not_found');
            expect(elapsed).toBeLessThan(150);
        } finally {
            releaseLock();
            await lockHolder;
        }
    });

    test('Unknown model on /v1/messages fails fast with 404 without waiting for lock', async () => {
        let releaseLock;
        const lockHeldPromise = new Promise((resolve) => {
            releaseLock = resolve;
        });

        let lockAcquired = false;
        const lockHolder = lock(async () => {
            lockAcquired = true;
            await lockHeldPromise;
        });

        while (!lockAcquired) {
            await new Promise((r) => setTimeout(r, 10));
        }

        try {
            const start = Date.now();
            const res = await request(app)
                .post('/v1/messages')
                .send({
                    model: 'opencode/nonexistent-model-xyz',
                    max_tokens: 100,
                    messages: [{ role: 'user', content: 'hello' }]
                });
            const elapsed = Date.now() - start;

            expect(res.status).toBe(404);
            expect(res.body.type).toBe('error');
            expect(res.body.error.type).toBe('not_found_error');
            expect(elapsed).toBeLessThan(150);
        } finally {
            releaseLock();
            await lockHolder;
        }
    });
});

describe('Provider List Caching', () => {
    test('Provider list is cached across requests within TTL and invalidated on reset/reconnect', async () => {
        sdkMocks.configProviders.mockClear();
        const { app, ctx } = createApp(baseConfig({}));

        // First call fetches from backend
        const list1 = await ctx.getProvidersList();
        expect(list1).toHaveLength(1);
        expect(sdkMocks.configProviders).toHaveBeenCalledTimes(1);

        // Second call within TTL returns cached without calling backend again
        const list2 = await ctx.getProvidersList();
        expect(list2).toEqual(list1);
        expect(sdkMocks.configProviders).toHaveBeenCalledTimes(1);

        // HTTP GET /v1/models also uses cached list
        const res = await request(app).get('/v1/models');
        expect(res.status).toBe(200);
        expect(sdkMocks.configProviders).toHaveBeenCalledTimes(1);

        // Invalidate cache manually
        ctx.invalidateProvidersCache();
        const list3 = await ctx.getProvidersList();
        expect(list3).toEqual(list1);
        expect(sdkMocks.configProviders).toHaveBeenCalledTimes(2);

        // Reconnect notification also invalidates cache
        notifyBackendReconnect();
        const list4 = await ctx.getProvidersList();
        expect(list4).toEqual(list1);
        expect(sdkMocks.configProviders).toHaveBeenCalledTimes(3);
    });

    test('Concurrent calls to getProvidersList share the same pending promise', async () => {
        sdkMocks.configProviders.mockClear();
        const { ctx } = createApp(baseConfig({}));

        const [listA, listB] = await Promise.all([ctx.getProvidersList(), ctx.getProvidersList()]);
        expect(listA).toEqual(listB);
        expect(sdkMocks.configProviders).toHaveBeenCalledTimes(1);
    });

    test('Provider cache reconnect race: in-flight providers call does not restore invalidated cache on late resolution', async () => {
        sdkMocks.configProviders.mockClear();
        const { ctx } = createApp(baseConfig({}));

        let resolveInFlight;
        const inFlightBackendPromise = new Promise((resolve) => {
            resolveInFlight = resolve;
        });

        let callCount = 0;
        sdkMocks.configProviders.mockImplementation(async () => {
            callCount += 1;
            if (callCount === 1) {
                return inFlightBackendPromise;
            }
            return {
                data: {
                    providers: [{
                        id: 'fresh-opencode',
                        models: { 'fresh-model': { name: 'Fresh Model' } }
                    }]
                }
            };
        });

        try {
            // 1. First fetch starts and remains in flight
            const flight1Promise = ctx.getProvidersList();
            expect(callCount).toBe(1);

            // 2. Trigger backend reconnect/invalidation while fetch is in flight
            notifyBackendReconnect();

            // 3. The in-flight fetch resolves late with stale provider info
            resolveInFlight({
                data: {
                    providers: [{
                        id: 'stale-opencode',
                        models: { 'stale-model': { name: 'Stale Model' } }
                    }]
                }
            });

            const flight1Result = await flight1Promise;
            expect(flight1Result[0].id).toBe('stale-opencode');

            // 4. Stale data must not overwrite the invalidated cache; subsequent call triggers fresh fetch
            const freshResult = await ctx.getProvidersList();
            expect(freshResult[0].id).toBe('fresh-opencode');
            expect(sdkMocks.configProviders).toHaveBeenCalledTimes(2);

            // 5. Subsequent call hits the fresh cache
            const cachedFresh = await ctx.getProvidersList();
            expect(cachedFresh[0].id).toBe('fresh-opencode');
            expect(sdkMocks.configProviders).toHaveBeenCalledTimes(2);
        } finally {
            sdkMocks.configProviders.mockImplementation(async () => ({
                data: {
                    providers: [{
                        id: 'opencode',
                        models: {
                            'kimi-k2.5': { name: 'Kimi k2.5' }
                        }
                    }]
                }
            }));
        }
    });

    test('Responses continuation 503 fails closed, preserves parent session AND does not call session.create()', async () => {
        const { app } = createApp(baseConfig({ RETRY_MAX_RETRIES: 1 }));

        sdkMocks.sessionMessages.mockResolvedValue([
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'turn 1' }] }
        ]);
        sdkMocks.sessionCreate.mockResolvedValueOnce({ data: { id: 'parent-session-123' } });
        sdkMocks.sessionPrompt.mockResolvedValue({ data: { parts: [{ type: 'text', text: 'turn 1' }] } });
        const seedRes = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/kimi-k2.5', input: 'first turn' });
        expect(seedRes.status).toBe(200);
        const prevId = seedRes.body.id;

        // 2. Continuation turn: attempt 1 fails with transient 503 error event, fails closed without creating new session or deleting parent session
        let attempt = 0;
        sdkMocks.eventSubscribe.mockImplementation(async () => {
            attempt += 1;
            const currentAttempt = attempt;
            return {
                stream: (async function* () {
                    if (currentAttempt === 1) {
                        yield {
                            type: 'session.error',
                            properties: {
                                sessionID: 'parent-session-123',
                                error: {
                                    name: 'APIError',
                                    data: { statusCode: 503, message: 'Endpoint is unavailable.', responseHeaders: { 'retry-after-ms': '5' } }
                                }
                            }
                        };
                    } else {
                        yield {
                            type: 'message.part.updated',
                            properties: { part: { type: 'text', sessionID: 'parent-session-123' }, delta: 'turn 2 success' }
                        };
                        yield {
                            type: 'message.updated',
                            properties: { info: { sessionID: 'parent-session-123', finish: 'stop' } }
                        };
                    }
                })()
            };
        });

        sdkMocks.sessionDelete.mockClear();
        sdkMocks.sessionCreate.mockClear();
        const contRes = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/kimi-k2.5', input: 'second turn', stream: true, previous_response_id: prevId });

        expect(contRes.status).toBe(200);
        expect(contRes.text).toContain('response.failed');
        expect(contRes.text).toContain('Endpoint is unavailable.');
        expect(contRes.text).not.toContain('turn 2 success');

        // Verify parent session was NOT deleted and session.create() was NOT called
        expect(sdkMocks.sessionCreate).not.toHaveBeenCalled();
        const deletedIds = sdkMocks.sessionDelete.mock.calls.map(c => c[0]?.path?.id);
        expect(deletedIds).not.toContain('parent-session-123');
    });

    test('Responses continuation 503 fails closed and does not duplicate user prompt in stateful session transcript', async () => {
        const { app } = createApp(baseConfig({ RETRY_MAX_RETRIES: 1 }));

        const transcript = [];
        let isTurn2 = false;
        let sessionPromptTurn2Calls = 0;
        let capturedMessageId = null;

        sdkMocks.sessionPrompt.mockImplementation(async (params) => {
            transcript.push({ role: 'user', content: params.body.parts });
            if (isTurn2) {
                sessionPromptTurn2Calls += 1;
                capturedMessageId = params.body?.messageID;
            }
            return { data: { parts: [{ type: 'text', text: isTurn2 ? 'turn 2' : 'turn 1' }] } };
        });

        sdkMocks.sessionMessages.mockResolvedValue([
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'turn 1' }] }
        ]);
        sdkMocks.sessionCreate.mockResolvedValueOnce({ data: { id: 'stateful-parent-session-123' } });

        // Turn 1: seed parent session
        const seedRes = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/kimi-k2.5', input: 'first turn' });
        expect(seedRes.status).toBe(200);
        const prevId = seedRes.body.id;
        expect(transcript).toHaveLength(1);

        // Turn 2: continuation turn
        // Attempt 1 succeeds in persisting user prompt, but SSE event stream emits 503 session.error
        isTurn2 = true;
        let attempt = 0;
        sdkMocks.eventSubscribe.mockImplementation(async () => {
            attempt += 1;
            const currentAttempt = attempt;
            return {
                stream: (async function* () {
                    if (currentAttempt === 1) {
                        yield {
                            type: 'session.error',
                            properties: {
                                sessionID: 'stateful-parent-session-123',
                                error: {
                                    name: 'APIError',
                                    data: { statusCode: 503, message: 'Endpoint is unavailable.', responseHeaders: { 'retry-after-ms': '5' } }
                                }
                            }
                        };
                    } else {
                        yield {
                            type: 'message.part.updated',
                            properties: { part: { type: 'text', sessionID: 'stateful-parent-session-123' }, delta: 'turn 2 success' }
                        };
                        yield {
                            type: 'message.updated',
                            properties: { info: { sessionID: 'stateful-parent-session-123', finish: 'stop' } }
                        };
                    }
                })()
            };
        });

        const contRes = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'second turn',
                stream: true,
                previous_response_id: prevId,
            });

        expect(contRes.status).toBe(200);
        expect(contRes.text).toContain('response.failed');
        expect(contRes.text).toContain('Endpoint is unavailable.');
        expect(contRes.text).not.toContain('turn 2 success');

        // Assert sdkMocks.sessionPrompt is called only once for Turn 2
        expect(sessionPromptTurn2Calls).toBe(1);
        expect(capturedMessageId).toMatch(/^msg_/);
        // Assert session transcript has only one instance of Turn 2 user prompt (no duplicate)
        const turn2Entries = transcript.filter((t) =>
            JSON.stringify(t.content).includes('second turn'),
        );
        expect(turn2Entries).toHaveLength(1);
    });

    test('Responses non-stream continuation 503 fails closed without duplicate user prompt in stateful session transcript', async () => {
        const { app } = createApp(baseConfig({ RETRY_MAX_RETRIES: 1 }));

        const transcript = [];
        let isTurn2 = false;
        let sessionPromptTurn2Calls = 0;
        let capturedMessageId = null;

        sdkMocks.sessionMessages.mockResolvedValue([
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'turn 1 nonstream' }] }
        ]);
        sdkMocks.sessionCreate.mockResolvedValueOnce({ data: { id: 'stateful-parent-nonstream-789' } });

        sdkMocks.sessionPrompt.mockImplementation(async (params) => {
            transcript.push({ role: 'user', content: params.body.parts });
            if (isTurn2) {
                sessionPromptTurn2Calls += 1;
                capturedMessageId = params.body?.messageID;
            }
            return { data: { parts: [{ type: 'text', text: isTurn2 ? 'turn 2 nonstream' : 'turn 1 nonstream' }] } };
        });

        const seedRes = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/kimi-k2.5', input: 'first turn nonstream' });
        expect(seedRes.status).toBe(200);
        const prevId = seedRes.body.id;
        expect(transcript).toHaveLength(1);

        isTurn2 = true;
        let pollCount = 0;
        // In continuation turn 2: sessionPrompt returns empty parts so it polls, and poll attempt 1 fails with 503
        sdkMocks.sessionPrompt.mockImplementation(async (params) => {
            transcript.push({ role: 'user', content: params.body.parts });
            if (isTurn2) {
                sessionPromptTurn2Calls += 1;
                capturedMessageId = params.body?.messageID;
            }
            return { data: { parts: [] } };
        });

        sdkMocks.sessionMessages.mockImplementation(async () => {
            pollCount += 1;
            if (pollCount === 1) {
                const err = new Error('Endpoint is unavailable.');
                err.statusCode = 503;
                err.data = { statusCode: 503, message: 'Endpoint is unavailable.', responseHeaders: { 'retry-after-ms': '5' } };
                throw err;
            }
            return [
                { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'turn 2 nonstream success' }] }
            ];
        });

        const contRes = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'second turn nonstream',
                previous_response_id: prevId,
            });

        expect(contRes.status).toBe(503);
        expect(contRes.body.message).toContain('Endpoint is unavailable.');
        expect(sessionPromptTurn2Calls).toBe(1);
        expect(capturedMessageId).toMatch(/^msg_/);
        const turn2Entries = transcript.filter((t) =>
            JSON.stringify(t.content).includes('second turn nonstream'),
        );
        expect(turn2Entries).toHaveLength(1);
    });

    test('Interactions continuation 503 fails closed without duplicate user prompt in stateful session transcript', async () => {
        const { app } = createApp(baseConfig({ RETRY_MAX_RETRIES: 1 }));

        const transcript = [];
        let isTurn2 = false;
        let sessionPromptTurn2Calls = 0;
        let capturedMessageId = null;

        sdkMocks.sessionCreate.mockResolvedValueOnce({ data: { id: 'intr-stateful-parent-456' } });
        sdkMocks.sessionPrompt.mockImplementation(async (params) => {
            transcript.push({ role: 'user', content: params.body.parts });
            if (isTurn2) {
                sessionPromptTurn2Calls += 1;
                capturedMessageId = params.body?.messageID;
            }
            return { data: { parts: [] } };
        });
        sdkMocks.sessionMessages.mockResolvedValueOnce([
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'turn 1 intr' }] }
        ]);

        const seedRes = await request(app)
            .post('/v1beta/interactions')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'first turn',
                store: true,
            });
        expect(seedRes.status).toBe(200);
        const prevIntrId = seedRes.body.id;
        expect(transcript).toHaveLength(1);

        isTurn2 = true;
        let pollCount = 0;
        sdkMocks.sessionMessages.mockImplementation(async () => {
            pollCount += 1;
            if (pollCount === 1) {
                const err = new Error('Endpoint is unavailable.');
                err.statusCode = 503;
                err.data = { statusCode: 503, message: 'Endpoint is unavailable.', responseHeaders: { 'retry-after-ms': '5' } };
                throw err;
            }
            return [
                { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'turn 2 intr success' }] }
            ];
        });

        const contRes = await request(app)
            .post('/v1beta/interactions')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'second turn',
                previous_interaction_id: prevIntrId,
            });

        expect(contRes.status).toBe(503);
        expect(contRes.body.message).toContain('Endpoint is unavailable.');
        expect(sessionPromptTurn2Calls).toBe(1);
        expect(capturedMessageId).toMatch(/^msg_/);
        const turn2Entries = transcript.filter((t) =>
            JSON.stringify(t.content).includes('second turn'),
        );
        expect(turn2Entries).toHaveLength(1);
    });

    test('Interactions continuation 503 prompt failure fails closed and preserves parent session', async () => {
        const { app } = createApp(baseConfig({ RETRY_MAX_RETRIES: 1 }));

        sdkMocks.sessionCreate.mockResolvedValueOnce({ data: { id: 'intr-parent-session-123' } });
        sdkMocks.sessionPrompt.mockResolvedValue({ data: { parts: [] } });
        sdkMocks.sessionMessages.mockResolvedValueOnce([
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'turn 1 intr' }] }
        ]);

        const seedRes = await request(app)
            .post('/v1beta/interactions')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'first turn',
                store: true
            });
        expect(seedRes.status).toBe(200);
        const prevIntrId = seedRes.body.id;

        let promptCount = 0;
        sdkMocks.sessionPrompt.mockImplementation(async (params) => {
            promptCount += 1;
            expect(params.path.id).toBe('intr-parent-session-123');
            if (promptCount === 1) {
                const err = new Error('Endpoint is unavailable.');
                err.statusCode = 503;
                err.data = { statusCode: 503, message: 'Endpoint is unavailable.', responseHeaders: { 'retry-after-ms': '5' } };
                throw err;
            }
            return { data: { parts: [] } };
        });

        sdkMocks.sessionMessages.mockResolvedValue([
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'turn 2 intr success' }] }
        ]);

        sdkMocks.sessionCreate.mockClear();
        sdkMocks.sessionDelete.mockClear();

        const contRes = await request(app)
            .post('/v1beta/interactions')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'second turn',
                previous_interaction_id: prevIntrId
            });

        expect(contRes.status).toBe(503);
        expect(contRes.body.message).toContain('Endpoint is unavailable.');
        expect(promptCount).toBe(1);

        // Verify parent session was NOT deleted and session.create() was NOT called on retry
        expect(sdkMocks.sessionCreate).not.toHaveBeenCalled();
        const deletedIds = sdkMocks.sessionDelete.mock.calls.map(c => c[0]?.path?.id);
        expect(deletedIds).not.toContain('intr-parent-session-123');
    });

    test('Responses streaming continuation prompt failure fails closed, emits response.failed with 503 and prompts only once', async () => {
        const { app } = createApp(baseConfig({ RETRY_MAX_RETRIES: 1 }));

        sdkMocks.sessionMessages.mockResolvedValue([
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'turn 1' }] }
        ]);
        sdkMocks.sessionCreate.mockResolvedValueOnce({ data: { id: 'resp-stream-parent-456' } });
        sdkMocks.sessionPrompt.mockResolvedValue({ data: { parts: [{ type: 'text', text: 'turn 1' }] } });
        const seedRes = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/kimi-k2.5', input: 'first turn' });
        expect(seedRes.status).toBe(200);
        const prevId = seedRes.body.id;

        let sessionPromptTurn2Calls = 0;
        sdkMocks.sessionPrompt.mockImplementation(async (params) => {
            sessionPromptTurn2Calls += 1;
            const err = new Error('Endpoint is unavailable.');
            err.statusCode = 503;
            err.data = { statusCode: 503, message: 'Endpoint is unavailable.', responseHeaders: { 'retry-after-ms': '5' } };
            throw err;
        });

        sdkMocks.sessionDelete.mockClear();
        sdkMocks.sessionCreate.mockClear();

        const contRes = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'second turn',
                stream: true,
                previous_response_id: prevId,
            });

        expect(contRes.status).toBe(200);
        expect(contRes.text).toContain('response.failed');
        expect(contRes.text).toContain('Endpoint is unavailable.');
        expect(contRes.text).not.toContain('response.completed');
        expect(sessionPromptTurn2Calls).toBe(1);
        expect(sdkMocks.sessionCreate).not.toHaveBeenCalled();
        const deletedIds = sdkMocks.sessionDelete.mock.calls.map(c => c[0]?.path?.id);
        expect(deletedIds).not.toContain('resp-stream-parent-456');
    });

    test('Responses non-stream continuation prompt failure fails closed, returns 503 and prompts only once', async () => {
        const { app } = createApp(baseConfig({ RETRY_MAX_RETRIES: 1 }));

        sdkMocks.sessionMessages.mockResolvedValue([
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'turn 1 nonstream' }] }
        ]);
        sdkMocks.sessionCreate.mockResolvedValueOnce({ data: { id: 'resp-nonstream-parent-789' } });
        sdkMocks.sessionPrompt.mockResolvedValue({ data: { parts: [{ type: 'text', text: 'turn 1 nonstream' }] } });

        const seedRes = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/kimi-k2.5', input: 'first turn nonstream' });
        expect(seedRes.status).toBe(200);
        const prevId = seedRes.body.id;

        let sessionPromptTurn2Calls = 0;
        sdkMocks.sessionPrompt.mockImplementation(async (params) => {
            sessionPromptTurn2Calls += 1;
            const err = new Error('Endpoint is unavailable.');
            err.statusCode = 503;
            err.data = { statusCode: 503, message: 'Endpoint is unavailable.', responseHeaders: { 'retry-after-ms': '5' } };
            throw err;
        });

        sdkMocks.sessionDelete.mockClear();
        sdkMocks.sessionCreate.mockClear();

        const contRes = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'second turn nonstream',
                previous_response_id: prevId,
            });

        expect(contRes.status).toBe(503);
        expect(contRes.body.message).toContain('Endpoint is unavailable.');
        expect(sessionPromptTurn2Calls).toBe(1);
        expect(sdkMocks.sessionCreate).not.toHaveBeenCalled();
        const deletedIds = sdkMocks.sessionDelete.mock.calls.map(c => c[0]?.path?.id);
        expect(deletedIds).not.toContain('resp-nonstream-parent-789');
    });

    test('Responses stream proxy fallback succeeds cleanly without repeating prompts or retaining Attempt 1 error', async () => {
        const { app } = createApp(baseConfig({
            RETRY_MAX_RETRIES: 1,
            UPSTREAM_PROXIES: ['http://10.0.0.1:8080'],
            UPSTREAM_PROXY_COOLDOWN_MS: 60000,
        }));

        let sessionCount = 0;
        sdkMocks.sessionCreate.mockImplementation(async () => {
            sessionCount += 1;
            return { data: { id: `resp-fallback-${sessionCount}` } };
        });

        sdkMocks.eventSubscribe.mockImplementation(async () => {
            return {
                stream: (async function* () {
                    yield {
                        type: 'session.error',
                        properties: {
                            sessionID: 'resp-fallback-1',
                            error: freeUsageError()
                        }
                    };
                })()
            };
        });

        let promptCalls = 0;
        sdkMocks.sessionPrompt.mockImplementation(async () => {
            promptCalls += 1;
            return { data: { parts: [] } };
        });

        sdkMocks.sessionMessages.mockResolvedValue([
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Hello from proxy fallback attempt 2' }] }
        ]);

        const res = await request(app)
            .post('/v1/responses')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'hello fallback',
                stream: true
            });

        expect(res.status).toBe(200);
        expect(res.text).toContain('Hello from proxy fallback attempt 2');
        expect(res.text).toContain('response.completed');
        expect(res.text).not.toContain('Rate limit exceeded');
        expect(promptCalls).toBe(2);
    });
});

describe('Backend Lifecycle & Active Model Retries', () => {
    afterEach(() => {
        clearBackendReconnectListeners();
    });

    test('getProvidersList triggers ensureBackend when config.MANAGE_BACKEND: true', async () => {
        sdkMocks.configProviders.mockClear();
        httpMocks.get.mockClear();

        // With MANAGE_BACKEND: true, getProvidersList triggers ensureBackend (which calls checkHealth via http.get)
        const { ctx: ctxManage } = createApp(baseConfig({ MANAGE_BACKEND: true }));
        const list = await ctxManage.getProvidersList();
        expect(list).toHaveLength(1);
        expect(httpMocks.get).toHaveBeenCalled();
        expect(sdkMocks.configProviders).toHaveBeenCalledTimes(1);

        // With MANAGE_BACKEND: false, getProvidersList does not call ensureBackend
        httpMocks.get.mockClear();
        sdkMocks.configProviders.mockClear();
        const { ctx: ctxNoManage } = createApp(baseConfig({ MANAGE_BACKEND: false }));
        const listNoManage = await ctxNoManage.getProvidersList();
        expect(listNoManage).toHaveLength(1);
        expect(httpMocks.get).not.toHaveBeenCalled();
        expect(sdkMocks.configProviders).toHaveBeenCalledTimes(1);
    });

    test('ensureActiveModel is called on retry when proxy fallback switches activeClient (Responses stream)', async () => {
        sdkMocks.configUpdate.mockClear();
        const { app } = createApp(baseConfig({
            RETRY_MAX_RETRIES: 1,
            UPSTREAM_PROXIES: ['http://10.0.0.1:8080'],
            UPSTREAM_PROXY_COOLDOWN_MS: 60000,
        }));

        let sessionCount = 0;
        sdkMocks.sessionCreate.mockImplementation(async () => {
            sessionCount += 1;
            return { data: { id: `resp-fallback-model-${sessionCount}` } };
        });

        sdkMocks.eventSubscribe.mockImplementation(async () => {
            return {
                stream: (async function* () {
                    if (sessionCount === 1) {
                        yield {
                            type: 'session.error',
                            properties: {
                                sessionID: 'resp-fallback-model-1',
                                error: freeUsageError()
                            }
                        };
                    } else {
                        yield {
                            type: 'message.part.updated',
                            properties: {
                                part: { type: 'text', sessionID: 'resp-fallback-model-2' },
                                delta: 'Hello from fallback attempt 2'
                            }
                        };
                        yield {
                            type: 'message.updated',
                            properties: {
                                info: { sessionID: 'resp-fallback-model-2', finish: 'stop' }
                            }
                        };
                    }
                })()
            };
        });

        sdkMocks.sessionPrompt.mockImplementation(async () => ({ data: { parts: [] } }));
        sdkMocks.sessionMessages.mockResolvedValue([
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Hello from fallback attempt 2' }] }
        ]);

        const res = await request(app)
            .post('/v1/responses')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'test active model retry',
                stream: true
            });

        expect(res.status).toBe(200);
        expect(sessionCount).toBe(2);
        // Attempt 1 calls ensureActiveModel on primary client, Attempt 2 on fallback proxyClient
        expect(sdkMocks.configUpdate).toHaveBeenCalledTimes(2);
        expect(sdkMocks.configUpdate).toHaveBeenNthCalledWith(1, {
            body: { activeModel: { providerID: 'opencode', modelID: 'kimi-k2.5' } }
        });
        expect(sdkMocks.configUpdate).toHaveBeenNthCalledWith(2, {
            body: { activeModel: { providerID: 'opencode', modelID: 'kimi-k2.5' } }
        });
    });

    test('ensureActiveModel is called on retry when proxy fallback switches activeClient (Messages stream)', async () => {
        sdkMocks.configUpdate.mockClear();
        const { app } = createApp(baseConfig({
            RETRY_MAX_RETRIES: 1,
            UPSTREAM_PROXIES: ['http://10.0.0.1:8080'],
            UPSTREAM_PROXY_COOLDOWN_MS: 60000,
        }));

        let sessionCount = 0;
        sdkMocks.sessionCreate.mockImplementation(async () => {
            sessionCount += 1;
            return { data: { id: `msg-fallback-model-${sessionCount}` } };
        });

        sdkMocks.eventSubscribe.mockImplementation(async () => {
            return {
                stream: (async function* () {
                    if (sessionCount === 1) {
                        yield {
                            type: 'session.error',
                            properties: {
                                sessionID: 'msg-fallback-model-1',
                                error: freeUsageError()
                            }
                        };
                    } else {
                        yield {
                            type: 'message.part.updated',
                            properties: {
                                part: { type: 'text', sessionID: 'msg-fallback-model-2' },
                                delta: 'Hello from messages fallback attempt 2'
                            }
                        };
                        yield {
                            type: 'message.updated',
                            properties: {
                                info: { sessionID: 'msg-fallback-model-2', finish: 'stop' }
                            }
                        };
                    }
                })()
            };
        });

        sdkMocks.sessionPrompt.mockImplementation(async () => ({ data: { parts: [] } }));

        const res = await request(app)
            .post('/v1/messages')
            .send({
                model: 'opencode/kimi-k2.5',
                max_tokens: 100,
                messages: [{ role: 'user', content: 'test active model retry' }],
                stream: true
            });

        expect(res.status).toBe(200);
        expect(sessionCount).toBe(2);
        // Attempt 1 on primary client, Attempt 2 on fallback proxyClient
        expect(sdkMocks.configUpdate).toHaveBeenCalledTimes(2);
        expect(sdkMocks.configUpdate).toHaveBeenNthCalledWith(1, {
            body: { activeModel: { providerID: 'opencode', modelID: 'kimi-k2.5' } }
        });
        expect(sdkMocks.configUpdate).toHaveBeenNthCalledWith(2, {
            body: { activeModel: { providerID: 'opencode', modelID: 'kimi-k2.5' } }
        });
    });

    test('ensureActiveModel is called on retry when proxy fallback switches activeClient (Interactions)', async () => {
        sdkMocks.configUpdate.mockClear();
        const { app } = createApp(baseConfig({
            RETRY_MAX_RETRIES: 1,
            UPSTREAM_PROXIES: ['http://10.0.0.1:8080'],
            UPSTREAM_PROXY_COOLDOWN_MS: 60000,
        }));

        let sessionCount = 0;
        sdkMocks.sessionCreate.mockImplementation(async () => {
            sessionCount += 1;
            return { data: { id: `intr-fallback-model-${sessionCount}` } };
        });

        sdkMocks.sessionPrompt.mockImplementation(async () => {
            if (sessionCount === 1) {
                throw freeUsageError();
            }
            return { data: { parts: [] } };
        });

        sdkMocks.sessionMessages.mockResolvedValue([
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Hello from interactions fallback attempt 2' }] }
        ]);

        const res = await request(app)
            .post('/v1beta/interactions')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'test interactions active model retry',
            });

        expect(res.status).toBe(200);
        expect(sessionCount).toBe(2);
        expect(res.body.output_text).toBe('Hello from interactions fallback attempt 2');
        expect(sdkMocks.configUpdate).toHaveBeenCalledTimes(2);
        expect(sdkMocks.configUpdate).toHaveBeenNthCalledWith(1, {
            body: { activeModel: { providerID: 'opencode', modelID: 'kimi-k2.5' } }
        });
        expect(sdkMocks.configUpdate).toHaveBeenNthCalledWith(2, {
            body: { activeModel: { providerID: 'opencode', modelID: 'kimi-k2.5' } }
        });
    });

    test('Chat route ensures activeModel is updated on retry when proxy fallback switches activeClient', async () => {
        sdkMocks.configUpdate.mockClear();
        const { app } = createApp(baseConfig({
            UPSTREAM_PROXIES: ['http://10.0.0.1:8080'],
            UPSTREAM_PROXY_COOLDOWN_MS: 60000,
            RETRY_MAX_RETRIES: 1,
        }));

        let sessionCount = 0;
        sdkMocks.sessionCreate.mockImplementation(async () => {
            sessionCount += 1;
            return { data: { id: `chat-fallback-session-${sessionCount}` } };
        });

        sdkMocks.sessionPrompt.mockImplementation(async () => {
            if (sessionCount === 1) {
                throw freeUsageError();
            }
            return { data: { parts: [] } };
        });

        sdkMocks.sessionMessages.mockResolvedValue([
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Hello from chat fallback attempt 2' }] }
        ]);

        const res = await request(app)
            .post('/v1/chat/completions')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'test chat active model retry' }],
            });

        expect(res.status).toBe(200);
        expect(sessionCount).toBe(2);
        expect(res.body.choices[0].message.content).toBe('Hello from chat fallback attempt 2');
        expect(sdkMocks.configUpdate).toHaveBeenCalledTimes(2);
        expect(sdkMocks.configUpdate).toHaveBeenNthCalledWith(1, {
            body: { activeModel: { providerID: 'opencode', modelID: 'kimi-k2.5' } }
        });
        expect(sdkMocks.configUpdate).toHaveBeenNthCalledWith(2, {
            body: { activeModel: { providerID: 'opencode', modelID: 'kimi-k2.5' } }
        });
    });

    test('clearBackendReconnectListeners and ctx.dispose() clean up reconnect listeners', async () => {
        sdkMocks.configProviders.mockClear();

        // 1. ctx.dispose() removes reconnect listener
        const { ctx: ctx1 } = createApp(baseConfig({}));
        await ctx1.getProvidersList();
        expect(sdkMocks.configProviders).toHaveBeenCalledTimes(1);

        expect(typeof ctx1.dispose).toBe('function');
        ctx1.dispose();

        // notifyBackendReconnect() does not invalidate disposed ctx cache
        notifyBackendReconnect();
        await ctx1.getProvidersList();
        expect(sdkMocks.configProviders).toHaveBeenCalledTimes(1);

        // 2. clearBackendReconnectListeners clears all listeners globally
        sdkMocks.configProviders.mockClear();
        const { ctx: ctx2 } = createApp(baseConfig({}));
        await ctx2.getProvidersList();
        expect(sdkMocks.configProviders).toHaveBeenCalledTimes(1);

        clearBackendReconnectListeners();
        notifyBackendReconnect();
        await ctx2.getProvidersList();
        expect(sdkMocks.configProviders).toHaveBeenCalledTimes(1);
    });
});
