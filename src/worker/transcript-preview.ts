import type { TranscriptPreviewSnippet } from '../shared/types';
import type { Cue } from './youtube';

/**
 * 字幕原文预览：在开头、约三分之一、约三分之二处各取一小段连续字幕，每段不超过 maxChars 个字符，带原始时间戳。
 * 只用于等待时让读者核对来源，不是摘要；不把整篇字幕传给前端，也不存进上下文。
 */
export function transcriptPreview(cues: Cue[], options: { snippets?: number; maxChars?: number } = {}): TranscriptPreviewSnippet[] {
  const snippets = options.snippets ?? 3;
  const maxChars = options.maxChars ?? 200;
  const usable = cues.filter((c) => c.text.trim());
  if (usable.length === 0) return [];
  const starts = [...new Set(Array.from({ length: snippets }, (_, i) => Math.floor((usable.length * i) / snippets)))];
  return starts.map((start, n) => {
    // 每段止于下一段的起点，字幕很短时各段不会重复同一句
    const end = starts[n + 1] ?? usable.length;
    let text = '';
    for (let i = start; i < end; i++) {
      const next = text ? `${text} ${usable[i]!.text.trim()}` : usable[i]!.text.trim();
      if (next.length > maxChars) {
        if (!text) text = `${next.slice(0, maxChars - 1)}…`;
        break;
      }
      text = next;
    }
    return { time: clock(usable[start]!.start), text };
  });
}

function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}
