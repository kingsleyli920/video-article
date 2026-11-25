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
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
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
}

/**
 * 每一步的时间上限都包含读取响应正文。线上实测这两步合计 0.3–1.8 秒，上限留足余量，
 * 同时保证不会一直卡在字幕阶段：超时报 youtube_timeout，示例视频据此转入内置备份。
 */
const TRANSCRIPT_TIMEOUTS = { playerMs: 10_000, captionsMs: 15_000 };

/** 直连 YouTube：先取播放器数据选字幕轨，再拉 srv1 格式的字幕（体积约为 json3 的十分之一）。 */
export async function fetchTranscript(videoId: string, options: TranscriptOptions = {}): Promise<Transcript> {
  const timeouts = { ...TRANSCRIPT_TIMEOUTS, ...options.timeouts };
  const player = await withDeadline('读取视频信息', timeouts.playerMs, options.signal, (signal) => fetchPlayer(videoId, signal));
  const track = pickTrack(player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []);
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

async function fetchPlayer(videoId: string, signal: AbortSignal): Promise<PlayerResponse> {
  const res = await request(PLAYER_ENDPOINT, {
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
 * 选字幕轨：排除自动配音的变体轨（地址带 variant），
 * 优先选与原声（自动识别轨）同语言的人工字幕，其次是自动识别轨，最后是任意人工字幕。
 */
export function pickTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  const usable = tracks.filter((t) => !/[?&]variant=/.test(t.baseUrl));
  const asr = usable.find((t) => t.kind === 'asr');
  const manual = usable.filter((t) => t.kind !== 'asr');
  const spoken = asr && baseLang(asr.languageCode);
  return manual.find((t) => baseLang(t.languageCode) === spoken) ?? asr ?? manual[0] ?? null;
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

/**
 * 把字幕片段整理成给模型读的正文：每段以 [时间] 开头；
 * 自动字幕里的 ">>" 表示换人说话，在这里另起一段并保留标记；同一人说得太长时在片段边界分段。
 */
export function formatTranscript(cues: Cue[]): string {
  const paragraphs: string[] = [];
  let current: { start: number; turn: boolean; parts: string[]; length: number } | null = null;

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
    cue.text.split('>>').forEach((piece, i) => {
      if (i > 0) open(cue.start, true);
      else if (!current || current.length > MAX_PARAGRAPH_CHARS) open(cue.start, false);
      const text = markDamagedNumbers(piece.trim());
      if (text && current) {
        current.parts.push(text);
        current.length += text.length + 1;
      }
    });
  }
  flush();
  return paragraphs.join('\n\n');
}

export const DAMAGED_NUMBER_MARK = '〔字幕数字残缺〕';

/**
 * 自动字幕偶尔吞掉数字开头，留下"千分位逗号 + 三位数"却没有前导数字（如 "of,200"）。
 * 这种写法不可能是完整数字，在后面标注出来，提示模型保留不确定性，而不是自行补成某个数。
 */
export function markDamagedNumbers(text: string): string {
  return text.replace(/(?<![\d,]),(\d{3})(?![\d,])/g, `,$1${DAMAGED_NUMBER_MARK}`);
}

function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}
