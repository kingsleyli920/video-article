import type { Page } from '@playwright/test';
import {
  FIXED_TIME,
  HANG,
  SAMPLE_URL,
  SUMMARY_1,
  apiError,
  deferred,
  expect,
  generationEvents,
  sseReply,
  summaryReply,
  test,
  type ApiMock,
} from './api-mock';

/** 生成一篇两章的文章（generationId = gen-1） */
async function generateArticle(page: Page, api: ApiMock): Promise<void> {
  api.queueGeneration(sseReply(generationEvents({})));
  await page.goto('/');
  await page.getByLabel('YouTube 链接').fill(SAMPLE_URL);
  await page.getByRole('button', { name: '生成文章' }).click();
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'ok');
}

const chapter = (page: Page, id: string) => page.locator(`section.chapter[data-chapter-id="${id}"]`);

/** 表格固定六行：Who/What/When/Where/Why/How */
async function expectTable(page: Page, id: string, values: string[]): Promise<void> {
  const rows = chapter(page, id).locator('.summary-table tr');
  await expect(rows.locator('th')).toHaveText(['Who', 'What', 'When', 'Where', 'Why', 'How']);
  await expect(rows.locator('td')).toHaveText(values);
}

const TABLE_1 = [
  '马克·安德森和主持人',
  '讨论 AI 为什么是新的计算平台',
  '原文未明确提及',
  '原文未明确提及',
  '大模型让软件第一次能处理模糊问题',
  '对比八十年来的计算机发展',
];

test.describe('5W1H', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(FIXED_TIME);
  });

  // 抓：请求方法或地址错误、带了请求体；加载中没有提示；表格行序错乱或空字段显示成空白/null
  test('点击 5W1H：先显示加载中，再显示六行表格，空字段写"原文未明确提及"', async ({ page, api }) => {
    await generateArticle(page, api);
    const gate = deferred();
    api.queueSummary(summaryReply('1', SUMMARY_1, { gate: gate.promise }));

    const toggle = chapter(page, '1').locator('.summary-toggle');
    await toggle.click();
    const panel = chapter(page, '1').locator('.summary-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveText('正在生成 5W1H 总结…');
    await expect(toggle).toHaveAttribute('aria-busy', 'true');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    // 加载中重复点击不发第二个请求
    await toggle.click();
    await expect(panel).toHaveText('正在生成 5W1H 总结…');

    gate.resolve();
    await expectTable(page, '1', TABLE_1);
    await expect(chapter(page, '1').locator('.summary-missing')).toHaveText(['原文未明确提及', '原文未明确提及']);
    await expect(toggle).not.toHaveAttribute('aria-busy');
    // 别的章节不受影响
    await expect(chapter(page, '2').locator('.summary-panel')).toBeHidden();
    await expect(chapter(page, '2').locator('.summary-toggle')).toHaveAttribute('aria-expanded', 'false');

    expect(api.summaries).toEqual([
      { method: 'POST', path: '/api/generations/gen-1/chapters/1/summary', postData: null, contentType: undefined },
    ]);
  });

  // 抓：收起再展开时重复请求、收起后面板仍显示或 aria-expanded 不同步
  test('收起再展开不重复请求，两章各自请求一次', async ({ page, api }) => {
    await generateArticle(page, api);
    api.queueSummary(summaryReply('1', SUMMARY_1), summaryReply('2', { ...SUMMARY_1, who: '安德森', what: '开源模型' }));

    const toggle = chapter(page, '1').locator('.summary-toggle');
    const panel = chapter(page, '1').locator('.summary-panel');
    await toggle.click();
    await expectTable(page, '1', TABLE_1);

    await toggle.click();
    await expect(panel).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(panel).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expectTable(page, '1', TABLE_1);

    await chapter(page, '2').locator('.summary-toggle').click();
    await expect(chapter(page, '2').locator('.summary-table td').nth(1)).toHaveText('开源模型');
    await expect(panel).toBeVisible();

    expect(api.summaries.map((r) => r.path)).toEqual([
      '/api/generations/gen-1/chapters/1/summary',
      '/api/generations/gen-1/chapters/2/summary',
    ]);
  });

  // 抓：失败时不显示原因或没有重试入口；重试后不重新请求或表格不出现
  test('5W1H 失败：显示原因和"重试"，重试成功后显示表格', async ({ page, api }) => {
    await generateArticle(page, api);
    api.queueSummary(apiError(503, 'gemini_busy', 'Gemini 模型繁忙，请稍后重试'), summaryReply('1', SUMMARY_1));

    const toggle = chapter(page, '1').locator('.summary-toggle');
    await toggle.click();
    const error = chapter(page, '1').locator('.summary-error');
    await expect(error).toHaveText('Gemini 模型繁忙，请稍后重试重试');
    const retry = error.getByRole('button', { name: '重试' });
    await expect(retry).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).not.toHaveAttribute('aria-busy');

    await retry.click();
    await expectTable(page, '1', TABLE_1);
    await expect(error).toHaveCount(0);
    expect(api.summaries.map((r) => r.path)).toEqual([
      '/api/generations/gen-1/chapters/1/summary',
      '/api/generations/gen-1/chapters/1/summary',
    ]);
    expect(api.summaries.every((r) => r.method === 'POST' && r.postData === null)).toBe(true);
  });

  // 抓：失败后点 5W1H 按钮（而不是重试）当成"已加载"只切换显示，再也拿不到总结
  test('5W1H 非 JSON 失败后，再点 5W1H 按钮也会重新请求', async ({ page, api }) => {
    await generateArticle(page, api);
    api.queueSummary({ status: 500, contentType: 'text/plain', body: 'oops' }, summaryReply('1', SUMMARY_1));

    const toggle = chapter(page, '1').locator('.summary-toggle');
    await toggle.click();
    await expect(chapter(page, '1').locator('.summary-error')).toHaveText('请求失败（HTTP 500）重试');
    await toggle.click();
    await expectTable(page, '1', TABLE_1);
    expect(api.summaries).toHaveLength(2);
  });
});

// 抓：5W1H 客户端超时不生效（一直加载中）或不到 100 秒就放弃；超时后没有重试入口
test('5W1H 100 秒没有响应：提示超时并可重试', async ({ page, api }) => {
  await page.clock.install({ time: FIXED_TIME });
  await page.goto('/');
  await page.clock.pauseAt(new Date(FIXED_TIME.getTime() + 60_000));
  api.queueGeneration(sseReply(generationEvents({})));
  await page.getByLabel('YouTube 链接').fill(SAMPLE_URL);
  await page.getByRole('button', { name: '生成文章' }).click();
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'ok');

  api.queueSummary(HANG, summaryReply('1', SUMMARY_1));
  await chapter(page, '1').locator('.summary-toggle').click();
  const panel = chapter(page, '1').locator('.summary-panel');
  await expect(panel).toHaveText('正在生成 5W1H 总结…');

  await page.clock.runFor(99_000);
  // 给提前超时的实现留出把错误画出来的真实时间，再断言仍在加载
  await page.waitForTimeout(300);
  await expect(panel).toHaveText('正在生成 5W1H 总结…');

  await page.clock.runFor(1_000);
  const error = panel.locator('.summary-error');
  await expect(error).toHaveText('长时间没有收到服务器的数据，已停止等待重试');
  await error.getByRole('button', { name: '重试' }).click();
  await expectTable(page, '1', TABLE_1);
  expect(api.summaries).toHaveLength(2);
});
