// P4 TS: root entrypoint (ported from index.js, behavior identical).
import { startProxy, normalizeBool, resolveDisableTools } from './src/proxy.js';
import { resolveMaxRetries } from './src/retry/policy.js';
import { mergeApiKeySources } from './src/auth/keys.js';
import { DEFAULT_PROXY_COOLDOWN_MS, normalizeProxyCooldownMs, normalizeProxyStrategy, parseProxyList, parseProxyNoProxyList } from './src/upstream-proxy/pool.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import type { ProxyConfig } from './src/types/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
  }
  if (value === undefined || value === null) return fallback;
  return Boolean(value);
}

function parseToolAllowlist(value: unknown, fallback: string[] = []): string[] {
  if (Array.isArray(value)) {
    // NOTE: `||` (not `??`) matches the original JS verbatim: falsy entries
    // (0/false) stringify to '' and are filtered out instead of becoming
    // "0"/"false" allowlist entries.
    return [...new Set((value as unknown[]).map((entry) => String((entry as unknown) || '').trim()).filter(Boolean))];
  }
  if (typeof value === 'string') {
    return [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))];
  }
  if (value === undefined || value === null || value === '') return fallback;
  return fallback;
}

function parsePort(value: unknown, fallback: number): number {
  const n = typeof value === 'string' || typeof value === 'number' ? parseInt(String(value), 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Resolve the multi-key list for one layer: canonical list + legacy aliases merge (empty never blocks). */
function parseApiKeys(...sources: unknown[]): string[] {
  return mergeApiKeySources(...sources);
}

// Default configuration
const defaultConfig = {
  PORT: parsePort(process.env['OPENCODE_PROXY_PORT'], 10000),
  API_KEY: '',
  API_KEYS: [] as string[],
  OPENCODE_SERVER_URL: `http://127.0.0.1:${process.env['OPENCODE_SERVER_PORT'] || 10001}`,
  OPENCODE_SERVER_PASSWORD: process.env['OPENCODE_SERVER_PASSWORD'] || '',
  MANAGE_BACKEND: parseBool(process.env['OPENCODE_PROXY_MANAGE_BACKEND'], false),
  OPENCODE_PATH: 'opencode',
  BIND_HOST: '0.0.0.0',
  DISABLE_TOOLS: true,
  EXTERNAL_TOOLS_MODE: 'proxy-bridge',
  EXTERNAL_TOOLS_CONFLICT_POLICY: 'namespace',
  INTERNAL_WEB_FETCH_ENABLED: parseBool(process.env['OPENCODE_INTERNAL_WEB_FETCH_ENABLED'], false),
  INTERNAL_ALLOWED_TOOLS: parseToolAllowlist(process.env['OPENCODE_INTERNAL_ALLOWED_TOOLS'], []),
  INTERNAL_TOOL_METRICS_ENABLED: parseBool(process.env['OPENCODE_INTERNAL_TOOL_METRICS_ENABLED'], true),
  INTERNAL_TOOL_DISCOVERY_FIXTURE: parseToolAllowlist(process.env['OPENCODE_TOOL_DISCOVERY_FIXTURE'], []),
  HEALTH_DETAILS_ENABLED: parseBool(process.env['OPENCODE_HEALTH_DETAILS_ENABLED'], true),
  HEALTH_DETAILS_REQUIRE_AUTH: parseBool(process.env['OPENCODE_HEALTH_DETAILS_REQUIRE_AUTH'], true),
  METRICS_ENABLED: parseBool(process.env['OPENCODE_METRICS_ENABLED'], false),
  METRICS_REQUIRE_AUTH: parseBool(process.env['OPENCODE_METRICS_REQUIRE_AUTH'], true),
  PROMPT_MODE: process.env['OPENCODE_PROXY_PROMPT_MODE'] || 'standard',
  OMIT_SYSTEM_PROMPT: parseBool(process.env['OPENCODE_PROXY_OMIT_SYSTEM_PROMPT'], false),
  AUTO_CLEANUP_CONVERSATIONS: parseBool(process.env['OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS'], false),
  CLEANUP_INTERVAL_MS: parsePort(process.env['OPENCODE_PROXY_CLEANUP_INTERVAL_MS'], 43200000),
  CLEANUP_MAX_AGE_MS: parsePort(process.env['OPENCODE_PROXY_CLEANUP_MAX_AGE_MS'], 86400000),
  UPSTREAM_PROXIES: parseProxyList([process.env['OPENCODE_UPSTREAM_PROXIES'], process.env['UPSTREAM_PROXIES']]),
  UPSTREAM_PROXY_STRATEGY: 'failover-rr',
  UPSTREAM_PROXY_COOLDOWN_MS: DEFAULT_PROXY_COOLDOWN_MS,
  UPSTREAM_PROXY_NO_PROXY: parseProxyNoProxyList(
    process.env['OPENCODE_UPSTREAM_PROXY_NO_PROXY'] ?? process.env['UPSTREAM_PROXY_NO_PROXY'],
    ['localhost', '127.0.0.1', '::1'],
  ),
};

// Load config from file.
// NOTE: the lookup covers both layouts because the compiled entry moves:
//   - dev (`tsx index.ts` / repo root): <root>/config.json
//   - prod (`node dist/index.js`): <root>/dist/config.json (sibling) and
//     <root>/config.json (parent) — Docker mounts config at WORKDIR root,
//     and .dockerignore keeps local dist/ out of the image.
const configCandidates = [
  path.join(__dirname, 'config.json'),
  path.join(__dirname, '..', 'config.json'),
  path.join(process.cwd(), 'config.json'),
];
const configPath = configCandidates.find((p) => fs.existsSync(p));
let fileConfig: Record<string, unknown> = {};

if (configPath) {
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    fileConfig = JSON.parse(content) as Record<string, unknown>;
    console.log(`[Config] Loaded from ${configPath}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Config] Error parsing ${configPath}:`, msg);
  }
}

function readFileString(key: string, fallback: string): string {
  const v: unknown = fileConfig[key];
  return typeof v === 'string' && v ? v : fallback;
}

function readFileNumber(key: string, fallback: number): number {
  const v: unknown = fileConfig[key];
  // NOTE: `0` falls through to fallback to match the original
  // `fileConfig.X || default` semantics verbatim.
  if (typeof v === 'number' && Number.isFinite(v) && v !== 0) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

// Merge configs: env > file > default
// Auth layers resolve independently; the env layer wins as a whole so a stale
// file single-key can never pollute (or resurrect after rotation of) an
// explicitly configured env list. Empty strings never block lower sources.
const envApiKeys = parseApiKeys(process.env['OPENCODE_API_KEYS'], process.env['API_KEYS'], process.env['API_KEY']);
const fileApiKeys = parseApiKeys(fileConfig['API_KEYS'], fileConfig['API_KEY']);
const resolvedApiKeys = envApiKeys.length > 0 ? envApiKeys : fileApiKeys;
const finalConfig: ProxyConfig = {  PORT:
    parsePort(process.env['OPENCODE_PROXY_PORT'], NaN) ||
    parsePort(process.env['PORT'], NaN) ||
    readFileNumber('PORT', defaultConfig.PORT),
  API_KEY: resolvedApiKeys[0] ?? '',
  API_KEYS: resolvedApiKeys,
  OPENCODE_SERVER_URL: process.env['OPENCODE_SERVER_URL'] || readFileString('OPENCODE_SERVER_URL', defaultConfig.OPENCODE_SERVER_URL),
  OPENCODE_SERVER_PASSWORD:
    process.env['OPENCODE_SERVER_PASSWORD'] || readFileString('OPENCODE_SERVER_PASSWORD', defaultConfig.OPENCODE_SERVER_PASSWORD),
  MANAGE_BACKEND: parseBool(
    process.env['OPENCODE_PROXY_MANAGE_BACKEND'],
    parseBool(fileConfig['MANAGE_BACKEND'], defaultConfig.MANAGE_BACKEND),
  ),
  OPENCODE_PATH: process.env['OPENCODE_PATH'] || readFileString('OPENCODE_PATH', defaultConfig.OPENCODE_PATH),
  BIND_HOST:
    process.env['BIND_HOST'] ||
    process.env['OPENCODE_PROXY_BIND_HOST'] ||
    readFileString('BIND_HOST', defaultConfig.BIND_HOST),
  // Single contract via resolveDisableTools: env canonical > env legacy
  // alias > file > default. Each source is normalized first so invalid
  // values ('', 'garbage') fall through instead of blocking lower sources.
  DISABLE_TOOLS: resolveDisableTools(
    {
      DISABLE_TOOLS: process.env['OPENCODE_DISABLE_TOOLS'],
      disableTools: process.env['DISABLE_TOOLS'],
    },
    (normalizeBool(fileConfig['DISABLE_TOOLS']) ?? defaultConfig.DISABLE_TOOLS) as boolean,
  ),
  EXTERNAL_TOOLS_MODE:
    process.env['OPENCODE_EXTERNAL_TOOLS_MODE'] || readFileString('EXTERNAL_TOOLS_MODE', defaultConfig.EXTERNAL_TOOLS_MODE),
  EXTERNAL_TOOLS_CONFLICT_POLICY:
    process.env['OPENCODE_EXTERNAL_TOOLS_CONFLICT_POLICY'] ||
    readFileString('EXTERNAL_TOOLS_CONFLICT_POLICY', defaultConfig.EXTERNAL_TOOLS_CONFLICT_POLICY),
  INTERNAL_WEB_FETCH_ENABLED: parseBool(
    process.env['OPENCODE_INTERNAL_WEB_FETCH_ENABLED'],
    parseBool(fileConfig['INTERNAL_WEB_FETCH_ENABLED'], defaultConfig.INTERNAL_WEB_FETCH_ENABLED),
  ),
  INTERNAL_ALLOWED_TOOLS: parseToolAllowlist(
    process.env['OPENCODE_INTERNAL_ALLOWED_TOOLS'],
    parseToolAllowlist(fileConfig['INTERNAL_ALLOWED_TOOLS'], defaultConfig.INTERNAL_ALLOWED_TOOLS),
  ),
  INTERNAL_TOOL_METRICS_ENABLED: parseBool(
    process.env['OPENCODE_INTERNAL_TOOL_METRICS_ENABLED'],
    parseBool(fileConfig['INTERNAL_TOOL_METRICS_ENABLED'], defaultConfig.INTERNAL_TOOL_METRICS_ENABLED),
  ),
  INTERNAL_TOOL_DISCOVERY_FIXTURE: parseToolAllowlist(
    process.env['OPENCODE_TOOL_DISCOVERY_FIXTURE'],
    parseToolAllowlist(fileConfig['INTERNAL_TOOL_DISCOVERY_FIXTURE'], defaultConfig.INTERNAL_TOOL_DISCOVERY_FIXTURE),
  ),
  HEALTH_DETAILS_ENABLED: parseBool(
    process.env['OPENCODE_HEALTH_DETAILS_ENABLED'],
    parseBool(fileConfig['HEALTH_DETAILS_ENABLED'], defaultConfig.HEALTH_DETAILS_ENABLED),
  ),
  HEALTH_DETAILS_REQUIRE_AUTH: parseBool(
    process.env['OPENCODE_HEALTH_DETAILS_REQUIRE_AUTH'],
    parseBool(fileConfig['HEALTH_DETAILS_REQUIRE_AUTH'], defaultConfig.HEALTH_DETAILS_REQUIRE_AUTH),
  ),
  METRICS_ENABLED: parseBool(
    process.env['OPENCODE_METRICS_ENABLED'],
    parseBool(fileConfig['METRICS_ENABLED'], defaultConfig.METRICS_ENABLED),
  ),
  METRICS_REQUIRE_AUTH: parseBool(
    process.env['OPENCODE_METRICS_REQUIRE_AUTH'],
    parseBool(fileConfig['METRICS_REQUIRE_AUTH'], defaultConfig.METRICS_REQUIRE_AUTH),
  ),
  USE_ISOLATED_HOME: parseBool(process.env['OPENCODE_USE_ISOLATED_HOME'], parseBool(fileConfig['USE_ISOLATED_HOME'], false)),
  REQUEST_TIMEOUT_MS: parsePort(process.env['OPENCODE_PROXY_REQUEST_TIMEOUT_MS'], 0) || readFileNumber('REQUEST_TIMEOUT_MS', 180000),
  RETRY_MAX_RETRIES: process.env['OPENCODE_PROXY_RETRY_MAX_RETRIES'] ?? fileConfig['RETRY_MAX_RETRIES'] ?? 3,
  DEBUG: parseBool(process.env['OPENCODE_PROXY_DEBUG'], parseBool(fileConfig['DEBUG'], false)),
  ZEN_API_KEY: process.env['OPENCODE_ZEN_API_KEY'] || readFileString('ZEN_API_KEY', ''),
  PROMPT_MODE: process.env['OPENCODE_PROXY_PROMPT_MODE'] || readFileString('PROMPT_MODE', defaultConfig.PROMPT_MODE),
  OMIT_SYSTEM_PROMPT: parseBool(
    process.env['OPENCODE_PROXY_OMIT_SYSTEM_PROMPT'],
    parseBool(fileConfig['OMIT_SYSTEM_PROMPT'], defaultConfig.OMIT_SYSTEM_PROMPT),
  ),
  AUTO_CLEANUP_CONVERSATIONS: parseBool(
    process.env['OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS'],
    parseBool(fileConfig['AUTO_CLEANUP_CONVERSATIONS'], defaultConfig.AUTO_CLEANUP_CONVERSATIONS),
  ),
  CLEANUP_INTERVAL_MS:
    parsePort(process.env['OPENCODE_PROXY_CLEANUP_INTERVAL_MS'], 0) ||
    readFileNumber('CLEANUP_INTERVAL_MS', defaultConfig.CLEANUP_INTERVAL_MS),
  CLEANUP_MAX_AGE_MS:
    parsePort(process.env['OPENCODE_PROXY_CLEANUP_MAX_AGE_MS'], 0) ||
    readFileNumber('CLEANUP_MAX_AGE_MS', defaultConfig.CLEANUP_MAX_AGE_MS),
  OPENCODE_HOME_BASE: null,
  // Fallback proxy pool (P3): env layer wins as a whole, then file, then default.
  // Empty = direct-only (default, zero overhead; engagable only on free-limit).
  UPSTREAM_PROXIES: (() => {
    const env = parseProxyList([process.env['OPENCODE_UPSTREAM_PROXIES'], process.env['UPSTREAM_PROXIES']]);
    if (env.length > 0) return env;
    const file = parseProxyList(fileConfig['UPSTREAM_PROXIES']);
    return file.length > 0 ? file : [...defaultConfig.UPSTREAM_PROXIES];
  })(),
  UPSTREAM_PROXY_STRATEGY: normalizeProxyStrategy(
    process.env['OPENCODE_UPSTREAM_PROXY_STRATEGY'] ||
      readFileString('UPSTREAM_PROXY_STRATEGY', defaultConfig.UPSTREAM_PROXY_STRATEGY),
  ),
  UPSTREAM_PROXY_COOLDOWN_MS: normalizeProxyCooldownMs(
    parsePort(process.env['OPENCODE_UPSTREAM_PROXY_COOLDOWN_MS'], 0) ||
      readFileNumber('UPSTREAM_PROXY_COOLDOWN_MS', defaultConfig.UPSTREAM_PROXY_COOLDOWN_MS),
  ),
  UPSTREAM_PROXY_NO_PROXY: parseProxyNoProxyList(
    process.env['OPENCODE_UPSTREAM_PROXY_NO_PROXY'] ?? process.env['UPSTREAM_PROXY_NO_PROXY'] ?? fileConfig['UPSTREAM_PROXY_NO_PROXY'],
    defaultConfig.UPSTREAM_PROXY_NO_PROXY,
  ),
};

// Validate required configuration
if (!finalConfig.OPENCODE_PATH) {
  console.error('[Error] OPENCODE_PATH is not set. Please configure it in config.json or environment variable.');
  process.exit(1);
}

// Check if opencode is available
try {
  execSync(`"${finalConfig.OPENCODE_PATH}" --version`, { stdio: 'ignore' });
} catch {
  console.warn(`[Warning] Cannot verify OpenCode installation: ${finalConfig.OPENCODE_PATH}`);
  console.warn('[Warning] Please ensure OpenCode is installed:');
  console.warn('  Windows: npm install -g opencode-ai');
  console.warn('  Linux/macOS: curl -fsSL https://opencode.ai/install | bash');
  console.warn('[Warning] Or specify the full path in config.json:');
  console.warn('  { "OPENCODE_PATH": "C:\\\\Users\\\\YourName\\\\AppData\\\\Roaming\\\\npm\\\\opencode.cmd" }');
}

console.log('[Config] Starting with configuration:');
console.log(`  - Port: ${finalConfig.PORT}`);
console.log(`  - Bind Host: ${finalConfig.BIND_HOST}`);
console.log(`  - Backend: ${finalConfig.OPENCODE_SERVER_URL}`);
console.log(`  - Backend Password: ${finalConfig.OPENCODE_SERVER_PASSWORD ? 'Configured' : 'Not configured'}`);
console.log(`  - OpenCode Path: ${finalConfig.OPENCODE_PATH}`);
console.log(`  - API Key: ${finalConfig.API_KEY ? 'Configured' : 'Not configured (no auth)'}`);
console.log(
  `  - API Keys: ${finalConfig.API_KEYS.length > 0 ? `Configured (n=${finalConfig.API_KEYS.length})` : 'Not configured'}`,
);
console.log(
  `  - Fallback Proxies: ${finalConfig.UPSTREAM_PROXIES.length > 0 ? `Configured (n=${finalConfig.UPSTREAM_PROXIES.length}, ${finalConfig.UPSTREAM_PROXY_STRATEGY})` : 'Direct-only'}`,
);
console.log(`  - Zen API Key: ${finalConfig.ZEN_API_KEY ? 'Configured' : 'Not configured'}`);
console.log(`  - Disable Tools: ${finalConfig.DISABLE_TOOLS ? 'Yes' : 'No'}`);
console.log(`  - External Tools Mode: ${finalConfig.EXTERNAL_TOOLS_MODE}`);
console.log(`  - External Tools Conflict Policy: ${finalConfig.EXTERNAL_TOOLS_CONFLICT_POLICY}`);
console.log(`  - Internal web_fetch Enabled: ${finalConfig.INTERNAL_WEB_FETCH_ENABLED ? 'Yes' : 'No'}`);
console.log(
  `  - Internal Allowed Tools: ${finalConfig.INTERNAL_ALLOWED_TOOLS.length ? finalConfig.INTERNAL_ALLOWED_TOOLS.join(', ') : '(none)'}`,
);
console.log(`  - Internal Tool Metrics Enabled: ${finalConfig.INTERNAL_TOOL_METRICS_ENABLED ? 'Yes' : 'No'}`);
console.log(
  `  - Internal Tool Discovery Fixture: ${finalConfig.INTERNAL_TOOL_DISCOVERY_FIXTURE.length ? finalConfig.INTERNAL_TOOL_DISCOVERY_FIXTURE.join(', ') : '(none)'}`,
);
console.log(`  - Health Details Enabled: ${finalConfig.HEALTH_DETAILS_ENABLED ? 'Yes' : 'No'}`);
console.log(`  - Health Details Require Auth: ${finalConfig.HEALTH_DETAILS_REQUIRE_AUTH ? 'Yes' : 'No'}`);
console.log(`  - Metrics Enabled: ${finalConfig.METRICS_ENABLED ? 'Yes' : 'No'}`);
console.log(`  - Metrics Require Auth: ${finalConfig.METRICS_REQUIRE_AUTH ? 'Yes' : 'No'}`);
console.log(`  - Use Isolated Home: ${finalConfig.USE_ISOLATED_HOME ? 'Yes' : 'No'}`);
console.log(`  - Request Timeout: ${finalConfig.REQUEST_TIMEOUT_MS}ms`);
console.log(
  `  - Max Retries: ${resolveMaxRetries(finalConfig.RETRY_MAX_RETRIES)} (raw: ${String(finalConfig.RETRY_MAX_RETRIES)}, total attempts 1+n)`,
);
console.log(`  - Prompt Mode: ${finalConfig.PROMPT_MODE}`);
console.log(`  - Omit System Prompt: ${finalConfig.OMIT_SYSTEM_PROMPT ? 'Yes' : 'No'}`);
console.log(`  - Auto Cleanup Conversations: ${finalConfig.AUTO_CLEANUP_CONVERSATIONS ? 'Yes' : 'No'}`);
console.log(`  - Cleanup Interval: ${finalConfig.CLEANUP_INTERVAL_MS}ms`);
console.log(`  - Cleanup Max Age: ${finalConfig.CLEANUP_MAX_AGE_MS}ms`);
console.log(`  - Debug: ${finalConfig.DEBUG ? 'Yes' : 'No'}`);

// A rejected promise inside a request handler must not take the whole proxy down.
// Node's default --unhandled-rejections=throw turns one bad request into a process
// exit, which reads to users as "the service stopped working after a while".
process.on('unhandledRejection', (reason: unknown) => {
  const detail =
    reason instanceof Error
      ? `${reason.name}: ${reason.message}`
      : typeof reason === 'string'
        ? reason
        : (() => {
            try {
              return JSON.stringify(reason);
            } catch {
              return String(reason);
            }
          })();
  console.error('[Proxy] Unhandled rejection (request dropped, server continues):', detail);
  if (reason instanceof Error && reason.stack) console.error(reason.stack);
});

// Start the proxy
try {
  const proxy = startProxy(finalConfig);

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[Shutdown] Received SIGINT, shutting down gracefully...');
    proxy.killBackend();
    proxy.server.close(() => {
      console.log('[Shutdown] Server closed');
      process.exit(0);
    });
  });

  process.on('SIGTERM', () => {
    console.log('\n[Shutdown] Received SIGTERM, shutting down gracefully...');
    proxy.killBackend();
    proxy.server.close(() => {
      console.log('[Shutdown] Server closed');
      process.exit(0);
    });
  });
} catch (error: unknown) {
  const msg = error instanceof Error ? error.message : String(error);
  console.error('[Fatal] Failed to start proxy:', msg);
  process.exit(1);
}
