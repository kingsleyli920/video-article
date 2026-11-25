import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { parseArticle } from '../shared/article';

export type ArticleState = 'streaming' | 'done' | 'failed';

const RENDER_INTERVAL_MS = 80;

const BUTTON_HINT: Record<ArticleState, string> = {
  streaming: '全文生成并保存后可用',
  done: '查看本章的 5W1H 总结',
  failed: '生成未完成，章节总结不可用',
};

/** 模型输出可能被字幕内容带偏，渲染结果一律经过 DOMPurify。 */
export function markdownToHtml(markdown: string): string {
  return DOMPurify.sanitize(marked.parse(markdown, { async: false, gfm: true }));
}

/** 按共享的章节规则把 Markdown 渲染成文章：章节标题旁放 5W1H 按钮，只有 done 状态可点。 */
export function buildArticle(markdown: string, state: ArticleState): DocumentFragment {
  const { title, intro, chapters } = parseArticle(markdown);
  const fragment = document.createDocumentFragment();

  if (title) fragment.append(textElement('h1', title));
  if (intro) fragment.append(htmlBlock('article-intro', intro));

  for (const chapter of chapters) {
    const section = document.createElement('section');
    section.className = 'chapter';
    section.dataset.chapterId = chapter.id;

    const heading = document.createElement('div');
    heading.className = 'chapter-heading';
    const h2 = textElement('h2', chapter.title);
    h2.id = `chapter-${chapter.id}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'summary-toggle';
    button.textContent = '5W1H';
    button.disabled = state !== 'done';
    button.title = BUTTON_HINT[state];
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', `summary-${chapter.id}`);
    button.setAttribute('aria-label', `${chapter.title}：5W1H 总结`);
    heading.append(h2, button);

    const panel = document.createElement('div');
    panel.className = 'summary-panel';
    panel.id = `summary-${chapter.id}`;
    panel.hidden = true;

    section.append(heading, panel, htmlBlock('chapter-body', chapter.markdown));
    fragment.append(section);
  }

  if (state === 'streaming') appendCaret(fragment);
  return fragment;
}

export interface ArticleView {
  reset(): void;
  /** 生成中：合并 80ms 内的多次更新再重绘 */
  update(markdown: string): void;
  finish(markdown: string): void;
  fail(markdown: string, message: string): void;
}

export function createArticleView(root: HTMLElement): ArticleView {
  let latest = '';
  let timer: ReturnType<typeof setTimeout> | undefined;

  const paint = (state: ArticleState, note?: string) => {
    clearTimeout(timer);
    timer = undefined;
    const fragment = buildArticle(latest, state);
    if (note) {
      const p = textElement('p', note);
      p.className = 'incomplete-note';
      fragment.append(p);
    }
    root.replaceChildren(fragment);
    root.dataset.state = state;
  };

  return {
    reset() {
      clearTimeout(timer);
      timer = undefined;
      latest = '';
      root.replaceChildren();
      delete root.dataset.state;
    },
    update(markdown) {
      latest = markdown;
      timer ??= setTimeout(() => paint('streaming'), RENDER_INTERVAL_MS);
    },
    finish(markdown) {
      latest = markdown;
      paint('done');
    },
    fail(markdown, message) {
      latest = markdown;
      paint('failed', markdown ? `内容不完整：${message}` : undefined);
    },
  };
}

function textElement<K extends keyof HTMLElementTagNameMap>(tag: K, text: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}

function htmlBlock(className: string, markdown: string): HTMLDivElement {
  const div = document.createElement('div');
  div.className = className;
  div.innerHTML = markdownToHtml(markdown);
  return div;
}

function appendCaret(fragment: DocumentFragment): void {
  const blocks = fragment.querySelectorAll('h1, h2, h3, p, li');
  const caret = document.createElement('span');
  caret.className = 'caret';
  caret.setAttribute('aria-hidden', 'true');
  blocks[blocks.length - 1]?.append(caret);
}
