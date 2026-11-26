/**
 * L5 全栈（受控上游）：模型繁忙时的备用模型、失败文案和重试。
 * 超时倍率 0.05：503 后固定等 1.5 秒重试一次；5W1H 主模型 2.5 秒、主备合计 4.25 秒。
 * 场景里没列出的模型一律 503，所以只列 mock-primary 的繁忙场景就是"主备都繁忙"。
 */
import { expect, test } from '@playwright/test';
import {
  chapter,
  controlsIdle,
  fillAndGenerate,
  IDLE_CONTROLS,
  recordSummaryRequests,
  statusMessage,
  summaryRows,
  summaryToggle,
  SOURCE_ROWS,
  sourceRows,
  VIDEO_URL,
} from './page';
import { modelsOf, promptOf, requestsOf, resetUpstream, setScenario } from './upstream';

const FALLBACK_ARTICLE = [
  '# 备用模型写的对话：受控上游\n\n## 第一章：开场\n\n',
  '**主持人:** 我们从哪里开始？\n\n**嘉宾:** 从第一个问题开始。\n\n',
  '## 第二章：收尾\n\n**主持人:** 还有什么？\n\n**嘉宾:** 没有了。',
];

const BUSY_MESSAGE = 'Gemini 模型繁忙，请稍后重试（HTTP 503）';

test.beforeEach(async () => {
  await resetUpstream();
});

// 抓：主模型开始输出前持续繁忙时没有整篇改用备用模型、状态条没注明实际写文章的模型；5W1H 主模型繁忙时没换备用模型
test('主模型繁忙：文章由备用模型完成并在状态条注明，5W1H 也由备用模型生成', async ({ page }) => {
  await setScenario({
    streams: { 'mock-primary': { kind: 'busy' }, 'mock-fallback': { kind: 'ok', texts: FALLBACK_ARTICLE, intervalMs: 50 } },
    summaries: {
      'mock-primary': { kind: 'busy' },
      'mock-fallback': { kind: 'ok', summary: { who: '备用模型给出的人物', what: '备用模型给出的事情', when: '', where: '', why: '', how: '备用模型给出的方式' } },
    },
  });
  await page.goto('/');
  await fillAndGenerate(page, VIDEO_URL);

  const status = page.locator('#status');
  await expect(status).toHaveAttribute('data-tone', 'ok', { timeout: 15_000 });
  expect(await statusMessage(page)).toMatch(/^已完成，共 2 章、65 字，用时 \d+ 秒。已对照字幕核对。点击章节标题旁的 5W1H 查看总结。$/);
  await expect(status.locator('.status-detail')).toHaveText('主模型繁忙，本次由 mock-fallback 生成');
  expect(await sourceRows(page)).toEqual(SOURCE_ROWS);
  await expect(page.locator('#article h1')).toHaveText('备用模型写的对话：受控上游');
  await expect(page.locator('#article h2')).toHaveText(['第一章：开场', '第二章：收尾']);
  // 主模型 503 → 重试一次仍 503 → 整篇改用备用模型
  expect(await modelsOf('stream')).toEqual(['mock-primary', 'mock-primary', 'mock-fallback']);

  const toggle = summaryToggle(page, '第二章：收尾');
  await toggle.click();
  const second = chapter(page, '2');
  await expect(second.locator('.summary-table tr')).toHaveCount(6, { timeout: 15_000 });
  expect(await summaryRows(second)).toEqual([
    ['Who', '备用模型给出的人物'],
    ['What', '备用模型给出的事情'],
    ['When', '原文未明确提及'],
    ['Where', '原文未明确提及'],
    ['Why', '原文未明确提及'],
    ['How', '备用模型给出的方式'],
  ]);
  expect(await modelsOf('summary')).toEqual(['mock-primary', 'mock-primary', 'mock-fallback']);
});

// 抓：主备都繁忙时错误文案不对或没有"重新生成"、失败后表单没恢复；"重新生成"没用上次的输入或恢复后仍失败
test('主备模型都繁忙：显示繁忙原因和"重新生成"，上游恢复后点"重新生成"成功', async ({ page }) => {
  await setScenario({ streams: { 'mock-primary': { kind: 'busy' } } });
  await page.goto('/');
  await fillAndGenerate(page, VIDEO_URL, '重试时也要带上这条要求');

  const status = page.locator('#status');
  await expect(status).toHaveAttribute('data-tone', 'error', { timeout: 15_000 });
  expect(await statusMessage(page)).toBe(BUSY_MESSAGE);
  // 来源信息在状态条下方的面板里，状态条不再附带来源；结束后面板保留
  await expect(status.locator('.status-detail')).toHaveCount(0);
  expect(await sourceRows(page)).toEqual(SOURCE_ROWS);
  const retry = status.getByRole('button', { name: '重新生成' });
  await expect(retry).toBeVisible();
  await expect(page.locator('#article')).toBeEmpty();
  await expect(page.locator('#article')).toHaveAttribute('data-state', 'failed');
  await expect.poll(() => controlsIdle(page)).toEqual(IDLE_CONTROLS);
  expect(await modelsOf('stream')).toEqual(['mock-primary', 'mock-primary', 'mock-fallback', 'mock-fallback']);

  // 上游恢复正常后点"重新生成"
  await setScenario({});
  await retry.click();
  await expect(status).toHaveAttribute('data-tone', 'ok', { timeout: 15_000 });
  expect(await statusMessage(page)).toMatch(/^已完成，共 2 章、68 字，用时 \d+ 秒。/);
  // 来源信息在状态条下方的面板里，状态条不再附带来源；结束后面板保留
  await expect(status.locator('.status-detail')).toHaveCount(0);
  expect(await sourceRows(page)).toEqual(SOURCE_ROWS);
  await expect(page.locator('#article h1')).toHaveText('对话测试嘉宾：受控上游');
  await expect(status.getByRole('button', { name: '重新生成' })).toHaveCount(0);
  await expect(summaryToggle(page, '第二章：数字')).toBeEnabled();

  const streams = await requestsOf('stream');
  expect(streams.map((r) => r.model)).toEqual(['mock-primary', 'mock-primary', 'mock-fallback', 'mock-fallback', 'mock-primary']);
  expect(promptOf(streams[4]).user).toContain('<user_requirements>\n重试时也要带上这条要求\n</user_requirements>');
  expect((await requestsOf('player')).map((r) => r.videoId)).toEqual(['mockvideo01', 'mockvideo01']);
});

// 抓：5W1H 主备都繁忙时面板不显示原因或没有"重试"、加载中重复点击发出多次请求、点"重试"不重新请求或恢复后仍不出表格
test('5W1H 主备都繁忙：面板显示原因和"重试"，上游恢复后点"重试"出现表格', async ({ page }) => {
  await setScenario({ summaries: { 'mock-primary': { kind: 'busy' } } });
  const summaryRequests = recordSummaryRequests(page);
  await page.goto('/');
  await fillAndGenerate(page, VIDEO_URL);
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'ok', { timeout: 15_000 });

  const second = chapter(page, '2');
  const toggle = summaryToggle(page, '第二章：数字');
  await toggle.click();
  await expect(second.locator('.summary-loading')).toHaveText('正在生成 5W1H 总结…');
  await expect(toggle).toHaveAttribute('aria-busy', 'true');
  await toggle.click(); // 加载中再点一次，应被忽略

  const error = second.locator('.summary-error');
  await expect(error).toBeVisible({ timeout: 15_000 });
  await expect(error).toHaveText(`${BUSY_MESSAGE}重试`);
  await expect(second.locator('.summary-table')).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(summaryRequests).toHaveLength(1);
  expect(await modelsOf('summary')).toEqual(['mock-primary', 'mock-primary', 'mock-fallback', 'mock-fallback']);

  await setScenario({ summaries: { 'mock-primary': { kind: 'ok', summary: { who: '重试后的人物', what: '重试后的事情', when: '某个时间', where: '', why: '', how: '' } } } });
  await second.getByRole('button', { name: '重试', exact: true }).click();
  await expect(second.locator('.summary-table tr')).toHaveCount(6);
  expect(await summaryRows(second)).toEqual([
    ['Who', '重试后的人物'],
    ['What', '重试后的事情'],
    ['When', '某个时间'],
    ['Where', '原文未明确提及'],
    ['Why', '原文未明确提及'],
    ['How', '原文未明确提及'],
  ]);
  await expect(error).toHaveCount(0);
  expect(summaryRequests).toHaveLength(2);
  expect(summaryRequests[1]!.path).toBe(summaryRequests[0]!.path);
  expect(await modelsOf('summary')).toEqual(['mock-primary', 'mock-primary', 'mock-fallback', 'mock-fallback', 'mock-primary']);
});
