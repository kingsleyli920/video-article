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
    expect(JSON.parse(String(init!.body)).generationConfig).toEqual({ maxOutputTokens: 32768, thinkingConfig: { thinkingLevel: 'low' } });
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

  it('模型输出不是 JSON 时报 summary_invalid', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ candidates: [{ content: { parts: [{ text: '不是 JSON' }] }, finishReason: 'STOP' }] }),
    );
    await expect(generateJson(OPTIONS, PROMPT, {})).rejects.toMatchObject({ code: 'summary_invalid' });
  });
});
