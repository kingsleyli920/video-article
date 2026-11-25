import { SUMMARY_FIELDS, type ChapterSummary, type SummaryField, type SummaryResponse } from '../shared/types';
import { ApiError, requestSummary } from './api';

const LABELS: Record<SummaryField, string> = { who: 'Who', what: 'What', when: 'When', where: 'Where', why: 'Why', how: 'How' };
export const MISSING_TEXT = '原文未明确提及';

/** 固定顺序、固定六行的 5W1H 表格；空值统一显示"原文未明确提及"。 */
export function renderSummaryTable(summary: ChapterSummary): HTMLTableElement {
  const table = document.createElement('table');
  table.className = 'summary-table';
  const body = table.createTBody();
  for (const field of SUMMARY_FIELDS) {
    const row = body.insertRow();
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = LABELS[field];
    const td = row.insertCell();
    const value = summary[field];
    if (value) {
      td.textContent = value;
    } else {
      const span = document.createElement('span');
      span.className = 'summary-missing';
      span.textContent = MISSING_TEXT;
      td.append(span);
    }
    row.prepend(th);
  }
  return table;
}

/**
 * 给一次生成的文章挂上 5W1H 交互：首次点击请求并展开，再点收起/展开不重复请求；
 * 同一章加载中忽略重复点击，失败时在面板里给出原因和重试。返回解绑函数。
 */
export function bindSummaries(
  root: HTMLElement,
  generationId: string,
  request: (generationId: string, chapterId: string, options: { signal: AbortSignal }) => Promise<SummaryResponse> = requestSummary,
): () => void {
  const loaded = new Set<string>();
  const loading = new Set<string>();
  // 解绑（开始新的一次生成）时中止这篇文章还在进行的 5W1H 请求，不再占用服务端
  const controller = new AbortController();

  const onClick = async (event: Event) => {
    const target = (event.target as Element | null)?.closest<HTMLButtonElement>('.summary-toggle, .summary-retry');
    const section = target?.closest<HTMLElement>('.chapter');
    const chapterId = section?.dataset.chapterId;
    if (!target || !section || !chapterId) return;
    const button = section.querySelector<HTMLButtonElement>('.summary-toggle')!;
    const panel = section.querySelector<HTMLElement>('.summary-panel')!;
    if (button.disabled || loading.has(chapterId)) return;

    if (loaded.has(chapterId)) {
      panel.hidden = !panel.hidden;
      button.setAttribute('aria-expanded', String(!panel.hidden));
      return;
    }

    loading.add(chapterId);
    button.setAttribute('aria-busy', 'true');
    button.setAttribute('aria-expanded', 'true');
    panel.hidden = false;
    panel.replaceChildren(paragraph('summary-loading', '正在生成 5W1H 总结…'));
    try {
      const { summary } = await request(generationId, chapterId, { signal: controller.signal });
      if (controller.signal.aborted) return;
      panel.replaceChildren(renderSummaryTable(summary));
      loaded.add(chapterId);
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = paragraph('summary-error', err instanceof ApiError ? err.message : '请求失败');
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'summary-retry link-button';
      retry.textContent = '重试';
      message.append(retry);
      panel.replaceChildren(message);
    } finally {
      loading.delete(chapterId);
      button.removeAttribute('aria-busy');
    }
  };

  root.addEventListener('click', onClick);
  return () => {
    root.removeEventListener('click', onClick);
    controller.abort();
  };
}

function paragraph(className: string, text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = className;
  p.textContent = text;
  return p;
}
