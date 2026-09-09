import { TranslatorRegistry, defaultTranslatorRegistry } from '../src/converters/registry.js';
import { registerAllTranslatorPairs } from '../src/converters/init.js';
import {
    ensureTranslatorsRegistered,
    isErrorEnvelope,
    translateRequestSafe,
    translateNonStreamSafe,
    translateStreamSafe,
    newStreamHolder,
} from '../src/converters/wire.js';
import { isTokenCountRegistered } from '../src/converters/fidelity.js';
import { holderTranslatorOf, createStreamHolder } from '../src/converters/holder.js';
import {
    anthropicMessagesToChatMessages,
    anthropicToolsToChatTools,
    anthropicToolChoiceToChat,
    extractSystemText,
} from '../src/converters/anthropic.js';

describe('Phase 1 wiring: registry fail-fast + idempotent init', () => {
    test('duplicate register throws (no silent overwrite)', () => {
        const r = new TranslatorRegistry();
        r.register('openai', 'claude', (model, body) => ({ ...body, model }), {
            nonStream: (m, _o, _t, b) => b,
        });
        expect(() =>
            r.register('openai', 'claude', (model, body) => ({ ...body, model }), {
                nonStream: (m, _o, _t, b) => b,
            }),
        ).toThrow(/duplicate/);
    });

    test('registerAll is idempotent on the same registry', () => {
        const r = new TranslatorRegistry();
        registerAllTranslatorPairs(r);
        expect(r.size()).toEqual({ requests: 12, responses: 12 });
        expect(() => registerAllTranslatorPairs(r)).not.toThrow();
        expect(r.size()).toEqual({ requests: 12, responses: 12 });
    });

    test('ensureTranslatorsRegistered initializes the shared default registry once', () => {
        const reg = ensureTranslatorsRegistered(defaultTranslatorRegistry());
        expect(reg.size()).toEqual({ requests: 12, responses: 12 });
        expect(() => ensureTranslatorsRegistered(defaultTranslatorRegistry())).not.toThrow();
    });

    test('isTokenCountRegistered derives from the registry (no static drift)', () => {
        const r = new TranslatorRegistry();
        registerAllTranslatorPairs(r);
        expect(isTokenCountRegistered(r)).toBe(false);
        const r2 = new TranslatorRegistry();
        r2.register('openai', 'claude', null, { tokenCount: (n) => ({ count: n }) });
        expect(isTokenCountRegistered(r2)).toBe(true);
    });
});

describe('Phase 1 wiring: error bypass + holder contract', () => {
    test('isErrorEnvelope covers the four route error-exit shapes', () => {
        expect(isErrorEnvelope({ error: { message: 'boom' } })).toBe(true);
        expect(isErrorEnvelope({ error: 'boom' })).toBe(true);
        expect(isErrorEnvelope({ type: 'response.failed', response: {} })).toBe(true);
        expect(isErrorEnvelope({ type: 'error', error: { message: 'x' } })).toBe(true);
        expect(isErrorEnvelope({ event: 'error', data: { message: 'x' } })).toBe(true);
        // Bare TransformedUpstreamErrorBody emitted unwrapped by routes.
        expect(isErrorEnvelope({ message: 'quota', type: 'insufficient_quota', code: 'insufficient_quota' })).toBe(true);
        // Raw SSE error strings bypass as well.
        expect(isErrorEnvelope('event: error\ndata: {"type":"error"}')).toBe(true);
        expect(isErrorEnvelope('data: {"type":"response.failed"}')).toBe(true);
        // Falsy sentinels are not error envelopes.
        expect(isErrorEnvelope({ error: '' })).toBe(false);
        expect(isErrorEnvelope({ error: 0 })).toBe(false);
        expect(isErrorEnvelope({ error: false })).toBe(false);
        expect(isErrorEnvelope({ error: null })).toBe(false);
        // Nested `error` wording inside valid content is not an envelope.
        expect(isErrorEnvelope({ model: 'm', messages: [{ role: 'user', content: 'string containing error' }] })).toBe(false);
        expect(isErrorEnvelope({ choices: [{ message: { content: 'error' } }] })).toBe(false);
        expect(isErrorEnvelope({ type: 'response.completed', response: {} })).toBe(false);
        expect(isErrorEnvelope({ event: 'message_stop', data: {} })).toBe(false);
        expect(isErrorEnvelope([])).toBe(false);
        expect(isErrorEnvelope({ model: 'm', messages: [] })).toBe(false);
        expect(isErrorEnvelope(null)).toBe(false);
        expect(isErrorEnvelope('data: {"type":"response.output_text.delta"}')).toBe(false);
    });

    test('Safe wrappers bypass error envelopes untouched', () => {
        const r = new TranslatorRegistry();
        registerAllTranslatorPairs(r);
        const errBody = { error: { message: 'boom' } };
        expect(translateRequestSafe(r, 'openai', 'claude', 'm', errBody, false)).toBe(errBody);
        expect(translateNonStreamSafe(r, 'openai', 'openai-response', 'm', {}, {}, errBody)).toBe(errBody);
        const errChunk = { type: 'response.failed', response: {} };
        const errStreamOut = translateStreamSafe(r, 'openai', 'openai-response', 'm', {}, {}, errChunk, {});
        expect(errStreamOut).toHaveLength(1);
        expect(errStreamOut[0]).toBe(errChunk);
        const typeErr = { type: 'error', error: { message: 'x' } };
        expect(translateNonStreamSafe(r, 'openai', 'claude', 'm', {}, {}, typeErr)).toBe(typeErr);
        const bareErr = { message: 'quota', type: 'insufficient_quota' };
        expect(translateNonStreamSafe(r, 'openai', 'claude', 'm', {}, {}, bareErr)).toBe(bareErr);
        const errEvent = { event: 'error', data: {} };
        const errEventOut = translateStreamSafe(r, 'openai', 'claude', 'm', {}, {}, errEvent, {});
        expect(errEventOut).toHaveLength(1);
        expect(errEventOut[0]).toBe(errEvent);
    });

    test('Safe wrappers translate valid payloads (converted shape, not passthrough)', () => {
        const r = new TranslatorRegistry();
        registerAllTranslatorPairs(r);
        // Claude block input must convert to a chat string-content message;
        // passthrough fallback would keep the block array, so this proves conversion.
        const out = translateRequestSafe(r, 'claude', 'openai', 'm', { model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, false);
        expect(out).toMatchObject({ model: 'm' });
        // claude request shape carries converted chat messages, not claude blocks.
        expect(out).toHaveProperty('messages');
        expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
    });

    test('shared holder caches one translator per stream', () => {
        let created = 0;
        const holder = newStreamHolder();
        const first = holderTranslatorOf(holder, 'm', (m) => ({ m, n: ++created }));
        const second = holderTranslatorOf(holder, 'm', (m) => ({ m, n: ++created }));
        expect(first).toBe(second);
        expect(created).toBe(1);
        expect(createStreamHolder()).toEqual({});
        // Per-stream isolation: two holders never share a translator.
        const other = newStreamHolder();
        expect(holderTranslatorOf(other, 'm', (m) => ({ m, n: ++created }))).not.toBe(first);
        // Primitive/null params fall back to fresh translators (single-shot only).
        expect(holderTranslatorOf(null, 'm', (m) => ({ m, n: ++created }))).not.toBe(holderTranslatorOf(undefined, 'm', (m) => ({ m, n: ++created })));
    });

    test('same holder reused across stream chunks (no state reset)', () => {
        const r = new TranslatorRegistry();
        registerAllTranslatorPairs(r);
        const holder = newStreamHolder();
        const c1 = translateStreamSafe(r, 'openai', 'openai-response', 'm', {}, {}, { choices: [{ delta: { content: 'a' } }] }, holder);
        expect(holder.translator).toBeDefined();
        const cached = holder.translator;
        const c2 = translateStreamSafe(r, 'openai', 'openai-response', 'm', {}, {}, { choices: [{ delta: { content: 'b' }, finish_reason: 'stop' }] }, holder);
        expect(holder.translator).toBe(cached);
        expect(Array.isArray(c1) && Array.isArray(c2)).toBe(true);
        expect(c2.length).toBeGreaterThan(0);
    });
});

describe('Phase 2 parity: N×N claude->openai matches legacy anthropic.ts', () => {
    function translatedOf(claudeBody) {
        const r = new TranslatorRegistry();
        registerAllTranslatorPairs(r);
        return translateRequestSafe(r, 'claude', 'openai', 'm', claudeBody, false);
    }

    test('text + system string matches legacy block', () => {
        const claudeBody = { model: 'm', system: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
        const out = translatedOf(claudeBody);
        const legacyMessages = anthropicMessagesToChatMessages(claudeBody.messages);
        const legacySystem = extractSystemText(claudeBody.system);
        if (legacySystem) legacyMessages.unshift({ role: 'system', content: legacySystem });
        expect(out.messages).toEqual(legacyMessages);
    });

    test('tools + tool_choice match legacy', () => {
        const tools = [{ name: 't', description: 'd', input_schema: { type: 'object' } }];
        const out = translatedOf({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools, tool_choice: { type: 'tool', name: 't' } });
        expect(out.tools).toEqual(anthropicToolsToChatTools(tools));
        expect(out.tool_choice).toEqual(anthropicToolChoiceToChat({ type: 'tool', name: 't' }));
    });

    test('empty tools/choice stay absent (route downstream defaults apply)', () => {
        const out = translatedOf({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
        expect(out.tools).toBeUndefined();
        expect(out.tool_choice).toBeUndefined();
    });

    test('image + tool_result blocks match legacy messages', () => {
        const messages = [
            { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }, { type: 'text', text: 'see' }] },
            { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 't', input: { a: 1 } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
        ];
        const out = translatedOf({ model: 'm', messages });
        expect(out.messages).toEqual(anthropicMessagesToChatMessages(messages));
    });

    test('adversarial extra type:error still converts via direct registry path', () => {
        const r = new TranslatorRegistry();
        registerAllTranslatorPairs(r);
        // Mirror the route direction (claude->openai): validation ignores extra
        // fields, so the body reaches translation; Safe would bypass (identity)
        // while the direct registry path converts (mode-confusion guard).
        const adversarial = { model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], type: 'error' };
        expect(translateRequestSafe(r, 'claude', 'openai', 'm', adversarial, false)).toBe(adversarial);
        const direct = r.translateRequest('claude', 'openai', 'm', adversarial, false);
        expect(direct).not.toBe(adversarial);
        expect(direct).toHaveProperty('messages');
    });
});

describe('Phase 2 parity: adaptive reasoning gate collapses to legacy', () => {
    async function gate() {
        const mod = await import('../src/converters/chat-messages/request.js');
        return mod.resolveMessagesReasoningLevel;
    }

    test('adaptive/auto family collapses to null (no prompt leak)', async () => {
        const resolveMessagesReasoningLevel = await gate();
        const normalize = (v) => {
            const map = { none: 'none', minimal: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'high' };
            if (!v || typeof v !== 'string') return null;
            return map[v.toLowerCase()] ?? null;
        };
        expect(resolveMessagesReasoningLevel({ type: 'adaptive' }, 'auto', normalize)).toBe(null);
        expect(resolveMessagesReasoningLevel({ type: 'adaptive', output_config: { effort: 'high' } }, 'high', normalize)).toBe(null);
        expect(resolveMessagesReasoningLevel({ type: 'auto' }, 'low', normalize)).toBe(null);
        // Full adaptive matrix: every effort variant + casing collapses.
        for (const effort of ['high', 'medium', 'low', 'min', 'max', 'unknown']) {
            expect(resolveMessagesReasoningLevel({ type: 'adaptive', output_config: { effort } }, effort, normalize)).toBe(null);
        }
        expect(resolveMessagesReasoningLevel({ type: 'adaptive', effort: 'medium' }, 'medium', normalize)).toBe(null);
        expect(resolveMessagesReasoningLevel({ type: 'Adaptive' }, 'high', normalize)).toBe(null);
        expect(resolveMessagesReasoningLevel({ type: 'AUTO' }, 'low', normalize)).toBe(null);
        expect(resolveMessagesReasoningLevel({ type: 'enabled', budget_tokens: 24000 }, 'high', normalize)).toBe('high');
        expect(resolveMessagesReasoningLevel({ type: 'disabled' }, 'none', normalize)).toBe('none');
        expect(resolveMessagesReasoningLevel(undefined, undefined, normalize)).toBe(null);
    });
});
