/**
 * L3 YouTube 字幕获取：各类失败的错误码、超时、被拦后换客户端重试、示例视频改用内置备份。
 * TIMEOUT_SCALE=0.05：前两次尝试 player 0.2 秒、字幕 0.25 秒，最后一次 player 0.5 秒、字幕 0.75 秒。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultScenario, MOCK_VIDEO_ID, type OkVideo, type VideoScenario } from '../harness/mock-upstream';
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

const ANDROID_UA = 'com.google.android.youtube/21.26.364 (Linux; U; Android 11) gzip';
const IOS_UA = 'com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)';
const OLD_ANDROID_UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip';
const MOCK_VIDEO = defaultScenario().videos[MOCK_VIDEO_ID] as OkVideo;
const player = (r: { body: unknown }) => (r.body as { context: { client: { clientName: string; clientVersion: string } } }).context.client;

describe('YouTube 字幕失败', () => {
  // 抓：YouTube 侧的不同失败被归成同一个笼统错误（用户不知道是被拦、视频问题还是没字幕）；失败后仍去调用模型；
  // 视频本身的问题（不可播放、没有字幕轨）也去换客户端重试
  it.each([
    ['blocked', 'youtube_blocked', 'YouTube 拒绝了字幕请求，可能触发了人机验证（共试 3 次：人机验证、人机验证、人机验证）', 3],
    ['unplayable', 'video_unavailable', '视频不存在或无法播放（Video unavailable）', 1],
    ['no-captions', 'no_captions', '这个视频没有可用的字幕', 1],
  ] as const)('播放器接口 %s：SSE 报 %s，不请求字幕和模型', async (kind, code, message, players) => {
    await stack.scenario({ videos: { mockvideo01: { kind } as VideoScenario } });
    const gen = await generate(stack, { url: MOCK_URL });
    expect(gen.status).toBe(200);
    expect(gen.events.map((e) => e.event)).toEqual(['stage', 'error']);
    expect(eventOf(gen.events, 'error')).toEqual({ code, message, partial: false });
    expect((await stack.requests()).map((r) => [r.kind, r.videoId])).toEqual(Array.from({ length: players }, () => ['player', 'mockvideo01']));
  });

  // 抓：播放器接口不响应时一直卡在字幕阶段；超时后没有中止上游请求；前两次没有用缩短的上限（总耗时超过说好的上限）
  it('播放器接口不响应：前两次各 0.2 秒、最后一次 0.5 秒后报 youtube_timeout，三次请求都被中止', async () => {
    await stack.scenario({ videos: { mockvideo01: { kind: 'hang' } } });
    const gen = await generate(stack, { url: MOCK_URL });
    expect(gen.events.map((e) => e.event)).toEqual(['stage', 'error']);
    expect(eventOf(gen.events, 'error')).toEqual({ code: 'youtube_timeout', message: '获取字幕超时，请稍后重试（共试 3 次：超时、超时、超时）', partial: false });
    expect(gen.elapsedMs).toBeGreaterThanOrEqual(880);
    expect(gen.elapsedMs).toBeLessThan(2_500);

    const players = await waitFor(
      async () => {
        const list = (await stack.requests()).filter((r) => r.kind === 'player');
        return list.length === 3 && list.every((r) => r.durationMs !== null) ? list : null;
      },
      3_000,
      '三次播放器请求的连接都关闭',
    );
    expect(players.map((r) => r.aborted)).toEqual([true, true, true]);
    expect(players.map((r) => r.durationMs! < 1_000)).toEqual([true, true, true]);
    expect(ofKind(await stack.requests(), 'stream')).toEqual([]);
  });
});

describe('被拦截后换客户端重试', () => {
  // 抓：普通视频被拦一次就整次失败；重试时没换客户端；IOS 给的字幕地址仍用 ANDROID 的 UA 去拉；重试成功后没有照常写完文章
  it.each([
    ['HTTP 403 一次', 'http403', 1, ['ANDROID 21.26.364', 'IOS 21.26.4'], IOS_UA],
    ['LOGIN_REQUIRED 两次', 'login', 2, ['ANDROID 21.26.364', 'IOS 21.26.4', 'ANDROID 20.10.38'], OLD_ANDROID_UA],
  ] as const)('前 %s：换客户端取到实时字幕，照常写完文章', async (_, mode, times, clients, captionsUa) => {
    await stack.scenario({ videos: { mockvideo01: { kind: 'blocked-first', times, mode, then: MOCK_VIDEO } } });
    const gen = await generate(stack, { url: MOCK_URL });
    expect(gen.events.find((e) => e.event === 'error')).toBeUndefined();
    expect(gen.events.at(-1)!.event).toBe('done');
    expect(eventOf(gen.events, 'meta')!.transcript).toMatchObject({ source: 'live', language: 'en', kind: 'asr' });

    const requests = await stack.requests();
    const players = ofKind(requests, 'player');
    expect(players.map((r) => `${player(r).clientName} ${player(r).clientVersion}`)).toEqual(clients);
    expect(players.map((r) => r.userAgent)).toEqual([ANDROID_UA, IOS_UA, OLD_ANDROID_UA].slice(0, clients.length));
    expect(ofKind(requests, 'captions').map((r) => r.userAgent)).toEqual([captionsUa]);
    const stream = ofKind(requests, 'stream');
    expect(stream).toHaveLength(1);
    expect(promptOf(stream[0]!).user).toContain('welcome to the show Alex here');
  });

  // 抓：重试次数没有上限；全部被拦后仍去调用模型；说明里看不出试了几次
  it('前 3 次都是 HTTP 403：试满 3 次后报 youtube_blocked，不请求字幕和模型', async () => {
    await stack.scenario({ videos: { mockvideo01: { kind: 'blocked-first', times: 3, mode: 'http403', then: MOCK_VIDEO } } });
    const gen = await generate(stack, { url: MOCK_URL });
    expect(gen.events.map((e) => e.event)).toEqual(['stage', 'error']);
    expect(eventOf(gen.events, 'error')).toEqual({ code: 'youtube_blocked', message: 'YouTube 拒绝了字幕请求，可能触发了人机验证（共试 3 次：HTTP 403、HTTP 403、HTTP 403）', partial: false });
    expect((await stack.requests()).map((r) => r.kind)).toEqual(['player', 'player', 'player']);
  });
});

describe('示例视频的内置备份', () => {
  // 抓：示例视频实时获取失败时直接报错，或者用了备份却不告诉用户（source、liveError 缺失），或者备份字幕没进模型请求
  it.each([
    ['被 YouTube 拦截', 'blocked', 'YouTube 拒绝了字幕请求，可能触发了人机验证（共试 3 次：人机验证、人机验证、人机验证）'],
    ['播放器接口不响应', 'hang', '获取字幕超时，请稍后重试（共试 3 次：超时、超时、超时）'],
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

    // 先换客户端试满 3 次，再用备份；核对阶段的请求不在这里核对
    const requests = (await stack.requests()).filter((r) => r.kind === 'player' || r.kind === 'captions' || r.kind === 'stream');
    expect(requests.map((r) => [r.kind, r.videoId ?? r.model])).toEqual([
      ['player', 'xRh2sVcNXQ8'],
      ['player', 'xRh2sVcNXQ8'],
      ['player', 'xRh2sVcNXQ8'],
      ['stream', 'mock-primary'],
    ]);
    // 模型收到的是备份字幕全文：开头、结尾都在，meta 里的字数就是这段正文的长度
    const user = promptOf(requests[3]!).user;
    const transcript = /<transcript>\n([\s\S]*)\n<\/transcript>/.exec(user)![1]!;
    expect(transcript.startsWith('[00:00] this new wave of AI companies is is growing revenue like just like actual')).toBe(true);
    expect(transcript.endsWith('Mars, so I will be just fine.')).toBe(true);
    expect(meta.transcript.chars).toBe(transcript.length);
    expect(meta.transcript.chars).toBeGreaterThan(50_000);
  });
});
