import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  canonicalJsonHash,
  CAPTURE_CHUNK_OVERHEAD_BYTES,
  IdempotencyRegistry,
  idempotencyDigest,
  idempotencyHeaderStorageBytes,
  MAX_CAPTURE_CHUNKS,
  type IdempotencyRecord,
  type IdempotencyWireResponse,
} from './registry.js';

const IDEMPOTENCY_HEADER = 'idempotency-key';
const MAX_KEY_BYTES = 256;
const TARGET_ENDPOINTS = new Set(['/v1/responses', '/v1beta/interactions', '/v1/interactions']);
const ANONYMOUS_TENANT = 'anonymous';

export interface IdempotencyRequestControl {
  readonly enabled: true;
  readonly reconciling: boolean;
  readonly submitted: boolean;
  readonly resultConfirmed: boolean;
  readonly confirmedAssistantMessageId: string | null;
  readonly childSessionId: string | null;
  readonly userMessageId: string | null;
  readonly model: string | null;
  readonly publicId: string | null;
  markSubmitted(childSessionId: string, userMessageId: string, model?: string): void;
  setModel(model: string): void;
  setPublicId(publicId: string): void;
  confirmResult(userMessageId: string, assistantMessageId: string): void;
  onCompleted(callback: () => void | Promise<void>): void;
}

interface IdempotencyRequest extends Request {
  idempotency?: IdempotencyRequestControl;
  continuationTenantId?: string;
}

interface IdempotencyMiddlewareOptions {
  registry: IdempotencyRegistry;
  configuredKeys: readonly string[];
  matchedKeyIndex: (req: Request) => number;
}

function jsonError(res: Response, statusCode: number, code: string, message: string, retryable = false): void {
  res.status(statusCode).json({
    error: {
      type: 'idempotency_error',
      code,
      message,
      ...(retryable ? { retryable: true } : {}),
    },
  });
}

function idempotencyHeaderCount(req: Request): number {
  const rawHeaders = (req as unknown as { rawHeaders?: unknown }).rawHeaders;
  if (!Array.isArray(rawHeaders)) return 0;
  let count = 0;
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (typeof rawHeaders[index] === 'string' && (rawHeaders[index] as string).toLowerCase() === IDEMPOTENCY_HEADER) {
      count += 1;
    }
  }
  return count;
}

function requestKey(req: Request): { present: boolean; key: string | null; invalid: boolean } {
  const count = idempotencyHeaderCount(req);
  const header = req.headers[IDEMPOTENCY_HEADER];
  const present = count > 0 || header !== undefined;
  if (!present) return { present: false, key: null, invalid: false };
  if (count > 1 || typeof header !== 'string') return { present: true, key: null, invalid: true };
  const key = header.trim();
  if (!key || Buffer.byteLength(key, 'utf8') > MAX_KEY_BYTES || /[\u0000-\u001f\u007f]/.test(key)) {
    return { present: true, key: null, invalid: true };
  }
  return { present: true, key, invalid: false };
}

function endpointPath(req: Request): string {
  const pathname = req.path.replace(/\/+$/, '').toLowerCase() || '/';
  if (pathname === '/v1beta/interactions' || pathname === '/v1/interactions') return '/v1/interactions';
  return pathname;
}

function parentIdFor(endpoint: string, body: unknown): string {
  const record = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const value = endpoint === '/v1/responses' ? record['previous_response_id'] : record['previous_interaction_id'];
  return typeof value === 'string' ? value : '';
}

function captureHeaders(
  res: Response,
  reserveHeaderBytes: (bytes: number) => boolean,
): Record<string, string | number | string[]> | null {
  const headers = res.getHeaders();
  const excluded = new Set([
    'connection',
    'content-length',
    'date',
    'keep-alive',
    'transfer-encoding',
    'upgrade',
  ]);
  const selected = Object.create(null) as Record<string, string | number | string[]>;
  for (const [name, value] of Object.entries(headers)) {
    if (excluded.has(name.toLowerCase()) || value === undefined) continue;
    if (typeof value === 'string' || typeof value === 'number' || Array.isArray(value)) {
      selected[name] = value as string | number | string[];
    }
  }
  if (!reserveHeaderBytes(idempotencyHeaderStorageBytes(selected))) return null;
  const output = Object.create(null) as Record<string, string | number | string[]>;
  for (const [name, value] of Object.entries(selected)) output[name] = Array.isArray(value) ? [...value] : value;
  return output;
}

function chunkByteLength(chunk: unknown, encoding?: unknown): number | null {
  if (typeof chunk === 'string') {
    const selectedEncoding = typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8';
    return Buffer.byteLength(chunk, selectedEncoding);
  }
  if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) return chunk.byteLength;
  return null;
}

function copyChunkBytes(chunk: unknown, encoding?: unknown): Buffer | null {
  if (typeof chunk === 'string') {
    const selectedEncoding = typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8';
    return Buffer.from(chunk, selectedEncoding);
  }
  if (Buffer.isBuffer(chunk)) return Buffer.from(chunk);
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return null;
}

interface SseDataRange {
  start: number;
  end: number;
}

interface SseDataEventRanges {
  previous: SseDataRange | null;
  latest: SseDataRange | null;
}

const MAX_SSE_TERMINAL_DATA_BYTES = 64 * 1024;
const SSE_TERMINAL_VALIDATION_RESERVATION_MULTIPLIER = 16;

/** Scan SSE line/event boundaries without materializing strings or event arrays. */
export function scanSseDataEventRanges(body: Buffer): SseDataEventRanges {
  let eventData: SseDataRange | null = null;
  let previous: SseDataRange | null = null;
  let latest: SseDataRange | null = null;
  const finishEvent = (): void => {
    if (eventData) {
      previous = latest;
      latest = eventData;
      eventData = null;
    }
  };
  const scanLine = (lineStart: number, lineEnd: number): void => {
    if (lineEnd > lineStart && body[lineEnd - 1] === 0x0d) lineEnd -= 1;
    if (lineEnd === lineStart) {
      finishEvent();
      return;
    }
    if (
      !eventData &&
      lineEnd - lineStart >= 5 &&
      body[lineStart] === 0x64 &&
      body[lineStart + 1] === 0x61 &&
      body[lineStart + 2] === 0x74 &&
      body[lineStart + 3] === 0x61 &&
      body[lineStart + 4] === 0x3a
    ) {
      eventData = { start: lineStart + 5, end: lineEnd };
    }
  };

  let lineStart = 0;
  for (let index = 0; index < body.byteLength; index += 1) {
    if (body[index] !== 0x0a) continue;
    scanLine(lineStart, index);
    lineStart = index + 1;
  }
  if (lineStart < body.byteLength) scanLine(lineStart, body.byteLength);
  finishEvent();
  return { previous, latest };
}

function isDoneData(body: Buffer, range: SseDataRange): boolean {
  let { start, end } = range;
  while (start < end && isSseWhitespace(body[start])) start += 1;
  while (end > start && isSseWhitespace(body[end - 1])) end -= 1;
  return end - start === 6 &&
    body[start] === 0x5b && body[start + 1] === 0x44 && body[start + 2] === 0x4f &&
    body[start + 3] === 0x4e && body[start + 4] === 0x45 && body[start + 5] === 0x5d;
}

function isSseWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0b || byte === 0x0c;
}

function parseSseTerminalEvent(
  body: Buffer,
  range: SseDataRange,
  expectedType: string,
  reserveTemporaryBytes: (bytes: number) => boolean,
  releaseTemporaryBytes: (bytes: number) => void,
): boolean {
  const dataBytes = range.end - range.start;
  if (dataBytes < 1 || dataBytes > MAX_SSE_TERMINAL_DATA_BYTES) return false;
  // Account for the temporary UTF-8 string and bounded JSON parse tree before
  // allocating either. The multiplier is intentionally conservative.
  const reservedBytes = dataBytes * SSE_TERMINAL_VALIDATION_RESERVATION_MULTIPLIER;
  if (!reserveTemporaryBytes(reservedBytes)) return false;
  try {
    const eventData = body.toString('utf8', range.start, range.end).trim();
    return (JSON.parse(eventData) as { type?: unknown }).type === expectedType;
  } catch {
    return false;
  } finally {
    releaseTemporaryBytes(reservedBytes);
  }
}

function isSuccessfulResponse(
  endpoint: string,
  response: IdempotencyWireResponse,
  reserveTemporaryBytes: (bytes: number) => boolean,
  releaseTemporaryBytes: (bytes: number) => void,
): boolean {
  if (response.statusCode < 200 || response.statusCode >= 300) return false;
  const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.includes('text/event-stream')) return true;
  const dataEvents = scanSseDataEventRanges(response.body);
  if (endpoint === '/v1/responses') {
    return Boolean(
      dataEvents.latest &&
      isDoneData(response.body, dataEvents.latest) &&
      dataEvents.previous &&
      parseSseTerminalEvent(
        response.body,
        dataEvents.previous,
        'response.completed',
        reserveTemporaryBytes,
        releaseTemporaryBytes,
      ),
    );
  }
  return Boolean(
    dataEvents.latest &&
    parseSseTerminalEvent(
      response.body,
      dataEvents.latest,
      'interaction.completed',
      reserveTemporaryBytes,
      releaseTemporaryBytes,
    ),
  );
}

function replay(res: Response, response: IdempotencyWireResponse): void {
  res.statusCode = response.statusCode;
  for (const [name, value] of Object.entries(response.headers)) res.setHeader(name, value);
  res.setHeader('Content-Length', response.body.byteLength);
  res.end(response.body);
}

function instrumentResponse(
  res: Response,
  endpoint: string,
  record: IdempotencyRecord,
  generation: number,
  registry: IdempotencyRegistry,
  onCompletedCallbacks: Array<() => void | Promise<void>>,
): void {
  const writable = res as unknown as {
    write: (...args: unknown[]) => boolean;
    end: (...args: unknown[]) => unknown;
  };
  const originalWrite = writable.write;
  const originalEnd = writable.end;
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  let capturedReservationBytes = 0;
  let captureOverflow = false;
  let captureReleased = false;
  const capture = (chunk: unknown, encoding?: unknown): void => {
    if (captureReleased || captureOverflow || chunk == null || typeof chunk === 'function') return;
    if (chunks.length >= MAX_CAPTURE_CHUNKS) {
      captureOverflow = true;
      return;
    }
    let byteLength: number | null;
    try {
      byteLength = chunkByteLength(chunk, encoding);
    } catch {
      captureOverflow = true;
      return;
    }
    if (byteLength === null) {
      captureOverflow = true;
      return;
    }
    if (!registry.reserveCaptureBytes(record, generation, byteLength, CAPTURE_CHUNK_OVERHEAD_BYTES)) {
      captureOverflow = true;
      return;
    }
    const reservationBytes = byteLength + CAPTURE_CHUNK_OVERHEAD_BYTES;
    let bytes: Buffer | null;
    try {
      bytes = copyChunkBytes(chunk, encoding);
    } catch {
      registry.releaseCaptureBytes(record, generation, reservationBytes, byteLength);
      captureOverflow = true;
      return;
    }
    if (!bytes || bytes.byteLength !== byteLength) {
      registry.releaseCaptureBytes(record, generation, reservationBytes, byteLength);
      captureOverflow = true;
      return;
    }
    chunks.push(bytes);
    capturedBytes += byteLength;
    capturedReservationBytes += reservationBytes;
  };
  const releaseCapture = (): void => {
    captureReleased = true;
    chunks.length = 0;
    capturedBytes = 0;
    capturedReservationBytes = 0;
    registry.releaseCapture(record, generation);
  };
  const runCompletedCallbacks = (): void => {
    void Promise.allSettled(onCompletedCallbacks.map((callback) => Promise.resolve().then(callback)));
  };
  const abandonOrMarkUnknown = (): void => {
    registry.releaseCapture(record, generation);
    chunks.length = 0;
    capturedBytes = 0;
    capturedReservationBytes = 0;
    if (record.submitted) {
      registry.markUnknown(record, generation);
    } else {
      registry.abandon(record, generation);
      runCompletedCallbacks();
    }
  };

  writable.write = function (...args: unknown[]): boolean {
    capture(args[0], args[1]);
    return originalWrite.apply(res, args);
  };
  writable.end = function (...args: unknown[]): unknown {
    capture(args[0], args[1]);
    return originalEnd.apply(res, args);
  };

  res.once('finish', () => {
    captureReleased = true;
    if (captureOverflow) {
      abandonOrMarkUnknown();
      return;
    }
    // Buffer.concat allocates an assembly buffer while the chunk buffers are
    // still live. Reserve that peak before allocating, then release the chunk
    // reservation after dropping those references. The assembled Buffer is
    // transferred to the registry without another full-body copy.
    const assemblyBytes = capturedBytes;
    if (!registry.reserveAssemblyBytes(record, generation, assemblyBytes)) {
      abandonOrMarkUnknown();
      return;
    }
    let body: Buffer;
    try {
      body = Buffer.concat(chunks, assemblyBytes);
    } catch {
      abandonOrMarkUnknown();
      return;
    }
    chunks.length = 0;
    registry.releaseCaptureBytes(record, generation, capturedReservationBytes, capturedBytes);
    capturedBytes = 0;
    capturedReservationBytes = 0;
    if (!registry.isCurrent(record, generation)) return;
    const headers = captureHeaders(
      res,
      (bytes) => registry.reserveAssemblyBytes(record, generation, bytes),
    );
    if (!headers) {
      abandonOrMarkUnknown();
      return;
    }
    const response: IdempotencyWireResponse = { statusCode: res.statusCode, headers, body };
    if (!record.submitted) {
      registry.completeCaptured(record, generation, 'failed', response);
      runCompletedCallbacks();
      return;
    }
    const resultConfirmed = record.resultConfirmed &&
      typeof record.confirmedAssistantMessageId === 'string' &&
      record.confirmedAssistantMessageId.trim().length > 0;
    if (response.statusCode >= 200 && response.statusCode < 300 && !resultConfirmed) {
      registry.markUnknown(record, generation);
      return;
    }
    if (isSuccessfulResponse(
      endpoint,
      response,
      (bytes) => registry.reserveAssemblyBytes(record, generation, bytes),
      (bytes) => registry.releaseCaptureBytes(record, generation, bytes),
    )) {
      const stored = registry.completeCaptured(record, generation, 'completed', response);
      if (stored) runCompletedCallbacks();
      return;
    }
    if (resultConfirmed) {
      const stored = registry.completeCaptured(record, generation, 'failed', response);
      if (stored) runCompletedCallbacks();
      return;
    }
    // A submitted prompt with no complete success wire result is uncertain
    // until a complete assistant result has been observed and confirmed.
    registry.markUnknown(record, generation);
  });

  res.once('close', () => {
    releaseCapture();
    const response = res as unknown as { writableFinished?: boolean };
    if (!response.writableFinished) {
      if (record.submitted) registry.markUnknown(record, generation);
      else registry.abandon(record, generation);
    }
  });

}

/**
 * Idempotency-Key middleware for the two stateful continuation APIs. It is
 * intentionally installed after auth and JSON parsing, and does nothing at
 * all when the header is absent.
 */
export function createIdempotencyMiddleware(options: IdempotencyMiddlewareOptions): RequestHandler {
  const { registry, configuredKeys, matchedKeyIndex } = options;
  return (req: Request, res: Response, next: NextFunction): void => {
    const endpoint = endpointPath(req);
    if (req.method !== 'POST' || !TARGET_ENDPOINTS.has(endpoint)) return next();

    let tenant = ANONYMOUS_TENANT;
    const keyIndex = configuredKeys.length > 0 ? matchedKeyIndex(req) : -1;
    const configuredKey = keyIndex >= 0 ? configuredKeys[keyIndex] : undefined;
    if (typeof configuredKey === 'string') tenant = `key:${idempotencyDigest(configuredKey)}`;
    (req as IdempotencyRequest).continuationTenantId = tenant;

    const header = requestKey(req);
    if (!header.present) return next();
    if (header.invalid || !header.key) {
      jsonError(res, 400, 'invalid_idempotency_key', 'Idempotency-Key must be a single non-empty value no longer than 256 bytes');
      return;
    }

    if (configuredKeys.length > 0) {
      if (keyIndex < 0 || typeof configuredKey !== 'string') {
        jsonError(res, 401, 'unauthorized', 'Unauthorized');
        return;
      }
      tenant = `key:${idempotencyDigest(configuredKey)}`;
    }

    const parentId = parentIdFor(endpoint, (req as IdempotencyRequest).body);
    const scopeId = idempotencyDigest(JSON.stringify([
      tenant,
      endpoint,
      parentId,
      idempotencyDigest(header.key),
    ]));
    let payloadHash: string;
    try {
      payloadHash = canonicalJsonHash((req as IdempotencyRequest).body);
    } catch {
      jsonError(res, 400, 'invalid_idempotency_payload', 'The request payload exceeds idempotency processing limits');
      return;
    }
    const prior = registry.get(scopeId);
    const priorState = prior?.state ?? null;
    const result = registry.begin(scopeId, payloadHash, tenant);
    if (result.kind === 'full') {
      jsonError(
        res,
        503,
        'idempotency_capacity_exceeded',
        'Idempotency capacity for this tenant or the service is temporarily exhausted; retry later',
        true,
      );
      return;
    }
    if (result.kind === 'mismatch') {
      jsonError(res, 409, 'idempotency_key_reused', 'This Idempotency-Key was already used with a different request payload');
      return;
    }

    const record = result.record;
    if (result.kind === 'existing' && priorState !== 'unknown') {
      if (record.state === 'completed' || record.state === 'failed') {
        if (record.wireResponse) {
          replay(res, record.wireResponse);
          return;
        }
        jsonError(res, 503, 'idempotency_result_unavailable', 'The original result is unavailable; retry reconciliation is required', true);
        return;
      }
      jsonError(res, 409, 'idempotency_in_progress', 'A request with this Idempotency-Key is already in progress', true);
      return;
    }

    const reconciling = result.kind === 'existing' && priorState === 'unknown';
    if (reconciling && (!record.childSessionId || !record.userMessageId)) {
      registry.markUnknown(record, record.generation);
      jsonError(res, 503, 'idempotency_reconciliation_pending', 'The previous outcome is uncertain and cannot yet be reconciled', true);
      return;
    }

    const callbacks: Array<() => void | Promise<void>> = [];
    const generation = record.generation;
    const control: IdempotencyRequestControl = {
      enabled: true,
      reconciling,
      get submitted() { return record.submitted; },
      get resultConfirmed() { return record.generation === generation && record.resultConfirmed; },
      get confirmedAssistantMessageId() {
        return record.generation === generation ? record.confirmedAssistantMessageId : null;
      },
      get childSessionId() { return record.childSessionId; },
      get userMessageId() { return record.userMessageId; },
      get model() { return record.model; },
      get publicId() { return record.publicId; },
      markSubmitted: (childSessionId, userMessageId, model) => {
        registry.markSubmitted(record, generation, childSessionId, userMessageId, model);
      },
      setModel: (model) => registry.setModel(record, generation, model),
      setPublicId: (publicId) => registry.setPublicId(record, generation, publicId),
      confirmResult: (userMessageId, assistantMessageId) =>
        registry.confirmResult(record, generation, userMessageId, assistantMessageId),
      onCompleted: (callback) => {
        if (registry.isCurrent(record, generation)) callbacks.push(callback);
      },
    };
    (req as IdempotencyRequest).idempotency = control;
    instrumentResponse(res, endpoint, record, generation, registry, callbacks);
    next();
  };
}

export function getIdempotencyControl(req: Request): IdempotencyRequestControl | null {
  return (req as IdempotencyRequest).idempotency ?? null;
}

/** Return the matched key's digest tenant, or the stable anonymous tenant when auth is disabled. */
export function getContinuationTenantId(req: Request): string {
  return (req as IdempotencyRequest).continuationTenantId ?? ANONYMOUS_TENANT;
}
