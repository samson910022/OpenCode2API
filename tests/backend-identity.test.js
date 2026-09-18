import { jest } from '@jest/globals';
import { resolveBackendClient, applyBackendIdentityEnv, ensureJailGitRepo } from '../src/backend/manager.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Stage-1: spawned backend must advertise a first-party client identity
// (x-opencode-client is minted inside the backend from OPENCODE_CLIENT).
// Unknown/foreign values inherited from the gateway host would classify us
// as "not from within OpenCode", so they fall back to the real CLI default.
describe('resolveBackendClient', () => {
    const KEY = 'OPENCODE_CLIENT';
    let saved;

    beforeEach(() => {
        saved = process.env[KEY];
        delete process.env[KEY];
    });

    afterEach(() => {
        if (saved === undefined) delete process.env[KEY];
        else process.env[KEY] = saved;
    });

    test('defaults to cli when unset/empty/whitespace', () => {
        expect(resolveBackendClient()).toBe('cli');
        process.env[KEY] = '';
        expect(resolveBackendClient()).toBe('cli');
        process.env[KEY] = '   ';
        expect(resolveBackendClient()).toBe('cli');
    });

    test('falls back to cli for unknown values', () => {
        process.env[KEY] = 'opencode2api';
        expect(resolveBackendClient()).toBe('cli');
        process.env[KEY] = 'gateway';
        expect(resolveBackendClient()).toBe('cli');
    });

    test('passes through known first-party values', () => {
        for (const v of ['cli', 'desktop', 'acp', 'app']) {
            process.env[KEY] = v;
            expect(resolveBackendClient()).toBe(v);
            process.env[KEY] = `  ${v}  `;
            expect(resolveBackendClient()).toBe(v);
        }
    });
});

describe('applyBackendIdentityEnv', () => {
    const KEY = 'OPENCODE_CLIENT';
    let saved;

    beforeEach(() => {
        saved = process.env[KEY];
        delete process.env[KEY];
    });

    afterEach(() => {
        if (saved === undefined) delete process.env[KEY];
        else process.env[KEY] = saved;
    });

    test('pins OPENCODE_CLIENT, overwriting foreign presets', () => {
        const env = applyBackendIdentityEnv({ OPENCODE_CLIENT: 'opencode2api' });
        expect(env['OPENCODE_CLIENT']).toBe('cli');
        process.env[KEY] = 'desktop';
        expect(applyBackendIdentityEnv({})['OPENCODE_CLIENT']).toBe('desktop');
    });

    test('removes only the literal public API key (anonymous uses empty)', () => {
        expect(applyBackendIdentityEnv({ OPENCODE_API_KEY: 'public' })['OPENCODE_API_KEY']).toBeUndefined();
        expect(applyBackendIdentityEnv({ OPENCODE_API_KEY: '  public  ' })['OPENCODE_API_KEY']).toBeUndefined();
        const real = applyBackendIdentityEnv({ OPENCODE_API_KEY: 'opencode-real-key-1' });
        expect(real['OPENCODE_API_KEY']).toBe('opencode-real-key-1');
        expect('OPENCODE_API_KEY' in applyBackendIdentityEnv({})).toBe(false);
    });
});

describe('jail git repo', () => {
    test('ensureJailGitRepo initializes and detects existing repos', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitrepo-test-'));
        expect(fs.existsSync(path.join(dir, '.git'))).toBe(false);
        expect(ensureJailGitRepo(dir)).toBe(true);
        expect(fs.existsSync(path.join(dir, '.git'))).toBe(true);
        expect(ensureJailGitRepo(dir)).toBe(true);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('ensureJailGitRepo fails open (warn + false) when git cannot run', () => {
        const spy = jest.spyOn(fs, 'existsSync').mockImplementationOnce(() => {
            throw new Error('boom');
        });
        try {
            expect(ensureJailGitRepo('/nonexistent-workspace-xyz')).toBe(false);
        } finally {
            spy.mockRestore();
        }
    });
});
