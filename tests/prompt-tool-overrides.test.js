import { selectPromptToolOverrides, isFreeTierSuspectModel } from '../src/proxy.js';

// Stage-5: Zen's free tier answers all-false tools maps with FreeTierError
// 403 (verified live); omitted or any-true maps return 200. The omission
// applies ONLY to likely-free Zen models — paid/other providers keep the
// exact old behavior (map always sent) so hard-disable never softens there.
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

    test('passes through maps with at least one enabled tool (any tier)', () => {
        const mixed = { bash: false, read: true };
        expect(selectPromptToolOverrides(mixed, ...FREE)).toBe(mixed);
        expect(selectPromptToolOverrides(mixed, ...PAID)).toBe(mixed);
    });

    test('drops all-false maps only for free-tier suspects', () => {
        expect(selectPromptToolOverrides({ bash: false, read: false }, ...FREE)).toBeNull();
        const paidMap = { bash: false };
        expect(selectPromptToolOverrides(paidMap, ...PAID)).toBe(paidMap);
    });

    test('drops empty/non-object inputs (previous call-site behavior)', () => {
        expect(selectPromptToolOverrides(null, ...FREE)).toBeNull();
        expect(selectPromptToolOverrides(undefined, ...FREE)).toBeNull();
        expect(selectPromptToolOverrides({}, ...FREE)).toBeNull();
        expect(selectPromptToolOverrides([], ...FREE)).toBeNull();
        expect(selectPromptToolOverrides('bash', ...FREE)).toBeNull();
    });
});
