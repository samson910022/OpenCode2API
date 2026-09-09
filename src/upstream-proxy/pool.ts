// Lazy upstream-proxy pool: direct by default, proxy only while engaged.
//
// Engagement is triggered exclusively by free/Go quota exhaustion
// (see isFreeUsageLimitError in ../errors/upstream.ts). Ordinary 5xx /
// transport errors keep the existing direct-retry path and never engage.
//
// Loopback targets (localhost/127.0.0.1/::1) always bypass the proxy so the
// default managed backend (`http://127.0.0.1:10001`) is never proxied.
//
// undici is loaded lazily (dynamic import) so hosts on older Node keep
// running direct-only: only actual proxy engagement needs it, and a load
// failure fails open to direct with a warning.
import type { Dispatcher } from 'undici';

export type ProxyStrategy = 'failover-rr' | 'round-robin' | 'random';
// NOTE: `failover-rr` and `round-robin` are aliases (both advance round-robin
// across engagements; transport failures always fail over to the next healthy
// proxy). Kept as separate names for forward compatibility.

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function maskProxyUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '(invalid)';
  }
}

function isSupportedProxyUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return ['http:', 'https:', 'socks:', 'socks5:', 'socks5h:'].includes(u.protocol) && Boolean(u.hostname);
  } catch {
    return false;
  }
}

/** Parse comma-separated / array proxy sources into validated URL strings.
 * Stable socks-first ordering: socks* entries keep their relative order and
 * move ahead of http(s) ones (SOCKS5 is the preferred egress). */
export function parseProxyList(value: unknown): string[] {
  const raw: unknown[] = Array.isArray(value) ? (value as unknown[]) : [value];
  const out: string[] = [];
  const push = (entry: unknown): void => {
    if (typeof entry !== 'string') return;
    for (const part of entry.split(',')) {
      const t = part.trim();
      if (t && isSupportedProxyUrl(t) && !out.includes(t)) out.push(t);
    }
  };
  for (const entry of raw) {
    if (Array.isArray(entry)) {
      for (const nested of entry as unknown[]) push(nested);
      continue;
    }
    push(entry);
  }
  const isSocks = (url: string): boolean => {
    try {
      const p = new URL(url).protocol;
      return p === 'socks:' || p === 'socks5:' || p === 'socks5h:';
    } catch {
      return false;
    }
  };
  // Array.prototype.sort is stable: relative order within each class is kept.
  out.sort((a, b) => Number(!isSocks(a)) - Number(!isSocks(b)));
  return out;
}

export function parseProxyNoProxyList(value: unknown, fallback: string[]): string[] {
  if (value === undefined || value === null || value === '') return [...fallback];
  const list = (Array.isArray(value) ? (value as unknown[]) : String(value).split(','))
    .map((e) => {
      const t = String(e ?? '').trim().toLowerCase();
      return t.startsWith('[') && t.endsWith(']') ? t.slice(1, -1) : t;
    })
    .filter(Boolean);
  return list.length > 0 ? [...new Set(list)] : [...fallback];
}

export const DEFAULT_PROXY_NO_PROXY = ['localhost', '127.0.0.1', '::1'];
export const DEFAULT_PROXY_COOLDOWN_MS = 300000;
export const DEFAULT_PROXY_STRATEGY: ProxyStrategy = 'failover-rr';

/** Allow-list the strategy at the config layer so the stored value is always real. */
export function normalizeProxyStrategy(value: unknown): ProxyStrategy {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return v === 'round-robin' || v === 'random' || v === 'failover-rr' ? (v as ProxyStrategy) : DEFAULT_PROXY_STRATEGY;
}

/** Clamp the cooldown at the config layer (positive finite, else default). */
export function normalizeProxyCooldownMs(value: unknown): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && (n as number) > 0 ? Math.floor(n as number) : DEFAULT_PROXY_COOLDOWN_MS;
}

export interface ProxyPoolOptions {
  proxies?: unknown;
  strategy?: unknown;
  cooldownMs?: unknown;
  noProxy?: unknown;
  logDebug?: (...args: unknown[]) => void;
}

export interface ProxyPoolStatus {
  configured: number;
  engaged: boolean;
  engagedUntil: number | null;
  current: string | null;
  cooled: Array<{ proxy: string; until: number }>;
}

export interface UpstreamProxyPool {
  readonly size: number;
  hasProxies: () => boolean;
  isEngaged: () => boolean;
  engage: (reason?: string) => string | null;
  disengage: () => void;
  proxiedFetch: (input: unknown, init?: unknown) => Promise<unknown>;
  getStatus: () => ProxyPoolStatus;
}

function targetHost(input: unknown): string {
  const normalize = (h: string): string => {
    const t = h.trim().toLowerCase();
    // WHATWG URL keeps IPv6 brackets in hostname ("[::1]"); strip them so
    // the loopback/no-proxy comparison hits.
    return t.startsWith('[') && t.endsWith(']') ? t.slice(1, -1) : t;
  };
  try {
    if (typeof input === 'string') return normalize(new URL(input).hostname);
    const req = input as { url?: unknown };
    if (typeof req?.url === 'string') return normalize(new URL(req.url).hostname);
  } catch {
    // fall through
  }
  return '';
}

export function createProxyPool(options: ProxyPoolOptions = {}): UpstreamProxyPool {
  const proxies = parseProxyList(options.proxies);
  const strategy = normalizeProxyStrategy(options.strategy);
  const cooldownMs = normalizeProxyCooldownMs(options.cooldownMs);
  const noProxy = new Set(parseProxyNoProxyList(options.noProxy, DEFAULT_PROXY_NO_PROXY));
  const logDebug = typeof options.logDebug === 'function' ? options.logDebug : (): void => {};
  // NOTE: undici logs an ExperimentalWarning for SOCKS5 support on first use;
  // expected and harmless (see pool docs).

  const dispatchers = new Map<string, Dispatcher>();
  const cooledUntil = new Map<string, number>();
  let cursor = 0;
  let engagedUntil = 0;
  let current: string | null = null;

  // Cached dynamic import: resolved at most once; a rejection (e.g. Node too
  // old for undici) is memorized so every proxied call fails open to direct.
  let undiciModule: {
    ProxyAgent: new (url: string) => Dispatcher;
    Socks5ProxyAgent: new (url: string) => Dispatcher;
    fetch: (input: unknown, init?: unknown) => Promise<unknown>;
  } | null = null;
  let undiciFailed = false;
  const loadUndici = async (): Promise<typeof undiciModule> => {
    if (undiciModule || undiciFailed) return undiciModule;
    try {
      const mod = (await import('undici')) as unknown as NonNullable<typeof undiciModule>;
      undiciModule = mod;
      return mod;
    } catch (err) {
      undiciFailed = true;
      logDebug('Upstream proxy runtime unavailable, staying direct', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };

  const getDispatcher = async (proxyUrl: string): Promise<Dispatcher | null> => {
    const hit = dispatchers.get(proxyUrl);
    if (hit) return hit;
    const mod = await loadUndici();
    if (!mod) return null;
    const protocol = new URL(proxyUrl).protocol;
    const agent: Dispatcher =
      protocol === 'socks:' || protocol === 'socks5:' || protocol === 'socks5h:'
        ? new mod.Socks5ProxyAgent(proxyUrl)
        : new mod.ProxyAgent(proxyUrl);
    dispatchers.set(proxyUrl, agent);
    return agent;
  };

  const healthy = (now: number): string[] => proxies.filter((p) => (cooledUntil.get(p) ?? 0) <= now);

  const pick = (): string | null => {
    if (proxies.length === 0) return null;
    const now = Date.now();
    let candidates = healthy(now);
    if (candidates.length === 0) {
      // All cooled: force the earliest-expiring one (never fully stall).
      let earliest: string | null = null;
      let earliestAt = Number.POSITIVE_INFINITY;
      for (const p of proxies) {
        const until = cooledUntil.get(p) ?? 0;
        if (until < earliestAt) {
          earliestAt = until;
          earliest = p;
        }
      }
      candidates = earliest ? [earliest] : [];
    }
    if (candidates.length === 0) return null;
    if (strategy === 'random') {
      return candidates[Math.floor(Math.random() * candidates.length)] as string;
    }
    const next = candidates[cursor % candidates.length] as string;
    cursor += 1;
    return next;
  };

  const cool = (proxyUrl: string, ms: number): void => {
    cooledUntil.set(proxyUrl, Date.now() + ms);
  };

  const pool: UpstreamProxyPool = {
    size: proxies.length,
    hasProxies: (): boolean => proxies.length > 0,
    isEngaged: (): boolean => proxies.length > 0 && Date.now() < engagedUntil,
    engage: (reason = 'free-limit'): string | null => {
      if (proxies.length === 0) return null;
      // Always advance: successive free-limit hits rotate to the next healthy
      // proxy (round-robin across retries/requests); sticky otherwise.
      const selected = pick();
      if (selected) current = selected;
      engagedUntil = Date.now() + cooldownMs;
      logDebug('Upstream proxy engaged', { reason, proxy: current ? maskProxyUrl(current) : null, strategy });
      return current ? maskProxyUrl(current) : null;
    },
    disengage: (): void => {
      engagedUntil = 0;
      current = null;
    },
    proxiedFetch: async (input: unknown, init?: unknown): Promise<unknown> => {
      const direct = (): Promise<unknown> =>
        (globalThis.fetch as (i: unknown, o?: unknown) => Promise<unknown>)(input as never, init as never);
      if (proxies.length === 0 || Date.now() >= engagedUntil) return direct();
      const host = targetHost(input);
      if (!host || LOOPBACK_HOSTS.has(host) || noProxy.has(host)) return direct();
      let proxyUrl = current && (cooledUntil.get(current) ?? 0) <= Date.now() ? current : pick();
      if (!proxyUrl) return direct();
      current = proxyUrl;
      try {
        const mod = await loadUndici();
        const dispatcher = proxyUrl ? await getDispatcher(proxyUrl) : null;
        if (!mod || !dispatcher) return direct();
        return await mod.fetch(input as never, {
          ...((init as Record<string, unknown>) ?? {}),
          dispatcher,
        } as never);
      } catch (err) {
        // Transport failure through this proxy: cool it, fail open to direct
        // for this call (quota errors are handled by callers, not here).
        cool(proxyUrl, Math.min(cooldownMs, 60000));
        logDebug('Upstream proxy transport failed, failing open to direct', {
          proxy: maskProxyUrl(proxyUrl),
          error: err instanceof Error ? err.message : String(err),
        });
        current = pick();
        return direct();
      }
    },
    getStatus: (): ProxyPoolStatus => {
      const now = Date.now();
      return {
        configured: proxies.length,
        engaged: proxies.length > 0 && now < engagedUntil,
        engagedUntil: now < engagedUntil ? engagedUntil : null,
        current: current ? maskProxyUrl(current) : null,
        cooled: [...cooledUntil.entries()]
          .filter(([, until]) => until > now)
          .map(([proxy, until]) => ({ proxy: maskProxyUrl(proxy), until })),
      };
    },
  };
  return pool;
}
