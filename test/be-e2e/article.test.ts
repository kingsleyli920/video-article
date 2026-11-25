/**
 * L3 文章生成：主模型繁忙或不响应时整篇改用备用模型；已开始输出后出错不换模型；
 * 各种不完整结束都不保存；客户端断开时取消传到上游、不保存。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readSse } from '../../src/shared/sse';
import { deltaText, eventOf, generate, ofKind, promptOf, sleep, summarize, waitFor } from './api';
import { MOCK_URL, TRANSCRIPT_TEXT } from './expected';
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

/** 备用模型写的文章，和主模型的默认文章内容不同，能分辨实际是谁写的 */
const FALLBACK_TEXTS = ['# 备用模型写的文章\n\n## 唯一一章：备用\n\n', '**嘉宾:** 这是备用模型的输出。'];
const FALLBACK_MARKDOWN = '# 备用模型写的文章\n\n## 唯一一章：备用\n\n**嘉宾:** 这是备用模型的输出。';
const FALLBACK_OK = { kind: 'ok' as const, texts: FALLBACK_TEXTS, intervalMs: 20 };

const NOT_FOUND = { error: { code: 'generation_not_found', message: '这次生成已过期或不存在，请重新生成' } };

describe('主模型繁忙或不响应时改用备用模型', () => {
  // 抓：主模型持续 503 时整篇失败、没有先重试一次就换、或者换了模型却仍报主模型；备用模型写的文章没有保存
  it('主模型 503（重试一次仍 503）：整篇由 mock-fallback 写完，done 报实际模型，上下文已保存', async () => {
    await stack.scenario({ streams: { 'mock-primary': { kind: 'busy' }, 'mock-fallback': FALLBACK_OK } });
    const gen = await generate(stack, { url: MOCK_URL });

    expect(gen.events.map((e) => e.event)).toEqual(['stage', 'meta', 'stage', 'delta', 'delta', 'done']);
    expect(eventOf(gen.events, 'meta')!.model).toBe('mock-primary');
    expect(deltaText(gen.events)).toBe(FALLBACK_MARKDOWN);
    expect(eventOf(gen.events, 'done')).toMatchObject({ chapters: [{ id: '1', title: '唯一一章：备用' }], numberWarnings: [], model: 'mock-fallback' });
    // 503 重试间隔 1.5 秒
    expect(gen.elapsedMs).toBeGreaterThanOrEqual(1_450);
    expect(gen.elapsedMs).toBeLessThan(4_000);

    const streams = ofKind(await stack.requests(), 'stream');
    expect(streams.map((r) => r.model)).toEqual(['mock-primary', 'mock-primary', 'mock-fallback']);
    // 备用模型收到的是同一份提示词
    expect(promptOf(streams[2]!).user).toBe(promptOf(streams[0]!).user);
    expect(promptOf(streams[2]!).user).toContain(`<transcript>\n${TRANSCRIPT_TEXT}\n</transcript>`);

    // 保存的是备用模型写的文章：5W1H 能取到，提示词里是备用文章的章节
    await stack.reset();
    const summary = await summarize(stack, eventOf(gen.events, 'meta')!.generationId, '1');
    expect(summary.status).toBe(200);
    expect(promptOf(ofKind(await stack.requests(), 'summary')[0]!).user).toContain(
      '<current_chapter id="1">\n## 唯一一章：备用\n\n**嘉宾:** 这是备用模型的输出。\n</current_chapter>',
    );
  });

  // 抓：主模型一直不给首个分块时永远等下去；超时后没有中止主模型请求；超时后直接报错而不换备用
  it('主模型不响应（首个分块 9 秒超时，线上 180 秒按 0.05 缩短）：中止主模型请求，改用 mock-fallback 写完', async () => {
    await stack.scenario({ streams: { 'mock-primary': { kind: 'hang' }, 'mock-fallback': FALLBACK_OK } });
    const gen = await generate(stack, { url: MOCK_URL });

    expect(gen.events.map((e) => e.event)).toEqual(['stage', 'meta', 'stage', 'delta', 'delta', 'done']);
    expect(deltaText(gen.events)).toBe(FALLBACK_MARKDOWN);
    expect(eventOf(gen.events, 'done')!.model).toBe('mock-fallback');
    expect(gen.elapsedMs).toBeGreaterThanOrEqual(8_950);
    expect(gen.elapsedMs).toBeLessThan(11_000);

    const streams = ofKind(await stack.requests(), 'stream');
    expect(streams.map((r) => [r.model, r.aborted])).toEqual([
      ['mock-primary', true],
      ['mock-fallback', false],
    ]);
    expect(streams[0]!.durationMs!).toBeGreaterThanOrEqual(8_900);
    expect(streams[0]!.durationMs!).toBeLessThan(10_000);
  });

  // 抓：主模型、备用模型都繁忙时没有明确报繁忙，或者对备用模型无限重试
  it('主备模型都 503：报 gemini_busy，partial 为 false，每个模型各请求两次', async () => {
    await stack.scenario({ streams: { 'mock-primary': { kind: 'busy' }, 'mock-fallback': { kind: 'busy' } } });
    const gen = await generate(stack, { url: MOCK_URL });

    expect(gen.events.map((e) => e.event)).toEqual(['stage', 'meta', 'stage', 'error']);
    expect(eventOf(gen.events, 'error')).toEqual({ code: 'gemini_busy', message: 'Gemini 模型繁忙，请稍后重试（HTTP 503）', partial: false });
    expect(ofKind(await stack.requests(), 'stream').map((r) => r.model)).toEqual(['mock-primary', 'mock-primary', 'mock-fallback', 'mock-fallback']);
    expect(gen.elapsedMs).toBeGreaterThanOrEqual(2_950);
    expect(gen.elapsedMs).toBeLessThan(5_000);
  });
});

describe('已开始输出或输出不完整', () => {
  // 抓：主模型写到一半出错后换备用模型重写，两个模型的输出拼成一篇；残缺文章被保存
  it('主模型输出一段后流里出现 503：报 gemini_busy、partial 为 true，不请求备用模型，不保存', async () => {
    await stack.scenario({
      streams: { 'mock-primary': { kind: 'error-after', texts: ['# 标题\n\n## 第一章：残缺\n\n写到一半'], code: 503 }, 'mock-fallback': FALLBACK_OK },
    });
    const gen = await generate(stack, { url: MOCK_URL });

    expect(gen.events.map((e) => e.event)).toEqual(['stage', 'meta', 'stage', 'delta', 'error']);
    expect(deltaText(gen.events)).toBe('# 标题\n\n## 第一章：残缺\n\n写到一半');
    expect(eventOf(gen.events, 'error')).toEqual({ code: 'gemini_busy', message: 'Gemini 模型繁忙，请稍后重试（HTTP 503）', partial: true });
    expect(ofKind(await stack.requests(), 'stream').map((r) => r.model)).toEqual(['mock-primary']);

    await stack.reset();
    const summary = await summarize(stack, eventOf(gen.events, 'meta')!.generationId, '1');
    expect(summary.status).toBe(404);
    expect(summary.body).toEqual(NOT_FOUND);
  });

  // 抓：模型输出到一半停住时一直等下去；空闲超时被当成繁忙去换备用模型（拼接两个模型的输出）；没有中止上游请求
  it('主模型输出一段后超过 3 秒没有新输出：报 interrupted、partial 为 true，中止上游请求，不换模型，不保存', async () => {
    await stack.scenario({
      streams: { 'mock-primary': { kind: 'ok', texts: ['# 标题\n\n## 第一章：停住\n\n写到一半', '永远等不到的下一段'], intervalMs: 3_500 }, 'mock-fallback': FALLBACK_OK },
    });
    const gen = await generate(stack, { url: MOCK_URL });

    expect(gen.events.map((e) => e.event)).toEqual(['stage', 'meta', 'stage', 'delta', 'error']);
    expect(eventOf(gen.events, 'error')).toEqual({ code: 'interrupted', message: '生成中断，文章不完整（模型超过 3 秒没有新输出）', partial: true });
    expect(gen.elapsedMs).toBeGreaterThanOrEqual(2_950);
    expect(gen.elapsedMs).toBeLessThan(3_450);

    const streams = await waitFor(
      async () => {
        const requests = ofKind(await stack.requests(), 'stream');
        return requests.every((r) => r.durationMs !== null) ? requests : null;
      },
      2_000,
      '上游流式请求结束',
    );
    expect(streams.map((r) => [r.model, r.aborted])).toEqual([['mock-primary', true]]);

    await stack.reset();
    const summary = await summarize(stack, eventOf(gen.events, 'meta')!.generationId, '1');
    expect(summary.status).toBe(404);
    expect(summary.body).toEqual(NOT_FOUND);
  });

  // 抓：被截断、没有结束标记或被安全策略拦截的文章仍发 done、保存并开放 5W1H；这类错误被当成繁忙去换备用模型
  it.each([
    ['MAX_TOKENS', 'truncated', '输出达到长度上限，文章不完整'],
    [null, 'interrupted', '生成中断，文章不完整（模型没有给出结束标记）'],
    ['SAFETY', 'blocked', '内容被模型的安全策略拦截，文章不完整（SAFETY）'],
  ])('finishReason=%s：报 %s，partial 为 true，不换模型，不保存', async (finishReason, code, message) => {
    await stack.scenario({
      streams: { 'mock-primary': { kind: 'ok', texts: ['# 对话测试嘉宾：受控上游\n\n## 第一章：开场\n\n', '**嘉宾:** 正文。'], intervalMs: 20, finishReason }, 'mock-fallback': FALLBACK_OK },
    });
    const gen = await generate(stack, { url: MOCK_URL });

    expect(gen.events.map((e) => e.event)).toEqual(['stage', 'meta', 'stage', 'delta', 'delta', 'error']);
    expect(eventOf(gen.events, 'error')).toEqual({ code, message, partial: true });
    expect(ofKind(await stack.requests(), 'stream').map((r) => r.model)).toEqual(['mock-primary']);

    await stack.reset();
    const summary = await summarize(stack, eventOf(gen.events, 'meta')!.generationId, '1');
    expect(summary.status).toBe(404);
    expect(summary.body).toEqual(NOT_FOUND);
  });
});

describe('客户端断开', () => {
  // 抓：用户关掉页面后服务端仍在读模型输出（上游请求没被取消，白白消耗额度），读完后还把文章保存了
  it('读到第一个 delta 后中止 fetch：上游流式请求被中止，该生成不保存', async () => {
    // 10 段、每段间隔 300 毫秒，完整读完约 2.7 秒；如果没被取消，结束后会是一篇结构有效、可以保存的文章
    const texts = ['# 慢速文章\n\n## 第一章：慢\n\n', ...Array.from({ length: 9 }, (_, i) => `第${i + 1}段。`)];
    await stack.scenario({ streams: { 'mock-primary': { kind: 'ok', texts, intervalMs: 300 } } });

    const started = Date.now();
    const controller = new AbortController();
    const res = await fetch(`${stack.url}/api/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: MOCK_URL }),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    let generationId = '';
    let firstDelta = '';
    try {
      for await (const message of readSse(res.body!)) {
        if (message.event === 'meta') generationId = (JSON.parse(message.data) as { generationId: string }).generationId;
        if (message.event === 'delta') {
          firstDelta = (JSON.parse(message.data) as { text: string }).text;
          break;
        }
      }
    } finally {
      controller.abort();
    }
    expect(generationId).toMatch(/^[0-9a-f]{64}$/);
    expect(firstDelta).toBe('# 慢速文章\n\n## 第一章：慢\n\n');

    // 取消传到上游：模拟上游记录到对方在流结束前断开
    const stream = await waitFor(
      async () => ofKind(await stack.requests(), 'stream').find((r) => r.durationMs !== null),
      5_000,
      '上游流式请求的连接关闭',
    );
    expect(stream.aborted).toBe(true);
    expect(stream.durationMs!).toBeLessThan(2_000);

    // 等到完整流本该结束之后再查，排除"只是还没来得及保存"
    await sleep(Math.max(0, 3_500 - (Date.now() - started)));
    await stack.reset();
    const summary = await summarize(stack, generationId, '1');
    expect(summary.status).toBe(404);
    expect(summary.body).toEqual(NOT_FOUND);
  });

  // 抓：上面的用例因为环境原因（例如慢速流本身就保存不了）才得到 404，而不是因为断开
  it('对照：同样的慢速流读完不断开，会正常保存，5W1H 可用', async () => {
    const texts = ['# 慢速文章\n\n## 第一章：慢\n\n', ...Array.from({ length: 9 }, (_, i) => `第${i + 1}段。`)];
    await stack.scenario({ streams: { 'mock-primary': { kind: 'ok', texts, intervalMs: 300 } } });
    const gen = await generate(stack, { url: MOCK_URL });
    expect(gen.events.at(-1)!.event).toBe('done');
    expect(ofKind(await stack.requests(), 'stream').map((r) => r.aborted)).toEqual([false]);

    const summary = await summarize(stack, eventOf(gen.events, 'meta')!.generationId, '1');
    expect(summary.status).toBe(200);
  });

});
