import {
    BACKEND_PROJECT_DIR,
    BACKEND_PERMISSION_TOOL_KEYS,
    buildBackendPermission,
} from '../src/backend/backend-permission.js';

// Contract: the headless backend (opencode serve) must never `ask` (nobody
// can approve, so the prompt hangs until the proxy 180s timeout) and must
// not silently execute tools the proxy did not authorize (free-tier strip
// omits the tools map -> backend falls back to agent defaults = all on).
// Default posture is deny-all; only explicitly allowlisted internal tools
// are allowed. external_directory is always jailed to the backend project.

const EXECUTION_KEYS = [
    'read',
    'edit',
    'glob',
    'grep',
    'list',
    'bash',
    'task',
    'todowrite',
    'question',
    'webfetch',
    'websearch',
    'lsp',
    'doom_loop',
    'skill',
];

describe('backend permission contract', () => {
    test('project dir constant matches the container backend project', () => {
        expect(BACKEND_PROJECT_DIR).toBe('/home/node/project');
    });

    test('tool keys are exactly the schema-valid opencode permission keys', () => {
        expect([...BACKEND_PERMISSION_TOOL_KEYS].sort()).toEqual(
            [...EXECUTION_KEYS, 'external_directory'].sort(),
        );
    });

    test('default (no args) denies everything and jails the filesystem', () => {
        const perm = buildBackendPermission();
        for (const key of EXECUTION_KEYS) {
            expect(perm[key]).toBe('deny');
        }
        expect(perm['external_directory']).toEqual({
            [`${BACKEND_PROJECT_DIR}/**`]: 'allow',
            '*': 'deny',
        });
        expect(Object.values(perm)).not.toContain('ask');
    });

    test('explicit allowlist allows only the listed tools', () => {
        const perm = buildBackendPermission(['websearch']);
        expect(perm['websearch']).toBe('allow');
        expect(perm['webfetch']).toBe('deny');
        expect(perm['bash']).toBe('deny');
        expect(perm['read']).toBe('deny');
    });

    test('explicit opt-in to execution tools is preserved', () => {
        const perm = buildBackendPermission(['bash', 'read']);
        expect(perm['bash']).toBe('allow');
        expect(perm['read']).toBe('allow');
        expect(perm['edit']).toBe('deny');
    });

    test('alias and case variants match the schema key (web_fetch -> webfetch)', () => {
        expect(buildBackendPermission(['web_fetch'])['webfetch']).toBe('allow');
        expect(buildBackendPermission(['WebSearch'])['websearch']).toBe('allow');
        expect(buildBackendPermission(['WEB-FETCH'])['webfetch']).toBe('allow');
    });

    test('webFetchEnabled shortcut allows webfetch when no explicit list', () => {
        const perm = buildBackendPermission([], true);
        expect(perm['webfetch']).toBe('allow');
        expect(perm['websearch']).toBe('deny');
    });

    test('explicit list wins over the webfetch shortcut', () => {
        const perm = buildBackendPermission(['read'], true);
        expect(perm['read']).toBe('allow');
        expect(perm['webfetch']).toBe('deny');
    });

    test('unknown names are ignored and never emitted (schema-safe)', () => {
        const perm = buildBackendPermission(['nonexistent_xyz', '', '  ', 123, null]);
        expect(perm['nonexistent_xyz']).toBeUndefined();
        for (const key of EXECUTION_KEYS) {
            expect(perm[key]).toBe('deny');
        }
        expect(Object.keys(perm).sort()).toEqual([...BACKEND_PERMISSION_TOOL_KEYS].sort());
    });

    test('garbage inputs fall back to deny-all', () => {
        for (const bad of [null, undefined, 'bash', 42, { bash: true }]) {
            const perm = buildBackendPermission(bad);
            for (const key of EXECUTION_KEYS) {
                expect(perm[key]).toBe('deny');
            }
        }
    });

    test('external_directory stays jailed even when read is allowed', () => {
        const perm = buildBackendPermission(['read']);
        expect(perm['read']).toBe('allow');
        expect(perm['external_directory']).toEqual({
            [`${BACKEND_PROJECT_DIR}/**`]: 'allow',
            '*': 'deny',
        });
    });

    test('flat-action keys are strings, never objects', () => {
        const perm = buildBackendPermission(['websearch', 'question']);
        for (const key of ['todowrite', 'question', 'webfetch', 'websearch', 'doom_loop']) {
            expect(typeof perm[key]).toBe('string');
        }
        expect(perm['websearch']).toBe('allow');
        expect(perm['question']).toBe('allow');
    });

    test('custom projectDir scopes the jail (isolated-home workspaces)', () => {
        const perm = buildBackendPermission([], false, '/tmp/jail-xyz/empty-workspace');
        expect(perm['external_directory']).toEqual({
            '/tmp/jail-xyz/empty-workspace/**': 'allow',
            '*': 'deny',
        });
        for (const key of ['read', 'bash', 'websearch']) {
            expect(perm[key]).toBe('deny');
        }
    });

    test('garbage projectDir falls back to the container default', () => {
        for (const bad of [null, undefined, '', '  ', 42]) {
            expect(buildBackendPermission([], false, bad)['external_directory']).toEqual({
                [`${BACKEND_PROJECT_DIR}/**`]: 'allow',
                '*': 'deny',
            });
        }
    });
});
