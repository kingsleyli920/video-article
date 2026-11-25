import { isBusy } from './app-error';
import { generateJson, type FallbackConfig, type GeminiOptions, type GeminiStats, type Prompt } from './gemini';

export interface JsonBudget {
  /** 主备模型合计的上限 */
  serverBudgetMs: number;
  /** 主模型的上限 */
  primaryMs: number;
  /** 主模型失败后，剩余预算至少这么多才换备用模型 */
  minFallbackMs: number;
}

export function scaleBudget(budget: JsonBudget, scale = 1): JsonBudget {
  return { serverBudgetMs: budget.serverBudgetMs * scale, primaryMs: budget.primaryMs * scale, minFallbackMs: budget.minFallbackMs * scale };
}

/**
 * 结构化输出的模型调用，5W1H、内容核对和约束提取共用。主模型最多 primaryMs（含一次 503 重试）；
 * 主模型繁忙或超时、而且总预算还剩至少 minFallbackMs 时，用剩余的预算调用备用模型（用备用模型自己的思考档）。
 * 主备合计不超过 serverBudgetMs。结构化输出一次返回，没有"已输出一半"的问题，所以可以整次换模型。
 * purpose 只用在日志里（<purpose>_fallback），signal 中止时立即取消请求。
 */
export async function generateJsonWithFallback(
  options: GeminiOptions,
  fallback: FallbackConfig | null,
  prompt: Prompt,
  schema: object,
  budget: JsonBudget,
  extra: { purpose?: string; signal?: AbortSignal } = {},
): Promise<{ raw: unknown; model: string; stats: GeminiStats; ms: number }> {
  const startedAt = Date.now();
  const stats: GeminiStats = {};
  try {
    const raw = await generateJson({ ...options, timeouts: { ...options.timeouts, requestMs: budget.primaryMs } }, prompt, schema, stats, extra.signal);
    return { raw, model: options.model, stats, ms: Date.now() - startedAt };
  } catch (err) {
    if (!fallback || !isBusy(err) || extra.signal?.aborted) throw err;
    const remainingMs = budget.serverBudgetMs - (Date.now() - startedAt);
    if (remainingMs < budget.minFallbackMs) throw err;
    console.log(
      JSON.stringify({ event: `${extra.purpose ?? 'summary'}_fallback`, from: options.model, to: fallback.model, thinkingLevel: fallback.thinkingLevel ?? null, reason: err.detail ?? null, remainingMs }),
    );
    const raw = await generateJson(
      { ...options, model: fallback.model, thinkingLevel: fallback.thinkingLevel, timeouts: { ...options.timeouts, requestMs: remainingMs } },
      prompt,
      schema,
      stats,
      extra.signal,
    );
    return { raw, model: fallback.model, stats, ms: Date.now() - startedAt };
  }
}
