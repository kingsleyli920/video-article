import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/client/api';
import { buildArticle } from '../../src/client/article-view';
import { bindSummaries, renderSummaryTable } from '../../src/client/summary-panel';
import type { SummaryResponse } from '../../src/shared/types';

const SUMMARY = { who: 'Mark', what: 'AI 收入增长', when: null, where: '企业市场', why: '效率提升', how: '按 token 计费' };

function setup(request: (id: string, chapter: string) => Promise<SummaryResponse>) {
  const root = document.createElement('div');
  root.append(buildArticle('## 第一章\n\n正文\n\n## 第二章\n\n正文', 'done'));
  document.body.replaceChildren(root);
  bindSummaries(root, 'gen-1', request);
  const button = root.querySelector<HTMLButtonElement>('section[data-chapter-id="1"] .summary-toggle')!;
  const panel = root.querySelector<HTMLElement>('section[data-chapter-id="1"] .summary-panel')!;
  return { root, button, panel };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('renderSummaryTable', () => {
  // 抓：字段顺序随模型输出变化，或空值显示成空白
  it('固定六行顺序，空值显示"原文未明确提及"', () => {
    const table = renderSummaryTable(SUMMARY);
    const rows = [...table.querySelectorAll('tr')].map((tr) => [tr.querySelector('th')?.textContent, tr.querySelector('td')?.textContent]);
    expect(rows).toEqual([
      ['Who', 'Mark'],
      ['What', 'AI 收入增长'],
      ['When', '原文未明确提及'],
      ['Where', '企业市场'],
      ['Why', '效率提升'],
      ['How', '按 token 计费'],
    ]);
    expect(table.querySelector('.summary-missing')?.textContent).toBe('原文未明确提及');
  });
});

describe('bindSummaries', () => {
  // 抓：加载中重复点击发出多次请求
  it('加载中重复点击只发一次请求，只带 generationId 和章节 id', async () => {
    let resolve!: (value: SummaryResponse) => void;
    const request = vi.fn(() => new Promise<SummaryResponse>((r) => (resolve = r)));
    const { button, panel } = setup(request);

    button.click();
    button.click();
    button.click();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('gen-1', '1');
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toBe('正在生成 5W1H 总结…');
    expect(button.getAttribute('aria-busy')).toBe('true');

    resolve({ chapterId: '1', cached: false, summary: SUMMARY });
    await flush();
    expect(panel.querySelectorAll('tr')).toHaveLength(6);
    expect(button.hasAttribute('aria-busy')).toBe(false);
  });

  // 抓：收起再展开时又请求一次
  it('加载完成后再点只切换展开/收起，不重复请求', async () => {
    const request = vi.fn(async () => ({ chapterId: '1', cached: false, summary: SUMMARY }));
    const { button, panel } = setup(request);
    button.click();
    await flush();
    button.click();
    expect(panel.hidden).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    button.click();
    expect(panel.hidden).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(request).toHaveBeenCalledTimes(1);
  });

  // 抓：失败后面板一直停在"正在生成"，或者没有重试入口
  it('失败时显示原因和重试，重试成功后显示表格', async () => {
    const request = vi
      .fn<(id: string, chapter: string) => Promise<SummaryResponse>>()
      .mockRejectedValueOnce(new ApiError('generation_not_found'))
      .mockResolvedValueOnce({ chapterId: '1', cached: false, summary: SUMMARY });
    const { panel } = setup(request);
    panel.closest('section')!.querySelector<HTMLButtonElement>('.summary-toggle')!.click();
    await flush();
    expect(panel.querySelector('.summary-error')?.firstChild?.textContent).toBe('这次生成已过期或不存在，请重新生成');

    panel.querySelector<HTMLButtonElement>('.summary-retry')!.click();
    await flush();
    expect(panel.querySelectorAll('tr')).toHaveLength(6);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('按钮 disabled 时点击不发请求', () => {
    const request = vi.fn();
    const root = document.createElement('div');
    root.append(buildArticle('## 第一章\n\n正文', 'streaming'));
    bindSummaries(root, 'gen-1', request);
    root.querySelector<HTMLButtonElement>('.summary-toggle')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(request).not.toHaveBeenCalled();
  });
});
