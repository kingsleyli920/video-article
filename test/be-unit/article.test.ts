import { describe, expect, it } from 'vitest';
import { parseArticle, validateArticle } from '../../src/shared/article';

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

describe('validateArticle', () => {
  it('没有二级标题章节时判为无效', () => {
    expect(validateArticle(parseArticle('# 标题\n\n只有正文。'))).toBe('没有二级标题章节');
  });

  // 抓：模型在最后一个章节标题后就停了，空章节仍被保存并开放 5W1H
  it('存在空章节时判为无效', () => {
    expect(validateArticle(parseArticle('## 第一章\n\n正文\n\n## 第二章\n'))).toBe('第 2 章缺少标题或正文');
  });

  it('结构完整时返回 null', () => {
    expect(validateArticle(parseArticle('# 标题\n\n## 第一章\n\n正文\n\n## 第二章\n\n正文'))).toBeNull();
  });
});
