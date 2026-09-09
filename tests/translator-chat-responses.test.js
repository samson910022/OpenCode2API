import { TranslatorRegistry } from '../src/converters/registry.js';
import { registerChatResponsesPair } from '../src/converters/chat-responses/init.js';
import {
    convertChatRequestToResponses,
    convertResponsesRequestToChat,
} from '../src/converters/chat-responses/request.js';
import {
    convertChatResponseToResponsesNonStream,
    convertResponsesResponseToChatNonStream,
    createChatToResponsesStreamTranslator,
    createResponsesToChatStreamTranslator,
} from '../src/converters/chat-responses/response.js';

function freshRegistry() {
    const r = new TranslatorRegistry();
    registerChatResponsesPair(r);
    return r;
}

describe('P1 responses.request -> chat.request (Go openai_openai-responses_request.go port)', () => {
    test('instructions become system message; input items map with tool adjacency', () => {
        const out = convertResponsesRequestToChat('m', {
            model: 'old',
            instructions: 'sys',
            input: [
                { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
                { type: 'function_call', call_id: 'call_1', name: 'get_time', arguments: '{}' },
                { type: 'function_call_output', call_id: 'call_1', output: 'noon' },
            ],
            max_output_tokens: 128,
            reasoning: { effort: 'high' },
        }, false);
        expect(out.model).toBe('m');
        expect(out.messages[0]).toEqual({ role: 'system', content: 'sys' });
        expect(out.messages).toContainEqual({ role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_time', arguments: '{}' } }] });
        expect(out.messages).toContainEqual({ role: 'tool', tool_call_id: 'call_1', content: 'noon' });
        expect(out.max_tokens).toBe(128);
        expect(out.reasoning_effort).toBe('high');
    });

    test('string input becomes a user message', () => {
        const out = convertResponsesRequestToChat('m', { input: 'hello' }, false);
        expect(out.messages).toEqual([{ role: 'user', content: 'hello' }]);
    });

    test('additional_tools merge with first-wins dedup + namespace qualify', () => {
        const out = convertResponsesRequestToChat('m', {
            tools: [{ type: 'function', name: 'get_time', description: 'top' }],
            input: [
                { type: 'additional_tools', tools: [{ type: 'function', name: 'get_time', description: 'copy' }, { type: 'custom', name: 'exec', description: 'copy' }] },
                { type: 'function_call', call_id: 'c1', namespace: 'functions', name: 'wait', arguments: '{}' },
            ],
        }, false);
        const names = out.tools.map((t) => t.function.name).sort();
        expect(names).toEqual(['exec', 'get_time']);
        const assistant = out.messages.find((m) => m.tool_calls);
        expect(assistant.tool_calls[0].function.name).toBe('functions__wait');
    });

    test('reasoning summary filters non-summary_text + image detail normalized', () => {
        const out = convertResponsesRequestToChat('m', {
            input: [
                { type: 'reasoning', summary: [{ type: 'summary_text', text: 'think' }, { type: 'other', text: 'skip' }] },
                { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:x', detail: 'original' }] },
            ],
        }, false);
        const assistant = out.messages.find((m) => m.reasoning_content);
        expect(assistant.reasoning_content).toBe('think');
        const user = out.messages.find((m) => m.role === 'user');
        expect(user.content).toEqual([{ type: 'image_url', image_url: { url: 'data:x', detail: 'high' } }]);
    });
});

describe('P1 chat.request -> responses.request (symmetric inverse)', () => {
    test('system/tools/tool_calls round-trip', () => {
        const out = convertChatRequestToResponses('m', {
            model: 'm',
            messages: [
                { role: 'system', content: 'sys' },
                { role: 'user', content: 'hi' },
                { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_time', arguments: '{}' } }], content: null },
                { role: 'tool', tool_call_id: 'call_1', content: 'noon' },
            ],
            tools: [{ type: 'function', function: { name: 'get_time', description: '', parameters: { type: 'object' } } }],
            max_tokens: 64,
        }, false);
        expect(out.model).toBe('m');
        expect(out.instructions).toBe('sys');
        expect(out.input).toContainEqual({ type: 'function_call', call_id: 'call_1', name: 'get_time', arguments: '{}' });
        expect(out.input).toContainEqual({ type: 'function_call_output', call_id: 'call_1', output: 'noon' });
        expect(out.max_output_tokens).toBe(64);
    });
});

describe('P1 chat.response <-> responses.response non-stream', () => {
    test('tool_calls become function_call output items with usage mapping', () => {
        const out = convertChatResponseToResponsesNonStream('m', {}, {}, {
            id: 'chatcmpl-1',
            choices: [{ message: { role: 'assistant', content: 'done', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_time', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
        expect(out.object).toBe('response');
        expect(out.status).toBe('completed');
        expect(out.output).toContainEqual({ type: 'function_call', call_id: 'call_1', id: 'call_1', name: 'get_time', arguments: '{}' });
        expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
    });

    test('responses output folds back to chat message + tool_calls', () => {
        const out = convertResponsesResponseToChatNonStream('m', {}, {}, {
            id: 'resp_1',
            output: [
                { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
                { type: 'function_call', call_id: 'call_1', name: 'get_time', arguments: '{}' },
            ],
            usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
        });
        expect(out.choices[0].finish_reason).toBe('tool_calls');
        expect(out.choices[0].message.tool_calls[0].id).toBe('call_1');
        expect(out.usage).toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
    });
});

describe('P1 chat-stream -> responses-events (Go response.go state machine core)', () => {
    test('text delta then finish emits created/delta/completed in order', () => {
        const next = createChatToResponsesStreamTranslator('m', 'resp_test');
        const e1 = next({ choices: [{ delta: { content: 'hel' }, finish_reason: null }] });
        expect(e1[0]).toMatchObject({ type: 'response.created' });
        expect(e1).toContainEqual(expect.objectContaining({ type: 'response.output_text.delta' }));
        const e2 = next({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
        expect(e2[e2.length - 1]).toMatchObject({ type: 'response.completed' });
        expect(e2).toContainEqual(expect.objectContaining({ type: 'response.output_text.done' }));
        expect(next({ choices: [{ delta: {}, finish_reason: 'stop' }] })).toEqual([]);
    });

    test('function_call args aggregate into arguments.done + incomplete on length', () => {
        const next = createChatToResponsesStreamTranslator('m', 'resp_args');
        next({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '{"a":' } }] }, finish_reason: null }] });
        const e2 = next({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, finish_reason: null }] });
        expect(e2).toContainEqual(expect.objectContaining({ type: 'response.function_call_arguments.delta', delta: '1}' }));
        const e3 = next({ choices: [{ delta: {}, finish_reason: 'length' }] });
        expect(e3).toContainEqual(expect.objectContaining({ type: 'response.function_call_arguments.done', arguments: '{"a":1}' }));
        expect(e3[e3.length - 1].response.status).toBe('incomplete');
    });

    test('late-arriving tool name fills output_item.done', () => {
        const next = createChatToResponsesStreamTranslator('m', 'resp_late');
        next({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_7', function: { arguments: '{}' } }] } }] });
        next({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'late_tool' } }] } }] });
        const done = next({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        const itemDone = done.find((e) => e.type === 'response.output_item.done' && e.item?.type === 'function_call');
        expect(itemDone.item.name).toBe('late_tool');
    });

    test('array system content extracts text instead of JSON', () => {
        const out = convertChatRequestToResponses('m', {
            messages: [{ role: 'system', content: [{ type: 'text', text: 'sys-arr' }] }],
        }, false);
        expect(out.instructions).toBe('sys-arr');
    });

    test('reverse tool stream carries names from output_item.added', () => {
        const next = createResponsesToChatStreamTranslator('m', 'c_rev');
        expect(next({ type: 'response.output_item.added', item: { type: 'function_call', call_id: 'call_1', name: 'get_time' } })).toEqual([]);
        const chunks = next({ type: 'response.function_call_arguments.delta', item_id: 'call_1', delta: '{"a":1}' });
        expect(chunks[0].choices[0].delta.tool_calls[0]).toMatchObject({ id: 'call_1', function: { name: 'get_time', arguments: '{"a":1}' } });
    });

    test('reverse tool stream omits name key when added never arrived', () => {
        const next = createResponsesToChatStreamTranslator('m', 'c_rev2');
        const chunks = next({ type: 'response.function_call_arguments.delta', item_id: 'call_9', delta: '{}' });
        expect(chunks[0].choices[0].delta.tool_calls[0].function).toEqual({ arguments: '{}' });
    });

    test('colon-bearing call ids survive forward translation', () => {
        const next = createChatToResponsesStreamTranslator('m', 'resp_colon');
        next({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call:1:2', function: { name: 'f', arguments: '{}' } }] } }] });
        const done = next({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        const itemDone = done.find((e) => e.type === 'response.output_item.done' && e.item?.type === 'function_call');
        expect(itemDone.item.call_id).toBe('call:1:2');
    });

    test('cross-protocol ids are regenerated with target prefix', () => {
        const toResp = convertChatResponseToResponsesNonStream('m', {}, {}, {
            id: 'chatcmpl-foreign',
            choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
            usage: {},
        });
        expect(toResp.id).toMatch(/^resp_/);
        const toChat = convertResponsesResponseToChatNonStream('m', {}, {}, { id: 'resp_foreign', output: [], usage: {} });
        expect(toChat.id).toMatch(/^chatcmpl-/);
    });

    test('custom object shapes resolve names; unnamed function tools dropped', () => {
        const out = convertResponsesRequestToChat('m', {
            tools: [
                { type: 'custom', custom: { name: 'exec' } },
                { type: 'function', description: 'nameless' },
            ],
            input: 'hi',
        }, false);
        expect(out.tools).toEqual([expect.objectContaining({ function: expect.objectContaining({ name: 'exec' }) })]);
    });
});

describe('P1 registry wiring (init.go port)', () => {
    test('both request directions + both non-stream responses registered', () => {
        const r = freshRegistry();
        expect(r.hasRequestTransformer('openai-response', 'openai')).toBe(true);
        expect(r.hasRequestTransformer('openai', 'openai-response')).toBe(true);
        expect(r.hasNonStreamResponseTransformer('openai', 'openai-response')).toBe(true);
        expect(r.hasNonStreamResponseTransformer('openai-response', 'openai')).toBe(true);
        expect(r.hasStreamResponseTransformer('openai', 'openai-response')).toBe(true);
        expect(r.size()).toEqual({ requests: 2, responses: 2 });
    });

    test('registry stream keeps state across chunks via holder param', () => {
        const r = freshRegistry();
        const holder = {};
        const e1 = r.translateStream('openai', 'openai-response', 'm', {}, {}, { choices: [{ delta: { content: 'a' } }] }, holder);
        expect(e1[0]).toMatchObject({ type: 'response.created' });
        const e2 = r.translateStream('openai', 'openai-response', 'm', {}, {}, { choices: [{ delta: { content: 'b' } }] }, holder);
        // Same stream: no second created event.
        expect(e2.some((e) => e.type === 'response.created')).toBe(false);
        expect(e2).toContainEqual(expect.objectContaining({ type: 'response.output_text.delta', delta: 'b' }));
    });

    test('done output_index matches added output_index per tool', () => {
        const next = createChatToResponsesStreamTranslator('m', 'resp_ix');
        const e1 = next({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_9', function: { name: 'f', arguments: '{}' } }] } }] });
        const added = e1.find((e) => e.type === 'response.output_item.added');
        const e2 = next({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        const done = e2.find((e) => e.type === 'response.output_item.done' && e.item?.type === 'function_call');
        expect(added.output_index).toBe(2);
        expect(done.output_index).toBe(added.output_index);
        expect(done.item.arguments).toBe('{}');
        expect(done.item.id).toBe('call_9');
    });
});
