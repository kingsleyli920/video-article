import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchTranscript, formatTranscript, parseSrv1, pickTrack, prepareTranscript, TranscriptError, type CaptionTrack } from '../../src/worker/youtube';
import { playerResponse, srv1 } from '../fixtures/upstream';

afterEach(() => vi.restoreAllMocks());

function mockYouTube(player: object, captions: string) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith('https://www.youtube.com/youtubei/v1/player')) return Response.json(player);
    if (url.startsWith('https://www.youtube.com/api/timedtext')) return new Response(captions);
    throw new Error(`意外请求 ${url}`);
  });
}

describe('fetchTranscript', () => {
  // 抓：没有改写 fmt 参数（拿到 srv3 而不是 srv1）、选错字幕轨、元数据丢失
  it('用 ANDROID 客户端取播放器数据，选原声英文轨并以 srv1 格式拉取', async () => {
    const fetchSpy = mockYouTube(playerResponse(), srv1([[0.16, 'hello &amp;#39;world&amp;#39;'], [1.9, 'second line']]));
    const transcript = await fetchTranscript('xRh2sVcNXQ8');

    const playerBody = JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body));
    expect(playerBody).toMatchObject({ videoId: 'xRh2sVcNXQ8', context: { client: { clientName: 'ANDROID' } } });
    const captionUrl = new URL(String(fetchSpy.mock.calls[1]![0]));
    expect(captionUrl.searchParams.get('fmt')).toBe('srv1');
    expect(captionUrl.searchParams.get('lang')).toBe('en');

    expect(transcript).toMatchObject({
      video: { id: 'xRh2sVcNXQ8', title: '测试视频', channel: '测试频道', lengthSeconds: 600 },
      language: 'en',
      kind: 'asr',
      trackName: 'English (auto-generated)',
      trackVssId: 'a.en',
    });
    // 抓：第一次就成功时多发请求，或者成功时没有记下用的是哪个客户端
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(transcript.attempts).toEqual([{ client: 'ANDROID 21.26.364', ok: true, ms: expect.any(Number) }]);
    expect(transcript.cues).toEqual([
      { start: 160, text: "hello 'world'" },
      { start: 1900, text: 'second line' },
    ]);
  });

  // 抓：YouTube 人机验证被当成"视频不存在"，用户看不出是被拦截
  // 补充验收预检 V08 抓：播放器数据里的默认音轨信息没有传给选轨，原声英语视频仍取到阿拉伯语字幕
  it('按播放器数据里的默认音轨选原声语言的字幕轨', async () => {
    const tracks = [
      { baseUrl: 'https://www.youtube.com/api/timedtext?v=x&lang=ar&fmt=srv3', languageCode: 'ar', vssId: '.ar' },
      { baseUrl: 'https://www.youtube.com/api/timedtext?v=x&lang=en&fmt=srv3', languageCode: 'en', vssId: '.en', name: { runs: [{ text: 'English' }] } },
      { baseUrl: 'https://www.youtube.com/api/timedtext?v=x&lang=en&kind=asr&variant=gemini&fmt=srv3', languageCode: 'en', kind: 'asr', vssId: 'a.en' },
    ];
    const player = playerResponse({ tracks }) as ReturnType<typeof playerResponse> & { captions: { playerCaptionsTracklistRenderer: Record<string, unknown> } };
    Object.assign(player.captions.playerCaptionsTracklistRenderer, {
      audioTracks: [{ audioTrackId: 'hi.3', defaultCaptionTrackIndex: 0 }, { audioTrackId: 'en-US.4', defaultCaptionTrackIndex: 1 }],
      defaultAudioTrackIndex: 1,
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json(player))
      .mockResolvedValueOnce(new Response(srv1([[0, 'hello']])));
    const transcript = await fetchTranscript('aircAruvnKk');
    expect([transcript.language, transcript.kind, transcript.trackVssId]).toEqual(['en', 'manual', '.en']);
    expect(String(fetchSpy.mock.calls[1]![0])).toBe('https://www.youtube.com/api/timedtext?v=x&lang=en&fmt=srv1');
  });

  // 抓：三种客户端都被人机验证拦下时被当成"视频不存在"，或者说明里看不出试了几次
  it('LOGIN_REQUIRED 且原因是 bot 验证时报 youtube_blocked', async () => {
    mockYouTube(playerResponse({ status: 'LOGIN_REQUIRED', reason: "Sign in to confirm you're not a bot" }), '');
    await expect(fetchTranscript('xRh2sVcNXQ8')).rejects.toMatchObject({
      code: 'youtube_blocked',
      message: 'YouTube 拒绝了字幕请求，可能触发了人机验证（共试 3 次：人机验证、人机验证、人机验证）',
    });
  });

  it('视频不可播放时报 video_unavailable 并带上 YouTube 给的原因', async () => {
    mockYouTube(playerResponse({ status: 'ERROR', reason: 'This video is unavailable' }), '');
    await expect(fetchTranscript('xRh2sVcNXQ8')).rejects.toMatchObject({ code: 'video_unavailable', message: '视频不存在或无法播放（This video is unavailable）' });
  });

  // 抓：字幕地址返回空内容（PO token 失效时的真实表现）却继续往下生成空文章
  it('没有字幕轨或字幕内容为空时报 no_captions', async () => {
    mockYouTube(playerResponse({ tracks: [] }), '');
    await expect(fetchTranscript('xRh2sVcNXQ8')).rejects.toMatchObject({ code: 'no_captions' });
    vi.restoreAllMocks();
    mockYouTube(playerResponse(), '');
    await expect(fetchTranscript('xRh2sVcNXQ8')).rejects.toMatchObject({ code: 'no_captions', message: '这个视频没有可用的字幕（共试 3 次：字幕为空、字幕为空、字幕为空）' });
  });

  // 抓：429 被当成一般上游错误，或者重试时复用了已经读过的同一个 Response
  it('YouTube 一直返回 429 时报 youtube_blocked', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 429 }));
    await expect(fetchTranscript('xRh2sVcNXQ8')).rejects.toMatchObject({ code: 'youtube_blocked', message: 'YouTube 拒绝了字幕请求，可能触发了人机验证（共试 3 次：HTTP 429、HTTP 429、HTTP 429）' });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player';
const ANDROID_UA = 'com.google.android.youtube/21.26.364 (Linux; U; Android 11) gzip';
const IOS_UA = 'com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)';
const OLD_ANDROID_UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip';
const BOT = playerResponse({ status: 'LOGIN_REQUIRED', reason: "Sign in to confirm you're not a bot" });

type Reply = object | number | 'network' | 'hang';

/** 第 N 次播放器请求按 players[N] 回应，第 N 次字幕请求按 captions[N]（用完后重复最后一个）。数字是 HTTP 状态 */
function mockAttempts(players: Reply[], captions: (string | number)[] = [srv1([[0, 'hello']])]) {
  let p = 0;
  let c = 0;
  const reply = (r: Reply | string, init?: RequestInit): Promise<Response> => {
    if (r === 'network') return Promise.reject(new TypeError('fetch failed'));
    if (r === 'hang') return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    if (typeof r === 'number') return Promise.resolve(new Response('', { status: r }));
    return Promise.resolve(typeof r === 'string' ? new Response(r) : Response.json(r));
  };
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith(PLAYER_URL)) {
      const r = players[p++];
      if (r === undefined) throw new Error(`多发了第 ${p} 次播放器请求`);
      return reply(r, init);
    }
    if (url.startsWith('https://www.youtube.com/api/timedtext')) return reply(captions[Math.min(c++, captions.length - 1)]!, init);
    throw new Error(`意外请求 ${url}`);
  });
}

type FetchSpy = ReturnType<typeof mockAttempts>;
const playerCalls = (spy: FetchSpy) => spy.mock.calls.filter(([u]) => String(u).startsWith(PLAYER_URL));
const captionCalls = (spy: FetchSpy) => spy.mock.calls.filter(([u]) => !String(u).startsWith(PLAYER_URL));
const headersOf = (call: FetchSpy['mock']['calls'][number]) => call[1]!.headers as Record<string, string>;
/** 一次播放器请求用的客户端：[clientName, clientVersion, UA, X-YouTube-Client-Name] */
const clientOf = (call: FetchSpy['mock']['calls'][number]) => {
  const client = JSON.parse(String(call[1]!.body)).context.client;
  return [client.clientName, client.clientVersion, headersOf(call)['user-agent'], headersOf(call)['x-youtube-client-name']];
};

describe('fetchTranscript 被拦截时换客户端重试', () => {
  // 抓：被 403 拦一次就失败（线上普通视频的核心缺口）；重试时还用同一个客户端；403 被归成笼统的 youtube_error
  it('第一次播放器 403、第二次换 IOS 客户端成功', async () => {
    const spy = mockAttempts([403, playerResponse()]);
    const transcript = await fetchTranscript('dQw4w9WgXcQ');
    expect(playerCalls(spy).map(clientOf)).toEqual([
      ['ANDROID', '21.26.364', ANDROID_UA, '3'],
      ['IOS', '21.26.4', IOS_UA, '5'],
    ]);
    expect(headersOf(playerCalls(spy)[1]!)['x-youtube-client-version']).toBe('21.26.4');
    expect(JSON.parse(String(playerCalls(spy)[1]![1]!.body)).context.client).toEqual({
      clientName: 'IOS',
      clientVersion: '21.26.4',
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '18.3.2.22D82',
      hl: 'en',
      gl: 'US',
    });
    // 抓：IOS 客户端给的字幕地址仍用 ANDROID 的 UA 去拉
    expect(captionCalls(spy).map((call) => headersOf(call)['user-agent'])).toEqual([IOS_UA]);
    expect(transcript.cues).toEqual([{ start: 0, text: 'hello' }]);
    expect(transcript.attempts).toEqual([
      { client: 'ANDROID 21.26.364', ok: false, step: 'player', code: 'youtube_blocked', detail: 'HTTP 403', ms: expect.any(Number) },
      { client: 'IOS 21.26.4', ok: true, ms: expect.any(Number) },
    ]);
  });

  // 抓：200 + LOGIN_REQUIRED（bot）不触发重试
  it('第一次 LOGIN_REQUIRED（bot）、第二次成功', async () => {
    const spy = mockAttempts([BOT, playerResponse()]);
    const transcript = await fetchTranscript('dQw4w9WgXcQ');
    expect(playerCalls(spy)).toHaveLength(2);
    expect(transcript.attempts.map((a) => [a.client, a.ok, a.code, a.detail])).toEqual([
      ['ANDROID 21.26.364', false, 'youtube_blocked', "Sign in to confirm you're not a bot"],
      ['IOS 21.26.4', true, undefined, undefined],
    ]);
  });

  // 抓：一直重试不停；试满 3 次后报错码不对；说明里看不出试了几次、各是什么结果；日志里没有每次的记录
  it('三种客户端都被拦：报 youtube_blocked，只请求 3 次，说明列出每次的结果', async () => {
    const spy = mockAttempts([403, BOT, 429]);
    const err = await fetchTranscript('dQw4w9WgXcQ').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranscriptError);
    expect(err).toMatchObject({ code: 'youtube_blocked', message: 'YouTube 拒绝了字幕请求，可能触发了人机验证（共试 3 次：HTTP 403、人机验证、HTTP 429）' });
    expect(spy).toHaveBeenCalledTimes(3);
    expect(playerCalls(spy).map(clientOf)).toEqual([
      ['ANDROID', '21.26.364', ANDROID_UA, '3'],
      ['IOS', '21.26.4', IOS_UA, '5'],
      ['ANDROID', '20.10.38', OLD_ANDROID_UA, '3'],
    ]);
    expect((err as TranscriptError).attempts.map((a) => [a.client, a.step, a.code, a.detail])).toEqual([
      ['ANDROID 21.26.364', 'player', 'youtube_blocked', 'HTTP 403'],
      ['IOS 21.26.4', 'player', 'youtube_blocked', "Sign in to confirm you're not a bot"],
      ['ANDROID 20.10.38', 'player', 'youtube_blocked', 'HTTP 429'],
    ]);
  });

  // 抓：视频本身的问题也去换客户端重试，白白多等、多发请求
  it('video_unavailable 不重试，只请求 1 次，说明和以前一样', async () => {
    const spy = mockAttempts([playerResponse({ status: 'ERROR', reason: 'This video is unavailable' })]);
    await expect(fetchTranscript('dQw4w9WgXcQ')).rejects.toMatchObject({ code: 'video_unavailable', message: '视频不存在或无法播放（This video is unavailable）' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // 抓：播放器正常返回但没有字幕轨（视频确实没有字幕）也去重试
  it('没有字幕轨（no_captions）不重试，只请求 1 次', async () => {
    const spy = mockAttempts([playerResponse({ tracks: [] })]);
    await expect(fetchTranscript('dQw4w9WgXcQ')).rejects.toMatchObject({ code: 'no_captions', message: '这个视频没有可用的字幕' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // 抓：只在播放器这一步重试，字幕下载被拦时直接失败
  it('字幕下载 403 后换客户端，重新取播放器数据并成功', async () => {
    const spy = mockAttempts([playerResponse(), playerResponse()], [403, srv1([[0, 'hello']])]);
    const transcript = await fetchTranscript('dQw4w9WgXcQ');
    expect(playerCalls(spy)).toHaveLength(2);
    expect(captionCalls(spy).map((call) => headersOf(call)['user-agent'])).toEqual([ANDROID_UA, IOS_UA]);
    expect(transcript.attempts.map((a) => [a.client, a.ok, a.step, a.code, a.detail])).toEqual([
      ['ANDROID 21.26.364', false, 'captions', 'youtube_blocked', 'HTTP 403'],
      ['IOS 21.26.4', true, undefined, undefined, undefined],
    ]);
  });

  // 抓：有字幕轨但内容为空（缺 PO token，因客户端而异）时直接报没有字幕
  it('字幕内容为空时换客户端成功', async () => {
    const spy = mockAttempts([playerResponse(), playerResponse()], ['', srv1([[0, 'hello']])]);
    await expect(fetchTranscript('dQw4w9WgXcQ')).resolves.toMatchObject({ cues: [{ start: 0, text: 'hello' }] });
    expect(playerCalls(spy)).toHaveLength(2);
  });

  // 抓：网络错误、其他 HTTP 错误不换客户端
  it('网络错误、HTTP 500 之后换客户端，第三次成功', async () => {
    const spy = mockAttempts(['network', 500, playerResponse()]);
    const transcript = await fetchTranscript('dQw4w9WgXcQ');
    expect(playerCalls(spy)).toHaveLength(3);
    expect(transcript.attempts.map((a) => [a.client, a.ok, a.code, a.detail])).toEqual([
      ['ANDROID 21.26.364', false, 'youtube_error', '网络请求失败'],
      ['IOS 21.26.4', false, 'youtube_error', 'HTTP 500'],
      ['ANDROID 20.10.38', true, undefined, undefined],
    ]);
  });

  // 抓：前几次尝试仍用完整上限，慢速 403 让用户白等；缩短上限下的超时不换客户端
  it('非最后一次尝试用缩短的上限，超时后换下一个客户端', async () => {
    const spy = mockAttempts(['hang', playerResponse()]);
    const started = Date.now();
    const transcript = await fetchTranscript('dQw4w9WgXcQ', { timeouts: { playerMs: 5_000, captionsMs: 5_000, quickPlayerMs: 50, quickCaptionsMs: 50 } });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(playerCalls(spy)).toHaveLength(2);
    expect(transcript.attempts[0]).toEqual({ client: 'ANDROID 21.26.364', ok: false, step: 'player', code: 'youtube_timeout', detail: '读取视频信息超过 0.05 秒', ms: expect.any(Number) });
  });

  // 抓：三次都超时时总耗时超出说好的上限，或最后一次没有用完整上限
  it('三次都超时：前两次用缩短上限、最后一次用完整上限，报 youtube_timeout', async () => {
    const spy = mockAttempts(['hang', 'hang', 'hang']);
    const started = Date.now();
    await expect(fetchTranscript('dQw4w9WgXcQ', { timeouts: { playerMs: 200, captionsMs: 200, quickPlayerMs: 50, quickCaptionsMs: 50 } })).rejects.toMatchObject({
      code: 'youtube_timeout',
      message: '获取字幕超时，请稍后重试（共试 3 次：超时、超时、超时）',
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(290);
    expect(elapsed).toBeLessThan(1_000);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  // 抓：已经给了完整上限仍超时还继续重试，用户要多等两轮
  it('上限没有缩短时超时不重试', async () => {
    const spy = mockAttempts(['hang']);
    await expect(fetchTranscript('dQw4w9WgXcQ', { timeouts: { playerMs: 50, captionsMs: 50 } })).rejects.toMatchObject({
      code: 'youtube_timeout',
      message: '获取字幕超时，请稍后重试（读取视频信息超过 0.05 秒）',
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // 抓：客户端已经断开还去请求 YouTube
  it('signal 已中止时不发任何请求，直接以中止原因结束', async () => {
    const spy = mockAttempts([playerResponse()]);
    const controller = new AbortController();
    const reason = new Error('客户端已断开');
    controller.abort(reason);
    await expect(fetchTranscript('dQw4w9WgXcQ', { signal: controller.signal })).rejects.toBe(reason);
    expect(spy).not.toHaveBeenCalled();
  });

  // 抓：客户端断开后仍换下一个客户端继续请求
  it('第一次被拦期间客户端断开：不再发下一次请求，以中止原因结束', async () => {
    const controller = new AbortController();
    const reason = new Error('客户端已断开');
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      controller.abort(reason);
      return new Response('', { status: 403 });
    });
    await expect(fetchTranscript('dQw4w9WgXcQ', { signal: controller.signal })).rejects.toBe(reason);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('pickTrack', () => {
  const track = (languageCode: string, kind?: string, variant = false): CaptionTrack => ({
    baseUrl: `https://www.youtube.com/api/timedtext?lang=${languageCode}${kind ? `&kind=${kind}` : ''}${variant ? '&variant=gemini' : ''}`,
    languageCode,
    kind,
  });

  // 抓：选中了自动配音的变体轨，文章内容变成机器翻译后的字幕
  it('排除 variant 变体轨，优先选与原声同语言的人工字幕', () => {
    const chosen = pickTrack([track('fr-FR', 'asr', true), track('de'), track('en', 'asr'), track('en-US')]);
    expect(chosen?.languageCode).toBe('en-US');
  });

  it('没有同语言人工字幕时选原声自动字幕', () => {
    expect(pickTrack([track('de'), track('en', 'asr')])?.languageCode).toBe('en');
  });

  it('只有人工字幕时选第一条', () => {
    expect(pickTrack([track('zh-Hans'), track('en')])?.languageCode).toBe('zh-Hans');
  });

  it('全是变体轨时返回 null', () => {
    expect(pickTrack([track('fr', 'asr', true)])).toBeNull();
  });

  // 以下几种轨道结构取自 2026-11-25 补充验收预检时 YouTube 实际返回的播放器数据（只保留语言、类型和变体参数）
  const real = (languageCode: string, kind?: 'asr', variant?: string): CaptionTrack => ({
    baseUrl: `https://www.youtube.com/api/timedtext?lang=${languageCode}${kind ? `&kind=${kind}` : ''}${variant ? `&variant=${variant}` : ''}`,
    languageCode,
    kind,
  });

  // 补充验收预检 V08、V09 抓：原声英语的自动识别轨带 variant=gemini 被排除后，按排序选中了阿拉伯语人工字幕
  it('3Blue1Brown 型：原声自动识别轨带变体参数时，按默认音轨（en-US）选英语人工字幕', () => {
    const tracks = [real('ar'), real('bn'), real('zh'), real('en'), real('en', 'asr', 'gemini')];
    expect(pickTrack(tracks, { audioTrackId: 'en-US.4', defaultCaptionTrackIndex: 3 })).toBe(tracks[3]);
  });

  // 补充验收预检 V14 抓：唯一的字幕轨是原声英语自动识别轨、带 variant=gemini，被误判为没有字幕
  it('Royal Institution 型：只有带变体参数的原声自动识别轨时选它，不报无字幕', () => {
    const tracks = [real('en', 'asr', 'gemini')];
    expect(pickTrack(tracks, { audioTrackId: 'en-US.4' })).toBe(tracks[0]);
  });

  // 补充验收预检 V17 抓：没有自动识别轨时直接选第一条人工字幕（阿拉伯语）
  it('freeCodeCamp 型：没有自动识别轨时按默认音轨（en）选英语人工字幕', () => {
    const tracks = [real('ar'), real('bg'), real('zh-CN'), real('en'), real('iw')];
    expect(pickTrack(tracks, { audioTrackId: 'en.4', defaultCaptionTrackIndex: 3 })).toBe(tracks[3]);
  });

  // 抓：没有音轨编号、也没有自动识别轨时无从判断原声
  it('BBC 型：只有默认字幕轨信息时按它的语言选（en-GB）', () => {
    const tracks = [real('de'), real('en-GB')];
    expect(pickTrack(tracks, { defaultCaptionTrackIndex: 1 })).toBe(tracks[1]);
  });

  // 抓：其他语言的配音轨（variant=timing-optimized）被当成原声；示例视频选中的轨道必须和以前一样（英语自动识别轨）
  it('示例视频型：配音轨带 timing-optimized 时仍选原声英语自动识别轨', () => {
    const tracks = [real('ar', 'asr', 'timing-optimized'), real('bn', 'asr', 'timing-optimized'), real('en', 'asr'), real('fr-FR', 'asr', 'timing-optimized')];
    expect(pickTrack(tracks, { audioTrackId: 'en-US.4' })).toBe(tracks[2]);
  });
});

describe('parseSrv1 / formatTranscript', () => {
  it('解析数字实体和十六进制实体', () => {
    expect(parseSrv1(srv1([[0, 'a &amp;#x4E2D; b &amp;amp; c']]))).toEqual([{ start: 0, text: 'a 中 b & c' }]);
  });

  // 抓：">>" 换人标记被吞掉或没有另起一段，模型无从判断说话人切换
  it('">>" 处另起一段并保留标记，段首带时间', () => {
    const text = formatTranscript([
      { start: 0, text: 'host intro question' },
      { start: 5_000, text: 'still host >> guest answer' },
      { start: 3_725_000, text: 'more answer' },
    ]);
    expect(text).toBe('[00:00] host intro question still host\n\n[00:05] >> guest answer more answer');
  });

  // 抓：给模型的文本里还留着残余数字 ",200"，模型照着补成 1,200；或者遮蔽之后原始片段丢了，没法追溯和检查
  it('残缺数字在给模型的文本里换成占位，原始片段、时间和所在字幕原文保留为证据', () => {
    const prepared = prepareTranscript([
      { start: 0, text: 'welcome' },
      { start: 2_065_000, text: "we're tracking on the order of,200 bills" },
    ]);
    expect(prepared.text).toBe("[00:00] welcome we're tracking on the order of〔字幕此处数字不清，无法确定具体数量〕 bills");
    expect(prepared.text).not.toContain('200');
    expect(prepared.damagedNumbers).toEqual([
      { time: '34:25', fragment: 'of,200', digits: '200', cue: "we're tracking on the order of,200 bills" },
    ]);
  });

  // 抓：把合法数字误判为残缺而遮蔽掉
  it('完整合法的数字原样保留，不记为残缺', () => {
    const prepared = prepareTranscript([{ start: 0, text: '1,200 bills, $200 or $300, 12,345,678, a, 200 b, 2026' }]);
    expect(prepared).toEqual({ text: '[00:00] 1,200 bills, $200 or $300, 12,345,678, a, 200 b, 2026', damagedNumbers: [] });
  });

  // 抓：一个合法数字被拆在相邻两条字幕里（"about 1" / ",200 bills"），被误判成残缺
  it('合法数字跨两条字幕拆开时拼回原数，不记为残缺', () => {
    const prepared = prepareTranscript([
      { start: 0, text: 'about 1' },
      { start: 2_000, text: ',200 bills were filed' },
    ]);
    expect(prepared).toEqual({ text: '[00:00] about 1,200 bills were filed', damagedNumbers: [] });
  });

  // 抓：残缺片段正好在一条字幕开头时，前一条结尾是单词而不是数字，却被当成跨条拆开的合法数字放过
  it('字幕开头的 ",200" 前一条以单词结尾时仍判为残缺，证据里带上前一条的末尾单词', () => {
    const prepared = prepareTranscript([
      { start: 0, text: 'on the order of' },
      { start: 2_000, text: ',200 bills' },
    ]);
    expect(prepared.text).toBe('[00:00] on the order of 〔字幕此处数字不清，无法确定具体数量〕 bills');
    expect(prepared.damagedNumbers).toEqual([{ time: '00:02', fragment: 'of,200', digits: '200', cue: ',200 bills' }]);
  });

  // 抓：换人说话（>>）后的 ",200" 被当成上一位说话人数字的延续，或者证据里拼进了上一位说话人的数字
  it('换人说话之后的 ",200" 不和上一位说话人的数字拼接，证据里也不带上一位说话人的数字', () => {
    const prepared = prepareTranscript([{ start: 0, text: 'it was 1 >> ,200 more' }]);
    expect(prepared.damagedNumbers).toEqual([{ time: '00:00', fragment: ',200', digits: '200', cue: 'it was 1 >> ,200 more' }]);
    expect(prepared.text).toBe('[00:00] it was 1\n\n[00:00] >> 〔字幕此处数字不清，无法确定具体数量〕 more');
  });

  // 抓：">>" 落在一条字幕末尾、后面暂时没有文字时，没有清掉前文，下一条开头的 ",200" 被误判为合法数字的延续
  it('">>" 在字幕末尾、下一条以 ",200" 开头：仍判为残缺并遮蔽，不拼接上一位说话人的数字', () => {
    const prepared = prepareTranscript([
      { start: 0, text: 'it was 1 >>' },
      { start: 1_000, text: ',200 more' },
    ]);
    expect(prepared.text).toBe('[00:00] it was 1\n\n[00:00] >> 〔字幕此处数字不清，无法确定具体数量〕 more');
    expect(prepared.damagedNumbers).toEqual([{ time: '00:01', fragment: ',200', digits: '200', cue: ',200 more' }]);
  });

  // 补充验收 C02（第 1 组）抓：合法的多组千分位数被拆在两条字幕里（"12" / ",345,678"），没有拼回，或被误当成残缺
  it('多组千分位跨两条字幕拆开时拼回原数，不记为残缺', () => {
    const prepared = prepareTranscript([
      { start: 0, text: '12' },
      { start: 8_000, text: ',345,678 dollars' },
    ]);
    expect(prepared).toEqual({ text: '[00:00] 12,345,678 dollars', damagedNumbers: [] });
  });

  // 补充验收 C02（第 2 组）抓：带小数的金额被拆开（"$1" / ",200.50"），小数点后被截断或被误当成残缺
  it('带小数的金额跨两条字幕拆开时拼回原数，不记为残缺', () => {
    const prepared = prepareTranscript([
      { start: 0, text: '$1' },
      { start: 8_000, text: ',200.50' },
    ]);
    expect(prepared).toEqual({ text: '[00:00] $1,200.50', damagedNumbers: [] });
  });

  // 补充验收 C02（第 3 组）抓：同一条字幕里的残缺数字没有按遮蔽策略处理，或丢了证据
  it('同一条字幕里的 "of,200" 遮蔽并保留证据', () => {
    const prepared = prepareTranscript([{ start: 0, text: 'There are of,200 bills.' }]);
    expect(prepared).toEqual({
      text: '[00:00] There are of〔字幕此处数字不清，无法确定具体数量〕 bills.',
      damagedNumbers: [{ time: '00:00', fragment: 'of,200', digits: '200', cue: 'There are of,200 bills.' }],
    });
  });

  // 补充验收 C03 抓：文字相同的两句（另一位说话人的重复确认）被去重；不同事件的数字和顺序丢失；&amp; 没有还原
  it('相同文字的重复确认按说话人分别保留，事件顺序、数字和转义字符都正确', () => {
    const xml = srv1([
      [0, '第一次试验耗时2天。'],
      [8, '我们确认了结果。'],
      [16, '&amp;gt;&amp;gt; 我们确认了结果。'],
      [24, '第二次试验耗时3天。'],
      [32, '条目包含 A &amp;amp; B，保留它们的区别。'],
    ]);
    expect(prepareTranscript(parseSrv1(xml))).toEqual({
      text: '[00:00] 第一次试验耗时2天。 我们确认了结果。\n\n[00:16] >> 我们确认了结果。 第二次试验耗时3天。 条目包含 A & B，保留它们的区别。',
      damagedNumbers: [],
    });
  });

  it('同一人说话过长时在片段边界分段，超过一小时用 h:mm:ss', () => {
    const long = 'x'.repeat(1_600);
    const text = formatTranscript([
      { start: 0, text: long },
      { start: 3_725_000, text: 'next part' },
    ]);
    expect(text).toBe(`[00:00] ${long}\n\n[1:02:05] next part`);
  });
});
