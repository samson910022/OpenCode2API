import { resolveDisableTools, normalizeBool } from '../src/proxy.js';
import {
    buildProxyConfig,
    parseStrictInteger,
    parseStrictPort,
    parseHttpUrl,
    parseToolNameList,
    resolveStringSetting,
    resolveBoolSetting,
    resolveIntSetting,
    resolvePortSetting,
    resolveDurationSetting,
    resolveRetryCountSetting,
    resolveListSetting,
    resolveEnumSetting,
    resolveUrlSetting,
    EXTERNAL_TOOLS_MODES,
    EXTERNAL_TOOLS_CONFLICT_POLICIES,
    EXTERNAL_TOOL_POLICY_MODES,
    EXTERNAL_TOOL_RISK_LEVEL_VALUES,
    DEFAULT_EXTERNAL_TOOLS_MODE,
    DEFAULT_EXTERNAL_TOOLS_CONFLICT_POLICY,
    DEFAULT_EXTERNAL_TOOL_POLICY_MODE,
    DEFAULT_EXTERNAL_TOOL_DEFAULT_RISK_LEVEL,
    DEFAULT_PROXY_PORT,
    DEFAULT_SERVER_PORT,
} from '../src/config/proxy-config.js';
import { resolveMaxRetries } from '../src/retry/policy.js';
import { DEFAULT_PROXY_STRATEGY, PROXY_STRATEGIES } from '../src/upstream-proxy/pool.js';

// Regression tests: docker-compose/.env document DISABLE_TOOLS, but the code
// only honored OPENCODE_DISABLE_TOOLS, so a legacy DISABLE_TOOLS=true was
// silently ignored. Both unit and production defaults are true (tools disabled);
// index.ts passes an explicit file fallback that also defaults to true.
describe('resolveDisableTools', () => {
    const CANONICAL = 'OPENCODE_DISABLE_TOOLS';
    const LEGACY = 'DISABLE_TOOLS';
    let savedCanonical;
    let savedLegacy;

    beforeEach(() => {
        savedCanonical = process.env[CANONICAL];
        savedLegacy = process.env[LEGACY];
        delete process.env[CANONICAL];
        delete process.env[LEGACY];
    });

    afterEach(() => {
        if (savedCanonical === undefined) delete process.env[CANONICAL];
        else process.env[CANONICAL] = savedCanonical;
        if (savedLegacy === undefined) delete process.env[LEGACY];
        else process.env[LEGACY] = savedLegacy;
    });

    test('defaults to the fallback when nothing is set', () => {
        expect(resolveDisableTools()).toBe(true);
        expect(resolveDisableTools({})).toBe(true);
        expect(resolveDisableTools({}, true)).toBe(true);
        expect(resolveDisableTools(null)).toBe(true);
        expect(resolveDisableTools(null, true)).toBe(true);
    });

    // Primary regression detector: legacy=true must take effect.
    // (Old code had no DISABLE_TOOLS branch, so this returned false.)
    test('honors legacy DISABLE_TOOLS=true (primary regression)', () => {
        process.env[LEGACY] = 'true';
        expect(resolveDisableTools({})).toBe(true);
    });

    test('honors legacy DISABLE_TOOLS=false', () => {
        process.env[LEGACY] = 'false';
        expect(resolveDisableTools({})).toBe(false);
    });

    test('canonical env wins over the legacy alias', () => {
        process.env[CANONICAL] = 'false';
        process.env[LEGACY] = 'true';
        expect(resolveDisableTools({})).toBe(false);
        process.env[CANONICAL] = 'true';
        process.env[LEGACY] = 'false';
        expect(resolveDisableTools({})).toBe(true);
    });

    test('explicit options win over both env vars', () => {
        process.env[CANONICAL] = 'true';
        process.env[LEGACY] = 'true';
        expect(resolveDisableTools({ DISABLE_TOOLS: false })).toBe(false);
        process.env[CANONICAL] = 'false';
        process.env[LEGACY] = 'false';
        expect(resolveDisableTools({ DISABLE_TOOLS: true })).toBe(true);
        expect(resolveDisableTools({ disableTools: true })).toBe(true);
        expect(resolveDisableTools({ DISABLE_TOOLS: 'false', disableTools: true })).toBe(false);
    });

    test('parses common bool spellings', () => {
        for (const v of ['1', 'true', 'yes', 'y', 'on', ' TRUE ']) {
            process.env[LEGACY] = v;
            expect(resolveDisableTools({})).toBe(true);
        }
        for (const v of ['0', 'false', 'no', 'n', 'off', ' FALSE ']) {
            process.env[LEGACY] = v;
            expect(resolveDisableTools({})).toBe(false);
        }
    });

    // Invalid values mean "unset" and fall through; they must NOT coerce.
    test('invalid values fall through to the next source', () => {
        for (const garbage of ['garbage', '', '   ', '2', 'truthy']) {
            process.env[CANONICAL] = garbage;
            process.env[LEGACY] = 'true';
            expect(resolveDisableTools({})).toBe(true);
            process.env[LEGACY] = 'false';
            expect(resolveDisableTools({})).toBe(false);
            delete process.env[LEGACY];
            expect(resolveDisableTools({})).toBe(true);
            expect(resolveDisableTools({}, true)).toBe(true);
        }
        // Legacy layer alone with garbage also falls back (not coerced).
        for (const garbage of ['garbage', '', '   ']) {
            process.env[LEGACY] = garbage;
            expect(resolveDisableTools({})).toBe(true);
            expect(resolveDisableTools({}, true)).toBe(true);
        }
        // Invalid option values fall through to env as well.
        process.env[CANONICAL] = 'true';
        for (const garbage of ['garbage', '', '   ']) {
            expect(resolveDisableTools({ DISABLE_TOOLS: garbage })).toBe(true);
        }
        expect(resolveDisableTools({ DISABLE_TOOLS: 'garbage', disableTools: 'false' })).toBe(false);
    });

    test('numbers 0/1 parse, other numbers fall through like invalid strings', () => {
        // 1/0 behave like '1'/'0'; any other number is "unset" and falls
        // through instead of coercing to false and blocking env.
        expect(resolveDisableTools({ DISABLE_TOOLS: 1 })).toBe(true);
        expect(resolveDisableTools({ DISABLE_TOOLS: 0 })).toBe(false);
        process.env[CANONICAL] = 'true';
        expect(resolveDisableTools({ DISABLE_TOOLS: 2 })).toBe(true);
        expect(resolveDisableTools({ DISABLE_TOOLS: -1 })).toBe(true);
        expect(resolveDisableTools({ DISABLE_TOOLS: 0 })).toBe(false);
        process.env[CANONICAL] = 'false';
        expect(resolveDisableTools({ DISABLE_TOOLS: 2 })).toBe(false);
        delete process.env[CANONICAL];
        expect(resolveDisableTools({ DISABLE_TOOLS: 2 })).toBe(true);
        expect(resolveDisableTools({ DISABLE_TOOLS: 2 }, true)).toBe(true);
    });
});

// index.ts cannot be imported directly (it starts the server), so mirror its
// exact resolution call here to pin the env > file > default contract.
// index.ts calls resolveDisableTools({DISABLE_TOOLS: canonical,
// disableTools: legacy}, normalizeBool(file) ?? default).
describe('index.js DISABLE_TOOLS chain (mirrored)', () => {
    const resolveIndexChain = (env, fileConfig, defaultValue) =>
        resolveDisableTools(
            {
                DISABLE_TOOLS: env.OPENCODE_DISABLE_TOOLS,
                disableTools: env.DISABLE_TOOLS,
            },
            normalizeBool(fileConfig.DISABLE_TOOLS) ?? defaultValue,
        );

    test('env > file > default', () => {
        expect(resolveIndexChain({}, {}, true)).toBe(true);
        expect(resolveIndexChain({}, { DISABLE_TOOLS: false }, true)).toBe(false);
        expect(resolveIndexChain({ DISABLE_TOOLS: 'false' }, { DISABLE_TOOLS: true }, true)).toBe(false);
        expect(resolveIndexChain({ OPENCODE_DISABLE_TOOLS: 'false' }, { DISABLE_TOOLS: true }, true)).toBe(false);
        expect(resolveIndexChain(
            { OPENCODE_DISABLE_TOOLS: 'true', DISABLE_TOOLS: 'false' },
            { DISABLE_TOOLS: false }, false,
        )).toBe(true);
    });

    test('invalid env falls through to file, not default', () => {
        expect(resolveIndexChain(
            { OPENCODE_DISABLE_TOOLS: 'garbage', DISABLE_TOOLS: '' },
            { DISABLE_TOOLS: false }, true,
        )).toBe(false);
    });
});

// Pure merge/normalizer helpers extracted from index.ts so both entry points
// (prod index.ts and library buildProxyConfig) share one strict contract:
// env canonical > env legacy alias > file short key > hardcoded default, with
// invalid values falling through instead of coercing.
describe('strict layer normalizers', () => {
    test('parseStrictInteger rejects partial/garbage numerics', () => {
        expect(parseStrictInteger('3')).toBe(3);
        expect(parseStrictInteger(' 42 ')).toBe(42);
        expect(parseStrictInteger('-1')).toBe(-1);
        expect(parseStrictInteger(0)).toBe(0);
        expect(parseStrictInteger('3abc')).toBeUndefined();
        expect(parseStrictInteger('3.5')).toBeUndefined();
        expect(parseStrictInteger('1e3')).toBeUndefined();
        expect(parseStrictInteger('')).toBeUndefined();
        expect(parseStrictInteger('   ')).toBeUndefined();
        expect(parseStrictInteger('garbage')).toBeUndefined();
        expect(parseStrictInteger(3.5)).toBeUndefined();
        expect(parseStrictInteger(NaN)).toBeUndefined();
        expect(parseStrictInteger(Infinity)).toBeUndefined();
        expect(parseStrictInteger(true)).toBeUndefined();
        expect(parseStrictInteger(null)).toBeUndefined();
        expect(parseStrictInteger(undefined)).toBeUndefined();
        expect(parseStrictInteger({})).toBeUndefined();
    });

    test('parseStrictPort enforces 1..65535', () => {
        expect(parseStrictPort('10000')).toBe(10000);
        expect(parseStrictPort(1)).toBe(1);
        expect(parseStrictPort(65535)).toBe(65535);
        for (const bad of ['0', 0, '-1', 65536, '100000', '80.5', 'abc', '', null, undefined, {}]) {
            expect(parseStrictPort(bad)).toBeUndefined();
        }
    });

    test('parseHttpUrl only accepts http(s) URLs', () => {
        expect(parseHttpUrl('http://127.0.0.1:10001')).toBe('http://127.0.0.1:10001');
        expect(parseHttpUrl(' https://backend.example.com ')).toBe('https://backend.example.com');
        for (const bad of ['not-a-url', '127.0.0.1:10001', 'ftp://host', 'file:///tmp/x', '', '   ', 42, null, undefined]) {
            expect(parseHttpUrl(bad)).toBeUndefined();
        }
    });

    test('parseToolNameList normalizes arrays/CSV and reports unset as undefined', () => {
        expect(parseToolNameList('a, b ,a,,c')).toEqual(['a', 'b', 'c']);
        expect(parseToolNameList(['a', ' b ', '', null, 0, false])).toEqual(['a', 'b']);
        expect(parseToolNameList([])).toEqual([]);
        expect(parseToolNameList('')).toBeUndefined();
        expect(parseToolNameList('   ')).toBeUndefined();
        expect(parseToolNameList(undefined)).toBeUndefined();
        expect(parseToolNameList(null)).toBeUndefined();
        expect(parseToolNameList(42)).toBeUndefined();
    });

    test('string layers: canonical > legacy > file > default, invalid falls through', () => {
        expect(resolveStringSetting(['canon', 'legacy', 'file'], 'def')).toBe('canon');
        expect(resolveStringSetting(['', 'legacy', 'file'], 'def')).toBe('legacy');
        expect(resolveStringSetting(['', '  ', 'file'], 'def')).toBe('file');
        expect(resolveStringSetting([undefined, null, '', '   '], 'def')).toBe('def');
        expect(resolveStringSetting([42, {}, 'file'], 'def')).toBe('file');
        expect(resolveStringSetting(['  canon  '], 'def')).toBe('canon');
    });

    test('bool layers: only exact recognized spellings count, garbage never coerces', () => {
        expect(resolveBoolSetting(['false'], true)).toBe(false);
        expect(resolveBoolSetting(['garbage', 'true'], false)).toBe(true);
        expect(resolveBoolSetting(['maybe', 'maybe', true], false)).toBe(true);
        expect(resolveBoolSetting(['garbage'], true)).toBe(true);
        expect(resolveBoolSetting([2], false)).toBe(false);
        expect(resolveBoolSetting([0], true)).toBe(false);
        expect(resolveBoolSetting(['0', 'true'], true)).toBe(false);
        expect(resolveBoolSetting(['', 'on'], false)).toBe(true);
    });

    test('int/port/duration/retry layers clamp by range instead of coercing', () => {
        expect(resolveIntSetting(['5'], 0, 10, 1)).toBe(5);
        expect(resolveIntSetting(['99'], 0, 10, 1)).toBe(1);
        expect(resolvePortSetting(['8080', '9090'], DEFAULT_PROXY_PORT)).toBe(8080);
        expect(resolvePortSetting(['0', '9090'], DEFAULT_PROXY_PORT)).toBe(9090);
        expect(resolvePortSetting(['abc'], DEFAULT_PROXY_PORT)).toBe(DEFAULT_PROXY_PORT);
        expect(resolveDurationSetting(['3abc', 5000], 1)).toBe(5000);
        expect(resolveDurationSetting(['0', '-5', 250], 1)).toBe(250);
        expect(resolveRetryCountSetting(['0'], 3)).toBe(0);
        expect(resolveRetryCountSetting(['-1', '4'], 3)).toBe(-1);
        expect(resolveRetryCountSetting(['2.9'], 3)).toBe(3);
    });

    test('list layers: empty string is unset, empty array is explicit', () => {
        expect(resolveListSetting(['a,b', 'c'], [])).toEqual(['a', 'b']);
        expect(resolveListSetting(['', 'c'], [])).toEqual(['c']);
        expect(resolveListSetting([['x', 'x', 'y']], [])).toEqual(['x', 'y']);
        expect(resolveListSetting([undefined, null], ['fallback'])).toEqual(['fallback']);
    });

    test('enum layers: unrecognized values fall through, never shadow lower layers', () => {
        expect(resolveEnumSetting(['report-only'], EXTERNAL_TOOL_POLICY_MODES, 'enforce')).toBe('report-only');
        expect(resolveEnumSetting(['Report-Only'], EXTERNAL_TOOL_POLICY_MODES, 'enforce')).toBe('report-only');
        expect(resolveEnumSetting(['garbage', 'enforce'], EXTERNAL_TOOL_POLICY_MODES, 'x')).toBe('enforce');
        expect(resolveEnumSetting(['', 'report-only'], EXTERNAL_TOOL_POLICY_MODES, 'x')).toBe('report-only');
        expect(resolveEnumSetting([42, {}], EXTERNAL_TOOL_POLICY_MODES, 'enforce')).toBe('enforce');
        expect(resolveEnumSetting(['nope'], EXTERNAL_TOOLS_MODES, DEFAULT_EXTERNAL_TOOLS_MODE)).toBe(DEFAULT_EXTERNAL_TOOLS_MODE);
        expect(resolveEnumSetting(['nope'], EXTERNAL_TOOLS_CONFLICT_POLICIES, DEFAULT_EXTERNAL_TOOLS_CONFLICT_POLICY))
            .toBe(DEFAULT_EXTERNAL_TOOLS_CONFLICT_POLICY);
        expect(resolveEnumSetting(['HIGH'], EXTERNAL_TOOL_RISK_LEVEL_VALUES, DEFAULT_EXTERNAL_TOOL_DEFAULT_RISK_LEVEL)).toBe('high');
        expect(resolveEnumSetting(['urgent'], EXTERNAL_TOOL_RISK_LEVEL_VALUES, DEFAULT_EXTERNAL_TOOL_DEFAULT_RISK_LEVEL))
            .toBe(DEFAULT_EXTERNAL_TOOL_DEFAULT_RISK_LEVEL);
        expect(EXTERNAL_TOOLS_MODES).toEqual(['proxy-bridge']);
        expect(EXTERNAL_TOOLS_CONFLICT_POLICIES).toEqual(['namespace']);
        expect(EXTERNAL_TOOL_POLICY_MODES).toEqual(['enforce', 'report-only']);
        expect(EXTERNAL_TOOL_RISK_LEVEL_VALUES).toEqual(['low', 'medium', 'high', 'critical']);
    });

    test('url layers: invalid env falls through to file/default', () => {
        expect(resolveUrlSetting(['https://a.example', 'http://b'], 'http://d')).toBe('https://a.example');
        expect(resolveUrlSetting(['nope', 'http://b'], 'http://d')).toBe('http://b');
        expect(resolveUrlSetting(['', 'garbage'], 'http://127.0.0.1:10001')).toBe('http://127.0.0.1:10001');
    });
});

const withEnv = (vars, fn) => {
    const saved = {};
    for (const key of Object.keys(vars)) {
        saved[key] = process.env[key];
        if (vars[key] === undefined) delete process.env[key];
        else process.env[key] = vars[key];
    }
    try {
        return fn();
    } finally {
        for (const key of Object.keys(saved)) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    }
};

describe('buildProxyConfig env/options matrix', () => {
    test('port: options > canonical env > legacy PORT env > default', () => {
        withEnv({ OPENCODE_PROXY_PORT: undefined, PORT: undefined }, () => {
            expect(buildProxyConfig().PORT).toBe(DEFAULT_PROXY_PORT);
            expect(buildProxyConfig({ PORT: 1234 }).PORT).toBe(1234);
            withEnv({ PORT: 2345 }, () => {
                expect(buildProxyConfig().PORT).toBe(2345);
                withEnv({ OPENCODE_PROXY_PORT: '3456' }, () => {
                    expect(buildProxyConfig().PORT).toBe(3456);
                    expect(buildProxyConfig({ PORT: 1234 }).PORT).toBe(1234);
                    expect(buildProxyConfig({ PORT: '1234' }).PORT).toBe(1234);
                });
            });
        });
    });

    test('port: invalid values fall through instead of becoming NaN/0', () => {
        withEnv({ OPENCODE_PROXY_PORT: 'garbage', PORT: '0' }, () => {
            expect(buildProxyConfig().PORT).toBe(DEFAULT_PROXY_PORT);
        });
        withEnv({ OPENCODE_PROXY_PORT: '70000', PORT: '8080' }, () => {
            expect(buildProxyConfig().PORT).toBe(8080);
        });
        expect(buildProxyConfig({ PORT: 'abc' }).PORT).toBe(DEFAULT_PROXY_PORT);
        expect(buildProxyConfig({ PORT: 65536 }).PORT).toBe(DEFAULT_PROXY_PORT);
        expect(buildProxyConfig({ PORT: -1 }).PORT).toBe(DEFAULT_PROXY_PORT);
    });

    test('backend url: options > env > OPENCODE_SERVER_PORT baked default > hardcoded default', () => {
        withEnv({ OPENCODE_SERVER_URL: undefined, OPENCODE_SERVER_PORT: undefined }, () => {
            expect(buildProxyConfig().OPENCODE_SERVER_URL).toBe(`http://127.0.0.1:${DEFAULT_SERVER_PORT}`);
            withEnv({ OPENCODE_SERVER_PORT: '10009' }, () => {
                expect(buildProxyConfig().OPENCODE_SERVER_URL).toBe('http://127.0.0.1:10009');
                withEnv({ OPENCODE_SERVER_URL: 'https://remote.example' }, () => {
                    expect(buildProxyConfig().OPENCODE_SERVER_URL).toBe('https://remote.example');
                    expect(buildProxyConfig({ OPENCODE_SERVER_URL: 'http://opt.example' }).OPENCODE_SERVER_URL)
                        .toBe('http://opt.example');
                });
            });
        });
    });

    test('backend url/path: invalid env falls through to the next layer', () => {
        withEnv({ OPENCODE_SERVER_URL: 'not-a-url', OPENCODE_PATH: '   ' }, () => {
            expect(buildProxyConfig().OPENCODE_SERVER_URL).toBe(`http://127.0.0.1:${DEFAULT_SERVER_PORT}`);
            expect(buildProxyConfig().OPENCODE_PATH).toBe('opencode');
            withEnv({ OPENCODE_PATH: '/opt/opencode' }, () => {
                expect(buildProxyConfig().OPENCODE_PATH).toBe('/opt/opencode');
                expect(buildProxyConfig({ OPENCODE_PATH: '/opt/other' }).OPENCODE_PATH).toBe('/opt/other');
            });
        });
    });

    test('manage backend / isolated home: options > env > library default (drift preserved)', () => {
        withEnv({ OPENCODE_PROXY_MANAGE_BACKEND: undefined, OPENCODE_USE_ISOLATED_HOME: undefined }, () => {
            expect(buildProxyConfig().MANAGE_BACKEND).toBe(true);
            expect(buildProxyConfig().USE_ISOLATED_HOME).toBe(false);
            withEnv({ OPENCODE_PROXY_MANAGE_BACKEND: 'false', OPENCODE_USE_ISOLATED_HOME: 'true' }, () => {
                expect(buildProxyConfig().MANAGE_BACKEND).toBe(false);
                expect(buildProxyConfig().USE_ISOLATED_HOME).toBe(true);
                withEnv({ OPENCODE_PROXY_MANAGE_BACKEND: 'garbage', OPENCODE_USE_ISOLATED_HOME: 'garbage' }, () => {
                    expect(buildProxyConfig().MANAGE_BACKEND).toBe(true);
                    expect(buildProxyConfig().USE_ISOLATED_HOME).toBe(false);
                    expect(buildProxyConfig({ MANAGE_BACKEND: false, USE_ISOLATED_HOME: true }).MANAGE_BACKEND).toBe(false);
                    expect(buildProxyConfig({ MANAGE_BACKEND: false, USE_ISOLATED_HOME: true }).USE_ISOLATED_HOME).toBe(true);
                });
            });
        });
    });

    test('request timeout keeps the library 300000 default and rejects partial numerics', () => {
        withEnv({ OPENCODE_PROXY_REQUEST_TIMEOUT_MS: undefined }, () => {
            expect(buildProxyConfig().REQUEST_TIMEOUT_MS).toBe(300000);
            withEnv({ OPENCODE_PROXY_REQUEST_TIMEOUT_MS: '60000' }, () => {
                expect(buildProxyConfig().REQUEST_TIMEOUT_MS).toBe(60000);
                withEnv({ OPENCODE_PROXY_REQUEST_TIMEOUT_MS: '60000ms' }, () => {
                    expect(buildProxyConfig().REQUEST_TIMEOUT_MS).toBe(300000);
                });
            });
        });
    });

    test('retry: options > canonical env > legacy env > default, no partial numerics', () => {
        withEnv({ OPENCODE_PROXY_RETRY_MAX_RETRIES: undefined, RETRY_MAX_RETRIES: undefined }, () => {
            expect(buildProxyConfig().RETRY_MAX_RETRIES).toBe(3);
            expect(resolveMaxRetries(buildProxyConfig().RETRY_MAX_RETRIES)).toBe(3);
            withEnv({ RETRY_MAX_RETRIES: '1' }, () => {
                expect(buildProxyConfig().RETRY_MAX_RETRIES).toBe(1);
                withEnv({ OPENCODE_PROXY_RETRY_MAX_RETRIES: '4' }, () => {
                    expect(buildProxyConfig().RETRY_MAX_RETRIES).toBe(4);
                    expect(buildProxyConfig({ RETRY_MAX_RETRIES: 2 }).RETRY_MAX_RETRIES).toBe(2);
                    expect(resolveMaxRetries(buildProxyConfig({ RETRY_MAX_RETRIES: 99 }).RETRY_MAX_RETRIES)).toBe(5);
                });
            });
        });
    });

    test('retry: invalid env values fall through and never parse partially', () => {
        withEnv({ OPENCODE_PROXY_RETRY_MAX_RETRIES: '3abc', RETRY_MAX_RETRIES: 'garbage' }, () => {
            expect(buildProxyConfig().RETRY_MAX_RETRIES).toBe(3);
        });
        withEnv({ OPENCODE_PROXY_RETRY_MAX_RETRIES: '', RETRY_MAX_RETRIES: '2' }, () => {
            expect(buildProxyConfig().RETRY_MAX_RETRIES).toBe(2);
        });
        withEnv({ OPENCODE_PROXY_RETRY_MAX_RETRIES: '2.9', RETRY_MAX_RETRIES: '' }, () => {
            expect(buildProxyConfig().RETRY_MAX_RETRIES).toBe(3);
        });
        expect(buildProxyConfig({ RETRY_MAX_RETRIES: '1x' }).RETRY_MAX_RETRIES).toBe(3);
        expect(buildProxyConfig({ RETRY_MAX_RETRIES: 0 }).RETRY_MAX_RETRIES).toBe(0);
    });

    test('external tool policy lists: options > canonical env > legacy env > default', () => {
        withEnv({
            OPENCODE_EXTERNAL_TOOL_ALLOWLIST: undefined,
            OPENCODE_EXTERNAL_TOOL_DENYLIST: undefined,
            OPENCODE_EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR: undefined,
            EXTERNAL_TOOL_ALLOWLIST: undefined,
            EXTERNAL_TOOL_DENYLIST: undefined,
            EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR: undefined,
        }, () => {
            const base = buildProxyConfig();
            expect(base.EXTERNAL_TOOL_POLICY_MODE).toBe(DEFAULT_EXTERNAL_TOOL_POLICY_MODE);
            expect(base.EXTERNAL_TOOL_DEFAULT_RISK_LEVEL).toBe(DEFAULT_EXTERNAL_TOOL_DEFAULT_RISK_LEVEL);
            expect(base.EXTERNAL_TOOL_ALLOWLIST).toEqual([]);
            expect(base.EXTERNAL_TOOL_DENYLIST).toEqual([]);
            expect(base.EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR).toEqual([]);
            withEnv({
                EXTERNAL_TOOL_ALLOWLIST: 'legacy_allow',
                EXTERNAL_TOOL_DENYLIST: 'legacy_deny',
                EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR: 'legacy_confirm',
            }, () => {
                const legacy = buildProxyConfig();
                expect(legacy.EXTERNAL_TOOL_ALLOWLIST).toEqual(['legacy_allow']);
                expect(legacy.EXTERNAL_TOOL_DENYLIST).toEqual(['legacy_deny']);
                expect(legacy.EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR).toEqual(['legacy_confirm']);
                withEnv({
                    OPENCODE_EXTERNAL_TOOL_ALLOWLIST: ' canon_allow , canon_allow ,b',
                    OPENCODE_EXTERNAL_TOOL_DENYLIST: 'canon_deny',
                    OPENCODE_EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR: 'canon_confirm',
                }, () => {
                    const canonical = buildProxyConfig();
                    expect(canonical.EXTERNAL_TOOL_ALLOWLIST).toEqual(['canon_allow', 'b']);
                    expect(canonical.EXTERNAL_TOOL_DENYLIST).toEqual(['canon_deny']);
                    expect(canonical.EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR).toEqual(['canon_confirm']);
                    const options = buildProxyConfig({
                        EXTERNAL_TOOL_ALLOWLIST: ['opt_allow'],
                        EXTERNAL_TOOL_DENYLIST: ['opt_deny'],
                        EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR: ['opt_confirm'],
                    });
                    expect(options.EXTERNAL_TOOL_ALLOWLIST).toEqual(['opt_allow']);
                    expect(options.EXTERNAL_TOOL_DENYLIST).toEqual(['opt_deny']);
                    expect(options.EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR).toEqual(['opt_confirm']);
                });
            });
        });
    });

    test('external tool policy mode/risk: invalid values fall through to the default', () => {
        withEnv({
            OPENCODE_EXTERNAL_TOOL_POLICY_MODE: undefined,
            EXTERNAL_TOOL_POLICY_MODE: undefined,
            OPENCODE_EXTERNAL_TOOL_DEFAULT_RISK_LEVEL: undefined,
            EXTERNAL_TOOL_DEFAULT_RISK_LEVEL: undefined,
        }, () => {
            withEnv({ OPENCODE_EXTERNAL_TOOL_POLICY_MODE: 'yolo', EXTERNAL_TOOL_DEFAULT_RISK_LEVEL: 'urgent' }, () => {
                expect(buildProxyConfig().EXTERNAL_TOOL_POLICY_MODE).toBe(DEFAULT_EXTERNAL_TOOL_POLICY_MODE);
                expect(buildProxyConfig().EXTERNAL_TOOL_DEFAULT_RISK_LEVEL).toBe(DEFAULT_EXTERNAL_TOOL_DEFAULT_RISK_LEVEL);
                withEnv({ EXTERNAL_TOOL_POLICY_MODE: 'report-only', EXTERNAL_TOOL_DEFAULT_RISK_LEVEL: 'HIGH' }, () => {
                    expect(buildProxyConfig().EXTERNAL_TOOL_POLICY_MODE).toBe('report-only');
                    expect(buildProxyConfig().EXTERNAL_TOOL_DEFAULT_RISK_LEVEL).toBe('high');
                    withEnv({ OPENCODE_EXTERNAL_TOOL_POLICY_MODE: 'enforce' }, () => {
                        expect(buildProxyConfig().EXTERNAL_TOOL_POLICY_MODE).toBe('enforce');
                    });
                    expect(buildProxyConfig({ EXTERNAL_TOOL_POLICY_MODE: 'report-only' }).EXTERNAL_TOOL_POLICY_MODE).toBe('report-only');
                    expect(buildProxyConfig({ EXTERNAL_TOOL_DEFAULT_RISK_LEVEL: 'critical' }).EXTERNAL_TOOL_DEFAULT_RISK_LEVEL)
                        .toBe('critical');
                });
            });
        });
    });

    test('unsupported EXTERNAL_TOOLS_MODE from options fails fast, invalid env falls through', () => {
        withEnv({ OPENCODE_EXTERNAL_TOOLS_MODE: undefined, OPENCODE_EXTERNAL_TOOLS_CONFLICT_POLICY: undefined }, () => {
            expect(() => buildProxyConfig({ EXTERNAL_TOOLS_MODE: 'passthrough' })).toThrow(/Unsupported EXTERNAL_TOOLS_MODE/);
            expect(() => buildProxyConfig({ externalToolsMode: 'passthrough' })).toThrow(/Unsupported EXTERNAL_TOOLS_MODE/);
            expect(() => buildProxyConfig({ EXTERNAL_TOOLS_CONFLICT_POLICY: 'drop' })).toThrow(/Unsupported EXTERNAL_TOOLS_CONFLICT_POLICY/);
            withEnv({ OPENCODE_EXTERNAL_TOOLS_MODE: 'passthrough', OPENCODE_EXTERNAL_TOOLS_CONFLICT_POLICY: 'drop' }, () => {
                expect(buildProxyConfig().EXTERNAL_TOOLS_MODE).toBe(DEFAULT_EXTERNAL_TOOLS_MODE);
                expect(buildProxyConfig().EXTERNAL_TOOLS_CONFLICT_POLICY).toBe(DEFAULT_EXTERNAL_TOOLS_CONFLICT_POLICY);
            });
            expect(buildProxyConfig({ EXTERNAL_TOOLS_MODE: 'proxy-bridge' }).EXTERNAL_TOOLS_MODE).toBe('proxy-bridge');
        });
    });

    test('upstream proxy legacy env aliases merge in the library path', () => {
        withEnv({
            OPENCODE_UPSTREAM_PROXY_STRATEGY: undefined,
            UPSTREAM_PROXY_STRATEGY: undefined,
            OPENCODE_UPSTREAM_PROXY_COOLDOWN_MS: undefined,
            UPSTREAM_PROXY_COOLDOWN_MS: undefined,
            OPENCODE_UPSTREAM_PROXY_NO_PROXY: undefined,
            UPSTREAM_PROXY_NO_PROXY: undefined,
            OPENCODE_UPSTREAM_PROXIES: undefined,
            UPSTREAM_PROXIES: undefined,
        }, () => {
            expect(buildProxyConfig().UPSTREAM_PROXY_STRATEGY).toBe('failover-rr');
            expect(buildProxyConfig().UPSTREAM_PROXY_COOLDOWN_MS).toBe(300000);
            expect(buildProxyConfig().UPSTREAM_PROXY_NO_PROXY).toEqual(['localhost', '127.0.0.1', '::1']);
            withEnv({
                UPSTREAM_PROXY_STRATEGY: 'random',
                UPSTREAM_PROXY_COOLDOWN_MS: '60000',
                UPSTREAM_PROXY_NO_PROXY: 'backend.internal,10.0.0.1',
                UPSTREAM_PROXIES: 'socks5://10.0.0.1:1080',
            }, () => {
                const legacy = buildProxyConfig();
                expect(legacy.UPSTREAM_PROXY_STRATEGY).toBe('random');
                expect(legacy.UPSTREAM_PROXY_COOLDOWN_MS).toBe(60000);
                expect(legacy.UPSTREAM_PROXY_NO_PROXY).toEqual(['backend.internal', '10.0.0.1']);
                expect(legacy.UPSTREAM_PROXIES).toEqual(['socks5://10.0.0.1:1080']);
                withEnv({ OPENCODE_UPSTREAM_PROXY_STRATEGY: 'round-robin' }, () => {
                    expect(buildProxyConfig().UPSTREAM_PROXY_STRATEGY).toBe('round-robin');
                    expect(buildProxyConfig({ UPSTREAM_PROXY_STRATEGY: 'random' }).UPSTREAM_PROXY_STRATEGY).toBe('random');
                });
                withEnv({ OPENCODE_UPSTREAM_PROXY_COOLDOWN_MS: 'garbage' }, () => {
                    expect(buildProxyConfig().UPSTREAM_PROXY_COOLDOWN_MS).toBe(60000);
                });
                withEnv({ OPENCODE_UPSTREAM_PROXY_NO_PROXY: '' }, () => {
                    expect(buildProxyConfig().UPSTREAM_PROXY_NO_PROXY).toEqual(['backend.internal', '10.0.0.1']);
                });
            });
        });
    });
});

// index.ts cannot be imported (it boots the server), so pin the exact layer
// arrays it passes to the shared normalizers.
describe('index.ts merge chain (mirrored)', () => {
    const file = (config) => config ?? {};

    const resolveIndexPort = (env, fileConfig) => resolvePortSetting(
        [env.OPENCODE_PROXY_PORT, env.PORT, file(fileConfig).PORT],
        DEFAULT_PROXY_PORT,
    );
    const resolveIndexServerPort = (env) => resolvePortSetting([env.OPENCODE_SERVER_PORT], DEFAULT_SERVER_PORT);
    const resolveIndexUrl = (env, fileConfig) => resolveUrlSetting(
        [env.OPENCODE_SERVER_URL, file(fileConfig).OPENCODE_SERVER_URL],
        `http://127.0.0.1:${resolveIndexServerPort(env)}`,
    );
    const resolveIndexPolicyMode = (env, fileConfig) => resolveEnumSetting(
        [env.OPENCODE_EXTERNAL_TOOL_POLICY_MODE, env.EXTERNAL_TOOL_POLICY_MODE, file(fileConfig).EXTERNAL_TOOL_POLICY_MODE],
        EXTERNAL_TOOL_POLICY_MODES,
        DEFAULT_EXTERNAL_TOOL_POLICY_MODE,
    );
    const resolveIndexRiskLevel = (env, fileConfig) => resolveEnumSetting(
        [
            env.OPENCODE_EXTERNAL_TOOL_DEFAULT_RISK_LEVEL,
            env.EXTERNAL_TOOL_DEFAULT_RISK_LEVEL,
            file(fileConfig).EXTERNAL_TOOL_DEFAULT_RISK_LEVEL,
        ],
        EXTERNAL_TOOL_RISK_LEVEL_VALUES,
        DEFAULT_EXTERNAL_TOOL_DEFAULT_RISK_LEVEL,
    );
    const resolveIndexAllowlist = (env, fileConfig) => resolveListSetting(
        [env.OPENCODE_EXTERNAL_TOOL_ALLOWLIST, env.EXTERNAL_TOOL_ALLOWLIST, file(fileConfig).EXTERNAL_TOOL_ALLOWLIST],
        [],
    );
    const resolveIndexRetries = (env, fileConfig) => resolveRetryCountSetting(
        [env.OPENCODE_PROXY_RETRY_MAX_RETRIES, env.RETRY_MAX_RETRIES, file(fileConfig).RETRY_MAX_RETRIES],
        3,
    );
    const resolveIndexBool = (env, fileConfig, canonical, fileKey, fallback) => resolveBoolSetting(
        [env[canonical], file(fileConfig)[fileKey]],
        fallback,
    );
    const resolveIndexStrategy = (env, fileConfig) => resolveEnumSetting(
        [env.OPENCODE_UPSTREAM_PROXY_STRATEGY, env.UPSTREAM_PROXY_STRATEGY, file(fileConfig).UPSTREAM_PROXY_STRATEGY],
        PROXY_STRATEGIES,
        DEFAULT_PROXY_STRATEGY,
    );

    test('PORT: canonical > legacy > file > default, invalid falls through', () => {
        expect(resolveIndexPort({}, {})).toBe(DEFAULT_PROXY_PORT);
        expect(resolveIndexPort({}, { PORT: 11000 })).toBe(11000);
        expect(resolveIndexPort({ PORT: '12000' }, { PORT: 11000 })).toBe(12000);
        expect(resolveIndexPort({ OPENCODE_PROXY_PORT: '13000', PORT: '12000' }, { PORT: 11000 })).toBe(13000);
        expect(resolveIndexPort({ OPENCODE_PROXY_PORT: '0' }, { PORT: 11000 })).toBe(11000);
        expect(resolveIndexPort({ OPENCODE_PROXY_PORT: 'abc', PORT: '' }, { PORT: 11000 })).toBe(11000);
        expect(resolveIndexPort({ OPENCODE_PROXY_PORT: '65536' }, { PORT: 11000 })).toBe(11000);
    });

    test('OPENCODE_SERVER_PORT validates 1..65535 and only bakes the default URL', () => {
        expect(resolveIndexServerPort({})).toBe(DEFAULT_SERVER_PORT);
        expect(resolveIndexServerPort({ OPENCODE_SERVER_PORT: '10002' })).toBe(10002);
        for (const bad of ['0', '65536', 'abc', '100 01', '']) {
            expect(resolveIndexServerPort({ OPENCODE_SERVER_PORT: bad })).toBe(DEFAULT_SERVER_PORT);
        }
        expect(resolveIndexUrl({ OPENCODE_SERVER_PORT: '10002' }, {})).toBe('http://127.0.0.1:10002');
        expect(resolveIndexUrl({ OPENCODE_SERVER_PORT: '10002', OPENCODE_SERVER_URL: 'https://x.example' }, {}))
            .toBe('https://x.example');
        expect(resolveIndexUrl({ OPENCODE_SERVER_URL: 'nope' }, { OPENCODE_SERVER_URL: 'http://file.example' }))
            .toBe('http://file.example');
    });

    test('file bools use the same strict parser as env', () => {
        expect(resolveIndexBool({}, { HEALTH_DETAILS_ENABLED: false }, 'OPENCODE_HEALTH_DETAILS_ENABLED', 'HEALTH_DETAILS_ENABLED', true))
            .toBe(false);
        expect(resolveIndexBool({}, { HEALTH_DETAILS_ENABLED: 'garbage' }, 'OPENCODE_HEALTH_DETAILS_ENABLED', 'HEALTH_DETAILS_ENABLED', true))
            .toBe(true);
        expect(resolveIndexBool({ OPENCODE_HEALTH_DETAILS_ENABLED: 'yes' }, { HEALTH_DETAILS_ENABLED: false }, 'OPENCODE_HEALTH_DETAILS_ENABLED', 'HEALTH_DETAILS_ENABLED', true))
            .toBe(true);
        expect(resolveIndexBool({ OPENCODE_HEALTH_DETAILS_ENABLED: 'maybe' }, { HEALTH_DETAILS_ENABLED: false }, 'OPENCODE_HEALTH_DETAILS_ENABLED', 'HEALTH_DETAILS_ENABLED', true))
            .toBe(false);
        expect(resolveIndexBool({}, {}, 'OPENCODE_METRICS_ENABLED', 'METRICS_ENABLED', false)).toBe(false);
        expect(resolveIndexBool({ OPENCODE_METRICS_ENABLED: 'garbage' }, {}, 'OPENCODE_METRICS_ENABLED', 'METRICS_ENABLED', false)).toBe(false);
    });

    test('external tool policy: canonical > legacy > file > default', () => {
        expect(resolveIndexPolicyMode({}, {})).toBe(DEFAULT_EXTERNAL_TOOL_POLICY_MODE);
        expect(resolveIndexPolicyMode({}, { EXTERNAL_TOOL_POLICY_MODE: 'report-only' })).toBe('report-only');
        expect(resolveIndexPolicyMode({ EXTERNAL_TOOL_POLICY_MODE: 'enforce' }, { EXTERNAL_TOOL_POLICY_MODE: 'report-only' })).toBe('enforce');
        expect(resolveIndexPolicyMode({ OPENCODE_EXTERNAL_TOOL_POLICY_MODE: 'report-only', EXTERNAL_TOOL_POLICY_MODE: 'enforce' }, {}))
            .toBe('report-only');
        expect(resolveIndexPolicyMode({ OPENCODE_EXTERNAL_TOOL_POLICY_MODE: 'nope' }, { EXTERNAL_TOOL_POLICY_MODE: 'report-only' }))
            .toBe('report-only');
        expect(resolveIndexPolicyMode({ OPENCODE_EXTERNAL_TOOL_POLICY_MODE: 'nope', EXTERNAL_TOOL_POLICY_MODE: '' }, { EXTERNAL_TOOL_POLICY_MODE: 'yolo' }))
            .toBe(DEFAULT_EXTERNAL_TOOL_POLICY_MODE);
    });

    test('external tool policy risk level and allowlist merge the same way', () => {
        expect(resolveIndexRiskLevel({}, {})).toBe(DEFAULT_EXTERNAL_TOOL_DEFAULT_RISK_LEVEL);
        expect(resolveIndexRiskLevel({ EXTERNAL_TOOL_DEFAULT_RISK_LEVEL: 'medium' }, { EXTERNAL_TOOL_DEFAULT_RISK_LEVEL: 'high' })).toBe('medium');
        expect(resolveIndexRiskLevel({ OPENCODE_EXTERNAL_TOOL_DEFAULT_RISK_LEVEL: 'CRITICAL', EXTERNAL_TOOL_DEFAULT_RISK_LEVEL: 'low' }, {}))
            .toBe('critical');
        expect(resolveIndexRiskLevel({ OPENCODE_EXTERNAL_TOOL_DEFAULT_RISK_LEVEL: 'nope' }, { EXTERNAL_TOOL_DEFAULT_RISK_LEVEL: 'low' })).toBe('low');
        expect(resolveIndexAllowlist({}, {})).toEqual([]);
        expect(resolveIndexAllowlist({ EXTERNAL_TOOL_ALLOWLIST: 'a' }, { EXTERNAL_TOOL_ALLOWLIST: ['b'] })).toEqual(['a']);
        expect(resolveIndexAllowlist({ OPENCODE_EXTERNAL_TOOL_ALLOWLIST: ' x , y ', EXTERNAL_TOOL_ALLOWLIST: 'a' }, {})).toEqual(['x', 'y']);
        expect(resolveIndexAllowlist({ OPENCODE_EXTERNAL_TOOL_ALLOWLIST: '' }, { EXTERNAL_TOOL_ALLOWLIST: 'a' })).toEqual(['a']);
    });

    test('RETRY_MAX_RETRIES: canonical > legacy > file > default, no partial numerics', () => {
        expect(resolveIndexRetries({}, {})).toBe(3);
        expect(resolveIndexRetries({}, { RETRY_MAX_RETRIES: 1 })).toBe(1);
        expect(resolveIndexRetries({ RETRY_MAX_RETRIES: '2' }, { RETRY_MAX_RETRIES: 1 })).toBe(2);
        expect(resolveIndexRetries({ OPENCODE_PROXY_RETRY_MAX_RETRIES: '4', RETRY_MAX_RETRIES: '2' }, {})).toBe(4);
        expect(resolveIndexRetries({ OPENCODE_PROXY_RETRY_MAX_RETRIES: '4abc' }, { RETRY_MAX_RETRIES: '2' })).toBe(2);
        expect(resolveIndexRetries({ OPENCODE_PROXY_RETRY_MAX_RETRIES: 'garbage', RETRY_MAX_RETRIES: '' }, { RETRY_MAX_RETRIES: 0 })).toBe(0);
        // Out-of-range values stay raw here; the 0-5 clamp stays owned by
        // resolveMaxRetries so the merge never silently reinterprets them.
        expect(resolveIndexRetries({ OPENCODE_PROXY_RETRY_MAX_RETRIES: '-1' }, {})).toBe(-1);
        expect(resolveMaxRetries(resolveIndexRetries({ OPENCODE_PROXY_RETRY_MAX_RETRIES: '-1' }, {}))).toBe(0);
        expect(resolveMaxRetries(resolveIndexRetries({ OPENCODE_PROXY_RETRY_MAX_RETRIES: '99' }, {}))).toBe(5);
    });

    test('UPSTREAM_PROXY_* legacy env aliases merge ahead of the file', () => {
        expect(resolveIndexStrategy({}, {})).toBe('failover-rr');
        expect(resolveIndexStrategy({}, { UPSTREAM_PROXY_STRATEGY: 'random' })).toBe('random');
        expect(resolveIndexStrategy({ UPSTREAM_PROXY_STRATEGY: 'round-robin' }, { UPSTREAM_PROXY_STRATEGY: 'random' })).toBe('round-robin');
        expect(resolveIndexStrategy({ OPENCODE_UPSTREAM_PROXY_STRATEGY: 'random', UPSTREAM_PROXY_STRATEGY: 'round-robin' }, {}))
            .toBe('random');
        expect(resolveIndexStrategy({ OPENCODE_UPSTREAM_PROXY_STRATEGY: 'garbage', UPSTREAM_PROXY_STRATEGY: 'random' }, {}))
            .toBe('random');
    });
});
