import { decodeHTML } from 'entities/decode';
import { Lexer, type MarkedToken, type Token } from 'marked';
import type { ChapterRef } from './types';

export interface Chapter extends ChapterRef {
  /** 章节正文（不含二级标题本身） */
  markdown: string;
}

export interface ParsedArticle {
  title: string;
  /** 顶层一级标题的个数，结构要求是恰好一个 */
  headingOneCount: number;
  /** 第一个章节之前、标题之外的内容 */
  intro: string;
  chapters: Chapter[];
}

/**
 * 用 marked 的词法 token 识别文章结构：顶层的一级标题是文章标题，顶层的二级标题开启一个章节。
 * 代码块、列表、引用里的 "## " 不会被当成章节。前后端共用这一份规则，章节 id 因此一致。
 */
export function parseArticle(markdown: string): ParsedArticle {
  let title = '';
  let intro = '';
  let headingOneCount = 0;
  const chapters: Chapter[] = [];

  for (const token of Lexer.lex(markdown)) {
    if (token.type === 'heading' && token.depth === 1) headingOneCount++;
    if (token.type === 'heading' && token.depth === 2) {
      chapters.push({ id: String(chapters.length + 1), title: inlineText(token), markdown: '' });
    } else if (token.type === 'heading' && token.depth === 1 && !title && chapters.length === 0) {
      title = inlineText(token);
    } else if (chapters.length > 0) {
      chapters[chapters.length - 1]!.markdown += token.raw;
    } else {
      intro += token.raw;
    }
  }

  for (const chapter of chapters) chapter.markdown = chapter.markdown.trim();
  return { title, headingOneCount, intro: intro.trim(), chapters };
}

/**
 * 与提示词里"程序会检查"的结构要求一一对应：一个非空的一级标题、至少一个章节、每章标题和正文非空。
 * 章节 id 按顺序生成，前后端用同一份解析代码，所以同一篇文章的 id 稳定一致。结构有效时返回 null。
 * 另外，正文里不能有字数算不准的 HTML（见 PLAIN_TAG）。
 */
export function validateArticle(article: ParsedArticle): string | null {
  if (!article.title) return '缺少一级标题';
  if (article.headingOneCount > 1) return `出现 ${article.headingOneCount} 个一级标题`;
  if (article.chapters.length === 0) return '没有二级标题章节';
  const empty = article.chapters.find((c) => !c.title || !c.markdown);
  if (empty) return `第 ${empty.id} 章缺少标题或正文`;
  // 正文里有算不准的 HTML 时拒收，不让"页面显示成功、字数却对不上"的文章存下来
  const [html] = displayedText(article).unsupported;
  if (html) return `正文里有不支持的 HTML：${html}`;
  return null;
}

function inlineText(token: Token): string {
  if ('tokens' in token && token.tokens?.length) return token.tokens.map(inlineText).join('').trim();
  return 'text' in token && typeof token.text === 'string' ? token.text : '';
}

/**
 * 原样交给浏览器的 HTML 里，只影响排版的标签：都在 DOMPurify 默认允许的范围内，按普通元素解析，
 * 标签本身不产生文字，里面的文字照常留在页面上。
 * 不在这里的标签（script、style、textarea、svg、没见过的标签等）有的连内容一起被 DOMPurify 丢掉，
 * 有的解析规则特殊，不逐个模拟，由 validateArticle 判为无效。
 */
const PLAIN_TAG =
  /^(?:a|abbr|b|bdi|bdo|big|blockquote|br|caption|center|cite|code|dd|del|details|dfn|div|dl|dt|em|figcaption|figure|font|h[1-6]|hr|i|img|ins|kbd|li|mark|ol|p|pre|q|rp|rt|ruby|s|samp|small|span|strike|strong|sub|summary|sup|table|tbody|td|tfoot|th|thead|time|tr|tt|u|ul|var|wbr)$/i;

/**
 * 依次匹配：注释；属性写法规范的起止标签（第 1 组是标签名）；其余会被浏览器当成标签或注释开头的 "<"。
 * 后面不是字母、/、!、? 的 "<" 浏览器按普通文字显示，这里不匹配。
 */
const HTML_PIECE =
  /<!---?>|<!--[\s\S]*?(?:--!?>|$)|<\/?([a-zA-Z][a-zA-Z0-9]*)(?:\s+[a-zA-Z_:][\w.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|<(?=[a-zA-Z/!?])/g;

/** marked 输出普通文字时会转义的 "&"：后面接不成 "&name;" "&#123;" "&#x1f;" 这种形式的 */
const BARE_AMPERSAND = /&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

interface DisplayedText {
  /** 页面上显示的文字，一段一项 */
  parts: string[];
  /** 算不准的 HTML 写法 */
  unsupported: string[];
}

/** 一段原样 HTML 在页面上留下的文字：去掉注释和标签，字符引用按浏览器的规则解码。 */
function rawHtmlText(html: string, out: DisplayedText): void {
  let from = 0;
  const text = (to: number) => {
    // 字符引用不会跨标签，所以一段一段解码
    if (to > from) out.parts.push(decodeHTML(html.slice(from, to)));
  };
  for (const piece of html.matchAll(HTML_PIECE)) {
    text(piece.index);
    from = piece.index + piece[0].length;
    if (piece[0].startsWith('<!--')) continue;
    const tag = piece[1];
    if (!tag || !PLAIN_TAG.test(tag)) out.unsupported.push(tag ? `<${tag}>` : html.slice(piece.index, piece.index + 20));
  }
  text(html.length);
}

/**
 * 一段 Markdown 经 marked（gfm）渲染、DOMPurify 清洗后留在页面上的文字。按 marked 的词法 token 逐个算，
 * 每种 token 的算法对应 marked 渲染器对它的输出：
 * - 普通文字：数字字符引用在词法阶段已经解码；命名引用（&amp;）原样留在 token 里，由浏览器解码。
 *   接不成引用的 "&"（"&amp x"、"AT&T"）marked 会转义成字面量；不存在的名字（&foo;）浏览器原样显示。
 * - 代码块、行内代码、自动链接：marked 把里面的 "&" 全部转义，所以是字面量，不解码。
 * - 图片：替代文字在 alt 属性里，不显示。任务列表的勾选框、分隔线、换行、链接定义同样不产生文字。
 * - 表格：表头和每个单元格。
 * - HTML（html token，以及 <pre> <code> <kbd> 里原样输出的文字）：见 rawHtmlText。
 */
function markdownText(markdown: string, out: DisplayedText): void {
  const walk = (tokens: Token[]) => {
    for (const token of tokens as MarkedToken[]) {
      switch (token.type) {
        case 'table':
          for (const cell of [...token.header, ...token.rows.flat()]) walk(cell.tokens);
          break;
        case 'list':
          walk(token.items);
          break;
        case 'code':
        case 'codespan':
          out.parts.push(token.text);
          break;
        case 'html':
          rawHtmlText(token.text, out);
          break;
        case 'image':
          break;
        case 'link':
          if (token.autolink) out.parts.push(token.text);
          else walk(token.tokens);
          break;
        case 'text':
        case 'escape':
          if ('tokens' in token && token.tokens) walk(token.tokens);
          else if ('escaped' in token && token.escaped) rawHtmlText(token.text, out);
          else out.parts.push(decodeHTML(token.text.replace(BARE_AMPERSAND, '&amp;')));
          break;
        default:
          if ('tokens' in token && token.tokens) walk(token.tokens);
      }
    }
  };
  walk(Lexer.lex(markdown));
}

/**
 * 页面（buildArticle）怎么显示，这里就怎么算：文章标题和章节标题直接显示解析出的标题文本，
 * 引言和每章正文各自交给 marked 渲染。
 */
function displayedText(article: ParsedArticle): DisplayedText {
  const out: DisplayedText = { parts: [], unsupported: [] };
  if (article.title) out.parts.push(article.title);
  markdownText(article.intro, out);
  for (const chapter of article.chapters) {
    if (chapter.title) out.parts.push(chapter.title);
    markdownText(chapter.markdown, out);
  }
  return out;
}

/**
 * 文章的可读文本：页面上实际显示的标题和正文文字，不含 Markdown 标记（# ** - 1. > 等）。
 * 同样基于 marked 的词法 token，和章节识别用同一套解析。
 */
export function articleText(markdown: string): string {
  return displayedText(parseArticle(markdown)).parts.join('\n');
}

/**
 * 本产品统一的篇幅口径：文章标题和正文的非空白字符数。中文、英文、数字、标点都计入，
 * Markdown 标记和空白不计入；5W1H 不属于文章，不计入。提示词和验收用的都是这个口径。
 */
export function countArticleChars(markdown: string): number {
  return articleText(markdown).replace(/\s+/g, '').length;
}

/**
 * 流式输出里是否已经出现第一段可以开始阅读的正文：一个已经写完（后面跟着空行）的段落里，
 * 至少有一行不是标题（# 开头）。小标题下一行紧跟正文、中间没有空行（"### 要点\n会前……"）也算。
 * 只用来测量"可读正文"的时间，标题、心跳和来源信息都不算。
 * 输出过程中最后一块可能还没写完，不算；complete 为 true 表示全文已经结束，最后一块也是完整段落
 * （很短的文章只有一段正文时，要到结束才能判出来）。
 */
export function hasReadableParagraph(markdown: string, complete = false): boolean {
  const blocks = markdown.split(/\n\s*\n/);
  return (complete ? blocks : blocks.slice(0, -1)).some((block) =>
    block.split('\n').some((line) => {
      const text = line.trim();
      return text.length > 0 && !text.startsWith('#');
    }),
  );
}
