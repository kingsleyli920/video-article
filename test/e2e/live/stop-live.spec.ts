import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';


/**
 * 抓：点"停止生成"后已生成的内容丢失、表单不恢复、仍可点 5W1H。
 * 记录浏览器端的绝对时间（发起、点击停止、页面显示已停止），用于和服务端日志中的
 * clientGoneMs（发现客户端离开）与 stoppedMs（上游请求终止）对照。会真实调用一次生成（中途停止）。
 */
test('生成中途点"停止生成"：保留部分正文并恢复操作', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: '填入示例视频' }).click();
  const requestStartedAt = Date.now();
  await page.getByRole('button', { name: '生成文章' }).click();

  // 等正文出现一段后再停止
  const article = page.locator('#article');
  await expect.poll(async () => (await article.textContent())?.length ?? 0, { timeout: 120_000 }).toBeGreaterThan(300);
  const stopClickedAt = Date.now();
  await page.getByRole('button', { name: '停止生成' }).click();

  const status = page.locator('#status');
  await expect(status).toHaveAttribute('data-tone', 'idle');
  await expect(status).toContainText('已停止生成');
  const stopShownAt = Date.now();

  // 部分正文保留并标为未完成；表单恢复；5W1H 不可用
  await expect(page.locator('.incomplete-note')).toHaveText('内容不完整：已停止生成');
  const partialChars = (await article.textContent())?.length ?? 0;
  expect(partialChars).toBeGreaterThan(300);
  await expect(page.locator('#submit')).toBeEnabled();
  await expect(page.getByLabel('YouTube 链接')).toBeEnabled();
  await expect(page.getByRole('button', { name: '停止生成' })).toBeHidden();
  for (const toggle of await page.locator('.summary-toggle').all()) await expect(toggle).toBeDisabled();
  await expect(status.getByRole('button', { name: '重新生成' })).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath('stopped.png'), fullPage: false });
  const timeline = {
    requestStartedAt: new Date(requestStartedAt).toISOString(),
    stopClickedAt: new Date(stopClickedAt).toISOString(),
    stopShownAt: new Date(stopShownAt).toISOString(),
    stopClickedAfterMs: stopClickedAt - requestStartedAt,
    stopShownAfterClickMs: stopShownAt - stopClickedAt,
    partialChars,
  };
  writeFileSync(testInfo.outputPath('stop-timeline.json'), JSON.stringify(timeline, null, 2));
  console.log(JSON.stringify(timeline));
});
