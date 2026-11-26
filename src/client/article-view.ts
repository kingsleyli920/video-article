import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { parseArticle } from '../shared/article';
import type { ArticleReview, NumberWarning, Revision, RevisionType } from '../shared/types';

/** reviewing：正文已经写完，正在核对；和 streaming 一样 5W1H 还不可用，但不再显示"还在写"的光标 */
export type ArticleState = 'streaming' | 'reviewing' | 'done' | 'failed';

const RENDER_INTERVAL_MS = 80;

const BUTTON_HINT: Record<ArticleState, string> = {
  streaming: '全文生成并保存后可用',
  reviewing: '全文核对并保存后可用',
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
  /** 正文已经写完、进入核对：去掉光标重绘；之后的 update（核对后的最终全文）也不带光标 */
  settle(): void;
  /** notices：显示在标题下方的提示（如疑似补全了残缺数字），不改正文。checked：核对记录，有内容时显示在标题下方 */
  finish(markdown: string, notices?: string[], checked?: ReviewRecord): void;
  /** label：文章下方说明的前缀，默认"内容不完整" */
  fail(markdown: string, message: string, label?: string): void;
}

/** 服务端的核对结果和采用的修订 */
export interface ReviewRecord {
  review: ArticleReview;
  revisions: Revision[];
}

const REVISION_LABEL: Record<RevisionType, string> = { time: '时间', attribution: '发言归属', quantity: '数量', unsupported: '没有依据', language: '语言' };

/**
 * 核对记录：按要求修订过、可计算约束的核对结果、对照字幕做的每一处修订（原句、改成什么、字幕依据）。
 * 最终文章和流式看到的初稿不一样时，读者能在这里看到改了哪里和为什么。没有任何内容时返回 null。
 * 全部用 textContent 写入，原句和字幕原文里的标记不会被当成 HTML。
 */
export function buildReviewRecord({ review, revisions }: ReviewRecord): HTMLElement | null {
  if (!review.rewritten && review.checks.length === 0 && revisions.length === 0) return null;
  const box = document.createElement('div');
  box.className = 'article-review';
  box.setAttribute('role', 'note');
  if (review.rewritten) {
    const { unmet, charsBefore, charsAfter } = review.rewritten;
    box.append(textElement('p', `初稿没有满足生成要求（${unmet.join('；')}），已按要求修订，全文从 ${charsBefore.toLocaleString('en-US')} 字改为 ${charsAfter.toLocaleString('en-US')} 字。`));
  }
  if (review.checks.length) box.append(textElement('p', `生成要求核对：${review.checks.join('；')}。`));
  if (revisions.length) {
    const details = document.createElement('details');
    details.append(textElement('summary', `对照字幕核对后修订了 ${revisions.length} 处，点开查看原句、修订和字幕依据`));
    const list = document.createElement('ol');
    for (const revision of revisions) {
      const item = document.createElement('li');
      const change = document.createElement('p');
      change.className = 'revision-change';
      const tag = textElement('span', REVISION_LABEL[revision.type]);
      tag.className = 'revision-type';
      // 原句和修订是 Markdown 片段：去掉加粗标记再显示，读起来和正文里一样
      const plain = (text: string) => text.replace(/\*\*/g, '');
      change.append(tag, textElement('del', plain(revision.before)), ' → ', textElement('ins', plain(revision.after) || '（删去）'));
      const reason = textElement('p', revision.reason);
      reason.className = 'revision-reason';
      const evidence = textElement('p', `字幕原文：${revision.evidence}`);
      evidence.className = 'revision-evidence';
      item.append(change, reason, evidence);
      list.append(item);
    }
    details.append(list);
    box.append(details);
  }
  return box;
}

export function createArticleView(root: HTMLElement): ArticleView {
  let latest = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let progress: 'streaming' | 'reviewing' = 'streaming';

  const paint = (state: ArticleState, note?: string, notices: string[] = [], checked?: ReviewRecord) => {
    clearTimeout(timer);
    timer = undefined;
    const fragment = buildArticle(latest, state);
    const boxes: HTMLElement[] = [];
    if (notices.length) {
      const box = document.createElement('div');
      box.className = 'article-notice';
      box.setAttribute('role', 'note');
      box.append(...notices.map((text) => textElement('p', text)));
      boxes.push(box);
    }
    const record = checked ? buildReviewRecord(checked) : null;
    if (record) boxes.push(record);
    if (boxes.length) {
      const title = fragment.querySelector('h1');
      if (title) title.after(...boxes);
      else fragment.prepend(...boxes);
    }
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
      progress = 'streaming';
      root.replaceChildren();
      delete root.dataset.state;
    },
    update(markdown) {
      latest = markdown;
      timer ??= setTimeout(() => paint(progress), RENDER_INTERVAL_MS);
    },
    settle() {
      progress = 'reviewing';
      if (latest) paint('reviewing');
    },
    finish(markdown, notices = [], checked) {
      latest = markdown;
      paint('done', undefined, notices, checked);
    },
    fail(markdown, message, label = '内容不完整') {
      latest = markdown;
      paint('failed', markdown ? `${label}：${message}` : undefined);
    },
  };
}

/** 把服务端的数字检查结果写成给读者看的一句话 */
export function numberWarningText({ time, fragment, written }: NumberWarning): string {
  const where = time ? `字幕 ${time} 附近` : '字幕里';
  return `${where}有一处数字残缺（原文"${fragment}"），文中写成了"${written.join('"、"')}"，疑似补全了残缺数字，请核对原字幕或原视频。`;
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
