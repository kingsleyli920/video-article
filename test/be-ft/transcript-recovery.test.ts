/**
 * L1b 字幕被拦截后换客户端重试、再换区域代取：经过完整 Worker（入站请求 → 字幕 → 写文章 → 核对 → 保存），出站请求全部替身。
 * 换区域用的是真实的 TranscriptRelay Durable Object；测试环境里它和 Worker 在同一个进程，出站 fetch 走同一个替身，
 * 所以按播放器请求的次数区分：前 3 次是本地的三种客户端，第 4 次起是各区域（每个区域同样最多 3 次）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTICLE_TEXTS, OTHER_VIDEO_ID, playerResponse, SAMPLE_VIDEO_ID } from '../fixtures/upstream';
import { eventOf, generate, geminiSse, mockUpstream } from './helpers';

afterEach(() => vi.restoreAllMocks());

const url = (id: string) => `https://www.youtube.com/watch?v=${id}`;
const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player';
const BOT = playerResponse({ status: 'LOGIN_REQUIRED', reason: "Sign in to confirm you're not a bot" });
/** 本地 3 次、三个区域各 3 次，一共 12 次播放器请求 */
const ALL_PLAYERS = 12;
const CLIENTS = ['ANDROID 21.26.364', 'IOS 21.26.4', 'ANDROID 20.10.38'];

/**
 * 在 helpers 的上游替身前面加一层：前几次播放器请求依次按 replies 回应（数字是 HTTP 状态），之后交回 helpers 的正常响应。
 * 返回各次播放器请求用的客户端（clientName clientVersion）。
 */
function blockFirstPlayers(upstream: ReturnType<typeof mockUpstream>, replies: (number | object)[]) {
  const normal = upstream.spy.getMockImplementation()!;
  const clients: string[] = [];
  let n = 0;
  upstream.spy.mockImplementation(async (input, init) => {
    const target = input instanceof Request ? input.url : String(input);
    if (target.startsWith(PLAYER_URL)) {
      const client = JSON.parse(String(init?.body)).context.client;
      clients.push(`${client.clientName} ${client.clientVersion}`);
      const reply = replies[n++];
      if (reply !== undefined) return typeof reply === 'number' ? new Response('', { status: reply }) : Response.json(reply);
    }
    return normal(input, init);
  });
  return clients;
}

/** 生成结束时那一行 generation 日志 */
function generationLog(spy: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const line = spy.mock.calls.map(([first]) => String(first)).find((text) => text.includes('"event":"generation"'));
  return JSON.parse(line!);
}

describe('字幕被拦截后换客户端重试（经过完整 Worker）', () => {
  // 抓：普通视频第一次被 403 拦下就整次失败（示例视频以外没有备份，这是线上的核心缺口）；重试后没有照常走完核对和保存
  it('普通视频第一次 403、第二次成功：照常生成完成，字幕来源是实时', async () => {
    const logSpy = vi.spyOn(console, 'log');
    const upstream = mockUpstream({ geminiStream: geminiSse(ARTICLE_TEXTS) });
    const clients = blockFirstPlayers(upstream, [403]);
    const { status, events } = await generate({ url: url(OTHER_VIDEO_ID) });

    expect(status).toBe(200);
    expect(clients).toEqual(['ANDROID 21.26.364', 'IOS 21.26.4']);
    expect(events.find((e) => e.event === 'error')).toBeUndefined();
    expect(events.at(-1)!.event).toBe('done');
    expect(eventOf(events, 'meta')!.transcript).toMatchObject({ source: 'live', language: 'en', kind: 'asr' });
    expect(upstream.gemini('article')).toHaveLength(1);
    expect(upstream.gemini('article')[0]!.body).toContain('live caption text');
    expect(upstream.gemini('review').length).toBeGreaterThan(0);

    // 抓：日志里看不出用了哪个客户端、前面失败的原因
    expect(generationLog(logSpy).transcriptAttempts).toEqual([
      { from: 'local', client: 'ANDROID 21.26.364', ok: false, step: 'player', code: 'youtube_blocked', detail: 'HTTP 403', ms: expect.any(Number) },
      { from: 'local', client: 'IOS 21.26.4', ok: true, ms: expect.any(Number) },
    ]);
    expect(generationLog(logSpy).transcriptVia).toBeNull();
  });

  // 抓：全部被拦后继续调用 Gemini；错误码不是 youtube_blocked；说明里看不出试了几次、换过区域；换区域没有上限
  it('普通视频本地三次和三个区域都被拦：报 youtube_blocked，不调用 Gemini，一共 12 次播放器请求', async () => {
    const logSpy = vi.spyOn(console, 'log');
    const upstream = mockUpstream({ geminiStream: geminiSse(ARTICLE_TEXTS) });
    const clients = blockFirstPlayers(upstream, [403, BOT, 403, ...Array(ALL_PLAYERS - 3).fill(BOT)]);
    const { events } = await generate({ url: url(OTHER_VIDEO_ID) });

    expect(events.map((e) => e.event)).toEqual(['stage', 'error']);
    expect(eventOf(events, 'error')).toEqual({
      code: 'youtube_blocked',
      message: 'YouTube 拒绝了字幕请求，可能触发了人机验证（本地试 3 次，换 3 个区域后仍被拦）',
      partial: false,
    });
    // 播放器请求一共 12 次：本地和三个区域各轮换一遍三种客户端
    expect(clients).toEqual([...CLIENTS, ...CLIENTS, ...CLIENTS, ...CLIENTS]);
    expect(upstream.gemini()).toHaveLength(0);
    const log = generationLog(logSpy);
    expect(log).toMatchObject({ ok: false, code: 'youtube_blocked' });
    const bot = "Sign in to confirm you're not a bot";
    expect((log.transcriptAttempts as { detail: string }[]).map((a) => a.detail)).toEqual(['HTTP 403', bot, 'HTTP 403', ...Array(9).fill(bot)]);
    // 抓：日志里看不出每次是本地还是哪个区域发的
    expect((log.transcriptAttempts as { from: string }[]).map((a) => a.from)).toEqual(['local', 'local', 'local', 'enam', 'enam', 'enam', 'wnam', 'wnam', 'wnam', 'apac', 'apac', 'apac']);
  });

  // 抓：本地被人机验证拦住后不换区域就报错；换区域取到后 meta 里没有 via（页面说不出字幕是哪里取的）；没有照常写完核对保存；
  // 日志里看不出第几次、哪个区域、哪个客户端成功
  it('普通视频本地三次被拦、第一个区域取到：照常生成完成，meta.transcript 带 via', async () => {
    const logSpy = vi.spyOn(console, 'log');
    const upstream = mockUpstream({ geminiStream: geminiSse(ARTICLE_TEXTS) });
    const clients = blockFirstPlayers(upstream, [BOT, BOT, BOT]);
    const { status, events } = await generate({ url: url(OTHER_VIDEO_ID) });

    expect(status).toBe(200);
    expect(events.find((e) => e.event === 'error')).toBeUndefined();
    expect(events.at(-1)!.event).toBe('done');
    expect(clients).toEqual([...CLIENTS, 'ANDROID 21.26.364']);
    expect(eventOf(events, 'meta')!.transcript).toMatchObject({ source: 'live', language: 'en', kind: 'asr', via: 'enam' });
    expect(eventOf(events, 'meta')!.transcript).not.toHaveProperty('liveError');
    expect(upstream.gemini('article')).toHaveLength(1);
    expect(upstream.gemini('article')[0]!.body).toContain('live caption text');
    expect(upstream.gemini('review').length).toBeGreaterThan(0);

    const log = generationLog(logSpy);
    expect(log.transcriptVia).toBe('enam');
    expect((log.transcriptAttempts as object[]).at(-1)).toEqual({ from: 'enam', client: 'ANDROID 21.26.364', ok: true, ms: expect.any(Number) });
    expect(log.transcriptAttempts).toHaveLength(4);
  });

  // 抓：示例视频重试全部失败后没有进入内置备份，或者用了备份却不说明失败原因
  it('示例视频本地和各区域都被拦：改用内置备份写完文章，meta 标明 backup 和失败原因', async () => {
    const upstream = mockUpstream({ geminiStream: geminiSse(ARTICLE_TEXTS) });
    const clients = blockFirstPlayers(upstream, [403, 403, 429, ...Array(ALL_PLAYERS - 3).fill(403)]);
    const { events } = await generate({ url: url(SAMPLE_VIDEO_ID) });

    expect(clients).toHaveLength(12);
    expect(eventOf(events, 'meta')!.transcript).toMatchObject({
      source: 'backup',
      language: 'en',
      kind: 'asr',
      liveError: 'YouTube 拒绝了字幕请求，可能触发了人机验证（本地试 3 次，换 3 个区域后仍被拦）',
    });
    expect(eventOf(events, 'meta')!.transcript).not.toHaveProperty('via');
    expect(upstream.gemini('article')[0]!.body).toContain('this new wave of AI companies');
    expect(events.at(-1)!.event).toBe('done');
  });

  // 抓：示例视频第一次被拦就直接改用备份，没有先换客户端取实时字幕
  it('示例视频第一次被拦、第二次成功：用实时字幕，不用备份', async () => {
    const upstream = mockUpstream({ geminiStream: geminiSse(ARTICLE_TEXTS) });
    blockFirstPlayers(upstream, [BOT]);
    const { events } = await generate({ url: url(SAMPLE_VIDEO_ID) });

    expect(eventOf(events, 'meta')!.transcript).toMatchObject({ source: 'live' });
    expect(eventOf(events, 'meta')!.transcript).not.toHaveProperty('liveError');
    expect(upstream.gemini('article')[0]!.body).toContain('live caption text');
    expect(events.at(-1)!.event).toBe('done');
  });
});
