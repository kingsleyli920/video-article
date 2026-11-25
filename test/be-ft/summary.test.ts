import { runDurableObjectAlarm } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArticle } from '../../src/shared/article';
import type { SummaryResponse } from '../../src/shared/types';
import { createStore, type GenerationContext } from '../../src/worker/store';
import { geminiJson } from '../fixtures/upstream';
import { mockUpstream } from './helpers';

afterEach(() => vi.restoreAllMocks());

const MARKDOWN = '# 标题\n\n## 技术革命：八十年一遇\n\n**主持人:** 第几局？\n\n**嘉宾:** 第三年。\n\n## 智能经济：收入爆发\n\n**嘉宾:** 第二章正文-服务端保存。';
const SUMMARY = { who: 'Mark', what: 'AI 收入增长', when: '', where: '企业市场', why: '效率提升', how: '按 token 计费' };

async function savedGeneration(): Promise<{ generationId: string; store: ReturnType<typeof createStore>['store'] }> {
  const { generationId, store } = createStore(env);
  const article = parseArticle(MARKDOWN);
  const context: GenerationContext = {
    version: 1,
    generationId,
    createdAt: '2026-11-24T00:00:00.000Z',
    model: 'test-model',
    video: { id: 'xRh2sVcNXQ8', title: '视频', channel: '频道', description: '', lengthSeconds: 60 },
    transcript: { source: 'backup', language: 'en', kind: 'asr', chars: 20, text: '[00:00] 字幕原文-服务端保存' },
    instructions: '用户要求-服务端保存',
    article: { title: article.title, markdown: MARKDOWN, chapters: article.chapters },
  };
  await store.save(context);
  return { generationId, store };
}

function summarize(generationId: string, chapterId: string, init: RequestInit = {}) {
  return exports.default.fetch(`https://app.test/api/generations/${generationId}/chapters/${chapterId}/summary`, { method: 'POST', ...init });
}

describe('POST /api/generations/:id/chapters/:chapterId/summary', () => {
  // 抓：总结用了前端传来的内容，或者漏了服务端保存的字幕、用户要求、章节正文
  it('只用服务端保存的字幕、用户要求和目标章节生成总结', async () => {
    const { generationId } = await savedGeneration();
    const upstream = mockUpstream({ geminiJson: geminiJson(SUMMARY) });
    const res = await summarize(generationId, '2');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ chapterId: '2', cached: false, summary: { ...SUMMARY, when: null } });
    const prompt = upstream.gemini()[0]!.body;
    expect(prompt).toContain('字幕原文-服务端保存');
    expect(prompt).toContain('用户要求-服务端保存');
    expect(prompt).toContain('第二章正文-服务端保存');
    expect(prompt).toContain('## 智能经济：收入爆发');
    expect(JSON.parse(prompt).generationConfig.responseJsonSchema.required).toEqual(['who', 'what', 'when', 'where', 'why', 'how']);
    // 实际发给 Gemini 的系统提示词里带着人物身份规则全文，而不只是一句"按同一套规则"
    const system = JSON.parse(prompt).systemInstruction.parts[0].text as string;
    expect(system).toContain('人物身份与发言归属：');
    expect(system).toContain('不能作为依据的：频道层面的通用介绍');
    expect(system).toContain('不写字幕和本期元数据里都没有出现过的人名');
  });

  // 抓：主模型繁忙时 5W1H 直接失败，评审期间遇到高峰就点不开
  it('主模型繁忙（503 重试后仍失败）时改用备用模型生成总结', async () => {
    const { generationId } = await savedGeneration();
    const upstream = mockUpstream({ busyModels: ['test-model'], geminiJson: geminiJson(SUMMARY) });
    const res = await summarize(generationId, '2');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ chapterId: '2', cached: false, summary: { ...SUMMARY, when: null } });
    expect(upstream.gemini().map((c) => c.url.split('/models/')[1]!.split(':')[0])).toEqual(['test-model', 'test-model', 'test-fallback']);
    expect(upstream.gemini().map((c) => JSON.parse(c.body).generationConfig.thinkingConfig)).toEqual([{ thinkingLevel: 'high' }, { thinkingLevel: 'high' }, { thinkingLevel: 'low' }]);
  });

  // 抓：5W1H 遇到 402 时重试或换备用模型
  it('主模型返回 402（预付额度用完）：只请求一次，不换备用模型，返回 gemini_billing', async () => {
    const { generationId } = await savedGeneration();
    const upstream = mockUpstream({ billingModels: ['test-model', 'test-fallback'], geminiJson: geminiJson(SUMMARY) });
    const res = await summarize(generationId, '2');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'gemini_billing', message: 'Gemini 账户的预付额度已用完，暂时无法生成' } });
    expect(upstream.gemini().map((c) => c.url.split('/models/')[1]!.split(':')[0])).toEqual(['test-model']);
  });

  // 抓：前端把整篇文章塞进请求体也被接受
  it('带请求体的总结请求一律拒绝，不调用 Gemini', async () => {
    const { generationId } = await savedGeneration();
    const upstream = mockUpstream({ geminiJson: geminiJson(SUMMARY) });
    const res = await summarize(generationId, '1', { body: JSON.stringify({ article: '前端伪造的文章' }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'body_not_allowed', message: '总结请求不接受请求体' } });
    expect(upstream.calls).toHaveLength(0);
  });

  // 抓：重复点击同一章时每次都重新调用模型
  it('同一章第二次请求直接复用已保存的结果', async () => {
    const { generationId } = await savedGeneration();
    const upstream = mockUpstream({ geminiJson: geminiJson(SUMMARY) });
    await summarize(generationId, '1');
    const second = (await (await summarize(generationId, '1')).json()) as SummaryResponse;
    expect(second).toMatchObject({ chapterId: '1', cached: true, summary: { who: 'Mark', when: null } });
    expect(upstream.gemini()).toHaveLength(1);
  });

  // 抓：同一章并发请求各自缓存未命中，重复调用 Gemini
  it('同一章节的并发请求合并成一次 Gemini 调用', async () => {
    const { generationId } = await savedGeneration();
    const gemini = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return Response.json(geminiJson(SUMMARY));
    });
    const responses = await Promise.all([summarize(generationId, '1'), summarize(generationId, '1'), summarize(generationId, '1')]);
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as SummaryResponse[];
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    // 都是 cached:false，说明是共用同一次生成，而不是后来的请求命中缓存
    expect(bodies.map((b) => b.cached)).toEqual([false, false, false]);
    expect(new Set(bodies.map((b) => JSON.stringify(b.summary))).size).toBe(1);
    expect(gemini).toHaveBeenCalledOnce();
  });

  it('不同章节的并发请求互不合并', async () => {
    const { generationId } = await savedGeneration();
    const gemini = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(geminiJson(SUMMARY)));
    await Promise.all([summarize(generationId, '1'), summarize(generationId, '2')]);
    expect(gemini).toHaveBeenCalledTimes(2);
  });

  // 抓：格式不合法的总结被缓存，之后再点也一直是坏结果
  it('模型返回的字段不全时报 summary_invalid，不缓存，下次重新生成', async () => {
    const { generationId, store } = await savedGeneration();
    mockUpstream({ geminiJson: geminiJson({ who: 'Mark' }) });
    const res = await summarize(generationId, '1');
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('summary_invalid');
    expect(await store.getSummary('1')).toBeNull();
  });

  it.each([
    ['不存在的生成', 'f'.repeat(64), '1', 404, 'generation_not_found'],
    ['格式不对的 id', 'not-an-id', '1', 404, 'generation_not_found'],
  ])('%s返回 404', async (_, id, chapter, status, code) => {
    const res = await summarize(id, chapter);
    expect(res.status).toBe(status);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
  });

  it('章节不存在时返回 chapter_not_found', async () => {
    const { generationId } = await savedGeneration();
    const res = await summarize(generationId, '9');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('chapter_not_found');
  });

  // 抓：过期数据没有被清掉，或清理后接口仍返回旧内容
  it('到期 alarm 删除上下文和总结，之后返回 generation_not_found', async () => {
    const { generationId, store } = await savedGeneration();
    mockUpstream({ geminiJson: geminiJson(SUMMARY) });
    await summarize(generationId, '1');
    expect(await runDurableObjectAlarm(store)).toBe(true);
    expect(await store.load()).toBeNull();
    expect(await store.getSummary('1')).toBeNull();
    const res = await summarize(generationId, '1');
    expect(res.status).toBe(404);
  });
});
