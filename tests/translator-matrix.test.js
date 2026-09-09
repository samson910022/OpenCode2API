import { TranslatorRegistry } from '../src/converters/registry.js';
import { registerAllTranslatorPairs } from '../src/converters/init.js';
import { STREAM_FIDELITY, TOKEN_COUNT_REGISTERED, streamFidelityOf } from '../src/converters/fidelity.js';
import { targetId } from '../src/converters/json.js';
import {
    usageToChat,
    usageToInteractions,
    usageToMessages,
    usageToResponses,
} from '../src/converters/usage.js';
import { createResponsesToChatStreamTranslator } from '../src/converters/chat-responses/response.js';
import { createMessagesToChatStreamTranslator } from '../src/converters/chat-messages/response.js';
import {
    createMessagesToResponsesStreamTranslator,
    createResponsesToMessagesStreamTranslator,
} from '../src/converters/responses-messages/response.js';
import {
    createInteractionsToChatStreamTranslator,
    createInteractionsToMessagesStreamTranslator,
    createInteractionsToResponsesStreamTranslator,
    createMessagesToInteractionsStreamTranslator,
    createResponsesToInteractionsStreamTranslator,
} from '../src/converters/interactions/response.js';

function fullMatrixRegistry() {
    const r = new TranslatorRegistry();
    registerAllTranslatorPairs(r);
    return r;
}

describe('P4 usage alignment (wire shapes preserved, zero-filled legs)', () => {
    test('chat/responses/messages legs interconvert; interactions stays grounding-only', () => {
        expect(usageToChat({ input_tokens: 3, output_tokens: 4, total_tokens: 7 })).toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
        expect(usageToResponses({ prompt_tokens: 3, completion_tokens: 4 })).toEqual({ input_tokens: 3, output_tokens: 4, total_tokens: 7 });
        expect(usageToMessages({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 99 })).toEqual({ input_tokens: 3, output_tokens: 4 });
        expect(usageToInteractions({ prompt_tokens: 3 })).toEqual({ grounding_tool_count: [{ type: 'google_search', count: 0 }] });
        expect(usageToInteractions({ grounding_tool_count: [{ type: 'google_search', count: 2 }] })).toEqual({ grounding_tool_count: [{ type: 'google_search', count: 2 }] });
    });
});

describe('P4 stream matrix has no missing directed edge', () => {
    test('all 12 response stream directions registered', () => {
        const r = fullMatrixRegistry();
        const pairs = [
            ['openai', 'openai-response'], ['openai-response', 'openai'],
            ['openai', 'claude'], ['claude', 'openai'],
            ['openai-response', 'claude'], ['claude', 'openai-response'],
            ['openai', 'interactions'], ['interactions', 'openai'],
            ['openai-response', 'interactions'], ['interactions', 'openai-response'],
            ['claude', 'interactions'], ['interactions', 'claude'],
        ];
        for (const [from, to] of pairs) {
            expect(r.hasStreamResponseTransformer(from, to)).toBe(true);
        }
        expect(r.size()).toEqual({ requests: 12, responses: 12 });
        // Fidelity ledger: 3 full forward edges, 9 text-core — no edge poses.
        expect(Object.keys(STREAM_FIDELITY)).toHaveLength(12);
        expect(streamFidelityOf('openai', 'openai-response')).toBe('full');
        expect(streamFidelityOf('openai', 'claude')).toBe('full');
        expect(streamFidelityOf('openai', 'interactions')).toBe('full');
        expect(streamFidelityOf('claude', 'openai')).toBe('text-core');
        // TokenCount intentionally unregistered on all edges (collector counts).
        expect(TOKEN_COUNT_REGISTERED).toBe(false);
        expect(r.translateTokenCount('openai', 'claude', 7, { n: 7 })).toEqual({ n: 7 });
    });

    test('reverse streams carry text end-to-end', () => {
        const toChat = createResponsesToChatStreamTranslator('m', 'c1');
        expect(toChat({ type: 'response.output_text.delta', delta: 'hi' })[0].choices[0].delta).toEqual({ content: 'hi' });
        const done = toChat({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } });
        expect(done[0].choices[0].finish_reason).toBe('stop');
        expect(done[0].usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });

        const msgToChat = createMessagesToChatStreamTranslator('m', 'c2');
        expect(msgToChat({ event: 'content_block_delta', data: { delta: { type: 'text_delta', text: 'yo' } } })[0].choices[0].delta).toEqual({ content: 'yo' });

        const msgToChat2 = createMessagesToChatStreamTranslator('m', 'c2b');
        msgToChat2({ event: 'message_start', data: { message: { usage: { input_tokens: 11 } } } });
        const msgDone = msgToChat2({ event: 'message_delta', data: { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } } });
        expect(msgDone[0].usage).toEqual({ prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 });

        const respToMsg = createResponsesToMessagesStreamTranslator('m', 'msg_9');
        const e1 = respToMsg({ type: 'response.output_text.delta', delta: 'a' });
        expect(e1[0]).toMatchObject({ event: 'message_start' });
        const msgToResp = createMessagesToResponsesStreamTranslator('m', 'resp_9');
        msgToResp({ event: 'message_start', data: {} });
        expect(msgToResp({ event: 'content_block_delta', data: { delta: { type: 'text_delta', text: 'b' } } })[0]).toMatchObject({ type: 'response.output_text.delta', delta: 'b' });

        const intrToChat = createInteractionsToChatStreamTranslator('m', 'c3');
        expect(intrToChat({ type: 'step.delta', delta: 's' })[0].choices[0].delta).toEqual({ content: 's' });
        const chatToIntr = createResponsesToInteractionsStreamTranslator('m', 'intr_9');
        chatToIntr({ type: 'response.created', response: {} });
        expect(chatToIntr({ type: 'response.output_text.delta', delta: 't' })[0]).toMatchObject({ type: 'step.delta', delta: 't' });
        const msgToIntr = createMessagesToInteractionsStreamTranslator('m', 'intr_8');
        msgToIntr({ event: 'message_start', data: {} });
        expect(msgToIntr({ event: 'content_block_delta', data: { delta: { type: 'text_delta', text: 'u' } } })[0]).toMatchObject({ type: 'step.delta', delta: 'u' });
        const intrToResp = createInteractionsToResponsesStreamTranslator('m', 'resp_8');
        intrToResp({ type: 'interaction.created', interaction: {} });
        expect(intrToResp({ type: 'step.delta', delta: 'v' })[0]).toMatchObject({ type: 'response.output_text.delta', delta: 'v' });
        const intrToMsg = createInteractionsToMessagesStreamTranslator('m', 'msg_8');
        intrToMsg({ type: 'interaction.created', interaction: {} });
        const wEvents = intrToMsg({ type: 'step.delta', delta: 'w' });
        expect(wEvents).toContainEqual(expect.objectContaining({ event: 'content_block_delta' }));
    });

    test('empty interaction stream emits no spurious content block', () => {
        const next = createInteractionsToMessagesStreamTranslator('m', 'msg_empty');
        next({ type: 'interaction.created', interaction: {} });
        const done = next({ type: 'interaction.completed', interaction: {} });
        expect(done.some((e) => e.event === 'content_block_start')).toBe(false);
        expect(done[done.length - 1]).toMatchObject({ event: 'message_stop' });
    });

    test('empty responses stream emits no spurious content block; usage flows', () => {
        const next = createResponsesToMessagesStreamTranslator('m', 'msg_rempty');
        const e1 = next({ type: 'response.created', response: {} });
        expect(e1.some((e) => e.event === 'content_block_start')).toBe(false);
        const done = next({ type: 'response.completed', response: { usage: { input_tokens: 4, output_tokens: 5 } } });
        const delta = done.find((e) => e.event === 'message_delta');
        expect(delta.data.usage).toEqual({ input_tokens: 4, output_tokens: 5 });
    });
});

describe('P4 error wire contracts untouched (registry never sees errors)', () => {
    test('routes still own error envelopes: registry has no error pair and must be bypassed', () => {
        const r = fullMatrixRegistry();
        // All 12 request directions are registered, so an error-shaped body
        // MUST NOT be fed to translators (converters assume valid requests).
        // Pin the bypass contract: error envelopes are route-owned; the
        // registry offers no error mapping and callers branch before calling.
        expect(r.hasRequestTransformer('openai', 'claude')).toBe(true);
        const valid = r.translateRequest('openai', 'claude', 'm', { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, false);
        expect(valid).toMatchObject({ model: 'm' });
    });
});

describe('targetId boundaries', () => {
    test('empty/short/foreign ids regenerate; exact prefix preserved', () => {
        const gen = () => 'resp_new';
        expect(targetId('', 'resp_', gen)).toBe('resp_new');
        expect(targetId('resp_', 'resp_', gen)).toBe('resp_new');
        expect(targetId('chatcmpl-x', 'resp_', gen)).toBe('resp_new');
        expect(targetId('resp_keep', 'resp_', gen)).toBe('resp_keep');
        expect(targetId(42, 'resp_', gen)).toBe('resp_new');
    });
});
