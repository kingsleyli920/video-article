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

  it('同一人说话过长时在片段边界分段，超过一小时用 h:mm:ss', () => {
    const long = 'x'.repeat(1_600);
    const text = formatTranscript([
      { start: 0, text: long },
      { start: 3_725_000, text: 'next part' },
    ]);
    expect(text).toBe(`[00:00] ${long}\n\n[1:02:05] next part`);
  });
});
