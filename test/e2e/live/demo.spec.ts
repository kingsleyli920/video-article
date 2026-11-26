import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { SseParser } from '../../../src/shared/sse';
import type { StreamEvents } from '../../../src/shared/types';

/**
 * 演示录屏：对线上地址做一次真实生成，全程录屏，并记下各个时刻（相对录屏开始），供事后剪辑精简版时定位。
 * 只操作应用页面：填链接和要求 → 等真实流式生成、核对、保存 → 滚动阅读 → 展开核对记录 → 点一章 5W1H → 手机宽度。
 * 不做断言式验收（那是 candidate-live.spec.ts 的事），只在生成没有成功时失败。会真实调用 1 次生成 + 1 次总结。
 *
 *   DEMO_URL=<YouTube 链接，不设用示例视频> DEMO_INSTRUCTIONS=<生成要求，可空> DEMO_CHAPTER=<点第几章的 5W1H，默认 2>
 */
const DEMO_URL = process.env.DEMO_URL;
const DEMO_INSTRUCTIONS = process.env.DEMO_INSTRUCTIONS ?? '';
const DEMO_CHAPTER = Number(process.env.DEMO_CHAPTER ?? 2);
const SIZE = { width: 1280, height: 800 };

test.use({ viewport: SIZE, video: { mode: 'on', size: SIZE } });

declare global {
  interface Window {
    __demoChunks: { t: number; text: string }[];
  }
}

test('演示录屏：真实生成 → 阅读 → 核对记录 → 5W1H → 手机宽度', async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  const startedAt = Date.now();
  /** 各时刻距录屏开始的秒数。录屏从页面创建开始，和这里的起点相差不到一秒 */
  const marks: Record<string, number> = {};
  const mark = (name: string) => (marks[name] = Math.round((Date.now() - startedAt) / 100) / 10);
  const pause = (ms: number) => page.waitForTimeout(ms);
  /** 平滑滚动到页面的某个位置，用时 ms */
  const glide = async (to: number | 'bottom', ms: number) => {
    await page.evaluate(
      async ([target, duration]) => {
        const from = window.scrollY;
        const end = target === 'bottom' ? document.documentElement.scrollHeight - window.innerHeight : (target as number);
        const t0 = performance.now();
        await new Promise<void>((resolve) => {
          const step = () => {
            const p = Math.min(1, (performance.now() - t0) / (duration as number));
            window.scrollTo(0, from + (end - from) * p);
            if (p < 1) setTimeout(step, 16);
            else resolve();
          };
          step();
        });
      },
      [to, ms] as const,
    );
  };

  await page.addInitScript(() => {
    window.__demoChunks = [];
    const decode = TextDecoder.prototype.decode;
    TextDecoder.prototype.decode = function (input?: AllowSharedBufferSource, options?: TextDecodeOptions) {
      const text = decode.call(this, input, options);
      if (text) window.__demoChunks.push({ t: Date.now(), text });
      return text;
    };
  });

  await page.goto('/');
  mark('loaded');
  await pause(1_500);
  if (DEMO_URL) await page.getByLabel('YouTube 链接').pressSequentially(DEMO_URL, { delay: 15 });
  else await page.getByRole('button', { name: '填入示例视频' }).click();
  await pause(800);
  if (DEMO_INSTRUCTIONS) {
    await page.getByLabel(/生成要求/).pressSequentially(DEMO_INSTRUCTIONS, { delay: 25 });
    await pause(2_500);
  }
  mark('inputReady');
  await page.getByRole('button', { name: '生成文章' }).click();
  mark('submitted');

  // 等待阶段：来源面板出来后展开字幕原文片段看一眼，再收起
  await expect(page.locator('#source')).toBeVisible({ timeout: 60_000 });
  mark('sourcePanel');
  await pause(1_500);
  const preview = page.locator('#source details summary');
  if (await preview.count()) {
    await preview.first().click();
    await pause(3_000);
    await preview.first().click();
  }

  // 正文开始出现：跟着最新的文字往下滚，让增长过程留在画面里
  const body = page.locator('#article .chapter-body, #article > .article-intro');
  await expect(body.first()).toBeVisible({ timeout: 300_000 });
  mark('firstText');
  const status = page.locator('#status');
  let reviewingMarked = false;
  for (;;) {
    const [tone, text] = await page.evaluate(() => [document.getElementById('status')!.dataset.tone, document.getElementById('status')!.textContent ?? ''] as const);
    if (tone !== 'busy') break;
    if (text.includes('核对') || text.includes('修订初稿')) {
      if (!reviewingMarked) {
        mark('reviewing');
        reviewingMarked = true;
        // 核对期间回到页面顶部，让状态条留在画面里
        await glide(0, 800);
      }
    } else {
      await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight - window.innerHeight }));
    }
    await pause(400);
  }
  mark('done');
  await expect(status).toHaveAttribute('data-tone', 'ok');
  await expect(status).toContainText('已完成');
  await pause(4_000);

  // 核对记录：展开看几秒再收起
  const record = page.locator('.article-review details summary');
  if (await record.count()) {
    await record.scrollIntoViewIfNeeded();
    await pause(1_000);
    await record.click();
    mark('reviewRecordOpen');
    await pause(1_500);
    await page.mouse.wheel(0, 500);
    await pause(4_000);
    await glide(0, 600);
    await record.click();
    await pause(800);
  }

  // 通读：从头滚到尾
  mark('readStart');
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await glide('bottom', Math.min(40_000, Math.max(12_000, height * 2.2)));
  mark('readEnd');
  await pause(1_500);

  // 5W1H：点一章，等真实总结出来
  const chapters = page.locator('section.chapter');
  const index = Math.min(DEMO_CHAPTER, await chapters.count()) - 1;
  const chapter = chapters.nth(index);
  await chapter.locator('.chapter-heading').scrollIntoViewIfNeeded();
  await page.evaluate((i) => window.scrollTo({ top: (document.querySelectorAll('section.chapter')[i] as HTMLElement).offsetTop - 20 }), index);
  await pause(1_500);
  const summaryResponse = page.waitForResponse((r) => r.url().includes('/summary'), { timeout: 120_000 });
  await chapter.locator('.summary-toggle').click();
  mark('summaryClicked');
  await expect(chapter.locator('.summary-table tr')).toHaveCount(6, { timeout: 120_000 });
  mark('summaryShown');
  const summary = (await (await summaryResponse).json()) as { cached: boolean };
  await pause(9_000);
  await page.mouse.wheel(0, 450);
  await pause(5_000);

  // 手机宽度：同一份结果，只调整视口
  await page.setViewportSize({ width: 390, height: 800 });
  mark('mobile');
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await pause(2_500);
  await glide(1_400, 6_000);
  await page.evaluate((i) => window.scrollTo({ top: (document.querySelectorAll('section.chapter')[i] as HTMLElement).offsetTop - 10 }), index);
  await pause(5_000);
  await glide('bottom', 6_000);
  await pause(1_500);
  mark('end');

  // 事件流里的版本无关信息：字幕来源、模型、服务端计时、核对结果
  const chunks = await page.evaluate(() => window.__demoChunks);
  const parser = new SseParser();
  let meta: StreamEvents['meta'] | null = null;
  let done: StreamEvents['done'] | null = null;
  let finalMarkdown = '';
  let draft = '';
  for (const chunk of chunks) {
    for (const message of parser.push(chunk.text)) {
      if (message.event === 'meta') meta = JSON.parse(message.data);
      if (message.event === 'delta') draft += (JSON.parse(message.data) as StreamEvents['delta']).text;
      if (message.event === 'revised') finalMarkdown = (JSON.parse(message.data) as StreamEvents['revised']).markdown;
      if (message.event === 'done') done = JSON.parse(message.data);
    }
  }
  expect(done).not.toBeNull();
  writeFileSync(testInfo.outputPath('article.md'), finalMarkdown || draft);
  writeFileSync(testInfo.outputPath('draft.md'), draft);
  writeFileSync(testInfo.outputPath('raw.sse'), chunks.map((c) => c.text).join(''));
  writeFileSync(
    testInfo.outputPath('timeline.json'),
    JSON.stringify(
      {
        url: DEMO_URL ?? '示例视频',
        instructions: DEMO_INSTRUCTIONS,
        marks,
        video: meta!.video,
        transcript: { ...meta!.transcript, preview: undefined },
        model: done!.model,
        serverTiming: done!.timing,
        chars: done!.chars,
        chapters: done!.chapters,
        review: done!.review,
        summaryChapter: index + 1,
        summaryCached: summary.cached,
      },
      null,
      2,
    ),
  );
});
