import { Lexer, type Token } from 'marked';
import type { ChapterRef } from './types';

export interface Chapter extends ChapterRef {
  /** 章节正文（不含二级标题本身） */
  markdown: string;
}

export interface ParsedArticle {
  title: string;
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
  const chapters: Chapter[] = [];

  for (const token of Lexer.lex(markdown)) {
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
  return { title, intro: intro.trim(), chapters };
}

/** 结构有效时返回 null，否则返回问题说明。 */
export function validateArticle(article: ParsedArticle): string | null {
  if (article.chapters.length === 0) return '没有二级标题章节';
  const empty = article.chapters.find((c) => !c.title || !c.markdown);
  if (empty) return `第 ${empty.id} 章缺少标题或正文`;
  return null;
}

function inlineText(token: Token): string {
  if ('tokens' in token && token.tokens?.length) return token.tokens.map(inlineText).join('').trim();
  return 'text' in token && typeof token.text === 'string' ? token.text : '';
}
