/**
 * N×N translator function types.
 *
 * Port of CLIProxyAPI `sdk/translator/types.go`. Payloads are plain JSON values
 * (`unknown`) instead of Go `[]byte`; streaming transforms return chunk arrays
 * instead of `[][]byte`. No Express/SDK deps (pure layer).
 *
 * Reference:
 * - /home/samson1357924/projects/CLIProxyAPI/sdk/translator/types.go
 * - /home/samson1357924/projects/CLIProxyAPI/sdk/translator/registry.go
 *
 * TODO(P1): Go signatures carry `context.Context` + return errors
 * (`types.go:9,14,18`); P0 middleware/transforms are infallible rewrites.
 * If cancellation/retry-after propagation is needed, widen to
 * `Result`-returning transforms without changing the (source, target) order.
 */

/** Convert a request payload from a source format to a target format. */
export type RequestTransform = (model: string, body: unknown, stream: boolean) => unknown;

/** Convert one streaming response chunk from source format to target format. */
export type ResponseStreamTransform = (
    model: string,
    originalRequest: unknown,
    translatedRequest: unknown,
    chunk: unknown,
    param?: unknown,
) => unknown[];

/** Convert a non-streaming response body from source format to target format. */
export type ResponseNonStreamTransform = (
    model: string,
    originalRequest: unknown,
    translatedRequest: unknown,
    body: unknown,
    param?: unknown,
) => unknown;

/** Convert a token count between formats (passthrough by default). */
export type ResponseTokenCountTransform = (count: number) => unknown;

export interface ResponseTransform {
    stream?: ResponseStreamTransform | null;
    nonStream?: ResponseNonStreamTransform | null;
    tokenCount?: ResponseTokenCountTransform | null;
}
