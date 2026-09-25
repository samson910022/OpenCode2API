import request from 'supertest';
import { jest } from '@jest/globals';
import { buildExternalToolRegistry } from '../src/tool-runtime/registry.js';
import { normalizeExternalToolChoice, buildToolExposure, preflightExternalToolChoice } from '../src/tool-runtime/router.js';
import { evaluateToolPolicy } from '../src/tool-runtime/policy.js';
import { validateToolCall, validateToolCalls } from '../src/tool-runtime/validator.js';

const sdkMockDefaults = {
    configProviders: async () => ({
        data: {
            providers: [
                {
                    id: 'opencode',
                    models: {
                        'kimi-k2.5': { name: 'Kimi k2.5', release_date: '2024-01-15' },
                        'gpt-5-nano': { name: 'GPT-5 Nano', release_date: '2025-01-15' },
                        'gpt-4': { name: 'GPT-4', release_date: '2024-06-01' },
                        'muse-spark-1.3-contributor-free': { name: 'Muse Spark', release_date: '2026-01-15' }
                    }
                }
            ]
        }
    }),
    configUpdate: async () => ({}),
    toolIds: async () => ({
        data: ['web_fetch', 'filesystem', 'bash']
    }),
    sessionCreate: async () => ({
        data: { id: 'test-session-id' }
    }),
    sessionPrompt: async (args) => {
        const promptText = args.body.prompt || args.body.parts?.map(part => part.text || '').join(' ') || '';
        const parts = [{ type: 'text', text: 'Mock response' }];

        if (promptText.includes('reasoning')) {
            parts.unshift({ type: 'reasoning', text: 'Thinking process...' });
        }

        return { data: { parts } };
    },
    sessionMessages: async () => ([
        {
            info: { role: 'assistant', finish: 'stop' },
            parts: [
                { type: 'text', text: 'Mock response' }
            ]
        }
    ]),
    sessionDelete: async () => ({}),
    eventSubscribe: async () => {
        const sessionId = 'test-session-id';
        const mockEvents = [
            { type: 'message.part.updated', properties: { part: { type: 'reasoning', sessionID: sessionId }, delta: 'Thinking...' } },
            { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: sessionId }, delta: 'Mock' } },
            { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: sessionId }, delta: ' response' } },
            { type: 'message.updated', properties: { info: { sessionID: sessionId, finish: 'stop' } } }
        ];

        return {
            stream: (async function* () {
                for (const event of mockEvents) {
                    yield event;
                }
            })()
        };
    }
};

const sdkMocks = {
    configProviders: jest.fn(sdkMockDefaults.configProviders),
    configUpdate: jest.fn(sdkMockDefaults.configUpdate),
    toolIds: jest.fn(sdkMockDefaults.toolIds),
    sessionCreate: jest.fn(sdkMockDefaults.sessionCreate),
    sessionPrompt: jest.fn(sdkMockDefaults.sessionPrompt),
    sessionMessages: jest.fn(sdkMockDefaults.sessionMessages),
    sessionDelete: jest.fn(sdkMockDefaults.sessionDelete),
    eventSubscribe: jest.fn(sdkMockDefaults.eventSubscribe)
};

jest.unstable_mockModule('https', () => ({
    default: {
        get: jest.fn((url, options, callback) => {
            const res = {
                statusCode: 200,
                headers: { 'content-type': 'image/png' },
                on: jest.fn((event, handler) => {
                    if (event === 'data') handler(Buffer.from('fake-image-data'));
                    if (event === 'end') handler();
                })
            };
            callback(res);
            return {
                on: jest.fn(),
                destroy: jest.fn()
            };
        })
    }
}));

jest.unstable_mockModule('http', () => ({
    default: {
        get: jest.fn((url, options, callback) => {
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

jest.unstable_mockModule('@opencode-ai/sdk', () => ({
    createOpencodeClient: jest.fn(() => ({
        config: {
            providers: sdkMocks.configProviders,
            update: sdkMocks.configUpdate
        },
        tool: {
            ids: sdkMocks.toolIds
        },
        session: {
            create: sdkMocks.sessionCreate,
            prompt: sdkMocks.sessionPrompt,
            messages: sdkMocks.sessionMessages,
            delete: sdkMocks.sessionDelete
        },
        event: {
            subscribe: sdkMocks.eventSubscribe
        }
    }))
}));

const { createApp } = await import('../src/proxy.js');

describe('Phase 1A tool policy and exact tool choice', () => {
    test('keeps side effect and risk metadata without inferring confirmation', () => {
        const [tool] = buildExternalToolRegistry([{
            type: 'function',
            function: {
                name: 'delete_ticket',
                x_proxy_side_effect: 'delete',
                x_proxy_risk_level: 'critical'
            }
        }]);

        expect(tool.sideEffect).toBe('delete');
        expect(tool.riskLevel).toBe('critical');
        expect(tool.requiresConfirmation).toBe(false);
        expect(evaluateToolPolicy(tool, {}, { config: {} })).toMatchObject({ status: 'allow' });
    });

    test('requires confirmation only from explicit metadata or direct config', () => {
        const [metadataTool] = buildExternalToolRegistry([{
            type: 'function',
            function: { name: 'write_ticket', x_proxy_requires_confirmation: true }
        }]);
        const [configTool] = buildExternalToolRegistry([{
            type: 'function',
            function: { name: 'write_ticket' }
        }]);

        expect(evaluateToolPolicy(metadataTool, {}, { config: {} })).toMatchObject({ status: 'require_confirmation' });
        expect(evaluateToolPolicy(configTool, {}, {
            config: { EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR: ['write_ticket'] }
        })).toMatchObject({ status: 'require_confirmation' });
    });

    test('denylist wins and a nonempty allowlist restricts tools', () => {
        const [tool] = buildExternalToolRegistry([{ type: 'function', name: 'delete_ticket' }]);
        const denied = evaluateToolPolicy(tool, {}, {
            config: {
                EXTERNAL_TOOL_ALLOWLIST: ['delete_ticket'],
                EXTERNAL_TOOL_DENYLIST: ['delete_ticket']
            }
        });
        const notAllowed = evaluateToolPolicy(tool, {}, {
            config: { EXTERNAL_TOOL_ALLOWLIST: ['read_ticket'] }
        });

        expect(denied).toMatchObject({ status: 'deny', code: 'tool_denied_by_policy' });
        expect(notAllowed).toMatchObject({ status: 'deny', code: 'tool_not_allowed_by_policy' });
    });

    test('preflights exact names and rejects unknown, disabled, and malformed choices', () => {
        const registry = buildExternalToolRegistry([
            { type: 'function', name: 'read' },
            { type: 'function', name: 'off', enabled: false }
        ]);

        expect(preflightExternalToolChoice({ type: 'function', name: 'read' }, registry)).toEqual({
            ok: true,
            normalized: { mode: 'required', requiredTool: 'external__read' }
        });
        expect(preflightExternalToolChoice({ type: 'function', name: 'external__read' }, registry)).toEqual({
            ok: true,
            normalized: { mode: 'required', requiredTool: 'external__read' }
        });
        expect(preflightExternalToolChoice({ type: 'function', name: 'READ' }, registry)).toMatchObject({ ok: false, code: 'unknown_tool' });
        expect(preflightExternalToolChoice({ type: 'function', name: 'off' }, registry)).toMatchObject({ ok: false, code: 'tool_disabled' });
        expect(preflightExternalToolChoice({ type: 'function' }, registry)).toMatchObject({ ok: false, code: 'invalid_tool_choice' });
        expect(preflightExternalToolChoice('none', registry)).toEqual({ ok: true, normalized: { mode: 'none', requiredTool: null } });
        expect(preflightExternalToolChoice('required', registry)).toEqual({ ok: true, normalized: { mode: 'required', requiredTool: null } });
        expect(preflightExternalToolChoice('required', [])).toEqual({ ok: true, normalized: { mode: 'auto', requiredTool: null } });
        expect(preflightExternalToolChoice('required', [registry[1]])).toEqual({ ok: true, normalized: { mode: 'auto', requiredTool: null } });
        expect(preflightExternalToolChoice({ type: 'any' }, [])).toEqual({ ok: true, normalized: { mode: 'auto', requiredTool: null } });
    });
});

describe('Proxy OpenAI API', () => {
    let app;

    beforeAll(() => {
        process.env.OPENCODE_SERVER_URL = 'http://127.0.0.1:10001';
        process.env.OPENCODE_PROXY_DEBUG = 'false';
    });

    beforeEach(() => {
        jest.clearAllMocks();
        Object.entries(sdkMockDefaults).forEach(([name, implementation]) => {
            sdkMocks[name].mockReset();
            sdkMocks[name].mockImplementation(implementation);
        });
        const config = {
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: false,
            DEBUG: false
        };
        const result = createApp(config);
        app = result.app;
    });

    test('POST /v1/chat/completions keeps normal non-tool responses unchanged when no external tools are provided', async () => {
        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [
                    { type: 'text', text: 'Plain assistant reply' }
                ]
            }
        ]);

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Hello' }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('chat.completion');
        expect(res.body.choices[0].finish_reason).toEqual('stop');
        expect(res.body.choices[0].message).toEqual({
            role: 'assistant',
            content: 'Plain assistant reply'
        });
        expect(res.body.choices[0].message.tool_calls).toBeUndefined();
    });

    test('POST /v1/chat/completions returns OpenAI-compatible tool_calls for external tools', async () => {
        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [
                    {
                        type: 'text',
                        text: '<function_calls>[{"id":"call_weather_1","name":"weather_lookup","arguments":{"city":"Tokyo","unit":"celsius"}}]</function_calls>'
                    }
                ]
            }
        ]);

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'weather_lookup',
                            description: 'Look up weather by city',
                            parameters: {
                                type: 'object',
                                properties: {
                                    city: { type: 'string' },
                                    unit: { type: 'string' }
                                },
                                required: ['city']
                            }
                        }
                    }
                ]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.choices[0].finish_reason).toEqual('tool_calls');
        expect(res.body.choices[0].message.role).toEqual('assistant');
        expect(res.body.choices[0].message.content).toBeNull();
        expect(res.body.choices[0].message.tool_calls).toEqual([
            {
                id: 'call_weather_1',
                type: 'function',
                function: {
                    name: 'weather_lookup',
                    arguments: JSON.stringify({ city: 'Tokyo', unit: 'celsius' })
                }
            }
        ]);

        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('External tools are virtualized by this proxy. They are not OpenCode tools.');
        expect(promptCall.body.system).toContain('external__weather_lookup');
        expect(promptCall.body.system).toContain('client_name');
    });

    test('POST /v1/chat/completions keeps external tool schema when OMIT_SYSTEM_PROMPT is true', async () => {
        const omitApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            OMIT_SYSTEM_PROMPT: true,
            DEBUG: false
        }).app;

        const res = await request(omitApp)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [
                    { role: 'system', content: 'user-system-secret' },
                    { role: 'user', content: 'Read a.txt' }
                ],
                tools: [{
                    type: 'function',
                    function: {
                        name: 'read',
                        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
                    }
                }]
            });

        expect(res.statusCode).toBe(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).not.toContain('user-system-secret');
        expect(promptCall.body.system).toContain('external__read');
        expect(promptCall.body.system).toContain('"path"');
    });

    test('POST /v1/chat/completions rejects an unknown specific tool choice', async () => {
        sdkMocks.sessionPrompt.mockClear();
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Use a tool' }],
                tools: [{ type: 'function', function: { name: 'read' } }],
                tool_choice: { type: 'function', name: 'missing' }
            });

        expect(res.statusCode).toBe(400);
        expect(res.body.error.type).toBe('invalid_request_error');
        expect(res.body.error.message).toContain('unknown tool');
        expect(sdkMocks.sessionPrompt).not.toHaveBeenCalled();
    });

    test('POST /v1/chat/completions keeps external web_fetch isolated from internal tool semantics', async () => {
        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [
                    {
                        type: 'text',
                        text: '<function_calls>[{"id":"call_web_fetch_1","name":"web_fetch","arguments":{"url":"https://example.com"}}]</function_calls>'
                    }
                ]
            }
        ]);

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Fetch https://example.com' }],
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'web_fetch',
                            description: 'External fetch tool',
                            parameters: {
                                type: 'object',
                                properties: {
                                    url: { type: 'string' }
                                },
                                required: ['url']
                            }
                        }
                    }
                ]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.choices[0].finish_reason).toEqual('tool_calls');
        expect(res.body.choices[0].message.tool_calls).toEqual([
            {
                id: 'call_web_fetch_1',
                type: 'function',
                function: {
                    name: 'web_fetch',
                    arguments: JSON.stringify({ url: 'https://example.com' })
                }
            }
        ]);

        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('Use only the namespaced names listed below. Do not use original client tool names inside function calls.');
        expect(promptCall.body.system).toContain('external__web_fetch');
        expect(promptCall.body.tools).toBeUndefined();
        expect(sdkMocks.toolIds).not.toHaveBeenCalled();
    });

    test('POST /v1/chat/completions parses <function=name>/<parameter=key> tool markup and normalizes the tool name', async () => {
        // Regression test for issue #6: models emit their native <function=webfetch> dialect
        // (with a name that drops the request's underscore) inside <tool_call> markup. This
        // must surface as a proper OpenAI `tool_calls` array with `finish_reason: tool_calls`,
        // with the reasoning separated into `reasoning_content` and the markup stripped from
        // `content`.
        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [
                    { type: 'reasoning', text: 'The user wants the page title. Use the fetch tool.' },
                    {
                        type: 'text',
                        text: '<tool_call>\n<function=webfetch>\n<parameter=url>https://example.com</parameter>\n<parameter=format>html</parameter>\n</function>\n</tool_call>'
                    }
                ]
            }
        ]);

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Fetch https://example.com title' }],
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'web_fetch',
                            description: 'Fetch a URL',
                            parameters: {
                                type: 'object',
                                properties: {
                                    url: { type: 'string' }
                                },
                                required: ['url']
                            }
                        }
                    }
                ]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.choices[0].finish_reason).toEqual('tool_calls');
        expect(res.body.choices[0].message.content).toBeNull();
        expect(res.body.choices[0].message.reasoning_content).toContain('The user wants the page title');
        expect(res.body.choices[0].message.tool_calls).toHaveLength(1);
        expect(res.body.choices[0].message.tool_calls[0].function.name).toEqual('web_fetch');
        expect(JSON.parse(res.body.choices[0].message.tool_calls[0].function.arguments)).toMatchObject({ url: 'https://example.com' });
    });

    test('POST /v1/chat/completions enables internal allowlist tools when client tools are omitted', async () => {
        const internalApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            INTERNAL_ALLOWED_TOOLS: ['web_fetch', 'filesystem']
        }).app;

        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [{ type: 'text', text: 'Fetched content summary' }]
            }
        ]);

        const res = await request(internalApp)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Fetch https://example.com' }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.choices[0].finish_reason).toEqual('stop');
        expect(res.body.choices[0].message).toEqual({
            role: 'assistant',
            content: 'Fetched content summary'
        });

        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('You may use only these built-in tools when truly required: web_fetch, filesystem');
        expect(promptCall.body.system).not.toContain('External tools are virtualized by this proxy. They are not OpenCode tools.');
        expect(promptCall.body.tools).toEqual({
            web_fetch: true,
            filesystem: true,
            bash: false
        });
        expect(sdkMocks.toolIds).toHaveBeenCalledTimes(1);
    });

    test('POST /v1/chat/completions preserves backward compatibility for INTERNAL_WEB_FETCH_ENABLED', async () => {
        const internalApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            INTERNAL_WEB_FETCH_ENABLED: true
        }).app;

        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [{ type: 'text', text: 'Fetched content summary' }]
            }
        ]);

        const res = await request(internalApp)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Fetch https://example.com' }]
            });

        expect(res.statusCode).toEqual(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('You may use only these built-in tools when truly required: web_fetch');
        expect(promptCall.body.tools).toEqual({
            web_fetch: true,
            filesystem: false,
            bash: false
        });
    });

    test('POST /v1/chat/completions falls back to fully disabled native tools when internal allowlist tools are unavailable', async () => {
        const internalApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            INTERNAL_ALLOWED_TOOLS: ['web_fetch', 'filesystem']
        }).app;
        sdkMocks.toolIds.mockResolvedValueOnce({ data: ['bash'] });
        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [{ type: 'text', text: 'Live tool access is unavailable.' }]
            }
        ]);

        const res = await request(internalApp)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Fetch https://example.com' }]
            });

        expect(res.statusCode).toEqual(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.tools).toEqual({
            bash: false
        });
    });

    test('POST /v1/chat/completions omits all-false tools map for free-tier models (Stage-5 gate)', async () => {
        const freeApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false
        }).app;
        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [{ type: 'text', text: 'Free tier answer' }]
            }
        ]);

        const res = await request(freeApp)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/muse-spark-1.3-contributor-free',
                messages: [{ role: 'user', content: 'Hi' }]
            });

        expect(res.statusCode).toEqual(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.tools).toBeUndefined();
        expect(promptCall.body.system).toContain('Tools are disabled');
    });

    test('POST /v1/chat/completions strips tool-call markup from output when DISABLE_TOOLS=true', async () => {
        const lockedApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false
        }).app;
        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [
                    {
                        type: 'text',
                        text: 'Here is the summary. <function_calls>{"name":"bash","arguments":{"command":"ls"}}</function_calls>'
                    }
                ]
            }
        ]);

        const res = await request(lockedApp)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'List files' }]
            });

        expect(res.statusCode).toEqual(200);
        const content = res.body.choices[0].message.content;
        expect(content).toContain('Here is the summary.');
        expect(content).not.toContain('<function_calls>');
        expect(content).not.toContain('function_calls');
    });

    test('POST /v1/chat/completions applies request-level allowlist narrowing (intersection)', async () => {
        const internalApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            INTERNAL_ALLOWED_TOOLS: ['web_fetch', 'filesystem', 'bash']
        }).app;

        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [{ type: 'text', text: 'Narrowed tool access' }]
            }
        ]);

        const res = await request(internalApp)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Use filesystem' }],
                opencode: {
                    internal_allowed_tools: ['filesystem', 'unconfigured_tool']
                }
            });

        expect(res.statusCode).toEqual(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('You may use only these built-in tools when truly required: filesystem');
        expect(promptCall.body.tools).toEqual({
            web_fetch: false,
            filesystem: true,
            bash: false
        });
    });

    test('POST /v1/chat/completions ignores request-level allowlist when external tools are present', async () => {
        const internalApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            INTERNAL_ALLOWED_TOOLS: ['filesystem']
        }).app;

        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [{ type: 'text', text: 'External bridge active' }]
            }
        ]);

        const res = await request(internalApp)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Use external tool' }],
                tools: [{ type: 'function', function: { name: 'external_fetch', description: 'test' } }],
                opencode: {
                    internal_allowed_tools: ['filesystem']
                }
            });

        expect(res.statusCode).toEqual(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('External tools are virtualized by this proxy');
        expect(promptCall.body.system).not.toContain('You may use only these built-in tools');
        expect(promptCall.body.tools).toEqual({
            web_fetch: false,
            filesystem: false,
            bash: false
        });
    });

    test('GET /health/details returns diagnostics when enabled and authorized', async () => {
        const diagnosticsApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            INTERNAL_ALLOWED_TOOLS: ['web_fetch', 'filesystem'],
            HEALTH_DETAILS_ENABLED: true,
            HEALTH_DETAILS_REQUIRE_AUTH: true
        }).app;

        const res = await request(diagnosticsApp)
            .get('/health/details')
            .set('Authorization', 'Bearer test-key');

        expect(res.statusCode).toEqual(200);
        expect(res.body.internal_tools.config.allowed_tools).toEqual(['web_fetch', 'filesystem']);
        expect(res.body.internal_tools.audit.fields).toEqual(expect.arrayContaining([
            'requestedAllowlist',
            'allowedToolNames',
            'deniedRequestedTools',
            'resolutionPath',
            'resultingMode'
        ]));
    });

    test('GET /health/details returns 401 when auth is required and missing', async () => {
        const diagnosticsApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            HEALTH_DETAILS_ENABLED: true,
            HEALTH_DETAILS_REQUIRE_AUTH: true
        }).app;

        const res = await request(diagnosticsApp).get('/health/details');
        expect(res.statusCode).toEqual(401);
    });

    test('GET /health/details returns 404 when diagnostics are disabled', async () => {
        const diagnosticsApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            HEALTH_DETAILS_ENABLED: false
        }).app;

        const res = await request(diagnosticsApp).get('/health/details');
        expect(res.statusCode).toEqual(404);
    });

    test('GET /metrics returns prometheus text when enabled and authorized', async () => {
        const metricsApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            METRICS_ENABLED: true,
            METRICS_REQUIRE_AUTH: true
        }).app;

        const res = await request(metricsApp)
            .get('/metrics')
            .set('Authorization', 'Bearer test-key');

        expect(res.statusCode).toEqual(200);
        expect(res.header['content-type']).toContain('text/plain');
        expect(res.text).toContain('opencode_internal_tool_mode_requests_total');
        expect(res.text).toContain('opencode_internal_tool_discovery_failures_total');
    });

    test('GET /metrics returns 401 when auth is required and missing', async () => {
        const metricsApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            METRICS_ENABLED: true,
            METRICS_REQUIRE_AUTH: true
        }).app;

        const res = await request(metricsApp).get('/metrics');
        expect(res.statusCode).toEqual(401);
    });

    test('GET /metrics returns 404 when metrics are disabled', async () => {
        const metricsApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            METRICS_ENABLED: false
        }).app;

        const res = await request(metricsApp).get('/metrics');
        expect(res.statusCode).toEqual(404);
    });

    test('POST /v1/chat/completions request-level narrowing emits richer audit fields in diagnostics-aware runtime', async () => {
        const internalApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: true,
            INTERNAL_ALLOWED_TOOLS: ['web_fetch', 'filesystem', 'bash']
        }).app;

        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [{ type: 'text', text: 'Narrowed tool access' }]
            }
        ]);

        const res = await request(internalApp)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Use filesystem' }],
                opencode: {
                    internal_allowed_tools: ['filesystem', 'unconfigured_tool']
                }
            });

        expect(res.statusCode).toEqual(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('You may use only these built-in tools when truly required: filesystem');
        expect(promptCall.body.tools).toEqual({
            web_fetch: false,
            filesystem: true,
            bash: false
        });
    });

    test('POST /v1/chat/completions continues after tool result messages with matching tool_call_id', async () => {
        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [
                    { type: 'text', text: 'The weather in Tokyo is 22°C and sunny.' }
                ]
            }
        ]);

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'weather_lookup',
                            description: 'Look up weather by city',
                            parameters: {
                                type: 'object',
                                properties: { city: { type: 'string' } },
                                required: ['city']
                            }
                        }
                    }
                ],
                messages: [
                    { role: 'user', content: 'What is the weather in Tokyo?' },
                    {
                        role: 'assistant',
                        content: null,
                        tool_calls: [
                            {
                                id: 'call_weather_1',
                                type: 'function',
                                function: {
                                    name: 'weather_lookup',
                                    arguments: JSON.stringify({ city: 'Tokyo' })
                                }
                            }
                        ]
                    },
                    {
                        role: 'tool',
                        tool_call_id: 'call_weather_1',
                        content: '22°C and sunny',
                        name: 'weather_lookup'
                    }
                ]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.choices[0].finish_reason).toEqual('stop');
        expect(res.body.choices[0].message).toEqual({
            role: 'assistant',
            content: 'The weather in Tokyo is 22°C and sunny.'
        });

        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.parts).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'text',
                text: expect.stringContaining('ASSISTANT: <function_calls>')
            }),
            expect.objectContaining({
                type: 'text',
                text: 'TOOL_RESULT: {"tool_call_id":"call_weather_1","name":"external__weather_lookup","content":"22°C and sunny"}'
            })
        ]));
        expect(promptCall.body.parts[1].text).toContain('external__weather_lookup');
        expect(promptCall.body.parts[1].text).toContain('call_weather_1');
        expect(promptCall.body.parts[1].text).toContain('{\\"city\\":\\"Tokyo\\"}');
    });

    test('POST /v1/chat/completions preserves an explicit empty tool result', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                tools: [{ type: 'function', function: { name: 'read' } }],
                messages: [
                    { role: 'user', content: 'Read a.txt' },
                    {
                        role: 'assistant',
                        content: null,
                        tool_calls: [{ id: 'call_read_1', type: 'function', function: { name: 'read', arguments: '{}' } }]
                    },
                    { role: 'tool', tool_call_id: 'call_read_1', name: 'read', content: '' }
                ]
            });

        expect(res.statusCode).toBe(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.parts).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'text',
                text: 'TOOL_RESULT: {"tool_call_id":"call_read_1","name":"external__read","content":""}'
            })
        ]));
    });

    test('GET /health returns status ok', async () => {
        const res = await request(app).get('/health');
        expect(res.statusCode).toEqual(200);
        expect(res.body.status).toEqual('ok');
    });

    test('GET /v1/models returns model list', async () => {
        const res = await request(app)
            .get('/v1/models')
            .set('Authorization', 'Bearer test-key');

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('list');
        expect(res.body.data[0].id).toEqual('opencode/kimi-k2.5');
    });

    test('POST /v1/chat/completions returns chat completion', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Hello' }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('chat.completion');
        expect(res.body.usage).toBeDefined();
        expect(res.body.usage.prompt_tokens).toBeGreaterThan(0);
    });

    test('POST /v1/chat/completions supports streaming', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Hello' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.header['content-type']).toContain('text/event-stream');
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/chat/completions streaming separates reasoning and answer from message.part.delta events', async () => {
        // Regression test for issue #9: newer OpenCode servers stream deltas as
        // `message.part.delta` events that carry only a `partID`. The part type is announced
        // by the preceding `message.part.updated` event. Without resolving the partID to its
        // type, reasoning and answer text could not be told apart and the answer was dropped.
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => {
            const sessionId = 'test-session-id';
            const mockEvents = [
                {
                    type: 'message.part.updated',
                    properties: { part: { id: 'part-reasoning', type: 'reasoning', sessionID: sessionId } }
                },
                { type: 'message.part.delta', properties: { sessionID: sessionId, partID: 'part-reasoning', field: 'text', delta: '3+5=' } },
                {
                    type: 'message.part.updated',
                    properties: { part: { id: 'part-text', type: 'text', sessionID: sessionId } }
                },
                { type: 'message.part.delta', properties: { sessionID: sessionId, partID: 'part-text', field: 'text', delta: '8' } },
                { type: 'message.updated', properties: { info: { sessionID: sessionId, finish: 'stop' } } }
            ];
            return {
                stream: (async function* () {
                    for (const event of mockEvents) yield event;
                })()
            };
        });

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'What is 3+5?' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);

        const deltas = [];
        for (const line of res.text.split('\n')) {
            if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
            const json = JSON.parse(line.slice(5).trim());
            const delta = json.choices?.[0]?.delta;
            if (delta) deltas.push(delta);
        }
        const reasoning = deltas.filter((d) => d.reasoning_content).map((d) => d.reasoning_content).join('');
        const content = deltas.filter((d) => d.content).map((d) => d.content).join('');
        expect(reasoning).toContain('3+5=');
        expect(content).toContain('8');
        expect(content).not.toContain('3+5=');
    });

    test('POST /v1/chat/completions streaming recovers answer from snapshot when every delta is tagged reasoning', async () => {
        // Regression test for issue #9: some OpenCode servers tag every streaming delta as
        // reasoning (even the final answer), leaving `content` empty. The message snapshot
        // separates reasoning and text correctly, so the proxy reconciles the missing answer
        // from the snapshot instead of returning an empty content.
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => {
            const sessionId = 'test-session-id';
            const mockEvents = [
                { type: 'message.part.updated', properties: { part: { type: 'reasoning', sessionID: sessionId }, delta: 'Let me think: ' } },
                { type: 'message.part.updated', properties: { part: { type: 'reasoning', sessionID: sessionId }, delta: '8' } },
                { type: 'message.updated', properties: { info: { sessionID: sessionId, finish: 'stop' } } }
            ];
            return {
                stream: (async function* () {
                    for (const event of mockEvents) yield event;
                })()
            };
        });
        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [
                    { type: 'reasoning', text: 'Let me think: ' },
                    { type: 'text', text: '8' }
                ]
            }
        ]);

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'What is 3+5?' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);

        const deltas = [];
        for (const line of res.text.split('\n')) {
            if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
            const json = JSON.parse(line.slice(5).trim());
            const delta = json.choices?.[0]?.delta;
            if (delta) deltas.push(delta);
        }
        const reasoning = deltas.filter((d) => d.reasoning_content).map((d) => d.reasoning_content).join('');
        const content = deltas.filter((d) => d.content).map((d) => d.content).join('');
        expect(reasoning).toContain('Let me think');
        // The answer must still reach the client even though the stream tagged it as reasoning.
        expect(content).toContain('8');
    });

    test('POST /v1/chat/completions streaming waits for internal tool execution instead of truncating', async () => {
        // Regression test for issue #3: a streaming response that triggers an internal tool
        // call (e.g. web_fetch) was truncated at the planning text. The collector resolved on
        // an intermediate 'stop' snapshot (or idle-timed-out) while the tool was still running,
        // so the final answer was dropped. The stream must stay open until the answer arrives.
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => {
            const sessionId = 'test-session-id';
            const mockEvents = [
                {
                    type: 'message.part.updated',
                    properties: { part: { type: 'text', sessionID: sessionId }, delta: 'I need to search. ' }
                },
                {
                    type: 'message.updated',
                    properties: {
                        info: {
                            sessionID: sessionId,
                            finish: 'stop',
                            parts: [
                                { type: 'text', text: 'I need to search. ' },
                                { type: 'tool', id: 'call_internal_1', tool: 'web_fetch', state: { status: 'pending', input: { url: 'https://example.com/weather' } } }
                            ]
                        }
                    }
                },
                {
                    type: 'message.part.updated',
                    properties: { part: { type: 'text', sessionID: sessionId }, delta: 'The weather is 14C.' }
                },
                {
                    type: 'message.updated',
                    properties: {
                        info: {
                            sessionID: sessionId,
                            finish: 'stop',
                            parts: [
                                { type: 'tool', id: 'call_internal_1', tool: 'web_fetch', state: { status: 'completed', input: { url: 'https://example.com/weather' }, output: '14C' } },
                                { type: 'text', text: 'The weather is 14C.' }
                            ]
                        }
                    }
                }
            ];
            return {
                stream: (async function* () {
                    for (const event of mockEvents) {
                        yield event;
                    }
                })()
            };
        });

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.text).toContain('data: [DONE]');

        const chunks = res.text.split('\n').filter(l => l.startsWith('data:') && !l.includes('[DONE]'));
        let streamed = '';
        for (const line of chunks) {
            const json = JSON.parse(line.slice(5).trim());
            const delta = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
            if (delta) streamed += delta;
        }
        // The full answer must be streamed, not just the planning text.
        expect(streamed).toEqual('I need to search. The weather is 14C.');
    });

    test('polling fallback waits for the assistant message to finish instead of returning a partial snapshot', async () => {
        // Regression test: pollForAssistantResponse returned as soon as any part had text.
        // A reasoning model emits its reasoning part before the text part, so the first
        // snapshot is reasoning-only and unfinished. Returning it dropped the entire answer
        // and produced a response consisting of nothing but a thinking block.
        let call = 0;
        sdkMocks.sessionMessages.mockImplementation(async () => {
            call += 1;
            if (call < 3) {
                return [{
                    info: { role: 'assistant' },
                    parts: [{ type: 'reasoning', text: 'Let me read the file.' }]
                }];
            }
            return [{
                info: { role: 'assistant', finish: 'stop' },
                parts: [
                    { type: 'reasoning', text: 'Let me read the file.' },
                    { type: 'text', text: 'The file says hello.' }
                ]
            }];
        });
        // Force the polling fallback: the event stream yields nothing usable.
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => {
            throw new Error('event stream unavailable');
        });

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Read a.txt' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        let streamed = '';
        for (const line of res.text.split('\n')) {
            if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
            const json = JSON.parse(line.slice(5).trim());
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) streamed += delta;
        }
        expect(streamed).toContain('The file says hello.');
        expect(call).toBeGreaterThanOrEqual(3);
    });

    test('polling fallback treats finish=tool as unfinished and keeps waiting', async () => {
        // finish === 'tool' is an intermediate turn that pauses for a tool result. Treating
        // it as terminal cut the response off before the post-tool answer arrived.
        let call = 0;
        sdkMocks.sessionMessages.mockImplementation(async () => {
            call += 1;
            if (call < 2) {
                return [{
                    info: { role: 'assistant', finish: 'tool' },
                    parts: [{ type: 'text', text: 'Calling a tool. ' }]
                }];
            }
            return [{
                info: { role: 'assistant', finish: 'stop' },
                parts: [{ type: 'text', text: 'Calling a tool. Done: 42.' }]
            }];
        });
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => {
            throw new Error('event stream unavailable');
        });

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Compute something' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        let streamed = '';
        for (const line of res.text.split('\n')) {
            if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
            const json = JSON.parse(line.slice(5).trim());
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) streamed += delta;
        }
        expect(streamed).toContain('Done: 42.');
    });

    test('polling fallback returns the last partial snapshot when the timeout is reached', async () => {
        // If the message never reports completion, the partial text still beats throwing a
        // timeout error and losing everything the model produced.
        sdkMocks.sessionMessages.mockImplementation(async () => ([{
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'Partial answer that never completes' }]
        }]));
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => {
            throw new Error('event stream unavailable');
        });

        const shortTimeoutApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 1200,
            DISABLE_TOOLS: false,
            DEBUG: false
        }).app;

        const res = await request(shortTimeoutApp)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Hello' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.text).toContain('Partial answer that never completes');
    });

    test('streaming surfaces an upstream message error without waiting out the first-delta window', async () => {
        // A message that the upstream aborts never emits another delta. The collector used to
        // sit through the entire first-delta timeout before polling rediscovered the error.
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => {
            const sessionId = 'test-session-id';
            const mockEvents = [{
                type: 'message.updated',
                properties: {
                    info: {
                        sessionID: sessionId,
                        error: { name: 'MessageAbortedError', data: { message: 'Aborted' } }
                    }
                }
            }];
            return {
                stream: (async function* () {
                    for (const event of mockEvents) yield event;
                })()
            };
        });
        sdkMocks.sessionMessages.mockImplementation(async () => ([{
            info: { role: 'assistant', error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } },
            parts: []
        }]));

        const startedAt = Date.now();
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Hello' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.text).toContain('MessageAbortedError');
        // Must not have burned the full first-delta window (30s by default).
        expect(Date.now() - startedAt).toBeLessThan(5000);
    });

    test('POST /v1/chat/completions streams reasoning_content separately from content', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Test with reasoning' }],
                stream: true
            });

        expect(res.text).toContain('reasoning_content');
        // Reasoning must not be wrapped in <think> tags inside content.
        expect(res.text).not.toContain('<think>');
        expect(res.text).not.toContain('</think>');
    });

    test('POST /v1/chat/completions streaming keeps reasoning out of content', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Test with reasoning' }],
                stream: true
            });

        const deltas = [];
        for (const line of res.text.split('\n')) {
            if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
            const json = JSON.parse(line.slice(5).trim());
            const delta = json.choices?.[0]?.delta;
            if (delta) deltas.push(delta);
        }
        const reasoning = deltas.filter((d) => d.reasoning_content).map((d) => d.reasoning_content).join('');
        const content = deltas.filter((d) => d.content).map((d) => d.content).join('');
        expect(reasoning).toContain('Thinking');
        expect(content).toContain('Mock response');
        // Reasoning and answer must never bleed into each other.
        expect(content).not.toContain('Thinking');
        expect(reasoning).not.toContain('Mock');
    });

    test('POST /v1/chat/completions non-stream returns reasoning_content without think wrapping', async () => {
        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [
                    { type: 'reasoning', text: 'Thinking process...' },
                    { type: 'text', text: 'Plain assistant reply' }
                ]
            }
        ]);

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Test with reasoning' }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.choices[0].message.content).toEqual('Plain assistant reply');
        expect(res.body.choices[0].message.reasoning_content).toEqual('Thinking process...');
        expect(res.body.choices[0].message.content).not.toContain('<think>');
    });

    test('POST /v1/chat/completions supports reasoning_effort', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Hello' }],
                reasoning_effort: 'high'
            });

        expect(res.statusCode).toEqual(200);
    });

    test('POST /v1/chat/completions supports reasoning object', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Hello' }],
                reasoning: { effort: 'high' }
            });

        expect(res.statusCode).toEqual(200);
    });

    test('POST /v1/chat/completions emits tool_calls finish_reason in streaming for external tools', async () => {
        sdkMocks.eventSubscribe.mockResolvedValueOnce({
            stream: (async function* () {
                const sessionId = 'test-session-id';
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: { type: 'reasoning', sessionID: sessionId },
                        delta: 'Thinking...'
                    }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: { type: 'text', sessionID: sessionId },
                        delta: '<function_calls>[{"id":"call_weather_stream_1","name":"external__weather_lookup","arguments":{"city":"Tokyo","unit":"celsius"}}]</function_calls>'
                    }
                };
                yield {
                    type: 'message.updated',
                    properties: { info: { sessionID: sessionId, finish: 'stop' } }
                };
            })()
        });

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                stream: true,
                messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'weather_lookup',
                            description: 'Look up weather by city',
                            parameters: {
                                type: 'object',
                                properties: {
                                    city: { type: 'string' },
                                    unit: { type: 'string' }
                                },
                                required: ['city']
                            }
                        }
                    }
                ]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.header['content-type']).toContain('text/event-stream');
        expect(res.text).toContain('"tool_calls"');
        expect(res.text).toContain('"finish_reason":"tool_calls"');
        expect(res.text).not.toContain('external__weather_lookup');
        expect(res.text).toContain('"name":"weather_lookup"');
    });

    test('POST /v1/chat/completions strips denied external tool calls from non-stream output', async () => {
        const restrictedApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: false,
            DEBUG: false,
            EXTERNAL_TOOL_DENYLIST: ['delete_ticket']
        }).app;

        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [
                    {
                        type: 'text',
                        text: '<function_calls>[{"id":"call_delete_1","name":"delete_ticket","arguments":{"id":"123"}}]</function_calls>'
                    }
                ]
            }
        ]);

        const res = await request(restrictedApp)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Delete ticket 123' }],
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'delete_ticket',
                            description: 'Delete a ticket',
                            parameters: {
                                type: 'object',
                                properties: { id: { type: 'string' } },
                                required: ['id']
                            }
                        }
                    }
                ]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.choices[0].finish_reason).toEqual('stop');
        expect(res.body.choices[0].message.tool_calls).toBeUndefined();
        expect(res.body.choices[0].message.content).toEqual('');
    });

    test('POST /v1/responses returns assistant response', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'Hello from responses'
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('response');
        expect(res.body.output[0].content[0].text).toBeDefined();
    });

    test('POST /v1/responses reports mid-stream failures on the open stream instead of crashing', async () => {
        // Regression test: the /v1/responses catch block called res.json() unconditionally.
        // After the SSE headers were sent that throws ERR_HTTP_HEADERS_SENT, which escaped the
        // async handler as an unhandled rejection and killed the proxy process. Users saw the
        // service "stop working" mid-session; the container restarted behind them.
        sdkMocks.sessionMessages.mockImplementation(async () => {
            throw new Error('upstream exploded after headers were sent');
        });
        sdkMocks.sessionPrompt.mockImplementation(async () => {
            throw new Error('upstream exploded after headers were sent');
        });
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => {
            throw new Error('event stream unavailable');
        });

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'Hello',
                stream: true
            });

        // Headers were already flushed as SSE, so the status stays 200 and the failure is
        // reported as a stream event. The important part is that no exception escapes.
        expect(res.statusCode).toEqual(200);
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/responses accepts chat-style input array', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: [{ role: 'user', content: 'Hello from chat-style input' }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('response');
        expect(res.body.output[0].content[0].text).toBeDefined();
    });

    test('POST /v1/responses accepts chat-style messages fallback', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Hello from messages fallback' }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('response');
        expect(res.body.output[0].content[0].text).toBeDefined();
    });

    test('POST /v1/responses returns external function_call output items for non-stream requests', async () => {
        sdkMocks.sessionPrompt.mockResolvedValueOnce({
            data: {
                parts: [
                    {
                        type: 'text',
                        text: '<function_calls>[{"id":"resp_call_weather_1","name":"external__weather_lookup","arguments":{"city":"Tokyo","unit":"celsius"}}]</function_calls>'
                    }
                ]
            }
        });

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'What is the weather in Tokyo?',
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'weather_lookup',
                            description: 'Look up weather by city',
                            parameters: {
                                type: 'object',
                                properties: {
                                    city: { type: 'string' },
                                    unit: { type: 'string' }
                                },
                                required: ['city']
                            }
                        }
                    }
                ]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('response');
        expect(res.body.output).toEqual([
            {
                type: 'function_call',
                status: 'completed',
                id: 'resp_call_weather_1',
                call_id: 'resp_call_weather_1',
                name: 'weather_lookup',
                arguments: JSON.stringify({ city: 'Tokyo', unit: 'celsius' })
            }
        ]);

        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('External tools are virtualized by this proxy. They are not OpenCode tools.');
        expect(promptCall.body.system).toContain('external__weather_lookup');
        expect(promptCall.body.system).toContain('client_name');
    });

    test('POST /v1/responses keeps external web_fetch isolated from internal tool semantics', async () => {
        sdkMocks.sessionPrompt.mockResolvedValueOnce({
            data: {
                parts: [
                    {
                        type: 'text',
                        text: '<function_calls>[{"id":"resp_call_web_fetch_1","name":"external__web_fetch","arguments":{"url":"https://example.com"}}]</function_calls>'
                    }
                ]
            }
        });

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'Fetch https://example.com',
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'web_fetch',
                            description: 'External fetch tool',
                            parameters: {
                                type: 'object',
                                properties: {
                                    url: { type: 'string' }
                                },
                                required: ['url']
                            }
                        }
                    }
                ]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.output).toEqual([
            {
                type: 'function_call',
                status: 'completed',
                id: 'resp_call_web_fetch_1',
                call_id: 'resp_call_web_fetch_1',
                name: 'web_fetch',
                arguments: JSON.stringify({ url: 'https://example.com' })
            }
        ]);

        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('Use only the namespaced names listed below. Do not use original client tool names inside function calls.');
        expect(promptCall.body.system).toContain('external__web_fetch');
        expect(promptCall.body.tools).toBeUndefined();
        expect(sdkMocks.toolIds).not.toHaveBeenCalled();
    });

    test('POST /v1/responses enables internal allowlist tools when client tools are omitted', async () => {
        const internalApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            INTERNAL_ALLOWED_TOOLS: ['web_fetch', 'filesystem']
        }).app;

        sdkMocks.sessionPrompt.mockResolvedValueOnce({
            data: {
                parts: [{ type: 'text', text: 'Fetched via internal allowlist tools' }]
            }
        });

        const res = await request(internalApp)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'Fetch https://example.com'
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('response');
        expect(res.body.status).toEqual('completed');
        expect(res.body.created_at).toEqual(expect.any(Number));
        expect(res.body.created).toEqual(res.body.created_at);
        expect(res.body.error).toBeNull();
        expect(res.body.incomplete_details).toBeNull();
        expect(res.body.output).toEqual([
            {
                id: expect.any(String),
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [
                    {
                        type: 'output_text',
                        text: 'Fetched via internal allowlist tools',
                        annotations: []
                    }
                ]
            }
        ]);

        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('You may use only these built-in tools when truly required: web_fetch, filesystem');
        expect(promptCall.body.system).not.toContain('External tools are virtualized by this proxy. They are not OpenCode tools.');
        expect(promptCall.body.tools).toEqual({
            web_fetch: true,
            filesystem: true,
            bash: false
        });
        expect(sdkMocks.toolIds).toHaveBeenCalledTimes(1);
    });

    test('POST /v1/responses preserves backward compatibility for INTERNAL_WEB_FETCH_ENABLED', async () => {
        const internalApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            INTERNAL_WEB_FETCH_ENABLED: true
        }).app;

        sdkMocks.sessionPrompt.mockResolvedValueOnce({
            data: {
                parts: [{ type: 'text', text: 'Fetched via internal web_fetch compatibility mode' }]
            }
        });

        const res = await request(internalApp)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'Fetch https://example.com'
            });

        expect(res.statusCode).toEqual(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('You may use only these built-in tools when truly required: web_fetch');
        expect(promptCall.body.tools).toEqual({
            web_fetch: true,
            filesystem: false,
            bash: false
        });
    });

    test('POST /v1/responses falls back to fully disabled native tools when internal allowlist tools are unavailable', async () => {
        const internalApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            INTERNAL_ALLOWED_TOOLS: ['web_fetch', 'filesystem']
        }).app;
        sdkMocks.toolIds.mockResolvedValueOnce({ data: ['bash'] });
        sdkMocks.sessionPrompt.mockResolvedValueOnce({
            data: {
                parts: [{ type: 'text', text: 'Live tool access is unavailable.' }]
            }
        });

        const res = await request(internalApp)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'Fetch https://example.com'
            });

        expect(res.statusCode).toEqual(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.tools).toEqual({
            bash: false
        });
    });

    test('POST /v1/responses applies request-level allowlist narrowing (intersection)', async () => {
        const internalApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            INTERNAL_ALLOWED_TOOLS: ['web_fetch', 'filesystem', 'bash']
        }).app;

        sdkMocks.sessionPrompt.mockResolvedValueOnce({
            data: {
                parts: [{ type: 'text', text: 'Narrowed tool access' }]
            }
        });

        const res = await request(internalApp)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'Use filesystem',
                opencode: {
                    internal_allowed_tools: ['filesystem', 'unconfigured_tool']
                }
            });

        expect(res.statusCode).toEqual(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('You may use only these built-in tools when truly required: filesystem');
        expect(promptCall.body.tools).toEqual({
            web_fetch: false,
            filesystem: true,
            bash: false
        });
    });

    test('POST /v1/responses ignores request-level allowlist when external tools are present', async () => {
        const internalApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            INTERNAL_ALLOWED_TOOLS: ['filesystem']
        }).app;

        sdkMocks.sessionPrompt.mockResolvedValueOnce({
            data: {
                parts: [{ type: 'text', text: 'External bridge active' }]
            }
        });

        const res = await request(internalApp)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'Use external tool',
                tools: [{ type: 'function', function: { name: 'external_fetch', description: 'test' } }],
                opencode: {
                    internal_allowed_tools: ['filesystem']
                }
            });

        expect(res.statusCode).toEqual(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('External tools are virtualized by this proxy');
        expect(promptCall.body.system).not.toContain('You may use only these built-in tools');
        expect(promptCall.body.tools).toEqual({
            web_fetch: false,
            filesystem: false,
            bash: false
        });
    });

    test('POST /v1/responses preserves an explicit empty function_call_output', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                tools: [{ type: 'function', function: { name: 'read' } }],
                input: [
                    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Read a.txt' }] },
                    { type: 'function_call', call_id: 'call_read_1', name: 'read', arguments: '{}' },
                    { type: 'function_call_output', call_id: 'call_read_1', output: '' }
                ]
            });

        expect(res.statusCode).toBe(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.parts).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'text',
                text: 'TOOL_RESULT: {"tool_call_id":"call_read_1","name":"external__read","content":""}'
            })
        ]));
    });

    test('POST /v1/responses continues after function_call_output input and returns assistant text', async () => {
        sdkMocks.sessionPrompt.mockResolvedValueOnce({
            data: {
                parts: [
                    { type: 'text', text: 'The weather in Tokyo is 22°C and sunny.' }
                ]
            }
        });

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'weather_lookup',
                            description: 'Look up weather by city',
                            parameters: {
                                type: 'object',
                                properties: { city: { type: 'string' } },
                                required: ['city']
                            }
                        }
                    }
                ],
                input: [
                    {
                        type: 'message',
                        role: 'user',
                        content: [
                            { type: 'input_text', text: 'What is the weather in Tokyo?' }
                        ]
                    },
                    {
                        type: 'function_call',
                        call_id: 'resp_call_weather_1',
                        name: 'weather_lookup',
                        arguments: { city: 'Tokyo' }
                    },
                    {
                        type: 'function_call_output',
                        call_id: 'resp_call_weather_1',
                        output: '22°C and sunny'
                    }
                ]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('response');
        expect(res.body.status).toEqual('completed');
        expect(res.body.created_at).toEqual(expect.any(Number));
        expect(res.body.created).toEqual(res.body.created_at);
        expect(res.body.error).toBeNull();
        expect(res.body.incomplete_details).toBeNull();
        expect(res.body.output).toEqual([
            {
                id: expect.any(String),
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [
                    {
                        type: 'output_text',
                        text: 'The weather in Tokyo is 22°C and sunny.',
                        annotations: []
                    }
                ]
            }
        ]);

        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.parts).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'text',
                text: 'What is the weather in Tokyo?'
            }),
            expect.objectContaining({
                type: 'text',
                text: expect.stringContaining('ASSISTANT: <function_calls>')
            }),
            expect.objectContaining({
                type: 'text',
                text: 'TOOL_RESULT: {"tool_call_id":"resp_call_weather_1","name":"external__weather_lookup","content":"22°C and sunny"}'
            })
        ]));
        expect(promptCall.body.parts[1].text).toContain('external__weather_lookup');
        expect(promptCall.body.parts[1].text).toContain('resp_call_weather_1');
        expect(promptCall.body.parts[1].text).toContain('{\\"city\\":\\"Tokyo\\"}');
    });

    test('POST /v1/chat/completions falls back to first available model when model is omitted', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                messages: [{ role: 'user', content: 'Hello without model' }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('chat.completion');
    });

    test('POST /v1/responses supports streaming', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'Hello from responses stream',
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.header['content-type']).toContain('text/event-stream');
        expect(res.text).toContain('response.output_item.added');
        expect(res.text).toContain('response.content_part.added');
        expect(res.text).toContain('response.output_text.delta');
        expect(res.text).toContain('response.output_item.done');
        expect(res.text).toContain('response.completed');
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/responses streaming emits function_call output items for external tools without leaking raw function markup', async () => {
        sdkMocks.eventSubscribe.mockResolvedValueOnce({
            stream: (async function* () {
                const sessionId = 'test-session-id';
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: { type: 'reasoning', sessionID: sessionId },
                        delta: 'Thinking...'
                    }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: { type: 'text', sessionID: sessionId },
                        delta: '<function_calls>[{"id":"resp_call_weather_stream_1","name":"external__weather_lookup","arguments":{"city":"Tokyo","unit":"celsius"}}]</function_calls>'
                    }
                };
                yield {
                    type: 'message.updated',
                    properties: { info: { sessionID: sessionId, finish: 'stop' } }
                };
            })()
        });

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'What is the weather in Tokyo?',
                stream: true,
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'weather_lookup',
                            description: 'Look up weather by city',
                            parameters: {
                                type: 'object',
                                properties: {
                                    city: { type: 'string' },
                                    unit: { type: 'string' }
                                },
                                required: ['city']
                            }
                        }
                    }
                ]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.header['content-type']).toContain('text/event-stream');
        expect(res.text).toContain('response.output_item.added');
        expect(res.text).toContain('resp_call_weather_stream_1');
        expect(res.text).toContain('"name":"weather_lookup"');
        expect(res.text).not.toContain('"text":"<function_calls>');
        expect(res.text).toContain('response.completed');
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/responses fails closed for denied external function calls in streaming output', async () => {
        const restrictedApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: false,
            DEBUG: false,
            EXTERNAL_TOOL_DENYLIST: ['delete_ticket']
        }).app;

        sdkMocks.eventSubscribe.mockResolvedValueOnce({
            stream: (async function* () {
                const sessionId = 'test-session-id';
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: { type: 'text', sessionID: sessionId },
                        delta: '<function_calls>[{"id":"resp_call_delete_stream_1","name":"external__delete_ticket","arguments":{"id":"123"}}]</function_calls>'
                    }
                };
                yield {
                    type: 'message.updated',
                    properties: { info: { sessionID: sessionId, finish: 'stop' } }
                };
            })()
        });

        const res = await request(restrictedApp)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'Delete ticket 123',
                stream: true,
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'delete_ticket',
                            description: 'Delete a ticket',
                            parameters: {
                                type: 'object',
                                properties: { id: { type: 'string' } },
                                required: ['id']
                            }
                        }
                    }
                ]
            });

        expect(res.statusCode).toEqual(200);
        const events = res.text
            .split('\n')
            .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
            .map((line) => JSON.parse(line.slice(6)));
        expect(events.map((event) => event.type)).toEqual(['response.created', 'response.failed']);
        expect(events.every((event) => event.response.output.length === 0)).toBe(true);
        expect(res.text).not.toContain('external__delete_ticket');
         expect(res.text).toContain('response.failed');
         expect(res.text).not.toContain('response.completed');
    });

    test('POST /v1/responses strips denied external function calls from non-stream output', async () => {
        const restrictedApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: false,
            DEBUG: false,
            EXTERNAL_TOOL_DENYLIST: ['delete_ticket']
        }).app;

        sdkMocks.sessionPrompt.mockResolvedValueOnce({
            data: {
                parts: [
                    {
                        type: 'text',
                        text: '<function_calls>[{"id":"resp_call_delete_1","name":"external__delete_ticket","arguments":{"id":"123"}}]</function_calls>'
                    }
                ]
            }
        });

        const res = await request(restrictedApp)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'Delete ticket 123',
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'delete_ticket',
                            description: 'Delete a ticket',
                            parameters: {
                                type: 'object',
                                properties: { id: { type: 'string' } },
                                required: ['id']
                            }
                        }
                    }
                ]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.output).toEqual([]);
    });

    test('POST /v1/responses strips tool-call markup from output when DISABLE_TOOLS=true', async () => {
        const lockedApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false
        }).app;

        sdkMocks.sessionPrompt.mockResolvedValueOnce({
            data: {
                parts: [
                    {
                        type: 'text',
                        text: 'Search summary here. <function_calls>{"name":"webfetch","arguments":{"url":"https://example.com"}}</function_calls>'
                    }
                ]
            }
        });

        const res = await request(lockedApp)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'Summarize https://example.com'
            });

        expect(res.statusCode).toEqual(200);
        const flat = JSON.stringify(res.body.output);
        expect(flat).toContain('Search summary here.');
        expect(flat).not.toContain('<function_calls>');
    });

    /**
     * The Responses API declares function tools flat: { type:'function', name, parameters }.
     * buildExternalToolRegistry only read tool.function.name, so every tool from a Responses
     * client was dropped. An empty registry means no tool contract is added to the prompt and
     * no tool-call markup is parsed back out, so the model appears to ignore tools entirely.
     */
    test('external tool registry accepts flat Responses-API tool definitions', () => {
        const flat = buildExternalToolRegistry([{
            type: 'function',
            name: 'read',
            description: 'Read a file',
            parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
        }]);

        expect(flat).toHaveLength(1);
        expect(flat[0].originalName).toBe('read');
        expect(flat[0].namespacedName).toBe('external__read');
        expect(flat[0].description).toBe('Read a file');
        expect(flat[0].parameters.required).toEqual(['path']);
        // Side-effect inference keyed off the name must still work on the flat shape.
        expect(flat[0].sideEffect).toBe('read');
    });

    test('external tool registry keeps accepting nested Chat-Completions tool definitions', () => {
        const nested = buildExternalToolRegistry([{
            type: 'function',
            function: {
                name: 'read',
                description: 'Read a file',
                parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
            }
        }]);

        expect(nested).toHaveLength(1);
        expect(nested[0].namespacedName).toBe('external__read');
        expect(nested[0].description).toBe('Read a file');
    });

    test('POST /v1/responses advertises flat tools to the model and parses their calls back', async () => {
        let sentSystem = '';
        sdkMocks.sessionPrompt.mockImplementation(async (args) => {
            sentSystem = args.body.system || '';
            return {
                data: {
                    parts: [{
                        type: 'text',
                        text: '<function_calls>{"name":"external__read","arguments":{"path":"a.txt"}}</function_calls>'
                    }]
                }
            };
        });

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'Read a.txt',
                tools: [{
                    type: 'function',
                    name: 'read',
                    description: 'Read a file',
                    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
                }]
            });

        expect(res.statusCode).toEqual(200);
        // The tool contract must reach the model.
        expect(sentSystem).toContain('external__read');
        const functionCalls = res.body.output.filter(item => item.type === 'function_call');
        expect(functionCalls).toHaveLength(1);
        expect(functionCalls[0].name).toBe('read');
        expect(JSON.parse(functionCalls[0].arguments)).toEqual({ path: 'a.txt' });
    });

    test('POST /v1/responses honours a flat tool_choice forcing a specific tool', async () => {
        let sentSystem = '';
        sdkMocks.sessionPrompt.mockImplementation(async (args) => {
            sentSystem = args.body.system || '';
            return {
                data: {
                    parts: [{
                        type: 'text',
                        text: '<function_calls>{"name":"external__read","arguments":{"path":"a.txt"}}</function_calls>'
                    }]
                }
            };
        });

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'Read a.txt',
                tools: [{
                    type: 'function',
                    name: 'read',
                    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
                }],
                tool_choice: { type: 'function', name: 'read' }
            });

        expect(res.statusCode).toEqual(200);
        expect(sentSystem).toContain('You MUST call external__read');
    });

    test('streaming retries once on transient upstream CreditsError and recovers', async () => {
        // Issue #5: upstream workers mislabel throttling as 401 "Insufficient balance"
        // (CreditsError). The very next attempt succeeds, so the proxy must rotate the
        // session and retry instead of surfacing the bogus billing error.
        sdkMocks.sessionMessages.mockReset();
        sdkMocks.sessionMessages.mockImplementation(async () => ([{
            info: { role: 'assistant', finish: 'stop' },
            parts: [{ type: 'text', text: 'Recovered response' }]
        }]));
        sdkMocks.eventSubscribe.mockReset();
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => {
            const sessionId = 'test-session-id';
            const mockEvents = [{
                type: 'message.updated',
                properties: {
                    info: {
                        sessionID: sessionId,
                        error: { name: 'CreditsError', data: { message: '401: {"message":"Insufficient balance. Manage your billing here: https://example.ai","type":"CreditsError","param":"","code":null}', responseHeaders: { 'retry-after-ms': '10' } } }
                    }
                }
            }];
            return {
                stream: (async function* () {
                    for (const event of mockEvents) yield event;
                })()
            };
        });
        // Subsequent calls fall through to the default mock (successful stream).

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Hello' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.text).toContain('Recovered response');
        expect(res.text).not.toContain('Insufficient balance');
        // The failed attempt's session must have been rotated before retrying.
        expect(sdkMocks.sessionDelete).toHaveBeenCalledWith({ path: { id: 'test-session-id' } });
    });

    test('non-streaming retries once on transient upstream CreditsError and recovers', async () => {
        // Same mislabeled billing failure, polling path: first snapshot reports the
        // CreditsError with no usable content, the retry succeeds.
        sdkMocks.sessionMessages.mockReset();
        sdkMocks.sessionMessages
            .mockResolvedValueOnce([{
                info: {
                    role: 'assistant',
                    error: { name: 'CreditsError', data: { message: '401: Insufficient balance', responseHeaders: { 'retry-after-ms': '10' } } }
                },
                parts: []
            }])
            .mockResolvedValue([{
                info: { role: 'assistant', finish: 'stop' },
                parts: [{ type: 'text', text: 'Recovered response' }]
            }]);
        sdkMocks.eventSubscribe.mockReset();

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Hello' }],
                stream: false
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.choices[0].message.content).toBe('Recovered response');
        expect(sdkMocks.sessionDelete).toHaveBeenCalledWith({ path: { id: 'test-session-id' } });
    });
describe('Proxy Responses API previous_response_id', () => {
    describe('Phase 1B external stream finalization', () => {
        const readTool = {
            type: 'function',
            function: {
                name: 'read',
                description: 'Read a file',
                parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
            }
        };
        const eventStream = (events) => async () => ({ stream: (async function* () { for (const event of events) yield event; })() });
        const eventStreamThenThrow = (events) => async () => ({ stream: (async function* () {
            for (const event of events) yield event;
            throw new Error('event stream cut');
        })() });
        const readSseData = (text) => text
            .split('\n')
            .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
            .map((line) => JSON.parse(line.slice(6)));
        const chatStreamPayload = { model: 'opencode/kimi-k2.5', stream: true, messages: [{ role: 'user', content: 'Hello' }] };
        const messagesStreamPayload = {
            model: 'opencode/kimi-k2.5',
            max_tokens: 100,
            stream: true,
            messages: [{ role: 'user', content: 'Hello' }]
        };
        const visibleTextFor = (path, text) => {
            if (path === '/v1/responses') {
                return readSseData(text)
                    .filter((event) => event.type === 'response.output_text.delta')
                    .map((event) => event.delta);
            }
            if (path === '/v1/messages') {
                return readSseData(text)
                    .filter((event) => event.type === 'content_block_delta' && event.delta?.type === 'text_delta')
                    .map((event) => event.delta.text);
            }
            return readSseData(text)
                .flatMap((event) => event.choices || [])
                .flatMap((choice) => (choice.delta?.content ? [choice.delta.content] : []));
        };

        test('non-stream parsing joins reasoning and content before extraction', async () => {
            sdkMocks.sessionMessages.mockResolvedValueOnce([{
                info: { role: 'assistant', finish: 'stop' },
                parts: [
                    { type: 'reasoning', text: '<function_calls>{"name":"read",' },
                    { type: 'text', text: '"arguments":{"path":"a.txt"}}</function_calls>' }
                ]
            }]);
            const res = await request(app)
                .post('/v1/chat/completions')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'Read a.txt' }], tools: [readTool] });
            expect(res.statusCode).toBe(200);
            expect(res.body.choices[0].finish_reason).toBe('tool_calls');
            expect(res.body.choices[0].message.tool_calls[0].function.name).toBe('read');
        });

        test.each([
            ['chat', '/v1/chat/completions'],
            ['messages', '/v1/messages']
        ])('non-stream %s strips a cross-channel marker before splitting visible text', async (_label, path) => {
            sdkMocks.sessionMessages.mockResolvedValueOnce([{
                info: { role: 'assistant', finish: 'stop' },
                parts: [
                    { type: 'reasoning', text: 'before <function_calls>{"name":"read",' },
                    { type: 'text', text: '"arguments":{"path":"a.txt"}}</function_calls> after' }
                ]
            }]);
            const payload = path === '/v1/chat/completions'
                ? { model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'Read a.txt' }], tools: [readTool] }
                : {
                    model: 'opencode/kimi-k2.5',
                    max_tokens: 100,
                    messages: [{ role: 'user', content: 'Read a.txt' }],
                    tools: [{ name: 'read', description: 'Read a file', input_schema: readTool.function.parameters }]
                };
            const res = await request(app)
                .post(path)
                .set('Authorization', 'Bearer test-key')
                .set('anthropic-version', '2023-06-01')
                .send(payload);
            expect(res.statusCode).toBe(200);
            if (path === '/v1/chat/completions') {
                expect(res.body.choices[0].message.content).toBe('after');
                expect(res.body.choices[0].message.reasoning_content).toBe('before');
            } else {
                expect(res.body.content.find((item) => item.type === 'text').text).toBe('after');
                expect(res.body.content.find((item) => item.type === 'thinking').thinking).toBe('before');
            }
        });

        test('non-stream responses strips a cross-channel marker before splitting visible text', async () => {
            sdkMocks.sessionMessages.mockReset();
            sdkMocks.sessionPrompt.mockResolvedValueOnce({
                data: {
                    parts: [
                        { type: 'reasoning', text: 'before <function_calls>{"name":"read",' },
                        { type: 'text', text: '"arguments":{"path":"a.txt"}}</function_calls> after' }
                    ]
                }
            });
            const res = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({
                    model: 'opencode/kimi-k2.5',
                    input: 'Read a.txt',
                    tools: [{ type: 'function', name: 'read', parameters: readTool.function.parameters }]
                });
            expect(res.statusCode).toBe(200);
            expect(res.body.output.find((item) => item.type === 'function_call').name).toBe('read');
            expect(res.body.output.find((item) => item.type === 'message').content[0].text).toBe('after');
            expect(res.body.reasoning.summary).toBe('before');
        });

        test('external chat stream sends buffered flush text and one validated call', async () => {
            sdkMocks.sessionMessages.mockResolvedValue([{ info: { role: 'assistant', finish: 'stop' }, parts: [] }]);
            sdkMocks.eventSubscribe.mockImplementationOnce(eventStream([
                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'test-session-id' }, delta: 'Visible ' } },
                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'test-session-id' }, delta: '<external__read>{"path":"a.txt"}</external__read> tail' } },
                { type: 'message.updated', properties: { info: { sessionID: 'test-session-id', finish: 'stop' } } }
            ]));
            const res = await request(app)
                .post('/v1/chat/completions')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'opencode/kimi-k2.5', stream: true, messages: [{ role: 'user', content: 'Read a.txt' }], tools: [readTool] });
            expect(res.statusCode).toBe(200);
            expect(res.text).toContain('Visible');
            expect(res.text).toContain('tail');
            expect(res.text).toContain('"tool_calls"');
            expect(res.text).not.toContain('<external__read>');
            expect(res.text).toContain('data: [DONE]');
        });

        test('buffered chat flush emits ordinary leading JSON once', async () => {
            sdkMocks.sessionMessages.mockResolvedValue([{ info: { role: 'assistant', finish: 'stop' }, parts: [] }]);
            sdkMocks.eventSubscribe.mockImplementationOnce(eventStream([
                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'test-session-id' }, delta: '{"ordinaryLeading":true}' } },
                { type: 'message.updated', properties: { info: { sessionID: 'test-session-id', finish: 'stop' } } }
            ]));
            const res = await request(app)
                .post('/v1/chat/completions')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'opencode/kimi-k2.5', stream: true, messages: [{ role: 'user', content: 'Read a.txt' }], tools: [readTool] });
            const visible = readSseData(res.text)
                .flatMap((event) => event.choices || [])
                .flatMap((choice) => choice.delta?.content ? [choice.delta.content] : []);
            expect(visible).toEqual(['{"ordinaryLeading":true}']);
        });

        test('buffered messages flush emits ordinary leading JSON once', async () => {
            sdkMocks.sessionMessages.mockResolvedValue([{ info: { role: 'assistant', finish: 'stop' }, parts: [] }]);
            sdkMocks.eventSubscribe.mockImplementationOnce(eventStream([
                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'test-session-id' }, delta: '{"ordinaryLeading":true}' } },
                { type: 'message.updated', properties: { info: { sessionID: 'test-session-id', finish: 'stop' } } }
            ]));
            const res = await request(app)
                .post('/v1/messages')
                .set('Authorization', 'Bearer test-key')
                .set('anthropic-version', '2023-06-01')
                .send({
                    model: 'opencode/kimi-k2.5',
                    max_tokens: 100,
                    stream: true,
                    messages: [{ role: 'user', content: 'Read a.txt' }],
                    tools: [{ name: 'read', description: 'Read a file', input_schema: readTool.function.parameters }]
                });
            const visible = readSseData(res.text)
                .filter((event) => event.type === 'content_block_delta' && event.delta?.type === 'text_delta')
                .map((event) => event.delta.text);
            expect(visible).toEqual(['{"ordinaryLeading":true}']);
        });

        test('buffered responses flush emits an ordinary leading array once', async () => {
            sdkMocks.sessionMessages.mockResolvedValue([{ info: { role: 'assistant', finish: 'stop' }, parts: [] }]);
            sdkMocks.eventSubscribe.mockImplementationOnce(eventStream([
                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'test-session-id' }, delta: '[1,2,3]' } },
                { type: 'message.updated', properties: { info: { sessionID: 'test-session-id', finish: 'stop' } } }
            ]));
            const res = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({
                    model: 'opencode/kimi-k2.5',
                    input: 'Read a.txt',
                    stream: true,
                    tools: [{ type: 'function', name: 'read', parameters: readTool.function.parameters }]
                });
            const visible = readSseData(res.text)
                .filter((event) => event.type === 'response.output_text.delta')
                .map((event) => event.delta);
            expect(visible).toEqual(['[1,2,3]']);
        });

        test.each([
            ['invalid arguments', '<function_calls>{"name":"read","arguments":{}}</function_calls>'],
            ['malformed markup', 'prefix <function_calls>{"name":"read" arguments</function_calls> suffix'],
            ['valid plus malformed', '<function_calls>{"name":"read","arguments":{"path":"a.txt"}}</function_calls><function_calls>{"name":"read" arguments</function_calls>'],
            ['valid plus invalid array member', '<function_calls>[{"name":"read","arguments":{"path":"a.txt"}},{"arguments":{"path":"b.txt"}}]</function_calls>'],
            ['valid plus unknown', '<function_calls>{"name":"read","arguments":{"path":"a.txt"}}</function_calls><function_calls>{"name":"missing","arguments":{}}</function_calls>'],
            ['unclosed canonical opener', '<function_calls>{"name":"read","arguments":{"path":"a.txt"}}'],
            ['unclosed DSML container', '<tool_calls>{"name":"read","arguments":{"path":"a.txt"}}'],
            ['unclosed DSML marker container', '<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="read"><｜｜DSML｜｜parameter name="path" string="true">a.txt</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke>'],
            ['unclosed tool_call wrapper', '<tool_call>{"name":"read","arguments":{"path":"a.txt"}}'],
            ['valid DSML plus unclosed wrapper', '<tool_calls><invoke name="read"><parameter name="path" string="true">a.txt</parameter></invoke></tool_calls><tool_call>{"name":"read"'],
            ['bare array with an invalid member', '[{"name":"read","arguments":{"path":"a.txt"}},{"arguments":{"path":"b.txt"}}]'],
            ['bare array with an unknown member', '[{"name":"read","arguments":{"path":"a.txt"}},{"name":"missing","arguments":{}}]'],
            ['bare array with a trailing member', '[{"name":"read","arguments":{"path":"a.txt"}},"junk"]'],
            ['parallel calls', '<function_calls>[{"name":"read","arguments":{"path":"a.txt"}},{"name":"read","arguments":{"path":"b.txt"}}]</function_calls>'],
            ['canonical block plus a second bare payload', '<function_calls>{"name":"read","arguments":{"path":"a.txt"}}</function_calls>{"name":"read","arguments":{"path":"b.txt"}}']
        ])('external chat stream fails closed for %s', async (_label, markup) => {
            sdkMocks.eventSubscribe.mockImplementationOnce(eventStream([
                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'test-session-id' }, delta: markup } },
                { type: 'message.updated', properties: { info: { sessionID: 'test-session-id', finish: 'stop' } } }
            ]));
            const res = await request(app)
                .post('/v1/chat/completions')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'opencode/kimi-k2.5', stream: true, messages: [{ role: 'user', content: 'Read a.txt' }], tools: [readTool] });
            expect(res.statusCode).toBe(200);
            expect(res.text).toContain('data: {"error"');
            expect(res.text).not.toContain('data: [DONE]');
        });

        test('external chat stream rejects conflicting arguments under one explicit id', async () => {
            sdkMocks.eventSubscribe.mockImplementationOnce(eventStream([
                {
                    type: 'message.part.updated',
                    properties: {
                        part: { type: 'text', sessionID: 'test-session-id' },
                        delta: '<function_calls>[{"id":"call_same","name":"read","arguments":{"path":"a.txt"}},{"id":"call_same","name":"read","arguments":{"path":"b.txt"}}]</function_calls>'
                    }
                },
                { type: 'message.updated', properties: { info: { sessionID: 'test-session-id', finish: 'stop' } } }
            ]));
            const res = await request(app)
                .post('/v1/chat/completions')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'opencode/kimi-k2.5', stream: true, messages: [{ role: 'user', content: 'Read a.txt' }], tools: [readTool] });
            expect(res.statusCode).toBe(200);
            expect(res.text).toContain('duplicate external tool call id');
            expect(res.text).not.toContain('data: [DONE]');
        });

        test('external responses stream fails closed before response.completed', async () => {
            sdkMocks.eventSubscribe.mockImplementationOnce(eventStream([
                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'test-session-id' }, delta: '<function_calls>{"name":"read","arguments":{}}</function_calls>' } },
                { type: 'message.updated', properties: { info: { sessionID: 'test-session-id', finish: 'stop' } } }
            ]));
            const res = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'opencode/kimi-k2.5', input: 'Read a.txt', stream: true, tools: [{ type: 'function', name: 'read', parameters: readTool.function.parameters }] });
            expect(res.statusCode).toBe(200);
            const frames = readSseFrames(res.text);
            expect(frames).toHaveLength(3);
            expect(frames[0].type).toBe('response.created');
            expect(frames[1].type).toBe('response.failed');
            expect(frames[2]).toBe('[DONE]');
            const created = frames[0];
            const failed = frames[1];
            expect(failed.response.id).toBe(created.response.id);
            expect(failed.response.created).toBe(created.response.created);
            expect(failed.response.created_at).toBe(created.response.created_at);
            expect(failed.response.model).toBe(created.response.model);
            expect(created.response.output).toEqual([]);
            expect(failed.response.output).toEqual([]);
            expect(failed.response.completed_at).toBeNull();
            expect([created.sequence_number, failed.sequence_number]).toEqual([0, 1]);
            expect(frames.some((frame) => frame && frame.type === 'response.output_item.added')).toBe(false);
            expect(created.response.tools).toEqual([{ type: 'function', name: 'read', parameters: readTool.function.parameters }]);
            expect(sdkMocks.sessionDelete).toHaveBeenCalledWith({ path: { id: 'test-session-id' } });
        });

        test.each(['noData', 'collect error'])('responses %s recovery reuses its first poll snapshot', async (mode) => {
            sdkMocks.sessionMessages.mockReset();
            sdkMocks.sessionMessages
                .mockResolvedValueOnce([{
                    info: { role: 'assistant', finish: 'stop' },
                    parts: [{ type: 'text', text: '<function_calls>{"name":"read","arguments":{"path":"a.txt"}}</function_calls>' }]
                }])
                .mockRejectedValueOnce(new Error('second transient poll failure'));
            sdkMocks.eventSubscribe.mockImplementationOnce(eventStream(
                mode === 'noData'
                    ? [{ type: 'message.updated', properties: { info: { sessionID: 'test-session-id', finish: 'stop' } } }]
                    : []
            ));
            if (mode === 'collect error') {
                sdkMocks.eventSubscribe.mockReset();
                sdkMocks.eventSubscribe.mockRejectedValueOnce(new Error('event stream unavailable'));
            }
            const res = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({
                    model: 'opencode/kimi-k2.5',
                    input: 'Read a.txt',
                    stream: true,
                    tools: [{ type: 'function', name: 'read', parameters: readTool.function.parameters }]
                });
            expect(res.statusCode).toBe(200);
            expect(res.text).toContain('response.completed');
            expect(res.text).not.toContain('response.failed');
            expect(sdkMocks.sessionMessages).toHaveBeenCalledTimes(1);
        });

        test.each([
            ['chat', '/v1/chat/completions', { ...chatStreamPayload, tools: [readTool] }],
            ['messages', '/v1/messages', { ...messagesStreamPayload, tools: [{ name: 'read', description: 'Read a file', input_schema: readTool.function.parameters }] }],
            ['responses', '/v1/responses', { model: 'opencode/kimi-k2.5', input: 'Read a file', stream: true, tools: [{ type: 'function', name: 'read', parameters: readTool.function.parameters }] }]
        ])('%s keeps a completed external stream when the recovery poll fails', async (_label, path, payload) => {
            sdkMocks.eventSubscribe.mockImplementationOnce(eventStream([
                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'test-session-id' }, delta: '<function_calls>{"name":"read","arguments":{"path":"a.txt"}}</function_calls>' } },
                { type: 'message.updated', properties: { info: { sessionID: 'test-session-id', finish: 'stop' } } }
            ]));
            sdkMocks.sessionMessages.mockRejectedValue(new Error('poll must not run'));
            const res = await request(app)
                .post(path)
                .set('Authorization', 'Bearer test-key')
                .set('anthropic-version', '2023-06-01')
                .send(payload);
            expect(res.statusCode).toBe(200);
            expect(visibleTextFor(path, res.text)).toEqual([]);
            expect(sdkMocks.sessionMessages).not.toHaveBeenCalled();
            expect(res.text).not.toContain('poll must not run');
            if (path === '/v1/chat/completions') expect(res.text).toContain('"tool_calls"');
            if (path === '/v1/messages') expect(res.text).toContain('tool_use');
            if (path === '/v1/responses') expect(res.text).toContain('response.completed');
        });

        test.each([
            ['chat', '/v1/chat/completions', { ...chatStreamPayload, tools: [readTool] }],
            ['messages', '/v1/messages', { ...messagesStreamPayload, tools: [{ name: 'read', description: 'Read a file', input_schema: readTool.function.parameters }] }],
            ['responses', '/v1/responses', { model: 'opencode/kimi-k2.5', input: 'Read a file', stream: true, tools: [{ type: 'function', name: 'read', parameters: readTool.function.parameters }] }]
        ])('%s preserves partial output when recovery polling fails', async (_label, path, payload) => {
            sdkMocks.eventSubscribe.mockImplementationOnce(eventStreamThenThrow([
                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'test-session-id' }, delta: 'partial answer' } }
            ]));
            sdkMocks.sessionMessages.mockRejectedValue(new Error('poll failed'));
            const res = await request(app)
                .post(path)
                .set('Authorization', 'Bearer test-key')
                .set('anthropic-version', '2023-06-01')
                .send(payload);
            expect(res.statusCode).toBe(200);
            expect(visibleTextFor(path, res.text).join('')).toBe('partial answer');
            expect(res.text).not.toContain('poll failed');
        });

        test('chat stream disconnect aborts collection and deletes its session', async () => {
            sdkMocks.eventSubscribe.mockImplementationOnce(async () => ({
                stream: (async function* () {
                    await new Promise(() => {});
                })()
            }));
            await new Promise((resolve) => {
                let settled = false;
                let fallbackTimer;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(fallbackTimer);
                    resolve();
                };
                const pending = request(app)
                    .post('/v1/chat/completions')
                    .set('Authorization', 'Bearer test-key')
                    .send({ model: 'opencode/kimi-k2.5', stream: true, messages: [{ role: 'user', content: 'Hello' }], tools: [readTool] });
                pending.end(finish);
                setTimeout(() => pending.abort(), 50);
                fallbackTimer = setTimeout(finish, 250);
            });
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(sdkMocks.sessionDelete).toHaveBeenCalledWith({ path: { id: 'test-session-id' } });
        });

        test('responses forced-call failure keeps the created response identity and sequence', async () => {
            sdkMocks.eventSubscribe.mockImplementationOnce(eventStream([
                { type: 'message.updated', properties: { info: { sessionID: 'test-session-id', finish: 'stop' } } }
            ]));
            sdkMocks.sessionMessages.mockResolvedValue([{ info: { role: 'assistant', finish: 'stop' }, parts: [] }]);
            sdkMocks.sessionPrompt
                .mockResolvedValueOnce({ data: { parts: [] } })
                .mockRejectedValueOnce(new Error('forced prompt failed'));
            const res = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({
                    model: 'opencode/kimi-k2.5',
                    input: 'Read a.txt',
                    stream: true,
                    tools: [{ type: 'function', name: 'read', parameters: readTool.function.parameters }],
                    tool_choice: { type: 'function', name: 'read' }
                });
            const frames = readSseFrames(res.text);
            expect(frames).toHaveLength(3);
            expect(frames[0].type).toBe('response.created');
            expect(frames[1].type).toBe('response.failed');
            expect(frames[2]).toBe('[DONE]');
            const created = frames[0];
            const failed = frames[1];
            expect(failed.response.id).toBe(created.response.id);
            expect(failed.response.created).toBe(created.response.created);
            expect(failed.response.created_at).toBe(created.response.created_at);
            expect(failed.response.model).toBe(created.response.model);
            expect(failed.response.completed_at).toBeNull();
            expect([created.sequence_number, failed.sequence_number]).toEqual([0, 1]);
            expect(sdkMocks.sessionDelete).toHaveBeenCalledWith({ path: { id: 'test-session-id' } });
        });

        test('external messages stream joins channels and emits tool_use only after finalization', async () => {
            sdkMocks.eventSubscribe.mockImplementationOnce(eventStream([
                { type: 'message.part.updated', properties: { part: { type: 'reasoning', sessionID: 'test-session-id' }, delta: '<function_calls>{"name":"read",' } },
                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'test-session-id' }, delta: '"arguments":{"path":"a.txt"}}</function_calls>' } },
                { type: 'message.updated', properties: { info: { sessionID: 'test-session-id', finish: 'stop' } } }
            ]));
            const res = await request(app)
                .post('/v1/messages')
                .set('Authorization', 'Bearer test-key')
                .set('anthropic-version', '2023-06-01')
                .send({
                    model: 'opencode/kimi-k2.5',
                    max_tokens: 100,
                    stream: true,
                    messages: [{ role: 'user', content: 'Read a.txt' }],
                    tools: [{ name: 'read', description: 'Read a file', input_schema: readTool.function.parameters }]
                });
            expect(res.statusCode).toBe(200);
            expect(res.text).toContain('tool_use');
            expect(res.text).toContain('message_stop');
            expect(res.text).not.toContain('<function_calls>');
        });

        test.each([
            ['chat', '/v1/chat/completions'],
            ['messages', '/v1/messages'],
            ['responses', '/v1/responses']
        ])('non-stream %s hides a bare call that fills only one channel', async (_label, path) => {
            const bare = '{"name":"read","arguments":{"path":"a.txt"}}';
            const parts = [
                { type: 'reasoning', text: 'let me check that' },
                { type: 'text', text: bare }
            ];
            sdkMocks.sessionMessages.mockReset();
            sdkMocks.sessionMessages.mockResolvedValue([{ info: { role: 'assistant', finish: 'stop' }, parts }]);
            sdkMocks.sessionPrompt.mockResolvedValueOnce({ data: { parts } });
            const payload = path === '/v1/chat/completions'
                ? { model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'Read a.txt' }], tools: [readTool] }
                : path === '/v1/messages'
                    ? {
                        model: 'opencode/kimi-k2.5',
                        max_tokens: 100,
                        messages: [{ role: 'user', content: 'Read a.txt' }],
                        tools: [{ name: 'read', description: 'Read a file', input_schema: readTool.function.parameters }]
                    }
                    : {
                        model: 'opencode/kimi-k2.5',
                        input: 'Read a.txt',
                        tools: [{ type: 'function', name: 'read', parameters: readTool.function.parameters }]
                    };
            const res = await request(app)
                .post(path)
                .set('Authorization', 'Bearer test-key')
                .set('anthropic-version', '2023-06-01')
                .send(payload);
            expect(res.statusCode).toBe(200);
            if (path === '/v1/chat/completions') {
                expect(res.body.choices[0].message.tool_calls[0].function.name).toBe('read');
                expect(res.body.choices[0].message.content).toBeNull();
                expect(res.body.choices[0].message.reasoning_content).toBe('let me check that');
            } else if (path === '/v1/messages') {
                expect(res.body.content.find((item) => item.type === 'tool_use').name).toBe('read');
                expect(res.body.content.find((item) => item.type === 'thinking').thinking).toBe('let me check that');
                expect(res.body.content.filter((item) => item.type === 'text')).toEqual([]);
            } else {
                expect(res.body.output.find((item) => item.type === 'function_call').name).toBe('read');
                expect(res.body.reasoning.summary).toBe('let me check that');
                expect(res.body.output.some((item) => item.type === 'message')).toBe(false);
            }
        });

        test.each([
            ['chat', '/v1/chat/completions'],
            ['messages', '/v1/messages'],
            ['responses', '/v1/responses']
        ])('non-stream %s accepts a bare call split across the two channels', async (_label, path) => {
            const parts = [
                { type: 'reasoning', text: '{"name":"read","arguments":' },
                { type: 'text', text: '{"path":"a.txt"}}' }
            ];
            sdkMocks.sessionMessages.mockReset();
            sdkMocks.sessionMessages.mockResolvedValue([{ info: { role: 'assistant', finish: 'stop' }, parts }]);
            sdkMocks.sessionPrompt.mockResolvedValueOnce({ data: { parts } });
            const payload = path === '/v1/chat/completions'
                ? { model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'Read a.txt' }], tools: [readTool] }
                : path === '/v1/messages'
                    ? {
                        model: 'opencode/kimi-k2.5',
                        max_tokens: 100,
                        messages: [{ role: 'user', content: 'Read a.txt' }],
                        tools: [{ name: 'read', description: 'Read a file', input_schema: readTool.function.parameters }]
                    }
                    : {
                        model: 'opencode/kimi-k2.5',
                        input: 'Read a.txt',
                        tools: [{ type: 'function', name: 'read', parameters: readTool.function.parameters }]
                    };
            const res = await request(app)
                .post(path)
                .set('Authorization', 'Bearer test-key')
                .set('anthropic-version', '2023-06-01')
                .send(payload);
            expect(res.statusCode).toBe(200);
            if (path === '/v1/chat/completions') {
                expect(res.body.choices[0].message.tool_calls[0].function.name).toBe('read');
                expect(JSON.parse(res.body.choices[0].message.tool_calls[0].function.arguments)).toEqual({ path: 'a.txt' });
                expect(res.body.choices[0].message.content).toBeNull();
                expect(res.body.choices[0].message.reasoning_content ?? null).toBeNull();
            } else if (path === '/v1/messages') {
                expect(res.body.content.find((item) => item.type === 'tool_use').name).toBe('read');
                expect(res.body.content.filter((item) => item.type === 'text')).toEqual([]);
                expect(res.body.content.filter((item) => item.type === 'thinking')).toEqual([]);
            } else {
                expect(res.body.output.find((item) => item.type === 'function_call').name).toBe('read');
                expect(res.body.output.some((item) => item.type === 'message')).toBe(false);
                expect(res.body.reasoning?.summary ?? []).toEqual([]);
            }
        });

        test.each([
            ['chat', '/v1/chat/completions'],
            ['messages', '/v1/messages'],
            ['responses', '/v1/responses']
        ])('non-stream %s keeps an ordinary JSON body', async (_label, path) => {
            const parts = [
                { type: 'reasoning', text: 'let me check that' },
                { type: 'text', text: '{"ordinaryLeading":true}' }
            ];
            sdkMocks.sessionMessages.mockReset();
            sdkMocks.sessionMessages.mockResolvedValue([{ info: { role: 'assistant', finish: 'stop' }, parts }]);
            sdkMocks.sessionPrompt.mockResolvedValueOnce({ data: { parts } });
            const payload = path === '/v1/chat/completions'
                ? { model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'Read a.txt' }], tools: [readTool] }
                : path === '/v1/messages'
                    ? {
                        model: 'opencode/kimi-k2.5',
                        max_tokens: 100,
                        messages: [{ role: 'user', content: 'Read a.txt' }],
                        tools: [{ name: 'read', description: 'Read a file', input_schema: readTool.function.parameters }]
                    }
                    : {
                        model: 'opencode/kimi-k2.5',
                        input: 'Read a.txt',
                        tools: [{ type: 'function', name: 'read', parameters: readTool.function.parameters }]
                    };
            const res = await request(app)
                .post(path)
                .set('Authorization', 'Bearer test-key')
                .set('anthropic-version', '2023-06-01')
                .send(payload);
            expect(res.statusCode).toBe(200);
            if (path === '/v1/chat/completions') {
                expect(res.body.choices[0].message.tool_calls).toBeUndefined();
                expect(res.body.choices[0].message.content).toBe('{"ordinaryLeading":true}');
            } else if (path === '/v1/messages') {
                expect(res.body.content.some((item) => item.type === 'tool_use')).toBe(false);
                expect(res.body.content.find((item) => item.type === 'text').text).toBe('{"ordinaryLeading":true}');
            } else {
                expect(res.body.output.some((item) => item.type === 'function_call')).toBe(false);
                expect(res.body.output.find((item) => item.type === 'message').content[0].text).toBe('{"ordinaryLeading":true}');
            }
        });

        test('responses stream transfers a newly created owned session to response state', async () => {
            sdkMocks.sessionMessages.mockResolvedValue([{ info: { role: 'assistant', finish: 'stop' }, parts: [] }]);
            sdkMocks.eventSubscribe.mockImplementationOnce(eventStream([
                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'test-session-id' }, delta: 'done' } },
                { type: 'message.updated', properties: { info: { sessionID: 'test-session-id', finish: 'stop' } } }
            ]));
            sdkMocks.sessionCreate.mockClear();
            sdkMocks.sessionDelete.mockClear();
            const res = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({
                    model: 'opencode/kimi-k2.5',
                    input: 'Read a.txt',
                    stream: true,
                    tools: [{ type: 'function', name: 'read', parameters: readTool.function.parameters }]
                });
            expect(res.text).toContain('response.completed');
            expect(sdkMocks.sessionCreate).toHaveBeenCalledTimes(1);
            expect(sdkMocks.sessionDelete).not.toHaveBeenCalled();

            const frames = readSseFrames(res.text);
            expect(frames[0].type).toBe('response.created');
            expect(frames[frames.length - 2].type).toBe('response.completed');
            expect(frames[frames.length - 1]).toBe('[DONE]');
            const completed = frames[frames.length - 2];
            const followUp = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({ input: 'And a follow-up', previous_response_id: completed.response.id });
            expect(followUp.statusCode).toBe(200);
            expect(sdkMocks.sessionCreate).toHaveBeenCalledTimes(1);
            expect(sdkMocks.sessionDelete).not.toHaveBeenCalled();
        });

        test('responses non-stream transfers a newly created owned session to response state', async () => {
            sdkMocks.sessionMessages.mockResolvedValue([{ info: { role: 'assistant', finish: 'stop' }, parts: [] }]);
            sdkMocks.sessionCreate.mockClear();
            sdkMocks.sessionDelete.mockClear();
            const res = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({
                    model: 'opencode/kimi-k2.5',
                    input: 'Read a.txt',
                    tools: [{ type: 'function', name: 'read', parameters: readTool.function.parameters }]
                });
            expect(res.statusCode).toBe(200);
            expect(res.body.id).toMatch(/^resp_/);
            expect(sdkMocks.sessionCreate).toHaveBeenCalledTimes(1);
            expect(sdkMocks.sessionDelete).not.toHaveBeenCalled();

            const followUp = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({ input: 'And a follow-up', previous_response_id: res.body.id });
            expect(followUp.statusCode).toBe(200);
            expect(sdkMocks.sessionCreate).toHaveBeenCalledTimes(1);
            expect(sdkMocks.sessionDelete).not.toHaveBeenCalled();
        });

        test('responses stream error preserves a shared session', async () => {
            const seed = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'opencode/kimi-k2.5', input: 'seed' });
            expect(seed.statusCode).toBe(200);
            sdkMocks.sessionDelete.mockClear();
            sdkMocks.sessionMessages.mockResolvedValue([{ info: { role: 'assistant', finish: 'stop' }, parts: [] }]);
            sdkMocks.eventSubscribe.mockImplementationOnce(eventStream([
                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'test-session-id' }, delta: '<function_calls>{"name":"read" arguments</function_calls>' } },
                { type: 'message.updated', properties: { info: { sessionID: 'test-session-id', finish: 'stop' } } }
            ]));
            const res = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({
                    input: 'Read a.txt',
                    previous_response_id: seed.body.id,
                    stream: true,
                    tools: [{ type: 'function', name: 'read', parameters: readTool.function.parameters }]
                });
            expect(res.text).toContain('response.failed');
            expect(sdkMocks.sessionDelete).not.toHaveBeenCalled();
        });

        test.each([
            ['chat', '/v1/chat/completions', chatStreamPayload],
            ['messages', '/v1/messages', messagesStreamPayload],
            ['responses', '/v1/responses', { model: 'opencode/kimi-k2.5', input: 'Hello', stream: true }]
        ])('%s stream recovery replays only the unsent snapshot suffix', async (_label, path, payload) => {
            sdkMocks.sessionMessages.mockResolvedValue([{
                info: { role: 'assistant', finish: 'stop' },
                parts: [{ type: 'text', text: 'Hello world' }]
            }]);
            sdkMocks.eventSubscribe.mockImplementationOnce(eventStreamThenThrow([
                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'test-session-id' }, delta: 'Hello ' } }
            ]));
            const res = await request(app)
                .post(path)
                .set('Authorization', 'Bearer test-key')
                .set('anthropic-version', '2023-06-01')
                .send(payload);
            expect(res.statusCode).toBe(200);
            expect(visibleTextFor(path, res.text).join('')).toBe('Hello world');
        });

        test.each([
            ['chat', '/v1/chat/completions', chatStreamPayload, 'data: [DONE]'],
            ['messages', '/v1/messages', messagesStreamPayload, 'message_stop'],
            ['responses', '/v1/responses', { model: 'opencode/kimi-k2.5', input: 'Hello', stream: true }, 'response.completed']
        ])('%s stream recovery reports a backend error instead of a normal success', async (_label, path, payload, successMarker) => {
            sdkMocks.sessionMessages.mockResolvedValue([{
                info: { role: 'assistant', finish: 'stop', error: { name: 'MessageAbortedError', data: { message: 'upstream aborted mid-turn' } } },
                parts: []
            }]);
            sdkMocks.eventSubscribe.mockImplementationOnce(eventStreamThenThrow([]));
            const res = await request(app)
                .post(path)
                .set('Authorization', 'Bearer test-key')
                .set('anthropic-version', '2023-06-01')
                .send(payload);
            expect(res.text).toContain('upstream aborted mid-turn');
            expect(res.text).not.toContain('[Proxy Error]');
            expect(res.text).not.toContain(successMarker);
            expect(visibleTextFor(path, res.text)).toEqual([]);
        });
        const readSseFrames = (text) => {
            const frames = [];
            for (const block of text.split(/\r?\n\r?\n/)) {
                const dataLines = block.split(/\r?\n/).filter((line) => line.startsWith('data:'));
                if (dataLines.length === 0) continue;
                const data = dataLines.map((line) => line.slice(5).replace(/^ /, '')).join('\n');
                frames.push(data === '[DONE]' ? '[DONE]' : JSON.parse(data));
            }
            return frames;
        };

        const optionalReasoningSummaryEvents = [
            'response.reasoning_summary_part.added',
            'response.reasoning_summary_part.done',
            'response.reasoning_summary_text.part.added'
        ];

        const assertPhase2SseContract = (text, expectation = {}) => {
            const frames = readSseFrames(text);
            const doneIndexes = frames.reduce((indexes, frame, index) => {
                if (frame === '[DONE]') indexes.push(index);
                return indexes;
            }, []);
            expect(doneIndexes).toEqual([frames.length - 1]);
            const events = frames.slice(0, -1);
            expect(events.length).toBeGreaterThan(0);
            expect(events[0].type).toBe('response.created');
            const created = events[0];
            expect(created.response.status).toBe('in_progress');
            expect(created.response.output).toEqual([]);
            expect(typeof created.response.id).toBe('string');
            expect(typeof created.response.created).toBe('number');
            expect(created.response.created_at).toBe(created.response.created);
            expect(typeof created.response.model).toBe('string');
            expect(Array.isArray(created.response.tools)).toBe(true);
            expect(typeof created.response.parallel_tool_calls).toBe('boolean');
            if (expectation.tools !== undefined) {
                expect(created.response.tools).toEqual(expectation.tools);
                expect(created.response.tools).not.toContainEqual(expect.objectContaining({ name: expect.stringMatching(/^external__/) }));
            }
            if (expectation.parallelToolCalls !== undefined) {
                expect(created.response.parallel_tool_calls).toBe(expectation.parallelToolCalls);
            }
            const terminalTypes = events
                .filter((event) => event.type === 'response.completed' || event.type === 'response.failed')
                .map((event) => event.type);
            expect(terminalTypes).toHaveLength(1);
            const terminal = events[events.length - 1];
            expect(terminal.type).toBe(terminalTypes[0]);
            expect(terminal.response.id).toBe(created.response.id);
            expect(terminal.response.created).toBe(created.response.created);
            expect(terminal.response.created_at).toBe(created.response.created_at);
            expect(terminal.response.model).toBe(created.response.model);
            expect(terminal.response.tools).toEqual(created.response.tools);
            expect(terminal.response.parallel_tool_calls).toBe(created.response.parallel_tool_calls);
            const required = events.filter((event) => !optionalReasoningSummaryEvents.includes(event.type));
            const sequenceNumbers = required.map((event) => event.sequence_number);
            expect(sequenceNumbers).toEqual(required.map((_, index) => index));
            expect(new Set(sequenceNumbers).size).toBe(sequenceNumbers.length);
            const added = events.filter((event) => event.type === 'response.output_item.added');
            const done = events.filter((event) => event.type === 'response.output_item.done');
            expect(added.length).toBeGreaterThan(0);
            const addedKeys = added.map((event) => `${event.output_index}:${event.item.type}:${event.item.id}`);
            expect(new Set(addedKeys).size).toBe(addedKeys.length);
            expect(added.map((event) => event.output_index)).toEqual(added.map((_, index) => index));
            expect(done.map((event) => event.output_index)).toEqual(added.map((event) => event.output_index));
            expect(done.map((event) => event.item.id)).toEqual(added.map((event) => event.item.id));
            expect(done.map((event) => event.item.type)).toEqual(added.map((event) => event.item.type));
            expect(terminal.response.output).toEqual(done.map((event) => event.item));
            const addedPositions = added.map((event) => events.indexOf(event));
            const donePositions = done.map((event) => events.indexOf(event));
            expect(donePositions.every((position, index) => position > addedPositions[index])).toBe(true);
            const deltaTypes = [
                'response.output_text.delta',
                'response.reasoning_summary_text.delta',
                'response.function_call_arguments.delta'
            ];
            const deltaKeys = events
                .filter((event) => deltaTypes.includes(event.type))
                .map((event) => `${event.output_index}:${event.item_id}:${event.type}`);
            expect(new Set(deltaKeys).size).toBe(deltaKeys.length);
            return { frames, events, created, terminal, added, done };
        };

        const setToolStream = (parts) => {
            sdkMocks.eventSubscribe.mockImplementationOnce(eventStream(parts));
        };

        test('Phase 2A tool-only output starts at zero and keeps function arguments in delta and done', async () => {
            setToolStream([
                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'test-session-id' }, delta: '<function_calls>{"id":"call_phase2","name":"read","arguments":{"path":"a.txt"}}</function_calls>' } },
                { type: 'message.updated', properties: { info: { sessionID: 'test-session-id', finish: 'stop' } } },
            ]);
            const res = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'opencode/kimi-k2.5', input: 'Read a.txt', stream: true, tools: [readTool] });
            expect(res.statusCode).toBe(200);
            const contract = assertPhase2SseContract(res.text);
            expect(contract.events.map((event) => event.type)).toEqual([
                'response.created',
                'response.output_item.added',
                'response.function_call_arguments.delta',
                'response.function_call_arguments.done',
                'response.output_item.done',
                'response.completed'
            ]);
            expect(contract.added.map((event) => event.item)).toEqual([
                { id: 'call_phase2', type: 'function_call', status: 'in_progress', call_id: 'call_phase2', name: 'read', arguments: '' }
            ]);
            expect(contract.events.filter((event) => event.type === 'response.function_call_arguments.delta').map((event) => [event.item_id, event.output_index, event.delta])).toEqual([
                ['call_phase2', 0, '{"path":"a.txt"}']
            ]);
            expect(contract.events.filter((event) => event.type === 'response.function_call_arguments.done').map((event) => [event.item_id, event.output_index, event.arguments])).toEqual([
                ['call_phase2', 0, '{"path":"a.txt"}']
            ]);
            expect(contract.done.map((event) => event.item)).toEqual([
                { id: 'call_phase2', type: 'function_call', status: 'completed', call_id: 'call_phase2', name: 'read', arguments: '{"path":"a.txt"}' }
            ]);
            expect(contract.terminal.response.output).toEqual(contract.done.map((event) => event.item));
        });

        test('Phase 2A reasoning-first output indexes follow added order', async () => {
            setToolStream([
                { type: 'message.part.updated', properties: { part: { type: 'reasoning', sessionID: 'test-session-id' }, delta: 'Think first.' } },
                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'test-session-id' }, delta: '<function_calls>{"id":"call_reasoning_phase2","name":"read","arguments":{"path":"b.txt"}}</function_calls>' } },
                { type: 'message.updated', properties: { info: { sessionID: 'test-session-id', finish: 'stop' } } },
            ]);
            const res = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'opencode/kimi-k2.5', input: 'Read b.txt', stream: true, tools: [readTool] });
            expect(res.statusCode).toBe(200);
            const contract = assertPhase2SseContract(res.text);
            expect(contract.events.map((event) => event.type)).toEqual([
                'response.created',
                'response.output_item.added',
                'response.reasoning_summary_text.delta',
                'response.output_item.added',
                'response.function_call_arguments.delta',
                'response.reasoning_summary_text.done',
                'response.output_item.done',
                'response.function_call_arguments.done',
                'response.output_item.done',
                'response.completed'
            ]);
            expect(contract.added.map((event) => [event.output_index, event.item])).toEqual([
                [0, { id: 'reasoning-0', type: 'reasoning', status: 'in_progress', summary: [{ type: 'summary_text', text: '' }] }],
                [1, { id: 'call_reasoning_phase2', type: 'function_call', status: 'in_progress', call_id: 'call_reasoning_phase2', name: 'read', arguments: '' }]
            ]);
            expect(contract.events.filter((event) => event.type === 'response.reasoning_summary_text.delta').map((event) => [event.item_id, event.output_index, event.delta])).toEqual([
                ['reasoning-0', 0, 'Think first.']
            ]);
            expect(contract.done.map((event) => event.item)).toEqual([
                { id: 'reasoning-0', type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: 'Think first.' }] },
                { id: 'call_reasoning_phase2', type: 'function_call', status: 'completed', call_id: 'call_reasoning_phase2', name: 'read', arguments: '{"path":"b.txt"}' }
            ]);
            expect(contract.terminal.response.output).toEqual(contract.done.map((event) => event.item));
        });

        test('Phase 2A text-plus-tool output indexes follow added order', async () => {
            setToolStream([
                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'test-session-id' }, delta: 'Visible text.' } },
                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'test-session-id' }, delta: '<function_calls>{"id":"call_text_phase2","name":"read","arguments":{"path":"b.txt"}}</function_calls>' } },
                { type: 'message.updated', properties: { info: { sessionID: 'test-session-id', finish: 'stop' } } },
            ]);
            const res = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'opencode/kimi-k2.5', input: 'Read b.txt', stream: true, tools: [readTool] });
            expect(res.statusCode).toBe(200);
            const contract = assertPhase2SseContract(res.text);
            expect(contract.events.map((event) => event.type)).toEqual([
                'response.created',
                'response.output_item.added',
                'response.content_part.added',
                'response.output_text.delta',
                'response.output_item.added',
                'response.function_call_arguments.delta',
                'response.output_text.done',
                'response.content_part.done',
                'response.output_item.done',
                'response.function_call_arguments.done',
                'response.output_item.done',
                'response.completed'
            ]);
            const messageId = contract.added[0].item.id;
            expect(contract.added.map((event) => event.item)).toEqual([
                { id: messageId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
                { id: 'call_text_phase2', type: 'function_call', status: 'in_progress', call_id: 'call_text_phase2', name: 'read', arguments: '' }
            ]);
            expect(contract.events.filter((event) => event.type === 'response.output_text.delta').map((event) => [event.item_id, event.output_index, event.delta])).toEqual([
                [messageId, 0, 'Visible text.']
            ]);
            expect(contract.done.map((event) => event.item)).toEqual([
                { id: messageId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Visible text.', annotations: [] }] },
                { id: 'call_text_phase2', type: 'function_call', status: 'completed', call_id: 'call_text_phase2', name: 'read', arguments: '{"path":"b.txt"}' }
            ]);
            expect(contract.terminal.response.output).toEqual(contract.done.map((event) => event.item));
        });

        test('Phase 2A search-plus-tool output uses contiguous search and function indexes', async () => {
            sdkMocks.sessionMessages.mockResolvedValue([{
                info: { role: 'assistant', finish: 'stop' },
                parts: [{ type: 'tool', tool: 'websearch', state: { status: 'completed', input: { query: 'phase2 query' }, output: 'source https://example.com/phase2' } }],
            }]);
            setToolStream([
                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'test-session-id' }, delta: '<function_calls>{"id":"call_search_phase2","name":"read","arguments":{"path":"c.txt"}}</function_calls>' } },
                { type: 'message.updated', properties: { info: { sessionID: 'test-session-id', finish: 'stop' } } },
            ]);
            const res = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'opencode/kimi-k2.5', input: 'Search and read', stream: true, tools: [{ type: 'web_search' }, readTool] });
            expect(res.statusCode).toBe(200);
            const contract = assertPhase2SseContract(res.text);
            expect(contract.events.map((event) => event.type)).toEqual([
                'response.created',
                'response.output_item.added',
                'response.web_search_call.searching',
                'response.web_search_call.completed',
                'response.output_item.added',
                'response.function_call_arguments.delta',
                'response.output_item.done',
                'response.function_call_arguments.done',
                'response.output_item.done',
                'response.completed'
            ]);
            expect(contract.added.map((event) => event.item)).toEqual([
                { id: 'ws_1', type: 'web_search_call', status: 'in_progress' },
                { id: 'call_search_phase2', type: 'function_call', status: 'in_progress', call_id: 'call_search_phase2', name: 'read', arguments: '' }
            ]);
            expect(contract.done.map((event) => event.item)).toEqual([
                { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'phase2 query' } },
                { id: 'call_search_phase2', type: 'function_call', status: 'completed', call_id: 'call_search_phase2', name: 'read', arguments: '{"path":"c.txt"}' }
            ]);
            expect(contract.terminal.response.output).toEqual(contract.done.map((event) => event.item));
        });

        test('Phase 2A search-plus-text output announces the search call first in stream and non-stream', async () => {
            const answer = 'Search result at https://example.com/phase2';
            const expectedAnnotations = [{
                type: 'url_citation',
                start_index: 17,
                end_index: 43,
                url: 'https://example.com/phase2',
                title: 'example.com'
            }];
            const expectedSearchItem = {
                id: 'ws_1',
                type: 'web_search_call',
                status: 'completed',
                action: { type: 'search', query: 'phase2 query' }
            };
            const withFixedMessageId = (items) => items.map((item) => (
                item.type === 'message' ? { ...item, id: '<message-id>' } : item
            ));
            const searchAnswerMessages = [{
                info: { role: 'assistant', finish: 'stop' },
                parts: [
                    { type: 'text', text: answer },
                    { type: 'tool', tool: 'websearch', state: { status: 'completed', input: { query: 'phase2 query' }, output: 'source https://example.com/phase2' } },
                ],
            }];

            sdkMocks.sessionMessages.mockResolvedValue(searchAnswerMessages);
            setToolStream([
                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'test-session-id' }, delta: answer } },
                { type: 'message.updated', properties: { info: { sessionID: 'test-session-id', finish: 'stop' } } },
            ]);
            const streamed = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'opencode/kimi-k2.5', input: 'Search for phase 2', stream: true, tools: [{ type: 'web_search' }, readTool] });
            expect(streamed.statusCode).toBe(200);
            const contract = assertPhase2SseContract(streamed.text, { tools: [{ type: 'web_search' }, readTool], parallelToolCalls: true });
            expect(contract.events.map((event) => event.type)).toEqual([
                'response.created',
                'response.output_item.added',
                'response.web_search_call.searching',
                'response.web_search_call.completed',
                'response.output_item.added',
                'response.content_part.added',
                'response.output_text.delta',
                'response.output_item.done',
                'response.output_text.done',
                'response.content_part.done',
                'response.output_item.done',
                'response.completed'
            ]);
            expect(contract.added.map((event) => [event.output_index, event.item.type, event.item.id])).toEqual([
                [0, 'web_search_call', 'ws_1'],
                [1, 'message', contract.added[1].item.id]
            ]);
            expect(contract.added[1].item.id).toMatch(/^msg_/);
            expect(contract.done.map((event) => [event.output_index, event.item.type, event.item.id])).toEqual([
                [0, 'web_search_call', 'ws_1'],
                [1, 'message', contract.added[1].item.id]
            ]);
            expect(contract.events.filter((event) => event.type === 'response.output_text.delta').map((event) => [event.output_index, event.delta])).toEqual([[1, answer]]);
            expect(contract.events.filter((event) => event.type === 'response.output_text.done').map((event) => [event.output_index, event.text])).toEqual([[1, answer]]);
            expect(contract.terminal.type).toBe('response.completed');
            expect(withFixedMessageId(contract.terminal.response.output)).toEqual([
                expectedSearchItem,
                {
                    id: '<message-id>',
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [{ type: 'output_text', text: answer, annotations: expectedAnnotations }]
                }
            ]);

            sdkMocks.sessionMessages.mockResolvedValue(searchAnswerMessages);
            sdkMocks.sessionPrompt.mockResolvedValueOnce({ data: { parts: [] } });
            const nonStreamed = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'opencode/kimi-k2.5', input: 'Search for phase 2', tools: [{ type: 'web_search' }, readTool] });
            expect(nonStreamed.statusCode).toBe(200);
            expect(nonStreamed.body.status).toBe('completed');
            expect(nonStreamed.body.output.map((item) => item.type)).toEqual(['web_search_call', 'message']);
            expect(nonStreamed.body.output[1].id).toMatch(/^msg_/);
            expect(withFixedMessageId(nonStreamed.body.output)).toEqual(withFixedMessageId(contract.terminal.response.output));
        });

        test('Phase 2A hosted search without external tools defers reasoning and text behind the search call', async () => {
            const reasoningText = 'Look up the docs first.';
            const answer = 'Grounded at https://example.com/phase2';
            const expectedAnnotations = [{
                type: 'url_citation',
                start_index: 12,
                end_index: 38,
                url: 'https://example.com/phase2',
                title: 'example.com'
            }];
            const expectedSearchItem = {
                id: 'ws_1',
                type: 'web_search_call',
                status: 'completed',
                action: { type: 'search', query: 'phase2 query' }
            };
            const withFixedMessageId = (items) => items.map((item) => (
                item.type === 'message' ? { ...item, id: '<message-id>' } : item
            ));
            const searchReasoningAnswerMessages = [{
                info: { role: 'assistant', finish: 'stop' },
                parts: [
                    { type: 'reasoning', text: reasoningText },
                    { type: 'text', text: answer },
                    { type: 'tool', tool: 'websearch', state: { status: 'completed', input: { query: 'phase2 query' }, output: 'source https://example.com/phase2' } },
                ],
            }];

            sdkMocks.sessionMessages.mockResolvedValue(searchReasoningAnswerMessages);
            setToolStream([
                { type: 'message.part.updated', properties: { part: { type: 'reasoning', sessionID: 'test-session-id' }, delta: reasoningText } },
                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'test-session-id' }, delta: answer } },
                { type: 'message.updated', properties: { info: { sessionID: 'test-session-id', finish: 'stop' } } },
            ]);
            const streamed = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'opencode/kimi-k2.5', input: 'Search for phase 2', stream: true, tools: [{ type: 'web_search' }] });
            expect(streamed.statusCode).toBe(200);
            const contract = assertPhase2SseContract(streamed.text, { tools: [{ type: 'web_search' }], parallelToolCalls: true });
            expect(contract.events.map((event) => event.type)).toEqual([
                'response.created',
                'response.output_item.added',
                'response.web_search_call.searching',
                'response.web_search_call.completed',
                'response.output_item.added',
                'response.reasoning_summary_text.delta',
                'response.output_item.added',
                'response.content_part.added',
                'response.output_text.delta',
                'response.output_item.done',
                'response.reasoning_summary_text.done',
                'response.output_item.done',
                'response.output_text.done',
                'response.content_part.done',
                'response.output_item.done',
                'response.completed'
            ]);
            const messageId = contract.added[2].item.id;
            expect(contract.added.map((event) => [event.output_index, event.item.type, event.item.id])).toEqual([
                [0, 'web_search_call', 'ws_1'],
                [1, 'reasoning', 'reasoning-0'],
                [2, 'message', messageId]
            ]);
            expect(messageId).toMatch(/^msg_/);
            expect(contract.done.map((event) => [event.output_index, event.item.type, event.item.id])).toEqual([
                [0, 'web_search_call', 'ws_1'],
                [1, 'reasoning', 'reasoning-0'],
                [2, 'message', messageId]
            ]);
            expect(contract.events.filter((event) => event.type === 'response.reasoning_summary_text.delta').map((event) => [event.output_index, event.item_id, event.delta])).toEqual([
                [1, 'reasoning-0', reasoningText]
            ]);
            expect(contract.events.filter((event) => event.type === 'response.output_text.delta').map((event) => [event.output_index, event.item_id, event.delta])).toEqual([
                [2, messageId, answer]
            ]);
            const searchAnnouncedFirst = contract.events
                .filter((event) => event.type === 'response.output_item.added')
                .map((event) => event.item.type);
            expect(searchAnnouncedFirst.indexOf('web_search_call')).toBe(0);
            expect(contract.events.findIndex((event) => event.type === 'response.output_text.delta')).toBeGreaterThan(
                contract.events.findIndex((event) => event.type === 'response.web_search_call.completed')
            );
            expect(contract.terminal.type).toBe('response.completed');
            expect(contract.terminal.response.output).toEqual(contract.done.map((event) => event.item));
            expect(withFixedMessageId(contract.terminal.response.output)).toEqual([
                expectedSearchItem,
                { id: 'reasoning-0', type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: reasoningText }] },
                {
                    id: '<message-id>',
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [{ type: 'output_text', text: answer, annotations: expectedAnnotations }]
                }
            ]);

            sdkMocks.sessionMessages.mockResolvedValue(searchReasoningAnswerMessages);
            sdkMocks.sessionPrompt.mockResolvedValueOnce({ data: { parts: [] } });
            const nonStreamed = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'opencode/kimi-k2.5', input: 'Search for phase 2', tools: [{ type: 'web_search' }] });
            expect(nonStreamed.statusCode).toBe(200);
            expect(nonStreamed.body.status).toBe('completed');
            expect(nonStreamed.body.output.map((item) => item.type)).toEqual(['web_search_call', 'message']);
            expect(nonStreamed.body.output[0]).toEqual(expectedSearchItem);
            expect(nonStreamed.body.output[1].id).toMatch(/^msg_/);
            expect(withFixedMessageId(nonStreamed.body.output)).toEqual([
                expectedSearchItem,
                {
                    id: '<message-id>',
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [{ type: 'output_text', text: answer, annotations: expectedAnnotations }]
                }
            ]);
            const withoutReasoning = contract.terminal.response.output.filter((item) => item.type !== 'reasoning');
            expect(withFixedMessageId(withoutReasoning)).toEqual(withFixedMessageId(nonStreamed.body.output));
        });

        test('Phase 2A mid-stream failure finalizes the announced item and reports it as partial failed output', async () => {
            setToolStream([
                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'test-session-id' }, delta: 'Partial answer' } },
                { type: 'message.updated', properties: { info: { sessionID: 'test-session-id', error: { name: 'MessageAbortedError', data: { message: 'upstream aborted mid-turn' } } } } },
            ]);
            const res = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'opencode/kimi-k2.5', input: 'Hello', stream: true });
            expect(res.statusCode).toBe(200);
            const contract = assertPhase2SseContract(res.text, { tools: [], parallelToolCalls: true });
            expect(contract.events.map((event) => event.type)).toEqual([
                'response.created',
                'response.output_item.added',
                'response.content_part.added',
                'response.output_text.delta',
                'response.output_text.done',
                'response.content_part.done',
                'response.output_item.done',
                'response.failed'
            ]);
            const messageId = contract.added[0].item.id;
            expect(messageId).toMatch(/^msg_/);
            expect(contract.added.map((event) => [event.output_index, event.item.type, event.item.id])).toEqual([
                [0, 'message', messageId]
            ]);
            expect(contract.events.filter((event) => event.type === 'response.output_text.done').map((event) => [event.output_index, event.content_index, event.item_id, event.text])).toEqual([
                [0, 0, messageId, 'Partial answer']
            ]);
            expect(contract.events.filter((event) => event.type === 'response.content_part.done').map((event) => [event.output_index, event.content_index, event.part])).toEqual([
                [0, 0, { type: 'output_text', text: 'Partial answer', annotations: [] }]
            ]);
            const partialMessageItem = {
                id: messageId,
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'Partial answer', annotations: [] }]
            };
            expect(contract.done.map((event) => [event.output_index, event.item])).toEqual([
                [0, partialMessageItem]
            ]);
            expect(contract.terminal.type).toBe('response.failed');
            expect(contract.terminal.response.status).toBe('failed');
            expect(contract.terminal.response.completed_at).toBeNull();
            expect(contract.terminal.response.incomplete_details).toBeNull();
            expect(contract.terminal.response.usage).toBeNull();
            expect(contract.terminal.response.output).toEqual([partialMessageItem]);
            expect(contract.terminal.response.error).toEqual({
                message: 'upstream aborted mid-turn',
                type: 'internal_error',
                code: 'MessageAbortedError'
            });
        });

        test.each([
            [
                'missing input',
                { model: 'opencode/kimi-k2.5', stream: true, tools: [readTool] },
                'input is required'
            ],
            [
                'empty input array',
                { model: 'opencode/kimi-k2.5', input: [], stream: true, tools: [readTool] },
                'input is required'
            ],
            [
                'unknown tool_choice',
                {
                    model: 'opencode/kimi-k2.5',
                    input: 'Use a missing tool',
                    stream: true,
                    tools: [readTool],
                    tool_choice: { type: 'function', name: 'missing' }
                },
                'tool_choice references an unknown tool: missing'
            ],
            [
                'unknown previous_response_id',
                {
                    model: 'opencode/kimi-k2.5',
                    input: 'Hello',
                    stream: true,
                    tools: [readTool],
                    previous_response_id: 'resp_phase2_missing'
                },
                'Invalid or expired previous_response_id'
            ]
        ])('Phase 2A preflight %s stays a 200 SSE created then failed then done lifecycle', async (_label, payload, errorMessage) => {
            const res = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send(payload);
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toBe('text/event-stream');
            const frames = readSseFrames(res.text);
            expect(frames).toHaveLength(3);
            expect(frames[0].type).toBe('response.created');
            expect(frames[1].type).toBe('response.failed');
            expect(frames[2]).toBe('[DONE]');
            const created = frames[0];
            const failed = frames[1];
            expect(created.response.status).toBe('in_progress');
            expect(created.response.output).toEqual([]);
            expect(created.response.model).toBe('opencode/kimi-k2.5');
            expect(failed.response.id).toBe(created.response.id);
            expect(failed.response.created).toBe(created.response.created);
            expect(failed.response.created_at).toBe(created.response.created_at);
            expect(failed.response.model).toBe(created.response.model);
            expect(failed.response.completed_at).toBeNull();
            expect(failed.response.status).toBe('failed');
            expect(failed.response.output).toEqual([]);
            expect(failed.response.usage).toBeNull();
            expect(failed.response.incomplete_details).toBeNull();
            expect(failed.response.error).toEqual({
                message: errorMessage,
                type: 'invalid_request_error',
                code: 'invalid_request_error'
            });
            expect([created.sequence_number, failed.sequence_number]).toEqual([0, 1]);
            expect(created.response.tools).toEqual([readTool]);
            expect(failed.response.tools).toEqual([readTool]);
            expect(created.response.parallel_tool_calls).toBe(true);
            expect(failed.response.parallel_tool_calls).toBe(true);
            expect(frames.some((frame) => frame !== '[DONE]' && frame.type === 'response.output_item.added')).toBe(false);
            expect(res.text).not.toContain('response.completed');
            expect(sdkMocks.sessionCreate).not.toHaveBeenCalled();
            expect(sdkMocks.eventSubscribe).not.toHaveBeenCalled();
        });

        test.each([
            ['provider qualified', { model: 'opencode/kimi-k2.5' }, 'opencode/kimi-k2.5'],
            ['bare alias', { model: 'kimi-k2.5' }, 'opencode/kimi-k2.5'],
            ['gpt4 alias', { model: 'gpt4' }, 'opencode/gpt-4'],
            ['no model', {}, 'opencode/kimi-k2.5']
        ])('Phase 2A %s request announces the resolved model in created and completed', async (_label, modelField, resolved) => {
            setToolStream([
                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'test-session-id' }, delta: 'Plain answer.' } },
                { type: 'message.updated', properties: { info: { sessionID: 'test-session-id', finish: 'stop' } } }
            ]);
            const res = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({ ...modelField, input: 'Hello', stream: true });
            expect(res.statusCode).toBe(200);
            const contract = assertPhase2SseContract(res.text, { tools: [], parallelToolCalls: true });
            expect(contract.created.response.model).toBe(resolved);
            expect(contract.terminal.response.model).toBe(resolved);
            expect(contract.terminal.type).toBe('response.completed');
            expect(contract.terminal.response.output.map((item) => item.content[0].text)).toEqual(['Plain answer.']);
        });

        test('Phase 2A pre-resolve failure keeps the request model in created and failed', async () => {
            const res = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({
                    model: 'kimi-k2.5',
                    input: 'Use a missing tool',
                    stream: true,
                    tools: [readTool],
                    tool_choice: { type: 'function', name: 'missing' }
                });
            expect(res.statusCode).toBe(200);
            const frames = readSseFrames(res.text);
            expect(frames.map((frame) => (frame === '[DONE]' ? frame : frame.type))).toEqual([
                'response.created',
                'response.failed',
                '[DONE]'
            ]);
            expect(frames[0].response.model).toBe('kimi-k2.5');
            expect(frames[1].response.model).toBe('kimi-k2.5');
        });

        test('Phase 2A pre-resolve failure without a model announces unknown', async () => {
            const res = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({
                    input: 'Use a missing tool',
                    stream: true,
                    tools: [readTool],
                    tool_choice: { type: 'function', name: 'missing' }
                });
            expect(res.statusCode).toBe(200);
            const frames = readSseFrames(res.text);
            expect(frames.map((frame) => (frame === '[DONE]' ? frame : frame.type))).toEqual([
                'response.created',
                'response.failed',
                '[DONE]'
            ]);
            expect(frames[0].response.model).toBe('unknown');
            expect(frames[1].response.model).toBe('unknown');
        });

        test('Phase 2A post-resolve failure keeps the resolved model in created and failed', async () => {
            sdkMocks.sessionCreate.mockRejectedValueOnce(new Error('backend refused the session'));
            const res = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'gpt4', input: 'Hello', stream: true });
            expect(res.statusCode).toBe(200);
            const frames = readSseFrames(res.text);
            expect(frames.map((frame) => (frame === '[DONE]' ? frame : frame.type))).toEqual([
                'response.created',
                'response.failed',
                '[DONE]'
            ]);
            expect(frames[0].response.model).toBe('opencode/gpt-4');
            expect(frames[1].response.model).toBe('opencode/gpt-4');
        });

        test('Phase 2A stream echoes request tools and parallel setting without internal metadata', async () => {
            const requestedTools = [{ type: 'web_search' }, readTool];
            setToolStream([
                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'test-session-id' }, delta: '<function_calls>{"id":"call_echo","name":"read","arguments":{"path":"a.txt"}}</function_calls>' } },
                { type: 'message.updated', properties: { info: { sessionID: 'test-session-id', finish: 'stop' } } }
            ]);
            const res = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({
                    model: 'opencode/kimi-k2.5',
                    input: 'Read a.txt',
                    stream: true,
                    tools: requestedTools,
                    parallel_tool_calls: false,
                    opencode: { internal_allowed_tools: ['bash'] }
                });
            expect(res.statusCode).toBe(200);
            const contract = assertPhase2SseContract(res.text, { tools: requestedTools, parallelToolCalls: false });
            expect(contract.terminal.response.tools).toEqual(requestedTools);
            expect(res.text).not.toContain('internal_allowed_tools');
            expect(res.text).not.toContain('external__');
            expect(res.text).not.toContain('"websearch"');
        });

        test('Phase 2A stream defaults parallel tool calls to true when the request omits it', async () => {
            setToolStream([
                { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'test-session-id' }, delta: '<function_calls>{"id":"call_parallel_default","name":"read","arguments":{"path":"a.txt"}}</function_calls>' } },
                { type: 'message.updated', properties: { info: { sessionID: 'test-session-id', finish: 'stop' } } }
            ]);
            const res = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'opencode/kimi-k2.5', input: 'Read a.txt', stream: true, tools: [readTool] });
            expect(res.statusCode).toBe(200);
            const contract = assertPhase2SseContract(res.text, { tools: [readTool], parallelToolCalls: true });
            expect(contract.terminal.response.parallel_tool_calls).toBe(true);
        });

        test('Phase 2A non-stream response echoes request tools and parallel setting', async () => {
            sdkMocks.sessionPrompt.mockResolvedValueOnce({
                data: {
                    parts: [{ type: 'text', text: '<function_calls>{"id":"call_ns_echo","name":"read","arguments":{"path":"a.txt"}}</function_calls>' }]
                }
            });
            const requestedTools = [{ type: 'web_search' }, readTool];
            const res = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({
                    model: 'opencode/kimi-k2.5',
                    input: 'Read a.txt',
                    tools: requestedTools,
                    parallel_tool_calls: false,
                    opencode: { internal_allowed_tools: ['bash'] }
                });
            expect(res.statusCode).toBe(200);
            expect(res.body.object).toBe('response');
            expect(res.body.model).toBe('opencode/kimi-k2.5');
            expect(res.body.tools).toEqual(requestedTools);
            expect(res.body.parallel_tool_calls).toBe(false);
            expect(res.body.output).toEqual([
                { id: 'call_ns_echo', type: 'function_call', status: 'completed', call_id: 'call_ns_echo', name: 'read', arguments: '{"path":"a.txt"}' }
            ]);
            expect(res.text).not.toContain('internal_allowed_tools');
            expect(res.text).not.toContain('external__');
        });

        test('Phase 2A non-stream response reports no tools and true parallel calls by default', async () => {
            const res = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'opencode/kimi-k2.5', input: 'Hello' });
            expect(res.statusCode).toBe(200);
            expect(res.body.tools).toEqual([]);
            expect(res.body.parallel_tool_calls).toBe(true);
        });

        test('Phase 2A stream rejects conflicting arguments under one explicit function_call id', async () => {
            setToolStream([
                {
                    type: 'message.part.updated',
                    properties: {
                        part: { type: 'text', sessionID: 'test-session-id' },
                        delta: '<function_calls>[{"id":"call_conflict","name":"read","arguments":{"path":"a.txt"}},{"id":"call_conflict","name":"read","arguments":{"path":"b.txt"}}]</function_calls>'
                    }
                },
                { type: 'message.updated', properties: { info: { sessionID: 'test-session-id', finish: 'stop' } } }
            ]);
            const res = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'opencode/kimi-k2.5', input: 'Read a.txt', stream: true, tools: [readTool] });
            expect(res.statusCode).toBe(200);
            const frames = readSseFrames(res.text);
            expect(frames.map((frame) => (frame === '[DONE]' ? frame : frame.type))).toEqual([
                'response.created',
                'response.failed',
                '[DONE]'
            ]);
            const [created, failed] = frames;
            expect(created.response.model).toBe('opencode/kimi-k2.5');
            expect(failed.response.model).toBe('opencode/kimi-k2.5');
            expect(failed.response.error.code).toBe('duplicate_external_tool_call_id');
            expect(failed.response.error.message).toContain('duplicate external tool call id');
            expect(failed.response.output).toEqual([]);
            expect(frames.some((frame) => frame !== '[DONE]' && String(frame.type).startsWith('response.function_call'))).toBe(false);
            expect(frames.some((frame) => frame !== '[DONE]' && frame.type === 'response.output_item.added')).toBe(false);
        });

        test('Phase 2A non-stream rejects conflicting arguments under one explicit function_call id', async () => {
            sdkMocks.sessionPrompt.mockResolvedValueOnce({
                data: {
                    parts: [{ type: 'text', text: '<function_calls>[{"id":"call_conflict","name":"read","arguments":{"path":"a.txt"}},{"id":"call_conflict","name":"read","arguments":{"path":"b.txt"}}]</function_calls>' }]
                }
            });
            const res = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'opencode/kimi-k2.5', input: 'Read a.txt', tools: [readTool] });
            expect(res.statusCode).toBe(500);
            expect(res.body.code).toBe('duplicate_external_tool_call_id');
            expect(res.body.message).toContain('duplicate external tool call id');
            expect(res.body.output).toBeUndefined();
            expect(res.text).not.toContain('"call_id":"call_conflict"');
        });

    });

    test('chains follow-up turns onto the stored session without recreating it', async () => {
        sdkMocks.sessionMessages.mockReset();
        sdkMocks.sessionMessages.mockResolvedValue([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [{ type: 'text', text: 'Mock response' }]
            }
        ]);
        sdkMocks.eventSubscribe.mockReset();
        sdkMocks.sessionCreate.mockClear();
        sdkMocks.sessionDelete.mockClear();
        sdkMocks.configUpdate.mockClear();

        const first = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/kimi-k2.5', input: 'Hello' });

        expect(first.statusCode).toEqual(200);
        expect(first.body.id).toMatch(/^resp_/);
        expect(sdkMocks.sessionCreate).toHaveBeenCalledTimes(1);

        const followUp = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                input: 'And a follow-up question',
                previous_response_id: first.body.id
            });

        expect(followUp.statusCode).toEqual(200);
        // The stored OpenCode session is reused; no new session, no teardown.
        expect(sdkMocks.sessionCreate).toHaveBeenCalledTimes(1);
        expect(sdkMocks.sessionDelete).not.toHaveBeenCalled();
        // Model falls back to the one recorded with the previous response.
        const lastUpdate = sdkMocks.configUpdate.mock.calls.at(-1)?.[0];
        expect(lastUpdate?.body?.activeModel).toEqual({ providerID: 'opencode', modelID: 'kimi-k2.5' });
    });

    test('rejects an invalid previous_response_id', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({ input: 'Hello', previous_response_id: 'resp_does-not-exist' });

        expect(res.statusCode).toEqual(400);
        expect(res.body.error.message).toContain('previous_response_id');
    });
});
});