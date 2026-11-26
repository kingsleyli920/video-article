/**
 * L1c：核对记录（buildReviewRecord）和它在文章里的位置（createArticleView.finish）。
 * 数据按真实服务端的形状：中文文章里的原句、英文字幕原文做依据、修订类型五选一。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildReviewRecord, createArticleView, type ReviewRecord } from '../../src/client/article-view';
import type { ArticleReview, Revision } from '../../src/shared/types';

const NO_REVIEW: ArticleReview = { sections: 3, revisions: 0, rewritten: null, checks: [] };

const TIME_FIX: Revision = {
  type: 'time',
  before: '2003 年那家基金投资了三家芯片公司。',
  after: '我 2003 年搬到硅谷，那家基金在之后十年里投资了三家芯片公司。',
  reason: '字幕里 2003 年只修饰搬家，投资发生在之后的十年里',
  evidence: 'I moved to the Valley in 2003. Over the next decade the fund backed three chip companies.',
};

const ATTRIBUTION_FIX: Revision = {
  type: 'attribution',
  before: '**安德森:** 软件正在吞噬世界。',
  after: '**主持人:** 你以前说过，软件正在吞噬世界。',
  reason: '这句是主持人在提问时引用嘉宾以前的话，不是嘉宾这次的回答',
  evidence: "You famously said software is eating the world. Do you still believe that?",
};

/** 渲染核对记录，返回各部分的文字，方便和手写的期望值整体比较 */
function read(record: HTMLElement) {
  const details = record.querySelector('details');
  return {
    className: record.className,
    role: record.getAttribute('role'),
    // 直接放在记录框里的说明句（按要求修订、约束核对结果）
    lines: [...record.querySelectorAll(':scope > p')].map((p) => p.textContent),
    details: details
      ? {
          open: details.open,
          summary: details.querySelector('summary')?.textContent,
          items: [...details.querySelectorAll('ol > li')].map((li) => ({
            type: li.querySelector('.revision-type')?.textContent,
            before: li.querySelector('del')?.textContent,
            after: li.querySelector('ins')?.textContent,
            change: li.querySelector('.revision-change')?.textContent,
            reason: li.querySelector('.revision-reason')?.textContent,
            evidence: li.querySelector('.revision-evidence')?.textContent,
          })),
        }
      : null,
  };
}

function build(record: ReviewRecord): HTMLElement {
  const element = buildReviewRecord(record);
  if (!element) throw new Error('应当渲染核对记录');
  return element;
}

describe('buildReviewRecord 的组合', () => {
  // 抓：没有任何修订、约束和按要求修订时也渲染一个空框（标题下方多出一块灰底）
  it('三者都没有：返回 null', () => {
    expect(buildReviewRecord({ review: NO_REVIEW, revisions: [] })).toBeNull();
  });

  // 抓：只有对照字幕的修订时多写了"按要求修订"或"生成要求核对"的句子；修订列表的摘要数字和条数对不上
  it('只有修订：只有一个收起的修订列表', () => {
    expect(read(build({ review: { ...NO_REVIEW, revisions: 2 }, revisions: [TIME_FIX, ATTRIBUTION_FIX] }))).toEqual({
      className: 'article-review',
      role: 'note',
      lines: [],
      details: {
        open: false,
        summary: '对照字幕核对后修订了 2 处，点开查看原句、修订和字幕依据',
        items: [
          {
            type: '时间',
            before: '2003 年那家基金投资了三家芯片公司。',
            after: '我 2003 年搬到硅谷，那家基金在之后十年里投资了三家芯片公司。',
            change: '时间2003 年那家基金投资了三家芯片公司。 → 我 2003 年搬到硅谷，那家基金在之后十年里投资了三家芯片公司。',
            reason: '字幕里 2003 年只修饰搬家，投资发生在之后的十年里',
            evidence: '字幕原文：I moved to the Valley in 2003. Over the next decade the fund backed three chip companies.',
          },
          {
            type: '发言归属',
            before: '**安德森:** 软件正在吞噬世界。',
            after: '**主持人:** 你以前说过，软件正在吞噬世界。',
            change: '发言归属**安德森:** 软件正在吞噬世界。 → **主持人:** 你以前说过，软件正在吞噬世界。',
            reason: '这句是主持人在提问时引用嘉宾以前的话，不是嘉宾这次的回答',
            evidence: "字幕原文：You famously said software is eating the world. Do you still believe that?",
          },
        ],
      },
    });
  });

  // 抓：约束核对结果漏显示、几条之间的分隔或句末标点写错
  it('只有约束核对：一句"生成要求核对：……。"，多条用分号连接', () => {
    const record = build({ review: { ...NO_REVIEW, checks: ['全文 1,025 字，上限 1,200 字', '共 3 章，要求正好 3 章'] }, revisions: [] });
    expect(read(record)).toEqual({
      className: 'article-review',
      role: 'note',
      lines: ['生成要求核对：全文 1,025 字，上限 1,200 字；共 3 章，要求正好 3 章。'],
      details: null,
    });
  });

  // 抓：按要求修订过却不告诉读者；字数没加千分位或前后写反；多条没满足的约束只显示第一条
  it('只有按要求修订：一句话说明没满足什么、从多少字改到多少字', () => {
    const record = build({
      review: { ...NO_REVIEW, rewritten: { unmet: ['全文 1,432 字，要求不超过 1,200 字', '全文 4 章，要求正好 3 章'], charsBefore: 1432, charsAfter: 1018 }, checks: [] },
      revisions: [],
    });
    expect(read(record).lines).toEqual(['初稿没有满足生成要求（全文 1,432 字，要求不超过 1,200 字；全文 4 章，要求正好 3 章），已按要求修订，全文从 1,432 字改为 1,018 字。']);
    expect(record.querySelector('details')).toBeNull();
  });

  // 抓：三者同时存在时顺序乱（读者先看到修订列表再看到为什么修订）或者某一项被覆盖
  it('三者都有：按要求修订 → 约束核对 → 修订列表，顺序固定', () => {
    const record = build({
      review: { sections: 3, revisions: 1, rewritten: { unmet: ['全文 12,480 字，要求不超过 10,000 字'], charsBefore: 12480, charsAfter: 8105 }, checks: ['全文 8,105 字，上限 10,000 字'] },
      revisions: [TIME_FIX],
    });
    expect([...record.children].map((el) => el.tagName)).toEqual(['P', 'P', 'DETAILS']);
    expect(read(record).lines).toEqual(['初稿没有满足生成要求（全文 12,480 字，要求不超过 10,000 字），已按要求修订，全文从 12,480 字改为 8,105 字。', '生成要求核对：全文 8,105 字，上限 10,000 字。']);
    expect(read(record).details?.summary).toBe('对照字幕核对后修订了 1 处，点开查看原句、修订和字幕依据');
  });
});

describe('修订条目的内容', () => {
  // 抓：原句、修订或字幕原文里的标记被当成 HTML 解析（XSS、加粗变成真的粗体、实体被解码）
  it('before / after / reason / evidence 里的 <img onerror>、<b>、**、&amp; 原样显示成文字，不生成任何元素', () => {
    // jsdom 不加载图片，onerror 不会真的触发，所以只看有没有生成元素；真实浏览器里的执行在 web-mock 的 review.spec.ts 里看
    const record = build({
      review: { ...NO_REVIEW, revisions: 1 },
      revisions: [
        {
          type: 'unsupported',
          before: '<img src=x onerror="__reviewXss()">研发 &amp; 销售',
          after: '<b>研发</b> & **销售**',
          reason: '字幕里没有 <script>alert(1)</script> 这家公司',
          evidence: 'R&amp;D <b>and</b> sales **grew** <img src=y onerror="__reviewXss()">',
        },
      ],
    });
    const item = read(record).details!.items[0]!;
    expect(item).toEqual({
      type: '没有依据',
      before: '<img src=x onerror="__reviewXss()">研发 &amp; 销售',
      after: '<b>研发</b> & **销售**',
      change: '没有依据<img src=x onerror="__reviewXss()">研发 &amp; 销售 → <b>研发</b> & **销售**',
      reason: '字幕里没有 <script>alert(1)</script> 这家公司',
      evidence: '字幕原文：R&amp;D <b>and</b> sales **grew** <img src=y onerror="__reviewXss()">',
    });
    // 记录框里只有界面自己建的元素
    expect(record.querySelectorAll('img, b, script, strong, em')).toHaveLength(0);
    expect([...new Set([...record.querySelectorAll('*')].map((el) => el.tagName))].sort()).toEqual(['DEL', 'DETAILS', 'INS', 'LI', 'OL', 'P', 'SPAN', 'SUMMARY']);
  });

  // 抓：删掉没有依据的内容时 after 是空串，<ins> 显示成空白，读者看不出这里是删除
  it('after 为空：修订处显示"（删去）"', () => {
    const record = build({
      review: { ...NO_REVIEW, revisions: 1 },
      revisions: [{ type: 'unsupported', before: '这家公司去年营收翻了三倍，', after: '', reason: '字幕里没有提到营收', evidence: 'we grew a lot last year, mostly from word of mouth' }],
    });
    expect(record.querySelector('del')?.textContent).toBe('这家公司去年营收翻了三倍，');
    expect(record.querySelector('ins')?.textContent).toBe('（删去）');
  });

  // 抓：类型标签缺了某一种、写成英文代码，或者两种类型共用一个标签
  it.each([
    ['time', '时间'],
    ['attribution', '发言归属'],
    ['quantity', '数量'],
    ['unsupported', '没有依据'],
    ['language', '语言'],
  ] as const)('类型 %s 的标签是"%s"', (type, label) => {
    const record = build({ review: { ...NO_REVIEW, revisions: 1 }, revisions: [{ ...TIME_FIX, type }] });
    expect(record.querySelector('.revision-type')?.textContent).toBe(label);
  });

  // 抓：修订列表默认展开，长长一串原句和字幕原文压在正文上面
  it('修订列表默认收起，点开再收起都只切换 open', () => {
    const record = build({ review: { ...NO_REVIEW, revisions: 2 }, revisions: [TIME_FIX, ATTRIBUTION_FIX] });
    const details = record.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.hasAttribute('open')).toBe(false);
    details.open = true;
    expect(record.querySelectorAll('ol > li')).toHaveLength(2);
    details.open = false;
    expect(record.querySelectorAll('ol > li')).toHaveLength(2);
  });
});

describe('createArticleView.finish 带核对记录', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const MARKDOWN = '# 对话安德森：AI 投资的下一站\n\n## 第一章 平台变化\n\n**安德森:** 我 2003 年搬到硅谷。';

  // 抓：核对记录放在正文末尾或数字提示前面；再 finish 一次（重新生成）时旧记录还在
  it('核对记录在标题下方、数字提示之后；下一次 finish 没有记录时旧记录消失', () => {
    const root = document.createElement('div');
    const view = createArticleView(root);
    view.finish(MARKDOWN, ['字幕 34:25 附近有一处数字残缺（原文"of,200"），文中写成了"1200"，疑似补全了残缺数字，请核对原字幕或原视频。'], {
      review: { ...NO_REVIEW, revisions: 1 },
      revisions: [TIME_FIX],
    });
    expect([...root.children].slice(0, 3).map((el) => el.className || el.tagName)).toEqual(['H1', 'article-notice', 'article-review']);

    view.finish(MARKDOWN, [], { review: NO_REVIEW, revisions: [] });
    expect(root.querySelector('.article-review')).toBeNull();
    view.finish(MARKDOWN, [], { review: { ...NO_REVIEW, checks: ['全文 21 字，上限 1,200 字'] }, revisions: [] });
    expect(root.querySelector('h1 + .article-review')?.textContent).toBe('生成要求核对：全文 21 字，上限 1,200 字。');
    view.finish(MARKDOWN);
    expect(root.querySelector('.article-review')).toBeNull();
  });

  // 抓：文章没有一级标题时核对记录丢失
  it('没有一级标题：核对记录放在文章最前面', () => {
    const root = document.createElement('div');
    createArticleView(root).finish('## 第一章 平台变化\n\n正文。', [], { review: { ...NO_REVIEW, checks: ['共 1 章，要求正好 1 章'] }, revisions: [] });
    expect(root.firstElementChild?.className).toBe('article-review');
  });
});
