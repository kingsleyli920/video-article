/**
 * L1b 对照字幕核对：经过完整 Worker 和 Durable Object，出站请求全部替身。
 * 覆盖事件序列、核对请求的内容、修订后的保存和 5W1H、各种丢弃、模型失败和客户端断开。
 */
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenerationStore, openStore } from '../../src/worker/store';
import { geminiJson, geminiSse, OTHER_VIDEO_ID, srv1 } from '../fixtures/upstream';
import { billingResponse, busyResponse, eventOf, generate, hangingResponse, mockUpstream } from './helpers';
import { CAPTIONS, DRAFT, DRAFT_STREAM, modelOf, promptOf, REVIEWED, SECTION_1, SECTION_2, TIME_ISSUE, TRANSCRIPT_TEXT, url } from './review-fixtures';

afterEach(() => vi.restoreAllMocks());

const SUMMARY = { who: 'Maria Lopez', what: '搬到柏林，基金投资 Alpha、Beta、Gamma', when: '2003 年起', where: '柏林', why: '', how: '' };

/** 整篇专项仍属于 review 用途，通过 system 区分，而不是完整文章也含有的第一章标题。 */
const isFidelityReview = (body: string) => promptOf(body).system.includes('负责整篇文章的语义限定复核');
/** 第一章的核对返回 TIME_ISSUE，第二章与整篇专项没有问题 */
const firstChapterIssue = (body: string) => geminiJson({ issues: !isFidelityReview(body) && promptOf(body).user.includes('<section>\n# 柏林与基金') ? [TIME_ISSUE] : [] });

describe('对照字幕核对：没有问题', () => {
  it('有效问题列表里只有个别坏建议：拒绝建议，但仍完成并保存原稿', async () => {
    mockUpstream({ captions: CAPTIONS, geminiStream: DRAFT_STREAM, reviewJson: geminiJson({ issues: [{ type: 'opinion' }] }) });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
    expect(eventOf(events, 'error')).toBeUndefined();
    expect(eventOf(events, 'revised')).toBeUndefined();
    expect(eventOf(events, 'done')!.review.revisions).toBe(0);
    expect((await openStore(env, eventOf(events, 'meta')!.generationId).load())!.article.markdown).toBe(DRAFT);
  });

  // 抓：没有核对阶段就保存；没问题时也发 revised；done.review 缺字段；章节或整篇专项请求漏了对应原文、整段字幕
  it('事件里有 reviewing、没有 revised；每章和整篇专项带对应原文及完整字幕', async () => {
    const upstream = mockUpstream({ captions: CAPTIONS, geminiStream: DRAFT_STREAM });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });

    expect(events.map((e) => e.event)).toEqual(['stage', 'meta', 'stage', 'delta', 'delta', 'delta', 'stage', 'done']);
    expect(events[6]!.data).toEqual({ stage: 'reviewing' });
    const done = eventOf(events, 'done')!;
    expect(done.review).toEqual({ sections: 2, revisions: 0, rewritten: null, checks: [] });
    expect(done.chars).toBe(61);
    const { modelDoneMs, reviewedMs, savedMs } = done.timing;
    expect(modelDoneMs).toBeLessThanOrEqual(reviewedMs!);
    expect(reviewedMs!).toBeLessThanOrEqual(savedMs);

    const reviews = upstream.gemini('review');
    expect(reviews).toHaveLength(3);
    expect(reviews.map((r) => modelOf(r.url))).toEqual(['test-model', 'test-model', 'test-model']);
    const chapters = reviews.filter((r) => !isFidelityReview(r.body));
    const fidelity = reviews.filter((r) => isFidelityReview(r.body));
    expect(chapters).toHaveLength(2);
    expect(fidelity).toHaveLength(1);
    const [first, second] = chapters.map((r) => promptOf(r.body).user);
    const whole = promptOf(fidelity[0]!.body).user;
    expect(whole).toContain(`<section>\n${DRAFT}\n</section>`);
    expect(first).toContain(`<section>\n${SECTION_1}\n</section>`);
    expect(second).toContain(`<section>\n${SECTION_2}\n</section>`);
    expect(first).not.toContain('现在有五到六家被投公司');
    expect(second).not.toContain('那家基金投资了');
    for (const user of [first, second, whole]) expect(user).toContain(`<transcript>\n${TRANSCRIPT_TEXT}\n</transcript>`);
    // 核对用主模型和它的思考档
    expect(reviews.map((r) => promptOf(r.body).generationConfig.thinkingConfig)).toEqual([{ thinkingLevel: 'high' }, { thinkingLevel: 'high' }, { thinkingLevel: 'high' }]);

    const saved = await openStore(env, eventOf(events, 'meta')!.generationId).load();
    expect(saved!.article.markdown).toBe(DRAFT);
    expect(saved!.review).toEqual({ sections: 2, revisions: 0, rewritten: null, checks: [], items: [], requirements: { maxChars: null, minChars: null, chaptersMin: null, chaptersMax: null, sectionsPerChapter: null, sectionTitles: [] } });
  });
});

describe('对照字幕核对：有修订', () => {
  // 抓：revised 发的是初稿或缺修订记录；done 的字数和章节按初稿算；保存的是初稿；5W1H 用的还是初稿的句子
  it('revised 带最终全文和修订记录，保存的就是它，随后 5W1H 用修订后的句子', async () => {
    const upstream = mockUpstream({ captions: CAPTIONS, geminiStream: DRAFT_STREAM, reviewJson: firstChapterIssue, geminiJson: geminiJson(SUMMARY) });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });

    expect(events.map((e) => e.event)).toEqual(['stage', 'meta', 'stage', 'delta', 'delta', 'delta', 'stage', 'revised', 'done']);
    // 流式发给页面的仍是初稿
    expect(events.filter((e) => e.event === 'delta').map((e) => (e.data as { text: string }).text).join('')).toBe(DRAFT);
    const revised = eventOf(events, 'revised')!;
    expect(revised).toEqual({
      markdown: REVIEWED,
      revisions: [
        {
          type: 'time',
          before: '2003 年那家基金投资了 Alpha、Beta 和 Gamma。',
          after: '我 2003 年搬到柏林，之后十年里那家基金先后投资了 Alpha、Beta 和 Gamma。',
          reason: '2003 年是嘉宾搬到柏林的时间，不是基金投资的时间',
          evidence: 'I moved to Berlin in 2003. Over the next ten years the fund backed Alpha, Beta and Gamma',
        },
      ],
    });
    const done = eventOf(events, 'done')!;
    expect(done.chars).toBe(74);
    expect(done.chapters).toEqual([
      { id: '1', title: '柏林岁月' },
      { id: '2', title: '现在的组合' },
    ]);
    expect(done.review).toEqual({ sections: 2, revisions: 1, rewritten: null, checks: [] });

    const generationId = eventOf(events, 'meta')!.generationId;
    const saved = await openStore(env, generationId).load();
    expect(saved!.article.markdown).toBe(revised.markdown);
    expect(saved!.article.chapters[0]!.markdown).toBe('**嘉宾:** 我 2003 年搬到柏林，之后十年里那家基金先后投资了 Alpha、Beta 和 Gamma。');
    expect(saved!.review!.draft).toBe(DRAFT);
    expect(saved!.review!.items).toEqual(revised.revisions);

    // 前端取 5W1H 时不带请求体，章节内容只来自服务端保存的最终文章
    const res = await exports.default.fetch(`https://app.test/api/generations/${generationId}/chapters/1/summary`, { method: 'POST' });
    expect(res.status).toBe(200);
    const summaries = upstream.gemini('summary');
    expect(summaries).toHaveLength(1);
    const user = promptOf(summaries[0]!.body).user;
    expect(user).toContain('<current_chapter id="1">\n## 柏林岁月\n\n**嘉宾:** 我 2003 年搬到柏林，之后十年里那家基金先后投资了 Alpha、Beta 和 Gamma。\n</current_chapter>');
    expect(user).not.toContain('2003 年那家基金投资了');
  });

  // 抓：没有字幕依据或定位不唯一的修订也被采用，改坏了文章；被丢弃后没有照常完成
  // 抓：没有字幕依据或定位不唯一的修订也被采用，改坏了文章；被丢弃后没有照常完成；丢弃的建议没有随 done 和保存的上下文留痕；
  // 原本就不在初稿里的 quote 被当成重叠建议送去合并处理（替身没预设合并响应，调用了就会失败）
  it.each([
    ['evidence 不在字幕里', { ...TIME_ISSUE, evidence: 'The fund invested in Alpha, Beta and Gamma back in 2003' }, 'evidence_not_in_transcript'],
    ['quote 在这一章里找不到', { ...TIME_ISSUE, quote: '2004 年那家基金投资了 Alpha、Beta 和 Gamma。' }, 'quote_not_found'],
    ['quote 在这一章里出现两次', { ...TIME_ISSUE, quote: '基金', replacement: '基金会' }, 'quote_not_unique'],
  ])('%s：文章不变，没有 revised，照常 done 并保存初稿，unapplied 记 %s', async (_label, issue, disposition) => {
    const upstream = mockUpstream({ captions: CAPTIONS, geminiStream: DRAFT_STREAM, reviewJson: (body) => geminiJson({ issues: !isFidelityReview(body) && promptOf(body).user.includes('<section>\n# 柏林与基金') ? [issue] : [] }) });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
    expect(events.map((e) => e.event)).toEqual(['stage', 'meta', 'stage', 'delta', 'delta', 'delta', 'stage', 'done']);
    const unapplied = [{ stage: 'chapter', disposition, ...issue }];
    expect(eventOf(events, 'done')!.review).toEqual({ sections: 2, revisions: 0, rewritten: null, checks: [], unapplied });
    const saved = await openStore(env, eventOf(events, 'meta')!.generationId).load();
    expect(saved!.article.markdown).toBe(DRAFT);
    expect(saved!.review).not.toHaveProperty('draft');
    expect(saved!.review!.unapplied).toEqual(unapplied);
    expect(upstream.gemini('reconcile')).toHaveLength(0);
  });
});

describe('对照字幕核对：模型失败', () => {
  it.each([[{}], [{ issues: null }], [{ issues: '没有问题' }]])('核对返回合法 JSON 但整体结构无效（%j）：报错，不保存', async (raw) => {
    mockUpstream({ captions: CAPTIONS, geminiStream: DRAFT_STREAM, reviewJson: geminiJson(raw) });
    const save = vi.spyOn(GenerationStore.prototype, 'save');
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
    expect(events.at(-1)).toEqual({
      event: 'error',
      data: { code: 'review_failed', message: '内容核对没有完成，这次生成没有保存（对照字幕核对没有完成：模型返回的格式无效（核对结果不是有效的问题列表））', partial: true },
    });
    expect(eventOf(events, 'done')).toBeUndefined();
    expect(eventOf(events, 'revised')).toBeUndefined();
    expect(save).not.toHaveBeenCalled();
    expect(await openStore(env, eventOf(events, 'meta')!.generationId).load()).toBeNull();
  });

  it('两章核对成功但整篇专项协议无效：SSE error、无 done/revised，DO 不保存', async () => {
    const successfulChapterSections: string[] = [];
    const upstream = mockUpstream({
      captions: CAPTIONS,
      geminiStream: DRAFT_STREAM,
      geminiOverride: ({ purpose, body }) => {
        if (purpose !== 'review') return undefined;
        if (isFidelityReview(body)) return Response.json(geminiJson({ issues: null }));
        successfulChapterSections.push(promptOf(body).user);
        return Response.json(geminiJson({ issues: [] }));
      },
    });
    const save = vi.spyOn(GenerationStore.prototype, 'save');
    const { status, events } = await generate({ url: url(OTHER_VIDEO_ID) });
    expect(status).toBe(200); // SSE 已开始，失败通过 error 事件返回。
    expect(successfulChapterSections).toHaveLength(2);
    expect(successfulChapterSections[0]).toContain(`<section>\n${SECTION_1}\n</section>`);
    expect(successfulChapterSections[1]).toContain(`<section>\n${SECTION_2}\n</section>`);
    const fidelity = upstream.gemini('review').filter((r) => isFidelityReview(r.body));
    expect(fidelity).toHaveLength(1);
    expect(promptOf(fidelity[0]!.body).user).toContain(`<section>\n${DRAFT}\n</section>`);
    expect(upstream.gemini('review')).toHaveLength(3);
    expect(upstream.gemini('summary')).toHaveLength(0);
    expect(events.at(-1)).toEqual({
      event: 'error',
      data: { code: 'review_failed', message: '内容核对没有完成，这次生成没有保存（对照字幕核对没有完成：模型返回的格式无效（核对结果不是有效的问题列表））', partial: true },
    });
    expect(eventOf(events, 'done')).toBeUndefined();
    expect(eventOf(events, 'revised')).toBeUndefined();
    expect(save).not.toHaveBeenCalled();
    expect(await openStore(env, eventOf(events, 'meta')!.generationId).load()).toBeNull();
  });

  // 抓：核对没做成也保存并发 done，没核对过的文章被当成已完成
  it('核对请求主备模型都 503：error review_failed，partial 为 true，不保存', async () => {
    const upstream = mockUpstream({ captions: CAPTIONS, geminiStream: DRAFT_STREAM, geminiOverride: ({ purpose }) => (purpose === 'review' ? busyResponse() : undefined) });
    const save = vi.spyOn(GenerationStore.prototype, 'save');
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });

    expect(events.at(-1)).toEqual({
      event: 'error',
      data: { code: 'review_failed', message: '内容核对没有完成，这次生成没有保存（对照字幕核对没有完成：Gemini 模型繁忙，请稍后重试（HTTP 503））', partial: true },
    });
    expect(eventOf(events, 'done')).toBeUndefined();
    // 两章加整篇专项：每路主模型请求两次，再换备用。首路失败结束请求上下文时，其他路的第二次备用请求可能尚在重试间隔中。
    const reviews = upstream.gemini('review');
    const models = reviews.map((r) => modelOf(r.url));
    expect(models.filter((m) => m === 'test-model')).toHaveLength(6);
    expect(models.filter((m) => m === 'test-fallback').length).toBeGreaterThanOrEqual(4);
    expect(models.filter((m) => m === 'test-fallback').length).toBeLessThanOrEqual(6);
    expect(models).toHaveLength(models.filter((m) => m === 'test-model' || m === 'test-fallback').length);
    for (const section of [SECTION_1, SECTION_2, DRAFT]) {
      const scope = reviews.filter((r) => promptOf(r.body).user.includes(`<section>\n${section}\n</section>`));
      expect(scope.filter((r) => modelOf(r.url) === 'test-model')).toHaveLength(2);
      expect(scope.filter((r) => modelOf(r.url) === 'test-fallback').length).toBeGreaterThanOrEqual(1);
    }
    expect(save).not.toHaveBeenCalled();
    expect(await openStore(env, eventOf(events, 'meta')!.generationId).load()).toBeNull();
  }, 10_000);

  // 抓：核对返回的不是 JSON 时当成"没有问题"放过去
  it('核对返回的不是 JSON：error review_failed，不保存', async () => {
    const notJson = () => Response.json({ candidates: [{ content: { parts: [{ text: '第一章没有发现问题。' }], role: 'model' }, finishReason: 'STOP' }] });
    mockUpstream({ captions: CAPTIONS, geminiStream: DRAFT_STREAM, geminiOverride: ({ purpose }) => (purpose === 'review' ? notJson() : undefined) });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
    expect(events.at(-1)).toEqual({
      event: 'error',
      data: { code: 'review_failed', message: '内容核对没有完成，这次生成没有保存（对照字幕核对没有完成：模型返回的格式无效（不是合法 JSON））', partial: true },
    });
    expect(await openStore(env, eventOf(events, 'meta')!.generationId).load()).toBeNull();
  });

  // 抓：核对时预付额度用完被包成 review_failed，或者重试、换同一账单下的备用模型
  it('核对时 402：error gemini_billing，两章及整篇专项各请求一次，不换备用模型', async () => {
    const upstream = mockUpstream({ captions: CAPTIONS, geminiStream: DRAFT_STREAM, geminiOverride: ({ purpose }) => (purpose === 'review' ? billingResponse() : undefined) });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
    expect(events.at(-1)).toEqual({ event: 'error', data: { code: 'gemini_billing', message: 'Gemini 账户的预付额度已用完，暂时无法生成', partial: true } });
    expect(upstream.gemini('review').map((r) => modelOf(r.url))).toEqual(['test-model', 'test-model', 'test-model']);
    expect(await openStore(env, eventOf(events, 'meta')!.generationId).load()).toBeNull();
  });

  // 抓：核对时主模型繁忙整次失败；换备用模型时沿用主模型的 high
  it('核对时主模型 503、备用正常：照常完成，备用请求用备用模型自己的思考档 low', async () => {
    const upstream = mockUpstream({
      captions: CAPTIONS,
      geminiStream: DRAFT_STREAM,
      reviewJson: firstChapterIssue,
      geminiOverride: ({ purpose, model }) => (purpose === 'review' && model === 'test-model' ? busyResponse() : undefined),
    });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
    expect(events.at(-1)!.event).toBe('done');
    expect(eventOf(events, 'revised')!.markdown).toBe(REVIEWED);
    const requests = upstream.gemini('review').map((r) => [modelOf(r.url), promptOf(r.body).generationConfig.thinkingConfig]);
    expect(requests.filter(([model]) => model === 'test-model')).toEqual([
      ['test-model', { thinkingLevel: 'high' }],
      ['test-model', { thinkingLevel: 'high' }],
      ['test-model', { thinkingLevel: 'high' }],
      ['test-model', { thinkingLevel: 'high' }],
      ['test-model', { thinkingLevel: 'high' }],
      ['test-model', { thinkingLevel: 'high' }],
    ]);
    expect(requests.filter(([model]) => model === 'test-fallback')).toEqual([
      ['test-fallback', { thinkingLevel: 'low' }],
      ['test-fallback', { thinkingLevel: 'low' }],
      ['test-fallback', { thinkingLevel: 'low' }],
    ]);
    // 每路均独立执行主备切换，整篇专项不能漏掉或误路由为 5W1H。
    for (const section of [SECTION_1, SECTION_2, DRAFT]) {
      const scope = upstream.gemini('review').filter((r) => promptOf(r.body).user.includes(`<section>\n${section}\n</section>`));
      expect(scope.map((r) => modelOf(r.url))).toEqual(['test-model', 'test-model', 'test-fallback']);
    }
    expect(upstream.gemini('summary')).toHaveLength(0);
    // 写文章仍是主模型：核对换备用模型不影响 done.model
    expect(eventOf(events, 'done')!.model).toBe('test-model');
  });
});

describe('对照字幕核对：客户端断开', () => {
  // 抓：核对进行中用户关掉页面，服务端照样等核对结束并保存；核对请求没被取消，白白消耗额度
  it('核对进行中断开：核对请求被中止，不保存', async () => {
    const signals: AbortSignal[] = [];
    mockUpstream({
      captions: CAPTIONS,
      geminiStream: DRAFT_STREAM,
      geminiOverride: ({ purpose, signal }) => {
        if (purpose !== 'review') return undefined;
        signals.push(signal!);
        return hangingResponse(signal);
      },
    });
    const save = vi.spyOn(GenerationStore.prototype, 'save');
    const res = await exports.default.fetch('https://app.test/api/generations', { method: 'POST', body: JSON.stringify({ url: url(OTHER_VIDEO_ID) }) });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    while (!received.includes('"stage":"reviewing"')) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
    const generationId = /"generationId":"([0-9a-f]{64})"/.exec(received)![1]!;
    await vi.waitFor(() => expect(signals).toHaveLength(3));
    expect(signals.map((s) => s.aborted)).toEqual([false, false, false]);

    await reader.cancel('user closed the tab');
    await vi.waitFor(() => expect(signals.map((s) => s.aborted)).toEqual([true, true, true]), { timeout: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(save).not.toHaveBeenCalled();
    expect(await openStore(env, generationId).load()).toBeNull();
  });
});

describe('对照字幕核对：重叠修订的合并处理', () => {
  // 审查方反例：主持人的估计被写成嘉宾的说法，金额也错了一个数量级
  const PILOT_CAPTIONS = srv1([[0, "Host: Our pilot cost about 20 dollars. This is my estimate, not the guest's statement."]]);
  const PILOT_TRANSCRIPT = "[00:00] Host: Our pilot cost about 20 dollars. This is my estimate, not the guest's statement.";
  const PILOT_DRAFT = '# 试点\n\n## 费用\n\n嘉宾表示，试点费用为200美元。';
  const EVIDENCE = "Host: Our pilot cost about 20 dollars. This is my estimate, not the guest's statement.";
  const CHAPTER_FIX = { type: 'quantity', quote: '试点费用为200美元。', evidence: EVIDENCE, problem: '金额是约 20 美元', replacement: '试点费用约为20美元。' };
  const ARTICLE_FIX = { type: 'attribution', quote: '嘉宾表示，试点费用为200美元。', evidence: EVIDENCE, problem: '这是主持人的估计，不是嘉宾的说法', replacement: '主持人估计，试点费用约为20美元。' };
  const FINAL = '# 试点\n\n## 费用\n\n主持人估计，试点费用约为20美元。';
  /** 逐章核对只改数字，整篇复核同时改归属和数字 */
  const twoWays = (body: string) => geminiJson({ issues: isFidelityReview(body) ? [ARTICLE_FIX] : [CHAPTER_FIX] });
  const REVISE = geminiJson({ items: [{ index: 0, status: 'revise', note: '数字已改对，归属仍错', quote: '嘉宾表示，试点费用约为20美元。', replacement: '主持人估计，试点费用约为20美元。', evidence: '' }] });

  // 抓（审查方反例，经过真实 Worker）：整篇建议因句子已被逐章改过而丢掉，保存的文章归属仍错；
  // revised、done、保存的上下文和随后 5W1H 用的文章不是同一份；合并请求带了整段字幕
  it('逐章改数字、整篇改归属：合并处理后 revised 是"主持人估计…"，保存与 5W1H 都用它，unapplied 留痕', async () => {
    const upstream = mockUpstream({
      captions: PILOT_CAPTIONS,
      geminiStream: geminiSse(['# 试点\n\n## 费用\n\n', '嘉宾表示，试点费用为200美元。']),
      reviewJson: twoWays,
      reconcileJson: REVISE,
      geminiJson: geminiJson(SUMMARY),
    });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });

    expect(events.map((e) => e.event)).toEqual(['stage', 'meta', 'stage', 'delta', 'delta', 'stage', 'revised', 'done']);
    const revisions = [
      { type: 'quantity', before: '试点费用为200美元。', after: '试点费用约为20美元。', reason: '金额是约 20 美元', evidence: EVIDENCE },
      { type: 'attribution', before: '嘉宾表示，试点费用约为20美元。', after: '主持人估计，试点费用约为20美元。', reason: '这是主持人的估计，不是嘉宾的说法', evidence: EVIDENCE },
    ];
    expect(eventOf(events, 'revised')).toEqual({ markdown: FINAL, revisions });
    const unapplied = [{ stage: 'article', disposition: 'superseded', ...ARTICLE_FIX, note: '数字已改对，归属仍错' }];
    expect(eventOf(events, 'done')!.review).toEqual({ sections: 1, revisions: 2, rewritten: null, checks: [], unapplied });

    const reconciles = upstream.gemini('reconcile');
    expect(reconciles).toHaveLength(1);
    expect(promptOf(reconciles[0]!.body).user).toContain('<article>\n# 试点\n\n## 费用\n\n嘉宾表示，试点费用约为20美元。\n</article>');
    expect(promptOf(reconciles[0]!.body).user).not.toContain('<transcript>');
    expect(upstream.gemini('review')).toHaveLength(2);
    for (const r of upstream.gemini('review')) expect(promptOf(r.body).user).toContain(`<transcript>\n${PILOT_TRANSCRIPT}\n</transcript>`);

    const generationId = eventOf(events, 'meta')!.generationId;
    const saved = await openStore(env, generationId).load();
    expect(saved!.article.markdown).toBe(FINAL);
    expect(saved!.review!.draft).toBe(PILOT_DRAFT);
    expect(saved!.review!.items).toEqual(revisions);
    expect(saved!.review!.unapplied).toEqual(unapplied);

    const res = await exports.default.fetch(`https://app.test/api/generations/${generationId}/chapters/1/summary`, { method: 'POST' });
    expect(res.status).toBe(200);
    const user = promptOf(upstream.gemini('summary')[0]!.body).user;
    expect(user).toContain('<current_chapter id="1">\n## 费用\n\n主持人估计，试点费用约为20美元。\n</current_chapter>');
    expect(user).not.toContain('嘉宾表示');
  });

  // 抓：合并处理响应无效时退回只采用逐章修订的文章并保存（归属仍错的稿子被当成核对过）
  it.each([
    ['缺条目', { items: [] }],
    ['格式无效', { verdicts: [] }],
  ])('合并处理响应%s：error review_failed，没有 revised 和 done，不保存', async (_label, raw) => {
    const upstream = mockUpstream({ captions: PILOT_CAPTIONS, geminiStream: geminiSse([PILOT_DRAFT]), reviewJson: twoWays, reconcileJson: geminiJson(raw) });
    const save = vi.spyOn(GenerationStore.prototype, 'save');
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
    expect(events.at(-1)).toEqual({
      event: 'error',
      data: { code: 'review_failed', message: '内容核对没有完成，这次生成没有保存（重叠修订建议的合并处理没有完成：模型没有对每条建议给出有效结论）', partial: true },
    });
    expect(eventOf(events, 'done')).toBeUndefined();
    expect(eventOf(events, 'revised')).toBeUndefined();
    expect(upstream.gemini('reconcile')).toHaveLength(1);
    expect(save).not.toHaveBeenCalled();
    expect(await openStore(env, eventOf(events, 'meta')!.generationId).load()).toBeNull();
  });
});

