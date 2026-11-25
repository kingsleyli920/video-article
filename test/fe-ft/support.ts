/**
 * L1d 前端功能测试的公共部分：在 jsdom 里放入真实的 index.html、加载真实的 main.ts，
 * 网络由 FakeBackend 控制（按测试的节奏逐条推送 SSE 事件，中止语义和真实 fetch 一致）。
 */
import { vi } from 'vitest';
import pageHtml from '../../src/client/index.html?raw';
import { encodeSse } from '../../src/shared/sse';

export const SAMPLE_URL = 'https://www.youtube.com/watch?v=xRh2sVcNXQ8';
export const VIDEO_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

/** 页面 body 的真实结构；去掉加载打包产物的 script（main.ts 由测试直接加载） */
function bodyMarkup(): string {
  const doc = new DOMParser().parseFromString(pageHtml, 'text/html');
  for (const script of doc.querySelectorAll('script')) script.remove();
  return doc.body.innerHTML;
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: RequestInit['body'];
  signal: AbortSignal;
}

/**
 * 服务端的一个流式响应：测试调用一次 event/heartbeat 就是网络上到达一个分块。
 * 和真实 fetch 一样，请求被中止时响应体以中止原因报错。
 */
export class SseStream {
  readonly readable: ReadableStream<Uint8Array>;
  cancelled = false;
  #controller!: ReadableStreamDefaultController<Uint8Array>;
  #encoder = new TextEncoder();

  constructor(signal: AbortSignal) {
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller;
      },
      cancel: () => {
        this.cancelled = true;
      },
    });
    signal.addEventListener(
      'abort',
      () => {
        try {
          this.#controller.error(signal.reason);
        } catch {
          // 已经关闭或取消
        }
      },
      { once: true },
    );
  }

  /** data 用 unknown：个别用例要模拟字段缺失的旧版服务端 */
  event(name: string, data: unknown): void {
    this.#push(encodeSse(name, data));
  }

  heartbeat(): void {
    this.#push(': keep-alive\n\n');
  }

  /** 服务端正常关闭连接 */
  end(): void {
    this.#controller.close();
  }

  /** 连接被重置 */
  reset(): void {
    this.#controller.error(new TypeError('network error'));
  }

  #push(text: string): void {
    this.#controller.enqueue(this.#encoder.encode(text));
  }
}

/** 一次 fetch：由测试决定怎么回应。回应之前请求被中止时，fetch 以中止原因失败（真实 fetch 的行为）。 */
export class PendingCall {
  readonly request: RecordedRequest;
  readonly response: Promise<Response>;
  #resolve!: (res: Response) => void;
  #reject!: (err: unknown) => void;
  #settled = false;

  constructor(request: RecordedRequest) {
    this.request = request;
    this.response = new Promise<Response>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    const { signal } = request;
    // 已经回应过的请求被中止（比如收到 done 后客户端主动断开）不影响 fetch 的结果
    const onAbort = () => {
      if (!this.#settled) this.#settle(() => this.#reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError')));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  respond(res: Response): void {
    this.#settle(() => this.#resolve(res));
  }

  json(status: number, body: unknown): void {
    this.respond(Response.json(body, { status }));
  }

  networkError(): void {
    this.#settle(() => this.#reject(new TypeError('Failed to fetch')));
  }

  openStream(): SseStream {
    const stream = new SseStream(this.request.signal);
    this.respond(new Response(stream.readable, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    return stream;
  }

  #settle(action: () => void): void {
    if (this.#settled) throw new Error(`请求已经有结果，不能再回应：${this.request.url}`);
    this.#settled = true;
    action();
  }
}

/**
 * 替换全局 fetch。生成请求默认立即以 200 + SSE 流回应（autoStream），流的内容由测试推送；
 * 5W1H 请求一律挂起，直到测试回应。
 */
export class FakeBackend {
  readonly calls: PendingCall[] = [];
  readonly streams: SseStream[] = [];
  autoStream = true;
  readonly fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => this.#handle(String(input), init ?? {}));

  get generations(): PendingCall[] {
    return this.calls.filter((call) => call.request.url === '/api/generations');
  }

  get summaries(): PendingCall[] {
    return this.calls.filter((call) => call.request.url.endsWith('/summary'));
  }

  /** 最近一次生成请求的流 */
  get stream(): SseStream {
    const stream = this.streams.at(-1);
    if (!stream) throw new Error('还没有生成请求');
    return stream;
  }

  #handle(url: string, init: RequestInit): Promise<Response> {
    if (!init.signal) throw new Error(`请求没有带中止信号：${url}`);
    const call = new PendingCall({
      url,
      method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: init.body,
      signal: init.signal,
    });
    this.calls.push(call);
    if (this.autoStream && url === '/api/generations') this.streams.push(call.openStream());
    return call.response;
  }
}

/** 让已到达的数据和 Promise 链跑完，不推进时间 */
export const settle = () => vi.advanceTimersByTimeAsync(0);
/** 推进假时钟（期间的 Promise 链会跑完） */
export const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
/** 文章生成中 80ms 合并一次重绘，推送 delta 后等这么久再看页面 */
export const RENDER_WAIT_MS = 100;

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`页面缺少 #${id}`);
  return element as T;
};

/** 页面上的元素和读法。每个 getter 都现查 DOM，拿到的是当前状态。 */
export const page = {
  get form() {
    return byId<HTMLFormElement>('generate-form');
  },
  get url() {
    return byId<HTMLInputElement>('video-url');
  },
  get instructions() {
    return byId<HTMLTextAreaElement>('instructions');
  },
  get sample() {
    return byId<HTMLButtonElement>('fill-sample');
  },
  get submit() {
    return byId<HTMLButtonElement>('submit');
  },
  get stop() {
    return byId<HTMLButtonElement>('stop');
  },
  get statusBox() {
    return byId<HTMLDivElement>('status');
  },
  get article() {
    return byId<HTMLElement>('article');
  },

  /** 状态条：主文案、补充说明、色调、是否显示"重新生成" */
  get status() {
    const box = this.statusBox;
    const main = box.querySelector('.status-text');
    return {
      hidden: box.hidden,
      tone: box.dataset.tone,
      text: main?.firstChild?.nodeType === Node.TEXT_NODE ? main.firstChild.textContent : null,
      detail: box.querySelector('.status-detail')?.textContent ?? '',
      hasRetry: this.retryButton !== null,
    };
  },

  get retryButton(): HTMLButtonElement | null {
    return [...this.statusBox.querySelectorAll('button')].find((b) => b.textContent === '重新生成') ?? null;
  },

  /** 表单控件是否全部可用（链接、要求、生成按钮、示例按钮） */
  get controlsDisabled(): boolean[] {
    return [this.url, this.instructions, this.submit, this.sample].map((el) => el.disabled);
  },

  chapter(id: string) {
    const section = this.article.querySelector<HTMLElement>(`section.chapter[data-chapter-id="${id}"]`);
    if (!section) throw new Error(`文章里没有第 ${id} 章`);
    return {
      section,
      title: section.querySelector('h2')?.textContent,
      toggle: section.querySelector<HTMLButtonElement>('.summary-toggle')!,
      panel: section.querySelector<HTMLElement>('.summary-panel')!,
    };
  },

  get chapterTitles(): string[] {
    return [...this.article.querySelectorAll('section.chapter h2')].map((h) => h.textContent ?? '');
  },

  get toggles(): HTMLButtonElement[] {
    return [...this.article.querySelectorAll<HTMLButtonElement>('.summary-toggle')];
  },

  /** 标题下方的提示（疑似补全了残缺数字） */
  get notices(): string[] {
    return [...this.article.querySelectorAll('.article-notice p')].map((p) => p.textContent ?? '');
  },

  get incompleteNote(): string | null {
    return this.article.querySelector('.incomplete-note')?.textContent ?? null;
  },
};

/** 像用户一样往输入框里填内容 */
export function type(field: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  field.focus();
  field.value = text;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/** 把真实页面放进 document，加载 main.ts（模块级代码在加载时绑定 DOM），然后接管时钟 */
export async function openPage(): Promise<void> {
  document.body.innerHTML = bodyMarkup();
  vi.resetModules();
  await import('../../src/client/main');
  vi.useFakeTimers();
}

export function closePage(): void {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
}

/** 填链接（和可选的要求）并点"生成文章" */
export async function submitWith(url: string, instructions = ''): Promise<void> {
  type(page.url, url);
  type(page.instructions, instructions);
  page.submit.click();
  await settle();
}

// —— 服务端事件的固定数据 ——

export function meta(generationId = 'gen-1', overrides: Record<string, unknown> = {}) {
  return {
    generationId,
    video: { id: 'dQw4w9WgXcQ', title: '示例访谈', channel: '示例频道', lengthSeconds: 3600 },
    transcript: { source: 'live', language: 'en', kind: 'asr', chars: 52000 },
    model: 'gemini-main',
    ...overrides,
  };
}

export const CHAPTERS = [
  { id: '1', title: '第一章 起步' },
  { id: '2', title: '第二章 增长' },
];

export function doneEvent(overrides: Record<string, unknown> = {}) {
  return {
    chapters: CHAPTERS,
    chars: 36,
    timing: { transcriptMs: 800, firstTokenMs: 2100, modelDoneMs: 9000, savedMs: 9100 },
    numberWarnings: [],
    model: 'gemini-main',
    ...overrides,
  };
}

/** 一篇两章的文章，按三段 delta 推送 */
export const ARTICLE_DELTAS = ['# 示例文章标题\n\n这是导语。', '\n\n## 第一章 起步\n\n第一章的正文。', '\n\n## 第二章 增长\n\n第二章的正文。'];

/** 推完整个成功流程（阶段、meta、全部正文、done），等页面处理完 */
export async function streamFullArticle(stream: SseStream, generationId = 'gen-1', done: Record<string, unknown> = {}): Promise<void> {
  stream.event('stage', { stage: 'transcript' });
  stream.event('meta', meta(generationId));
  stream.event('stage', { stage: 'generating' });
  for (const text of ARTICLE_DELTAS) stream.event('delta', { text });
  stream.event('done', doneEvent(done));
  await settle();
}

export const SUMMARY = { who: '主持人和嘉宾', what: '讨论公司早期如何起步', when: null, where: '硅谷', why: '验证产品方向', how: '先做小规模试点' };
