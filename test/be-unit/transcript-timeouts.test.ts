import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientGone } from '../../src/worker/event-stream';
import { loadTranscript } from '../../src/worker/transcripts';
import { fetchTranscript } from '../../src/worker/youtube';
import { OTHER_VIDEO_ID, playerResponse, SAMPLE_VIDEO_ID, srv1 } from '../fixtures/upstream';

afterEach(() => vi.restoreAllMocks());

const FAST = { playerMs: 50, captionsMs: 50 };

/** 永不返回的请求：只在中止信号触发时以中止原因失败，和真实 fetch 一样 */
const hang = (init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));

/** 响应头已到，但正文一直不结束，而且无视中止信号（最坏情况） */
const endlessBody = () => new Response(new ReadableStream({ start() {} }));

describe('字幕获取的时间上限', () => {
  // 抓：player 请求一直不返回时停在"正在获取字幕"，既不报错也不触发兜底
  it('player 请求不返回时报 youtube_timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => hang(init));
    await expect(fetchTranscript(OTHER_VIDEO_ID, { timeouts: FAST })).rejects.toMatchObject({
      code: 'youtube_timeout',
      message: '获取字幕超时，请稍后重试（读取视频信息超过 0.05 秒）',
    });
  });

  // 抓：响应头到了但正文读不完时卡住（计时只覆盖到响应头）
  it('字幕正文一直读不完时报 youtube_timeout，即使正文读取不响应中止信号', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).includes('/youtubei/v1/player') ? Response.json(playerResponse()) : endlessBody(),
    );
    await expect(fetchTranscript(OTHER_VIDEO_ID, { timeouts: FAST })).rejects.toMatchObject({
      code: 'youtube_timeout',
      message: '获取字幕超时，请稍后重试（下载字幕超过 0.05 秒）',
    });
  });

  it('player 的 JSON 正文读不完也在上限内结束', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => endlessBody());
    await expect(fetchTranscript(OTHER_VIDEO_ID, { timeouts: FAST })).rejects.toMatchObject({ code: 'youtube_timeout' });
  });

  it('上限内正常返回时不受影响', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).includes('/youtubei/v1/player') ? Response.json(playerResponse()) : new Response(srv1([[0, 'hello']])),
    );
    await expect(fetchTranscript(OTHER_VIDEO_ID, { timeouts: { playerMs: 1_000, captionsMs: 1_000 } })).resolves.toMatchObject({ cues: [{ text: 'hello' }] });
  });
});

describe('loadTranscript 的兜底与取消', () => {
  // 抓：示例视频的实时字幕超时后没有进入内置备份
  it('示例视频超时后改用内置备份，并说明是超时', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => hang(init));
    const { info, transcript } = await loadTranscript(SAMPLE_VIDEO_ID, { timeouts: FAST });
    expect(info).toEqual({ source: 'backup', language: 'en', kind: 'asr', liveError: '获取字幕超时，请稍后重试（读取视频信息超过 0.05 秒）' });
    expect(transcript.cues).toHaveLength(2801);
  });

  it('其他视频超时后给出可重试的 youtube_timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => hang(init));
    await expect(loadTranscript(OTHER_VIDEO_ID, { timeouts: FAST })).rejects.toMatchObject({ code: 'youtube_timeout' });
  });

  // 抓：客户端已断开仍去读备份、继续往下生成，白白消耗模型额度
  it('客户端断开导致的取消直接抛出，不走备份', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => hang(init));
    const controller = new AbortController();
    const pending = loadTranscript(SAMPLE_VIDEO_ID, { signal: controller.signal, timeouts: { playerMs: 5_000, captionsMs: 5_000 } });
    const gone = new ClientGone('disconnected');
    controller.abort(gone);
    await expect(pending).rejects.toBe(gone);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
