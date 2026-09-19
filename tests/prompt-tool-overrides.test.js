import { selectPromptToolOverrides, isFreeTierSuspectModel } from '../src/proxy.js';

// Stage-5: Zen's free tier answers tools maps containing ANY `false` with
// FreeTierError 403 (verified live: single/all-false/mixed all gate; {},
// omitted, and true-only maps pass). The stripping applies ONLY to
// likely-free Zen models — paid/other providers keep the exact old behavior
// (map always sent) so hard-disable never softens there.
describe('isFreeTierSuspectModel', () => {
    test('matches opencode free-suffixed models', () => {
        expect(isFreeTierSuspectModel('opencode', 'muse-spark-1.3-contributor-free')).toBe(true);
        expect(isFreeTierSuspectModel('opencode', 'kimi-k2.5-free')).toBe(true);
    });

    test('matches documented free models without the suffix', () => {
        expect(isFreeTierSuspectModel('opencode', 'big-pickle')).toBe(true);
        expect(isFreeTierSuspectModel('opencode', 'union-alpha')).toBe(true);
    });

    test('rejects paid models, other providers, and non-strings', () => {
        expect(isFreeTierSuspectModel('opencode', 'kimi-k2.5')).toBe(false);
        expect(isFreeTierSuspectModel('opencode', 'gpt-5')).toBe(false);
        expect(isFreeTierSuspectModel('anthropic', 'muse-spark-1.3-contributor-free')).toBe(false);
        expect(isFreeTierSuspectModel('opencode', '')).toBe(false);
        expect(isFreeTierSuspectModel(null, 'x-free')).toBe(false);
        expect(isFreeTierSuspectModel('opencode', null)).toBe(false);
    });
});

describe('selectPromptToolOverrides', () => {
    const FREE = ['opencode', 'muse-spark-1.3-contributor-free'];
    const PAID = ['opencode', 'kimi-k2.5'];

    test('passes maps through verbatim for paid/other tiers', () => {
        const mixed = { bash: false, read: true };
        expect(selectPromptToolOverrides(mixed, ...PAID)).toBe(mixed);
        const allFalse = { bash: false };
        expect(selectPromptToolOverrides(allFalse, ...PAID)).toBe(allFalse);
    });

    test('strips false entries for free-tier suspects (any false gates)', () => {
        expect(selectPromptToolOverrides({ bash: false, read: true }, ...FREE)).toEqual({ read: true });
        expect(selectPromptToolOverrides({ bash: false, read: false }, ...FREE)).toBeNull();
        expect(selectPromptToolOverrides({ bash: true }, ...FREE)).toEqual({ bash: true });
    });

    test('drops empty/non-object inputs (previous call-site behavior)', () => {
        expect(selectPromptToolOverrides(null, ...FREE)).toBeNull();
        expect(selectPromptToolOverrides(undefined, ...FREE)).toBeNull();
        expect(selectPromptToolOverrides({}, ...FREE)).toBeNull();
        expect(selectPromptToolOverrides([], ...FREE)).toBeNull();
        expect(selectPromptToolOverrides('bash', ...FREE)).toBeNull();
    });

    test('omitted provider/model IDs keep the safe default (all-false preserved)', () => {
        // A route forgetting to pass provider/model must NOT soften the
        // hard-disable: isFreeTierSuspectModel(undefined, undefined) is false.
        const allFalse = { bash: false, read: false };
        expect(selectPromptToolOverrides(allFalse)).toBe(allFalse);
        expect(selectPromptToolOverrides(allFalse, undefined, undefined)).toBe(allFalse);
        expect(selectPromptToolOverrides(allFalse, 'opencode')).toBe(allFalse);
    });
});
