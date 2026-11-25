import type { Page } from '@playwright/test';
import {
  FIXED_TIME,
  HANG,
  PARTIAL_MD,
  SAMPLE_URL,
  apiError,
  expect,
  generationEvents,
  jsonReply,
  sourceRows,
  sseReply,
  statusMain,
  test,
  type Reply,
} from './api-mock';

async function submit(page: Page): Promise<void> {
  await page.getByLabel('YouTube 链接').fill(SAMPLE_URL);
  await page.getByLabel(/生成要求/).fill('语言简洁');
  await page.getByRole('button', { name: '生成文章' }).click();
}

/** 结束后控件恢复可用 */
async function expectControlsRestored(page: Page): Promise<void> {
  await expect(page.locator('#submit')).toBeEnabled();
  await expect(page.locator('#submit')).toHaveText('生成文章');
  await expect(page.getByRole('button', { name: '停止生成' })).toBeHidden();
  await expect(page.getByLabel('YouTube 链接')).toBeEnabled();
  await expect(page.getByLabel(/生成要求/)).toBeEnabled();
  await expect(page.getByRole('button', { name: '填入示例视频' })).toBeEnabled();
}

test.describe('生成失败', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(FIXED_TIME);
  });

  // 抓：写到一半出错时丢掉已生成的内容、没标"内容不完整"、5W1H 仍可点、没有"重新生成"
  test('error 事件（partial）：显示原因和"重新生成"，保留部分正文并标内容不完整，5W1H 不可点', async ({ page, api }) => {
    api.queueGeneration(
      sseReply(generationEvents({ markdown: PARTIAL_MD, end: ['error', { code: 'gemini_busy', message: 'Gemini 模型繁忙，请稍后重试', partial: true }] })),
    );
    await page.goto('/');
    await submit(page);

    const status = page.locator('#status');
    await expect(status).toHaveAttribute('data-tone', 'error');
    expect(await statusMain(page)).toBe('Gemini 模型繁忙，请稍后重试');
    await expect(status.locator('.status-detail')).toHaveCount(0);
    await expect(status.getByRole('button', { name: '重新生成' })).toBeVisible();
    // 失败后已经取得的来源信息保留
    await expect(page.locator('#source')).toBeVisible();
    expect(await sourceRows(page)).toEqual([
      ['来源视频', '对话安德森', 'a16z · 时长 1:00:00'],
      ['字幕', '英语 · 人工字幕', '整理后 52,000 字符'],
      ['字幕来源', 'YouTube 实时获取'],
    ]);

    const article = page.locator('#article');
    await expect(article).toHaveAttribute('data-state', 'failed');
    await expect(article.locator('h1')).toHaveText('对话安德森：AI 革命的万亿美金之问');
    await expect(article.locator('h2')).toHaveText(['一、AI 是新的计算平台']);
    await expect(article.locator('.chapter-body h3')).toHaveText('平台级变化');
    await expect(article.locator('.chapter-body p')).toHaveText(['主持人: 你为什么说 AI 是一次平台级的变化？']);
    await expect(article.locator('.incomplete-note')).toHaveText('内容不完整：Gemini 模型繁忙，请稍后重试');
    const toggle = article.locator('.summary-toggle');
    await expect(toggle).toBeDisabled();
    await expect(toggle).toHaveAttribute('title', '生成未完成，章节总结不可用');
    await expect(article.locator('.caret')).toHaveCount(0);
    await expectControlsRestored(page);
    expect(api.summaries).toHaveLength(0);
  });

  // 抓：还没写出正文就失败时，仍显示空的"内容不完整"提示
  test('error 事件（无正文）：只显示错误原因，不出现内容不完整提示', async ({ page, api }) => {
    api.queueGeneration(
      sseReply([
        ['stage', { stage: 'transcript' }],
        ['error', { code: 'no_captions', message: '这个视频没有可用的字幕', partial: false }],
      ]),
    );
    await page.goto('/');
    await submit(page);

    await expect(page.locator('#status')).toHaveAttribute('data-tone', 'error');
    expect(await statusMain(page)).toBe('这个视频没有可用的字幕');
    await expect(page.locator('#status .status-detail')).toHaveCount(0);
    await expect(page.locator('#status').getByRole('button', { name: '重新生成' })).toBeVisible();
    // 没收到 meta，来源面板不出现
    await expect(page.locator('#source')).toBeHidden();
    await expect(page.locator('#article')).toBeEmpty();
    await expect(page.locator('#article')).toBeHidden();
    await expectControlsRestored(page);
  });

  const HTTP_CASES: { name: string; reply: Reply; text: string }[] = [
    { name: '429 JSON 错误', reply: apiError(429, 'gemini_quota', 'Gemini 免费额度已用完或请求过于频繁，请稍后再试'), text: 'Gemini 免费额度已用完或请求过于频繁，请稍后再试' },
    { name: '500 JSON 错误', reply: apiError(500, 'internal', '服务器内部错误'), text: '服务器内部错误' },
    { name: '502 非 JSON 响应', reply: { status: 502, contentType: 'text/html', body: '<html>Bad Gateway</html>' }, text: '请求失败（HTTP 502）' },
    { name: '200 但 JSON 体不是事件流', reply: jsonReply(200, { ok: true }), text: '生成中断，文章不完整' },
    { name: '网络层断开', reply: { abort: true }, text: '网络连接中断' },
  ];
  for (const { name, reply, text } of HTTP_CASES) {
    // 抓：HTTP 层错误时页面卡在生成中、文案不是服务端给的原因、没有"重新生成"
    test(`HTTP 失败（${name}）：显示对应原因和"重新生成"`, async ({ page, api }) => {
      api.queueGeneration(reply);
      await page.goto('/');
      await submit(page);

      await expect(page.locator('#status')).toHaveAttribute('data-tone', 'error');
      expect(await statusMain(page)).toBe(text);
      await expect(page.locator('#status').getByRole('button', { name: '重新生成' })).toBeVisible();
      await expect(page.locator('#article')).toBeEmpty();
      await expectControlsRestored(page);
    });
  }

  // 抓：事件流没有 done 就结束时被当成成功（5W1H 可点）或页面一直停在生成中
  test('流没有 done 就结束：判为中断，保留部分正文并标内容不完整', async ({ page, api }) => {
    api.queueGeneration(sseReply(generationEvents({ markdown: PARTIAL_MD, end: null })));
    await page.goto('/');
    await submit(page);

    await expect(page.locator('#status')).toHaveAttribute('data-tone', 'error');
    expect(await statusMain(page)).toBe('生成中断，文章不完整');
    await expect(page.locator('#article')).toHaveAttribute('data-state', 'failed');
    await expect(page.locator('#article h1')).toHaveText('对话安德森：AI 革命的万亿美金之问');
    await expect(page.locator('.incomplete-note')).toHaveText('内容不完整：生成中断，文章不完整');
    await expect(page.locator('.summary-toggle')).toBeDisabled();
    await expect(page.locator('#status').getByRole('button', { name: '重新生成' })).toBeVisible();
    await expectControlsRestored(page);
  });
});

test.describe('停止与超时', () => {
  // 抓：点停止后请求没有真正中止、状态不变、控件不恢复；停止后不能再次生成
  test('请求挂起时点"停止生成"：中止请求、显示已停止、控件恢复，之后能再次生成', async ({ page, api }) => {
    await page.clock.setFixedTime(FIXED_TIME);
    api.queueGeneration(HANG);
    await page.goto('/');
    await submit(page);

    const status = page.locator('#status');
    await expect(status).toHaveAttribute('data-tone', 'busy');
    const failed = page.waitForEvent('requestfailed', (request) => request.url().endsWith('/api/generations'));
    await page.getByRole('button', { name: '停止生成' }).click();
    await failed;

    await expect(status).toHaveAttribute('data-tone', 'idle');
    // 还没有任何内容时不说"已生成的内容保留在下方"
    expect(await statusMain(page)).toBe('已停止生成。');
    await expect(status.getByRole('button', { name: '重新生成' })).toBeVisible();
    await expect(page.locator('#article')).toBeEmpty();
    // 停止按钮隐藏后焦点移到"生成文章"
    await expect(page.getByRole('button', { name: '生成文章' })).toBeFocused();
    await expectControlsRestored(page);
    await expect(page.getByLabel(/生成要求/)).toHaveValue('语言简洁');

    // 第二次操作
    api.queueGeneration(sseReply(generationEvents({})));
    await page.getByRole('button', { name: '生成文章' }).click();
    await expect(status).toHaveAttribute('data-tone', 'ok');
    await expect(page.locator('#article h1')).toHaveText('对话安德森：AI 革命的万亿美金之问');
    expect(api.generations).toHaveLength(2);
  });

  // 抓：客户端空闲超时不生效（页面永远等）、提前触发（不到 45 秒）、超时后没有文案或"重新生成"
  test('45 秒没收到任何字节：客户端超时，提示已停止等待并可重新生成', async ({ page, api }) => {
    await page.clock.install({ time: FIXED_TIME });
    api.queueGeneration(HANG);
    await page.goto('/');
    await page.clock.pauseAt(new Date(FIXED_TIME.getTime() + 60_000));
    await submit(page);

    const status = page.locator('#status');
    await expect(status).toHaveAttribute('data-tone', 'busy');
    expect(await statusMain(page)).toBe('正在获取字幕 · 已用时 0 秒');

    await page.clock.runFor(44_000);
    await expect.poll(() => statusMain(page)).toBe('正在获取字幕 · 已用时 44 秒');
    // 给提前超时的实现留出把错误画出来的真实时间，再断言仍在等待
    await page.waitForTimeout(300);
    await expect(status).toHaveAttribute('data-tone', 'busy');
    expect(await statusMain(page)).toBe('正在获取字幕 · 已用时 44 秒');

    await page.clock.runFor(1_000);
    await expect(status).toHaveAttribute('data-tone', 'error');
    expect(await statusMain(page)).toBe('长时间没有收到服务器的数据，已停止等待');
    await expect(status.getByRole('button', { name: '重新生成' })).toBeVisible();
    await expectControlsRestored(page);

    api.queueGeneration(sseReply(generationEvents({})));
    await status.getByRole('button', { name: '重新生成' }).click();
    await expect(status).toHaveAttribute('data-tone', 'ok');
    expect(api.generations).toHaveLength(2);
    expect(api.generations[1]!.postData).toBe(api.generations[0]!.postData);
  });
});
