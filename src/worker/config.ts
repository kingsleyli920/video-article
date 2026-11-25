import { AppError } from './app-error';
import { geminiTimeouts, type FallbackConfig, type GeminiOptions } from './gemini';
import { transcriptTimeouts, type TranscriptOptions } from './youtube';

/** 应用运行配置只来自 Worker 环境：GEMINI_API_KEY 是 secret，模型名和思考强度是 vars。 */
export function geminiOptions(env: Env): GeminiOptions {
  if (!env.GEMINI_API_KEY) throw new AppError('gemini_error', '服务器未配置 GEMINI_API_KEY');
  return {
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL,
    thinkingLevel: env.GEMINI_THINKING_LEVEL || undefined,
    timeouts: geminiTimeouts(timeoutScale(env)),
    ...(env.GEMINI_API_BASE ? { apiBase: env.GEMINI_API_BASE } : {}),
  };
}

/** 字幕请求的配置；signal 由调用方补上 */
export function transcriptOptions(env: Env): TranscriptOptions {
  return {
    timeouts: transcriptTimeouts(timeoutScale(env)),
    ...(env.YOUTUBE_PLAYER_URL ? { playerEndpoint: env.YOUTUBE_PLAYER_URL } : {}),
  };
}

/** 超时倍率：只在测试时设置 TIMEOUT_SCALE（0 到 1 之间），其他情况一律按 1 处理 */
export function timeoutScale(env: Env): number {
  const scale = Number(env.TIMEOUT_SCALE ?? 1);
  return Number.isFinite(scale) && scale > 0 && scale <= 1 ? scale : 1;
}

/**
 * 备用模型：主模型在开始输出之前持续繁忙（503 重试后仍失败，或首个分块超时）时，改用它完成这一次请求。
 * 只在还没有任何输出时切换，不会把两个模型的输出拼成一篇。没配置或和主模型相同时返回 null。
 * 备用模型用自己的思考档（GEMINI_FALLBACK_THINKING_LEVEL）：主模型改成 high 之后，备用模型仍按验证过的 low 运行，
 * 不沿用主模型的思考档。
 */
export function fallbackConfig(env: Env): FallbackConfig | null {
  const fallback: string = env.GEMINI_FALLBACK_MODEL ?? '';
  const primary: string = env.GEMINI_MODEL;
  if (!fallback || fallback === primary) return null;
  const thinkingLevel: string = env.GEMINI_FALLBACK_THINKING_LEVEL ?? '';
  return { model: fallback, ...(thinkingLevel ? { thinkingLevel } : {}) };
}
