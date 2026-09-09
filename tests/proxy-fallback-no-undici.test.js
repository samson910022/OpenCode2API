import { jest } from '@jest/globals';

// Simulates hosts where undici cannot load (e.g. Node < 22.19): engagement
// must fail open to direct instead of crashing the request.
jest.unstable_mockModule('undici', () => {
    throw new Error('undici unavailable on this runtime');
});

const { createProxyPool } = await import('../src/upstream-proxy/pool.js');

describe('proxy pool without undici runtime', () => {
    let savedFetch;
    let fetchCalls;
    beforeEach(() => {
        fetchCalls = [];
        savedFetch = globalThis.fetch;
        globalThis.fetch = (async (...args) => {
            fetchCalls.push(args);
            return new Response('direct-ok');
        }) as typeof fetch;
    });
    afterEach(() => {
        globalThis.fetch = savedFetch;
    });

    test('engaged non-loopback target fails open to direct', async () => {
        const pool = createProxyPool({ proxies: 'socks5://10.0.0.9:1080', cooldownMs: 60000 });
        expect(pool.engage('free')).toContain('socks5://');
        expect(pool.isEngaged()).toBe(true);
        const res = await pool.proxiedFetch('https://example.com/api', {});
        expect(fetchCalls.length).toBe(1);
        expect(await res.text()).toBe('direct-ok');
        // Second call remembers the failure (no repeated import storms).
        await pool.proxiedFetch('https://example.com/api', {});
        expect(fetchCalls.length).toBe(2);
    });
});
