import type { ExternalToolEntry } from './registry.js';

/** String shorthand accepted by Chat Completions (`auto` / `none` / `required`). */
export type ChatStringToolChoice = 'auto' | 'none' | 'required';

/** Chat Completions object shape: `{ type:'function', function:{ name } }` (nested). */
export interface ChatNestedFunctionToolChoice {
  type: 'function';
  function?: { name?: unknown; [key: string]: unknown } | null;
  name?: unknown;
  [key: string]: unknown;
}

/** Responses API object shape: `{ type:'function', name }` (flat). */
export interface ChatFlatFunctionToolChoice {
  type: 'function';
  name?: unknown;
  function?: unknown;
  [key: string]: unknown;
}

/** Anthropic Messages shapes: `{ type: 'auto' | 'any' | 'tool' | 'none', name? }`. */
export interface AnthropicAutoToolChoice {
  type: 'auto';
  name?: unknown;
  [key: string]: unknown;
}

export interface AnthropicNoneToolChoice {
  type: 'none';
  name?: unknown;
  [key: string]: unknown;
}

export interface AnthropicAnyToolChoice {
  type: 'any';
  name?: unknown;
  [key: string]: unknown;
}

export interface AnthropicSpecificToolChoice {
  type: 'tool';
  name?: unknown;
  [key: string]: unknown;
}

/** Fallback for case-variant or otherwise unknown object shapes. */
export interface UnknownObjectToolChoice {
  type?: unknown;
  name?: unknown;
  function?: unknown;
  [key: string]: unknown;
}

/**
 * Every `tool_choice` shape the proxy accepts: Chat string/object forms plus
 * Anthropic Messages object forms.
 */
export type ExternalToolChoice =
  | ChatStringToolChoice
  | ChatNestedFunctionToolChoice
  | ChatFlatFunctionToolChoice
  | AnthropicAutoToolChoice
  | AnthropicNoneToolChoice
  | AnthropicAnyToolChoice
  | AnthropicSpecificToolChoice
  | UnknownObjectToolChoice;

export type ToolChoiceMode = 'auto' | 'none' | 'required';

export interface NormalizedChoice {
  mode: ToolChoiceMode;
  requiredTool: string | null;
}

export interface ToolExposure {
  tools: ExternalToolEntry[];
  toolChoice: NormalizedChoice;
  prompt: string;
  reminder: string;
}

function asRegistryList(registry: unknown): ExternalToolEntry[] {
  return Array.isArray(registry) ? (registry as ExternalToolEntry[]) : [];
}

export interface ToolChoicePreflightSuccess {
  ok: true;
  normalized: NormalizedChoice;
}

export interface ToolChoicePreflightFailure {
  ok: false;
  code: string;
  message: string;
}

export type ToolChoicePreflightResult = ToolChoicePreflightSuccess | ToolChoicePreflightFailure;

function preflightFailure(code: string, message: string): ToolChoicePreflightFailure {
  return { ok: false, code, message };
}

function exactToolForName(registry: ExternalToolEntry[], name: unknown): ExternalToolEntry | null {
  if (typeof name !== 'string' || !name) return null;
  return registry.find((tool) => tool.originalName === name || tool.namespacedName === name) ?? null;
}

export function preflightExternalToolChoice(toolChoice: unknown, registry: unknown): ToolChoicePreflightResult {
  const list = asRegistryList(registry);
  if (toolChoice === undefined) {
    return { ok: true, normalized: { mode: 'auto', requiredTool: null } };
  }
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') {
      return { ok: true, normalized: { mode: toolChoice, requiredTool: null } };
    }
    return preflightFailure('invalid_tool_choice', `Invalid tool_choice: ${toolChoice}`);
  }
  if (!toolChoice || typeof toolChoice !== 'object' || Array.isArray(toolChoice)) {
    return preflightFailure('invalid_tool_choice', 'tool_choice must be a valid string or object.');
  }

  const candidate = toolChoice as UnknownObjectToolChoice & Record<string, unknown>;
  const type = candidate['type'];
  if (typeof type !== 'string') {
    return preflightFailure('invalid_tool_choice', 'tool_choice.type is required.');
  }
  if (type === 'auto' || type === 'none' || type === 'required') {
    return { ok: true, normalized: { mode: type, requiredTool: null } };
  }
  if (type === 'any') {
    return { ok: true, normalized: { mode: 'required', requiredTool: null } };
  }

  let requestedName: unknown;
  if (type === 'tool') {
    requestedName = candidate['name'];
  } else if (type === 'function') {
    const hasFunction = Object.prototype.hasOwnProperty.call(candidate, 'function');
    const hasDirectName = Object.prototype.hasOwnProperty.call(candidate, 'name');
    if (hasFunction) {
      const fn = candidate['function'];
      if (!fn || typeof fn !== 'object' || Array.isArray(fn)) {
        return preflightFailure('invalid_tool_choice', 'tool_choice.function must contain a tool name.');
      }
      const fnRecord = fn as Record<string, unknown>;
      const hasNestedName = Object.prototype.hasOwnProperty.call(fnRecord, 'name');
      if (!hasNestedName || typeof fnRecord['name'] !== 'string' || !fnRecord['name']) {
        return preflightFailure('invalid_tool_choice', 'tool_choice.function.name is required.');
      }
      if (hasDirectName && candidate['name'] !== fnRecord['name']) {
        return preflightFailure('invalid_tool_choice', 'tool_choice contains conflicting tool names.');
      }
      requestedName = fnRecord['name'];
    } else {
      requestedName = hasDirectName ? candidate['name'] : undefined;
    }
  } else {
    return preflightFailure('invalid_tool_choice', `Unsupported tool_choice.type: ${type}`);
  }

  if (typeof requestedName !== 'string' || !requestedName) {
    return preflightFailure('invalid_tool_choice', 'tool_choice.name is required for a specific tool choice.');
  }
  const tool = exactToolForName(list, requestedName);
  if (!tool) {
    return preflightFailure('unknown_tool', `tool_choice references an unknown tool: ${requestedName}`);
  }
  if (tool.enabled === false) {
    return preflightFailure('tool_disabled', `tool_choice references a disabled tool: ${requestedName}`);
  }
  return { ok: true, normalized: { mode: 'required', requiredTool: tool.namespacedName } };
}

export function normalizeExternalToolChoice(toolChoice: unknown, registry: unknown): NormalizedChoice {
  const result = preflightExternalToolChoice(toolChoice, registry);
  return result.ok ? result.normalized : { mode: 'auto', requiredTool: null };
}

export function buildExternalToolsPrompt(registry: unknown, toolChoice: unknown = null): string {
  const list = asRegistryList(registry);
  if (!Array.isArray(registry) || list.length === 0) return '';
  const normalizedChoice = normalizeExternalToolChoice(toolChoice, registry);
  const choiceInstructions: string[] = [];
  if (normalizedChoice.mode === 'required') {
    if (normalizedChoice.requiredTool) {
      choiceInstructions.push(`Tool use is REQUIRED for this turn. You MUST call ${normalizedChoice.requiredTool} before giving any final answer.`);
    } else {
      choiceInstructions.push('Tool use is REQUIRED for this turn. You MUST call an external tool before giving any final answer.');
    }
  } else if (normalizedChoice.mode === 'none') {
    choiceInstructions.push('Tool use is disabled for this turn. Do not emit <function_calls>.');
  }

  return [
    'External tools are virtualized by this proxy. They are not OpenCode tools.',
    'When you need an external tool, your entire assistant reply MUST be ONLY one or more <function_calls>...</function_calls> blocks.',
    'Do NOT output <think>, explanations, markdown, prose, or any text before or after <function_calls> blocks when making a tool call.',
    'Each block must contain JSON with this exact shape:',
    '{"name":"external__tool_name","arguments":{}}',
    'Arguments must be a valid JSON object that matches the declared schema.',
    'Use only the namespaced names listed below. Do not use original client tool names inside function calls.',
    'If tool results are later provided as TOOL_RESULT messages, use those results to continue normally.',
    ...choiceInstructions,
    `Available external tools: ${JSON.stringify(list.map((tool) => ({
      name: tool.namespacedName,
      client_name: tool.originalName,
      description: tool.description,
      parameters: tool.parameters,
      risk_level: tool.riskLevel,
      side_effect: tool.sideEffect,
      requires_confirmation: tool.requiresConfirmation
    })))}`
  ].join('\n');
}

/**
 * Short imperative restatement of the markup contract, meant to be appended as the final
 * prompt part rather than buried in the system prompt.
 *
 * Position matters more than wording here. With the contract only in the system prompt,
 * deepseek-v4-flash-free emitted parseable markup in 4/8 runs of an obvious single-tool
 * request; with this reminder as the last thing before generation it was 8/8. Harnesses
 * like pi send system prompts of 16KB or more and the contract gets lost inside them.
 */
export function buildExternalToolsReminder(registry: unknown, toolChoice: unknown = null): string {
  const list = asRegistryList(registry);
  if (!Array.isArray(registry) || list.length === 0) return '';
  const normalizedChoice = normalizeExternalToolChoice(toolChoice, registry);
  if (normalizedChoice.mode === 'none') return '';
  const first = list[0];
  if (!first) return '';
  const exampleName = normalizedChoice.requiredTool || first.namespacedName;
  return [
    'REMINDER: External tools are called by emitting markup, not through any native tool API.',
    `To call one, your entire reply must be ONLY <function_calls>{"name":"${exampleName}","arguments":{...}}</function_calls>`,
    'with no prose, no markdown and no <think> block. Otherwise answer normally.',
    `Available names: ${list.map((tool) => tool.namespacedName).join(', ')}`
  ].join('\n');
}

export function buildToolExposure(registry: unknown, toolChoice: unknown = null): ToolExposure {
  const exposedTools: ExternalToolEntry[] = Array.isArray(registry)
    ? (registry as ExternalToolEntry[]).filter((tool) => tool.enabled !== false)
    : [];
  const normalizedChoice = normalizeExternalToolChoice(toolChoice, exposedTools);
  return {
    tools: exposedTools,
    toolChoice: normalizedChoice,
    prompt: buildExternalToolsPrompt(exposedTools, toolChoice),
    reminder: buildExternalToolsReminder(exposedTools, toolChoice)
  };
}
