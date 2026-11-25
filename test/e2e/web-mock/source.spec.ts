import { FIXED_TIME, PREVIEW, SAMPLE_URL, expect, holdGenerationAfterMeta, meta, sourceRows, statusMain, test } from './api-mock';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
});

// 抓：真实浏览器里来源面板要等正文出来才显示，或者不在状态条和文章之间；字幕片段折叠框默认展开、点不开或展开后不是逐条原文；停止后面板被清掉或写成"已完成"
test('等待模型输出时来源面板已经显示，字幕原文片段可以展开和收起，停止后面板原样保留', async ({ page }) => {
  await holdGenerationAfterMeta(page, meta({ transcript: { source: 'live', language: 'en', kind: 'asr', chars: 52000, preview: PREVIEW } }));
  await page.goto('/');
  await page.getByLabel('YouTube 链接').fill(SAMPLE_URL);
  await page.getByRole('button', { name: '生成文章' }).click();

  const panel = page.getByRole('region', { name: '来源信息' });
  await expect(panel).toBeVisible();
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'busy');
  expect(await statusMain(page)).toBe('字幕已获取，等待模型输出 · 已用时 0 秒');
  await expect(page.locator('#status .status-detail')).toHaveCount(0);
  await expect(page.locator('#article')).toBeEmpty();
  expect(await sourceRows(page)).toEqual([
    ['来源视频', '对话安德森', 'a16z · 时长 1:00:00'],
    ['字幕', '英语 · 自动生成字幕', '整理后 52,000 字符'],
    ['字幕来源', 'YouTube 实时获取'],
  ]);
  // 面板在状态条下方
  const statusBox = (await page.locator('#status').boundingBox())!;
  const panelBox = (await panel.boundingBox())!;
  expect(panelBox.y).toBeGreaterThanOrEqual(statusBox.y + statusBox.height);

  const summary = panel.locator('summary');
  const items = panel.locator('li');
  await expect(summary).toHaveText('字幕原文片段（节选 3 段，自动生成字幕可能有识别错误）');
  await expect(items.first()).toBeHidden();

  await summary.click();
  await expect(panel.locator('details')).toHaveAttribute('open', '');
  await expect(items).toHaveText([
    "[00:00] Welcome back to the a16z show. I'm here with Marc Andreessen, and today we're going to talk about the trillion-dollar question in AI.",
    '[20:00] For eighty years computers were machines that followed instructions. Large models are the first time software can deal with ambiguity.',
    '[40:00] Open source means a small team can get frontier capability, so the competition moves to product and distribution.',
  ]);
  await expect(items.first()).toBeVisible();

  await page.getByRole('button', { name: '停止生成' }).click();
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'idle');
  expect(await statusMain(page)).toBe('已停止生成。');
  await expect(panel).toBeVisible();
  await expect(items).toHaveCount(3);
  await expect(items.first()).toBeVisible();
  await expect(panel).not.toContainText(/完成|停止/);

  await summary.click();
  await expect(items.first()).toBeHidden();
});
