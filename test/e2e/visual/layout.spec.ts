/**
 * L5 视觉：截图之外的版面几何检查（不出基线图）。同样由 visual-desktop 和 visual-mobile 各跑一遍。
 * 这里的期望值来自 styles.css 里写明的意图，例如 .summary-loading 的 margin: 0、.incomplete-note 的 margin-top: 28px。
 */
import { expectNoHorizontalOverflow, verticalGaps } from './layout-checks';
import {
  FIXED_TIME,
  HANG,
  PARTIAL_MD,
  SAMPLE_URL,
  apiError,
  expect,
  generationEvents,
  meta,
  sseReply,
  test,
} from '../web-mock/api-mock';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto('/');
  await page.getByLabel('YouTube 链接').fill(SAMPLE_URL);
});

// 抓：视频标题里一长串不带空格的字符（如连写的 hashtag）在来源面板里不换行，伸出面板边框、把页面撑出横向滚动
test('来源面板里的长视频标题不溢出', async ({ page, api }, testInfo) => {
  api.queueGeneration(
    sseReply(
      generationEvents({
        meta: meta({
          video: { id: 'xRh2sVcNXQ8', title: 'Marc Andreessen on AI #a16z#AI#Andreessen#TrillionDollarQuestion#OpenSourceModels', channel: 'a16z', lengthSeconds: 7200 },
        }),
      }),
    ),
  );
  await page.getByRole('button', { name: '生成文章' }).click();
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'ok');
  await expect(page.locator('#source .source-title')).toHaveText('Marc Andreessen on AI #a16z#AI#Andreessen#TrillionDollarQuestion#OpenSourceModels');
  await expect(page.locator('#source .source-title')).toBeVisible();
  // 现场截图留作证据（不是基线）
  await page.screenshot({ path: testInfo.outputPath('long-video-title.png'), fullPage: true });
  await expectNoHorizontalOverflow(page);
});

// 抓：5W1H 面板里"加载中"和"失败"提示上下留白不一致（文字贴顶、下方多出一截空白）
// 已知失败：.article p（优先级 0,1,1）的 margin-bottom: 14px 盖过了 .summary-loading/.summary-error（0,1,0）的 margin: 0
test('5W1H 面板里的加载中和失败提示上下留白一致', async ({ page, api }) => {
  api.queueGeneration(sseReply(generationEvents({})));
  api.queueSummary(HANG, apiError(503, 'gemini_busy', 'Gemini 模型繁忙，请稍后重试'));
  await page.getByRole('button', { name: '生成文章' }).click();
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'ok');
  await page.locator('section.chapter[data-chapter-id="1"] .summary-toggle').click();
  await page.locator('section.chapter[data-chapter-id="2"] .summary-toggle').click();
  await expect(page.locator('#summary-1 .summary-loading')).toBeVisible();
  await expect(page.locator('#summary-2 .summary-error')).toBeVisible();

  const gaps = {
    loading: await verticalGaps(page, '#summary-1', '.summary-loading'),
    error: await verticalGaps(page, '#summary-2', '.summary-error'),
  };
  // 面板 padding 是上下各 14px
  expect(gaps).toEqual({ loading: { top: 14, bottom: 14 }, error: { top: 14, bottom: 14 } });
});

// 抓："内容不完整"提示和上方正文挤在一起，没有和正文拉开距离
// 已知失败：.article p 的 margin: 0 0 14px 盖过了 .incomplete-note 的 margin-top: 28px，实际间距只有正文段落的 14px
test('"内容不完整"提示和上方正文之间留出 28px', async ({ page, api }) => {
  api.queueGeneration(
    sseReply(generationEvents({ markdown: PARTIAL_MD, end: ['error', { code: 'gemini_busy', message: 'Gemini 模型繁忙，请稍后重试', partial: true }] })),
  );
  await page.getByRole('button', { name: '生成文章' }).click();
  await expect(page.locator('.incomplete-note')).toBeVisible();

  const gap = await page.locator('.incomplete-note').evaluate((note) => {
    const last = Array.from(document.querySelectorAll('#article .chapter-body > *')).pop()!;
    return Math.round(note.getBoundingClientRect().top - last.getBoundingClientRect().bottom);
  });
  expect(gap).toBe(28);
});
