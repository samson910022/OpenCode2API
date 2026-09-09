/**
 * N×N translator format identifiers.
 *
 * Port of CLIProxyAPI `sdk/translator/formats.go` + `internal/constant/constant.go`,
 * scoped to the four protocols this gateway serves. No Express/SDK deps (pure layer).
 *
 * Reference:
 * - /home/samson1357924/projects/CLIProxyAPI/sdk/translator/formats.go
 * - /home/samson1357924/projects/CLIProxyAPI/internal/constant/constant.go
 *
 * TODO: CLIProxyAPI also defines `gemini` / `codex` / `antigravity`
 * (`formats.go:8-10`); out of scope for P0 (four local protocols only).
 * Add new Format constants + directed pairs when a fifth protocol lands.
 */

export const FormatOpenAI = 'openai' as const;
export const FormatOpenAIResponse = 'openai-response' as const;
export const FormatClaude = 'claude' as const;
export const FormatInteractions = 'interactions' as const;

export type Format =
    | typeof FormatOpenAI
    | typeof FormatOpenAIResponse
    | typeof FormatClaude
    | typeof FormatInteractions;

export const ALL_FORMATS: readonly Format[] = [
    FormatOpenAI,
    FormatOpenAIResponse,
    FormatClaude,
    FormatInteractions,
] as const;

export function isFormat(value: unknown): value is Format {
    return (
        value === FormatOpenAI ||
        value === FormatOpenAIResponse ||
        value === FormatClaude ||
        value === FormatInteractions
    );
}
