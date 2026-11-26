import type { ErrorCode } from '../shared/errors';
import type { TranscriptInfo } from '../shared/types';
import { AppError, toAppError } from './app-error';
import sampleBackup from './transcripts/xRh2sVcNXQ8.json';
import { fetchTranscript, TranscriptError, type Transcript, type TranscriptAttempt, type TranscriptOptions } from './youtube';

/** 内置备份文件的格式：cues 存成 [开始毫秒, 文本]，source 记录来源，便于复核。 */
export interface BackupFile {
  source: { method: string; fetchedAt: string; trackVssId: string; url: string };
  video: Transcript['video'];
  language: string;
  kind: 'asr' | 'manual';
  trackName: string;
  cues: [number, string][];
}

const BACKUPS = new Map<string, BackupFile>([[sampleBackup.video.id, sampleBackup as BackupFile]]);

export interface LoadedTranscript {
  transcript: Transcript;
  info: Omit<TranscriptInfo, 'chars'>;
}

/** 其他区域代取的结果。RPC 跨不了自定义错误类，失败用普通对象表示；attempts 是那个区域里的各次尝试 */
export type RelayResult = { ok: true; transcript: Transcript } | { ok: false; code: ErrorCode; detail?: string; attempts: TranscriptAttempt[] };

/** 一个能代取字幕的其他区域。region 记进 attempts 的 from 和 TranscriptInfo.via */
export interface TranscriptRelay {
  region: string;
  fetch(videoId: string): Promise<RelayResult>;
}

export interface LoadOptions extends TranscriptOptions {
  /** 本地被拦（youtube_blocked）后依次请这些区域代取；不传就不换区域 */
  relays?: TranscriptRelay[];
  /** 每个区域代取的总上限（包含 RPC 往返），不传时用 RELAY_TIMEOUT_MS */
  relayTimeoutMs?: number;
}

/**
 * 每个区域代取的总上限。区域里的 fetchTranscript 自己最坏 43 秒（见 youtube.ts 的 TRANSCRIPT_TIMEOUTS），
 * 外层多留 2 秒给 RPC 往返和 Durable Object 冷启动；超过就不再等它，按 youtube_timeout 处理。
 */
export const RELAY_TIMEOUT_MS = 45_000;

const LOCAL = 'local';

/**
 * 先直连 YouTube（被拦时 fetchTranscript 内部会换客户端重试）。本地最终是 youtube_blocked（人机验证按出口 IP 池判定，
 * 换客户端没用）时，依次请 relays 里的其他区域代取：某个区域也被拦就试下一个；返回别的失败（视频不存在、超时等）就停下，
 * 报那个区域的错误。本地是其他失败时不换区域。
 * 都失败（含超时）且该视频有内置备份时改用备份，并带上实时获取失败的原因。只有示例视频有备份，其他视频失败就报错。
 * 客户端已经断开导致的取消不兜底，也不再请下一个区域，直接把取消原因抛出去。
 *
 * 字幕阶段最坏耗时：本地 43 秒 + 每个区域最多 45 秒 × 3 个区域 = 178 秒。只有每个区域都慢速被拦到接近上限才会这样；
 * 常见的人机验证拦截几百毫秒就返回，换 3 个区域通常多几秒。
 */
export async function loadTranscript(videoId: string, options: LoadOptions = {}): Promise<LoadedTranscript> {
  let failure: unknown;
  let attempts: TranscriptAttempt[];
  try {
    const transcript = await fetchTranscript(videoId, options);
    return live({ ...transcript, attempts: tagged(transcript.attempts, LOCAL) });
  } catch (err) {
    if (options.signal?.aborted) throw options.signal.reason;
    failure = err;
    attempts = tagged(err instanceof TranscriptError ? err.attempts : [], LOCAL);
  }

  if (failure instanceof AppError && failure.code === 'youtube_blocked' && options.relays?.length) {
    const relayed = await tryRelays(videoId, options.relays, options, attempts);
    if (!(relayed instanceof TranscriptError)) return relayed;
    failure = relayed;
  }

  const backup = BACKUPS.get(videoId);
  if (!backup) throw failure;
  const reason = toAppError(failure).message;
  console.warn(JSON.stringify({ event: 'transcript_backup', videoId, reason }));
  return {
    transcript: fromBackup(backup, failure instanceof TranscriptError ? failure.attempts : attempts),
    info: { source: 'backup', language: backup.language, kind: backup.kind, liveError: reason },
  };
}

/** 依次请各区域代取。成功返回结果；失败返回要报的错误，attempts 里依次是本地和各区域的尝试 */
async function tryRelays(videoId: string, relays: TranscriptRelay[], options: LoadOptions, local: TranscriptAttempt[]): Promise<LoadedTranscript | TranscriptError> {
  const attempts = [...local];
  for (const relay of relays) {
    const started = Date.now();
    const result = await callRelay(relay, videoId, options.signal, options.relayTimeoutMs ?? RELAY_TIMEOUT_MS);
    if (result.ok) {
      return live({ ...result.transcript, attempts: [...attempts, ...tagged(result.transcript.attempts, relay.region)] }, relay.region);
    }
    // RPC 本身失败或超时时区域里没有尝试记录，补一条，日志里能看出是哪个区域、多久
    const tried = result.attempts.length ? result.attempts : [{ client: 'relay', ok: false, code: result.code, ...(result.detail ? { detail: result.detail } : {}), ms: Date.now() - started }];
    attempts.push(...tagged(tried, relay.region));
    if (result.code !== 'youtube_blocked') return new TranscriptError(result.code, result.detail, attempts);
  }
  return new TranscriptError('youtube_blocked', `本地试 ${local.length} 次，换 ${relays.length} 个区域后仍被拦`, attempts);
}

/**
 * 请一个区域代取，最多等 ms 毫秒。RPC 调用本身取消不了：客户端断开或到点时不再等它，立即结束（它在那个区域里会自己跑完）。
 * 断开时抛出取消原因；超时和 RPC 异常都变成失败结果。
 */
async function callRelay(relay: TranscriptRelay, videoId: string, signal: AbortSignal | undefined, ms: number): Promise<RelayResult> {
  if (signal?.aborted) throw signal.reason;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AppError('youtube_timeout', `${relay.region} 区域代取超过 ${ms / 1000} 秒`)), ms);
    onAbort = () => reject(signal!.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([relay.fetch(videoId), stop]);
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    if (err instanceof AppError) return { ok: false, code: err.code, ...(err.detail ? { detail: err.detail } : {}), attempts: [] };
    console.error(JSON.stringify({ event: 'transcript_relay_error', region: relay.region, error: String(err) }));
    return { ok: false, code: 'youtube_error', detail: '其他区域的节点调用失败', attempts: [] };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

function live(transcript: Transcript, via?: string): LoadedTranscript {
  return { transcript, info: { source: 'live', language: transcript.language, kind: transcript.kind, ...(via ? { via } : {}) } };
}

/** 给每条尝试标上发出的地方：local 或区域名 */
function tagged(attempts: TranscriptAttempt[], from: string): TranscriptAttempt[] {
  return attempts.map((a) => ({ ...a, from }));
}

function fromBackup(file: BackupFile, attempts: TranscriptAttempt[]): Transcript {
  return {
    video: file.video,
    language: file.language,
    kind: file.kind,
    trackName: file.trackName,
    trackVssId: file.source.trackVssId,
    cues: file.cues.map(([start, text]) => ({ start, text })),
    attempts,
  };
}
