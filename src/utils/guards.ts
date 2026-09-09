// Shared unknown-guards (single source; do not duplicate per file).
//
// `asRecord` is byte-identical to the former per-file copies in
// proxy.ts / routes/* / stream/collector.ts / errors/upstream.ts /
// tool-runtime/registry.ts. `toErrorMessage` matches the variant used by
// proxy.ts and the three main routes (chat/responses/messages):
// non-Error objects are read via `asRecord` and only a string `message`
// field is used, otherwise the whole value is stringified.
// NOTE: routes/system.ts and stream/collector.ts intentionally keep their
// own narrower `toErrorMessage` (stringifies a non-string `message`
// field instead); do not "unify" them here — that would change behavior.

export function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function toErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  const r = asRecord(e);
  const m: unknown = r['message'];
  return typeof m === 'string' ? m : String(e);
}
