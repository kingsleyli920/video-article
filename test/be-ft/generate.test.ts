import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenerationStore, openStore } from '../../src/worker/store';
import { ARTICLE_MARKDOWN, ARTICLE_TEXTS, OTHER_VIDEO_ID, SAMPLE_VIDEO_ID } from '../fixtures/upstream';
import { eventOf, generate, geminiSse, mockUpstream } from './helpers';

afterEach(() => vi.restoreAllMocks());

const url = (id: string) => `https://www.youtube.com/watch?v=${id}`;

describe('POST /api/generations', () => {
  // 抓：事件顺序错乱、done 在保存之前发出、保存的上下文缺字幕或文章
  it('正常流程：stage → meta → stage → delta… → done，done 时上下文已保存', async () => {
    const upstream = mockUpstream({ geminiStream: geminiSse(ARTICLE_TEXTS) });
    const { status, events } = await generate({ url: url(OTHER_VIDEO_ID), instructions: '写给投资人' });

    expect(status).toBe(200);
    expect(events.map((e) => e.event)).toEqual(['stage', 'meta', 'stage', 'delta', 'delta', 'delta', 'done']);
    const meta = eventOf(events, 'meta')!;
    expect(meta.transcript).toEqual({ source: 'live', language: 'en', kind: 'asr', chars: '[00:00] live caption text'.length });
    expect(events.filter((e) => e.event === 'delta').map((e) => (e.data as { text: string }).text).join('')).toBe(ARTICLE_MARKDOWN);
    expect(eventOf(events, 'done')!.chapters).toEqual([
      { id: '1', title: '技术革命：八十年一遇' },
      { id: '2', title: '智能经济：收入爆发' },
    ]);

    const saved = await openStore(env, meta.generationId).load();
    expect(saved).toMatchObject({
      generationId: meta.generationId,
      instructions: '写给投资人',
      transcript: { source: 'live', text: '[00:00] live caption text' },
      article: { title: '对话测试嘉宾：测试议题', markdown: ARTICLE_MARKDOWN },
    });
    expect(saved!.article.chapters.map((c) => c.id)).toEqual(['1', '2']);

    // 用户要求和字幕都进了 Gemini 请求
    const prompt = upstream.gemini()[0]!.body;
    expect(prompt).toContain('写给投资人');
    expect(prompt).toContain('live caption text');
  });

  // 抓：示例视频实时抓取失败时直接报错，或者用了备份却不告诉用户
  it('示例视频实时字幕失败时改用内置备份，并在 meta 里说明来源和失败原因', async () => {
    const upstream = mockUpstream({ player: 429, geminiStream: geminiSse(ARTICLE_TEXTS) });
    const { events } = await generate({ url: url(SAMPLE_VIDEO_ID) });
    expect(eventOf(events, 'meta')!.transcript).toMatchObject({
      source: 'backup',
      language: 'en',
      kind: 'asr',
      liveError: 'YouTube 拒绝了字幕请求，可能触发了人机验证（HTTP 429）',
    });
    expect(upstream.gemini()[0]!.body).toContain('this new wave of AI companies');
    expect(eventOf(events, 'done')).toBeDefined();
  });

  // 抓：其他视频也悄悄用了示例视频的备份字幕
  it('其他视频实时字幕失败时报错，不使用备份', async () => {
    const upstream = mockUpstream({ player: 429, geminiStream: geminiSse(ARTICLE_TEXTS) });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
    expect(events.map((e) => e.event)).toEqual(['stage', 'error']);
    expect(eventOf(events, 'error')).toEqual({ code: 'youtube_blocked', message: 'YouTube 拒绝了字幕请求，可能触发了人机验证（HTTP 429）', partial: false });
    expect(upstream.gemini()).toHaveLength(0);
  });

  // 抓：输出被截断仍然发 done、保存上下文并开放 5W1H
  it.each([
    ['MAX_TOKENS', 'truncated', '输出达到长度上限，文章不完整'],
    [null, 'interrupted', '生成中断，文章不完整（模型没有给出结束标记）'],
    ['SAFETY', 'blocked', '内容被模型的安全策略拦截，文章不完整（SAFETY）'],
  ])('finishReason=%s 时发 error(%s)，保留 partial 标记且不保存', async (finishReason, code, message) => {
    mockUpstream({ geminiStream: geminiSse(ARTICLE_TEXTS, finishReason) });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
    expect(events.at(-1)).toEqual({ event: 'error', data: { code, message, partial: true } });
    expect(eventOf(events, 'done')).toBeUndefined();
    expect(await openStore(env, eventOf(events, 'meta')!.generationId).load()).toBeNull();
  });

  // 抓：模型没写二级标题时也保存并开放 5W1H，前端点开后找不到章节
  it('文章没有章节结构时发 invalid_structure，不保存', async () => {
    mockUpstream({ geminiStream: geminiSse(['# 标题\n\n只有一段正文。']) });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
    expect(eventOf(events, 'error')).toEqual({ code: 'invalid_structure', message: '文章缺少有效的章节结构，无法提供章节总结（没有二级标题章节）', partial: true });
    expect(await openStore(env, eventOf(events, 'meta')!.generationId).load()).toBeNull();
  });

  // 抓：保存失败时仍然发 done，前端开放 5W1H 后全部 404
  it('保存上下文失败时发 save_failed，不发 done', async () => {
    mockUpstream({ geminiStream: geminiSse(ARTICLE_TEXTS) });
    vi.spyOn(GenerationStore.prototype, 'save').mockImplementation(async () => {
      throw new Error('disk full');
    });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
    expect(events.at(-1)).toEqual({ event: 'error', data: { code: 'save_failed', message: '保存生成上下文失败，章节总结不可用', partial: true } });
    expect(eventOf(events, 'done')).toBeUndefined();
  });

  it('字幕超过上限时报 transcript_too_long，不调用 Gemini', async () => {
    const long = Array.from({ length: 160 }, (_, i) => `<text start="${i}" dur="1">${'word '.repeat(400)}</text>`).join('');
    const upstream = mockUpstream({ captions: `<transcript>${long}</transcript>`, geminiStream: geminiSse(ARTICLE_TEXTS) });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
    expect(eventOf(events, 'error')!.code).toBe('transcript_too_long');
    expect(upstream.gemini()).toHaveLength(0);
  });

  it.each([
    [{ url: 'https://example.com/watch?v=xRh2sVcNXQ8' }, 400, 'invalid_url'],
    [{ url: url(OTHER_VIDEO_ID), instructions: 'x'.repeat(1001) }, 400, 'instructions_too_long'],
    [{ url: url(OTHER_VIDEO_ID), instructions: 42 }, 400, 'invalid_request'],
  ])('输入不合法时直接返回 JSON 错误：%o', async (body, status, code) => {
    const upstream = mockUpstream({});
    const res = await exports.default.fetch('https://app.test/api/generations', { method: 'POST', body: JSON.stringify(body) });
    expect(res.status).toBe(status);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
    expect(upstream.calls).toHaveLength(0);
  });

  it('GET 请求返回 405', async () => {
    const res = await exports.default.fetch('https://app.test/api/generations');
    expect(res.status).toBe(405);
  });
});
