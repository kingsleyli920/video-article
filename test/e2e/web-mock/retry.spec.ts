import type { Page } from '@playwright/test';
import {
  FIXED_TIME,
  PARTIAL_MD,
  SAMPLE_URL,
  SECOND_ARTICLE_MD,
  SUMMARY_1,
  WARNINGS,
  deferred,
  done,
  expect,
  generationEvents,
  meta,
  sseReply,
  statusMain,
  summaryReply,
  test,
} from './api-mock';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
});

/** 页面处于刚打开时的干净状态：没有状态条和文章，控件可用，两个输入框为空 */
async function expectInitialState(page: Page): Promise<void> {
  await expect(page.locator('#status')).toBeHidden();
  await expect(page.locator('#status')).toBeEmpty();
  await expect(page.locator('#source')).toBeHidden();
  await expect(page.locator('#source')).toBeEmpty();
  await expect(page.locator('#article')).toBeEmpty();
  await expect(page.locator('#article')).not.toHaveAttribute('data-state');
  await expect(page.locator('#submit')).toBeEnabled();
  await expect(page.locator('#submit')).toHaveText('生成文章');
  await expect(page.getByRole('button', { name: '停止生成' })).toBeHidden();
  await expect(page.getByLabel('YouTube 链接')).toHaveValue('');
  await expect(page.getByLabel(/生成要求/)).toHaveValue('');
}

// 抓："重新生成"用了别的输入、失败时的部分内容和"内容不完整"在成功后残留、5W1H 仍不可点
test('失败后点"重新生成"：用同样的链接和要求重发，成功后清掉失败痕迹', async ({ page, api }) => {
  api.queueGeneration(
    sseReply(generationEvents({ markdown: PARTIAL_MD, end: ['error', { code: 'interrupted', message: '生成中断，文章不完整', partial: true }] })),
    sseReply(generationEvents({ meta: meta({ generationId: 'gen-retry' }) })),
  );
  await page.goto('/');
  await page.getByLabel('YouTube 链接').fill(SAMPLE_URL);
  await page.getByLabel(/生成要求/).fill('写给投资人');
  await page.getByRole('button', { name: '生成文章' }).click();
  const status = page.locator('#status');
  await expect(status).toHaveAttribute('data-tone', 'error');
  await expect(page.locator('.incomplete-note')).toBeVisible();

  // 用户改了输入框，"重新生成"仍重发上一次的输入
  await page.getByLabel(/生成要求/).fill('改过的要求');
  await status.getByRole('button', { name: '重新生成' }).click();
  await expect(status).toHaveAttribute('data-tone', 'ok');

  expect(api.generations).toHaveLength(2);
  expect(JSON.parse(api.generations[1]!.postData ?? 'null')).toEqual({ url: SAMPLE_URL, instructions: '写给投资人' });
  await expect(page.locator('#article')).toHaveAttribute('data-state', 'done');
  await expect(page.locator('.incomplete-note')).toHaveCount(0);
  await expect(page.locator('#article h2')).toHaveText(['一、AI 是新的计算平台', '二、开源模型与创业公司']);
  await expect(page.locator('.summary-toggle').first()).toBeEnabled();
  await expect(status.getByRole('button', { name: '重新生成' })).toHaveCount(0);

  api.queueSummary(summaryReply('1', SUMMARY_1));
  await page.locator('.summary-toggle').first().click();
  await expect(page.locator('.summary-table')).toBeVisible();
  expect(api.summaries.map((r) => r.path)).toEqual(['/api/generations/gen-retry/chapters/1/summary']);
});

// 抓：第二次生成时旧文章、旧数字提示、旧 5W1H 面板、旧来源面板残留；新文章的 5W1H 仍用旧 generationId 或一次点击发两次请求
test('成功并展开 5W1H 后再生成一次：旧内容全部清掉，新 5W1H 请求带新的 generationId', async ({ page, api }) => {
  const secondGate = deferred();
  api.queueGeneration(
    sseReply(generationEvents({ meta: meta({ generationId: 'gen-1' }), end: ['done', done({ numberWarnings: WARNINGS })] })),
    sseReply(
      generationEvents({
        meta: meta({ generationId: 'gen-2', video: { id: 'xRh2sVcNXQ8', title: '开源模型专访', channel: 'a16z', lengthSeconds: 754 } }),
        markdown: SECOND_ARTICLE_MD,
        end: ['done', done({ chapters: [{ id: '1', title: '开源与闭源' }], chars: 321 })],
      }),
      { gate: secondGate.promise },
    ),
  );
  api.queueSummary(summaryReply('1', SUMMARY_1), summaryReply('1', { ...SUMMARY_1, who: '安德森' }));

  await page.goto('/');
  await page.getByLabel('YouTube 链接').fill(SAMPLE_URL);
  await page.getByRole('button', { name: '生成文章' }).click();
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'ok');
  await page.locator('.summary-toggle').first().click();
  await expect(page.locator('.summary-table')).toBeVisible();
  await expect(page.locator('.article-notice')).toBeVisible();

  await page.getByLabel(/生成要求/).fill('只讲开源');
  await page.getByRole('button', { name: '生成文章' }).click();

  // 第二次还在生成：旧内容已经清空
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'busy');
  await expect(page.locator('#article')).toBeEmpty();
  await expect(page.locator('.article-notice, .summary-panel, .summary-table')).toHaveCount(0);
  await expect(page.locator('#source')).toBeHidden();
  await expect(page.locator('#source')).toBeEmpty();

  secondGate.resolve();
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'ok');
  expect(await statusMain(page)).toBe('已完成，共 1 章、321 字，用时 0 秒。已对照字幕核对。点击章节标题旁的 5W1H 查看总结。');
  await expect(page.locator('#article h1')).toHaveText('第二篇：开源模型的商业逻辑');
  await expect(page.locator('#article h2')).toHaveText(['开源与闭源']);
  await expect(page.getByText('对话安德森：AI 革命的万亿美金之问')).toHaveCount(0);
  await expect(page.locator('#source .source-title')).toHaveText('开源模型专访');
  await expect(page.locator('#source')).toContainText('a16z · 时长 12:34');
  await expect(page.locator('.article-notice')).toHaveCount(0);
  await expect(page.locator('.summary-table')).toHaveCount(0);
  await expect(page.locator('.summary-panel:not([hidden])')).toHaveCount(0);
  await expect(page.locator('.summary-toggle')).toHaveAttribute('aria-expanded', 'false');

  await page.locator('.summary-toggle').click();
  await expect(page.locator('.summary-table td').first()).toHaveText('安德森');
  expect(api.summaries.map((r) => r.path)).toEqual([
    '/api/generations/gen-1/chapters/1/summary',
    '/api/generations/gen-2/chapters/1/summary',
  ]);
  expect(JSON.parse(api.generations[1]!.postData ?? 'null')).toEqual({ url: SAMPLE_URL, instructions: '只讲开源' });
});

// 抓：刷新后残留上一次的文章、状态条或 5W1H，或者刷新时自动重发生成请求
test('生成完成后刷新页面：回到干净的初始状态，不重发请求', async ({ page, api }) => {
  api.queueGeneration(sseReply(generationEvents({ end: ['done', done({ numberWarnings: WARNINGS })] })));
  api.queueSummary(summaryReply('1', SUMMARY_1));
  await page.goto('/');
  await page.getByLabel('YouTube 链接').fill(SAMPLE_URL);
  await page.getByLabel(/生成要求/).fill('写给投资人');
  await page.getByRole('button', { name: '生成文章' }).click();
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'ok');
  await page.locator('.summary-toggle').first().click();
  await expect(page.locator('.summary-table')).toBeVisible();

  await page.reload();
  await expectInitialState(page);
  expect(api.generations).toHaveLength(1);
  expect(api.summaries).toHaveLength(1);
});

// 抓：离开再按返回键回来时页面残留旧文章、状态条或 5W1H，或者返回后无法再次生成
test('离开页面再按返回键回来：没有旧结果，可以重新生成', async ({ page, api }) => {
  api.queueGeneration(sseReply(generationEvents({})), sseReply(generationEvents({ meta: meta({ generationId: 'gen-back' }) })));
  api.queueSummary(summaryReply('1', SUMMARY_1), summaryReply('1', SUMMARY_1));
  await page.goto('/');
  await page.getByLabel('YouTube 链接').fill(SAMPLE_URL);
  await page.getByRole('button', { name: '生成文章' }).click();
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'ok');
  await page.locator('.summary-toggle').first().click();
  await expect(page.locator('.summary-table')).toBeVisible();

  await page.goto('about:blank');
  await page.goBack();
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
  await expectInitialState(page);

  await page.getByRole('button', { name: '填入示例视频' }).click();
  await page.getByRole('button', { name: '生成文章' }).click();
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'ok');
  await page.locator('.summary-toggle').first().click();
  await expect(page.locator('.summary-table')).toBeVisible();
  expect(api.generations).toHaveLength(2);
  expect(api.summaries.map((r) => r.path)).toEqual([
    '/api/generations/gen-1/chapters/1/summary',
    '/api/generations/gen-back/chapters/1/summary',
  ]);
});

// 抓：返回键回到页面时，浏览器把上次填的"生成要求"恢复进输入框，而链接框（autocomplete="off"）是空的，两个输入框状态不一致
// 已知失败：src/client/index.html 的 textarea#instructions 没有 autocomplete="off"，Chromium 返回时会恢复它的内容
test('离开页面再按返回键回来：生成要求输入框和链接框一样是空的', async ({ page, api }) => {
  api.queueGeneration(sseReply(generationEvents({})));
  await page.goto('/');
  await page.getByLabel('YouTube 链接').fill(SAMPLE_URL);
  await page.getByLabel(/生成要求/).fill('写给投资人');
  await page.getByRole('button', { name: '生成文章' }).click();
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'ok');

  await page.goto('about:blank');
  await page.goBack();
  await expect(page.getByLabel('YouTube 链接')).toHaveValue('');
  await expect(page.getByLabel(/生成要求/)).toHaveValue('');
});
