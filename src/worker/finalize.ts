import { countArticleChars, parseArticle, validateArticle } from '../shared/article';
import { LIMITS, REVIEW_TIMING } from '../shared/limits';
import type { ArticleReview, Revision, SuggestionStage, UnappliedSuggestion } from '../shared/types';
import { AppError } from './app-error';
import type { Prompt } from './gemini';
import { chunkExcerpts, hedgedExcerpts, hedgeReviewPrompt, parseToneChecks, TONE_SCHEMA } from './hedges';
import { checkRequirements, describeRequirements, hasRequirements, rewritePrompt, type Requirements } from './requirements';
import { applyRevisionAt, MAX_REVISIONS, evidenceInTranscript, fidelityReviewPrompt, parseIssues, parseReconcile, reconcilePrompt, reviewPrompt, splitForReview, RECONCILE_SCHEMA, REVIEW_SCHEMA, type RejectReason, type ReviewIssue } from './review';
import { TrackedText, type Span } from './tracked';
import type { VideoMeta } from './youtube';

/** 收尾阶段要用到的模型调用，由生成流程提供（带超时、备用模型和取消），测试里可以换成替身 */
export interface FinalizeModel {
  /** 结构化输出，返回解析后的 JSON */
  json(prompt: Prompt, schema: object): Promise<unknown>;
  /** 整篇修订：返回模型写出的完整文章；没有正常结束时抛错 */
  rewrite(prompt: Prompt): Promise<string>;
}

/** 合并处理最多做这么多轮：第一轮给出的修订落实不了时，带着原因再处理一轮 */
export const RECONCILE_ROUNDS = 2;

/** 合并处理给出的修订落实不了的原因，写进给用户看的错误说明 */
const FAILURE_LABEL: Record<string, string> = {
  quote_not_found: '修订定位不到原句',
  quote_not_unique: '修订定位不唯一',
  evidence_not_in_transcript: '修订的依据对不上字幕',
  structure: '修订会破坏文章结构',
  too_long: '修订改动过大',
  no_change: '修订没有实际改动',
  reverts_earlier: '修订把已改正的内容改了回去',
  limit: '修订数量超过上限',
  duplicates_context: '修订和紧挨着的上下文重复',
};

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
      return { issues, malformed: malformed.length };
    })),
    readIssues(fidelityReviewPrompt({ video, transcriptText, instructions, outline, section: markdown })),
    Promise.all(
      toneChunks.map(async (excerpts, i) => {
        const first = toneChunks.slice(0, i).reduce((n, c) => n + c.length, 0) + 1;
        // 判为"语气丢了"却没给出可用的修订（字段不全），等于发现了问题没有处理：重新核对这一份一次，仍然如此就算核对没完成
        for (let attempt = 0; ; attempt++) {
          const parsed = parseToneChecks(await model.json(hedgeReviewPrompt({ video, excerpts, first, section: markdown }), TONE_SCHEMA), first, excerpts.length);
          if (parsed === null) throw new AppError('summary_invalid', '语气清单核对没有对每一条给出结论');
          if (parsed.malformed.length === 0) return parsed;
          if (attempt >= 1) throw new AppError('summary_invalid', '语气清单核对判为语气丢失的条目没有给出有效修订');
        }
      }),
    ).then((parts) => ({ issues: parts.flatMap((p) => p.issues), malformed: parts.flatMap((p) => p.malformed) })),
  ]).catch((err: unknown) => failReview(err, '对照字幕核对没有完成'));

  // 几路核对基于同一份核对前的文章。依次应用：逐章 → 整篇 → 语气。每次替换都记下它改的是初稿的哪一段（TrackedText），
  // 后面的建议按位置判断是不是和已经改过的地方重叠，不按文字判断：别的段落里出现一样的文字不算。
  const tracked = new TrackedText(markdown);
  const revisions: Revision[] = [];
  const rejected: FinalizeResult['rejected'] = {};
  const count = (reason: RejectReason, n = 1) => (rejected[reason] = (rejected[reason] ?? 0) + n);
  const unapplied: UnappliedSuggestion[] = [];
  interface Pending {
    stage: SuggestionStage;
    issue: ReviewIssue;
    /** 上一轮合并处理给出的修订为什么没能落实 */
    failure?: string;
  }
  let pending: Pending[] = [];

  /** suspect：替换文字和紧挨着的上下文有一段重合。这只是疑似有问题（也可能是正常的纠错），不应用也不拒绝，交给合并处理判断 */
  type Outcome = { result: 'applied' } | { result: 'overlap'; where: Span | null } | { result: 'suspect' } | { result: RejectReason };

  /** 在当前文章的 start 处落实一条修订并记下位置 */
  const commit = (issue: ReviewIssue, start: number, refining: boolean): Outcome => {
    // 修订数上限只管逐章、整篇、语气这三路的建议。合并处理的修订是在已经改过的句子上再改，不代表文章又多了一处问题，不占上限；
    // 否则修订多的文章会因为这个上限让一条必须落实的修订落实不了，整次生成失败。
    if (!refining && revisions.length >= MAX_REVISIONS) return { result: 'limit' };
    const current = tracked.current;
    // 合并处理给出的修订是模型看着当前文章、知道上一次为什么没落实之后给的，不再用"和上下文重复"这个弱信号拦它
    const outcome = applyRevisionAt(current, issue, start, transcriptText, { allowContextRepeat: refining });
    if ('reason' in outcome) return outcome.reason === 'duplicates_context' ? { result: 'suspect' } : { result: outcome.reason };
    // 不能把前面已经改掉的初稿写法又改回来
    if (refining && revisions.some((r) => r.before.trim().length >= 4 && !current.includes(r.before) && outcome.markdown.includes(r.before))) return { result: 'reverts_earlier' };
    tracked.replace({ start, end: start + issue.quote.length }, issue.replacement);
    revisions.push(outcome.applied);
    return { result: 'applied' };
  };

  /**
   * 落实逐章、整篇、语气核对的建议。这些建议都是对着核对前的文章提的，所以先在核对前的文章里确定它指的是哪一处
   *（逐章建议限定在本单元 scope 内），再看那一处现在的状态。不能在当前文章里找：同一句话在初稿里出现两次、
   * 其中一处已被改掉时，当前文章里只剩一处匹配，那不代表建议指的就是剩下的这一处。
   * 返回 applied；或 overlap（它指的那一处已经被改过，where 是那一处在初稿里的位置，确定不了时为 null）；或程序校验拒绝的原因。
   */
  const attempt = (issue: ReviewIssue, scope: Span | null): Outcome => {
    const base = scope ? markdown.slice(scope.start, scope.end) : markdown;
    const offset = scope?.start ?? 0;
    const hits: Span[] = [];
    for (let at = base.indexOf(issue.quote); at >= 0; at = base.indexOf(issue.quote, at + 1)) hits.push({ start: offset + at, end: offset + at + issue.quote.length });
    // 本单元里没有：逐章核对引了别的章里的句子时交给合并处理基于全文判断，否则就是找不到
    if (hits.length === 0) return scope && markdown.includes(issue.quote) ? { result: 'overlap', where: null } : { result: 'quote_not_found' };
    if (hits.length > 1) {
      // 初稿里就不唯一：都没被改过时照旧按"定位不唯一"拒绝；有的已经被改过时，说不清它指哪一处，交给合并处理
      return hits.some((h) => tracked.touched(h)) ? { result: 'overlap', where: null } : { result: 'quote_not_unique' };
    }
    const where = hits[0]!;
    if (tracked.touched(where)) return { result: 'overlap', where };
    return commit(issue, tracked.toCurrent(where).start, false);
  };

  /** 落实合并处理给出的修订。它是对着当前文章提的，按当前文章定位，要求唯一 */
  const refine = (issue: ReviewIssue): Outcome => {
    const current = tracked.current;
    const at = current.indexOf(issue.quote);
    if (at < 0) return { result: 'quote_not_found' };
    if (current.indexOf(issue.quote, at + 1) >= 0) return { result: 'quote_not_unique' };
    return commit(issue, at, true);
  };

  /**
   * 建议指的那一处（初稿坐标 where）现在是不是已经改成了它想要的结果。
   * 把那一处连同改过它的替换合起来看：这段文字现在必须恰好等于"只做这一条建议"会得到的结果，一个字都不差，才算已覆盖。
   * 只要有出入（前一条修订多改或少改了别的地方），程序就证明不了两者一致，交给合并处理，不去猜。
   */
  const coveredAt = (where: Span | null, issue: ReviewIssue): boolean => {
    if (!where || !tracked.touched(where)) return false;
    const region = tracked.region(where);
    const before = region.original.slice(0, where.start - region.start);
    const after = region.original.slice(where.end - region.start);
    return region.current === before + issue.replacement + after;
  };

  const place = (stage: SuggestionStage, issue: ReviewIssue, scope: Span | null) => {
    const outcome = attempt(issue, scope);
    if (outcome.result === 'applied') return;
    if (outcome.result === 'suspect') {
      pending.push({ stage, issue, failure: 'duplicates_context' });
      return;
    }
    if (outcome.result !== 'overlap') {
      count(outcome.result);
      unapplied.push({ stage, disposition: outcome.result, ...issue });
    } else if (!evidenceInTranscript(issue.evidence, transcriptText)) {
      count('evidence_not_in_transcript');
      unapplied.push({ stage, disposition: 'evidence_not_in_transcript', ...issue });
    } else if (coveredAt(outcome.where, issue)) {
      unapplied.push({ stage, disposition: 'covered', ...issue, note: '这一处已由另一条修订改成相同的文字' });
    } else pending.push({ stage, issue });
  };

  let offset = 0;
  for (const [index, section] of sections.entries()) {
    const scope = { start: offset, end: offset + section.length };
    offset = scope.end;
    if (chapterOutcomes[index]!.malformed) count('malformed', chapterOutcomes[index]!.malformed);
    for (const issue of chapterOutcomes[index]!.issues) place('chapter', issue, scope);
  }
  if (fidelity.malformed.length) count('malformed', fidelity.malformed.length);
  for (const issue of fidelity.issues) place('article', issue, null);
  for (const issue of tone.issues) place('tone', issue, null);

  // 重叠而没有确认已改好的建议：交给模型基于当前文章逐条处理。给出的修订落实不了时再处理一轮；
  // 仍有落实不了的，说明有一个已经指出的问题没有解决，这次核对不能算完成。
  for (let round = 1; pending.length > 0; round++) {
    if (round > RECONCILE_ROUNDS) {
      throw new AppError('review_failed', `重叠修订建议的合并处理没有完成：有 ${pending.length} 条建议指出的问题仍未落实（${[...new Set(pending.map((p) => FAILURE_LABEL[p.failure ?? ''] ?? '修订没有通过校验'))].join('、')}）`);
    }
    const batch = pending;
    pending = [];
    const raw = await model
      .json(reconcilePrompt({ video, article: tracked.current, applied: revisions, pending: batch.map((p) => ({ ...p.issue, failure: p.failure })) }), RECONCILE_SCHEMA)
      .catch((err: unknown) => failReview(err, '重叠修订建议的合并处理没有完成'));
    const items = parseReconcile(raw, batch.length);
    if (!items) throw new AppError('review_failed', '重叠修订建议的合并处理没有完成：模型没有对每条建议给出有效结论');
    for (const [index, { stage, issue }] of batch.entries()) {
      const item = items[index]!;
      if (item.status !== 'revise') {
        unapplied.push({ stage, disposition: item.status, ...issue, note: item.note });
        continue;
      }
      const next: ReviewIssue = { type: issue.type, quote: item.quote, replacement: item.replacement, evidence: item.evidence.trim() || issue.evidence, problem: issue.problem };
      const outcome = refine(next);
      if (outcome.result === 'applied') {
        unapplied.push({ stage, disposition: 'superseded', ...issue, note: item.note });
        continue;
      }
      const reason = outcome.result === 'overlap' || outcome.result === 'suspect' ? 'quote_not_found' : outcome.result;
      count(reason);
      unapplied.push({ stage: 'reconcile', disposition: reason, ...next, note: item.note });
      pending.push({ stage, issue, failure: reason });
    }
  }
  const reviewed = tracked.current;

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
