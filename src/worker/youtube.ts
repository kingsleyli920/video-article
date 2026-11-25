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

/** 直连 YouTube：先取播放器数据选字幕轨，再拉 srv1 格式的字幕（体积约为 json3 的十分之一）。 */
export async function fetchTranscript(videoId: string): Promise<Transcript> {
  const player = await fetchPlayer(videoId);
  const track = pickTrack(player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []);
  if (!track) throw new AppError('no_captions');

  const res = await request(captionUrl(track.baseUrl), { headers: { 'user-agent': ANDROID_UA } });
  const cues = parseSrv1(await res.text());
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

async function fetchPlayer(videoId: string): Promise<PlayerResponse> {
  const res = await request(PLAYER_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': ANDROID_UA },
    body: JSON.stringify({ context: { client: ANDROID_CLIENT }, videoId }),
  });
  const player = (await res.json()) as PlayerResponse;
  const { status, reason } = player.playabilityStatus ?? {};
  if (status === 'OK') return player;
  if (status === 'LOGIN_REQUIRED' && /bot/i.test(reason ?? '')) throw new AppError('youtube_blocked', reason);
  throw new AppError('video_unavailable', reason || status);
}

async function request(url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
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
      const text = piece.trim();
      if (text && current) {
        current.parts.push(text);
        current.length += text.length + 1;
      }
    });
  }
  flush();
  return paragraphs.join('\n\n');
}

function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}
