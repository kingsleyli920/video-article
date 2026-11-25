/**
 * L3 5W1H 的时间预算和备用模型（TIMEOUT_SCALE=0.05）：主模型上限 2.5 秒、主备合计 4.25 秒、
 * 剩余不足 0.75 秒不换备用；503 重试间隔 1.5 秒（不缩放）。另测格式无效和同章并发合并。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eventOf, generate, ofKind, summarize, waitFor } from './api';
import { MOCK_SUMMARY_NORMALIZED, MOCK_URL } from './expected';
import { startStack, type Stack } from './stack';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({ worker: 8798, upstream: 8799 });
});
afterAll(async () => {
  await stack?.stop();
});
beforeEach(async () => {
  await stack.reset();
});

/** 用默认场景生成并保存一篇文章，清空请求记录后返回 generationId */
async function savedGeneration(): Promise<string> {
  const gen = await generate(stack, { url: MOCK_URL });
  expect(gen.events.at(-1)!.event).toBe('done');
  await stack.reset();
  return eventOf(gen.events, 'meta')!.generationId;
}

/** 备用模型的 5W1H，和主模型的不同，能分辨实际是谁给的结果 */
const FALLBACK_SUMMARY = { who: '备用模型', what: '备用总结', when: '本期', where: '', why: '主模型不可用', how: '换模型' };
const FALLBACK_SUMMARY_NORMALIZED = { who: '备用模型', what: '备用总结', when: '本期', where: null, why: '主模型不可用', how: '换模型' };

/** 所有 5W1H 上游请求都结束（响应完或连接断开）后返回 */
const settledSummaryRequests = () =>
  waitFor(
    async () => {
      const requests = ofKind(await stack.requests(), 'summary');
      return requests.every((r) => r.durationMs !== null) ? requests : null;
    },
    3_000,
    '5W1H 上游请求全部结束',
  );

describe('5W1H 的时间预算和备用模型', () => {
  // 抓：主模型不响应时一直等下去；主模型超时后不换备用；没有在 2.5 秒时中止主模型请求；备用模型的结果没被采用
  it('主模型不响应、备用正常：约 2.5 秒时中止主模型并改用备用，返回备用模型的结果', async () => {
    const generationId = await savedGeneration();
    await stack.scenario({ summaries: { 'mock-primary': { kind: 'hang' }, 'mock-fallback': { kind: 'ok', summary: FALLBACK_SUMMARY } } });

    const res = await summarize(stack, generationId, '1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chapterId: '1', cached: false, summary: FALLBACK_SUMMARY_NORMALIZED });
    expect(res.elapsedMs).toBeGreaterThanOrEqual(2_450);
    expect(res.elapsedMs).toBeLessThan(4_250);

    const requests = await settledSummaryRequests();
    expect(requests.map((r) => [r.model, r.aborted])).toEqual([
      ['mock-primary', true],
      ['mock-fallback', false],
    ]);
    expect(requests[0]!.durationMs!).toBeGreaterThanOrEqual(2_400);
    expect(requests[0]!.durationMs!).toBeLessThan(3_000);
  });

  // 抓：主备两次调用各自计时、合计超过总预算（前端会先超时）；超时后不报繁忙；失败结果被缓存
  it('主备模型都不响应：总耗时不超过约 4.25 秒，返回 503 gemini_busy，两个请求都被中止，失败不缓存', async () => {
    const generationId = await savedGeneration();
    await stack.scenario({ summaries: { 'mock-primary': { kind: 'hang' }, 'mock-fallback': { kind: 'hang' } } });

    const res = await summarize(stack, generationId, '1');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: { code: 'gemini_busy', message: expect.stringMatching(/^Gemini 模型繁忙，请稍后重试（模型超过 1\.[5-7]\d* 秒没有响应）$/) },
    });
    expect(res.elapsedMs).toBeGreaterThanOrEqual(4_000);
    expect(res.elapsedMs).toBeLessThan(5_000);

    const requests = await settledSummaryRequests();
    expect(requests.map((r) => [r.model, r.aborted])).toEqual([
      ['mock-primary', true],
      ['mock-fallback', true],
    ]);

    // 失败没有缓存：上游恢复后同一章重新生成
    await stack.reset();
    const retry = await summarize(stack, generationId, '1');
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ chapterId: '1', cached: false, summary: MOCK_SUMMARY_NORMALIZED });
    expect(ofKind(await stack.requests(), 'summary')).toHaveLength(1);
  });

  // 抓：主模型 503 时把主模型的时间额度耗完才换备用，或者不重试直接换、不换直接报错
  it('主模型 503（重试一次仍 503）：约 1.5 秒后立即换备用，不等满主模型的 2.5 秒', async () => {
    const generationId = await savedGeneration();
    await stack.scenario({ summaries: { 'mock-primary': { kind: 'busy' }, 'mock-fallback': { kind: 'ok', summary: FALLBACK_SUMMARY } } });

    const res = await summarize(stack, generationId, '2');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chapterId: '2', cached: false, summary: FALLBACK_SUMMARY_NORMALIZED });
    expect(res.elapsedMs).toBeGreaterThanOrEqual(1_450);
    expect(res.elapsedMs).toBeLessThan(2_400);
    expect(ofKind(await stack.requests(), 'summary').map((r) => r.model)).toEqual(['mock-primary', 'mock-primary', 'mock-fallback']);
  });

  // 抓：模型返回非 JSON 时报 500 或把坏结果存下；格式错误被当成繁忙去调用备用模型
  it('主模型返回的不是 JSON：502 summary_invalid，不换备用，不缓存', async () => {
    const generationId = await savedGeneration();
    await stack.scenario({ summaries: { 'mock-primary': { kind: 'invalid' }, 'mock-fallback': { kind: 'ok', summary: FALLBACK_SUMMARY } } });

    const res = await summarize(stack, generationId, '1');
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: { code: 'summary_invalid', message: '模型返回的总结格式无效，请重试（不是合法 JSON）' } });
    expect(ofKind(await stack.requests(), 'summary').map((r) => r.model)).toEqual(['mock-primary']);

    await stack.reset();
    const retry = await summarize(stack, generationId, '1');
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ chapterId: '1', cached: false, summary: MOCK_SUMMARY_NORMALIZED });
  });
});

describe('同一章的并发请求', () => {
  // 抓：并发请求各自缓存未命中、重复调用模型（多花额度，且可能存下不同的结果）
  it('同一章并发 3 个请求：上游只收到一次，3 个响应相同且都是 cached:false；之后再请求命中缓存', async () => {
    const generationId = await savedGeneration();
    await stack.scenario({ summaries: { 'mock-primary': { kind: 'ok', summary: { ...FALLBACK_SUMMARY, who: '并发测试' }, delayMs: 800 } } });

    const results = await Promise.all([summarize(stack, generationId, '1'), summarize(stack, generationId, '1'), summarize(stack, generationId, '1')]);
    const expected = { chapterId: '1', cached: false, summary: { ...FALLBACK_SUMMARY_NORMALIZED, who: '并发测试' } };
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(results.map((r) => r.body)).toEqual([expected, expected, expected]);
    expect(ofKind(await stack.requests(), 'summary')).toHaveLength(1);

    const later = await summarize(stack, generationId, '1');
    expect(later.body).toEqual({ ...expected, cached: true });
    expect(ofKind(await stack.requests(), 'summary')).toHaveLength(1);
  });
});
