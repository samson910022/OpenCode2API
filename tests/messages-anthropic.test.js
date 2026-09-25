import request from 'supertest';
import { jest } from '@jest/globals';

const sdkMocks = {
    configProviders: jest.fn(async () => ({
        data: {
            providers: [{ id: 'opencode', models: { 'muse-spark-1.3-contributor-free': { name: 'Muse Spark' }, 'kimi-k2.5': { name: 'Kimi' } } }]
        }
    })),
    configUpdate: jest.fn(async () => ({})),
    toolIds: jest.fn(async () => ({ data: ['web_fetch', 'filesystem', 'bash'] })),
    sessionCreate: jest.fn(async () => ({ data: { id: 'msg-session' } })),
    sessionPrompt: jest.fn(async () => ({ data: { parts: [{ type: 'text', text: 'Hello!' }] } })),
    sessionMessages: jest.fn(async () => ([{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Hello!' }] }])),
    sessionDelete: jest.fn(async () => ({})),
    eventSubscribe: jest.fn(async () => ({
        stream: (async function* () {
            yield { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'msg-session' }, delta: 'Hello' } };
            yield { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'msg-session' }, delta: '!' } };
            yield { type: 'message.updated', properties: { info: { sessionID: 'msg-session', finish: 'stop' } } };
        })()
    }))
};

jest.unstable_mockModule('https', () => ({
    default: {
        get: jest.fn((url, options, callback) => {
            const res = { statusCode: 200, headers: { 'content-type': 'image/png' }, on: jest.fn((event, handler) => { if (event === 'data') handler(Buffer.from('x')); if (event === 'end') handler(); }) };
            callback(res);
            return { on: jest.fn(), destroy: jest.fn() };
        })
    }
}));

jest.unstable_mockModule('http', () => ({
    default: {
        get: jest.fn((url, options, callback) => {
            // checkHealth path -> 200; image downloads -> empty
            if (String(url).includes('/health')) {
                const res = { statusCode: 200, headers: {}, on: jest.fn() };
                callback(res);
                return { on: jest.fn(), destroy: jest.fn(), setTimeout: jest.fn() };
            }
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
        session: { create: sdkMocks.sessionCreate, prompt: sdkMocks.sessionPrompt, messages: sdkMocks.sessionMessages, delete: sdkMocks.sessionDelete },
        event: { subscribe: sdkMocks.eventSubscribe }
    }))
}));

const { createApp } = await import('../src/proxy.js');
import {
    validateMessagesRequest,
    anthropicMessagesToChatMessages,
    anthropicToolsToChatTools,
    anthropicToolChoiceToChat,
    mapFinishToStopReason
} from '../src/converters/anthropic.js';

function parseMessagesSseFrames(text) {
    const frames = [];
    const blocks = String(text || '').split('\n\n');
    for (const block of blocks) {
        const trimmed = block.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith(':')) continue;
        const lines = block.split('\n');
        let eventName = null;
        let dataText = null;
        for (const line of lines) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataText = line.slice(5).trim();
        }
        if (!eventName || dataText === null) continue;
        let data = null;
        try {
            data = JSON.parse(dataText);
        } catch {
            data = dataText;
        }
        frames.push({ event: eventName, data });
    }
    return frames;
}

function messagesToolStarts(frames) {
    return frames.filter((f) => f.event === 'content_block_start' && f.data && f.data.content_block && f.data.content_block.type === 'tool_use');
}

function messagesInputDeltas(frames) {
    return frames.filter((f) => f.event === 'content_block_delta' && f.data && f.data.delta && f.data.delta.type === 'input_json_delta');
}

function messagesThinkingStarts(frames) {
    return frames.filter((f) => f.event === 'content_block_start' && f.data && f.data.content_block && f.data.content_block.type === 'thinking');
}

function messagesThinkingDeltas(frames) {
    return frames.filter((f) => f.event === 'content_block_delta' && f.data && f.data.delta && f.data.delta.type === 'thinking_delta');
}

function messagesTextDeltas(frames) {
    return frames.filter((f) => f.event === 'content_block_delta' && f.data && f.data.delta && f.data.delta.type === 'text_delta');
}

describe('Anthropic /v1/messages converters', () => {
    test('validation requires model/max_tokens/messages', () => {
        expect(validateMessagesRequest({})).not.toBeNull();
        expect(validateMessagesRequest({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })).toBeNull();
        expect(validateMessagesRequest({ model: 'm', max_tokens: 10, messages: [{ role: 'assistant', content: 'hi' }] }).statusCode).toBe(400);
    });
    test('tool_use/tool_result round-trip preserves toolu_ id', () => {
        const chat = anthropicMessagesToChatMessages([
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_abc', name: 'weather_lookup', input: { city: 'Tokyo' } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_abc', content: 'sunny' }] }
        ]);
        const flat = JSON.stringify(chat);
        expect(flat).toContain('toolu_abc');
        expect(flat).toContain('tool_call_id');
    });
    test('tools input_schema and tool_choice mapping', () => {
        expect(anthropicToolsToChatTools([{ name: 'w', input_schema: { type: 'object' } }])[0].function.parameters).toEqual({ type: 'object' });
        expect(anthropicToolChoiceToChat({ type: 'any' })).toBe('required');
        expect(anthropicToolChoiceToChat({ type: 'tool', name: 'w' })).toEqual({ type: 'function', function: { name: 'w' } });
        expect(mapFinishToStopReason('stop', true)).toBe('tool_use');
    });

    test('preserves enabled but drops proxy-reserved metadata in converted tools', () => {
        const converted = anthropicToolsToChatTools([{
            name: 'w',
            input_schema: { type: 'object' },
            enabled: false,
            x_proxy_side_effect: 'write',
            x_proxy_risk_level: 'high',
            x_proxy_requires_confirmation: true
        }]);

        expect(converted[0].function.enabled).toBe(false);
        expect(converted[0].function.x_proxy_side_effect).toBeUndefined();
        expect(converted[0].function.x_proxy_risk_level).toBeUndefined();
        expect(converted[0].function.x_proxy_requires_confirmation).toBeUndefined();
        expect(JSON.stringify(converted)).not.toContain('x_proxy_');
    });

    test('does not convert a tool choice without a name to required', () => {
        expect(anthropicToolChoiceToChat({ type: 'tool' })).toBeUndefined();
        expect(validateMessagesRequest({
            model: 'm',
            max_tokens: 10,
            messages: [{ role: 'user', content: 'hi' }],
            tool_choice: { type: 'tool' }
        })).toMatchObject({
            statusCode: 400,
            body: { type: 'error', error: { type: 'invalid_request_error' } }
        });
    });
});

describe('POST /v1/messages', () => {
    let app;
    beforeEach(() => {
        jest.clearAllMocks();
        const config = { PORT: 10000, API_KEY: 'test-key', OPENCODE_SERVER_URL: 'http://127.0.0.1:10001', REQUEST_TIMEOUT_MS: 5000, DISABLE_TOOLS: true, DEBUG: false };
        app = createApp(config).app;
    });
    test('preserves an explicit empty tool_result in non-stream input', async () => {
        const res = await request(app)
            .post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/muse-spark-1.3-contributor-free',
                max_tokens: 100,
                tools: [{ name: 'read', input_schema: { type: 'object' } }],
                messages: [
                    { role: 'user', content: 'Read a.txt' },
                    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_read_1', name: 'read', input: {} }] },
                    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read_1', content: '' }] }
                ]
            });

        expect(res.statusCode).toBe(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.parts).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'text',
                text: 'TOOL_RESULT: {"tool_call_id":"toolu_read_1","name":"external__read","content":""}'
            })
        ]));
    });

    test('non-stream returns Anthropic message shape', async () => {
        const res = await request(app).post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
        expect(res.statusCode).toBe(200);
        expect(res.body.type).toBe('message');
        expect(res.body.role).toBe('assistant');
        expect(Array.isArray(res.body.content)).toBe(true);
        expect(res.body.stop_reason).toBe('end_turn');
        expect(res.body.usage.input_tokens).toBeGreaterThanOrEqual(0);
    });
    test('401 without key', async () => {
        const res = await request(app).post('/v1/messages')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
        expect(res.statusCode).toBe(401);
        expect(res.body.type).toBe('error');
    });
    test('missing tool_choice name returns an invalid request', async () => {
        const res = await request(app)
            .post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/muse-spark-1.3-contributor-free',
                max_tokens: 10,
                messages: [{ role: 'user', content: 'hi' }],
                tool_choice: { type: 'tool' }
            });

        expect(res.statusCode).toBe(400);
        expect(res.body.type).toBe('error');
        expect(res.body.error.type).toBe('invalid_request_error');
        expect(res.body.error.message).toContain('tool_choice.name');
    });

    test('tiny max_tokens does not fake max_tokens stop_reason (usage is estimated)', async () => {
        const res = await request(app).post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
        expect(res.statusCode).toBe(200);
        // Backend does not surface truncation; stop_reason comes from tool calls only.
        expect(res.body.stop_reason).toBe('end_turn');
    });
    test('missing max_tokens -> 400', async () => {
        const res = await request(app).post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', messages: [{ role: 'user', content: 'hi' }] });
        expect(res.statusCode).toBe(400);
    });
    test('x-api-key auth works', async () => {
        const res = await request(app).post('/v1/messages')
            .set('x-api-key', 'test-key')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
        expect(res.statusCode).toBe(200);
    });
    test('stream emits message_start/delta/stop without [DONE]', async () => {
        const res = await request(app).post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .set('Accept', 'text/event-stream')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'hi' }] });
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain('event: message_start');
        expect(res.text).toContain('event: message_stop');
        expect(res.text).not.toContain('[DONE]');
    });
    test('tools reach prompt with namespaced guard and user line', async () => {
        const res = await request(app).post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'read', description: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] });
        expect(res.statusCode).toBe(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)[0];
        expect(String(promptCall.body.system)).toContain('external__read');
        const flat = (promptCall.body.parts || []).map((p) => String(p.text || '')).join(' ');
        expect(flat).toContain('USER');
        expect(flat).toContain('hi');
        expect(JSON.stringify(res.body)).not.toContain('external__');
    });
    test('non-stream tool_use output preserves id and reports tool_use stop', async () => {
        sdkMocks.sessionMessages.mockResolvedValueOnce([{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: '<function_calls>[{"id":"toolu_read_1","name":"external__read","arguments":{"path":"a.txt"}}]</function_calls>' }] }]);
        const res = await request(app).post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', max_tokens: 100, messages: [{ role: 'user', content: 'Read a.txt' }], tools: [{ name: 'read', description: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] });
        expect(res.statusCode).toBe(200);
        expect(res.body.stop_reason).toBe('tool_use');
        const toolBlock = (res.body.content || []).find((c) => c.type === 'tool_use');
        expect(toolBlock).toBeDefined();
        expect(toolBlock.id).toBe('toolu_read_1');
        expect(toolBlock.name).toBe('read');
        expect(toolBlock.input).toEqual({ path: 'a.txt' });
        expect(JSON.stringify(res.body)).not.toContain('external__');
        expect(JSON.stringify(res.body)).not.toContain('<function_calls>');
    });
    test('tool_use plus tool_result continuation maps to prompt parts in order', async () => {
        const res = await request(app).post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', max_tokens: 100, tools: [{ name: 'read', description: 'Read', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'Read a.txt' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_read_1', name: 'read', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read_1', content: 'file body' }] }] });
        expect(res.statusCode).toBe(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)[0];
        const flat = (promptCall.body.parts || []).map((p) => String(p.text || '')).join('\n\n');
        expect(flat).toContain('ASSISTANT: <function_calls>');
        expect(flat).toContain('toolu_read_1');
        expect(flat).toContain('TOOL_RESULT:');
        expect(flat).toContain('external__read');
        expect(flat).toContain('file body');
        expect(flat.indexOf('ASSISTANT:')).toBeLessThan(flat.indexOf('TOOL_RESULT:'));
    });
    test('stream tool_use emits input_json_delta lifecycle and message deltas', async () => {
        sdkMocks.sessionMessages.mockResolvedValue([{ info: { role: 'assistant', finish: 'stop' }, parts: [] }]);
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => ({ stream: (async function* () { yield { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'msg-session' }, delta: '<function_calls>[{"id":"toolu_stream_1","name":"external__read","arguments":{"path":"a.txt"}}]</function_calls>' } }; yield { type: 'message.updated', properties: { info: { sessionID: 'msg-session', finish: 'stop' } } }; })() }));
        const res = await request(app).post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'Read a.txt' }], tools: [{ name: 'read', description: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }] });
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain('tool_use');
        expect(res.text).toContain('input_json_delta');
        expect(res.text).toContain('toolu_stream_1');
        expect(res.text).toContain('event: message_delta');
        expect(res.text).toContain('event: message_stop');
        expect(res.text).toContain('event: content_block_stop');
        const idxStart = res.text.indexOf('content_block_start');
        const idxDelta = res.text.indexOf('input_json_delta');
        const idxStop = res.text.indexOf('content_block_stop');
        const idxMsgDelta = res.text.indexOf('message_delta');
        const idxMsgStop = res.text.indexOf('message_stop');
        expect(idxStart).toBeGreaterThanOrEqual(0);
        expect(idxStart).toBeLessThan(idxDelta);
        expect(idxDelta).toBeLessThan(idxStop);
        expect(idxStop).toBeLessThan(idxMsgDelta);
        expect(idxMsgDelta).toBeLessThan(idxMsgStop);
        expect(res.text).not.toContain('[DONE]');
        expect(res.text).not.toContain('external__read');
        expect(res.text).not.toContain('<function_calls>');
    });
    test('reasoning surfaces as thinking block with empty signature', async () => {
        sdkMocks.sessionMessages.mockResolvedValueOnce([{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'reasoning', text: 'plan step' }, { type: 'text', text: 'done' }] }]);
        const res = await request(app).post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
        expect(res.statusCode).toBe(200);
        const thinking = (res.body.content || []).find((c) => c.type === 'thinking');
        expect(thinking).toBeDefined();
        expect(thinking.thinking).toBe('plan step');
        expect(thinking.signature).toBe('');
        const textBlock = (res.body.content || []).find((c) => c.type === 'text');
        expect(textBlock.text).toBe('done');
        expect(res.body.stop_reason).toBe('end_turn');
    });
    test('parallel tool calls preserve ids and order on messages', async () => {
        sdkMocks.sessionMessages.mockResolvedValueOnce([{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: '<function_calls>[{"id":"toolu_p_a","name":"external__read","arguments":{"path":"a.txt"}},{"id":"toolu_p_b","name":"external__read","arguments":{"path":"b.txt"}}]</function_calls>' }] }]);
        const res = await request(app).post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', max_tokens: 100, messages: [{ role: 'user', content: 'Read both' }], tools: [{ name: 'read', description: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }] });
        expect(res.statusCode).toBe(200);
        expect(res.body.stop_reason).toBe('tool_use');
        const uses = (res.body.content || []).filter((c) => c.type === 'tool_use');
        expect(uses.map((c) => c.id)).toEqual(['toolu_p_a', 'toolu_p_b']);
        expect(uses.map((c) => c.name)).toEqual(['read', 'read']);
        expect(uses[0].input).toEqual({ path: 'a.txt' });
        expect(uses[1].input).toEqual({ path: 'b.txt' });
        expect(JSON.stringify(res.body)).not.toContain('external__');
    });
    test('parallel tool calls preserve ids and order on chat', async () => {
        sdkMocks.sessionMessages.mockResolvedValueOnce([{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: '<function_calls>[{"id":"call_p_a","name":"external__read","arguments":{"path":"a.txt"}},{"id":"call_p_b","name":"external__read","arguments":{"path":"b.txt"}}]</function_calls>' }] }]);
        const res = await request(app).post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', messages: [{ role: 'user', content: 'Read both' }], tools: [{ type: 'function', function: { name: 'read', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }] });
        expect(res.statusCode).toBe(200);
        expect(res.body.choices[0].finish_reason).toBe('tool_calls');
        expect(res.body.choices[0].message.tool_calls.map((c) => c.id)).toEqual(['call_p_a', 'call_p_b']);
        expect(res.body.choices[0].message.tool_calls.map((c) => c.function.name)).toEqual(['read', 'read']);
        expect(JSON.parse(res.body.choices[0].message.tool_calls[0].function.arguments)).toEqual({ path: 'a.txt' });
        expect(JSON.parse(res.body.choices[0].message.tool_calls[1].function.arguments)).toEqual({ path: 'b.txt' });
        expect(JSON.stringify(res.body)).not.toContain('external__');
    });
    test('parallel tool calls preserve ids and order on responses', async () => {
        sdkMocks.sessionPrompt.mockResolvedValueOnce({ data: { parts: [{ type: 'text', text: '<function_calls>[{"id":"call_p_a","name":"external__read","arguments":{"path":"a.txt"}},{"id":"call_p_b","name":"external__read","arguments":{"path":"b.txt"}}]</function_calls>' }] } });
        const res = await request(app).post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', input: 'Read both', tools: [{ type: 'function', name: 'read', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }] });
        expect(res.statusCode).toBe(200);
        const calls = (res.body.output || []).filter((o) => o.type === 'function_call');
        expect(calls.map((c) => c.call_id)).toEqual(['call_p_a', 'call_p_b']);
        expect(calls.map((c) => c.name)).toEqual(['read', 'read']);
        expect(JSON.parse(calls[0].arguments)).toEqual({ path: 'a.txt' });
        expect(JSON.parse(calls[1].arguments)).toEqual({ path: 'b.txt' });
        expect(JSON.stringify(res.body)).not.toContain('external__');
    });
    test('parallel continuation maps both tool results in order on chat', async () => {
        const res = await request(app).post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', messages: [{ role: 'user', content: 'Read both' }, { role: 'assistant', content: null, tool_calls: [{ id: 'call_p_a', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'a.txt' }) } }, { id: 'call_p_b', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'b.txt' }) } }] }, { role: 'tool', tool_call_id: 'call_p_a', name: 'read', content: 'body-a' }, { role: 'tool', tool_call_id: 'call_p_b', name: 'read', content: 'body-b' }], tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }] });
        expect(res.statusCode).toBe(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)[0];
        const flat = (promptCall.body.parts || []).map((p) => String(p.text || '')).join('\n\n');
        expect(flat).toContain('call_p_a');
        expect(flat).toContain('call_p_b');
        expect(flat).toContain('body-a');
        expect(flat).toContain('body-b');
        expect(flat.indexOf('call_p_a')).toBeLessThan(flat.indexOf('call_p_b'));
    });
    test('parallel continuation maps both tool results in order on responses', async () => {
        const res = await request(app).post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Read both' }] }, { type: 'function_call', call_id: 'call_p_a', name: 'read', arguments: JSON.stringify({ path: 'a.txt' }) }, { type: 'function_call', call_id: 'call_p_b', name: 'read', arguments: JSON.stringify({ path: 'b.txt' }) }, { type: 'function_call_output', call_id: 'call_p_a', output: 'body-a' }, { type: 'function_call_output', call_id: 'call_p_b', output: 'body-b' }], tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }] });
        expect(res.statusCode).toBe(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)[0];
        const flat = (promptCall.body.parts || []).map((p) => String(p.text || '')).join('\n\n');
        expect(flat).toContain('call_p_a');
        expect(flat).toContain('call_p_b');
        expect(flat).toContain('body-a');
        expect(flat).toContain('body-b');
        expect(flat.indexOf('call_p_a')).toBeLessThan(flat.indexOf('call_p_b'));
    });
    test('parallel continuation maps both tool results in order on messages', async () => {
        const res = await request(app).post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', max_tokens: 100, tools: [{ name: 'read', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'Read both' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_p_a', name: 'read', input: { path: 'a.txt' } }, { type: 'tool_use', id: 'toolu_p_b', name: 'read', input: { path: 'b.txt' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_p_a', content: 'body-a' }, { type: 'tool_result', tool_use_id: 'toolu_p_b', content: 'body-b' }] }] });
        expect(res.statusCode).toBe(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)[0];
        const flat = (promptCall.body.parts || []).map((p) => String(p.text || '')).join('\n\n');
        expect(flat).toContain('toolu_p_a');
        expect(flat).toContain('toolu_p_b');
        expect(flat).toContain('body-a');
        expect(flat).toContain('body-b');
        expect(flat.indexOf('toolu_p_a')).toBeLessThan(flat.indexOf('toolu_p_b'));
    });
    test('stream single tool_use emits precise blocks and suppresses text', async () => {
        sdkMocks.sessionMessages.mockResolvedValue([{ info: { role: 'assistant', finish: 'stop' }, parts: [] }]);
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => ({ stream: (async function* () { yield { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'msg-session' }, delta: '<function_calls>[{"id":"toolu_stream_1","name":"external__read","arguments":{"path":"a.txt"}}]</function_calls>' } }; yield { type: 'message.updated', properties: { info: { sessionID: 'msg-session', finish: 'stop' } } }; })() }));
        const res = await request(app).post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'Read a.txt' }], tools: [{ name: 'read', description: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] });
        expect(res.statusCode).toBe(200);
        const frames = parseMessagesSseFrames(res.text);
        const toolStarts = messagesToolStarts(frames);
        expect(toolStarts).toHaveLength(1);
        expect(toolStarts[0].data.content_block.id).toBe('toolu_stream_1');
        expect(toolStarts[0].data.content_block.name).toBe('read');
        expect(toolStarts[0].data.content_block.input).toEqual({});
        expect(toolStarts[0].data.index).toBe(0);
        const toolDeltas = messagesInputDeltas(frames);
        expect(toolDeltas).toHaveLength(1);
        expect(toolDeltas[0].data.index).toBe(toolStarts[0].data.index);
        expect(JSON.parse(toolDeltas[0].data.delta.partial_json)).toEqual({ path: 'a.txt' });
        expect(toolDeltas[0].data.delta.partial_json).toBe(JSON.stringify({ path: 'a.txt' }));
        expect(messagesTextDeltas(frames)).toHaveLength(0);
        expect(frames.filter((f) => f.event === 'content_block_start' && f.data.content_block && f.data.content_block.type === 'text')).toHaveLength(0);
        expect(res.text).not.toContain('<function_calls>');
        expect(res.text).not.toContain('external__');
        const eventSeq = frames.map((f) => f.event);
        expect(eventSeq[0]).toBe('message_start');
        expect(eventSeq[eventSeq.length - 1]).toBe('message_stop');
        expect(eventSeq.indexOf('content_block_start')).toBeLessThan(eventSeq.indexOf('content_block_delta'));
        expect(eventSeq.indexOf('content_block_delta')).toBeLessThan(eventSeq.indexOf('content_block_stop'));
        expect(eventSeq.indexOf('content_block_stop')).toBeLessThan(eventSeq.indexOf('message_delta'));
        expect(eventSeq.indexOf('message_delta')).toBeLessThan(eventSeq.indexOf('message_stop'));
        const msgDelta = frames.find((f) => f.event === 'message_delta');
        expect(msgDelta.data.delta.stop_reason).toBe('tool_use');
        expect(res.text).not.toContain('[DONE]');
    });
    test('stream thinking emits ordered blocks with empty signature', async () => {
        sdkMocks.sessionMessages.mockResolvedValue([{ info: { role: 'assistant', finish: 'stop' }, parts: [] }]);
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => ({ stream: (async function* () { yield { type: 'message.part.updated', properties: { part: { type: 'reasoning', sessionID: 'msg-session' }, delta: 'plan ' } }; yield { type: 'message.part.updated', properties: { part: { type: 'reasoning', sessionID: 'msg-session' }, delta: 'step' } }; yield { type: 'message.updated', properties: { info: { sessionID: 'msg-session', finish: 'stop' } } }; })() }));
        const res = await request(app).post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'hi' }] });
        expect(res.statusCode).toBe(200);
        const frames = parseMessagesSseFrames(res.text);
        const thinkStarts = messagesThinkingStarts(frames);
        expect(thinkStarts).toHaveLength(1);
        expect(thinkStarts[0].data.content_block.signature).toBe('');
        expect(thinkStarts[0].data.content_block.thinking).toBe('');
        expect(thinkStarts[0].data.index).toBe(0);
        const thinkDeltas = messagesThinkingDeltas(frames);
        expect(thinkDeltas.length).toBeGreaterThanOrEqual(1);
        expect(thinkDeltas.map((f) => f.data.delta.thinking).join('')).toBe('plan step');
        for (const d of thinkDeltas) expect(d.data.index).toBe(thinkStarts[0].data.index);
        expect(frames.filter((f) => f.event === 'content_block_stop' && f.data.index === thinkStarts[0].data.index)).toHaveLength(1);
        expect(messagesTextDeltas(frames)).toHaveLength(0);
        expect(messagesToolStarts(frames)).toHaveLength(0);
        const eventSeq = frames.map((f) => f.event);
        expect(eventSeq[0]).toBe('message_start');
        expect(eventSeq[eventSeq.length - 1]).toBe('message_stop');
        expect(eventSeq.indexOf('content_block_start')).toBeLessThan(eventSeq.indexOf('content_block_delta'));
        expect(eventSeq.indexOf('content_block_delta')).toBeLessThan(eventSeq.indexOf('content_block_stop'));
        expect(eventSeq.indexOf('content_block_stop')).toBeLessThan(eventSeq.indexOf('message_delta'));
        expect(eventSeq.indexOf('message_delta')).toBeLessThan(eventSeq.indexOf('message_stop'));
        expect(frames.find((f) => f.event === 'message_delta').data.delta.stop_reason).toBe('end_turn');
        expect(res.text).not.toContain('[DONE]');
    });
    test('stream thinking coexists with tool_use and keeps index order', async () => {
        sdkMocks.sessionMessages.mockResolvedValue([{ info: { role: 'assistant', finish: 'stop' }, parts: [] }]);
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => ({ stream: (async function* () { yield { type: 'message.part.updated', properties: { part: { type: 'reasoning', sessionID: 'msg-session' }, delta: 'plan step' } }; yield { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'msg-session' }, delta: '<function_calls>[{"id":"toolu_mix_1","name":"external__read","arguments":{"path":"a.txt"}}]</function_calls>' } }; yield { type: 'message.updated', properties: { info: { sessionID: 'msg-session', finish: 'stop' } } }; })() }));
        const res = await request(app).post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'Read a.txt' }], tools: [{ name: 'read', description: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }] });
        expect(res.statusCode).toBe(200);
        const frames = parseMessagesSseFrames(res.text);
        const thinkStarts = messagesThinkingStarts(frames);
        expect(thinkStarts).toHaveLength(1);
        expect(thinkStarts[0].data.content_block.signature).toBe('');
        const thinkDeltas = messagesThinkingDeltas(frames);
        expect(thinkDeltas).toHaveLength(1);
        expect(thinkDeltas[0].data.delta.thinking).toBe('plan step');
        expect(thinkDeltas[0].data.index).toBe(thinkStarts[0].data.index);
        const toolStarts = messagesToolStarts(frames);
        expect(toolStarts).toHaveLength(1);
        expect(toolStarts[0].data.content_block.name).toBe('read');
        expect(toolStarts[0].data.content_block.id).toBe('toolu_mix_1');
        expect(toolStarts[0].data.index).toBeGreaterThan(thinkStarts[0].data.index);
        const toolDeltas = messagesInputDeltas(frames);
        expect(toolDeltas).toHaveLength(1);
        expect(JSON.parse(toolDeltas[0].data.delta.partial_json)).toEqual({ path: 'a.txt' });
        expect(toolDeltas[0].data.index).toBe(toolStarts[0].data.index);
        expect(messagesTextDeltas(frames)).toHaveLength(0);
        expect(res.text).not.toContain('<function_calls>');
        expect(res.text).not.toContain('external__');
        expect(frames.find((f) => f.event === 'message_delta').data.delta.stop_reason).toBe('tool_use');
        expect(res.text).not.toContain('[DONE]');
    });
    test('stream parallel tool_use keeps order indexes and partial_json', async () => {
        sdkMocks.sessionMessages.mockResolvedValue([{ info: { role: 'assistant', finish: 'stop' }, parts: [] }]);
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => ({ stream: (async function* () { yield { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'msg-session' }, delta: '<function_calls>[{"id":"toolu_p_a","name":"external__read","arguments":{"path":"a.txt"}},{"id":"toolu_p_b","name":"external__read","arguments":{"path":"b.txt"}}]</function_calls>' } }; yield { type: 'message.updated', properties: { info: { sessionID: 'msg-session', finish: 'stop' } } }; })() }));
        const res = await request(app).post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'Read both' }], tools: [{ name: 'read', description: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }] });
        expect(res.statusCode).toBe(200);
        const frames = parseMessagesSseFrames(res.text);
        const toolStarts = messagesToolStarts(frames);
        expect(toolStarts.map((f) => f.data.content_block.id)).toEqual(['toolu_p_a', 'toolu_p_b']);
        expect(toolStarts.map((f) => f.data.content_block.name)).toEqual(['read', 'read']);
        expect(toolStarts[1].data.index).toBe(toolStarts[0].data.index + 1);
        const toolDeltas = messagesInputDeltas(frames);
        expect(toolDeltas).toHaveLength(2);
        expect(toolDeltas[0].data.index).toBe(toolStarts[0].data.index);
        expect(toolDeltas[1].data.index).toBe(toolStarts[1].data.index);
        expect(JSON.parse(toolDeltas[0].data.delta.partial_json)).toEqual({ path: 'a.txt' });
        expect(JSON.parse(toolDeltas[1].data.delta.partial_json)).toEqual({ path: 'b.txt' });
        expect(messagesTextDeltas(frames)).toHaveLength(0);
        expect(res.text).not.toContain('<function_calls>');
        expect(res.text).not.toContain('external__');
        expect(frames.find((f) => f.event === 'message_delta').data.delta.stop_reason).toBe('tool_use');
        expect(res.text).not.toContain('[DONE]');
    });
    test('parallel continuation maps ids arguments and results with namespace', async () => {
        const res = await request(app).post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', max_tokens: 100, tools: [{ name: 'read', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'Read both' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_p_a', name: 'read', input: { path: 'a.txt' } }, { type: 'tool_use', id: 'toolu_p_b', name: 'read', input: { path: 'b.txt' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_p_a', content: 'body-a' }, { type: 'tool_result', tool_use_id: 'toolu_p_b', content: 'body-b' }] }] });
        expect(res.statusCode).toBe(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)[0];
        const flat = (promptCall.body.parts || []).map((p) => String(p.text || '')).join('\n\n');
        expect(flat).toContain('ASSISTANT: <function_calls>');
        expect(flat).toContain('TOOL_RESULT:');
        expect(flat).toContain('external__read');
        const openTag = '<function_calls>';
        const closeTag = '</function_calls>';
        const assistantCalls = JSON.parse(flat.slice(flat.indexOf(openTag) + openTag.length, flat.indexOf(closeTag)));
        expect(assistantCalls.map((c) => c.id)).toEqual(['toolu_p_a', 'toolu_p_b']);
        expect(assistantCalls.map((c) => c.name)).toEqual(['external__read', 'external__read']);
        expect(JSON.parse(assistantCalls[0].arguments)).toEqual({ path: 'a.txt' });
        expect(JSON.parse(assistantCalls[1].arguments)).toEqual({ path: 'b.txt' });
        const chunks = flat.split('TOOL_RESULT:').slice(1);
        expect(chunks).toHaveLength(2);
        const firstResult = JSON.parse(chunks[0].trim().split('\n\n')[0]);
        const secondResult = JSON.parse(chunks[1].trim().split('\n\n')[0]);
        expect(firstResult.tool_call_id).toBe('toolu_p_a');
        expect(secondResult.tool_call_id).toBe('toolu_p_b');
        expect(firstResult.name).toBe('external__read');
        expect(secondResult.name).toBe('external__read');
        expect(firstResult.content).toBe('body-a');
        expect(secondResult.content).toBe('body-b');
        expect(firstResult.tool_call_id).toBe(assistantCalls[0].id);
        expect(secondResult.tool_call_id).toBe(assistantCalls[1].id);
        expect(flat.indexOf('ASSISTANT:')).toBeLessThan(flat.indexOf('TOOL_RESULT:'));
        expect(flat.indexOf('toolu_p_a')).toBeLessThan(flat.indexOf('toolu_p_b'));
    });
    test('tool_choice any forces tool_use on non-stream when first turn is empty', async () => {
        sdkMocks.sessionMessages.mockResolvedValueOnce([{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'hello no tool' }] }]);
        sdkMocks.sessionMessages.mockResolvedValueOnce([{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: '<function_calls>[{"id":"toolu_req_1","name":"external__read","arguments":{"path":"a.txt"}}]</function_calls>' }] }]);
        const res = await request(app).post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', max_tokens: 100, messages: [{ role: 'user', content: 'Read a.txt' }], tools: [{ name: 'read', description: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }], tool_choice: { type: 'any' } });
        expect(res.statusCode).toBe(200);
        expect(res.body.stop_reason).toBe('tool_use');
        const use = (res.body.content || []).find((c) => c.type === 'tool_use');
        expect(use).toBeDefined();
        expect(use.id).toBe('toolu_req_1');
        expect(use.name).toBe('read');
        expect(use.input).toEqual({ path: 'a.txt' });
        expect(JSON.stringify(res.body)).not.toContain('external__');
        expect(JSON.stringify(res.body)).not.toContain('<function_calls>');
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(2);
    });
    test('tool_choice tool forces tool_use on stream when first events lack tools', async () => {
        sdkMocks.sessionMessages.mockResolvedValueOnce([{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: '<function_calls>[{"id":"toolu_req_s1","name":"external__read","arguments":{"path":"b.txt"}}]</function_calls>' }] }]);
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => ({ stream: (async function* () { yield { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'msg-session' }, delta: 'hello' } }; yield { type: 'message.updated', properties: { info: { sessionID: 'msg-session', finish: 'stop' } } }; })() }));
        const res = await request(app).post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'Read b.txt' }], tools: [{ name: 'read', description: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }], tool_choice: { type: 'tool', name: 'read' } });
        expect(res.statusCode).toBe(200);
        const frames = parseMessagesSseFrames(res.text);
        const toolStarts = messagesToolStarts(frames);
        expect(toolStarts).toHaveLength(1);
        expect(toolStarts[0].data.content_block.id).toBe('toolu_req_s1');
        expect(toolStarts[0].data.content_block.name).toBe('read');
        const toolDeltas = messagesInputDeltas(frames);
        expect(toolDeltas).toHaveLength(1);
        expect(JSON.parse(toolDeltas[0].data.delta.partial_json)).toEqual({ path: 'b.txt' });
        expect(res.text).not.toContain('external__');
        expect(res.text).not.toContain('<function_calls>');
        expect(frames.find((f) => f.event === 'message_delta').data.delta.stop_reason).toBe('tool_use');
        expect(res.text).not.toContain('[DONE]');
    });
    test('tool_choice required without tool on non-stream returns explicit contract', async () => {
        sdkMocks.sessionMessages.mockResolvedValue([{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'hello no tool' }] }]);
        const res = await request(app).post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', max_tokens: 100, messages: [{ role: 'user', content: 'Read a.txt' }], tools: [{ name: 'read', description: 'Read', input_schema: { type: 'object' } }], tool_choice: { type: 'any' } });
        expect(res.statusCode).toBe(500);
        expect(res.body.type).toBe('error');
        expect(res.body.error.type).toBe('internal_error');
        expect(String(res.body.error.message)).toContain('required external tool call');
    });
    test('tool_choice required without tool on stream returns explicit contract', async () => {
        sdkMocks.sessionMessages.mockResolvedValue([{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'hello no tool' }] }]);
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => ({ stream: (async function* () { yield { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'msg-session' }, delta: 'hello no tool' } }; yield { type: 'message.updated', properties: { info: { sessionID: 'msg-session', finish: 'stop' } } }; })() }));
        const res = await request(app).post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'Read a.txt' }], tools: [{ name: 'read', description: 'Read', input_schema: { type: 'object' } }], tool_choice: { type: 'any' } });
        expect(res.statusCode).toBe(200);
        const frames = parseMessagesSseFrames(res.text);
        expect(frames.some((f) => f.event === 'error')).toBe(true);
        expect(messagesToolStarts(frames)).toHaveLength(0);
        expect(messagesInputDeltas(frames)).toHaveLength(0);
        expect(res.text).not.toContain('[DONE]');
        expect(res.text).not.toContain('external__');
    });
});
