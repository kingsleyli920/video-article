import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeBackend, type PendingCall, SUMMARY, VIDEO_URL, advance, closePage, openPage, page, settle, streamFullArticle, submitWith } from './support';

let backend: FakeBackend;

// 每个用例从"一篇两章的文章已生成并保存（generationId = gen-1）"开始
beforeEach(async () => {
  await openPage();
  backend = new FakeBackend();
  await submitWith(VIDEO_URL);
  await streamFullArticle(backend.stream, 'gen-1');
  expect(page.status.tone).toBe('ok');
});
afterEach(closePage);

const tableRows = (panel: HTMLElement) =>
  [...panel.querySelectorAll('tr')].map((tr) => [tr.querySelector('th')?.textContent, tr.querySelector('td')?.textContent]);

const EXPECTED_ROWS = [
  ['Who', '主持人和嘉宾'],
  ['What', '讨论公司早期如何起步'],
  ['When', '原文未明确提及'],
  ['Where', '硅谷'],
  ['Why', '验证产品方向'],
  ['How', '先做小规模试点'],
];

const summaryOk = (call: PendingCall) => call.json(200, { chapterId: '1', cached: false, summary: SUMMARY });

describe('5W1H 总结', () => {
  // 抓：点击后没有加载提示；请求带了请求体、方法不对或路径不对；空字段显示成空白；字段顺序乱
  it('点 5W1H：先显示"正在生成 5W1H 总结…"，返回后显示六行表格，空字段显示"原文未明确提及"', async () => {
    const chapter = page.chapter('1');
    chapter.toggle.click();
    await settle();

    expect(chapter.panel.hidden).toBe(false);
    expect(chapter.panel.textContent).toBe('正在生成 5W1H 总结…');
    expect(chapter.toggle.getAttribute('aria-busy')).toBe('true');
    expect(chapter.toggle.getAttribute('aria-expanded')).toBe('true');
    expect(backend.summaries).toHaveLength(1);
    const { request } = backend.summaries[0]!;
    expect(request.url).toBe('/api/generations/gen-1/chapters/1/summary');
    expect(request.method).toBe('POST');
    expect(request.body).toBeUndefined();

    summaryOk(backend.summaries[0]!);
    await settle();

    expect(tableRows(chapter.panel)).toEqual(EXPECTED_ROWS);
    expect(chapter.panel.querySelector('.summary-missing')?.textContent).toBe('原文未明确提及');
    expect(chapter.toggle.hasAttribute('aria-busy')).toBe(false);
    // 只展开被点的那一章
    expect(page.chapter('2').panel.hidden).toBe(true);
    expect(page.chapter('2').toggle.getAttribute('aria-expanded')).toBe('false');
  });

  // 抓：收起再展开时又请求一次（浪费额度、表格闪烁）
  it('再点收起、再点展开：只切换显示，不重新请求', async () => {
    const chapter = page.chapter('1');
    chapter.toggle.click();
    await settle();
    summaryOk(backend.summaries[0]!);
    await settle();

    chapter.toggle.click();
    await settle();
    expect(chapter.panel.hidden).toBe(true);
    expect(chapter.toggle.getAttribute('aria-expanded')).toBe('false');

    chapter.toggle.click();
    await settle();
    expect(chapter.panel.hidden).toBe(false);
    expect(chapter.toggle.getAttribute('aria-expanded')).toBe('true');
    expect(tableRows(chapter.panel)).toEqual(EXPECTED_ROWS);
    expect(backend.summaries).toHaveLength(1);
  });

  // 抓：加载中连点发出多次请求，或者连点把面板收起了
  it('加载中重复点击只发一次请求', async () => {
    const chapter = page.chapter('1');
    chapter.toggle.click();
    chapter.toggle.click();
    chapter.toggle.click();
    await settle();

    expect(backend.summaries).toHaveLength(1);
    expect(chapter.panel.hidden).toBe(false);
    expect(chapter.panel.textContent).toBe('正在生成 5W1H 总结…');

    summaryOk(backend.summaries[0]!);
    await settle();
    expect(tableRows(chapter.panel)).toEqual(EXPECTED_ROWS);
    expect(backend.summaries).toHaveLength(1);
  });

  // 抓：两章同时加载时互相干扰（第二章的点击被当成重复点击忽略，或结果写错章）
  it('两章先后点开：各发一次请求，结果各回各的面板', async () => {
    page.chapter('1').toggle.click();
    page.chapter('2').toggle.click();
    await settle();
    expect(backend.summaries.map((call) => call.request.url)).toEqual([
      '/api/generations/gen-1/chapters/1/summary',
      '/api/generations/gen-1/chapters/2/summary',
    ]);

    backend.summaries[1]!.json(200, {
      chapterId: '2',
      cached: true,
      summary: { who: '嘉宾', what: '讲增长', when: '2023 年', where: null, why: '市场变化', how: '扩大销售团队' },
    });
    await settle();
    expect(tableRows(page.chapter('2').panel)).toEqual([
      ['Who', '嘉宾'],
      ['What', '讲增长'],
      ['When', '2023 年'],
      ['Where', '原文未明确提及'],
      ['Why', '市场变化'],
      ['How', '扩大销售团队'],
    ]);
    expect(page.chapter('1').panel.textContent).toBe('正在生成 5W1H 总结…');

    summaryOk(backend.summaries[0]!);
    await settle();
    expect(tableRows(page.chapter('1').panel)).toEqual(EXPECTED_ROWS);
  });

  // 抓：点文章正文也触发总结请求
  it('点章节正文和标题不会发总结请求', async () => {
    page.chapter('1').section.querySelector<HTMLElement>('.chapter-body p')!.click();
    page.chapter('1').section.querySelector<HTMLElement>('h2')!.click();
    page.article.querySelector<HTMLElement>('h1')!.click();
    await settle();
    expect(backend.summaries).toHaveLength(0);
    expect(page.chapter('1').panel.hidden).toBe(true);
  });

  // 抓：失败后面板停在"正在生成"、不说原因或没有重试入口；点重试没有真正重发
  it.each<[string, (call: PendingCall) => void, string]>([
    ['503 JSON 错误', (call) => call.json(503, { error: { code: 'gemini_busy', message: 'Gemini 模型繁忙，请稍后重试' } }), 'Gemini 模型繁忙，请稍后重试'],
    ['网络错误', (call) => call.networkError(), '网络连接中断'],
  ])('%s：显示原因和"重试"，点"重试"成功后显示表格', async (_name, fail, message) => {
    const chapter = page.chapter('1');
    chapter.toggle.click();
    await settle();
    fail(backend.summaries[0]!);
    await settle();

    const error = chapter.panel.querySelector('.summary-error');
    expect(error?.firstChild?.textContent).toBe(message);
    expect(chapter.panel.querySelector('.summary-retry')?.textContent).toBe('重试');
    expect(chapter.panel.hidden).toBe(false);
    expect(chapter.toggle.hasAttribute('aria-busy')).toBe(false);
    expect(chapter.panel.querySelector('table')).toBeNull();

    chapter.panel.querySelector<HTMLButtonElement>('.summary-retry')!.click();
    await settle();
    expect(backend.summaries).toHaveLength(2);
    expect(backend.summaries[1]!.request.url).toBe('/api/generations/gen-1/chapters/1/summary');
    expect(chapter.panel.textContent).toBe('正在生成 5W1H 总结…');

    summaryOk(backend.summaries[1]!);
    await settle();
    expect(tableRows(chapter.panel)).toEqual(EXPECTED_ROWS);
    expect(chapter.panel.querySelector('.summary-error')).toBeNull();
  });

  // 抓：5W1H 请求一直不返回时面板永远停在"正在生成"，或者超时后没中止请求
  it('100 秒没有响应：显示超时文案和"重试"并中止请求，重试成功后显示表格', async () => {
    const chapter = page.chapter('1');
    chapter.toggle.click();
    await settle();
    const { signal } = backend.summaries[0]!.request;

    await advance(99_999);
    expect(chapter.panel.textContent).toBe('正在生成 5W1H 总结…');
    expect(signal.aborted).toBe(false);

    await advance(1);
    expect(signal.aborted).toBe(true);
    expect(chapter.panel.querySelector('.summary-error')?.firstChild?.textContent).toBe('长时间没有收到服务器的数据，已停止等待');
    expect(chapter.panel.querySelector('.summary-retry')?.textContent).toBe('重试');

    chapter.panel.querySelector<HTMLButtonElement>('.summary-retry')!.click();
    await settle();
    expect(backend.summaries).toHaveLength(2);
    summaryOk(backend.summaries[1]!);
    await settle();
    expect(tableRows(chapter.panel)).toEqual(EXPECTED_ROWS);
  });
});
