// P4 TS: proxy config defaults + pure bool/config builders (ported from P3 .js, behavior identical).
import type { DisableToolsOptions, ProxyConfig, ProxyConfigOptions } from '../types/config.js';
import { mergeApiKeySources } from '../auth/keys.js';
import {
  DEFAULT_PROXY_COOLDOWN_MS,
  DEFAULT_PROXY_NO_PROXY,
  DEFAULT_PROXY_STRATEGY,
  PROXY_STRATEGIES,
  normalizeProxyCooldownMs,
  parseProxyList,
  parseProxyNoProxyList,
} from '../upstream-proxy/pool.js';
import { DEFAULT_MAX_RETRIES } from '../retry/policy.js';
import { TOOL_RISK_LEVELS } from '../tool-runtime/contracts.js';

export const DEFAULT_REQUEST_TIMEOUT_MS = 300000;
export const DEFAULT_POLL_INTERVAL_MS = 500;
export const DEFAULT_PROXY_PORT = 10000;
export const DEFAULT_SERVER_PORT = 10001;
export const DEFAULT_BIND_HOST = '0.0.0.0';
export const DEFAULT_OPENCODE_PATH = 'opencode';
export const DEFAULT_PROMPT_MODE = 'standard';
export const DEFAULT_CLEANUP_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_CLEANUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_EXTERNAL_TOOLS_MODE = 'proxy-bridge';
export const DEFAULT_EXTERNAL_TOOLS_CONFLICT_POLICY = 'namespace';
export const EXTERNAL_TOOLS_MODES: readonly string[] = ['proxy-bridge'];
export const EXTERNAL_TOOLS_CONFLICT_POLICIES: readonly string[] = ['namespace'];
export const EXTERNAL_TOOL_POLICY_MODES: readonly string[] = ['enforce', 'report-only'];
export const DEFAULT_EXTERNAL_TOOL_POLICY_MODE = 'enforce';
export const EXTERNAL_TOOL_RISK_LEVEL_VALUES: readonly string[] = Object.values(TOOL_RISK_LEVELS);
export const DEFAULT_EXTERNAL_TOOL_DEFAULT_RISK_LEVEL: string = TOOL_RISK_LEVELS.LOW;
export const MAX_PORT = 65535;
export const MIN_PORT = 1;
// Retry policy (ported from upstream opencode session/retry.ts; see src/retry/policy.ts).
// Total attempts = 1 + maxRetries; maxRetries defaults to 3, configurable via
// OPENCODE_PROXY_RETRY_MAX_RETRIES, hard-capped at 5 (upstream ceiling).
// Delays are exponential with jitter and honor retry-after headers.
// Reasoning models can take well over 10s before emitting their first token.
// A short window here makes the event stream give up and fall back to polling on
// every request, which loses true streaming. Configurable for slow backends.
export const DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS: number =
  Number(process.env['OPENCODE2API_EVENT_FIRST_DELTA_TIMEOUT_MS']) || 30000;
export const DEFAULT_EVENT_IDLE_TIMEOUT_MS: number =
  Number(process.env['OPENCODE2API_EVENT_IDLE_TIMEOUT_MS']) || 8000;

/**
 * Normalize a boolean-ish value. Returns true/false for recognized spellings,
 * undefined for missing/invalid values so callers can fall through with ??.
 * Numbers: only 0/1 are recognized (like '0'/'1'); any other number is
 * treated as unset so it never blocks a lower-priority source.
 */
export function normalizeBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
  }
  return undefined;
}

/**
 * Resolve the effective disable-tools flag.
 * Precedence: options.DISABLE_TOOLS > options.disableTools >
 * env OPENCODE_DISABLE_TOOLS (canonical) > env DISABLE_TOOLS (legacy alias
 * used by docker-compose/.env) > fallback.
 * Invalid values ('garbage', '', whitespace) are treated as unset and fall
 * through to the next source instead of coercing.
 */
export function resolveDisableTools(options?: unknown, fallback: boolean = false): boolean {
  const o = (options ?? {}) as DisableToolsOptions;
  const record = o as Record<string, unknown>;
  return (
    normalizeBool(record['DISABLE_TOOLS']) ??
    normalizeBool(record['disableTools']) ??
    normalizeBool(process.env['OPENCODE_DISABLE_TOOLS']) ??
    normalizeBool(process.env['DISABLE_TOOLS']) ??
    fallback
  );
}

export type ConfigLayers = readonly unknown[];

export function parseStrictInteger(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value === 'string') {
    const t = value.trim();
    if (!/^[+-]?\d+$/.test(t)) return undefined;
    const n = Number(t);
    return Number.isSafeInteger(n) ? n : undefined;
  }
  return undefined;
}

export function parseStrictPort(value: unknown): number | undefined {
  const n = parseStrictInteger(value);
  return n !== undefined && n >= MIN_PORT && n <= MAX_PORT ? n : undefined;
}

export function parseHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  if (!t) return undefined;
  try {
    const protocol = new URL(t).protocol;
    return protocol === 'http:' || protocol === 'https:' ? t : undefined;
  } catch {
    return undefined;
  }
}

export function parseToolNameList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return [...new Set((value as unknown[]).map((entry) => String(entry || '').trim()).filter(Boolean))];
  }
  if (typeof value === 'string') {
    if (!value.trim()) return undefined;
    return [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))];
  }
  return undefined;
}

export function resolveStringSetting(layers: ConfigLayers, fallback: string): string {
  for (const layer of layers) {
    if (typeof layer === 'string' && layer.trim()) return layer.trim();
  }
  return fallback;
}

export function resolveBoolSetting(layers: ConfigLayers, fallback: boolean): boolean {
  for (const layer of layers) {
    const normalized = normalizeBool(layer);
    if (normalized !== undefined) return normalized;
  }
  return fallback;
}

export function resolveIntSetting(layers: ConfigLayers, min: number, max: number, fallback: number): number {
  for (const layer of layers) {
    const n = parseStrictInteger(layer);
    if (n !== undefined && n >= min && n <= max) return n;
  }
  return fallback;
}

export function resolvePortSetting(layers: ConfigLayers, fallback: number): number {
  return resolveIntSetting(layers, MIN_PORT, MAX_PORT, fallback);
}

export function resolveDurationSetting(layers: ConfigLayers, fallback: number): number {
  return resolveIntSetting(layers, 1, Number.MAX_SAFE_INTEGER, fallback);
}

export function resolveRetryCountSetting(layers: ConfigLayers, fallback: number): number {
  return resolveIntSetting(layers, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, fallback);
}

export function resolveListSetting(layers: ConfigLayers, fallback: string[]): string[] {
  for (const layer of layers) {
    const parsed = parseToolNameList(layer);
    if (parsed !== undefined) return parsed;
  }
  return fallback;
}

export function resolveEnumSetting(layers: ConfigLayers, allowed: readonly string[], fallback: string): string {
  for (const layer of layers) {
    if (typeof layer !== 'string') continue;
    const t = layer.trim().toLowerCase();
    if (t && allowed.includes(t)) return t;
  }
  return fallback;
}

export function resolveUrlSetting(layers: ConfigLayers, fallback: string): string {
  for (const layer of layers) {
    const parsed = parseHttpUrl(layer);
    if (parsed !== undefined) return parsed;
  }
  return fallback;
}

/**
 * Race a promise against a timeout. The real outcome always wins: fast
 * resolutions/rejections settle the race immediately; only a never-settling
 * promise loses to the timer. A no-op handler is attached so a late rejection
 * can never surface as an unhandled rejection (which would terminate the
 * process under Node's default --unhandled-rejections=throw).
 * The timeout error message keeps the 'Request timeout' prefix so
 * transformUpstreamError maps it to 504 (not 500); the label is appended
 * for diagnosability.
 */
export function withTimeout(promise: unknown, timeoutMs: unknown, label: string = 'operation'): Promise<unknown> {
  const numericMs = Number(timeoutMs);
  const ms = Number.isFinite(numericMs) ? numericMs : DEFAULT_REQUEST_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Request timeout after ${ms}ms (${label})`)), ms);
  });
  const candidate = promise as { catch?: unknown } | null | undefined;
  if (candidate && typeof candidate.catch === 'function') {
    (candidate as Promise<unknown>).catch(() => {});
  }
  return Promise.race([promise as Promise<unknown>, timeoutPromise]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function readStringOption(options: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v: unknown = options[key];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

/**
 * Build the effective proxy config from caller options + env.
 * Layer order per key: caller options > env canonical > env legacy alias >
 * hardcoded default. Every layer is normalized first, so an invalid value
 * falls through to the next layer instead of coercing or shadowing it.
 */
export function buildProxyConfig(options: unknown = {}): ProxyConfig {
  // Also tolerate explicit null (the = {} default only covers undefined).
  const raw: ProxyConfigOptions = (options ?? {}) as ProxyConfigOptions;
  const opts = raw as Record<string, unknown>;
  const disableTools = resolveDisableTools(raw);

  const promptMode = resolveStringSetting(
    [opts['PROMPT_MODE'], opts['promptMode'], process.env['OPENCODE_PROXY_PROMPT_MODE']],
    DEFAULT_PROMPT_MODE,
  );
  const externalToolsModeOption = readStringOption(opts, ['EXTERNAL_TOOLS_MODE', 'externalToolsMode']);
  if (externalToolsModeOption !== undefined && !EXTERNAL_TOOLS_MODES.includes(externalToolsModeOption)) {
    throw new Error(
      `Unsupported EXTERNAL_TOOLS_MODE: ${externalToolsModeOption}. Supported value: ${EXTERNAL_TOOLS_MODES.join(', ')}`,
    );
  }
  const externalToolsMode =
    externalToolsModeOption ??
    resolveEnumSetting(
      [process.env['OPENCODE_EXTERNAL_TOOLS_MODE']],
      EXTERNAL_TOOLS_MODES,
      DEFAULT_EXTERNAL_TOOLS_MODE,
    );
  const externalToolsConflictPolicyOption = readStringOption(opts, [
    'EXTERNAL_TOOLS_CONFLICT_POLICY',
    'externalToolsConflictPolicy',
  ]);
  if (
    externalToolsConflictPolicyOption !== undefined &&
    !EXTERNAL_TOOLS_CONFLICT_POLICIES.includes(externalToolsConflictPolicyOption)
  ) {
    throw new Error(
      `Unsupported EXTERNAL_TOOLS_CONFLICT_POLICY: ${externalToolsConflictPolicyOption}. Supported value: ${EXTERNAL_TOOLS_CONFLICT_POLICIES.join(', ')}`,
    );
  }
  const externalToolsConflictPolicy =
    externalToolsConflictPolicyOption ??
    resolveEnumSetting(
      [process.env['OPENCODE_EXTERNAL_TOOLS_CONFLICT_POLICY']],
      EXTERNAL_TOOLS_CONFLICT_POLICIES,
      DEFAULT_EXTERNAL_TOOLS_CONFLICT_POLICY,
    );
  const serverPort = resolvePortSetting([process.env['OPENCODE_SERVER_PORT']], DEFAULT_SERVER_PORT);
  // Multi-key auth (A): caller options win as a whole layer; otherwise env.
  // Both the list (API_KEYS/OPENCODE_API_KEYS, comma-separated) and the legacy
  // single (API_KEY) merge with empty values ignored (never blocking).
  // NOTE: `!== undefined` is intentional — an explicitly passed empty value
  // isolates tests/Docker defaults from ambient env leakage.
  const optsProvidedKeys = opts['API_KEYS'] !== undefined || opts['API_KEY'] !== undefined;
  const resolvedApiKeys: string[] = optsProvidedKeys
    ? mergeApiKeySources(opts['API_KEYS'], opts['API_KEY'])
    : mergeApiKeySources(process.env['OPENCODE_API_KEYS'], process.env['API_KEYS'], process.env['API_KEY']);
  // Display single = first effective key (same rule as index.ts prod path).
  const resolvedApiKey: string = resolvedApiKeys[0] ?? '';
  const config: ProxyConfig = {
    PORT: resolvePortSetting([opts['PORT'], process.env['OPENCODE_PROXY_PORT'], process.env['PORT']], DEFAULT_PROXY_PORT),
    API_KEY: resolvedApiKey,
    API_KEYS: resolvedApiKeys,
    OPENCODE_SERVER_URL: resolveUrlSetting(
      [opts['OPENCODE_SERVER_URL'], process.env['OPENCODE_SERVER_URL']],
      `http://127.0.0.1:${serverPort}`,
    ),
    OPENCODE_SERVER_PASSWORD: resolveStringSetting(
      [opts['OPENCODE_SERVER_PASSWORD'], process.env['OPENCODE_SERVER_PASSWORD']],
      '',
    ),
    OPENCODE_PATH: resolveStringSetting([opts['OPENCODE_PATH'], process.env['OPENCODE_PATH']], DEFAULT_OPENCODE_PATH),
    BIND_HOST: resolveStringSetting(
      [opts['BIND_HOST'], opts['bindHost'], process.env['BIND_HOST'], process.env['OPENCODE_PROXY_BIND_HOST']],
      DEFAULT_BIND_HOST,
    ),
    USE_ISOLATED_HOME: resolveBoolSetting(
      [opts['USE_ISOLATED_HOME'], process.env['OPENCODE_USE_ISOLATED_HOME']],
      false,
    ),
    REQUEST_TIMEOUT_MS: resolveDurationSetting(
      [opts['REQUEST_TIMEOUT_MS'], process.env['OPENCODE_PROXY_REQUEST_TIMEOUT_MS']],
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    MANAGE_BACKEND: resolveBoolSetting([opts['MANAGE_BACKEND'], process.env['OPENCODE_PROXY_MANAGE_BACKEND']], true),
    DISABLE_TOOLS: disableTools,
    EXTERNAL_TOOLS_MODE: externalToolsMode,
    EXTERNAL_TOOLS_CONFLICT_POLICY: externalToolsConflictPolicy,
    EXTERNAL_TOOL_POLICY_MODE: resolveEnumSetting(
      [opts['EXTERNAL_TOOL_POLICY_MODE'], process.env['OPENCODE_EXTERNAL_TOOL_POLICY_MODE'], process.env['EXTERNAL_TOOL_POLICY_MODE']],
      EXTERNAL_TOOL_POLICY_MODES,
      DEFAULT_EXTERNAL_TOOL_POLICY_MODE,
    ),
    EXTERNAL_TOOL_DEFAULT_RISK_LEVEL: resolveEnumSetting(
      [
        opts['EXTERNAL_TOOL_DEFAULT_RISK_LEVEL'],
        process.env['OPENCODE_EXTERNAL_TOOL_DEFAULT_RISK_LEVEL'],
        process.env['EXTERNAL_TOOL_DEFAULT_RISK_LEVEL'],
      ],
      EXTERNAL_TOOL_RISK_LEVEL_VALUES,
      DEFAULT_EXTERNAL_TOOL_DEFAULT_RISK_LEVEL,
    ),
    EXTERNAL_TOOL_ALLOWLIST: resolveListSetting(
      [opts['EXTERNAL_TOOL_ALLOWLIST'], process.env['OPENCODE_EXTERNAL_TOOL_ALLOWLIST'], process.env['EXTERNAL_TOOL_ALLOWLIST']],
      [],
    ),
    EXTERNAL_TOOL_DENYLIST: resolveListSetting(
      [opts['EXTERNAL_TOOL_DENYLIST'], process.env['OPENCODE_EXTERNAL_TOOL_DENYLIST'], process.env['EXTERNAL_TOOL_DENYLIST']],
      [],
    ),
    EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR: resolveListSetting(
      [
        opts['EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR'],
        process.env['OPENCODE_EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR'],
        process.env['EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR'],
      ],
      [],
    ),
    INTERNAL_WEB_FETCH_ENABLED: resolveBoolSetting(
      [opts['INTERNAL_WEB_FETCH_ENABLED'], process.env['OPENCODE_INTERNAL_WEB_FETCH_ENABLED']],
      false,
    ),
    INTERNAL_ALLOWED_TOOLS: resolveListSetting(
      [opts['INTERNAL_ALLOWED_TOOLS'], process.env['OPENCODE_INTERNAL_ALLOWED_TOOLS']],
      [],
    ),
    INTERNAL_TOOL_METRICS_ENABLED: resolveBoolSetting(
      [opts['INTERNAL_TOOL_METRICS_ENABLED'], process.env['OPENCODE_INTERNAL_TOOL_METRICS_ENABLED']],
      true,
    ),
    INTERNAL_TOOL_DISCOVERY_FIXTURE: resolveListSetting(
      [opts['INTERNAL_TOOL_DISCOVERY_FIXTURE'], process.env['OPENCODE_TOOL_DISCOVERY_FIXTURE']],
      [],
    ),
    HEALTH_DETAILS_ENABLED: resolveBoolSetting(
      [opts['HEALTH_DETAILS_ENABLED'], process.env['OPENCODE_HEALTH_DETAILS_ENABLED']],
      true,
    ),
    HEALTH_DETAILS_REQUIRE_AUTH: resolveBoolSetting(
      [opts['HEALTH_DETAILS_REQUIRE_AUTH'], process.env['OPENCODE_HEALTH_DETAILS_REQUIRE_AUTH']],
      true,
    ),
    METRICS_ENABLED: resolveBoolSetting([opts['METRICS_ENABLED'], process.env['OPENCODE_METRICS_ENABLED']], false),
    METRICS_REQUIRE_AUTH: resolveBoolSetting(
      [opts['METRICS_REQUIRE_AUTH'], process.env['OPENCODE_METRICS_REQUIRE_AUTH']],
      true,
    ),
    DEBUG: resolveBoolSetting([opts['DEBUG'], process.env['OPENCODE_PROXY_DEBUG']], false),
    ZEN_API_KEY: resolveStringSetting([opts['ZEN_API_KEY'], process.env['OPENCODE_ZEN_API_KEY']], ''),
    PROMPT_MODE: promptMode,
    OMIT_SYSTEM_PROMPT: resolveBoolSetting(
      [opts['OMIT_SYSTEM_PROMPT'], process.env['OPENCODE_PROXY_OMIT_SYSTEM_PROMPT']],
      promptMode === 'plugin-inject',
    ),
    AUTO_CLEANUP_CONVERSATIONS: resolveBoolSetting(
      [opts['AUTO_CLEANUP_CONVERSATIONS'], process.env['OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS']],
      false,
    ),
    CLEANUP_INTERVAL_MS: resolveDurationSetting(
      [opts['CLEANUP_INTERVAL_MS'], process.env['OPENCODE_PROXY_CLEANUP_INTERVAL_MS']],
      DEFAULT_CLEANUP_INTERVAL_MS,
    ),
    CLEANUP_MAX_AGE_MS: resolveDurationSetting(
      [opts['CLEANUP_MAX_AGE_MS'], process.env['OPENCODE_PROXY_CLEANUP_MAX_AGE_MS']],
      DEFAULT_CLEANUP_MAX_AGE_MS,
    ),
    OPENCODE_HOME_BASE: resolveStringSetting([opts['OPENCODE_HOME_BASE']], '') || null,
    RETRY_MAX_RETRIES: resolveRetryCountSetting(
      [opts['RETRY_MAX_RETRIES'], process.env['OPENCODE_PROXY_RETRY_MAX_RETRIES'], process.env['RETRY_MAX_RETRIES']],
      DEFAULT_MAX_RETRIES,
    ),
    // Fallback proxy pool (P3): empty = direct-only (default, zero overhead).
    // Library path mirrors index.ts: explicit opts layer wins as a whole,
    // otherwise env (canonical OPENCODE_ name first, then legacy alias).
    UPSTREAM_PROXIES:
      opts['UPSTREAM_PROXIES'] !== undefined || opts['UPSTREAM_PROXY_URLS'] !== undefined
        ? parseProxyList([opts['UPSTREAM_PROXIES'], opts['UPSTREAM_PROXY_URLS']].flatMap((v) => (Array.isArray(v) ? v : [v])))
        : parseProxyList([process.env['OPENCODE_UPSTREAM_PROXIES'], process.env['UPSTREAM_PROXIES']]),
    UPSTREAM_PROXY_STRATEGY: resolveEnumSetting(
      [
        opts['UPSTREAM_PROXY_STRATEGY'],
        process.env['OPENCODE_UPSTREAM_PROXY_STRATEGY'],
        process.env['UPSTREAM_PROXY_STRATEGY'],
      ],
      PROXY_STRATEGIES,
      DEFAULT_PROXY_STRATEGY,
    ),
    UPSTREAM_PROXY_COOLDOWN_MS: normalizeProxyCooldownMs(
      resolveIntSetting(
        [
          opts['UPSTREAM_PROXY_COOLDOWN_MS'],
          process.env['OPENCODE_UPSTREAM_PROXY_COOLDOWN_MS'],
          process.env['UPSTREAM_PROXY_COOLDOWN_MS'],
        ],
        1,
        Number.MAX_SAFE_INTEGER,
        DEFAULT_PROXY_COOLDOWN_MS,
      ),
    ),
    UPSTREAM_PROXY_NO_PROXY: parseProxyNoProxyList(
      resolveListSetting(
        [opts['UPSTREAM_PROXY_NO_PROXY'], process.env['OPENCODE_UPSTREAM_PROXY_NO_PROXY'], process.env['UPSTREAM_PROXY_NO_PROXY']],
        [],
      ),
      DEFAULT_PROXY_NO_PROXY,
    ),
  };
  return config;
}
