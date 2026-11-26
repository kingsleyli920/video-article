/**
 * L3 收尾阶段：真实 wrangler dev + 模拟上游，只经 HTTP 入口。
 * 覆盖"核对出修订 → 保存最终版本 → 5W1H 用最终版本"、"超字数 → 整篇修订 → 完成"、核对时客户端断开、核对超时。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS } from '../../src/shared/limits';
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
    // 整篇复核返回同一个问题，章内已改过：旧 quote 定位不到，替换文字已在文章里，记为 covered，不调合并处理
    expect(done.review).toEqual({
      sections: 2,
      revisions: 1,
      rewritten: null,
      checks: [],
      unapplied: [
        {
          stage: 'article',
          disposition: 'covered',
          type: 'quantity',
          quote: '大约有1200项。',
          replacement: '大约有一千多项（字幕此处数字不清）。',
          problem: '字幕里的数字不完整，不能确定是 1200',
          evidence: "we're tracking on the order of",
          note: '这一处已由另一条修订改成相同的文字',
        },
      ],
    });
    expect(done.numberWarnings).toEqual([]);
    expect(ofKind(await stack.requests(), 'reconcile')).toHaveLength(0);

    // 两章加整篇复核；默认字幕里没有语气词表里的说法，不发语气核对
    expect(ofKind(await stack.requests(), 'tone')).toHaveLength(0);
    const reviews = ofKind(await stack.requests(), 'review');
    expect(reviews.map((r) => r.model)).toEqual(['mock-primary', 'mock-primary', 'mock-primary']);
    expect(reviews.map((r) => promptOf(r).user.includes('<section>\n## 第二章：数字'))).toEqual([false, true, false]);
    expect(promptOf(reviews[2]!).system).toContain('整篇文章的语义限定复核');
    expect(promptOf(reviews[2]!).user).toContain(`<section>\n${ARTICLE_MARKDOWN}\n</section>`);
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
  it.each([
    ['不是 JSON', { kind: 'invalid' as const }],
    ['缺少 issues', { kind: 'response' as const, result: {} }],
    ['issues 不是数组', { kind: 'response' as const, result: { issues: {} } }],
  ])('核对响应%s：经 HTTP 发 review_failed，不发 done，也不保存', async (_name, behavior) => {
    await stack.scenario({ reviews: { 'mock-primary': behavior, 'mock-fallback': behavior } });
    const gen = await generate(stack, { url: MOCK_URL });
    // SSE 已经开始，HTTP 状态仍为 200；失败必须以 error 事件结束，不能误报 done。
    expect(gen.status).toBe(200);
    expect(gen.contentType).toContain('text/event-stream');
    expect(deltaText(gen.events)).toBe(ARTICLE_MARKDOWN);
    expect(gen.events.at(-1)).toMatchObject({ event: 'error', data: { code: 'review_failed', partial: true } });
    expect(eventOf(gen.events, 'done')).toBeUndefined();
    expect(eventOf(gen.events, 'revised')).toBeUndefined();
    const reviews = ofKind(await stack.requests(), 'review');
    expect(reviews.some((r) => r.model === 'mock-primary')).toBe(true);
    // 格式无效不属于可重试的繁忙/超时；直接失败，不把无效结果当成没有问题。
    expect(reviews.every((r) => r.model === 'mock-primary')).toBe(true);

    await stack.reset();
    const summary = await summarize(stack, eventOf(gen.events, 'meta')!.generationId, '1');
    expect(summary.status).toBe(404);
    expect(summary.body).toEqual(NOT_FOUND);
    expect(ofKind(await stack.requests(), 'summary')).toHaveLength(0);
  });

  it('重写稿超过全局长度上限：经 HTTP 报 article_too_long，5W1H 查不到未保存的上下文', async () => {
    const oversized = `# 标题\n\n## 一\n\n${'a'.repeat(LIMITS.articleChars)}\n\n## 二\n\n正文。\n\n## 三\n\n正文。`;
    await stack.scenario({
      requirements: { 'mock-primary': { kind: 'ok', result: { ...NONE, chaptersMin: 3, chaptersMax: 3, chaptersQuote: '分三章' } } },
      rewrites: { 'mock-primary': { kind: 'ok', texts: [oversized], intervalMs: 0 } },
    });
    const gen = await generate(stack, { url: MOCK_URL, instructions: '分三章写' });
    expect(gen.events.at(-1)).toEqual({ event: 'error', data: { code: 'article_too_long', message: '文章超过长度上限，已停止生成', partial: true } });
    expect(eventOf(gen.events, 'done')).toBeUndefined();
    expect(eventOf(gen.events, 'revised')).toBeUndefined();
    expect(ofKind(await stack.requests(), 'review')).toHaveLength(0);
    expect(ofKind(await stack.requests(), 'tone')).toHaveLength(0);

    await stack.reset();
    const summary = await summarize(stack, eventOf(gen.events, 'meta')!.generationId, '1');
    expect(summary.status).toBe(404);
    expect(summary.body).toEqual(NOT_FOUND);
  });

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
      // 等两章和整篇复核三个请求都到了上游再断开
      await waitFor(async () => (ofKind(await stack.requests(), 'review').length === 3 ? true : null), 2_000, '三个核对请求到达上游');
    } finally {
      controller.abort();
    }
    expect(generationId).toMatch(/^[0-9a-f]{64}$/);

    const reviews = await waitFor(
      async () => {
        const list = ofKind(await stack.requests(), 'review');
        return list.length === 3 && list.every((r) => r.durationMs !== null) ? list : null;
      },
      3_000,
      '核对请求的连接关闭',
    );
    expect(reviews.map((r) => r.aborted)).toEqual([true, true, true]);
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
        return list.length >= 4 && list.every((r) => r.durationMs !== null) ? list : null;
      },
      3_000,
      '核对请求的连接全部关闭',
    );
    // 两章和整篇复核并行：主模型各超时后换备用，任一路超时都会让整次失败
    expect(reviews.filter((r) => r.model === 'mock-primary').map((r) => r.aborted)).toEqual([true, true, true]);
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

describe('重叠修订的合并处理（审查方反例）', () => {
  const EVIDENCE = "Host: Our pilot cost about 20 dollars. This is my estimate, not the guest's statement.";
  const FINAL = '# 试点\n\n## 费用\n\n主持人估计，试点费用约为20美元。';

  // 抓：经真实 HTTP 时整篇建议因句子已被逐章改过而丢掉，保存的文章"嘉宾表示，试点费用约为20美元。"归属仍错；
  // 合并请求没有发到上游或被当成核对请求；5W1H 用的不是最终文章
  it('逐章改数字、整篇改归属：最终文章是"主持人估计…"，5W1H 上游请求里的章节与之一致', async () => {
    await stack.scenario({
      videos: { mockvideo01: { kind: 'ok', title: 'Pilot cost', channel: '测试频道', description: '', cues: [[0, "Host: Our pilot cost about 20 dollars. This is my estimate, not the guest's statement."]] } },
      streams: { 'mock-primary': { kind: 'ok', texts: ['# 试点\n\n## 费用\n\n', '嘉宾表示，试点费用为200美元。'], intervalMs: 20 } },
      reviews: {
        'mock-primary': {
          kind: 'ok',
          issues: [{ type: 'quantity', quote: '试点费用为200美元。', evidence: EVIDENCE, problem: '金额是约 20 美元', replacement: '试点费用约为20美元。' }],
          fidelityIssues: [{ type: 'attribution', quote: '嘉宾表示，试点费用为200美元。', evidence: EVIDENCE, problem: '这是主持人的估计，不是嘉宾的说法', replacement: '主持人估计，试点费用约为20美元。' }],
        },
      },
      reconciles: {
        'mock-primary': {
          kind: 'response',
          result: { items: [{ index: 0, status: 'revise', note: '数字已改对，归属仍错', quote: '嘉宾表示，试点费用约为20美元。', replacement: '主持人估计，试点费用约为20美元。', evidence: '' }] },
        },
      },
    });
    const gen = await generate(stack, { url: MOCK_URL });

    expect(gen.events.map((e) => e.event)).toEqual(['stage', 'meta', 'stage', 'delta', 'delta', 'stage', 'revised', 'done']);
    expect(eventOf(gen.events, 'revised')!.markdown).toBe(FINAL);
    const done = eventOf(gen.events, 'done')!;
    expect(done.review.revisions).toBe(2);
    expect(done.review.unapplied).toEqual([
      { stage: 'article', disposition: 'superseded', type: 'attribution', quote: '嘉宾表示，试点费用为200美元。', replacement: '主持人估计，试点费用约为20美元。', problem: '这是主持人的估计，不是嘉宾的说法', evidence: EVIDENCE, note: '数字已改对，归属仍错' },
    ]);
    const reconciles = ofKind(await stack.requests(), 'reconcile');
    expect(reconciles.map((r) => r.model)).toEqual(['mock-primary']);
    expect(promptOf(reconciles[0]!).user).toContain('<article>\n# 试点\n\n## 费用\n\n嘉宾表示，试点费用约为20美元。\n</article>');
    expect(ofKind(await stack.requests(), 'review')).toHaveLength(2);
    // 字幕里 "about 20 dollars" 是一条语气片段：另发一次语气核对（默认全部 kept）
    expect(ofKind(await stack.requests(), 'tone')).toHaveLength(1);
    expect(done.review.toneExcerpts).toBe(1);

    await stack.reset();
    const summary = await summarize(stack, eventOf(gen.events, 'meta')!.generationId, '1');
    expect(summary.status).toBe(200);
    const user = promptOf(ofKind(await stack.requests(), 'summary')[0]!).user;
    expect(user).toContain('<current_chapter id="1">\n## 费用\n\n主持人估计，试点费用约为20美元。\n</current_chapter>');
    expect(user).not.toContain('嘉宾表示');
  });

  const pilotScenario = (reconcile: { kind: 'response'; result: unknown } | { kind: 'sequence'; results: unknown[] }) => ({
    videos: { mockvideo01: { kind: 'ok' as const, title: 'Pilot cost', channel: '测试频道', description: '', cues: [[0, "Host: Our pilot cost about 20 dollars. This is my estimate, not the guest's statement."]] as [number, string][] } },
    streams: { 'mock-primary': { kind: 'ok' as const, texts: ['# 试点\n\n## 费用\n\n', '嘉宾表示，试点费用为200美元。'], intervalMs: 20 } },
    reviews: {
      'mock-primary': {
        kind: 'ok' as const,
        issues: [{ type: 'quantity', quote: '试点费用为200美元。', evidence: EVIDENCE, problem: '金额是约 20 美元', replacement: '试点费用约为20美元。' }],
        fidelityIssues: [{ type: 'attribution', quote: '嘉宾表示，试点费用为200美元。', evidence: EVIDENCE, problem: '这是主持人的估计，不是嘉宾的说法', replacement: '主持人估计，试点费用约为20美元。' }],
      },
    },
    reconciles: { 'mock-primary': reconcile },
  });
  /** quote 在当前文章里找不到的修订 */
  const UNFOUND = { items: [{ index: 0, status: 'revise', note: '还要改', quote: '主持人表示，试点费用约为20美元。', replacement: '主持人估计，试点费用约为20美元。', evidence: '' }] };

  // 抓：经真实 HTTP 时合并处理两轮都给不出能落实的修订，归属仍错的文章照样 done 并保存、5W1H 可用
  it('合并修订两轮都落实不了：error review_failed，合并请求 2 次，随后 5W1H 返回 generation_not_found', async () => {
    await stack.scenario(pilotScenario({ kind: 'response', result: UNFOUND }));
    const gen = await generate(stack, { url: MOCK_URL });

    expect(gen.events.map((e) => e.event)).toEqual(['stage', 'meta', 'stage', 'delta', 'delta', 'stage', 'error']);
    expect(gen.events.at(-1)!.data).toEqual({
      code: 'review_failed',
      message: '内容核对没有完成，这次生成没有保存（重叠修订建议的合并处理没有完成：有 1 条建议指出的问题仍未落实（quote_not_found））',
      partial: true,
    });
    const reconciles = ofKind(await stack.requests(), 'reconcile');
    expect(reconciles.map((r) => r.model)).toEqual(['mock-primary', 'mock-primary']);
    expect(promptOf(reconciles[1]!).user).toContain('"previousAttempt": "上一次给出的 quote 在 <article> 里找不到：必须从当前的 <article> 逐字复制"');

    await stack.reset();
    const summary = await summarize(stack, eventOf(gen.events, 'meta')!.generationId, '1');
    expect(summary.status).toBe(404);
    expect(summary.body).toEqual(NOT_FOUND);
    expect(ofKind(await stack.requests(), 'summary')).toHaveLength(0);
  });

  // 抓：经真实 HTTP 时第一轮落实不了就失败，没有带着原因再处理一轮；或者没采用第二轮的有效修订
  it('合并修订第一轮落实不了、第二轮有效：done，最终文章是"主持人估计…"，5W1H 用它', async () => {
    await stack.scenario(
      pilotScenario({
        kind: 'sequence',
        results: [UNFOUND, { items: [{ index: 0, status: 'revise', note: '数字已改对，归属仍错', quote: '嘉宾表示，试点费用约为20美元。', replacement: '主持人估计，试点费用约为20美元。', evidence: '' }] }],
      }),
    );
    const gen = await generate(stack, { url: MOCK_URL });
    expect(gen.events.at(-1)!.event).toBe('done');
    expect(eventOf(gen.events, 'revised')!.markdown).toBe(FINAL);
    expect(ofKind(await stack.requests(), 'reconcile')).toHaveLength(2);

    await stack.reset();
    const summary = await summarize(stack, eventOf(gen.events, 'meta')!.generationId, '1');
    expect(summary.status).toBe(200);
    expect(promptOf(ofKind(await stack.requests(), 'summary')[0]!).user).toContain('<current_chapter id="1">\n## 费用\n\n主持人估计，试点费用约为20美元。\n</current_chapter>');
  });
});

describe('语气清单核对', () => {
  const STIPEND = 'And this seems to store the stipends for workers at a temple some few thousand years ago.';
  const DRAFT = '# 泥板\n\n## 用途\n\n该图表包含行和列，用来记录当时神庙工人的津贴。';
  const FINAL = '# 泥板\n\n## 用途\n\n该图表包含行和列，似乎用来记录当时神庙工人的津贴。';
  const SEEMS = { type: 'unsupported' as const, quote: '用来记录当时神庙工人的津贴', replacement: '似乎用来记录当时神庙工人的津贴', evidence: STIPEND, problem: '原话是 seems to，是推测' };
  const stipendScenario = {
    videos: { mockvideo01: { kind: 'ok' as const, title: 'Clay tablets', channel: '测试频道', description: '', cues: [[0, STIPEND]] as [number, string][] } },
    streams: { 'mock-primary': { kind: 'ok' as const, texts: ['# 泥板\n\n## 用途\n\n', '该图表包含行和列，用来记录当时神庙工人的津贴。'], intervalMs: 20 } },
  };

  // 抓：经真实 HTTP 时语气核对请求没发到上游或被当成普通核对；它的修订没进最终文章；5W1H 用的不是最终文章
  it('只有语气核对查出"似乎"被去掉：revised 补回"似乎"，5W1H 上游请求里的章节与之一致', async () => {
    await stack.scenario({ ...stipendScenario, tones: { 'mock-primary': { kind: 'ok', drops: [{ match: 'seems to store', ...SEEMS }] } } });
    const gen = await generate(stack, { url: MOCK_URL });

    expect(gen.events.map((e) => e.event)).toEqual(['stage', 'meta', 'stage', 'delta', 'delta', 'stage', 'revised', 'done']);
    expect(deltaText(gen.events)).toBe(DRAFT);
    expect(eventOf(gen.events, 'revised')).toEqual({ markdown: FINAL, revisions: [{ type: 'unsupported', before: SEEMS.quote, after: SEEMS.replacement, reason: SEEMS.problem, evidence: STIPEND }] });
    expect(eventOf(gen.events, 'done')!.review).toEqual({ sections: 1, toneExcerpts: 1, revisions: 1, rewritten: null, checks: [] });

    const requests = await stack.requests();
    // 一章 + 整篇两次核对；语气一次，带编号 1 的片段和整篇初稿，不带整段字幕
    expect(ofKind(requests, 'review')).toHaveLength(2);
    const tones = ofKind(requests, 'tone');
    expect(tones.map((r) => r.model)).toEqual(['mock-primary']);
    expect(promptOf(tones[0]!).user).toContain(`\n1. [seems to / some few] ${STIPEND}\n`);
    expect(promptOf(tones[0]!).user).toContain(`<section>\n${DRAFT}\n</section>`);
    expect(promptOf(tones[0]!).user).not.toContain('<transcript>');

    await stack.reset();
    const summary = await summarize(stack, eventOf(gen.events, 'meta')!.generationId, '1');
    expect(summary.status).toBe(200);
    const user = promptOf(ofKind(await stack.requests(), 'summary')[0]!).user;
    expect(user).toContain('<current_chapter id="1">\n## 用途\n\n该图表包含行和列，似乎用来记录当时神庙工人的津贴。\n</current_chapter>');
  });

  // 抓（真实反例，经真实 HTTP）：整篇复核和语气核对都补"似乎"，最终稿叠成"似乎似乎用来记录…"
  it('整篇复核和语气核对给出相同的"似乎"：最终稿只有一个"似乎"，语气那条记 covered，不调合并处理', async () => {
    await stack.scenario({
      ...stipendScenario,
      reviews: { 'mock-primary': { kind: 'ok', issues: [], fidelityIssues: [SEEMS] } },
      tones: { 'mock-primary': { kind: 'ok', drops: [{ match: 'seems to store', ...SEEMS }] } },
    });
    const gen = await generate(stack, { url: MOCK_URL });

    expect(eventOf(gen.events, 'revised')!.markdown).toBe(FINAL);
    const done = eventOf(gen.events, 'done')!;
    expect(done.review.revisions).toBe(1);
    expect(done.review.unapplied).toEqual([{ stage: 'tone', disposition: 'covered', ...SEEMS, note: '这一处已由另一条修订改成相同的文字' }]);
    expect(ofKind(await stack.requests(), 'reconcile')).toHaveLength(0);

    await stack.reset();
    const summary = await summarize(stack, eventOf(gen.events, 'meta')!.generationId, '1');
    expect(promptOf(ofKind(await stack.requests(), 'summary')[0]!).user).toContain('<current_chapter id="1">\n## 用途\n\n该图表包含行和列，似乎用来记录当时神庙工人的津贴。\n</current_chapter>');
    expect(summary.status).toBe(200);
  });

  // 抓：经真实 HTTP 时语气核对返回空清单被当成"没有问题"，没核对完的文章被保存、5W1H 可用
  it('语气核对响应缺条目：review_failed，不保存', async () => {
    await stack.scenario({ ...stipendScenario, tones: { 'mock-primary': { kind: 'response', result: { checks: [] } } } });
    const gen = await generate(stack, { url: MOCK_URL });
    expect(gen.events.at(-1)).toEqual({
      event: 'error',
      data: { code: 'review_failed', message: '内容核对没有完成，这次生成没有保存（对照字幕核对没有完成：模型返回的格式无效（语气清单核对没有对每一条给出结论））', partial: true },
    });
    expect(eventOf(gen.events, 'done')).toBeUndefined();
    await stack.reset();
    const summary = await summarize(stack, eventOf(gen.events, 'meta')!.generationId, '1');
    expect(summary.status).toBe(404);
    expect(summary.body).toEqual(NOT_FOUND);
  });
});

describe('约束提取确认不了', () => {
  // 抓：经真实 HTTP 时提取返回 {}（字段全缺）被当成"用户没提约束"，文章照样保存、5W1H 可用
  it('三次都返回 {}：error requirements_unconfirmed，约束提取 3 次，随后取 5W1H 返回 generation_not_found', async () => {
    await stack.scenario({ requirements: { 'mock-primary': { kind: 'ok', result: {} } } });
    const gen = await generate(stack, { url: MOCK_URL, instructions: '不超过1500字' });

    expect(gen.events.map((e) => e.event)).toEqual(['stage', 'meta', 'stage', 'delta', 'delta', 'delta', 'error']);
    expect(gen.events.at(-1)!.data).toEqual({
      code: 'requirements_unconfirmed',
      message: '没能确认生成要求里的字数、章节等硬性约束，这次生成没有保存，请换一种说法重试（提取了 3 次，模型返回的格式都无效）',
      partial: true,
    });
    const requests = await stack.requests();
    expect(ofKind(requests, 'requirements').map((r) => r.model)).toEqual(['mock-primary', 'mock-primary', 'mock-primary']);
    expect(ofKind(requests, 'review')).toHaveLength(0);
    expect(ofKind(requests, 'tone')).toHaveLength(0);

    await stack.reset();
    const summary = await summarize(stack, eventOf(gen.events, 'meta')!.generationId, '1');
    expect(summary.status).toBe(404);
    expect(summary.body).toEqual(NOT_FOUND);
    expect(ofKind(await stack.requests(), 'summary')).toHaveLength(0);
  });

  // 抓：第二次提取正确时仍按第一次（没有约束）执行，68 字的初稿没有按 50 字上限修订
  it('第一次 {}、第二次正确：按 50 字上限修订后完成', async () => {
    await stack.scenario({
      requirements: { 'mock-primary': { kind: 'sequence', results: [{}, { ...NONE, maxChars: 50, charsQuote: '不超过 50 字' }] } },
      rewrites: { 'mock-primary': { kind: 'ok', texts: [SHORT], intervalMs: 0 } },
    });
    const gen = await generate(stack, { url: MOCK_URL, instructions: '全文不超过 50 字' });
    expect(gen.events.at(-1)!.event).toBe('done');
    expect(eventOf(gen.events, 'revised')!.markdown).toBe(SHORT);
    expect(eventOf(gen.events, 'done')!.review.checks).toEqual(['全文 46 字，上限 50 字']);
    expect(ofKind(await stack.requests(), 'requirements')).toHaveLength(2);
  });
});

