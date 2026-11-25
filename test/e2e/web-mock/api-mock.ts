/**
 * web-mock 和 visual 共用的后端替身：只用 page.route 拦截 /api/**，页面和静态资源仍由真实 wrangler dev 提供。
 * 每个接口按队列依次回复；队列空了或者请求了没有登记的 /api 地址，都记进 unexpected，由夹具在用例结束时断言为空。
 */
import { expect, test as base, type Page, type Route } from '@playwright/test';
import { encodeSse } from '../../../src/shared/sse';
import type { ChapterSummary, NumberWarning, StreamEvents } from '../../../src/shared/types';

export type SseEvent = { [K in keyof StreamEvents]: [K, StreamEvents[K]] }[keyof StreamEvents];

/** 一次回复。hang：一直不回；abort：网络层断开；gate：等这个 Promise 完成后再回。 */
export interface Reply {
  status?: number;
  contentType?: string;
  body?: string;
  hang?: boolean;
  abort?: boolean;
  gate?: Promise<void>;
}

export interface RecordedRequest {
  method: string;
  path: string;
  postData: string | null;
  contentType: string | undefined;
}

export interface ApiMock {
  generations: RecordedRequest[];
  summaries: RecordedRequest[];
  unexpected: string[];
  queueGeneration(...replies: Reply[]): void;
  queueSummary(...replies: Reply[]): void;
}

export const SAMPLE_URL = 'https://www.youtube.com/watch?v=xRh2sVcNXQ8';
export const PRIMARY_MODEL = 'gemini-3.8-flash';
export const FALLBACK_MODEL = 'gemini-3.6-flash';
/** 固定的浏览器时间，状态条的"已用时 N 秒"因此可预期 */
export const FIXED_TIME = new Date('2026-11-25T10:00:00+08:00');

export const ARTICLE_MD = `# 对话安德森：AI 革命的万亿美金之问

马克·安德森在这期访谈里谈 AI 基础设施投资、开源模型和创业公司的机会。

## 一、AI 是新的计算平台

### 平台级变化

**主持人:** 你为什么说 AI 是一次平台级的变化？

**安德森:** 过去八十年，计算机一直是按指令执行的机器。大模型第一次让软件能处理模糊的问题，这一轮基础设施投入约 1200 亿美元。

1. 算力：数据中心和芯片的投入仍在加速。
2. 模型：前沿模型的能力每年都有明显提升。

## 二、开源模型与创业公司

### 开源的影响

**主持人:** 开源会不会让大公司失去优势？

**安德森:** 开源让小团队也能用上前沿能力，竞争会集中在产品和分发上。`;

export const ARTICLE_CHAPTERS = [
  { id: '1', title: '一、AI 是新的计算平台' },
  { id: '2', title: '二、开源模型与创业公司' },
];

/** 写到"一章开了个头"就断掉的部分正文 */
export const PARTIAL_MD = `# 对话安德森：AI 革命的万亿美金之问

马克·安德森在这期访谈里谈 AI 基础设施投资、开源模型和创业公司的机会。

## 一、AI 是新的计算平台

### 平台级变化

**主持人:** 你为什么说 AI 是一次平台级的变化？`;

export const SECOND_ARTICLE_MD = `# 第二篇：开源模型的商业逻辑

这是按新的生成要求写的第二篇文章。

## 开源与闭源

### 成本

**安德森:** 开源模型的成本每年都在下降。`;

export const WARNINGS: NumberWarning[] = [
  { time: '34:25', fragment: 'of,200', written: ['1200'] },
  { time: null, fragment: '3,', written: ['3000', '3万'] },
];

export function meta(overrides: Partial<StreamEvents['meta']> = {}): StreamEvents['meta'] {
  return {
    generationId: 'gen-1',
    video: { id: 'xRh2sVcNXQ8', title: '对话安德森', channel: 'a16z', lengthSeconds: 3600 },
    transcript: { source: 'live', language: 'en', kind: 'manual', chars: 52000 },
    model: PRIMARY_MODEL,
    ...overrides,
  };
}

export function done(overrides: Partial<StreamEvents['done']> = {}): StreamEvents['done'] {
  return {
    chapters: ARTICLE_CHAPTERS,
    chars: 1234,
    timing: { transcriptMs: 800, firstTokenMs: 4200, modelDoneMs: 30000, savedMs: 30100 },
    numberWarnings: [],
    model: PRIMARY_MODEL,
    ...overrides,
  };
}

/** 把正文切成几段 delta，模拟流式输出 */
export function deltas(markdown: string, pieces = 3): SseEvent[] {
  const size = Math.ceil(markdown.length / pieces);
  const out: SseEvent[] = [];
  for (let i = 0; i < markdown.length; i += size) out.push(['delta', { text: markdown.slice(i, i + size) }]);
  return out;
}

/** 生成接口的完整事件序列：stage → meta → stage → delta… → 结尾（done / error / 无结尾表示中断） */
export function generationEvents(options: {
  meta?: StreamEvents['meta'];
  markdown?: string;
  end?: SseEvent | null;
}): SseEvent[] {
  const markdown = options.markdown ?? ARTICLE_MD;
  const end = options.end === undefined ? (['done', done()] as SseEvent) : options.end;
  const events: SseEvent[] = [
    ['stage', { stage: 'transcript' }],
    ['meta', options.meta ?? meta()],
    ['stage', { stage: 'generating' }],
    ...deltas(markdown),
  ];
  if (end) events.push(end);
  return events;
}

export function sseReply(events: SseEvent[], extra: Partial<Reply> = {}): Reply {
  return {
    status: 200,
    contentType: 'text/event-stream; charset=utf-8',
    body: events.map(([name, data]) => encodeSse(name, data)).join(''),
    ...extra,
  };
}

export function jsonReply(status: number, data: unknown, extra: Partial<Reply> = {}): Reply {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(data), ...extra };
}

export function apiError(status: number, code: string, message: string): Reply {
  return jsonReply(status, { error: { code, message } });
}

export function summaryReply(chapterId: string, summary: ChapterSummary, extra: Partial<Reply> = {}): Reply {
  return jsonReply(200, { chapterId, summary, cached: false }, extra);
}

export const SUMMARY_1: ChapterSummary = {
  who: '马克·安德森和主持人',
  what: '讨论 AI 为什么是新的计算平台',
  when: null,
  where: null,
  why: '大模型让软件第一次能处理模糊问题',
  how: '对比八十年来的计算机发展',
};

export const HANG: Reply = { hang: true };

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function respond(route: Route, reply: Reply | undefined, unexpected: string[]): Promise<void> {
  if (!reply) {
    unexpected.push(`队列已空：${route.request().method()} ${new URL(route.request().url()).pathname}`);
    await route.fulfill({ status: 599, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: '测试没有准备这次回复' } }) });
    return;
  }
  if (reply.gate) await reply.gate;
  if (reply.hang) return; // 不回复，请求一直挂着
  if (reply.abort) return route.abort('connectionreset');
  await route
    .fulfill({ status: reply.status ?? 200, contentType: reply.contentType, body: reply.body ?? '' })
    .catch(() => {}); // 页面已经中止了这次请求
}

function record(route: Route): RecordedRequest {
  const request = route.request();
  return {
    method: request.method(),
    path: new URL(request.url()).pathname,
    postData: request.postData(),
    contentType: request.headers()['content-type'],
  };
}

export async function installApiMock(page: Page): Promise<ApiMock> {
  const generationQueue: Reply[] = [];
  const summaryQueue: Reply[] = [];
  const mock: ApiMock = {
    generations: [],
    summaries: [],
    unexpected: [],
    queueGeneration: (...replies) => void generationQueue.push(...replies),
    queueSummary: (...replies) => void summaryQueue.push(...replies),
  };
  // 后注册的路由优先匹配：兜底的 /api/** 先注册
  await page.route('**/api/**', async (route) => {
    mock.unexpected.push(`未登记的接口：${route.request().method()} ${new URL(route.request().url()).pathname}`);
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'not_found', message: '接口不存在' } }) });
  });
  await page.route('**/api/generations', async (route) => {
    mock.generations.push(record(route));
    await respond(route, generationQueue.shift(), mock.unexpected);
  });
  await page.route('**/api/generations/*/chapters/*/summary', async (route) => {
    mock.summaries.push(record(route));
    await respond(route, summaryQueue.shift(), mock.unexpected);
  });
  return mock;
}

/** 夹具 api：每个用例自动装好后端替身，结束时确认没有多余或没准备回复的 /api 请求 */
export const test = base.extend<{ api: ApiMock }>({
  api: async ({ page }, use) => {
    const api = await installApiMock(page);
    await use(api);
    // 挂起的请求在页面关闭时由浏览器丢弃，处理函数里的报错不影响结果
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    expect(api.unexpected, '不应出现测试没有准备的 /api 请求').toEqual([]);
  },
});

export { expect };

/** 状态条主文案（不含下方的来源说明） */
export async function statusMain(page: Page): Promise<string> {
  return page.locator('#status .status-text').evaluate((el) => el.firstChild?.textContent ?? '');
}

/** 页面没有横向溢出 */
export async function horizontalOverflow(page: Page): Promise<{ scrollWidth: number; innerWidth: number }> {
  return page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
}
