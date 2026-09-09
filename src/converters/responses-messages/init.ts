/**
 * responses <-> messages directed-pair registration (P4: text-core streams both ways).
 */

import { FormatClaude, FormatOpenAIResponse } from '../formats.js';
import type { TranslatorRegistry } from '../registry.js';
import { defaultTranslatorRegistry } from '../registry.js';
import { convertMessagesRequestToResponses, convertResponsesRequestToMessages } from './request.js';
import {
    convertMessagesResponseToResponsesNonStream,
    convertResponsesResponseToMessagesNonStream,
    createMessagesToResponsesStreamTranslator,
    createResponsesToMessagesStreamTranslator,
} from './response.js';

export interface ResponsesMessagesStreamHolder {
    translator?: ReturnType<typeof createResponsesToMessagesStreamTranslator>;
}

export interface MessagesResponsesStreamHolder {
    translator?: ReturnType<typeof createMessagesToResponsesStreamTranslator>;
}

function responsesMessagesTranslatorOf(param: unknown, model: string): ReturnType<typeof createResponsesToMessagesStreamTranslator> {
    if (param && typeof param === 'object') {
        const holder = param as ResponsesMessagesStreamHolder;
        if (!holder.translator) holder.translator = createResponsesToMessagesStreamTranslator(model);
        return holder.translator;
    }
    return createResponsesToMessagesStreamTranslator(model);
}

function messagesResponsesTranslatorOf(param: unknown, model: string): ReturnType<typeof createMessagesToResponsesStreamTranslator> {
    if (param && typeof param === 'object') {
        const holder = param as MessagesResponsesStreamHolder;
        if (!holder.translator) holder.translator = createMessagesToResponsesStreamTranslator(model);
        return holder.translator;
    }
    return createMessagesToResponsesStreamTranslator(model);
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
