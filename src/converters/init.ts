/**
 * N×N directed-pair registration entrypoint.
 *
 * Mirrors CLIProxyAPI `internal/translator/init.go` (blank imports triggering
 * per-pair `init()`). Here registration is explicit (no side-effect imports)
 * so Jest ESM ordering stays deterministic.
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
