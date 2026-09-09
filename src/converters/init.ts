/**
 * N×N directed-pair registration entrypoint.
 *
 * Mirrors CLIProxyAPI `internal/translator/init.go` (blank imports triggering
 * per-pair `init()`). Here registration is explicit (no side-effect imports)
 * so Jest ESM ordering stays deterministic.
 *
 * NOTE: production routes consume the registry via src/converters/wire.ts
 * Safe wrappers (error-bypass + per-stream holders). The registry is
 * initialized once per process (see ensureTranslatorsRegistered): an
 * unregistered direction still falls back to passthrough-with-model-
 * normalization, never to an error, so callers MUST use the wire.ts
 * Safe wrappers (which bypass error envelopes before translating).
 */

import type { TranslatorRegistry } from './registry.js';
import { defaultTranslatorRegistry } from './registry.js';
import { registerChatResponsesPair } from './chat-responses/init.js';
import { registerChatMessagesPair } from './chat-messages/init.js';
import { registerResponsesMessagesPair } from './responses-messages/init.js';
import { registerInteractionsPairs } from './interactions/init.js';

/** Registries already initialized (idempotent wiring; createApp runs per test). */
const initializedRegistries = new WeakSet<TranslatorRegistry>();

export function registerAllTranslatorPairs(registry: TranslatorRegistry = defaultTranslatorRegistry()): void {
    if (initializedRegistries.has(registry)) return;
    // NOTE: mark initialized only AFTER all four succeed — a throwing
    // register must not poison the cache into a half-wired (6/12) no-op.
    // Per-pair register* on a shared registry is not supported; always use
    // registerAll (fresh registries in tests may use per-pair directly).
    registerChatResponsesPair(registry);
    registerChatMessagesPair(registry);
    registerResponsesMessagesPair(registry);
    registerInteractionsPairs(registry);
    initializedRegistries.add(registry);
}
