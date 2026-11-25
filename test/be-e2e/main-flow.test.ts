/**
 * L3 主流程和存储落盘：真实 wrangler dev（本地 workerd + SQLite Durable Object）+ 模拟上游，只经 HTTP 入口。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deltaText, eventOf, generate, ofKind, promptOf, summarize } from './api';
import {
  ARTICLE_CHAPTERS,
  ARTICLE_CHARS,
  ARTICLE_MARKDOWN,
  CHANGED_VIDEO,
  MOCK_SUMMARY_NORMALIZED,
  MOCK_URL,
  TRANSCRIPT_CHARS,
  TRANSCRIPT_TEXT,
} from './expected';
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

/** 5W1H 提示词里第二章的正文块（只含当前章节，不含第一章正文） */
const CHAPTER_2_BLOCK = '<current_chapter id="2">\n## 第二章：数字\n\n**主持人:** 有多少项？\n\n**嘉宾:** 大约有1200项。\n</current_chapter>';

describe('主流程：生成文章 → 5W1H', () => {
  // 抓：事件顺序错乱；meta/done 的字段缺失或算错（来源、字数、章节、数字提示、实际模型）；
  // 文章请求漏了整理后的字幕或用户要求；5W1H 重新抓字幕或用了别处的内容而不是服务端保存的上下文；
  // 系统提示词没带人物身份规则全文；同章第二次请求没命中缓存又调了一次模型
  it('带生成要求生成文章，随后取 5W1H：事件、上游请求、保存的上下文和缓存都正确', async () => {
    const gen = await generate(stack, { url: MOCK_URL, instructions: '  写给投资人看，突出数字  ' });

    expect(gen.status).toBe(200);
    expect(gen.contentType).toBe('text/event-stream; charset=utf-8');
    expect(gen.events.map((e) => e.event)).toEqual(['stage', 'meta', 'stage', 'delta', 'delta', 'delta', 'done']);
    expect(gen.events[0]!.data).toEqual({ stage: 'transcript' });
    expect(gen.events[2]!.data).toEqual({ stage: 'generating' });

    const meta = eventOf(gen.events, 'meta')!;
    expect(meta).toEqual({
      generationId: expect.stringMatching(/^[0-9a-f]{64}$/),
      video: { id: 'mockvideo01', title: '受控上游测试视频', channel: '测试频道', lengthSeconds: 600 },
      transcript: { source: 'live', language: 'en', kind: 'asr', chars: TRANSCRIPT_CHARS },
      model: 'mock-primary',
    });
    expect(deltaText(gen.events)).toBe(ARTICLE_MARKDOWN);

    const done = eventOf(gen.events, 'done')!;
    expect(done).toEqual({
      chapters: ARTICLE_CHAPTERS,
      chars: ARTICLE_CHARS,
      timing: { transcriptMs: expect.any(Number), firstTokenMs: expect.any(Number), modelDoneMs: expect.any(Number), savedMs: expect.any(Number) },
      numberWarnings: [{ time: '34:25', fragment: 'of,200', written: ['1200'] }],
      model: 'mock-primary',
    });
    const { transcriptMs, firstTokenMs, modelDoneMs, savedMs } = done.timing;
    expect(transcriptMs).toBeLessThanOrEqual(firstTokenMs!);
    expect(firstTokenMs!).toBeLessThanOrEqual(modelDoneMs);
    expect(modelDoneMs).toBeLessThanOrEqual(savedMs);

    // 上游实际收到的：先播放器、再字幕、再一次主模型流式请求；请求里是整理后的字幕和去掉首尾空白的用户要求
    const generationRequests = await stack.requests();
    expect(generationRequests.map((r) => r.kind)).toEqual(['player', 'captions', 'stream']);
    expect(generationRequests[0]!.videoId).toBe('mockvideo01');
    const streamRequest = generationRequests[2]!;
    expect(streamRequest.path).toBe('/gemini/mock-primary:streamGenerateContent?alt=sse');
    const articlePrompt = promptOf(streamRequest);
    expect(articlePrompt.user).toContain(`<transcript>\n${TRANSCRIPT_TEXT}\n</transcript>`);
    // 残缺数字在交给模型的文本里已换成占位，不再暴露 ",200"
    expect(articlePrompt.user).not.toContain(',200');
    expect(articlePrompt.user).toContain('<user_requirements>\n写给投资人看，突出数字\n</user_requirements>');
    expect(articlePrompt.user).toContain('简介：\n本期主持人 Alex Chen');

    // 生成之后把上游的视频数据整个换掉：5W1H 只能读服务端保存的上下文，不能重新抓取
    await stack.reset();
    await stack.scenario({ videos: { mockvideo01: CHANGED_VIDEO } });

    const first = await summarize(stack, meta.generationId, '2');
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ chapterId: '2', cached: false, summary: MOCK_SUMMARY_NORMALIZED });

    const summaryRequests = await stack.requests();
    expect(summaryRequests.map((r) => [r.kind, r.path])).toEqual([['summary', '/gemini/mock-primary:generateContent']]);
    const prompt = promptOf(summaryRequests[0]!);
    expect(prompt.user).toContain(`<transcript>\n${TRANSCRIPT_TEXT}\n</transcript>`);
    expect(prompt.user).not.toContain(',200');
    expect(prompt.user).toContain(CHAPTER_2_BLOCK);
    expect(prompt.user).toContain('<article_outline>\n1. 第一章：开场\n2. 第二章：数字\n</article_outline>');
    expect(prompt.user).not.toContain('从第一个问题开始'); // 第一章正文不进当前章节的总结
    expect(prompt.user).toContain('\n写给投资人看，突出数字\n</user_requirements>');
    expect(prompt.user).toContain('标题：受控上游测试视频\n频道：测试频道\n时长：10 分钟\n简介：\n本期主持人 Alex Chen\n</video>');
    expect(prompt.user).not.toContain('CHANGED');
    // 系统提示词带着人物身份规则全文（首行、中间、末行）和 who 字段的人名约束
    expect(prompt.system).toContain('人物身份与发言归属：\n- 字幕（无论人工字幕还是自动识别）通常没有说话人标注。');
    expect(prompt.system).toContain('- 不能作为依据的：频道层面的通用介绍（例如每期都会出现的"our host"之类说明，并非针对本期）；只凭标题或简介猜测某人在本期出场。');
    expect(prompt.system).toContain('分不清一段话出自谁时不要硬归给某人，可以改成转述。不要用 Host、Guest 这类英文称呼。');
    expect(prompt.system).toContain('不写字幕和本期元数据里都没有出现过的人名');
    expect(prompt.generationConfig).toMatchObject({
      responseMimeType: 'application/json',
      responseJsonSchema: { required: ['who', 'what', 'when', 'where', 'why', 'how'] },
    });

    // 同一章再请求：命中缓存，上游没有新请求
    const second = await summarize(stack, meta.generationId, '2');
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ chapterId: '2', cached: true, summary: MOCK_SUMMARY_NORMALIZED });
    expect(await stack.requests()).toHaveLength(1);
  });
});

describe('存储落盘', () => {
  // 抓：上下文或已生成的 5W1H 只放在内存里（全局变量、DO 实例字段），Worker 重启后丢失或重新调用模型
  it('Worker 重启后：另一章从落盘的上下文生成 5W1H，已缓存的那章仍是 cached', async () => {
    const gen = await generate(stack, { url: MOCK_URL, instructions: '落盘测试的生成要求' });
    expect(gen.events.at(-1)!.event).toBe('done');
    const { generationId } = eventOf(gen.events, 'meta')!;

    const before = await summarize(stack, generationId, '1');
    expect(before.body).toEqual({ chapterId: '1', cached: false, summary: MOCK_SUMMARY_NORMALIZED });

    await stack.restartWorker();
    await stack.reset();
    await stack.scenario({ videos: { mockvideo01: CHANGED_VIDEO } });

    const other = await summarize(stack, generationId, '2');
    expect(other.status).toBe(200);
    expect(other.body).toEqual({ chapterId: '2', cached: false, summary: MOCK_SUMMARY_NORMALIZED });
    const afterRestart = await stack.requests();
    expect(afterRestart.map((r) => r.kind)).toEqual(['summary']);
    const prompt = promptOf(ofKind(afterRestart, 'summary')[0]!);
    expect(prompt.user).toContain(`<transcript>\n${TRANSCRIPT_TEXT}\n</transcript>`);
    expect(prompt.user).toContain(CHAPTER_2_BLOCK);
    expect(prompt.user).toContain('\n落盘测试的生成要求\n</user_requirements>');
    expect(prompt.user).not.toContain('CHANGED');

    const cached = await summarize(stack, generationId, '1');
    expect(cached.status).toBe(200);
    expect(cached.body).toEqual({ chapterId: '1', cached: true, summary: MOCK_SUMMARY_NORMALIZED });
    expect(await stack.requests()).toHaveLength(1);
  });
});
