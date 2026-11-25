import { Lexer } from 'marked';
import type { Revision, RevisionType } from '../shared/types';
import type { Prompt } from './gemini';
import { videoBlock } from './prompts';
import type { VideoMeta } from './youtube';

/**
 * 内容核对与局部修订：文章流式写完之后，按章并行地让模型拿这一章逐句对照整段字幕，列出与字幕不一致的地方和修订后的句子；
 * 程序只在"问题能在字幕里找到原文依据、要替换的句子能在这一章里唯一定位"时才替换那一句。
 * 不重写全文：没被点到的句子一个字都不动。按章核对比整篇一次核对查得细，各章同时进行，等待时间取决于最慢的一章。
 */

/** 例子都是虚构的，不取自任何具体视频。 */
const REVIEW_SYSTEM = `你是事实核对编辑。下面有一段视频字幕，和根据它整理成的一篇中文文章里的一部分（<section>）。字幕是唯一的事实依据。请逐句把 <section> 和字幕对照：先在字幕里找到每句话对应的原文，再看这句话写得对不对。找出写错的地方，并给出只改动出错部分的修订。

要找的问题（type）：
- time：年份、日期、时间段被安到了别的事情上。字幕里一个时间只修饰某一件事，文章却让它修饰了其他事。例：字幕是"我 2003 年搬到柏林。那家基金在之后十年里先后投了甲、乙、丙"，文章写成"2003 年那家基金投资了甲、乙、丙"。
- attribution：谁说的话写错了。先分清字幕里每段话是谁说的，再看文章。包括：主持人说的话被写进嘉宾的回答；主持人在提问或接话时复述、引用嘉宾以前说过的话（"你以前说过……""我最喜欢你那句……"），文章写成嘉宾这次回答里自己讲的；一个人的观点写成另一个人的；开场介绍人说的话写成演讲者说的。
- quantity：数字对应的对象、范围、时间或确定程度变了。文章里每一个数字、倍数和数量词都要回到字幕核对。包括：现状写成预期，或预期写成现状（"现在 5 个，以后会到 5 到 6 个"写成"现在有 5 到 6 个"）；倍数、数量级、单位写错（tripling 写成"加倍"、功率写成能耗）；"大概""可能""我记不清了"这类不确定的说法被写成确定的事实。
- unsupported：字幕里没有、会改变事实的补充：新的数字、人名、头衔、机构、事件、例子、因果关系或评价。
- language：没有必要的半译（书名、专名一半中文一半英文）、中英混杂、日语汉字词、错字、残缺的句子。专名拿不准中文译名时，保留字幕里的英文原文。

要求：
1. 每个问题都要有字幕依据。evidence 从 <transcript> 里逐字复制一段连续的原文，足以说明问题；不能改写、翻译，也不能把不相邻的句子拼在一起（确实需要两处时用 " … " 隔开）。程序会核对 evidence 是否真的出现在字幕里，对不上的问题会被丢弃。
2. quote 是 <section> 里要被替换的原文：逐字复制（标点和 ** 等标记都照抄），在 <section> 里只出现一次，并且不跨段落。尽量短，只包住出错的那一句或半句。
3. replacement 用来替换 quote：只改正这一处，保持原来的人称、语气和格式；不能加入 evidence 里没有的新信息；不能改动标题层级，不能分段。要删掉没有依据的内容时，replacement 写删掉之后仍然通顺的文字。
4. 以下情况不算问题，不要报：
   - 措辞偏好；合理的压缩和省略（没写全不算错，写错才算）；
   - 不改变事实的润色：把口语换成书面说法、补上衔接词、常识性的修饰（"一群鸟"写成"一群飞翔的鸟"）；
   - 自动字幕听错的人名、产品名，上下文能确定时写成正确写法；
   - 文中"字幕此处数字不清"这类说明；
   - 用户要求带来的取舍，例如篇幅、范围、受众、文体。
5. 没有把握就不报。没有问题时 issues 返回空数组。`;

/**
 * 把文章切成核对单元：标题和第一章合成第一个单元，之后每章一个。各单元的 raw 首尾相接就是原文，
 * 修订在单元内定位和替换，再原样拼回去。切不出章节（或拼不回原文）时返回 null，调用方按整篇处理。
 */
export function splitForReview(markdown: string): string[] | null {
  const sections: string[] = [];
  let current = '';
  let seenChapter = false;
  for (const token of Lexer.lex(markdown)) {
    if (token.type === 'heading' && token.depth === 2) {
      if (seenChapter) {
        sections.push(current);
        current = '';
      }
      seenChapter = true;
    }
    current += token.raw;
  }
  sections.push(current);
  return seenChapter && sections.join('') === markdown ? sections : null;
}

export function reviewPrompt(input: { video: VideoMeta; transcriptText: string; instructions: string; outline: string[]; section: string }): Prompt {
  const { video, transcriptText, instructions, outline, section } = input;
  return {
    system: REVIEW_SYSTEM,
    user: `${videoBlock(video)}

<transcript>
${transcriptText}
</transcript>

<user_requirements note="生成文章时用户提出的要求，只用来理解文章为什么这样取舍">
${instructions.trim() || '无'}
</user_requirements>

<article_outline note="整篇文章的章节标题，只用来了解这一部分在全文里的位置">
${outline.map((t, i) => `${i + 1}. ${t}`).join('\n')}
</article_outline>

<section>
${section}
</section>

请核对 <section>，输出问题列表。`,
  };
}

const TYPES: RevisionType[] = ['time', 'attribution', 'quantity', 'unsupported', 'language'];

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: TYPES },
          quote: { type: 'string', description: '文章里要被替换的原文，逐字复制' },
          evidence: { type: 'string', description: '字幕里的依据，逐字复制' },
          problem: { type: 'string', description: '一句话说明哪里和字幕不一致' },
          replacement: { type: 'string', description: '替换 quote 的文字' },
        },
        required: ['type', 'quote', 'evidence', 'problem', 'replacement'],
      },
    },
  },
  required: ['issues'],
} as const;

export interface ReviewIssue {
  type: RevisionType;
  quote: string;
  evidence: string;
  problem: string;
  replacement: string;
}

export type RejectReason = 'malformed' | 'quote_not_found' | 'quote_not_unique' | 'evidence_not_in_transcript' | 'no_change' | 'structure' | 'too_long' | 'limit';

export interface ReviewOutcome {
  markdown: string;
  applied: Revision[];
  rejected: { issue: unknown; reason: RejectReason }[];
}

/** 一篇文章最多替换这么多处；再多说明这不是"局部修订"能解决的 */
export const MAX_REVISIONS = 40;
/** evidence 每个片段至少这么长，太短的片段在任何字幕里都找得到，起不到核对作用 */
const MIN_EVIDENCE_CHARS = 12;

/** 模型返回的原始 JSON → 问题列表；结构不对的条目记为 malformed，不让一条坏数据废掉整次核对 */
export function parseIssues(raw: unknown): { issues: ReviewIssue[]; malformed: unknown[] } {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { issues?: unknown }).issues) ? (raw as { issues: unknown[] }).issues : null;
  if (!list) return { issues: [], malformed: [raw] };
  const issues: ReviewIssue[] = [];
  const malformed: unknown[] = [];
  for (const item of list) {
    const i = item as Partial<Record<keyof ReviewIssue, unknown>> | null;
    const ok =
      i && typeof i === 'object' && TYPES.includes(i.type as RevisionType) && [i.quote, i.evidence, i.problem, i.replacement].every((v) => typeof v === 'string') && (i.quote as string).trim() !== '';
    if (ok) issues.push({ type: i.type as RevisionType, quote: i.quote as string, evidence: i.evidence as string, problem: (i.problem as string).trim(), replacement: i.replacement as string });
    else malformed.push(item);
  }
  return { issues, malformed };
}

/**
 * 按问题列表修订文章。每一条都要过这几关，过不了就丢弃、原文不动：
 * - quote 在当前文章里恰好出现一次（定位不唯一就不改，避免改到别处）；
 * - evidence 的每个片段都能在字幕里逐字找到（忽略空白、大小写和时间戳）；
 * - 不改变结构：quote 和 replacement 都不跨段落，不新增或去掉标题行；
 * - replacement 不比 quote 长出太多（局部修订不是扩写）。
 * 依次替换，后面的条目在已经替换过的文章上定位。
 */
export function applyRevisions(markdown: string, issues: ReviewIssue[], transcriptText: string): ReviewOutcome {
  const haystack = normalizeEvidence(transcriptText);
  const applied: Revision[] = [];
  const rejected: ReviewOutcome['rejected'] = [];
  let current = markdown;

  for (const issue of issues) {
    const reason = check(issue, current, haystack, applied.length);
    if (reason) {
      rejected.push({ issue, reason });
      continue;
    }
    current = current.replace(issue.quote, () => issue.replacement);
    applied.push({ type: issue.type, before: issue.quote, after: issue.replacement, reason: issue.problem, evidence: issue.evidence.trim() });
  }
  return { markdown: current, applied, rejected };
}

function check(issue: ReviewIssue, markdown: string, haystack: string, appliedCount: number): RejectReason | null {
  const { quote, replacement, evidence } = issue;
  if (appliedCount >= MAX_REVISIONS) return 'limit';
  if (quote === replacement) return 'no_change';
  const first = markdown.indexOf(quote);
  if (first < 0) return 'quote_not_found';
  if (markdown.indexOf(quote, first + 1) >= 0) return 'quote_not_unique';
  if (!evidenceFound(evidence, haystack)) return 'evidence_not_in_transcript';
  if (crossesBlock(quote) || crossesBlock(replacement) || hasHeadingLine(replacement) !== hasHeadingLine(quote)) return 'structure';
  // 整行标题不能被删空；标题行内的文字可以改，但不能把 # 标记改掉（上一行已保证）
  if (replacement.trim() === '' && isWholeLine(markdown, first, quote.length)) return 'structure';
  if (replacement.length > Math.max(quote.length * 2, quote.length + 80)) return 'too_long';
  return null;
}

const crossesBlock = (text: string) => /\n\s*\n/.test(text);
const hasHeadingLine = (text: string) => /(^|\n)\s{0,3}#{1,6}\s/.test(text);

function isWholeLine(markdown: string, start: number, length: number): boolean {
  const before = start === 0 || markdown[start - 1] === '\n';
  const end = start + length;
  const after = end === markdown.length || markdown[end] === '\n';
  return before && after;
}

/** 字幕和 evidence 用同一种方式归一：去掉段首时间戳和换人标记，空白压成一个空格，统一小写和引号 */
export function normalizeEvidence(text: string): string {
  return text
    .replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, ' ')
    .replace(/>>/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function evidenceFound(evidence: string, haystack: string): boolean {
  const fragments = evidence
    .split(/\s*(?:…|\.{3,})\s*/)
    .map(normalizeEvidence)
    .filter((f) => f.length > 0);
  if (fragments.length === 0) return false;
  return fragments.every((f) => f.length >= MIN_EVIDENCE_CHARS && haystack.includes(f));
}
