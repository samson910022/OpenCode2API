/**
 * chat <-> responses directed-pair registration.
 *
 * Mirrors CLIProxyAPI `internal/translator/openai/openai/responses/init.go`
 * (`Register(OpenaiResponse, OpenAI, request, {Stream, NonStream})`) plus the
 * symmetric chat->responses request pair (no Go counterpart). Stream state is
 * carried in `param` (mirrors Go `param *any`), holding one
 * `createChatToResponsesStreamTranslator` per stream.
 */

import { FormatOpenAI, FormatOpenAIResponse } from '../formats.js';
import type { TranslatorRegistry } from '../registry.js';
import { defaultTranslatorRegistry } from '../registry.js';
import type { StreamHolder } from '../holder.js';
import { holderTranslatorOf } from '../holder.js';
import { convertChatRequestToResponses, convertResponsesRequestToChat } from './request.js';
import {
    convertChatResponseToResponsesNonStream,
    convertResponsesResponseToChatNonStream,
    createChatToResponsesStreamTranslator,
    createResponsesToChatStreamTranslator,
} from './response.js';

type StreamState = ReturnType<typeof createChatToResponsesStreamTranslator>;

/**
 * Holder contract (mirrors Go `param *any`): callers MUST pass the same
 * object as `param` for every chunk of one stream; the translator instance
 * is cached on it. Passing no holder (undefined/null/primitive) translates
 * each call as an independent single-chunk stream — correct for non-stream
 * tests but NOT for multi-chunk streams.
 */
export interface ChatResponsesStreamHolder extends StreamHolder<StreamState> {}

export interface ResponsesChatStreamHolder extends StreamHolder<ReturnType<typeof createResponsesToChatStreamTranslator>> {}

function responsesStreamStateOf(param: unknown, model: string): ReturnType<typeof createResponsesToChatStreamTranslator> {
    return holderTranslatorOf(param, model, (m) => createResponsesToChatStreamTranslator(m));
}

function streamStateOf(param: unknown, model: string): StreamState {
    return holderTranslatorOf(param, model, (m) => createChatToResponsesStreamTranslator(m));
}

export function registerChatResponsesPair(registry: TranslatorRegistry = defaultTranslatorRegistry()): void {
    // responses.request -> chat.request (Go: ConvertOpenAIResponsesRequestToOpenAIChatCompletions)
    // + the symmetric inverse chat.request -> responses.request (no Go
    // counterpart; Go chat->chat is identity). Both directions are registered
    // so cross-API session continuation works either way; responses->chat
    // stays the fidelity-critical path ported line-by-line.
    registry.register(FormatOpenAIResponse, FormatOpenAI, (model, body, stream) => convertResponsesRequestToChat(model, body, stream), {
        // responses.response -> chat.response (text-core + tool-args inverse)
        stream: (model, o, t, chunk, param) => responsesStreamStateOf(param, model)(chunk) as unknown[],
        nonStream: (model, o, t, body) => convertResponsesResponseToChatNonStream(model, o, t, body),
    });
    // chat.request -> responses.request (symmetric inverse)
    registry.register(FormatOpenAI, FormatOpenAIResponse, (model, body, stream) => convertChatRequestToResponses(model, body, stream), {
        // chat.response -> responses.response (Go: ConvertOpenAIChatCompletionsResponseToOpenAIResponses*)
        stream: (model, o, t, chunk, param) => streamStateOf(param, model)(chunk) as unknown[],
        nonStream: (model, o, t, body) => convertChatResponseToResponsesNonStream(model, o, t, body),
    });
}
