import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyHttpError, generateJson, streamText } from '../../src/worker/gemini';
import { chunkedBody, geminiJson, geminiSse } from '../fixtures/upstream';

afterEach(() => vi.restoreAllMocks());

const OPTIONS = { apiKey: 'test-key', model: 'gemini-3.6-flash', thinkingLevel: 'low' };
const PROMPT = { system: '系统', user: '用户' };

async function run(body: ReadableStream<Uint8Array> | string, status = 200) {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status }));
  const texts: string[] = [];
  const finishReason = await streamText(OPTIONS, PROMPT, async (text) => {
    texts.push(text);
  });
  return { texts, finishReason, fetchSpy };
}

describe('streamText', () => {
  // 抓：Gemini 的 SSE 分块切在中文字节和 \r\n 中间时，正文乱码或丢段
  it('按 7 字节切分的响应也能还原全部中文正文，并返回 finishReason', async () => {
    const { texts, finishReason } = await run(chunkedBody(geminiSse(['智能经济：', '收入爆发与成本塌陷'])));
    expect(texts).toEqual(['智能经济：', '收入爆发与成本塌陷']);
    expect(finishReason).toBe('STOP');
  });

  // 抓：把模型的思考内容当正文推给用户
  it('跳过 thought 部分', async () => {
    const { texts } = await run(geminiSse(['正文'], 'STOP', { thought: '内部思考' }));
    expect(texts).toEqual(['正文']);
  });

  // 抓：连接中途断开却当作正常结束
  it('没有 finishReason 就结束时返回 null', async () => {
    const { finishReason } = await run(geminiSse(['写到一半'], null));
    expect(finishReason).toBeNull();
  });

  it('MAX_TOKENS 原样返回，由调用方判定截断', async () => {
    const { finishReason } = await run(geminiSse(['很长的文章'], 'MAX_TOKENS'));
    expect(finishReason).toBe('MAX_TOKENS');
  });

  it('请求带上 key、模型名、思考强度，走 alt=sse 流式端点', async () => {
    const { fetchSpy } = await run(geminiSse(['正文']));
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse');
    expect((init!.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key');
    // 思考 token 计入输出上限，默认上限按官方建议 65,536，避免高档思考被截断
    expect(JSON.parse(String(init!.body)).generationConfig).toEqual({ maxOutputTokens: 65536, thinkingConfig: { thinkingLevel: 'low' } });
  });

  // 抓：用量、实际模型版本、服务档没有记录，或者为了等用量而一直等连接关闭
  it('从终止事件里记下用量和模型版本，从响应头记下服务档；可单独指定输出上限', async () => {
    const last = { candidates: [{ content: { parts: [{ text: '尾' }], role: 'model' }, finishReason: 'STOP' }], modelVersion: 'gemini-x-001', usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30, cachedContentTokenCount: 80, serviceTier: 'standard' } };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(`${geminiSse(['正文'], null)}data: ${JSON.stringify(last)}\r\n\r\n`, { headers: { 'x-gemini-service-tier': 'standard' } }),
    );
    const stats = {};
    const texts: string[] = [];
    const finishReason = await streamText({ ...OPTIONS, maxOutputTokens: 1234 }, PROMPT, async (t) => void texts.push(t), undefined, stats);
    expect(finishReason).toBe('STOP');
    expect(texts.join('')).toBe('正文尾');
    expect(stats).toEqual({
      serviceTierHeader: 'standard',
      modelVersion: 'gemini-x-001',
      usage: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30, cachedContentTokenCount: 80, serviceTier: 'standard' },
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body)).generationConfig.maxOutputTokens).toBe(1234);
  });

  // 抓：首次 503 直接失败；或者在已经输出后重试，导致两次输出拼在一起
  it('开始输出前遇到 503 只重试一次', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ error: { code: 503, status: 'UNAVAILABLE' } }, { status: 503 }))
      .mockResolvedValueOnce(new Response(geminiSse(['重试后正文'])));
    const texts: string[] = [];
    const finishReason = await streamText(OPTIONS, PROMPT, async (t) => {
      texts.push(t);
    });
    expect(finishReason).toBe('STOP');
    expect(texts).toEqual(['重试后正文']);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('连续两次 503 报 gemini_busy，不再继续重试', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ error: { code: 503 } }, { status: 503 }));
    await expect(streamText(OPTIONS, PROMPT, async () => {})).rejects.toMatchObject({ code: 'gemini_busy' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // 抓：流中途收到错误事件时吞掉错误，把半截文章当完整文章
  it('流中途出现 error 事件时抛错，已输出的正文保留在调用方', async () => {
    const body = geminiSse(['前半段'], null) + `data: ${JSON.stringify({ error: { code: 500, message: 'internal' } })}\r\n\r\n`;
    const texts: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body));
    await expect(
      streamText(OPTIONS, PROMPT, async (t) => {
        texts.push(t);
      }),
    ).rejects.toMatchObject({ code: 'gemini_busy' });
    expect(texts).toEqual(['前半段']);
  });
});

describe('超时', () => {
  const FAST = { ...OPTIONS, timeouts: { firstChunkMs: 60, idleMs: 60, requestMs: 60 } };

  /** 模拟真实 fetch：中止信号触发时，响应体随之报错 */
  function stalledBody(signal: AbortSignal, first?: string): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        if (first) controller.enqueue(new TextEncoder().encode(first));
        signal.addEventListener('abort', () => controller.error(signal.reason));
      },
    });
  }

  // 抓：Gemini 迟迟不给首个分块时页面永远停在"等待模型输出"
  it('首个分块迟迟不到时报 gemini_busy', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => new Response(stalledBody(init!.signal!)));
    await expect(streamText(FAST, PROMPT, async () => {})).rejects.toMatchObject({ code: 'gemini_busy', message: 'Gemini 模型繁忙，请稍后重试（模型超过 0.06 秒没有响应）' });
  });

  it('连响应头都不返回时同样按首包超时处理', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) => new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    );
    await expect(streamText(FAST, PROMPT, async () => {})).rejects.toMatchObject({ code: 'gemini_busy' });
  });

  // 抓：输出到一半卡住时一直等下去，或者把半截文章当成完整文章
  it('输出中途长时间没有新分块时报 interrupted，已输出部分保留', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => new Response(stalledBody(init!.signal!, geminiSse(['第一段'], null))));
    const texts: string[] = [];
    await expect(
      streamText(FAST, PROMPT, async (t) => {
        texts.push(t);
      }),
    ).rejects.toMatchObject({ code: 'interrupted', message: '生成中断，文章不完整（模型超过 0.06 秒没有新输出）' });
    expect(texts).toEqual(['第一段']);
  });

  it('下游写入慢不算模型空闲', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(geminiSse(['第一段', '第二段'])));
    const texts: string[] = [];
    const finishReason = await streamText(FAST, PROMPT, async (t) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      texts.push(t);
    });
    expect(finishReason).toBe('STOP');
    expect(texts).toEqual(['第一段', '第二段']);
  });

  it('结构化请求整体超时报 gemini_busy', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) => new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    );
    await expect(generateJson(FAST, PROMPT, {})).rejects.toMatchObject({ code: 'gemini_busy' });
  });
});

describe('终止事件', () => {
  /** 发完给定事件后连接一直不关（和真实 fetch 一样，中止信号触发时响应体报错）；记录上游响应体是否被取消 */
  function hangingAfter(sse: string) {
    const state = { cancelled: false };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sse));
            init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason));
          },
          cancel() {
            state.cancelled = true;
          },
        }),
      ),
    );
    return state;
  }

  // 抓：完整正文和 STOP 都到了，连接不关闭，最后被空闲超时判成 interrupted
  it('收到 STOP 后连接不关：立即返回 STOP，终止事件里的最后一段正文也被处理，并释放上游连接', async () => {
    const upstream = hangingAfter(geminiSse(['第一段', '最后一段'], 'STOP'));
    const texts: string[] = [];
    const fast = { ...OPTIONS, timeouts: { firstChunkMs: 1_000, idleMs: 200 } };
    await expect(
      streamText(fast, PROMPT, async (t) => {
        texts.push(t);
      }),
    ).resolves.toBe('STOP');
    expect(texts).toEqual(['第一段', '最后一段']);
    await Promise.resolve();
    expect(upstream.cancelled).toBe(true);
  });

  it('收到 MAX_TOKENS 后同样立即返回原因，由调用方判为截断', async () => {
    hangingAfter(geminiSse(['很长'], 'MAX_TOKENS'));
    const fast = { ...OPTIONS, timeouts: { firstChunkMs: 1_000, idleMs: 200 } };
    await expect(streamText(fast, PROMPT, async () => {})).resolves.toBe('MAX_TOKENS');
  });

  it('没有终止事件、连接也不关时按空闲超时判为中断，不当成成功', async () => {
    hangingAfter(geminiSse(['写到一半'], null));
    const fast = { ...OPTIONS, timeouts: { firstChunkMs: 1_000, idleMs: 100 } };
    await expect(streamText(fast, PROMPT, async () => {})).rejects.toMatchObject({ code: 'interrupted' });
  });
});

describe('外部取消', () => {
  // 抓：客户端已断开，Gemini 请求仍在继续生成，白白消耗额度
  it('客户端断开时立即中止 Gemini 请求，并抛出取消原因而不是超时', async () => {
    let upstreamSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      upstreamSignal = init!.signal!;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(geminiSse(['第一段'], null)));
            init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason));
          },
        }),
      );
    });
    const client = new AbortController();
    const gone = new Error('client gone');
    const texts: string[] = [];
    const pending = streamText(OPTIONS, PROMPT, async (t) => {
      texts.push(t);
      client.abort(gone);
    }, client.signal);
    await expect(pending).rejects.toBe(gone);
    expect(upstreamSignal?.aborted).toBe(true);
    expect(texts).toEqual(['第一段']);
  });

  it('开始前已经取消时不发请求', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const client = new AbortController();
    client.abort(new Error('already gone'));
    await expect(streamText(OPTIONS, PROMPT, async () => {}, client.signal)).rejects.toThrow('already gone');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('classifyHttpError', () => {
  it.each([
    [429, '{"error":{"message":"Resource has been exhausted"}}', 'gemini_quota'],
    [400, '{"error":{"message":"User location is not supported for the API use."}}', 'gemini_region'],
    [400, '{"error":{"message":"API key not valid. Please pass a valid API key."}}', 'gemini_error'],
    [503, 'not json', 'gemini_busy'],
  ])('HTTP %i → %s', (status, body, code) => {
    expect(classifyHttpError(status, body).code).toBe(code);
  });
});

describe('generateJson', () => {
  it('请求结构化输出并解析 JSON', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(geminiJson({ who: 'Mark' })));
    expect(await generateJson(OPTIONS, PROMPT, { type: 'object' })).toEqual({ who: 'Mark' });
    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body));
    expect(body.generationConfig).toMatchObject({ responseMimeType: 'application/json', responseJsonSchema: { type: 'object' } });
  });

  // 抓：5W1H 的实际模型版本、用量（含思考 token）和服务档没有记录，验收时无法确认是谁写的总结；或输出上限仍是会被高档思考截断的旧值
  it('记下用量、模型版本和服务档；思考 token 计入输出上限，默认上限 65,536', async () => {
    const response = { ...geminiJson({ who: 'Mark' }), modelVersion: 'gemini-y-002', usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 40, thoughtsTokenCount: 3000, serviceTier: 'standard' } };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(response, { headers: { 'x-gemini-service-tier': 'priority' } }));
    const stats = {};
    expect(await generateJson(OPTIONS, PROMPT, { type: 'object' }, stats)).toEqual({ who: 'Mark' });
    expect(stats).toEqual({
      serviceTierHeader: 'priority',
      modelVersion: 'gemini-y-002',
      usage: { promptTokenCount: 300, candidatesTokenCount: 40, thoughtsTokenCount: 3000, serviceTier: 'standard' },
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body)).generationConfig.maxOutputTokens).toBe(65536);
  });

  it('模型输出不是 JSON 时报 summary_invalid', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ candidates: [{ content: { parts: [{ text: '不是 JSON' }] }, finishReason: 'STOP' }] }),
    );
    await expect(generateJson(OPTIONS, PROMPT, {})).rejects.toMatchObject({ code: 'summary_invalid' });
  });
});
