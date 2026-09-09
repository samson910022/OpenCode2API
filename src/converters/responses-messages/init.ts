/**
 * responses <-> messages directed-pair registration (P4: text-core streams both ways).
 */

import { FormatClaude, FormatOpenAIResponse } from '../formats.js';
import type { TranslatorRegistry } from '../registry.js';
import { defaultTranslatorRegistry } from '../registry.js';
import type { StreamHolder } from '../holder.js';
import { holderTranslatorOf } from '../holder.js';
import { convertMessagesRequestToResponses, convertResponsesRequestToMessages } from './request.js';
import {
    convertMessagesResponseToResponsesNonStream,
    convertResponsesResponseToMessagesNonStream,
    createMessagesToResponsesStreamTranslator,
    createResponsesToMessagesStreamTranslator,
} from './response.js';

export interface ResponsesMessagesStreamHolder extends StreamHolder<ReturnType<typeof createResponsesToMessagesStreamTranslator>> {}

export interface MessagesResponsesStreamHolder extends StreamHolder<ReturnType<typeof createMessagesToResponsesStreamTranslator>> {}

function responsesMessagesTranslatorOf(param: unknown, model: string): ReturnType<typeof createResponsesToMessagesStreamTranslator> {
    return holderTranslatorOf(param, model, (m) => createResponsesToMessagesStreamTranslator(m));
}

function messagesResponsesTranslatorOf(param: unknown, model: string): ReturnType<typeof createMessagesToResponsesStreamTranslator> {
    return holderTranslatorOf(param, model, (m) => createMessagesToResponsesStreamTranslator(m));
}

export function registerResponsesMessagesPair(registry: TranslatorRegistry = defaultTranslatorRegistry()): void {
    registry.register(FormatOpenAIResponse, FormatClaude, (model, body, stream) => convertResponsesRequestToMessages(model, body, stream), {
        stream: (model, _o, _t, chunk, param) => responsesMessagesTranslatorOf(param, model)(chunk) as unknown[],
        nonStream: (model, o, t, body) => convertResponsesResponseToMessagesNonStream(model, o, t, body),
    });
    registry.register(FormatClaude, FormatOpenAIResponse, (model, body, stream) => convertMessagesRequestToResponses(model, body, stream), {
        stream: (model, _o, _t, chunk, param) => messagesResponsesTranslatorOf(param, model)(chunk) as unknown[],
        nonStream: (model, o, t, body) => convertMessagesResponseToResponsesNonStream(model, o, t, body),
    });
}
