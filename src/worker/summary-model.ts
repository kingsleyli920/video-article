import { SUMMARY_TIMING } from '../shared/limits';
import { isBusy } from './app-error';
import { generateJson, type GeminiOptions, type Prompt } from './gemini';

export interface SummaryBudget {
  /** 主备模型合计的上限 */
  serverBudgetMs: number;
  /** 主模型的上限 */
  primaryMs: number;
  /** 主模型失败后，剩余预算至少这么多才换备用模型 */
  minFallbackMs: number;
}

/** 按倍率缩短的 5W1H 预算（倍率只在测试时小于 1） */
export function summaryBudget(scale = 1): SummaryBudget {
  return {
    serverBudgetMs: SUMMARY_TIMING.serverBudgetMs * scale,
    primaryMs: SUMMARY_TIMING.primaryMs * scale,
    minFallbackMs: SUMMARY_TIMING.minFallbackMs * scale,
  };
}

/**
 * 5W1H 的模型调用。主模型最多 primaryMs（含一次 503 重试）；主模型繁忙或超时、而且总预算还剩至少 minFallbackMs 时，
 * 用剩余的预算调用备用模型。主备合计不超过 serverBudgetMs，前端因此总能在自己的超时之前收到结果或明确的错误。
 */
export async function generateSummaryJson(
  options: GeminiOptions,
  fallbackModel: string | null,
  prompt: Prompt,
  schema: object,
  budget: SummaryBudget = summaryBudget(),
): Promise<{ raw: unknown; model: string }> {
  const startedAt = Date.now();
  try {
    const raw = await generateJson({ ...options, timeouts: { ...options.timeouts, requestMs: budget.primaryMs } }, prompt, schema);
    return { raw, model: options.model };
  } catch (err) {
    if (!fallbackModel || !isBusy(err)) throw err;
    const remainingMs = budget.serverBudgetMs - (Date.now() - startedAt);
    if (remainingMs < budget.minFallbackMs) throw err;
    console.log(
      JSON.stringify({ event: 'summary_fallback', from: options.model, to: fallbackModel, reason: err.detail ?? null, remainingMs }),
    );
    const raw = await generateJson({ ...options, model: fallbackModel, timeouts: { ...options.timeouts, requestMs: remainingMs } }, prompt, schema);
    return { raw, model: fallbackModel };
  }
}
