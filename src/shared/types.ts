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

/** 字幕里残缺的数字（如 "of,200"）在文中被写成了确定的数（如 "1200"）。只用来提示，不改正文。 */
export interface NumberWarning {
  /** 残缺处所在段落的字幕时间，如 "34:25" */
  time: string | null;
  /** 字幕原文片段，如 "of,200" */
  fragment: string;
  /** 文中的写法，如 ["1200"] */
  written: string[];
}

/** 生成接口的 SSE 事件：事件名 → data 的 JSON 结构 */
export interface StreamEvents {
  stage: { stage: 'transcript' | 'generating' };
  meta: { generationId: string; video: VideoInfo; transcript: TranscriptInfo; model: string };
  delta: { text: string };
  /** chars：按统一口径计算的文章字数（标题和正文的非空白字符，不含 Markdown 标记） */
  /** model：实际写出这篇文章的模型（主模型繁忙时可能是备用模型，meta 里的是主模型） */
  done: { chapters: ChapterRef[]; chars: number; timing: GenerationTiming; numberWarnings: NumberWarning[]; model: string };
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
