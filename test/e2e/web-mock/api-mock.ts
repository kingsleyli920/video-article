/**
 * web-mock 和 visual 共用的后端替身：只用 page.route 拦截 /api/**，页面和静态资源仍由真实 wrangler dev 提供。
 * 每个接口按队列依次回复；队列空了或者请求了没有登记的 /api 地址，都记进 unexpected，由夹具在用例结束时断言为空。
 */
import { expect, test as base, type Page, type Route } from '@playwright/test';
import { encodeSse } from '../../../src/shared/sse';
import type { ArticleReview, ChapterSummary, NumberWarning, Revision, StreamEvents, TranscriptPreviewSnippet } from '../../../src/shared/types';

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

/** 字幕原文片段：和真实服务端一样，开头、约三分之一、约三分之二处各一段，每段不超过 200 字 */
export const PREVIEW: TranscriptPreviewSnippet[] = [
  { time: '00:00', text: "Welcome back to the a16z show. I'm here with Marc Andreessen, and today we're going to talk about the trillion-dollar question in AI." },
  { time: '20:00', text: 'For eighty years computers were machines that followed instructions. Large models are the first time software can deal with ambiguity.' },
  { time: '40:00', text: 'Open source means a small team can get frontier capability, so the competition moves to product and distribution.' },
];

export function meta(overrides: Partial<StreamEvents['meta']> = {}): StreamEvents['meta'] {
  return {
    generationId: 'gen-1',
    video: { id: 'xRh2sVcNXQ8', title: '对话安德森', channel: 'a16z', lengthSeconds: 3600 },
    transcript: { source: 'live', language: 'en', kind: 'manual', chars: 52000, preview: PREVIEW },
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
    review: { sections: ARTICLE_CHAPTERS.length, revisions: 0, rewritten: null, checks: [] },
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

/**
 * 生成接口的完整事件序列：stage → meta → stage → delta… → 核对阶段 → 结尾（done / error / 无结尾表示中断）。
 * 核对阶段（beforeEnd）默认：结尾是 done 时发一个 stage: reviewing（现在的服务端在 done 之前总会核对），其他结尾不发。
 */
export function generationEvents(options: {
  meta?: StreamEvents['meta'];
  markdown?: string;
  beforeEnd?: SseEvent[];
  end?: SseEvent | null;
}): SseEvent[] {
  const markdown = options.markdown ?? ARTICLE_MD;
  const end = options.end === undefined ? (['done', done()] as SseEvent) : options.end;
  const beforeEnd = options.beforeEnd ?? (end?.[0] === 'done' ? [stage('reviewing')] : []);
  const events: SseEvent[] = [
    ['stage', { stage: 'transcript' }],
    ['meta', options.meta ?? meta()],
    ['stage', { stage: 'generating' }],
    ...deltas(markdown),
    ...beforeEnd,
  ];
  if (end) events.push(end);
  return events;
}

export function stage(name: StreamEvents['stage']['stage']): SseEvent {
  return ['stage', { stage: name }];
}

/** 核对后的最终全文和采用的修订（服务端只在最终文章和初稿不同时发） */
export function revised(markdown: string, revisions: Revision[]): SseEvent {
  return ['revised', { markdown, revisions }];
}

/** done.review：sections 章并行核对；其余默认"没有修订、没有按要求修订、用户没提可计算的要求" */
export function review(overrides: Partial<ArticleReview> = {}): ArticleReview {
  return { sections: ARTICLE_CHAPTERS.length, revisions: 0, rewritten: null, checks: [], ...overrides };
}

// —— 核对阶段的数据：初稿里有错句，核对后换成有字幕依据的版本 ——

/** 流式初稿：第一章把 2003 年安到了投资上，第二章把估计写成了确定的事实 */
export const DRAFT_MD = ARTICLE_MD.replace(
  '过去八十年，计算机一直是按指令执行的机器。',
  '2003 年那家基金投资了三家芯片公司。过去八十年，计算机一直是按指令执行的机器。',
).replace('开源让小团队也能用上前沿能力，竞争会集中在产品和分发上。', '开源模型的成本每年下降一半，这是确定的事实，竞争会集中在产品和分发上。');

/** 核对后的最终全文：两处错句换成有字幕依据的写法 */
export const REVIEWED_MD = ARTICLE_MD.replace(
  '过去八十年，计算机一直是按指令执行的机器。',
  '我 2003 年搬到硅谷，那家基金在之后十年里投资了三家芯片公司。过去八十年，计算机一直是按指令执行的机器。',
).replace('开源让小团队也能用上前沿能力，竞争会集中在产品和分发上。', '开源模型的成本大概每年下降一半，竞争会集中在产品和分发上。');

export const REVISIONS: Revision[] = [
  {
    type: 'time',
    before: '2003 年那家基金投资了三家芯片公司。',
    after: '我 2003 年搬到硅谷，那家基金在之后十年里投资了三家芯片公司。',
    reason: '字幕里 2003 年只修饰搬家，投资发生在之后的十年里',
    evidence: 'I moved to the Valley in 2003. Over the next decade the fund backed three chip companies.',
  },
  {
    type: 'quantity',
    before: '开源模型的成本每年下降一半，这是确定的事实，',
    after: '开源模型的成本大概每年下降一半，',
    reason: '字幕里是估计，文章写成了确定的事实',
    evidence: 'the cost of running open models probably halves every year, roughly, I could be off',
  },
];

/** 按要求修订过、约束已核对：用户要求"不超过 1200 字"，初稿 1,432 字 */
export const REWRITTEN_REVIEW: ArticleReview = {
  sections: 2,
  revisions: 0,
  rewritten: { unmet: ['全文 1,432 字，要求不超过 1,200 字'], charsBefore: 1432, charsAfter: 1018 },
  checks: ['全文 1,018 字，上限 1,200 字'],
};

export const REVIEW_FAILED_MESSAGE = '内容核对没有完成，这次生成没有保存（对照字幕核对没有完成：Gemini 模型繁忙，请稍后重试（HTTP 503））';
export const REQUIREMENTS_UNMET_MESSAGE = '文章没有满足生成要求里的硬性约束，修订后仍不满足（全文 1,356 字，要求不超过 1,200 字）';

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

/**
 * 生成接口发完 stage、meta、stage(generating) 后连接保持打开、不再有数据，即"字幕已获取，等待模型输出"。
 * page.route 只能一次性回复整个响应体，做不到发一半停住，所以在页面脚本运行前替换 window.fetch，
 * 只接管 POST /api/generations（不经过 page.route，api.generations 里没有记录），其余请求照常走网络和路由替身。
 * 页面中止请求（停止生成、超时）时，流以中止原因报错，和真实 fetch 一致。
 */
export async function holdGenerationAfterMeta(page: Page, data: StreamEvents['meta']): Promise<void> {
  const text = [encodeSse('stage', { stage: 'transcript' }), encodeSse('meta', data), encodeSse('stage', { stage: 'generating' })].join('');
  await page.addInitScript((sse) => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url, location.href).pathname !== '/api/generations' || init?.method !== 'POST') return original(input, init);
      const signal = init.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse));
          signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } }));
    };
  }, text);
}

export interface ScriptedGeneration {
  /** 往最近一次生成请求的流里推事件（网络上到达一个分块），页面处理完之前不返回 */
  push(...events: SseEvent[]): Promise<void>;
  /** 浏览器发出的各次生成请求的请求体 */
  bodies(): Promise<string[]>;
  /** 最近一次生成请求是否已经被页面中止（停止生成、超时） */
  aborted(): Promise<boolean>;
}

/**
 * 生成接口由测试一步步推送事件，连接一直开着：用来看"初稿已显示、正在核对""revised 到达前后"这类中间状态。
 * 和 holdGenerationAfterMeta 一样在页面脚本运行前替换 window.fetch，只接管 POST /api/generations（api.generations 里没有记录）。
 * 页面中止请求时流以中止原因报错，和真实 fetch 一致；之后再 push 不会到达页面。
 */
export async function scriptedGeneration(page: Page): Promise<ScriptedGeneration> {
  await page.addInitScript(() => {
    type Slot = { controller: ReadableStreamDefaultController<Uint8Array>; aborted: boolean; closed: boolean };
    const w = window as unknown as { __gen: { slots: Slot[]; bodies: string[] } };
    w.__gen = { slots: [], bodies: [] };
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url, location.href).pathname !== '/api/generations' || init?.method !== 'POST') return original(input, init);
      w.__gen.bodies.push(String(init.body ?? ''));
      const signal = init.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const slot: Slot = { controller, aborted: false, closed: false };
          w.__gen.slots.push(slot);
          signal?.addEventListener(
            'abort',
            () => {
              slot.aborted = true;
              if (!slot.closed) controller.error(signal.reason);
              slot.closed = true;
            },
            { once: true },
          );
        },
        cancel() {
          const slot = w.__gen.slots.at(-1);
          if (slot) slot.closed = true;
        },
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } }));
    };
  });
  return {
    async push(...events) {
      const text = events.map(([name, data]) => encodeSse(name, data)).join('');
      await page.evaluate((chunk) => {
        const slot = (window as unknown as { __gen: { slots: { controller: ReadableStreamDefaultController<Uint8Array>; closed: boolean }[] } }).__gen.slots.at(-1);
        if (!slot) throw new Error('还没有生成请求');
        if (!slot.closed) slot.controller.enqueue(new TextEncoder().encode(chunk));
      }, text);
      // 让页面读完这个分块、跑完 80ms 合并重绘
      await page.waitForTimeout(150);
    },
    bodies: () => page.evaluate(() => (window as unknown as { __gen: { bodies: string[] } }).__gen.bodies),
    aborted: () => page.evaluate(() => (window as unknown as { __gen: { slots: { aborted: boolean }[] } }).__gen.slots.at(-1)?.aborted ?? false),
  };
}

/** 来源面板每一行的标签和内容：[标签, 内容…] */
export async function sourceRows(page: Page): Promise<string[][]> {
  return page.locator('#source .source-row').evaluateAll((rows) => rows.map((row) => Array.from(row.children, (cell) => cell.textContent ?? '')));
}

/** 状态条主文案（不含下方的补充说明） */
export async function statusMain(page: Page): Promise<string> {
  return page.locator('#status .status-text').evaluate((el) => el.firstChild?.textContent ?? '');
}

/** 页面没有横向溢出 */
export async function horizontalOverflow(page: Page): Promise<{ scrollWidth: number; innerWidth: number }> {
  return page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
}
