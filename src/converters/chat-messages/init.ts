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
import { convertChatRequestToMessages, convertMessagesRequestToChat } from './request.js';
import {
    convertChatResponseToMessagesNonStream,
    convertMessagesResponseToChatNonStream,
    createChatToMessagesStreamTranslator,
    createMessagesToChatStreamTranslator,
    type AnthropicStreamEvent,
} from './response.js';

export interface ChatMessagesStreamHolder {
    translator?: ReturnType<typeof createChatToMessagesStreamTranslator>;
}

export interface MessagesChatStreamHolder {
    translator?: ReturnType<typeof createMessagesToChatStreamTranslator>;
}

function messagesChatTranslatorOf(param: unknown, model: string): ReturnType<typeof createMessagesToChatStreamTranslator> {
    if (param && typeof param === 'object') {
        const holder = param as MessagesChatStreamHolder;
        if (!holder.translator) holder.translator = createMessagesToChatStreamTranslator(model);
        return holder.translator;
    }
    return createMessagesToChatStreamTranslator(model);
}

export function registerChatMessagesPair(registry: TranslatorRegistry = defaultTranslatorRegistry()): void {
    registry.register(FormatClaude, FormatOpenAI, (model, body, stream) => convertMessagesRequestToChat(model, body, stream), {
        stream: (model, _o, _t, chunk, param) => messagesChatTranslatorOf(param, model)(chunk) as unknown[],
        nonStream: (model, o, t, body) => convertMessagesResponseToChatNonStream(model, o, t, body),
    });
    registry.register(FormatOpenAI, FormatClaude, (model, body, stream) => convertChatRequestToMessages(model, body, stream), {
        stream: (model, _o, _t, chunk, param) => {
            let translator: ReturnType<typeof createChatToMessagesStreamTranslator> | undefined;
            if (param && typeof param === 'object') {
                const holder = param as ChatMessagesStreamHolder;
                if (!holder.translator) holder.translator = createChatToMessagesStreamTranslator(model);
                translator = holder.translator;
            } else {
                translator = createChatToMessagesStreamTranslator(model);
            }
            return translator(chunk) as unknown[];
        },
        nonStream: (model, o, t, body) => convertChatResponseToMessagesNonStream(model, o, t, body),
    });
}

export type { AnthropicStreamEvent };
