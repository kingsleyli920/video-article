import { afterEach, describe, expect, it, vi } from 'vitest';
import { TIMEOUTS } from '../../src/client/api';
import { SUMMARY_TIMING } from '../../src/shared/limits';
import { generateSummaryJson, summaryBudget } from '../../src/worker/summary-model';
import { geminiJson } from '../fixtures/upstream';

afterEach(() => vi.restoreAllMocks());

const OPTIONS = { apiKey: 'k', model: 'primary-model' };
const PROMPT = { system: 's', user: 'u' };
const SUMMARY = { who: '甲', what: '乙', when: '', where: '', why: '', how: '' };

type Behavior = 'hang' | 'ok' | 503 | 400;

/** 按模型名返回预设行为；hang 表示一直不响应，但和真实 fetch 一样在中止时抛出 */
function upstream(byModel: Record<string, Behavior>) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const model = String(input).split('/').pop()!.split(':')[0]!;
    calls.push(model);
    const behavior = byModel[model];
    if (behavior === 'ok') return Promise.resolve(Response.json(geminiJson(SUMMARY)));
    if (behavior === 503) return Promise.resolve(Response.json({ error: { code: 503, message: 'overloaded' } }, { status: 503 }));
    if (behavior === 400) return Promise.resolve(Response.json({ error: { code: 400, message: 'API key not valid.' } }, { status: 400 }));
    return new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)));
  });
  return calls;
}

async function timed<T>(work: Promise<T>) {
  const started = Date.now();
  const result = await work.then(
    (value) => ({ value, error: null }),
    (error: unknown) => ({ value: null, error: error as { code?: string } }),
  );
  return { ...result, ms: Date.now() - started };
}

describe('5W1H 主备模型的总预算', () => {
  // 抓：前端 100 秒超时之前，服务端主备合计可能等满 180 秒，前端只能看到自己的超时
  it('服务端总预算比前端超时至少短 10 秒，主模型上限加最小备用时间不超过总预算，前端用的就是这份常量', () => {
    expect(SUMMARY_TIMING).toEqual({ clientMs: 100_000, serverBudgetMs: 85_000, primaryMs: 50_000, minFallbackMs: 15_000 });
    expect(SUMMARY_TIMING.clientMs - SUMMARY_TIMING.serverBudgetMs).toBeGreaterThanOrEqual(10_000);
    expect(SUMMARY_TIMING.primaryMs + SUMMARY_TIMING.minFallbackMs).toBeLessThanOrEqual(SUMMARY_TIMING.serverBudgetMs);
    expect(TIMEOUTS.summaryMs).toBe(100_000);
    expect(summaryBudget(0.01)).toEqual({ serverBudgetMs: 850, primaryMs: 500, minFallbackMs: 150 });
  });

  // 抓：主模型卡住时一直等，或者换备用模型后又给它一个完整的超时，合计超出总预算
  it('主模型在上限内没有响应时，用剩余预算调用备用模型', async () => {
    const calls = upstream({ 'primary-model': 'hang', 'fallback-model': 'ok' });
    const { value, ms } = await timed(generateSummaryJson(OPTIONS, 'fallback-model', PROMPT, {}, { serverBudgetMs: 600, primaryMs: 200, minFallbackMs: 100 }));
    expect(value?.raw).toEqual(SUMMARY);
    expect(value?.model).toBe('fallback-model');
    expect(calls).toEqual(['primary-model', 'fallback-model']);
    expect(ms).toBeGreaterThanOrEqual(195);
    expect(ms).toBeLessThan(600);
  });

  // 抓：主备都卡住时等待时间超过总预算
  it('主备都没有响应时，在总预算内报 gemini_busy', async () => {
    const calls = upstream({ 'primary-model': 'hang', 'fallback-model': 'hang' });
    const { error, ms } = await timed(generateSummaryJson(OPTIONS, 'fallback-model', PROMPT, {}, { serverBudgetMs: 600, primaryMs: 200, minFallbackMs: 100 }));
    expect(error?.code).toBe('gemini_busy');
    expect(calls).toEqual(['primary-model', 'fallback-model']);
    expect(ms).toBeGreaterThanOrEqual(590);
    expect(ms).toBeLessThan(700);
  });

  // 抓：剩余时间已经不够还去调备用模型，结果超出预算
  it('主模型失败后剩余预算不足最小备用时间时，不再调用备用模型', async () => {
    const calls = upstream({ 'primary-model': 'hang', 'fallback-model': 'ok' });
    const { error, ms } = await timed(generateSummaryJson(OPTIONS, 'fallback-model', PROMPT, {}, { serverBudgetMs: 300, primaryMs: 250, minFallbackMs: 100 }));
    expect(error?.code).toBe('gemini_busy');
    expect(calls).toEqual(['primary-model']);
    expect(ms).toBeLessThan(300);
  });

  // 抓：主模型明确返回繁忙时还等满主模型上限才换
  it('主模型 503（重试一次后仍是 503）时立即换备用模型', async () => {
    const calls = upstream({ 'primary-model': 503, 'fallback-model': 'ok' });
    const { value, ms } = await timed(generateSummaryJson(OPTIONS, 'fallback-model', PROMPT, {}, { serverBudgetMs: 10_000, primaryMs: 8_000, minFallbackMs: 1_000 }));
    expect(value?.raw).toEqual(SUMMARY);
    expect(value?.model).toBe('fallback-model');
    expect(calls).toEqual(['primary-model', 'primary-model', 'fallback-model']);
    expect(ms).toBeLessThan(3_000);
  });

  // 抓：API key 无效之类的配置错误也去换模型，掩盖真实原因
  it('不是繁忙的错误（如 API key 无效）不换备用模型，原样报错', async () => {
    const calls = upstream({ 'primary-model': 400, 'fallback-model': 'ok' });
    const { error } = await timed(generateSummaryJson(OPTIONS, 'fallback-model', PROMPT, {}, summaryBudget(0.01)));
    expect(error).toMatchObject({ code: 'gemini_error', detail: 'API key 无效' });
    expect(calls).toEqual(['primary-model']);
  });

  it('没有配置备用模型时，主模型繁忙直接报 gemini_busy', async () => {
    const calls = upstream({ 'primary-model': 'hang' });
    const { error } = await timed(generateSummaryJson(OPTIONS, null, PROMPT, {}, { serverBudgetMs: 600, primaryMs: 100, minFallbackMs: 100 }));
    expect(error?.code).toBe('gemini_busy');
    expect(calls).toEqual(['primary-model']);
  });
});
