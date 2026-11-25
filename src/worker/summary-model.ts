import { SUMMARY_TIMING } from '../shared/limits';
import type { FallbackConfig, GeminiOptions, GeminiStats, Prompt } from './gemini';
import { generateJsonWithFallback, type JsonBudget } from './json-model';

export type SummaryBudget = JsonBudget;

/** 按倍率缩短的 5W1H 预算（倍率只在测试时小于 1） */
export function summaryBudget(scale = 1): SummaryBudget {
  return {
    serverBudgetMs: SUMMARY_TIMING.serverBudgetMs * scale,
    primaryMs: SUMMARY_TIMING.primaryMs * scale,
    minFallbackMs: SUMMARY_TIMING.minFallbackMs * scale,
  };
}

/** 5W1H 的模型调用：主备模型共用总预算，见 generateJsonWithFallback。 */
export function generateSummaryJson(
  options: GeminiOptions,
  fallback: FallbackConfig | null,
  prompt: Prompt,
  schema: object,
  budget: SummaryBudget = summaryBudget(),
): Promise<{ raw: unknown; model: string; stats: GeminiStats; ms: number }> {
  return generateJsonWithFallback(options, fallback, prompt, schema, budget, { purpose: 'summary' });
}
