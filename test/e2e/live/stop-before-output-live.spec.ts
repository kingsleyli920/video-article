import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

/**
 * 抓：模型还没输出第一段（没有任何写入）时用户点停止，服务端要等到模型首个分块或心跳写入时才发现断开，
 * 期间一直占着上游请求。记录浏览器端点击时刻，和服务端日志的 clientGoneMs / stoppedMs / firstTokenMs 对照：
 * 入站请求的中止信号生效时，clientGoneMs 紧跟点击时刻，且日志里没有 firstTokenMs。会真实调用一次生成（中途停止）。
 */
test('模型还没输出时点"停止生成"：页面立即停止，没有正文', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: '填入示例视频' }).click();
  const requestStartedAt = Date.now();
  await page.getByRole('button', { name: '生成文章' }).click();

  const status = page.locator('#status');
  await expect(status).toContainText('等待模型输出', { timeout: 30_000 });
  // 确认此时还没有任何正文
  expect(((await page.locator('#article').textContent()) ?? '').length).toBe(0);
  const stopClickedAt = Date.now();
  await page.getByRole('button', { name: '停止生成' }).click();

  await expect(status).toHaveAttribute('data-tone', 'idle');
  await expect(status).toContainText('已停止生成。');
  await expect(page.locator('#article')).toBeEmpty();
  await expect(page.getByRole('button', { name: '生成文章' })).toBeEnabled();

  const timeline = {
    requestStartedAt: new Date(requestStartedAt).toISOString(),
    stopClickedAt: new Date(stopClickedAt).toISOString(),
    stopClickedAfterMs: stopClickedAt - requestStartedAt,
  };
  writeFileSync(testInfo.outputPath('stop-before-output-timeline.json'), JSON.stringify(timeline, null, 2));
  console.log(JSON.stringify(timeline));
});
