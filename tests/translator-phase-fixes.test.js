import { TranslatorRegistry } from '../src/converters/registry.js';
import { TranslatorPipeline } from '../src/converters/pipeline.js';
import { makeId, normalizeArgs, num, asArray, str } from '../src/converters/json.js';
import {
    usageToChat,
    usageToInteractions,
    usageToMessages,
    usageToResponses,
} from '../src/converters/usage.js';
import {
    convertChatResponseToResponsesNonStream,
    convertResponsesResponseToChatNonStream,
} from '../src/converters/chat-responses/response.js';
import { convertChatRequestToMessages } from '../src/converters/chat-messages/request.js';
import {
    convertMessagesRequestToResponses,
    convertResponsesRequestToMessages,
} from '../src/converters/responses-messages/request.js';
import { createResponsesToMessagesStreamTranslator } from '../src/converters/responses-messages/response.js';
import { createChatToResponsesStreamTranslator } from '../src/converters/chat-responses/response.js';

describe('Phase2 pipeline useResponse (P0)', () => {
    test('useResponse rewrites envelope after terminal translation', () => {
        const r = new TranslatorRegistry();
        r.register('openai', 'claude', null, {
            nonStream: (model, _o, _t, body) => ({ ...body, model }),
        });
        const p = new TranslatorPipeline(r);
        p.useResponse((resp, next) => {
            const out = next(resp);
            return { ...out, chunks: [...out.chunks, { marker: true }] };
        });
        const out = p.translateResponse(
            'openai',
            'claude',
            { format: 'openai', model: 'm', stream: true, body: { c: 1 }, chunks: [{ c: 1 }] },
            {},
            {},
        );
        expect(out.format).toBe('claude');
        expect(out.chunks).toContainEqual({ marker: true });
    });

    test('stream with empty chunks falls back to single body translation', () => {
        const r = new TranslatorRegistry();
        r.register('openai', 'claude', null, {
            stream: (model, _o, _t, chunk) => [{ echo: chunk, model }],
        });
        const p = new TranslatorPipeline(r);
        const out = p.translateResponse(
            'openai',
            'claude',
            { format: 'openai', model: 'm', stream: true, body: { c: 1 }, chunks: [] },
            {},
            {},
        );
        expect(out.chunks).toEqual([{ echo: { c: 1 }, model: 'm' }]);
    });
});

describe('Phase3 json/usage boundaries (P0)', () => {
    test('num/str/asArray fail closed', () => {
        expect(num(NaN)).toBe(0);
        expect(num(Infinity)).toBe(0);
        expect(num('3')).toBe(0);
        expect(str(null)).toBe('');
        expect(str(42)).toBe('');
        expect(asArray('x')).toEqual([]);
        expect(asArray(null)).toEqual([]);
    });

    test('normalizeArgs handles missing and circular', () => {
        expect(normalizeArgs(undefined)).toBe('{}');
        expect(normalizeArgs(null)).toBe('{}');
        expect(normalizeArgs('')).toBe('{}');
        expect(normalizeArgs('{"a":1}')).toBe('{"a":1}');
        const circular = {};
        circular.self = circular;
        expect(normalizeArgs(circular)).toBe('{}');
    });

    test('makeId keeps prefix', () => {
        expect(makeId('resp_').startsWith('resp_')).toBe(true);
        expect(makeId('msg_').startsWith('msg_')).toBe(true);
        expect(makeId('toolu_').startsWith('toolu_')).toBe(true);
    });

    test('usage zero-fills unknown legs', () => {
        expect(usageToChat(null)).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
        expect(usageToResponses(undefined)).toEqual({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
        expect(usageToMessages([])).toEqual({ input_tokens: 0, output_tokens: 0 });
        expect(usageToInteractions([])).toEqual({ grounding_tool_count: [{ type: 'google_search', count: 0 }] });
        expect(usageToInteractions({ grounding_tool_count: [{ count: 2 }] })).toEqual({ grounding_tool_count: [{ type: 'google_search', count: 2 }] });
    });
});

describe('Phase1 regression: content/incomplete/is_error/custom (P0)', () => {
    test('chat array content extracts text (no silent drop)', () => {
        const out = convertChatResponseToResponsesNonStream('m', {}, {}, {
            id: 'chatcmpl-x',
            choices: [{ finish_reason: 'stop', message: { content: [{ text: 'he' }, { text: 'llo' }] } }],
            usage: {},
        });
        expect(out.output[0].content).toEqual([{ type: 'output_text', text: 'hello' }]);
    });

    test('responses incomplete content_filter round-trips (non-stream)', () => {
        const out = convertResponsesResponseToChatNonStream('m', {}, {}, {
            id: 'resp_x',
            status: 'incomplete',
            incomplete_details: { reason: 'content_filter' },
            output: [],
            usage: {},
        });
        expect(out.choices[0].finish_reason).toBe('content_filter');
        const out2 = convertResponsesResponseToChatNonStream('m', {}, {}, {
            id: 'resp_x',
            status: 'incomplete',
            output: [],
            usage: {},
        });
        expect(out2.choices[0].finish_reason).toBe('length');
    });

    test('chat tool ERROR: prefix maps to is_error and strips once', () => {
        const out = convertChatRequestToMessages('m', {
            messages: [{ role: 'tool', tool_call_id: 'toolu_1', content: 'ERROR: boom' }],
        }, false);
        expect(out.messages[0].content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'boom', is_error: true }]);
        const plain = convertChatRequestToMessages('m', {
            messages: [{ role: 'tool', tool_call_id: 'toolu_1', content: 'ok' }],
        }, false);
        expect(plain.messages[0].content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }]);
    });

    test('responses custom declaration kept so custom_tool_call has a declaration', () => {
        const out = convertResponsesRequestToMessages('m', {
            tools: [{ type: 'custom', name: 'mytool' }],
            input: [{ type: 'custom_tool_call', call_id: 'c1', name: 'mytool', input: 'hi' }],
        }, false);
        expect(out.tools).toHaveLength(1);
        expect(out.tools[0]).toMatchObject({ name: 'mytool' });
        expect(out.messages[0].content[0]).toMatchObject({ type: 'tool_use', name: 'mytool' });
    });

    test('messages is_error forwards as ERROR: prefix to responses', () => {
        const out = convertMessagesRequestToResponses('m', {
            messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }] }],
        }, false);
        expect(out.input[0]).toMatchObject({ type: 'function_call_output', output: 'ERROR: boom' });
    });
});

describe('Phase4 text-core downgrade pinned (P0)', () => {
    test('responses->messages stream drops function_call_arguments (text only)', () => {
        const next = createResponsesToMessagesStreamTranslator('m', 'msg_pin');
        next({ type: 'response.created', response: {} });
        const toolEvents = next({ type: 'response.function_call_arguments.delta', delta: '{"a":1}' });
        // Text-core: tool deltas produce no Anthropic events.
        expect(toolEvents).toEqual([]);
    });

    test('chat->responses stream text flows; terminal usage zero-filled when absent', () => {
        const next = createChatToResponsesStreamTranslator('m', 'resp_pin');
        const deltas = next({ choices: [{ delta: { content: 'hi' }, finish_reason: null }] });
        expect(deltas.some((e) => e.type === 'response.output_text.delta')).toBe(true);
    });
});
