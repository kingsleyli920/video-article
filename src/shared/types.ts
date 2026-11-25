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
  /** 字幕原文的少量片段（带原始时间戳），只在 meta 里发给页面，不保存 */
  preview?: TranscriptPreviewSnippet[];
}

export interface TranscriptPreviewSnippet {
  time: string;
  text: string;
}

export interface ChapterRef {
  id: string;
  title: string;
}

/** 相对服务端收到请求的毫秒数，用来核对流式输出的时间线 */
export interface GenerationTiming {
  transcriptMs: number;
  firstTokenMs: number | null;
  /** 第一段写完、不是标题的正文发出的时间（旧版本没有这个字段） */
  firstParagraphMs?: number | null;
  modelDoneMs: number;
  /** 约束检查和字幕核对结束的时间（旧版本没有这个字段） */
  reviewedMs?: number;
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

/** 核对字幕后的修订类型：时间绑定、发言归属、数量的对象或确定程度、没有依据的内容、语言残缺 */
export type RevisionType = 'time' | 'attribution' | 'quantity' | 'unsupported' | 'language';

/** 一处局部修订：把文章里的 before 换成 after。reason 是问题说明，evidence 是字幕里的原文依据 */
export interface Revision {
  type: RevisionType;
  before: string;
  after: string;
  reason: string;
  evidence: string;
}

/** 文章写完之后的核对结果，随 done 发给页面，也存进生成上下文 */
export interface ArticleReview {
  /** 并行对照字幕核对的单元数（按章） */
  sections: number;
  /** 采用的局部修订数 */
  revisions: number;
  /** 初稿没满足可计算约束、整篇修订过一次时的记录；没发生是 null */
  rewritten: { unmet: string[]; charsBefore: number; charsAfter: number } | null;
  /** 可计算约束的核对结果，每条一句，如"全文 1,025 字，上限 1,200 字"；用户没提这类要求时为空 */
  checks: string[];
}

/** 生成接口的 SSE 事件：事件名 → data 的 JSON 结构 */
export interface StreamEvents {
  /** revising：初稿没满足可计算约束，正在按要求修订；reviewing：正在对照字幕核对 */
  stage: { stage: 'transcript' | 'generating' | 'revising' | 'reviewing' };
  meta: { generationId: string; video: VideoInfo; transcript: TranscriptInfo; model: string };
  delta: { text: string };
  /**
   * 核对后的最终文章和初稿不同时发一次，在 done 之前：页面用 markdown 整体替换已经显示的初稿，
   * 之后保存、章节 id 和 5W1H 都以它为准。revisions 是对照字幕做的局部修订，供页面列出。
   */
  revised: { markdown: string; revisions: Revision[] };
  /** chars：按统一口径计算的文章字数（标题和正文的非空白字符，不含 Markdown 标记） */
  /** model：实际写出这篇文章的模型（主模型繁忙时可能是备用模型，meta 里的是主模型） */
  done: { chapters: ChapterRef[]; chars: number; timing: GenerationTiming; numberWarnings: NumberWarning[]; model: string; review: ArticleReview };
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
