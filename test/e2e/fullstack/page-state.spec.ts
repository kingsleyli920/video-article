/**
 * L5 全栈（受控上游）：刷新后恢复上次完成的文章、YouTube 拦截、本地被拦后换区域取字幕。
 * 换区域用的 Durable Object 在 wrangler dev 里和 Worker 同一个进程，播放器请求同样发到模拟上游：
 * 前 3 次是本地的三种客户端，第 4 次起是各区域（每个区域最多 3 次）。
 */
import { expect, test } from '@playwright/test';
import { defaultScenario, MOCK_VIDEO_ID, type OkVideo } from '../../harness/mock-upstream';
import { chapter, controlsIdle, fillAndGenerate, IDLE_CONTROLS, SOURCE_ROWS, sourceRows, statusMessage, summaryToggle, VIDEO_URL } from './page';
import { resetUpstream, setScenario, upstreamRequests } from './upstream';

test.beforeEach(async () => {
  await resetUpstream();
});

// 抓：刷新后文章丢失，或者恢复出的文章 5W1H 不可用、表单仍处于锁定状态；刷新后不能再次生成，
// 或再次生成后页面上还留着上一篇的 5W1H 面板
test('生成完成后刷新页面：恢复这篇文章和输入，5W1H 用服务端保存的同一次生成，并能再次生成', async ({ page }) => {
  await page.goto('/');
  await fillAndGenerate(page, VIDEO_URL, '刷新前的要求');
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'ok', { timeout: 15_000 });
  await summaryToggle(page, '第二章：数字').click();
  await expect(chapter(page, '2').locator('.summary-table tr')).toHaveCount(6);

  await page.reload();
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'ok');
  await expect(page.locator('#status')).toContainText('已恢复上次生成的文章');
  await expect(page.locator('#article')).toHaveAttribute('data-state', 'done');
  await expect(page.locator('#article h1')).toHaveText('对话测试嘉宾：受控上游');
  await expect(page.getByLabel('YouTube 链接')).toHaveValue(VIDEO_URL);
  await expect(page.getByLabel('生成要求')).toHaveValue('刷新前的要求');
  expect(await controlsIdle(page)).toEqual(IDLE_CONTROLS);
  // 刷新前展开过的 5W1H 面板不保留，恢复后是收起的；再点一次，由真实的 Worker 用保存的那次生成返回（走缓存）
  await expect(page.locator('#article .summary-table')).toHaveCount(0);
  await summaryToggle(page, '第二章：数字').click();
  await expect(chapter(page, '2').locator('.summary-table tr')).toHaveCount(6);

  // 刷新后再生成一次：正常完成，5W1H 是这次的新面板（未展开）
  await page.getByLabel('生成要求').fill('');
  await page.getByRole('button', { name: '生成文章' }).click();
  await expect(page.locator('#status')).toContainText('已完成', { timeout: 15_000 });
  await expect(page.locator('#article h1')).toHaveText('对话测试嘉宾：受控上游');
  await expect(page.locator('#article .summary-table')).toHaveCount(0);
  await expect(summaryToggle(page, '第二章：数字')).toHaveAttribute('aria-expanded', 'false');
});

// 抓：YouTube 人机验证拦截被报成别的错误（如视频不存在、网络错误）；非示例视频错误地兜底或继续调用模型；失败后表单不恢复；
// 一直被拦时换区域没有上限
test('YouTube 拦截非示例视频：显示人机验证错误，不调用模型', async ({ page }) => {
  await setScenario({ videos: { blockedvid1: { kind: 'blocked' } } });
  await page.goto('/');
  await fillAndGenerate(page, 'https://www.youtube.com/watch?v=blockedvid1');

  const status = page.locator('#status');
  await expect(status).toHaveAttribute('data-tone', 'error', { timeout: 15_000 });
  expect(await statusMessage(page)).toBe('YouTube 拒绝了字幕请求，可能触发了人机验证（本地试 3 次，换 3 个区域后仍被拦）');
  await expect(status.locator('.status-detail')).toHaveCount(0);
  await expect(status.getByRole('button', { name: '重新生成' })).toBeVisible();
  await expect(page.locator('#article')).toBeEmpty();
  await expect.poll(() => controlsIdle(page)).toEqual(IDLE_CONTROLS);

  const upstream = await upstreamRequests();
  // 被拦后本地换客户端重试 3 次，再换 3 个区域各试 3 次，一共 12 次播放器请求；都被拦，所以没有字幕请求，也没有调用模型
  expect(upstream.map((r) => [r.kind, r.videoId])).toEqual(Array.from({ length: 12 }, () => ['player', 'blockedvid1']));
});

// 抓：本地三种客户端都被人机验证拦住后不换区域、页面直接报错；换区域取到后来源面板仍只写"YouTube 实时获取"，
// 用户看不出换过节点；取到之后还接着请后面的区域
test('本地 3 次被拦、第 4 次（其他区域）正常：页面照常生成，来源面板写明改由美国东部节点获取', async ({ page }) => {
  const video = defaultScenario().videos[MOCK_VIDEO_ID] as OkVideo;
  await setScenario({ videos: { [MOCK_VIDEO_ID]: { kind: 'blocked-first', times: 3, mode: 'login', then: video } } });
  await page.goto('/');
  await fillAndGenerate(page, VIDEO_URL);

  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'ok', { timeout: 15_000 });
  await expect(page.locator('#article h1')).toHaveText('对话测试嘉宾：受控上游');
  expect(await sourceRows(page)).toEqual([SOURCE_ROWS[0], SOURCE_ROWS[1], ['字幕来源', 'YouTube 实时获取（本服务器被 YouTube 拦截，改由美国东部节点获取）']]);
  await expect(page.locator('#source .source-row-warn')).toHaveCount(0);

  const upstream = (await upstreamRequests()).filter((r) => r.kind === 'player' || r.kind === 'captions' || r.kind === 'stream');
  expect(upstream.map((r) => r.kind)).toEqual(['player', 'player', 'player', 'player', 'captions', 'stream']);
});
