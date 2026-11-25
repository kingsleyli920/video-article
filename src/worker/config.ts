import { AppError } from './app-error';
import type { GeminiOptions } from './gemini';

/** 应用运行配置只来自 Worker 环境：GEMINI_API_KEY 是 secret，模型名和思考强度是 vars。 */
export function geminiOptions(env: Env): GeminiOptions {
  if (!env.GEMINI_API_KEY) throw new AppError('gemini_error', '服务器未配置 GEMINI_API_KEY');
  return {
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL,
    thinkingLevel: env.GEMINI_THINKING_LEVEL || undefined,
  };
}

/**
 * 备用模型：主模型在开始输出之前持续繁忙（503 重试后仍失败，或首个分块超时）时，改用它完成这一次请求。
 * 只在还没有任何输出时切换，不会把两个模型的输出拼成一篇。没配置或和主模型相同时返回 null。
 */
export function fallbackModel(env: Env): string | null {
  const fallback: string = env.GEMINI_FALLBACK_MODEL ?? '';
  const primary: string = env.GEMINI_MODEL;
  return fallback && fallback !== primary ? fallback : null;
}

export const isBusy = (err: unknown) => err instanceof AppError && err.code === 'gemini_busy';
