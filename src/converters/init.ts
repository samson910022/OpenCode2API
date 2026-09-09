/**
 * N×N directed-pair registration entrypoint.
 *
 * Mirrors CLIProxyAPI `internal/translator/init.go` (blank imports triggering
 * per-pair `init()`). Here registration is explicit (no side-effect imports)
 * so Jest ESM ordering stays deterministic.
 *
 * NOTE: production routes do not consume the registry yet — it is exercised
 * by tests only, so behavior today is unchanged. When wiring routes, the
 * caller MUST invoke registerAllTranslatorPairs (or the per-pair register
 * functions) first: an unregistered direction silently falls back to
 * passthrough-with-model-normalization, never to an error.
 */

import type { TranslatorRegistry } from './registry.js';
import { defaultTranslatorRegistry } from './registry.js';
import { registerChatResponsesPair } from './chat-responses/init.js';
import { registerChatMessagesPair } from './chat-messages/init.js';
import { registerResponsesMessagesPair } from './responses-messages/init.js';
import { registerInteractionsPairs } from './interactions/init.js';

export function registerAllTranslatorPairs(registry: TranslatorRegistry = defaultTranslatorRegistry()): void {
    registerChatResponsesPair(registry);
    registerChatMessagesPair(registry);
    registerResponsesMessagesPair(registry);
    registerInteractionsPairs(registry);
}
