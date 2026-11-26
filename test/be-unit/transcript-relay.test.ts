/**
 * L1a 本地被人机验证拦住后换区域代取：loadTranscript 配假的 relays，本地的出站请求用 fetch 替身。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientGone } from '../../src/worker/event-stream';
import { loadTranscript, type RelayResult, type TranscriptRelay } from '../../src/worker/transcripts';
import type { Transcript } from '../../src/worker/youtube';
import { OTHER_VIDEO_ID, playerResponse, SAMPLE_VIDEO_ID } from '../fixtures/upstream';

afterEach(() => vi.restoreAllMocks());

const BOT_REASON = "Sign in to confirm you're not a bot";
const FAST = { playerMs: 50, captionsMs: 50 };

/** 本地出口：每次播放器请求都按 reply 回应 */
function localPlayer(reply: () => Response | Promise<Response>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply());
}
const botBlocked = () => Response.json(playerResponse({ status: 'LOGIN_REQUIRED', reason: BOT_REASON }));

/** 区域里取到的字幕（只有一条成功的尝试） */
const RELAYED: Transcript = {
  video: { id: OTHER_VIDEO_ID, title: '区域取到的视频', channel: '测试频道', description: '', lengthSeconds: 600 },
  language: 'en',
  kind: 'asr',
  trackName: 'English (auto-generated)',
  trackVssId: 'a.en',
  cues: [{ start: 0, text: 'relayed caption text' }],
  attempts: [{ client: 'ANDROID 21.26.364', ok: true, ms: 12 }],
};
const OK: RelayResult = { ok: true, transcript: RELAYED };
/** 区域里三种客户端都被人机验证拦住 */
const BLOCKED: RelayResult = {
  ok: false,
  code: 'youtube_blocked',
  detail: '共试 3 次：人机验证、人机验证、人机验证',
  attempts: [
    { client: 'ANDROID 21.26.364', ok: false, step: 'player', code: 'youtube_blocked', detail: BOT_REASON, ms: 5 },
    { client: 'IOS 21.26.4', ok: false, step: 'player', code: 'youtube_blocked', detail: BOT_REASON, ms: 6 },
    { client: 'ANDROID 20.10.38', ok: false, step: 'player', code: 'youtube_blocked', detail: BOT_REASON, ms: 7 },
  ],
};
const UNAVAILABLE: RelayResult = {
  ok: false,
  code: 'video_unavailable',
  detail: 'Video unavailable',
  attempts: [{ client: 'ANDROID 21.26.364', ok: false, step: 'player', code: 'video_unavailable', detail: 'Video unavailable', ms: 4 }],
};

/** 假区域：按 reply 回应（函数形式时原样返回它给的 Promise，不多包一层），记下被调用的次数 */
function relay(region: string, reply: RelayResult | (() => Promise<RelayResult>)) {
  const fetch = vi.fn((_videoId: string) => (typeof reply === 'function' ? reply() : Promise.resolve(reply)));
  return { region, fetch } satisfies TranscriptRelay;
}

/** 本地三次都被人机验证拦住时的三条尝试 */
const LOCAL_BLOCKED = [
  { from: 'local', client: 'ANDROID 21.26.364', ok: false, step: 'player', code: 'youtube_blocked', detail: BOT_REASON, ms: expect.any(Number) },
  { from: 'local', client: 'IOS 21.26.4', ok: false, step: 'player', code: 'youtube_blocked', detail: BOT_REASON, ms: expect.any(Number) },
  { from: 'local', client: 'ANDROID 20.10.38', ok: false, step: 'player', code: 'youtube_blocked', detail: BOT_REASON, ms: expect.any(Number) },
];
const regionBlocked = (from: string) => [
  { from, client: 'ANDROID 21.26.364', ok: false, step: 'player', code: 'youtube_blocked', detail: BOT_REASON, ms: 5 },
  { from, client: 'IOS 21.26.4', ok: false, step: 'player', code: 'youtube_blocked', detail: BOT_REASON, ms: 6 },
  { from, client: 'ANDROID 20.10.38', ok: false, step: 'player', code: 'youtube_blocked', detail: BOT_REASON, ms: 7 },
];

describe('本地被拦后换区域代取', () => {
  // 抓：本地被拦后不换区域就报错；换区域成功后 attempts 里看不出第几次、哪个区域、哪个客户端成功；via 没带出来；取到一个后还接着请后面的区域
  it('本地三次被拦、第一个区域成功：用那个区域的字幕，via 是 enam，attempts 依次是本地三次和区域的一次', async () => {
    const localSpy = localPlayer(botBlocked);
    const enam = relay('enam', OK);
    const wnam = relay('wnam', OK);
    const { transcript, info } = await loadTranscript(OTHER_VIDEO_ID, { relays: [enam, wnam] });

    expect(localSpy).toHaveBeenCalledTimes(3);
    expect(enam.fetch).toHaveBeenCalledOnce();
    expect(enam.fetch).toHaveBeenCalledWith('dQw4w9WgXcQ');
    expect(wnam.fetch).not.toHaveBeenCalled();
    expect(info).toEqual({ source: 'live', language: 'en', kind: 'asr', via: 'enam' });
    expect(transcript.cues).toEqual([{ start: 0, text: 'relayed caption text' }]);
    expect(transcript.video.title).toBe('区域取到的视频');
    expect(transcript.attempts).toEqual([...LOCAL_BLOCKED, { from: 'enam', client: 'ANDROID 21.26.364', ok: true, ms: 12 }]);
  });

  // 抓：第一个区域也被拦就放弃，没有接着试下一个；区域里被拦的那几次没进记录
  it('第一个区域也被拦、第二个成功：via 是 wnam，第三个区域不请求', async () => {
    localPlayer(botBlocked);
    const enam = relay('enam', BLOCKED);
    const wnam = relay('wnam', OK);
    const apac = relay('apac', OK);
    const { transcript, info } = await loadTranscript(OTHER_VIDEO_ID, { relays: [enam, wnam, apac] });

    expect([enam.fetch.mock.calls.length, wnam.fetch.mock.calls.length, apac.fetch.mock.calls.length]).toEqual([1, 1, 0]);
    expect(info).toEqual({ source: 'live', language: 'en', kind: 'asr', via: 'wnam' });
    expect(transcript.attempts).toEqual([...LOCAL_BLOCKED, ...regionBlocked('enam'), { from: 'wnam', client: 'ANDROID 21.26.364', ok: true, ms: 12 }]);
  });

  // 抓：全部被拦后报成别的错误；给用户的说明把十几次尝试全列出来（太长），或看不出换过区域；详细记录丢了某个区域
  it('本地和三个区域都被拦：报 youtube_blocked，说明简短，attempts 有全部 12 次', async () => {
    localPlayer(botBlocked);
    const relays = [relay('enam', BLOCKED), relay('wnam', BLOCKED), relay('apac', BLOCKED)];
    const err = await loadTranscript(OTHER_VIDEO_ID, { relays }).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'youtube_blocked', message: 'YouTube 拒绝了字幕请求，可能触发了人机验证（本地试 3 次，换 3 个区域后仍被拦）' });
    expect((err as { attempts: unknown[] }).attempts).toEqual([...LOCAL_BLOCKED, ...regionBlocked('enam'), ...regionBlocked('wnam'), ...regionBlocked('apac')]);
    expect(relays.map((r) => r.fetch.mock.calls.length)).toEqual([1, 1, 1]);
  });

  // 抓：本地是视频本身的问题（不存在、没字幕）、超时或一般错误时也去换区域，白白多等，错误也被改写
  it.each([
    ['video_unavailable', () => Response.json(playerResponse({ status: 'ERROR', reason: 'Video unavailable' })), '视频不存在或无法播放（Video unavailable）'],
    ['no_captions', () => Response.json(playerResponse({ tracks: [] })), '这个视频没有可用的字幕'],
    ['youtube_error', () => new Response('', { status: 500 }), '获取字幕失败（共试 3 次：HTTP 500、HTTP 500、HTTP 500）'],
    [
      'youtube_timeout',
      (init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))),
      '获取字幕超时，请稍后重试（读取视频信息超过 0.05 秒）',
    ],
  ] as const)('本地最终是 %s：不请求任何区域，原样报这个错误', async (code, reply, message) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => reply(init));
    const relays = [relay('enam', OK), relay('wnam', OK)];
    await expect(loadTranscript(OTHER_VIDEO_ID, { relays, timeouts: FAST })).rejects.toMatchObject({ code, message });
    expect(relays.map((r) => r.fetch.mock.calls.length)).toEqual([0, 0]);
  });

  // 抓：某个区域已经确认视频不存在，还接着请后面的区域；报出来的仍是本地的"被拦"
  it('第一个区域返回 video_unavailable：停下，不再请后面的区域，报视频不存在', async () => {
    localPlayer(botBlocked);
    const enam = relay('enam', UNAVAILABLE);
    const wnam = relay('wnam', OK);
    const err = await loadTranscript(OTHER_VIDEO_ID, { relays: [enam, wnam] }).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'video_unavailable', message: '视频不存在或无法播放（Video unavailable）' });
    expect(wnam.fetch).not.toHaveBeenCalled();
    expect((err as { attempts: unknown[] }).attempts).toEqual([
      ...LOCAL_BLOCKED,
      { from: 'enam', client: 'ANDROID 21.26.364', ok: false, step: 'player', code: 'video_unavailable', detail: 'Video unavailable', ms: 4 },
    ]);
  });

  // 抓：某个区域一直不返回时整次卡住；一个区域超时或 RPC 出错就整次放弃，不再试还能用的区域；超时和出错的区域在记录里没有痕迹
  it.each([
    ['一直不返回', () => new Promise<RelayResult>(() => {}), { code: 'youtube_timeout', detail: 'enam 区域代取超过 0.03 秒' }],
    ['RPC 抛错', () => Promise.reject(new Error('Durable Object reset')), { code: 'youtube_error', detail: '其他区域的节点调用失败' }],
  ] as const)('第一个区域%s：按上限结束，记下这次失败，接着由第二个区域取到', async (_, reply, failure) => {
    localPlayer(botBlocked);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const enam = relay('enam', reply);
    const wnam = relay('wnam', OK);
    const started = Date.now();
    const loaded = await loadTranscript(OTHER_VIDEO_ID, { relays: [enam, wnam], relayTimeoutMs: 30 });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(loaded.info.via).toBe('wnam');
    expect(wnam.fetch).toHaveBeenCalledTimes(1);
    expect(loaded.transcript.attempts.find((a) => a.from === 'enam')).toEqual({ from: 'enam', client: 'relay', ok: false, ...failure, ms: expect.any(Number) });
  });
});

describe('换区域时的取消和备份', () => {
  // 抓：客户端断开后还在等区域的 RPC 返回（RPC 本身取消不了），或者断开后接着请下一个区域
  it('等第一个区域时客户端断开：立即以取消原因结束，不请第二个区域', async () => {
    localPlayer(botBlocked);
    const controller = new AbortController();
    const gone = new ClientGone('disconnected');
    const enam = relay('enam', () => {
      setTimeout(() => controller.abort(gone), 10);
      return new Promise<RelayResult>(() => {});
    });
    const wnam = relay('wnam', OK);
    const started = Date.now();
    await expect(loadTranscript(SAMPLE_VIDEO_ID, { relays: [enam, wnam], signal: controller.signal })).rejects.toBe(gone);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(wnam.fetch).not.toHaveBeenCalled();
  });

  // 抓：第一个区域的"被拦"结果先到、客户端紧接着断开（结果已经拿到，不靠等待中的取消），仍去请下一个区域；示例视频断开后还读备份
  it('第一个区域返回被拦的同时客户端断开：不请第二个区域，也不走备份', async () => {
    localPlayer(botBlocked);
    const controller = new AbortController();
    const gone = new ClientGone('disconnected');
    const enam = relay('enam', () => {
      controller.abort(gone);
      return Promise.resolve(BLOCKED);
    });
    const wnam = relay('wnam', OK);
    await expect(loadTranscript(SAMPLE_VIDEO_ID, { relays: [enam, wnam], signal: controller.signal })).rejects.toBe(gone);
    expect(wnam.fetch).not.toHaveBeenCalled();
  });

  // 抓：示例视频换区域之前就用了备份（没先换区域），或者各区域都被拦后不走备份；备份的说明里没提换过区域
  it('示例视频本地和各区域都被拦：最后改用内置备份，liveError 说明换过区域', async () => {
    localPlayer(botBlocked);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const relays = [relay('enam', BLOCKED), relay('wnam', BLOCKED), relay('apac', BLOCKED)];
    const { transcript, info } = await loadTranscript(SAMPLE_VIDEO_ID, { relays });

    expect(info).toEqual({ source: 'backup', language: 'en', kind: 'asr', liveError: 'YouTube 拒绝了字幕请求，可能触发了人机验证（本地试 3 次，换 3 个区域后仍被拦）' });
    expect(relays.map((r) => r.fetch.mock.calls.length)).toEqual([1, 1, 1]);
    expect(transcript.cues).toHaveLength(2801);
    expect(transcript.attempts.map((a) => a.from)).toEqual(['local', 'local', 'local', 'enam', 'enam', 'enam', 'wnam', 'wnam', 'wnam', 'apac', 'apac', 'apac']);
  });

  // 抓：示例视频某个区域取到了实时字幕，却仍用了备份
  it('示例视频第一个区域成功：用实时字幕，不用备份', async () => {
    localPlayer(botBlocked);
    const { info } = await loadTranscript(SAMPLE_VIDEO_ID, { relays: [relay('enam', OK)] });
    expect(info).toEqual({ source: 'live', language: 'en', kind: 'asr', via: 'enam' });
  });
});
