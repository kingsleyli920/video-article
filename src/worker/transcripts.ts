import type { TranscriptInfo } from '../shared/types';
import { toAppError } from './app-error';
import sampleBackup from './transcripts/xRh2sVcNXQ8.json';
import { fetchTranscript, type Transcript } from './youtube';

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

/** 先直连 YouTube；失败且该视频有内置备份时改用备份，并带上实时获取失败的原因。 */
export async function loadTranscript(videoId: string): Promise<LoadedTranscript> {
  try {
    const transcript = await fetchTranscript(videoId);
    return { transcript, info: { source: 'live', language: transcript.language, kind: transcript.kind } };
  } catch (err) {
    const backup = BACKUPS.get(videoId);
    if (!backup) throw err;
    const reason = toAppError(err).message;
    console.warn(JSON.stringify({ event: 'transcript_backup', videoId, reason }));
    return {
      transcript: fromBackup(backup),
      info: { source: 'backup', language: backup.language, kind: backup.kind, liveError: reason },
    };
  }
}

function fromBackup(file: BackupFile): Transcript {
  return {
    video: file.video,
    language: file.language,
    kind: file.kind,
    trackName: file.trackName,
    trackVssId: file.source.trackVssId,
    cues: file.cues.map(([start, text]) => ({ start, text })),
  };
}
