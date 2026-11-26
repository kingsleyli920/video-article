/**
 * L1b 对照字幕核对：经过完整 Worker 和 Durable Object，出站请求全部替身。
 * 覆盖事件序列、核对请求的内容、修订后的保存和 5W1H、各种丢弃、模型失败和客户端断开。
 */
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenerationStore, openStore } from '../../src/worker/store';
import { geminiJson, geminiSse, OTHER_VIDEO_ID, srv1, toneChecks } from '../fixtures/upstream';
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

  // 抓：没有核对阶段就保存；没问题时也发 revised；done.review 缺字段；章节或整篇专项请求漏了对应原文、整段字幕；
  // 字幕里有约数说法时没发语气核对，或语气核对带了整段字幕
  it('事件里有 reviewing、没有 revised；每章和整篇专项带对应原文及完整字幕，语气核对带清单和整篇文章', async () => {
    const upstream = mockUpstream({ captions: CAPTIONS, geminiStream: DRAFT_STREAM });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });

    expect(events.map((e) => e.event)).toEqual(['stage', 'meta', 'stage', 'delta', 'delta', 'delta', 'stage', 'done']);
    expect(events[6]!.data).toEqual({ stage: 'reviewing' });
    const done = eventOf(events, 'done')!;
    // 字幕里 "about five" 一条语气片段
    expect(done.review).toEqual({ sections: 2, toneExcerpts: 1, revisions: 0, rewritten: null, checks: [] });
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

    // 语气核对：一份清单、一次请求；带编号 1 的片段和整篇初稿，不带整段字幕
    const tones = upstream.gemini('tone');
    expect(tones).toHaveLength(1);
    const tone = promptOf(tones[0]!.body);
    expect(modelOf(tones[0]!.url)).toBe('test-model');
    expect(tone.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'high' });
    expect(tone.user).toContain('\n1. [about five] Over the next ten years the fund backed Alpha, Beta and Gamma we are at about five portfolio companies now and I expect that to grow to five or six\n');
    expect(tone.user).toContain(`<section>\n${DRAFT}\n</section>`);
    expect(tone.user).not.toContain('<transcript>');

    const saved = await openStore(env, eventOf(events, 'meta')!.generationId).load();
    expect(saved!.article.markdown).toBe(DRAFT);
    expect(saved!.review).toEqual({ sections: 2, toneExcerpts: 1, revisions: 0, rewritten: null, checks: [], items: [], requirements: { maxChars: null, minChars: null, chaptersMin: null, chaptersMax: null, sectionsPerChapter: null, sectionTitles: [] } });
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
    expect(done.review).toEqual({ sections: 2, toneExcerpts: 1, revisions: 1, rewritten: null, checks: [] });

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
    expect(eventOf(events, 'done')!.review).toEqual({ sections: 2, toneExcerpts: 1, revisions: 0, rewritten: null, checks: [], unapplied });
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

describe('对照字幕核对：网关超时', () => {
  // 抓（线上实际遇到）：核对请求被网关回 524 时当成不可重试的错误，整次生成报失败，没有换备用模型
  it('核对时主模型返回 524：每路主模型请求两次后换备用模型，照常完成，不是 review_failed', async () => {
    const upstream = mockUpstream({
      captions: CAPTIONS,
      geminiStream: DRAFT_STREAM,
      reviewJson: firstChapterIssue,
      geminiOverride: ({ purpose, model }) => (purpose === 'review' && model === 'test-model' ? new Response('error code: 524', { status: 524 }) : undefined),
    });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
    expect(events.at(-1)!.event).toBe('done');
    expect(eventOf(events, 'error')).toBeUndefined();
    expect(eventOf(events, 'revised')!.markdown).toBe(REVIEWED);
    for (const section of [SECTION_1, SECTION_2, DRAFT]) {
      const scope = upstream.gemini('review').filter((r) => promptOf(r.body).user.includes(`<section>\n${section}\n</section>`));
      expect(scope.map((r) => modelOf(r.url))).toEqual(['test-model', 'test-model', 'test-fallback']);
    }
    expect((await openStore(env, eventOf(events, 'meta')!.generationId).load())!.article.markdown).toBe(REVIEWED);
  });
});

describe('对照字幕核对：客户端断开', () => {
  // 抓：核对进行中用户关掉页面，服务端照样等核对结束并保存；核对请求（含语气核对）没被取消，白白消耗额度
  it('核对进行中断开：两章、整篇和语气核对四个请求都被中止，不保存', async () => {
    const signals: AbortSignal[] = [];
    mockUpstream({
      captions: CAPTIONS,
      geminiStream: DRAFT_STREAM,
      geminiOverride: ({ purpose, signal }) => {
        if (purpose !== 'review' && purpose !== 'tone') return undefined;
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
    // 两章 + 整篇 + 语气（字幕里 "about five" 一条）
    await vi.waitFor(() => expect(signals).toHaveLength(4));
    expect(signals.map((s) => s.aborted)).toEqual([false, false, false, false]);

    await reader.cancel('user closed the tab');
    await vi.waitFor(() => expect(signals.map((s) => s.aborted)).toEqual([true, true, true, true]), { timeout: 1_000 });
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
    // 字幕里 "about 20 dollars" 一条语气片段，替身判 kept
    expect(eventOf(events, 'done')!.review).toEqual({ sections: 1, toneExcerpts: 1, revisions: 2, rewritten: null, checks: [], unapplied });

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

  // 抓：经过真实 Worker 时合并处理判"已改正"或"不成立"也报错，或者没把结论随 done 和保存的上下文留痕
  it.each([
    ['covered', '当前文章已经改正'],
    ['unfounded', '依据不支持这条建议'],
  ])('合并处理返回 %s：done 并保存逐章修订后的文章，unapplied 记合并结论', async (status, note) => {
    const upstream = mockUpstream({
      captions: PILOT_CAPTIONS,
      geminiStream: geminiSse([PILOT_DRAFT]),
      reviewJson: twoWays,
      reconcileJson: geminiJson({ items: [{ index: 0, status, note, quote: '', replacement: '', evidence: '' }] }),
    });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
    expect(events.at(-1)!.event).toBe('done');
    expect(eventOf(events, 'revised')!.markdown).toBe('# 试点\n\n## 费用\n\n嘉宾表示，试点费用约为20美元。');
    const unapplied = [{ stage: 'article', disposition: status, ...ARTICLE_FIX, note }];
    expect(eventOf(events, 'done')!.review.unapplied).toEqual(unapplied);
    expect(upstream.gemini('reconcile')).toHaveLength(1);
    const saved = await openStore(env, eventOf(events, 'meta')!.generationId).load();
    expect(saved!.article.markdown).toBe('# 试点\n\n## 费用\n\n嘉宾表示，试点费用约为20美元。');
    expect(saved!.review!.unapplied).toEqual(unapplied);
  });

  // 抓：经过真实 Worker 时，合并处理两轮给出的修订都落实不了（quote 在当前文章里找不到），归属仍错的文章照样发 done 并保存；
  // 第二轮请求没带上次失败的原因
  it('合并修订两轮都落实不了：error review_failed（仍未落实），没有 revised 和 done，不保存，合并请求 2 次', async () => {
    const upstream = mockUpstream({
      captions: PILOT_CAPTIONS,
      geminiStream: geminiSse([PILOT_DRAFT]),
      reviewJson: twoWays,
      reconcileJson: geminiJson({ items: [{ index: 0, status: 'revise', note: '还要改', quote: '主持人表示，试点费用约为20美元。', replacement: '主持人估计，试点费用约为20美元。', evidence: '' }] }),
    });
    const save = vi.spyOn(GenerationStore.prototype, 'save');
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
    expect(events.at(-1)).toEqual({
      event: 'error',
      data: { code: 'review_failed', message: '内容核对没有完成，这次生成没有保存（重叠修订建议的合并处理没有完成：有 1 条建议指出的问题仍未落实（修订定位不到原句））', partial: true },
    });
    expect(eventOf(events, 'done')).toBeUndefined();
    expect(eventOf(events, 'revised')).toBeUndefined();
    const reconciles = upstream.gemini('reconcile');
    expect(reconciles).toHaveLength(2);
    expect(promptOf(reconciles[0]!.body).user).not.toContain('previousAttempt');
    expect(promptOf(reconciles[1]!.body).user).toContain('"previousAttempt": "上一次给出的 quote 在 <article> 里找不到：必须从当前的 <article> 逐字复制"');
    expect(save).not.toHaveBeenCalled();
    expect(await openStore(env, eventOf(events, 'meta')!.generationId).load()).toBeNull();
  });

  // 抓：经过真实 Worker 时，合并处理第一轮落实不了、第二轮给出有效修订，却仍报失败或没采用第二轮的修订
  it('合并修订第一轮落实不了、第二轮有效：done，revised 是"主持人估计…"，保存的就是它', async () => {
    let round = 0;
    const bad = geminiJson({ items: [{ index: 0, status: 'revise', note: '还要改', quote: '试点', replacement: '试点项目', evidence: '' }] });
    const upstream = mockUpstream({ captions: PILOT_CAPTIONS, geminiStream: geminiSse([PILOT_DRAFT]), reviewJson: twoWays, reconcileJson: () => (round++ === 0 ? bad : REVISE) });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
    expect(events.at(-1)!.event).toBe('done');
    expect(eventOf(events, 'revised')!.markdown).toBe(FINAL);
    expect(eventOf(events, 'done')!.review.unapplied).toEqual([
      { stage: 'reconcile', disposition: 'quote_not_unique', type: 'attribution', quote: '试点', replacement: '试点项目', problem: '这是主持人的估计，不是嘉宾的说法', evidence: EVIDENCE, note: '还要改' },
      { stage: 'article', disposition: 'superseded', ...ARTICLE_FIX, note: '数字已改对，归属仍错' },
    ]);
    expect(upstream.gemini('reconcile')).toHaveLength(2);
    expect((await openStore(env, eventOf(events, 'meta')!.generationId).load())!.article.markdown).toBe(FINAL);
  });

  // 抓（审查方反例，经过真实 Worker）：嘉宾段已有"成本20美元"，整篇要改主持人段的建议被按全文误判 covered，
  // 保存的文章主持人段停在"成本约200美元"；revised、done 和保存的上下文不是同一份
  it('"成本"反例：整篇建议进合并处理，revised 里主持人段是合并后的文字，嘉宾段不变，保存的上下文一致', async () => {
    const HOST = 'Host: our setup cost 20 dollars in the first year.';
    const GUEST = 'Guest: we paid 20 dollars for the same setup.';
    const COST_DRAFT = '# 成本\n\n## 试点\n\n**主持人:** 第一年的成本200美元。\n\n**嘉宾:** 我们的成本300美元。';
    const COST_FINAL = '# 成本\n\n## 试点\n\n**主持人:** 第一年的成本20美元。\n\n**嘉宾:** 我们的成本20美元。';
    const HOST_ABOUT = { type: 'quantity', quote: '成本200美元', replacement: '成本约200美元', evidence: HOST, problem: '主持人说的是约数' };
    const GUEST_FIX = { type: 'quantity', quote: '成本300美元', replacement: '成本20美元', evidence: GUEST, problem: '嘉宾说的是 20 美元' };
    const HOST_FIX = { type: 'quantity', quote: '成本200美元', replacement: '成本20美元', evidence: HOST, problem: '主持人说的是 20 美元' };
    const upstream = mockUpstream({
      captions: srv1([
        [0, HOST],
        [20, GUEST],
      ]),
      geminiStream: geminiSse(['# 成本\n\n## 试点\n\n', '**主持人:** 第一年的成本200美元。\n\n**嘉宾:** 我们的成本300美元。']),
      reviewJson: (body) => geminiJson({ issues: isFidelityReview(body) ? [HOST_FIX] : [HOST_ABOUT, GUEST_FIX] }),
      reconcileJson: geminiJson({ items: [{ index: 0, status: 'revise', note: '加了约但数字仍错', quote: '第一年的成本约200美元。', replacement: '第一年的成本20美元。', evidence: '' }] }),
    });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });

    expect(events.map((e) => e.event)).toEqual(['stage', 'meta', 'stage', 'delta', 'delta', 'stage', 'revised', 'done']);
    const revisions = [
      { type: 'quantity', before: '成本200美元', after: '成本约200美元', reason: '主持人说的是约数', evidence: HOST },
      { type: 'quantity', before: '成本300美元', after: '成本20美元', reason: '嘉宾说的是 20 美元', evidence: GUEST },
      { type: 'quantity', before: '第一年的成本约200美元。', after: '第一年的成本20美元。', reason: '主持人说的是 20 美元', evidence: HOST },
    ];
    expect(eventOf(events, 'revised')).toEqual({ markdown: COST_FINAL, revisions });
    const unapplied = [{ stage: 'article', disposition: 'superseded', ...HOST_FIX, note: '加了约但数字仍错' }];
    expect(eventOf(events, 'done')!.review).toEqual({ sections: 1, revisions: 3, rewritten: null, checks: [], unapplied });
    const reconciles = upstream.gemini('reconcile');
    expect(reconciles).toHaveLength(1);
    expect(promptOf(reconciles[0]!.body).user).toContain('<article>\n# 成本\n\n## 试点\n\n**主持人:** 第一年的成本约200美元。\n\n**嘉宾:** 我们的成本20美元。\n</article>');

    const saved = await openStore(env, eventOf(events, 'meta')!.generationId).load();
    expect(saved!.article.markdown).toBe(COST_FINAL);
    expect(saved!.review!.draft).toBe(COST_DRAFT);
    expect(saved!.review!.items).toEqual(revisions);
    expect(saved!.review!.unapplied).toEqual(unapplied);
  });

  // 审查方反例 A、B：修订目标位置的身份。都经过真实 Worker 入口，断言事件流和保存的内容
  describe('修订目标位置的身份（反例 A、B）', () => {
    const A_EVIDENCE = 'Host: Our pilot cost about 20 dollars, and the other pilot cost exactly 20 dollars.';
    const A_PARAGRAPH = '主持人介绍两个试点：第一个试点成本200美元，另一个试点成本300美元。';
    const A_AFTER_CHAPTER = '主持人介绍两个试点：第一个试点成本约200美元，另一个试点成本20美元。';
    const A_DRAFT = `# 试点\n\n## 费用\n\n${A_PARAGRAPH}`;
    const A_FINAL = '# 试点\n\n## 费用\n\n主持人介绍两个试点：第一个试点成本约20美元，另一个试点成本20美元。';
    const A_CHAPTER = { type: 'quantity', quote: A_PARAGRAPH, replacement: A_AFTER_CHAPTER, evidence: A_EVIDENCE, problem: '第一个是约数，第二个是 20 美元' };
    const A_ARTICLE = { type: 'quantity', quote: '试点成本200美元', replacement: '试点成本20美元', evidence: A_EVIDENCE, problem: '第一个试点的金额也应是20美元，不是200美元。' };
    const aUpstream = (reconcile: unknown) =>
      mockUpstream({
        captions: srv1([[0, A_EVIDENCE]]),
        geminiStream: geminiSse(['# 试点\n\n## 费用\n\n', A_PARAGRAPH]),
        reviewJson: (body) => geminiJson({ issues: isFidelityReview(body) ? [A_ARTICLE] : [A_CHAPTER] }),
        reconcileJson: geminiJson(reconcile),
      });

    // 抓（反例 A）：整篇建议被扩大范围里第二个试点的"试点成本20美元"冒充成已覆盖，没有合并请求，
    // 保存的文章第一个试点停在"约200美元"
    it('反例 A：整篇建议不自动 covered，进一次合并处理；revised、done 和保存的文章里第一个金额改对、第二个金额不变', async () => {
      const upstream = aUpstream({ items: [{ index: 0, status: 'revise', note: '第一个金额仍是约200', quote: '第一个试点成本约200美元', replacement: '第一个试点成本约20美元', evidence: '' }] });
      const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
      expect(events.at(-1)!.event).toBe('done');
      expect(upstream.gemini('reconcile')).toHaveLength(1);
      expect(promptOf(upstream.gemini('reconcile')[0]!.body).user).toContain(`<article>\n# 试点\n\n## 费用\n\n${A_AFTER_CHAPTER}\n</article>`);
      expect(eventOf(events, 'revised')!.markdown).toBe(A_FINAL);
      expect(eventOf(events, 'done')!.review.unapplied).toEqual([{ stage: 'article', disposition: 'superseded', ...A_ARTICLE, note: '第一个金额仍是约200' }]);
      const saved = await openStore(env, eventOf(events, 'meta')!.generationId).load();
      expect(saved!.article.markdown).toBe(A_FINAL);
      expect(saved!.review!.draft).toBe(A_DRAFT);
    });

    // 抓（反例 A 的失败路径）：合并处理明确说还要改、两轮给出的修订都落实不了，却照样保存并发 done
    it('反例 A：合并处理两轮都落实不了，error review_failed，没有 revised 和 done，不保存', async () => {
      const upstream = aUpstream({ items: [{ index: 0, status: 'revise', note: '还要改', quote: '第一个试点成本200美元', replacement: '第一个试点成本20美元', evidence: '' }] });
      const save = vi.spyOn(GenerationStore.prototype, 'save');
      const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
      expect(events.at(-1)!.event).toBe('error');
      expect((events.at(-1)!.data as { code: string }).code).toBe('review_failed');
      expect(eventOf(events, 'done')).toBeUndefined();
      expect(eventOf(events, 'revised')).toBeUndefined();
      expect(upstream.gemini('reconcile')).toHaveLength(2);
      expect(save).not.toHaveBeenCalled();
      expect(await openStore(env, eventOf(events, 'meta')!.generationId).load()).toBeNull();
    });

    // 抓（反例 B）：初稿里"试点成本200美元"出现两次，主持人那处被逐章改掉后，整篇建议的短引文在当前文章里只剩嘉宾那一处，
    // 被当成唯一定位直接替换，嘉宾正确的 200 美元被改成 20 美元并保存
    it('反例 B：初稿里不唯一的引文进合并处理，嘉宾的 200 美元不被改；页面收到的最终稿和保存的文章一致', async () => {
      const HOST = 'Host: Our pilot cost 20 dollars.';
      const GUEST = 'Guest: Our other pilot cost 200 dollars.';
      const B_DRAFT = '# 试点\n\n## 费用\n\n主持人：试点成本200美元。\n\n嘉宾：试点成本200美元。';
      const B_FINAL = '# 试点\n\n## 费用\n\n主持人：试点成本20美元。\n\n嘉宾：试点成本200美元。';
      const B_CHAPTER = { type: 'quantity', quote: '主持人：试点成本200美元。', replacement: '主持人：试点成本20美元。', evidence: HOST, problem: '主持人说20美元。' };
      const B_ARTICLE = { type: 'quantity', quote: '试点成本200美元', replacement: '试点成本20美元', evidence: HOST, problem: '主持人说20美元，不是200美元。' };
      const upstream = mockUpstream({
        captions: srv1([
          [0, HOST],
          [10, GUEST],
        ]),
        geminiStream: geminiSse(['# 试点\n\n## 费用\n\n', '主持人：试点成本200美元。\n\n嘉宾：试点成本200美元。']),
        reviewJson: (body) => geminiJson({ issues: isFidelityReview(body) ? [B_ARTICLE] : [B_CHAPTER] }),
        reconcileJson: geminiJson({ items: [{ index: 0, status: 'covered', note: '主持人那一处已经是 20 美元', quote: '', replacement: '', evidence: '' }] }),
      });
      const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
      expect(events.at(-1)!.event).toBe('done');
      expect(upstream.gemini('reconcile')).toHaveLength(1);
      expect(eventOf(events, 'revised')).toEqual({ markdown: B_FINAL, revisions: [{ type: 'quantity', before: '主持人：试点成本200美元。', after: '主持人：试点成本20美元。', reason: '主持人说20美元。', evidence: HOST }] });
      expect(eventOf(events, 'done')!.review.unapplied).toEqual([{ stage: 'article', disposition: 'covered', ...B_ARTICLE, note: '主持人那一处已经是 20 美元' }]);
      const saved = await openStore(env, eventOf(events, 'meta')!.generationId).load();
      expect(saved!.article.markdown).toBe(B_FINAL);
      expect(saved!.review!.draft).toBe(B_DRAFT);
    });
  });

  // 审查方第三轮反例：已覆盖必须是完整结果相等；和上下文重合只是疑似问题。都经过真实 Worker 入口
  describe('完整结果相等与疑似重复（经过 Worker 入口）', () => {
    // 抓（反例 1）：段落以替换文字开头就被判 covered，没有依据的尾句随文章保存
    it('整篇建议要删掉尾句、逐章只改了金额：进合并处理，revised 和保存的文章里尾句已处理', async () => {
      const HOST = 'Host: The pilot cost 20 dollars.';
      const GUEST = 'Guest: I cannot guarantee that the project will succeed.';
      const PARAGRAPH = '主持人说成本200美元。嘉宾保证项目一定成功。';
      const FINAL = '# 试点\n\n## 费用\n\n主持人说成本20美元。嘉宾表示无法保证项目成功。';
      const chapterFix = { type: 'quantity', quote: PARAGRAPH, replacement: '主持人说成本20美元。嘉宾保证项目一定成功。', evidence: HOST, problem: '成本是 20 美元' };
      const articleFix = { type: 'unsupported', quote: PARAGRAPH, replacement: '主持人说成本20美元。', evidence: `${HOST} … ${GUEST}`, problem: '成本是 20 美元；嘉宾没有保证成功' };
      const upstream = mockUpstream({
        captions: srv1([
          [0, HOST],
          [10, GUEST],
        ]),
        geminiStream: geminiSse(['# 试点\n\n## 费用\n\n', PARAGRAPH]),
        reviewJson: (body) => geminiJson({ issues: isFidelityReview(body) ? [articleFix] : [chapterFix] }),
        reconcileJson: geminiJson({ items: [{ index: 0, status: 'revise', note: '尾句仍在', quote: '嘉宾保证项目一定成功。', replacement: '嘉宾表示无法保证项目成功。', evidence: GUEST }] }),
      });
      const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
      expect(events.at(-1)!.event).toBe('done');
      expect(upstream.gemini('reconcile')).toHaveLength(1);
      expect(eventOf(events, 'revised')!.markdown).toBe(FINAL);
      expect(eventOf(events, 'done')!.review.unapplied).toEqual([{ stage: 'article', disposition: 'superseded', ...articleFix, note: '尾句仍在' }]);
      expect((await openStore(env, eventOf(events, 'meta')!.generationId).load())!.article.markdown).toBe(FINAL);
    });

    // 抓（反例 2）：当前文字以替换文字结尾就被判 covered，否定词随文章保存
    it('整篇建议要去掉否定词、逐章只补了来源限定：进合并处理，保存的文章里否定词已去掉', async () => {
      const EVIDENCE = 'The demonstrated system supports offline operation.';
      const FINAL = '# 系统\n\n## 能力\n\n视频中演示的系统支持离线运行。';
      const sourceFix = { type: 'unsupported', quote: '该系统不支持离线运行。', replacement: '视频中演示的系统不支持离线运行。', evidence: EVIDENCE, problem: '补上来源限定' };
      const negationFix = { type: 'unsupported', quote: '不支持离线运行', replacement: '支持离线运行', evidence: EVIDENCE, problem: '字幕说的是支持离线运行' };
      const upstream = mockUpstream({
        captions: srv1([[0, EVIDENCE]]),
        geminiStream: geminiSse(['# 系统\n\n## 能力\n\n', '该系统不支持离线运行。']),
        reviewJson: (body) => geminiJson({ issues: isFidelityReview(body) ? [negationFix] : [sourceFix] }),
        reconcileJson: geminiJson({ items: [{ index: 0, status: 'revise', note: '否定词仍在', quote: '视频中演示的系统不支持离线运行。', replacement: '视频中演示的系统支持离线运行。', evidence: '' }] }),
      });
      const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
      expect(events.at(-1)!.event).toBe('done');
      expect(upstream.gemini('reconcile')).toHaveLength(1);
      expect(eventOf(events, 'revised')!.markdown).toBe(FINAL);
      expect((await openStore(env, eventOf(events, 'meta')!.generationId).load())!.article.markdown).toBe(FINAL);
    });

    const BANK = 'This is a bank deposit. Bank deposits can be withdrawn.';
    const BANK_FINAL = '# 银行\n\n## 存款\n\n这是银行存款。银行存款可以提取。';
    const bankFix = { type: 'unsupported', quote: '这是银行贷款。', replacement: '这是银行存款。', evidence: BANK, problem: '字幕说的是存款' };
    const bankUpstream = (reconcile: unknown) =>
      mockUpstream({
        captions: srv1([[0, BANK]]),
        geminiStream: geminiSse(['# 银行\n\n## 存款\n\n', '这是银行贷款。银行存款可以提取。']),
        reviewJson: (body) => geminiJson({ issues: isFidelityReview(body) ? [bankFix] : [] }),
        reconcileJson: geminiJson(reconcile),
      });

    // 抓（反例 3）：合法纠错因为和下一句共用"银行存款"被拒，"银行贷款"随文章保存并报完成
    it('合法纠错和下一句共用一个词：交合并处理确认后落实，revised 和保存的文章里错误已改', async () => {
      const upstream = bankUpstream({ items: [{ index: 0, status: 'revise', note: '只是用到同一个词，照改', quote: '这是银行贷款。', replacement: '这是银行存款。', evidence: '' }] });
      const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
      expect(events.at(-1)!.event).toBe('done');
      const reconciles = upstream.gemini('reconcile');
      expect(reconciles).toHaveLength(1);
      expect(promptOf(reconciles[0]!.body).user).toContain('这条建议还没有应用');
      expect(eventOf(events, 'revised')).toEqual({ markdown: BANK_FINAL, revisions: [{ type: 'unsupported', before: '这是银行贷款。', after: '这是银行存款。', reason: '字幕说的是存款', evidence: BANK }] });
      expect(eventOf(events, 'done')!.review.unapplied).toEqual([{ stage: 'article', disposition: 'superseded', ...bankFix, note: '只是用到同一个词，照改' }]);
      expect((await openStore(env, eventOf(events, 'meta')!.generationId).load())!.article.markdown).toBe(BANK_FINAL);
    });

    // 抓：疑似重复的建议被记成"已完成"——合并处理说还要改却两轮都落实不了时，带着"银行贷款"保存并发 done
    it('疑似重复的建议合并处理两轮都落实不了：error review_failed，没有 done，不保存', async () => {
      const upstream = bankUpstream({ items: [{ index: 0, status: 'revise', note: '照改', quote: '这是一笔银行贷款。', replacement: '这是银行存款。', evidence: '' }] });
      const save = vi.spyOn(GenerationStore.prototype, 'save');
      const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
      expect(events.at(-1)!.event).toBe('error');
      expect((events.at(-1)!.data as { code: string }).code).toBe('review_failed');
      expect(eventOf(events, 'done')).toBeUndefined();
      expect(upstream.gemini('reconcile')).toHaveLength(2);
      expect(save).not.toHaveBeenCalled();
    });
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

describe('对照字幕核对：语气清单核对', () => {
  /** 字幕原话 "about five" 是约数，初稿第二章写成了确定的"五到六家" */
  const HEDGE = { type: 'quantity' as const, quote: '现在有五到六家被投公司。', replacement: '现在大约有五家被投公司，预计会增加到五到六家。', evidence: 'we are at about five portfolio companies now', problem: '原话是约五家，五到六家是预期' };
  /** 采用 HEDGE 之后：61 - 12 + 23 = 72 字 */
  const TONED = '# 柏林与基金\n\n## 柏林岁月\n\n**嘉宾:** 2003 年那家基金投资了 Alpha、Beta 和 Gamma。\n\n## 现在的组合\n\n**嘉宾:** 现在大约有五家被投公司，预计会增加到五到六家。';

  // 抓：语气核对的修订没进 revised；保存的上下文、done 的字数、随后 5W1H 用的还是初稿
  it('语气核对查出一处：revised 带这条修订，保存的就是它，5W1H 用修订后的句子', async () => {
    const upstream = mockUpstream({
      captions: CAPTIONS,
      geminiStream: DRAFT_STREAM,
      toneJson: (body) => geminiJson(toneChecks(promptOf(body).user, [{ match: 'about five', ...HEDGE }])),
      geminiJson: geminiJson(SUMMARY),
    });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });

    expect(events.map((e) => e.event)).toEqual(['stage', 'meta', 'stage', 'delta', 'delta', 'delta', 'stage', 'revised', 'done']);
    const revisions = [{ type: 'quantity', before: '现在有五到六家被投公司。', after: '现在大约有五家被投公司，预计会增加到五到六家。', reason: '原话是约五家，五到六家是预期', evidence: 'we are at about five portfolio companies now' }];
    expect(eventOf(events, 'revised')).toEqual({ markdown: TONED, revisions });
    const done = eventOf(events, 'done')!;
    expect(done.chars).toBe(72);
    expect(done.review).toEqual({ sections: 2, toneExcerpts: 1, revisions: 1, rewritten: null, checks: [] });
    // 两章、整篇各一次，语气一次（一条片段）；没有重叠，不调合并处理
    expect(upstream.gemini('review')).toHaveLength(3);
    expect(upstream.gemini('tone')).toHaveLength(1);
    expect(upstream.gemini('reconcile')).toHaveLength(0);

    const generationId = eventOf(events, 'meta')!.generationId;
    const saved = await openStore(env, generationId).load();
    expect(saved!.article.markdown).toBe(TONED);
    expect(saved!.review!.draft).toBe(DRAFT);
    expect(saved!.review!.items).toEqual(revisions);
    expect(saved!.review!.toneExcerpts).toBe(1);

    const res = await exports.default.fetch(`https://app.test/api/generations/${generationId}/chapters/2/summary`, { method: 'POST' });
    expect(res.status).toBe(200);
    const user = promptOf(upstream.gemini('summary')[0]!.body).user;
    expect(user).toContain('<current_chapter id="2">\n## 现在的组合\n\n**嘉宾:** 现在大约有五家被投公司，预计会增加到五到六家。\n</current_chapter>');
    expect(user).not.toContain('现在有五到六家被投公司');
  });

  /** 判为 dropped 却缺 replacement 的语气结论 */
  const PARTIAL = geminiJson({ checks: [{ index: 1, status: 'dropped', type: 'quantity', quote: '现在有五到六家被投公司。', evidence: 'we are at about five portfolio companies now', problem: '原话是约五家' }] });

  // 抓：经过真实 Worker 时，语气核对两次都判"语气丢了"却不给修订，文章照样发 done 并保存
  it('语气核对两次都 dropped 而缺修订：error review_failed，没有 revised 和 done，不保存，语气请求 2 次', async () => {
    const upstream = mockUpstream({ captions: CAPTIONS, geminiStream: DRAFT_STREAM, toneJson: PARTIAL });
    const save = vi.spyOn(GenerationStore.prototype, 'save');
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
    expect(events.at(-1)).toEqual({
      event: 'error',
      data: { code: 'review_failed', message: '内容核对没有完成，这次生成没有保存（对照字幕核对没有完成：模型返回的格式无效（语气清单核对判为语气丢失的条目没有给出有效修订））', partial: true },
    });
    expect(eventOf(events, 'done')).toBeUndefined();
    expect(eventOf(events, 'revised')).toBeUndefined();
    expect(upstream.gemini('tone')).toHaveLength(2);
    expect(save).not.toHaveBeenCalled();
    expect(await openStore(env, eventOf(events, 'meta')!.generationId).load()).toBeNull();
  });

  // 抓：经过真实 Worker 时，语气核对第一次缺修订、重试给出有效修订，却仍报失败或没采用重试的修订
  it('语气核对第一次缺修订、第二次正常：done，revised 带第二次的修订，保存的就是它', async () => {
    let attempt = 0;
    const upstream = mockUpstream({
      captions: CAPTIONS,
      geminiStream: DRAFT_STREAM,
      toneJson: (body) => (attempt++ === 0 ? PARTIAL : geminiJson(toneChecks(promptOf(body).user, [{ match: 'about five', ...HEDGE }]))),
    });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
    expect(events.at(-1)!.event).toBe('done');
    expect(eventOf(events, 'revised')!.markdown).toBe(TONED);
    expect(upstream.gemini('tone')).toHaveLength(2);
    expect((await openStore(env, eventOf(events, 'meta')!.generationId).load())!.article.markdown).toBe(TONED);
  });

  // 抓：语气核对漏了条目（只返回有问题的几条或什么都不给）时当成"没有问题"，没核对完的文章被保存
  it.each([
    ['缺条目', { checks: [] }],
    ['不是清单格式', { issues: [] }],
  ])('语气核对响应%s：error review_failed，没有 revised 和 done，不保存', async (_label, raw) => {
    const upstream = mockUpstream({ captions: CAPTIONS, geminiStream: DRAFT_STREAM, toneJson: geminiJson(raw) });
    const save = vi.spyOn(GenerationStore.prototype, 'save');
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
    expect(events.at(-1)).toEqual({
      event: 'error',
      data: { code: 'review_failed', message: '内容核对没有完成，这次生成没有保存（对照字幕核对没有完成：模型返回的格式无效（语气清单核对没有对每一条给出结论））', partial: true },
    });
    expect(eventOf(events, 'done')).toBeUndefined();
    expect(eventOf(events, 'revised')).toBeUndefined();
    expect(upstream.gemini('tone')).toHaveLength(1);
    expect(upstream.gemini('summary')).toHaveLength(0);
    expect(save).not.toHaveBeenCalled();
    expect(await openStore(env, eventOf(events, 'meta')!.generationId).load()).toBeNull();
  });
});
