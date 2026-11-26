/**
 * L1b 用户要求里的可计算约束：提取请求、初稿不满足时的整篇修订、修订后仍不满足时报错不保存。
 */
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenerationStore, openStore } from '../../src/worker/store';
import { geminiJson, geminiSse, OTHER_VIDEO_ID } from '../fixtures/upstream';
import { eventOf, generate, mockUpstream } from './helpers';
import { CAPTIONS, DRAFT, DRAFT_STREAM, NONE, promptOf, url } from './review-fixtures';

afterEach(() => vi.restoreAllMocks());

/** 压缩到 36 字的修订稿：5 + 4 +（3 + "2003年搬到柏林。"10）+ 5 +（3 + "现在约五家。"6） */
const SHORT = '# 柏林与基金\n\n## 柏林岁月\n\n**嘉宾:** 2003 年搬到柏林。\n\n## 现在的组合\n\n**嘉宾:** 现在约五家。';

/** 扩成三章的修订稿 */
const THREE_CHAPTERS =
  '# 柏林与基金\n\n## 柏林岁月\n\n**嘉宾:** 2003 年搬到柏林。\n\n## 基金的十年\n\n**嘉宾:** 之后十年里那家基金先后投资了 Alpha、Beta 和 Gamma。\n\n## 现在的组合\n\n**嘉宾:** 现在大约有五家被投公司。';

/** 每章三个小节的修订稿 */
const THREE_SECTIONS = [
  '# 柏林与基金',
  '## 柏林岁月',
  '### 搬家',
  '**嘉宾:** 2003 年搬到柏林。',
  '### 基金',
  '之后十年里那家基金先后投资了 Alpha、Beta 和 Gamma。',
  '### 小结',
  '一切从柏林开始。',
  '## 现在的组合',
  '### 现状',
  '现在大约有五家被投公司。',
  '### 预期',
  '预计会增加到五到六家。',
  '### 小结',
  '组合还在扩大。',
].join('\n\n');

const NAMED_SECTIONS = '# 柏林与基金\n\n## 柏林岁月\n\n### 核心观点\n\n嘉宾 2003 年搬到柏林。\n\n### 原话依据\n\n之后十年里基金先后投资了 Alpha、Beta 和 Gamma。\n\n### 给你的启发\n\n现在大约有五家被投公司。';
const EMPTY_SECTIONS = '# 柏林与基金\n\n## 柏林岁月\n\n### 核心观点\n\n### 原话依据\n\n### 给你的启发';
const SECTION_INSTRUCTIONS = '每章按核心观点、原话依据、给你的启发的顺序分三个小节';
const SECTION_REQUIREMENTS = { ...NONE, sectionsPerChapter: 3, sectionTitles: ['核心观点', '原话依据', '给你的启发'], sectionsQuote: SECTION_INSTRUCTIONS };

/** 整篇修订流式返回：分两块 */
const rewriteOf = (markdown: string) => geminiSse([markdown.slice(0, 20), markdown.slice(20)]);

describe('用户要求"不超过 N 字"', () => {
  // 抓：初稿超字数时直接保存或截断；修订请求里没告诉模型差多少；最终保存的不是修订稿
  it('初稿超出上限：stage revising，发一次修订请求，保存修订稿', async () => {
    const upstream = mockUpstream({
      captions: CAPTIONS,
      geminiStream: DRAFT_STREAM,
      requirementsJson: geminiJson({ ...NONE, maxChars: 50, charsQuote: '不超过 50 字' }),
      rewriteStream: rewriteOf(SHORT),
    });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID), instructions: '写给投资人看，全文不超过 50 字' });

    expect(events.map((e) => e.event)).toEqual(['stage', 'meta', 'stage', 'delta', 'delta', 'delta', 'stage', 'stage', 'revised', 'done']);
    expect(events.filter((e) => e.event === 'stage').map((e) => e.data)).toEqual([{ stage: 'transcript' }, { stage: 'generating' }, { stage: 'revising' }, { stage: 'reviewing' }]);

    const rewrites = upstream.gemini('rewrite');
    expect(rewrites).toHaveLength(1);
    const user = promptOf(rewrites[0]!.body).user;
    expect(user).toContain('<unmet_requirements note="程序按统一口径算出来的，以它为准">\n- 全文 61 字，要求不超过 50 字\n</unmet_requirements>');
    expect(user).toContain(`<draft>\n${DRAFT}\n</draft>`);

    expect(eventOf(events, 'revised')).toEqual({ markdown: SHORT, revisions: [] });
    const done = eventOf(events, 'done')!;
    expect(done.chars).toBe(36);
    expect(done.review).toEqual({ sections: 2, revisions: 0, rewritten: { unmet: ['全文 61 字，要求不超过 50 字'], charsBefore: 61, charsAfter: 36 }, checks: ['全文 36 字，上限 50 字'] });
    // 核对的是修订稿
    expect(upstream.gemini('review').map((r) => promptOf(r.body).user.includes('2003 年搬到柏林。'))).toEqual([true, false, true]);

    const saved = await openStore(env, eventOf(events, 'meta')!.generationId).load();
    expect(saved!.article.markdown).toBe(SHORT);
    expect(saved!.review!.draft).toBe(DRAFT);
    expect(saved!.review!.requirements).toEqual({ maxChars: 50, minChars: null, chaptersMin: null, chaptersMax: null, sectionsPerChapter: null, sectionTitles: [] });
  });

  // 抓：修订稿仍超字数时照样保存并发 done，页面显示成功
  it('修订稿仍超出上限：error requirements_unmet，带实际字数和上限，不保存，没有 done', async () => {
    const save = vi.spyOn(GenerationStore.prototype, 'save');
    const upstream = mockUpstream({
      captions: CAPTIONS,
      geminiStream: DRAFT_STREAM,
      requirementsJson: geminiJson({ ...NONE, maxChars: 50, charsQuote: '不超过 50 字' }),
      rewriteStream: rewriteOf(DRAFT),
    });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID), instructions: '全文不超过 50 字' });

    expect(events.at(-1)).toEqual({ event: 'error', data: { code: 'requirements_unmet', message: '文章没有满足生成要求里的硬性约束，修订后仍不满足（全文 61 字，要求不超过 50 字）', partial: true } });
    expect(eventOf(events, 'done')).toBeUndefined();
    expect(eventOf(events, 'revised')).toBeUndefined();
    expect(upstream.gemini('rewrite')).toHaveLength(1);
    expect(upstream.gemini('review')).toHaveLength(0);
    expect(save).not.toHaveBeenCalled();
    expect(await openStore(env, eventOf(events, 'meta')!.generationId).load()).toBeNull();
  });
});

describe('章节和小节要求', () => {
  // 抓：章节数不对时不修订；修订后 done 的章节和保存的章节还是初稿的两章
  it('"正好 3 章"而初稿只有 2 章：修订成 3 章后保存，done 列出 3 章', async () => {
    const upstream = mockUpstream({
      captions: CAPTIONS,
      geminiStream: DRAFT_STREAM,
      requirementsJson: geminiJson({ ...NONE, chaptersMin: 3, chaptersMax: 3, chaptersQuote: '分三章' }),
      rewriteStream: rewriteOf(THREE_CHAPTERS),
    });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID), instructions: '分三章写' });

    expect(promptOf(upstream.gemini('rewrite')[0]!.body).user).toContain('\n- 全文 2 章，要求正好 3 章\n');
    const done = eventOf(events, 'done')!;
    expect(done.chapters).toEqual([
      { id: '1', title: '柏林岁月' },
      { id: '2', title: '基金的十年' },
      { id: '3', title: '现在的组合' },
    ]);
    expect(done.review.checks).toEqual(['共 3 章，要求正好 3 章']);
    expect(done.review.sections).toBe(3);
    const saved = await openStore(env, eventOf(events, 'meta')!.generationId).load();
    expect(saved!.article.chapters.map((c) => c.title)).toEqual(['柏林岁月', '基金的十年', '现在的组合']);
  });

  // 抓：每章小节数不对时不修订，或者只看第一章
  it('"每章三个小节"而初稿没有小节：每一章都列进修订要求，修订后满足', async () => {
    const upstream = mockUpstream({
      captions: CAPTIONS,
      geminiStream: DRAFT_STREAM,
      requirementsJson: geminiJson({ ...NONE, sectionsPerChapter: 3, sectionsQuote: '每章三个小节' }),
      rewriteStream: rewriteOf(THREE_SECTIONS),
    });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID), instructions: '每章三个小节' });

    expect(promptOf(upstream.gemini('rewrite')[0]!.body).user).toContain('\n- 第 1 章有 0 个小节，要求每章 3 个\n- 第 2 章有 0 个小节，要求每章 3 个\n');
    const done = eventOf(events, 'done')!;
    expect(done.review.rewritten!.unmet).toEqual(['第 1 章有 0 个小节，要求每章 3 个', '第 2 章有 0 个小节，要求每章 3 个']);
    expect(done.review.checks).toEqual(['每章 3 个小节']);
    expect(eventOf(events, 'revised')!.markdown).toBe(THREE_SECTIONS);
  });

  it.each([
    ['合并标题', '# 柏林与基金\n\n## 柏林岁月\n\n### 核心观点、原话依据、给你的启发\n\n嘉宾 2003 年搬到柏林。\n\n### 其他一\n\n现在大约有五家被投公司。\n\n### 其他二\n\n预计会增加到五到六家。'],
    ['小节倒序', '# 柏林与基金\n\n## 柏林岁月\n\n### 给你的启发\n\n现在大约有五家被投公司。\n\n### 原话依据\n\n之后十年里基金先后投资了 Alpha、Beta 和 Gamma。\n\n### 核心观点\n\n嘉宾 2003 年搬到柏林。'],
    ['空小节', EMPTY_SECTIONS],
  ])('%s不能直接成功：按要求修订为独立、有序且有正文的小节后保存', async (_name, draft) => {
    const upstream = mockUpstream({
      captions: CAPTIONS,
      geminiStream: geminiSse([draft]),
      requirementsJson: geminiJson(SECTION_REQUIREMENTS),
      rewriteStream: rewriteOf(NAMED_SECTIONS),
    });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID), instructions: SECTION_INSTRUCTIONS });

    expect(upstream.gemini('rewrite')).toHaveLength(1);
    expect(eventOf(events, 'done')!.review.rewritten!.unmet.length).toBeGreaterThan(0);
    expect(eventOf(events, 'done')!.review.checks).toEqual(['每章 3 个小节：核心观点、原话依据、给你的启发']);
    expect(eventOf(events, 'revised')!.markdown).toBe(NAMED_SECTIONS);
    const saved = await openStore(env, eventOf(events, 'meta')!.generationId).load();
    expect(saved!.article.markdown).toBe(NAMED_SECTIONS);
  });

  it('修订稿仍只有空小节：报 requirements_unmet，不保存、不发 done', async () => {
    const save = vi.spyOn(GenerationStore.prototype, 'save');
    mockUpstream({
      captions: CAPTIONS,
      geminiStream: geminiSse([EMPTY_SECTIONS]),
      requirementsJson: geminiJson(SECTION_REQUIREMENTS),
      rewriteStream: rewriteOf(EMPTY_SECTIONS),
    });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID), instructions: SECTION_INSTRUCTIONS });

    expect(eventOf(events, 'error')).toMatchObject({ code: 'requirements_unmet' });
    expect(eventOf(events, 'done')).toBeUndefined();
    expect(save).not.toHaveBeenCalled();
    expect(await openStore(env, eventOf(events, 'meta')!.generationId).load()).toBeNull();
  });
});

describe('约束提取请求', () => {
  // 抓：约束提取用了主模型的高档思考（慢、贵）；或者没有用户要求时也去调模型
  it('有用户要求：发一次约束提取请求，思考档 low，请求里是去掉首尾空白的用户原话', async () => {
    const upstream = mockUpstream({ captions: CAPTIONS, geminiStream: DRAFT_STREAM });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID), instructions: '  写给投资人看  ' });
    expect(events.at(-1)!.event).toBe('done');
    const requests = upstream.gemini('requirements');
    expect(requests).toHaveLength(1);
    const prompt = promptOf(requests[0]!.body);
    expect(prompt.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });
    expect(prompt.user).toBe('<user_requirements>\n写给投资人看\n</user_requirements>\n\n请提取硬性约束。');
  });

  it('没有用户要求：不发约束提取请求', async () => {
    const upstream = mockUpstream({ captions: CAPTIONS, geminiStream: DRAFT_STREAM });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID), instructions: '   ' });
    expect(events.at(-1)!.event).toBe('done');
    expect(upstream.gemini('requirements')).toHaveLength(0);
  });

  // 抓：模型编出用户没写过的约束（quote 不在原话里）也被强制执行，好好的初稿被要求压缩
  it('模型给的 quote 不在用户原话里：不强制执行，照常 done，checks 为空', async () => {
    const upstream = mockUpstream({
      captions: CAPTIONS,
      geminiStream: DRAFT_STREAM,
      requirementsJson: geminiJson({ ...NONE, maxChars: 30, charsQuote: '不超过 30 字' }),
    });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID), instructions: '写得简短一些' });
    expect(events.map((e) => e.event)).toEqual(['stage', 'meta', 'stage', 'delta', 'delta', 'delta', 'stage', 'done']);
    expect(eventOf(events, 'done')!.review).toEqual({ sections: 2, revisions: 0, rewritten: null, checks: [] });
    expect(upstream.gemini('rewrite')).toHaveLength(0);
    const saved = await openStore(env, eventOf(events, 'meta')!.generationId).load();
    expect(saved!.article.markdown).toBe(DRAFT);
  });
});
