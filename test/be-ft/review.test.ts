/**
 * L1b 对照字幕核对：经过完整 Worker 和 Durable Object，出站请求全部替身。
 * 覆盖事件序列、核对请求的内容、修订后的保存和 5W1H、各种丢弃、模型失败和客户端断开。
 */
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenerationStore, openStore } from '../../src/worker/store';
import { geminiJson, OTHER_VIDEO_ID } from '../fixtures/upstream';
import { billingResponse, busyResponse, eventOf, generate, hangingResponse, mockUpstream } from './helpers';
import { CAPTIONS, DRAFT, DRAFT_STREAM, modelOf, promptOf, REVIEWED, SECTION_1, SECTION_2, TIME_ISSUE, TRANSCRIPT_TEXT, url } from './review-fixtures';

afterEach(() => vi.restoreAllMocks());

const SUMMARY = { who: 'Maria Lopez', what: '搬到柏林，基金投资 Alpha、Beta、Gamma', when: '2003 年起', where: '柏林', why: '', how: '' };

/** 第一章的核对返回 TIME_ISSUE，第二章没有问题 */
const firstChapterIssue = (body: string) => geminiJson({ issues: promptOf(body).user.includes('<section>\n# 柏林与基金') ? [TIME_ISSUE] : [] });

describe('对照字幕核对：没有问题', () => {
  // 抓：没有核对阶段就保存；没问题时也发 revised；done.review 缺字段；核对请求不是每章一个，或者漏了这一章原文、整段字幕
  it('事件里有 stage: reviewing、没有 revised；每章一个核对请求，带这一章原文和整段字幕', async () => {
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
    expect(reviews).toHaveLength(2);
    expect(reviews.map((r) => modelOf(r.url))).toEqual(['test-model', 'test-model']);
    const [first, second] = reviews.map((r) => promptOf(r.body).user);
    expect(first).toContain(`<section>\n${SECTION_1}\n</section>`);
    expect(second).toContain(`<section>\n${SECTION_2}\n</section>`);
    expect(first).not.toContain('现在有五到六家被投公司');
    expect(second).not.toContain('那家基金投资了');
    for (const user of [first, second]) expect(user).toContain(`<transcript>\n${TRANSCRIPT_TEXT}\n</transcript>`);
    // 核对用主模型和它的思考档
    expect(reviews.map((r) => promptOf(r.body).generationConfig.thinkingConfig)).toEqual([{ thinkingLevel: 'high' }, { thinkingLevel: 'high' }]);

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
  it.each([
    ['evidence 不在字幕里', { ...TIME_ISSUE, evidence: 'The fund invested in Alpha, Beta and Gamma back in 2003' }],
    ['quote 在这一章里找不到', { ...TIME_ISSUE, quote: '2004 年那家基金投资了 Alpha、Beta 和 Gamma。' }],
    ['quote 在这一章里出现两次', { ...TIME_ISSUE, quote: '基金', replacement: '基金会' }],
  ])('%s：文章不变，没有 revised，照常 done 并保存初稿', async (_label, issue) => {
    mockUpstream({ captions: CAPTIONS, geminiStream: DRAFT_STREAM, reviewJson: (body) => geminiJson({ issues: promptOf(body).user.includes('<section>\n# 柏林与基金') ? [issue] : [] }) });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
    expect(events.map((e) => e.event)).toEqual(['stage', 'meta', 'stage', 'delta', 'delta', 'delta', 'stage', 'done']);
    expect(eventOf(events, 'done')!.review).toEqual({ sections: 2, revisions: 0, rewritten: null, checks: [] });
    const saved = await openStore(env, eventOf(events, 'meta')!.generationId).load();
    expect(saved!.article.markdown).toBe(DRAFT);
    expect(saved!.review).not.toHaveProperty('draft');
  });
});

describe('对照字幕核对：模型失败', () => {
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
    // 每章：主模型两次（503 重试一次），再换备用模型。先失败的那一章让整次核对失败时，另一章的备用模型第二次请求
    // 还在 1.5 秒的重试间隔里；实测这一次请求不会再发出（请求上下文结束后定时器不再触发），所以备用模型是 3 或 4 次
    const models = upstream.gemini('review').map((r) => modelOf(r.url));
    expect(models.filter((m) => m === 'test-model')).toHaveLength(4);
    expect(models.filter((m) => m === 'test-fallback').length).toBeGreaterThanOrEqual(3);
    expect(models).toHaveLength(models.filter((m) => m === 'test-model' || m === 'test-fallback').length);
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
  it('核对时 402：error gemini_billing，每章只请求一次，不换备用模型', async () => {
    const upstream = mockUpstream({ captions: CAPTIONS, geminiStream: DRAFT_STREAM, geminiOverride: ({ purpose }) => (purpose === 'review' ? billingResponse() : undefined) });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
    expect(events.at(-1)).toEqual({ event: 'error', data: { code: 'gemini_billing', message: 'Gemini 账户的预付额度已用完，暂时无法生成', partial: true } });
    expect(upstream.gemini('review').map((r) => modelOf(r.url))).toEqual(['test-model', 'test-model']);
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
    ]);
    expect(requests.filter(([model]) => model === 'test-fallback')).toEqual([
      ['test-fallback', { thinkingLevel: 'low' }],
      ['test-fallback', { thinkingLevel: 'low' }],
    ]);
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
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    expect(signals.map((s) => s.aborted)).toEqual([false, false]);

    await reader.cancel('user closed the tab');
    await vi.waitFor(() => expect(signals.map((s) => s.aborted)).toEqual([true, true]), { timeout: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(save).not.toHaveBeenCalled();
    expect(await openStore(env, generationId).load()).toBeNull();
  });
});
