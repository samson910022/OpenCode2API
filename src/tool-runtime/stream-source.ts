// Authoritative stream source selection for external tool finalization.
//
// Streaming routes receive the same assistant text twice: incremental deltas
// (`message.part.delta` / legacy `message.part.updated` delta) and one or more
// full snapshots (a recovery poll, `message.updated` info.parts, or the final
// `part.text`). The two sources are not independent artifacts: a lossy delta
// stream can be missing a chunk while the snapshot is complete. Validating both
// groups independently therefore fails a turn that the snapshot could repair.
//
// Routes must pick exactly one group for parse/validate/finalize: the snapshot
// when one is available, otherwise the raw delta text. This helper centralizes
// that choice so all three public protocols behave identically.
import { asRecord } from '../utils/guards.js';

export interface StreamSnapshotLike {
  content?: unknown;
  reasoning?: unknown;
  error?: unknown;
  /** Timeout fallback: the backend message has not finished yet. */
  partial?: unknown;
  /** Recovery poll observed a terminal message. */
  complete?: unknown;
}

export type AuthoritativeStreamSourceKind = 'polled-snapshot' | 'collector-snapshot' | 'raw';

export interface AuthoritativeStreamSource {
  content: string;
  reasoning: string;
  kind: AuthoritativeStreamSourceKind;
  fromSnapshot: boolean;
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

export function resolveAuthoritativeStreamSource(input: {
  collected: unknown;
  polledSnapshot?: StreamSnapshotLike | null;
  rawContent: unknown;
  rawReasoning: unknown;
}): AuthoritativeStreamSource {
  const polled = input.polledSnapshot;
  if (polled && polled.error == null && polled.partial !== true) {
    const content = asText(polled.content);
    const reasoning = asText(polled.reasoning);
    // Empty snapshots (including terminal ones) are not evidence: preferring
    // them would erase calls that were already streamed. A timeout partial is
    // likewise not final and must not replace the raw/collector group.
    if (content || reasoning) {
      return {
        content,
        reasoning,
        kind: 'polled-snapshot',
        fromSnapshot: true,
      };
    }
  }

  const collected = asRecord(input.collected);
  const rawContent = asText(input.rawContent);
  const rawReasoning = asText(input.rawReasoning);
  if (collected['authoritative'] === true && collected['error'] == null) {
    const content = asText(collected['content']);
    const reasoning = asText(collected['reasoning']);
    // The collector only marks a real repair, but keep the non-empty guard here
    // too: an empty authoritative repair must not hide streamed tool calls. Text
    // equal to the raw group is not a repair either, so keep that path as well.
    if ((content || reasoning) && (content !== rawContent || reasoning !== rawReasoning)) {
      return {
        content,
        reasoning,
        kind: 'collector-snapshot',
        fromSnapshot: true,
      };
    }
  }

  return {
    content: rawContent,
    reasoning: rawReasoning,
    kind: 'raw',
    fromSnapshot: false,
  };
}

/** True when the parser rejected partial/malformed tool markup. */
export function isMalformedExternalToolCallError(error: unknown): boolean {
  return asRecord(error)['code'] === 'malformed_external_tool_call';
}
