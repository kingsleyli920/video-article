import type { StreamEvents, TranscriptPreviewSnippet } from '../shared/types';

export type SourceMeta = Pick<StreamEvents['meta'], 'video' | 'transcript'>;

/**
 * 来源面板：收到 meta 立即写明这篇文章依据的视频和字幕；生成结束（完成、失败、停止）后原样保留，
 * 开始新的一次生成时清空并隐藏。面板只陈述来源，不表示生成进度或结果。
 */
export interface SourcePanel {
  show(meta: SourceMeta): void;
  clear(): void;
}

export function createSourcePanel(root: HTMLElement): SourcePanel {
  return {
    show(meta) {
      root.replaceChildren(...buildSource(meta));
      root.hidden = false;
    },
    clear() {
      root.replaceChildren();
      root.hidden = true;
    },
  };
}

/** 面板内容。所有来自服务端的文字都用 textContent 写入，视频标题和字幕原文不会被当成 HTML。 */
export function buildSource({ video, transcript }: SourceMeta): HTMLElement[] {
  const facts = document.createElement('dl');
  facts.className = 'source-facts';

  const duration = formatDuration(video.lengthSeconds);
  const videoRow = row('来源视频', [video.title || video.id, joinParts([video.channel, duration && `时长 ${duration}`])]);
  videoRow.querySelector('dd')?.classList.add('source-title');
  facts.append(videoRow);

  const chars = typeof transcript.chars === 'number' && Number.isFinite(transcript.chars) ? `整理后 ${transcript.chars.toLocaleString('zh-CN')} 字符` : '';
  facts.append(row('字幕', [joinParts([languageName(transcript.language), transcript.kind === 'asr' ? '自动生成字幕' : '人工字幕']), chars]));

  const origin = row('字幕来源', [transcript.source === 'live' ? 'YouTube 实时获取' : `内置备份（实时获取失败：${transcript.liveError || '未知原因'}）`]);
  if (transcript.source !== 'live') origin.classList.add('source-row-warn');
  facts.append(origin);

  const snippets = (transcript.preview ?? []).filter((s): s is TranscriptPreviewSnippet => typeof s?.text === 'string' && s.text.trim() !== '');
  if (snippets.length === 0) return [facts];

  const details = document.createElement('details');
  details.className = 'source-preview';
  const summary = document.createElement('summary');
  const asrNote = transcript.kind === 'asr' ? '，自动生成字幕可能有识别错误' : '';
  summary.textContent = `字幕原文片段（节选 ${snippets.length} 段${asrNote}）`;
  const list = document.createElement('ol');
  list.className = 'source-snippets';
  // 片段是字幕原文（未翻译），标上语言，读屏软件按原文语言朗读
  if (transcript.language) list.lang = transcript.language;
  for (const { time, text } of snippets) {
    const item = document.createElement('li');
    if (time) {
      const stamp = document.createElement('span');
      stamp.className = 'source-time';
      stamp.textContent = `[${time}]`;
      item.append(stamp, ' ');
    }
    item.append(text);
    list.append(item);
  }
  details.append(summary, list);
  return [facts, details];
}

/** 视频时长：不到一小时写 mm:ss，否则写 h:mm:ss；时长未知（0 或缺失）时返回空字符串 */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '';
  const total = Math.round(totalSeconds);
  const h = Math.floor(total / 3600);
  const mmss = `${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

/** 字幕语言代码换成中文名（en → 英语）；认不出的代码原样显示 */
export function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames(['zh-CN'], { type: 'language' }).of(code);
    if (name && name !== code) return name;
  } catch {
    // 不是合法的语言代码
  }
  return code;
}

function joinParts(parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join(' · ');
}

/** 一行：标签 + 一到多段内容（空的内容不出现） */
function row(label: string, values: string[]): HTMLDivElement {
  const div = document.createElement('div');
  div.className = 'source-row';
  const dt = document.createElement('dt');
  dt.textContent = label;
  div.append(dt);
  for (const value of values) {
    if (!value) continue;
    const dd = document.createElement('dd');
    dd.textContent = value;
    div.append(dd);
  }
  return div;
}
