import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '../../src/shared/limits';
import { readSse } from '../../src/shared/sse';
import { handleGenerate } from '../../src/worker/generate';
import { GenerationStore, openStore } from '../../src/worker/store';
import { ARTICLE_MARKDOWN, ARTICLE_TEXTS, geminiJson, NO_REQUIREMENTS_JSON, OTHER_VIDEO_ID, playerResponse, SAMPLE_VIDEO_ID, srv1 } from '../fixtures/upstream';
import { eventOf, generate, geminiSse, mockUpstream } from './helpers';

afterEach(() => vi.restoreAllMocks());

const url = (id: string) => `https://www.youtube.com/watch?v=${id}`;

describe('POST /api/generations', () => {
  // 抓：事件顺序错乱、done 在保存之前发出、保存的上下文缺字幕或文章
  it('正常流程：stage → meta → stage → delta… → done，done 时上下文已保存', async () => {
    const upstream = mockUpstream({ geminiStream: geminiSse(ARTICLE_TEXTS) });
    const { status, events } = await generate({ url: url(OTHER_VIDEO_ID), instructions: '写给投资人' });

    expect(status).toBe(200);
    // 文章写完之后、done 之前多了核对阶段（stage: reviewing）；初稿没有问题时不发 revised
    expect(events.map((e) => e.event)).toEqual(['stage', 'meta', 'stage', 'delta', 'delta', 'delta', 'stage', 'done']);
    expect(events.filter((e) => e.event === 'stage').map((e) => e.data)).toEqual([{ stage: 'transcript' }, { stage: 'generating' }, { stage: 'reviewing' }]);
    const meta = eventOf(events, 'meta')!;
    // 抓：等待时没有字幕来源信息，或者把整篇字幕发给页面
    expect(meta.transcript).toEqual({
      source: 'live',
      language: 'en',
      kind: 'asr',
      chars: '[00:00] live caption text'.length,
      preview: [{ time: '00:00', text: 'live caption text' }],
    });
    expect(events.filter((e) => e.event === 'delta').map((e) => (e.data as { text: string }).text).join('')).toBe(ARTICLE_MARKDOWN);
    expect(eventOf(events, 'done')!.chapters).toEqual([
      { id: '1', title: '技术革命：八十年一遇' },
      { id: '2', title: '智能经济：收入爆发' },
    ]);
    expect(eventOf(events, 'done')!.numberWarnings).toEqual([]);

    const saved = await openStore(env, meta.generationId).load();
    expect(saved).toMatchObject({
      generationId: meta.generationId,
      instructions: '写给投资人',
      transcript: { source: 'live', text: '[00:00] live caption text' },
      article: { title: '对话测试嘉宾：测试议题', markdown: ARTICLE_MARKDOWN },
    });
    expect(saved!.article.chapters.map((c) => c.id)).toEqual(['1', '2']);
    // 预览只在 meta 里发给页面，不存进上下文
    expect(saved!.transcript).not.toHaveProperty('preview');

    // 用户要求和字幕都进了写文章的 Gemini 请求（有用户要求时还会有一次约束提取请求，先于写文章发出）
    const prompt = upstream.gemini('article')[0]!.body;
    expect(prompt).toContain('写给投资人');
    expect(prompt).toContain('live caption text');
  });

  // 抓：模型还没开始输出（没有任何写入）时用户离开，服务端要等首个分块超时（线上 180 秒）才放手，之后还去调备用模型
  it('模型还没输出时入站请求中止：立即中止上游请求，不调用备用模型，不保存', async () => {
    const geminiCalls: { model: string; signal: AbortSignal }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith('https://www.youtube.com/youtubei/v1/player')) return Response.json(playerResponse());
      if (url.startsWith('https://www.youtube.com/api/timedtext')) return new Response(srv1([[0, 'live caption text']]));
      if (url.includes('generativelanguage.googleapis.com')) {
        const signal = init!.signal!;
        geminiCalls.push({ model: url.split('/models/')[1]!.split(':')[0]!, signal });
        // 模型一直不返回，和真实 fetch 一样在中止时失败
        return new Promise<Response>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
      }
      throw new Error(`测试未预设的出站请求：${url}`);
    });
    const client = new AbortController();
    const res = await exports.default.fetch('https://app.test/api/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: url(OTHER_VIDEO_ID) }),
      signal: client.signal,
    });
    // 手动读到"generating"阶段为止，不取消响应体：只让入站请求中止，单独验证这条发现断开的路径
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    while (!received.includes('"stage":"generating"')) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
    const generationId = /"generationId":"([0-9a-f]{64})"/.exec(received)![1]!;
    await vi.waitFor(() => expect(geminiCalls).toHaveLength(1));

    client.abort();
    await vi.waitFor(() => expect(geminiCalls[0]!.signal.aborted).toBe(true), { timeout: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(geminiCalls.map((c) => c.model)).toEqual(['test-model']);
    expect(await openStore(env, generationId).load()).toBeNull();
  });

  // 抓：模型把字幕里残缺的数字补成确定的数，done 里却没有提示；没有补数时误报
  // 也抓：交给模型的文章请求和 5W1H 请求里还留着 ",200"；遮蔽之后原始证据丢失、数字检查失效
  it('字幕有残缺数字：文章和 5W1H 实际发出的请求都用占位，原始证据存进上下文，文中补出的数照样提示', async () => {
    const upstream = mockUpstream({
      captions: srv1([
        [0, 'intro'],
        [2065, '&amp;gt;&amp;gt; we&amp;#39;re tracking on the order of,200 bills'],
      ]),
      geminiStream: geminiSse(['# 标题\n\n## 监管\n\n各州大约有1200项法案，', '另有 300 项已通过。']),
      geminiJson: geminiJson({ who: '嘉宾', what: '州级法案', when: '', where: '美国', why: '', how: '' }),
    });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
    const done = eventOf(events, 'done')!;
    expect(done.numberWarnings).toEqual([{ time: '34:25', fragment: 'of,200', written: ['1200'] }]);

    const masked = "[00:00] intro\n\n[34:25] >> we're tracking on the order of〔字幕此处数字不清，无法确定具体数量〕 bills";
    const articleRequest = upstream.gemini('article')[0]!.body;
    expect(JSON.parse(articleRequest).contents[0].parts[0].text).toContain(`<transcript>\n${masked}\n</transcript>`);
    expect(articleRequest).not.toContain(',200');

    const generationId = eventOf(events, 'meta')!.generationId;
    const saved = await openStore(env, generationId).load();
    expect(saved!.transcript.text).toBe(masked);
    expect(saved!.transcript.damagedNumbers).toEqual([
      { time: '34:25', fragment: 'of,200', digits: '200', cue: ">> we're tracking on the order of,200 bills" },
    ]);

    const res = await exports.default.fetch(`https://app.test/api/generations/${generationId}/chapters/1/summary`, { method: 'POST' });
    expect(res.status).toBe(200);
    // 只看 5W1H 请求：核对请求里也带着同一份遮蔽后的字幕，按位置取会取到核对请求
    expect(upstream.gemini('summary')).toHaveLength(1);
    const summaryRequest = upstream.gemini('summary')[0]!.body;
    expect(JSON.parse(summaryRequest).contents[0].parts[0].text).toContain(`<transcript>\n${masked}\n</transcript>`);
    expect(summaryRequest).not.toContain(',200');
  });

  // 抓：主模型开始输出前一直 503 时整篇失败，或者换了模型却不说明实际用的是哪个
  it('主模型开始输出前持续繁忙（503 重试后仍失败）时整篇改用备用模型，done 和保存的上下文记录实际模型', async () => {
    const upstream = mockUpstream({ busyModels: ['test-model'], geminiStream: geminiSse(ARTICLE_TEXTS) });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
    // 只看写文章的请求（核对请求同样会先 503 再换备用，那是另一回事）
    expect(upstream.gemini('article').map((c) => c.url.split('/models/')[1]!.split(':')[0])).toEqual(['test-model', 'test-model', 'test-fallback']);
    expect(eventOf(events, 'meta')!.model).toBe('test-model');
    expect(eventOf(events, 'done')!.model).toBe('test-fallback');
    expect(events.filter((e) => e.event === 'delta').map((e) => (e.data as { text: string }).text).join('')).toBe(ARTICLE_MARKDOWN);
    expect((await openStore(env, eventOf(events, 'meta')!.generationId).load())!.model).toBe('test-fallback');
    // 主模型用 high；备用模型用它自己经过验证的思考档 low，不沿用主模型的 high
    expect(upstream.gemini('article').map((c) => JSON.parse(c.body).generationConfig.thinkingConfig)).toEqual([{ thinkingLevel: 'high' }, { thinkingLevel: 'high' }, { thinkingLevel: 'low' }]);
  });

  // 抓：备用模型没有配置思考档时，请求里又带上了主模型的 high（实际请求和日志里记的 null 不一致）
  it('备用模型没有配置思考档时，备用请求不带 thinkingConfig，不沿用主模型的 high', async () => {
    const upstream = mockUpstream({ busyModels: ['test-model'], geminiStream: geminiSse(ARTICLE_TEXTS) });
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (work: Promise<unknown>) => void pending.push(work), passThroughOnException: () => {} } as unknown as ExecutionContext;
    const request = new Request('https://app.test/api/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: url(OTHER_VIDEO_ID) }),
    });
    const res = await handleGenerate(request, { ...env, GEMINI_FALLBACK_THINKING_LEVEL: '' } as unknown as Env, ctx);
    const events: { event: string; data: { model?: string } }[] = [];
    for await (const message of readSse(res.body!)) events.push({ event: message.event, data: JSON.parse(message.data) });
    await Promise.all(pending);

    expect(events.at(-1)).toMatchObject({ event: 'done', data: { model: 'test-fallback' } });
    const requests = upstream.gemini('article').map((c) => ({ model: c.url.split('/models/')[1]!.split(':')[0], thinkingConfig: JSON.parse(c.body).generationConfig.thinkingConfig }));
    expect(requests).toEqual([
      { model: 'test-model', thinkingConfig: { thinkingLevel: 'high' } },
      { model: 'test-model', thinkingConfig: { thinkingLevel: 'high' } },
      { model: 'test-fallback', thinkingConfig: undefined },
    ]);
  });

  // 抓：预付额度用完（402）时重试或换同一账单下的备用模型，或者只报"调用失败"让人看不出原因
  it('主模型返回 402（预付额度用完）：只请求一次，不重试、不换备用模型，报 gemini_billing', async () => {
    const upstream = mockUpstream({ billingModels: ['test-model', 'test-fallback'], geminiStream: geminiSse(ARTICLE_TEXTS) });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
    expect(upstream.gemini().map((c) => c.url.split('/models/')[1]!.split(':')[0])).toEqual(['test-model']);
    expect(events.at(-1)).toEqual({ event: 'error', data: { code: 'gemini_billing', message: 'Gemini 账户的预付额度已用完，暂时无法生成', partial: false } });
  });

  // 抓：主模型写到一半出错后换模型重写，两个模型的输出拼成一篇
  it('主模型已经开始输出后出现 503 错误事件时不换模型，报 gemini_busy 并保留部分内容', async () => {
    const overloaded = `data: ${JSON.stringify({ error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } })}\r\n\r\n`;
    const upstream = mockUpstream({ geminiStream: geminiSse(['# 标题\n\n## 第一章\n\n写到一半'], null) + overloaded });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
    expect(upstream.gemini()).toHaveLength(1);
    expect(events.at(-1)).toEqual({ event: 'error', data: { code: 'gemini_busy', message: 'Gemini 模型繁忙，请稍后重试（HTTP 503）', partial: true } });
    expect(await openStore(env, eventOf(events, 'meta')!.generationId).load()).toBeNull();
  });

  // 抓：示例视频实时抓取失败时直接报错，或者用了备份却不告诉用户
  it('示例视频实时字幕失败时改用内置备份，并在 meta 里说明来源和失败原因', async () => {
    const upstream = mockUpstream({ player: 429, geminiStream: geminiSse(ARTICLE_TEXTS) });
    const { events } = await generate({ url: url(SAMPLE_VIDEO_ID) });
    expect(eventOf(events, 'meta')!.transcript).toMatchObject({
      source: 'backup',
      language: 'en',
      kind: 'asr',
      liveError: 'YouTube 拒绝了字幕请求，可能触发了人机验证（本地试 3 次，换 3 个区域后仍被拦）',
    });
    expect(upstream.gemini('article')[0]!.body).toContain('this new wave of AI companies');
    expect(eventOf(events, 'done')).toBeDefined();
  });

  // 抓：其他视频也悄悄用了示例视频的备份字幕
  it('其他视频实时字幕失败时报错，不使用备份', async () => {
    const upstream = mockUpstream({ player: 429, geminiStream: geminiSse(ARTICLE_TEXTS) });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
    expect(events.map((e) => e.event)).toEqual(['stage', 'error']);
    expect(eventOf(events, 'error')).toEqual({ code: 'youtube_blocked', message: 'YouTube 拒绝了字幕请求，可能触发了人机验证（本地试 3 次，换 3 个区域后仍被拦）', partial: false });
    expect(upstream.gemini()).toHaveLength(0);
    // 本地 3 次、三个区域各 3 次，都是 429
    expect(upstream.calls.filter((c) => c.url.startsWith('https://www.youtube.com/youtubei/v1/player'))).toHaveLength(12);
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
  // 补充验收 R04、R09、R10 抓：文章只有一段正文（正好是最后一块），done 里的首个可读段落时间是 null
  it('只有一段正文的短文：首个可读段落记为最后一段正文发出的时间，不是 null', async () => {
    mockUpstream({ geminiStream: geminiSse(['# 营收与成本\n\n## 数据说明\n\n', '营收为1.2亿美元。']) });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
    const timing = eventOf(events, 'done')!.timing;
    expect(timing.firstParagraphMs).not.toBeNull();
    expect(timing.firstParagraphMs!).toBeGreaterThanOrEqual(timing.firstTokenMs!);
    expect(timing.firstParagraphMs!).toBeLessThanOrEqual(timing.modelDoneMs);
  });

  it('文章没有章节结构时发 invalid_structure，不保存', async () => {
    mockUpstream({ geminiStream: geminiSse(['# 标题\n\n只有一段正文。']) });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
    expect(eventOf(events, 'error')).toEqual({ code: 'invalid_structure', message: '文章缺少有效的章节结构，无法提供章节总结（没有二级标题章节）', partial: true });
    expect(await openStore(env, eventOf(events, 'meta')!.generationId).load()).toBeNull();
  });

  // 抓：全文重写没有复用初稿的异常长输出保护，或长度错误被包装成 review_failed。
  it('重写流超过全局长度上限：article_too_long，不再核对，不保存或替换页面', async () => {
    const oversized = `# 标题\n\n## 一\n\n${'a'.repeat(LIMITS.articleChars)}\n\n## 二\n\n正文。\n\n## 三\n\n正文。`;
    const upstream = mockUpstream({
      geminiStream: geminiSse(ARTICLE_TEXTS),
      requirementsJson: geminiJson({ ...NO_REQUIREMENTS_JSON, chaptersMin: 3, chaptersMax: 3, chaptersQuote: '分三章' }),
      geminiOverride: ({ purpose }) => (purpose === 'rewrite' ? new Response(geminiSse([oversized]), { headers: { 'content-type': 'text/event-stream' } }) : undefined),
    });
    const save = vi.spyOn(GenerationStore.prototype, 'save');
    const { events } = await generate({ url: url(OTHER_VIDEO_ID), instructions: '分三章写' });
    expect(eventOf(events, 'error')).toEqual({ code: 'article_too_long', message: '文章超过长度上限，已停止生成', partial: true });
    expect(eventOf(events, 'done')).toBeUndefined();
    expect(eventOf(events, 'revised')).toBeUndefined();
    expect(upstream.gemini('rewrite')).toHaveLength(1);
    expect(upstream.gemini('review')).toHaveLength(0);
    expect(upstream.gemini('tone')).toHaveLength(0);
    expect(save).not.toHaveBeenCalled();
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

  // 抓：模型还没结束客户端就走了，服务端照样跑完并保存，白白消耗额度和存储
  it('客户端在模型结束前断开：服务端停止读取模型输出，不保存上下文', async () => {
    const save = vi.spyOn(GenerationStore.prototype, 'save');
    const encoder = new TextEncoder();
    let upstreamCancelled = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/youtubei/v1/player')) return Response.json(playerResponse());
      if (url.includes('/api/timedtext')) return new Response(srv1([[0, 'live caption text']]));
      // 先给出全部正文，200 毫秒后才给 STOP；客户端在这之间断开
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(encoder.encode(geminiSse(ARTICLE_TEXTS, null)));
            await new Promise((resolve) => setTimeout(resolve, 200));
            try {
              controller.enqueue(encoder.encode(geminiSse([''], 'STOP')));
            } catch {
              // 上游已被取消
            }
          },
          cancel() {
            upstreamCancelled = true;
          },
        }),
      );
    });

    const res = await exports.default.fetch('https://app.test/api/generations', { method: 'POST', body: JSON.stringify({ url: url(OTHER_VIDEO_ID) }) });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    while (!received.includes('智能经济')) received += decoder.decode((await reader.read()).value, { stream: true });
    const generationId = /"generationId":"([0-9a-f]{64})"/.exec(received)![1]!;
    await reader.cancel('user closed the tab');

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(upstreamCancelled).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(await openStore(env, generationId).load()).toBeNull();
  });

  // 补充验收 C01 抓：上限按视频时长或原始字幕长度判断，而不是按整理后交给模型的文本；等于上限时被误拒，超出 1 个字符时仍调用 Gemini。
  // 整理后的文本是 "[00:00] " 加一条字幕原文，长度 = 8 + 原文长度；上限 L 取自生产常量 LIMITS.transcriptChars。
  it.each([
    ['L-1', -1, '600', true],
    ['L', 0, '600', true],
    ['L+1', 1, '600', false],
    ['L（视频时长 13.9 小时）', 0, '50000', true],
  ])('整理后正好 %s 个字符：上限内继续生成，超出时在调用 Gemini 前报 transcript_too_long', async (_label, delta, lengthSeconds, allowed) => {
    const L = LIMITS.transcriptChars;
    const text = 'abcdefghij'.repeat(Math.ceil(L / 10)).slice(0, L - 8 + delta);
    const player = playerResponse();
    player.videoDetails.lengthSeconds = lengthSeconds;
    const upstream = mockUpstream({ player, captions: srv1([[0, text]]), geminiStream: geminiSse(ARTICLE_TEXTS) });
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });
    if (allowed) {
      expect(eventOf(events, 'meta')!.transcript.chars).toBe(L + delta);
      expect(eventOf(events, 'done')).toBeDefined();
      // 写文章只请求一次（之后每章还有一个核对请求）
      expect(upstream.gemini('article')).toHaveLength(1);
    } else {
      expect(eventOf(events, 'meta')).toBeUndefined();
      expect(eventOf(events, 'error')).toEqual({ code: 'transcript_too_long', message: '字幕过长，超过支持的上限（300001 字符，上限 300000）', partial: false });
      expect(upstream.gemini()).toHaveLength(0);
    }
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
