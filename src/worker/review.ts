import { Lexer } from 'marked';
import type { Revision, RevisionType } from '../shared/types';
import type { Prompt } from './gemini';
import { SAME_OBJECT_RULE, STATE_RULE, videoBlock } from './prompts';
import type { VideoMeta } from './youtube';

/**
 * 内容核对与局部修订：文章流式写完之后，按章并行地让模型拿这一章逐句对照整段字幕，列出与字幕不一致的地方和修订后的句子；
 * 程序只在"问题能在字幕里找到原文依据、要替换的句子能在这一章里唯一定位"时才替换那一句。
 * 不重写全文：没被点到的句子一个字都不动。按章核对比整篇一次核对查得细，各章同时进行，等待时间取决于最慢的一章。
 */

/** 例子都是虚构的，不取自任何具体视频。 */
const REVIEW_SYSTEM = `你是事实核对编辑。下面有一段视频字幕，和根据它整理成的一篇中文文章里的一部分（<section>）。字幕是唯一的事实依据。请逐句把 <section> 和字幕对照：先在字幕里找到每句话对应的原文，再看这句话写得对不对。找出写错的地方，并给出只改动出错部分的修订。

逐句核对时，除了数值本身，必须检查六件事：数据所在句或紧邻说明有没有保留视频、演示或假设语境；原话的约数、不确定语气与比较边界有没有变强；条件和因果方向有没有被压缩改写；同一对象、同一范围在整段字幕里的不同口径有没有被明确说明；每个数字数的对象（整体还是其中一部分、哪一次尝试）有没有写对；动作的进行状态和完成程度有没有被改变。缺少这些限定可能改变事实，不能直接按"合理省略"放过。

要找的问题（type）：
- time：年份、日期、时间段被安到了别的事情上。字幕里一个时间只修饰某一件事，文章却让它修饰了其他事。例：字幕是"我 2003 年搬到柏林。那家基金在之后十年里先后投了甲、乙、丙"，文章写成"2003 年那家基金投资了甲、乙、丙"。
- attribution：谁说的话写错了。先分清字幕里每段话是谁说的，再看文章。包括：主持人说的话被写进嘉宾的回答；主持人在提问或接话时复述、引用嘉宾以前说过的话（"你以前说过……""我最喜欢你那句……"），文章写成嘉宾这次回答里自己讲的；一个人的观点写成另一个人的；开场介绍人说的话写成演讲者说的；回答者为澄清而列举或复述的具体对象被补进提问者的话。压缩提问仍须保留原发言边界，澄清内容应另归回答者。讲者明确称为自己的简化框架、解释或个人判断时，文章必须保留这个归属，不能写成已经证实的普遍规律。用户要求保留发言归属且字幕明确具名时，不应将该提问者无差别压缩成"学生""观众"。
- quantity：数字对应的对象、范围、时间或确定程度变了。文章里每一个数字、倍数和数量词都要回到字幕核对。包括：现状与预期互换（"现在 5 个，以后会到 5 到 6 个"写成"现在有 5 到 6 个"）；倍数、数量级、单位写错（tripling 写成"加倍"、功率写成能耗）；about、approximately、typically 或"大概""可能"被删掉，即使还保留数值区间；将"超过"写成"至少"等改变比较边界；视频统计或演示值脱离紧邻来源语境，被写成当前事实。全文开头笼统说明讲者框架不能代替每处数据的局部语境。数字的计数对象写错也算：把整体的数量写成某一部分的数量，或把不同次尝试、不同步骤的读数写成同一件事的两种说法。${SAME_OBJECT_RULE}文章里声称"字幕前后口径不一致"、而两处其实数的是不同对象或不同次尝试的，同样要报：replacement 分别写清各自数的是什么，去掉"不一致"的说法。
- unsupported：字幕里没有、会改变事实的补充或加强：新的数字、人名、头衔、机构、事件、例子、因果关系或评价。I believe、I think、maybe、perhaps 不能消失后变成确定断言。核对条件、因果方向和各对象的关系：不能把先后顺序当因果、把缓解措施并列成起因、把一项措施的属性推广给所有措施，或把总额变化与相对负担变化混同。代码、命令、提示符的符号也逐一对照口述，不能按常见格式补齐。约数不等于假设；原话同时有 maybe、about、let's say 时，仅写"约"仍可能丢失假设性质。回答者先肯定再推测的原话，不能压成排他归因或确定断言。${STATE_RULE}这类问题按内容选 time（时间状态）或 unsupported（完成程度被加强）。
- language：没有必要的半译（书名、专名一半中文一半英文）、中英混杂、日语汉字词、错字、残缺的句子。专名拿不准中文译名时，保留字幕里的英文原文。`;

/** 两种核对共用相同的局部修订协议和例外边界。 */
const REVIEW_OUTPUT_RULES = `要求：
1. 每个问题都要有字幕依据。evidence 从 <transcript> 里逐字复制最短且足以说明问题的连续原文，每段建议 12–200 字符，避免抄入无关长段；确需多处依据时，用 " … " 隔开各段，不能直接拼接不相邻的句子。不得改写、翻译或按排版习惯润色，尤其保留英文句末标点在引号内外的原位置。虚构例：原文是 He called it 'ready'.，应照抄 He called it 'ready'.，不能改成 He called it 'ready.'。程序会逐段核对 evidence 是否真的出现在字幕里，对不上的问题会被丢弃。
2. quote 是 <section> 里要被替换的原文：逐字复制（标点和 ** 等标记都照抄），在 <section> 里只出现一次，并且不跨段落。尽量短，只包住出错的那一句或半句。
3. replacement 用来替换 quote：只改正这一处，保持原来的人称、语气和格式；不能加入 evidence 里没有的新信息；不能改动标题层级，不能分段。要删掉没有依据的内容时，replacement 写删掉之后仍然通顺的文字。
   只有同一对象、同一范围、同一次操作或陈述在字幕前后出现不一致的口径或读数时，才算口径冲突（对象、范围或所属的尝试不同，不算）。这时若文章保留两种说法，replacement 必须明确说明"字幕前后口径不一致，未作统一"等；仅分别写"先说……后说……"不算已处理。evidence 给出冲突两处原文；不能自行挑选、推算或合并成一个确定结论，也不能用常识替字幕裁定。
4. 以下情况不算问题，不要报：
   - 措辞偏好；不改变所保留事实的压缩和省略。缺少来源语境、确定程度、比较边界、关键条件或冲突提示会改变事实时，不属于这一例外；
   - 不改变事实的润色：把口语换成书面说法、补上衔接词、常识性的修饰（"一群鸟"写成"一群飞翔的鸟"）；
   - 自动字幕听错的人名、产品名，上下文能确定时写成正确写法；
   - 文中"字幕此处数字不清"这类说明；
   - 用户要求带来的取舍，例如篇幅、范围、受众、文体；但不能借取舍强化结论、改变因果或丢失用户明确要求保留的发言归属。
5. 没有把握就不报。没有问题时 issues 返回空数组。`;

const FIDELITY_REVIEW_SYSTEM = `你是事实核对编辑，负责整篇文章的语义限定复核。<section> 是完整文章，<transcript> 是唯一事实来源。只查下面五类会改变事实的问题，不做措辞润色、内容扩写或全面重写：

1. 来源与适用语境：逐一检查文章中的统计、数量和断言。即使视频用当前口吻陈述真实统计，文章也必须在该句或紧邻说明中保留"视频所述""视频中讲者提到"等来源；全文标题或开头笼统归属于某位讲者不能代替局部限定。不要把"示例"狭义理解为只有假设数据才需限定，也不要把真实统计错标成假设。演示、假设或讲者的简化框架则保留各自语境，不补字幕没有的日期。
2. 确定程度与比较边界：检查 about、typically、I believe 等约数、通常成立或不确定的语气，以及大于、小于、至少等边界，不能因压缩而加强；数值区间不等于保留了约数语气。假设、可能和约数分别核对；保留"约"不能替代 maybe 或 let's say 的假设性质。代码、命令、提示符不得因惯例补入未口述的符号。
3. 条件与因果：回到整段字幕的上下文，核对每条因果真正对应的主体、条件与结果。相邻分句、分号或同一列表不代表它们有同一因果；不能将后续缓解措施写成问题起因，也不能把一项措施的效果推广给其他措施。若省略条件会把结论变成无条件成立，必须补回必要条件。区分总额变化与相对某个基数的负担变化。
4. 重复口径：在整段字幕中比较同一对象、同一范围的前后说法或读数。若文章保留了两种不一致的说法，就近明确说明字幕前后口径不一致、未作统一；只写"先说……后说……"不够。不自行挑选、计算或用常识消除冲突。${SAME_OBJECT_RULE}文章把不同对象或不同次尝试的数字说成"口径不一致"时，改为分别写清各自数的是什么。
5. 状态与完成程度：${STATE_RULE}

type 从 time、attribution、quantity、unsupported 中选择最贴合的一项。只替换有明确字幕依据的短句或半句，保持未涉及的问题原样；不要为补充一般背景而报告问题。`;

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

interface ReviewPromptInput { video: VideoMeta; transcriptText: string; instructions: string; outline: string[]; section: string }

export function reviewPrompt(input: ReviewPromptInput): Prompt {
  return buildReviewPrompt(input, REVIEW_SYSTEM);
}

/** 与逐章核对并行的一次整篇复核，只聚焦容易在压缩中丢失的语义限定。 */
export function fidelityReviewPrompt(input: ReviewPromptInput): Prompt {
  return buildReviewPrompt(input, FIDELITY_REVIEW_SYSTEM);
}

function buildReviewPrompt(input: ReviewPromptInput, system: string): Prompt {
  const { video, transcriptText, instructions, outline, section } = input;
  return {
    system: `${system}\n\n${REVIEW_OUTPUT_RULES}`,
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

export type RejectReason = 'malformed' | 'quote_not_found' | 'quote_not_unique' | 'evidence_not_in_transcript' | 'no_change' | 'structure' | 'too_long' | 'limit' | 'reverts_earlier';

export interface ReviewOutcome {
  markdown: string;
  applied: Revision[];
  rejected: { issue: ReviewIssue; reason: RejectReason }[];
}

/** 一篇文章最多替换这么多处；再多说明这不是"局部修订"能解决的 */
export const MAX_REVISIONS = 40;
/** evidence 每个片段至少这么长，太短的片段在任何字幕里都找得到，起不到核对作用 */
const MIN_EVIDENCE_CHARS = 12;

/** 整体缺少 issues 数组时无法确认核对完成，返回 null；有效列表里的个别坏建议另记为 malformed。 */
export function parseIssues(raw: unknown): { issues: ReviewIssue[]; malformed: unknown[] } | null {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { issues?: unknown }).issues) ? (raw as { issues: unknown[] }).issues : null;
  if (!list) return null;
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
    const next = current.replace(issue.quote, () => issue.replacement);
    // 标题不能被改没：替换前后标题的个数要一样，而且每个标题都还有文字（比如把章节标题整个删空）
    if (!sameHeadings(current, next)) {
      rejected.push({ issue, reason: 'structure' });
      continue;
    }
    current = next;
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

function sameHeadings(before: string, after: string): boolean {
  const headings = (markdown: string) => Lexer.lex(markdown).flatMap((t) => (t.type === 'heading' ? [`${t.depth}:${t.text.trim() ? 'x' : ''}`] : []));
  const [a, b] = [headings(before), headings(after)];
  return a.length === b.length && b.every((h, i) => h === a[i] && h.endsWith('x'));
}
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

/** evidence 的每个片段是否都能在字幕里逐字找到 */
export function evidenceInTranscript(evidence: string, transcriptText: string): boolean {
  return evidenceFound(evidence, normalizeEvidence(transcriptText));
}

function evidenceFound(evidence: string, haystack: string): boolean {
  const fragments = evidence
    .split(/\s*(?:…|\.{3,})\s*/)
    .map(normalizeEvidence)
    .filter((f) => f.length > 0);
  if (fragments.length === 0) return false;
  return fragments.every((f) => f.length >= MIN_EVIDENCE_CHARS && haystack.includes(f));
}

/**
 * 重叠建议的合并处理。逐章核对和整篇复核针对同一份初稿，一条建议要替换的句子可能已被另一条修订改过，按原文定位不到。
 * 这类建议不能直接丢：它可能还指出了另一条修订没有处理的问题（例如一条只改了数字，另一条还要改发言归属）。
 * 这里让模型基于当前文章逐条给出结论，要改的仍然走 applyRevisions 的全部校验。
 * 只给模型当前文章、已采用的修订和每条建议自带的字幕依据（程序已核对过依据确实在字幕里），不再发整段字幕。
 */
const RECONCILE_SYSTEM = `你是事实核对编辑。一篇根据视频字幕写成的文章刚做过两路核对，两路针对同一份初稿，各自提出了修订建议。一部分建议已经采用（<applied>）；另一些建议（<pending>）要替换的初稿原句与已采用的修订重叠，在当前文章（<article>）里已经不是原来的样子。请基于当前文章逐条处理 <pending>。

对每一条：先在 <article> 里找到这条建议原本针对的那句话现在的写法，再对照这条建议的 problem 和 evidence，判断它指出的问题现在还在不在。evidence 是字幕原文，是唯一的事实依据。

status 三选一：
- covered：这条建议指出的问题在当前文章里已经全部改正。
- revise：问题还有一部分没有改正（例如数字已经改对，但发言归属、来源限定、不确定语气或条件仍然不对）。给出针对当前文章的修订：quote 从 <article> 逐字复制（标点和 ** 等标记照抄），在 <article> 里只出现一次，不跨段落，尽量短；replacement 只改正还没改正的部分，必须保留已采用修订改对的内容，不能改回初稿的写法，不能加入 evidence 里没有的信息，不改标题、不分段；evidence 从这条建议的 evidence 里逐字复制。
- unfounded：对照 evidence 后，这条建议本身不成立，或 evidence 不足以支持它。

每条 pending 都必须按 index 给出恰好一个结论。note 用一句话说明理由。status 不是 revise 时，quote、replacement、evidence 填空字符串。`;

const RECONCILE_STATUS = ['covered', 'revise', 'unfounded'] as const;
export type ReconcileStatus = (typeof RECONCILE_STATUS)[number];

export const RECONCILE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'pending 里的序号' },
          status: { type: 'string', enum: RECONCILE_STATUS },
          note: { type: 'string', description: '一句话理由' },
          quote: { type: 'string', description: '当前文章里要被替换的原文，逐字复制' },
          replacement: { type: 'string', description: '替换 quote 的文字' },
          evidence: { type: 'string', description: '字幕里的依据，逐字复制' },
        },
        required: ['index', 'status', 'note', 'quote', 'replacement', 'evidence'],
      },
    },
  },
  required: ['items'],
} as const;

export function reconcilePrompt(input: { video: VideoMeta; article: string; applied: Revision[]; pending: ReviewIssue[] }): Prompt {
  const { video, article, applied, pending } = input;
  return {
    system: RECONCILE_SYSTEM,
    user: `${videoBlock(video)}

<article>
${article}
</article>

<applied note="已经采用的修订：before 是初稿原文，after 是当前文章里的写法">
${JSON.stringify(applied.map((r) => ({ before: r.before, after: r.after, reason: r.reason })), null, 1)}
</applied>

<pending note="quote 是初稿里的原文，在当前文章里已经找不到；replacement 是当时建议的写法">
${JSON.stringify(pending.map((p, index) => ({ index, type: p.type, quote: p.quote, replacement: p.replacement, problem: p.problem, evidence: p.evidence })), null, 1)}
</pending>

请逐条给出结论。`,
  };
}

export interface ReconcileItem {
  status: ReconcileStatus;
  note: string;
  quote: string;
  replacement: string;
  evidence: string;
}

/** 合并处理的结果必须对每条 pending 恰好给出一个有效结论，否则整体无效（返回 null），不能当成处理过。 */
export function parseReconcile(raw: unknown, count: number): ReconcileItem[] | null {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items) ? (raw as { items: unknown[] }).items : null;
  if (!list || list.length !== count) return null;
  const result: (ReconcileItem | undefined)[] = Array.from({ length: count });
  for (const item of list) {
    const i = item as Partial<Record<'index' | keyof ReconcileItem, unknown>> | null;
    if (!i || typeof i !== 'object') return null;
    const index = i.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= count || result[index]) return null;
    if (!RECONCILE_STATUS.includes(i.status as ReconcileStatus)) return null;
    if (![i.note, i.quote, i.replacement, i.evidence].every((v) => typeof v === 'string')) return null;
    if (i.status === 'revise' && (i.quote as string).trim() === '') return null;
    result[index] = { status: i.status as ReconcileStatus, note: (i.note as string).trim(), quote: i.quote as string, replacement: i.replacement as string, evidence: i.evidence as string };
  }
  return result as ReconcileItem[];
}
