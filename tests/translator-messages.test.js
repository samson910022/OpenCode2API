import { TranslatorRegistry } from '../src/converters/registry.js';
import { registerChatMessagesPair } from '../src/converters/chat-messages/init.js';
import { registerResponsesMessagesPair } from '../src/converters/responses-messages/init.js';
import {
    convertChatRequestToMessages,
    convertMessagesRequestToChat,
} from '../src/converters/chat-messages/request.js';
import {
    convertChatResponseToMessagesNonStream,
    convertMessagesResponseToChatNonStream,
    createChatToMessagesStreamTranslator,
} from '../src/converters/chat-messages/response.js';
import {
    convertMessagesRequestToResponses,
    convertResponsesRequestToMessages,
} from '../src/converters/responses-messages/request.js';
import {
    convertMessagesResponseToResponsesNonStream,
    convertResponsesResponseToMessagesNonStream,
} from '../src/converters/responses-messages/response.js';

function freshRegistry() {
    const r = new TranslatorRegistry();
    registerChatMessagesPair(r);
    registerResponsesMessagesPair(r);
    return r;
}

describe('P2 messages.request <-> chat.request', () => {
    test('messages tools/system/thinking map to chat', () => {
        const out = convertMessagesRequestToChat('m', {
            system: 'sys',
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
            tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }],
            tool_choice: { type: 'auto' },
            thinking: { type: 'enabled', budget_tokens: 9000 },
            max_tokens: 64,
        }, false);
        expect(out.messages[0]).toEqual({ role: 'system', content: 'sys' });
        expect(out.tools).toEqual([{ type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object' } } }]);
        expect(out.reasoning_effort).toBe('medium');
        expect(out.max_tokens).toBe(64);
    });

    test('chat image/tool round-trip to messages blocks', () => {
        const out = convertChatRequestToMessages('m', {
            messages: [
                { role: 'system', content: 'sys' },
                { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
                { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 't', arguments: '{"a":1}' } }] },
                { role: 'tool', tool_call_id: 'toolu_1', content: 'ok' },
            ],
        }, false);
        expect(out.system).toBe('sys');
        expect(out.messages[0].content[0].type).toBe('image');
        expect(out.messages[1].content[0]).toMatchObject({ type: 'tool_use', id: 'toolu_1' });
        expect(out.messages[2]).toMatchObject({ role: 'user' });
    });
});

describe('P2 chat.response <-> messages.response', () => {
    test('tool_calls become tool_use with tool_use stop reason', () => {
        const out = convertChatResponseToMessagesNonStream('m', {}, {}, {
            choices: [{ message: { content: 'hi', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 't', arguments: '{"a":1}' } }] }, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
        });
        expect(out.stop_reason).toBe('tool_use');
        expect(out.content).toContainEqual({ type: 'tool_use', id: 'toolu_1', name: 't', input: { a: 1 } });
        expect(out.usage).toEqual({ input_tokens: 5, output_tokens: 6 });
    });

    test('stream emits start/text-delta/tool-json/stop sequence without [DONE]', () => {
        const next = createChatToMessagesStreamTranslator('m', 'msg_1');
        const e1 = next({ choices: [{ delta: { content: 'hi' } }] });
        expect(e1[0]).toMatchObject({ event: 'message_start' });
        expect(e1.some((e) => e.event === 'content_block_delta')).toBe(true);
        const e2 = next({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'toolu_1', function: { name: 't', arguments: '{"a":1}' } }] } }] });
        expect(e2).toContainEqual(expect.objectContaining({ event: 'content_block_start' }));
        const e3 = next({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { completion_tokens: 7 } });
        expect(e3[e3.length - 1]).toMatchObject({ event: 'message_stop' });
        expect(e3.some((e) => e.event === 'message_delta')).toBe(true);
    });
});

describe('P2 responses.request <-> messages.request', () => {
    test('function_call maps both ways with tool ids preserved', () => {
        const toMsg = convertResponsesRequestToMessages('m', {
            instructions: 'sys',
            input: [{ type: 'function_call', call_id: 'call_1', name: 't', arguments: '{"a":1}' }],
        }, false);
        expect(toMsg.system).toBe('sys');
        expect(toMsg.messages[0].content[0]).toMatchObject({ type: 'tool_use', id: 'call_1' });
        const toResp = convertMessagesRequestToResponses('m', {
            system: 'sys',
            messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 't', input: { a: 1 } }] }],
        }, false);
        expect(toResp.instructions).toBe('sys');
        expect(toResp.input[0]).toMatchObject({ type: 'function_call', call_id: 'call_1' });
    });
});

describe('P2 responses.response <-> messages.response', () => {
    test('output items fold to blocks and back', () => {
        const toMsg = convertResponsesResponseToMessagesNonStream('m', {}, {}, {
            id: 'resp_1',
            output: [{ type: 'function_call', call_id: 'call_1', name: 't', arguments: '{"a":1}' }],
            usage: { input_tokens: 2, output_tokens: 3 },
        });
        expect(toMsg.stop_reason).toBe('tool_use');
        const toResp = convertMessagesResponseToResponsesNonStream('m', {}, {}, toMsg);
        expect(toResp.output).toContainEqual(expect.objectContaining({ type: 'function_call', call_id: 'call_1' }));
    });
});

describe('P2 registry wiring', () => {
    test('tool_choice absent leaves no key; thinking none/auto symmetry', () => {
        const bare = convertResponsesRequestToMessages('m', { input: 'hi' }, false);
        expect('tool_choice' in bare).toBe(false);
        expect('thinking' in bare).toBe(false);
        const disabled = convertResponsesRequestToMessages('m', { input: [], reasoning: { effort: 'none' } }, false);
        expect(disabled.thinking).toEqual({ type: 'disabled' });
        const back = convertMessagesRequestToResponses('m', { messages: [], thinking: { type: 'adaptive' } }, false);
        expect(back.reasoning).toEqual({ effort: 'auto' });
    });

    test('8 directed pairs registered (4 chat-messages + 4 responses-messages requests/responses)', () => {
        const r = freshRegistry();
        for (const [from, to] of [['claude', 'openai'], ['openai', 'claude'], ['openai-response', 'claude'], ['claude', 'openai-response']]) {
            expect(r.hasRequestTransformer(from, to)).toBe(true);
            expect(r.hasNonStreamResponseTransformer(from, to)).toBe(true);
        }
        expect(r.hasStreamResponseTransformer('openai', 'claude')).toBe(true);
        expect(r.size()).toEqual({ requests: 4, responses: 4 });
    });
});
