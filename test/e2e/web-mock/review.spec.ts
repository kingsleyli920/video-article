/**
 * L2：核对阶段在真实浏览器里的表现。后端用 page.route 或 scriptedGeneration（一步步推事件）控制。
 */
import type { Page } from '@playwright/test';
import {
  ARTICLE_CHAPTERS,
  DRAFT_MD,
  FIXED_TIME,
  REQUIREMENTS_UNMET_MESSAGE,
  REVIEWED_MD,
  REVIEW_FAILED_MESSAGE,
  REVISIONS,
  REWRITTEN_REVIEW,
  SAMPLE_URL,
  SUMMARY_1,
  deltas,
  done,
  expect,
  generationEvents,
  meta,
  review,
  revised,
  scriptedGeneration,
  sseReply,
  stage,
  statusMain,
  summaryReply,
  test,
} from './api-mock';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
});

async function start(page: Page, instructions = ''): Promise<void> {
  await page.goto('/');
  await page.getByLabel('YouTube 链接').fill(SAMPLE_URL);
  await page.getByLabel(/生成要求/).fill(instructions);
  await page.getByRole('button', { name: '生成文章' }).click();
}

const chapterBodies = (page: Page) => page.locator('#article section.chapter .chapter-body');

// 抓：revised 到达后页面仍是初稿；核对记录默认展开、点不开，或展开后原句 / 修订 / 字幕原文不可见；修订里的 HTML 在浏览器里被执行；
// 5W1H 在 revised 之后带了请求体或者用了旧的章节
test('revised：初稿被换成最终全文，核对记录点开能看到原句、修订和字幕原文，5W1H 不带请求体', async ({ page, api }) => {
  const xss = { ...REVISIONS[1]!, evidence: `${REVISIONS[1]!.evidence} <img src=x onerror="window.__reviewXss = 1">` };
  const gen = await scriptedGeneration(page);
  await start(page);

  await gen.push(stage('transcript'), ['meta', meta()], stage('generating'), ...deltas(DRAFT_MD));
  await expect(chapterBodies(page).first()).toContainText('2003 年那家基金投资了三家芯片公司。');
  await gen.push(stage('reviewing'));
  expect(await statusMain(page)).toBe('正文已写完，正在对照字幕核对 · 已用时 0 秒');
  await expect(page.locator('.summary-toggle')).toHaveCount(2);
  for (const toggle of await page.locator('.summary-toggle').all()) await expect(toggle).toBeDisabled();

  await gen.push(revised(REVIEWED_MD, [REVISIONS[0]!, xss]));
  // 还没 done：正文已经是最终版本，初稿的两处错句都不在页面上
  await expect(chapterBodies(page).first()).toContainText('我 2003 年搬到硅谷，那家基金在之后十年里投资了三家芯片公司。');
  await expect(chapterBodies(page).nth(1)).toContainText('开源模型的成本大概每年下降一半，竞争会集中在产品和分发上。');
  await expect(page.locator('#article')).not.toContainText('这是确定的事实');
  await expect(page.locator('#article')).not.toContainText('2003 年那家基金投资了');
  await expect(page.locator('.article-review')).toHaveCount(0);

  await gen.push(['done', done({ review: review({ revisions: 2 }) })]);
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'ok');
  expect(await statusMain(page)).toBe('已完成，共 2 章、1234 字，用时 0 秒。已对照字幕核对，修订 2 处。点击章节标题旁的 5W1H 查看总结。');
  await expect(page.locator('#article section.chapter').first()).not.toContainText('2003 年那家基金投资了');

  const record = page.locator('#article > h1 + .article-review');
  await expect(record).toBeVisible();
  const summary = record.locator('summary');
  await expect(summary).toHaveText('对照字幕核对后修订了 2 处，点开查看原句、修订和字幕依据');
  await expect(record.locator('li').first()).toBeHidden();

  // 点开：两条都看得到
  await summary.click();
  await expect(record.locator('details')).toHaveAttribute('open', '');
  await expect(record.locator('.revision-type')).toHaveText(['时间', '数量']);
  await expect(record.locator('del')).toHaveText(['2003 年那家基金投资了三家芯片公司。', '开源模型的成本每年下降一半，这是确定的事实，']);
  await expect(record.locator('ins')).toHaveText(['我 2003 年搬到硅谷，那家基金在之后十年里投资了三家芯片公司。', '开源模型的成本大概每年下降一半，']);
  await expect(record.locator('.revision-evidence')).toHaveText([
    '字幕原文：I moved to the Valley in 2003. Over the next decade the fund backed three chip companies.',
    '字幕原文：the cost of running open models probably halves every year, roughly, I could be off <img src=x onerror="window.__reviewXss = 1">',
  ]);
  for (const locator of [record.locator('del').first(), record.locator('ins').last(), record.locator('.revision-evidence').last()]) await expect(locator).toBeVisible();
  await expect(record.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __reviewXss?: number }).__reviewXss)).toBeUndefined();

  // 收起、再展开
  await summary.click();
  await expect(record.locator('li').first()).toBeHidden();
  await summary.click();
  await expect(record.locator('li').last()).toBeVisible();

  // 完成后点第 2 章 5W1H：路径参数，没有请求体
  api.queueSummary(summaryReply('2', SUMMARY_1));
  await page.getByRole('button', { name: `${ARTICLE_CHAPTERS[1]!.title}：5W1H 总结` }).click();
  await expect(page.locator('section.chapter[data-chapter-id="2"] .summary-table tr')).toHaveCount(6);
  expect(api.summaries.map((r) => [r.method, r.path, r.postData])).toEqual([['POST', '/api/generations/gen-1/chapters/2/summary', null]]);
  expect(JSON.parse((await gen.bodies())[0]!)).toEqual({ url: SAMPLE_URL, instructions: '' });
});

// 抓：按要求修订过、约束核对结果在真实浏览器里没显示或文案不对；状态条阶段没经过"正在修订"
test('按要求修订：经历"正在修订"，完成后核对记录写明修订和约束核对结果', async ({ page }) => {
  const gen = await scriptedGeneration(page);
  await start(page, '写给投资人，不超过 1200 字');
  await gen.push(stage('transcript'), ['meta', meta()], stage('generating'), ...deltas(DRAFT_MD));
  await gen.push(stage('revising'));
  expect(await statusMain(page)).toBe('初稿没有满足生成要求，正在修订 · 已用时 0 秒');
  await gen.push(stage('reviewing'));
  expect(await statusMain(page)).toBe('正文已写完，正在对照字幕核对 · 已用时 0 秒');
  await gen.push(revised(REVIEWED_MD, []), ['done', done({ chars: 1018, review: REWRITTEN_REVIEW })]);

  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'ok');
  const record = page.locator('#article > h1 + .article-review');
  await expect(record.locator(':scope > p')).toHaveText([
    '初稿没有满足生成要求（全文 1,432 字，要求不超过 1,200 字），已按要求修订，全文从 1,432 字改为 1,018 字。',
    '生成要求核对：全文 1,018 字，上限 1,200 字。',
  ]);
  await expect(record.locator('details')).toHaveCount(0);
  expect(await statusMain(page)).toBe('已完成，共 2 章、1018 字，用时 0 秒。已对照字幕核对。点击章节标题旁的 5W1H 查看总结。');
  // 完成后显示的是修订稿，不是流式初稿
  await expect(chapterBodies(page).nth(1)).toContainText('开源模型的成本大概每年下降一半，竞争会集中在产品和分发上。');
  await expect(page.locator('#article section.chapter')).toHaveText([/我 2003 年搬到硅谷/, /大概每年下降一半/]);
  expect(JSON.parse((await gen.bodies())[0]!)).toEqual({ url: SAMPLE_URL, instructions: '写给投资人，不超过 1200 字' });
});

// 抓：核对没通过时说明仍写"内容不完整"、丢掉具体原因、文章被清掉、5W1H 可点或没有"重新生成"；重新生成后旧说明残留
for (const [code, phase, message] of [
  ['review_failed', 'reviewing', REVIEW_FAILED_MESSAGE],
  ['requirements_unmet', 'revising', REQUIREMENTS_UNMET_MESSAGE],
] as const) {
  test(`${code}：保留文章，下方写"未通过核对："和具体原因，5W1H 不可用，重新生成后清掉`, async ({ page, api }) => {
    api.queueGeneration(
      sseReply(generationEvents({ markdown: DRAFT_MD, beforeEnd: [stage(phase)], end: ['error', { code, message, partial: true }] })),
      sseReply(generationEvents({ end: ['done', done()] })),
    );
    await start(page, '不超过 1200 字');

    const status = page.locator('#status');
    await expect(status).toHaveAttribute('data-tone', 'error');
    expect(await statusMain(page)).toBe(message);
    await expect(page.locator('#article')).toHaveAttribute('data-state', 'failed');
    await expect(page.locator('#article h2')).toHaveText(['一、AI 是新的计算平台', '二、开源模型与创业公司']);
    await expect(chapterBodies(page).first()).toContainText('2003 年那家基金投资了三家芯片公司。');
    await expect(page.locator('.incomplete-note')).toHaveText(`未通过核对：${message}`);
    await expect(page.locator('.incomplete-note')).toBeVisible();
    await expect(page.locator('.summary-toggle')).toHaveCount(2);
    for (const toggle of await page.locator('.summary-toggle').all()) await expect(toggle).toBeDisabled();
    await expect(page.locator('.article-review')).toHaveCount(0);

    await status.getByRole('button', { name: '重新生成' }).click();
    await expect(status).toHaveAttribute('data-tone', 'ok');
    await expect(page.locator('.incomplete-note')).toHaveCount(0);
    expect(api.generations.map((r) => JSON.parse(r.postData ?? 'null'))).toEqual([
      { url: SAMPLE_URL, instructions: '不超过 1200 字' },
      { url: SAMPLE_URL, instructions: '不超过 1200 字' },
    ]);
  });
}

// 抓：核对阶段点停止后请求没断、页面显示成完成，或者初稿被清掉；停止后再到的 revised 把页面改了
test('核对中点"停止生成"：中止请求，保留初稿，状态条"已停止"，不显示成完成', async ({ page }) => {
  const gen = await scriptedGeneration(page);
  await start(page);
  await gen.push(stage('transcript'), ['meta', meta()], stage('generating'), ...deltas(DRAFT_MD), stage('reviewing'));
  expect(await statusMain(page)).toBe('正文已写完，正在对照字幕核对 · 已用时 0 秒');

  await page.getByRole('button', { name: '停止生成' }).click();
  const status = page.locator('#status');
  await expect(status).toHaveAttribute('data-tone', 'idle');
  expect(await statusMain(page)).toBe('已停止生成，已生成的内容保留在下方。');
  expect(await gen.aborted()).toBe(true);
  await expect(status.getByRole('button', { name: '重新生成' })).toBeVisible();
  await expect(page.locator('#article')).toHaveAttribute('data-state', 'failed');
  await expect(chapterBodies(page).first()).toContainText('2003 年那家基金投资了三家芯片公司。');
  await expect(page.locator('.incomplete-note')).toHaveText('内容不完整：已停止生成');
  for (const toggle of await page.locator('.summary-toggle').all()) await expect(toggle).toBeDisabled();
  await expect(page.getByRole('button', { name: '生成文章' })).toBeEnabled();

  await gen.push(revised(REVIEWED_MD, REVISIONS), ['done', done({ review: review({ revisions: 2 }) })]);
  await page.waitForTimeout(300);
  await expect(status).toHaveAttribute('data-tone', 'idle');
  await expect(page.locator('#article')).not.toContainText('搬到硅谷');
  await expect(page.locator('.article-review')).toHaveCount(0);
});
