import { countArticleChars, parseArticle, validateArticle } from '../shared/article';
import { LIMITS, REVIEW_TIMING } from '../shared/limits';
import type { ArticleReview, Revision } from '../shared/types';
import { AppError } from './app-error';
import type { Prompt } from './gemini';
import { checkRequirements, describeRequirements, hasRequirements, rewritePrompt, type Requirements } from './requirements';
import { applyRevisions, parseIssues, reviewPrompt, splitForReview, REVIEW_SCHEMA, type RejectReason } from './review';
import type { VideoMeta } from './youtube';

/** 收尾阶段要用到的模型调用，由生成流程提供（带超时、备用模型和取消），测试里可以换成替身 */
export interface FinalizeModel {
  /** 结构化输出，返回解析后的 JSON */
  json(prompt: Prompt, schema: object): Promise<unknown>;
  /** 整篇修订：返回模型写出的完整文章；没有正常结束时抛错 */
  rewrite(prompt: Prompt): Promise<string>;
}

export interface FinalizeInput {
  draft: string;
  video: VideoMeta;
  transcriptText: string;
  instructions: string;
  /** 用户要求里的可计算约束；提取在文章流式输出期间并行进行 */
  requirements: Promise<Requirements>;
}

export interface FinalizeResult {
  /** 最终文章：保存、展示、章节 id 和 5W1H 都以它为准 */
  markdown: string;
  review: ArticleReview;
  revisions: Revision[];
  requirements: Requirements;
  /** 被丢弃的修订建议及原因，只进日志 */
  rejected: Partial<Record<RejectReason, number>>;
}

/** 异常长输出的兜底上限按原始 Markdown 长度算，与用户要求的可读字数上限分开。 */
export function assertArticleLength(markdown: string): void {
  if (markdown.length > LIMITS.articleChars) throw new AppError('article_too_long');
}

/**
 * 文章流式写完之后、保存之前的收尾：
 * 1. 按统一口径核对用户要求里的可计算约束（字数、章数、小节）。不满足就让模型在草稿基础上修订一次，再核对；
 *    仍不满足报 requirements_unmet，不保存、不显示成功。不用截断来凑字数。
 * 2. 按章并行对照字幕核对，只替换有字幕依据、能唯一定位的句子（见 review.ts）。
 * 3. 修订完再核对一遍结构和约束，确认局部修订没有破坏它们。
 * 任何一步的模型调用失败都会让这次生成失败（review_failed），不会把没核对过的文章当成已完成。
 */
export async function finalizeArticle(input: FinalizeInput, model: FinalizeModel, onStage: (stage: 'revising' | 'reviewing') => Promise<void>): Promise<FinalizeResult> {
  const { video, transcriptText, instructions } = input;
  assertArticleLength(input.draft);
  const requirements = await input.requirements.catch((err: unknown) => failReview(err, '没能确认生成要求里的硬性约束'));
  let markdown = input.draft;
  let rewritten: ArticleReview['rewritten'] = null;

  const unmet = checkRequirements(markdown, requirements);
  if (unmet.length > 0) {
    await onStage('revising');
    const revised = await model.rewrite(rewritePrompt({ video, transcriptText, instructions, markdown, violations: unmet })).catch((err: unknown) => failReview(err, '按生成要求修订没有完成'));
    assertArticleLength(revised);
    const problem = validateArticle(parseArticle(revised));
    const still = problem ? [problem] : checkRequirements(revised, requirements).map((v) => v.message);
    if (still.length > 0) throw new AppError('requirements_unmet', still.join('；'));
    rewritten = { unmet: unmet.map((v) => v.message), charsBefore: countArticleChars(markdown), charsAfter: countArticleChars(revised) };
    markdown = revised;
  }

  await onStage('reviewing');
  const sections = groupSections(splitForReview(markdown) ?? [markdown], REVIEW_TIMING.maxUnits);
  const outline = parseArticle(markdown).chapters.map((c) => c.title);
  const outcomes = await Promise.all(
    sections.map(async (section) => {
      const raw = await model.json(reviewPrompt({ video, transcriptText, instructions, outline, section }), REVIEW_SCHEMA);
      const parsed = parseIssues(raw);
      if (parsed === null) throw new AppError('summary_invalid', '核对结果不是有效的问题列表');
      const { issues, malformed } = parsed;
      return { ...applyRevisions(section, issues, transcriptText), malformed: malformed.length };
    }),
  ).catch((err: unknown) => failReview(err, '对照字幕核对没有完成'));

  const reviewed = outcomes.map((o) => o.markdown).join('');
  const revisions = outcomes.flatMap((o) => o.applied);
  const rejected: FinalizeResult['rejected'] = {};
  for (const o of outcomes) {
    for (const r of o.rejected) rejected[r.reason] = (rejected[r.reason] ?? 0) + 1;
    if (o.malformed) rejected.malformed = (rejected.malformed ?? 0) + o.malformed;
  }

  // 局部修订不改标题层级，正常不会破坏结构；万一破坏了就不能保存
  assertArticleLength(reviewed);
  const problem = validateArticle(parseArticle(reviewed));
  if (problem) throw new AppError('review_failed', `修订后的文章结构无效：${problem}`);
  const after = checkRequirements(reviewed, requirements);
  if (after.length > 0) throw new AppError('requirements_unmet', after.map((v) => v.message).join('；'));

  return {
    markdown: reviewed,
    revisions,
    requirements,
    rejected,
    review: {
      sections: sections.length,
      revisions: revisions.length,
      rewritten,
      checks: hasRequirements(requirements) ? describeRequirements(reviewed, requirements) : [],
    },
  };
}

/** 章节多于上限时把相邻的章节合并成一个核对单元，各单元首尾相接仍是原文 */
export function groupSections(sections: string[], max: number): string[] {
  if (sections.length <= max) return sections;
  const size = Math.ceil(sections.length / max);
  const groups: string[] = [];
  for (let i = 0; i < sections.length; i += size) groups.push(sections.slice(i, i + size).join(''));
  return groups;
}

/**
 * 收尾阶段的模型调用失败：客户端取消、账单、额度、地区和文章长度这类错误原样抛出（用户需要知道真实原因），
 * 其余（繁忙、超时、返回格式不对）统一报 review_failed，并带上是哪一步没完成。
 */
function failReview(err: unknown, step: string): never {
  if (!(err instanceof AppError)) throw err;
  if (['gemini_billing', 'gemini_quota', 'gemini_region', 'requirements_unmet', 'article_too_long'].includes(err.code)) throw err;
  // summary_invalid 是结构化输出解析失败的通用错误码，文案里的"总结"在这里不适用，换成中性的说法
  const cause = err.code === 'summary_invalid' ? `模型返回的格式无效${err.detail ? `（${err.detail}）` : ''}` : err.message;
  throw new AppError('review_failed', `${step}：${cause}`);
}
