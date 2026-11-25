/**
 * L3 YouTube 字幕获取：各类失败的错误码、超时、示例视频改用内置备份。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { VideoScenario } from '../harness/mock-upstream';
import { eventOf, generate, ofKind, promptOf, waitFor } from './api';
import { MOCK_URL, SAMPLE_URL } from './expected';
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

describe('YouTube 字幕失败', () => {
  // 抓：YouTube 侧的不同失败被归成同一个笼统错误（用户不知道是被拦、视频问题还是没字幕）；失败后仍去调用模型
  it.each([
    ['blocked', 'youtube_blocked', "YouTube 拒绝了字幕请求，可能触发了人机验证（Sign in to confirm you're not a bot）"],
    ['unplayable', 'video_unavailable', '视频不存在或无法播放（Video unavailable）'],
    ['no-captions', 'no_captions', '这个视频没有可用的字幕'],
  ] as const)('播放器接口 %s：SSE 报 %s，不请求字幕和模型', async (kind, code, message) => {
    await stack.scenario({ videos: { mockvideo01: { kind } as VideoScenario } });
    const gen = await generate(stack, { url: MOCK_URL });
    expect(gen.status).toBe(200);
    expect(gen.events.map((e) => e.event)).toEqual(['stage', 'error']);
    expect(eventOf(gen.events, 'error')).toEqual({ code, message, partial: false });
    expect((await stack.requests()).map((r) => [r.kind, r.videoId])).toEqual([['player', 'mockvideo01']]);
  });

  // 抓：播放器接口不响应时一直卡在字幕阶段；超时后没有中止上游请求
  it('播放器接口不响应：约 0.5 秒后报 youtube_timeout，并中止对上游的请求', async () => {
    await stack.scenario({ videos: { mockvideo01: { kind: 'hang' } } });
    const gen = await generate(stack, { url: MOCK_URL });
    expect(gen.events.map((e) => e.event)).toEqual(['stage', 'error']);
    expect(eventOf(gen.events, 'error')).toEqual({ code: 'youtube_timeout', message: '获取字幕超时，请稍后重试（读取视频信息超过 0.5 秒）', partial: false });
    expect(gen.elapsedMs).toBeGreaterThanOrEqual(480);
    expect(gen.elapsedMs).toBeLessThan(2_000);

    const player = await waitFor(async () => (await stack.requests()).find((r) => r.kind === 'player' && r.durationMs !== null), 3_000, '播放器请求的连接关闭');
    expect(player.aborted).toBe(true);
    expect(player.durationMs!).toBeLessThan(2_000);
    expect(ofKind(await stack.requests(), 'stream')).toEqual([]);
  });
});

describe('示例视频的内置备份', () => {
  // 抓：示例视频实时获取失败时直接报错，或者用了备份却不告诉用户（source、liveError 缺失），或者备份字幕没进模型请求
  it.each([
    ['被 YouTube 拦截', 'blocked', "YouTube 拒绝了字幕请求，可能触发了人机验证（Sign in to confirm you're not a bot）"],
    ['播放器接口不响应', 'hang', '获取字幕超时，请稍后重试（读取视频信息超过 0.5 秒）'],
  ] as const)('xRh2sVcNXQ8 %s：改用内置备份写完文章，meta 标明 backup 和失败原因', async (_, kind, liveError) => {
    await stack.scenario({ videos: { xRh2sVcNXQ8: { kind } as VideoScenario } });
    const gen = await generate(stack, { url: SAMPLE_URL });
    expect(gen.events.at(-1)!.event).toBe('done');

    const meta = eventOf(gen.events, 'meta')!;
    expect(meta.video).toEqual({
      id: 'xRh2sVcNXQ8',
      title: "Marc Andreessen's 2026 Outlook: AI Timelines, US vs. China, and The Price of AI",
      channel: 'a16z',
      lengthSeconds: 4878,
    });
    expect(meta.transcript).toEqual({ source: 'backup', language: 'en', kind: 'asr', chars: expect.any(Number), liveError, preview: expect.any(Array) });
    // 备份字幕同样带原文片段：开头、约三分之一、约三分之二处各一段（81 分钟视频），每段不超过 200 字符
    const preview = meta.transcript.preview!;
    expect(preview.map((s) => s.time)).toEqual(['00:00', '26:51', '53:43']);
    expect(preview[0]!.text.startsWith('this new wave of AI companies is is growing revenue')).toBe(true);
    expect(preview.every((s) => s.text.length > 0 && s.text.length <= 200)).toBe(true);

    const requests = await stack.requests();
    expect(requests.map((r) => [r.kind, r.videoId ?? r.model])).toEqual([
      ['player', 'xRh2sVcNXQ8'],
      ['stream', 'mock-primary'],
    ]);
    // 模型收到的是备份字幕全文：开头、结尾都在，meta 里的字数就是这段正文的长度
    const user = promptOf(requests[1]!).user;
    const transcript = /<transcript>\n([\s\S]*)\n<\/transcript>/.exec(user)![1]!;
    expect(transcript.startsWith('[00:00] this new wave of AI companies is is growing revenue like just like actual')).toBe(true);
    expect(transcript.endsWith('Mars, so I will be just fine.')).toBe(true);
    expect(meta.transcript.chars).toBe(transcript.length);
    expect(meta.transcript.chars).toBeGreaterThan(50_000);
  });
});
