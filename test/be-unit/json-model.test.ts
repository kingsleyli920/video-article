import { afterEach, describe, expect, it, vi } from 'vitest';
import { REQUIREMENTS_TIMING, REVIEW_TIMING } from '../../src/shared/limits';
import { ClientGone } from '../../src/worker/event-stream';
import { generateJsonWithFallback, scaleBudget } from '../../src/worker/json-model';
import { geminiJson } from '../fixtures/upstream';

afterEach(() => vi.restoreAllMocks());

const OPTIONS = { apiKey: 'k', model: 'primary-model', thinkingLevel: 'high' };
const FALLBACK = { model: 'fallback-model', thinkingLevel: 'low' };
const PROMPT = { system: '你是事实核对编辑。', user: '<section>\n## 柏林岁月\n</section>' };
const ISSUES = { issues: [] };

type Behavior = 'hang' | 'ok';

/** 按模型名返回预设行为；hang 一直不响应，但和真实 fetch 一样在中止时抛出中止原因 */
function upstream(byModel: Record<string, Behavior>) {
  const calls: { model: string; signal: AbortSignal; thinkingConfig: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const model = String(input).split('/').pop()!.split(':')[0]!;
    calls.push({ model, signal: init!.signal!, thinkingConfig: JSON.parse(String(init!.body)).generationConfig.thinkingConfig });
    if (byModel[model] === 'ok') return Promise.resolve(Response.json(geminiJson(ISSUES)));
    return new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)));
  });
  return calls;
}

describe('generateJsonWithFallback：取消', () => {
  // 抓：客户端已经离开还去发核对请求，白白消耗额度
  it('signal 已经中止：不发请求，直接抛出中止原因', async () => {
    const calls = upstream({ 'primary-model': 'ok' });
    const client = new AbortController();
    const gone = new ClientGone('disconnected');
    client.abort(gone);
    await expect(generateJsonWithFallback(OPTIONS, FALLBACK, PROMPT, {}, scaleBudget(REVIEW_TIMING), { purpose: 'review', signal: client.signal })).rejects.toBe(gone);
    expect(calls).toHaveLength(0);
  });

  // 抓：等待主模型期间客户端断开，服务端还等满主模型上限，或者把取消当成繁忙去换备用模型
  it('等待主模型时取消：立即结束，取消传到上游请求，不换备用模型', async () => {
    const calls = upstream({ 'primary-model': 'hang', 'fallback-model': 'ok' });
    const client = new AbortController();
    const gone = new ClientGone('disconnected');
    const work = generateJsonWithFallback(OPTIONS, FALLBACK, PROMPT, {}, { serverBudgetMs: 10_000, primaryMs: 5_000, minFallbackMs: 1_000 }, { purpose: 'review', signal: client.signal });
    const outcome = work.then(
      () => 'resolved',
      (err: unknown) => err,
    );
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const abortedAt = Date.now();
    client.abort(gone);
    expect(await outcome).toBe(gone);
    expect(Date.now() - abortedAt).toBeLessThan(100);
    expect(calls.map((c) => [c.model, c.signal.aborted])).toEqual([['primary-model', true]]);
  });

  // 抓：主模型超时换到备用模型之后，取消不再传给备用模型的请求
  it('等待备用模型时取消：备用请求也被中止，立即结束', async () => {
    const calls = upstream({ 'primary-model': 'hang', 'fallback-model': 'hang' });
    const client = new AbortController();
    const gone = new ClientGone('disconnected');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const outcome = generateJsonWithFallback(OPTIONS, FALLBACK, PROMPT, {}, { serverBudgetMs: 5_000, primaryMs: 50, minFallbackMs: 100 }, { purpose: 'review', signal: client.signal }).then(
      () => 'resolved',
      (err: unknown) => err,
    );
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    const abortedAt = Date.now();
    client.abort(gone);
    expect(await outcome).toBe(gone);
    expect(Date.now() - abortedAt).toBeLessThan(100);
    expect(calls.map((c) => [c.model, c.signal.aborted])).toEqual([
      ['primary-model', true],
      ['fallback-model', true],
    ]);
  });
});

describe('generateJsonWithFallback：备用模型和日志', () => {
  // 抓：核对、约束提取换备用模型时日志都记成 summary_fallback，线上分不清是哪一步在降级
  it.each([
    ['review', 'review_fallback'],
    ['requirements', 'requirements_fallback'],
    [undefined, 'summary_fallback'],
  ])('purpose=%s：日志事件名是 %s，备用请求用备用模型自己的思考档', async (purpose, event) => {
    const calls = upstream({ 'primary-model': 'hang', 'fallback-model': 'ok' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await generateJsonWithFallback(OPTIONS, FALLBACK, PROMPT, {}, { serverBudgetMs: 2_000, primaryMs: 50, minFallbackMs: 100 }, purpose ? { purpose } : {});
    expect(result.raw).toEqual(ISSUES);
    expect(result.model).toBe('fallback-model');
    expect(calls.map((c) => [c.model, c.thinkingConfig])).toEqual([
      ['primary-model', { thinkingLevel: 'high' }],
      ['fallback-model', { thinkingLevel: 'low' }],
    ]);
    const entries = log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(entries).toEqual([
      { event, from: 'primary-model', to: 'fallback-model', thinkingLevel: 'low', reason: '模型超过 0.05 秒没有响应', remainingMs: expect.any(Number) },
    ]);
  });
});

describe('scaleBudget', () => {
  // 抓：测试环境的倍率没有作用到某一项，L3 的核对超时要等满线上的 150 秒
  it('三项按同一倍率缩短，只返回预算字段', () => {
    expect(scaleBudget(REVIEW_TIMING, 0.5)).toEqual({ serverBudgetMs: 105_000, primaryMs: 75_000, minFallbackMs: 10_000 });
    expect(scaleBudget(REQUIREMENTS_TIMING)).toEqual({ serverBudgetMs: 50_000, primaryMs: 30_000, minFallbackMs: 10_000 });
  });
});
