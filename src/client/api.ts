import { ERROR_MESSAGES, type ErrorCode } from '../shared/errors';
import { readSse } from '../shared/sse';
import type { ApiErrorBody, StreamEvents, SummaryResponse } from '../shared/types';

export class ApiError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message?: string) {
    super(message ?? ERROR_MESSAGES[code]);
    this.code = code;
  }
}

export type GenerationEvent = { [K in keyof StreamEvents]: { event: K; data: StreamEvents[K] } }[keyof StreamEvents];

/** 发起生成并逐条产出服务端事件。连接中途断开时抛出 network 错误。 */
export async function* streamGeneration(input: { url: string; instructions: string }): AsyncGenerator<GenerationEvent> {
  const res = await send('/api/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  if (!res.body) throw new ApiError('network');
  try {
    for await (const message of readSse(res.body)) {
      yield { event: message.event, data: JSON.parse(message.data) } as GenerationEvent;
    }
  } catch (err) {
    throw err instanceof ApiError ? err : new ApiError('network');
  }
}

/** 请求某一章的 5W1H：只带 generationId 和章节 id，没有请求体。 */
export async function requestSummary(generationId: string, chapterId: string): Promise<SummaryResponse> {
  const res = await send(`/api/generations/${encodeURIComponent(generationId)}/chapters/${encodeURIComponent(chapterId)}/summary`, { method: 'POST' });
  return (await res.json()) as SummaryResponse;
}

async function send(url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError('network');
  }
  if (res.ok) return res;
  const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
  throw body?.error ? new ApiError(body.error.code, body.error.message) : new ApiError('internal', `请求失败（HTTP ${res.status}）`);
}
