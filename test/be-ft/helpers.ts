import { exports } from 'cloudflare:workers';
import { vi } from 'vitest';
import { readSse } from '../../src/shared/sse';
import type { StreamEvents } from '../../src/shared/types';
import { chunkedBody, geminiJson, geminiPurpose, geminiSse, NO_REQUIREMENTS_JSON, playerResponse, srv1, type GeminiPurpose } from '../fixtures/upstream';

export interface UpstreamOptions {
  /** YouTube 播放器接口的响应；传 status 数字表示直接返回该 HTTP 状态 */
  player?: object | number;
  captions?: string;
  /** Gemini 流式响应体（SSE 文本） */
  geminiStream?: string;
  /** 5W1H（generateContent）的 JSON 响应 */
  geminiJson?: object;
  /** 对照字幕核对的 JSON 响应；不设时返回"没有问题"。函数形式按请求体决定（各章的请求体不同） */
  reviewJson?: object | ((body: string) => object);
  /** 约束提取的 JSON 响应；不设时返回"没有可计算的约束" */
  requirementsJson?: object;
  /** 按要求修订（流式）的响应体；不设时这种请求会报"未预设" */
  rewriteStream?: string;
  /** 这些模型的 Gemini 请求一律返回 503（模拟持续繁忙） */
  busyModels?: string[];
  /** 这些模型的 Gemini 请求一律返回 402（预付额度用完，2026-11-25 实际遇到的响应） */
  billingModels?: string[];
  /**
   * 按用途和模型单独指定 Gemini 的响应（比如只让核对请求 503、402 或一直不返回），优先于上面所有选项；
   * 返回 undefined 时按其他选项处理
   */
  geminiOverride?: (request: { purpose: GeminiPurpose; model: string; body: string; signal: AbortSignal | null }) => Response | Promise<Response> | undefined;
}

/** Gemini 的 503 响应（模型繁忙） */
export const busyResponse = () => Response.json({ error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } }, { status: 503 });
/** Gemini 的 402 响应（预付额度用完） */
export const billingResponse = () =>
  Response.json({ error: { code: 402, message: 'Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.', status: 'RESOURCE_EXHAUSTED' } }, { status: 402 });
/** 一直不返回，和真实 fetch 一样在中止时失败 */
export const hangingResponse = (signal: AbortSignal | null) => new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));

export interface UpstreamCall {
  url: string;
  body: string;
  /** Gemini 请求的用途；YouTube 请求为 null */
  purpose: GeminiPurpose | null;
}

/** 拦截 Worker 的全部出站请求，按地址返回预设响应，并记录请求体。没有预设的地址直接报错。 */
export function mockUpstream(options: UpstreamOptions) {
  const calls: UpstreamCall[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = typeof init?.body === 'string' ? init.body : '';
    const isGemini = url.includes('generativelanguage.googleapis.com');
    const purpose = isGemini ? geminiPurpose(url, JSON.parse(body || 'null')) : null;
    calls.push({ url, body, purpose });
    if (url.startsWith('https://www.youtube.com/youtubei/v1/player')) {
      const player = options.player ?? playerResponse();
      return typeof player === 'number' ? new Response('', { status: player }) : Response.json(player);
    }
    if (url.startsWith('https://www.youtube.com/api/timedtext')) return new Response(options.captions ?? srv1([[0, 'live caption text']]));
    if (purpose && options.geminiOverride) {
      const model = url.split('/models/')[1]!.split(':')[0]!;
      const override = options.geminiOverride({ purpose, model, body, signal: init?.signal ?? null });
      if (override !== undefined) return override;
    }
    if (options.billingModels?.some((model) => url.includes(`/models/${model}:`))) return billingResponse();
    if (options.busyModels?.some((model) => url.includes(`/models/${model}:`))) return busyResponse();
    const streamBody = purpose === 'rewrite' ? options.rewriteStream : purpose === 'article' ? options.geminiStream : undefined;
    if (streamBody !== undefined) return new Response(chunkedBody(streamBody), { headers: { 'content-type': 'text/event-stream' } });
    if (purpose === 'review') {
      const review = typeof options.reviewJson === 'function' ? options.reviewJson(body) : options.reviewJson;
      return Response.json(review ?? geminiJson({ issues: [] }));
    }
    if (purpose === 'requirements') return Response.json(options.requirementsJson ?? geminiJson(NO_REQUIREMENTS_JSON));
    if (purpose === 'summary' && options.geminiJson) return Response.json(options.geminiJson);
    throw new Error(`测试未预设的出站请求：${url}`);
  });
  /** 全部 Gemini 请求；给了用途就只返回那一种（如 'article' 只看写文章的请求） */
  const gemini = (only?: GeminiPurpose) => calls.filter((c) => c.purpose !== null && (only === undefined || c.purpose === only));
  return { spy, calls, gemini };
}

export type ReceivedEvent = { [K in keyof StreamEvents]: { event: K; data: StreamEvents[K] } }[keyof StreamEvents];

export async function generate(body: object): Promise<{ status: number; events: ReceivedEvent[] }> {
  const res = await exports.default.fetch('https://app.test/api/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const events: ReceivedEvent[] = [];
  if (res.headers.get('content-type')?.startsWith('text/event-stream')) {
    for await (const message of readSse(res.body!)) events.push({ event: message.event, data: JSON.parse(message.data) } as ReceivedEvent);
  }
  return { status: res.status, events };
}

export function eventOf<K extends keyof StreamEvents>(events: ReceivedEvent[], name: K): StreamEvents[K] | undefined {
  return events.find((e) => e.event === name)?.data as StreamEvents[K] | undefined;
}

export { geminiSse };
