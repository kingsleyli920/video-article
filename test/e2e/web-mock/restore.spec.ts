import { FIXED_TIME, SAMPLE_URL, SUMMARY_1, expect, generationEvents, meta, sseReply, summaryReply, test } from './api-mock';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
});

// 抓（真实浏览器）：生成完成后刷新，文章消失；或者恢复出的文章 5W1H 点不了、刷新时又发了一次生成请求
test('生成完成后刷新：文章、来源面板和输入都恢复，5W1H 用原来的生成编号', async ({ page, api }, testInfo) => {
  api.queueGeneration(sseReply(generationEvents({ meta: meta({ generationId: 'gen-restore' }) })));
  api.queueSummary(summaryReply('1', SUMMARY_1));
  await page.goto('/');
  await page.getByLabel('YouTube 链接').fill(SAMPLE_URL);
  await page.getByLabel(/生成要求/).fill('写给投资人');
  await page.getByRole('button', { name: '生成文章' }).click();
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'ok');
  const titleBefore = await page.locator('#article h1').innerText();
  const chaptersBefore = await page.locator('section.chapter h2').allInnerTexts();

  await page.reload();

  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'ok');
  await expect(page.locator('#status')).toContainText('已恢复上次生成的文章');
  await expect(page.locator('#article')).toHaveAttribute('data-state', 'done');
  await expect(page.locator('#article h1')).toHaveText(titleBefore);
  expect(await page.locator('section.chapter h2').allInnerTexts()).toEqual(chaptersBefore);
  await expect(page.locator('#source')).toBeVisible();
  await expect(page.getByLabel('YouTube 链接')).toHaveValue(SAMPLE_URL);
  await expect(page.getByLabel(/生成要求/)).toHaveValue('写给投资人');
  await page.screenshot({ path: testInfo.outputPath('restored.png'), fullPage: true });

  await page.locator('section.chapter').first().locator('.summary-toggle').click();
  await expect(page.locator('section.chapter').first().locator('.summary-table tr')).toHaveCount(6);
  expect(api.generations).toHaveLength(1);
  expect(api.summaries.map((r) => r.path)).toEqual(['/api/generations/gen-restore/chapters/1/summary']);
});

// 抓（真实浏览器）：生成中刷新后页面一片空白，没有任何说明，输入也丢了
test('生成中刷新：填回链接和要求，提示上次被中断，可以重新生成', async ({ page, api }, testInfo) => {
  api.queueGeneration({ hang: true }, sseReply(generationEvents({ meta: meta({ generationId: 'gen-again' }) })));
  await page.goto('/');
  await page.getByLabel('YouTube 链接').fill(SAMPLE_URL);
  await page.getByLabel(/生成要求/).fill('写给投资人');
  await page.getByRole('button', { name: '生成文章' }).click();
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'busy');

  // 浏览器会先弹出"离开此网站？"的确认，这里选择离开
  page.on('dialog', (dialog) => void dialog.accept());
  await page.reload();

  const status = page.locator('#status');
  await expect(status).toHaveAttribute('data-tone', 'idle');
  await expect(status).toContainText('上次生成因为页面刷新或关闭而中断，没有保存。链接和要求已经填回。');
  await expect(page.locator('#article')).toBeEmpty();
  await expect(page.getByLabel('YouTube 链接')).toHaveValue(SAMPLE_URL);
  await expect(page.getByLabel(/生成要求/)).toHaveValue('写给投资人');
  await expect(page.locator('#submit')).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('interrupted.png') });

  await status.getByRole('button', { name: '重新生成' }).click();
  await expect(status).toHaveAttribute('data-tone', 'ok');
  expect(JSON.parse(api.generations[1]!.postData ?? 'null')).toEqual({ url: SAMPLE_URL, instructions: '写给投资人' });
});
