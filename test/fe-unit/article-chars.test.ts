import { describe, expect, it } from 'vitest';
import { buildArticle } from '../../src/client/article-view';
import { articleText, countArticleChars, parseArticle, validateArticle } from '../../src/shared/article';
import { ARTICLE_MARKDOWN } from '../fixtures/upstream';

/** 页面上真正渲染出来的文字（marked + DOMPurify + 浏览器解析），去掉界面自己加的 5W1H 按钮和所有空白 */
function pageText(markdown: string): string {
  const root = document.createElement('div');
  root.append(buildArticle(markdown, 'done'));
  for (const button of root.querySelectorAll('button.summary-toggle')) button.remove();
  return (root.textContent ?? '').replace(/\s+/g, '');
}

// 每项：[名称, Markdown, 页面上应该显示的文字（去掉空白，手写）, 字数（手数）]
const SAMPLES: [string, string, string, number][] = [
  [
    '正常文章',
    ARTICLE_MARKDOWN,
    '对话测试嘉宾：测试议题技术革命：八十年一遇当前阶段主持人:我们在第几局？嘉宾:第三年。智能经济：收入爆发商业模式主持人:收入如何？嘉宾:增长很快。',
    73,
  ],
  ['引言', '# 题\n\n导语 &amp; 说明\n\n## 章\n\n正文', '题导语&说明章正文', 9],
  [
    '表格',
    '# 季度复盘\n\n## 数据\n\n| 季度 | 营收 |\n| --- | --- |\n| Q1 | **1,200** 万 |\n| Q2 | 待定<br>下周公布 |',
    '季度复盘数据季度营收Q11,200万Q2待定下周公布',
    26,
  ],
  [
    '实体',
    '# 实体\n\n## 写法\n\n研发 &amp; 销售 &rarr; 增长&nbsp;快，&#39;引&#39;，&amp;amp;，&amp x，AT&T，&foo;',
    "实体写法研发&销售→增长快，'引'，&amp;，&ampx，AT&T，&foo;",
    40,
  ],
  [
    '行内 HTML 和图片',
    '# 排版\n\n## 行内\n\n前<br>后 <b>粗</b> H<sub>2</sub>O <span title="提示">内&amp;外</span><!-- 注释 -->，看![替代文字](http://a/b.png)图',
    '排版行内前后粗H2O内&外，看图',
    16,
  ],
  // <kbd> <code> 里的文字 marked 原样输出，没有分号的 &lt 浏览器会解码；外面的照字面显示
  ['原样输出的行内文字', '# 题\n\n## 章\n\n按 <kbd>Ctrl &amp; C</kbd>，<code>a &lt b</code>，c &lt d', '题章按Ctrl&C，a<b，c&ltd', 19],
  [
    '块级 HTML',
    '# 排版\n\n## 块级\n\n<div align="center">块内文字 &amp; 更多</div>\n\n<details><summary>摘要</summary>\n\n展开的**内容**\n\n</details>\n\n<table><tr><th>头</th><td>格</td></tr></table>',
    '排版块级块内文字&更多摘要展开的内容头格',
    20,
  ],
  [
    '列表和引用',
    '# 清单\n\n## 要点\n\n- 一级\n  - 二级 &amp;\n    1. 三级\n- [ ] 待办\n- [x] 完成\n\n> 引用 **重点**\n> > 二层 ~~旧~~',
    '清单要点一级二级&三级待办完成引用重点二层旧',
    22,
  ],
  [
    '代码和链接',
    '# 代码\n\n## 写法\n\n```\na &amp; b\n```\n\n行内 `c &lt; d`，[官网 **首页**](https://example.com)，<https://a.io/?x=1&amp;y=2>',
    '代码写法a&amp;b行内c&lt;d，官网首页，https://a.io/?x=1&amp;y=2',
    50,
  ],
  // 页面直接显示解析出的标题文本，标题里的命名实体和标签照字面出现；正文里的小标题正常渲染
  ['标题', '# 增长 &amp; 留存\n\n## 第一章 <b>重点</b>\n\n### 小节 &amp; 要点\n\n正文', '增长&amp;留存第一章<b>重点</b>小节&要点正文', 28],
  // 页面一章一章分开渲染，链接定义写在别的章节里时这一章认不到，照字面显示
  ['跨章节的引用式链接', '# 题\n\n## 一\n\n见[官网][site]\n\n## 二\n\n[site]: https://example.com\n\n正文', '题一见[官网][site]二正文', 16],
];

describe('字数和页面一致', () => {
  // 抓：字数统计和页面渲染各算各的——表格里的字漏计、实体按源码长度计、图片替代文字被计入、
  // 标签里的字漏计等，任何一种都会让"完成后显示的字数"和读者看到的文字对不上
  it.each(SAMPLES)('%s：countArticleChars 等于页面渲染出的可见文字数', (_name, markdown, text, chars) => {
    expect(validateArticle(parseArticle(markdown))).toBeNull();
    expect(pageText(markdown)).toBe(text);
    expect(pageText(markdown)).toHaveLength(chars);
    expect(articleText(markdown).replace(/\s+/g, '')).toBe(text);
    expect(countArticleChars(markdown)).toBe(chars);
  });

  // 抓：放行的排版标签里混进了页面会吞字或多出字的标签（比如 DOMPurify 升级后改了处理方式），字数悄悄对不上
  it.each(
    (
      'a abbr b bdi bdo big blockquote br caption center cite code dd del details dfn div dl dt em figcaption figure font ' +
      'h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q rp rt ruby s samp small span strike strong sub summary sup ' +
      'table tbody td tfoot th thead time tr tt u ul var wbr'
    ).split(' '),
  )('放行的排版标签 <%s>：写在行内或单独成块，标签都不产生文字，里面的字照常显示', (tag) => {
    const inline = `# 题\n\n## 章\n\n前<${tag}>字</${tag}>后`;
    expect(validateArticle(parseArticle(inline))).toBeNull();
    expect(pageText(inline)).toBe('题章前字后');
    expect(countArticleChars(inline)).toBe(5);
    const block = `# 题\n\n## 章\n\n<${tag} title="提示">字</${tag}>\n\n后`;
    expect(validateArticle(parseArticle(block))).toBeNull();
    expect(pageText(block)).toBe('题章字后');
    expect(countArticleChars(block)).toBe(4);
  });

  // 抓：拒收的范围和页面的实际行为脱节。下面这些写法在页面上留下的文字和照着 token 算出来的确实不一样，
  // 所以是拒收，不是硬算一个数
  it.each([
    ['脚本内容被整个丢掉', '前 <script>alert(1)</script> 后', '题章前后'],
    ['样式内容被整个丢掉', '<style>p { color: red }</style>\n\n后文', '题章后文'],
    ['没见过的标签被去掉，标签名不显示', '泛型 List<String> x', '题章泛型Listx'],
    ['没写完的标签把后文一起吞掉', '<div title="x\n\n后文', '题章'],
  ])('被判为无效的 HTML：%s', (_name, body, text) => {
    const markdown = `# 题\n\n## 章\n\n${body}`;
    expect(pageText(markdown)).toBe(text);
    expect(validateArticle(parseArticle(markdown))).toMatch(/^正文里有不支持的 HTML：/);
  });
});
