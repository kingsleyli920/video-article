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
  /** 输出上限（含思考 token），不填用默认值 */
  maxOutputTokens?: number;
}

export interface Prompt {
  system: string;
  user: string;
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
}

/** 用量字段按 Gemini 返回原样记录，缺失的字段保持缺失（不当成 0） */
export interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
  serviceTier?: string;
}

/** 一次调用的统计：调用方传入空对象，调用过程中填写。只从已经收到的数据里取，不为它多等连接关闭 */
export interface GeminiStats {
  usage?: GeminiUsage;
  modelVersion?: string;
  /** 响应头 x-gemini-service-tier（Priority 降级时会显示 standard） */
  serviceTierHeader?: string | null;
}

interface GeminiChunk {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  usageMetadata?: GeminiUsage;
  modelVersion?: string;
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; status?: string; message?: string };
}

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
// 思考 token 也计入输出上限（官方文档），高档思考时过低的上限会截断；按官方建议至少 65,536
/** 备用模型和它自己的思考档（见 config.ts 的 fallbackConfig） */
export interface FallbackConfig {
  model: string;
  thinkingLevel?: string;
}

const ARTICLE_MAX_OUTPUT_TOKENS = 65_536;
const SUMMARY_MAX_OUTPUT_TOKENS = 65_536;
const BUSY_RETRY_DELAY_MS = 1_500;

/**
 * 上游卡住时，没有超时会让页面一直停在"等待模型输出"。
 * firstChunkMs：从发请求到收到第一个流式分块；idleMs：两个分块之间；requestMs：非流式请求整体。
 * firstChunkMs 取 180 秒：高档思考时模型先想完再出字，第八轮实测 gemini-4-hydrogen + high 首个正文 51 秒、80 秒
 * （gemini-4-neon + high 112 秒、143 秒），120 秒余量不够；主模型超时后备用模型约 50 秒写完，合计仍远低于前端 10 分钟总时限。
 * 开始出字后分块间隔都在 1 秒以内，idleMs 不变。
 */
const DEFAULT_TIMEOUTS = { firstChunkMs: 180_000, idleMs: 60_000, requestMs: 90_000 };

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
  stats: GeminiStats = {},
): Promise<string | null> {
  if (signal?.aborted) throw signal.reason;
  const { firstChunkMs, idleMs } = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  const watchdog = new Watchdog();
  const onCancel = () => watchdog.cancel(signal!.reason);
  signal?.addEventListener('abort', onCancel, { once: true });
  watchdog.arm(firstChunkMs, () => new AppError('gemini_busy', `模型超过 ${firstChunkMs / 1000} 秒没有响应`));
  try {
    const body = payload(options, prompt, { maxOutputTokens: options.maxOutputTokens ?? ARTICLE_MAX_OUTPUT_TOKENS });
    const res = await post(options, 'streamGenerateContent?alt=sse', body, watchdog.signal);
    stats.serviceTierHeader = res.headers.get('x-gemini-service-tier');
    let finishReason: string | null = null;
    for await (const message of readSse(res.body!)) {
      watchdog.clear(); // 等下游写完不算模型空闲
      const chunk = parseChunk(message.data);
      if (chunk.usageMetadata) stats.usage = chunk.usageMetadata;
      if (chunk.modelVersion) stats.modelVersion = chunk.modelVersion;
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
export async function generateJson(options: GeminiOptions, prompt: Prompt, schema: object, stats: GeminiStats = {}): Promise<unknown> {
  const { requestMs } = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  const watchdog = new Watchdog();
  watchdog.arm(requestMs, () => new AppError('gemini_busy', `模型超过 ${requestMs / 1000} 秒没有响应`));
  let raw: string;
  try {
    const body = payload(options, prompt, {
      maxOutputTokens: options.maxOutputTokens ?? SUMMARY_MAX_OUTPUT_TOKENS,
      responseMimeType: 'application/json',
      responseJsonSchema: schema,
    });
    const res = await post(options, 'generateContent', body, watchdog.signal);
    stats.serviceTierHeader = res.headers.get('x-gemini-service-tier');
    raw = await res.text();
  } catch (err) {
    throw watchdog.reason ?? err;
  } finally {
    watchdog.clear();
  }
  const chunk = parseChunk(raw);
  if (chunk.usageMetadata) stats.usage = chunk.usageMetadata;
  if (chunk.modelVersion) stats.modelVersion = chunk.modelVersion;
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
  // 预付额度用完（2026-11-25 实际遇到：HTTP 402，"Your prepayment credits are depleted"）。不是繁忙：不重试、不换备用模型，
  // 同一账单下换模型也一样会被拒，换了只会掩盖原因
  if (status === 402 || /prepayment credits are depleted/i.test(message)) return new AppError('gemini_billing');
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
