import { Lexer } from 'marked';
import { countArticleChars, parseArticle } from '../shared/article';
import type { Prompt } from './gemini';
import { ARTICLE_RULES, videoBlock } from './prompts';
import type { VideoMeta } from './youtube';

/**
 * 用户要求里能直接算出来的硬性约束：字数上下限、章节数、每章的小节。
 * 提取交给模型（自然语言的写法太多），但每一项都必须能在用户原话里找到出处，数值也要和原话里的数字对得上，
 * 对不上的不采用。是否满足由程序按统一口径计算，不问模型。
 */
export interface Requirements {
  maxChars: number | null;
  minChars: number | null;
  chaptersMin: number | null;
  chaptersMax: number | null;
  /** 每一章要有的三级小节个数 */
  sectionsPerChapter: number | null;
  /** 每一章都要出现的小节名 */
  sectionTitles: string[];
}

export const NO_REQUIREMENTS: Requirements = { maxChars: null, minChars: null, chaptersMin: null, chaptersMax: null, sectionsPerChapter: null, sectionTitles: [] };

export function hasRequirements(r: Requirements): boolean {
  return r.maxChars !== null || r.minChars !== null || r.chaptersMin !== null || r.chaptersMax !== null || r.sectionsPerChapter !== null || r.sectionTitles.length > 0;
}

const REQUIREMENTS_SYSTEM = `你负责从用户写给文章生成器的要求里，提取能直接数出来的硬性约束。只提取用户明确写出数量的要求，不推测、不补充。

- maxChars / minChars：全文字数的上限、下限。"不超过 1500 字""最多 800 字""1500 字以内"是上限；"至少 2000 字""不少于 2000 字"是下限；"800 到 1000 字"两个都有。"简短一点""写长一些"这类没有数字的说法不提取。
- chaptersMin / chaptersMax：章节数。"正好 3 章""分三章""写三章"时两个都填 3；"不超过 5 章"只填上限；"至少 4 章"只填下限。
- sectionsPerChapter：每一章要有几个小节（"每章三个小节"）。sectionTitles：用户点名每章都要有的小节名，按用户写的原样、顺序列出（"每章都包含'核心观点''原话依据'两个小节"→ ["核心观点","原话依据"]）。
- 没有对应要求的数字字段填 0，sectionTitles 填空数组。
- 每一类约束都要给出 quote：从用户要求里逐字复制的那半句话。没有对应要求时 quote 填空字符串。程序会核对 quote 是否真的出现在用户要求里。`;

export const REQUIREMENTS_SCHEMA = {
  type: 'object',
  properties: {
    maxChars: { type: 'integer' },
    minChars: { type: 'integer' },
    charsQuote: { type: 'string' },
    chaptersMin: { type: 'integer' },
    chaptersMax: { type: 'integer' },
    chaptersQuote: { type: 'string' },
    sectionsPerChapter: { type: 'integer' },
    sectionTitles: { type: 'array', items: { type: 'string' } },
    sectionsQuote: { type: 'string' },
  },
  required: ['maxChars', 'minChars', 'charsQuote', 'chaptersMin', 'chaptersMax', 'chaptersQuote', 'sectionsPerChapter', 'sectionTitles', 'sectionsQuote'],
} as const;

export function requirementsPrompt(instructions: string): Prompt {
  return { system: REQUIREMENTS_SYSTEM, user: `<user_requirements>\n${instructions.trim()}\n</user_requirements>\n\n请提取硬性约束。` };
}

/**
 * 模型的提取结果 → 约束。每一类约束都要过两关，否则丢弃并记进 dropped：
 * quote 逐字出现在用户要求里（忽略空白）；数值出现在 quote 的数字里（阿拉伯数字或中文数字）。
 */
export function parseRequirements(raw: unknown, instructions: string): { requirements: Requirements; dropped: string[] } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const source = squeeze(instructions);
  const dropped: string[] = [];
  const requirements: Requirements = { ...NO_REQUIREMENTS, sectionTitles: [] };
  const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);
  const quoted = (name: string, quote: unknown, values: (number | null)[]): boolean => {
    const present = values.filter((v): v is number => v !== null);
    if (present.length === 0) return false;
    const text = typeof quote === 'string' ? squeeze(quote) : '';
    const numbers = numbersIn(text);
    const ok = text !== '' && source.includes(text) && present.every((v) => numbers.includes(v));
    if (!ok) dropped.push(name);
    return ok;
  };

  const maxChars = int(r.maxChars);
  const minChars = int(r.minChars);
  if (quoted('chars', r.charsQuote, [maxChars, minChars]) && (maxChars === null || minChars === null || minChars <= maxChars)) {
    requirements.maxChars = maxChars;
    requirements.minChars = minChars;
  }
  const chaptersMin = int(r.chaptersMin);
  const chaptersMax = int(r.chaptersMax);
  if (quoted('chapters', r.chaptersQuote, [chaptersMin, chaptersMax]) && (chaptersMin === null || chaptersMax === null || chaptersMin <= chaptersMax)) {
    requirements.chaptersMin = chaptersMin;
    requirements.chaptersMax = chaptersMax;
  }
  const sectionsPerChapter = int(r.sectionsPerChapter);
  const titles = Array.isArray(r.sectionTitles) ? r.sectionTitles.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim()) : [];
  const sectionsQuote = typeof r.sectionsQuote === 'string' ? squeeze(r.sectionsQuote) : '';
  if (sectionsPerChapter !== null || titles.length > 0) {
    const quoteOk = sectionsQuote !== '' && source.includes(sectionsQuote);
    const countOk = sectionsPerChapter === null || numbersIn(sectionsQuote).includes(sectionsPerChapter);
    const titlesOk = titles.every((t) => source.includes(squeeze(t)));
    if (quoteOk && countOk && titlesOk) {
      requirements.sectionsPerChapter = sectionsPerChapter;
      requirements.sectionTitles = titles;
    } else dropped.push('sections');
  }
  return { requirements, dropped };
}

/** 约束没有满足的地方，message 直接给用户看 */
export interface Violation {
  kind: 'max_chars' | 'min_chars' | 'chapters' | 'sections';
  message: string;
}

const fmt = (n: number) => n.toLocaleString('en-US');

/** 按统一口径核对文章是否满足约束。字数用 countArticleChars，章节用 parseArticle，小节数三级标题。 */
export function checkRequirements(markdown: string, r: Requirements): Violation[] {
  const violations: Violation[] = [];
  const chars = countArticleChars(markdown);
  const { chapters } = parseArticle(markdown);
  if (r.maxChars !== null && chars > r.maxChars) violations.push({ kind: 'max_chars', message: `全文 ${fmt(chars)} 字，要求不超过 ${fmt(r.maxChars)} 字` });
  if (r.minChars !== null && chars < r.minChars) violations.push({ kind: 'min_chars', message: `全文 ${fmt(chars)} 字，要求至少 ${fmt(r.minChars)} 字` });
  const n = chapters.length;
  if ((r.chaptersMin !== null && n < r.chaptersMin) || (r.chaptersMax !== null && n > r.chaptersMax)) {
    const want = r.chaptersMin === r.chaptersMax ? `正好 ${r.chaptersMin} 章` : r.chaptersMin === null ? `不超过 ${r.chaptersMax} 章` : r.chaptersMax === null ? `至少 ${r.chaptersMin} 章` : `${r.chaptersMin} 到 ${r.chaptersMax} 章`;
    violations.push({ kind: 'chapters', message: `全文 ${n} 章，要求${want}` });
  }
  if (r.sectionsPerChapter !== null || r.sectionTitles.length > 0) {
    for (const chapter of chapters) {
      const sections = Lexer.lex(chapter.markdown).flatMap((t) => (t.type === 'heading' && t.depth === 3 ? [t.text.trim()] : []));
      const missing = r.sectionTitles.filter((title) => !sections.some((s) => s.includes(title)));
      if (r.sectionsPerChapter !== null && sections.length !== r.sectionsPerChapter) {
        violations.push({ kind: 'sections', message: `第 ${chapter.id} 章有 ${sections.length} 个小节，要求每章 ${r.sectionsPerChapter} 个` });
      } else if (missing.length > 0) {
        violations.push({ kind: 'sections', message: `第 ${chapter.id} 章缺少小节：${missing.join('、')}` });
      }
    }
  }
  return violations;
}

/** 约束的核对结果，写给用户看：每条约束一句，带实际数值。只在约束已经满足时使用 */
export function describeRequirements(markdown: string, r: Requirements): string[] {
  const lines: string[] = [];
  const chars = countArticleChars(markdown);
  const chapters = parseArticle(markdown).chapters.length;
  if (r.maxChars !== null && r.minChars !== null) lines.push(`全文 ${fmt(chars)} 字，要求 ${fmt(r.minChars)} 到 ${fmt(r.maxChars)} 字`);
  else if (r.maxChars !== null) lines.push(`全文 ${fmt(chars)} 字，上限 ${fmt(r.maxChars)} 字`);
  else if (r.minChars !== null) lines.push(`全文 ${fmt(chars)} 字，下限 ${fmt(r.minChars)} 字`);
  if (r.chaptersMin !== null || r.chaptersMax !== null) {
    const want = r.chaptersMin === r.chaptersMax ? `正好 ${r.chaptersMin} 章` : r.chaptersMin === null ? `不超过 ${r.chaptersMax} 章` : r.chaptersMax === null ? `至少 ${r.chaptersMin} 章` : `${r.chaptersMin} 到 ${r.chaptersMax} 章`;
    lines.push(`共 ${chapters} 章，要求${want}`);
  }
  if (r.sectionsPerChapter !== null && r.sectionTitles.length > 0) lines.push(`每章 ${r.sectionsPerChapter} 个小节：${r.sectionTitles.join('、')}`);
  else if (r.sectionsPerChapter !== null) lines.push(`每章 ${r.sectionsPerChapter} 个小节`);
  else if (r.sectionTitles.length > 0) lines.push(`每章都有小节：${r.sectionTitles.join('、')}`);
  return lines;
}

/** 约束没满足时的有限修订：让模型在草稿基础上改到满足要求，不是从头重写，也不靠截断。 */
export function rewritePrompt(input: { video: VideoMeta; transcriptText: string; instructions: string; markdown: string; violations: Violation[] }): Prompt {
  const { video, transcriptText, instructions, markdown, violations } = input;
  return {
    system: `你是中文内容编辑。下面是一篇根据视频字幕写成的文章草稿，它没有满足用户提出的硬性要求。请修订草稿，使它满足全部要求。

修订规则：
- 只做满足要求所必需的改动，其余内容保持原样。
- 要压缩篇幅时，删去次要的例子、重复和铺垫，保留关键结论、数字和人名；不能把具体数字改掉，也不能改写成更笼统的说法。写到字数上限的八成左右，留出余量。
- 要补内容（例如缺少的小节、章节）时，只用字幕里有的内容。
- 不加入字幕之外的事实，不改变原来的发言归属。
- 直接输出修订后的完整文章，从一级标题开始，不要解释改了什么。

文章本身要遵守的规则仍然有效：

${ARTICLE_RULES}`,
    user: `${videoBlock(video)}

<transcript>
${transcriptText}
</transcript>

<user_requirements>
${instructions.trim()}
</user_requirements>

<unmet_requirements note="程序按统一口径算出来的，以它为准">
${violations.map((v) => `- ${v.message}`).join('\n')}
</unmet_requirements>

<draft>
${markdown}
</draft>

请输出修订后的完整文章。`,
  };
}

const squeeze = (text: string) => text.replace(/\s+/g, '');

const CN_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

/** 一段文字里出现的所有数：阿拉伯数字（1500、1,500、1.5k、2千、3万）和中文数字（三、十二、一千五百、一千五、两千） */
export function numbersIn(text: string): number[] {
  const found: number[] = [];
  for (const m of text.matchAll(/(\d[\d,，]*(?:\.\d+)?)\s*([kK千万wW])?/g)) {
    const base = Number(m[1]!.replace(/[,，]/g, ''));
    const unit = m[2] ? (/[kK千]/.test(m[2]) ? 1000 : 10000) : 1;
    if (Number.isFinite(base)) found.push(Math.round(base * unit));
  }
  // 紧跟在阿拉伯数字后面的"千""万"是上面那条规则的单位（"2千""3万"），不能再单独读成 1000、10000
  for (const m of text.matchAll(/(?<![\d.]\s*)[零〇一二两三四五六七八九十百千万]+/g)) {
    const value = parseChineseNumber(m[0]);
    if (value !== null) found.push(value);
  }
  return found;
}

/** 中文数字 → 数值。支持"一千五"这种省略末位单位的说法（= 1500）。解析不了返回 null */
export function parseChineseNumber(text: string): number | null {
  let total = 0;
  let section = 0;
  let digit: number | null = null;
  let lastUnit = 1;
  for (const ch of text) {
    if (ch in CN_DIGITS) {
      digit = CN_DIGITS[ch]!;
    } else if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch]!;
      section += (digit ?? 1) * unit;
      digit = null;
      lastUnit = unit;
    } else if (ch === '万') {
      total += (section + (digit ?? 0) || 1) * 10000;
      section = 0;
      digit = null;
      lastUnit = 10000;
    } else return null;
  }
  if (digit !== null) section += lastUnit >= 100 && !/[零〇]/.test(text) ? (digit * lastUnit) / 10 : digit;
  const value = total + section;
  return value > 0 ? value : null;
}
