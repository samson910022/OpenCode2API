// P4 TS: system routes (models/health/details/metrics/404) (ported from P3 .js, behavior identical).
import type { Application, Request, Response } from 'express';
import type { AppContext } from '../types/context.js';
import { buildEffectiveApiKeys, createApiKeyVerifier } from '../auth/keys.js';

function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String((e as Record<string, unknown>)?.['message'] ?? e);
}

export function registerSystemRoutes(app: Application, ctx: AppContext): void {
  const {
    API_KEY,
    API_KEYS = [],
    DISABLE_TOOLS,
    INTERNAL_TOOL_METRICS_ENABLED,
    INTERNAL_TOOL_DISCOVERY_FIXTURE,
    HEALTH_DETAILS_ENABLED,
    HEALTH_DETAILS_REQUIRE_AUTH,
    METRICS_ENABLED,
    METRICS_REQUIRE_AUTH,
    SERVER_INTERNAL_ALLOWED_TOOL_NAMES,
    getProvidersList,
    buildModelsList,
    normalizeConfiguredToolNames,
    internalToolMetrics,
    getCachedToolIds,
    getCachedToolIdsAt,
    getDiscoverySource,
    getDiscoveryLastSuccessAt,
    getDiscoveryLastErrorAt,
    getDiscoveryLastError,
    proxyPool,
  } = ctx;
  // ctx.API_KEYS is already the effective list built by createApp; the merge
  // below is idempotent and only covers hand-built contexts in tests.
  const effectiveApiKeys: string[] =
    Array.isArray(API_KEYS) && API_KEYS.length > 0 ? [...API_KEYS] : buildEffectiveApiKeys(API_KEY, []);
  const apiKeyVerifier = createApiKeyVerifier(effectiveApiKeys);
  const hasValidBearerAuth = (req: Request): boolean => {
    if (apiKeyVerifier.keys.length === 0) return true;
    return apiKeyVerifier.isAuthorized(
      req as unknown as { headers: { authorization?: unknown; 'x-api-key'?: unknown } },
    );
  };

  const shouldAllowOperationalEndpoint = (
    req: Request,
    opts: { enabled: unknown; requireAuth: unknown },
  ): boolean => {
    if (!opts.enabled) return false;
    if (!opts.requireAuth) return true;
    return hasValidBearerAuth(req);
  };

  // Models endpoint
  app.get('/v1/models', (_req: Request, res: Response): void => {
    void (async (): Promise<void> => {
      try {
        const models = buildModelsList(await getProvidersList());
        res.json({ object: 'list', data: models });
      } catch (error: unknown) {
        console.error('[Proxy] Model Fetch Error:', toErrorMessage(error));
        res.json({ object: 'list', data: [{ id: 'opencode/kimi-k2.5-free', object: 'model' }] });
      }
    })();
  });

  app.get('/health', (_req: Request, res: Response): void => {
    res.json({
      status: 'ok',
      proxy: true,
    });
  });

  app.get('/health/details', (req: Request, res: Response): void => {
    if (
      !shouldAllowOperationalEndpoint(req, {
        enabled: HEALTH_DETAILS_ENABLED,
        requireAuth: HEALTH_DETAILS_REQUIRE_AUTH,
      })
    ) {
      res.status(HEALTH_DETAILS_ENABLED ? 401 : 404).json({
        error: { message: HEALTH_DETAILS_ENABLED ? 'Unauthorized' : 'Not found' },
      });
      return;
    }
    const metricsSnapshot = INTERNAL_TOOL_METRICS_ENABLED ? { ...internalToolMetrics } : null;
    const cached = getCachedToolIds();
    const cachedAt = getCachedToolIdsAt();
    const discoverySource = typeof getDiscoverySource === 'function' ? getDiscoverySource() : 'none';
    const discoverySuccessAt = typeof getDiscoveryLastSuccessAt === 'function' ? getDiscoveryLastSuccessAt() : 0;
    const discoveryErrorAt = typeof getDiscoveryLastErrorAt === 'function' ? getDiscoveryLastErrorAt() : 0;
    const discoveryError = typeof getDiscoveryLastError === 'function' ? getDiscoveryLastError() : null;
    const idsCount = cached ? cached.length : 0;
    const cacheAgeMs = cachedAt ? Date.now() - cachedAt : null;
    const liveVerified = discoverySource === 'live' && idsCount > 0;
    const discoveryReady = liveVerified;
    const fixtureConfigured = normalizeConfiguredToolNames(INTERNAL_TOOL_DISCOVERY_FIXTURE).length > 0;
    res.json({
      status: 'ok',
      proxy: true,
      internal_tools: {
        config: {
          allowed_tools: SERVER_INTERNAL_ALLOWED_TOOL_NAMES,
          metrics_enabled: INTERNAL_TOOL_METRICS_ENABLED,
          discovery_fixture: normalizeConfiguredToolNames(INTERNAL_TOOL_DISCOVERY_FIXTURE),
        },
        metrics: metricsSnapshot,
        cache: {
          tool_ids_cached: !!cached,
          tool_id_count: cached ? cached.length : 0,
          age_ms: cachedAt ? Date.now() - cachedAt : null,
        },
        tool_discovery: {
          source: discoverySource,
          live_verified: liveVerified,
          ready: discoveryReady,
          fixture_configured: fixtureConfigured,
          disable_tools: Boolean(DISABLE_TOOLS),
          ids_count: idsCount,
          cache_age_ms: cacheAgeMs,
          last_success_at: discoverySuccessAt || null,
          last_error_at: discoveryErrorAt || null,
          last_error: discoveryError,
          override_omitted_total: internalToolMetrics.overrideOmitted ?? 0,
        },
        readiness: {
          tool_discovery_ready: discoveryReady,
          live_backend_verified: liveVerified,
        },
        audit: {
          available: true,
          fields: [
            'requestedAllowlist',
            'allowedToolNames',
            'deniedRequestedTools',
            'resolutionPath',
            'resultingMode',
          ],
        },
        fallback_proxies: proxyPool ? proxyPool.getStatus() : null,
      },
    });
  });

  app.get('/metrics', (req: Request, res: Response): void => {
    if (
      !shouldAllowOperationalEndpoint(req, {
        enabled: METRICS_ENABLED,
        requireAuth: METRICS_REQUIRE_AUTH,
      })
    ) {
      res.status(METRICS_ENABLED ? 401 : 404).send(METRICS_ENABLED ? 'Unauthorized' : 'Not found');
      return;
    }

    const cached = getCachedToolIds();
    const cachedAt = getCachedToolIdsAt();
    const proxyStatus = proxyPool ? proxyPool.getStatus() : null;
    const metricsSource = typeof getDiscoverySource === 'function' ? getDiscoverySource() : 'none';
    const metricsSuccessAt = typeof getDiscoveryLastSuccessAt === 'function' ? getDiscoveryLastSuccessAt() : 0;
    const metricsErrorAt = typeof getDiscoveryLastErrorAt === 'function' ? getDiscoveryLastErrorAt() : 0;
    const metricsIdsCount = cached ? cached.length : 0;
    const metricsCacheAge = cachedAt ? Date.now() - cachedAt : -1;
    const metricsLiveVerified = metricsSource === 'live' && metricsIdsCount > 0 ? 1 : 0;
    const metricsReady = metricsLiveVerified;
    const metricsLines = [
      '# HELP opencode_internal_tool_mode_requests_total Count of internal tool mode selections by mode.',
      '# TYPE opencode_internal_tool_mode_requests_total counter',
      `opencode_internal_tool_mode_requests_total{mode="external_bridge"} ${internalToolMetrics.externalBridgeRequests}`,
      `opencode_internal_tool_mode_requests_total{mode="internal_allowlist"} ${internalToolMetrics.internalAllowlistRequests}`,
      `opencode_internal_tool_mode_requests_total{mode="disabled"} ${internalToolMetrics.disabledRequests}`,
      '# HELP opencode_internal_tool_discovery_failures_total Count of backend tool discovery failures.',
      '# TYPE opencode_internal_tool_discovery_failures_total counter',
      `opencode_internal_tool_discovery_failures_total ${internalToolMetrics.discoveryFailures}`,
      '# HELP opencode_internal_tool_fallback_disabled_total Count of allowlist resolutions that fell back to disabled.',
      '# TYPE opencode_internal_tool_fallback_disabled_total counter',
      `opencode_internal_tool_fallback_disabled_total ${internalToolMetrics.fallbackToDisabled}`,
      '# HELP opencode_internal_tool_overrides_omitted_total Count of tool override omissions under operator allow.',
      '# TYPE opencode_internal_tool_overrides_omitted_total counter',
      `opencode_internal_tool_overrides_omitted_total ${internalToolMetrics.overrideOmitted ?? 0}`,
      '# HELP opencode_internal_tool_cache_ids Number of cached backend tool IDs.',
      '# TYPE opencode_internal_tool_cache_ids gauge',
      `opencode_internal_tool_cache_ids ${cached ? cached.length : 0}`,
      '# HELP opencode_internal_tool_discovery_ids_count Number of discovered backend tool IDs.',
      '# TYPE opencode_internal_tool_discovery_ids_count gauge',
      `opencode_internal_tool_discovery_ids_count ${metricsIdsCount}`,
      '# HELP opencode_internal_tool_discovery_cache_age_ms Age of cached backend tool IDs in milliseconds.',
      '# TYPE opencode_internal_tool_discovery_cache_age_ms gauge',
      `opencode_internal_tool_discovery_cache_age_ms ${metricsCacheAge}`,
      '# HELP opencode_internal_tool_discovery_live_verified Whether live backend tool discovery is verified.',
      '# TYPE opencode_internal_tool_discovery_live_verified gauge',
      `opencode_internal_tool_discovery_live_verified ${metricsLiveVerified}`,
      '# HELP opencode_internal_tool_discovery_ready Whether tool discovery readiness holds.',
      '# TYPE opencode_internal_tool_discovery_ready gauge',
      `opencode_internal_tool_discovery_ready ${metricsReady}`,
      '# HELP opencode_internal_tool_discovery_source_info Tool discovery source.',
      '# TYPE opencode_internal_tool_discovery_source_info gauge',
      `opencode_internal_tool_discovery_source_info{source="${metricsSource}"} 1`,
      '# HELP opencode_internal_tool_discovery_last_success_timestamp_seconds Last tool discovery success time.',
      '# TYPE opencode_internal_tool_discovery_last_success_timestamp_seconds gauge',
      `opencode_internal_tool_discovery_last_success_timestamp_seconds ${metricsSuccessAt ? Math.floor(metricsSuccessAt / 1000) : 0}`,
      '# HELP opencode_internal_tool_discovery_last_error_timestamp_seconds Last tool discovery error time.',
      '# TYPE opencode_internal_tool_discovery_last_error_timestamp_seconds gauge',
      `opencode_internal_tool_discovery_last_error_timestamp_seconds ${metricsErrorAt ? Math.floor(metricsErrorAt / 1000) : 0}`,
      '# HELP opencode_fallback_proxy_configured Number of configured fallback proxies.',
      '# TYPE opencode_fallback_proxy_configured gauge',
      `opencode_fallback_proxy_configured ${proxyStatus ? proxyStatus.configured : 0}`,
      '# HELP opencode_fallback_proxy_engaged Whether the fallback proxy pool is engaged (1) or direct (0).',
      '# TYPE opencode_fallback_proxy_engaged gauge',
      `opencode_fallback_proxy_engaged ${proxyStatus && proxyStatus.engaged ? 1 : 0}`,
    ];

    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(`${metricsLines.join('\n')}\n`);
  });
}

export function registerNotFoundRoute(app: Application): void {
  app.use((req: Request, res: Response): void => {
    res.status(404).json({
      error: {
        message: `Route not found: ${req.method} ${req.path}`,
        type: 'not_found_error',
      },
    });
  });
}
