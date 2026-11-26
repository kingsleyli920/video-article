/**
 * 收尾阶段（约束检查、对照字幕核对）L1b 用例共用的数据：英文字幕、按字幕写出的中文初稿、真实形状的核对结果。
 * 期望值（字数、整理后的字幕）都是手写字面量，不从被测代码算。
 */
import { geminiSse, srv1 } from '../fixtures/upstream';

export const url = (id: string) => `https://www.youtube.com/watch?v=${id}`;

/** 第三条的 "about five" 是语气词表里的约数说法：这份字幕摘出 1 条语气片段，收尾时会多发 1 次语气清单核对 */
export const CAPTIONS = srv1([
  [0, 'welcome back to the show today we are talking with Maria Lopez'],
  [12, 'I moved to Berlin in 2003. Over the next ten years the fund backed Alpha, Beta and Gamma'],
  [65, 'we are at about five portfolio companies now and I expect that to grow to five or six'],
]);

/** 三条字幕整理后合成一段（不到 1500 字符，没有换人标记），只在开头带一个时间戳 */
export const TRANSCRIPT_TEXT =
  '[00:00] welcome back to the show today we are talking with Maria Lopez I moved to Berlin in 2003. Over the next ten years the fund backed Alpha, Beta and Gamma we are at about five portfolio companies now and I expect that to grow to five or six';

export const DRAFT_TEXTS = ['# 柏林与基金\n\n## 柏林岁月\n\n', '**嘉宾:** 2003 年那家基金投资了 Alpha、Beta 和 Gamma。\n\n', '## 现在的组合\n\n**嘉宾:** 现在有五到六家被投公司。'];
/** 流式初稿，61 字（标题 5、"柏林岁月"4、第一章正文 32、"现在的组合"5、第二章正文 15） */
export const DRAFT = '# 柏林与基金\n\n## 柏林岁月\n\n**嘉宾:** 2003 年那家基金投资了 Alpha、Beta 和 Gamma。\n\n## 现在的组合\n\n**嘉宾:** 现在有五到六家被投公司。';
export const DRAFT_STREAM = geminiSse(DRAFT_TEXTS);

/** 两个核对单元：标题和第一章一个，第二章一个 */
export const SECTION_1 = '# 柏林与基金\n\n## 柏林岁月\n\n**嘉宾:** 2003 年那家基金投资了 Alpha、Beta 和 Gamma。\n\n';
export const SECTION_2 = '## 现在的组合\n\n**嘉宾:** 现在有五到六家被投公司。';

/** 字幕里 2003 年修饰的是"搬到柏林"，不是"基金投资" */
export const TIME_ISSUE = {
  type: 'time',
  quote: '2003 年那家基金投资了 Alpha、Beta 和 Gamma。',
  evidence: 'I moved to Berlin in 2003. Over the next ten years the fund backed Alpha, Beta and Gamma',
  problem: '2003 年是嘉宾搬到柏林的时间，不是基金投资的时间',
  replacement: '我 2003 年搬到柏林，之后十年里那家基金先后投资了 Alpha、Beta 和 Gamma。',
};

/** 采用 TIME_ISSUE 之后的最终文章，74 字（61 - 29 + 42） */
export const REVIEWED = '# 柏林与基金\n\n## 柏林岁月\n\n**嘉宾:** 我 2003 年搬到柏林，之后十年里那家基金先后投资了 Alpha、Beta 和 Gamma。\n\n## 现在的组合\n\n**嘉宾:** 现在有五到六家被投公司。';

/** 约束提取的"什么都没提"结果，手写一份，不和替身共用 */
export const NONE = { maxChars: 0, minChars: 0, charsQuote: '', chaptersMin: 0, chaptersMax: 0, chaptersQuote: '', sectionsPerChapter: 0, sectionTitles: [], sectionsQuote: '' };

/** Gemini 请求的用户消息和生成配置 */
export function promptOf(body: string): { system: string; user: string; generationConfig: { thinkingConfig?: unknown } } {
  const parsed = JSON.parse(body) as { systemInstruction: { parts: { text: string }[] }; contents: { parts: { text: string }[] }[]; generationConfig: { thinkingConfig?: unknown } };
  return { system: parsed.systemInstruction.parts[0]!.text, user: parsed.contents[0]!.parts[0]!.text, generationConfig: parsed.generationConfig };
}

export const modelOf = (requestUrl: string) => requestUrl.split('/models/')[1]!.split(':')[0]!;
