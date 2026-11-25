/** 上游（YouTube、Gemini）响应的构造工具，L1a 和 L1b 共用。格式按 2026-11 实测的真实响应缩减而来。 */

export const SAMPLE_VIDEO_ID = 'xRh2sVcNXQ8';
export const OTHER_VIDEO_ID = 'dQw4w9WgXcQ';

export function playerResponse(options: { status?: string; reason?: string; tracks?: object[] } = {}) {
  return {
    playabilityStatus: { status: options.status ?? 'OK', ...(options.reason ? { reason: options.reason } : {}) },
    videoDetails: { title: '测试视频', author: '测试频道', shortDescription: '简介', lengthSeconds: '600' },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: options.tracks ?? [
          { baseUrl: 'https://www.youtube.com/api/timedtext?v=x&lang=fr-FR&kind=asr&variant=gemini&fmt=srv3', languageCode: 'fr-FR', kind: 'asr', vssId: 'a.fr-FR' },
          { baseUrl: 'https://www.youtube.com/api/timedtext?v=x&lang=en&kind=asr&fmt=srv3', languageCode: 'en', kind: 'asr', vssId: 'a.en', name: { runs: [{ text: 'English (auto-generated)' }] } },
        ],
      },
    },
  };
}

export function srv1(cues: [number, string][]): string {
  const body = cues.map(([seconds, text]) => `<text start="${seconds}" dur="2.5">${text}</text>`).join('');
  return `<?xml version="1.0" encoding="utf-8" ?><transcript>${body}</transcript>`;
}

/** Gemini streamGenerateContent?alt=sse 的响应体：每段文本一个事件，最后一个事件带 finishReason。 */
export function geminiSse(texts: string[], finishReason: string | null = 'STOP', options: { thought?: string } = {}): string {
  const events = texts.map((text, i) => {
    const parts = [...(i === 0 && options.thought ? [{ text: options.thought, thought: true }] : []), { text }];
    const candidate: Record<string, unknown> = { content: { parts, role: 'model' }, index: 0 };
    if (i === texts.length - 1 && finishReason) candidate.finishReason = finishReason;
    return `data: ${JSON.stringify({ candidates: [candidate], modelVersion: 'test-model' })}\r\n\r\n`;
  });
  return events.join('');
}

/** 把文本按字节切成很小的分块，用来模拟网络分块切在多字节字符和行中间的情况。 */
export function chunkedBody(text: string, size = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
      controller.close();
    },
  });
}

export function geminiJson(value: unknown, finishReason = 'STOP') {
  return { candidates: [{ content: { parts: [{ text: JSON.stringify(value) }], role: 'model' }, finishReason }] };
}

export type GeminiPurpose = 'article' | 'rewrite' | 'review' | 'requirements' | 'summary';

/** 按系统提示词的开头判断一次 Gemini 请求是做什么的（文章、按要求修订、对照字幕核对、提取约束、5W1H） */
export function geminiPurpose(url: string, body: unknown): GeminiPurpose {
  const system = String((body as { systemInstruction?: { parts?: { text?: string }[] } } | null)?.systemInstruction?.parts?.[0]?.text ?? '');
  if (url.includes('streamGenerateContent')) return system.startsWith('你是中文内容编辑。下面是一篇') ? 'rewrite' : 'article';
  if (system.startsWith('你是事实核对编辑')) return 'review';
  if (system.startsWith('你负责从用户写给文章生成器的要求里')) return 'requirements';
  return 'summary';
}

/** 约束提取的"什么都没提"结果 */
export const NO_REQUIREMENTS_JSON = { maxChars: 0, minChars: 0, charsQuote: '', chaptersMin: 0, chaptersMax: 0, chaptersQuote: '', sectionsPerChapter: 0, sectionTitles: [], sectionsQuote: '' };

export const ARTICLE_TEXTS = [
  '# 对话测试嘉宾：测试议题\n\n## 技术革命：',
  '八十年一遇\n\n### 当前阶段\n\n**主持人:** 我们在第几局？\n\n**嘉宾:** 第三年。\n\n',
  '## 智能经济：收入爆发\n\n### 商业模式\n\n**主持人:** 收入如何？\n\n**嘉宾:** 增长很快。',
];
export const ARTICLE_MARKDOWN = ARTICLE_TEXTS.join('');
