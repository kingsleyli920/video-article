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

  // 抓：模型编出用户没写过的约束（quote 不在原话里）也被强制执行，好好的初稿被要求压缩；
  // 或者反过来把这次提取当成"没有约束"照常保存（提取结果对不上原话，说明这次没认对，要重新提取，仍不行就失败）
  it('模型给的 quote 三次都不在用户原话里：不强制执行，重提三次后 requirements_unconfirmed，不保存', async () => {
    const save = vi.spyOn(GenerationStore.prototype, 'save');
    const upstream = mockUpstream({
      captions: CAPTIONS,
      geminiStream: DRAFT_STREAM,
      requirementsJson: geminiJson({ ...NONE, maxChars: 30, charsQuote: '不超过 30 字' }),
    });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID), instructions: '写得简短一些' });
    expect(events.map((e) => e.event)).toEqual(['stage', 'meta', 'stage', 'delta', 'delta', 'delta', 'error']);
    expect(events.at(-1)!.data).toEqual({ code: 'requirements_unconfirmed', message: '没能确认生成要求里的字数、章节等硬性约束，这次生成没有保存，请换一种说法重试（提取了 3 次，字数要求仍和原话对不上）', partial: true });
    expect(upstream.gemini('requirements')).toHaveLength(3);
    expect(upstream.gemini('rewrite')).toHaveLength(0);
    expect(upstream.gemini('review')).toHaveLength(0);
    expect(save).not.toHaveBeenCalled();
    expect(await openStore(env, eventOf(events, 'meta')!.generationId).load()).toBeNull();
  });
});

describe('约束提取确认不了（审查方反例，用户要求"不超过1500字"）', () => {
  const INSTRUCTIONS = '不超过1500字';
  /** 1604 字：标题"标题"2 + 章节标题"第一章"3 + 正文 1599 */
  const LONG = `# 标题\n\n## 第一章\n\n${'字'.repeat(1599)}`;
  /** 修订稿 1200 字：2 + 3 + 1195 */
  const FIT = `# 标题\n\n## 第一章\n\n${'字'.repeat(1195)}`;
  const WRONG_VALUE = { ...NONE, maxChars: 1600, charsQuote: '不超过1500字' };
  const GOOD = { ...NONE, maxChars: 1500, charsQuote: '不超过1500字' };

  // 抓（修复前的行为）：提取返回 {} 或 maxChars 和出处对不上时，字数上限被悄悄丢掉，1604 字的文章当成满足要求保存并发 done
  it.each([
    ['{}', {}, '模型返回的格式都无效'],
    ['maxChars=1600、出处仍是"不超过1500字"', WRONG_VALUE, '字数要求仍和原话对不上'],
  ])('三次都返回 %s：error requirements_unconfirmed，没有 done，不保存，约束提取恰好 3 次', async (_label, raw, kind) => {
    const save = vi.spyOn(GenerationStore.prototype, 'save');
    const upstream = mockUpstream({ captions: CAPTIONS, geminiStream: geminiSse([LONG]), requirementsJson: geminiJson(raw) });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID), instructions: INSTRUCTIONS });
    expect(events.at(-1)).toEqual({
      event: 'error',
      data: { code: 'requirements_unconfirmed', message: `没能确认生成要求里的字数、章节等硬性约束，这次生成没有保存，请换一种说法重试（提取了 3 次，${kind}）`, partial: true },
    });
    expect(eventOf(events, 'done')).toBeUndefined();
    expect(eventOf(events, 'revised')).toBeUndefined();
    const requests = upstream.gemini('requirements');
    expect(requests).toHaveLength(3);
    for (const r of requests) expect(promptOf(r.body).user).toBe('<user_requirements>\n不超过1500字\n</user_requirements>\n\n请提取硬性约束。');
    expect(upstream.gemini('review')).toHaveLength(0);
    expect(save).not.toHaveBeenCalled();
    expect(await openStore(env, eventOf(events, 'meta')!.generationId).load()).toBeNull();
  });

  // 抓：重新提取后仍用第一次的坏结果（没有上限），或者没有按第二次得到的正确上限修订
  it.each([
    ['{}', {}],
    ['maxChars=1600', WRONG_VALUE],
  ])('第一次 %s、第二次正确：按 1500 字上限修订后保存', async (_label, raw) => {
    const upstream = mockUpstream({
      captions: CAPTIONS,
      geminiStream: geminiSse([LONG]),
      requirementsJson: (attempt) => geminiJson(attempt === 0 ? raw : GOOD),
      rewriteStream: rewriteOf(FIT),
    });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID), instructions: INSTRUCTIONS });
    expect(upstream.gemini('requirements')).toHaveLength(2);
    expect(promptOf(upstream.gemini('rewrite')[0]!.body).user).toContain('<unmet_requirements note="程序按统一口径算出来的，以它为准">\n- 全文 1,604 字，要求不超过 1,500 字\n</unmet_requirements>');
    const done = eventOf(events, 'done')!;
    expect(done.chars).toBe(1200);
    expect(done.review.rewritten).toEqual({ unmet: ['全文 1,604 字，要求不超过 1,500 字'], charsBefore: 1604, charsAfter: 1200 });
    expect(done.review.checks).toEqual(['全文 1,200 字，上限 1,500 字']);
    const saved = await openStore(env, eventOf(events, 'meta')!.generationId).load();
    expect(saved!.article.markdown).toBe(FIT);
    expect(saved!.review!.requirements).toEqual({ maxChars: 1500, minChars: null, chaptersMin: null, chaptersMax: null, sectionsPerChapter: null, sectionTitles: [] });
  });

  // 抓：结构完整、全 0 全空的合法"没有可计算约束"被当成确认不了，纯风格要求的生成全部失败或白白重提
  it('纯风格要求（"写得口语一点，面向初学者"）：提取一次，正常 done，checks 为空', async () => {
    const upstream = mockUpstream({ captions: CAPTIONS, geminiStream: DRAFT_STREAM, requirementsJson: geminiJson(NONE) });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID), instructions: '写得口语一点，面向初学者' });
    expect(events.at(-1)!.event).toBe('done');
    expect(eventOf(events, 'done')!.review).toEqual({ sections: 2, revisions: 0, rewritten: null, checks: [] });
    expect(upstream.gemini('requirements')).toHaveLength(1);
    expect(upstream.gemini('rewrite')).toHaveLength(0);
    expect((await openStore(env, eventOf(events, 'meta')!.generationId).load())!.article.markdown).toBe(DRAFT);
  });
});
