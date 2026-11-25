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
