// Free-limit → proxy-fallback glue (thin; routes call these at retry gates).
import { isFreeUsageLimitError, parseFreeLimitKind } from '../errors/upstream.js';
import type { UpstreamProxyPool } from './pool.js';

/**
 * True when this error should abandon the direct path and fail over to the
 * proxy pool (pool must be configured; loopback targets bypass regardless).
 */
export function shouldFallbackToProxy(error: unknown, pool: UpstreamProxyPool | null | undefined): boolean {
  if (!pool || !pool.hasProxies()) return false;
  return isFreeUsageLimitError(error);
}

/**
 * Engage the pool (rotates to the next healthy proxy) and warn once.
 * Returns true when fallback is active and the caller should retry via proxy.
 */
export function engageFallbackForFreeLimit(
  error: unknown,
  pool: UpstreamProxyPool | null | undefined,
  log?: (...args: unknown[]) => void,
): boolean {
  if (!shouldFallbackToProxy(error, pool)) return false;
  const kind = parseFreeLimitKind(error);
  const label = (pool as UpstreamProxyPool).engage(kind ?? 'free-limit');
  if (!label) return false;
  const warn = typeof log === 'function' ? log : console.warn;
  warn(`[Proxy] Free usage limit detected (${kind ?? 'free'}), failing over to proxy ${label}`);
  return true;
}
