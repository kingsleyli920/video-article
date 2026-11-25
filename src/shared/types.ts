import type { ErrorCode } from './errors';

export type TranscriptSource = 'live' | 'backup';

export interface VideoInfo {
  id: string;
  title: string;
  channel: string;
  lengthSeconds: number;
}

export interface TranscriptInfo {
  source: TranscriptSource;
  language: string;
  kind: 'asr' | 'manual';
  chars: number;
  /** 使用内置备份时，实时获取失败的原因 */
  liveError?: string;
}

export interface ChapterRef {
  id: string;
  title: string;
}

/** 相对服务端收到请求的毫秒数，用来核对流式输出的时间线 */
export interface GenerationTiming {
  transcriptMs: number;
  firstTokenMs: number | null;
  modelDoneMs: number;
  savedMs: number;
}

/** 生成接口的 SSE 事件：事件名 → data 的 JSON 结构 */
export interface StreamEvents {
  stage: { stage: 'transcript' | 'generating' };
  meta: { generationId: string; video: VideoInfo; transcript: TranscriptInfo; model: string };
  delta: { text: string };
  /** chars：按统一口径计算的文章字数（标题和正文的非空白字符，不含 Markdown 标记） */
  done: { chapters: ChapterRef[]; chars: number; timing: GenerationTiming };
  error: { code: ErrorCode; message: string; partial: boolean };
}

export const SUMMARY_FIELDS = ['who', 'what', 'when', 'where', 'why', 'how'] as const;
export type SummaryField = (typeof SUMMARY_FIELDS)[number];
/** null 表示原文未明确提及 */
export type ChapterSummary = Record<SummaryField, string | null>;

export interface SummaryResponse {
  chapterId: string;
  summary: ChapterSummary;
  cached: boolean;
}

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string };
}
