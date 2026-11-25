import { Lexer, type Token, type Tokens } from 'marked';
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
 */
export function validateArticle(article: ParsedArticle): string | null {
  if (!article.title) return '缺少一级标题';
  if (article.headingOneCount > 1) return `出现 ${article.headingOneCount} 个一级标题`;
  if (article.chapters.length === 0) return '没有二级标题章节';
  const empty = article.chapters.find((c) => !c.title || !c.markdown);
  if (empty) return `第 ${empty.id} 章缺少标题或正文`;
  return null;
}

function inlineText(token: Token): string {
  if ('tokens' in token && token.tokens?.length) return token.tokens.map(inlineText).join('').trim();
  return 'text' in token && typeof token.text === 'string' ? token.text : '';
}

/**
 * 文章的可读文本：标题和正文里实际显示的文字，不含 Markdown 标记（# ** - 1. > 等）。
 * 同样基于 marked 的词法 token，和章节识别用同一套解析。
 */
export function articleText(markdown: string): string {
  const parts: string[] = [];
  const walk = (tokens: Token[]) => {
    for (const token of tokens) {
      if (token.type === 'list') walk((token as Tokens.List).items);
      else if ('tokens' in token && token.tokens?.length) walk(token.tokens);
      else if (token.type === 'text' || token.type === 'codespan' || token.type === 'escape' || token.type === 'code') parts.push(token.text);
    }
  };
  walk(Lexer.lex(markdown));
  return parts.join('\n');
}

/**
 * 本产品统一的篇幅口径：文章标题和正文的非空白字符数。中文、英文、数字、标点都计入，
 * Markdown 标记和空白不计入；5W1H 不属于文章，不计入。提示词和验收用的都是这个口径。
 */
export function countArticleChars(markdown: string): number {
  return articleText(markdown).replace(/\s+/g, '').length;
}

