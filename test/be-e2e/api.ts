/**
 * L3 后端 E2E 的 HTTP 客户端辅助：只经 Worker 的公开接口发请求，读取 SSE 和 JSON 响应，并记录耗时。
 * 期望值一律写在测试里，这里只负责收发和取上游请求里的提示词。
 */
import { readSse } from '../../src/shared/sse';
import type { StreamEvents } from '../../src/shared/types';
import type { RecordedRequest } from '../harness/mock-upstream';
import type { Stack } from './stack';

export type ReceivedEvent = { [K in keyof StreamEvents]: { event: K; data: StreamEvents[K] } }[keyof StreamEvents];

export interface GenerateResult {
  status: number;
  contentType: string | null;
  /** SSE 响应的事件（注释行心跳不算事件） */
  events: ReceivedEvent[];
  /** 非 SSE 响应（输入校验失败等）的 JSON 正文 */
  json: unknown;
  /** 从发出请求到响应读完的毫秒数 */
  elapsedMs: number;
}

/** 以原始字符串作为请求体调用生成接口，读完整个响应 */
export async function postGeneration(stack: Stack, rawBody: string, init: RequestInit = {}): Promise<GenerateResult> {
  return explainReset(async () => {
    const started = Date.now();
    const res = await fetch(`${stack.url}/api/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rawBody,
      ...init,
    });
    const contentType = res.headers.get('content-type');
    const events: ReceivedEvent[] = [];
    let json: unknown = null;
    if (contentType?.startsWith('text/event-stream')) {
      for await (const message of readSse(res.body!)) events.push({ event: message.event, data: JSON.parse(message.data) } as ReceivedEvent);
    } else {
      json = await readJson(res);
    }
    return { status: res.status, contentType, events, json, elapsedMs: Date.now() - started };
  });
}

const RELOAD_HINT = '常见原因：其他会话重新构建了 dist/client（wrangler dev 监视该目录并重载 Worker，掐断进行中的请求）';

/**
 * Worker 一侧关闭了连接（undici 报 terminated / other side closed）时补上最常见的原因再抛出，不重试：
 * wrangler dev 监视静态资源目录 dist/client，别的会话重新构建（例如 Playwright 的 webServer 先跑 npm run build）
 * 会让它重载 Worker，进行中的请求随之被掐断。Worker 进程崩溃也是这个现象，所以不能靠重试掩盖。
 */
async function explainReset<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause;
    if (err instanceof TypeError && cause?.code === 'UND_ERR_SOCKET') {
      throw new Error(`Worker 关闭了连接。${RELOAD_HINT}；也可能是 Worker 进程崩溃。`, { cause: err });
    }
    throw err;
  }
}

/** 接口的 JSON 正文。不是 JSON 时带上状态码和原文报错；wrangler 重载 Worker 时的提示单独说明原因 */
async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const hint = /restarted mid-request/.test(text) ? `wrangler dev 在请求进行中重载了 Worker。${RELOAD_HINT}。` : '';
    throw new Error(`${hint}响应不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
}

export function generate(stack: Stack, body: object): Promise<GenerateResult> {
  return postGeneration(stack, JSON.stringify(body));
}

export function eventOf<K extends keyof StreamEvents>(events: ReceivedEvent[], name: K): StreamEvents[K] | undefined {
  return events.find((e) => e.event === name)?.data as StreamEvents[K] | undefined;
}

export function deltaText(events: ReceivedEvent[]): string {
  return events
    .filter((e) => e.event === 'delta')
    .map((e) => (e.data as StreamEvents['delta']).text)
    .join('');
}

export interface SummaryCall {
  status: number;
  body: unknown;
  elapsedMs: number;
}

/** 调用 5W1H 接口；默认不带请求体 */
export function summarize(stack: Stack, generationId: string, chapterId: string, init: RequestInit = {}): Promise<SummaryCall> {
  return explainReset(async () => {
    const started = Date.now();
    const res = await fetch(`${stack.url}/api/generations/${generationId}/chapters/${chapterId}/summary`, { method: 'POST', ...init });
    const body = await readJson(res);
    return { status: res.status, body, elapsedMs: Date.now() - started };
  });
}

/** 发给 Gemini 的提示词：系统指令和用户消息 */
export function promptOf(request: RecordedRequest): { system: string; user: string; generationConfig: Record<string, unknown> } {
  const body = request.body as {
    systemInstruction: { parts: { text: string }[] };
    contents: { parts: { text: string }[] }[];
    generationConfig: Record<string, unknown>;
  };
  return { system: body.systemInstruction.parts[0]!.text, user: body.contents[0]!.parts[0]!.text, generationConfig: body.generationConfig };
}

export const ofKind = (requests: RecordedRequest[], kind: RecordedRequest['kind']) => requests.filter((r) => r.kind === kind);

/** 轮询直到 check 返回非空值（例如等上游记录到连接关闭），超时抛错 */
export async function waitFor<T>(check: () => Promise<T | null | undefined>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${timeoutMs} 毫秒内没有等到：${what}`);
    await sleep(50);
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
