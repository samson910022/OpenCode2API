// Server-side search grounding helpers (pure; no Express/SDK deps).
//
// Maps OpenAI-style hosted search tools (`tools:[{type:web_search}]`) onto the
// opencode built-in `websearch` tool and rebuilds `web_search_call` output
// items + `url_citation` annotations from the backend tool parts.
import { asRecord } from '../utils/guards.js';

export const HOSTED_SEARCH_TOOL_TYPES = ['web_search', 'web_search_preview', 'google_search'];
/** True for hosted search tool types, incl. versioned variants (e.g. Anthropic `web_search_20260222`). */
export function isHostedSearchType(type: unknown): boolean {
  if (typeof type !== 'string') return false;
  const v = type.toLowerCase();
  return HOSTED_SEARCH_TOOL_TYPES.includes(v) || v.startsWith('web_search_') || v.startsWith('web_search-');
}

export const SEARCH_GROUNDING_INSTRUCTION =
  'A built-in web search tool (websearch) is enabled for this turn. ' +
  'When the request needs fresh or external facts, call websearch first and answer ' +
  'only from the conversation plus the search results. ' +
  'Include the source URLs you relied on verbatim in your answer so they can be cited.';

function toolTypeOf(def: unknown): string {
  return typeof asRecord(def)['type'] === 'string' ? String(asRecord(def)['type']) : '';
}

export interface HostedSearchRequest {
  requested: boolean;
  kinds: string[];
}

/** Detect OpenAI/Gemini/Anthropic hosted search tools in a `tools` array. */
export function detectHostedSearchTools(tools: unknown): HostedSearchRequest {
  if (!Array.isArray(tools)) return { requested: false, kinds: [] };
  const kinds: string[] = [];
  for (const def of tools as unknown[]) {
    const t = toolTypeOf(def).toLowerCase();
    if (isHostedSearchType(t) && !kinds.includes(t)) kinds.push(t);
  }
  return { requested: kinds.length > 0, kinds };
}

/** Remove hosted search defs so the external-tool registry stays function-only. */
export function stripHostedSearchTools(tools: unknown): unknown[] {
  if (!Array.isArray(tools)) return [];
  return (tools as unknown[]).filter((def) => !isHostedSearchType(toolTypeOf(def).toLowerCase()));
}

export interface SearchSource {
  url: string;
  title: string;
}

export interface SearchEvidence {
  queries: string[];
  sources: SearchSource[];
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

function cleanUrl(raw: string): string | null {
  const m = raw.match(URL_RE);
  if (!m || !m[0]) return null;
  // Trim trailing punctuation the regex may have swallowed.
  return m[0].replace(/[.,;:!?]+$/, '');
}

/** Extract http(s) URLs from free text, deduped, capped. */
export function extractUrls(text: unknown, cap = 10): string[] {
  if (typeof text !== 'string' || !text) return [];
  const out: string[] = [];
  for (const match of text.matchAll(URL_RE)) {
    const u = cleanUrl(match[0]);
    if (u && !out.includes(u)) out.push(u);
    if (out.length >= cap) break;
  }
  return out;
}

function titleFor(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function inputQueryText(input: unknown): string {
  if (typeof input === 'string') return input;
  const rec = asRecord(input);
  for (const key of ['query', 'q', 'question', 'text']) {
    if (typeof rec[key] === 'string' && (rec[key] as string).trim()) return (rec[key] as string).trim();
  }
  return '';
}

function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === null || output === undefined) return '';
  const rec = asRecord(output);
  for (const key of ['text', 'content', 'result', 'output', 'summary']) {
    if (typeof rec[key] === 'string' && (rec[key] as string)) return rec[key] as string;
  }
  try {
    return JSON.stringify(output);
  } catch {
    return '';
  }
}

/**
 * Rebuild search evidence from backend `type:'tool'` parts. Only completed
 * `websearch` executions count; anything else is ignored. URLs are taken
 * exclusively from tool output text that the model could have seen — never
 * invented — so downstream citations stay honest.
 */
export function extractSearchEvidence(toolParts: unknown): SearchEvidence {
  const queries: string[] = [];
  const sources: SearchSource[] = [];
  if (!Array.isArray(toolParts)) return { queries, sources };
  for (const part of toolParts as unknown[]) {
    const pr = asRecord(part);
    if (pr['type'] !== 'tool') continue;
    const toolName = String(pr['tool'] ?? '');
    if (toolName !== 'websearch') continue;
    const state = asRecord(pr['state']);
    if (state['status'] !== 'completed') continue;
    const q = inputQueryText(state['input']);
    if (q && !queries.includes(q)) queries.push(q);
    for (const url of extractUrls(outputText(state['output']))) {
      if (!sources.some((s) => s.url === url)) sources.push({ url, title: titleFor(url) });
    }
  }
  return { queries, sources };
}

export interface WebSearchCallItem {
  id: string;
  type: 'web_search_call';
  status: 'completed';
  action: { type: 'search'; query: string };
}

/** One `web_search_call` output item per executed query. */
export function buildWebSearchCallItems(evidence: SearchEvidence, idPrefix = 'ws'): WebSearchCallItem[] {
  return evidence.queries.map((query, i) => ({
    id: `${idPrefix}_${i + 1}`,
    type: 'web_search_call',
    status: 'completed',
    action: { type: 'search', query },
  }));
}

export interface CitationAnnotation {
  type: 'url_citation';
  start_index: number;
  end_index: number;
  url: string;
  title: string;
}

/**
 * Build `url_citation` annotations for source URLs verifiably present in the
 * answer text (substring match). Sources absent from the text yield nothing —
 * an empty list beats a hallucinated citation.
 */
export function buildCitationAnnotations(text: unknown, sources: SearchSource[], cap = 10): CitationAnnotation[] {
  if (typeof text !== 'string' || !text) return [];
  const out: CitationAnnotation[] = [];
  for (const source of sources) {
    if (out.length >= cap) break;
    const idx = text.indexOf(source.url);
    if (idx < 0) continue;
    out.push({
      type: 'url_citation',
      start_index: idx,
      end_index: idx + source.url.length,
      url: source.url,
      title: source.title,
    });
  }
  return out;
}
