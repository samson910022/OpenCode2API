// Backend permission lockdown (pure, no Express/SDK deps).
//
// Why: the headless backend (opencode serve) must never `ask` — nobody can
// approve, so the prompt hangs until the proxy 180s timeout — and must not
// silently execute tools the proxy did not authorize. The free-tier strip
// (selectPromptToolOverrides, src/proxy.ts) omits the prompt `tools` map for
// suspect models, which makes the backend fall back to agent defaults (all
// internal tools on). Observed live: backend invoked real internal `read` on
// /tmp/*, hit `external_directory ask`, hung forever.
//
// Posture: deny-all by default; only explicitly allowlisted internal tools
// are allowed (explicit opt-in preserved). external_directory is always
// jailed to the backend project dir so allowed file tools cannot escape it.
// Unknown allowlist names are ignored (never emitted) to stay schema-valid
// per https://opencode.ai/config.json (PermissionConfig keys).

/** Backend project dir inside the container (session working scope). */
export const BACKEND_PROJECT_DIR = '/home/node/project';

/** Schema-valid opencode permission keys (PermissionConfig). */
export const BACKEND_PERMISSION_TOOL_KEYS: readonly string[] = [
  'read',
  'edit',
  'glob',
  'grep',
  'list',
  'bash',
  'task',
  'external_directory',
  'todowrite',
  'question',
  'webfetch',
  'websearch',
  'lsp',
  'doom_loop',
  'skill',
];

/** Flat-action keys take a bare "allow"/"deny" string, never an object. */
const FLAT_ACTION_KEYS: ReadonlySet<string> = new Set([
  'todowrite',
  'question',
  'webfetch',
  'websearch',
  'doom_loop',
]);

function normalizeToolName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.toLowerCase().replace(/[_-]+/g, '');
}

function normalizedKeyMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const key of BACKEND_PERMISSION_TOOL_KEYS) {
    map.set(key.toLowerCase().replace(/[_-]+/g, ''), key);
  }
  return map;
}

/**
 * Build the backend `permission` record.
 * @param allowedTools explicit internal allowlist (array of names, any case;
 *   `web_fetch`/`WEB-FETCH` alias to the `webfetch` schema key). Unknown
 *   names are ignored.
 * @param webFetchEnabled legacy shortcut: allow `webfetch` when no explicit
 *   list is configured (mirrors the proxy internal-allowlist resolution).
 * @param projectDir backend project scope for the external_directory jail
 *   (container default; isolated-home callers pass their jail workspace).
 */
export function buildBackendPermission(
  allowedTools: unknown = [],
  webFetchEnabled: unknown = false,
  projectDir: unknown = BACKEND_PROJECT_DIR,
): Record<string, unknown> {
  const keyByNormalized = normalizedKeyMap();
  const allowed = new Set<string>();
  const entries = Array.isArray(allowedTools) ? allowedTools : [];
  for (const entry of entries) {
    const schemaKey = keyByNormalized.get(normalizeToolName(entry) ?? '');
    if (schemaKey && schemaKey !== 'external_directory') allowed.add(schemaKey);
  }
  if (allowed.size === 0 && webFetchEnabled === true) allowed.add('webfetch');

  const scope = typeof projectDir === 'string' && projectDir.trim() ? projectDir.trim() : BACKEND_PROJECT_DIR;
  const permission: Record<string, unknown> = {};
  for (const key of BACKEND_PERMISSION_TOOL_KEYS) {
    if (key === 'external_directory') {
      permission[key] = { [`${scope}/**`]: 'allow', '*': 'deny' };
    } else {
      permission[key] = allowed.has(key) ? 'allow' : 'deny';
    }
  }
  return permission;
}
