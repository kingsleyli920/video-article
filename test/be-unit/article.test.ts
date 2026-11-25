import { describe, expect, it } from 'vitest';
import { articleText, countArticleChars, parseArticle, validateArticle } from '../../src/shared/article';
import { ARTICLE_MARKDOWN } from '../fixtures/upstream';

/** 页面上显示的文字，去掉空白后的样子 */
const shown = (markdown: string) => articleText(markdown).replace(/\s+/g, '');

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

  // 抓：改了算法之后，正常文章（标题、小标题、加粗的说话人、段落）的字数跟着变
  it('正常文章的字数：测试夹具里的示例文章是 73 字', () => {
    // 11 对话测试嘉宾：测试议题｜10 技术革命：八十年一遇｜4 当前阶段｜11 主持人:我们在第几局？｜7 嘉宾:第三年。
    // 9 智能经济：收入爆发｜4 商业模式｜9 主持人:收入如何？｜8 嘉宾:增长很快。
    expect(countArticleChars(ARTICLE_MARKDOWN)).toBe(73);
  });

  // 抓：表格的单元格没有遍历，表格里的字一个都不计
  it('表格：表头和每个单元格里的文字都计入，单元格里的加粗标记不计', () => {
    const markdown = '| 季度 | 营收 |\n| --- | --- |\n| Q1 | **1,200** 万 |\n| Q2 | 待定 |';
    expect(shown(markdown)).toBe('季度营收Q11,200万Q2待定');
    expect(countArticleChars(markdown)).toBe(16);
  });

  // 抓：&amp; 按源码的 5 个字符计，页面上只显示 1 个字符
  it('命名实体按显示出来的字符计：&amp; 是 1 个字符，&nbsp; 是空白不计', () => {
    const markdown = '研发 &amp; 销售 &rarr; 增长&nbsp;快';
    expect(shown(markdown)).toBe('研发&销售→增长快');
    expect(countArticleChars(markdown)).toBe(9);
  });

  // 抓：数字实体按源码长度计；或者 marked 已经解码过的结果又被解码一遍（&#38;amp; 显示的是 &amp;）
  it('数字实体按显示出来的字符计，解码只做一遍', () => {
    expect(shown('&#39;引&#39; &#x4e2d;')).toBe("'引'中");
    expect(countArticleChars('&#39;引&#39; &#x4e2d;')).toBe(4);
    expect(shown('&#38;amp;')).toBe('&amp;');
    expect(countArticleChars('&#38;amp;')).toBe(5);
  });

  // 抓：&amp;amp; 被解码两遍算成 1 个字符；没有分号的 "&amp x"、"AT&T" 被当成实体；不存在的 &foo; 被吞掉
  it('写成实体样子但页面按原文显示的：&amp;amp; 显示 &amp;，没有分号的和不存在的名字原样显示', () => {
    expect(shown('&amp;amp;')).toBe('&amp;');
    expect(countArticleChars('&amp;amp;')).toBe(5);
    expect(shown('&amp x')).toBe('&ampx');
    expect(countArticleChars('&amp x')).toBe(5);
    expect(shown('AT&T')).toBe('AT&T');
    expect(countArticleChars('AT&T')).toBe(4);
    expect(shown('&foo;')).toBe('&foo;');
    expect(countArticleChars('&foo;')).toBe(5);
  });

  // 抓：行内 HTML 的标签、属性、注释被计入；或者标签之间的文字漏计、里面的实体不解码
  it('行内 HTML：标签、属性和注释不计，标签之间的文字照常计', () => {
    const markdown = '前<br>后 <b>粗</b> <span title="提示">内&amp;外</span><!-- 注释 -->';
    expect(shown(markdown)).toBe('前后粗内&外');
    expect(countArticleChars(markdown)).toBe(6);
  });

  // 抓：<kbd> <code> <pre> 里的行内文字 marked 不转义、原样输出，却按普通文字算——没有分号的 &lt 在这里浏览器会解码成 <
  it('行内的 <kbd> <code> 里原样输出的文字按浏览器的规则解码', () => {
    expect(shown('按 <kbd>Ctrl &amp; C</kbd>，<code>a &lt b</code>')).toBe('按Ctrl&C，a<b');
    expect(countArticleChars('按 <kbd>Ctrl &amp; C</kbd>，<code>a &lt b</code>')).toBe(11);
    // 对照：不在这类标签里时，没有分号的 &lt 照字面显示
    expect(shown('a &lt b')).toBe('a&ltb');
  });

  // 抓：块级 HTML 整块跳过，里面的可见文字漏计
  it('块级 HTML：里面的文字计入、实体解码；原样 HTML 里的 Markdown 标记页面会照字面显示，也计入', () => {
    expect(shown('<div>块内文字 &amp; 更多</div>')).toBe('块内文字&更多');
    expect(countArticleChars('<div>块内文字 &amp; 更多</div>')).toBe(7);
    expect(shown('<div>\n**不是粗体**\n</div>')).toBe('**不是粗体**');
    expect(countArticleChars('<div>\n**不是粗体**\n</div>')).toBe(8);
  });

  // 抓：图片的替代文字（在 alt 属性里，页面不显示）被计入
  it('图片：替代文字和标题都不计', () => {
    const markdown = '看![替代文字](http://a/b.png "标题")图';
    expect(shown(markdown)).toBe('看图');
    expect(countArticleChars(markdown)).toBe(2);
  });

  // 抓：链接地址被计入；自动链接里的 &amp; 被解码（marked 在自动链接里把 & 当字面量，页面显示的就是 &amp;）
  it('链接：只计显示的文字；自动链接按原文计，里面的 &amp; 不解码', () => {
    expect(shown('[官网 **首页**](https://example.com/a?b=1)')).toBe('官网首页');
    expect(countArticleChars('[官网 **首页**](https://example.com/a?b=1)')).toBe(4);
    expect(shown('<https://a.io/?x=1&amp;y=2>')).toBe('https://a.io/?x=1&amp;y=2');
    expect(countArticleChars('<https://a.io/?x=1&amp;y=2>')).toBe(25);
  });

  // 抓：代码块和行内代码里的 &amp; 被解码（代码里是字面量，页面显示 &amp; 五个字符）
  it('代码块和行内代码：里面的实体是字面量，不解码', () => {
    const markdown = '```\na &amp; b\n```\n\n行内 `c &lt; d`';
    expect(shown(markdown)).toBe('a&amp;b行内c&lt;d');
    expect(countArticleChars(markdown)).toBe(15);
  });

  // 抓：删除线、强调的标记被计入，或者里面的文字漏计
  it('删除线和强调：只计里面的文字', () => {
    expect(shown('~~旧价~~ **新价** *限时*')).toBe('旧价新价限时');
    expect(countArticleChars('~~旧价~~ **新价** *限时*')).toBe(6);
  });

  // 抓：嵌套的引用、嵌套的列表只算到第一层
  it('引用和嵌套列表：每一层的文字都计入', () => {
    expect(shown('> 引用 **重点**\n> > 二层 &amp; 更深')).toBe('引用重点二层&更深');
    expect(countArticleChars('> 引用 **重点**\n> > 二层 &amp; 更深')).toBe(9);
    expect(shown('- 一级\n  - 二级 &amp;\n    1. 三级')).toBe('一级二级&三级');
    expect(countArticleChars('- 一级\n  - 二级 &amp;\n    1. 三级')).toBe(7);
  });

  // 抓：任务列表的 [ ] [x] 被当成文字计入
  it('任务列表：勾选框不计', () => {
    expect(shown('- [ ] 待办\n- [x] 完成')).toBe('待办完成');
    expect(countArticleChars('- [ ] 待办\n- [x] 完成')).toBe(4);
  });

  // 抓：正文里的小标题走另一套算法，实体不解码
  it('正文里的三级标题和正文一样算', () => {
    expect(shown('# 题\n\n## 章\n\n### 小节 &amp; 要点\n\n正文')).toBe('题章小节&要点正文');
    expect(countArticleChars('# 题\n\n## 章\n\n### 小节 &amp; 要点\n\n正文')).toBe(9);
  });

  // 抓：文章标题和章节标题按"渲染后"算，和页面对不上。页面目前直接显示解析出的标题文本，
  // 标题里的命名实体和 HTML 标签会照字面出现（增长 &amp; 留存、第一章 <b>重点</b>），字数跟着页面走
  it('文章标题和章节标题按页面显示的标题文本计', () => {
    const markdown = '# 增长 &amp; 留存\n\n## 第一章 <b>重点</b>\n\n正文';
    expect(shown(markdown)).toBe('增长&amp;留存第一章<b>重点</b>正文');
    expect(countArticleChars(markdown)).toBe(23);
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

  // 抓：内容会被 DOMPurify 连同标签一起丢掉、或解析规则特殊的 HTML 照样保存，页面显示成功，字数却和页面对不上
  it.each([
    ['脚本', '前 <script>alert(1)</script> 后', '<script>'],
    ['样式', '<style>p { color: red }</style>\n\n后文', '<style>'],
    ['文本框', '<textarea>文本域</textarea>', '<textarea>'],
    ['矢量图', '<svg><text>字</text></svg>', '<svg>'],
    ['没见过的标签', '泛型 List<String> x', '<String>'],
    ['自定义元素', '<my-tag>自定义</my-tag>', '<my-tag>'],
    ['处理指令', '<?php echo 1 ?>', '<?php echo 1 ?>'],
    ['没写完的标签', '<div title="x\n\n后文', '<div title="x'],
  ])('正文里有算不准的 HTML（%s）时判为无效', (_name, body, html) => {
    expect(validateArticle(parseArticle(`# 标题\n\n## 第一章\n\n${body}`))).toBe(`正文里有不支持的 HTML：${html}`);
  });

  // 抓：把常见的排版标签也一起拒掉，模型多写一个 <br> 整篇文章就作废
  it('只影响排版的 HTML（换行、加粗、div、表格、注释）不影响有效性', () => {
    const body = '前<br>后 <b>粗</b> H<sub>2</sub>O\n\n<div align="center">块</div>\n\n<table><tr><td>格</td></tr></table>\n\n<!-- 注释 -->';
    expect(validateArticle(parseArticle(`# 标题\n\n## 第一章\n\n${body}`))).toBeNull();
  });

  // 抓：把页面按普通文字显示的 "<"（后面不是标签名）当成 HTML 拒掉
  it('不构成标签的 "<" 是普通文字，不影响有效性', () => {
    expect(validateArticle(parseArticle('# 标题\n\n## 第一章\n\n增速 < 3%，a<1，<主持人> 说'))).toBeNull();
    // 增速 < 3% ， a<1 ， <主持人> 说 = 2+1+2+1+3+1+5+1
    expect(countArticleChars('增速 < 3%，a<1，<主持人> 说')).toBe(16);
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

  // 补充验收 R10 抓：小标题下一行紧跟正文、中间没有空行时，整块被当成标题，全文结束也判不出可读正文
  it('小标题和正文在同一块里（中间只有换行）时，写完的这一块算可读正文；只有标题行的块不算', async () => {
    const { hasReadableParagraph } = await import('../../src/shared/article');
    expect(hasReadableParagraph('# 会议流程学习笔记\n\n## 会前\n\n### 要点\n会前准备包含三项内容。\n\n')).toBe(true);
    expect(hasReadableParagraph('# 会议流程学习笔记\n\n## 会前\n\n### 要点\n会前准备包含')).toBe(false);
    expect(hasReadableParagraph('# 标题\n\n## 会前\n### 要点\n\n', true)).toBe(false);
  });
});
