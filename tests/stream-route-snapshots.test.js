import request from 'supertest';
import { jest } from '@jest/globals';

// Keep the collector idle window tiny so the idle-timeout recovery path is
// deterministic without a real backend. Set before importing the proxy because
// the collector reads these constants at module load.
process.env['OPENCODE2API_EVENT_IDLE_TIMEOUT_MS'] = '40';
process.env['OPENCODE2API_EVENT_FIRST_DELTA_TIMEOUT_MS'] = '400';

const SESSION_ID = 'route-snapshot-session';

jest.unstable_mockModule('http', () => ({
    default: {
        get: jest.fn((_url, _options, callback) => {
            const response = {
                statusCode: 200,
                headers: {},
                on: jest.fn()
            };
            callback(response);
            return {
                on: jest.fn(),
                destroy: jest.fn(),
                setTimeout: jest.fn()
            };
        })
    }
}));

const sdkMocks = {
    configProviders: jest.fn(async () => ({
        data: { providers: [{ id: 'opencode', models: { 'kimi-k2.5': { name: 'Kimi k2.5' } } }] }
    })),
    configUpdate: jest.fn(async () => ({})),
    toolIds: jest.fn(async () => ({ data: ['web_fetch', 'filesystem', 'bash'] })),
    sessionCreate: jest.fn(async () => ({ data: { id: SESSION_ID } })),
    sessionPrompt: jest.fn(async () => ({ data: { parts: [{ type: 'text', text: 'Mock response' }] } })),
    sessionMessages: jest.fn(async () => ([
        { info: { role: 'assistant', finish: 'stop' }, parts: [] }
    ])),
    sessionDelete: jest.fn(async () => ({})),
    eventSubscribe: jest.fn(async () => ({
        stream: (async function* () {
            yield { type: 'message.updated', properties: { info: { sessionID: SESSION_ID, finish: 'stop' } } };
        })()
    }))
};

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

const readSseData = (text) => text
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)));

const visibleTextFor = (path, text) => {
    const frames = readSseData(text);
    if (path === '/v1/responses') {
        return frames.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta);
    }
    if (path === '/v1/messages') {
        return frames
            .filter((event) => event.type === 'content_block_delta' && event.delta?.type === 'text_delta')
            .map((event) => event.delta.text);
    }
    return frames
        .flatMap((event) => event.choices || [])
        .flatMap((choice) => (choice.delta?.content ? [choice.delta.content] : []));
};

const toolCallsFor = (path, text) => {
    const frames = readSseData(text);
    if (path === '/v1/responses') {
        const args = frames
            .filter((event) => event.type === 'response.function_call_arguments.delta')
            .map((event) => event.delta)
            .join('');
        return frames
            .filter((event) => event.type === 'response.output_item.added' && event.item?.type === 'function_call')
            .map((event) => ({ ...event.item, arguments: args }));
    }
    if (path === '/v1/messages') {
        const input = frames
            .filter((event) => event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta')
            .map((event) => event.delta.partial_json)
            .join('');
        return frames
            .filter((event) => event.type === 'content_block_start' && event.content_block?.type === 'tool_use')
            .map((event) => ({ ...event.content_block, arguments: input }));
    }
    return frames
        .flatMap((event) => event.choices || [])
        .flatMap((choice) => choice.delta?.tool_calls || [])
        .map((call) => ({
            id: call.id,
            name: call.function?.name,
            arguments: call.function?.arguments
        }));
};

const buildApp = () => createApp({
    PORT: 10000,
    API_KEY: 'test-key',
    OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
    REQUEST_TIMEOUT_MS: 120,
    RETRY_MAX_RETRIES: 0,
    DISABLE_TOOLS: true,
    DEBUG: false
}).app;

const readTool = {
    type: 'function',
    function: {
        name: 'read',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
    }
};

const payloads = [
    ['chat', '/v1/chat/completions', { model: 'opencode/kimi-k2.5', stream: true, messages: [{ role: 'user', content: 'Read a file' }], tools: [readTool] }],
    ['messages', '/v1/messages', {
        model: 'opencode/kimi-k2.5',
        max_tokens: 100,
        stream: true,
        messages: [{ role: 'user', content: 'Read a file' }],
        tools: [{ name: 'read', description: 'Read a file', input_schema: readTool.function.parameters }]
    }],
    ['responses', '/v1/responses', {
        model: 'opencode/kimi-k2.5',
        input: 'Read a file',
        stream: true,
        tools: [{ type: 'function', name: 'read', parameters: readTool.function.parameters }]
    }]
];

const plainTextPayloads = [
    ['chat', '/v1/chat/completions', { model: 'opencode/kimi-k2.5', stream: true, messages: [{ role: 'user', content: 'Say hello' }] }],
    ['messages', '/v1/messages', { model: 'opencode/kimi-k2.5', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'Say hello' }] }],
    ['responses', '/v1/responses', { model: 'opencode/kimi-k2.5', input: 'Say hello', stream: true }],
];

describe('route snapshot source selection', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        sdkMocks.eventSubscribe.mockImplementation(async () => ({
            stream: (async function* () {
                yield {
                    type: 'message.updated',
                    properties: { info: { id: 'assistant-current', role: 'assistant', sessionID: SESSION_ID } },
                };
                yield {
                    type: 'message.part.updated',
                    properties: { part: { id: 'raw-part', messageID: 'assistant-current', type: 'text', sessionID: SESSION_ID }, delta: '<function_calls>{"id":"call_raw_complete","name":"read","arguments":{"path":"a.txt"}}</function_calls>' }
                };
                // finish=tool keeps the collector waiting for a terminal snapshot;
                // the tiny idle window then forces the recovery-poll path.
                yield { type: 'message.updated', properties: { info: { id: 'assistant-current', role: 'assistant', sessionID: SESSION_ID, finish: 'tool' } } };
            })()
        }));
    });

    test.each(payloads)('%s keeps a complete raw tool call when the poll snapshot is empty', async (_label, path, payload) => {
        sdkMocks.sessionMessages.mockResolvedValue([
            { info: { role: 'assistant', finish: 'stop' }, parts: [] }
        ]);
        const res = await request(buildApp())
            .post(path)
            .set('Authorization', 'Bearer test-key')
            .set('anthropic-version', '2023-06-01')
            .send(payload);
        expect(res.statusCode).toBe(200);
        expect(visibleTextFor(path, res.text).join('')).toBe('');
        const calls = toolCallsFor(path, res.text);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ name: 'read' });
        expect(JSON.stringify(calls[0].arguments)).toContain('a.txt');
        expect(sdkMocks.sessionMessages).toHaveBeenCalled();
        if (_label === 'chat') {
            expect(res.text).toContain('"finish_reason":"tool_calls"');
            expect(res.text).toContain('data: [DONE]');
            expect(res.text).not.toMatch(/"error"\s*:\s*\{/);
        } else if (_label === 'messages') {
            const frames = readSseData(res.text);
            const terminalDelta = frames.find((frame) => frame.type === 'message_delta');
            expect(terminalDelta?.delta?.stop_reason).toBe('tool_use');
            expect(res.text).toContain('event: message_stop');
            expect(res.text).not.toContain('[DONE]');
            expect(res.text).not.toContain('event: error');
        } else {
            const frames = readSseData(res.text);
            expect(frames.at(-1)?.type).toBe('response.completed');
            expect(res.text).toContain('data: [DONE]');
            expect(res.text).not.toContain('response.failed');
            expect(res.text).not.toMatch(/"error"\s*:\s*\{/);
        }
    });

    test.each(plainTextPayloads)('%s does not succeed with partial raw text when recovery polling finds an empty completed snapshot', async (label, path, payload) => {
        sdkMocks.eventSubscribe.mockImplementation(async () => ({
            stream: (async function* () {
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: { id: 'partial-text', messageID: 'assistant-current', type: 'text', sessionID: SESSION_ID },
                        delta: 'partial answer',
                    },
                };
                yield {
                    type: 'message.updated',
                    properties: {
                        info: { id: 'assistant-current', role: 'assistant', sessionID: SESSION_ID, finish: 'tool' },
                    },
                };
            })(),
        }));
        sdkMocks.sessionMessages.mockResolvedValue([
            { info: { id: 'assistant-current', role: 'assistant', finish: 'stop' }, parts: [] },
        ]);

        const res = await request(buildApp())
            .post(path)
            .set('Authorization', 'Bearer test-key')
            .set('anthropic-version', '2023-06-01')
            .send(payload);

        expect(res.statusCode).toBe(200);
        expect(visibleTextFor(path, res.text).join('')).toContain('partial answer');
        if (label === 'chat') {
            const frames = readSseData(res.text);
            expect(frames.at(-1)).toHaveProperty('error');
            expect(res.text).toContain('data: {"error":');
            expect(res.text).not.toContain('data: [DONE]');
            expect(res.text).not.toContain('"finish_reason":"stop"');
        } else if (label === 'messages') {
            const frames = readSseData(res.text);
            expect(frames.at(-1)).toMatchObject({ type: 'error', error: expect.any(Object) });
            expect(res.text).toContain('event: error');
            expect(res.text).not.toContain('[DONE]');
            expect(res.text).not.toContain('message_stop');
            expect(res.text).not.toContain('message_delta');
        } else {
            const frames = readSseData(res.text);
            expect(frames.at(-1)?.type).toBe('response.failed');
            expect(res.text).toContain('data: [DONE]');
            expect(res.text).not.toContain('response.completed');
        }
    });

    test.each(payloads)('%s fails closed when the poll snapshot is a timeout partial', async (label, path, payload) => {
        // finish=tool means the polled message is never terminal, so the poll
        // returns lastPartial with partial: true after the request timeout.
        sdkMocks.sessionMessages.mockResolvedValue([
            { info: { role: 'assistant', finish: 'tool' }, parts: [{ type: 'text', text: 'partial answer' }] }
        ]);
        const res = await request(buildApp())
            .post(path)
            .set('Authorization', 'Bearer test-key')
            .set('anthropic-version', '2023-06-01')
            .send(payload);
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain('Recovery poll returned incomplete response');
        if (label === 'chat') {
            expect(res.text).not.toContain('data: [DONE]');
            expect(res.text).not.toContain('finish_reason');
        } else if (label === 'messages') {
            expect(res.text).not.toContain('message_stop');
            expect(res.text).not.toContain('message_delta');
        } else if (label === 'responses') {
            expect(res.text).not.toContain('response.completed');
        }
    }, 15000);

    test.each(payloads)('%s delivers only snapshot tool call (b.txt) and does not combine raw streamed call (a.txt)', async (_label, path, payload) => {
        sdkMocks.sessionMessages.mockResolvedValue([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [{
                    type: 'text',
                    text: '<function_calls>{"id":"call_snap_complete","name":"read","arguments":{"path":"b.txt"}}</function_calls>'
                }]
            }
        ]);
        const res = await request(buildApp())
            .post(path)
            .set('Authorization', 'Bearer test-key')
            .set('anthropic-version', '2023-06-01')
            .send(payload);
        expect(res.statusCode).toBe(200);
        expect(visibleTextFor(path, res.text).join('')).toBe('');
        const calls = toolCallsFor(path, res.text);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ name: 'read' });
        expect(JSON.stringify(calls[0].arguments)).toContain('b.txt');
        expect(JSON.stringify(calls[0].arguments)).not.toContain('a.txt');
        expect(res.text).not.toContain('a.txt');
        expect(res.text).not.toContain('response.failed');
        expect(res.text).not.toMatch(/"error"\s*:\s*\{/);
    });

    test.each(payloads)('%s succeeds with 1 tool call under parallel_tool_calls: false without failing with parallel_external_tool_calls', async (_label, path, payload) => {
        sdkMocks.sessionMessages.mockResolvedValue([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [{
                    type: 'text',
                    text: '<function_calls>{"id":"call_snap_complete","name":"read","arguments":{"path":"b.txt"}}</function_calls>'
                }]
            }
        ]);
        const nonParallelPayload = {
            ...payload,
            parallel_tool_calls: false,
            disable_parallel_tool_use: true
        };
        const res = await request(buildApp())
            .post(path)
            .set('Authorization', 'Bearer test-key')
            .set('anthropic-version', '2023-06-01')
            .send(nonParallelPayload);
        expect(res.statusCode).toBe(200);
        expect(res.text).not.toContain('parallel_external_tool_calls');
        const calls = toolCallsFor(path, res.text);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ name: 'read' });
        expect(JSON.stringify(calls[0].arguments)).toContain('b.txt');
        expect(JSON.stringify(calls[0].arguments)).not.toContain('a.txt');
        expect(res.text).not.toContain('response.failed');
        expect(res.text).not.toMatch(/"error"\s*:\s*\{/);
    });

    test.each(payloads)('%s cleanly delivers snapshot tool calls when repairing from malformed raw markup without combining raw deltas', async (_label, path, payload) => {
        const malformedDelta = 'prefix <function_calls>{"name":"read" arguments</function_calls> suffix';
        sdkMocks.eventSubscribe.mockImplementation(async () => ({
            stream: (async function* () {
                yield {
                    type: 'message.part.updated',
                    properties: { part: { type: 'text', sessionID: SESSION_ID }, delta: malformedDelta }
                };
                yield { type: 'message.updated', properties: { info: { sessionID: SESSION_ID, finish: 'stop' } } };
            })()
        }));
        sdkMocks.sessionMessages.mockResolvedValue([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [{
                    type: 'text',
                    text: '<function_calls>{"id":"call_snap_repaired","name":"read","arguments":{"path":"b.txt"}}</function_calls>'
                }]
            }
        ]);
        const res = await request(buildApp())
            .post(path)
            .set('Authorization', 'Bearer test-key')
            .set('anthropic-version', '2023-06-01')
            .send(payload);
        expect(res.statusCode).toBe(200);
        expect(res.text).not.toContain('malformed_external_tool_call');
        const calls = toolCallsFor(path, res.text);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ name: 'read' });
        expect(JSON.stringify(calls[0].arguments)).toContain('b.txt');
        expect(res.text).not.toContain('response.failed');
        expect(res.text).not.toMatch(/"error"\s*:\s*\{/);
    });
});
