// P4 TS: root entrypoint (ported from index.js, behavior identical).
import { startProxy, normalizeBool, resolveDisableTools } from './src/proxy.js';
import { resolveMaxRetries } from './src/retry/policy.js';
import { mergeApiKeySources } from './src/auth/keys.js';
import {
  parseProxyList,
  parseProxyNoProxyList,
  normalizeProxyCooldownMs,
  DEFAULT_PROXY_COOLDOWN_MS,
  DEFAULT_PROXY_NO_PROXY,
  DEFAULT_PROXY_STRATEGY,
  PROXY_STRATEGIES,
} from './src/upstream-proxy/pool.js';
import {
  DEFAULT_BIND_HOST,
  DEFAULT_CLEANUP_INTERVAL_MS,
  DEFAULT_CLEANUP_MAX_AGE_MS,
  DEFAULT_EXTERNAL_TOOLS_CONFLICT_POLICY,
  DEFAULT_EXTERNAL_TOOLS_MODE,
  DEFAULT_EXTERNAL_TOOL_DEFAULT_RISK_LEVEL,
  DEFAULT_EXTERNAL_TOOL_POLICY_MODE,
  DEFAULT_OPENCODE_PATH,
  DEFAULT_PROMPT_MODE,
  DEFAULT_PROXY_PORT,
  DEFAULT_SERVER_PORT,
  EXTERNAL_TOOLS_CONFLICT_POLICIES,
  EXTERNAL_TOOLS_MODES,
  EXTERNAL_TOOL_POLICY_MODES,
  EXTERNAL_TOOL_RISK_LEVEL_VALUES,
  parseStrictPort,
  resolveBoolSetting,
  resolveDurationSetting,
  resolveEnumSetting,
  resolveListSetting,
  resolvePortSetting,
  resolveRetryCountSetting,
  resolveStringSetting,
  resolveUrlSetting,
} from './src/config/proxy-config.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import type { ProxyConfig } from './src/types/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Resolve the multi-key list for one layer: canonical list + legacy aliases merge (empty never blocks). */
function parseApiKeys(...sources: unknown[]): string[] {
  return mergeApiKeySources(...sources);
}

function warnUnsupportedEnum(label: string, value: unknown, allowed: readonly string[], effective: string): void {
  if (typeof value !== 'string' || !value.trim()) return;
  const normalized = value.trim().toLowerCase();
  if (allowed.includes(normalized)) return;
  console.warn(
    `[Config] Warning: ${label}="${value.trim()}" is not supported (supported: ${allowed.join(', ')}); using "${effective}"`,
  );
}

function warnInvalidPort(label: string, value: unknown, effective: number): void {
  if (value === undefined || value === null || value === '') return;
  if (parseStrictPort(value) !== undefined) return;
  console.warn(`[Config] Warning: ${label}="${String(value)}" is not a valid port (1-65535); using ${effective}`);
}

function warnInvalidUrl(label: string, value: unknown): void {
  if (typeof value !== 'string' || !value.trim()) return;
  try {
    const protocol = new URL(value.trim()).protocol;
    if (protocol === 'http:' || protocol === 'https:') return;
  } catch {}
  console.warn(`[Config] Warning: ${label}="${value.trim()}" is not a valid http(s) URL; falling back to the next source`);
}

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

// Merge configs: env canonical > env legacy alias > config.json > default.
// Every layer is normalized before it is compared, so an invalid value falls
// through to the next one instead of coercing (no `Boolean('garbage')`) and no
// layer can silently shadow a lower one.
const envApiKeys = parseApiKeys(process.env['OPENCODE_API_KEYS'], process.env['API_KEYS'], process.env['API_KEY']);
const fileApiKeys = parseApiKeys(fileConfig['API_KEYS'], fileConfig['API_KEY']);
const resolvedApiKeys = envApiKeys.length > 0 ? envApiKeys : fileApiKeys;

const serverPort = resolvePortSetting([process.env['OPENCODE_SERVER_PORT']], DEFAULT_SERVER_PORT);
warnInvalidPort('OPENCODE_SERVER_PORT', process.env['OPENCODE_SERVER_PORT'], serverPort);
const defaultServerUrl = `http://127.0.0.1:${serverPort}`;

const externalToolsMode = resolveEnumSetting(
  [process.env['OPENCODE_EXTERNAL_TOOLS_MODE'], fileConfig['EXTERNAL_TOOLS_MODE']],
  EXTERNAL_TOOLS_MODES,
  DEFAULT_EXTERNAL_TOOLS_MODE,
);
warnUnsupportedEnum('OPENCODE_EXTERNAL_TOOLS_MODE', process.env['OPENCODE_EXTERNAL_TOOLS_MODE'], EXTERNAL_TOOLS_MODES, externalToolsMode);
warnUnsupportedEnum('config.json EXTERNAL_TOOLS_MODE', fileConfig['EXTERNAL_TOOLS_MODE'], EXTERNAL_TOOLS_MODES, externalToolsMode);
const externalToolsConflictPolicy = resolveEnumSetting(
  [process.env['OPENCODE_EXTERNAL_TOOLS_CONFLICT_POLICY'], fileConfig['EXTERNAL_TOOLS_CONFLICT_POLICY']],
  EXTERNAL_TOOLS_CONFLICT_POLICIES,
  DEFAULT_EXTERNAL_TOOLS_CONFLICT_POLICY,
);
warnUnsupportedEnum(
  'OPENCODE_EXTERNAL_TOOLS_CONFLICT_POLICY',
  process.env['OPENCODE_EXTERNAL_TOOLS_CONFLICT_POLICY'],
  EXTERNAL_TOOLS_CONFLICT_POLICIES,
  externalToolsConflictPolicy,
);
warnUnsupportedEnum(
  'config.json EXTERNAL_TOOLS_CONFLICT_POLICY',
  fileConfig['EXTERNAL_TOOLS_CONFLICT_POLICY'],
  EXTERNAL_TOOLS_CONFLICT_POLICIES,
  externalToolsConflictPolicy,
);
const externalToolPolicyMode = resolveEnumSetting(
  [
    process.env['OPENCODE_EXTERNAL_TOOL_POLICY_MODE'],
    process.env['EXTERNAL_TOOL_POLICY_MODE'],
    fileConfig['EXTERNAL_TOOL_POLICY_MODE'],
  ],
  EXTERNAL_TOOL_POLICY_MODES,
  DEFAULT_EXTERNAL_TOOL_POLICY_MODE,
);
warnUnsupportedEnum(
  'OPENCODE_EXTERNAL_TOOL_POLICY_MODE',
  process.env['OPENCODE_EXTERNAL_TOOL_POLICY_MODE'],
  EXTERNAL_TOOL_POLICY_MODES,
  externalToolPolicyMode,
);
warnUnsupportedEnum('EXTERNAL_TOOL_POLICY_MODE', process.env['EXTERNAL_TOOL_POLICY_MODE'], EXTERNAL_TOOL_POLICY_MODES, externalToolPolicyMode);
warnUnsupportedEnum(
  'config.json EXTERNAL_TOOL_POLICY_MODE',
  fileConfig['EXTERNAL_TOOL_POLICY_MODE'],
  EXTERNAL_TOOL_POLICY_MODES,
  externalToolPolicyMode,
);
const externalToolDefaultRiskLevel = resolveEnumSetting(
  [
    process.env['OPENCODE_EXTERNAL_TOOL_DEFAULT_RISK_LEVEL'],
    process.env['EXTERNAL_TOOL_DEFAULT_RISK_LEVEL'],
    fileConfig['EXTERNAL_TOOL_DEFAULT_RISK_LEVEL'],
  ],
  EXTERNAL_TOOL_RISK_LEVEL_VALUES,
  DEFAULT_EXTERNAL_TOOL_DEFAULT_RISK_LEVEL,
);
warnUnsupportedEnum(
  'OPENCODE_EXTERNAL_TOOL_DEFAULT_RISK_LEVEL',
  process.env['OPENCODE_EXTERNAL_TOOL_DEFAULT_RISK_LEVEL'],
  EXTERNAL_TOOL_RISK_LEVEL_VALUES,
  externalToolDefaultRiskLevel,
);
warnUnsupportedEnum(
  'EXTERNAL_TOOL_DEFAULT_RISK_LEVEL',
  process.env['EXTERNAL_TOOL_DEFAULT_RISK_LEVEL'],
  EXTERNAL_TOOL_RISK_LEVEL_VALUES,
  externalToolDefaultRiskLevel,
);
warnUnsupportedEnum(
  'config.json EXTERNAL_TOOL_DEFAULT_RISK_LEVEL',
  fileConfig['EXTERNAL_TOOL_DEFAULT_RISK_LEVEL'],
  EXTERNAL_TOOL_RISK_LEVEL_VALUES,
  externalToolDefaultRiskLevel,
);

const proxyPort = resolvePortSetting(
  [process.env['OPENCODE_PROXY_PORT'], process.env['PORT'], fileConfig['PORT']],
  DEFAULT_PROXY_PORT,
);
warnInvalidPort('OPENCODE_PROXY_PORT', process.env['OPENCODE_PROXY_PORT'], proxyPort);
warnInvalidPort('PORT', process.env['PORT'], proxyPort);
warnInvalidUrl('OPENCODE_SERVER_URL', process.env['OPENCODE_SERVER_URL']);
warnInvalidUrl('config.json OPENCODE_SERVER_URL', fileConfig['OPENCODE_SERVER_URL']);

const finalConfig: ProxyConfig = {
  PORT: proxyPort,
  API_KEY: resolvedApiKeys[0] ?? '',
  API_KEYS: resolvedApiKeys,
  OPENCODE_SERVER_URL: resolveUrlSetting(
    [process.env['OPENCODE_SERVER_URL'], fileConfig['OPENCODE_SERVER_URL']],
    defaultServerUrl,
  ),
  OPENCODE_SERVER_PASSWORD: resolveStringSetting(
    [process.env['OPENCODE_SERVER_PASSWORD'], fileConfig['OPENCODE_SERVER_PASSWORD']],
    '',
  ),
  MANAGE_BACKEND: resolveBoolSetting(
    [process.env['OPENCODE_PROXY_MANAGE_BACKEND'], fileConfig['MANAGE_BACKEND']],
    false,
  ),
  OPENCODE_PATH: resolveStringSetting(
    [process.env['OPENCODE_PATH'], fileConfig['OPENCODE_PATH']],
    DEFAULT_OPENCODE_PATH,
  ),
  BIND_HOST: resolveStringSetting(
    [process.env['BIND_HOST'], process.env['OPENCODE_PROXY_BIND_HOST'], fileConfig['BIND_HOST']],
    DEFAULT_BIND_HOST,
  ),
  // Single contract via resolveDisableTools: env canonical > env legacy
  // alias > file > default. Each source is normalized first so invalid
  // values ('', 'garbage') fall through instead of blocking lower sources.
  DISABLE_TOOLS: resolveDisableTools(
    {
      DISABLE_TOOLS: process.env['OPENCODE_DISABLE_TOOLS'],
      disableTools: process.env['DISABLE_TOOLS'],
    },
    (normalizeBool(fileConfig['DISABLE_TOOLS']) ?? true) as boolean,
  ),
  EXTERNAL_TOOLS_MODE: externalToolsMode,
  EXTERNAL_TOOLS_CONFLICT_POLICY: externalToolsConflictPolicy,
  EXTERNAL_TOOL_POLICY_MODE: externalToolPolicyMode,
  EXTERNAL_TOOL_DEFAULT_RISK_LEVEL: externalToolDefaultRiskLevel,
  EXTERNAL_TOOL_ALLOWLIST: resolveListSetting(
    [
      process.env['OPENCODE_EXTERNAL_TOOL_ALLOWLIST'],
      process.env['EXTERNAL_TOOL_ALLOWLIST'],
      fileConfig['EXTERNAL_TOOL_ALLOWLIST'],
    ],
    [],
  ),
  EXTERNAL_TOOL_DENYLIST: resolveListSetting(
    [
      process.env['OPENCODE_EXTERNAL_TOOL_DENYLIST'],
      process.env['EXTERNAL_TOOL_DENYLIST'],
      fileConfig['EXTERNAL_TOOL_DENYLIST'],
    ],
    [],
  ),
  EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR: resolveListSetting(
    [
      process.env['OPENCODE_EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR'],
      process.env['EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR'],
      fileConfig['EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR'],
    ],
    [],
  ),
  INTERNAL_WEB_FETCH_ENABLED: resolveBoolSetting(
    [process.env['OPENCODE_INTERNAL_WEB_FETCH_ENABLED'], fileConfig['INTERNAL_WEB_FETCH_ENABLED']],
    false,
  ),
  INTERNAL_ALLOWED_TOOLS: resolveListSetting(
    [process.env['OPENCODE_INTERNAL_ALLOWED_TOOLS'], fileConfig['INTERNAL_ALLOWED_TOOLS']],
    [],
  ),
  INTERNAL_TOOL_METRICS_ENABLED: resolveBoolSetting(
    [process.env['OPENCODE_INTERNAL_TOOL_METRICS_ENABLED'], fileConfig['INTERNAL_TOOL_METRICS_ENABLED']],
    true,
  ),
  INTERNAL_TOOL_DISCOVERY_FIXTURE: resolveListSetting(
    [process.env['OPENCODE_TOOL_DISCOVERY_FIXTURE'], fileConfig['INTERNAL_TOOL_DISCOVERY_FIXTURE']],
    [],
  ),
  HEALTH_DETAILS_ENABLED: resolveBoolSetting(
    [process.env['OPENCODE_HEALTH_DETAILS_ENABLED'], fileConfig['HEALTH_DETAILS_ENABLED']],
    true,
  ),
  HEALTH_DETAILS_REQUIRE_AUTH: resolveBoolSetting(
    [process.env['OPENCODE_HEALTH_DETAILS_REQUIRE_AUTH'], fileConfig['HEALTH_DETAILS_REQUIRE_AUTH']],
    true,
  ),
  METRICS_ENABLED: resolveBoolSetting(
    [process.env['OPENCODE_METRICS_ENABLED'], fileConfig['METRICS_ENABLED']],
    false,
  ),
  METRICS_REQUIRE_AUTH: resolveBoolSetting(
    [process.env['OPENCODE_METRICS_REQUIRE_AUTH'], fileConfig['METRICS_REQUIRE_AUTH']],
    true,
  ),
  USE_ISOLATED_HOME: resolveBoolSetting(
    [process.env['OPENCODE_USE_ISOLATED_HOME'], fileConfig['USE_ISOLATED_HOME']],
    false,
  ),
  REQUEST_TIMEOUT_MS: resolveDurationSetting(
    [process.env['OPENCODE_PROXY_REQUEST_TIMEOUT_MS'], fileConfig['REQUEST_TIMEOUT_MS']],
    180000,
  ),
  RETRY_MAX_RETRIES: resolveRetryCountSetting(
    [
      process.env['OPENCODE_PROXY_RETRY_MAX_RETRIES'],
      process.env['RETRY_MAX_RETRIES'],
      fileConfig['RETRY_MAX_RETRIES'],
    ],
    3,
  ),
  DEBUG: resolveBoolSetting([process.env['OPENCODE_PROXY_DEBUG'], fileConfig['DEBUG']], false),
  ZEN_API_KEY: resolveStringSetting([process.env['OPENCODE_ZEN_API_KEY'], fileConfig['ZEN_API_KEY']], ''),
  PROMPT_MODE: resolveStringSetting(
    [process.env['OPENCODE_PROXY_PROMPT_MODE'], fileConfig['PROMPT_MODE']],
    DEFAULT_PROMPT_MODE,
  ),
  OMIT_SYSTEM_PROMPT: resolveBoolSetting(
    [process.env['OPENCODE_PROXY_OMIT_SYSTEM_PROMPT'], fileConfig['OMIT_SYSTEM_PROMPT']],
    false,
  ),
  AUTO_CLEANUP_CONVERSATIONS: resolveBoolSetting(
    [process.env['OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS'], fileConfig['AUTO_CLEANUP_CONVERSATIONS']],
    false,
  ),
  CLEANUP_INTERVAL_MS: resolveDurationSetting(
    [process.env['OPENCODE_PROXY_CLEANUP_INTERVAL_MS'], fileConfig['CLEANUP_INTERVAL_MS']],
    DEFAULT_CLEANUP_INTERVAL_MS,
  ),
  CLEANUP_MAX_AGE_MS: resolveDurationSetting(
    [process.env['OPENCODE_PROXY_CLEANUP_MAX_AGE_MS'], fileConfig['CLEANUP_MAX_AGE_MS']],
    DEFAULT_CLEANUP_MAX_AGE_MS,
  ),
  OPENCODE_HOME_BASE: null,
  // Fallback proxy pool (P3): env layer wins as a whole, then file, then default.
  // Empty = direct-only (default, zero overhead; engagable only on free-limit).
  UPSTREAM_PROXIES: (() => {
    const env = parseProxyList([process.env['OPENCODE_UPSTREAM_PROXIES'], process.env['UPSTREAM_PROXIES']]);
    if (env.length > 0) return env;
    const file = parseProxyList(fileConfig['UPSTREAM_PROXIES']);
    return file.length > 0 ? file : [];
  })(),
  UPSTREAM_PROXY_STRATEGY: resolveEnumSetting(
    [
      process.env['OPENCODE_UPSTREAM_PROXY_STRATEGY'],
      process.env['UPSTREAM_PROXY_STRATEGY'],
      fileConfig['UPSTREAM_PROXY_STRATEGY'],
    ],
    PROXY_STRATEGIES,
    DEFAULT_PROXY_STRATEGY,
  ),
  UPSTREAM_PROXY_COOLDOWN_MS: normalizeProxyCooldownMs(
    resolveDurationSetting(
      [
        process.env['OPENCODE_UPSTREAM_PROXY_COOLDOWN_MS'],
        process.env['UPSTREAM_PROXY_COOLDOWN_MS'],
        fileConfig['UPSTREAM_PROXY_COOLDOWN_MS'],
      ],
      DEFAULT_PROXY_COOLDOWN_MS,
    ),
  ),
  UPSTREAM_PROXY_NO_PROXY: parseProxyNoProxyList(
    resolveListSetting(
      [
        process.env['OPENCODE_UPSTREAM_PROXY_NO_PROXY'],
        process.env['UPSTREAM_PROXY_NO_PROXY'],
        fileConfig['UPSTREAM_PROXY_NO_PROXY'],
      ],
      [],
    ),
    DEFAULT_PROXY_NO_PROXY,
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
console.log(`  - Backend Port: ${serverPort} (OPENCODE_SERVER_PORT; only bakes the default loopback URL)`);
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
console.log(`  - External Tool Policy Mode: ${finalConfig.EXTERNAL_TOOL_POLICY_MODE}`);
console.log(`  - External Tool Default Risk Level: ${finalConfig.EXTERNAL_TOOL_DEFAULT_RISK_LEVEL}`);
console.log(
  `  - External Tool Allowlist: ${finalConfig.EXTERNAL_TOOL_ALLOWLIST.length ? finalConfig.EXTERNAL_TOOL_ALLOWLIST.join(', ') : '(none)'}`,
);
console.log(
  `  - External Tool Denylist: ${finalConfig.EXTERNAL_TOOL_DENYLIST.length ? finalConfig.EXTERNAL_TOOL_DENYLIST.join(', ') : '(none)'}`,
);
console.log(
  `  - External Tool Confirmation Required: ${finalConfig.EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR.length ? finalConfig.EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR.join(', ') : '(none)'}`,
);
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
  `  - Max Retries: ${resolveMaxRetries(finalConfig.RETRY_MAX_RETRIES)} (merged: ${String(finalConfig.RETRY_MAX_RETRIES)}, total attempts 1+n)`,
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
