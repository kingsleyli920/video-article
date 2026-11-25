import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { SseParser } from '../../src/shared/sse';
import type { StreamEvents } from '../../src/shared/types';

const SAMPLE_URL = 'https://www.youtube.com/watch?v=xRh2sVcNXQ8';

declare global {
  interface Window {
    __sseChunks: { t: number; text: string }[];
  }
}

/**
 * 抓：正文在模型结束后才一次性到达浏览器（假流式）、done 前就能点 5W1H、
 * 总结请求夹带前端内容、重复点击重复请求。会真实调用 YouTube 和 Gemini（1 次生成 + 1 次总结）。
 */
test('示例视频：实时字幕 → 流式文章 → 保存 → 章节 5W1H', async ({ page }, testInfo) => {
  // 只在测试里包装 TextDecoder，记录浏览器每收到一个响应分块的时间，不改应用代码
  await page.addInitScript(() => {
    window.__sseChunks = [];
    const decode = TextDecoder.prototype.decode;
    TextDecoder.prototype.decode = function (input?: AllowSharedBufferSource, options?: TextDecodeOptions) {
      const text = decode.call(this, input, options);
      if (text) window.__sseChunks.push({ t: performance.now(), text });
      return text;
    };
  });
  const summaryRequests: { method: string; body: string | null }[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/summary')) summaryRequests.push({ method: req.method(), body: req.postData() });
  });

  await page.goto('/');
  // "填入示例视频"只填链接，不发起生成
  await page.getByRole('button', { name: '填入示例视频' }).click();
  await expect(page.getByLabel('YouTube 链接')).toHaveValue(SAMPLE_URL);
  await expect(page.locator('#status')).toBeHidden();
  const clickAt = await page.evaluate(() => performance.now());
  await page.getByRole('button', { name: '生成文章' }).click();

  // 生成中：表单锁定，可以停止，状态条显示阶段和已用时间；章节出现但 5W1H 不可点
  const status = page.locator('#status');
  await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible();
  await expect(status).toContainText(/已用时 \d+ 秒/);
  const firstChapter = page.locator('section.chapter').first();
  await expect(firstChapter).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('#submit')).toBeDisabled();
  await expect(firstChapter.locator('.summary-toggle')).toBeDisabled();
  await expect(status).toHaveAttribute('data-tone', 'busy');
  await page.screenshot({ path: testInfo.outputPath('1-streaming.png') });

  // 每 1.5 秒采样一次正文长度，直到完成或失败
  const samples: [number, number][] = [];
  for (;;) {
    const [t, length, tone] = await page.evaluate(() => [
      performance.now(),
      document.getElementById('article')!.textContent!.length,
      document.getElementById('status')!.dataset.tone,
    ] as const);
    samples.push([Math.round(t - clickAt), length]);
    if (tone !== 'busy') break;
    await page.waitForTimeout(1_500);
  }
  await expect(status).toHaveAttribute('data-tone', 'ok');
  await expect(status).toContainText('已完成');
  await expect(page.getByRole('button', { name: '停止生成' })).toBeHidden();
  await expect(page.locator('#submit')).toBeEnabled();

  // 从浏览器收到的分块还原事件：第一段正文到达时间 vs 服务端回报的模型结束时间
  const chunks = await page.evaluate(() => window.__sseChunks);
  const parser = new SseParser();
  let firstDeltaAt: number | null = null;
  let markdown = '';
  let done: StreamEvents['done'] | null = null;
  let meta: StreamEvents['meta'] | null = null;
  for (const chunk of chunks) {
    for (const message of parser.push(chunk.text)) {
      if (message.event === 'delta') {
        firstDeltaAt ??= Math.round(chunk.t - clickAt);
        markdown += (JSON.parse(message.data) as StreamEvents['delta']).text;
      }
      if (message.event === 'done') done = JSON.parse(message.data);
      if (message.event === 'meta') meta = JSON.parse(message.data);
    }
  }
  expect(done).not.toBeNull();
  expect(firstDeltaAt).not.toBeNull();
  // 页面显示的字数和服务端按统一口径算出的一致
  await expect(status).toContainText(`${done!.chars} 字`);
  expect(firstDeltaAt!).toBeLessThan(done!.timing.modelDoneMs - 5_000);
  const growing = samples.filter(([, n], i) => i > 0 && n > samples[i - 1]![1]);
  expect(growing.length).toBeGreaterThanOrEqual(3);

  // 完成：全部 5W1H 可点
  const toggles = page.locator('.summary-toggle');
  const chapterCount = await toggles.count();
  expect(chapterCount).toBe(done!.chapters.length);
  for (let i = 0; i < chapterCount; i++) await expect(toggles.nth(i)).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('2-done-top.png') });

  // 点第二章的 5W1H：固定六行，再点收起、再点展开都不重复请求
  const chapter = page.locator('section.chapter').nth(1);
  const toggle = chapter.locator('.summary-toggle');
  await toggle.click();
  await expect(chapter.locator('.summary-loading')).toBeVisible();
  await expect(chapter.locator('.summary-table tr')).toHaveCount(6, { timeout: 90_000 });
  const rows = await chapter.locator('.summary-table tr').evaluateAll((trs) => trs.map((tr) => [tr.querySelector('th')!.textContent, tr.querySelector('td')!.textContent]));
  expect(rows.map(([label]) => label)).toEqual(['Who', 'What', 'When', 'Where', 'Why', 'How']);
  for (const [, value] of rows) expect(value!.trim().length).toBeGreaterThan(0);
  await chapter.scrollIntoViewIfNeeded();
  await chapter.screenshot({ path: testInfo.outputPath('3-summary.png') });

  await toggle.click();
  await expect(chapter.locator('.summary-panel')).toBeHidden();
  await toggle.click();
  await expect(chapter.locator('.summary-panel')).toBeVisible();
  expect(summaryRequests).toEqual([{ method: 'POST', body: null }]);

  await page.setViewportSize({ width: 390, height: 844 });
  await chapter.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('4-mobile.png') });

  writeFileSync(testInfo.outputPath('article.md'), markdown);
  writeFileSync(
    testInfo.outputPath('evidence.json'),
    JSON.stringify({ generationId: meta?.generationId, transcript: meta?.transcript, model: meta?.model, firstDeltaAt, serverTiming: done!.timing, chars: done!.chars, chapters: done!.chapters, samples, summaryChapterId: '2', summary: rows, chunkCount: chunks.length }, null, 2),
  );
  console.log(`第一段正文到达浏览器 ${firstDeltaAt} ms；服务端模型结束 ${done!.timing.modelDoneMs} ms；共 ${chunks.length} 个分块，${chapterCount} 章`);
});
