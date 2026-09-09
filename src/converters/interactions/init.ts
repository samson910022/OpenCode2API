/**
 * interactions <-> {chat, responses, messages} directed-pair registration.
 *
 * Mirrors CLIProxyAPI per-pair init.go files:
 * - openai/interactions/chat-completions/init.go (both directions)
 * - openai/interactions/responses/init.go (both directions)
 * - claude/interactions/init.go + interactions/claude/init.go
 *
 * Stream: only chat->interactions in P3 (stateful, holder contract mirrors
 * chat-responses); remaining stream directions are P4.
 */

import { FormatClaude, FormatInteractions, FormatOpenAI, FormatOpenAIResponse } from '../formats.js';
import type { TranslatorRegistry } from '../registry.js';
import { defaultTranslatorRegistry } from '../registry.js';
import {
    convertChatRequestToInteractions,
    convertInteractionsRequestToChat,
    convertInteractionsRequestToMessages,
    convertInteractionsRequestToResponses,
    convertMessagesRequestToInteractions,
    convertResponsesRequestToInteractions,
} from './request.js';
import {
    convertChatResponseToInteractionsNonStream,
    convertInteractionsResponseToChatNonStream,
    convertInteractionsResponseToMessagesNonStream,
    convertInteractionsResponseToResponsesNonStream,
    convertMessagesResponseToInteractionsNonStream,
    convertResponsesResponseToInteractionsNonStream,
    createChatToInteractionsStreamTranslator,
    createInteractionsToChatStreamTranslator,
    createInteractionsToMessagesStreamTranslator,
    createInteractionsToResponsesStreamTranslator,
    createMessagesToInteractionsStreamTranslator,
    createResponsesToInteractionsStreamTranslator,
} from './response.js';

function holderTranslator<T>(param: unknown, model: string, create: (model: string) => T): T {
    if (param && typeof param === 'object') {
        const holder = param as StreamHolder<T>;
        if (!holder.translator) holder.translator = create(model);
        return holder.translator;
    }
    return create(model);
}

export interface StreamHolder<T> {
    translator?: T;
}

export type ChatToInteractionsStreamHolder = StreamHolder<ReturnType<typeof createChatToInteractionsStreamTranslator>>;
export type InteractionsToChatStreamHolder = StreamHolder<ReturnType<typeof createInteractionsToChatStreamTranslator>>;
export type ResponsesToInteractionsStreamHolder = StreamHolder<ReturnType<typeof createResponsesToInteractionsStreamTranslator>>;
export type InteractionsToResponsesStreamHolder = StreamHolder<ReturnType<typeof createInteractionsToResponsesStreamTranslator>>;
export type MessagesToInteractionsStreamHolder = StreamHolder<ReturnType<typeof createMessagesToInteractionsStreamTranslator>>;
export type InteractionsToMessagesStreamHolder = StreamHolder<ReturnType<typeof createInteractionsToMessagesStreamTranslator>>;

export function registerInteractionsPairs(registry: TranslatorRegistry = defaultTranslatorRegistry()): void {
    registry.register(FormatOpenAI, FormatInteractions, (model, body, stream) => convertChatRequestToInteractions(model, body, stream), {
        stream: (model, _o, _t, chunk, param) => holderTranslator(param, model, (m) => createChatToInteractionsStreamTranslator(m))(chunk) as unknown[],
        nonStream: (model, o, t, body) => convertChatResponseToInteractionsNonStream(model, o, t, body),
    });
    registry.register(FormatInteractions, FormatOpenAI, (model, body, stream) => convertInteractionsRequestToChat(model, body, stream), {
        stream: (model, _o, _t, chunk, param) => holderTranslator(param, model, (m) => createInteractionsToChatStreamTranslator(m))(chunk) as unknown[],
        nonStream: (model, o, t, body) => convertInteractionsResponseToChatNonStream(model, o, t, body),
    });
    registry.register(FormatOpenAIResponse, FormatInteractions, (model, body, stream) => convertResponsesRequestToInteractions(model, body, stream), {
        stream: (model, _o, _t, chunk, param) => holderTranslator(param, model, (m) => createResponsesToInteractionsStreamTranslator(m))(chunk) as unknown[],
        nonStream: (model, o, t, body) => convertResponsesResponseToInteractionsNonStream(model, o, t, body),
    });
    registry.register(FormatInteractions, FormatOpenAIResponse, (model, body, stream) => convertInteractionsRequestToResponses(model, body, stream), {
        stream: (model, _o, _t, chunk, param) => holderTranslator(param, model, (m) => createInteractionsToResponsesStreamTranslator(m))(chunk) as unknown[],
        nonStream: (model, o, t, body) => convertInteractionsResponseToResponsesNonStream(model, o, t, body),
    });
    registry.register(FormatClaude, FormatInteractions, (model, body, stream) => convertMessagesRequestToInteractions(model, body, stream), {
        stream: (model, _o, _t, chunk, param) => holderTranslator(param, model, (m) => createMessagesToInteractionsStreamTranslator(m))(chunk) as unknown[],
        nonStream: (model, o, t, body) => convertMessagesResponseToInteractionsNonStream(model, o, t, body),
    });
    registry.register(FormatInteractions, FormatClaude, (model, body, stream) => convertInteractionsRequestToMessages(model, body, stream), {
        stream: (model, _o, _t, chunk, param) => holderTranslator(param, model, (m) => createInteractionsToMessagesStreamTranslator(m))(chunk) as unknown[],
        nonStream: (model, o, t, body) => convertInteractionsResponseToMessagesNonStream(model, o, t, body),
    });
}
