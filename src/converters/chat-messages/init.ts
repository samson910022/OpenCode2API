/**
 * messages <-> chat directed-pair registration.
 * Request/response ports:
 * - messages.request -> chat.request wraps ../anthropic.js (openai/claude port)
 * - chat.request -> messages.request mirrors
 *   CLIProxyAPI claude/openai/chat-completions/claude_openai_request.go
 * - chat.response <-> messages.response mirror
 *   openai/claude/openai_claude_response.go (NonStream) + stream core
 */

import { FormatClaude, FormatOpenAI } from '../formats.js';
import type { TranslatorRegistry } from '../registry.js';
import { defaultTranslatorRegistry } from '../registry.js';
import type { StreamHolder } from '../holder.js';
import { holderTranslatorOf } from '../holder.js';
import { convertChatRequestToMessages, convertMessagesRequestToChat } from './request.js';
import {
    convertChatResponseToMessagesNonStream,
    convertMessagesResponseToChatNonStream,
    createChatToMessagesStreamTranslator,
    createMessagesToChatStreamTranslator,
    type AnthropicStreamEvent,
} from './response.js';

export interface ChatMessagesStreamHolder extends StreamHolder<ReturnType<typeof createChatToMessagesStreamTranslator>> {}

export interface MessagesChatStreamHolder extends StreamHolder<ReturnType<typeof createMessagesToChatStreamTranslator>> {}

function messagesChatTranslatorOf(param: unknown, model: string): ReturnType<typeof createMessagesToChatStreamTranslator> {
    return holderTranslatorOf(param, model, (m) => createMessagesToChatStreamTranslator(m));
}

function chatMessagesTranslatorOf(param: unknown, model: string): ReturnType<typeof createChatToMessagesStreamTranslator> {
    return holderTranslatorOf(param, model, (m) => createChatToMessagesStreamTranslator(m));
}

export function registerChatMessagesPair(registry: TranslatorRegistry = defaultTranslatorRegistry()): void {
    registry.register(FormatClaude, FormatOpenAI, (model, body, stream) => convertMessagesRequestToChat(model, body, stream), {
        stream: (model, _o, _t, chunk, param) => messagesChatTranslatorOf(param, model)(chunk) as unknown[],
        nonStream: (model, o, t, body) => convertMessagesResponseToChatNonStream(model, o, t, body),
    });
    registry.register(FormatOpenAI, FormatClaude, (model, body, stream) => convertChatRequestToMessages(model, body, stream), {
        stream: (model, _o, _t, chunk, param) => chatMessagesTranslatorOf(param, model)(chunk) as unknown[],
        nonStream: (model, o, t, body) => convertChatResponseToMessagesNonStream(model, o, t, body),
    });
}

export type { AnthropicStreamEvent };
