// HTTP error classification and protocol-shaped error bodies for request/body-parser errors.
import { asRecord } from '../utils/guards.js';

export interface AnthropicHttpErrorBody {
  type: 'error';
  error: {
    type: 'invalid_request_error' | 'api_error';
    message: string;
    code?: string;
  };
}

export interface OpenAiHttpErrorBody {
  error: {
    message: string;
    type: 'invalid_request_error' | 'server_error';
    code?: string;
  };
}

export interface ClassifiedHttpError {
  status: number;
  statusCode: number;
  body: AnthropicHttpErrorBody | OpenAiHttpErrorBody;
}

export function isAnthropicMessagesPath(path?: string): boolean {
  if (!path || typeof path !== 'string') return false;
  const normalized = (path.split('?')[0]?.replace(/\/+$/, '') ?? '').toLowerCase();
  return normalized === '/v1/messages';
}

/**
 * Pure HTTP error classifier.
 * Maps body-parser and request-level errors to safe HTTP statuses and protocol-shaped bodies.
 * NEVER echoes err.body, err.message, stack traces, internal class names, or filesystem paths.
 */
export function classifyHttpError(err: unknown, path?: string): ClassifiedHttpError {
  const record = asRecord(err);
  const rawType = record['type'];
  const errType = typeof rawType === 'string' ? rawType : '';
  const rawStatus = record['status'] ?? record['statusCode'];
  const statusNum =
    typeof rawStatus === 'number'
      ? rawStatus
      : typeof rawStatus === 'string'
        ? Number(rawStatus)
        : null;
  const isSyntaxError = err instanceof SyntaxError || record['name'] === 'SyntaxError';

  let status: number;
  let message: string;
  let code: string | undefined;

  if (errType === 'entity.parse.failed' || isSyntaxError || (statusNum === 400 && 'body' in record)) {
    status = 400;
    message = 'Malformed JSON in request body';
    code = 'invalid_json';
  } else if (errType === 'entity.too.large' || statusNum === 413) {
    status = 413;
    message = 'Request body exceeds the maximum permitted size';
    code = 'entity_too_large';
  } else if (errType === 'media.type.unsupported') {
    status = 415;
    message = 'Unsupported or missing Content-Type; expected a JSON media type';
    code = 'unsupported_media_type';
  } else if (errType === 'charset.unsupported' || errType === 'encoding.unsupported' || statusNum === 415) {
    status = 415;
    message = 'Unsupported body encoding or charset';
    code = 'unsupported_media_type';
  } else if (errType === 'entity.verify.failed') {
    status = 400;
    message = 'Request body verification failed';
    code = undefined;
  } else {
    status = 500;
    message = 'Internal server error';
    code = undefined;
  }

  const isAnthropic = isAnthropicMessagesPath(path);
  const errorType = status >= 500
    ? (isAnthropic ? 'api_error' : 'server_error')
    : 'invalid_request_error';
  const body: AnthropicHttpErrorBody | OpenAiHttpErrorBody = isAnthropic
    ? {
        type: 'error',
        error: {
          type: errorType as AnthropicHttpErrorBody['error']['type'],
          message,
          ...(code ? { code } : {}),
        },
      }
    : {
        error: {
          message,
          type: errorType as OpenAiHttpErrorBody['error']['type'],
          ...(code ? { code } : {}),
        },
      };

  return {
    status,
    statusCode: status,
    body,
  };
}
