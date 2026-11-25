import { ERROR_MESSAGES, type ErrorCode } from '../shared/errors';
import type { ApiErrorBody } from '../shared/types';

const STATUS: Partial<Record<ErrorCode, number>> = {
  invalid_request: 400,
  invalid_url: 400,
  instructions_too_long: 400,
  body_not_allowed: 400,
  not_found: 404,
  generation_not_found: 404,
  chapter_not_found: 404,
  method_not_allowed: 405,
  transcript_too_long: 413,
  gemini_quota: 429,
  internal: 500,
  gemini_busy: 503,
};

/** 带错误码的业务错误。detail 会拼进给用户看的说明，不能放密钥或内部细节。 */
export class AppError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, detail?: string) {
    super(detail ? `${ERROR_MESSAGES[code]}（${detail}）` : ERROR_MESSAGES[code]);
    this.code = code;
  }

  get status(): number {
    return STATUS[this.code] ?? 502;
  }
}

export function toAppError(err: unknown): AppError {
  return err instanceof AppError ? err : new AppError('internal');
}

export function errorResponse(err: AppError): Response {
  const body: ApiErrorBody = { error: { code: err.code, message: err.message } };
  return Response.json(body, { status: err.status });
}
