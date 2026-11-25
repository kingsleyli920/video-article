/**
 * L3 输入和接口边界：生成接口的请求校验、5W1H 接口的路径和请求体校验、未完成的生成不保存。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eventOf, generate, ofKind, postGeneration, promptOf, summarize } from './api';
import { MOCK_SUMMARY_NORMALIZED, MOCK_URL } from './expected';
import { startStack, type Stack } from './stack';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({ worker: 8798, upstream: 8799 });
});
afterAll(async () => {
  await stack?.stop();
});
beforeEach(async () => {
  await stack.reset();
});

/** 生成一篇并确认保存成功，返回 generationId */
async function savedGeneration(): Promise<string> {
  const gen = await generate(stack, { url: MOCK_URL });
  expect(gen.events.at(-1)!.event).toBe('done');
  return eventOf(gen.events, 'meta')!.generationId;
}

describe('生成接口的输入校验', () => {
  // 抓：非法输入没有在入口拦下（返回 200 SSE 或 500），错误码或状态码不对，或者校验前就已经请求了上游
  it.each([
    ['不是 YouTube 的链接', 400, 'invalid_url', '请输入有效的 YouTube 视频链接', JSON.stringify({ url: 'https://example.com/watch?v=mockvideo01' })],
    ['视频 ID 不是 11 位', 400, 'invalid_url', '请输入有效的 YouTube 视频链接', JSON.stringify({ url: 'https://youtu.be/mockvideo0' })],
    ['缺少 url', 400, 'invalid_url', '请输入有效的 YouTube 视频链接', JSON.stringify({ instructions: '写成摘要' })],
    ['生成要求超过 1000 字', 400, 'instructions_too_long', '生成要求不能超过 1000 字', JSON.stringify({ url: MOCK_URL, instructions: '字'.repeat(1001) })],
    ['生成要求不是字符串', 400, 'invalid_request', '请求格式不正确（instructions 必须是字符串）', JSON.stringify({ url: MOCK_URL, instructions: 42 })],
    ['请求体超过 8192 字节', 400, 'invalid_request', '请求格式不正确（请求体过大）', JSON.stringify({ url: MOCK_URL, instructions: '短', padding: 'x'.repeat(8200) })],
    ['请求体不是 JSON', 400, 'invalid_request', '请求格式不正确（不是合法 JSON）', `url=${MOCK_URL}&instructions=abc`],
  ])('%s：返回 %i %s，不请求上游', async (_, status, code, message, rawBody) => {
    const res = await postGeneration(stack, rawBody);
    expect(res.status).toBe(status);
    expect(res.contentType).toMatch(/^application\/json/);
    expect(res.json).toEqual({ error: { code, message } });
    expect(await stack.requests()).toEqual([]);
  });

  // 抓：生成要求按字节而不是按字数限制（1000 个汉字是 3000 字节），合法的长要求被误拒
  it('生成要求恰好 1000 个汉字时正常生成，要求原样进入文章请求', async () => {
    const instructions = '字'.repeat(1000);
    const gen = await generate(stack, { url: MOCK_URL, instructions });
    expect(gen.status).toBe(200);
    expect(gen.events.at(-1)!.event).toBe('done');
    const stream = ofKind(await stack.requests(), 'stream');
    expect(stream).toHaveLength(1);
    expect(promptOf(stream[0]!).user).toContain(`<user_requirements>\n${instructions}\n</user_requirements>`);
  });

  // 抓：方法和路径没有限制，GET 也触发生成，或未知路径落到别的处理上
  it.each([
    ['GET /api/generations', 405, 'method_not_allowed', '不支持的请求方法', 'GET', '/api/generations'],
    ['GET 5W1H 接口', 405, 'method_not_allowed', '不支持的请求方法', 'GET', `/api/generations/${'a'.repeat(64)}/chapters/1/summary`],
    ['未知的 API 路径', 404, 'not_found', '接口不存在', 'POST', '/api/unknown'],
  ])('%s：返回 %i %s', async (_, status, code, message, method, path) => {
    const res = await fetch(`${stack.url}${path}`, { method });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: { code, message } });
    expect(await stack.requests()).toEqual([]);
  });
});

describe('5W1H 接口的边界', () => {
  // 抓：未知或伪造的 generationId 报 500、或新建了一个空对象去调用模型
  it.each([
    ['64 位十六进制但从未生成过', 'f'.repeat(64)],
    ['格式不对的 id', 'not-a-generation-id'],
  ])('generationId %s：404 generation_not_found，不调用模型', async (_, generationId) => {
    const res = await summarize(stack, generationId, '1');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'generation_not_found', message: '这次生成已过期或不存在，请重新生成' } });
    expect(await stack.requests()).toEqual([]);
  });

  // 抓：章节 id 越界时没有校验，拿空章节去调用模型
  it('已保存的生成里不存在的章节：404 chapter_not_found，不调用模型', async () => {
    const generationId = await savedGeneration();
    await stack.reset();
    const res = await summarize(stack, generationId, '3');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'chapter_not_found', message: '找不到这个章节' } });
    expect(await stack.requests()).toEqual([]);
  });

  // 抓：前端可以在请求体里塞伪造的文章或字幕，服务端照单全收
  it('5W1H 请求带请求体：400 body_not_allowed，不调用模型；之后不带请求体仍正常生成', async () => {
    const generationId = await savedGeneration();
    await stack.reset();
    const rejected = await summarize(stack, generationId, '1', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ article: '前端伪造的文章', transcript: '前端伪造的字幕' }),
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body).toEqual({ error: { code: 'body_not_allowed', message: '总结请求不接受请求体' } });
    expect(await stack.requests()).toEqual([]);

    const ok = await summarize(stack, generationId, '1');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ chapterId: '1', cached: false, summary: MOCK_SUMMARY_NORMALIZED });
  });

  // 抓：没有结束标记的残缺文章也被保存，前端仍能打开 5W1H
  it('生成中断（没有结束标记）时不保存，该 generationId 的 5W1H 返回 404', async () => {
    await stack.scenario({ streams: { 'mock-primary': { kind: 'ok', texts: ['# 标题\n\n## 第一章：残缺\n\n', '写到一半'], intervalMs: 20, finishReason: null } } });
    const gen = await generate(stack, { url: MOCK_URL });
    expect(gen.events.map((e) => e.event)).toEqual(['stage', 'meta', 'stage', 'delta', 'delta', 'error']);
    expect(eventOf(gen.events, 'error')).toEqual({ code: 'interrupted', message: '生成中断，文章不完整（模型没有给出结束标记）', partial: true });

    await stack.reset();
    const res = await summarize(stack, eventOf(gen.events, 'meta')!.generationId, '1');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'generation_not_found', message: '这次生成已过期或不存在，请重新生成' } });
    expect(await stack.requests()).toEqual([]);
  });
});
