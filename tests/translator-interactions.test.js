import { TranslatorRegistry } from '../src/converters/registry.js';
import { registerInteractionsPairs } from '../src/converters/interactions/init.js';
import {
    convertChatRequestToInteractions,
    convertInteractionsRequestToChat,
    convertInteractionsRequestToMessages,
    convertInteractionsRequestToResponses,
    convertMessagesRequestToInteractions,
    convertResponsesRequestToInteractions,
} from '../src/converters/interactions/request.js';
import {
    convertChatResponseToInteractionsNonStream,
    convertInteractionsResponseToChatNonStream,
    convertInteractionsResponseToMessagesNonStream,
    convertInteractionsResponseToResponsesNonStream,
    convertMessagesResponseToInteractionsNonStream,
    convertResponsesResponseToInteractionsNonStream,
    createChatToInteractionsStreamTranslator,
} from '../src/converters/interactions/response.js';

function freshRegistry() {
    const r = new TranslatorRegistry();
    registerInteractionsPairs(r);
    return r;
}

describe('P3 interactions requests (Go openai/interactions + claude/interactions ports)', () => {
    test('chat system/tools fold to instructions/google_search; function tools dropped', () => {
        const out = convertChatRequestToInteractions('m', {
            messages: [
                { role: 'system', content: 'sys' },
                { role: 'user', content: 'hi' },
                { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{}' } }] },
            ],
            tools: [{ type: 'function', function: { name: 'f' } }, { type: 'function', function: { name: 'web_search' } }],
        }, false);
        expect(out.system_instruction).toBe('sys');
        expect(out.input).toEqual([{ role: 'user', content: 'hi' }]);
        expect(out.tools).toEqual([{ type: 'google_search' }]);
    });

    test('interactions input normalizes both ways; instructions round-trip', () => {
        const toChat = convertInteractionsRequestToChat('m', { input: 'hello', instructions: 'sys' }, false);
        expect(toChat.messages).toEqual([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }]);
        const toResp = convertInteractionsRequestToResponses('m', { input: [{ role: 'user', content: 'hi' }] }, false);
        expect(toResp.input).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]);
        const toMsg = convertInteractionsRequestToMessages('m', { input: 'hi' }, false);
        expect(toMsg.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
        const fromMsg = convertMessagesRequestToInteractions('m', { system: 'sys-m', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, false);
        expect(fromMsg.input).toEqual([{ role: 'user', content: 'hi' }]);
        expect(fromMsg.system_instruction).toBe('sys-m');
        const fromResp = convertResponsesRequestToInteractions('m', { instructions: 'sys-r', input: 'hi' }, false);
        expect(fromResp.input).toEqual([{ role: 'user', content: 'hi' }]);
        expect(fromResp.system_instruction).toBe('sys-r');
    });
});

describe('P3 interactions responses (non-stream core)', () => {
    test('chat/responses/messages text folds to output_text; interaction folds back', () => {
        const fromChat = convertChatResponseToInteractionsNonStream('m', {}, {}, {
            choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
        });
        expect(fromChat.output_text).toBe('done');
        expect(fromChat.usage).toEqual({ grounding_tool_count: [{ type: 'google_search', count: 0 }] });
        const fromResp = convertResponsesResponseToInteractionsNonStream('m', {}, {}, {
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
        });
        expect(fromResp.output_text).toBe('hi');
        const fromMsg = convertMessagesResponseToInteractionsNonStream('m', {}, {}, {
            content: [{ type: 'text', text: 'yo' }],
        });
        expect(fromMsg.output_text).toBe('yo');
        expect(convertInteractionsResponseToChatNonStream('m', {}, {}, { output_text: 'back' }).choices[0].message.content).toBe('back');
        expect(convertInteractionsResponseToResponsesNonStream('m', {}, {}, { output_text: 'back' }).output[0].content[0].text).toBe('back');
        expect(convertInteractionsResponseToMessagesNonStream('m', {}, {}, { output_text: 'back' }).content).toEqual([{ type: 'text', text: 'back' }]);
    });
});

describe('P3 interactions stream (route wire: created->step.delta->completed, no DONE)', () => {
    test('500-char slicing + deferred completed', () => {
        const next = createChatToInteractionsStreamTranslator('m', 'intr_1');
        const e1 = next({ choices: [{ delta: { content: 'a'.repeat(1200) } }] });
        expect(e1[0]).toMatchObject({ type: 'interaction.created' });
        expect(e1.filter((e) => e.type === 'step.delta')).toHaveLength(2);
        const e2 = next({ choices: [{ delta: {}, finish_reason: 'stop' }] });
        expect(e2[e2.length - 1]).toMatchObject({ type: 'interaction.completed', interaction: { id: 'intr_1', output_text: 'a'.repeat(1200), steps: [] } });
        expect(next({ choices: [{ delta: {}, finish_reason: 'stop' }] })).toEqual([]);
    });

    test('system_instruction string survives; tool text kept as role:tool', () => {
        const toChat = convertInteractionsRequestToChat('m', { input: [{ type: 'text', text: 'bare' }], system_instruction: 'sys-s' }, false);
        expect(toChat.messages[0]).toEqual({ role: 'system', content: 'sys-s' });
        expect(toChat.messages[1]).toEqual({ role: 'user', content: 'bare' });
        const toMsg = convertInteractionsRequestToMessages('m', { input: 'hi', system_instruction: { parts: 'sys-p' } }, false);
        expect(toMsg.system).toBe('sys-p');
        const fromChat = convertChatRequestToInteractions('m', { messages: [{ role: 'tool', tool_call_id: 'c1', content: 'res' }] }, false);
        expect(fromChat.input).toEqual([{ role: 'tool', content: 'res' }]);
    });
});

describe('P3 registry wiring', () => {
    test('6 directed pairs registered with chat->interactions stream', () => {
        const r = freshRegistry();
        for (const [from, to] of [['openai', 'interactions'], ['interactions', 'openai'], ['openai-response', 'interactions'], ['interactions', 'openai-response'], ['claude', 'interactions'], ['interactions', 'claude']]) {
            expect(r.hasRequestTransformer(from, to)).toBe(true);
            expect(r.hasNonStreamResponseTransformer(from, to)).toBe(true);
        }
        expect(r.hasStreamResponseTransformer('openai', 'interactions')).toBe(true);
        expect(r.size()).toEqual({ requests: 6, responses: 6 });
    });
});
