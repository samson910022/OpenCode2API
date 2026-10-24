import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import net from 'node:net';

const sdkMocks = {
    configProviders: jest.fn(async () => ({
        data: {
            providers: [
                {
                    id: 'opencode',
                    models: {
                        'kimi-k2.5': { id: 'kimi-k2.5', name: 'Kimi K2.5' },
                        'kimi-k2.5-free': { id: 'kimi-k2.5-free', name: 'Kimi K2.5 Free' }
                    }
                }
            ]
        }
    })),
    configUpdate: jest.fn(async () => ({})),
    toolIds: jest.fn(async () => ['bash', 'read']),
    sessionCreate: jest.fn(async () => ({ id: 'mock-session-123' })),
    sessionPrompt: jest.fn(async () => ({ parts: [] })),
    sessionMessages: jest.fn(async () => []),
    sessionDelete: jest.fn(async () => ({})),
    eventSubscribe: jest.fn(async () => ({
        stream: (async function* () { })()
    }))
};

jest.unstable_mockModule('http', () => ({
    default: {
        get: jest.fn((url, options, callback) => {
            const res = { statusCode: 200, headers: {}, on: jest.fn() };
            callback(res);
            return { on: jest.fn(), destroy: jest.fn(), setTimeout: jest.fn() };
        })
    }
}));

jest.unstable_mockModule('@opencode-ai/sdk', () => ({
    createOpencodeClient: jest.fn(() => ({
        config: { providers: sdkMocks.configProviders, update: sdkMocks.configUpdate },
        tool: { ids: sdkMocks.toolIds },
        session: { create: sdkMocks.sessionCreate, prompt: sdkMocks.sessionPrompt, messages: sdkMocks.sessionMessages, delete: sdkMocks.sessionDelete },
        event: { subscribe: sdkMocks.eventSubscribe }
    }))
}));

const { createApp } = await import('../src/proxy.js');
const { classifyHttpError } = await import('../src/errors/http.js');
const { registerErrorHandler } = await import('../src/routes/system.js');
const { toAnthropicErrorType } = await import('../src/converters/anthropic.js');

describe('Pure HTTP Error Classifier (classifyHttpError)', () => {
    test('classifies entity.parse.failed as 400 invalid_json for OpenAI routes', () => {
        const result = classifyHttpError({ type: 'entity.parse.failed' }, '/v1/chat/completions');
        expect(result.status).toBe(400);
        expect(result.statusCode).toBe(400);
        expect(result.body).toEqual({
            error: {
                message: 'Malformed JSON in request body',
                type: 'invalid_request_error',
                code: 'invalid_json'
            }
        });
    });

    test('classifies entity.parse.failed as 400 invalid_json for Anthropic /v1/messages', () => {
        const result = classifyHttpError({ type: 'entity.parse.failed' }, '/v1/messages');
        expect(result.status).toBe(400);
        expect(result.statusCode).toBe(400);
        expect(result.body).toEqual({
            type: 'error',
            error: {
                type: 'invalid_request_error',
                message: 'Malformed JSON in request body',
                code: 'invalid_json'
            }
        });
    });

    test('classifies SyntaxError with status 400 as 400 invalid_json', () => {
        const err = new SyntaxError('Unexpected token');
        err.status = 400;
        const result = classifyHttpError(err, '/v1/responses');
        expect(result.status).toBe(400);
        expect(result.body.error.code).toBe('invalid_json');
        expect(result.body.error.message).toBe('Malformed JSON in request body');
    });

    test('classifies entity.too.large as 413 entity_too_large', () => {
        const openAiRes = classifyHttpError({ type: 'entity.too.large' }, '/v1/chat/completions');
        expect(openAiRes.status).toBe(413);
        expect(openAiRes.body).toEqual({
            error: {
                message: 'Request body exceeds the maximum permitted size',
                type: 'invalid_request_error',
                code: 'entity_too_large'
            }
        });

        const anthropicRes = classifyHttpError({ type: 'entity.too.large', status: 413 }, '/v1/messages');
        expect(anthropicRes.status).toBe(413);
        expect(anthropicRes.body).toEqual({
            type: 'error',
            error: {
                type: 'invalid_request_error',
                message: 'Request body exceeds the maximum permitted size',
                code: 'entity_too_large'
            }
        });
    });

    test('classifies charset.unsupported and encoding.unsupported as 415 unsupported_media_type', () => {
        const charsetRes = classifyHttpError({ type: 'charset.unsupported' }, '/v1/chat/completions');
        expect(charsetRes.status).toBe(415);
        expect(charsetRes.body).toEqual({
            error: {
                message: 'Unsupported body encoding or charset',
                type: 'invalid_request_error',
                code: 'unsupported_media_type'
            }
        });

        const encodingRes = classifyHttpError({ type: 'encoding.unsupported' }, '/v1/messages');
        expect(encodingRes.status).toBe(415);
        expect(encodingRes.body).toEqual({
            type: 'error',
            error: {
                type: 'invalid_request_error',
                message: 'Unsupported body encoding or charset',
                code: 'unsupported_media_type'
            }
        });
    });

    test('classifies entity.verify.failed as 400 without code', () => {
        const openAiRes = classifyHttpError({ type: 'entity.verify.failed' }, '/v1/chat/completions');
        expect(openAiRes.status).toBe(400);
        expect(openAiRes.body).toEqual({
            error: {
                message: 'Request body verification failed',
                type: 'invalid_request_error'
            }
        });

        const anthropicRes = classifyHttpError({ type: 'entity.verify.failed' }, '/v1/messages');
        expect(anthropicRes.status).toBe(400);
        expect(anthropicRes.body).toEqual({
            type: 'error',
            error: {
                type: 'invalid_request_error',
                message: 'Request body verification failed'
            }
        });
    });

    test('generic fallback returns 500 without leaking error details', () => {
        const secretError = new Error('Database password leak at /var/secrets/key.pem');
        secretError.body = 'sensitive raw snippet';
        secretError.stack = 'SecretError at /app/server.ts:42';

        const openAiRes = classifyHttpError(secretError, '/v1/chat/completions');
        expect(openAiRes.status).toBe(500);
        expect(openAiRes.body).toEqual({
            error: {
                message: 'Internal server error',
                type: 'server_error'
            }
        });
        const serializedOpenAi = JSON.stringify(openAiRes);
        expect(serializedOpenAi).not.toContain('Database password');
        expect(serializedOpenAi).not.toContain('sensitive raw snippet');
        expect(serializedOpenAi).not.toContain('/var/secrets');
        expect(serializedOpenAi).not.toContain('SecretError');

        const anthropicRes = classifyHttpError(secretError, '/v1/messages');
        expect(anthropicRes.status).toBe(500);
        expect(anthropicRes.body).toEqual({
            type: 'error',
            error: {
                type: 'api_error',
                message: 'Internal server error'
            }
        });
        const serializedAnthropic = JSON.stringify(anthropicRes);
        expect(serializedAnthropic).not.toContain('Database password');
        expect(serializedAnthropic).not.toContain('sensitive raw snippet');
        expect(serializedAnthropic).not.toContain('/var/secrets');
    });
});

describe('Anthropic Error Type Mapping (toAnthropicErrorType)', () => {
    test('maps 415 to invalid_request_error', () => {
        expect(toAnthropicErrorType(415)).toBe('invalid_request_error');
    });
});

describe('Terminal Express Error Handler with Supertest', () => {
    let app;
    beforeEach(() => {
        jest.clearAllMocks();
        app = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false
        }).app;
    });

    test('malformed JSON on /v1/chat/completions returns 400 JSON (never HTML or stack)', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .set('Content-Type', 'application/json')
            .send('{bad json');

        expect(res.status).toBe(400);
        expect(res.headers['content-type']).toMatch(/application\/json/);
        expect(res.body).toEqual({
            error: {
                message: 'Malformed JSON in request body',
                type: 'invalid_request_error',
                code: 'invalid_json'
            }
        });
        expect(res.text).not.toContain('<!DOCTYPE');
        expect(res.text).not.toContain('{bad json');
    });

    test('malformed JSON on /v1/messages returns 400 Anthropic JSON (never HTML or stack)', async () => {
        const res = await request(app)
            .post('/v1/messages')
            .set('x-api-key', 'test-key')
            .set('Content-Type', 'application/json')
            .send('{bad json');

        expect(res.status).toBe(400);
        expect(res.headers['content-type']).toMatch(/application\/json/);
        expect(res.body).toEqual({
            type: 'error',
            error: {
                type: 'invalid_request_error',
                message: 'Malformed JSON in request body',
                code: 'invalid_json'
            }
        });
        expect(res.text).not.toContain('<!DOCTYPE');
        expect(res.text).not.toContain('{bad json');
    });

    test('malformed JSON on /v1/responses returns 400 JSON', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .set('Content-Type', 'application/json')
            .send('{bad json');

        expect(res.status).toBe(400);
        expect(res.headers['content-type']).toMatch(/application\/json/);
        expect(res.body).toEqual({
            error: {
                message: 'Malformed JSON in request body',
                type: 'invalid_request_error',
                code: 'invalid_json'
            }
        });
        expect(res.text).not.toContain('<!DOCTYPE');
        expect(res.text).not.toContain('{bad json');
    });

    test('malformed JSON on /v1/interactions returns 400 JSON', async () => {
        const res = await request(app)
            .post('/v1/interactions')
            .set('Authorization', 'Bearer test-key')
            .set('Content-Type', 'application/json')
            .send('{bad json');

        expect(res.status).toBe(400);
        expect(res.headers['content-type']).toMatch(/application\/json/);
        expect(res.body).toEqual({
            error: {
                message: 'Malformed JSON in request body',
                type: 'invalid_request_error',
                code: 'invalid_json'
            }
        });
        expect(res.text).not.toContain('<!DOCTYPE');
        expect(res.text).not.toContain('{bad json');
    });

    test.each([
        ['/v1/chat/completions', 'Authorization', 'Bearer test-key'],
        ['/v1/messages', 'x-api-key', 'test-key'],
        ['/v1/responses', 'Authorization', 'Bearer test-key'],
        ['/v1beta/interactions', 'Authorization', 'Bearer test-key'],
        ['/v1/interactions', 'Authorization', 'Bearer test-key'],
    ])('unsupported Content-Type on %s returns a protocol-shaped 415 before route validation', async (path, authHeader, authValue) => {
        const call = request(app).post(path).set(authHeader, authValue)
            .set('Content-Type', 'text/plain').send('not JSON');
        const res = await call;

        expect(res.status).toBe(415);
        if (path === '/v1/messages') {
            expect(res.body).toEqual({
                type: 'error',
                error: {
                    type: 'invalid_request_error',
                    message: 'Unsupported or missing Content-Type; expected a JSON media type',
                    code: 'unsupported_media_type'
                }
            });
        } else {
            expect(res.body).toEqual({
                error: {
                    message: 'Unsupported or missing Content-Type; expected a JSON media type',
                    type: 'invalid_request_error',
                    code: 'unsupported_media_type'
                }
            });
        }
    });

    test('nonempty body without Content-Type returns 415, but an empty body can reach normal validation', async () => {
        const missingType = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .set('Content-Type', '')
            .send('not JSON');
        expect(missingType.status).toBe(415);
        expect(missingType.body.error.code).toBe('unsupported_media_type');

        const missingBody = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .set('Content-Type', '');
        expect(missingBody.status).toBe(400);
        expect(missingBody.body.error.type).toBe('invalid_request_error');
    });

    test('empty chunked body without Content-Type reaches normal validation', async () => {
        const server = app.listen(0, '127.0.0.1');
        try {
            await new Promise((resolve) => server.once('listening', resolve));
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            const rawResponse = await new Promise((resolve, reject) => {
                const socket = net.createConnection({ host: '127.0.0.1', port });
                let response = '';
                socket.on('connect', () => {
                    socket.write([
                        'POST /v1/responses HTTP/1.1',
                        'Host: 127.0.0.1',
                        'Authorization: Bearer test-key',
                        'Transfer-Encoding: chunked',
                        'Connection: close',
                        '',
                        '0',
                        '',
                        '',
                    ].join('\r\n'));
                });
                socket.on('data', (chunk) => { response += chunk.toString('utf8'); });
                socket.on('error', reject);
                socket.on('end', () => resolve(response));
            });
            expect(rawResponse).toMatch(/^HTTP\/1\.1 400\b/);
            expect(rawResponse).toContain('"type":"invalid_request_error"');
            expect(rawResponse).not.toContain('"code":"unsupported_media_type"');
        } finally {
            await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    test('nonempty chunked body without Content-Type returns 415', async () => {
        const server = app.listen(0, '127.0.0.1');
        try {
            await new Promise((resolve) => server.once('listening', resolve));
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            const rawResponse = await new Promise((resolve, reject) => {
                const socket = net.createConnection({ host: '127.0.0.1', port });
                let response = '';
                socket.on('connect', () => {
                    socket.write([
                        'POST /v1/responses HTTP/1.1',
                        'Host: 127.0.0.1',
                        'Authorization: Bearer test-key',
                        'Transfer-Encoding: chunked',
                        'Connection: close',
                        '',
                        '4',
                        'nope',
                        '0',
                        '',
                        '',
                    ].join('\r\n'));
                });
                socket.on('data', (chunk) => { response += chunk.toString('utf8'); });
                socket.on('error', reject);
                socket.on('end', () => resolve(response));
            });
            expect(rawResponse).toMatch(/^HTTP\/1\.1 415\b/);
            expect(rawResponse).toContain('"code":"unsupported_media_type"');
        } finally {
            await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    test('unsupported incomplete body is rejected and the connection is closed', async () => {
        const server = app.listen(0, '127.0.0.1');
        try {
            await new Promise((resolve) => server.once('listening', resolve));
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            const rawResponse = await new Promise((resolve, reject) => {
                const socket = net.createConnection({ host: '127.0.0.1', port });
                let response = '';
                socket.setTimeout(3000, () => socket.destroy(new Error('server did not close rejected request')));
                socket.on('connect', () => {
                    socket.write([
                        'POST /v1/responses HTTP/1.1',
                        'Host: 127.0.0.1',
                        'Authorization: Bearer test-key',
                        'Content-Type: text/plain',
                        'Content-Length: 1048576',
                        'Connection: keep-alive',
                        '',
                        'x'.repeat(64 * 1024),
                    ].join('\r\n'));
                });
                socket.on('data', (chunk) => { response += chunk.toString('utf8'); });
                socket.on('error', reject);
                socket.on('end', () => resolve(response));
            });
            expect(rawResponse).toMatch(/^HTTP\/1\.1 415\b/);
            expect(rawResponse).toMatch(/Connection: close/i);
        } finally {
            await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    test('unauthenticated malformed JSON returns 401 (auth before parsing)', async () => {
        const chatRes = await request(app)
            .post('/v1/chat/completions')
            .set('Content-Type', 'application/json')
            .send('{bad json');

        expect(chatRes.status).toBe(401);
        expect(chatRes.body).toEqual({
            error: { message: 'Unauthorized' }
        });

        const messagesRes = await request(app)
            .post('/v1/messages')
            .set('Content-Type', 'application/json')
            .send('{bad json');

        expect(messagesRes.status).toBe(401);
        expect(messagesRes.body).toEqual({
            type: 'error',
            error: {
                type: 'authentication_error',
                message: 'Unauthorized'
            }
        });
    });

    test('unauthenticated unsupported media type still returns 401 before media validation', async () => {
        const chatRes = await request(app)
            .post('/v1/chat/completions')
            .set('Content-Type', 'text/plain')
            .send('not JSON');
        expect(chatRes.status).toBe(401);
        expect(chatRes.body).toEqual({ error: { message: 'Unauthorized' } });

        const messagesRes = await request(app)
            .post('/v1/messages')
            .set('Content-Type', 'text/plain')
            .send('not JSON');
        expect(messagesRes.status).toBe(401);
        expect(messagesRes.body).toEqual({
            type: 'error',
            error: { type: 'authentication_error', message: 'Unauthorized' }
        });
    });

    test('unauthorized request on /v1/messages/ with trailing slash returns Anthropic error format', async () => {
        const res = await request(app)
            .post('/v1/messages/')
            .set('Content-Type', 'application/json')
            .send('{bad json');

        expect(res.status).toBe(401);
        expect(res.body).toEqual({
            type: 'error',
            error: {
                type: 'authentication_error',
                message: 'Unauthorized'
            }
        });
    });

    test('oversized body (simulated 413) returns 413 JSON', async () => {
        const testApp = express();
        testApp.disable('x-powered-by');
        testApp.post('/v1/chat/completions', (_req, _res, next) => {
            const err = new Error('request entity too large');
            err.type = 'entity.too.large';
            err.status = 413;
            next(err);
        });
        testApp.post('/v1/messages', (_req, _res, next) => {
            const err = new Error('request entity too large');
            err.type = 'entity.too.large';
            err.status = 413;
            next(err);
        });
        registerErrorHandler(testApp);

        const chatRes = await request(testApp)
            .post('/v1/chat/completions')
            .send({});
        expect(chatRes.status).toBe(413);
        expect(chatRes.body).toEqual({
            error: {
                message: 'Request body exceeds the maximum permitted size',
                type: 'invalid_request_error',
                code: 'entity_too_large'
            }
        });

        const messagesRes = await request(testApp)
            .post('/v1/messages')
            .send({});
        expect(messagesRes.status).toBe(413);
        expect(messagesRes.body).toEqual({
            type: 'error',
            error: {
                type: 'invalid_request_error',
                message: 'Request body exceeds the maximum permitted size',
                code: 'entity_too_large'
            }
        });
    });

    test('response headers do NOT include x-powered-by', async () => {
        const healthRes = await request(app).get('/health');
        expect(healthRes.headers['x-powered-by']).toBeUndefined();

        const modelsRes = await request(app).get('/v1/models');
        expect(modelsRes.headers['x-powered-by']).toBeUndefined();

        const postRes = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .set('Content-Type', 'application/json')
            .send('{bad json');
        expect(postRes.headers['x-powered-by']).toBeUndefined();
    });

    test('unknown model request returns 404 with model_not_found and available_models', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/unknown-model-xyz',
                messages: [{ role: 'user', content: 'hello' }]
            });

        expect(res.status).toBe(404);
        expect(res.body.code).toBe('model_not_found');
        expect(res.body.type).toBe('model_not_found');
        expect(Array.isArray(res.body.available_models)).toBe(true);
        expect(res.body.available_models).toContain('opencode/kimi-k2.5');
        expect(res.body.available_models).toContain('opencode/kimi-k2.5-free');
    });

    test('unknown model request on /v1/messages returns 404', async () => {
        const res = await request(app)
            .post('/v1/messages')
            .set('x-api-key', 'test-key')
            .send({
                model: 'opencode/unknown-model-xyz',
                max_tokens: 100,
                messages: [{ role: 'user', content: 'hello' }]
            });

        expect(res.status).toBe(404);
        expect(res.body.type).toBe('error');
        expect(res.body.error.code).toBe('model_not_found');
        expect(res.body.error.type).toBe('not_found_error');
    });

    test('unknown model request on /v1/responses returns 404', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/unknown-model-xyz',
                input: 'hello'
            });

        expect(res.status).toBe(404);
        expect(res.body.code).toBe('model_not_found');
        expect(res.body.type).toBe('model_not_found');
    });

    test('unknown model request on /v1/interactions returns 404', async () => {
        const res = await request(app)
            .post('/v1/interactions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/unknown-model-xyz',
                input: 'hello'
            });

        expect(res.status).toBe(404);
        expect(res.body.code).toBe('model_not_found');
        expect(res.body.type).toBe('model_not_found');
    });

    test('headersSent check in registerErrorHandler calls next(err)', async () => {
        const testApp = express();
        let nextCalledWith = null;
        testApp.get('/stream', (_req, res, next) => {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.write('chunk');
            next(new Error('stream broke mid-flight'));
        });
        registerErrorHandler(testApp);
        // Custom error recorder after registerErrorHandler to verify next(err) was called
        testApp.use((err, _req, res, _next) => {
            nextCalledWith = err;
            if (!res.writableEnded) res.end();
        });

        await request(testApp).get('/stream');
        expect(nextCalledWith).toBeInstanceOf(Error);
        expect(nextCalledWith.message).toBe('stream broke mid-flight');
    });

    test('unexpected route errors use server_error and api_error in actual HTTP responses', async () => {
        const testApp = express();
        testApp.post('/v1/responses', (_req, _res, next) => next(new Error('secret internal detail')));
        testApp.post('/v1/messages', (_req, _res, next) => next(new Error('secret internal detail')));
        registerErrorHandler(testApp);

        const openAiRes = await request(testApp).post('/v1/responses').send({});
        expect(openAiRes.status).toBe(500);
        expect(openAiRes.body).toEqual({ error: { message: 'Internal server error', type: 'server_error' } });
        expect(openAiRes.text).not.toContain('secret internal detail');

        const anthropicRes = await request(testApp).post('/v1/messages').send({});
        expect(anthropicRes.status).toBe(500);
        expect(anthropicRes.body).toEqual({
            type: 'error',
            error: { type: 'api_error', message: 'Internal server error' }
        });
        expect(anthropicRes.text).not.toContain('secret internal detail');
    });

    test('trailing slashes on bypass endpoints (/health/, /health/details/, /metrics/) bypass auth without 401 when API_KEY is configured', async () => {
        const bypassApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            HEALTH_DETAILS_ENABLED: true,
            HEALTH_DETAILS_REQUIRE_AUTH: false,
            METRICS_ENABLED: true,
            METRICS_REQUIRE_AUTH: false
        }).app;

        const healthRes = await request(bypassApp).get('/health/');
        expect(healthRes.status).toBe(200);
        expect(healthRes.body.status).toBe('ok');

        const healthDetailsRes = await request(bypassApp).get('/health/details/');
        expect(healthDetailsRes.status).toBe(200);
        expect(healthDetailsRes.body.status).toBe('ok');

        const metricsRes = await request(bypassApp).get('/metrics/');
        expect(metricsRes.status).toBe(200);
        expect(metricsRes.text).toContain('opencode_internal_tool_mode_requests_total');
    });

    test('GET /health/ with trailing slash bypasses auth without 401 on default app', async () => {
        const res = await request(app).get('/health/');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'ok', proxy: true });
    });
});
