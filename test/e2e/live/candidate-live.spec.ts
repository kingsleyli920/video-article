import { expect, test, type Response } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { countArticleChars, hasReadableParagraph } from '../../../src/shared/article';
import { SseParser } from '../../../src/shared/sse';
import type { StreamEvents } from '../../../src/shared/types';
import { TIMEOUTS } from '../../../src/client/api';
import { bodyGrowth, worthKeeping, type Sample } from './body-growth';

const SAMPLE_URL = 'https://www.youtube.com/watch?v=xRh2sVcNXQ8';
/** 期望写文章的模型（候选配置验收时设置，例如 EXPECT_MODEL=gemini-4-hydrogen）；不设时不检查 */
const EXPECT_MODEL = process.env.EXPECT_MODEL;
/** 要测的视频和生成要求；不设时用示例视频、要求为空（补充验收用它跑其他视频） */
const CASE_URL = process.env.CASE_URL;
const CASE_INSTRUCTIONS = process.env.CASE_INSTRUCTIONS ?? '';
const FIELDS = ['who', 'what', 'when', 'where', 'why', 'how'];
/**
 * 生成中多久看一次页面正文的长度。短文章的正文可能不到半秒就发完（补充验收里 268 字的那篇约 470 毫秒），
 * 页面每 80 毫秒重绘一次；1.5 秒看一次会把整个增长过程错过，只看到 0 字和完整长度。
 */
const SAMPLE_INTERVAL_MS = 100;

declare global {
  interface Window {
    __sseChunks: { t: number; text: string }[];
  }
}

/** 文本里与正文逐字相同、长度达到 window 的片段个数：5W1H 应当是概括，不是把正文原样抄回来 */
function echoedSpans(value: string, article: string, window = 40): number {
  let count = 0;
  for (let i = 0; i + window <= value.length; i += window) if (article.includes(value.slice(i, i + window))) count++;
  return count;
}

/**
 * 候选配置验收（真实 YouTube 和 Gemini）。抓：
 * - 来源面板要等正文出来才显示（等待期间页面一片空白）；
 * - 正文在模型结束后才一次性到达浏览器；
 * - 正文分块陆续到了浏览器，页面却等到完成才一次贴出来；
 * - 实际写文章的不是候选模型（悄悄换了备用模型）；
 * - 两个不同章节的 5W1H 有一个走了缓存、字段缺失、请求夹带正文或把正文原样抄回。
 * 会真实调用 1 次生成 + 2 次总结。
 */
test('候选配置：来源面板先于正文 → 流式文章 → 保存 → 两个不同章节的 5W1H（都不走缓存）', async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  await page.addInitScript(() => {
    window.__sseChunks = [];
    const decode = TextDecoder.prototype.decode;
    TextDecoder.prototype.decode = function (input?: AllowSharedBufferSource, options?: TextDecodeOptions) {
      const text = decode.call(this, input, options);
      if (text) window.__sseChunks.push({ t: performance.now(), text });
      return text;
    };
  });
  const summaryRequests: { url: string; body: string | null }[] = [];
  const summaryResponses: { url: string; status: number; body: unknown }[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/summary')) summaryRequests.push({ url: req.url(), body: req.postData() });
  });
  page.on('response', async (res: Response) => {
    if (!res.url().includes('/summary')) return;
    summaryResponses.push({ url: res.url(), status: res.status(), body: await res.json().catch(() => null) });
  });

  await page.goto('/');
  if (CASE_URL) await page.getByLabel('YouTube 链接').fill(CASE_URL);
  else await page.getByRole('button', { name: '填入示例视频' }).click();
  if (CASE_INSTRUCTIONS) await page.getByLabel(/生成要求/).fill(CASE_INSTRUCTIONS);
  const clickAt = await page.evaluate(() => performance.now());
  await page.getByRole('button', { name: '生成文章' }).click();

  // 来源面板：收到 meta 就显示，此时正文还是空的
  const source = page.locator('#source');
  await expect(source).toBeVisible({ timeout: 60_000 });
  const sourceAt = Math.round((await page.evaluate(() => performance.now())) - clickAt);
  const articleLengthAtSource = await page.locator('#article').evaluate((el) => el.textContent?.length ?? 0);
  const sourceText = (await source.innerText()).replace(/\s+/g, ' ');
  expect(sourceText).toContain('来源视频');
  expect(sourceText).toContain('字幕来源');
  await page.screenshot({ path: testInfo.outputPath('1-waiting-source.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('1-waiting-source-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 860 });

  // 生成中每 100 毫秒看一次正文长度，直到结束。长度没变时每 1.5 秒留一条（等模型思考的几十秒里一直是 0），
  // 长度变了的每条都留；结束后的那一条一定留
  const status = page.locator('#status');
  const samples: Sample[] = [];
  for (;;) {
    const [t, length, tone] = await page.evaluate(() => [performance.now(), document.getElementById('article')!.textContent!.length, document.getElementById('status')!.dataset.tone] as const);
    const sample: Sample = [Math.round(t - clickAt), length];
    if (tone !== 'busy' || worthKeeping(samples.at(-1), sample)) samples.push(sample);
    if (tone !== 'busy') break;
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  }
  await expect(status).toHaveAttribute('data-tone', 'ok');
  await expect(status).toContainText('已完成');
  await expect(source).toBeVisible();

  // 浏览器收到的分块还原：第一个正文分块、第一段可读正文的到达时间
  const chunks = await page.evaluate(() => window.__sseChunks);
  const parser = new SseParser();
  let markdown = '';
  /** 流式初稿（最终文章和它不同时才有）、核对采用的修订、各阶段事件到达的时间 */
  let draft: string | null = null;
  let revisions: StreamEvents['revised']['revisions'] = [];
  const stages: [number, string][] = [];
  const deltaTimes = new Set<number>();
  let firstDeltaAt: number | null = null;
  let firstParagraphAt: number | null = null;
  let lastDeltaAt: number | null = null;
  let doneAt: number | null = null;
  let meta: StreamEvents['meta'] | null = null;
  let done: StreamEvents['done'] | null = null;
  for (const chunk of chunks) {
    for (const message of parser.push(chunk.text)) {
      if (message.event === 'meta') meta = JSON.parse(message.data);
      if (message.event === 'stage') stages.push([Math.round(chunk.t - clickAt), (JSON.parse(message.data) as StreamEvents['stage']).stage]);
      if (message.event === 'revised') {
        // 核对后的最终文章：之后页面、保存的上下文和 5W1H 都以它为准
        const data = JSON.parse(message.data) as StreamEvents['revised'];
        draft = markdown;
        markdown = data.markdown;
        revisions = data.revisions;
      }
      if (message.event === 'done') {
        done = JSON.parse(message.data);
        doneAt = Math.round(chunk.t - clickAt);
      }
      if (message.event === 'delta') {
        firstDeltaAt ??= Math.round(chunk.t - clickAt);
        lastDeltaAt = Math.round(chunk.t - clickAt);
        deltaTimes.add(lastDeltaAt);
        markdown += (JSON.parse(message.data) as StreamEvents['delta']).text;
        if (firstParagraphAt === null && hasReadableParagraph(markdown)) firstParagraphAt = Math.round(chunk.t - clickAt);
      }
    }
  }
  expect(meta).not.toBeNull();
  expect(done).not.toBeNull();
  // 等待模型输出期间：服务端每 15 秒发一次心跳（SSE 注释 ": keep-alive"），浏览器任何两次收到字节的间隔
  // 都要短于前端的无字节超时（45 秒），否则前端会在模型思考时误判连接中断
  const beforeFirstDelta = chunks.filter((c) => Math.round(c.t - clickAt) < firstDeltaAt!);
  const heartbeats = beforeFirstDelta.filter((c) => c.text.includes(': keep-alive')).length;
  const arrivals = [0, ...beforeFirstDelta.map((c) => Math.round(c.t - clickAt)), firstDeltaAt!];
  const maxSilenceBeforeFirstDelta = Math.max(...arrivals.slice(1).map((t, i) => t - arrivals[i]!));
  expect(maxSilenceBeforeFirstDelta).toBeLessThan(TIMEOUTS.generationIdleMs);
  if (firstDeltaAt! > 30_000) expect(heartbeats).toBeGreaterThanOrEqual(1);
  // 文章只有一段正文时，要到最后一个正文分块才算读到完整段落
  if (firstParagraphAt === null && hasReadableParagraph(markdown, true)) firstParagraphAt = lastDeltaAt;
  if (EXPECT_MODEL) {
    expect(meta!.model).toBe(EXPECT_MODEL);
    expect(done!.model).toBe(EXPECT_MODEL);
  }
  expect(firstDeltaAt!).toBeGreaterThan(sourceAt - 2_000);
  // 真流式：正文分块在不同时刻陆续到达，首个分块早于模型结束。高档思考下短文的正文几秒就发完，不能要求"早 5 秒"
  expect(deltaTimes.size).toBeGreaterThanOrEqual(3);
  expect(firstDeltaAt!).toBeLessThan(done!.timing.modelDoneMs);
  // 页面上的正文也在完成前就开始增长：完成前至少有一次采样看到的是中间长度，不是分块到了却攒到完成才一次贴出来
  const growth = bodyGrowth(samples, doneAt!);
  expect(growth.ok, growth.reason).toBe(true);
  writeFileSync(testInfo.outputPath('article.md'), markdown);
  if (draft !== null) writeFileSync(testInfo.outputPath('draft.md'), draft);
  // 核对阶段：保存前一定经过"对照字幕核对"；页面显示的是核对后的最终文章，不是流式初稿
  expect(stages.map(([, s]) => s)).toContain('reviewing');
  expect(done!.review.revisions).toBe(revisions.length);
  expect(done!.chars).toBe(countArticleChars(markdown));
  const pageText = (await page.locator('#article').innerText()).replace(/\s+/g, '');
  const plain = (text: string) => text.replace(/\s+/g, '');
  const noMarkup = (text: string) => !/[*_`#>\[\]|]/.test(text) && text.trim().length >= 8;
  for (const r of revisions) {
    if (r.after && noMarkup(r.after)) expect(pageText, `页面应显示修订后的句子：${r.after}`).toContain(plain(r.after));
  }
  if (revisions.length > 0) {
    const record = page.locator('.article-review details');
    await expect(record.locator('summary')).toContainText(`修订了 ${revisions.length} 处`);
    await record.locator('summary').click();
    await expect(record.locator('li')).toHaveCount(revisions.length);
    await page.screenshot({ path: testInfo.outputPath('2-review-record.png'), fullPage: true });
    await record.locator('summary').click();
  }
  await page.screenshot({ path: testInfo.outputPath('2-done.png') });

  // 两个不同章节的 5W1H：第 2 章和第 4 章；不足 4 章时取第一章和最后一章；只有一章时只取这一章
  const chapters = page.locator('section.chapter');
  const count = await chapters.count();
  expect(count).toBe(done!.chapters.length);
  const picks = count >= 4 ? [1, 3] : count >= 2 ? [0, count - 1] : [0];
  const summaries: { chapterId: string; title: string; rows: string[][]; ms: number }[] = [];
  for (const index of picks) {
    const chapter = chapters.nth(index);
    const startedAt = Date.now();
    await chapter.locator('.summary-toggle').click();
    await expect(chapter.locator('.summary-table tr')).toHaveCount(6, { timeout: 110_000 });
    const rows = await chapter.locator('.summary-table tr').evaluateAll((trs) => trs.map((tr) => [tr.querySelector('th')!.textContent ?? '', tr.querySelector('td')!.textContent ?? '']));
    expect(rows.map(([label]) => label)).toEqual(['Who', 'What', 'When', 'Where', 'Why', 'How']);
    for (const [, value] of rows) expect(value!.trim().length).toBeGreaterThan(0);
    summaries.push({ chapterId: done!.chapters[index]!.id, title: done!.chapters[index]!.title, rows, ms: Date.now() - startedAt });
    await chapter.scrollIntoViewIfNeeded();
    await chapter.screenshot({ path: testInfo.outputPath(`3-summary-ch${index + 1}.png`) });
  }

  // 请求不带正文；两次都是现生成（cached=false）；返回只有六个字段，没有把正文原样抄回
  expect(summaryRequests.map((r) => r.body)).toEqual(picks.map(() => null));
  expect(new Set(summaryRequests.map((r) => r.url)).size).toBe(picks.length);
  expect(summaryResponses.map((r) => r.status)).toEqual(picks.map(() => 200));
  const echoes: number[] = [];
  for (const response of summaryResponses) {
    const body = response.body as { summary: Record<string, string>; cached: boolean };
    expect(body.cached).toBe(false);
    expect(Object.keys(body.summary).sort()).toEqual([...FIELDS].sort());
    echoes.push(FIELDS.reduce((n, key) => n + echoedSpans(body.summary[key] ?? '', markdown), 0));
  }
  expect(echoes).toEqual(picks.map(() => 0));

  await page.setViewportSize({ width: 390, height: 844 });
  await chapters.nth(picks.at(-1)!).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('4-mobile.png') });

  writeFileSync(
    testInfo.outputPath('evidence.json'),
    JSON.stringify(
      {
        model: meta!.model,
        doneModel: done!.model,
        stages,
        review: done!.review,
        revisions,
        transcript: meta!.transcript,
        sourceAt,
        articleLengthAtSource,
        heartbeatsBeforeFirstDelta: heartbeats,
        maxSilenceBeforeFirstDelta,
        firstDeltaAt,
        firstParagraphAt,
        doneAt,
        bodyGrowth: growth,
        serverTiming: done!.timing,
        chars: done!.chars,
        chapters: done!.chapters,
        numberWarnings: done!.numberWarnings,
        samples,
        chunkCount: chunks.length,
        summaries,
        summaryResponses,
      },
      null,
      2,
    ),
  );
  console.log(`首个正文前收到心跳 ${heartbeats} 次，最长无字节间隔 ${maxSilenceBeforeFirstDelta} ms；`);
  console.log(`来源面板 ${sourceAt} ms（此时正文 ${articleLengthAtSource} 字）；第一个正文分块 ${firstDeltaAt} ms；第一段可读正文 ${firstParagraphAt} ms；服务端模型结束 ${done!.timing.modelDoneMs} ms；保存 ${done!.timing.savedMs} ms；${count} 章；5W1H 用时 ${summaries.map((s) => s.ms).join(' / ')} ms`);
});
