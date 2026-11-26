import type { Prompt } from './gemini';
import { videoBlock } from './prompts';
import type { ReviewIssue } from './review';
import type { VideoMeta } from './youtube';

/**
 * 语气清单核对。通读式的核对同时要查归属、数字、时间、因果等很多类问题，原话里的"似乎""可能""大概"被写成确定说法这类细问题时有时漏。
 * 这里换一种做法：程序先按一份通用词表，从字幕里摘出带不确定或约略语气的原话片段，列成清单；
 * 模型只做一件事——对着清单逐条看文章里对应的句子有没有保留这层语气。
 * 词表是通用的英文和中文说法，不针对任何视频；命中只是"值得核对"，是不是真的不确定由模型结合上下文判断。
 * 模型给出的修订和其他核对一样，要过 applyRevisions 的全部校验。
 */

/** 英文：单词边界匹配，不分大小写。about/around 只在后面跟数字或数量词时算约数（否则多半是"关于"） */
const NUMBER_WORD = String.raw`(?:\d[\d,.]*|a\s|an\s|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|half|dozen|several|few)`;
const EN_MARKERS = [
  String.raw`seems?(?:\s+(?:to|like|that))?`,
  String.raw`seemed`,
  String.raw`appears?\s+to`,
  String.raw`might`,
  String.raw`may(?=\s+(?:be|have|not|well|also|even|or|want|need|see|find|get|look|seem|take|make|come|go|end|turn|actually)\b)`,
  String.raw`could\s+be`,
  String.raw`probably`,
  String.raw`perhaps`,
  String.raw`maybe`,
  String.raw`possibly`,
  String.raw`presumably`,
  String.raw`apparently`,
  String.raw`supposedly`,
  String.raw`(?:un)?likely`,
  String.raw`I\s+(?:think|believe|guess|suppose|suspect|imagine|assume)`,
  String.raw`I(?:'m|\s+am)\s+not\s+(?:sure|certain)`,
  String.raw`not\s+(?:sure|certain)`,
  String.raw`as\s+far\s+as\s+I\s+(?:know|remember|recall)`,
  String.raw`if\s+I\s+(?:remember|recall)`,
  String.raw`(?:roughly|approximately|around|about|nearly|almost|some)\s+${NUMBER_WORD}`,
  String.raw`or\s+so`,
  String.raw`more\s+or\s+less`,
  String.raw`typically`,
  String.raw`usually`,
  String.raw`generally`,
  String.raw`tends?\s+to`,
  String.raw`let(?:'s|\s+us)\s+say`,
];
const EN_PATTERN = new RegExp(String.raw`(?<![A-Za-z])(?:${EN_MARKERS.join('|')})(?![A-Za-z])`, 'gi');
/** 中文：字幕本身是中文时用 */
const ZH_PATTERN = /可能|大概|大约|也许|或许|似乎|好像|恐怕|估计|未必|不一定|说不定|应该是|我觉得|我认为|我猜|我印象|不确定|不太确定|差不多|左右|通常|一般来说|往往/g;

export interface HedgedExcerpt {
  /** 字幕里的连续原文，可以直接当 evidence */
  text: string;
  /** 这段里命中的词 */
  markers: string[];
}

/** 一段摘录最多向命中词两侧各扩这么多字符；清单总长度上限，超出的部分不再摘（返回 dropped 计数） */
const WINDOW_CHARS = 220;
/** 片段至少这么长才能当依据（核对 evidence 时每段至少 12 个字符，见 review.ts） */
const MIN_EXCERPT_CHARS = 12;
export const HEDGE_LIST_CHARS = 120_000;

/**
 * 从整理后的字幕里摘出带不确定语气的片段。每个命中向两侧扩到最近的句子边界（句号、问号、叹号或换行），
 * 找不到边界时最多扩 WINDOW_CHARS；重叠的片段合并。摘录不跨段落，是字幕里的连续原文。
 */
export function hedgedExcerpts(transcriptText: string): { excerpts: HedgedExcerpt[]; dropped: number } {
  const spans: { start: number; end: number; markers: string[] }[] = [];
  const hits: { index: number; length: number; marker: string }[] = [];
  for (const pattern of [EN_PATTERN, ZH_PATTERN]) {
    for (const m of transcriptText.matchAll(pattern)) hits.push({ index: m.index, length: m[0].length, marker: m[0].replace(/\s+/g, ' ') });
  }
  hits.sort((a, b) => a.index - b.index);

  for (const hit of hits) {
    let start = hit.index;
    const minStart = Math.max(0, hit.index - WINDOW_CHARS);
    while (start > minStart && !isBoundaryBefore(transcriptText, start)) start--;
    const extendBack = () => {
      if (start > minStart) start--;
      while (start > minStart && !isBoundaryBefore(transcriptText, start)) start--;
    };
    let end = hit.index + hit.length;
    const maxEnd = Math.min(transcriptText.length, end + WINDOW_CHARS);
    while (end < maxEnd && !isBoundaryAfter(transcriptText, end)) end++;
    // 一句话太短（中文常见）当不了依据：往前多带一句
    if (end - start < MIN_EXCERPT_CHARS && transcriptText[start - 1] !== '\n') extendBack();
    const last = spans.at(-1);
    if (last && start <= last.end && !transcriptText.slice(last.end, start).includes('\n')) {
      last.end = Math.max(last.end, end);
      if (!last.markers.includes(hit.marker)) last.markers.push(hit.marker);
    } else spans.push({ start, end, markers: [hit.marker] });
  }

  const excerpts: HedgedExcerpt[] = [];
  let total = 0;
  let dropped = 0;
  for (const span of spans) {
    // 去掉段首的时间戳和换人标记，留下的仍是字幕里的连续文字（核对 evidence 时这些标记本来就被忽略）
    const text = transcriptText
      .slice(span.start, span.end)
      .replace(/^\s*(?:\[\d{1,2}:\d{2}(?::\d{2})?\]\s*)?(?:>>\s*)?/, '')
      .trim();
    if (text.length < MIN_EXCERPT_CHARS) continue;
    if (total + text.length > HEDGE_LIST_CHARS) {
      dropped++;
      continue;
    }
    total += text.length;
    excerpts.push({ text, markers: span.markers });
  }
  return { excerpts, dropped };
}

/** start 处是不是一句话的开头：前一个字符是换行，或前面是句末标点加空白 */
function isBoundaryBefore(text: string, start: number): boolean {
  const prev = text[start - 1];
  if (prev === '\n') return true;
  // 中文句末标点后面通常没有空白，直接算边界；英文的要后面跟空白（避免在 3.14、e.g. 这种地方断开）
  if (/[。？！]["”’）)]?$/.test(text.slice(Math.max(0, start - 2), start))) return true;
  return /\s/.test(prev ?? '') && /[.?!]["'”’)]?$/.test(text.slice(Math.max(0, start - 3), start).trimEnd());
}

/** end 处是不是一句话的结尾：到了换行，或刚越过句末标点 */
function isBoundaryAfter(text: string, end: number): boolean {
  if (text[end] === '\n') return true;
  const tail = text.slice(Math.max(0, end - 2), end);
  if (/[。？！]["”’）)]?$/.test(tail) && !/["”’）)]/.test(text[end] ?? '')) return true;
  return /[.?!]["'”’)]?$/.test(tail) && /\s/.test(text[end] ?? ' ');
}

/** 一次请求最多核对这么多条片段；清单更长时分成几次请求并行，最多 TONE_MAX_REQUESTS 次（再多就加大每次的条数） */
const TONE_CHUNK = 60;
const TONE_MAX_REQUESTS = 3;

/** 把清单分成几份，每份一次请求。条数少时一份；份数封顶，保证并行请求数可控 */
export function chunkExcerpts(excerpts: HedgedExcerpt[]): HedgedExcerpt[][] {
  if (excerpts.length === 0) return [];
  const parts = Math.min(TONE_MAX_REQUESTS, Math.ceil(excerpts.length / TONE_CHUNK));
  const size = Math.ceil(excerpts.length / parts);
  const chunks: HedgedExcerpt[][] = [];
  for (let i = 0; i < excerpts.length; i += size) chunks.push(excerpts.slice(i, i + size));
  return chunks;
}

/** 系统提示词的开头用来和另外两种核对区分（测试替身按它分流），不要改成和它们相同的开头 */
const HEDGE_SYSTEM = `你是事实核对编辑，这一次只核对确定程度。<section> 是根据视频字幕写成的完整文章。<hedged_excerpts> 是程序从字幕里摘出的原话片段，每段都带有不确定、推测或约略的语气（方括号里是命中的词），片段是唯一的事实依据。

清单里的每一条都要给出结论，不能跳过，也不能合并。对每一条：先在 <section> 里找这段原话对应的句子，再选 status：
- absent：文章没有写到这段内容。
- kept：文章写到了，并且保留了相应的语气（例如"可能""似乎""大概""约""通常""讲者认为""印象中"）；或者命中的词在原话里并不表示不确定或约略（例如 may 表示许可、I think 之后是讲者正在做的操作说明、typically 只是在描述固定的操作步骤）；或者讲者先推测、紧接着自己确认了，文章按确认后的说法写。
- dropped：文章写到了，却写成了确定的说法——去掉了推测或约略的语气，或换成了"显然""必然""就是""都"这类更强的词。结论句、原因句也算：原话是"大概不是 A，看起来是 B"，文章写成"不是 A，而是 B"就是 dropped。

只看确定程度。归属、数字、时间等其他问题不在这次核对的范围内。`;

const HEDGE_OUTPUT_RULES = `status 为 dropped 时还要给出修订：
1. evidence 从这一条片段里逐字复制最短且足以说明问题的连续原文（至少 12 个字符），不改写、不翻译。程序会核对 evidence 是否真的出现在字幕里，对不上的会被丢弃。
2. quote 是 <section> 里要被替换的原文：逐字复制（标点和 ** 等标记都照抄），在 <section> 里只出现一次，并且不跨段落。尽量短，只包住语气出错的那半句。
3. replacement 用来替换 quote：只补回原话的那层语气，其余文字、人称和格式保持不变；不能加入片段里没有的信息；不改标题，不分段。
4. problem 用一句话说明原话的语气和文章的写法差在哪里。type：约数、数量、范围的确定程度用 quantity，其余用 unsupported。
status 不是 dropped 时，quote、replacement、evidence、problem 填空字符串，type 填 unsupported。index 用清单里的编号。`;

const TONE_STATUS = ['absent', 'kept', 'dropped'] as const;

export const TONE_SCHEMA = {
  type: 'object',
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: '清单里的编号' },
          status: { type: 'string', enum: TONE_STATUS },
          type: { type: 'string', enum: ['quantity', 'unsupported'] },
          quote: { type: 'string' },
          replacement: { type: 'string' },
          evidence: { type: 'string' },
          problem: { type: 'string' },
        },
        required: ['index', 'status', 'type', 'quote', 'replacement', 'evidence', 'problem'],
      },
    },
  },
  required: ['checks'],
} as const;

/** first：这一份清单的起始编号（从 1 起），各份的编号在整张清单里连续 */
export function hedgeReviewPrompt(input: { video: VideoMeta; excerpts: HedgedExcerpt[]; first: number; section: string }): Prompt {
  const { video, excerpts, first, section } = input;
  return {
    system: `${HEDGE_SYSTEM}\n\n${HEDGE_OUTPUT_RULES}`,
    user: `${videoBlock(video)}

<hedged_excerpts>
${excerpts.map((e, i) => `${first + i}. [${e.markers.join(' / ')}] ${e.text}`).join('\n')}
</hedged_excerpts>

<section>
${section}
</section>

请对清单里的第 ${first} 到第 ${first + excerpts.length - 1} 条逐条给出结论。`,
  };
}

/**
 * 语气核对的结果 → 问题列表。清单里的每一条都必须恰好有一个结论，否则说明这一份没有核对完，返回 null（调用方按核对失败处理）。
 * dropped 而修订字段不全的条目记为 malformed，只丢弃这一条。
 */
export function parseToneChecks(raw: unknown, first: number, count: number): { issues: ReviewIssue[]; malformed: unknown[] } | null {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { checks?: unknown }).checks) ? (raw as { checks: unknown[] }).checks : null;
  if (!list) return null;
  const seen = new Set<number>();
  const issues: ReviewIssue[] = [];
  const malformed: unknown[] = [];
  for (const item of list) {
    const c = item as Record<string, unknown> | null;
    if (!c || typeof c !== 'object') return null;
    const index = c.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < first || index >= first + count || seen.has(index)) return null;
    if (!TONE_STATUS.includes(c.status as (typeof TONE_STATUS)[number])) return null;
    seen.add(index);
    if (c.status !== 'dropped') continue;
    const ok = [c.quote, c.replacement, c.evidence, c.problem].every((v) => typeof v === 'string') && (c.quote as string).trim() !== '';
    if (ok) issues.push({ type: c.type === 'quantity' ? 'quantity' : 'unsupported', quote: c.quote as string, replacement: c.replacement as string, evidence: c.evidence as string, problem: (c.problem as string).trim() });
    else malformed.push(item);
  }
  return seen.size === count ? { issues, malformed } : null;
}
