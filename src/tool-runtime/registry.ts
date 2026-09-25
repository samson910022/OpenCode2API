import {
  EXTERNAL_TOOL_PREFIX,
  TOOL_RISK_LEVELS,
  TOOL_SIDE_EFFECTS,
  normalizeRiskLevel,
  normalizeSideEffect
} from './contracts.js';
import { qualifyToolName } from '../converters/chat-responses/request.js';
import { isHostedSearchType } from '../search/grounding.js';
import type { ToolRiskLevel, ToolSideEffect } from './contracts.js';
import { asRecord } from '../utils/guards.js';

/** Shared extension fields carried alongside a client tool definition. */
export interface ToolDefinitionExtras {
  enabled?: unknown;
  [key: string]: unknown;
}

/** Function payload nested under `tool.function` (Chat Completions shape). */
export interface ChatFunctionPayload extends ToolDefinitionExtras {
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
  input_schema?: unknown;
}

/** Shape 1 — Chat Completions nests the definition under `function`. */
export interface ChatFunctionNestedTool extends ToolDefinitionExtras {
  type: 'function';
  function: ChatFunctionPayload;
}

/** Shape 2 — Responses API keeps the definition flat. */
export interface ResponsesFlatTool extends ToolDefinitionExtras {
  type: 'function';
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
  input_schema?: unknown;
  function?: unknown;
}

/** Shape 3 — Anthropic Messages shape uses `input_schema` instead of `parameters`. */
export interface AnthropicInputSchemaTool extends ToolDefinitionExtras {
  type: 'function';
  name?: unknown;
  description?: unknown;
  input_schema?: unknown;
  parameters?: unknown;
  function?: unknown;
}

/** The three function-tool shapes the proxy receives. */
export type IncomingToolDefinition =
  | ChatFunctionNestedTool
  | ResponsesFlatTool
  | AnthropicInputSchemaTool;

/** Normalized view produced by {@link normalizeToolDefinition}. */
export interface NormalizedToolDefinition {
  name: string;
  declaredName: string;
  description: unknown;
  parameters: unknown;
  enabled: unknown;
  x_proxy_side_effect: unknown;
  x_proxy_risk_level: unknown;
  x_proxy_requires_confirmation: unknown;
}

/** A single namespaced external tool in the request registry. */
export interface ExternalToolEntry {
  id: string;
  originalName: string;
  namespacedName: string;
  declaredName: string;
  description: string;
  parameters: Record<string, unknown>;
  sideEffect: ToolSideEffect;
  riskLevel: ToolRiskLevel;
  requiresConfirmation: boolean;
  enabled: boolean;
  sourceTool: unknown;
}

export type ToolRegistry = ExternalToolEntry[];

export const FUNCTION_TOOL_TYPE = 'function';
export const CUSTOM_TOOL_TYPE = 'custom';
export const NAMESPACE_TOOL_TYPE = 'namespace';
export const ADDITIONAL_TOOLS_ITEM_TYPE = 'additional_tools';

export const CUSTOM_TOOL_FALLBACK_NAME = 'custom_tool';

export const PROXY_LEAF_NAME_KEY = '__proxy_leaf_name';

/**
 * Declaration keys the proxy reserves for itself. They are stripped from every
 * client declaration and never read back out of a request body: the leaf name,
 * the inferred side effect/risk and the confirmation flag are proxy-authored
 * (expansion/registry), so a client cannot forge a `delete_all` tool into a
 * harmless-looking `read`.
 */
export const INTERNAL_TOOL_METADATA_KEYS = [
  PROXY_LEAF_NAME_KEY,
  'x_proxy_side_effect',
  'x_proxy_risk_level',
  'x_proxy_requires_confirmation',
] as const;

/** Declaration fields a namespace container passes down to its leaves. */
const INHERITABLE_DECLARATION_KEYS = ['enabled'] as const;

/** Values only the proxy may author. Held out-of-band so no body can carry them. */
export interface InternalToolMetadata {
  declaredName?: string;
  sideEffect?: unknown;
  riskLevel?: unknown;
  requiresConfirmation?: unknown;
}

const internalToolMetadata = new WeakMap<object, InternalToolMetadata>();

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readInternalToolMetadata(source: unknown): InternalToolMetadata {
  if (!source || typeof source !== 'object') return {};
  return internalToolMetadata.get(source as object) ?? {};
}

function attachInternalToolMetadata(target: Record<string, unknown>, metadata: InternalToolMetadata): void {
  internalToolMetadata.set(target, metadata);
}

function stripInternalToolMetadataKeys(record: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if ((INTERNAL_TOOL_METADATA_KEYS as readonly string[]).includes(key)) continue;
    next[key] = value;
  }
  return next;
}

export const CUSTOM_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: { input: { type: 'string' } },
  required: ['input'],
};

export const TOOL_DECLARATION_ERROR_CODES = {
  UNSUPPORTED_TYPE: 'unsupported_tool_type',
  INVALID_DECLARATION: 'invalid_tool_declaration',
} as const;

export interface ToolDeclarationIssue {
  code: string;
  toolType: string;
  path: string;
  message: string;
}

export interface ToolDeclarationSource {
  path: string;
  tools: unknown;
}

export interface ToolDeclarationExpansion {
  tools: Record<string, unknown>[];
  issues: ToolDeclarationIssue[];
  customToolNames: string[];
}

export interface RegistryIndex {
  byOriginalName: Map<string, ExternalToolEntry>;
  byNamespacedName: Map<string, ExternalToolEntry>;
}

export interface BuildRegistryOptions {
  prefix?: unknown;
  [key: string]: unknown;
}

function normalizeDescription(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeParameters(parameters: unknown): Record<string, unknown> {
  if (parameters && typeof parameters === 'object' && !Array.isArray(parameters)) {
    return parameters as Record<string, unknown>;
  }
  return { type: 'object', properties: {} };
}

/**
 * Normalizes the two function-tool shapes the proxy receives.
 *
 * Chat Completions nests the definition:  { type:'function', function:{ name, parameters } }
 * The Responses API keeps it flat:        { type:'function', name, parameters }
 *
 * Callers used to read `tool.function.name` directly, so every Responses-API tool was
 * silently dropped from the registry. An empty registry means no tool contract reaches the
 * prompt and no tool-call markup is ever parsed back out, which is indistinguishable from
 * a model that simply refuses to call tools.
 */
export function normalizeToolDefinition(tool: unknown): NormalizedToolDefinition | null {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return null;
  const candidate = tool as IncomingToolDefinition & Record<string, unknown>;
  if (candidate['type'] !== 'function') return null;
  // Narrow the union: Chat shape carries `function` as an object; the flat and
  // Anthropic shapes are used directly.
  const maybeFn: unknown = (candidate as ChatFunctionNestedTool).function;
  const definition: Record<string, unknown> =
    maybeFn && typeof maybeFn === 'object' && !Array.isArray(maybeFn)
      ? (maybeFn as Record<string, unknown>)
      : (candidate as unknown as Record<string, unknown>);
  const name = String(definition['name'] || '').trim();
  if (!name) return null;
  const topLevel = candidate as unknown as Record<string, unknown>;
  // Anthropic Messages shape uses `input_schema` instead of `parameters`.
  const parameters: unknown = definition['parameters'] ?? definition['input_schema'];
  // Policy metadata comes from the proxy's own out-of-band channel only. A
  // declaration that still carries `__proxy_leaf_name`/`x_proxy_*` (a client
  // body sent straight to buildExternalToolRegistry, or a spoofed copy) is
  // ignored here, so the leaf name, side effect and risk stay proxy-authored.
  const internal = readInternalToolMetadata(candidate);
  return {
    name,
    declaredName: resolveDeclaredLeafName(name, internal.declaredName),
    description: definition['description'],
    parameters,
    enabled: definition['enabled'] ?? topLevel['enabled'],
    x_proxy_side_effect: internal.sideEffect,
    x_proxy_risk_level: internal.riskLevel,
    x_proxy_requires_confirmation: internal.requiresConfirmation
  };
}

function resolveDeclaredLeafName(name: string, annotated: unknown): string {
  const declared = typeof annotated === 'string' ? annotated.trim() : '';
  if (!declared) return name;
  if (name === declared) return declared;
  if (name.endsWith(`__${declared}`)) return declared;
  return name;
}

function inferSideEffect(declaredName: string, metadata: InternalToolMetadata): ToolSideEffect {
  const declared: unknown = metadata.sideEffect;
  if (declared !== undefined && declared !== null) return normalizeSideEffect(declared, TOOL_SIDE_EFFECTS.NONE);

  const name = String(declaredName || '').toLowerCase();
  if (/^(get|list|search|find|read|fetch|lookup)/.test(name)) return TOOL_SIDE_EFFECTS.READ;
  if (/^(create|update|set|post|write|send)/.test(name)) return TOOL_SIDE_EFFECTS.WRITE;
  if (/^(delete|remove|destroy)/.test(name)) return TOOL_SIDE_EFFECTS.DELETE;
  return TOOL_SIDE_EFFECTS.NONE;
}

function inferRiskLevel(sideEffect: ToolSideEffect, metadata: InternalToolMetadata): ToolRiskLevel {
  const declared: unknown = metadata.riskLevel;
  if (declared !== undefined && declared !== null) return normalizeRiskLevel(declared, TOOL_RISK_LEVELS.LOW);
  if (sideEffect === TOOL_SIDE_EFFECTS.DELETE || sideEffect === TOOL_SIDE_EFFECTS.PAYMENT) {
    return TOOL_RISK_LEVELS.CRITICAL;
  }
  if (sideEffect === TOOL_SIDE_EFFECTS.WRITE || sideEffect === TOOL_SIDE_EFFECTS.EXTERNAL_NOTIFICATION) {
    return TOOL_RISK_LEVELS.MEDIUM;
  }
  return TOOL_RISK_LEVELS.LOW;
}

function inferRequiresConfirmation(metadata: InternalToolMetadata): boolean {
  return metadata.requiresConfirmation === true;
}

export function buildExternalToolRegistry(tools: unknown, options: unknown = {}): ExternalToolEntry[] {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  const opts = asRecord(options);
  const prefixRaw: unknown = opts['prefix'];
  const prefix = prefixRaw ? String(prefixRaw) : EXTERNAL_TOOL_PREFIX;
  const registry: ExternalToolEntry[] = [];
  const seenNamespaced = new Set<string>();

  (tools as unknown[]).forEach((tool: unknown, index: number) => {
    const definition = normalizeToolDefinition(tool);
    if (!definition) return;
    const originalName = definition.name;

    let namespacedName = `${prefix}${originalName}`;
    let counter = 2;
    while (seenNamespaced.has(namespacedName)) {
      namespacedName = `${prefix}${originalName}_${counter}`;
      counter += 1;
    }
    seenNamespaced.add(namespacedName);

    // Inference runs on the proxy-authored bare leaf, so a namespace-qualified
    // name (`gh__delete_repo`) can never dodge the `delete*` rule.
    const metadata = readInternalToolMetadata(tool);
    const sideEffect = inferSideEffect(definition.declaredName, metadata);
    const riskLevel = inferRiskLevel(sideEffect, metadata);
    registry.push({
      id: `external_tool_${index + 1}`,
      originalName,
      namespacedName,
      declaredName: definition.declaredName,
      description: normalizeDescription(definition.description),
      parameters: normalizeParameters(definition.parameters),
      sideEffect,
      riskLevel,
      requiresConfirmation: inferRequiresConfirmation(metadata),
      enabled: definition.enabled !== false,
      sourceTool: tool
    });
  });

  return registry;
}

export function findExternalToolByName(registry: unknown, name: unknown): ExternalToolEntry | null {
  if (!name || !Array.isArray(registry)) return null;
  const list = registry as ExternalToolEntry[];
  const exact = list.find((tool) => tool.namespacedName === name || tool.originalName === name);
  if (exact) return exact;

  // Models frequently drop separators or change case when emitting a tool name
  // (e.g. the request declares `web_fetch` but the model writes `webfetch`).
  // Fall back to a separator/case-insensitive match, but only when it is
  // unambiguous — an exact match always wins and a tie resolves to nothing.
  const normalized = normalizeToolNameForMatch(name);
  if (!normalized) return null;
  const matches = list.filter((tool) =>
    normalizeToolNameForMatch(tool.namespacedName) === normalized ||
    normalizeToolNameForMatch(tool.originalName) === normalized
  );
  return matches.length === 1 && matches[0] ? matches[0] : null;
}

// Shared with the internal-allowlist matcher (proxy.ts) so `web_fetch` and
// `webfetch` (likewise `web_search`/`websearch`) resolve identically on both
// the external-bridge and internal-allowlist paths.
export function normalizeToolNameForMatch(name: unknown): string {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Collect the `additional_tools` declarations a request carries.
 *
 * Accepts the raw request input: an array (`input[1].tools`) or the single
 * object form, which the client wrote as `input.tools`. A malformed `tools`
 * payload is still returned as a source so the expansion reports it instead of
 * silently dropping the item.
 */
export function collectAdditionalToolSources(input: unknown, pathPrefix = 'input'): ToolDeclarationSource[] {
  const indexed = Array.isArray(input);
  const items: unknown[] = indexed
    ? (input as unknown[])
    : input && typeof input === 'object'
      ? [input]
      : [];
  const sources: ToolDeclarationSource[] = [];
  items.forEach((item: unknown, index: number) => {
    const record = asRecord(item);
    if (record['type'] !== ADDITIONAL_TOOLS_ITEM_TYPE) return;
    const itemPath = indexed ? `${pathPrefix}[${index}]` : pathPrefix;
    sources.push({ path: `${itemPath}.tools`, tools: record['tools'] });
  });
  return sources;
}

function declarationTypeOf(tool: unknown): string {
  const raw = asRecord(tool)['type'];
  return typeof raw === 'string' ? raw.trim() : '';
}

function declarationFunctionNameOf(tool: unknown): string {
  const record = asRecord(tool);
  const nested = asRecord(record['function']);
  const name = record['name'] ?? nested['name'];
  return typeof name === 'string' ? name.trim() : '';
}

function customDeclarationNameOf(tool: unknown): string {
  const record = asRecord(tool);
  const custom = record['custom'];
  const customName =
    custom && typeof custom === 'object' && !Array.isArray(custom)
      ? String(asRecord(custom)['name'] ?? '').trim()
      : typeof custom === 'string'
        ? custom.trim()
        : '';
  return declarationFunctionNameOf(tool) || customName || CUSTOM_TOOL_FALLBACK_NAME;
}

function collectInheritedMetadata(container: Record<string, unknown>, inherited: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...inherited };
  for (const key of INHERITABLE_DECLARATION_KEYS) {
    // Presence, not `!== undefined`: an explicit `null` on a container must
    // clear what an outer container declared, not fall through to it.
    if (hasOwn(container, key)) next[key] = container[key];
  }
  return next;
}

function buildLeafDeclaration(
  record: Record<string, unknown>,
  name: string,
  leafName: string,
  custom: boolean,
  inherited: Record<string, unknown>,
): Record<string, unknown> {
  const next = stripInternalToolMetadataKeys(record);
  next['type'] = FUNCTION_TOOL_TYPE;
  next['name'] = name;
  if (custom) next['parameters'] = CUSTOM_TOOL_PARAMETERS;
  const nested = asRecord(record['function']);
  if (Object.keys(nested).length > 0) {
    const nestedNext = stripInternalToolMetadataKeys(nested);
    nestedNext['name'] = name;
    next['function'] = nestedNext;
  }
  for (const key of INHERITABLE_DECLARATION_KEYS) {
    if (!hasOwn(next, key) && hasOwn(inherited, key)) next[key] = inherited[key];
  }
  // The bare leaf name is proxy-authored: nothing in the request body can set
  // or override it, so risk/side-effect inference stays trustworthy.
  attachInternalToolMetadata(next, { declaredName: leafName });
  return next;
}

/** Deterministic serialization so two declarations compare by value, not key order. */
function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}

/**
 * Identity of a declaration as the registry will see it. Two declarations that
 * land on the same name are only interchangeable when this matches, so a
 * conflicting duplicate can be reported instead of silently losing a schema.
 */
function declarationSignature(record: Record<string, unknown>, custom: boolean): string {
  const nested = asRecord(record['function']);
  const read = (key: string): unknown => (hasOwn(record, key) ? record[key] : nested[key]);
  return stableStringify({
    custom,
    description: normalizeDescription(read('description')),
    parameters: custom ? CUSTOM_TOOL_PARAMETERS : normalizeParameters(read('parameters') ?? read('input_schema')),
    enabled: read('enabled') !== false
  });
}

function invalidDeclarationIssue(toolType: string, path: string, message: string): ToolDeclarationIssue {
  return { code: TOOL_DECLARATION_ERROR_CODES.INVALID_DECLARATION, toolType, path, message };
}

export function expandToolDeclarationSources(sources: unknown): ToolDeclarationExpansion {
  const list = Array.isArray(sources) ? (sources as unknown[]) : [];
  const issues: ToolDeclarationIssue[] = [];
  const customToolNames: string[] = [];
  const expandedTools: Record<string, unknown>[] = [];
  const emitted = new Map<string, { signature: string; path: string }>();
  const walk = (items: unknown, path: string, namespacePath: string, inherited: Record<string, unknown>): void => {
    if (!Array.isArray(items)) return;
    (items as unknown[]).forEach((tool: unknown, index: number) => {
      const itemPath = `${path}[${index}]`;
      const record = asRecord(tool);
      const type = declarationTypeOf(tool);
      if (isHostedSearchType(type)) return;
      if (type === NAMESPACE_TOOL_TYPE) {
        const namespaceName = typeof record['name'] === 'string' ? record['name'].trim() : '';
        const nextPath = qualifyToolName(namespacePath, namespaceName);
        const children = record['tools'];
        if (!nextPath) {
          issues.push(invalidDeclarationIssue(type, itemPath, `Namespace tool at ${itemPath} requires a name.`));
          return;
        }
        if (!Array.isArray(children) || children.length === 0) {
          issues.push(
            invalidDeclarationIssue(type, itemPath, `Namespace tool at ${itemPath} declares no nested tools.`),
          );
          return;
        }
        walk(children as unknown[], `${itemPath}.tools`, nextPath, collectInheritedMetadata(record, inherited));
        return;
      }
      if (type !== FUNCTION_TOOL_TYPE && type !== CUSTOM_TOOL_TYPE) {
        const label = type || 'missing';
        issues.push({
          code: TOOL_DECLARATION_ERROR_CODES.UNSUPPORTED_TYPE,
          toolType: label,
          path: itemPath,
          message: `Unsupported tool type "${label}" at ${itemPath}${namespacePath ? ` in namespace "${namespacePath}"` : ''}. Only function, custom and namespace tools are supported.`,
        });
        return;
      }
      const custom = type === CUSTOM_TOOL_TYPE;
      const leafName = custom ? customDeclarationNameOf(tool) : declarationFunctionNameOf(tool);
      if (!leafName) {
        issues.push(invalidDeclarationIssue(type, itemPath, `Function tool at ${itemPath} requires a name.`));
        return;
      }
      const name = namespacePath ? qualifyToolName(namespacePath, leafName) : leafName;
      const signature = declarationSignature(record, custom);
      const declared = emitted.get(name);
      if (declared) {
        if (declared.signature === signature) return;
        issues.push(
          invalidDeclarationIssue(
            type,
            itemPath,
            `Tool "${name}" at ${itemPath} conflicts with the declaration at ${declared.path}. Only an identical repeated declaration is deduplicated.`,
          ),
        );
        return;
      }
      emitted.set(name, { signature, path: itemPath });
      if (custom) customToolNames.push(name);
      expandedTools.push(buildLeafDeclaration(record, name, leafName, custom, inherited));
    });
  };
  for (const source of list) {
    const entry = asRecord(source);
    const path = typeof entry['path'] === 'string' && entry['path'] ? (entry['path'] as string) : 'tools';
    const declared = entry['tools'];
    // A source whose payload is not an array (an `additional_tools` item with
    // `tools: {}`, a string, nothing at all) is an invalid declaration, never a
    // silently empty tool set.
    if (declared !== undefined && !Array.isArray(declared)) {
      issues.push(
        invalidDeclarationIssue(
          ADDITIONAL_TOOLS_ITEM_TYPE,
          path,
          `Additional tool declarations at ${path} must be an array.`,
        ),
      );
      continue;
    }
    walk(declared, path, '', {});
  }
  return { tools: expandedTools, issues, customToolNames };
}

export function expandToolDeclarations(tools: unknown): ToolDeclarationExpansion {
  return expandToolDeclarationSources([{ path: 'tools', tools }]);
}

export function findExternalToolByExactName(registry: unknown, name: unknown): ExternalToolEntry | null {
  if (typeof name !== 'string' || !name) return null;
  if (!Array.isArray(registry)) return null;
  return (
    (registry as ExternalToolEntry[]).find(
      (tool) => tool.originalName === name || tool.namespacedName === name,
    ) ?? null
  );
}

export function resolveExternalToolName(registry: unknown, name: unknown, namespace?: unknown): ExternalToolEntry | null {
  if (typeof name !== 'string' || !name.trim()) return null;
  if (!Array.isArray(registry)) return null;
  const raw = name.trim();
  const list = registry as ExternalToolEntry[];
  if (typeof namespace === 'string' && namespace.trim()) {
    const qualified = qualifyToolName(namespace, raw);
    if (qualified && qualified !== raw) {
      const hinted = list.find((tool) => tool.originalName === qualified || tool.namespacedName === qualified);
      if (hinted) return hinted;
    }
  }
  return list.find((tool) => tool.originalName === raw || tool.namespacedName === raw) ?? null;
}

export function createRegistryIndex(registry: unknown): RegistryIndex {
  const byOriginalName = new Map<string, ExternalToolEntry>();
  const byNamespacedName = new Map<string, ExternalToolEntry>();
  const list: ExternalToolEntry[] = Array.isArray(registry) ? (registry as ExternalToolEntry[]) : [];
  list.forEach((tool) => {
    byOriginalName.set(tool.originalName, tool);
    byNamespacedName.set(tool.namespacedName, tool);
  });
  return { byOriginalName, byNamespacedName };
}
