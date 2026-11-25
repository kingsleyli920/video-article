import { readSse } from '../shared/sse';
import { AppError } from './app-error';

export interface GeminiOptions {
  apiKey: string;
  model: string;
  /** minimal / low / medium / high，不填用模型默认值 */
  thinkingLevel?: string;
  /** 超时设置，测试时可以调短 */
  timeouts?: Partial<typeof DEFAULT_TIMEOUTS>;
  /** 模型地址前缀，只在测试时指向模拟上游 */
  apiBase?: string;
}

export interface Prompt {
  system: string;
  user: string;
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
}

interface GeminiChunk {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; status?: string; message?: string };
}

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const ARTICLE_MAX_OUTPUT_TOKENS = 32_768;
const SUMMARY_MAX_OUTPUT_TOKENS = 4_096;
const BUSY_RETRY_DELAY_MS = 1_500;

/**
 * 上游卡住时，没有超时会让页面一直停在"等待模型输出"。
 * firstChunkMs：从发请求到收到第一个流式分块；idleMs：两个分块之间；requestMs：非流式请求整体。
 */
const DEFAULT_TIMEOUTS = { firstChunkMs: 120_000, idleMs: 60_000, requestMs: 90_000 };

/** 按倍率缩短的超时设置（倍率只在测试时小于 1） */
export function geminiTimeouts(scale = 1): typeof DEFAULT_TIMEOUTS {
  return { firstChunkMs: DEFAULT_TIMEOUTS.firstChunkMs * scale, idleMs: DEFAULT_TIMEOUTS.idleMs * scale, requestMs: DEFAULT_TIMEOUTS.requestMs * scale };
}

/** 计时到点就中止请求，并记下要抛给调用方的错误。 */
class Watchdog {
  readonly #controller = new AbortController();
  #timer: ReturnType<typeof setTimeout> | null = null;
  reason: AppError | null = null;

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** 外部取消（客户端断开）：中止请求，但不记成超时 */
  cancel(reason: unknown): void {
    this.clear();
    this.#controller.abort(reason);
  }

  arm(ms: number, error: () => AppError): void {
    this.clear();
    this.#timer = setTimeout(() => {
      this.reason = error();
      this.#controller.abort(this.reason);
    }, ms);
  }

  clear(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }
}

/**
 * 流式生成：每收到一段正文就交给 onText（会等它完成，保证下游背压），返回模型给出的 finishReason。
 * 只在还没有任何输出之前对 503 重试一次；开始输出后不重试、不换模型。
 * 收到带 finishReason 的终止事件后，先处理其中的最后一段正文，再停止读取并释放连接，不等 HTTP EOF；
 * 没有终止事件就断流时返回 null（由调用方判为中断）。signal 中止（客户端断开）时立即取消请求并抛出中止原因。
 */
export async function streamText(
  options: GeminiOptions,
  prompt: Prompt,
  onText: (text: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted) throw signal.reason;
  const { firstChunkMs, idleMs } = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  const watchdog = new Watchdog();
  const onCancel = () => watchdog.cancel(signal!.reason);
  signal?.addEventListener('abort', onCancel, { once: true });
  watchdog.arm(firstChunkMs, () => new AppError('gemini_busy', `模型超过 ${firstChunkMs / 1000} 秒没有响应`));
  try {
    const body = payload(options, prompt, { maxOutputTokens: ARTICLE_MAX_OUTPUT_TOKENS });
    const res = await post(options, 'streamGenerateContent?alt=sse', body, watchdog.signal);
    let finishReason: string | null = null;
    for await (const message of readSse(res.body!)) {
      watchdog.clear(); // 等下游写完不算模型空闲
      const chunk = parseChunk(message.data);
      const candidate = chunk.candidates?.[0];
      const text = candidate?.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? '').join('') ?? '';
      if (text) await onText(text);
      if (candidate?.finishReason) {
        finishReason = candidate.finishReason;
        break; // 退出循环会取消响应体读取，连接随之释放
      }
      watchdog.arm(idleMs, () => new AppError('interrupted', `模型超过 ${idleMs / 1000} 秒没有新输出`));
    }
    return finishReason;
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    throw watchdog.reason ?? err;
  } finally {
    watchdog.clear();
    signal?.removeEventListener('abort', onCancel);
  }
}

/** 结构化输出：按 JSON schema 生成并返回解析后的对象（结构校验由调用方负责）。 */
export async function generateJson(options: GeminiOptions, prompt: Prompt, schema: object): Promise<unknown> {
  const { requestMs } = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  const watchdog = new Watchdog();
  watchdog.arm(requestMs, () => new AppError('gemini_busy', `模型超过 ${requestMs / 1000} 秒没有响应`));
  let raw: string;
  try {
    const body = payload(options, prompt, { maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS, responseMimeType: 'application/json', responseJsonSchema: schema });
    raw = await (await post(options, 'generateContent', body, watchdog.signal)).text();
  } catch (err) {
    throw watchdog.reason ?? err;
  } finally {
    watchdog.clear();
  }
  const chunk = parseChunk(raw);
  const candidate = chunk.candidates?.[0];
  if (candidate?.finishReason && candidate.finishReason !== 'STOP') throw new AppError('summary_invalid', candidate.finishReason);
  const text = candidate?.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? '').join('') ?? '';
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('summary_invalid', '不是合法 JSON');
  }
}

function payload(options: GeminiOptions, prompt: Prompt, generationConfig: Record<string, unknown>) {
  return {
    systemInstruction: { parts: [{ text: prompt.system }] },
    contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
    generationConfig: {
      ...generationConfig,
      ...(options.thinkingLevel ? { thinkingConfig: { thinkingLevel: options.thinkingLevel } } : {}),
    },
  };
}

async function post(options: GeminiOptions, method: string, body: object, signal: AbortSignal): Promise<Response> {
  const url = `${options.apiBase ?? API_BASE}/${encodeURIComponent(options.model)}:${method}`;
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey },
    body: JSON.stringify(body),
    signal,
  };
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch {
      throw new AppError('gemini_error', '网络请求失败');
    }
    if (res.ok) return res;
    const error = classifyHttpError(res.status, await res.text());
    if (error.code === 'gemini_busy' && attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_DELAY_MS));
      continue;
    }
    throw error;
  }
}

export function classifyHttpError(status: number, body: string): AppError {
  let message = '';
  try {
    message = (JSON.parse(body) as GeminiChunk).error?.message ?? '';
  } catch {
    // 非 JSON 响应，按状态码归类
  }
  if (/location is not supported/i.test(message)) return new AppError('gemini_region');
  if (status === 429) return new AppError('gemini_quota');
  if (status === 503 || status === 500) return new AppError('gemini_busy', `HTTP ${status}`);
  if (/api key/i.test(message)) return new AppError('gemini_error', 'API key 无效');
  return new AppError('gemini_error', `HTTP ${status}`);
}

function parseChunk(data: string): GeminiChunk {
  let chunk: GeminiChunk;
  try {
    chunk = JSON.parse(data) as GeminiChunk;
  } catch {
    throw new AppError('interrupted', '模型响应格式异常');
  }
  if (chunk.error) throw classifyHttpError(chunk.error.code ?? 500, JSON.stringify({ error: chunk.error }));
  if (chunk.promptFeedback?.blockReason) throw new AppError('blocked', chunk.promptFeedback.blockReason);
  return chunk;
}
