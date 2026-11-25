import { exports } from 'cloudflare:workers';
import { vi } from 'vitest';
import { readSse } from '../../src/shared/sse';
import type { StreamEvents } from '../../src/shared/types';
import { chunkedBody, geminiSse, playerResponse, srv1 } from '../fixtures/upstream';

export interface UpstreamOptions {
  /** YouTube 播放器接口的响应；传 status 数字表示直接返回该 HTTP 状态 */
  player?: object | number;
  captions?: string;
  /** Gemini 流式响应体（SSE 文本） */
  geminiStream?: string;
  /** Gemini generateContent 的 JSON 响应 */
  geminiJson?: object;
  /** 这些模型的 Gemini 请求一律返回 503（模拟持续繁忙） */
  busyModels?: string[];
}

export interface UpstreamCall {
  url: string;
  body: string;
}

/** 拦截 Worker 的全部出站请求，按地址返回预设响应，并记录请求体。没有预设的地址直接报错。 */
export function mockUpstream(options: UpstreamOptions) {
  const calls: UpstreamCall[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
    if (url.startsWith('https://www.youtube.com/youtubei/v1/player')) {
      const player = options.player ?? playerResponse();
      return typeof player === 'number' ? new Response('', { status: player }) : Response.json(player);
    }
    if (url.startsWith('https://www.youtube.com/api/timedtext')) return new Response(options.captions ?? srv1([[0, 'live caption text']]));
    if (options.busyModels?.some((model) => url.includes(`/models/${model}:`))) {
      return Response.json({ error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } }, { status: 503 });
    }
    if (url.includes(':streamGenerateContent') && options.geminiStream !== undefined) {
      return new Response(chunkedBody(options.geminiStream), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.includes(':generateContent') && options.geminiJson) return Response.json(options.geminiJson);
    throw new Error(`测试未预设的出站请求：${url}`);
  });
  return { spy, calls, gemini: () => calls.filter((c) => c.url.includes('generativelanguage.googleapis.com')) };
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
