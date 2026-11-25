import { ERROR_MESSAGES, type ErrorCode } from '../shared/errors';
import { readSse } from '../shared/sse';
import { SUMMARY_TIMING } from '../shared/limits';
import type { ApiErrorBody, StreamEvents, SummaryResponse } from '../shared/types';

export class ApiError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message?: string) {
    super(message ?? ERROR_MESSAGES[code]);
    this.code = code;
  }
}

export type GenerationEvent = { [K in keyof StreamEvents]: { event: K; data: StreamEvents[K] } }[keyof StreamEvents];

/**
 * 浏览器端的等待边界，按真实耗时留余量：
 * - 生成：服务端每 15 秒发一次心跳，45 秒没收到任何字节说明连接已不正常；
 *   整次生成上限 10 分钟（低档思考实测 25–75 秒，gemini-4-hydrogen + high 实测 103–135 秒；
 *   服务端首包超时 180 秒、输出空闲超时 60 秒，主模型首包超时后改用备用模型仍在 10 分钟内）。
 * - 5W1H：服务端主备合计上限 85 秒（SUMMARY_TIMING），浏览器等 100 秒。
 */
export const TIMEOUTS = { generationIdleMs: 45_000, generationTotalMs: 600_000, summaryMs: SUMMARY_TIMING.clientMs };

export interface RequestOptions {
  signal?: AbortSignal;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
}

/** 管理一次请求的中止：外部取消 → cancelled；空闲或总时长超时 → client_timeout。dispose 清理计时器并断开连接。 */
class RequestGuard {
  readonly controller = new AbortController();
  readonly #outer: AbortSignal | undefined;
  readonly #idleMs: number | undefined;
  readonly #onOuterAbort = () => this.controller.abort(new ApiError('cancelled'));
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #totalTimer: ReturnType<typeof setTimeout>;

  constructor(outer: AbortSignal | undefined, idleMs: number | undefined, totalMs: number) {
    this.#outer = outer;
    this.#idleMs = idleMs;
    if (outer?.aborted) this.#onOuterAbort();
    outer?.addEventListener('abort', this.#onOuterAbort, { once: true });
    this.#totalTimer = setTimeout(() => this.controller.abort(new ApiError('client_timeout')), totalMs);
    this.touch();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** 收到数据时调用，重新开始空闲计时 */
  touch(): void {
    if (this.#idleMs === undefined) return;
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.controller.abort(new ApiError('client_timeout')), this.#idleMs);
  }

  /** 中止导致的错误换成对应的 ApiError（取消或超时），其他错误按网络错误处理 */
  error(err: unknown): ApiError {
    const reason: unknown = this.controller.signal.reason;
    if (this.controller.signal.aborted && reason instanceof ApiError) return reason;
    return err instanceof ApiError ? err : new ApiError('network');
  }

  dispose(): void {
    clearTimeout(this.#idleTimer);
    clearTimeout(this.#totalTimer);
    this.#outer?.removeEventListener('abort', this.#onOuterAbort);
    this.controller.abort();
  }
}

/** 发起生成并逐条产出服务端事件。调用方提前结束迭代时，连接和计时器随之清理。 */
export async function* streamGeneration(input: { url: string; instructions: string }, options: RequestOptions = {}): AsyncGenerator<GenerationEvent> {
  const guard = new RequestGuard(options.signal, options.idleTimeoutMs ?? TIMEOUTS.generationIdleMs, options.totalTimeoutMs ?? TIMEOUTS.generationTotalMs);
  try {
    const res = await send('/api/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: guard.signal,
    });
    if (!res.body) throw new ApiError('network');
    guard.touch();
    for await (const message of readSse(res.body, () => guard.touch())) {
      yield { event: message.event, data: JSON.parse(message.data) } as GenerationEvent;
    }
  } catch (err) {
    throw guard.error(err);
  } finally {
    guard.dispose();
  }
}

/** 请求某一章的 5W1H：只带 generationId 和章节 id，没有请求体。 */
export async function requestSummary(generationId: string, chapterId: string, options: RequestOptions = {}): Promise<SummaryResponse> {
  const guard = new RequestGuard(options.signal, undefined, options.totalTimeoutMs ?? TIMEOUTS.summaryMs);
  try {
    const res = await send(`/api/generations/${encodeURIComponent(generationId)}/chapters/${encodeURIComponent(chapterId)}/summary`, {
      method: 'POST',
      signal: guard.signal,
    });
    return (await res.json()) as SummaryResponse;
  } catch (err) {
    throw guard.error(err);
  } finally {
    guard.dispose();
  }
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
