/**
 * L1d：文章写完之后的核对阶段（revising / reviewing、revised、done.review、requirements_unmet / review_failed）。
 * 真实 index.html + main.ts，网络由 FakeBackend 逐条推送 SSE 事件。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeBackend, NO_REVIEW_CHANGES, RENDER_WAIT_MS, SUMMARY, VIDEO_URL, advance, closePage, meta, openPage, page, settle, submitWith } from './support';

let backend: FakeBackend;

beforeEach(async () => {
  await openPage();
  backend = new FakeBackend();
});
afterEach(closePage);

// —— 一篇两章的文章：初稿第一章有一处时间错位，第二章标题中英混杂；核对后两处都改了 ——

const DRAFT_DELTAS = [
  '# 对话安德森：AI 投资的下一站\n\n马克·安德森谈芯片、开源模型和创业公司的机会。',
  '\n\n## 第一章 平台变化\n\n**安德森:** 2003 年那家基金投资了三家芯片公司。',
  '\n\n## 第二章 开源 models 的成本\n\n**安德森:** 开源模型的成本大概每年下降一半。',
];

const FINAL_MD = `# 对话安德森：AI 投资的下一站

马克·安德森谈芯片、开源模型和创业公司的机会。

## 第一章 平台变化

**安德森:** 我 2003 年搬到硅谷，那家基金在之后十年里投资了三家芯片公司。

## 第二章 开源模型的成本

**安德森:** 开源模型的成本大概每年下降一半。`;

const REVISIONS = [
  {
    type: 'time',
    before: '2003 年那家基金投资了三家芯片公司。',
    after: '我 2003 年搬到硅谷，那家基金在之后十年里投资了三家芯片公司。',
    reason: '字幕里 2003 年只修饰搬家，投资发生在之后的十年里',
    evidence: 'I moved to the Valley in 2003. Over the next decade the fund backed three chip companies.',
  },
  {
    type: 'language',
    before: '开源 models 的成本',
    after: '开源模型的成本',
    reason: '章节标题中英混杂',
    evidence: 'the cost of open models probably halves every year',
  },
];

const FINAL_CHAPTERS = [
  { id: '1', title: '第一章 平台变化' },
  { id: '2', title: '第二章 开源模型的成本' },
];

function reviewedDone(overrides: Record<string, unknown> = {}) {
  return {
    chapters: FINAL_CHAPTERS,
    chars: 76,
    timing: { transcriptMs: 800, firstTokenMs: 2100, firstParagraphMs: 2600, modelDoneMs: 9000, reviewedMs: 41000, savedMs: 41100 },
    numberWarnings: [],
    model: 'gemini-main',
    review: NO_REVIEW_CHANGES,
    ...overrides,
  };
}

/** 推 stage、meta 和整篇初稿，等页面画出来 */
async function streamDraft(): Promise<void> {
  backend.stream.event('stage', { stage: 'transcript' });
  backend.stream.event('meta', meta());
  backend.stream.event('stage', { stage: 'generating' });
  for (const text of DRAFT_DELTAS) backend.stream.event('delta', { text });
  await advance(RENDER_WAIT_MS);
  expect(page.chapterTitles).toEqual(['第一章 平台变化', '第二章 开源 models 的成本']);
}

const chapterBody = (id: string) => page.chapter(id).section.querySelector('.chapter-body')?.textContent?.trim();

const reviewBox = () => page.article.querySelector<HTMLElement>('.article-review');

/** 核对记录：直接写在框里的句子、修订列表（展开状态、摘要、每条的类型 / 原句 / 修订 / 原因 / 字幕原文） */
function reviewRecord() {
  const box = reviewBox();
  if (!box) return null;
  const details = box.querySelector('details');
  return {
    afterTitle: box.previousElementSibling?.tagName,
    lines: [...box.querySelectorAll(':scope > p')].map((p) => p.textContent),
    details: details
      ? {
          open: details.open,
          summary: details.querySelector('summary')?.textContent,
          items: [...details.querySelectorAll('li')].map((li) => [
            li.querySelector('.revision-type')?.textContent,
            li.querySelector('del')?.textContent,
            li.querySelector('ins')?.textContent,
            li.querySelector('.revision-reason')?.textContent,
            li.querySelector('.revision-evidence')?.textContent,
          ]),
        }
      : null,
  };
}

describe('核对阶段的状态条', () => {
  // 抓：核对阶段沿用"正在生成文章"的文案，用户以为模型还在写；核对中 5W1H 就能点（上下文还没保存）
  it('stage: reviewing：状态条"正文已写完，正在对照字幕核对"，5W1H 仍不可点；done 后可点并写"已对照字幕核对。"', async () => {
    await submitWith(VIDEO_URL);
    await streamDraft();
    expect(page.status.text).toBe('正在生成文章 · 已用时 0 秒');

    backend.stream.event('stage', { stage: 'reviewing' });
    await settle();
    expect(page.status).toEqual({ hidden: false, tone: 'busy', text: '正文已写完，正在对照字幕核对 · 已用时 0 秒', detail: '', hasRetry: false });
    expect(page.toggles.map((b) => [b.disabled, b.title])).toEqual([
      [true, '全文核对并保存后可用'],
      [true, '全文核对并保存后可用'],
    ]);
    expect(page.stop.hidden).toBe(false);

    // 核对要几十秒：阶段文案不变，用时照常走
    await advance(37_000);
    expect(page.status.text).toBe('正文已写完，正在对照字幕核对 · 已用时 37 秒');
    expect(page.toggles.map((b) => b.disabled)).toEqual([true, true]);

    backend.stream.event('done', reviewedDone({ chapters: [{ id: '1', title: '第一章 平台变化' }, { id: '2', title: '第二章 开源 models 的成本' }] }));
    await settle();
    expect(page.status).toEqual({
      hidden: false,
      tone: 'ok',
      text: '已完成，共 2 章、76 字，用时 37 秒。已对照字幕核对。点击章节标题旁的 5W1H 查看总结。',
      detail: '',
      hasRetry: false,
    });
    expect(page.toggles.map((b) => [b.disabled, b.title])).toEqual([
      [false, '查看本章的 5W1H 总结'],
      [false, '查看本章的 5W1H 总结'],
    ]);
  });

  // 抓：revising 阶段没有自己的文案；revising → reviewing 切换后状态条没跟着变
  it('stage: revising → reviewing：状态条依次显示"正在修订"和"正在对照字幕核对"', async () => {
    await submitWith(VIDEO_URL, '不超过 1200 字');
    await streamDraft();

    backend.stream.event('stage', { stage: 'revising' });
    await settle();
    expect(page.status).toEqual({ hidden: false, tone: 'busy', text: '初稿没有满足生成要求，正在修订 · 已用时 0 秒', detail: '', hasRetry: false });
    expect(page.toggles.map((b) => b.disabled)).toEqual([true, true]);
    await advance(12_000);
    expect(page.status.text).toBe('初稿没有满足生成要求，正在修订 · 已用时 12 秒');

    backend.stream.event('stage', { stage: 'reviewing' });
    await settle();
    expect(page.status.text).toBe('正文已写完，正在对照字幕核对 · 已用时 12 秒');
  });
});

describe('revised：最终全文替换初稿', () => {
  // 抓：revised 到达后页面仍显示初稿（错句还在）；完成时用初稿重绘；章节和 5W1H 按钮还按初稿的标题；核对记录不显示或默认展开；状态条没写修订处数；5W1H 带请求体
  it('初稿被整体换成最终全文，完成后标题下方有核对记录，章节和 5W1H 按最终文章重建', async () => {
    await submitWith(VIDEO_URL);
    await streamDraft();
    expect(chapterBody('1')).toBe('安德森: 2003 年那家基金投资了三家芯片公司。');

    backend.stream.event('stage', { stage: 'reviewing' });
    backend.stream.event('revised', { markdown: FINAL_MD, revisions: REVISIONS });
    await advance(RENDER_WAIT_MS);

    // 还没 done：正文已经是最终版本，但 5W1H 仍不可点、还没有核对记录
    expect(chapterBody('1')).toBe('安德森: 我 2003 年搬到硅谷，那家基金在之后十年里投资了三家芯片公司。');
    expect(page.article.textContent).not.toContain('2003 年那家基金投资了');
    expect(page.chapterTitles).toEqual(['第一章 平台变化', '第二章 开源模型的成本']);
    expect(page.article.textContent).not.toContain('models');
    expect(page.toggles.map((b) => b.disabled)).toEqual([true, true]);
    expect(reviewBox()).toBeNull();

    backend.stream.event('done', reviewedDone({ review: { sections: 2, revisions: 2, rewritten: null, checks: [] } }));
    await settle();

    expect(page.article.dataset.state).toBe('done');
    expect(chapterBody('1')).toBe('安德森: 我 2003 年搬到硅谷，那家基金在之后十年里投资了三家芯片公司。');
    // 原句只出现在核对记录的 <del> 里，正文里没有
    expect([...page.article.querySelectorAll('section.chapter')].map((s) => s.textContent).join('')).not.toContain('2003 年那家基金投资了');
    expect(page.chapterTitles).toEqual(['第一章 平台变化', '第二章 开源模型的成本']);
    expect(page.toggles.map((b) => [b.disabled, b.getAttribute('aria-label')])).toEqual([
      [false, '第一章 平台变化：5W1H 总结'],
      [false, '第二章 开源模型的成本：5W1H 总结'],
    ]);
    expect(page.status).toEqual({
      hidden: false,
      tone: 'ok',
      text: '已完成，共 2 章、76 字，用时 0 秒。已对照字幕核对，修订 2 处。点击章节标题旁的 5W1H 查看总结。',
      detail: '',
      hasRetry: false,
    });

    const items = [
      [
        '时间',
        '2003 年那家基金投资了三家芯片公司。',
        '我 2003 年搬到硅谷，那家基金在之后十年里投资了三家芯片公司。',
        '字幕里 2003 年只修饰搬家，投资发生在之后的十年里',
        '字幕原文：I moved to the Valley in 2003. Over the next decade the fund backed three chip companies.',
      ],
      ['语言', '开源 models 的成本', '开源模型的成本', '章节标题中英混杂', '字幕原文：the cost of open models probably halves every year'],
    ];
    expect(reviewRecord()).toEqual({
      afterTitle: 'H1',
      lines: [],
      details: { open: false, summary: '对照字幕核对后修订了 2 处，点开查看原句、修订和字幕依据', items },
    });

    // 展开、收起、再展开：内容不变
    const details = reviewBox()!.querySelector('details')!;
    details.open = true;
    expect(reviewRecord()?.details).toEqual({ open: true, summary: '对照字幕核对后修订了 2 处，点开查看原句、修订和字幕依据', items });
    details.open = false;
    details.open = true;
    expect(reviewRecord()?.details?.items).toEqual(items);

    // 完成后点第 2 章（标题是修订后的）的 5W1H：只带路径参数，没有请求体
    page.chapter('2').toggle.click();
    await settle();
    expect(backend.summaries.map((c) => [c.request.url, c.request.method, c.request.body])).toEqual([['/api/generations/gen-1/chapters/2/summary', 'POST', undefined]]);
    backend.summaries[0]!.json(200, { chapterId: '2', cached: false, summary: SUMMARY });
    await settle();
    expect(page.chapter('2').panel.querySelectorAll('tr')).toHaveLength(6);

    // 再点第 1 章：同样没有请求体；核对记录不受 5W1H 影响
    page.chapter('1').toggle.click();
    await settle();
    expect(backend.summaries.map((c) => [c.request.url, c.request.body])).toEqual([
      ['/api/generations/gen-1/chapters/2/summary', undefined],
      ['/api/generations/gen-1/chapters/1/summary', undefined],
    ]);
    expect(reviewRecord()?.details?.items).toEqual(items);
  });

  // 抓：按要求修订过的事实、约束核对结果没显示，或者文案、千分位写错
  it('按要求修订 + 约束核对：核对记录写明没满足什么、字数变化和核对结果，没有修订列表', async () => {
    await submitWith(VIDEO_URL, '写给投资人，不超过 1200 字');
    await streamDraft();
    backend.stream.event('stage', { stage: 'revising' });
    await settle();
    expect(page.status.text).toBe('初稿没有满足生成要求，正在修订 · 已用时 0 秒');
    backend.stream.event('stage', { stage: 'reviewing' });
    backend.stream.event('revised', { markdown: FINAL_MD, revisions: [] });
    backend.stream.event('done', reviewedDone({ chars: 1018, review: { sections: 2, revisions: 0, rewritten: { unmet: ['全文 1,432 字，要求不超过 1,200 字'], charsBefore: 1432, charsAfter: 1018 }, checks: ['全文 1,018 字，上限 1,200 字'] } }));
    await settle();

    expect(reviewRecord()).toEqual({
      afterTitle: 'H1',
      lines: ['初稿没有满足生成要求（全文 1,432 字，要求不超过 1,200 字），已按要求修订，全文从 1,432 字改为 1,018 字。', '生成要求核对：全文 1,018 字，上限 1,200 字。'],
      details: null,
    });
    expect(page.status.text).toBe('已完成，共 2 章、1,018 字，用时 0 秒。已对照字幕核对。点击章节标题旁的 5W1H 查看总结。');
    expect(chapterBody('1')).toBe('安德森: 我 2003 年搬到硅谷，那家基金在之后十年里投资了三家芯片公司。');
  });

  // 抓：用户提了字数要求、初稿就满足时，约束核对结果没显示
  it('只有约束核对结果（没有修订、没有按要求修订）：核对记录只有一句"生成要求核对"', async () => {
    await submitWith(VIDEO_URL, '不超过 1200 字');
    await streamDraft();
    backend.stream.event('stage', { stage: 'reviewing' });
    backend.stream.event('done', reviewedDone({ review: { sections: 2, revisions: 0, rewritten: null, checks: ['全文 76 字，上限 1,200 字'] } }));
    await settle();

    expect(reviewRecord()).toEqual({ afterTitle: 'H1', lines: ['生成要求核对：全文 76 字，上限 1,200 字。'], details: null });
  });

  // 抓：没有任何修订和约束时也挂一个空的核对记录框
  it('没有修订、没有约束：不出现核对记录框', async () => {
    await submitWith(VIDEO_URL);
    await streamDraft();
    backend.stream.event('stage', { stage: 'reviewing' });
    backend.stream.event('done', reviewedDone({ chapters: [{ id: '1', title: '第一章 平台变化' }, { id: '2', title: '第二章 开源 models 的成本' }] }));
    await settle();

    expect(page.status.tone).toBe('ok');
    expect(reviewBox()).toBeNull();
    expect(page.article.querySelector('h1')?.nextElementSibling?.className).toBe('article-intro');
  });
});

describe('核对没通过', () => {
  // 抓：核对没通过时说明仍写"内容不完整"（用户以为是网络断了），或者丢掉服务端给的具体原因；文章被清空；5W1H 可点；没有"重新生成"
  it.each([
    ['requirements_unmet', 'revising', '文章没有满足生成要求里的硬性约束，修订后仍不满足（全文 1,356 字，要求不超过 1,200 字）'],
    ['review_failed', 'reviewing', '内容核对没有完成，这次生成没有保存（对照字幕核对没有完成：Gemini 模型繁忙，请稍后重试（HTTP 503））'],
  ])('error %s：保留文章，下方说明以"未通过核对："开头并带具体原因，5W1H 不可用，有"重新生成"', async (code, stage, message) => {
    await submitWith(VIDEO_URL, '不超过 1200 字');
    await streamDraft();
    backend.stream.event('stage', { stage });
    backend.stream.event('error', { code, message, partial: true });
    await settle();

    expect(page.status).toEqual({ hidden: false, tone: 'error', text: message, detail: '', hasRetry: true });
    expect(page.article.dataset.state).toBe('failed');
    expect(page.chapterTitles).toEqual(['第一章 平台变化', '第二章 开源 models 的成本']);
    expect(chapterBody('1')).toBe('安德森: 2003 年那家基金投资了三家芯片公司。');
    expect(page.incompleteNote).toBe(`未通过核对：${message}`);
    expect(page.toggles.map((b) => [b.disabled, b.title])).toEqual([
      [true, '生成未完成，章节总结不可用'],
      [true, '生成未完成，章节总结不可用'],
    ]);
    expect(reviewBox()).toBeNull();
    expect(page.article.querySelector('.caret')).toBeNull();

    // 点"重新生成"：同样的输入，旧文章和说明清掉
    page.retryButton!.click();
    await settle();
    expect(backend.generations).toHaveLength(2);
    expect(JSON.parse(String(backend.generations[1]!.request.body))).toEqual({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', instructions: '不超过 1200 字' });
    expect(page.article.children).toHaveLength(0);
    expect(page.incompleteNote).toBeNull();
  });

  // 抓：把所有失败都改成"未通过核对"，网络或模型的问题被说成核对没通过
  it.each([
    ['interrupted', '生成中断，文章不完整'],
    ['save_failed', '保存生成上下文失败，章节总结不可用'],
    ['gemini_busy', 'Gemini 模型繁忙，请稍后重试'],
  ])('其他错误（%s）在核对阶段到达：说明仍是"内容不完整："', async (code, message) => {
    await submitWith(VIDEO_URL);
    await streamDraft();
    backend.stream.event('stage', { stage: 'reviewing' });
    backend.stream.event('error', { code, message, partial: true });
    await settle();

    expect(page.incompleteNote).toBe(`内容不完整：${message}`);
    expect(page.status.text).toBe(message);
  });
});

describe('核对阶段停止', () => {
  // 抓：核对阶段点停止后页面被当成完成（5W1H 可点、状态条写"已完成"），或者初稿被清掉；停止后迟到的 revised / done 又把页面改成完成
  it('核对中点"停止生成"：中止请求，保留初稿，不显示成已完成，之后的事件不再生效', async () => {
    await submitWith(VIDEO_URL);
    await streamDraft();
    backend.stream.event('stage', { stage: 'reviewing' });
    await settle();
    const { signal } = backend.generations[0]!.request;

    page.stop.click();
    await settle();

    expect(signal.aborted).toBe(true);
    expect(page.status).toEqual({ hidden: false, tone: 'idle', text: '已停止，下方是没有核对完的初稿。', detail: '', hasRetry: true });
    expect(page.article.dataset.state).toBe('failed');
    expect(chapterBody('1')).toBe('安德森: 2003 年那家基金投资了三家芯片公司。');
    expect(page.incompleteNote).toBe('未通过核对：已停止，这篇文章没有核对完，也没有保存');
    expect(page.toggles.map((b) => b.disabled)).toEqual([true, true]);
    expect(reviewBox()).toBeNull();
    expect(page.controlsDisabled).toEqual([false, false, false, false]);

    // 流已经被中止，服务端再发什么页面都收不到；时间再走也不会变
    expect(() => backend.stream.event('revised', { markdown: FINAL_MD, revisions: REVISIONS })).toThrow();
    await advance(60_000);
    expect(page.status.tone).toBe('idle');
    expect(page.article.dataset.state).toBe('failed');
    expect(page.article.textContent).not.toContain('搬到硅谷');
  });
});

describe('重新生成和旧服务端', () => {
  // 抓：重新生成时上一篇的核对记录留在新文章上面
  it('上一篇有核对记录，再生成一次：开始时清掉，新文章没有修订时也不出现旧记录', async () => {
    await submitWith(VIDEO_URL);
    await streamDraft();
    backend.stream.event('stage', { stage: 'reviewing' });
    backend.stream.event('revised', { markdown: FINAL_MD, revisions: REVISIONS });
    backend.stream.event('done', reviewedDone({ review: { sections: 2, revisions: 2, rewritten: null, checks: ['全文 76 字，上限 1,200 字'] } }));
    await settle();
    reviewBox()!.querySelector('details')!.open = true;
    expect(reviewRecord()?.lines).toEqual(['生成要求核对：全文 76 字，上限 1,200 字。']);

    await submitWith(VIDEO_URL, '只讲开源模型');
    expect(backend.generations).toHaveLength(2);
    expect(reviewBox()).toBeNull();
    expect(page.article.children).toHaveLength(0);

    backend.stream.event('meta', meta('gen-2'));
    backend.stream.event('delta', { text: '# 第二篇：开源模型\n\n## 开源的成本\n\n**安德森:** 成本每年都在下降。' });
    backend.stream.event('stage', { stage: 'reviewing' });
    await advance(RENDER_WAIT_MS);
    expect(reviewBox()).toBeNull();
    backend.stream.event('done', reviewedDone({ chapters: [{ id: '1', title: '开源的成本' }], chars: 20, review: { sections: 1, revisions: 0, rewritten: null, checks: [] } }));
    await settle();

    expect(reviewBox()).toBeNull();
    expect(page.status.text).toBe('已完成，共 1 章、20 字，用时 0 秒。已对照字幕核对。点击章节标题旁的 5W1H 查看总结。');
    expect(page.chapterTitles).toEqual(['开源的成本']);
  });

  // 抓：旧版服务端的 done 没有 review 字段时页面报错卡住，或者照样写"已对照字幕核对"
  it('done 没有 review 字段：照常完成，状态条不写核对那句，没有核对记录', async () => {
    await submitWith(VIDEO_URL);
    await streamDraft();
    const { review: _review, ...oldDone } = reviewedDone({ chapters: [{ id: '1', title: '第一章 平台变化' }, { id: '2', title: '第二章 开源 models 的成本' }] });
    backend.stream.event('done', oldDone);
    await settle();

    expect(page.status).toEqual({ hidden: false, tone: 'ok', text: '已完成，共 2 章、76 字，用时 0 秒。点击章节标题旁的 5W1H 查看总结。', detail: '', hasRetry: false });
    expect(reviewBox()).toBeNull();
    expect(page.toggles.map((b) => b.disabled)).toEqual([false, false]);
  });
});
