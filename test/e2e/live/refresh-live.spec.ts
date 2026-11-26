import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

/**
 * 刷新页面的真实验证（真实 YouTube 和 Gemini）。抓：
 * - 生成中刷新后页面一片空白、没有说明，或者服务端那次生成没有停下来；
 * - 生成完成后刷新，文章没有恢复，或者恢复出的文章 5W1H 用不了。
 * 会真实调用：1 次中途被刷新打断的生成 + 1 次完整生成 + 1 次总结。
 */
const VIDEO = process.env.CASE_URL ?? 'https://www.youtube.com/watch?v=UF8uR6Z6KLc';
const INSTRUCTIONS = process.env.CASE_INSTRUCTIONS ?? '写成给高中生看的学习笔记，不要问答体；正好 3 章。';

test('生成中刷新 → 提示被中断并重新生成 → 完成后刷新 → 文章恢复，5W1H 可用', async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  const startedAt = Date.now();
  const at = () => Math.round((Date.now() - startedAt) / 100) / 10;
  const log: Record<string, unknown> = {};
  const generations: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/generations')) generations.push(`${at()}s`);
  });

  await page.goto('/');
  await page.getByLabel('YouTube 链接').fill(VIDEO);
  await page.getByLabel(/生成要求/).fill(INSTRUCTIONS);
  await page.getByRole('button', { name: '生成文章' }).click();

  // 等正文开始出现再刷新：这时模型已经在输出
  await expect(page.locator('#article .chapter-body, #article > .article-intro').first()).toBeVisible({ timeout: 300_000 });
  await page.waitForTimeout(1_500);
  log.partialCharsBeforeReload = await page.locator('#article').evaluate((el) => el.textContent?.length ?? 0);
  log.reloadDuringGenerationAt = at();
  let dialogs = 0;
  page.on('dialog', (dialog) => {
    dialogs++;
    void dialog.accept();
  });
  await page.reload();

  const status = page.locator('#status');
  await expect(status).toContainText('上次生成因为页面刷新或关闭而中断，没有保存。链接和要求已经填回。');
  await expect(page.locator('#article')).toBeEmpty();
  await expect(page.getByLabel('YouTube 链接')).toHaveValue(VIDEO);
  await expect(page.getByLabel(/生成要求/)).toHaveValue(INSTRUCTIONS);
  log.leaveConfirmDialogs = dialogs;
  await page.screenshot({ path: testInfo.outputPath('1-interrupted.png') });

  // 重新生成，这次等它完成
  await status.getByRole('button', { name: '重新生成' }).click();
  log.regenerateAt = at();
  await expect(status).toContainText('已完成', { timeout: 600_000 });
  log.doneAt = at();
  const titleBefore = await page.locator('#article h1').innerText();
  const chaptersBefore = await page.locator('section.chapter h2').allInnerTexts();
  const bodyBefore = (await page.locator('#article').innerText()).replace(/\s+/g, '');
  const doneStatus = await status.innerText();

  await page.reload();
  await expect(status).toContainText('已恢复上次生成的文章');
  await expect(page.locator('#article')).toHaveAttribute('data-state', 'done');
  await expect(page.locator('#article h1')).toHaveText(titleBefore);
  expect(await page.locator('section.chapter h2').allInnerTexts()).toEqual(chaptersBefore);
  // 恢复出的正文和刷新前逐字相同（去掉空白比较）
  expect((await page.locator('#article').innerText()).replace(/\s+/g, '')).toBe(bodyBefore);
  await expect(page.locator('#source')).toBeVisible();
  await expect(page.getByLabel('YouTube 链接')).toHaveValue(VIDEO);
  await expect(page.getByLabel(/生成要求/)).toHaveValue(INSTRUCTIONS);
  await page.screenshot({ path: testInfo.outputPath('2-restored.png') });

  // 恢复后的 5W1H：由服务端用保存的那次生成现做
  const summaryResponse = page.waitForResponse((r) => r.url().includes('/summary'), { timeout: 120_000 });
  const chapter = page.locator('section.chapter').first();
  await chapter.locator('.summary-toggle').click();
  await expect(chapter.locator('.summary-table tr')).toHaveCount(6, { timeout: 120_000 });
  const response = await summaryResponse;
  const summary = (await response.json()) as { cached: boolean };
  await chapter.screenshot({ path: testInfo.outputPath('3-summary-after-restore.png') });

  // 整个过程只发了两次生成请求：被打断的那次和重新生成的那次；两次刷新都没有偷偷重发
  expect(generations).toHaveLength(2);
  expect(response.status()).toBe(200);
  expect(summary.cached).toBe(false);
  Object.assign(log, { generations, doneStatus, restoredStatus: await status.innerText(), title: titleBefore, chapters: chaptersBefore, bodyChars: bodyBefore.length, summaryStatus: response.status(), summaryCached: summary.cached });
  writeFileSync(testInfo.outputPath('refresh-evidence.json'), JSON.stringify(log, null, 2));
  console.log(JSON.stringify(log));
});
