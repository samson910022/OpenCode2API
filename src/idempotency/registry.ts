import { createHash } from 'node:crypto';

export const MIN_IDEMPOTENCY_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_IDEMPOTENCY_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_IDEMPOTENCY_MAX_ENTRIES = 2_000;
export const DEFAULT_IDEMPOTENCY_MAX_LIVE_ENTRIES_PER_TENANT = 100;
export const DEFAULT_IDEMPOTENCY_MAX_RETAINED_ENTRIES_PER_TENANT = 500;
export const DEFAULT_IDEMPOTENCY_MAX_CACHED_BYTES = 64 * 1024 * 1024;
export const DEFAULT_IDEMPOTENCY_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_CAPTURE_CHUNKS = 1_024;
export const CAPTURE_CHUNK_OVERHEAD_BYTES = 128;
const HEADER_ENTRY_OVERHEAD_BYTES = 64;
const HEADER_ARRAY_OVERHEAD_BYTES = 24;
const HEADER_ARRAY_ITEM_OVERHEAD_BYTES = 16;
export const DEFAULT_IDEMPOTENCY_MAX_CACHED_BYTES_PER_TENANT =
  2 * DEFAULT_IDEMPOTENCY_MAX_RESPONSE_BYTES +
  MAX_CAPTURE_CHUNKS * CAPTURE_CHUNK_OVERHEAD_BYTES +
  2 * 1024 * 1024;

export type IdempotencyState = 'in_progress' | 'completed' | 'failed' | 'unknown';

export interface IdempotencyWireResponse {
  statusCode: number;
  headers: Record<string, string | number | string[]>;
  body: Buffer;
}

/** Conservative bounded estimate of the retained JS header storage in UTF-8 bytes. */
export function idempotencyHeaderStorageBytes(
  headers: Record<string, string | number | string[]>,
): number {
  let bytes = 0;
  const add = (value: number): void => {
    if (!Number.isSafeInteger(value) || value < 0 || bytes > Number.MAX_SAFE_INTEGER - value) {
      bytes = Number.MAX_SAFE_INTEGER;
      return;
    }
    bytes += value;
  };
  for (const [name, value] of Object.entries(headers)) {
    add(Buffer.byteLength(name, 'utf8') + HEADER_ENTRY_OVERHEAD_BYTES);
    if (Array.isArray(value)) {
      add(HEADER_ARRAY_OVERHEAD_BYTES);
      for (const item of value) {
        add(Buffer.byteLength(item, 'utf8') + HEADER_ARRAY_ITEM_OVERHEAD_BYTES);
      }
    } else {
      add(Buffer.byteLength(String(value), 'utf8'));
    }
  }
  return bytes;
}

/** Body plus retained header storage, used for global and per-tenant cache budgets. */
export function idempotencyResponseStorageBytes(response: IdempotencyWireResponse): number {
  const bodyBytes = response.body.byteLength;
  const headerBytes = idempotencyHeaderStorageBytes(response.headers);
  return bodyBytes > Number.MAX_SAFE_INTEGER - headerBytes ? Number.MAX_SAFE_INTEGER : bodyBytes + headerBytes;
}

function copyHeaders(headers: Record<string, string | number | string[]>): Record<string, string | number | string[]> {
  const copy = Object.create(null) as Record<string, string | number | string[]>;
  for (const [name, value] of Object.entries(headers)) copy[name] = Array.isArray(value) ? [...value] : value;
  return copy;
}

export interface IdempotencyRecord {
  readonly scopeId: string;
  readonly tenantId: string;
  readonly payloadHash: string;
  state: IdempotencyState;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  generation: number;
  submitted: boolean;
  resultConfirmed: boolean;
  confirmedAssistantMessageId: string | null;
  childSessionId: string | null;
  userMessageId: string | null;
  model: string | null;
  publicId: string | null;
  wireResponse: IdempotencyWireResponse | null;
}

export type IdempotencyBeginResult =
  | { kind: 'created'; record: IdempotencyRecord }
  | { kind: 'existing'; record: IdempotencyRecord }
  | { kind: 'mismatch'; record: IdempotencyRecord }
  | { kind: 'full' };

export interface IdempotencyRegistryOptions {
  ttlMs?: number;
  maxEntries?: number;
  maxLiveEntriesPerTenant?: number;
  maxRetainedEntriesPerTenant?: number;
  maxCachedBytes?: number;
  maxCachedBytesPerTenant?: number;
  maxResponseBytes?: number;
  now?: () => number;
}

const MAX_CANONICAL_DEPTH = 256;
const MAX_CANONICAL_NODES = 1_000_000;

function canonicalize(value: unknown, state: { nodes: number }, depth: number): string {
  state.nodes += 1;
  if (state.nodes > MAX_CANONICAL_NODES || depth > MAX_CANONICAL_DEPTH) {
    throw new RangeError('Idempotency payload exceeds canonicalization limits');
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item, state, depth + 1)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], state, depth + 1)}`);
  return `{${fields.join(',')}}`;
}

/** Canonical JSON makes object property order irrelevant while preserving array order and JSON values. */
export function canonicalJsonHash(payload: unknown): string {
  return createHash('sha256').update(canonicalize(payload, { nodes: 0 }, 0), 'utf8').digest('hex');
}

/** Hash secrets and scope components before they are used as a registry key. */
export function idempotencyDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * A bounded, per-app in-memory idempotency ledger. Active and unknown entries
 * are never evicted: doing so could turn an uncertain prompt into a new prompt.
 * Completed/failed replay records have a TTL clamped to at least 30 minutes.
 */
export class IdempotencyRegistry {
  private readonly entries = new Map<string, IdempotencyRecord>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxLiveEntriesPerTenant: number;
  private readonly maxRetainedEntriesPerTenant: number;
  private readonly maxCachedBytes: number;
  private readonly maxCachedBytesPerTenant: number;
  private readonly maxResponseBytes: number;
  private cachedBytes = 0;
  private pendingCaptureBytes = 0;
  private readonly captureBytesByScope = new Map<string, number>();
  private readonly responseBytesByScope = new Map<string, number>();
  private readonly tenantEntrySlots = new Map<string, number>();
  private readonly retainedEntriesByTenant = new Map<string, number>();
  private readonly cachedBytesByTenant = new Map<string, number>();
  private readonly pendingCaptureBytesByTenant = new Map<string, number>();
  private readonly liveEntriesByTenant = new Map<string, number>();

  constructor(options: IdempotencyRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = Math.max(MIN_IDEMPOTENCY_TTL_MS, options.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS);
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_IDEMPOTENCY_MAX_ENTRIES));
    const perTenantEntryLimit = this.maxEntries > 1 ? this.maxEntries - 1 : this.maxEntries;
    this.maxLiveEntriesPerTenant = Math.max(
      1,
      Math.min(
        perTenantEntryLimit,
        Math.floor(options.maxLiveEntriesPerTenant ?? DEFAULT_IDEMPOTENCY_MAX_LIVE_ENTRIES_PER_TENANT),
      ),
    );
    this.maxRetainedEntriesPerTenant = Math.max(
      1,
      Math.min(
        perTenantEntryLimit,
        Math.floor(options.maxRetainedEntriesPerTenant ?? DEFAULT_IDEMPOTENCY_MAX_RETAINED_ENTRIES_PER_TENANT),
      ),
    );
    this.maxCachedBytes = Math.max(0, options.maxCachedBytes ?? DEFAULT_IDEMPOTENCY_MAX_CACHED_BYTES);
    this.maxCachedBytesPerTenant = Math.max(
      0,
      Math.min(
        this.maxCachedBytes > 1 ? this.maxCachedBytes - 1 : this.maxCachedBytes,
        options.maxCachedBytesPerTenant ?? DEFAULT_IDEMPOTENCY_MAX_CACHED_BYTES_PER_TENANT,
      ),
    );
    this.maxResponseBytes = Math.max(0, options.maxResponseBytes ?? DEFAULT_IDEMPOTENCY_MAX_RESPONSE_BYTES);
  }

  begin(scopeId: string, payloadHash: string, tenantId: string = 'anonymous'): IdempotencyBeginResult {
    this.pruneExpired();
    const existing = this.entries.get(scopeId);
    if (existing) {
      existing.updatedAt = this.now();
      if (existing.payloadHash !== payloadHash) return { kind: 'mismatch', record: existing };
      if (existing.state === 'unknown') {
        // Claim reconciliation synchronously so concurrent retries cannot poll
        // or emit a second response for the same submitted prompt.
        existing.state = 'in_progress';
        existing.generation += 1;
        existing.resultConfirmed = false;
        existing.confirmedAssistantMessageId = null;
        existing.expiresAt = this.now() + this.ttlMs;
      }
      return { kind: 'existing', record: existing };
    }
    // Reserve a per-tenant slot for every record. It moves from live to
    // retained on completion. No record may be evicted before its TTL: a
    // completed/failed record must remain replayable, and active/unknown
    // records must not permit a duplicate prompt.
    if ((this.liveEntriesByTenant.get(tenantId) ?? 0) >= this.maxLiveEntriesPerTenant) return { kind: 'full' };
    if ((this.tenantEntrySlots.get(tenantId) ?? 0) >= this.maxRetainedEntriesPerTenant) return { kind: 'full' };
    if (this.entries.size >= this.maxEntries) return { kind: 'full' };

    const now = this.now();
    const record: IdempotencyRecord = {
      scopeId,
      tenantId,
      payloadHash,
      state: 'in_progress',
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.ttlMs,
      generation: 1,
      submitted: false,
      resultConfirmed: false,
      confirmedAssistantMessageId: null,
      childSessionId: null,
      userMessageId: null,
      model: null,
      publicId: null,
      wireResponse: null,
    };
    this.entries.set(scopeId, record);
    this.adjustCount(this.tenantEntrySlots, tenantId, 1);
    this.liveEntriesByTenant.set(tenantId, (this.liveEntriesByTenant.get(tenantId) ?? 0) + 1);
    return { kind: 'created', record };
  }

  isCurrent(record: IdempotencyRecord, generation: number): boolean {
    return this.entries.get(record.scopeId) === record && record.generation === generation && record.state === 'in_progress';
  }

  markSubmitted(
    record: IdempotencyRecord,
    generation: number,
    childSessionId: string,
    userMessageId: string,
    model?: string,
  ): void {
    if (!this.isCurrent(record, generation)) {
      throw new Error('Cannot submit an abandoned or inactive idempotency request');
    }
    record.submitted = true;
    record.childSessionId = childSessionId;
    record.userMessageId = userMessageId;
    record.resultConfirmed = false;
    record.confirmedAssistantMessageId = null;
    if (model) record.model = model;
    this.touch(record);
  }

  /** Remove a disconnected request only if it has not submitted its prompt. */
  abandon(record: IdempotencyRecord, generation: number): void {
    if (!this.isCurrent(record, generation) || record.submitted) return;
    record.generation += 1;
    this.entries.delete(record.scopeId);
    this.adjustCount(this.tenantEntrySlots, record.tenantId, -1);
    this.adjustTenantLiveCount(record.tenantId, -1);
    const reservedBytes = this.captureBytesByScope.get(record.scopeId) ?? 0;
    this.captureBytesByScope.delete(record.scopeId);
    this.responseBytesByScope.delete(record.scopeId);
    this.pendingCaptureBytes = Math.max(0, this.pendingCaptureBytes - reservedBytes);
    this.adjustPendingTenantBytes(record.tenantId, -reservedBytes);
    this.removeCachedResponse(record);
  }

  setModel(record: IdempotencyRecord, generation: number, model: string): void {
    if (!this.isCurrent(record, generation)) {
      throw new Error('Cannot update an abandoned or inactive idempotency request');
    }
    record.model = model;
    this.touch(record);
  }

  setPublicId(record: IdempotencyRecord, generation: number, publicId: string): void {
    if (!this.isCurrent(record, generation)) {
      throw new Error('Cannot update an abandoned or inactive idempotency request');
    }
    record.publicId = publicId;
    this.touch(record);
  }

  confirmResult(record: IdempotencyRecord, generation: number, userMessageId: string, assistantMessageId: string): void {
    if (
      !this.isCurrent(record, generation) ||
      !record.submitted ||
      record.userMessageId !== userMessageId ||
      typeof assistantMessageId !== 'string' ||
      assistantMessageId.trim().length === 0
    ) {
      throw new Error('Cannot confirm an inactive or mismatched idempotency result');
    }
    record.resultConfirmed = true;
    record.confirmedAssistantMessageId = assistantMessageId;
    this.touch(record);
  }

  /** Reserve bounded memory for response capture while a route is streaming. */
  reserveCaptureBytes(
    record: IdempotencyRecord,
    generation: number,
    bytes: number,
    overheadBytes = 0,
  ): boolean {
    if (
      !this.isCurrent(record, generation) ||
      !Number.isFinite(bytes) ||
      bytes < 0 ||
      !Number.isFinite(overheadBytes) ||
      overheadBytes < 0
    ) return false;
    const reservedBytes = bytes + overheadBytes;
    const current = this.captureBytesByScope.get(record.scopeId) ?? 0;
    const responseBytes = this.responseBytesByScope.get(record.scopeId) ?? 0;
    if (
      responseBytes + bytes > this.maxResponseBytes ||
      this.cachedBytes + this.pendingCaptureBytes + reservedBytes > this.maxCachedBytes ||
      (this.cachedBytesByTenant.get(record.tenantId) ?? 0) +
        (this.pendingCaptureBytesByTenant.get(record.tenantId) ?? 0) + reservedBytes >
        this.maxCachedBytesPerTenant
    ) return false;
    this.captureBytesByScope.set(record.scopeId, current + reservedBytes);
    this.responseBytesByScope.set(record.scopeId, responseBytes + bytes);
    this.pendingCaptureBytes += reservedBytes;
    this.adjustPendingTenantBytes(record.tenantId, reservedBytes);
    return true;
  }

  /** Reserve the second, temporary buffer needed to assemble captured chunks. */
  reserveAssemblyBytes(record: IdempotencyRecord, generation: number, bytes: number): boolean {
    if (!this.isCurrent(record, generation) || !Number.isFinite(bytes) || bytes < 0) return false;
    const current = this.captureBytesByScope.get(record.scopeId) ?? 0;
    if (
      this.cachedBytes + this.pendingCaptureBytes + bytes > this.maxCachedBytes ||
      (this.cachedBytesByTenant.get(record.tenantId) ?? 0) +
        (this.pendingCaptureBytesByTenant.get(record.tenantId) ?? 0) + bytes >
        this.maxCachedBytesPerTenant
    ) return false;
    this.captureBytesByScope.set(record.scopeId, current + bytes);
    this.pendingCaptureBytes += bytes;
    this.adjustPendingTenantBytes(record.tenantId, bytes);
    return true;
  }

  releaseCaptureBytes(
    record: IdempotencyRecord,
    generation: number,
    bytes: number,
    responseBytes = 0,
  ): void {
    if (
      !this.isCurrent(record, generation) ||
      !Number.isFinite(bytes) ||
      bytes <= 0 ||
      !Number.isFinite(responseBytes) ||
      responseBytes < 0
    ) return;
    const current = this.captureBytesByScope.get(record.scopeId) ?? 0;
    const released = Math.min(current, bytes);
    const remaining = current - released;
    if (remaining === 0) this.captureBytesByScope.delete(record.scopeId);
    else this.captureBytesByScope.set(record.scopeId, remaining);
    const capturedResponseBytes = this.responseBytesByScope.get(record.scopeId) ?? 0;
    // Body bytes, per-chunk overhead, and temporary validation/assembly bytes
    // share the memory reservation but only body bytes count toward response
    // size limits.
    const releasedResponseBytes = Math.min(capturedResponseBytes, responseBytes, released);
    const remainingResponseBytes = capturedResponseBytes - releasedResponseBytes;
    if (remainingResponseBytes === 0) this.responseBytesByScope.delete(record.scopeId);
    else this.responseBytesByScope.set(record.scopeId, remainingResponseBytes);
    this.pendingCaptureBytes = Math.max(0, this.pendingCaptureBytes - released);
    this.adjustPendingTenantBytes(record.tenantId, -released);
  }

  releaseCapture(record: IdempotencyRecord, generation: number): void {
    if (!this.isCurrent(record, generation)) return;
    const bytes = this.captureBytesByScope.get(record.scopeId) ?? 0;
    this.captureBytesByScope.delete(record.scopeId);
    this.responseBytesByScope.delete(record.scopeId);
    this.pendingCaptureBytes = Math.max(0, this.pendingCaptureBytes - bytes);
    this.adjustPendingTenantBytes(record.tenantId, -bytes);
  }

  markUnknown(record: IdempotencyRecord, generation: number): void {
    if (!this.isCurrent(record, generation)) return;
    this.releaseCapture(record, generation);
    this.removeCachedResponse(record);
    record.state = 'unknown';
    record.wireResponse = null;
    record.resultConfirmed = false;
    record.confirmedAssistantMessageId = null;
    record.generation += 1;
    this.touch(record);
  }

  /**
   * Store a caller-owned response without retaining an aliased Buffer. The
   * registry reserves the clone before allocating it, so temporary storage is
   * included in the configured memory bound.
   */
  complete(
    record: IdempotencyRecord,
    generation: number,
    state: 'completed' | 'failed',
    response: IdempotencyWireResponse,
  ): boolean {
    if (!this.isCurrent(record, generation)) return false;
    const responseBytes = response.body.byteLength;
    const storageBytes = idempotencyResponseStorageBytes(response);
    if (responseBytes > this.maxResponseBytes || !this.reserveAssemblyBytes(record, generation, storageBytes)) {
      if (record.submitted) this.markUnknown(record, generation);
      else this.abandon(record, generation);
      return false;
    }
    let ownedResponse: IdempotencyWireResponse;
    try {
      ownedResponse = { ...response, headers: copyHeaders(response.headers), body: Buffer.from(response.body) };
    } catch {
      if (record.submitted) this.markUnknown(record, generation);
      else this.abandon(record, generation);
      return false;
    }
    return this.commitComplete(record, generation, state, ownedResponse);
  }

  /** Commit an assembled body whose allocation is already reserved by capture. */
  completeCaptured(
    record: IdempotencyRecord,
    generation: number,
    state: 'completed' | 'failed',
    response: IdempotencyWireResponse,
  ): boolean {
    return this.commitComplete(record, generation, state, response);
  }

  private commitComplete(
    record: IdempotencyRecord,
    generation: number,
    state: 'completed' | 'failed',
    response: IdempotencyWireResponse,
  ): boolean {
    if (!this.isCurrent(record, generation)) return false;
    const priorBytes = record.wireResponse ? idempotencyResponseStorageBytes(record.wireResponse) : 0;
    const responseBytes = response.body.byteLength;
    const storageBytes = idempotencyResponseStorageBytes(response);
    const captureBytes = this.captureBytesByScope.get(record.scopeId) ?? 0;
    if (
      responseBytes > this.maxResponseBytes ||
      this.cachedBytes - priorBytes + this.pendingCaptureBytes - captureBytes + storageBytes > this.maxCachedBytes ||
      (this.cachedBytesByTenant.get(record.tenantId) ?? 0) - priorBytes +
        (this.pendingCaptureBytesByTenant.get(record.tenantId) ?? 0) - captureBytes + storageBytes >
        this.maxCachedBytesPerTenant
    ) {
      if (record.submitted) this.markUnknown(record, generation);
      else this.abandon(record, generation);
      return false;
    }
    this.releaseCapture(record, generation);
    this.cachedBytes += storageBytes - priorBytes;
    this.adjustCachedTenantBytes(record.tenantId, storageBytes - priorBytes);
    this.adjustTenantLiveCount(record.tenantId, -1);
    this.adjustCount(this.retainedEntriesByTenant, record.tenantId, 1);
    record.state = state;
    record.wireResponse = response;
    this.touch(record);
    return true;
  }

  get(scopeId: string): IdempotencyRecord | null {
    this.pruneExpired();
    return this.entries.get(scopeId) ?? null;
  }

  get size(): number {
    this.pruneExpired();
    return this.entries.size;
  }

  get retainedResponseBytes(): number {
    return this.cachedBytes;
  }

  get pendingResponseBytes(): number {
    return this.pendingCaptureBytes;
  }

  getTenantRetainedEntries(tenantId: string): number {
    return this.retainedEntriesByTenant.get(tenantId) ?? 0;
  }

  getTenantRetainedResponseBytes(tenantId: string): number {
    return this.cachedBytesByTenant.get(tenantId) ?? 0;
  }

  getTenantPendingResponseBytes(tenantId: string): number {
    return this.pendingCaptureBytesByTenant.get(tenantId) ?? 0;
  }

  private touch(record: IdempotencyRecord): void {
    record.updatedAt = this.now();
    record.expiresAt = this.now() + this.ttlMs;
  }

  private adjustTenantLiveCount(tenantId: string, delta: number): void {
    this.adjustCount(this.liveEntriesByTenant, tenantId, delta);
  }

  private adjustCount(map: Map<string, number>, tenantId: string, delta: number): void {
    const count = Math.max(0, (map.get(tenantId) ?? 0) + delta);
    if (count === 0) map.delete(tenantId);
    else map.set(tenantId, count);
  }

  private adjustPendingTenantBytes(tenantId: string, delta: number): void {
    this.adjustCount(this.pendingCaptureBytesByTenant, tenantId, delta);
  }

  private adjustCachedTenantBytes(tenantId: string, delta: number): void {
    this.adjustCount(this.cachedBytesByTenant, tenantId, delta);
  }

  private removeCachedResponse(record: IdempotencyRecord): void {
    const bytes = record.wireResponse ? idempotencyResponseStorageBytes(record.wireResponse) : 0;
    this.cachedBytes = Math.max(0, this.cachedBytes - bytes);
    this.adjustCachedTenantBytes(record.tenantId, -bytes);
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [scopeId, record] of this.entries) {
      // A hung live request must not expire and admit a second prompt. It is
      // bounded by maxEntries and transitions when the response closes/ends.
      if (record.state === 'in_progress' || record.state === 'unknown') continue;
      if (record.expiresAt > now) continue;
      this.removeCachedResponse(record);
      this.adjustCount(this.retainedEntriesByTenant, record.tenantId, -1);
      this.adjustCount(this.tenantEntrySlots, record.tenantId, -1);
      this.entries.delete(scopeId);
    }
  }
}
