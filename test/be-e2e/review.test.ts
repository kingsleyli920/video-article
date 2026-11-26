/**
 * L3 收尾阶段：真实 wrangler dev + 模拟上游，只经 HTTP 入口。
 * 覆盖"核对出修订 → 保存最终版本 → 5W1H 用最终版本"、"超字数 → 整篇修订 → 完成"、核对时客户端断开、核对超时。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readSse } from '../../src/shared/sse';
import { deltaText, eventOf, generate, ofKind, promptOf, sleep, summarize, waitFor } from './api';
import { ARTICLE_MARKDOWN, MOCK_URL, TRANSCRIPT_TEXT } from './expected';
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

/** 字幕里"order of,200"的数字是残缺的，文章却写成了确定的 1200 */
const NUMBER_ISSUE = {
  type: 'quantity',
  quote: '大约有1200项。',
  evidence: "we're tracking on the order of",
  problem: '字幕里的数字不完整，不能确定是 1200',
  replacement: '大约有一千多项（字幕此处数字不清）。',
};

/** 默认文章采用 NUMBER_ISSUE 之后：68 - 9（"大约有1200项。"）+ 18 = 77 字 */
const REVIEWED =
  '# 对话测试嘉宾：受控上游\n\n## 第一章：开场\n\n**主持人:** 我们从哪里开始？\n\n**嘉宾:** 从第一个问题开始。\n\n## 第二章：数字\n\n**主持人:** 有多少项？\n\n**嘉宾:** 大约有一千多项（字幕此处数字不清）。';

/** 压缩到 46 字的修订稿：标题 11 + "第一章：开场"6 +（3 + 9）+ "第二章：数字"6 +（3 + 8） */
const SHORT = '# 对话测试嘉宾：受控上游\n\n## 第一章：开场\n\n**嘉宾:** 从第一个问题开始。\n\n## 第二章：数字\n\n**嘉宾:** 大约有一千多项。';

const NONE = { maxChars: 0, minChars: 0, charsQuote: '', chaptersMin: 0, chaptersMax: 0, chaptersQuote: '', sectionsPerChapter: 0, sectionTitles: [], sectionsQuote: '' };
const NOT_FOUND = { error: { code: 'generation_not_found', message: '这次生成已过期或不存在，请重新生成' } };

describe('核对出修订', () => {
  // 抓：经真实 HTTP 时 revised 没发出或发的是初稿；保存和 5W1H 用的还是初稿；数字提示按初稿算（修订后已经没有 1200）
  it('第二章的残缺数字被修订：revised 是最终全文，保存的就是它，5W1H 用修订后的句子', async () => {
    await stack.scenario({ reviews: { 'mock-primary': { kind: 'ok', issues: [NUMBER_ISSUE] } } });
    const gen = await generate(stack, { url: MOCK_URL });

    expect(gen.events.map((e) => e.event)).toEqual(['stage', 'meta', 'stage', 'delta', 'delta', 'delta', 'stage', 'revised', 'done']);
    expect(deltaText(gen.events)).toBe(ARTICLE_MARKDOWN);
    expect(eventOf(gen.events, 'revised')).toEqual({
      markdown: REVIEWED,
      revisions: [
        { type: 'quantity', before: '大约有1200项。', after: '大约有一千多项（字幕此处数字不清）。', reason: '字幕里的数字不完整，不能确定是 1200', evidence: "we're tracking on the order of" },
      ],
    });
    const done = eventOf(gen.events, 'done')!;
    expect(done.chars).toBe(77);
    expect(done.review).toEqual({ sections: 2, revisions: 1, rewritten: null, checks: [] });
    expect(done.numberWarnings).toEqual([]);

    // 两章各一个核对请求，只有第二章的那个拿到了问题（模拟上游按 <section> 分发）
    const reviews = ofKind(await stack.requests(), 'review');
    expect(reviews.map((r) => r.model)).toEqual(['mock-primary', 'mock-primary']);
    expect(reviews.map((r) => promptOf(r).user.includes('<section>\n## 第二章：数字'))).toEqual([false, true]);
    for (const r of reviews) expect(promptOf(r).user).toContain(`<transcript>\n${TRANSCRIPT_TEXT}\n</transcript>`);

    await stack.reset();
    const summary = await summarize(stack, eventOf(gen.events, 'meta')!.generationId, '2');
    expect(summary.status).toBe(200);
    const user = promptOf(ofKind(await stack.requests(), 'summary')[0]!).user;
    expect(user).toContain('<current_chapter id="2">\n## 第二章：数字\n\n**主持人:** 有多少项？\n\n**嘉宾:** 大约有一千多项（字幕此处数字不清）。\n</current_chapter>');
    expect(user).not.toContain('大约有1200项');
  });
});

describe('超字数 → 修订 → 完成', () => {
  // 抓：经真实 HTTP 时没进修订阶段；修订请求没发或发给了别的模型；最终保存的不是修订稿
  it('"全文不超过 50 字"而初稿 68 字：revising，一次修订请求，保存 46 字的修订稿', async () => {
    await stack.scenario({
      requirements: { 'mock-primary': { kind: 'ok', result: { ...NONE, maxChars: 50, charsQuote: '不超过 50 字' } } },
      rewrites: { 'mock-primary': { kind: 'ok', texts: [SHORT.slice(0, 25), SHORT.slice(25)], intervalMs: 20 } },
    });
    const gen = await generate(stack, { url: MOCK_URL, instructions: '全文不超过 50 字' });

    expect(gen.events.map((e) => e.event)).toEqual(['stage', 'meta', 'stage', 'delta', 'delta', 'delta', 'stage', 'stage', 'revised', 'done']);
    expect(gen.events.filter((e) => e.event === 'stage').map((e) => e.data)).toEqual([{ stage: 'transcript' }, { stage: 'generating' }, { stage: 'revising' }, { stage: 'reviewing' }]);
    expect(eventOf(gen.events, 'revised')).toEqual({ markdown: SHORT, revisions: [] });
    const done = eventOf(gen.events, 'done')!;
    expect(done.chars).toBe(46);
    expect(done.review).toEqual({ sections: 2, revisions: 0, rewritten: { unmet: ['全文 68 字，要求不超过 50 字'], charsBefore: 68, charsAfter: 46 }, checks: ['全文 46 字，上限 50 字'] });

    const requests = await stack.requests();
    const [requirements] = ofKind(requests, 'requirements');
    expect(promptOf(requirements!).generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });
    const rewrites = ofKind(requests, 'rewrite');
    expect(rewrites.map((r) => [r.model, r.path])).toEqual([['mock-primary', '/gemini/mock-primary:streamGenerateContent?alt=sse']]);
    expect(promptOf(rewrites[0]!).user).toContain('\n- 全文 68 字，要求不超过 50 字\n</unmet_requirements>');

    await stack.reset();
    const summary = await summarize(stack, eventOf(gen.events, 'meta')!.generationId, '2');
    expect(summary.status).toBe(200);
    expect(promptOf(ofKind(await stack.requests(), 'summary')[0]!).user).toContain('<current_chapter id="2">\n## 第二章：数字\n\n**嘉宾:** 大约有一千多项。\n</current_chapter>');
  });
});

describe('核对阶段的失败和断开', () => {
  // 抓：核对进行中用户关掉页面，核对请求没被取消（白白消耗额度），核对结束后文章照样被保存
  it('核对进行中中止 fetch：上游的核对请求被中止，该生成不保存', async () => {
    // 核对 4 秒后才返回"没有问题"；如果没被取消，结束后会正常保存
    await stack.scenario({ reviews: { 'mock-primary': { kind: 'ok', issues: [], delayMs: 4_000 } } });
    const started = Date.now();
    const controller = new AbortController();
    const res = await fetch(`${stack.url}/api/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: MOCK_URL }),
      signal: controller.signal,
    });
    let generationId = '';
    try {
      for await (const message of readSse(res.body!)) {
        if (message.event === 'meta') generationId = (JSON.parse(message.data) as { generationId: string }).generationId;
        if (message.event === 'stage' && message.data.includes('reviewing')) break;
      }
      // 等两个核对请求都到了上游再断开
      await waitFor(async () => (ofKind(await stack.requests(), 'review').length === 2 ? true : null), 2_000, '两个核对请求到达上游');
    } finally {
      controller.abort();
    }
    expect(generationId).toMatch(/^[0-9a-f]{64}$/);

    const reviews = await waitFor(
      async () => {
        const list = ofKind(await stack.requests(), 'review');
        return list.length === 2 && list.every((r) => r.durationMs !== null) ? list : null;
      },
      3_000,
      '核对请求的连接关闭',
    );
    expect(reviews.map((r) => r.aborted)).toEqual([true, true]);
    expect(reviews.every((r) => r.durationMs! < 3_500)).toBe(true);

    // 等到核对本该返回之后再查，排除"只是还没来得及保存"
    await sleep(Math.max(0, 5_000 - (Date.now() - started)));
    await stack.reset();
    const summary = await summarize(stack, generationId, '1');
    expect(summary.status).toBe(404);
    expect(summary.body).toEqual(NOT_FOUND);
  });

  // 抓：核对的上游一直不响应时永远等下去，或者超时后把没核对过的文章保存了
  it('核对主备模型都不响应：在缩短后的预算内（主模型 7.5 秒、合计 10.5 秒）报 review_failed，不保存', async () => {
    await stack.scenario({ reviews: { 'mock-primary': { kind: 'hang' }, 'mock-fallback': { kind: 'hang' } } });
    const gen = await generate(stack, { url: MOCK_URL });

    expect(gen.events.map((e) => e.event)).toEqual(['stage', 'meta', 'stage', 'delta', 'delta', 'delta', 'stage', 'error']);
    const error = eventOf(gen.events, 'error')!;
    expect(error.code).toBe('review_failed');
    expect(error.partial).toBe(true);
    // 备用模型的超时是剩余预算，不是整数秒
    expect(error.message).toMatch(/^内容核对没有完成，这次生成没有保存（对照字幕核对没有完成：Gemini 模型繁忙，请稍后重试（模型超过 [\d.]+ 秒没有响应））$/);
    expect(gen.elapsedMs).toBeGreaterThanOrEqual(10_400);
    expect(gen.elapsedMs).toBeLessThan(13_000);

    const reviews = await waitFor(
      async () => {
        const list = ofKind(await stack.requests(), 'review');
        return list.length >= 3 && list.every((r) => r.durationMs !== null) ? list : null;
      },
      3_000,
      '核对请求的连接全部关闭',
    );
    // 两章并行：各自主模型 7.5 秒超时后换备用；先超时的那一章让整次失败
    expect(reviews.filter((r) => r.model === 'mock-primary').map((r) => r.aborted)).toEqual([true, true]);
    for (const r of reviews.filter((r) => r.model === 'mock-primary')) {
      expect(r.durationMs!).toBeGreaterThanOrEqual(7_400);
      expect(r.durationMs!).toBeLessThan(8_500);
    }
    expect(reviews.filter((r) => r.model === 'mock-fallback').length).toBeGreaterThanOrEqual(1);
    expect(reviews.filter((r) => r.model === 'mock-fallback').every((r) => r.aborted)).toBe(true);

    await stack.reset();
    const summary = await summarize(stack, eventOf(gen.events, 'meta')!.generationId, '1');
    expect(summary.status).toBe(404);
  });
});
