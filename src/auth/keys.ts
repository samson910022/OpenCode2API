// Pure multi-key auth helpers (no Express/SDK deps; safe for unit tests).
import { timingSafeEqual } from 'node:crypto';

/** Parse a single/list key source into a deduped, trimmed string array. */
export function parseApiKeyList(value: unknown): string[] {
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const entry of value as unknown[]) {
      if (entry === undefined || entry === null) continue;
      if (typeof entry === 'string') {
        const t = entry.trim();
        if (t && !out.includes(t)) out.push(t);
        continue;
      }
      if (typeof entry === 'object') {
        const rec = entry as Record<string, unknown>;
        const k: unknown = rec['key'];
        if (typeof k === 'string') {
          const t = k.trim();
          if (t && !out.includes(t)) out.push(t);
        }
        continue;
      }
      // numbers/booleans are ignored (never become keys)
    }
    return out;
  }
  if (typeof value === 'string') {
    const out: string[] = [];
    for (const part of value.split(',')) {
      const t = part.trim();
      if (t && !out.includes(t)) out.push(t);
    }
    return out;
  }
  return [];
}

/** Merge several key sources in priority order, deduped (first wins). */
export function mergeApiKeySources(...sources: unknown[]): string[] {
  const out: string[] = [];
  for (const src of sources) {
    for (const k of parseApiKeyList(src)) {
      if (!out.includes(k)) out.push(k);
    }
  }
  return out;
}

export interface MinimalHeaders {
  authorization?: unknown;
  'x-api-key'?: unknown;
}

export interface MinimalRequest {
  headers: MinimalHeaders;
}

/** Extract the presented token: `Authorization: Bearer <token>` (case-insensitive) or `x-api-key`. */
export function extractRequestToken(req: MinimalRequest): string | null {
  const tokens = getRequestTokens(req);
  return tokens.length > 0 ? (tokens[0] as string) : null;
}

/**
 * Collect all presented tokens (Bearer first, then every x-api-key value).
 * Preserves the legacy OR semantics: a request passes when ANY header matches.
 */
export function getRequestTokens(req: MinimalRequest): string[] {
  const headers = (req as { headers?: Record<string, unknown> })?.headers ?? {};
  const out: string[] = [];
  const authHeader: unknown = headers['authorization'];
  if (typeof authHeader === 'string') {
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    if (m && m[1] !== undefined) {
      const t = m[1].trim();
      if (t) out.push(t);
    }
  }
  const apiKeyHeader: unknown = headers['x-api-key'];
  if (typeof apiKeyHeader === 'string') {
    const t = apiKeyHeader.trim();
    if (t) out.push(t);
  }
  if (Array.isArray(apiKeyHeader)) {
    for (const h of apiKeyHeader as unknown[]) {
      if (typeof h === 'string' && h.trim()) out.push(h.trim());
    }
  }
  return out;
}

function timingSafeCompare(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

/** Constant-time membership check; returns the matched index or -1. */
export function findApiKeyIndex(token: string | null | undefined, keys: readonly string[]): number {
  if (!token || typeof token !== 'string') return -1;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (typeof k !== 'string' || !k) continue;
    if (timingSafeCompare(token, k)) return i;
  }
  return -1;
}

export function isValidApiKey(token: string | null | undefined, keys: readonly string[]): boolean {
  return findApiKeyIndex(token, keys) >= 0;
}

/**
 * OR-membership check across every presented token; returns the matched
 * key index or -1. Either `Authorization: Bearer` or `x-api-key` may match
 * (legacy OR semantics preserved).
 */
export function findMatchedApiKeyIndex(req: MinimalRequest, keys: readonly string[]): number {
  if (!Array.isArray(keys) || keys.length === 0) return -1;
  for (const token of getRequestTokens(req)) {
    const idx = findApiKeyIndex(token, keys);
    if (idx >= 0) return idx;
  }
  return -1;
}

/** Shared verifier: empty key list = no auth; otherwise any presented token must match. */
export function createApiKeyVerifier(keys: readonly string[]): {
  keys: string[];
  isAuthorized: (req: MinimalRequest) => boolean;
  matchedIndex: (req: MinimalRequest) => number;
} {
  const list = Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string' && k !== '') : [];
  return {
    keys: list,
    isAuthorized: (req: MinimalRequest): boolean => {
      if (list.length === 0) return true;
      return findMatchedApiKeyIndex(req, list) >= 0;
    },
    matchedIndex: (req: MinimalRequest): number => findMatchedApiKeyIndex(req, list),
  };
}

/**
 * Build the effective key list.
 * NOTE: argument order is (singleKey, multiKeys) for call-site readability,
 * but the merge priority is multiKeys-first so an explicit list wins
 * positionally over the legacy single value; both remain valid.
 */
export function buildEffectiveApiKeys(singleKey: unknown, multiKeys: unknown): string[] {
  return mergeApiKeySources(multiKeys, singleKey);
}

/** Log-safe placeholder (never echoes key material, even for short keys). */
export function maskApiKeyForLog(key: string): string {
  if (!key) return '(empty)';
  return `***(len=${key.length})`;
}
