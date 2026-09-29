import request from 'supertest';
import { jest } from '@jest/globals';

// Parity contract the user asked for: one simulated session-protocol
// transcript (the backend emits <function_calls> text) must surface as an
// equivalent tool call on every public protocol:
//   /v1/chat/completions -> message.tool_calls[] + finish_reason tool_calls
//   /v1/responses        -> output[] function_call item
//   /v1/messages         -> content[] tool_use block + stop_reason tool_use
// Non-stream everywhere for determinism.

const TOOL_TRANSCRIPT = '<function_calls>[{\"id\":\"call_read_1\",\"name\":\"read\",\"arguments\":{\"path\":\"/tmp/toolprobe.txt\"}}]</function_calls>';

const sdkMocks = {
    configProviders: jest.fn(async () => ({
        data: {
            providers: [{ id: 'opencode', models: { 'muse-spark-1.3-contributor-free': { name: 'Muse Spark' } } }]
        }
    })),
    configUpdate: jest.fn(async () => ({})),
    toolIds: jest.fn(async () => ({ data: ['read', 'bash', 'edit'] })),
    sessionCreate: jest.fn(async () => ({ data: { id: 'parity-session' } })),
    sessionPrompt: jest.fn(async () => ({
        data: { parts: [{ type: 'text', text: TOOL_TRANSCRIPT }] }
    })),
    sessionMessages: jest.fn(async () => ([
        { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: TOOL_TRANSCRIPT }] }
    ])),
    sessionDelete: jest.fn(async () => ({})),
    eventSubscribe: jest.fn(async () => ({
        stream: (async function* () {
            yield { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'parity-session' }, delta: TOOL_TRANSCRIPT } };
            yield { type: 'message.updated', properties: { info: { sessionID: 'parity-session', finish: 'stop' } } };
        })()
    }))
};

jest.unstable_mockModule('http', () => ({
    default: {
        get: jest.fn((url, options, callback) => {
            const response = {
                statusCode: 200,
                headers: {},
                on: jest.fn()
            };
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

let app;
beforeAll(() => {
    const config = {
        PORT: 10000,
        API_KEY: 'test-key',
        OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
        REQUEST_TIMEOUT_MS: 5000,
        DISABLE_TOOLS: false,
        DEBUG: false
    };
    app = createApp(config).app;
});

describe('tool-call protocol parity (session -> public protocols)', () => {
    test('chat completions returns OpenAI tool_calls', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/muse-spark-1.3-contributor-free',
                messages: [{ role: 'user', content: 'Read the probe file' }],
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'read',
                            description: 'Read a file',
                            parameters: { type: 'object', properties: { path: { type: 'string' } } }
                        }
                    }
                ]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.choices[0].finish_reason).toEqual('tool_calls');
        expect(res.body.choices[0].message.tool_calls).toEqual([
            {
                id: 'call_read_1',
                type: 'function',
                function: {
                    name: 'read',
                    arguments: JSON.stringify({ path: '/tmp/toolprobe.txt' })
                }
            }
        ]);
    });

    test('responses returns a function_call output item', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/muse-spark-1.3-contributor-free',
                input: 'Read the probe file',
                tools: [
                    {
                        type: 'function',
                        name: 'read',
                        description: 'Read a file',
                        parameters: { type: 'object', properties: { path: { type: 'string' } } }
                    }
                ]
            });

        expect(res.statusCode).toEqual(200);
        const calls = (res.body.output || []).filter((item) => item.type === 'function_call');
        expect(calls.length).toEqual(1);
        expect(calls[0].name).toEqual('read');
        expect(typeof calls[0].call_id).toBe('string');
        expect(JSON.parse(calls[0].arguments)).toEqual({ path: '/tmp/toolprobe.txt' });
    });

    test('messages returns a tool_use content block', async () => {
        const res = await request(app)
            .post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/muse-spark-1.3-contributor-free',
                max_tokens: 100,
                messages: [{ role: 'user', content: 'Read the probe file' }],
                tools: [{ name: 'read', input_schema: { type: 'object' } }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.stop_reason).toEqual('tool_use');
        const uses = (res.body.content || []).filter((block) => block.type === 'tool_use');
        expect(uses.length).toEqual(1);
        expect(uses[0].name).toEqual('read');
        expect(uses[0].input).toEqual({ path: '/tmp/toolprobe.txt' });
    });

    test('interactions passes text through (client function tools belong on /v1/responses)', async () => {
        // Intentional divergence, locked: interactions only accepts server-side
        // search tools; client-executed function tools are rejected with 400.
        const rejected = await request(app)
            .post('/v1beta/interactions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/muse-spark-1.3-contributor-free',
                input: 'Read the probe file',
                tools: [{ type: 'function', name: 'read' }]
            });
        expect(rejected.statusCode).toEqual(400);

        const res = await request(app)
            .post('/v1beta/interactions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/muse-spark-1.3-contributor-free',
                input: 'Read the probe file'
            });
        expect(res.statusCode).toEqual(200);
        expect(res.body.status).toEqual('completed');
    });
});
