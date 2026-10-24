import express from 'express';
import net from 'node:net';
import request from 'supertest';
import { jest } from '@jest/globals';

import {
    canonicalJsonHash,
    IdempotencyRegistry,
    idempotencyDigest,
    idempotencyHeaderStorageBytes,
    idempotencyResponseStorageBytes,
    MIN_IDEMPOTENCY_TTL_MS,
    DEFAULT_IDEMPOTENCY_MAX_CACHED_BYTES_PER_TENANT,
    DEFAULT_IDEMPOTENCY_MAX_RESPONSE_BYTES,
} from '../src/idempotency/registry.js';
import { createIdempotencyMiddleware, scanSseDataEventRanges } from '../src/idempotency/middleware.js';

const promptBySession = new Map();
let sessionSequence = 0;
let forkSequence = 0;
let assistantSequence = 0;
let toolObservationCount = 0;

const sdkMocks = {
    configProviders: jest.fn(async () => ({
        data: { providers: [{ id: 'opencode', models: { 'kimi-k2.5': { name: 'Kimi' } } }] },
    })),
    configUpdate: jest.fn(async () => ({})),
    toolIds: jest.fn(async () => ({ data: ['websearch', 'webfetch'] })),
    sessionCreate: jest.fn(async () => ({ data: { id: `idem-session-${++sessionSequence}` } })),
    sessionFork: jest.fn(async () => ({ data: { id: `idem-fork-${++forkSequence}` } })),
    sessionPrompt: jest.fn(async (args) => {
        const sessionId = args?.path?.id;
        promptBySession.set(sessionId, structuredClone(args));
        const assistantId = `assistant-${++assistantSequence}`;
        return {
            data: {
                info: { id: assistantId, role: 'assistant', parentID: args?.body?.messageID, finish: 'stop' },
                parts: [{ type: 'text', text: 'idempotent answer' }],
            },
        };
    }),
    sessionMessages: jest.fn(async ({ path }) => {
        const prompt = promptBySession.get(path.id);
        const messageID = prompt?.body?.messageID;
        const assistantId = `assistant-poll-${path.id}`;
        const parts = [{ type: 'text', text: 'idempotent answer' }];
        if (prompt?.body?.tools?.websearch === true) {
            toolObservationCount += 1;
            parts.push({
                type: 'tool',
                id: 'search-tool-call',
                tool: 'websearch',
                state: { status: 'completed', input: { query: 'test query' }, output: 'tool result' },
            });
        }
        return [{
            info: {
                id: assistantId,
                role: 'assistant',
                parentID: messageID,
                sessionID: path.id,
                finish: 'stop',
            },
            parts,
        }];
    }),
    sessionDelete: jest.fn(async () => ({})),
    eventSubscribe: jest.fn(async () => ({ stream: (async function* () {})() })),
};
const defaultSessionMessagesImplementation = sdkMocks.sessionMessages.getMockImplementation();

jest.unstable_mockModule('@opencode-ai/sdk', () => ({
    createOpencodeClient: jest.fn(() => ({
        config: { providers: sdkMocks.configProviders, update: sdkMocks.configUpdate },
        tool: { ids: sdkMocks.toolIds },
        session: {
            create: sdkMocks.sessionCreate,
            fork: sdkMocks.sessionFork,
            prompt: sdkMocks.sessionPrompt,
            messages: sdkMocks.sessionMessages,
            delete: sdkMocks.sessionDelete,
        },
        event: { subscribe: sdkMocks.eventSubscribe },
    })),
}));

jest.unstable_mockModule('http', () => ({
    default: {
        get: jest.fn((_url, options, callback) => {
            const cb = typeof options === 'function' ? options : callback;
            cb({ statusCode: 200, headers: {}, on: jest.fn() });
            return { on: jest.fn(), destroy: jest.fn(), setTimeout: jest.fn() };
        }),
    },
}));

jest.unstable_mockModule('https', () => ({
    default: {
        get: jest.fn((_url, options, callback) => {
            const cb = typeof options === 'function' ? options : callback;
            cb({ statusCode: 200, headers: {}, on: jest.fn() });
            return { on: jest.fn(), destroy: jest.fn() };
        }),
    },
}));

const { createApp } = await import('../src/proxy.js');

afterEach(() => {
    jest.restoreAllMocks();
});

function createRouteApp(overrides = {}) {
    return createApp({
        PORT: 10000,
        API_KEY: '',
        API_KEYS: [],
        OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
        REQUEST_TIMEOUT_MS: 1000,
        RETRY_MAX_RETRIES: 0,
        DISABLE_TOOLS: true,
        DEBUG: false,
        ...overrides,
    });
}

function createMiddlewareApp({ keys = [], route, registryOptions = {} } = {}) {
    const app = express();
    const registry = new IdempotencyRegistry(registryOptions);
    app.use(express.json());
    app.use(createIdempotencyMiddleware({
        registry,
        configuredKeys: keys,
        matchedKeyIndex: (req) => {
            const authorization = req.headers.authorization;
            const token = typeof authorization === 'string' ? authorization.replace(/^Bearer\s+/i, '') : '';
            return keys.indexOf(token);
        },
    }));
    app.post(['/v1/responses', '/v1beta/interactions', '/v1/interactions'], route);
  return { app, registry };
}

async function startAbortedRequest(app, path, key, body) {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    const socket = net.createConnection(address.port, '127.0.0.1');
    await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
    });
    const payload = JSON.stringify(body);
    socket.write(
        `POST ${path} HTTP/1.1\r\n` +
        'Host: 127.0.0.1\r\n' +
        `Idempotency-Key: ${key}\r\n` +
        'Content-Type: application/json\r\n' +
        `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
        'Connection: close\r\n\r\n' +
        payload,
    );
    return {
        abort: () => socket.destroy(),
        closeServer: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    };
}

describe('idempotency canonicalization and bounded registry', () => {
    test('canonical JSON hashes ignore object order and nested object order, but preserve array order', () => {
        expect(canonicalJsonHash({ z: 2, a: { y: 1, x: 0 }, list: [1, 2] }))
            .toBe(canonicalJsonHash({ list: [1, 2], a: { x: 0, y: 1 }, z: 2 }));
        expect(canonicalJsonHash({ list: [1, 2] })).not.toBe(canonicalJsonHash({ list: [2, 1] }));
    });

    test('rejects non-finite numbers instead of canonicalizing them as null', () => {
        expect(() => canonicalJsonHash({ max_output_tokens: Infinity })).toThrow(/non-finite number/);
        expect(() => canonicalJsonHash({ max_output_tokens: -Infinity })).toThrow(/non-finite number/);
        expect(() => canonicalJsonHash({ max_output_tokens: NaN })).toThrow(/non-finite number/);
    });

    test('same scope with a different payload hash conflicts and distinct scopes remain independent', () => {
        const registry = new IdempotencyRegistry();
        const first = registry.begin('scope-a', canonicalJsonHash({ input: 'one' }));
        expect(first.kind).toBe('created');
        expect(registry.begin('scope-a', canonicalJsonHash({ input: 'two' })).kind).toBe('mismatch');
        expect(registry.begin('scope-b', canonicalJsonHash({ input: 'two' })).kind).toBe('created');
    });

    test('TTL is clamped to at least 30 minutes and expired records are removed', () => {
        let now = 10_000;
        const registry = new IdempotencyRegistry({ ttlMs: 1, now: () => now });
        const entry = registry.begin('scope', canonicalJsonHash({ input: 'x' }));
        expect(entry.kind).toBe('created');
        const callerBody = Buffer.from('{"error":"bad request"}');
        registry.complete(entry.record, entry.record.generation, 'failed', {
            statusCode: 400,
            headers: { 'content-type': 'application/json' },
            body: callerBody,
        });
        callerBody.fill(0);
        expect(entry.record.wireResponse.body.toString()).toBe('{"error":"bad request"}');
        expect(registry.pendingResponseBytes).toBe(0);
        expect(entry.record.expiresAt - now).toBeGreaterThanOrEqual(MIN_IDEMPOTENCY_TTL_MS);
        now += MIN_IDEMPOTENCY_TTL_MS - 1;
        expect(registry.get('scope')).not.toBeNull();
        now += 2;
        expect(registry.get('scope')).toBeNull();
    });

    test('retained header bytes are accounted and released with entry capacity after TTL', () => {
        let now = 10_000;
        const registry = new IdempotencyRegistry({
            maxEntries: 1,
            ttlMs: MIN_IDEMPOTENCY_TTL_MS,
            maxCachedBytes: 512,
            maxCachedBytesPerTenant: 512,
            now: () => now,
        });
        const first = registry.begin('header-ttl-one', canonicalJsonHash({ input: 'one' }), 'tenant-a');
        expect(first.kind).toBe('created');
        const response = {
            statusCode: 201,
            headers: { 'x-retained-header': 'h'.repeat(80) },
            body: Buffer.from('x'),
        };
        expect(registry.complete(first.record, first.record.generation, 'failed', response)).toBe(true);
        const retainedBytes = idempotencyResponseStorageBytes(first.record.wireResponse);
        expect(retainedBytes).toBeGreaterThan(response.body.byteLength);
        expect(registry.retainedResponseBytes).toBe(retainedBytes);
        expect(registry.getTenantRetainedResponseBytes('tenant-a')).toBe(retainedBytes);
        expect(registry.begin('header-ttl-two', canonicalJsonHash({ input: 'two' }), 'tenant-a').kind).toBe('full');

        now += MIN_IDEMPOTENCY_TTL_MS + 1;
        expect(registry.size).toBe(0);
        expect(registry.retainedResponseBytes).toBe(0);
        expect(registry.getTenantRetainedResponseBytes('tenant-a')).toBe(0);
        expect(registry.getTenantRetainedEntries('tenant-a')).toBe(0);
        expect(registry.begin('header-ttl-two', canonicalJsonHash({ input: 'two' }), 'tenant-a').kind).toBe('created');
    });

    test('own __proto__ response headers are estimated and cloned as ordinary headers', () => {
        const registry = new IdempotencyRegistry();
        const entry = registry.begin('proto-header-clone', canonicalJsonHash({ input: 'same' }));
        expect(entry.kind).toBe('created');
        const headerValues = ['first=one', 'second=two'];
        const headers = Object.create(null);
        Object.defineProperty(headers, '__proto__', {
            value: headerValues,
            enumerable: true,
            configurable: true,
            writable: true,
        });

        expect(idempotencyHeaderStorageBytes(headers)).toBeGreaterThan(0);
        expect(registry.complete(entry.record, entry.record.generation, 'completed', {
            statusCode: 201,
            headers,
            body: Buffer.from('stable'),
        })).toBe(true);
        headerValues[0] = 'mutated';

        expect(Object.getPrototypeOf(entry.record.wireResponse.headers)).toBeNull();
        expect(Object.hasOwn(entry.record.wireResponse.headers, '__proto__')).toBe(true);
        expect(entry.record.wireResponse.headers['__proto__']).toEqual(['first=one', 'second=two']);
        expect(idempotencyResponseStorageBytes(entry.record.wireResponse)).toBeGreaterThan(Buffer.byteLength('stable'));
    });

    test('unknown entries remain tombstoned after their ordinary replay TTL', () => {
        let now = 100;
        const registry = new IdempotencyRegistry({ ttlMs: MIN_IDEMPOTENCY_TTL_MS, now: () => now });
        const entry = registry.begin('unknown-scope', canonicalJsonHash({ input: 'x' }));
        expect(entry.kind).toBe('created');
        registry.markUnknown(entry.record, entry.record.generation);
        now += MIN_IDEMPOTENCY_TTL_MS * 10;
        expect(registry.get('unknown-scope')?.state).toBe('unknown');
        expect(registry.begin('different-scope', canonicalJsonHash({ input: 'y' })).kind).toBe('created');
    });

    test('submitted child sessions stay pinned while their operation is unresolved', () => {
        const registry = new IdempotencyRegistry();
        const entry = registry.begin('unresolved-child', canonicalJsonHash({ input: 'x' }), 'tenant-a');
        expect(entry.kind).toBe('created');
        registry.markSubmitted(entry.record, entry.record.generation, 'child-session', 'user-message');
        expect(registry.hasUnresolvedChildSession('child-session')).toBe(true);

        registry.markUnknown(entry.record, entry.record.generation);
        expect(registry.hasUnresolvedChildSession('child-session')).toBe(true);
        const retry = registry.begin('unresolved-child', canonicalJsonHash({ input: 'x' }), 'tenant-a');
        expect(retry.kind).toBe('existing');
        expect(registry.hasUnresolvedChildSession('child-session')).toBe(true);

        registry.confirmResult(retry.record, retry.record.generation, 'user-message', 'assistant-message');
        expect(registry.complete(retry.record, retry.record.generation, 'completed', {
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from('{"ok":true}'),
        })).toBe(true);
        expect(registry.hasUnresolvedChildSession('child-session')).toBe(false);
    });

    test('registry refuses new live entries at its bound instead of evicting uncertain records', () => {
        const registry = new IdempotencyRegistry({ maxEntries: 1 });
        const first = registry.begin('scope-a', canonicalJsonHash({ a: 1 }));
        expect(first.kind).toBe('created');
        registry.markUnknown(first.record, first.record.generation);
        expect(registry.begin('scope-b', canonicalJsonHash({ b: 2 })).kind).toBe('full');
        expect(registry.get('scope-a')?.state).toBe('unknown');
    });

    test('per-tenant live quota isolates unknown outcomes while the global cap remains available', async () => {
        const { app, registry } = createMiddlewareApp({
            keys: ['tenant-a-secret', 'tenant-b-secret'],
            registryOptions: { maxEntries: 3, maxLiveEntriesPerTenant: 2 },
            route: (req, res) => {
                if (req.headers.authorization === 'Bearer tenant-a-secret') {
                    if (!req.idempotency.reconciling) req.idempotency.markSubmitted(`child-${req.idempotency.publicId}`, `message-${req.idempotency.publicId}`);
                    res.status(503).json({ error: 'still uncertain' });
                    return;
                }
                res.json({ tenant: 'b' });
            },
        });
        const send = (tenant, key) => request(app).post('/v1/responses')
            .set('Authorization', `Bearer ${tenant}`)
            .set('Idempotency-Key', key)
            .send({ input: key });

        expect((await send('tenant-a-secret', 'unknown-one')).statusCode).toBe(503);
        expect((await send('tenant-a-secret', 'unknown-two')).statusCode).toBe(503);
        const quotaFull = await send('tenant-a-secret', 'unknown-three');
        expect(quotaFull.statusCode).toBe(503);
        expect(quotaFull.body.error.code).toBe('idempotency_capacity_exceeded');
        expect(quotaFull.body.error.retryable).toBe(true);

        const tenantB = await send('tenant-b-secret', 'tenant-b-key');
        expect(tenantB.statusCode).toBe(200);
        expect(tenantB.body.tenant).toBe('b');

        const noReprompt = await send('tenant-a-secret', 'unknown-one');
        expect(noReprompt.statusCode).toBe(503);
        expect(noReprompt.body.error).toBe('still uncertain');
        expect(registry.size).toBe(3);
    });

    test('retained quota preserves completed replays until TTL, reserves capacity for other tenants, and frees slots after expiry', async () => {
        let now = 1_000;
        let handlerCalls = 0;
        const { app, registry } = createMiddlewareApp({
            keys: ['tenant-a-secret', 'tenant-b-secret'],
            registryOptions: { maxEntries: 2, ttlMs: MIN_IDEMPOTENCY_TTL_MS, now: () => now },
            route: (_req, res) => {
                handlerCalls += 1;
                res.json({ handlerCalls });
            },
        });
        const send = (tenant, key) => request(app).post('/v1/responses')
            .set('Authorization', `Bearer ${tenant}`)
            .set('Idempotency-Key', key)
            .send({ input: key });
        const tenantAId = `key:${idempotencyDigest('tenant-a-secret')}`;

        const firstA = await send('tenant-a-secret', 'retained-a-one');
        expect(firstA.statusCode).toBe(200);
        expect(registry.getTenantRetainedEntries(tenantAId)).toBe(1);
        const replayA = await send('tenant-a-secret', 'retained-a-one');
        expect(replayA.text).toBe(firstA.text);
        expect(handlerCalls).toBe(1);

        const sameTenantAtQuota = await send('tenant-a-secret', 'retained-a-two');
        expect(sameTenantAtQuota.statusCode).toBe(503);
        expect(sameTenantAtQuota.body.error.code).toBe('idempotency_capacity_exceeded');
        expect(handlerCalls).toBe(1);
        expect(registry.getTenantRetainedEntries(tenantAId)).toBe(1);
        expect(registry.getTenantRetainedResponseBytes(tenantAId)).toBeGreaterThan(Buffer.byteLength(firstA.text));
        expect((await send('tenant-a-secret', 'retained-a-one')).text).toBe(firstA.text);
        expect(handlerCalls).toBe(1);

        const tenantB = await send('tenant-b-secret', 'retained-b-one');
        expect(tenantB.statusCode).toBe(200);
        expect(handlerCalls).toBe(2);
        expect(registry.size).toBe(2);

        now += MIN_IDEMPOTENCY_TTL_MS + 1;
        expect(registry.size).toBe(0);
        const afterExpiry = await send('tenant-a-secret', 'retained-a-one');
        expect(afterExpiry.statusCode).toBe(200);
        expect(afterExpiry.text).not.toBe(firstA.text);
        expect(handlerCalls).toBe(3);
        expect(registry.getTenantRetainedEntries(tenantAId)).toBe(1);
        expect(registry.getTenantRetainedResponseBytes(tenantAId)).toBeGreaterThan(Buffer.byteLength(afterExpiry.text));
        const tenantBAfterExpiry = await send('tenant-b-secret', 'retained-b-after-expiry');
        expect(tenantBAfterExpiry.statusCode).toBe(200);
        expect(handlerCalls).toBe(4);
        expect(registry.size).toBe(2);
    });

    test('maxEntries=2 clamps a tenant to one retained entry and reserves the other slot', () => {
        const registry = new IdempotencyRegistry({ maxEntries: 2 });
        const firstA = registry.begin('small-global-a-one', canonicalJsonHash({ a: 1 }), 'tenant-a');
        expect(firstA.kind).toBe('created');
        expect(registry.complete(firstA.record, firstA.record.generation, 'completed', {
            statusCode: 200,
            headers: {},
            body: Buffer.from('tenant a'),
        })).toBe(true);
        expect(registry.begin('small-global-a-two', canonicalJsonHash({ a: 2 }), 'tenant-a').kind).toBe('full');

        const secondTenant = registry.begin('small-global-b-one', canonicalJsonHash({ b: 1 }), 'tenant-b');
        expect(secondTenant.kind).toBe('created');
        const replay = registry.begin('small-global-a-one', canonicalJsonHash({ a: 1 }), 'tenant-a');
        expect(replay.kind).toBe('existing');
        expect(replay.record).toBe(firstA.record);
        expect(replay.record.wireResponse.body.toString()).toBe('tenant a');
        expect(registry.size).toBe(2);
    });

    test('small global byte limit reserves capacity for another tenant and default budget fits one maximum response', () => {
        const registry = new IdempotencyRegistry({ maxCachedBytes: 10 });
        const tenantA = registry.begin('small-bytes-a', canonicalJsonHash({ a: 1 }), 'tenant-a');
        const tenantB = registry.begin('small-bytes-b', canonicalJsonHash({ b: 1 }), 'tenant-b');
        const tenantC = registry.begin('small-bytes-c', canonicalJsonHash({ c: 1 }), 'tenant-c');
        expect(tenantA.kind).toBe('created');
        expect(tenantB.kind).toBe('created');
        expect(tenantC.kind).toBe('created');

        expect(registry.complete(tenantC.record, tenantC.record.generation, 'completed', {
            statusCode: 200,
            headers: {},
            body: Buffer.alloc(10, 0x63),
        })).toBe(false);
        expect(registry.retainedResponseBytes).toBe(0);

        expect(registry.complete(tenantA.record, tenantA.record.generation, 'completed', {
            statusCode: 200,
            headers: {},
            body: Buffer.alloc(9, 0x61),
        })).toBe(true);
        expect(registry.getTenantRetainedResponseBytes('tenant-a')).toBe(9);
        expect(registry.complete(tenantB.record, tenantB.record.generation, 'completed', {
            statusCode: 200,
            headers: {},
            body: Buffer.alloc(1, 0x62),
        })).toBe(true);
        expect(registry.retainedResponseBytes).toBe(10);
        expect(registry.getTenantRetainedResponseBytes('tenant-b')).toBe(1);
        expect(DEFAULT_IDEMPOTENCY_MAX_CACHED_BYTES_PER_TENANT).toBeGreaterThanOrEqual(
            2 * DEFAULT_IDEMPOTENCY_MAX_RESPONSE_BYTES + 1_024 * 128 + 1024 * 1024,
        );
    });

    test('small global byte limit reserves pending capture capacity for another tenant', () => {
        const registry = new IdempotencyRegistry({ maxCachedBytes: 10 });
        const tenantA = registry.begin('pending-bytes-a', canonicalJsonHash({ a: 1 }), 'tenant-a');
        const tenantB = registry.begin('pending-bytes-b', canonicalJsonHash({ b: 1 }), 'tenant-b');
        expect(tenantA.kind).toBe('created');
        expect(tenantB.kind).toBe('created');

        expect(registry.reserveCaptureBytes(tenantA.record, tenantA.record.generation, 10)).toBe(false);
        expect(registry.reserveCaptureBytes(tenantA.record, tenantA.record.generation, 9)).toBe(true);
        expect(registry.reserveCaptureBytes(tenantB.record, tenantB.record.generation, 2)).toBe(false);
        expect(registry.reserveCaptureBytes(tenantB.record, tenantB.record.generation, 1)).toBe(true);
        expect(registry.pendingResponseBytes).toBe(10);
        expect(registry.getTenantPendingResponseBytes('tenant-a')).toBe(9);
        expect(registry.getTenantPendingResponseBytes('tenant-b')).toBe(1);
    });

    test('retained and pending response bytes are bounded independently per tenant', async () => {
        let handlerCalls = 0;
        const { app, registry } = createMiddlewareApp({
            keys: ['tenant-a-secret', 'tenant-b-secret'],
            registryOptions: {
                maxCachedBytes: 1_000,
                maxCachedBytesPerTenant: 350,
                maxResponseBytes: 200,
            },
            route: (_req, res) => {
                handlerCalls += 1;
                res.status(201).send('x'.repeat(50));
            },
        });
        const send = (tenant, key) => request(app).post('/v1/responses')
            .set('Authorization', `Bearer ${tenant}`)
            .set('Idempotency-Key', key)
            .send({ input: key });
        const tenantAId = `key:${idempotencyDigest('tenant-a-secret')}`;
        const tenantBId = `key:${idempotencyDigest('tenant-b-secret')}`;

        expect((await send('tenant-a-secret', 'bytes-a-one')).statusCode).toBe(201);
        expect(registry.getTenantRetainedResponseBytes(tenantAId)).toBeGreaterThan(50);
        // The response is still delivered, but its temporary assembly buffer
        // would exceed tenant A's retained + pending byte budget, so it is not
        // retained as a replay and the reservation is released.
        expect((await send('tenant-a-secret', 'bytes-a-two')).statusCode).toBe(201);
        const tenantABytes = registry.getTenantRetainedResponseBytes(tenantAId);
        expect(tenantABytes).toBeGreaterThan(50);
        expect(registry.getTenantPendingResponseBytes(tenantAId)).toBe(0);

        expect((await send('tenant-b-secret', 'bytes-b-one')).statusCode).toBe(201);
        const tenantBBytes = registry.getTenantRetainedResponseBytes(tenantBId);
        expect(tenantBBytes).toBeGreaterThan(50);
        expect(registry.retainedResponseBytes).toBe(tenantABytes + tenantBBytes);
        expect(registry.pendingResponseBytes).toBe(0);
        expect(handlerCalls).toBe(3);
    });
});

describe('Idempotency-Key middleware', () => {
    test('SSE scanner handles CRLF boundaries and large data without building event strings', () => {
        const largeData = Buffer.alloc(4 * 1024 * 1024, 0x78);
        const prefix = Buffer.from('event: message\r\ndata: ');
        const separator = Buffer.from('\r\n\r\ndata: {"type":"interaction.completed"}\r\n\r\n');
        const body = Buffer.concat([prefix, largeData, separator]);
        const ranges = scanSseDataEventRanges(body);

        expect(ranges.previous).toEqual({ start: prefix.byteLength - 1, end: prefix.byteLength + largeData.byteLength });
        expect(ranges.latest).not.toBeNull();
        expect(body.toString('utf8', ranges.latest.start, ranges.latest.end).trim()).toBe('{"type":"interaction.completed"}');
    });

    test('replays completed JSON with status, headers, and body; canonical key order replays and payload mismatch returns 409', async () => {
        let handlerCalls = 0;
        const { app } = createMiddlewareApp({ route: (req, res) => {
            handlerCalls += 1;
            res.set('X-Origin', 'first').status(201).json({ handlerCalls });
        } });
        const first = await request(app).post('/v1/responses').set('Idempotency-Key', 'json-key')
            .send({ payload: { z: 1, a: 2 }, input: 'hello' });
        const replayed = await request(app).post('/v1/responses').set('Idempotency-Key', 'json-key')
            .send({ input: 'hello', payload: { a: 2, z: 1 } });
        expect(replayed.statusCode).toBe(201);
        expect(replayed.text).toBe(first.text);
        expect(replayed.headers['x-origin']).toBe('first');
        expect(handlerCalls).toBe(1);

        const conflict = await request(app).post('/v1/responses').set('Idempotency-Key', 'json-key')
            .send({ input: 'different' });
        expect(conflict.statusCode).toBe(409);
        expect(conflict.body.error.code).toBe('idempotency_key_reused');
        expect(handlerCalls).toBe(1);
    });

    test('rejects an overflowed JSON number rather than replaying it as null', async () => {
        let handlerCalls = 0;
        const { app } = createMiddlewareApp({ route: (_req, res) => {
            handlerCalls += 1;
            res.json({ ok: true });
        } });

        const overflow = await request(app).post('/v1/responses')
            .set('Idempotency-Key', 'overflow-number')
            .set('Content-Type', 'application/json')
            .send('{"max_output_tokens":1e400}');

        expect(overflow.statusCode).toBe(400);
        expect(overflow.body.error.code).toBe('invalid_idempotency_payload');
        expect(handlerCalls).toBe(0);
    });

    test('case-insensitive Express paths share replay and conflict scopes', async () => {
        let handlerCalls = 0;
        const { app } = createMiddlewareApp({ route: (_req, res) => {
            handlerCalls += 1;
            res.json({ handlerCalls });
        } });
        const first = await request(app).post('/v1/responses').set('Idempotency-Key', 'case-key')
            .send({ input: 'same' });
        const replayed = await request(app).post('/V1/RESPONSES').set('Idempotency-Key', 'case-key')
            .send({ input: 'same' });
        expect(replayed.statusCode).toBe(200);
        expect(replayed.text).toBe(first.text);
        expect(handlerCalls).toBe(1);

        const conflict = await request(app).post('/V1/RESPONSES').set('Idempotency-Key', 'case-key')
            .send({ input: 'different' });
        expect(conflict.statusCode).toBe(409);
        expect(conflict.body.error.code).toBe('idempotency_key_reused');
        expect(handlerCalls).toBe(1);
    });

    test('authenticated tenants and parent IDs are scoped; interaction aliases share one endpoint scope', async () => {
        let handlerCalls = 0;
        const { app } = createMiddlewareApp({ keys: ['tenant-a-secret', 'tenant-b-secret'], route: (_req, res) => {
            handlerCalls += 1;
            res.json({ call: handlerCalls });
        } });
        const payload = { input: 'same' };
        const call = (path, tenant, body = payload) => request(app).post(path)
            .set('Authorization', `Bearer ${tenant}`)
            .set('Idempotency-Key', 'shared-key')
            .send(body);

        const tenantA = await call('/v1beta/interactions', 'tenant-a-secret');
        const tenantAReplay = await call('/v1beta/interactions', 'tenant-a-secret');
        const tenantB = await call('/v1beta/interactions', 'tenant-b-secret');
        const alias = await call('/v1/interactions', 'tenant-a-secret');
        const responses = await call('/v1/responses', 'tenant-a-secret');
        const parentOne = await call('/v1beta/interactions', 'tenant-a-secret', { ...payload, previous_interaction_id: 'parent-one' });
        const parentTwo = await call('/v1beta/interactions', 'tenant-a-secret', { ...payload, previous_interaction_id: 'parent-two' });

        expect(tenantAReplay.text).toBe(tenantA.text);
        expect(tenantB.body.call).toBe(2);
        expect(alias.text).toBe(tenantA.text);
        expect(responses.body.call).toBe(3);
        expect(parentOne.body.call).toBe(4);
        expect(parentTwo.body.call).toBe(5);
        expect(handlerCalls).toBe(5);
    });

    test('in-progress duplicates return retryable 409 without entering the route', async () => {
        let handlerCalls = 0;
        let release;
        let signalStarted;
        const pending = new Promise((resolve) => { release = resolve; });
        const started = new Promise((resolve) => { signalStarted = resolve; });
        const { app } = createMiddlewareApp({ route: async (_req, res) => {
            handlerCalls += 1;
            signalStarted();
            await pending;
            res.json({ ok: true });
        } });
        const firstPromise = request(app).post('/v1/responses').set('Idempotency-Key', 'busy')
            .send({ input: 'wait' }).then((response) => response);
        await started;
        const duplicate = await request(app).post('/v1/responses').set('Idempotency-Key', 'busy').send({ input: 'wait' });
        expect(duplicate.statusCode).toBe(409);
        expect(duplicate.body.error.code).toBe('idempotency_in_progress');
        expect(duplicate.body.error.retryable).toBe(true);
        expect(handlerCalls).toBe(1);
        release();
        expect((await firstPromise).statusCode).toBe(200);
    });

    test('definite pre-submission failures replay the original error response', async () => {
        let handlerCalls = 0;
        const { app } = createMiddlewareApp({ route: (_req, res) => {
            handlerCalls += 1;
            res.set('X-Failure', 'stable').status(422).json({ error: 'invalid input' });
        } });
        const first = await request(app).post('/v1/responses').set('Idempotency-Key', 'failed').send({ input: 'bad' });
        const replayed = await request(app).post('/v1/responses').set('Idempotency-Key', 'failed').send({ input: 'bad' });
        expect(replayed.statusCode).toBe(422);
        expect(replayed.text).toBe(first.text);
        expect(replayed.headers['x-failure']).toBe('stable');
        expect(handlerCalls).toBe(1);
    });

    test('unknown requests never re-submit and reconcile only the recorded child/message', async () => {
        let handlerCalls = 0;
        const observed = [];
        const { app } = createMiddlewareApp({ route: (req, res) => {
            handlerCalls += 1;
            const control = req.idempotency;
            observed.push({
                reconciling: control.reconciling,
                child: control.childSessionId,
                message: control.userMessageId,
                publicId: control.publicId,
            });
            if (handlerCalls === 1) {
                control.markSubmitted('child-stable', 'message-stable', 'opencode/kimi-k2.5');
                control.setPublicId('public-id-exposed-before-disconnect');
                res.status(503).json({ error: 'upstream timed out' });
                return;
            }
            if (handlerCalls === 2) {
                res.status(503).json({ error: 'not yet confirmed' });
                return;
            }
            control.confirmResult('message-stable', 'assistant-stable');
            res.json({ id: control.publicId, answer: 'reconciled' });
        } });
        const send = () => request(app).post('/v1/responses').set('Idempotency-Key', 'unknown')
            .send({ input: 'same' });
        expect((await send()).statusCode).toBe(503);
        const unsuccessful = await send();
        expect(unsuccessful.statusCode).toBe(503);
        expect(unsuccessful.body.error).toBe('not yet confirmed');
        const completed = await send();
        expect(completed.statusCode).toBe(200);
        expect(completed.body.id).toBe('public-id-exposed-before-disconnect');
        expect((await send()).text).toBe(completed.text);
        expect(observed).toEqual([
            { reconciling: false, child: null, message: null, publicId: null },
            { reconciling: true, child: 'child-stable', message: 'message-stable', publicId: 'public-id-exposed-before-disconnect' },
            { reconciling: true, child: 'child-stable', message: 'message-stable', publicId: 'public-id-exposed-before-disconnect' },
        ]);
        expect(handlerCalls).toBe(3);
    });

    test.each([
        ['JSON', '/v1/responses'],
        ['SSE', '/v1beta/interactions'],
    ])('submitted unconfirmed %s 2xx responses stay unknown rather than being cached as completed', async (_label, path) => {
        let handlerCalls = 0;
        const { app, registry } = createMiddlewareApp({ route: (req, res) => {
            handlerCalls += 1;
            if (req.idempotency.reconciling) {
                res.status(503).json({ error: { code: 'idempotency_reconciliation_pending' } });
                return;
            }
            req.idempotency.markSubmitted('unconfirmed-child', 'unconfirmed-user');
            if (path === '/v1/responses') {
                res.status(200).json({ answer: 'unconfirmed' });
                return;
            }
            res.status(200).type('text/event-stream');
            res.write('data: {"type":"interaction.completed","interaction":{"status":"completed"}}\n\n');
            res.end();
        } });
        const send = () => request(app).post(path).set('Idempotency-Key', `unconfirmed-${_label}`)
            .send({ input: 'same' });

        const first = await send();
        expect(first.statusCode).toBe(200);
        expect(registry.size).toBe(1);
        const pending = await send();
        expect(pending.statusCode).toBe(503);
        expect(pending.body.error.code).toBe('idempotency_reconciliation_pending');
        expect(handlerCalls).toBe(2);
    });

    test('Set-Cookie header arrays are copied at finish and replay their original values', async () => {
        let handlerCalls = 0;
        const cookies = ['first=one; Path=/', 'second=two; Path=/'];
        const { app, registry } = createMiddlewareApp({ route: (_req, res) => {
            handlerCalls += 1;
            res.setHeader('Set-Cookie', cookies);
            res.once('finish', () => {
                cookies[0] = 'mutated=after-finish; Path=/';
                cookies.push('late=mutation; Path=/');
            });
            res.status(201).send('stable body');
        } });
        const send = () => request(app).post('/v1/responses').set('Idempotency-Key', 'mutable-set-cookie')
            .send({ input: 'same' });

        const first = await send();
        const scopeId = idempotencyDigest(JSON.stringify([
            'anonymous',
            '/v1/responses',
            '',
            idempotencyDigest('mutable-set-cookie'),
        ]));
        const record = registry.get(scopeId);
        const replayed = await send();
        expect(first.statusCode).toBe(201);
        expect(record.wireResponse.headers['set-cookie']).toEqual(['first=one; Path=/', 'second=two; Path=/']);
        expect(replayed.headers['set-cookie']).toEqual(['first=one; Path=/', 'second=two; Path=/']);
        expect(handlerCalls).toBe(1);
    });

    test('__proto__ response header arrays survive capture and replay', async () => {
        let handlerCalls = 0;
        const { app, registry } = createMiddlewareApp({ route: (_req, res) => {
            handlerCalls += 1;
            res.setHeader('__proto__', ['first=one', 'second=two']);
            res.status(201).send('stable body');
        } });
        const send = () => request(app).post('/v1/responses').set('Idempotency-Key', 'proto-header-replay')
            .send({ input: 'same' });
        const rawValues = (response) => {
            const result = [];
            const rawHeaders = response.res.rawHeaders;
            for (let index = 0; index < rawHeaders.length; index += 2) {
                if (rawHeaders[index].toLowerCase() === '__proto__') result.push(rawHeaders[index + 1]);
            }
            return result;
        };

        const first = await send();
        const scopeId = idempotencyDigest(JSON.stringify([
            'anonymous',
            '/v1/responses',
            '',
            idempotencyDigest('proto-header-replay'),
        ]));
        const record = registry.get(scopeId);
        const replayed = await send();

        expect(first.statusCode).toBe(201);
        expect(rawValues(first)).toEqual(['first=one', 'second=two']);
        expect(Object.hasOwn(record.wireResponse.headers, '__proto__')).toBe(true);
        expect(record.wireResponse.headers['__proto__']).toEqual(['first=one', 'second=two']);
        expect(rawValues(replayed)).toEqual(['first=one', 'second=two']);
        expect(replayed.text).toBe(first.text);
        expect(handlerCalls).toBe(1);
    });

    test('a tiny body with a huge response header is delivered but not retained past the cache budget', async () => {
        let handlerCalls = 0;
        const { app, registry } = createMiddlewareApp({
            registryOptions: { maxCachedBytes: 1_024 },
            route: (_req, res) => {
                handlerCalls += 1;
                res.setHeader('X-Huge', 'h'.repeat(2_048));
                res.status(201).send('x');
            },
        });
        const send = () => request(app).post('/v1/responses').set('Idempotency-Key', 'huge-header-budget')
            .send({ input: 'same' });

        expect((await send()).statusCode).toBe(201);
        expect(registry.size).toBe(0);
        expect(registry.retainedResponseBytes).toBe(0);
        expect(registry.pendingResponseBytes).toBe(0);
        expect((await send()).statusCode).toBe(201);
        expect(handlerCalls).toBe(2);
    });

    test('an oversized __proto__ header array cannot evade capture accounting', async () => {
        let handlerCalls = 0;
        const headerValues = ['a'.repeat(1_024), 'b'.repeat(1_024)];
        const { app, registry } = createMiddlewareApp({
            registryOptions: { maxCachedBytes: 1_024 },
            route: (_req, res) => {
                handlerCalls += 1;
                res.setHeader('__proto__', headerValues);
                res.status(201).send('x');
            },
        });
        const send = () => request(app).post('/v1/responses').set('Idempotency-Key', 'proto-header-budget')
            .send({ input: 'same' });
        const rawValues = (response) => {
            const result = [];
            const rawHeaders = response.res.rawHeaders;
            for (let index = 0; index < rawHeaders.length; index += 2) {
                if (rawHeaders[index].toLowerCase() === '__proto__') result.push(rawHeaders[index + 1]);
            }
            return result;
        };

        const first = await send();
        expect(first.statusCode).toBe(201);
        expect(rawValues(first)).toEqual(headerValues);
        expect(registry.size).toBe(0);
        expect(registry.retainedResponseBytes).toBe(0);
        expect(registry.pendingResponseBytes).toBe(0);
        expect((await send()).statusCode).toBe(201);
        expect(handlerCalls).toBe(2);
    });

    test('SSE completed replay preserves the exact event bytes and relevant headers', async () => {
        let handlerCalls = 0;
        const { app } = createMiddlewareApp({ route: (_req, res) => {
            handlerCalls += 1;
            res.status(200).set('Content-Type', 'text/event-stream').set('X-Stream', 'stable');
            res.write('data: {"type":"interaction.created"}\n\n');
            res.write('data: {"type":"interaction.completed","interaction":{"id":"one"}}\n\n');
            res.end();
        } });
        const first = await request(app).post('/v1beta/interactions').set('Idempotency-Key', 'stream-key').send({ input: 'hello' });
        const replayed = await request(app).post('/v1beta/interactions').set('Idempotency-Key', 'stream-key').send({ input: 'hello' });
        expect(replayed.statusCode).toBe(200);
        expect(replayed.text).toBe(first.text);
        expect(replayed.headers['content-type']).toContain('text/event-stream');
        expect(replayed.headers['x-stream']).toBe('stable');
        expect(handlerCalls).toBe(1);
    });

    test('confirmed terminal Interactions SSE failures are retained as failed and replay byte-for-byte', async () => {
        let handlerCalls = 0;
        const key = 'confirmed-error-stream';
        const { app, registry } = createMiddlewareApp({ route: (req, res) => {
            handlerCalls += 1;
            const control = req.idempotency;
            if (!control.reconciling) control.markSubmitted('error-child', 'error-user-message');
            else control.confirmResult('error-user-message', 'error-assistant-message');
            res.status(200).set('Content-Type', 'text/event-stream');
            res.write('data: {"type":"interaction.created","interaction":{"id":"intr-error"}}\n\n');
            res.write('data: {"type":"error","error":{"message":"terminal failure"}}\n\n');
            res.end();
        } });
        const scopeId = idempotencyDigest(JSON.stringify([
            'anonymous',
            '/v1/interactions',
            '',
            idempotencyDigest(key),
        ]));
        const send = () => request(app).post('/v1beta/interactions').set('Idempotency-Key', key)
            .send({ input: 'hello' });

        const uncertain = await send();
        expect(registry.get(scopeId)?.state).toBe('unknown');
        const failed = await send();
        expect(failed.statusCode).toBe(200);
        expect(failed.headers['content-type']).toContain('text/event-stream');
        expect(registry.get(scopeId)?.state).toBe('failed');
        expect(registry.get(scopeId)?.wireResponse?.body.toString()).toBe(failed.text);
        const replayed = await send();
        expect(replayed.text).toBe(failed.text);
        expect(uncertain.statusCode).toBe(200);
        expect(handlerCalls).toBe(2);
    });

    test('a disconnected partial stream becomes unknown and retries do not launch another run', async () => {
        let handlerCalls = 0;
        const { app } = createMiddlewareApp({ route: (req, res) => {
            handlerCalls += 1;
            if (!req.idempotency.reconciling) {
                req.idempotency.markSubmitted('stream-child', 'stream-message');
                res.set('Content-Type', 'text/event-stream');
                res.write('data: {"type":"response.created"}\n\n');
                res.socket.destroy();
                return;
            }
            res.status(503).json({ error: { code: 'idempotency_reconciliation_pending' } });
        } });
        await request(app).post('/v1/responses').set('Idempotency-Key', 'disconnected-stream')
            .send({ input: 'partial' }).then(() => null, () => null);

        const retry = await request(app).post('/v1/responses').set('Idempotency-Key', 'disconnected-stream')
            .send({ input: 'partial' });
        expect(retry.statusCode).toBe(503);
        expect(retry.body.error.code).toBe('idempotency_reconciliation_pending');
        expect(handlerCalls).toBe(2);
    });

    test('pre-submit disconnect abandons its record and delayed continuation cannot prompt', async () => {
        let handlerCalls = 0;
        let promptCalls = 0;
        let refusedDelayedPrompt = false;
        let signalStarted;
        let signalClosed;
        let signalContinued;
        let resumeDelayedRoute;
        const started = new Promise((resolve) => { signalStarted = resolve; });
        const closed = new Promise((resolve) => { signalClosed = resolve; });
        const continued = new Promise((resolve) => { signalContinued = resolve; });
        const delayedRoute = new Promise((resolve) => { resumeDelayedRoute = resolve; });
        const { app } = createMiddlewareApp({ route: async (req, res) => {
            handlerCalls += 1;
            if (handlerCalls === 1) {
                res.once('close', signalClosed);
                signalStarted();
                await delayedRoute;
                try {
                    req.idempotency.markSubmitted('abandoned-child', 'abandoned-message');
                    promptCalls += 1;
                } catch {
                    refusedDelayedPrompt = true;
                }
                signalContinued();
                return;
            }
            req.idempotency.markSubmitted('fresh-child', 'fresh-message');
            promptCalls += 1;
            res.json({ promptCalls });
        } });

        const aborted = await startAbortedRequest(app, '/v1/responses', 'pre-submit-close', { input: 'same' });
        await started;
        aborted.abort();
        await closed;
        resumeDelayedRoute();
        await continued;

        expect(refusedDelayedPrompt).toBe(true);
        expect(promptCalls).toBe(0);
        const fresh = await request(app).post('/v1/responses').set('Idempotency-Key', 'pre-submit-close')
            .send({ input: 'same' });
        expect(fresh.statusCode).toBe(200);
        expect(fresh.body.promptCalls).toBe(1);
        expect(handlerCalls).toBe(2);
        expect(promptCalls).toBe(1);
        await aborted.closeServer();
    });

    test('submitted disconnect remains unknown and cannot submit again', async () => {
        let handlerCalls = 0;
        let promptCalls = 0;
        let signalStarted;
        let signalClosed;
        const started = new Promise((resolve) => { signalStarted = resolve; });
        const closed = new Promise((resolve) => { signalClosed = resolve; });
        const { app } = createMiddlewareApp({ route: async (req, res) => {
            handlerCalls += 1;
            if (req.idempotency.reconciling) {
                res.status(503).json({ error: { code: 'idempotency_reconciliation_pending' } });
                return;
            }
            req.idempotency.markSubmitted('submitted-child', 'submitted-message');
            promptCalls += 1;
            res.once('close', signalClosed);
            signalStarted();
            await new Promise((resolve) => res.once('close', resolve));
        } });

        const aborted = await startAbortedRequest(app, '/v1/responses', 'submitted-close', { input: 'same' });
        await started;
        aborted.abort();
        await closed;

        const retry = await request(app).post('/v1/responses').set('Idempotency-Key', 'submitted-close')
            .send({ input: 'same' });
        expect(retry.statusCode).toBe(503);
        expect(retry.body.error.code).toBe('idempotency_reconciliation_pending');
        expect(handlerCalls).toBe(2);
        expect(promptCalls).toBe(1);
        await aborted.closeServer();
    });

    test('a disconnected original lease cannot mutate or prompt after reconciliation is claimed', async () => {
        let handlerCalls = 0;
        let promptCalls = 0;
        let signalOriginalStarted;
        let signalOriginalClosed;
        let signalRetryClaimed;
        let signalOriginalContinued;
        let resumeOriginal;
        let finishRetry;
        const originalStarted = new Promise((resolve) => { signalOriginalStarted = resolve; });
        const originalClosed = new Promise((resolve) => { signalOriginalClosed = resolve; });
        const retryClaimed = new Promise((resolve) => { signalRetryClaimed = resolve; });
        const originalContinued = new Promise((resolve) => { signalOriginalContinued = resolve; });
        const originalGate = new Promise((resolve) => { resumeOriginal = resolve; });
        const retryGate = new Promise((resolve) => { finishRetry = resolve; });
        let staleMutationRejected = false;
        const { app } = createMiddlewareApp({ route: async (req, res) => {
            handlerCalls += 1;
            const control = req.idempotency;
            if (handlerCalls === 1) {
                control.markSubmitted('leased-child', 'leased-message');
                promptCalls += 1;
                res.once('close', signalOriginalClosed);
                signalOriginalStarted();
                await originalGate;
                try {
                    control.setPublicId('stale-public-id');
                } catch {
                    staleMutationRejected = true;
                }
                try {
                    control.markSubmitted('stale-child', 'stale-message');
                    promptCalls += 1;
                } catch {
                    staleMutationRejected = true;
                }
                signalOriginalContinued();
                return;
            }
            expect(control.reconciling).toBe(true);
            expect(control.publicId).toBeNull();
            signalRetryClaimed();
            await retryGate;
            res.json({ answer: 'reconciled' });
        } });

        const aborted = await startAbortedRequest(app, '/v1/responses', 'lease-race', { input: 'same' });
        await originalStarted;
        aborted.abort();
        await originalClosed;
        const retryPromise = request(app).post('/v1/responses').set('Idempotency-Key', 'lease-race')
            .send({ input: 'same' }).then((response) => response);
        await retryClaimed;
        resumeOriginal();
        await originalContinued;
        expect(staleMutationRejected).toBe(true);
        expect(promptCalls).toBe(1);
        finishRetry();
        expect((await retryPromise).statusCode).toBe(200);
        expect(handlerCalls).toBe(2);
        expect(promptCalls).toBe(1);
        await aborted.closeServer();
    });

    test('writes after close neither reserve capture bytes nor change the unknown lease', async () => {
        let signalLateWrites;
        const lateWrites = new Promise((resolve) => { signalLateWrites = resolve; });
        let handlerCalls = 0;
        let pendingAfterLateWrites = -1;
        const { app, registry } = createMiddlewareApp({ route: (req, res) => {
            handlerCalls += 1;
            if (req.idempotency.reconciling) {
                res.status(503).json({ error: 'still unknown' });
                return;
            }
            req.idempotency.markSubmitted('late-write-child', 'late-write-message');
            res.once('close', () => {
                try { res.write('late write'); } catch {}
                try { res.end('late end'); } catch {}
                // A late finish signal must not assemble chunks retained by
                // the closed response closure.
                res.emit('finish');
                pendingAfterLateWrites = registry.pendingResponseBytes;
                signalLateWrites();
            });
            res.write('partial');
            res.socket.destroy();
        } });
        const assemblyRequests = [];
        const reserveAssemblyBytes = registry.reserveAssemblyBytes.bind(registry);
        registry.reserveAssemblyBytes = (record, generation, bytes) => {
            assemblyRequests.push(bytes);
            return reserveAssemblyBytes(record, generation, bytes);
        };

        const aborted = await startAbortedRequest(app, '/v1/responses', 'late-capture', { input: 'same' });
        await lateWrites;
        expect(pendingAfterLateWrites).toBe(0);
        expect(assemblyRequests).toEqual([0]);
        expect(registry.pendingResponseBytes).toBe(0);
        expect(registry.getTenantPendingResponseBytes('anonymous')).toBe(0);
        const retry = await request(app).post('/v1/responses').set('Idempotency-Key', 'late-capture')
            .send({ input: 'same' });
        expect(retry.statusCode).toBe(503);
        expect(handlerCalls).toBe(2);
        await aborted.closeServer();
    });

    test('many tiny response writes hit the chunk bound and cannot be cached as a replay', async () => {
        let handlerCalls = 0;
        let promptCalls = 0;
        let reconciled = false;
        const { app, registry } = createMiddlewareApp({ route: (req, res) => {
            handlerCalls += 1;
            if (!req.idempotency.reconciling) {
                promptCalls += 1;
                req.idempotency.markSubmitted('many-chunks-child', 'many-chunks-message');
                for (let index = 0; index < 1_100; index += 1) res.write('x');
                res.end();
                return;
            }
            reconciled = req.idempotency.reconciling;
            res.status(503).json({ error: 'reconciliation pending' });
        } });

        const send = () => request(app).post('/v1/responses').set('Idempotency-Key', 'many-tiny-chunks').send({ input: 'same' });
        expect((await send()).statusCode).toBe(200);
        expect(registry.pendingResponseBytes).toBe(0);

        const retry = await send();
        expect(retry.statusCode).toBe(503);
        expect(retry.body.error).toBe('reconciliation pending');
        expect(handlerCalls).toBe(2);
        expect(promptCalls).toBe(1);
        expect(reconciled).toBe(true);
    });

    test('one-byte chunks charge conservative object overhead and balance pending accounting on overflow', async () => {
        let handlerCalls = 0;
        const { app, registry } = createMiddlewareApp({
            registryOptions: {
                maxCachedBytes: 1_024,
                maxCachedBytesPerTenant: 1_024,
                maxResponseBytes: 4_096,
            },
            route: (req, res) => {
                handlerCalls += 1;
                if (req.idempotency.reconciling) {
                    res.status(503).json({ error: 'reconciliation pending' });
                    return;
                }
                req.idempotency.markSubmitted('tiny-chunk-child', 'tiny-chunk-message');
                for (let index = 0; index < 100; index += 1) res.write('x');
                res.end();
            },
        });
        const reservations = [];
        const reserveCaptureBytes = registry.reserveCaptureBytes.bind(registry);
        registry.reserveCaptureBytes = (record, generation, bytes, overhead) => {
            const accepted = reserveCaptureBytes(record, generation, bytes, overhead);
            reservations.push({ bytes, overhead, accepted, pending: registry.pendingResponseBytes });
            return accepted;
        };
        const send = () => request(app).post('/v1/responses').set('Idempotency-Key', 'tiny-byte-budget')
            .send({ input: 'same' });

        expect((await send()).statusCode).toBe(200);
        expect(reservations[0]).toMatchObject({ bytes: 1, overhead: 128, accepted: true, pending: 129 });
        expect(reservations.filter(({ accepted }) => accepted)).toHaveLength(7);
        expect(reservations.find(({ accepted }) => !accepted)).toMatchObject({ bytes: 1, overhead: 128, pending: 903 });
        expect(registry.pendingResponseBytes).toBe(0);
        expect(registry.getTenantPendingResponseBytes('anonymous')).toBe(0);
        expect(registry.retainedResponseBytes).toBe(0);
        expect(registry.getTenantRetainedResponseBytes('anonymous')).toBe(0);

        const retry = await send();
        expect(retry.statusCode).toBe(503);
        expect(handlerCalls).toBe(2);
        expect(registry.pendingResponseBytes).toBe(0);
        expect(registry.getTenantPendingResponseBytes('anonymous')).toBe(0);
    });

    test.each([
        ['Responses', '/v1/responses', 'finish-tool', { finish: 'tool', parts: [] }],
        ['Responses', '/v1/responses', 'active-tool', {
            finish: 'stop',
            parts: [{ type: 'tool', id: 'active-call', tool: 'websearch', state: { status: 'running' } }],
        }],
        ['Responses', '/v1/responses', 'incomplete-no-finish', { parts: [] }],
        ['Interactions', '/v1beta/interactions', 'finish-tool-interaction', { finish: 'tool', parts: [] }],
        ['Interactions', '/v1beta/interactions', 'active-tool-interaction', {
            finish: 'stop',
            parts: [{ type: 'tool', id: 'active-call', tool: 'websearch', state: { status: 'pending' } }],
        }],
        ['Interactions', '/v1beta/interactions', 'incomplete-no-finish-interaction', { parts: [] }],
    ])('%s reconciliation keeps an assistant error pending while the exact-parent turn is incomplete (%s)', async (_name, path, key, snapshot) => {
        const app = createRouteApp({ REQUEST_TIMEOUT_MS: 100 }).app;
        sdkMocks.sessionPrompt.mockImplementationOnce(async (args) => {
            promptBySession.set(args.path.id, structuredClone(args));
            throw Object.assign(new Error('upstream timed out after submit'), { statusCode: 503 });
        });
        const payload = { model: 'opencode/kimi-k2.5', input: 'uncertain tool turn' };
        const first = await request(app).post(path).set('Idempotency-Key', key).send(payload);
        expect(first.statusCode).toBeGreaterThanOrEqual(400);
        const promptCallsAfterInitialRequest = sdkMocks.sessionPrompt.mock.calls.length;
        const sessionCreatesAfterInitialRequest = sdkMocks.sessionCreate.mock.calls.length;

        sdkMocks.sessionMessages.mockImplementation(async ({ path: sessionPath }) => {
            const prompt = promptBySession.get(sessionPath.id);
            return [{
                info: {
                    id: `assistant-awaiting-tool-${sessionPath.id}`,
                    role: 'assistant',
                    parentID: prompt?.body?.messageID,
                    sessionID: sessionPath.id,
                    finish: snapshot.finish,
                    error: { name: 'ProviderError', message: 'tool turn still active' },
                },
                parts: snapshot.parts,
            }];
        });
        sdkMocks.sessionMessages.mockClear();

        const retry = () => request(app).post(path).set('Idempotency-Key', key).send(payload);
        const pendingOne = await retry();
        const pendingTwo = await retry();
        expect(pendingOne.statusCode).toBe(503);
        expect(pendingOne.body.error.code).toBe('idempotency_reconciliation_pending');
        expect(pendingTwo.statusCode).toBe(503);
        expect(pendingTwo.body.error.code).toBe('idempotency_reconciliation_pending');
        expect(sdkMocks.sessionMessages).toHaveBeenCalled();
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(promptCallsAfterInitialRequest);
        expect(sdkMocks.sessionCreate).toHaveBeenCalledTimes(sessionCreatesAfterInitialRequest);
    });

    test('capture accounting includes the temporary assembly buffer and retains the exact body', async () => {
        const { app, registry } = createMiddlewareApp({
            registryOptions: { maxCachedBytes: 1_000, maxCachedBytesPerTenant: 1_000, maxResponseBytes: 11 },
            route: (_req, res) => res.status(201).send('01234567890'),
        });
        const reservationPeaks = [];
        const reserveCaptureBytes = registry.reserveCaptureBytes.bind(registry);
        const reserveAssemblyBytes = registry.reserveAssemblyBytes.bind(registry);
        registry.reserveCaptureBytes = (...args) => {
            const accepted = reserveCaptureBytes(...args);
            reservationPeaks.push(registry.pendingResponseBytes);
            return accepted;
        };
        registry.reserveAssemblyBytes = (...args) => {
            const accepted = reserveAssemblyBytes(...args);
            reservationPeaks.push(registry.pendingResponseBytes);
            return accepted;
        };

        const first = await request(app).post('/v1/responses').set('Idempotency-Key', 'assembly-budget')
            .send({ input: 'same' });
        const replayed = await request(app).post('/v1/responses').set('Idempotency-Key', 'assembly-budget')
            .send({ input: 'same' });
        expect(first.statusCode).toBe(201);
        expect(first.text).toBe('01234567890');
        expect(replayed.text).toBe(first.text);
        expect(reservationPeaks.slice(0, 2)).toEqual([139, 150]);
        expect(registry.pendingResponseBytes).toBe(0);
        expect(registry.getTenantPendingResponseBytes('anonymous')).toBe(0);
        expect(registry.retainedResponseBytes).toBeGreaterThan(11);
        expect(registry.getTenantRetainedResponseBytes('anonymous')).toBe(registry.retainedResponseBytes);
    });

    test('capture overhead across multiple chunks releases exactly through assembly and completion', async () => {
        const { app, registry } = createMiddlewareApp({
            registryOptions: { maxCachedBytes: 5_000, maxResponseBytes: 100 },
            route: (_req, res) => {
                res.status(201);
                for (let index = 0; index < 12; index += 1) res.write('x');
                res.end();
            },
        });
        const capturePeaks = [];
        const assemblyPeaks = [];
        const reserveCaptureBytes = registry.reserveCaptureBytes.bind(registry);
        const reserveAssemblyBytes = registry.reserveAssemblyBytes.bind(registry);
        registry.reserveCaptureBytes = (...args) => {
            const accepted = reserveCaptureBytes(...args);
            capturePeaks.push(registry.pendingResponseBytes);
            return accepted;
        };
        registry.reserveAssemblyBytes = (...args) => {
            const accepted = reserveAssemblyBytes(...args);
            assemblyPeaks.push(registry.pendingResponseBytes);
            return accepted;
        };

        const response = await request(app).post('/v1/responses').set('Idempotency-Key', 'multi-chunk-overhead')
            .send({ input: 'same' });
        expect(response.statusCode).toBe(201);
        expect(response.text).toBe('x'.repeat(12));
        expect(capturePeaks).toEqual(Array.from({ length: 12 }, (_, index) => (index + 1) * 129));
        expect(assemblyPeaks).toHaveLength(2);
        expect(assemblyPeaks[0]).toBe(12 * 129 + 12);
        expect(assemblyPeaks[1]).toBeGreaterThan(0);
        expect(registry.pendingResponseBytes).toBe(0);
        expect(registry.getTenantPendingResponseBytes('anonymous')).toBe(0);
        expect(registry.retainedResponseBytes).toBeGreaterThan(12);
        expect(registry.getTenantRetainedResponseBytes('anonymous')).toBe(registry.retainedResponseBytes);
    });

    test('pre-submit capture overflow abandons the key so a retry starts fresh', async () => {
        let handlerCalls = 0;
        const reconcilingStates = [];
        const { app, registry } = createMiddlewareApp({
            registryOptions: { maxCachedBytes: 0 },
            route: (req, res) => {
                handlerCalls += 1;
                reconcilingStates.push(req.idempotency.reconciling);
                if (handlerCalls === 1) {
                    res.status(422).json({ error: 'cannot capture this before submit' });
                    return;
                }
                res.status(204).end();
            },
        });
        const send = () => request(app).post('/v1/responses').set('Idempotency-Key', 'pre-submit-overflow')
            .send({ input: 'same' });
        expect((await send()).statusCode).toBe(422);
        expect(registry.pendingResponseBytes).toBe(0);
        expect(registry.getTenantPendingResponseBytes('anonymous')).toBe(0);
        expect((await send()).statusCode).toBe(204);
        expect(handlerCalls).toBe(2);
        expect(reconcilingStates).toEqual([false, false]);
    });

    test('submitted oversized responses remain unknown and cannot prompt again', async () => {
        let handlerCalls = 0;
        let promptCalls = 0;
        const reconcilingStates = [];
        const { app } = createMiddlewareApp({
            registryOptions: { maxCachedBytes: 128, maxResponseBytes: 4 },
            route: (req, res) => {
                handlerCalls += 1;
                reconcilingStates.push(req.idempotency.reconciling);
                if (req.idempotency.reconciling) {
                    res.status(503).json({ error: 'reconciliation required' });
                    return;
                }
                req.idempotency.markSubmitted('oversized-child', 'oversized-message');
                promptCalls += 1;
                res.json({ answer: 'too large to capture' });
            },
        });
        const send = () => request(app).post('/v1/responses').set('Idempotency-Key', 'submitted-overflow')
            .send({ input: 'same' });
        expect((await send()).statusCode).toBe(200);
        expect((await send()).statusCode).toBe(503);
        expect(handlerCalls).toBe(2);
        expect(promptCalls).toBe(1);
        expect(reconcilingStates).toEqual([false, true]);
    });

    test('empty and oversized Idempotency-Key values are rejected safely', async () => {
        let handlerCalls = 0;
        const { app } = createMiddlewareApp({ route: (_req, res) => {
            handlerCalls += 1;
            res.json({ ok: true });
        } });
        const empty = await request(app).post('/v1/responses').set('Idempotency-Key', '   ').send({ input: 'x' });
        const oversized = await request(app).post('/v1/responses').set('Idempotency-Key', 'x'.repeat(257)).send({ input: 'x' });
        expect(empty.statusCode).toBe(400);
        expect(oversized.statusCode).toBe(400);
        expect(empty.body.error.code).toBe('invalid_idempotency_key');
        expect(handlerCalls).toBe(0);
    });
});

describe('Responses and Interactions idempotent routes', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        promptBySession.clear();
        sessionSequence = 0;
        forkSequence = 0;
        assistantSequence = 0;
        toolObservationCount = 0;
        sdkMocks.sessionCreate.mockImplementation(async () => ({ data: { id: `idem-session-${++sessionSequence}` } }));
        sdkMocks.sessionFork.mockImplementation(async () => ({ data: { id: `idem-fork-${++forkSequence}` } }));
        sdkMocks.sessionDelete.mockImplementation(async () => ({}));
        sdkMocks.sessionPrompt.mockImplementation(async (args) => {
            const sessionId = args?.path?.id;
            promptBySession.set(sessionId, structuredClone(args));
            const assistantId = `assistant-${++assistantSequence}`;
            return {
                data: {
                    info: { id: assistantId, role: 'assistant', parentID: args?.body?.messageID, finish: 'stop' },
                    parts: [{ type: 'text', text: 'idempotent answer' }],
                },
            };
        });
        sdkMocks.sessionMessages.mockImplementation(async ({ path }) => {
            const prompt = promptBySession.get(path.id);
            const parts = [{ type: 'text', text: 'idempotent answer' }];
            if (prompt?.body?.tools?.websearch === true) {
                toolObservationCount += 1;
                parts.push({
                    type: 'tool',
                    id: 'search-tool-call',
                    tool: 'websearch',
                    state: { status: 'completed', input: { query: 'test query' }, output: 'tool result' },
                });
            }
            return [{
                info: {
                    id: `assistant-poll-${path.id}`,
                    role: 'assistant',
                    parentID: prompt?.body?.messageID,
                    sessionID: path.id,
                    finish: 'stop',
                },
                parts,
            }];
        });
        sdkMocks.eventSubscribe.mockImplementation(async () => ({ stream: (async function* () {})() }));
    });

    test('completed Responses JSON replays the original ID and result without prompting again', async () => {
        const app = createRouteApp().app;
        const payload = { model: 'opencode/kimi-k2.5', input: 'answer this' };
        const first = await request(app).post('/v1/responses').set('Idempotency-Key', 'responses-json').send(payload);
        const replayed = await request(app).post('/v1/responses').set('Idempotency-Key', 'responses-json').send(payload);
        expect(first.statusCode).toBe(200);
        expect(replayed.statusCode).toBe(200);
        expect(replayed.text).toBe(first.text);
        expect(replayed.body.id).toBe(first.body.id);
        expect(sdkMocks.sessionCreate).toHaveBeenCalledTimes(1);
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(1);
    });

    test('expired response state does not delete a child pinned by an unknown idempotent outcome', async () => {
        const { app, ctx } = createRouteApp();
        const largeText = 'x'.repeat(DEFAULT_IDEMPOTENCY_MAX_RESPONSE_BYTES + 1024);
        sdkMocks.sessionPrompt.mockImplementationOnce(async (args) => {
            promptBySession.set(args.path.id, structuredClone(args));
            return {
                data: {
                    info: {
                        id: 'oversized-assistant',
                        role: 'assistant',
                        parentID: args.body.messageID,
                        finish: 'stop',
                    },
                    parts: [{ type: 'text', text: largeText }],
                },
            };
        });
        sdkMocks.sessionMessages.mockImplementationOnce(async ({ path }) => {
            const prompt = promptBySession.get(path.id);
            return [{
                info: {
                    id: 'oversized-assistant-poll',
                    role: 'assistant',
                    parentID: prompt.body.messageID,
                    sessionID: path.id,
                    finish: 'stop',
                },
                parts: [{ type: 'text', text: largeText }],
            }];
        });
        const payload = { model: 'opencode/kimi-k2.5', input: 'large response for retention test' };
        const first = await request(app).post('/v1/responses')
            .set('Idempotency-Key', 'oversized-child-retention')
            .send(payload);

        expect(first.statusCode).toBe(200);
        const state = ctx.responseState.get(first.body.id);
        expect(state).toBeDefined();
        state.expiresAt = Date.now() - 1;
        await ctx.sweepResponseState();
        expect(ctx.responseState.has(first.body.id)).toBe(false);
        expect(sdkMocks.sessionDelete).not.toHaveBeenCalledWith({ path: { id: state.sessionId } });

        const reconciled = await request(app).post('/v1/responses')
            .set('Idempotency-Key', 'oversized-child-retention')
            .send(payload);
        expect(reconciled.statusCode).toBe(200);
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(1);
        expect(sdkMocks.sessionMessages).toHaveBeenCalledTimes(2);

        const reconciledState = ctx.responseState.get(reconciled.body.id);
        expect(reconciledState).toBeDefined();
        reconciledState.expiresAt = Date.now() - 1;
        await ctx.sweepResponseState();
        expect(sdkMocks.sessionDelete).toHaveBeenCalledWith({ path: { id: state.sessionId } });
    });

    test('keyed non-stream prompt with tool finish and completion time polls for the complete exact turn', async () => {
        const app = createRouteApp().app;
        sdkMocks.sessionPrompt.mockImplementationOnce(async (args) => {
            promptBySession.set(args.path.id, structuredClone(args));
            return {
                data: {
                    info: {
                        id: 'assistant-intermediate-tool-turn',
                        role: 'assistant',
                        parentID: args.body.messageID,
                        finish: 'tool',
                        time: { completed: Date.now() },
                    },
                    parts: [{ type: 'text', text: 'unsafe partial tool-turn text' }],
                },
            };
        });
        sdkMocks.sessionMessages.mockImplementationOnce(async ({ path: sessionPath }) => {
            const prompt = promptBySession.get(sessionPath.id);
            return [{
                info: {
                    id: 'assistant-complete-after-tool',
                    role: 'assistant',
                    parentID: prompt?.body?.messageID,
                    sessionID: sessionPath.id,
                    finish: 'stop',
                },
                parts: [{ type: 'text', text: 'complete exact assistant result' }],
            }];
        });

        const response = await request(app).post('/v1/responses').set('Idempotency-Key', 'tool-finish-prompt')
            .send({ model: 'opencode/kimi-k2.5', input: 'finish the tool turn' });
        expect(response.statusCode).toBe(200);
        expect(JSON.stringify(response.body)).toContain('complete exact assistant result');
        expect(JSON.stringify(response.body)).not.toContain('unsafe partial tool-turn text');
        expect(sdkMocks.sessionMessages).toHaveBeenCalledTimes(1);
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(1);
    });

    test('a keyed no-ID prompt snapshot cannot complete JSON before an exact terminal poll', async () => {
        const app = createRouteApp({ REQUEST_TIMEOUT_MS: 50 }).app;
        sdkMocks.sessionPrompt.mockImplementationOnce(async (args) => {
            promptBySession.set(args.path.id, structuredClone(args));
            return {
                data: {
                    info: { role: 'assistant', parentID: args.body.messageID, finish: 'stop' },
                    parts: [{ type: 'text', text: 'unsafe no-ID prompt snapshot' }],
                },
            };
        });
        sdkMocks.sessionMessages.mockImplementation(async ({ path: sessionPath }) => {
            const prompt = promptBySession.get(sessionPath.id);
            return [{
                info: {
                    id: 'assistant-poll-still-incomplete',
                    role: 'assistant',
                    parentID: prompt?.body?.messageID,
                    sessionID: sessionPath.id,
                },
                parts: [{ type: 'text', text: 'still incomplete' }],
            }];
        });

        const send = () => request(app).post('/v1/responses').set('Idempotency-Key', 'no-id-prompt-snapshot')
            .send({ model: 'opencode/kimi-k2.5', input: 'wait for an exact terminal turn' });
        const first = await send();
        expect(first.statusCode).toBe(503);
        expect(first.body.error.code).toBe('idempotency_reconciliation_pending');
        expect(first.text).not.toContain('unsafe no-ID prompt snapshot');
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(1);
        const retry = await send();
        expect(retry.statusCode).toBe(503);
        expect(retry.headers['content-type']).toContain('application/json');
        expect(retry.body.error).toMatchObject({ code: 'idempotency_reconciliation_pending', retryable: true });
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(1);
    });

    test('a complete-looking prompt snapshot is not confirmation without a complete exact-turn poll', async () => {
        const app = createRouteApp({ REQUEST_TIMEOUT_MS: 50 }).app;
        sdkMocks.sessionPrompt.mockImplementationOnce(async (args) => {
            promptBySession.set(args.path.id, structuredClone(args));
            return {
                data: {
                    info: {
                        id: 'assistant-prompt-only-terminal',
                        role: 'assistant',
                        parentID: args.body.messageID,
                        finish: 'stop',
                    },
                    parts: [{ type: 'text', text: 'unpolled prompt snapshot answer' }],
                },
            };
        });
        sdkMocks.sessionMessages.mockImplementation(async ({ path: sessionPath }) => {
            const prompt = promptBySession.get(sessionPath.id);
            return [{
                info: {
                    id: 'assistant-poll-incomplete',
                    role: 'assistant',
                    parentID: prompt?.body?.messageID,
                    sessionID: sessionPath.id,
                },
                parts: [{ type: 'text', text: 'unconfirmed poll snapshot' }],
            }];
        });

        const response = await request(app).post('/v1/responses').set('Idempotency-Key', 'prompt-snapshot-not-confirmed')
            .send({ model: 'opencode/kimi-k2.5', input: 'confirm by polling' });
        expect(response.statusCode).toBe(503);
        expect(response.body.error.code).toBe('idempotency_reconciliation_pending');
        expect(response.text).not.toContain('unpolled prompt snapshot answer');
        expect(sdkMocks.sessionMessages).toHaveBeenCalled();
    });

    test('keyed non-stream prompt text with an error and no finish stays unknown until an exact terminal poll', async () => {
        const app = createRouteApp({ REQUEST_TIMEOUT_MS: 80 }).app;
        let terminalVisible = false;
        sdkMocks.sessionPrompt.mockImplementationOnce(async (args) => {
            promptBySession.set(args.path.id, structuredClone(args));
            return {
                data: {
                    info: {
                        id: 'assistant-unconfirmed-prompt-result',
                        role: 'assistant',
                        parentID: args.body.messageID,
                        error: { name: 'ProviderError', message: 'prompt result is not terminal' },
                    },
                    parts: [{ type: 'text', text: 'unsafe partial prompt text' }],
                },
            };
        });
        sdkMocks.sessionMessages.mockImplementation(async ({ path: sessionPath }) => {
            const prompt = promptBySession.get(sessionPath.id);
            const exactTurn = {
                info: {
                    id: terminalVisible ? 'assistant-later-terminal' : 'assistant-still-incomplete',
                    role: 'assistant',
                    parentID: prompt?.body?.messageID,
                    sessionID: sessionPath.id,
                    ...(terminalVisible ? { finish: 'stop' } : {}),
                },
                parts: [{ type: 'text', text: terminalVisible ? 'reconciled terminal answer' : 'still partial' }],
            };
            // Put a different turn last so the poll must filter by the
            // submitted user message ID rather than taking the newest assistant.
            const unrelatedTurn = {
                info: {
                    id: 'assistant-unrelated-terminal',
                    role: 'assistant',
                    parentID: 'another-user-message',
                    sessionID: sessionPath.id,
                    finish: 'stop',
                },
                parts: [{ type: 'text', text: 'wrong unrelated answer' }],
            };
            return [exactTurn, unrelatedTurn];
        });

        const payload = { model: 'opencode/kimi-k2.5', input: 'confirm this turn' };
        const send = () => request(app).post('/v1/responses').set('Idempotency-Key', 'prompt-unconfirmed')
            .send(payload);
        const incomplete = await send();
        expect(incomplete.statusCode).toBe(503);
        expect(incomplete.body.error.code).toBe('idempotency_reconciliation_pending');
        expect(incomplete.text).not.toContain('unsafe partial prompt text');
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(1);
        const submittedMessageId = sdkMocks.sessionPrompt.mock.calls[0][0].body.messageID;
        expect(typeof submittedMessageId).toBe('string');

        terminalVisible = true;
        const reconciled = await send();
        expect(reconciled.statusCode).toBe(200);
        expect(JSON.stringify(reconciled.body)).toContain('reconciled terminal answer');
        expect(JSON.stringify(reconciled.body)).not.toContain('unsafe partial prompt text');
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(1);
        expect(sdkMocks.sessionMessages).toHaveBeenCalledWith(expect.objectContaining({ path: { id: 'idem-session-1' } }));

        const replayed = await send();
        expect(replayed.text).toBe(reconciled.text);
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(1);
    });

    test.each([
        ['Responses', '/v1/responses', 'terminal-response-error'],
        ['Interactions', '/v1beta/interactions', 'terminal-interaction-error'],
    ])('%s complete assistant errors are cached and replayed without another prompt', async (_name, path, key) => {
        const app = createRouteApp().app;
        const payload = { model: 'opencode/kimi-k2.5', input: 'produce a terminal error' };
        sdkMocks.sessionPrompt.mockImplementationOnce(async (args) => {
            promptBySession.set(args.path.id, structuredClone(args));
            return {
                data: {
                    info: { id: 'assistant-prompt-error', role: 'assistant', parentID: args.body.messageID },
                    parts: [],
                },
            };
        });
        sdkMocks.sessionMessages.mockImplementationOnce(async ({ path: sessionPath }) => {
            const prompt = promptBySession.get(sessionPath.id);
            return [{
                info: {
                    id: 'assistant-terminal-error',
                    role: 'assistant',
                    parentID: prompt?.body?.messageID,
                    sessionID: sessionPath.id,
                    finish: 'stop',
                    error: { name: 'ProviderError', message: 'terminal assistant failure' },
                },
                parts: [],
            }];
        });

        const send = () => request(app).post(path).set('Idempotency-Key', key).send(payload);
        const first = await send();
        const replayed = await send();
        expect(first.statusCode).toBeGreaterThanOrEqual(400);
        expect(replayed.statusCode).toBe(first.statusCode);
        expect(replayed.text).toBe(first.text);
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(1);
        expect(sdkMocks.sessionMessages).toHaveBeenCalledTimes(1);
    });

    test('same continuation key reuses one child while different keys fork separately from the same parent', async () => {
        const app = createRouteApp().app;
        const seed = await request(app).post('/v1/responses').send({ model: 'opencode/kimi-k2.5', input: 'seed' });
        const continuation = { input: 'follow up', previous_response_id: seed.body.id };
        const first = await request(app).post('/v1/responses').set('Idempotency-Key', 'follow-up-one').send(continuation);
        const replayed = await request(app).post('/v1/responses').set('Idempotency-Key', 'follow-up-one').send(continuation);
        const separateKey = await request(app).post('/v1/responses').set('Idempotency-Key', 'follow-up-two').send(continuation);

        expect(first.statusCode).toBe(200);
        expect(replayed.text).toBe(first.text);
        expect(separateKey.statusCode).toBe(200);
        expect(sdkMocks.sessionFork).toHaveBeenCalledTimes(2);
        expect(sdkMocks.sessionFork.mock.calls.map(([args]) => args.path.id)).toEqual([
            'idem-session-1',
            'idem-session-1',
        ]);
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(3);
        const mismatch = await request(app).post('/v1/responses').set('Idempotency-Key', 'follow-up-one')
            .send({ ...continuation, input: 'different' });
        expect(mismatch.statusCode).toBe(409);
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(3);
    });

    test('Interactions SSE is replayed byte-for-byte through either endpoint alias', async () => {
        const app = createRouteApp().app;
        const payload = {
            model: 'opencode/kimi-k2.5',
            input: 'search this',
            stream: true,
            tools: [{ type: 'google_search' }],
        };
        const first = await request(app).post('/v1beta/interactions').set('Idempotency-Key', 'interaction-stream').send(payload);
        const replayed = await request(app).post('/v1beta/interactions').set('Idempotency-Key', 'interaction-stream').send(payload);
        expect(first.statusCode).toBe(200);
        expect(replayed.text).toBe(first.text);
        expect(first.text).toContain('interaction.completed');
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(1);
        expect(toolObservationCount).toBe(1);

        const alias = await request(app).post('/v1/interactions').set('Idempotency-Key', 'interaction-stream').send(payload);
        expect(alias.statusCode).toBe(200);
        expect(alias.text).toBe(first.text);
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(1);
        expect(toolObservationCount).toBe(1);
    });

    test('keyed Responses streaming does not complete from a terminal event without an assistant ID', async () => {
        const app = createRouteApp({ REQUEST_TIMEOUT_MS: 50 }).app;
        sdkMocks.sessionPrompt.mockReset();
        sdkMocks.sessionPrompt.mockImplementation(async (args) => {
            promptBySession.set(args.path.id, structuredClone(args));
            return {
                data: {
                    info: { id: 'assistant-prompt-snapshot', role: 'assistant', parentID: args.body.messageID, finish: 'stop' },
                    parts: [{ type: 'text', text: 'unsafe prompt snapshot text' }],
                },
            };
        });
        sdkMocks.sessionMessages.mockReset();
        sdkMocks.sessionMessages.mockImplementation(async ({ path: sessionPath }) => {
            const prompt = promptBySession.get(sessionPath.id);
            return [{
                info: {
                    id: 'assistant-poll-incomplete-stream',
                    role: 'assistant',
                    parentID: prompt?.body?.messageID,
                    sessionID: sessionPath.id,
                },
                parts: [{ type: 'text', text: 'unsafe partial poll text' }],
            }];
        });
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => ({
            stream: (async function* () {
                await Promise.resolve();
                const [sessionID, prompt] = [...promptBySession.entries()][0] ?? [];
                yield {
                    type: 'message.updated',
                    properties: {
                        info: {
                            role: 'assistant',
                            parentID: prompt?.body?.messageID,
                            finish: 'stop',
                            sessionID,
                            parts: [{ id: 'idless-terminal-part', type: 'text', text: 'unsafe idless event text' }],
                        },
                    },
                };
            })(),
        }));

        const response = await request(app).post('/v1/responses').set('Idempotency-Key', 'idless-stream-terminal')
            .send({ model: 'opencode/kimi-k2.5', input: 'wait for stream confirmation', stream: true });
        expect(response.statusCode).toBe(200);
        expect(response.text).toContain('response.failed');
        expect(response.text).not.toContain('response.completed');
        expect(response.text).not.toContain('unsafe prompt snapshot text');
        expect(response.text).not.toContain('unsafe partial poll text');
        expect(response.text).not.toContain('unsafe idless event text');
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(1);
    });

    test('keyed Responses streaming reconciliation stays SSE-pending until a later exact poll completes', async () => {
        const app = createRouteApp({ REQUEST_TIMEOUT_MS: 80 }).app;
        let terminalVisible = false;
        sdkMocks.sessionPrompt.mockImplementationOnce(async (args) => {
            promptBySession.set(args.path.id, structuredClone(args));
            throw Object.assign(new Error('upstream timed out after submit'), { statusCode: 503 });
        });
        sdkMocks.sessionMessages.mockImplementation(async ({ path: sessionPath }) => {
            const prompt = promptBySession.get(sessionPath.id);
            return [{
                info: {
                    id: terminalVisible ? 'assistant-later-responses-terminal' : 'assistant-incomplete-responses-poll',
                    role: 'assistant',
                    parentID: prompt?.body?.messageID,
                    sessionID: sessionPath.id,
                    ...(terminalVisible ? { finish: 'stop' } : {}),
                },
                parts: [{ type: 'text', text: terminalVisible ? 'reconciled Responses answer' : 'unsafe incomplete poll text' }],
            }];
        });

        const payload = { model: 'opencode/kimi-k2.5', input: 'reconcile this stream', stream: true };
        const send = () => request(app).post('/v1/responses').set('Idempotency-Key', 'responses-stream-pending')
            .send(payload);
        const parseData = (text) => text.split(/\r?\n/)
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice('data: '.length))
            .map((data) => data === '[DONE]' ? data : JSON.parse(data));

        const initial = await send();
        expect(initial.statusCode).toBe(200);
        expect(initial.headers['content-type']).toContain('text/event-stream');
        expect(initial.text).toContain('response.failed');
        expect(initial.text).toContain('data: [DONE]');

        const pending = await send();
        const pendingEvents = parseData(pending.text);
        expect(pending.statusCode).toBe(200);
        expect(pending.headers['content-type']).toContain('text/event-stream');
        expect(pendingEvents.at(-1)).toBe('[DONE]');
        expect(pendingEvents.some((event) => event?.type === 'response.failed')).toBe(true);
        expect(pendingEvents.some((event) => event?.type === 'response.completed')).toBe(false);
        expect(pending.text).not.toContain('unsafe incomplete poll text');
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(1);
        const pollsBeforeCompletion = sdkMocks.sessionMessages.mock.calls.length;
        expect(pollsBeforeCompletion).toBeGreaterThan(0);

        terminalVisible = true;
        const completed = await send();
        expect(completed.statusCode).toBe(200);
        expect(completed.headers['content-type']).toContain('text/event-stream');
        expect(completed.text).toContain('response.completed');
        expect(completed.text).toContain('reconciled Responses answer');
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(1);
        expect(sdkMocks.sessionMessages.mock.calls.length).toBeGreaterThan(pollsBeforeCompletion);

        const pollsAfterCompletion = sdkMocks.sessionMessages.mock.calls.length;
        const replayed = await send();
        expect(replayed.text).toBe(completed.text);
        expect(sdkMocks.sessionMessages).toHaveBeenCalledTimes(pollsAfterCompletion);
    });

    test('keyed Interactions streaming reconciliation stays SSE-pending until a later exact poll completes', async () => {
        const app = createRouteApp({ REQUEST_TIMEOUT_MS: 80 }).app;
        let terminalVisible = false;
        sdkMocks.sessionPrompt.mockImplementationOnce(async (args) => {
            promptBySession.set(args.path.id, structuredClone(args));
            throw Object.assign(new Error('upstream timed out after submit'), { statusCode: 503 });
        });
        sdkMocks.sessionMessages.mockImplementation(async ({ path: sessionPath }) => {
            const prompt = promptBySession.get(sessionPath.id);
            return [{
                info: {
                    id: terminalVisible ? 'assistant-later-interactions-terminal' : 'assistant-incomplete-interactions-poll',
                    role: 'assistant',
                    parentID: prompt?.body?.messageID,
                    sessionID: sessionPath.id,
                    ...(terminalVisible ? { finish: 'stop' } : {}),
                },
                parts: [{ type: 'text', text: terminalVisible ? 'reconciled Interactions answer' : 'unsafe incomplete poll text' }],
            }];
        });

        const payload = { model: 'opencode/kimi-k2.5', input: 'reconcile this interaction', stream: true };
        const send = () => request(app).post('/v1beta/interactions').set('Idempotency-Key', 'interactions-stream-pending')
            .send(payload);
        const parseEvents = (text) => text.split(/\r?\n/)
            .filter((line) => line.startsWith('data: '))
            .map((line) => JSON.parse(line.slice('data: '.length)));

        const initial = await send();
        const initialEvents = parseEvents(initial.text);
        expect(initial.statusCode).toBe(200);
        expect(initial.headers['content-type']).toContain('text/event-stream');
        expect(initialEvents.map((event) => event.type)).toEqual(['interaction.created', 'error']);
        expect(initial.text).not.toContain('interaction.completed');

        const pending = await send();
        const pendingEvents = parseEvents(pending.text);
        expect(pending.statusCode).toBe(200);
        expect(pending.headers['content-type']).toContain('text/event-stream');
        expect(pendingEvents.map((event) => event.type)).toEqual(['interaction.created', 'error']);
        expect(pending.text).not.toContain('interaction.completed');
        expect(pending.text).not.toContain('unsafe incomplete poll text');
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(1);
        const pollsBeforeCompletion = sdkMocks.sessionMessages.mock.calls.length;

        terminalVisible = true;
        const completed = await send();
        expect(completed.statusCode).toBe(200);
        expect(completed.headers['content-type']).toContain('text/event-stream');
        expect(parseEvents(completed.text).at(-1).type).toBe('interaction.completed');
        expect(completed.text).toContain('reconciled Interactions answer');
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(1);
        expect(sdkMocks.sessionMessages.mock.calls.length).toBeGreaterThan(pollsBeforeCompletion);

        const pollCountAfterCompletion = sdkMocks.sessionMessages.mock.calls.length;
        const replayed = await send();
        expect(replayed.text).toBe(completed.text);
        expect(sdkMocks.sessionMessages).toHaveBeenCalledTimes(pollCountAfterCompletion);
    });

    test('keyed streaming Interactions reconciliation emits and replays a confirmed terminal assistant error as SSE', async () => {
        const app = createRouteApp({ REQUEST_TIMEOUT_MS: 100 }).app;
        sdkMocks.sessionPrompt.mockImplementationOnce(async (args) => {
            promptBySession.set(args.path.id, structuredClone(args));
            throw Object.assign(new Error('upstream timed out after submit'), { statusCode: 503 });
        });
        sdkMocks.sessionMessages.mockImplementationOnce(async ({ path: sessionPath }) => {
            const prompt = promptBySession.get(sessionPath.id);
            return [{
                info: {
                    id: 'assistant-terminal-stream-error',
                    role: 'assistant',
                    parentID: prompt?.body?.messageID,
                    sessionID: sessionPath.id,
                    finish: 'stop',
                    error: { name: 'ProviderError', data: { message: 'terminal stream failure' } },
                },
                parts: [],
            }];
        });
        const payload = { model: 'opencode/kimi-k2.5', input: 'produce a terminal error', stream: true };
        const send = () => request(app).post('/v1beta/interactions').set('Idempotency-Key', 'terminal-stream-error')
            .send(payload);

        const first = await send();
        expect(first.statusCode).toBe(200);
        const reconciled = await send();
        expect(reconciled.statusCode).toBe(200);
        expect(reconciled.headers['content-type']).toContain('text/event-stream');
        const events = reconciled.text
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data: '))
            .map((line) => JSON.parse(line.slice('data: '.length)));
        expect(events.map((event) => event.type)).toEqual(['interaction.created', 'error']);
        expect(events[0].interaction).toMatchObject({ id: expect.any(String), status: 'in_progress' });
        expect(events[1].error.message).toContain('terminal stream failure');
        expect(reconciled.text).not.toContain('interaction.completed');

        const replayed = await send();
        expect(replayed.statusCode).toBe(reconciled.statusCode);
        expect(replayed.text).toBe(reconciled.text);
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(1);
        expect(sdkMocks.sessionMessages).toHaveBeenCalledTimes(1);
    });

    test('unknown Responses outcome reconciles the recorded child/message without a second prompt', async () => {
        const { app, ctx } = createRouteApp({ REQUEST_TIMEOUT_MS: 100 });
        sdkMocks.sessionDelete.mockClear();
        sdkMocks.sessionPrompt.mockImplementationOnce(async (args) => {
            promptBySession.set(args.path.id, structuredClone(args));
            throw Object.assign(new Error('upstream timed out after submit'), { statusCode: 503 });
        });
        const payload = { model: 'opencode/kimi-k2.5', input: 'uncertain turn' };
        const first = await request(app).post('/v1/responses').set('Idempotency-Key', 'unknown-responses').send(payload);
        expect(first.statusCode).toBeGreaterThanOrEqual(400);

        const reconciled = await request(app).post('/v1/responses').set('Idempotency-Key', 'unknown-responses').send(payload);
        expect(reconciled.statusCode).toBe(200);
        expect(reconciled.body.output[0].content[0].text).toBe('idempotent answer');
        expect(sdkMocks.sessionCreate).toHaveBeenCalledTimes(1);
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(1);
        expect(sdkMocks.sessionMessages).toHaveBeenCalledWith(expect.objectContaining({ path: { id: 'idem-session-1' } }));
        expect(ctx.responseState.has(reconciled.body.id)).toBe(true);
        expect(sdkMocks.sessionDelete).not.toHaveBeenCalled();
    });

    test('unknown Interactions outcome also polls its recorded child/message instead of prompting again', async () => {
        const app = createRouteApp({ REQUEST_TIMEOUT_MS: 100 }).app;
        sdkMocks.sessionPrompt.mockImplementationOnce(async (args) => {
            promptBySession.set(args.path.id, structuredClone(args));
            throw Object.assign(new Error('upstream timed out after submit'), { statusCode: 503 });
        });
        const payload = { model: 'opencode/kimi-k2.5', input: 'uncertain interaction' };
        const first = await request(app).post('/v1beta/interactions').set('Idempotency-Key', 'unknown-interaction').send(payload);
        expect(first.statusCode).toBeGreaterThanOrEqual(400);

        const reconciled = await request(app).post('/v1beta/interactions').set('Idempotency-Key', 'unknown-interaction').send(payload);
        expect(reconciled.statusCode).toBe(200);
        expect(reconciled.body.status).toBe('completed');
        expect(sdkMocks.sessionCreate).toHaveBeenCalledTimes(1);
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(1);
        expect(sdkMocks.sessionMessages).toHaveBeenCalledWith(expect.objectContaining({ path: { id: 'idem-session-1' } }));
    });

    test('store:false reconciliation deletes its reused child only after caching, never the stored parent', async () => {
        const app = createRouteApp().app;
        const parent = await request(app).post('/v1beta/interactions')
            .send({ model: 'opencode/kimi-k2.5', input: 'parent' });
        expect(parent.statusCode).toBe(200);

        sdkMocks.sessionPrompt.mockImplementationOnce(async (args) => {
            promptBySession.set(args.path.id, structuredClone(args));
            throw Object.assign(new Error('upstream timed out after submit'), { statusCode: 503 });
        });
        const payload = {
            model: 'opencode/kimi-k2.5',
            input: 'ephemeral child',
            previous_interaction_id: parent.body.id,
            store: false,
        };
        const first = await request(app).post('/v1beta/interactions').set('Idempotency-Key', 'ephemeral-child').send(payload);
        expect(first.statusCode).toBeGreaterThanOrEqual(400);

        const deletedSessionIds = [];
        sdkMocks.sessionDelete.mockImplementation(async ({ path }) => {
            deletedSessionIds.push(path.id);
            return {};
        });
        const reconciled = await request(app).post('/v1beta/interactions')
            .set('Idempotency-Key', 'ephemeral-child').send(payload);
        expect(reconciled.statusCode).toBe(200);
        await new Promise((resolve) => setImmediate(resolve));
        expect(deletedSessionIds).toEqual(['idem-fork-1']);
    });

    test('Responses store:false reconciliation deletes its owned child after wire capture, never its parent', async () => {
        const { app, ctx } = createRouteApp();
        const parent = await request(app).post('/v1/responses')
            .send({ model: 'opencode/kimi-k2.5', input: 'stored parent' });
        expect(parent.statusCode).toBe(200);
        const parentSessionId = ctx.responseState.get(parent.body.id).sessionId;

        sdkMocks.sessionFork.mockResolvedValueOnce({ data: { id: 'responses-ephemeral-child' } });
        sdkMocks.sessionPrompt.mockImplementationOnce(async (args) => {
            promptBySession.set(args.path.id, structuredClone(args));
            throw Object.assign(new Error('upstream timed out after submit'), { statusCode: 503 });
        });
        const payload = {
            model: 'opencode/kimi-k2.5',
            input: 'ephemeral response child',
            previous_response_id: parent.body.id,
            store: false,
        };
        const failed = await request(app).post('/v1/responses').set('Idempotency-Key', 'responses-ephemeral-child-key').send(payload);
        expect(failed.statusCode).toBeGreaterThanOrEqual(400);

        const deletedSessionIds = [];
        sdkMocks.sessionDelete.mockImplementation(async ({ path }) => {
            deletedSessionIds.push(path.id);
            return {};
        });
        const reconciled = await request(app).post('/v1/responses')
            .set('Idempotency-Key', 'responses-ephemeral-child-key').send(payload);
        expect(reconciled.statusCode).toBe(200);
        expect(ctx.responseState.has(reconciled.body.id)).toBe(false);
        await new Promise((resolve) => setImmediate(resolve));
        expect(deletedSessionIds).toEqual(['responses-ephemeral-child']);
        expect(deletedSessionIds).not.toContain(parentSessionId);

        const replayed = await request(app).post('/v1/responses')
            .set('Idempotency-Key', 'responses-ephemeral-child-key').send(payload);
        expect(replayed.text).toBe(reconciled.text);
        expect(deletedSessionIds).toEqual(['responses-ephemeral-child']);
    });

    test('confirmed required-tool validation failure is cached and replayed without another prompt', async () => {
        const app = createRouteApp().app;
        sdkMocks.sessionPrompt.mockImplementationOnce(async (args) => {
            promptBySession.set(args.path.id, structuredClone(args));
            throw Object.assign(new Error('upstream timed out after submit'), { statusCode: 503 });
        });
        const payload = {
            model: 'opencode/kimi-k2.5',
            input: 'call the required tool',
            tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }],
            tool_choice: 'required',
        };
        await request(app).post('/v1/responses').set('Idempotency-Key', 'confirmed-required-failure').send(payload);

        const failed = await request(app).post('/v1/responses')
            .set('Idempotency-Key', 'confirmed-required-failure').send(payload);
        expect(failed.statusCode).toBe(502);
        expect(failed.body.error.code).toBe('external_tool_choice_required');
        const replayed = await request(app).post('/v1/responses')
            .set('Idempotency-Key', 'confirmed-required-failure').send(payload);
        expect(replayed.statusCode).toBe(failed.statusCode);
        expect(replayed.text).toBe(failed.text);
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(1);
        expect(sdkMocks.sessionMessages).toHaveBeenCalledTimes(1);
    });

    test('complete terminal error from the required-tool prompt is cached and replayed without a second forced prompt', async () => {
        const app = createRouteApp().app;
        sdkMocks.sessionPrompt.mockClear();
        sdkMocks.sessionMessages.mockClear();
        let forcedPromptCalls = 0;
        const promptWithoutTool = async (args) => {
            promptBySession.set(args.path.id, structuredClone(args));
            if (args.body.parts?.some((part) => String(part.text).includes('previous reply did not emit the required external tool call'))) {
                forcedPromptCalls += 1;
            }
            return {
                data: {
                    info: { id: `assistant-${args.body.messageID}`, role: 'assistant', parentID: args.body.messageID, finish: 'stop' },
                    parts: [{ type: 'text', text: 'No required tool call.' }],
                },
            };
        };
        sdkMocks.sessionPrompt.mockImplementationOnce(promptWithoutTool).mockImplementationOnce(promptWithoutTool);
        sdkMocks.sessionMessages.mockImplementationOnce(async ({ path }) => {
            const prompt = promptBySession.get(path.id);
            return [{
                info: {
                    id: 'assistant-forced-terminal-error',
                    role: 'assistant',
                    parentID: prompt?.body?.messageID,
                    sessionID: path.id,
                    finish: 'stop',
                    error: { name: 'ProviderError', data: { message: 'forced prompt terminal error' } },
                },
                parts: [],
            }];
        });
        const payload = {
            model: 'opencode/kimi-k2.5',
            input: 'call the required tool',
            tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }],
            tool_choice: 'required',
        };

        const failed = await request(app).post('/v1/responses').set('Idempotency-Key', 'forced-terminal-error').send(payload);
        expect(failed.statusCode).toBe(500);
        expect(failed.text).toContain('forced prompt terminal error');
        const replayed = await request(app).post('/v1/responses').set('Idempotency-Key', 'forced-terminal-error').send(payload);
        expect(replayed.statusCode).toBe(failed.statusCode);
        expect(replayed.text).toBe(failed.text);
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(2);
        expect(forcedPromptCalls).toBe(1);
        expect(sdkMocks.sessionMessages).toHaveBeenCalledTimes(1);
    });

    test('Responses does not poll for a forced tool result when its prompt resolves after client abort', async () => {
        const app = createRouteApp({ REQUEST_TIMEOUT_MS: 80 }).app;
        let signalForcedPromptStarted;
        let releaseForcedPrompt;
        const forcedPromptStarted = new Promise((resolve) => { signalForcedPromptStarted = resolve; });
        const forcedPromptGate = new Promise((resolve) => { releaseForcedPrompt = resolve; });
        sdkMocks.sessionPrompt.mockImplementation(async (args) => {
            promptBySession.set(args.path.id, structuredClone(args));
            const isForced = args.body.parts?.some((part) =>
                String(part.text).includes('previous reply did not emit the required external tool call'));
            if (isForced) {
                signalForcedPromptStarted();
                await forcedPromptGate;
            }
            return {
                data: {
                    info: {
                        id: `assistant-${args.body.messageID}`,
                        role: 'assistant',
                        parentID: args.body.messageID,
                        finish: 'stop',
                    },
                    parts: [],
                },
            };
        });
        sdkMocks.sessionMessages.mockImplementation(async ({ path }) => {
            const prompt = promptBySession.get(path.id);
            return [{
                info: {
                    id: `assistant-poll-${path.id}`,
                    role: 'assistant',
                    parentID: prompt?.body?.messageID,
                    sessionID: path.id,
                    finish: 'stop',
                },
                parts: [],
            }];
        });
        const payload = {
            model: 'opencode/kimi-k2.5',
            input: 'call the required tool',
            tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }],
            tool_choice: 'required',
        };
        const aborted = await startAbortedRequest(app, '/v1/responses', 'forced-prompt-abort', payload);
        await forcedPromptStarted;
        expect(sdkMocks.sessionMessages).toHaveBeenCalledTimes(1);

        aborted.abort();
        // Let the server's response-close listener abort the route signal
        // while the forced prompt remains deliberately unresolved.
        await new Promise((resolve) => setTimeout(resolve, 50));
        releaseForcedPrompt();
        await new Promise((resolve) => setTimeout(resolve, 100));
        await aborted.closeServer();
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(2);
        expect(sdkMocks.sessionMessages).toHaveBeenCalledTimes(1);
    });

    test('incomplete required-tool prompt errors remain unknown and are not re-prompted', async () => {
        const app = createRouteApp({ REQUEST_TIMEOUT_MS: 35 }).app;
        sdkMocks.sessionPrompt.mockClear();
        sdkMocks.sessionMessages.mockClear();
        let forcedPromptCalls = 0;
        const promptWithoutTool = async (args) => {
            promptBySession.set(args.path.id, structuredClone(args));
            if (args.body.parts?.some((part) => String(part.text).includes('previous reply did not emit the required external tool call'))) {
                forcedPromptCalls += 1;
            }
            return {
                data: {
                    info: { id: `assistant-${args.body.messageID}`, role: 'assistant', parentID: args.body.messageID, finish: 'stop' },
                    parts: [{ type: 'text', text: 'No required tool call.' }],
                },
            };
        };
        sdkMocks.sessionPrompt.mockImplementationOnce(promptWithoutTool).mockImplementationOnce(promptWithoutTool);
        const incompleteErrorSnapshot = async ({ path }) => {
            const prompt = promptBySession.get(path.id);
            return [{
                info: {
                    id: `assistant-incomplete-${path.id}`,
                    role: 'assistant',
                    parentID: prompt?.body?.messageID,
                    sessionID: path.id,
                    error: { name: 'ProviderError', data: { message: 'forced prompt still running' } },
                },
                parts: [],
            }];
        };
        sdkMocks.sessionMessages.mockImplementation(incompleteErrorSnapshot);
        const payload = {
            model: 'opencode/kimi-k2.5',
            input: 'call the required tool',
            tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }],
            tool_choice: 'required',
        };

        const first = await request(app).post('/v1/responses').set('Idempotency-Key', 'forced-incomplete-error').send(payload);
        expect(first.statusCode).toBe(503);
        expect(first.body.error.code).toBe('idempotency_reconciliation_pending');
        const retry = await request(app).post('/v1/responses').set('Idempotency-Key', 'forced-incomplete-error').send(payload);
        expect(retry.statusCode).toBe(503);
        expect(retry.body.error.code).toBe('idempotency_reconciliation_pending');
        expect(retry.body.error.retryable).toBe(true);
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(2);
        expect(forcedPromptCalls).toBe(1);
        sdkMocks.sessionMessages.mockImplementation(defaultSessionMessagesImplementation);
    });

    test('keyed required-tool follow-up rejects parseable partial poll output and reconciles without prompting again', async () => {
        const app = createRouteApp({ REQUEST_TIMEOUT_MS: 35 }).app;
        // Clear any unconsumed one-shot mock from preceding route cases before
        // this test installs its exact prompt/poll behavior.
        sdkMocks.sessionPrompt.mockReset();
        sdkMocks.sessionMessages.mockReset();
        let forcedPromptCalls = 0;
        sdkMocks.sessionPrompt.mockImplementation(async (args) => {
            const sessionId = args.path.id;
            promptBySession.set(sessionId, structuredClone(args));
            const forced = args.body.parts?.some((part) =>
                String(part.text).includes('previous reply did not emit the required external tool call'));
            if (forced) forcedPromptCalls += 1;
            return {
                data: {
                    info: {
                        id: `assistant-${args.body.messageID}`,
                        role: 'assistant',
                        parentID: args.body.messageID,
                        finish: 'stop',
                    },
                    parts: [{ type: 'text', text: forced ? 'Forced prompt submitted.' : 'No required tool call.' }],
                },
            };
        });
        sdkMocks.sessionMessages.mockImplementation(async ({ path }) => {
            const prompt = promptBySession.get(path.id);
            return [{
                info: {
                    id: `assistant-partial-${path.id}`,
                    role: 'assistant',
                    parentID: prompt?.body?.messageID,
                    sessionID: path.id,
                },
                parts: [{
                    type: 'text',
                    text: '<function_calls>{"name":"external__lookup","arguments":{}}</function_calls>',
                }],
            }];
        });
        const payload = {
            model: 'opencode/kimi-k2.5',
            input: 'call the required tool',
            tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }],
            tool_choice: 'required',
        };

        const first = await request(app).post('/v1/responses').set('Idempotency-Key', 'forced-partial-call').send(payload);
        expect(first.statusCode).toBe(503);
        expect(first.body.error.code).toBe('idempotency_reconciliation_pending');
        const retry = await request(app).post('/v1/responses').set('Idempotency-Key', 'forced-partial-call').send(payload);
        expect(retry.statusCode).toBe(503);
        expect(retry.body.error.code).toBe('idempotency_reconciliation_pending');
        expect(retry.body.error.retryable).toBe(true);
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(2);
        expect(forcedPromptCalls).toBe(1);
        expect(sdkMocks.sessionMessages).toHaveBeenCalledTimes(2);
        sdkMocks.sessionMessages.mockImplementation(defaultSessionMessagesImplementation);
    });

    test('non-stream disconnect cannot launch a required-tool follow-up after reconciliation starts', async () => {
        const app = createRouteApp().app;
        let signalInitialPrompt;
        let releaseInitialPrompt;
        let signalRetryPoll;
        let releaseRetryPoll;
        let signalOriginalRouteCaught;
        const initialPromptStarted = new Promise((resolve) => { signalInitialPrompt = resolve; });
        const initialPromptGate = new Promise((resolve) => { releaseInitialPrompt = resolve; });
        const retryPollStarted = new Promise((resolve) => { signalRetryPoll = resolve; });
        const retryPollGate = new Promise((resolve) => { releaseRetryPoll = resolve; });
        const originalRouteCaught = new Promise((resolve) => { signalOriginalRouteCaught = resolve; });
        const payload = {
            model: 'opencode/kimi-k2.5',
            input: 'call the required tool',
            tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }],
            tool_choice: 'required',
        };
        sdkMocks.sessionPrompt.mockImplementationOnce(async (args) => {
            promptBySession.set(args.path.id, structuredClone(args));
            signalInitialPrompt();
            await initialPromptGate;
            return {
                data: {
                    info: { id: 'assistant-initial', role: 'assistant', parentID: args.body.messageID, finish: 'stop' },
                    parts: [{ type: 'text', text: 'No tool was emitted.' }],
                },
            };
        });
        sdkMocks.sessionMessages.mockImplementation(async ({ path }) => {
            signalRetryPoll();
            await retryPollGate;
            const prompt = promptBySession.get(path.id);
            return [{
                info: {
                    id: `assistant-poll-${path.id}`,
                    role: 'assistant',
                    parentID: prompt?.body?.messageID,
                    sessionID: path.id,
                    finish: 'stop',
                },
                parts: [{ type: 'text', text: 'No tool was emitted.' }],
            }];
        });
        const originalError = jest.spyOn(console, 'error').mockImplementation((...args) => {
            if (args[0] === '[Proxy] Responses API Error:' && args[1] === 'Client disconnected') {
                signalOriginalRouteCaught();
            }
        });

        const aborted = await startAbortedRequest(app, '/v1/responses', 'required-tool-close', payload);
        await initialPromptStarted;
        aborted.abort();

        let retryPromise;
        for (let attempt = 0; attempt < 20 && !retryPromise; attempt += 1) {
            const candidate = request(app).post('/v1/responses')
                .set('Idempotency-Key', 'required-tool-close').send(payload).then((response) => response);
            const outcome = await Promise.race([
                candidate.then((response) => ({ response })),
                retryPollStarted.then(() => ({ claimed: true })),
            ]);
            if (outcome.claimed) {
                retryPromise = candidate;
            } else {
                expect(outcome.response.statusCode).toBe(409);
            }
        }
        expect(retryPromise).toBeDefined();
        releaseInitialPrompt();
        await originalRouteCaught;
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(1);
        releaseRetryPoll();
        const reconciledFailure = await retryPromise;
        expect(reconciledFailure.statusCode).toBe(502);
        expect(reconciledFailure.body.error.code).toBe('external_tool_choice_required');
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(1);
        originalError.mockRestore();
        await aborted.closeServer();
    });

    test('unconfirmed reconciliation stays unknown, returns stable 503, and can later succeed', async () => {
        const app = createRouteApp({ REQUEST_TIMEOUT_MS: 40 }).app;
        sdkMocks.sessionPrompt.mockImplementationOnce(async (args) => {
            promptBySession.set(args.path.id, structuredClone(args));
            throw Object.assign(new Error('upstream timed out after submit'), { statusCode: 503 });
        });
        const payload = { model: 'opencode/kimi-k2.5', input: 'uncertain turn' };
        await request(app).post('/v1/responses').set('Idempotency-Key', 'unconfirmed').send(payload);

        sdkMocks.sessionMessages.mockImplementation(async ({ path }) => [{
            info: {
                id: 'assistant-partial',
                role: 'assistant',
                parentID: promptBySession.get(path.id)?.body?.messageID,
                sessionID: path.id,
            },
            parts: [{ type: 'text', text: 'partial answer' }],
        }]);
        const pending = await request(app).post('/v1/responses').set('Idempotency-Key', 'unconfirmed').send(payload);
        expect(pending.statusCode).toBe(503);
        expect(pending.body.error.code).toBe('idempotency_reconciliation_pending');
        expect(pending.body.error.retryable).toBe(true);

        sdkMocks.sessionMessages.mockImplementation(async ({ path }) => [{
            info: {
                id: `assistant-poll-${path.id}`,
                role: 'assistant',
                parentID: promptBySession.get(path.id)?.body?.messageID,
                sessionID: path.id,
                finish: 'stop',
            },
            parts: [{ type: 'text', text: 'idempotent answer' }],
        }]);
        const reconciled = await request(app).post('/v1/responses').set('Idempotency-Key', 'unconfirmed').send(payload);
        expect(reconciled.statusCode).toBe(200);
        expect(sdkMocks.sessionPrompt).toHaveBeenCalledTimes(1);
        expect(sdkMocks.sessionCreate).toHaveBeenCalledTimes(1);
    });
});
