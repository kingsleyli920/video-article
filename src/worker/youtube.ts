import { AppError } from './app-error';

export interface Cue {
  /** 开始时间，毫秒 */
  start: number;
  text: string;
}

export interface VideoMeta {
  id: string;
  title: string;
  channel: string;
  description: string;
  lengthSeconds: number;
}

export interface Transcript {
  video: VideoMeta;
  language: string;
  kind: 'asr' | 'manual';
  trackName: string;
  trackVssId: string;
  cues: Cue[];
}

export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
  vssId?: string;
  name?: { simpleText?: string; runs?: { text: string }[] };
}

interface PlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  videoDetails?: { title?: string; author?: string; shortDescription?: string; lengthSeconds?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
      audioTracks?: DefaultAudio[];
      defaultAudioTrackIndex?: number;
    };
  };
}

/** 播放器数据里的默认音轨：音轨编号带原声语言（如 "en-US.4"），并指向这条音轨的默认字幕轨 */
export interface DefaultAudio {
  audioTrackId?: string;
  defaultCaptionTrackIndex?: number;
}

const PLAYER_ENDPOINT = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
// 2026-11 实测：网页端（WEB）给出的字幕地址缺 PO token 时返回空内容，ANDROID 客户端给出的地址可以直接拉取。
const ANDROID_CLIENT = {
  clientName: 'ANDROID',
  clientVersion: '20.10.38',
  androidSdkVersion: 30,
  osName: 'Android',
  osVersion: '11',
  hl: 'en',
  gl: 'US',
} as const;
const ANDROID_UA = `com.google.android.youtube/${ANDROID_CLIENT.clientVersion} (Linux; U; Android 11) gzip`;

export interface TranscriptOptions {
  /** 客户端断开等上游取消；触发后立即放弃，不再兜底 */
  signal?: AbortSignal;
  /** 测试时可以调短 */
  timeouts?: Partial<typeof TRANSCRIPT_TIMEOUTS>;
  /** 播放器接口地址，只在测试时指向模拟上游 */
  playerEndpoint?: string;
}

/**
 * 每一步的时间上限都包含读取响应正文。线上实测这两步合计 0.3–1.8 秒，上限留足余量，
 * 同时保证不会一直卡在字幕阶段：超时报 youtube_timeout，示例视频据此转入内置备份。
 */
const TRANSCRIPT_TIMEOUTS = { playerMs: 10_000, captionsMs: 15_000 };

/** 按倍率缩短的字幕超时（倍率只在测试时小于 1） */
export function transcriptTimeouts(scale = 1): typeof TRANSCRIPT_TIMEOUTS {
  return { playerMs: TRANSCRIPT_TIMEOUTS.playerMs * scale, captionsMs: TRANSCRIPT_TIMEOUTS.captionsMs * scale };
}

/** 直连 YouTube：先取播放器数据选字幕轨，再拉 srv1 格式的字幕（体积约为 json3 的十分之一）。 */
export async function fetchTranscript(videoId: string, options: TranscriptOptions = {}): Promise<Transcript> {
  const timeouts = { ...TRANSCRIPT_TIMEOUTS, ...options.timeouts };
  const player = await withDeadline('读取视频信息', timeouts.playerMs, options.signal, (signal) => fetchPlayer(videoId, signal, options.playerEndpoint ?? PLAYER_ENDPOINT));
  const renderer = player.captions?.playerCaptionsTracklistRenderer;
  const track = pickTrack(renderer?.captionTracks ?? [], renderer?.audioTracks?.[renderer.defaultAudioTrackIndex ?? 0] ?? {});
  if (!track) throw new AppError('no_captions');

  const xml = await withDeadline('下载字幕', timeouts.captionsMs, options.signal, async (signal) => {
    const res = await request(captionUrl(track.baseUrl), { headers: { 'user-agent': ANDROID_UA }, signal });
    return res.text();
  });
  const cues = parseSrv1(xml);
  if (cues.length === 0) throw new AppError('no_captions', '字幕内容为空');

  const details = player.videoDetails ?? {};
  return {
    video: {
      id: videoId,
      title: details.title ?? '',
      channel: details.author ?? '',
      description: details.shortDescription ?? '',
      lengthSeconds: Number(details.lengthSeconds ?? 0),
    },
    language: track.languageCode,
    kind: track.kind === 'asr' ? 'asr' : 'manual',
    trackName: track.name?.simpleText ?? track.name?.runs?.map((r) => r.text).join('') ?? track.languageCode,
    trackVssId: track.vssId ?? '',
    cues,
  };
}

async function fetchPlayer(videoId: string, signal: AbortSignal, endpoint: string): Promise<PlayerResponse> {
  const res = await request(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': ANDROID_UA },
    body: JSON.stringify({ context: { client: ANDROID_CLIENT }, videoId }),
    signal,
  });
  const player = (await res.json()) as PlayerResponse;
  const { status, reason } = player.playabilityStatus ?? {};
  if (status === 'OK') return player;
  if (status === 'LOGIN_REQUIRED' && /bot/i.test(reason ?? '')) throw new AppError('youtube_blocked', reason);
  throw new AppError('video_unavailable', reason || status);
}

/**
 * 在时间上限内完成一步（请求 + 读正文）。到点时中止请求并立即报 youtube_timeout；
 * 外部取消时立即以取消原因结束。用 Promise.race 兜底，即使正文读取不响应中止信号也不会卡住。
 */
async function withDeadline<T>(label: string, ms: number, outer: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (outer?.aborted) throw outer.reason;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let rejectCancelled!: (reason: unknown) => void;
  const cancelled = new Promise<never>((_, reject) => (rejectCancelled = reject));
  const onAbort = () => {
    controller.abort(outer!.reason);
    rejectCancelled(outer!.reason);
  };
  outer?.addEventListener('abort', onAbort, { once: true });
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new AppError('youtube_timeout', `${label}超过 ${ms / 1000} 秒`);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), deadline, cancelled]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}

async function request(url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    if (init.signal?.aborted) throw init.signal.reason;
    throw new AppError('youtube_error', '网络请求失败');
  }
  if (res.status === 429) throw new AppError('youtube_blocked', 'HTTP 429');
  if (!res.ok) throw new AppError('youtube_error', `HTTP ${res.status}`);
  return res;
}

/**
 * 选字幕轨：先确定原声语言，再在同语言的轨道里按"人工字幕 → 不带变体参数的自动识别 → 带变体参数的自动识别"选。
 *
 * 原声语言依次看：默认音轨的编号（"en-US.4" → en）、不带变体参数的自动识别轨、默认音轨的默认字幕轨。
 * 地址带 variant 的轨道不能一概排除：自动配音轨带 variant=timing-optimized，但有些视频的原声自动识别轨也带
 * variant=gemini（2026-11-25 预检：3Blue1Brown、Royal Institution），排除后会选到排在前面的阿拉伯语人工字幕，
 * 或者误报没有字幕。判断不出原声时，选第一条不带变体参数的人工字幕或自动识别轨。
 */
export function pickTrack(tracks: CaptionTrack[], audio: DefaultAudio = {}): CaptionTrack | null {
  const variant = (t: CaptionTrack) => /[?&]variant=/.test(t.baseUrl);
  const asr = (t: CaptionTrack) => t.kind === 'asr';
  const fromAudio = audio.audioTrackId ? baseLang(audio.audioTrackId.split('.')[0]!) : '';
  const fromAsr = tracks.find((t) => asr(t) && !variant(t));
  const fromDefault = audio.defaultCaptionTrackIndex === undefined ? undefined : tracks[audio.defaultCaptionTrackIndex];
  const spoken = fromAudio || (fromAsr && baseLang(fromAsr.languageCode)) || (fromDefault && baseLang(fromDefault.languageCode));
  if (spoken) {
    const same = tracks.filter((t) => baseLang(t.languageCode) === spoken);
    const chosen = same.find((t) => !asr(t) && !variant(t)) ?? same.find((t) => asr(t) && !variant(t)) ?? same.find(asr) ?? same[0];
    if (chosen) return chosen;
  }
  return tracks.find((t) => !asr(t) && !variant(t)) ?? tracks.find((t) => !variant(t)) ?? null;
}

function baseLang(code: string): string {
  return code.split('-')[0]!.toLowerCase();
}

function captionUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('fmt', 'srv1');
  return url.toString();
}

const SRV1_CUE = /<text start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;

/** 解析 srv1：<text start="秒" dur="秒">文本</text>。文本是两层转义（&amp;#39;），需要解两次。 */
export function parseSrv1(xml: string): Cue[] {
  const cues: Cue[] = [];
  for (const [, start, body] of xml.matchAll(SRV1_CUE)) {
    const text = decodeEntities(decodeEntities(body!)).replace(/\s+/g, ' ').trim();
    if (text) cues.push({ start: Math.round(Number(start) * 1000), text });
  }
  return cues;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED[entity.toLowerCase()] ?? match;
  });
}

const MAX_PARAGRAPH_CHARS = 1_500;

/** 交给模型的文本里，已确认残缺的数字换成这个占位，不再暴露可能诱导补全的残余数字 */
export const DAMAGED_NUMBER_PLACEHOLDER = '〔字幕此处数字不清，无法确定具体数量〕';

/** 字幕里确认残缺的数字。原始片段、时间和所在字幕原文都保留，作为证据，也供生成后的数字检查使用 */
export interface DamagedNumber {
  /** 所在字幕片段的开始时间，如 "34:25" */
  time: string;
  /** 原始片段，连同前面的词，如 "of,200" */
  fragment: string;
  /** 残缺的三位数，如 "200" */
  digits: string;
  /** 所在字幕片段的原文 */
  cue: string;
}

export interface PreparedTranscript {
  /** 给模型读的正文：残缺数字已换成占位 */
  text: string;
  damagedNumbers: DamagedNumber[];
}

/**
 * 自动字幕偶尔吞掉数字开头，留下"千分位逗号 + 三位数"却没有前导数字（如 "of,200"）。这种写法不可能是完整数字。
 * 前面紧挨着数字或逗号的（如 "1,200"、"12,345,678"）不算。
 */
const DAMAGED_NUMBER = /(?<![\d,]),(\d{3})(?![\d,])/g;

/** 被拆到下一条字幕开头的千分位部分：一组或多组 ",ddd"，可带小数 */
const CONTINUED_NUMBER = /^,\d{3}(?:,\d{3})*(?:\.\d+)?(?![\d,])/;

/**
 * 把字幕片段整理成给模型读的正文：每段以 [时间] 开头；
 * 自动字幕里的 ">>" 表示换人说话，在这里另起一段并保留标记；同一人说得太长时在片段边界分段。
 * 残缺数字换成占位，原始片段记进 damagedNumbers。合法数字被拆在相邻两条字幕里（前一条以数字结尾、
 * 后一条以 ",200"、",345,678" 或 ",200.50" 开头）时拼回去（"1,200"、"12,345,678"、"$1,200.50"），不当成残缺。
 */
export function prepareTranscript(cues: Cue[]): PreparedTranscript {
  const paragraphs: string[] = [];
  const damagedNumbers: DamagedNumber[] = [];
  let current: { start: number; turn: boolean; parts: string[]; length: number } | null = null;
  let previous = '';

  const flush = () => {
    if (current?.parts.length) {
      paragraphs.push(`[${clock(current.start)}] ${current.turn ? '>> ' : ''}${current.parts.join(' ')}`);
    }
  };
  const open = (start: number, turn: boolean) => {
    flush();
    current = { start, turn, parts: [], length: 0 };
  };

  for (const cue of cues) {
    cue.text.split('>>').forEach((rawPiece, i) => {
      const piece = rawPiece.trim();
      // 同一人连续说话、上一条以数字结尾、这一条以完整的千分位开头（",200"、",345,678"、",200.50"）：同一个数被拆开了
      const continues = i === 0 && current !== null && /\d$/.test(previous) && CONTINUED_NUMBER.test(piece);
      if (i > 0) {
        open(cue.start, true);
        // 换人说话：上一位说话人末尾的数字不能和后面的内容拼接，也不能进入残缺片段的证据；">>" 后面暂时没有文字时也要清掉
        previous = '';
      } else if (!continues && (!current || current.length > MAX_PARAGRAPH_CHARS)) open(cue.start, false);

      const text = piece.replace(DAMAGED_NUMBER, (match: string, digits: string, offset: number) => {
        if (offset === 0 && continues) return match;
        const word = offset === 0 ? (/\S*$/.exec(previous)?.[0] ?? '') : (/\S*$/.exec(piece.slice(0, offset))?.[0] ?? '');
        damagedNumbers.push({ time: clock(cue.start), fragment: `${word}${match}`, digits, cue: cue.text.trim() });
        return DAMAGED_NUMBER_PLACEHOLDER;
      });
      if (!text || !current) return;
      if (continues && current.parts.length) {
        current.parts[current.parts.length - 1] += text;
      } else {
        current.parts.push(text);
      }
      current.length += text.length + 1;
      previous = text;
    });
  }
  flush();
  return { text: paragraphs.join('\n\n'), damagedNumbers };
}

/** 只要给模型读的正文时使用 */
export function formatTranscript(cues: Cue[]): string {
  return prepareTranscript(cues).text;
}

function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}
