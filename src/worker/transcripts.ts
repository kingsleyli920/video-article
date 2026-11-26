import type { TranscriptInfo } from '../shared/types';
import { toAppError } from './app-error';
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

/**
 * 先直连 YouTube（被拦时 fetchTranscript 内部会换客户端重试）；全部失败（含超时）且该视频有内置备份时改用备份，
 * 并带上实时获取失败的原因。只有示例视频有备份，其他视频失败就报错。
 * 客户端已经断开导致的取消不兜底，直接把取消原因抛出去。
 */
export async function loadTranscript(videoId: string, options: TranscriptOptions = {}): Promise<LoadedTranscript> {
  try {
    const transcript = await fetchTranscript(videoId, options);
    return { transcript, info: { source: 'live', language: transcript.language, kind: transcript.kind } };
  } catch (err) {
    if (options.signal?.aborted) throw options.signal.reason;
    const backup = BACKUPS.get(videoId);
    if (!backup) throw err;
    const reason = toAppError(err).message;
    const attempts = err instanceof TranscriptError ? err.attempts : [];
    console.warn(JSON.stringify({ event: 'transcript_backup', videoId, reason }));
    return {
      transcript: fromBackup(backup, attempts),
      info: { source: 'backup', language: backup.language, kind: backup.kind, liveError: reason },
    };
  }
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
