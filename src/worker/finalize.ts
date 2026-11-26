import { countArticleChars, parseArticle, validateArticle } from '../shared/article';
import { LIMITS, REVIEW_TIMING } from '../shared/limits';
import type { ArticleReview, Revision, SuggestionStage, UnappliedSuggestion } from '../shared/types';
import { AppError } from './app-error';
import type { Prompt } from './gemini';
import { chunkExcerpts, hedgedExcerpts, hedgeReviewPrompt, parseToneChecks, TONE_SCHEMA } from './hedges';
import { checkRequirements, describeRequirements, hasRequirements, rewritePrompt, type Requirements } from './requirements';
import { applyRevisions, evidenceInTranscript, fidelityReviewPrompt, parseIssues, parseReconcile, reconcilePrompt, reviewPrompt, splitForReview, RECONCILE_SCHEMA, REVIEW_SCHEMA, type RejectReason, type ReviewIssue } from './review';
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
 * 1. 核对可计算约束，并在有字数上限时尽量为核对补字预留两成空间；两种需要共用至多一次整篇修订。
 *    修订后仍不满足用户原约束时报 requirements_unmet；内部预留目标不是新的硬性约束，不用截断来凑字数。
 * 2. 按章核对、一次整篇语义限定复核和一次语气清单核对（见 hedges.ts）并行；先合并逐章修订，再依次应用整篇建议和语气建议，所有替换经过相同校验（见 review.ts）。
 *    要改的句子已被另一条修订改过、按原文定位不到的建议，不直接丢弃：重复的记为已覆盖，其余基于当前文章再做一次合并处理。
 *    没有采用的建议连同来源阶段和处置结果记进 review.unapplied。
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
  // 内部目标不能低于用户下限；上下限相等时自然没有预留空间。它与真实违约共用一次改写预算。
  const reserveChars = requirements.maxChars === null ? undefined : Math.max(requirements.minChars ?? 0, Math.floor(requirements.maxChars * 0.8));
  const needsHeadroom = reserveChars !== undefined && countArticleChars(markdown) > reserveChars;
  if (unmet.length > 0 || needsHeadroom) {
    await onStage('revising');
    const revised = await model.rewrite(rewritePrompt({ video, transcriptText, instructions, markdown, violations: unmet, reserveChars })).catch((err: unknown) => failReview(err, '按生成要求修订没有完成'));
    assertArticleLength(revised);
    const problem = validateArticle(parseArticle(revised));
    const still = problem ? [problem] : checkRequirements(revised, requirements).map((v) => v.message);
    if (still.length > 0) throw new AppError('requirements_unmet', still.join('；'));
    rewritten = { unmet: unmet.map((v) => v.message), charsBefore: countArticleChars(markdown), charsAfter: countArticleChars(revised) };
    markdown = revised;
  }

  await onStage('reviewing');
  // 总并行预算中预留两个连接给整篇语义限定复核和语气清单核对，其余连接用于逐章核对。
  // 语气清单：程序从字幕里摘出带不确定语气的原话，另发一路只核对这一件事，要求逐条给出结论；清单长时分成至多三份并行。
  // 字幕里没有这类说法时不发。并行请求超过 Workers 的同时连接数时，多出的请求会排队，不会失败。
  const hedges = hedgedExcerpts(transcriptText);
  const toneChunks = chunkExcerpts(hedges.excerpts);
  const sections = groupSections(splitForReview(markdown) ?? [markdown], Math.max(1, REVIEW_TIMING.maxUnits - 2));
  const outline = parseArticle(markdown).chapters.map((c) => c.title);
  const readIssues = async (prompt: Prompt) => {
    const parsed = parseIssues(await model.json(prompt, REVIEW_SCHEMA));
    if (parsed === null) throw new AppError('summary_invalid', '核对结果不是有效的问题列表');
    return parsed;
  };
  const [chapterOutcomes, fidelity, tone] = await Promise.all([
    Promise.all(sections.map(async (section) => {
      const { issues, malformed } = await readIssues(reviewPrompt({ video, transcriptText, instructions, outline, section }));
      return { ...applyRevisions(section, issues, transcriptText), malformed: malformed.length };
    })),
    readIssues(fidelityReviewPrompt({ video, transcriptText, instructions, outline, section: markdown })),
    Promise.all(
      toneChunks.map(async (excerpts, i) => {
        const first = toneChunks.slice(0, i).reduce((n, c) => n + c.length, 0) + 1;
        const parsed = parseToneChecks(await model.json(hedgeReviewPrompt({ video, excerpts, first, section: markdown }), TONE_SCHEMA), first, excerpts.length);
        if (parsed === null) throw new AppError('summary_invalid', '语气清单核对没有对每一条给出结论');
        return parsed;
      }),
    ).then((parts) => ({ issues: parts.flatMap((p) => p.issues), malformed: parts.flatMap((p) => p.malformed) })),
  ]).catch((err: unknown) => failReview(err, '对照字幕核对没有完成'));

  // 两路基于同一份核对前文章：先合并逐章修订，再应用整篇建议。
  const combined = chapterOutcomes.map((o) => o.markdown).join('');
  const chapterRevisions = chapterOutcomes.flatMap((o) => o.applied);
  const fidelityOutcome = { ...applyRevisions(combined, fidelity.issues, transcriptText, chapterRevisions), malformed: fidelity.malformed.length };
  const toneOutcome = { ...applyRevisions(fidelityOutcome.markdown, tone.issues, transcriptText, [...chapterRevisions, ...fidelityOutcome.applied]), malformed: tone.malformed.length };
  const staged: { stage: SuggestionStage; outcome: (typeof chapterOutcomes)[number] }[] = [
    ...chapterOutcomes.map((outcome) => ({ stage: 'chapter' as const, outcome })),
    { stage: 'article', outcome: fidelityOutcome },
    { stage: 'tone', outcome: toneOutcome },
  ];
  let reviewed = toneOutcome.markdown;
  const revisions = staged.flatMap((s) => s.outcome.applied);
  const rejected: FinalizeResult['rejected'] = {};
  const count = (reason: RejectReason, n = 1) => (rejected[reason] = (rejected[reason] ?? 0) + n);
  const unapplied: UnappliedSuggestion[] = [];
  const pending: { stage: SuggestionStage; issue: ReviewIssue }[] = [];
  for (const { stage, outcome } of staged) {
    if (outcome.malformed) count('malformed', outcome.malformed);
    for (const { issue, reason } of outcome.rejected) {
      // 引文在核对前的文章里有、轮到它时却定位不到：多数是它要改的句子已被另一条修订改过（也可能是引了别的章的句子）。
      // 这类建议不能直接丢，见 reconcilePrompt；rejected 里按最终处置计数，不记成 quote_not_found。
      const overlapped = reason === 'overlaps_earlier' || (reason === 'quote_not_found' && markdown.includes(issue.quote));
      if (!overlapped) {
        count(reason);
        unapplied.push({ stage, disposition: reason, ...issue });
      } else if (!evidenceInTranscript(issue.evidence, transcriptText)) {
        count('evidence_not_in_transcript');
        unapplied.push({ stage, disposition: 'evidence_not_in_transcript', ...issue });
      }
      // 另一条修订已经写入了一模一样的替换文字：重复建议，问题已改正
      else if (issue.replacement.trim() !== '' && reviewed.includes(issue.replacement) && !markdown.includes(issue.replacement)) unapplied.push({ stage, disposition: 'covered', ...issue, note: '另一条修订已写入相同的替换文字' });
      else pending.push({ stage, issue });
    }
  }

  if (pending.length > 0) {
    const raw = await model.json(reconcilePrompt({ video, article: reviewed, applied: revisions, pending: pending.map((p) => p.issue) }), RECONCILE_SCHEMA).catch((err: unknown) => failReview(err, '重叠修订建议的合并处理没有完成'));
    const items = parseReconcile(raw, pending.length);
    if (!items) throw new AppError('review_failed', '重叠修订建议的合并处理没有完成：模型没有对每条建议给出有效结论');
    for (const [index, { stage, issue }] of pending.entries()) {
      const item = items[index]!;
      if (item.status !== 'revise') {
        unapplied.push({ stage, disposition: item.status, ...issue, note: item.note });
        continue;
      }
      unapplied.push({ stage, disposition: 'superseded', ...issue, note: item.note });
      const next: ReviewIssue = { type: issue.type, quote: item.quote, replacement: item.replacement, evidence: item.evidence.trim() || issue.evidence, problem: issue.problem };
      const outcome = applyRevisions(reviewed, [next], transcriptText);
      // 不能把前面已经改掉的初稿写法又改回来
      const reverts = outcome.applied.length > 0 && revisions.some((r) => r.before.trim().length >= 4 && !reviewed.includes(r.before) && outcome.markdown.includes(r.before));
      const reason: RejectReason | null = reverts ? 'reverts_earlier' : (outcome.rejected[0]?.reason ?? null);
      if (reason) {
        count(reason);
        unapplied.push({ stage: 'reconcile', disposition: reason, ...next, note: item.note });
      } else {
        reviewed = outcome.markdown;
        revisions.push(...outcome.applied);
      }
    }
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
      ...(hedges.excerpts.length > 0 ? { toneExcerpts: hedges.excerpts.length } : {}),
      revisions: revisions.length,
      rewritten,
      checks: hasRequirements(requirements) ? describeRequirements(reviewed, requirements) : [],
      ...(unapplied.length > 0 ? { unapplied } : {}),
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
  if (['gemini_billing', 'gemini_quota', 'gemini_region', 'requirements_unmet', 'requirements_unconfirmed', 'article_too_long'].includes(err.code)) throw err;
  // summary_invalid 是结构化输出解析失败的通用错误码，文案里的"总结"在这里不适用，换成中性的说法
  const cause = err.code === 'summary_invalid' ? `模型返回的格式无效${err.detail ? `（${err.detail}）` : ''}` : err.message;
  throw new AppError('review_failed', `${step}：${cause}`);
}
