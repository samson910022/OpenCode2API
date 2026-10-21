import { resolveAuthoritativeStreamSource } from '../src/tool-runtime/stream-source.js';

const rawInput = (overrides = {}) => ({
    collected: { content: 'raw content', reasoning: 'raw reasoning', authoritative: false },
    rawContent: 'raw content',
    rawReasoning: 'raw reasoning',
    ...overrides
});

describe('resolveAuthoritativeStreamSource', () => {
    test('an empty completed poll falls back to the collector/raw group', () => {
        const source = resolveAuthoritativeStreamSource(rawInput({
            polledSnapshot: { content: '', reasoning: '', error: null, complete: true }
        }));
        expect(source).toMatchObject({
            kind: 'raw',
            fromSnapshot: false,
            content: 'raw content',
            reasoning: 'raw reasoning'
        });
    });

    test('a partial poll never wins even when it has text', () => {
        const source = resolveAuthoritativeStreamSource(rawInput({
            polledSnapshot: { content: 'partial text', reasoning: '', error: null, partial: true }
        }));
        expect(source).toMatchObject({ kind: 'raw', fromSnapshot: false, content: 'raw content' });
    });

    test('a complete non-empty poll wins over raw and collector snapshots', () => {
        const source = resolveAuthoritativeStreamSource(rawInput({
            collected: { content: 'collector repaired', reasoning: '', authoritative: true },
            polledSnapshot: { content: 'polled answer', reasoning: 'polled reasoning', error: null, complete: true }
        }));
        expect(source).toEqual({
            kind: 'polled-snapshot',
            fromSnapshot: true,
            content: 'polled answer',
            reasoning: 'polled reasoning'
        });
    });

    test('a collector-authoritative repair wins when no poll snapshot exists', () => {
        const source = resolveAuthoritativeStreamSource(rawInput({
            collected: { content: 'repaired answer', reasoning: 'repaired reasoning', authoritative: true }
        }));
        expect(source).toEqual({
            kind: 'collector-snapshot',
            fromSnapshot: true,
            content: 'repaired answer',
            reasoning: 'repaired reasoning'
        });
    });

    test('equal or empty collector text is never authoritative', () => {
        const equal = resolveAuthoritativeStreamSource(rawInput({
            collected: { content: 'raw content', reasoning: 'raw reasoning', authoritative: true }
        }));
        expect(equal).toMatchObject({ kind: 'raw', fromSnapshot: false, content: 'raw content' });

        const empty = resolveAuthoritativeStreamSource(rawInput({
            collected: { content: '', reasoning: '', authoritative: true }
        }));
        expect(empty).toMatchObject({ kind: 'raw', fromSnapshot: false, content: 'raw content' });
    });

    test('an error-bearing poll falls back to the collector/raw group', () => {
        const source = resolveAuthoritativeStreamSource(rawInput({
            polledSnapshot: { content: 'ignored', reasoning: '', error: { name: 'Boom' }, complete: true }
        }));
        expect(source).toMatchObject({ kind: 'raw', fromSnapshot: false, content: 'raw content' });
    });
});
