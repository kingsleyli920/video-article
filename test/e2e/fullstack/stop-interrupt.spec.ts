/**
 * L5 全栈（受控上游）：用户停止生成、模型流中途出错。
 * 核对三处：页面（部分正文保留、控件恢复、5W1H 不可点）、模拟上游（流式请求是否被 Worker 取消）、
 * 存储（这次生成没有保存，summary 接口返回 404）。
 */
import { expect, test } from '@playwright/test';
import { controlsIdle, fillAndGenerate, IDLE_CONTROLS, recordSse, sseGenerationIds, statusMessage, VIDEO_SOURCE, VIDEO_URL } from './page';
import { modelsOf, requestsOf, resetUpstream, setScenario } from './upstream';

/** 20 段、每段间隔 300 毫秒：从头到尾约 5.7 秒 */
const LONG_ARTICLE = [
  '# 对话测试嘉宾：停止测试\n\n## 第一章：开场\n\n',
  ...Array.from({ length: 18 }, (_, i) => `**嘉宾:** 这是第${i + 1}段。\n\n`),
  '**嘉宾:** 最后一段。',
];
const LONG_ARTICLE_MS = 19 * 300;

test.beforeEach(async () => {
  await resetUpstream();
});

// 抓：停止后部分正文丢失或还在继续增长、控件不恢复、5W1H 仍可点；服务端没发现断开（上游流式请求没被取消、一直读到结束）；停止的生成被保存下来
test('停止生成：保留部分正文并恢复控件，服务端取消上游请求，这次生成没有保存', async ({ page }) => {
  await setScenario({ streams: { 'mock-primary': { kind: 'ok', texts: LONG_ARTICLE, intervalMs: 300 } } });
  await recordSse(page);
  await page.goto('/');
  await fillAndGenerate(page, VIDEO_URL);

  const article = page.locator('#article');
  await expect(article).toContainText('这是第3段。');
  const stopClickedAt = Date.now();
  await page.getByRole('button', { name: '停止生成' }).click();

  const status = page.locator('#status');
  await expect(status).toHaveAttribute('data-tone', 'idle');
  expect(await statusMessage(page)).toBe('已停止生成，已生成的内容保留在下方。');
  await expect(status.locator('.status-detail')).toHaveText(VIDEO_SOURCE);
  await expect(status.getByRole('button', { name: '重新生成' })).toBeVisible();
  await expect(page.locator('#article .incomplete-note')).toHaveText('内容不完整：已停止生成');
  await expect(article).toHaveAttribute('data-state', 'failed');
  await expect(page.locator('#article h1')).toHaveText('对话测试嘉宾：停止测试');
  await expect(article).toContainText('这是第3段。');
  await expect(article).not.toContainText('最后一段');
  const toggle = page.getByRole('button', { name: '第一章：开场：5W1H 总结', exact: true });
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute('title', '生成未完成，章节总结不可用');
  await expect.poll(() => controlsIdle(page)).toEqual(IDLE_CONTROLS);
  const textAfterStop = await article.textContent();

  // 上游：唯一的流式请求被 Worker 中途断开，没有读到自然结束
  await expect.poll(async () => (await requestsOf('stream'))[0]?.durationMs ?? null, { timeout: 10_000 }).not.toBeNull();
  const streams = await requestsOf('stream');
  expect(streams).toHaveLength(1);
  console.log(`上游流式请求：aborted=${streams[0]!.aborted}，持续 ${streams[0]!.durationMs} ms（自然结束约 ${LONG_ARTICLE_MS} ms），点停止后 ${Date.parse(streams[0]!.at) + streams[0]!.durationMs! - stopClickedAt} ms 断开`);
  expect(streams[0]!.aborted).toBe(true);
  expect(streams[0]!.durationMs!).toBeLessThan(LONG_ARTICLE_MS - 1_000);

  // 这次生成没有保存：页面 5W1H 仍不可点，直接请求 summary 接口返回 404
  await page.waitForTimeout(1_000); // 给可能的错误保存留出时间
  await expect(article).toHaveText(textAfterStop ?? '');
  await expect(toggle).toBeDisabled();
  const ids = await sseGenerationIds(page);
  expect(ids).toHaveLength(1);
  const res = await page.request.post(`/api/generations/${ids[0]}/chapters/1/summary`);
  expect(res.status()).toBe(404);
  expect(await res.json()).toEqual({ error: { code: 'generation_not_found', message: '这次生成已过期或不存在，请重新生成' } });
  expect(await requestsOf('summary')).toHaveLength(0);
  expect(await modelsOf('stream')).toEqual(['mock-primary']);
});

// 抓：模型流中途出错时丢掉已生成的内容、没标"内容不完整"、5W1H 可点；已有输出后又换备用模型重写（拼接两个模型的输出）
test('流中途 503：保留部分内容并标"内容不完整"，5W1H 不可点，不换备用模型', async ({ page }) => {
  await setScenario({
    streams: {
      'mock-primary': { kind: 'error-after', code: 503, texts: ['# 对话测试嘉宾：中途出错\n\n## 第一章：开场\n\n**主持人:** 我们从哪里开始？\n\n', '**嘉宾:** 刚说到一半'] },
      'mock-fallback': { kind: 'ok', texts: ['# 备用模型的文章\n\n## 第一章：备用\n\n备用模型写的内容。'] },
    },
  });
  await recordSse(page);
  await page.goto('/');
  await fillAndGenerate(page, VIDEO_URL);

  const status = page.locator('#status');
  await expect(status).toHaveAttribute('data-tone', 'error', { timeout: 15_000 });
  expect(await statusMessage(page)).toBe('Gemini 模型繁忙，请稍后重试（HTTP 503）');
  await expect(status.locator('.status-detail')).toHaveText(VIDEO_SOURCE);
  await expect(status.getByRole('button', { name: '重新生成' })).toBeVisible();

  const article = page.locator('#article');
  await expect(article).toHaveAttribute('data-state', 'failed');
  await expect(page.locator('#article h1')).toHaveText('对话测试嘉宾：中途出错');
  await expect(article).toContainText('刚说到一半');
  await expect(article).not.toContainText('备用模型');
  await expect(page.locator('#article .incomplete-note')).toHaveText('内容不完整：Gemini 模型繁忙，请稍后重试（HTTP 503）');
  const toggle = page.getByRole('button', { name: '第一章：开场：5W1H 总结', exact: true });
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute('title', '生成未完成，章节总结不可用');
  await expect.poll(() => controlsIdle(page)).toEqual(IDLE_CONTROLS);

  // 没有重试、没有换备用模型；没有保存
  expect(await modelsOf('stream')).toEqual(['mock-primary']);
  const ids = await sseGenerationIds(page);
  expect(ids).toHaveLength(1);
  const res = await page.request.post(`/api/generations/${ids[0]}/chapters/1/summary`);
  expect(res.status()).toBe(404);
});
