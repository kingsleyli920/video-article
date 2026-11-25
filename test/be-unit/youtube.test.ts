import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchTranscript, formatTranscript, parseSrv1, pickTrack, prepareTranscript, type CaptionTrack } from '../../src/worker/youtube';
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

  it('LOGIN_REQUIRED 且原因是 bot 验证时报 youtube_blocked', async () => {
    mockYouTube(playerResponse({ status: 'LOGIN_REQUIRED', reason: "Sign in to confirm you're not a bot" }), '');
    await expect(fetchTranscript('xRh2sVcNXQ8')).rejects.toMatchObject({ code: 'youtube_blocked' });
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
    await expect(fetchTranscript('xRh2sVcNXQ8')).rejects.toMatchObject({ code: 'no_captions', message: '这个视频没有可用的字幕（字幕内容为空）' });
  });

  it('YouTube 返回 429 时报 youtube_blocked', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 429 }));
    await expect(fetchTranscript('xRh2sVcNXQ8')).rejects.toMatchObject({ code: 'youtube_blocked' });
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
