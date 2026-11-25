import { describe, expect, it } from 'vitest';
import { countArticleChars, parseArticle, validateArticle } from '../../src/shared/article';

describe('parseArticle', () => {
  // 抓：只按 "## " 字符串切分，把代码块、引用、列表里的 ## 也当成章节
  it('只把顶层二级标题当章节，代码块、引用、列表里的 ## 不算', () => {
    const markdown = [
      '# 对话安德森：万亿美金之问',
      '',
      '## 技术革命：八十年一遇',
      '',
      '```',
      '## 这是代码',
      '```',
      '',
      '> ## 这是引用',
      '',
      '- ## 这是列表项',
      '',
      '## 智能经济：收入爆发与成本塌陷',
      '',
      '**Mark:** 回答。',
    ].join('\n');
    const article = parseArticle(markdown);
    expect(article.title).toBe('对话安德森：万亿美金之问');
    expect(article.chapters.map((c) => [c.id, c.title])).toEqual([
      ['1', '技术革命：八十年一遇'],
      ['2', '智能经济：收入爆发与成本塌陷'],
    ]);
    expect(article.chapters[0]!.markdown).toContain('## 这是代码');
    expect(article.chapters[1]!.markdown).toBe('**Mark:** 回答。');
  });

  // 抓：章节标题里带强调或行内代码时，标题文本残留 Markdown 符号
  it('章节标题取纯文本，不带强调符号', () => {
    const article = parseArticle('## **价值捕捉**：按需计费与 `token` 定价\n\n正文');
    expect(article.chapters[0]!.title).toBe('价值捕捉：按需计费与 token 定价');
  });

  // 抓：Setext 风格二级标题（下划线 ---）被漏掉
  it('Setext 风格的二级标题也识别为章节', () => {
    const article = parseArticle('监管挑战\n---\n\n正文');
    expect(article.chapters.map((c) => c.title)).toEqual(['监管挑战']);
  });

  it('第一个章节之前的非标题内容放进 intro', () => {
    const article = parseArticle('# 标题\n\n导语一段。\n\n## 第一章\n\n正文');
    expect(article.intro).toBe('导语一段。');
  });
});

describe('countArticleChars', () => {
  // 抓：提示词、计数和验收各用一套口径，同一篇文章算出不同字数
  it('标题和正文的非空白字符都计入（中英文、数字、标点），Markdown 标记和空白不计入', () => {
    const markdown = '# 标题 A\n\n## 第一章\n\n**主持人:** 你好，world 123。\n\n1. 要点：说明\n2. [链接](https://example.com)\n\n> 引用';
    // 标题A 第一章 主持人: 你好，world123。 要点：说明 链接 引用
    expect(countArticleChars(markdown)).toBe(31);
  });
});

describe('validateArticle', () => {
  it('没有二级标题章节时判为无效', () => {
    expect(validateArticle(parseArticle('# 标题\n\n只有正文。'))).toBe('没有二级标题章节');
  });

  // 抓：模型在最后一个章节标题后就停了，空章节仍被保存并开放 5W1H
  it('存在空章节时判为无效', () => {
    expect(validateArticle(parseArticle('# 标题\n\n## 第一章\n\n正文\n\n## 第二章\n'))).toBe('第 2 章缺少标题或正文');
  });

  // 抓：提示词要求一级标题，代码却不检查，没有标题的文章也被保存
  it('缺少一级标题时判为无效', () => {
    expect(validateArticle(parseArticle('## 第一章\n\n正文'))).toBe('缺少一级标题');
  });

  it('出现多个一级标题时判为无效', () => {
    expect(validateArticle(parseArticle('# 标题\n\n## 第一章\n\n正文\n\n# 又一个标题\n\n正文'))).toBe('出现 2 个一级标题');
  });

  it('结构完整时返回 null', () => {
    expect(validateArticle(parseArticle('# 标题\n\n## 第一章\n\n正文\n\n## 第二章\n\n正文'))).toBeNull();
  });
});

describe('hasReadableParagraph', () => {
  // 抓：把只有标题的 "# 对" 当成"开始可以阅读"，或者把还没写完的段落算进去
  it('只有写完、后面跟着空行、不是标题的段落才算可读正文', async () => {
    const { hasReadableParagraph } = await import('../../src/shared/article');
    expect(hasReadableParagraph('# 对')).toBe(false);
    expect(hasReadableParagraph('# 对话标题\n\n## 第一章\n\n')).toBe(false);
    expect(hasReadableParagraph('# 对话标题\n\n## 第一章\n\n**主持人:** 我们从哪')).toBe(false);
    expect(hasReadableParagraph('# 对话标题\n\n## 第一章\n\n**主持人:** 我们从哪里开始？\n\n')).toBe(true);
  });

  // 补充验收 R04、R09、R10 抓：很短的文章只有一段正文，正好是最后一块，结束后仍记为"没有可读段落"
  it('全文结束时最后一块也算完整段落；只有标题时仍然不算', async () => {
    const { hasReadableParagraph } = await import('../../src/shared/article');
    const short = '# 营收与成本\n\n## 数据说明\n\n营收为1.2亿美元，成本为1200亿美元。';
    expect(hasReadableParagraph(short)).toBe(false);
    expect(hasReadableParagraph(short, true)).toBe(true);
    expect(hasReadableParagraph('# 标题\n\n## 第一章', true)).toBe(false);
  });
});
