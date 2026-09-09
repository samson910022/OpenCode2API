const { TranslatorRegistry } = await import('../src/converters/registry.js');
const formats = await import('../src/converters/formats.js');
const { TranslatorPipeline } = await import('../src/converters/pipeline.js');

describe('translator formats (CLIProxyAPI formats.go port)', () => {
    test('exposes four protocols', () => {
        expect(formats.FormatOpenAI).toBe('openai');
        expect(formats.FormatOpenAIResponse).toBe('openai-response');
        expect(formats.FormatClaude).toBe('claude');
        expect(formats.FormatInteractions).toBe('interactions');
        expect(formats.isFormat('openai')).toBe(true);
        expect(formats.isFormat('nope')).toBe(false);
    });
});

describe('TranslatorRegistry P0 (CLIProxyAPI registry.go port)', () => {
    test('fallback preserves body and normalizes model', () => {
        const r = new TranslatorRegistry();
        expect(r.hasRequestTransformer('openai', 'claude')).toBe(false);
        const out = r.translateRequest('openai', 'claude', 'm', { model: 'old', x: 1 }, false);
        expect(out).toEqual({ model: 'm', x: 1 });
    });

    test('registered directed pairs translate and report Has*', () => {
        const r = new TranslatorRegistry();
        r.register('openai', 'claude', (model, body) => ({ ...body, model }), {
            stream: (model, _o, _t, chunk) => [{ ...chunk, model }],
            nonStream: (model, _o, _t, body) => ({ ...body, model }),
        });
        expect(r.hasRequestTransformer('openai', 'claude')).toBe(true);
        expect(r.hasStreamResponseTransformer('openai', 'claude')).toBe(true);
        expect(r.hasNonStreamResponseTransformer('openai', 'claude')).toBe(true);
        // Reverse direction stays unregistered (N×N is directed).
        expect(r.hasRequestTransformer('claude', 'openai')).toBe(false);
        expect(r.translateNonStream('openai', 'claude', 'm', {}, {}, { a: 1 })).toEqual({ a: 1, model: 'm' });
        expect(r.translateStream('openai', 'claude', 'm', {}, {}, { b: 2 })).toEqual([{ b: 2, model: 'm' }]);
        expect(r.size()).toEqual({ requests: 1, responses: 1 });
    });

    test('unregistered response falls back to passthrough', () => {
        const r = new TranslatorRegistry();
        const chunk = { x: 1 };
        expect(r.translateStream('openai', 'claude', 'm', {}, {}, chunk)).toEqual([chunk]);
        expect(r.translateNonStream('openai', 'claude', 'm', {}, {}, chunk)).toBe(chunk);
    });
});

describe('TranslatorPipeline P0 (CLIProxyAPI pipeline.go port)', () => {
    test('request middleware wraps terminal registry translation', () => {
        const r = new TranslatorRegistry();
        const p = new TranslatorPipeline(r);
        const seen = [];
        p.useRequest((req, next) => {
            seen.push(req.format);
            return next(req);
        });
        const out = p.translateRequest('openai', 'claude', { format: 'openai', model: 'm', stream: false, body: { model: 'x' } });
        expect(out.format).toBe('claude');
        expect(out.body).toEqual({ model: 'm' });
        expect(seen).toEqual(['openai']);
    });

    test('response terminal maps body->chunks for stream, body->body otherwise', () => {
        const r = new TranslatorRegistry();
        r.register('openai', 'claude', null, {
            stream: (model, _o, _t, chunk) => [{ echo: chunk }],
            nonStream: (model, _o, _t, body) => ({ ...body, model }),
        });
        const p = new TranslatorPipeline(r);
        const streamed = p.translateResponse(
            'openai',
            'claude',
            { format: 'openai', model: 'm', stream: true, body: { c: 1 }, chunks: [] },
            {},
            {},
        );
        expect(streamed.format).toBe('claude');
        expect(streamed.chunks).toEqual([{ echo: { c: 1 } }]);
        const plain = p.translateResponse(
            'openai',
            'claude',
            { format: 'openai', model: 'm', stream: false, body: { a: 1 }, chunks: [] },
            {},
            {},
        );
        expect(plain.body).toEqual({ a: 1, model: 'm' });
    });

    test('tokenCount falls back to the passthrough value when unregistered', () => {
        const r = new TranslatorRegistry();
        expect(r.translateTokenCount('openai', 'claude', 7, { n: 7 })).toEqual({ n: 7 });
        expect(r.hasResponseTransformer('openai', 'claude')).toBe(false);
        r.register('openai', 'claude', null, { tokenCount: (n) => ({ count: n }) });
        expect(r.hasResponseTransformer('openai', 'claude')).toBe(true);
        expect(r.translateTokenCount('openai', 'claude', 7, null)).toEqual({ count: 7 });
    });

    test('directed pairs are one-way until the reverse is registered', () => {
        const r = new TranslatorRegistry();
        r.register('openai', 'claude', (model, body) => ({ ...body, model }), { nonStream: (m, _o, _t, b) => b });
        expect(r.hasNonStreamResponseTransformer('openai', 'claude')).toBe(true);
        expect(r.hasNonStreamResponseTransformer('claude', 'openai')).toBe(false);
        expect(r.translateNonStream('claude', 'openai', 'm', {}, {}, { a: 1 })).toEqual({ a: 1 });
    });

    test('stream terminal translates every buffered chunk through one holder', () => {
        const r = new TranslatorRegistry();
        const seen = [];
        r.register('openai', 'claude', null, {
            stream: (model, _o, _t, chunk, param) => {
                seen.push([chunk, param]);
                return [{ chunk }];
            },
        });
        const p = new TranslatorPipeline(r);
        const holder = {};
        const out = p.translateResponse(
            'openai',
            'claude',
            { format: 'openai', model: 'm', stream: true, body: { ignored: true }, chunks: [{ a: 1 }, { b: 2 }] },
            {},
            {},
            holder,
        );
        expect(out.chunks).toEqual([{ chunk: { a: 1 } }, { chunk: { b: 2 } }]);
        expect(seen[0][1]).toBe(holder);
        expect(seen[1][1]).toBe(holder);
    });
});
