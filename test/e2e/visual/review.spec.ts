/**
 * L5 视觉：核对阶段的界面状态。visual-desktop（1280×860）和 visual-mobile（iPhone 13）各跑一遍。
 * 后端用 page.route 或 scriptedGeneration 控制；Date.now 固定，"已用时"恒为 0 秒。
 */
import type { Page } from '@playwright/test';
import type { Revision } from '../../../src/shared/types';
import { expectNoHorizontalOverflow } from './layout-checks';
import {
  DRAFT_MD,
  FIXED_TIME,
  REVIEWED_MD,
  REVIEW_FAILED_MESSAGE,
  REVISIONS,
  REWRITTEN_REVIEW,
  SAMPLE_URL,
  WARNINGS,
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
  test,
  type ApiMock,
} from '../web-mock/api-mock';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
});

async function start(page: Page, instructions = '写给不懂技术的投资人，只保留商业相关的内容，不超过 1200 字。'): Promise<void> {
  await page.goto('/');
  await page.getByLabel('YouTube 链接').fill(SAMPLE_URL);
  await page.getByLabel(/生成要求/).fill(instructions);
  await page.getByRole('button', { name: '生成文章' }).click();
}

async function generate(page: Page, api: ApiMock, ...replies: Parameters<ApiMock['queueGeneration']>): Promise<void> {
  api.queueGeneration(...replies);
  await start(page);
}

/** 三条修订：一条很长的字幕原文、一条长句的发言归属、一条删去 */
const LONG_REVISIONS: Revision[] = [
  {
    ...REVISIONS[0]!,
    evidence:
      "I moved to the Valley in 2003. Over the next decade the fund backed three chip companies, and honestly at the time nobody thought semiconductors were a venture category at all, everybody told us the capital requirements were too high and the cycles were too long, and we kept saying look, the software layer is going to need an enormous amount of compute and somebody is going to have to build it, so we just kept writing checks while everyone else was chasing consumer apps",
  },
  {
    type: 'attribution',
    before: '**安德森:** 我一直认为软件正在吞噬世界，而且这一轮人工智能会让这个过程再加速十倍，所有行业的公司最后都会变成软件公司，没有例外。',
    after: '**主持人:** 你以前说过软件正在吞噬世界，你现在还这么看吗？这一轮人工智能会不会让这个过程再加速？',
    reason: '这段是主持人提问时引用嘉宾以前的话，文章写成了嘉宾这次的回答，"十倍""没有例外"字幕里也没有',
    evidence: 'You famously said software is eating the world. Do you still believe that, and does AI speed it up?',
  },
  {
    type: 'unsupported',
    before: '这家基金去年的回报率超过了 300%，',
    after: '',
    reason: '字幕里没有提到回报率',
    evidence: 'we did fine last year, I am not going to give you numbers',
  },
];

// 抓：核对中状态条的文案换行错乱、和停止按钮挤在一起；初稿正文和光标在核对中显示异常
test('核对中：状态条"正在对照字幕核对"', async ({ page }) => {
  const gen = await scriptedGeneration(page);
  await start(page);
  await gen.push(stage('transcript'), ['meta', meta()], stage('generating'), ...deltas(DRAFT_MD), stage('reviewing'));
  await expect(page.locator('#status')).toHaveText('正文已写完，正在对照字幕核对 · 已用时 0 秒');
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'busy');
  await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible();
  await expect(page.locator('.summary-toggle').first()).toBeDisabled();
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot('14-reviewing.png', { fullPage: true });
});

// 抓：核对记录和数字提示同时出现时贴在一起或间距过大；收起时摘要换行错乱
test('完成且有核对记录（收起），和数字提示同时出现', async ({ page, api }) => {
  await generate(
    page,
    api,
    sseReply(generationEvents({ markdown: DRAFT_MD, beforeEnd: [stage('reviewing'), revised(REVIEWED_MD, LONG_REVISIONS)], end: ['done', done({ numberWarnings: WARNINGS, review: review({ revisions: 3 }) })] })),
  );
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'ok');
  const record = page.locator('#article > .article-notice + .article-review');
  await expect(record).toBeVisible();
  await expect(record.locator('summary')).toHaveText('对照字幕核对后修订了 3 处，点开查看原句、修订和字幕依据');
  await expect(record.locator('li').first()).toBeHidden();
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot('15-review-collapsed.png', { fullPage: true });
});

// 抓：展开后原句 / 修订长句在手机宽度下溢出或不折行，很长的字幕原文撑破记录框，"（删去）"看不出来，条目之间挤在一起，框底边被截
test('核对记录展开：3 条修订，含很长的字幕原文和一条删去', async ({ page, api }) => {
  await generate(
    page,
    api,
    sseReply(generationEvents({ markdown: DRAFT_MD, beforeEnd: [stage('reviewing'), revised(REVIEWED_MD, LONG_REVISIONS)], end: ['done', done({ numberWarnings: WARNINGS, review: review({ revisions: 3 }) })] })),
  );
  const record = page.locator('#article .article-review');
  await record.locator('summary').click();
  await expect(record.locator('li')).toHaveCount(3);
  await expect(record.locator('li').last()).toBeVisible();
  await expect(record.locator('ins').last()).toHaveText('（删去）');
  await expectNoHorizontalOverflow(page);
  // 从文章标题截到导语：看记录框内的折行、底边，以及和上方数字提示、下方导语的间距
  const clip = await page.evaluate(() => {
    const title = document.querySelector('#article h1')!.getBoundingClientRect();
    const intro = document.querySelector('#article .article-intro')!.getBoundingClientRect();
    return { x: 0, y: title.top + window.scrollY - 16, width: document.documentElement.clientWidth, height: intro.bottom - title.top + 32 };
  });
  await expect(page).toHaveScreenshot('16-review-expanded.png', { fullPage: true, clip });
});

// 抓：按要求修订和约束核对结果两句话的间距、换行错乱
test('按要求修订过 + 约束核对结果', async ({ page, api }) => {
  await generate(
    page,
    api,
    sseReply(generationEvents({ markdown: DRAFT_MD, beforeEnd: [stage('revising'), stage('reviewing'), revised(REVIEWED_MD, [])], end: ['done', done({ chars: 1018, review: REWRITTEN_REVIEW })] })),
  );
  const record = page.locator('#article > h1 + .article-review');
  await expect(record.locator(':scope > p')).toHaveCount(2);
  await expect(record.locator('details')).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot('17-review-rewritten.png', { fullPage: true });
});

// 抓：未通过核对的错误条、"重新生成"和文章下方"未通过核对："说明排版错乱，长原因溢出
test('未通过核对', async ({ page, api }) => {
  await generate(
    page,
    api,
    sseReply(generationEvents({ markdown: DRAFT_MD, beforeEnd: [stage('reviewing')], end: ['error', { code: 'review_failed', message: REVIEW_FAILED_MESSAGE, partial: true }] })),
  );
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'error');
  await expect(page.locator('#status').getByRole('button', { name: '重新生成' })).toBeVisible();
  await expect(page.locator('.incomplete-note')).toHaveText(`未通过核对：${REVIEW_FAILED_MESSAGE}`);
  await expect(page.locator('.summary-toggle').first()).toBeDisabled();
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot('18-review-failed.png', { fullPage: true });
});
