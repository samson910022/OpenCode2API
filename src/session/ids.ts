// Session/message ID format guardrails (Stage-2 mimic work).
//
// Upstream facts as of opencode@5a8335857b (re-verify on backend bump):
// - `x-opencode-session` is minted inside the backend:
//   `packages/schema/src/session-id.ts` = `"ses_" + descending()`,
//   where descending = 12 lowercase hex + 14 base62
//   (`packages/schema/src/identifier.ts`, mirrored in
//   `packages/opencode/src/id/id.ts`). Schema acceptance is loose
//   (`startsWith("ses")`), but Zen logging/sticky routing expects canonical.
// - `x-opencode-request` = `"msg_" + ascending()`, same suffix shape
//   (`packages/schema/src/session-message.ts`).
// - `x-opencode-project` has NO `prj_` prefix in this commit (grep finds
//   nothing under packages/); values are `"global"` or opaque git-derived
//   strings (`packages/core/src/project.ts`), or omitted when empty.
// - The SDK path (`session.create()` with no params) offers no per-request
//   header passthrough: the gateway CANNOT and MUST NOT forge these IDs.
//   They are validated here only as a debug drift signal (e.g. backend
//   version change), never to block a request. The regexes below are
//   intentionally strict: a backend format change only emits a debug log.
const SESSION_SUFFIX = '[0-9a-f]{12}[0-9A-Za-z]{14}';

export const SESSION_ID_RE = new RegExp(`^ses_${SESSION_SUFFIX}$`);
export const MESSAGE_ID_RE = new RegExp(`^msg_${SESSION_SUFFIX}$`);

export function isValidSessionId(value: unknown): boolean {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

export function isValidMessageId(value: unknown): boolean {
  return typeof value === 'string' && MESSAGE_ID_RE.test(value);
}
