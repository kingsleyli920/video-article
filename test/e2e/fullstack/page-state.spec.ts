/**
 * L5 全栈（受控上游）：刷新后的初始状态、YouTube 拦截。
 */
import { expect, test } from '@playwright/test';
import { chapter, controlsIdle, fillAndGenerate, IDLE_CONTROLS, statusMessage, summaryToggle, VIDEO_URL } from './page';
import { resetUpstream, setScenario, upstreamRequests } from './upstream';

test.beforeEach(async () => {
  await resetUpstream();
});

// 抓：刷新后残留上一次的文章、状态条、5W1H 面板或表单输入，表单仍处于锁定状态；刷新后不能再次生成
test('刷新页面后回到干净的初始状态，并能再次生成', async ({ page }) => {
  await page.goto('/');
  await fillAndGenerate(page, VIDEO_URL, '刷新前的要求');
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'ok', { timeout: 15_000 });
  await summaryToggle(page, '第二章：数字').click();
  await expect(chapter(page, '2').locator('.summary-table tr')).toHaveCount(6);

  await page.reload();
  await expect(page.locator('#status')).toBeHidden();
  await expect(page.locator('#status')).toBeEmpty();
  await expect(page.locator('#article')).toBeEmpty();
  await expect(page.locator('#article')).not.toHaveAttribute('data-state');
  await expect(page.getByLabel('YouTube 链接')).toHaveValue('');
  await expect(page.getByLabel('生成要求')).toHaveValue('');
  expect(await controlsIdle(page)).toEqual(IDLE_CONTROLS);

  // 刷新后再生成一次：正常完成，5W1H 是这次的新面板（未展开）
  await fillAndGenerate(page, VIDEO_URL);
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'ok', { timeout: 15_000 });
  await expect(page.locator('#article h1')).toHaveText('对话测试嘉宾：受控上游');
  await expect(page.locator('#article .summary-table')).toHaveCount(0);
  await expect(summaryToggle(page, '第二章：数字')).toHaveAttribute('aria-expanded', 'false');
});

// 抓：YouTube 人机验证拦截被报成别的错误（如视频不存在、网络错误）；非示例视频错误地兜底或继续调用模型；失败后表单不恢复
test('YouTube 拦截非示例视频：显示人机验证错误，不调用模型', async ({ page }) => {
  await setScenario({ videos: { blockedvid1: { kind: 'blocked' } } });
  await page.goto('/');
  await fillAndGenerate(page, 'https://www.youtube.com/watch?v=blockedvid1');

  const status = page.locator('#status');
  await expect(status).toHaveAttribute('data-tone', 'error', { timeout: 15_000 });
  expect(await statusMessage(page)).toBe('YouTube 拒绝了字幕请求，可能触发了人机验证（共试 3 次：人机验证、人机验证、人机验证）');
  await expect(status.locator('.status-detail')).toHaveCount(0);
  await expect(status.getByRole('button', { name: '重新生成' })).toBeVisible();
  await expect(page.locator('#article')).toBeEmpty();
  await expect.poll(() => controlsIdle(page)).toEqual(IDLE_CONTROLS);

  const upstream = await upstreamRequests();
  // 被拦后换客户端重试，一共 3 次播放器请求；都被拦，所以没有字幕请求，也没有调用模型
  expect(upstream.map((r) => [r.kind, r.videoId])).toEqual([
    ['player', 'blockedvid1'],
    ['player', 'blockedvid1'],
    ['player', 'blockedvid1'],
  ]);
});
