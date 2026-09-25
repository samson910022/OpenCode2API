import { findExternalToolByName } from './registry.js';
import type { ExternalToolEntry } from './registry.js';

/**
 * Tool-call markup parsing.
 *
 * The proxy asks models to emit tool calls as `<function_calls>{json}</function_calls>`.
 * Models served by OpenCode's free tier frequently ignore that contract and fall back to
 * whatever markup their own training used. Observed alternatives, all captured verbatim
 * from live responses, are listed in FOREIGN FORMATS below.
 *
 * Rather than teach every call site about each dialect, everything is normalized to the
 * canonical `<function_calls>` form at the parser boundary. Downstream code is unchanged.
 *
 * FOREIGN FORMATS
 *   1. DSML (DeepSeek native)
 *        <｜｜DSML｜｜tool_calls>
 *        <｜｜DSML｜｜invoke name="external__bash">
 *        <｜｜DSML｜｜parameter name="command" string="true">ls -la</｜｜DSML｜｜parameter>
 *        </｜｜DSML｜｜invoke>
 *        </｜｜DSML｜｜tool_calls>
 *      The `｜` is U+FF5C (fullwidth vertical line), not an ASCII pipe. The marker is
 *      treated as optional so plain `<invoke>`/`<parameter>` markup parses too.
 *   2. JSON wrapper:      <tool_call>{"name":...,"arguments":{...}}</tool_call>
 *   3. Tag with attrs:    <external__bash arguments='{"command":"ls"}' name="external__bash"/>
 *   4. Tag with body:     <external__bash>{"command":"ls"}</external__bash>
 *                         <external__bash><parameters>{...}</parameters></external__bash>
 *                         <external__bash "Run a shell command">\n{"command":"ls"}
 *   5. Bare JSON:         {"name":"external__bash","arguments":{"command":"ls"}}
 *
 * AMBIGUITY POLICY
 * Formats 1, 2 and the canonical form carry their own delimiters, so they are recognized
 * unconditionally. Formats 3-5 are only recognized when the name matches a tool in the
 * request's registry, because `<summary>` or a JSON snippet in prose must never be
 * mistaken for a tool call. Format 5 additionally requires the JSON to span the entire
 * message body, so payload examples quoted mid-sentence are ignored.
 */

/** A single raw tool call before id/type normalization. */
export interface RawToolCall {
  id?: unknown;
  name: string;
  arguments: unknown;
}

/** Normalized tool call in OpenAI `tool_calls` shape. */
export interface FinalToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** Consumed markup range as `[start, end)`. */
export type TextSpan = [number, number];

/** Streaming text filter with an end-of-stream `flush()`. */
export type ToolCallFilter = ((chunk: string) => string) & { flush: () => string };

/** Streaming tool-call extractor with an end-of-stream `flush()`. */
export type ToolCallStreamParser = ((chunk: string) => FinalToolCall[]) & { flush: () => FinalToolCall[] };

interface ExtractedCalls {
  calls: RawToolCall[];
  spans: TextSpan[];
  valid?: boolean;
}

interface JsonValueLocation {
  json: string;
  start: number;
  end: number;
}

// U+FF5C fullwidth vertical line, or an ASCII pipe, around an optional DSML tag.
// Matches "｜｜DSML｜｜", "|DSML|", or nothing at all.
const MARK = '[\\uFF5C|]*(?:DSML)?[\\uFF5C|]*';

const CANONICAL_OPEN = '<function_calls>';
const CANONICAL_CLOSE = '</function_calls>';

const RE = {
  canonicalBlock: /<function_calls>([\s\S]*?)<\/function_calls>/g,
  canonicalStrayTag: /<\/?function_calls>/g,
  // DSML/plain <tool_calls> container. Contents are parsed for invoke blocks.
  dsmlContainer: new RegExp(`<${MARK}tool_calls\\s*>([\\s\\S]*?)</${MARK}tool_calls\\s*>`, 'g'),
  invokeBlock: new RegExp(`<${MARK}invoke\\s+name\\s*=\\s*["']([^"']+)["']\\s*>([\\s\\S]*?)</${MARK}invoke\\s*>`, 'g'),
  invokeParam: new RegExp(`<${MARK}parameter\\s+name\\s*=\\s*["']([^"']+)["']([^>]*)>([\\s\\S]*?)</${MARK}parameter\\s*>`, 'g'),
  // Singular <tool_call> JSON wrapper. Plural is handled by dsmlContainer, which
  // falls through to JSON parsing when it holds no invoke blocks.
  jsonWrapper: /<\u200b?tool_call\s*>([\s\S]*?)<\/\u200b?tool_call\s*>/g,
  // Opener/closer pairs counted separately so an envelope that never closes is still
  // detected; the paired patterns above only match complete blocks.
  dsmlOpen: new RegExp(`<${MARK}tool_calls\\s*>`, 'g'),
  dsmlClose: new RegExp(`</${MARK}tool_calls\\s*>`, 'g'),
  jsonOpen: /<\u200b?tool_call\s*>/g,
  jsonClose: /<\/\u200b?tool_call\s*>/g,
  codeFence: /^\s*```(?:[a-zA-Z0-9_-]*)\s*\n([\s\S]*?)\n?\s*```\s*$/,
  jsonNameField: /["'](?:tool_name|tool|name)["']\s*:\s*["']([^"'\n]{1,200})["']/g,
  leadingNewline: /^\r?\n/,
  trailingNewline: /\r?\n[ \t]*$/
};

const escapeRegExp = (value: unknown): string => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type ScannedTagName = 'canonical' | 'tool_calls' | 'tool_call' | 'invoke' | 'parameter' | 'function';

interface ScannedMarkupTag {
  start: number;
  end: number;
  closing: boolean;
  name: ScannedTagName;
  raw: string;
}

interface MarkupScan {
  tags: ScannedMarkupTag[];
  unterminatedStart: number | null;
}

interface MarkupBlock {
  start: number;
  end: number;
  bodyStart: number;
  bodyEnd: number;
}

function maskDoubleQuotedStrings(source: string): string {
  const chars = source.split('');
  let inString = false;
  let escaped = false;
  for (let index = 0; index < chars.length; index += 1) {
    const ch = chars[index] as string;
    if (inString) {
      chars[index] = ' ';
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      chars[index] = ' ';
    }
  }
  return chars.join('');
}

function matchAllOutsideStrings(source: string, pattern: RegExp): RegExpExecArray[] {
  const masked = maskDoubleQuotedStrings(source);
  return [...source.matchAll(pattern)].filter((match) => {
    const index = match.index ?? 0;
    return masked[index] === source[index];
  });
}

function classifyMarkupTag(raw: string): { closing: boolean; name: ScannedTagName } | null {
  if (/^<function_calls>$/i.test(raw)) return { closing: false, name: 'canonical' };
  if (/^<\/function_calls>$/i.test(raw)) return { closing: true, name: 'canonical' };
  if (/^<\u200b?tool_call\s*>$/i.test(raw)) return { closing: false, name: 'tool_call' };
  if (/^<\/\u200b?tool_call\s*>$/i.test(raw)) return { closing: true, name: 'tool_call' };
  const dsmlToolCalls = new RegExp(`^<${MARK}tool_calls\\s*>$`, 'i');
  const dsmlToolCallsClose = new RegExp(`^</${MARK}tool_calls\\s*>$`, 'i');
  if (dsmlToolCalls.test(raw)) return { closing: false, name: 'tool_calls' };
  if (dsmlToolCallsClose.test(raw)) return { closing: true, name: 'tool_calls' };
  const dsmlInvoke = new RegExp(`^<${MARK}invoke\\b`, 'i');
  const dsmlInvokeClose = new RegExp(`^</${MARK}invoke\\s*>$`, 'i');
  if (dsmlInvoke.test(raw)) return { closing: false, name: 'invoke' };
  if (dsmlInvokeClose.test(raw)) return { closing: true, name: 'invoke' };
  const dsmlParameter = new RegExp(`^<${MARK}parameter\\b`, 'i');
  const dsmlParameterClose = new RegExp(`^</${MARK}parameter\\s*>$`, 'i');
  if (dsmlParameter.test(raw)) return { closing: false, name: 'parameter' };
  if (dsmlParameterClose.test(raw)) return { closing: true, name: 'parameter' };
  if (/^<function\s*=\s*[^\s/>]+\s*>$/i.test(raw)) return { closing: false, name: 'function' };
  if (/^<\/function\s*>$/i.test(raw)) return { closing: true, name: 'function' };
  return null;
}

function scanMarkupTags(source: string): MarkupScan {
  const masked = maskDoubleQuotedStrings(source);
  const tags: ScannedMarkupTag[] = [];
  let unterminatedStart: number | null = null;
  for (let index = 0; index < source.length;) {
    if (masked[index] !== '<') {
      index += 1;
      continue;
    }
    const end = findTagEnd(source, index + 1);
    if (end === -1) {
      const remainder = masked.slice(index);
      if (new RegExp(`^<(?:\\u200b?tool_call|${MARK}(?:tool_calls|invoke|parameter)|function_calls)`, 'i').test(remainder)) {
        unterminatedStart = index;
      }
      break;
    }
    const raw = source.slice(index, end + 1);
    const classified = classifyMarkupTag(raw);
    if (classified) tags.push({ start: index, end: end + 1, raw, ...classified });
    index = end + 1;
  }
  return { tags, unterminatedStart };
}

function findMarkupBlocks(scan: MarkupScan, name: ScannedTagName): MarkupBlock[] {
  const stack: ScannedMarkupTag[] = [];
  const blocks: MarkupBlock[] = [];
  for (const tag of scan.tags) {
    if (tag.name !== name) continue;
    if (!tag.closing) {
      stack.push(tag);
      continue;
    }
    const open = stack.pop();
    if (!open) continue;
    blocks.push({ start: open.start, end: tag.end, bodyStart: open.end, bodyEnd: tag.start });
  }
  return blocks.sort((a, b) => a.start - b.start);
}

function hasBalancedMarkupTag(scan: MarkupScan, name: ScannedTagName): boolean {
  const stack: ScannedMarkupTag[] = [];
  for (const tag of scan.tags) {
    if (tag.name !== name) continue;
    if (!tag.closing) {
      stack.push(tag);
      continue;
    }
    if (!stack.length) return false;
    stack.pop();
  }
  return stack.length === 0;
}

/** Tool names accepted for the registry-gated formats, longest first so `<foo_2` wins over `<foo`. */
function registryNames(registry: unknown): string[] {
  if (!Array.isArray(registry)) return [];
  const names = new Set<string>();
  for (const tool of registry as unknown[]) {
    if (tool && typeof tool === 'object' && !Array.isArray(tool)) {
      const record = tool as Record<string, unknown>;
      if (typeof record['namespacedName'] === 'string' && record['namespacedName']) {
        names.add(record['namespacedName'] as string);
      }
      if (typeof record['originalName'] === 'string' && record['originalName']) {
        names.add(record['originalName'] as string);
      }
    }
  }
  return [...names].sort((a, b) => b.length - a.length);
}

/** Map every accepted tool name (namespaced and original) to its declared JSON schema. */
function registrySchemas(registry: unknown): Map<string, unknown> {
  const schemas = new Map<string, unknown>();
  if (!Array.isArray(registry)) return schemas;
  for (const tool of registry as unknown[]) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) continue;
    const record = tool as Record<string, unknown>;
    if (!record['parameters']) continue;
    if (typeof record['namespacedName'] === 'string' && record['namespacedName']) {
      schemas.set(record['namespacedName'] as string, record['parameters']);
    }
    if (typeof record['originalName'] === 'string' && record['originalName']) {
      schemas.set(record['originalName'] as string, record['parameters']);
    }
  }
  return schemas;
}

/**
 * DSML parameter bodies usually sit on their own line. Drop one leading and one trailing
 * newline so `<parameter>\nvalue\n</parameter>` yields "value", while interior whitespace
 * and intentional trailing spaces inside multi-line values survive untouched.
 */
function trimParamValue(raw: unknown): string {
  return String(raw ?? '')
    .replace(RE.leadingNewline, '')
    .replace(RE.trailingNewline, '');
}

/** `string="true"` forces a string; otherwise numbers/booleans/objects are decoded. */
function coerceParamValue(value: string, attrs: unknown): unknown {
  if (/string\s*=\s*["']true["']/i.test(String(attrs || ''))) return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!/^(-?\d|true$|false$|null$|\{|\[|")/.test(trimmed)) return value;
  try {
    const decoded: unknown = JSON.parse(trimmed);
    return decoded;
  } catch {
    return value;
  }
}

/** Pull `{ id?, name, arguments }` out of the JSON shapes models produce. */
function rawCallFromJson(node: unknown): RawToolCall | null {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  const record = node as Record<string, unknown>;
  const fnRaw: unknown = record['function'];
  const fnRecord: Record<string, unknown> =
    fnRaw && typeof fnRaw === 'object' && !Array.isArray(fnRaw) ? (fnRaw as Record<string, unknown>) : {};
  const nameRaw: unknown = fnRecord['name'] ?? record['name'] ?? record['tool_name'] ?? record['tool'];
  if (!nameRaw || typeof nameRaw !== 'string') return null;
  let args: unknown = fnRecord['arguments'] ?? record['arguments'] ?? record['parameters'] ?? record['args'] ?? {};
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed) {
      args = {};
    } else {
      try {
        const decoded: unknown = JSON.parse(trimmed);
        args = decoded;
      } catch {
        return { id: record['id'], name: nameRaw, arguments: trimmed };
      }
    }
  }
  return { id: record['id'], name: nameRaw, arguments: args };
}

/** Expand a decoded JSON payload, which may be a single call, an array, or a wrapper object. */
function rawCallsFromJsonPayload(parsed: unknown): RawToolCall[] {
  let candidates: unknown[];
  if (Array.isArray(parsed)) {
    candidates = parsed as unknown[];
  } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record['tool_calls'])) {
      candidates = record['tool_calls'] as unknown[];
    } else if (Array.isArray(record['invokes'])) {
      candidates = record['invokes'] as unknown[];
    } else {
      candidates = [parsed];
    }
  } else {
    candidates = [parsed];
  }
  const out: RawToolCall[] = [];
  for (const candidate of candidates) {
    const call = rawCallFromJson(candidate);
    if (call) out.push(call);
  }
  return out;
}

function rawCallsFromJsonText(text: unknown): RawToolCall[] {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return rawCallsFromJsonPayload(parsed);
  } catch {
    // The body may be prefixed by stray markup — a nested <function_calls> tag copied
    // from the contract reminder, or a tool wrapper tag emitted by the model before
    // the JSON payload. Scan for the first balanced JSON value and try again.
    const found = findFirstJsonValue(trimmed);
    if (!found) return [];
    try {
      const parsed: unknown = JSON.parse(found.json);
      return rawCallsFromJsonPayload(parsed);
    } catch {
      return [];
    }
  }
}

function jsonPayloadCandidates(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed as unknown[];
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record['tool_calls'])) return record['tool_calls'] as unknown[];
    if (Array.isArray(record['invokes'])) return record['invokes'] as unknown[];
  }
  return [parsed];
}

function isJsonMarkupPrefixOrSuffix(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (/^```[\s\S]*```$/.test(trimmed)) return true;
  return new RegExp(`^(?:\\s|</${MARK}(?:function_calls|tool_calls|tool_call)\\s*>)+$`, 'i').test(trimmed);
}

function hasUnclosedJsonDelimiter(value: string): boolean {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of value) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      const expected: string = ch === '}' ? '{' : '[';
      if (stack[stack.length - 1] === expected) stack.pop();
    }
  }
  return stack.length > 0 || inString;
}

function parseJsonEnvelopeText(text: unknown): { parsed: unknown } | null {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  try {
    return { parsed: JSON.parse(trimmed) as unknown };
  } catch {
    const found = findFirstJsonValue(trimmed);
    if (!found) return null;
    const prefix = trimmed.slice(0, found.start).trim();
    if (hasUnclosedJsonDelimiter(prefix)) return null;
    if (!isJsonMarkupPrefixOrSuffix(trimmed.slice(found.end))) return null;
    try {
      return { parsed: JSON.parse(found.json) as unknown };
    } catch {
      return null;
    }
  }
}

function rawCallsFromJsonEnvelopeText(text: unknown): RawToolCall[] {
  const parsed = parseJsonEnvelopeText(text);
  return parsed ? rawCallsFromJsonPayload(parsed.parsed) : [];
}

function hasValidJsonCallEnvelope(text: unknown, registry?: unknown): boolean {
  const parsed = parseJsonEnvelopeText(text);
  if (!parsed) return false;
  const candidates = jsonPayloadCandidates(parsed.parsed);
  if (!candidates.length) return false;
  const calls = candidates.map((candidate) => rawCallFromJson(candidate));
  if (calls.some((call) => call === null)) return false;
  if (registry !== undefined && registry !== null && calls.some((call) => !findExternalToolByName(registry, call?.name))) return false;
  return true;
}

function rawCallsFromJsonFragments(text: unknown): RawToolCall[] {
  const source = String(text ?? '');
  const calls: RawToolCall[] = [];
  let offset = 0;
  while (offset < source.length) {
    const found = findFirstJsonValue(source.slice(offset));
    if (!found) break;
    calls.push(...rawCallsFromJsonPayload(JSON.parse(found.json) as unknown));
    const next = offset + found.end;
    if (next <= offset) break;
    offset = next;
  }
  return calls;
}

/** Byte offset just past the JSON value starting at `start`, or -1 if it never closes. */
function findJsonEnd(text: string, start: number): number {
  const opener: string = text[start] as string;
  if (opener !== '{' && opener !== '[') return -1;
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch: string = text[i] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** First balanced JSON object/array in `text`, as `{ json, start, end }`. */
function findFirstJsonValue(text: string): JsonValueLocation | null {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{' && text[i] !== '[') continue;
    const end = findJsonEnd(text, i);
    if (end === -1) continue;
    const json = text.slice(i, end);
    try {
      JSON.parse(json);
      return { json, start: i, end };
    } catch {
      // Keep scanning; this brace was not the start of a valid value.
    }
  }
  return null;
}

// --- format extractors -----------------------------------------------------
// Each returns { calls, spans } where spans are [start, end) ranges of consumed markup.

function hasSingleValidNestedCanonicalBody(body: string, registry?: unknown): boolean {
  const nested = matchAllOutsideStrings(body, RE.canonicalBlock);
  if (nested.length !== 1) return false;
  const match = nested[0] as RegExpExecArray;
  const start = match.index ?? 0;
  return (
    body.slice(0, start).trim() === '' &&
    body.slice(start + match[0].length).trim() === '' &&
    hasValidJsonCallEnvelope(match[1], registry)
  );
}

function extractCanonical(text: string, registry?: unknown): ExtractedCalls {
  const calls: RawToolCall[] = [];
  const spans: TextSpan[] = [];
  let structurallyValid = hasValidCanonicalTagStructure(text);
  const blocks = findMarkupBlocks(scanMarkupTags(text), 'canonical');
  for (const block of blocks) {
    spans.push([block.start, block.end]);
    const body = text.slice(block.bodyStart, block.bodyEnd);
    if (hasValidJsonCallEnvelope(body, registry)) calls.push(...rawCallsFromJsonEnvelopeText(body));
    else if (!hasSingleValidNestedCanonicalBody(body, registry)) structurallyValid = false;
  }
  return { calls: structurallyValid ? calls : [], spans, valid: structurallyValid };
}

interface DsmlTagToken {
  closing: boolean;
  name: string;
  start: number;
  end: number;
  raw: string;
}

interface DsmlAnalysis {
  hasMarkup: boolean;
  valid: boolean;
  calls: RawToolCall[];
  spans: TextSpan[];
}

function dsmlTagTokens(segment: string): { tokens: DsmlTagToken[]; unterminatedStart: number | null } {
  const scan = scanMarkupTags(segment);
  const dsmlSyntax = new RegExp(`<${MARK}(?:invoke|parameter)\\s+name\\s*=`, 'i').test(maskDoubleQuotedStrings(segment));
  const tokens: DsmlTagToken[] = [];
  for (const tag of scan.tags) {
    if (tag.name !== 'tool_calls' && tag.name !== 'invoke' && tag.name !== 'parameter') continue;
    if (tag.name === 'parameter' && !dsmlSyntax) continue;
    tokens.push({ closing: tag.closing, name: tag.name, start: tag.start, end: tag.end, raw: tag.raw });
  }
  return { tokens, unterminatedStart: scan.unterminatedStart };
}

function dsmlInvokeName(raw: string): string | null {
  const match = new RegExp(`^<${MARK}invoke\\s+name\\s*=\\s*(["'])([^"']+)\\1\\s*>$`, 'i').exec(raw);
  return match?.[2] ?? null;
}

function dsmlParameter(raw: string): { name: string; attrs: string } | null {
  const match = new RegExp(`^<${MARK}parameter\\s+name\\s*=\\s*(["'])([^"']+)\\1([^>]*)>$`, 'i').exec(raw);
  if (!match?.[2]) return null;
  return { name: match[2], attrs: match[3] ?? '' };
}

function isDsmlClose(raw: string, name: string): boolean {
  return new RegExp(`^</${MARK}${name}\\s*>$`, 'i').test(raw);
}

function analyzeDsmlSegment(segment: string, allowOutsideText: boolean = false): DsmlAnalysis {
  const scan = dsmlTagTokens(segment);
  const hasMarkup = scan.tokens.length > 0 || scan.unterminatedStart !== null;
  if (!hasMarkup) return { hasMarkup: false, valid: true, calls: [], spans: [] };

  const calls: RawToolCall[] = [];
  const spans: TextSpan[] = [];
  let valid = true;
  let cursor = 0;
  let invoke: { name: string; args: Record<string, unknown>; start: number } | null = null;
  let parameter: { name: string; attrs: string; contentStart: number } | null = null;
  const firstMarkupStart = scan.unterminatedStart ?? scan.tokens[0]?.start ?? 0;

  for (const token of scan.tokens) {
    if (!allowOutsideText && !parameter && segment.slice(cursor, token.start).trim()) valid = false;
    if (token.name === 'tool_calls') valid = false;
    if (token.closing) {
      if (!isDsmlClose(token.raw, token.name)) valid = false;
      if (token.name === 'parameter') {
        if (!parameter || !invoke) {
          valid = false;
        } else {
          invoke.args[parameter.name] = coerceParamValue(
            trimParamValue(segment.slice(parameter.contentStart, token.start)),
            parameter.attrs
          );
          parameter = null;
        }
      } else if (token.name === 'invoke') {
        if (!invoke || parameter) {
          valid = false;
        } else {
          calls.push({ name: invoke.name, arguments: invoke.args });
          spans.push([invoke.start, token.end]);
          invoke = null;
        }
      }
    } else if (token.name === 'invoke') {
      const name = dsmlInvokeName(token.raw);
      if (invoke || parameter || !name) valid = false;
      else invoke = { name, args: {}, start: token.start };
    } else if (token.name === 'parameter') {
      const parsed = dsmlParameter(token.raw);
      if (!invoke || parameter || !parsed) valid = false;
      else parameter = { name: parsed.name, attrs: parsed.attrs, contentStart: token.end };
    }
    cursor = token.end;
  }

  if (parameter) valid = false;
  if (invoke) {
    valid = false;
    spans.push([invoke.start, segment.length]);
  }
  if (!allowOutsideText && segment.slice(cursor).trim()) valid = false;
  if (!valid) spans.push([firstMarkupStart, segment.length]);
  return { hasMarkup, valid, calls: valid ? calls : [], spans };
}

function extractInvokeBlocks(segment: string): RawToolCall[] {
  return analyzeDsmlSegment(segment).calls;
}

/** DSML/plain `<tool_calls>` containers, plus bare `<invoke>` blocks outside any container. */
function dsmlRemainder(text: string): string {
  const blocks = findMarkupBlocks(scanMarkupTags(text), 'tool_calls');
  let remainder = '';
  let cursor = 0;
  for (const block of blocks) {
    if (block.start < cursor) continue;
    remainder += text.slice(cursor, block.start) + ' '.repeat(block.end - block.start);
    cursor = block.end;
  }
  return remainder + text.slice(cursor);
}

function extractDsml(text: string, registry?: unknown): ExtractedCalls {
  const calls: RawToolCall[] = [];
  const spans: TextSpan[] = [];
  let structurallyValid = true;
  const scan = scanMarkupTags(text);

  for (const container of findMarkupBlocks(scan, 'tool_calls')) {
    spans.push([container.start, container.end]);
    const body = text.slice(container.bodyStart, container.bodyEnd);
    const analysis = analyzeDsmlSegment(body);
    if (analysis.hasMarkup) {
      if (
        analysis.valid &&
        (registry === undefined || analysis.calls.every((call) => Boolean(findExternalToolByName(registry, call.name))))
      ) calls.push(...analysis.calls);
      else structurallyValid = false;
    } else {
      const jsonCalls = rawCallsFromJsonEnvelopeText(body);
      if (
        jsonCalls.length &&
        (registry === undefined || jsonCalls.every((call) => Boolean(findExternalToolByName(registry, call.name))))
      ) calls.push(...jsonCalls);
      else structurallyValid = false;
    }
  }

  const naked = analyzeDsmlSegment(dsmlRemainder(text), true);
  if (naked.hasMarkup) {
    if (
      naked.valid &&
      (registry === undefined || naked.calls.every((call) => Boolean(findExternalToolByName(registry, call.name))))
    ) calls.push(...naked.calls);
    else structurallyValid = false;
    spans.push(...naked.spans);
  }

  return { calls: structurallyValid ? calls : [], spans, valid: structurallyValid };
}

interface NonJsonToolWrapperResult {
  calls: RawToolCall[];
  spans: TextSpan[];
  valid: boolean;
}

function extractNonJsonToolWrapper(registry: unknown, body: string): NonJsonToolWrapperResult {
  const functionResult = extractFunctionEquals(body);
  const tagResult = extractTagNamed(body, registryNames(registry), registrySchemas(registry));
  const calls = [...functionResult.calls, ...tagResult.calls];
  const spans = [...functionResult.spans, ...tagResult.spans];
  const valid = calls.length > 0 && !textOutsideSpans(body, spans).some((segment) => segment.trim());
  return { calls, spans, valid };
}

function extractJsonWrapper(text: string, registry?: unknown): ExtractedCalls {
  const calls: RawToolCall[] = [];
  const spans: TextSpan[] = [];
  let structurallyValid = true;
  for (const wrapper of findMarkupBlocks(scanMarkupTags(text), 'tool_call')) {
    const body = text.slice(wrapper.bodyStart, wrapper.bodyEnd);
    const bodyCalls = rawCallsFromJsonEnvelopeText(body);
    if (bodyCalls.length) {
      if (hasValidJsonCallEnvelope(body, registry)) {
        calls.push(...bodyCalls);
        spans.push([wrapper.start, wrapper.end]);
      } else {
        structurallyValid = false;
      }
      continue;
    }
    const nonJson = extractNonJsonToolWrapper(registry, body);
    if (nonJson.valid) spans.push([wrapper.start, wrapper.end]);
    else structurallyValid = false;
  }
  return { calls: structurallyValid ? calls : [], spans, valid: structurallyValid };
}

/**
 * Pull the arguments attribute value out of a tag's attribute text. Handles quoted
 * values (`arguments='{...}'`) and bare ones (`arguments={...}`), which models emit
 * interchangeably.
 */
function argsFromAttrs(attrs: string): string | null {
  const marker = attrs.match(/(?:arguments|parameters|args|input)\s*=\s*/i);
  if (!marker) return null;
  const markerIndex: number = marker.index ?? 0;
  const start = markerIndex + marker[0].length;
  const opener: string = attrs[start] as string;

  if (opener === '"' || opener === "'") {
    let i = start + 1;
    let out = '';
    while (i < attrs.length && attrs[i] !== opener) {
      if (attrs[i] === '\\' && i + 1 < attrs.length) {
        out += attrs[i + 1];
        i += 2;
        continue;
      }
      out += attrs[i];
      i += 1;
    }
    return out;
  }

  if (opener === '{' || opener === '[') {
    const end = findJsonEnd(attrs, start);
    if (end !== -1) return attrs.slice(start, end);
  }
  return null;
}

/**
 * Coerce an XML child element's text using the declared JSON-schema type. A schema type of
 * `string` is honoured verbatim so a path like `123.txt` or a body of JSON-looking text is
 * not silently turned into a number or an object.
 */
function coerceSchemaValue(value: string, schema: unknown): unknown {
  const schemaRecord: Record<string, unknown> =
    schema && typeof schema === 'object' && !Array.isArray(schema) ? (schema as Record<string, unknown>) : {};
  const rawType: unknown = schemaRecord['type'];
  const type: unknown = Array.isArray(rawType) ? (rawType as unknown[])[0] : rawType;
  if (type === 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (type === 'number' || type === 'integer') {
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : value;
  }
  if (type === 'boolean') {
    if (/^true$/i.test(trimmed)) return true;
    if (/^false$/i.test(trimmed)) return false;
    return value;
  }
  if (type === 'object' || type === 'array') {
    try {
      const decoded: unknown = JSON.parse(trimmed);
      return decoded;
    } catch {
      return value;
    }
  }
  // Untyped: fall back to the permissive decoding used elsewhere.
  return coerceParamValue(value, '');
}

/**
 * Arguments carried as XML child elements rather than JSON:
 *
 *   <read>
 *     <path>a.txt</path>
 *     <offset>10</offset>
 *   </read>
 *
 * Widely used by Cline/Roo-style harnesses, so models emit it from training even when
 * asked for JSON. Only child names declared in the tool's own schema are accepted, which
 * keeps prose containing angle brackets from being mistaken for arguments.
 */
function argsFromXmlChildren(body: string, parameters: unknown): Record<string, unknown> | null {
  const paramsRecord: Record<string, unknown> | null =
    parameters && typeof parameters === 'object' && !Array.isArray(parameters)
      ? (parameters as Record<string, unknown>)
      : null;
  const propertiesRaw: unknown = paramsRecord ? paramsRecord['properties'] : null;
  const properties: Record<string, unknown> | null =
    propertiesRaw && typeof propertiesRaw === 'object' && !Array.isArray(propertiesRaw)
      ? (propertiesRaw as Record<string, unknown>)
      : null;
  if (!properties || typeof properties !== 'object') return null;
  const allowed = Object.keys(properties);
  if (!allowed.length) return null;

  const args: Record<string, unknown> = {};
  let matched = 0;
  for (const key of allowed) {
    const re = new RegExp(`<${escapeRegExp(key)}\\s*>([\\s\\S]*?)</${escapeRegExp(key)}\\s*>`, 'i');
    const found = body.match(re);
    if (!found) continue;
    matched += 1;
    args[key] = coerceSchemaValue(trimParamValue(found[1]), properties[key]);
  }
  return matched > 0 ? args : null;
}

/**
 * End index of a tag's attribute region, skipping over quoted strings and balanced JSON
 * so that a `>` inside an attribute value (`arguments={"command":"ls > out"}`) does not
 * terminate the tag early.
 */
function findTagEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const ch: string = text[i] as string;
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === '{' || ch === '[') {
      const end = findJsonEnd(text, i);
      if (end !== -1) {
        i = end;
        continue;
      }
    }
    if (ch === '>') return i;
    i += 1;
  }
  return -1;
}

/**
 * Registry-gated tag formats: `<tool .../>`, `<tool ...>body</tool>`, and an unclosed
 * `<tool ...>` followed by a JSON body.
 */
function extractTagNamed(text: string, names: string[], schemas: Map<string, unknown> = new Map()): ExtractedCalls {
  const calls: RawToolCall[] = [];
  const spans: TextSpan[] = [];
  if (!names.length) return { calls, spans };

  const opener = new RegExp(`<(${names.map(escapeRegExp).join('|')})(?=[\\s/>"'])`, 'g');

  for (const match of matchAllOutsideStrings(text, opener)) {
    const name: string = match[1];
    const matchIndex: number = match.index ?? 0;
    const attrsStart = matchIndex + match[0].length;
    const tagEnd = findTagEnd(text, attrsStart);
    if (tagEnd === -1) continue;
    const attrs = text.slice(attrsStart, tagEnd);
    const openEnd = tagEnd + 1;

    // Arguments carried as an attribute: arguments='{"a":1}' or arguments={"a":1}
    const attrArgs = argsFromAttrs(attrs);
    if (attrArgs !== null) {
      const parsed = rawCallsFromJsonText(attrArgs);
      if (parsed.length) {
        calls.push(...parsed.map((call) => ({ ...call, name: call.name || name })));
      } else {
        try {
          const decoded: unknown = JSON.parse(attrArgs);
          calls.push({ name, arguments: decoded });
        } catch {
          calls.push({ name, arguments: {} });
        }
      }
      spans.push([matchIndex, openEnd]);
      continue;
    }

    if (attrs.trim().endsWith('/')) {
      calls.push({ name, arguments: {} });
      spans.push([matchIndex, openEnd]);
      continue;
    }

    // Body may be wrapped in a matching close tag, or simply trail the opener.
    const closeTag = `</${name}>`;
    const closeMatch = matchAllOutsideStrings(text.slice(openEnd), new RegExp(`</${escapeRegExp(name)}\\s*>`, 'gi'))[0];
    const closeIdx = closeMatch ? openEnd + (closeMatch.index ?? 0) : -1;
    const body = closeIdx === -1 ? text.slice(openEnd) : text.slice(openEnd, closeIdx);
    const json = findFirstJsonValue(body);
    const consumedEnd = closeIdx === -1
      ? (json ? openEnd + json.end : openEnd)
      : closeIdx + closeTag.length;

    if (json) {
      const parsed = rawCallsFromJsonText(json.json);
      const named = parsed.filter((call) => call.name);
      if (named.length) {
        calls.push(...named);
      } else {
        try {
          const decoded: unknown = JSON.parse(json.json);
          calls.push({ name, arguments: decoded });
        } catch {
          continue;
        }
      }
      spans.push([matchIndex, consumedEnd]);
      continue;
    }

    // No JSON body. Arguments may still be present as XML child elements named
    // after the schema's properties; dropping them here produced tool calls with
    // empty arguments, which fail validation for any tool with required fields.
    const xmlArgs = argsFromXmlChildren(body, schemas.get(name));
    if (xmlArgs) {
      calls.push({ name, arguments: xmlArgs });
      spans.push([matchIndex, consumedEnd]);
      continue;
    }
    spans.push([matchIndex, closeIdx === -1 ? openEnd : closeIdx + closeTag.length]);
  }

  return { calls, spans };
}

/**
 * Registry-gated bare JSON. Requires the JSON to be the whole message body (optionally
 * inside one code fence) so that payloads quoted inside prose are left alone.
 */
function extractBareJson(text: string, registry: unknown): ExtractedCalls {
  if (!Array.isArray(registry) || registry.length === 0) return { calls: [], spans: [] };
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[' && !trimmed.startsWith('```'))) {
    return { calls: [], spans: [] };
  }

  const fenced = trimmed.match(RE.codeFence);
  const body = (fenced ? String(fenced[1]) : trimmed).trim();
  if (!body || (body[0] !== '{' && body[0] !== '[')) return { calls: [], spans: [] };
  const parsed = parseJsonEnvelopeText(body);
  if (!parsed) {
    const known = rawCallsFromJsonFragments(body).some((call) => Boolean(findExternalToolByName(registry, call.name))) || hasKnownJsonNameHint(registry, body);
    return known ? { calls: [], spans: [[0, text.length]] } : { calls: [], spans: [] };
  }
  const candidates = jsonPayloadCandidates(parsed.parsed);
  if (!candidates.length) return { calls: [], spans: [] };
  const calls = candidates.map((candidate) => rawCallFromJson(candidate));
  if (calls.some((call) => call === null || !findExternalToolByName(registry, call?.name))) {
    const known = calls.some((call) => call !== null && Boolean(findExternalToolByName(registry, call.name)));
    return known ? { calls: [], spans: [[0, text.length]] } : { calls: [], spans: [] };
  }
  return { calls: calls as RawToolCall[], spans: [[0, text.length]] };
}

/**
 * `<function=name>` / `<parameter=key>value</parameter>` markup, the native tool-call
 * dialect of Qwen/GLM-family models and some OpenCode free-tier models:
 *
 *   <tool_call>
 *   <function=webfetch>
 *   <parameter=url>https://example.com</parameter>
 *   <parameter=format>html</parameter>
 *   </function>
 *   </tool_call>
 *
 * The surrounding `<tool_call>` container is already consumed by extractJsonWrapper
 * (which strips it as a span even when the body is not JSON), so here we only recognise
 * the `<function=...>` opener, collect its `<parameter=...>` children, and mark the
 * whole `<function>...</function>` block for hiding. Name mapping (e.g. `webfetch` →
 * `web_fetch`) is resolved later against the request's registry.
 */
function functionEqualsAllowsEmptyArguments(name: string, registry: unknown): boolean {
  if (registry === undefined || registry === null) return true;
  const tool = findExternalToolByName(registry, name);
  if (!tool) return false;
  const parameters = tool.parameters && typeof tool.parameters === 'object' ? tool.parameters as Record<string, unknown> : {};
  const required = parameters['required'];
  return !Array.isArray(required) || required.length === 0;
}

function extractFunctionEquals(text: string, registry?: unknown): ExtractedCalls {
  const calls: RawToolCall[] = [];
  const spans: TextSpan[] = [];
  let structurallyValid = true;
  const openerRe = /<function\s*=\s*([^\s/>]+)\s*>/gi;
  for (const match of matchAllOutsideStrings(text, openerRe)) {
    const name: string = String(match[1]).trim();
    if (!name) continue;
    const matchIndex: number = match.index ?? 0;
    const openEnd = matchIndex + match[0].length;
    const closeMatch = matchAllOutsideStrings(text.slice(openEnd), /<\/function\s*>/gi)[0];
    const closeIdx = closeMatch ? openEnd + (closeMatch.index ?? 0) : -1;
    if (closeIdx === -1) {
      spans.push([matchIndex, openEnd]);
      structurallyValid = false;
      continue;
    }
    const end = closeIdx + String(closeMatch[0]).length;
    const body = text.slice(openEnd, closeIdx);

    const args: Record<string, unknown> = {};
    const paramRe = /<parameter\s*=\s*([^\s/>]+)\s*>([\s\S]*?)<\/parameter\s*>/gi;
    for (const param of matchAllOutsideStrings(body, paramRe)) {
      args[String(param[1]).trim()] = trimParamValue(param[2]);
    }
    const openCount = (body.match(/<parameter\s*=/gi) || []).length;
    const closeCount = (body.match(/<\/parameter\s*>/gi) || []).length;
    if (openCount !== closeCount || Object.keys(args).length !== openCount) structurallyValid = false;
    if (!Object.keys(args).length) {
      spans.push([matchIndex, end]);
      if (functionEqualsAllowsEmptyArguments(name, registry)) calls.push({ name, arguments: {} });
      else structurallyValid = false;
      continue;
    }

    calls.push({ name, arguments: args });
    spans.push([matchIndex, end]);
  }
  return { calls, spans, valid: structurallyValid };
}

/** Every format in one pass. `spans` cover all markup that should be hidden from users. */
function collectAll(text: unknown, registry: unknown): ExtractedCalls {
  const source = typeof text === 'string' ? text : '';
  if (!source) return { calls: [], spans: [] };
  const names = registryNames(registry);
  const schemas = registrySchemas(registry);

  const results: ExtractedCalls[] = [
    extractCanonical(source, registry),
    extractDsml(source, registry),
    extractJsonWrapper(source, registry),
    extractFunctionEquals(source, registry),
    extractTagNamed(source, names, schemas),
    extractBareJson(source, registry)
  ];

  const seen = new Set<string>();
  const calls: RawToolCall[] = [];
  results.forEach((result) => {
    result.calls.forEach((call) => {
      const explicit = typeof call.id === 'string' && Boolean(call.id);
      const key = `${explicit ? `id:${call.id}` : 'generated'}::${toolCallKey(call.name, call.arguments)}`;
      if (seen.has(key)) return;
      seen.add(key);
      calls.push(call);
    });
  });

  const structurallyValid = results.every((result) => result.valid !== false);
  return { calls: structurallyValid ? calls : [], spans: results.flatMap((result) => result.spans) };
}

const GENERATED_CALL_MARKER = '__opencode_generated_tool_call__';

type InternalFinalToolCall = FinalToolCall & { [GENERATED_CALL_MARKER]?: boolean };

function markGeneratedToolCall(call: FinalToolCall): FinalToolCall {
  const marked = { ...call } as InternalFinalToolCall;
  Object.defineProperty(marked, GENERATED_CALL_MARKER, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return marked;
}

function isGeneratedToolCall(call: unknown): boolean {
  return Boolean(
    call &&
      typeof call === 'object' &&
      (call as Record<string, unknown>)[GENERATED_CALL_MARKER] === true,
  );
}

function toFinalCalls(rawCalls: RawToolCall[], seed = 0): FinalToolCall[] {
  return rawCalls.map((call, index) => {
    const finalCall: FinalToolCall = {
      id: typeof call.id === 'string' && call.id ? call.id : `call_${Date.now()}_${seed + index + 1}`,
      type: 'function' as const,
      function: {
        name: call.name,
        arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {})
      }
    };
    return typeof call.id === 'string' && call.id ? finalCall : markGeneratedToolCall(finalCall);
  });
}

function stringifyToolArguments(args: unknown): string {
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args ?? {}) ?? '{}';
  } catch {
    return '{}';
  }
}

function canonicalizeJsonValue(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('circular tool arguments');
    seen.add(value);
    const canonical = value.map((item) => canonicalizeJsonValue(item, seen));
    seen.delete(value);
    return canonical;
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) throw new Error('circular tool arguments');
    seen.add(value);
    const record = value as Record<string, unknown>;
    const canonical: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    Object.keys(record).sort().forEach((key) => {
      canonical[key] = canonicalizeJsonValue(record[key], seen);
    });
    seen.delete(value);
    return canonical;
  }
  return value;
}

function canonicalToolArguments(args: unknown): string {
  let value = args;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return stringifyToolArguments(args);
    }
  }
  try {
    return JSON.stringify(canonicalizeJsonValue(value)) ?? stringifyToolArguments(args);
  } catch {
    return stringifyToolArguments(args);
  }
}

function toolCallKey(name: string, args: unknown): string {
  return `${name}\u0000${canonicalToolArguments(args)}`;
}

export function mergeToolCallArtifacts(...artifacts: unknown[]): FinalToolCall[] {
  const values: unknown[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === 'object') {
      const nested = (value as Record<string, unknown>)['calls'];
      if (Array.isArray(nested)) {
        nested.forEach(visit);
        return;
      }
      values.push(value);
    }
  };
  artifacts.forEach(visit);

  const reservedExplicitIds = new Set<string>();
  values.forEach((value: unknown) => {
    const record = value as Record<string, unknown>;
    const generated = isGeneratedToolCall(record);
    const id = record['id'];
    if (!generated && typeof id === 'string' && id) reservedExplicitIds.add(id);
  });

  const output: FinalToolCall[] = [];
  const usedIds = new Set<string>();
  const seenExplicitArtifacts = new Set<string>();
  const seenGenerated = new Set<string>();
  const generatedCounts = new Map<string, number>();

  values.forEach((value: unknown) => {
    const record = value as Record<string, unknown>;
    const fn = record['function'];
    const fnRecord = fn && typeof fn === 'object' && !Array.isArray(fn)
      ? (fn as Record<string, unknown>)
      : {};
    const name = String(fnRecord['name'] ?? '');
    const args = fnRecord['arguments'] ?? {};
    const generated = isGeneratedToolCall(record) || (typeof record['id'] !== 'string' || !record['id']);
    const rawId = typeof record['id'] === 'string' ? record['id'] : '';

    if (!generated) {
      const key = `${rawId}\u0000${toolCallKey(name, args)}`;
      if (seenExplicitArtifacts.has(key)) return;
      seenExplicitArtifacts.add(key);
      usedIds.add(rawId);
      output.push({
        id: rawId,
        type: 'function',
        function: {
          name,
          arguments: stringifyToolArguments(args)
        }
      });
      return;
    }

    const key = toolCallKey(name, args);
    if (seenGenerated.has(key)) return;
    seenGenerated.add(key);
    const generatedBase = rawId || `call_${name.replace(/[^a-zA-Z0-9_]/g, '_') || 'tool'}`;
    let id: string;
    if (rawId) {
      id = rawId;
      let suffix = generatedCounts.get(rawId) || 0;
      while (usedIds.has(id) || reservedExplicitIds.has(id)) {
        suffix += 1;
        id = `${rawId}_${suffix + 1}`;
      }
      generatedCounts.set(rawId, suffix);
    } else {
      let count = (generatedCounts.get(generatedBase) || 0) + 1;
      id = `${generatedBase}_${count}`;
      while (usedIds.has(id) || reservedExplicitIds.has(id)) {
        count += 1;
        id = `${generatedBase}_${count}`;
      }
      generatedCounts.set(generatedBase, count);
    }
    usedIds.add(id);
    output.push(markGeneratedToolCall({
      id,
      type: 'function',
      function: {
        name,
        arguments: stringifyToolArguments(args)
      }
    }));
  });

  return output;
}

// --- public API ------------------------------------------------------------

/** Canonical `<function_calls>` blocks only. Kept for callers that must not guess. */
export function parseToolCallsFromText(...chunks: unknown[]): FinalToolCall[] {
  const calls: RawToolCall[] = [];
  chunks.forEach((chunk: unknown) => {
    if (!chunk || typeof chunk !== 'string') return;
    calls.push(...extractCanonical(chunk).calls);
  });
  return toFinalCalls(calls);
}

function mergeTextSpans(spans: TextSpan[]): TextSpan[] {
  return [...spans].sort((a, b) => a[0] - b[0]).reduce((acc: TextSpan[], span: TextSpan) => {
    const last: TextSpan | undefined = acc[acc.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else acc.push([...span] as TextSpan);
    return acc;
  }, []);
}

function stripTextSpans(text: string, spans: TextSpan[]): string {
  if (!spans.length) return text;
  return mergeTextSpans(spans).reduceRight((acc: string, span: TextSpan) => {
    const [start, end] = span;
    return acc.slice(0, start) + acc.slice(end);
  }, text);
}

export interface StripMarkupOptions {
  registry?: unknown;
  [key: string]: unknown;
}

/**
 * Remove tool-call markup from user-visible text.
 * Registry-gated formats are only stripped when `options.registry` is supplied; the
 * self-delimiting formats are always stripped.
 */
export function stripFunctionCallMarkup(text: string, trim: boolean = true, options: StripMarkupOptions = {}): string {
  if (!text) return text;
  const opts: Record<string, unknown> =
    options && typeof options === 'object' ? (options as unknown as Record<string, unknown>) : {};
  const { spans } = collectAll(text, opts['registry']);
  const cleaned = stripTextSpans(text, spans).replace(RE.canonicalStrayTag, '');
  return trim ? cleaned.trim() : cleaned;
}

export function stripExternalToolCallMarkupFromJoinedText(
  registry: unknown,
  reasoning: unknown,
  content: unknown,
  trim: boolean = false,
): { reasoning: string; content: string } {
  const reasoningText = typeof reasoning === 'string' ? reasoning : '';
  const contentText = typeof content === 'string' ? content : '';
  const source = `${reasoningText}${contentText}`;
  const { spans } = collectAll(source, registry);
  // A bare tool-call payload normally occupies one whole channel while the other carries
  // ordinary reasoning or text. Joined, the body no longer looks like bare JSON, so the
  // registry-gated whole-body rule never fires and the raw payload would stay visible.
  // Re-derive the payload per channel; a joined span that swallows such a channel span
  // is dropped in favour of the narrower per-channel one so the sibling channel's text
  // survives. Ordinary JSON and non-tool arrays produce no channel span and stay visible.
  const names = registryNames(registry);
  const channelSpans: TextSpan[] = [];
  if (names.length) {
    for (const span of extractBareJson(reasoningText, registry).spans) {
      channelSpans.push([span[0], span[1]]);
    }
    for (const span of extractBareJson(contentText, registry).spans) {
      channelSpans.push([reasoningText.length + span[0], reasoningText.length + span[1]]);
    }
  }
  // A payload split across the two channels only completes in the joined body, so the
  // joined whole-body span is the accurate one; narrowing it to the half that parses would
  // leave the other half visible.
  const joinedWholeBody = hasValidJsonCallEnvelope(source, registry);
  const widenedSpans = channelSpans.length && !joinedWholeBody
    ? spans.filter((span) => !channelSpans.some((inner) => inner[0] >= span[0] && inner[1] <= span[1]))
    : spans;
  const merged = mergeTextSpans([...widenedSpans, ...channelSpans]);
  let reasoningOut = '';
  let contentOut = '';
  let cursor = 0;
  const append = (start: number, end: number): void => {
    if (end <= start) return;
    const segment = source.slice(start, end);
    if (start < reasoningText.length) {
      const reasoningEnd = Math.min(end, reasoningText.length);
      reasoningOut += segment.slice(0, reasoningEnd - start);
    }
    const contentStart = Math.max(start, reasoningText.length);
    if (end > contentStart) {
      contentOut += segment.slice(contentStart - start);
    }
  };
  merged.forEach(([start, end]) => {
    append(cursor, start);
    cursor = Math.max(cursor, end);
  });
  append(cursor, source.length);
  reasoningOut = reasoningOut.replace(RE.canonicalStrayTag, '');
  contentOut = contentOut.replace(RE.canonicalStrayTag, '');
  return {
    reasoning: trim ? reasoningOut.trim() : reasoningOut,
    content: trim ? contentOut.trim() : contentOut,
  };
}

/** Parse tool calls and map them onto the request's registry, dropping unknown tools. */
export function parseExternalToolCallsFromText(registry: unknown, ...chunks: unknown[]): FinalToolCall[] {
  if (!Array.isArray(registry) || (registry as unknown[]).length === 0) return [];
  const list = registry as ExternalToolEntry[];
  const rawCalls: RawToolCall[] = [];
  chunks.forEach((chunk: unknown) => {
    if (!chunk || typeof chunk !== 'string') return;
    rawCalls.push(...collectAll(chunk, registry).calls);
  });

  const counts = new Map<string, number>();
  return rawCalls.flatMap((rawCall) => {
    const tool = findExternalToolByName(list, rawCall.name);
    if (!tool) return [];
    const nextCount = (counts.get(tool.namespacedName) || 0) + 1;
    counts.set(tool.namespacedName, nextCount);
    const finalCall: FinalToolCall = {
      id: typeof rawCall.id === 'string' && rawCall.id
        ? rawCall.id
        : `call_${tool.namespacedName.replace(/[^a-zA-Z0-9_]/g, '_')}_${nextCount}`,
      type: 'function' as const,
      function: {
        name: tool.originalName,
        arguments: typeof rawCall.arguments === 'string'
          ? rawCall.arguments
          : JSON.stringify(rawCall.arguments ?? {})
      }
    };
    return typeof rawCall.id === 'string' && rawCall.id
      ? [finalCall]
      : [markGeneratedToolCall(finalCall)];
  });
}

export function parseExternalToolCallsFromJoinedText(
  registry: unknown,
  reasoning: unknown,
  content: unknown,
): FinalToolCall[] {
  if (!Array.isArray(registry) || (registry as unknown[]).length === 0) return [];
  const reasoningText = typeof reasoning === 'string' ? reasoning : '';
  const contentText = typeof content === 'string' ? content : '';
  return mergeToolCallArtifacts(
    parseExternalToolCallsFromText(registry, reasoningText),
    parseExternalToolCallsFromText(registry, contentText),
    parseExternalToolCallsFromText(registry, `${reasoningText}${contentText}`),
  );
}

export function hasExternalToolCallMarkup(registry: unknown, text: unknown): boolean {
  if (typeof text !== 'string' || !text) return false;
  return collectAll(text, registry).spans.length > 0;
}

/**
 * Bare tool-call payload (format 5): the whole body is one call, an array of calls, or a
 * `{tool_calls:[...]}` wrapper. Ordinary JSON and non-tool arrays are left alone, so the
 * check is inert until at least one member resolves onto a registered tool. Once it is
 * tool-call shaped the batch is all-or-nothing: every member must be a well-formed call
 * for a registered tool, which also covers invalid and trailing members.
 */
function hasKnownJsonNameHint(registry: unknown, text: string): boolean {
  if (!Array.isArray(registry) || registry.length === 0) return false;
  for (const match of text.matchAll(RE.jsonNameField)) {
    if (findExternalToolByName(registry, match[1])) return true;
  }
  return false;
}

function hasMalformedBareJsonCall(registry: unknown, text: string, joined?: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (joined !== undefined && hasUnclosedJsonDelimiter(trimmed) && !hasUnclosedJsonDelimiter(joined)) return false;
  const fenced = trimmed.match(RE.codeFence);
  const body = (fenced ? String(fenced[1]) : trimmed).trim();
  if (!body || (body[0] !== '{' && body[0] !== '[')) {
    return trimmed.startsWith('```') && hasKnownJsonNameHint(registry, trimmed);
  }

  const parsed = parseJsonEnvelopeText(body);
  const calls = parsed
    ? jsonPayloadCandidates(parsed.parsed).map((candidate) => rawCallFromJson(candidate)).filter((call): call is RawToolCall => call !== null)
    : [];
  const known = calls.filter((call) => Boolean(findExternalToolByName(registry, call.name)));
  if (known.length) return !hasValidJsonCallEnvelope(body, registry);
  if (parsed) return false;
  return rawCallsFromJsonFragments(body).some((call) => Boolean(findExternalToolByName(registry, call.name))) || hasKnownJsonNameHint(registry, body);
}

function bareJsonLooksLikeToolCall(registry: unknown, text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const fenced = trimmed.match(RE.codeFence);
  const body = (fenced ? String(fenced[1]) : trimmed).trim();
  if (!body || (body[0] !== '{' && body[0] !== '[')) return false;
  const parsed = parseJsonEnvelopeText(body);
  if (!parsed) return hasKnownJsonNameHint(registry, body);
  return jsonPayloadCandidates(parsed.parsed).some((candidate) => {
    const call = rawCallFromJson(candidate);
    return call !== null && Boolean(findExternalToolByName(registry, call.name));
  });
}

function textOutsideSpans(source: string, spans: TextSpan[]): string[] {
  if (!spans.length) return source ? [source] : [];
  const segments: string[] = [];
  let cursor = 0;
  for (const [start, end] of mergeTextSpans(spans)) {
    if (start > cursor) segments.push(source.slice(cursor, start));
    cursor = Math.max(cursor, end);
  }
  if (cursor < source.length) segments.push(source.slice(cursor));
  return segments;
}

function hasStrayBareJsonToolPayload(registry: unknown, source: string, spans: TextSpan[]): boolean {
  return textOutsideSpans(source, spans).some((segment) => bareJsonLooksLikeToolCall(registry, segment));
}

interface CanonicalTagToken {
  start: number;
  end: number;
  closing: boolean;
}

function canonicalTagTokens(source: string): CanonicalTagToken[] {
  return scanMarkupTags(source)
    .tags.filter((tag) => tag.name === 'canonical')
    .map((tag) => ({ start: tag.start, end: tag.end, closing: tag.closing }));
}

function hasValidCanonicalTagStructure(source: string): boolean {
  const stack: CanonicalTagToken[] = [];
  const nestedCounts = new Map<CanonicalTagToken, number>();
  const invalidNestedPrefixes = new Set<CanonicalTagToken>();
  let invalidClose = false;
  let maxDepth = 0;

  for (const token of canonicalTagTokens(source)) {
    if (token.closing) {
      if (!stack.length) {
        invalidClose = true;
        continue;
      }
      stack.pop();
      continue;
    }
    const outer = stack[stack.length - 1];
    if (stack.length === 1 && outer) {
      nestedCounts.set(outer, (nestedCounts.get(outer) || 0) + 1);
      if (source.slice(outer.end, token.start).trim() !== '') invalidNestedPrefixes.add(outer);
    }
    stack.push(token);
    maxDepth = Math.max(maxDepth, stack.length);
  }

  if (invalidClose || maxDepth > 2) return false;
  if (stack.length === 0) return true;
  if (stack.length !== 1) return false;
  const unmatched = stack[0];
  return unmatched !== undefined && nestedCounts.get(unmatched) === 1 && !invalidNestedPrefixes.has(unmatched);
}

interface ToolCallSourceView {
  joined: string;
  channels: string[];
}

function buildToolCallSourceView(entries: unknown[]): ToolCallSourceView | null {
  const channels = entries.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  return channels.length ? { joined: channels.join(''), channels } : null;
}

function normalizeToolCallSource(source: unknown): ToolCallSourceView[] {
  if (typeof source === 'string') {
    const view = buildToolCallSourceView([source]);
    return view ? [view] : [];
  }
  if (!Array.isArray(source)) return [];
  if (source.some((entry) => Array.isArray(entry))) {
    return source
      .filter((entry): entry is unknown[] => Array.isArray(entry))
      .map((group) => buildToolCallSourceView(group))
      .filter((view): view is ToolCallSourceView => view !== null);
  }
  const view = buildToolCallSourceView(source);
  return view ? [view] : [];
}

function hasMalformedToolEnvelope(registry: unknown, text: unknown): boolean {
  if (!Array.isArray(registry) || registry.length === 0) return false;
  return normalizeToolCallSource(text).some(
    (view) =>
      hasMalformedToolSource(registry, view.joined) ||
      view.channels.some((channel) => hasMalformedBareJsonCall(registry, channel, view.joined))
  );
}

function hasMalformedToolSource(registry: unknown, source: string): boolean {
  const collected = collectAll(source, registry);
  if (collected.calls.some((call) => !findExternalToolByName(registry as ExternalToolEntry[], call.name))) return true;

  if (!hasValidCanonicalTagStructure(source)) return true;
  const scan = scanMarkupTags(source);
  for (const block of findMarkupBlocks(scan, 'canonical')) {
    const body = source.slice(block.bodyStart, block.bodyEnd);
    if (hasValidJsonCallEnvelope(body, registry)) continue;
    if (canonicalTagTokens(body).length > 0 && hasValidCanonicalTagStructure(body)) continue;
    return true;
  }

  if (!hasBalancedMarkupTag(scan, 'tool_calls')) return true;
  for (const container of findMarkupBlocks(scan, 'tool_calls')) {
    const body = source.slice(container.bodyStart, container.bodyEnd);
    const analysis = analyzeDsmlSegment(body);
    if (analysis.hasMarkup) {
      if (!analysis.valid || analysis.calls.some((call) => !findExternalToolByName(registry, call.name))) return true;
    } else if (!hasValidJsonCallEnvelope(body, registry)) return true;
  }
  const naked = analyzeDsmlSegment(dsmlRemainder(source), true);
  if (
    naked.hasMarkup &&
    (!naked.valid || naked.calls.some((call) => !findExternalToolByName(registry, call.name)))
  ) return true;

  if (!hasBalancedMarkupTag(scan, 'tool_call')) return true;
  for (const wrapper of findMarkupBlocks(scan, 'tool_call')) {
    const body = source.slice(wrapper.bodyStart, wrapper.bodyEnd);
    const jsonCalls = rawCallsFromJsonEnvelopeText(body);
    if (jsonCalls.length) {
      if (!hasValidJsonCallEnvelope(body, registry)) return true;
      continue;
    }
    const nonJson = extractNonJsonToolWrapper(registry, body);
    if (!nonJson.valid) return true;
    if (nonJson.calls.some((call) => !findExternalToolByName(registry, call.name))) return true;
  }

  if (hasStrayBareJsonToolPayload(registry, source, collected.spans)) return true;

  const names = registryNames(registry);
  const schemas = registrySchemas(registry);
  if (names.length) {
    const opener = new RegExp(`<(${names.map(escapeRegExp).join('|')})(?=[\\s/>"'])`, 'g');
    for (const match of matchAllOutsideStrings(source, opener)) {
      const name = match[1];
      const matchIndex = match.index ?? 0;
      const attrsStart = matchIndex + match[0].length;
      const tagEnd = findTagEnd(source, attrsStart);
      if (tagEnd === -1) return true;
      const attrs = source.slice(attrsStart, tagEnd);
      const attrArgs = argsFromAttrs(attrs);
      if (attrArgs !== null) {
        try {
          JSON.parse(attrArgs);
          continue;
        } catch {
          return true;
        }
      }
      if (attrs.trim().endsWith('/')) continue;
      const openEnd = tagEnd + 1;
      const closeMatch = matchAllOutsideStrings(source.slice(openEnd), new RegExp(`</${escapeRegExp(name)}\\s*>`, 'gi'))[0];
      const closeIdx = closeMatch ? openEnd + (closeMatch.index ?? 0) : -1;
      const body = closeIdx === -1 ? source.slice(openEnd) : source.slice(openEnd, closeIdx);
      if (findFirstJsonValue(body) || argsFromXmlChildren(body, schemas.get(name))) continue;
      return true;
    }
  }

  for (const match of matchAllOutsideStrings(source, /<function\s*=\s*([^\s/>]+)\s*>/gi)) {
    const name = String(match[1]).trim();
    const openEnd = (match.index ?? 0) + match[0].length;
    const closeMatch = matchAllOutsideStrings(source.slice(openEnd), /<\/function\s*>/gi)[0];
    const closeIdx = closeMatch ? openEnd + (closeMatch.index ?? 0) : -1;
    if (closeIdx === -1) return true;
    const body = source.slice(openEnd, closeIdx);
    const completeParameters = matchAllOutsideStrings(
      body,
      /<parameter\s*=\s*([^\s/>]+)\s*>([\s\S]*?)<\/parameter\s*>/gi,
    ).length;
    const maskedBody = maskDoubleQuotedStrings(body);
    const parameterOpenCount = (maskedBody.match(/<parameter\s*=/gi) || []).length;
    const parameterCloseCount = (maskedBody.match(/<\/parameter\s*>/gi) || []).length;
    if (completeParameters !== parameterOpenCount || completeParameters !== parameterCloseCount) return true;
    if (completeParameters === 0 && !functionEqualsAllowsEmptyArguments(name, registry)) return true;
  }

  return false;
}

export function assertToolCallArtifactIntegrity(calls: unknown, registry: unknown, sourceText: unknown): void {
  const ids = new Map<string, string>();
  if (Array.isArray(calls)) {
    for (const call of calls) {
      const record = call && typeof call === 'object' ? (call as Record<string, unknown>) : {};
      const id = record['id'];
      if (typeof id !== 'string' || !id) continue;
      const fn = record['function'];
      const fnRecord = fn && typeof fn === 'object' && !Array.isArray(fn)
        ? (fn as Record<string, unknown>)
        : {};
      const semanticKey = toolCallKey(String(fnRecord['name'] ?? ''), fnRecord['arguments'] ?? {});
      const previous = ids.get(id);
      if (previous !== undefined && previous !== semanticKey) {
        const error = new Error('The model emitted conflicting arguments for a duplicate external tool call id.') as Error & { code?: string };
        error.code = 'duplicate_external_tool_call_id';
        throw error;
      }
      ids.set(id, semanticKey);
    }
  }
  if (hasMalformedToolEnvelope(registry, sourceText)) {
    const error = new Error('The model emitted malformed external tool markup.') as Error & { code?: string };
    error.code = 'malformed_external_tool_call';
    throw error;
  }
}

/**
 * Openers that may begin tool markup. Used to decide whether a partial chunk should be
 * withheld from the client until we know what it is.
 */
function markerOpeners(registry: unknown): string[] {
  const openers = ['<function_calls', '<function=', '<tool_call', '<tool_calls', '<invoke', '<parameter', '<\uFF5C', '<|'];
  registryNames(registry).forEach((name) => openers.push(`<${name.toLowerCase()}`));
  return openers;
}

/** True when `candidate` is a prefix of an opener, or already contains one. */
function couldBeMarker(candidate: string, openers: string[]): boolean {
  const lower = candidate.toLowerCase().replace(/\u200b/g, '');
  return openers.some((opener) => {
    const normalized = opener.toLowerCase().replace(/\u200b/g, '');
    return normalized.startsWith(lower) || lower.startsWith(normalized);
  });
}

interface InlineBlock {
  open: RegExp;
  close: RegExp;
}

/** Complete self-delimiting blocks are dropped inline; other formats wait for flush(). */
const INLINE_BLOCKS: InlineBlock[] = [
  { open: new RegExp(`^<${MARK}tool_calls\\s*>`, 'i'), close: new RegExp(`</${MARK}tool_calls\\s*>`, 'i') },
  { open: new RegExp(`^<${MARK}invoke\\s`, 'i'), close: new RegExp(`</${MARK}invoke\\s*>`, 'i') },
  { open: /^<\u200b?tool_call\s*>/i, close: /<\/\u200b?tool_call\s*>/i },
  { open: new RegExp(`^${escapeRegExp(CANONICAL_OPEN)}`, 'i'), close: new RegExp(escapeRegExp(CANONICAL_CLOSE), 'i') }
];

/**
 * Close tags for the known block formats. OpenCode streams reasoning and content as
 * separate channels, so a model can open a block in one and close it in the other. The
 * channel that only receives the closer must drop it instead of printing it as prose.
 */
const KNOWN_CLOSE_TAG = new RegExp(
  `^</(?:\\u200b?tool_call|${MARK}(?:function_calls|function|tool_calls|invoke|parameter))\\s*>`,
  'i'
);

/** A close tag truncated at a chunk boundary, e.g. "</function_". */
const PARTIAL_CLOSE_TAG = /^<\/\u200b?[a-z0-9_\uFF5C|]*$/i;

function matchInlineBlock(buffer: string): { pending: true } | { end: number } | null {
  for (const block of INLINE_BLOCKS) {
    if (!block.open.test(buffer)) continue;
    const close = buffer.match(block.close);
    if (!close) return { pending: true };
    const closeIndex: number = close.index ?? 0;
    return { end: closeIndex + close[0].length };
  }
  return null;
}

export interface ToolCallFilterOptions {
  disableTools?: unknown;
  forceStrip?: unknown;
  registry?: unknown;
  [key: string]: unknown;
}

/**
 * Streaming text filter. Emits user-visible text and withholds anything that may be tool
 * markup. Call `flush()` when the stream ends to release or discard held text.
 */
export function createToolCallFilter(options: ToolCallFilterOptions = {}): ToolCallFilter {
  const opts: Record<string, unknown> =
    options && typeof options === 'object' ? (options as unknown as Record<string, unknown>) : {};
  const disableTools: unknown = opts['disableTools'];
  const forceStrip: unknown = opts['forceStrip'] ?? false;
  const registry: unknown = opts['registry'] ?? null;
  if (!disableTools && !forceStrip) {
    const passthrough = ((chunk: string): string => chunk) as ToolCallFilter;
    passthrough.flush = (): string => '';
    return passthrough;
  }

  const openers = markerOpeners(registry);
  let buffer = '';
  let emittedVisible = false;
  let held = false;

  const filter = ((chunk: string): string => {
    if (!chunk) return '';
    buffer += chunk;
    let output = '';

    while (buffer.length) {
      if (held) return output;

      const inline = matchInlineBlock(buffer);
      if (inline && 'pending' in inline) return output;
      if (inline && 'end' in inline) {
        buffer = buffer.slice(inline.end);
        continue;
      }

      // Orphaned close tag from a block that opened in the other channel.
      const orphanClose = buffer.match(KNOWN_CLOSE_TAG);
      if (orphanClose) {
        buffer = buffer.slice(orphanClose[0].length);
        continue;
      }
      if (PARTIAL_CLOSE_TAG.test(buffer)) return output;

      // A leading `{` may be a whole-body JSON call; hold it until flush decides.
      if (!emittedVisible && !output.trim() && /^\s*[{[]/.test(buffer)) {
        held = true;
        return output;
      }

      const markerIdx = buffer.indexOf('<');
      if (markerIdx === -1) {
        output += buffer;
        buffer = '';
        break;
      }

      if (markerIdx > 0) {
        output += buffer.slice(0, markerIdx);
        buffer = buffer.slice(markerIdx);
        continue;
      }

      if (!couldBeMarker(buffer, openers)) {
        output += buffer[0];
        buffer = buffer.slice(1);
        continue;
      }

      // Either an incomplete opener or a registry-gated format. Hold for flush().
      const complete = /^<[^\s/>]+[^>]*>/.test(buffer);
      if (!complete) return output;
      held = true;
      return output;
    }

    if (output.trim()) emittedVisible = true;
    return output;
  }) as ToolCallFilter;

  filter.flush = (): string => {
    const remaining = buffer;
    buffer = '';
    held = false;
    if (!remaining) return '';
    // Strip whatever markup is actually present and release the rest. Also drop a
    // trailing orphaned close tag that was still being buffered when the stream ended.
    const stripped = stripFunctionCallMarkup(remaining, false, { registry });
    return KNOWN_CLOSE_TAG.test(stripped.trim()) ? '' : stripped;
  };

  return filter;
}

/**
 * Streaming tool-call extractor. Self-delimiting blocks surface as soon as they close;
 * registry-gated formats surface from `flush()` at end of stream.
 */
export function createExternalToolCallStreamParser(registry: unknown): ToolCallStreamParser {
  if (!Array.isArray(registry) || (registry as unknown[]).length === 0) {
    const noop = ((..._args: unknown[]): FinalToolCall[] => []) as ToolCallStreamParser;
    noop.flush = (): FinalToolCall[] => [];
    return noop;
  }
  const list = registry as ExternalToolEntry[];

  const openers = markerOpeners(registry);
  let buffer = '';
  let sequence = 0;

  const withUniqueIds = (calls: FinalToolCall[]): FinalToolCall[] => calls.map((call) => {
    if (!isGeneratedToolCall(call)) return call;
    sequence += 1;
    return markGeneratedToolCall({ ...call, id: `${call.id}_${sequence}` });
  });

  const parser = ((chunk: string): FinalToolCall[] => {
    if (!chunk) return [];
    buffer += chunk;
    const calls: FinalToolCall[] = [];

    while (buffer.length) {
      const markerIdx = buffer.search(/<[^\s]/);
      if (markerIdx === -1) break;

      const candidate = buffer.slice(markerIdx);
      const inline = matchInlineBlock(candidate);
      if (inline && 'pending' in inline) break;
      if (inline && 'end' in inline) {
        const block = candidate.slice(0, inline.end);
        calls.push(...withUniqueIds(parseExternalToolCallsFromText(list, block)));
        buffer = candidate.slice(inline.end);
        continue;
      }

      if (couldBeMarker(candidate, openers)) break;
      buffer = candidate.slice(1);
    }

    return calls;
  }) as ToolCallStreamParser;

  parser.flush = (): FinalToolCall[] => {
    const remaining = buffer;
    buffer = '';
    if (!remaining.trim()) return [];
    return withUniqueIds(parseExternalToolCallsFromText(list, remaining));
  };

  return parser;
}
