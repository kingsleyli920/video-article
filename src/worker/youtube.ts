import { ERROR_MESSAGES, type ErrorCode } from '../shared/errors';
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
  /** 依次试过的客户端和各自的结果；最后一条是成功的那次。内置备份时是实时获取失败的那几次 */
  attempts: TranscriptAttempt[];
}

/** 一次字幕获取尝试：用哪个客户端、成没成、失败在哪一步、错误码和原因、耗时 */
export interface TranscriptAttempt {
  client: string;
  ok: boolean;
  step?: 'player' | 'captions';
  code?: ErrorCode;
  detail?: string;
  ms: number;
}

/** 全部尝试都失败时抛出：错误码沿用最后一次的，attempts 供日志和探针使用 */
export class TranscriptError extends AppError {
  readonly attempts: TranscriptAttempt[];

  constructor(code: ErrorCode, detail: string | undefined, attempts: TranscriptAttempt[]) {
    super(code, detail);
    this.attempts = attempts;
  }
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

interface Client {
  /** InnerTube 的 X-YouTube-Client-Name 编号 */
  id: string;
  /** 播放器请求体里的 context.client */
  context: { clientName: string; clientVersion: string } & Record<string, string | number>;
  /** 播放器请求和字幕下载都用这个 UA（字幕地址是按这个客户端签发的） */
  ua: string;
}

/**
 * 按顺序轮换的客户端，参数取自 yt-dlp 主干。2026-11 实测：网页端（WEB）给出的字幕地址缺 PO token 时返回空内容，
 * 移动端客户端给出的地址可以直接拉取。2026-11-25 从 Cloudflare 出口实测 42 轮：单独成功率 ANDROID 21.26.364 是 39/42、
 * ANDROID 20.10.38 是 38/42、IOS 21.26.4 是 37/42，失败全是播放器接口 HTTP 403；同一轮三个全失败 0/42。
 * 第二个换成 IOS 而不是旧版 ANDROID：拦截如果按客户端类型判定，换类型比换版本更可能绕开（两两相关性没测，待探针验证）。
 * TVHTML5（一律 LOGIN_REQUIRED）、ANDROID_VR、WEB_EMBEDDED_PLAYER、MWEB（直接 403）不可用，不要加进来。
 */
const CLIENTS: Client[] = [
  {
    id: '3',
    context: { clientName: 'ANDROID', clientVersion: '21.26.364', androidSdkVersion: 30, osName: 'Android', osVersion: '11', hl: 'en', gl: 'US' },
    ua: 'com.google.android.youtube/21.26.364 (Linux; U; Android 11) gzip',
  },
  {
    id: '5',
    context: { clientName: 'IOS', clientVersion: '21.26.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82', hl: 'en', gl: 'US' },
    ua: 'com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
  },
  {
    id: '3',
    context: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, osName: 'Android', osVersion: '11', hl: 'en', gl: 'US' },
    ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
  },
];

const EMPTY_CAPTIONS = '字幕内容为空';

export interface TranscriptOptions {
  /** 客户端断开等上游取消；触发后立即放弃，不再兜底 */
  signal?: AbortSignal;
  /** 测试时可以调短 */
  timeouts?: Partial<typeof TRANSCRIPT_TIMEOUTS>;
  /** 播放器接口地址，只在测试时指向模拟上游 */
  playerEndpoint?: string;
}

/**
 * 每一步的时间上限都包含读取响应正文。线上实测这两步合计 0.3–1.8 秒。
 *
 * - 最后一次尝试用完整上限：player 10 秒、字幕 15 秒，和只试一次时一样。
 * - 之前的尝试用缩短的上限（quick*）：player 4 秒、字幕 5 秒。被拦的 403 有时要 5 到 8 秒才返回，等它没有意义，
 *   正常响应远在 4 秒以内；即使网络偶尔慢、早期尝试被掐断，最后一次仍有完整上限。
 * - 超时是否换下一个客户端：只有这一步用的是缩短上限时才换（多半是慢速拦截）；已经给了完整上限仍超时，
 *   再试只会让用户多等，直接报 youtube_timeout，示例视频据此转入内置备份。上限设得一样短时（如测试里统一调短），
 *   超时也就不换。
 * - 整个字幕阶段的最坏耗时：(4 + 5) × 2 + (10 + 15) = 43 秒（旧版只试一次是 25 秒）。常见的快速 403 每次只多几百毫秒，
 *   慢速 403 每次最多多 4 秒。
 */
const TRANSCRIPT_TIMEOUTS = { playerMs: 10_000, captionsMs: 15_000, quickPlayerMs: 4_000, quickCaptionsMs: 5_000 };

/** 按倍率缩短的字幕超时（倍率只在测试时小于 1） */
export function transcriptTimeouts(scale = 1): typeof TRANSCRIPT_TIMEOUTS {
  const t = TRANSCRIPT_TIMEOUTS;
  return { playerMs: t.playerMs * scale, captionsMs: t.captionsMs * scale, quickPlayerMs: t.quickPlayerMs * scale, quickCaptionsMs: t.quickCaptionsMs * scale };
}

type Step = 'player' | 'captions';
type StepLimits = Record<Step, number>;

/**
 * 直连 YouTube：先取播放器数据选字幕轨，再拉 srv1 格式的字幕（体积约为 json3 的十分之一）。
 *
 * 被拦截时按 CLIENTS 的顺序换客户端重试，最多 3 次。换下一个的失败：播放器或字幕 HTTP 403 / 429（youtube_blocked）、
 * LOGIN_REQUIRED + bot（youtube_blocked）、网络错误和其他 HTTP 错误（youtube_error，换客户端可能绕开某个版本被拒的情况）、
 * 有字幕轨但字幕内容为空（缺 PO token 的表现，因客户端而异）、缩短上限下的超时。
 * 不重试：video_unavailable、no_captions（播放器正常返回但没有字幕轨）、完整上限下的超时、客户端断开（立即停止）。
 * 只试一次就结束时错误说明和以前一样；试了多次时说明里列出每次的结果，详细记录在 TranscriptError.attempts。
 * 不依赖 Worker 环境，探针可以直接调用。
 */
export async function fetchTranscript(videoId: string, options: TranscriptOptions = {}): Promise<Transcript> {
  const full = { ...TRANSCRIPT_TIMEOUTS, ...options.timeouts };
  const attempts: TranscriptAttempt[] = [];
  let failure: AppError | null = null;
  for (const [i, client] of CLIENTS.entries()) {
    const limits: StepLimits =
      i === CLIENTS.length - 1
        ? { player: full.playerMs, captions: full.captionsMs }
        : { player: Math.min(full.quickPlayerMs, full.playerMs), captions: Math.min(full.quickCaptionsMs, full.captionsMs) };
    const label = `${client.context.clientName} ${client.context.clientVersion}`;
    const started = Date.now();
    const at: { step: Step } = { step: 'player' };
    try {
      const transcript = await attempt(videoId, client, limits, options, at);
      attempts.push({ client: label, ok: true, ms: Date.now() - started });
      return { ...transcript, attempts };
    } catch (err) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (!(err instanceof AppError)) throw err;
      failure = err;
      attempts.push({ client: label, ok: false, step: at.step, code: err.code, ...(err.detail ? { detail: err.detail } : {}), ms: Date.now() - started });
      const fullLimit = at.step === 'player' ? full.playerMs : full.captionsMs;
      if (!recoverable(err, limits[at.step] < fullLimit)) break;
    }
  }
  const detail = attempts.length === 1 ? failure!.detail : `共试 ${attempts.length} 次：${attempts.map(outcome).join('、')}`;
  throw new TranscriptError(failure!.code, detail, attempts);
}

function recoverable(err: AppError, shortenedLimit: boolean): boolean {
  if (err.code === 'youtube_timeout') return shortenedLimit;
  return err.code === 'youtube_blocked' || err.code === 'youtube_error' || (err.code === 'no_captions' && err.detail === EMPTY_CAPTIONS);
}

/** 给用户看的单次结果，尽量短："HTTP 403"、"人机验证"、"超时"、"字幕为空"…… */
function outcome(a: TranscriptAttempt): string {
  const what = a.code === 'youtube_timeout' ? '超时' : a.detail === EMPTY_CAPTIONS ? '为空' : /bot/i.test(a.detail ?? '') ? '人机验证' : (a.detail ?? ERROR_MESSAGES[a.code!]);
  if (a.step !== 'captions') return what;
  return /^[A-Za-z]/.test(what) ? `字幕 ${what}` : `字幕${what}`;
}

/** 用一个客户端走完一次：播放器数据 → 选轨 → 下载字幕。at.step 记录走到了哪一步，失败时据此判断 */
async function attempt(videoId: string, client: Client, limits: StepLimits, options: TranscriptOptions, at: { step: Step }): Promise<Omit<Transcript, 'attempts'>> {
  const player = await withDeadline('读取视频信息', limits.player, options.signal, (signal) => fetchPlayer(videoId, client, signal, options.playerEndpoint ?? PLAYER_ENDPOINT));
  const renderer = player.captions?.playerCaptionsTracklistRenderer;
  const track = pickTrack(renderer?.captionTracks ?? [], renderer?.audioTracks?.[renderer.defaultAudioTrackIndex ?? 0] ?? {});
  if (!track) throw new AppError('no_captions');

  at.step = 'captions';
  const xml = await withDeadline('下载字幕', limits.captions, options.signal, async (signal) => {
    const res = await request(captionUrl(track.baseUrl), { headers: { 'user-agent': client.ua }, signal });
    return res.text();
  });
  const cues = parseSrv1(xml);
  if (cues.length === 0) throw new AppError('no_captions', EMPTY_CAPTIONS);

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

async function fetchPlayer(videoId: string, client: Client, signal: AbortSignal, endpoint: string): Promise<PlayerResponse> {
  const res = await request(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': client.ua,
      'x-youtube-client-name': client.id,
      'x-youtube-client-version': client.context.clientVersion,
    },
    body: JSON.stringify({ context: { client: client.context }, videoId }),
    signal,
  });
  let player: PlayerResponse;
  try {
    player = (await res.json()) as PlayerResponse;
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new AppError('youtube_error', '视频信息不是有效的 JSON');
  }
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
  // 2026-11-25 实测：Cloudflare 出口被拦时播放器接口直接回 403，和 429 一样是拦截，不是一般的上游错误
  if (res.status === 403 || res.status === 429) throw new AppError('youtube_blocked', `HTTP ${res.status}`);
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
