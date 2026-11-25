/**
 * L5 视觉：关键界面状态的截图比对。同一份用例由 visual-desktop（1280×860）和 visual-mobile（iPhone 13）各跑一遍。
 * 后端全部用 page.route 控制；Date.now 固定，"已用时 N 秒"恒为 0 秒，截图稳定。
 * 每张图之外另断言：页面没有横向溢出、关键元素可见。
 */
import type { Locator, Page } from '@playwright/test';
import { expectNoHorizontalOverflow } from './layout-checks';
import {
  FALLBACK_MODEL,
  FIXED_TIME,
  HANG,
  PARTIAL_MD,
  SAMPLE_URL,
  SUMMARY_1,
  WARNINGS,
  apiError,
  done,
  expect,
  generationEvents,
  meta,
  sseReply,
  summaryReply,
  test,
  type ApiMock,
} from '../web-mock/api-mock';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
});

async function fillForm(page: Page, instructions = '写给不懂技术的投资人，只保留商业相关的内容，语言简洁。'): Promise<void> {
  await page.getByLabel('YouTube 链接').fill(SAMPLE_URL);
  await page.getByLabel(/生成要求/).fill(instructions);
}

async function generate(page: Page, api: ApiMock, ...replies: Parameters<ApiMock['queueGeneration']>): Promise<void> {
  api.queueGeneration(...replies);
  await page.goto('/');
  await fillForm(page);
  await page.getByRole('button', { name: '生成文章' }).click();
}

const chapter = (page: Page, id: string): Locator => page.locator(`section.chapter[data-chapter-id="${id}"]`);

// 抓：初始页面布局错乱、停止按钮或状态条在空闲时露出
test('初始空页面', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '生成文章' })).toBeVisible();
  await expect(page.getByRole('button', { name: '填入示例视频' })).toBeVisible();
  await expect(page.getByRole('button', { name: '停止生成' })).toBeHidden();
  await expect(page.locator('#status')).toBeHidden();
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot('01-initial.png', { fullPage: true });
});

// 抓：填入长链接和多行要求后输入框撑破布局
test('填好链接和生成要求', async ({ page }) => {
  await page.goto('/');
  await fillForm(page);
  await expect(page.getByLabel('YouTube 链接')).toHaveValue(SAMPLE_URL);
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot('02-filled.png', { fullPage: true });
});

// 抓：等待中状态条不是 busy 样式、停止按钮没出现或和提交按钮挤在一起
test('等待中：状态条 busy 和停止按钮', async ({ page, api }) => {
  await generate(page, api, HANG);
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'busy');
  await expect(page.locator('#status')).toHaveText('正在获取字幕 · 已用时 0 秒');
  await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible();
  await expect(page.getByRole('button', { name: '生成中…' })).toBeDisabled();
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot('03-waiting.png', { fullPage: true });
});

// 抓：完成后标题、数字提示、章节标题和 5W1H 按钮排版错乱
test('完成：标题、数字提示和章节', async ({ page, api }) => {
  await generate(page, api, sseReply(generationEvents({ end: ['done', done({ numberWarnings: WARNINGS })] })));
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'ok');
  await expect(page.locator('#article h1')).toBeVisible();
  await expect(page.locator('#article .article-notice')).toBeVisible();
  await expect(chapter(page, '1').getByRole('button', { name: /5W1H/ })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot('04-done.png', { fullPage: true });
});

// 抓：5W1H 表格列宽、行线或"原文未明确提及"的灰色样式错乱
test('5W1H 展开的表格', async ({ page, api }) => {
  await generate(page, api, sseReply(generationEvents({})));
  api.queueSummary(summaryReply('1', SUMMARY_1));
  await chapter(page, '1').locator('.summary-toggle').click();
  await expect(chapter(page, '1').locator('.summary-table tr')).toHaveCount(6);
  await expect(chapter(page, '1').locator('.summary-missing').first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expect(chapter(page, '1')).toHaveScreenshot('05-summary-table.png');
});

// 抓：5W1H 加载中没有提示或按钮没有忙碌样式
test('5W1H 加载中', async ({ page, api }) => {
  await generate(page, api, sseReply(generationEvents({})));
  api.queueSummary(HANG);
  await chapter(page, '1').locator('.summary-toggle').click();
  await expect(chapter(page, '1').locator('.summary-loading')).toHaveText('正在生成 5W1H 总结…');
  await expect(chapter(page, '1').locator('.summary-toggle')).toHaveAttribute('aria-busy', 'true');
  await expectNoHorizontalOverflow(page);
  await expect(chapter(page, '1')).toHaveScreenshot('06-summary-loading.png');
});

// 抓：5W1H 失败的原因和"重试"不醒目或挤在一起
test('5W1H 失败带重试', async ({ page, api }) => {
  await generate(page, api, sseReply(generationEvents({})));
  api.queueSummary(apiError(503, 'gemini_busy', 'Gemini 模型繁忙，请稍后重试'));
  await chapter(page, '1').locator('.summary-toggle').click();
  await expect(chapter(page, '1').getByRole('button', { name: '重试' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expect(chapter(page, '1')).toHaveScreenshot('07-summary-error.png');
});

// 抓：失败时的错误条、"重新生成"、部分正文和"内容不完整"提示排版错乱
test('生成失败：部分内容和"内容不完整"', async ({ page, api }) => {
  await generate(
    page,
    api,
    sseReply(generationEvents({ markdown: PARTIAL_MD, end: ['error', { code: 'gemini_busy', message: 'Gemini 模型繁忙，请稍后重试', partial: true }] })),
  );
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'error');
  await expect(page.locator('#status').getByRole('button', { name: '重新生成' })).toBeVisible();
  await expect(page.locator('.incomplete-note')).toBeVisible();
  await expect(page.locator('.summary-toggle')).toBeDisabled();
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot('08-failed-partial.png', { fullPage: true });
});

// 抓：停止后状态条样式不是中性的 idle、"重新生成"不可见
test('已停止', async ({ page, api }) => {
  await generate(page, api, HANG);
  await page.getByRole('button', { name: '停止生成' }).click();
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'idle');
  await expect(page.locator('#status').getByRole('button', { name: '重新生成' })).toBeVisible();
  await expect(page.getByRole('button', { name: '生成文章' })).toBeEnabled();
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot('09-stopped.png', { fullPage: true });
});

// 抓：校验错误的红色状态条不显示或样式错误
test('输入校验错误', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('YouTube 链接').fill('https://example.com/watch?v=xRh2sVcNXQ8');
  await page.getByRole('button', { name: '生成文章' }).click();
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'error');
  await expect(page.locator('#status')).toHaveText('请输入有效的 YouTube 视频链接');
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot('10-invalid-url.png', { fullPage: true });
});

// 抓：备用模型说明和备份字幕原因在状态条里换行错乱或看不到
test('备用模型提示', async ({ page, api }) => {
  await generate(
    page,
    api,
    sseReply(
      generationEvents({
        meta: meta({ transcript: { source: 'backup', language: 'en', kind: 'asr', chars: 52000, liveError: 'YouTube 拒绝了字幕请求，可能触发了人机验证' } }),
        end: ['done', done({ model: FALLBACK_MODEL })],
      }),
    ),
  );
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'ok');
  await expect(page.locator('#status .status-detail')).toContainText('主模型繁忙，本次由 gemini-3.6-flash 生成');
  await expect(page.locator('#status .status-detail')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot('11-fallback-model.png');
});

const LONG_WORD = 'Pneumonoultramicroscopicsilicovolcanoconiosis'.repeat(2);
const LONG_URL = 'https://www.example.com/research/ai-infrastructure/2026/andreessen-horowitz-trillion-dollar-question-full-transcript?utm_source=youtube&utm_medium=description';
const LONG_MD = `# 对话安德森：AI 革命的万亿美金之问，以及开源模型、算力投资、创业公司和监管政策在未来十年里会怎样重新塑造整个软件行业

马克·安德森在这期访谈里谈 ${LONG_WORD} 和 AI 基础设施投资。原始资料见 ${LONG_URL} 。

## 一、${LONG_WORD} 是新的计算平台吗？以及为什么这一轮投入和过去八十年都不一样

### Superintelligence-infrastructure-investment-cycle-and-the-trillion-dollar-question

**主持人:** 你为什么说 AI 是一次平台级的变化？${'这一轮投入的规模、速度和参与者都和以往不同，'.repeat(6)}

**安德森:** ${'过去八十年，计算机一直是按指令执行的机器。大模型第一次让软件能处理模糊的问题。'.repeat(5)}${LONG_WORD}

1. 算力：${LONG_WORD}
2. 模型：前沿模型的能力每年都有明显提升，参见 ${LONG_URL}

## 二、开源模型与创业公司

### 开源的影响

**主持人:** 开源会不会让大公司失去优势？

**安德森:** 开源让小团队也能用上前沿能力。`;

// 抓：长标题、长段落、长英文单词、长链接、长生成要求、长 5W1H 内容把页面撑出横向滚动或文字溢出容器
test('长内容不溢出', async ({ page, api }) => {
  api.queueGeneration(
    sseReply(
      generationEvents({
        meta: meta({
          video: {
            id: 'xRh2sVcNXQ8',
            title: 'Marc Andreessen on the AI Revolution: The Trillion-Dollar Question, Open Source Models, Startups and What Comes Next | Full Interview',
            channel: 'a16z',
            lengthSeconds: 7200,
          },
        }),
        markdown: LONG_MD,
        end: ['done', done({ numberWarnings: [{ time: '1:02:03', fragment: `${LONG_WORD},200`, written: ['1200000000000000000000000000'] }] })],
      }),
    ),
  );
  api.queueSummary(
    summaryReply('1', {
      who: `马克·安德森（Marc Andreessen）和主持人 ${LONG_WORD}`,
      what: '讨论 AI 为什么是新的计算平台，'.repeat(6),
      when: null,
      where: LONG_URL,
      why: LONG_WORD,
      how: '对比八十年来的计算机发展',
    }),
  );
  await page.goto('/');
  await page.getByLabel('YouTube 链接').fill(`${SAMPLE_URL}&list=${'PL'.repeat(60)}`);
  await page.getByLabel(/生成要求/).fill(`${'写给不懂技术的投资人，只保留商业相关的内容。'.repeat(8)}${LONG_WORD}`);
  await page.getByRole('button', { name: '生成文章' }).click();
  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'ok');
  await chapter(page, '1').locator('.summary-toggle').click();
  await expect(chapter(page, '1').locator('.summary-table tr')).toHaveCount(6);

  await expect(page.locator('#article h1')).toBeVisible();
  await expect(page.locator('#status .status-detail')).toBeVisible();
  await expect(chapter(page, '1').getByRole('button', { name: /5W1H/ })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot('12-long-content.png', { fullPage: true });
});

