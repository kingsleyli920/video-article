import { describe, expect, it, vi } from 'vitest';
import { LIMITS } from '../../src/shared/limits';
import { AppError } from '../../src/worker/app-error';
import { ClientGone } from '../../src/worker/event-stream';
import { finalizeArticle, groupSections, type FinalizeInput, type FinalizeModel } from '../../src/worker/finalize';
import type { Prompt } from '../../src/worker/gemini';
import { NO_REQUIREMENTS, type Requirements } from '../../src/worker/requirements';
import { fidelityReviewPrompt, reconcilePrompt, RECONCILE_SCHEMA, REVIEW_SCHEMA } from '../../src/worker/review';

const VIDEO = { id: 'mockvideo01', title: 'Maria Lopez on Berlin and the fund', channel: '测试频道', description: '', lengthSeconds: 600 };

const TRANSCRIPT = [
  "[00:00] welcome back to the show, today I'm talking with Maria Lopez",
  '[00:12] >> I moved to Berlin in 2003. Over the next ten years the fund backed Alpha, Beta and Gamma',
  '[01:05] we’re at about five portfolio companies now and I expect that to grow to five or six',
].join('\n\n');

/**
 * 流式初稿，61 字：标题"柏林与基金"5；第一章"柏林岁月"4 + 正文 32（"嘉宾:"3 + 2003 4 + "年那家基金投资了"8 + Alpha 5 + "、"1 + Beta 4 + "和"1 + Gamma 5 + "。"1）；
 * 第二章"现在的组合"5 + 正文 15（"嘉宾:"3 + "现在有五到六家被投公司。"12）。
 */
const DRAFT = '# 柏林与基金\n\n## 柏林岁月\n\n**嘉宾:** 2003 年那家基金投资了 Alpha、Beta 和 Gamma。\n\n## 现在的组合\n\n**嘉宾:** 现在有五到六家被投公司。';

/** 按要求压缩后的修订稿，36 字：5 + 4 +（3 + "2003年搬到柏林。"10）+ 5 +（3 + "现在约五家。"6） */
const REWRITTEN = '# 柏林与基金\n\n## 柏林岁月\n\n**嘉宾:** 2003 年搬到柏林。\n\n## 现在的组合\n\n**嘉宾:** 现在约五家。';

const TIME_ISSUE = {
  type: 'time',
  quote: '2003 年那家基金投资了 Alpha、Beta 和 Gamma。',
  evidence: 'I moved to Berlin in 2003. Over the next ten years the fund backed Alpha, Beta and Gamma',
  problem: '2003 年是嘉宾搬到柏林的时间，不是基金投资的时间',
  replacement: '我 2003 年搬到柏林，之后十年里那家基金先后投资了 Alpha、Beta 和 Gamma。',
};
const QUANTITY_ISSUE = {
  type: 'quantity',
  quote: '现在有五到六家被投公司。',
  evidence: 'we’re at about five portfolio companies now and I expect that to grow to five or six',
  problem: '现在大约五家，五到六家是预期',
  replacement: '现在大约有五家被投公司，预计会增加到五到六家。',
};

const req = (patch: Partial<Requirements>): Requirements => ({ ...NO_REQUIREMENTS, sectionTitles: [], ...patch });

/** 核对请求里 <section> 的内容 */
const sectionOf = (prompt: Prompt) => /<section>\n([\s\S]*)\n<\/section>/.exec(prompt.user)![1]!;
const FIDELITY_SYSTEM = fidelityReviewPrompt({ video: VIDEO, transcriptText: TRANSCRIPT, instructions: '', outline: [], section: DRAFT }).system;
const isFidelity = (prompt: Prompt) => prompt.system === FIDELITY_SYSTEM;
const RECONCILE_SYSTEM = reconcilePrompt({ video: VIDEO, article: '', applied: [], pending: [] }).system;
const isReconcile = (prompt: Prompt) => prompt.system === RECONCILE_SYSTEM;

/**
 * 手写的模型替身：json（核对）按这一单元的原文返回结果，没给 review 时返回"没有问题"；
 * rewrite、reconcile（重叠修订的合并处理）没给时被调用就报错（用例因此能证明"不该修订时没有修订""不该合并时没有调用"）。
 */
function fakeModel(
  options: { review?: (section: string) => unknown; fidelity?: (section: string) => unknown; reconcile?: (prompt: Prompt) => unknown; rewrite?: (prompt: Prompt) => Promise<string> } = {},
) {
  const reviewPrompts: Prompt[] = [];
  const fidelityPrompts: Prompt[] = [];
  const reconcilePrompts: Prompt[] = [];
  const schemas: object[] = [];
  const rewritePrompts: Prompt[] = [];
  const model: FinalizeModel = {
    async json(prompt, schema) {
      schemas.push(schema);
      if (isReconcile(prompt)) {
        reconcilePrompts.push(prompt);
        if (!options.reconcile) throw new Error('这个用例不该调用合并处理');
        return options.reconcile(prompt);
      }
      if (isFidelity(prompt)) {
        fidelityPrompts.push(prompt);
        return options.fidelity ? options.fidelity(sectionOf(prompt)) : { issues: [] };
      }
      reviewPrompts.push(prompt);
      return options.review ? options.review(sectionOf(prompt)) : { issues: [] };
    },
    async rewrite(prompt) {
      rewritePrompts.push(prompt);
      if (!options.rewrite) throw new Error('这个用例不该调用 rewrite');
      return options.rewrite(prompt);
    },
  };
  return { model, reviewPrompts, fidelityPrompts, reconcilePrompts, schemas, rewritePrompts };
}

function input(patch: Partial<FinalizeInput> = {}): FinalizeInput {
  return { draft: DRAFT, video: VIDEO, transcriptText: TRANSCRIPT, instructions: '', requirements: Promise.resolve(NO_REQUIREMENTS), ...patch };
}

/** 记录阶段回调的顺序 */
function stages() {
  const seen: string[] = [];
  return { seen, onStage: async (stage: 'revising' | 'reviewing') => void seen.push(stage) };
}

/** 等 promise 失败并返回错误；成功了就让用例失败 */
async function rejection(work: Promise<unknown>): Promise<AppError> {
  const result = await work.then(
    () => null,
    (err: unknown) => err,
  );
  if (result === null) throw new Error('应该失败却成功了');
  return result as AppError;
}

describe('finalizeArticle：正常路径', () => {
  // 抓：没有约束、没有问题时也改动了文章，或者白白调用一次整篇修订
  it('没有约束、核对没有问题：原样返回，每章一次核对并额外整篇复核一次，不调用 rewrite', async () => {
    const { model, reviewPrompts, fidelityPrompts, schemas, rewritePrompts } = fakeModel();
    const { seen, onStage } = stages();
    const result = await finalizeArticle(input(), model, onStage);
    expect(result).toEqual({
      markdown: DRAFT,
      revisions: [],
      requirements: NO_REQUIREMENTS,
      rejected: {},
      review: { sections: 2, revisions: 0, rewritten: null, checks: [] },
    });
    expect(rewritePrompts).toHaveLength(0);
    expect(seen).toEqual(['reviewing']);
    expect(reviewPrompts.map(sectionOf)).toEqual([
      '# 柏林与基金\n\n## 柏林岁月\n\n**嘉宾:** 2003 年那家基金投资了 Alpha、Beta 和 Gamma。\n\n',
      '## 现在的组合\n\n**嘉宾:** 现在有五到六家被投公司。',
    ]);
    // 每个核对请求都带整段字幕、整篇的章节目录和核对用的 schema
    for (const prompt of reviewPrompts) {
      expect(prompt.user).toContain(`<transcript>\n${TRANSCRIPT}\n</transcript>`);
      expect(prompt.user).toContain('<article_outline note="整篇文章的章节标题，只用来了解这一部分在全文里的位置">\n1. 柏林岁月\n2. 现在的组合\n</article_outline>');
    }
    expect(fidelityPrompts.map(sectionOf)).toEqual([DRAFT]);
    expect(schemas).toEqual([REVIEW_SCHEMA, REVIEW_SCHEMA, REVIEW_SCHEMA]);
  });

  // 抓：已有足够篇幅余量时仍改写；核对结果里没有给用户看的实际数值
  it('有约束且初稿已有两成余量：不修订，checks 写出原上限', async () => {
    const { model, rewritePrompts } = fakeModel();
    const { seen, onStage } = stages();
    const result = await finalizeArticle(input({ requirements: Promise.resolve(req({ maxChars: 80 })) }), model, onStage);
    expect(result.markdown).toBe(DRAFT);
    expect(result.review).toEqual({ sections: 2, revisions: 0, rewritten: null, checks: ['全文 61 字，上限 80 字'] });
    expect(rewritePrompts).toHaveLength(0);
    expect(seen).toEqual(['reviewing']);
  });

  // 抓：核对出的问题没有替换进最终文章；各章的修订拼回去时丢了别的章；丢弃的建议没记数
  it('两章各有一处有依据的问题：都替换，其他文字不动；没有依据的和格式不对的计入 rejected', async () => {
    const fabricated = { ...QUANTITY_ISSUE, quote: '现在有五到六家', evidence: 'the fund now owns six companies' };
    const { model } = fakeModel({
      review: (section) => (section.includes('柏林岁月') ? { issues: [TIME_ISSUE, { type: 'opinion' }] } : { issues: [fabricated, QUANTITY_ISSUE] }),
    });
    const result = await finalizeArticle(input(), model, stages().onStage);
    expect(result.markdown).toBe(
      '# 柏林与基金\n\n## 柏林岁月\n\n**嘉宾:** 我 2003 年搬到柏林，之后十年里那家基金先后投资了 Alpha、Beta 和 Gamma。\n\n## 现在的组合\n\n**嘉宾:** 现在大约有五家被投公司，预计会增加到五到六家。',
    );
    expect(result.revisions).toEqual([
      { type: 'time', before: TIME_ISSUE.quote, after: TIME_ISSUE.replacement, reason: TIME_ISSUE.problem, evidence: TIME_ISSUE.evidence },
      { type: 'quantity', before: QUANTITY_ISSUE.quote, after: QUANTITY_ISSUE.replacement, reason: QUANTITY_ISSUE.problem, evidence: QUANTITY_ISSUE.evidence },
    ]);
    expect(result.rejected).toEqual({ malformed: 1, evidence_not_in_transcript: 1 });
    // 程序校验拒绝的建议连同来源阶段留痕；格式不对的不在内
    expect(result.review).toEqual({
      sections: 2,
      revisions: 2,
      rewritten: null,
      checks: [],
      unapplied: [
        {
          stage: 'chapter',
          disposition: 'evidence_not_in_transcript',
          type: 'quantity',
          quote: '现在有五到六家',
          replacement: '现在大约有五家被投公司，预计会增加到五到六家。',
          problem: '现在大约五家，五到六家是预期',
          evidence: 'the fund now owns six companies',
        },
      ],
    });
  });

  // 抓：初稿超字数时直接报错或截断，而不是让模型修订一次；修订后核对的还是初稿；阶段顺序错
  it('初稿超出上限 → 修订一次后满足：返回修订稿，rewritten 记录前后字数，阶段 revising → reviewing', async () => {
    const { model, rewritePrompts, reviewPrompts, fidelityPrompts } = fakeModel({ rewrite: async () => REWRITTEN });
    const { seen, onStage } = stages();
    const result = await finalizeArticle(input({ instructions: '全文不超过 50 字', requirements: Promise.resolve(req({ maxChars: 50 })) }), model, onStage);
    expect(seen).toEqual(['revising', 'reviewing']);
    expect(result.markdown).toBe(REWRITTEN);
    expect(result.review).toEqual({
      sections: 2,
      revisions: 0,
      rewritten: { unmet: ['全文 61 字，要求不超过 50 字'], charsBefore: 61, charsAfter: 36 },
      checks: ['全文 36 字，上限 50 字'],
    });
    expect(rewritePrompts).toHaveLength(1);
    expect(rewritePrompts[0]!.user).toContain('<unmet_requirements note="程序按统一口径算出来的，以它为准">\n- 全文 61 字，要求不超过 50 字\n</unmet_requirements>');
    expect(rewritePrompts[0]!.user).toContain(`<draft>\n${DRAFT}\n</draft>`);
    expect(rewritePrompts[0]!.user).toContain('<user_requirements>\n全文不超过 50 字\n</user_requirements>');
    // 核对的是修订稿，不是初稿
    expect(reviewPrompts.map(sectionOf)).toEqual(['# 柏林与基金\n\n## 柏林岁月\n\n**嘉宾:** 2003 年搬到柏林。\n\n', '## 现在的组合\n\n**嘉宾:** 现在约五家。']);
    expect(fidelityPrompts.map(sectionOf)).toEqual([REWRITTEN]);
  });

  it('初稿满足原上限但余量不足：仅改写一次，真实 unmet 为空，全部核对使用压缩稿', async () => {
    const requirements = req({ maxChars: 70, chaptersMin: 2, chaptersMax: 2 });
    const { model, rewritePrompts, reviewPrompts, fidelityPrompts } = fakeModel({ rewrite: async () => REWRITTEN });
    const { seen, onStage } = stages();
    const result = await finalizeArticle(input({ instructions: '不超过70字，正好2章', requirements: Promise.resolve(requirements) }), model, onStage);
    expect(seen).toEqual(['revising', 'reviewing']);
    expect(rewritePrompts).toHaveLength(1);
    expect(rewritePrompts[0]!.user).toContain('不超过 56 字');
    expect(rewritePrompts[0]!.user).toContain('<unmet_requirements note="程序按统一口径算出来的，以它为准">\n无\n</unmet_requirements>');
    expect(result.requirements).toEqual(requirements);
    expect(result.review.rewritten).toEqual({ unmet: [], charsBefore: 61, charsAfter: 36 });
    expect(result.review.checks).toEqual(['全文 36 字，上限 70 字', '共 2 章，要求正好 2 章']);
    expect(reviewPrompts.map(sectionOf).join('')).toBe(REWRITTEN);
    expect(fidelityPrompts.map(sectionOf)).toEqual([REWRITTEN]);
  });

  it('预留目标不低于用户下限；模型未达到内部目标但满足原约束时继续，不重复改写', async () => {
    const { model, rewritePrompts } = fakeModel({ rewrite: async () => DRAFT });
    const result = await finalizeArticle(input({ requirements: Promise.resolve(req({ minChars: 60, maxChars: 70 })) }), model, stages().onStage);
    expect(rewritePrompts).toHaveLength(1);
    expect(rewritePrompts[0]!.user).toContain('不超过 60 字');
    expect(result.markdown).toBe(DRAFT);
    expect(result.review.rewritten).toEqual({ unmet: [], charsBefore: 61, charsAfter: 61 });
    expect(result.review.checks).toEqual(['全文 61 字，要求 60 到 70 字']);
  });

  it('用户要求精确字数时不另行压缩，内部目标不能取代用户下限', async () => {
    const { model, rewritePrompts } = fakeModel();
    const result = await finalizeArticle(input({ requirements: Promise.resolve(req({ minChars: 61, maxChars: 61 })) }), model, stages().onStage);
    expect(result.markdown).toBe(DRAFT);
    expect(rewritePrompts).toHaveLength(0);
  });

  it('只为预留篇幅改写也不得低于用户下限或破坏原章节要求', async () => {
    for (const [requirements, revised] of [
      [req({ maxChars: 70, minChars: 40 }), REWRITTEN],
      [req({ maxChars: 70, chaptersMin: 2, chaptersMax: 2 }), '# 标题\n\n## 内容\n\n正文。'],
    ] as const) {
      const { model, rewritePrompts, reviewPrompts, fidelityPrompts } = fakeModel({ rewrite: async () => revised });
      const err = await rejection(finalizeArticle(input({ requirements: Promise.resolve(requirements) }), model, stages().onStage));
      expect(err.code).toBe('requirements_unmet');
      expect(rewritePrompts).toHaveLength(1);
      expect(reviewPrompts).toHaveLength(0);
      expect(fidelityPrompts).toHaveLength(0);
    }
  });

  // 抓：为整篇复核预留连接后，合并时丢了章节或把复核算成额外章节单元
  it('7 章的文章：合并成 4 个核对单元，拼回去等于原文', async () => {
    const draft = `# 七章\n\n${Array.from({ length: 7 }, (_, i) => `## 第${i + 1}章\n\n**嘉宾:** 第${i + 1}章正文。`).join('\n\n')}`;
    const { model, reviewPrompts } = fakeModel();
    const result = await finalizeArticle(input({ draft }), model, stages().onStage);
    expect(result.review.sections).toBe(4);
    expect(reviewPrompts.map(sectionOf).join('')).toBe(draft);
    expect(reviewPrompts.map((p) => sectionOf(p).match(/^## .+$/gm))).toEqual([['## 第1章', '## 第2章'], ['## 第3章', '## 第4章'], ['## 第5章', '## 第6章'], ['## 第7章']]);
  });

  it('10章占满逐章预算时，连同整篇复核也不超过6个并行请求', async () => {
    const draft = `# 十章\n\n${Array.from({ length: 10 }, (_, i) => `## 第${i + 1}章\n\n第${i + 1}章正文。`).join('\n\n')}`;
    const { model, reviewPrompts, fidelityPrompts, schemas } = fakeModel();
    const result = await finalizeArticle(input({ draft }), model, stages().onStage);
    expect(result.review.sections).toBe(5);
    expect(reviewPrompts.map(sectionOf).join('')).toBe(draft);
    expect(fidelityPrompts.map(sectionOf)).toEqual([draft]);
    expect(schemas).toHaveLength(6);
  });
});

describe('finalizeArticle：并行', () => {
  // 抓：各单元串行核对，等待时间是所有章节之和（高档思考每章 30 到 60 秒）
  it('两章与整篇复核都在任何一个请求返回前发出，完成顺序不影响合并', async () => {
    const pending: { section: string; fidelity: boolean; resolve: (value: unknown) => void }[] = [];
    const model: FinalizeModel = {
      json: (prompt) => new Promise((resolve) => pending.push({ section: sectionOf(prompt), fidelity: isFidelity(prompt), resolve })),
      rewrite: async () => {
        throw new Error('不该调用 rewrite');
      },
    };
    const work = finalizeArticle(input(), model, stages().onStage);
    await vi.waitFor(() => expect(pending).toHaveLength(3), { timeout: 500, interval: 5 });
    expect(pending.map((p) => p.fidelity)).toEqual([false, false, true]);
    expect(pending[2]!.section).toBe(DRAFT);
    pending[2]!.resolve({ issues: [QUANTITY_ISSUE] });
    pending[1]!.resolve({ issues: [] });
    pending[0]!.resolve({ issues: [TIME_ISSUE] });
    const result = await work;
    expect(result.markdown).toBe(DRAFT.replace(TIME_ISSUE.quote, TIME_ISSUE.replacement).replace(QUANTITY_ISSUE.quote, QUANTITY_ISSUE.replacement));
    expect(result.revisions.map((r) => r.before)).toEqual([TIME_ISSUE.quote, QUANTITY_ISSUE.quote]);
    expect(result.review.sections).toBe(2);
  });
});

describe('finalizeArticle：整篇语义限定复核', () => {
  // 抓：整篇复核给出与逐章相同的建议时，被当成"定位不到"丢掉而不留痕，或者白白再调一次合并处理
  it('先保留逐章修订，再应用仍可定位的整篇建议；与逐章重复的建议记为 covered，不调合并处理', async () => {
    const { model, reconcilePrompts } = fakeModel({
      review: (section) => ({ issues: section.includes('柏林岁月') ? [TIME_ISSUE] : [] }),
      fidelity: () => ({ issues: [TIME_ISSUE, QUANTITY_ISSUE, { type: 'opinion' }] }),
    });
    const result = await finalizeArticle(input(), model, stages().onStage);
    expect(result.markdown).toBe(DRAFT.replace(TIME_ISSUE.quote, TIME_ISSUE.replacement).replace(QUANTITY_ISSUE.quote, QUANTITY_ISSUE.replacement));
    expect(result.revisions.map((r) => r.before)).toEqual([TIME_ISSUE.quote, QUANTITY_ISSUE.quote]);
    expect(result.rejected).toEqual({ malformed: 1 });
    expect(result.review).toEqual({
      sections: 2,
      revisions: 2,
      rewritten: null,
      checks: [],
      unapplied: [
        {
          stage: 'article',
          disposition: 'covered',
          type: 'time',
          quote: '2003 年那家基金投资了 Alpha、Beta 和 Gamma。',
          replacement: '我 2003 年搬到柏林，之后十年里那家基金先后投资了 Alpha、Beta 和 Gamma。',
          problem: '2003 年是嘉宾搬到柏林的时间，不是基金投资的时间',
          evidence: 'I moved to Berlin in 2003. Over the next ten years the fund backed Alpha, Beta and Gamma',
          note: '另一条修订已写入相同的替换文字',
        },
      ],
    });
    expect(reconcilePrompts).toHaveLength(0);
  });

  it('整篇建议仍受唯一定位、字幕依据与局部结构校验，不会改动别处', async () => {
    const { model } = fakeModel({ fidelity: () => ({ issues: [
      { ...QUANTITY_ISSUE, quote: '**嘉宾:** ', replacement: '**讲者:** ' },
      { ...QUANTITY_ISSUE, evidence: 'There are precisely six companies in the portfolio.' },
      { ...QUANTITY_ISSUE, replacement: '现在大约五家。\n\n### 新标题\n预计更多。' },
    ] }) });
    const result = await finalizeArticle(input(), model, stages().onStage);
    expect(result.markdown).toBe(DRAFT);
    expect(result.revisions).toEqual([]);
    expect(result.rejected).toEqual({ quote_not_unique: 1, evidence_not_in_transcript: 1, structure: 1 });
  });

  it('整篇复核补字后仍须满足用户字数上限，失败不返回可保存结果', async () => {
    const { model, rewritePrompts } = fakeModel({ fidelity: () => ({ issues: [QUANTITY_ISSUE] }), rewrite: async () => DRAFT });
    const save = vi.fn();
    const work = finalizeArticle(input({ requirements: Promise.resolve(req({ maxChars: 61 })) }), model, stages().onStage).then(save);
    expect((await rejection(work)).code).toBe('requirements_unmet');
    expect(rewritePrompts).toHaveLength(1);
    expect(save).not.toHaveBeenCalled();
  });

  it.each([{}, { issues: null }, { issues: '没有问题' }])('仅整篇复核返回无效协议（%j）也失败，不继续保存', async (raw) => {
    const { model } = fakeModel({ fidelity: () => raw });
    const save = vi.fn();
    const err = await rejection(finalizeArticle(input(), model, stages().onStage).then(save));
    expect(err.code).toBe('review_failed');
    expect(save).not.toHaveBeenCalled();
  });

  it('仅整篇复核请求失败时，已完成的逐章结果不能用于保存', async () => {
    const { model } = fakeModel({
      review: () => ({ issues: [TIME_ISSUE] }),
      fidelity: () => { throw new AppError('gemini_busy', 'HTTP 503'); },
    });
    const save = vi.fn();
    expect((await rejection(finalizeArticle(input(), model, stages().onStage).then(save))).code).toBe('review_failed');
    expect(save).not.toHaveBeenCalled();
  });
});

describe('finalizeArticle：重叠修订的合并处理', () => {
  // 审查方反例：主持人的估计被写成嘉宾的说法，金额也错了一个数量级
  const PILOT_TRANSCRIPT = "[00:00] Host: Our pilot cost about 20 dollars. This is my estimate, not the guest's statement.";
  const PILOT_DRAFT = '# 试点\n\n## 费用\n\n嘉宾表示，试点费用为200美元。';
  const EVIDENCE = "Host: Our pilot cost about 20 dollars. This is my estimate, not the guest's statement.";
  /** 逐章核对只改数字 */
  const CHAPTER_FIX = { type: 'quantity', quote: '试点费用为200美元。', evidence: EVIDENCE, problem: '金额是约 20 美元', replacement: '试点费用约为20美元。' };
  /** 整篇复核同时改归属和数字，quote 是初稿的整句 */
  const ARTICLE_FIX = { type: 'attribution', quote: '嘉宾表示，试点费用为200美元。', evidence: EVIDENCE, problem: '这是主持人的估计，不是嘉宾的说法', replacement: '主持人估计，试点费用约为20美元。' };
  /** 只采用逐章修订后的文章 */
  const AFTER_CHAPTER = '# 试点\n\n## 费用\n\n嘉宾表示，试点费用约为20美元。';
  const CHAPTER_REVISION = { type: 'quantity', before: '试点费用为200美元。', after: '试点费用约为20美元。', reason: '金额是约 20 美元', evidence: EVIDENCE };
  /** ARTICLE_FIX 转入合并处理后留下的记录 */
  const superseded = (note: string) => ({
    stage: 'article',
    disposition: 'superseded',
    type: 'attribution',
    quote: '嘉宾表示，试点费用为200美元。',
    replacement: '主持人估计，试点费用约为20美元。',
    problem: '这是主持人的估计，不是嘉宾的说法',
    evidence: EVIDENCE,
    note,
  });
  const verdict = (patch: Record<string, unknown>) => ({ index: 0, status: 'revise', note: '数字已改对，归属仍错', quote: '', replacement: '', evidence: '', ...patch });

  const pilot = (options: { fidelity?: unknown[]; reconcile?: (prompt: Prompt) => unknown }) =>
    fakeModel({ review: () => ({ issues: [CHAPTER_FIX] }), fidelity: () => ({ issues: options.fidelity ?? [ARTICLE_FIX] }), reconcile: options.reconcile });
  const pilotInput = (patch: Partial<FinalizeInput> = {}) => input({ draft: PILOT_DRAFT, transcriptText: PILOT_TRANSCRIPT, ...patch });

  // 抓（审查方反例）：整篇建议因为句子已被逐章修订改过而定位不到，被直接丢掉，最终稿"嘉宾表示，试点费用约为20美元。"归属仍错却照样成功
  it('逐章只改数字、整篇还要改归属：合并处理基于当前文章再改一次，最终稿归属和数字都对', async () => {
    const { model, reconcilePrompts, schemas } = pilot({
      reconcile: () => ({ items: [verdict({ quote: '嘉宾表示，试点费用约为20美元。', replacement: '主持人估计，试点费用约为20美元。' })] }),
    });
    const result = await finalizeArticle(pilotInput(), model, stages().onStage);
    expect(result.markdown).toBe('# 试点\n\n## 费用\n\n主持人估计，试点费用约为20美元。');
    expect(result.revisions).toEqual([
      CHAPTER_REVISION,
      { type: 'attribution', before: '嘉宾表示，试点费用约为20美元。', after: '主持人估计，试点费用约为20美元。', reason: '这是主持人的估计，不是嘉宾的说法', evidence: EVIDENCE },
    ]);
    expect(result.review).toEqual({ sections: 1, revisions: 2, rewritten: null, checks: [], unapplied: [superseded('数字已改对，归属仍错')] });
    expect(result.rejected).toEqual({});
    // 合并请求只发一次，基于当前文章（已含逐章修订），带已采用的修订
    expect(reconcilePrompts).toHaveLength(1);
    expect(reconcilePrompts[0]!.user).toContain(`<article>\n${AFTER_CHAPTER}\n</article>`);
    expect(reconcilePrompts[0]!.user).toContain('"before": "试点费用为200美元。"');
    expect(schemas.at(-1)).toBe(RECONCILE_SCHEMA);
  });

  // 抓：两路给出一模一样的修订时也去调合并模型（白白多一次请求），或者没有留痕
  it('两路给出相同的修订：记为 covered，不调合并处理', async () => {
    const { model, reconcilePrompts } = pilot({ fidelity: [CHAPTER_FIX] });
    const result = await finalizeArticle(pilotInput(), model, stages().onStage);
    expect(result.markdown).toBe(AFTER_CHAPTER);
    expect(result.revisions).toEqual([CHAPTER_REVISION]);
    expect(result.review.unapplied).toEqual([
      { stage: 'article', disposition: 'covered', type: 'quantity', quote: '试点费用为200美元。', replacement: '试点费用约为20美元。', problem: '金额是约 20 美元', evidence: EVIDENCE, note: '另一条修订已写入相同的替换文字' },
    ]);
    expect(reconcilePrompts).toHaveLength(0);
  });

  // 抓：合并处理判定"已改正"或"建议不成立"时仍改动文章，或者没有把结论和理由留痕
  it.each([
    ['covered', '当前文章已经改正'],
    ['unfounded', '依据不支持这条建议'],
  ])('合并处理返回 %s：文章保持逐章修订后的样子，建议连同理由记进 unapplied', async (status, note) => {
    const { model } = pilot({ reconcile: () => ({ items: [verdict({ status, note })] }) });
    const result = await finalizeArticle(pilotInput(), model, stages().onStage);
    expect(result.markdown).toBe(AFTER_CHAPTER);
    expect(result.revisions).toEqual([CHAPTER_REVISION]);
    expect(result.review.unapplied).toEqual([{ ...superseded(note), disposition: status }]);
  });

  // 抓：合并处理给出的修订把逐章已改对的数字（200 → 约 20）又改回初稿写法，也被采用
  it('合并处理的修订把初稿写法改回来：拒绝为 reverts_earlier，前一步的修正保留', async () => {
    const { model } = pilot({ reconcile: () => ({ items: [verdict({ quote: '嘉宾表示，试点费用约为20美元。', replacement: '主持人估计，试点费用为200美元。', note: '改归属' })] }) });
    const result = await finalizeArticle(pilotInput(), model, stages().onStage);
    expect(result.markdown).toBe(AFTER_CHAPTER);
    expect(result.revisions).toEqual([CHAPTER_REVISION]);
    expect(result.rejected).toEqual({ reverts_earlier: 1 });
    expect(result.review.unapplied).toEqual([
      superseded('改归属'),
      { stage: 'reconcile', disposition: 'reverts_earlier', type: 'attribution', quote: '嘉宾表示，试点费用约为20美元。', replacement: '主持人估计，试点费用为200美元。', problem: '这是主持人的估计，不是嘉宾的说法', evidence: EVIDENCE, note: '改归属' },
    ]);
  });

  // 抓：合并处理给出的修订绕过了逐章和整篇修订都要过的校验（定位、唯一、字幕依据）
  it.each([
    ['quote 在当前文章里找不到', { quote: '主持人表示，试点费用约为20美元。', replacement: '主持人估计，试点费用约为20美元。' }, 'quote_not_found', EVIDENCE, { quote_not_found: 1 }],
    ['quote 在当前文章里出现两次', { quote: '试点', replacement: '试点项目' }, 'quote_not_unique', EVIDENCE, { quote_not_unique: 1 }],
    [
      'evidence 不在字幕里',
      { quote: '嘉宾表示，试点费用约为20美元。', replacement: '主持人估计，试点费用约为20美元。', evidence: 'The guest said the pilot cost 20 dollars.' },
      'evidence_not_in_transcript',
      'The guest said the pilot cost 20 dollars.',
      { evidence_not_in_transcript: 1 },
    ],
  ])('合并处理的修订%s：拒绝，记 stage reconcile，文章不变', async (_label, patch, reason, evidence, rejected) => {
    const { model } = pilot({ reconcile: () => ({ items: [verdict({ ...patch, note: '还要改' })] }) });
    const result = await finalizeArticle(pilotInput(), model, stages().onStage);
    expect(result.markdown).toBe(AFTER_CHAPTER);
    expect(result.revisions).toEqual([CHAPTER_REVISION]);
    expect(result.review.unapplied).toEqual([
      superseded('还要改'),
      { stage: 'reconcile', disposition: reason, type: 'attribution', quote: patch.quote, replacement: patch.replacement, problem: '这是主持人的估计，不是嘉宾的说法', evidence, note: '还要改' },
    ]);
    expect(result.rejected).toEqual(rejected);
  });

  // 抓：重叠建议的依据本身不在字幕里时也送去合并处理（模型可能据此改文章）
  it('重叠建议的 evidence 不在字幕里：直接记 evidence_not_in_transcript，不调合并处理', async () => {
    const { model, reconcilePrompts } = pilot({ fidelity: [{ ...ARTICLE_FIX, evidence: 'The guest said it cost about 20 dollars' }] });
    const result = await finalizeArticle(pilotInput(), model, stages().onStage);
    expect(result.markdown).toBe(AFTER_CHAPTER);
    expect(result.review.unapplied).toEqual([
      { stage: 'article', disposition: 'evidence_not_in_transcript', type: 'attribution', quote: '嘉宾表示，试点费用为200美元。', replacement: '主持人估计，试点费用约为20美元。', problem: '这是主持人的估计，不是嘉宾的说法', evidence: 'The guest said it cost about 20 dollars' },
    ]);
    expect(reconcilePrompts).toHaveLength(0);
  });

  // 抓：原本就不在初稿里的 quote（模型编的）也被当成"重叠"送去合并处理
  it('quote 原本就不在初稿里：直接 quote_not_found，不进合并处理', async () => {
    const { model, reconcilePrompts } = pilot({ fidelity: [{ ...ARTICLE_FIX, quote: '嘉宾说试点很便宜。' }] });
    const result = await finalizeArticle(pilotInput(), model, stages().onStage);
    expect(result.markdown).toBe(AFTER_CHAPTER);
    expect(result.review.unapplied).toEqual([
      { stage: 'article', disposition: 'quote_not_found', type: 'attribution', quote: '嘉宾说试点很便宜。', replacement: '主持人估计，试点费用约为20美元。', problem: '这是主持人的估计，不是嘉宾的说法', evidence: EVIDENCE },
    ]);
    expect(result.rejected).toEqual({ quote_not_found: 1 });
    expect(reconcilePrompts).toHaveLength(0);
  });

  // 抓：合并处理漏给、重复给或格式不对的结论被当成"处理过"，没处理的建议悄悄消失，文章照样保存
  const SECOND = { type: 'unsupported', quote: '费用为200美元', evidence: 'Our pilot cost about 20 dollars. This is my estimate', problem: '这是主持人的估计', replacement: '费用约为20美元，是主持人的估计' };
  it.each<[string, unknown[], unknown]>([
    ['缺条目', [ARTICLE_FIX], { items: [] }],
    ['index 重复', [ARTICLE_FIX, SECOND], { items: [verdict({ status: 'covered' }), verdict({ status: 'covered' })] }],
    ['缺 items', [ARTICLE_FIX], {}],
    ['status 无效', [ARTICLE_FIX], { items: [verdict({ status: 'fixed' })] }],
  ])('合并处理响应%s：review_failed，不返回可保存的结果', async (_label, fidelity, raw) => {
    const { model, reconcilePrompts } = pilot({ fidelity, reconcile: () => raw });
    const save = vi.fn();
    const err = await rejection(finalizeArticle(pilotInput(), model, stages().onStage).then(save));
    expect({ code: err.code, message: err.message }).toEqual({
      code: 'review_failed',
      message: '内容核对没有完成，这次生成没有保存（重叠修订建议的合并处理没有完成：模型没有对每条建议给出有效结论）',
    });
    expect(reconcilePrompts).toHaveLength(1);
    expect(save).not.toHaveBeenCalled();
  });

  // 抓：合并请求失败时退回"只采用逐章修订"的文章保存；或者账单错误被包成 review_failed
  it('合并处理请求失败（繁忙）：review_failed，说明是哪一步', async () => {
    const { model } = pilot({ reconcile: () => { throw new AppError('gemini_busy', 'HTTP 503'); } });
    const save = vi.fn();
    const err = await rejection(finalizeArticle(pilotInput(), model, stages().onStage).then(save));
    expect({ code: err.code, message: err.message }).toEqual({
      code: 'review_failed',
      message: '内容核对没有完成，这次生成没有保存（重叠修订建议的合并处理没有完成：Gemini 模型繁忙，请稍后重试（HTTP 503））',
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('合并处理请求返回 402：gemini_billing 原样抛出', async () => {
    const original = new AppError('gemini_billing');
    const { model } = pilot({ reconcile: () => { throw original; } });
    expect(await rejection(finalizeArticle(pilotInput(), model, stages().onStage))).toBe(original);
  });
});

describe('finalizeArticle：约束不满足', () => {
  // 抓：修订稿仍超字数时照样保存，用户以为满足了要求
  it('修订稿仍超出上限：requirements_unmet，带实际字数和上限，不再核对', async () => {
    const { model, reviewPrompts } = fakeModel({ rewrite: async () => DRAFT });
    const err = await rejection(finalizeArticle(input({ requirements: Promise.resolve(req({ maxChars: 50 })) }), model, stages().onStage));
    expect(err).toBeInstanceOf(AppError);
    expect({ code: err.code, message: err.message }).toEqual({ code: 'requirements_unmet', message: '文章没有满足生成要求里的硬性约束，修订后仍不满足（全文 61 字，要求不超过 50 字）' });
    expect(reviewPrompts).toHaveLength(0);
  });

  // 抓：修订稿结构坏了（没有章节）也被采用，5W1H 找不到章节
  it('修订稿结构无效：requirements_unmet，说明结构问题', async () => {
    const { model } = fakeModel({ rewrite: async () => '# 柏林与基金\n\n压缩成了一段，没有章节。' });
    const err = await rejection(finalizeArticle(input({ requirements: Promise.resolve(req({ maxChars: 50 })) }), model, stages().onStage));
    expect({ code: err.code, message: err.message }).toEqual({ code: 'requirements_unmet', message: '文章没有满足生成要求里的硬性约束，修订后仍不满足（没有二级标题章节）' });
  });

  // 抓：局部修订之后不再复查约束，替换让文章超出上限也照样保存
  it('初稿正好在上限上，局部修订后超出：requirements_unmet', async () => {
    // 替换把 29 字的句子换成 42 字的句子：61 - 29 + 42 = 74
    const { model } = fakeModel({ review: (section) => ({ issues: section.includes('柏林岁月') ? [TIME_ISSUE] : [] }), rewrite: async () => DRAFT });
    const err = await rejection(finalizeArticle(input({ requirements: Promise.resolve(req({ maxChars: 61 })) }), model, stages().onStage));
    expect({ code: err.code, message: err.message }).toEqual({ code: 'requirements_unmet', message: '文章没有满足生成要求里的硬性约束，修订后仍不满足（全文 74 字，要求不超过 61 字）' });
  });

  // 抓：一条会把章节标题删空的修订建议被采用（文章结构坏掉），或者因为它让整次生成失败
  it('把章节标题的文字删空的修订建议：只丢弃这一条，文章不变，照常完成', async () => {
    const emptyTitle = { ...TIME_ISSUE, type: 'language', quote: '柏林岁月', replacement: '' };
    const { model } = fakeModel({ review: (section) => ({ issues: section.includes('柏林岁月') ? [emptyTitle] : [] }) });
    const result = await finalizeArticle(input(), model, stages().onStage);
    expect(result.markdown).toBe(input().draft);
    expect(result.revisions).toEqual([]);
    expect(result.rejected).toEqual({ structure: 1 });
  });
});

describe('finalizeArticle：全局文章长度保护', () => {
  const prefix = '# 标题\n\n## 内容\n\n';
  const atLimit = `${prefix}句${'a'.repeat(LIMITS.articleChars - prefix.length - 1)}`;

  it('没有用户字数要求时，恰好达到全局上限的文章仍可完成', async () => {
    const { model } = fakeModel();
    const result = await finalizeArticle(input({ draft: atLimit }), model, stages().onStage);
    expect(result.markdown).toBe(atLimit);
  });

  it('全文重写满足章数要求但超过全局长度上限：拒绝，不再核对', async () => {
    const oversized = `# 标题\n\n## 一\n\n${'a'.repeat(LIMITS.articleChars)}\n\n## 二\n\n正文。\n\n## 三\n\n正文。`;
    const { model, reviewPrompts } = fakeModel({ rewrite: async () => oversized });
    const err = await rejection(finalizeArticle(input({ requirements: Promise.resolve(req({ chaptersMin: 3, chaptersMax: 3 })) }), model, stages().onStage));
    expect(err.code).toBe('article_too_long');
    expect(reviewPrompts).toHaveLength(0);
  });

  it('局部修订把文章推过全局长度上限：拒绝最终稿', async () => {
    const { model } = fakeModel({ review: () => ({ issues: [{ ...TIME_ISSUE, quote: '句', replacement: '句子' }] }) });
    const err = await rejection(finalizeArticle(input({ draft: atLimit }), model, stages().onStage));
    expect(err.code).toBe('article_too_long');
  });

  it('整篇语义限定复核把文章推过全局长度上限：也拒绝最终稿', async () => {
    const { model } = fakeModel({ fidelity: () => ({ issues: [{ ...TIME_ISSUE, quote: '句', replacement: '句子' }] }) });
    const save = vi.fn();
    const err = await rejection(finalizeArticle(input({ draft: atLimit }), model, stages().onStage).then(save));
    expect(err.code).toBe('article_too_long');
    expect(save).not.toHaveBeenCalled();
  });
});

describe('finalizeArticle：模型调用失败', () => {
  it.each([[{}], [{ issues: null }], [{ issues: '没有问题' }]])('核对结果整体结构无效（%j）：review_failed，不能当作没有问题', async (raw) => {
    const { model } = fakeModel({ review: () => raw });
    const err = await rejection(finalizeArticle(input(), model, stages().onStage));
    expect(err.code).toBe('review_failed');
    expect(err.message).toContain('核对结果不是有效的问题列表');
  });

  it('重写流触发全局长度保护：保留 article_too_long 错误', async () => {
    const original = new AppError('article_too_long');
    const { model } = fakeModel({ rewrite: () => Promise.reject(original) });
    expect(await rejection(finalizeArticle(input({ requirements: Promise.resolve(req({ maxChars: 50 })) }), model, stages().onStage))).toBe(original);
  });

  // 抓：约束提取失败时当成"没有约束"放过去，或者报成和核对无关的错误
  it('约束提取失败：review_failed，说明是哪一步', async () => {
    const { model, reviewPrompts } = fakeModel();
    const requirements = Promise.reject(new AppError('gemini_busy', 'HTTP 503'));
    const err = await rejection(finalizeArticle(input({ requirements }), model, stages().onStage));
    expect({ code: err.code, message: err.message }).toEqual({
      code: 'review_failed',
      message: '内容核对没有完成，这次生成没有保存（没能确认生成要求里的硬性约束：Gemini 模型繁忙，请稍后重试（HTTP 503））',
    });
    expect(reviewPrompts).toHaveLength(0);
  });

  // 抓：修订请求失败（繁忙、被截断）时把没满足要求的初稿保存下来
  it.each([
    [new AppError('gemini_busy', '模型超过 9 秒没有响应'), '内容核对没有完成，这次生成没有保存（按生成要求修订没有完成：Gemini 模型繁忙，请稍后重试（模型超过 9 秒没有响应））'],
    [new AppError('truncated'), '内容核对没有完成，这次生成没有保存（按生成要求修订没有完成：输出达到长度上限，文章不完整）'],
  ])('修订调用失败（%s）：review_failed', async (error, message) => {
    const { model } = fakeModel({ rewrite: () => Promise.reject(error) });
    const err = await rejection(finalizeArticle(input({ requirements: Promise.resolve(req({ maxChars: 50 })) }), model, stages().onStage));
    expect({ code: err.code, message: err.message }).toEqual({ code: 'review_failed', message });
  });

  // 抓：某一章核对失败时其他章的结果照样保存；结构化输出解析失败的文案里出现"总结"
  it.each([
    [new AppError('summary_invalid', '不是合法 JSON'), '内容核对没有完成，这次生成没有保存（对照字幕核对没有完成：模型返回的格式无效（不是合法 JSON））'],
    [new AppError('summary_invalid'), '内容核对没有完成，这次生成没有保存（对照字幕核对没有完成：模型返回的格式无效）'],
    [new AppError('gemini_busy', 'HTTP 503'), '内容核对没有完成，这次生成没有保存（对照字幕核对没有完成：Gemini 模型繁忙，请稍后重试（HTTP 503））'],
  ])('第二章核对失败（%s）：review_failed', async (error, message) => {
    const { model } = fakeModel({
      review: (section) => {
        if (section.includes('现在的组合')) throw error;
        return { issues: [TIME_ISSUE] };
      },
    });
    const err = await rejection(finalizeArticle(input(), model, stages().onStage));
    expect({ code: err.code, message: err.message }).toEqual({ code: 'review_failed', message });
  });

  // 抓：账单、额度、地区错误被包成"核对没有完成"，用户看不出要去充值或换地区
  it.each(['gemini_billing', 'gemini_quota', 'gemini_region'] as const)('核对返回 %s：原样抛出', async (code) => {
    const original = new AppError(code);
    const { model } = fakeModel({
      review: () => {
        throw original;
      },
    });
    expect(await rejection(finalizeArticle(input(), model, stages().onStage))).toBe(original);
  });

  // 抓：约束提取确认不了（requirements_unconfirmed）被包成 review_failed 或当成没有约束继续核对、保存
  it('约束提取确认不了：requirements_unconfirmed 原样抛出，不核对', async () => {
    const original = new AppError('requirements_unconfirmed', '提取了 3 次，字数要求仍和原话对不上');
    const { model, reviewPrompts, fidelityPrompts } = fakeModel();
    const err = await rejection(finalizeArticle(input({ instructions: '不超过1500字', requirements: Promise.reject(original) }), model, stages().onStage));
    expect(err).toBe(original);
    expect(reviewPrompts).toHaveLength(0);
    expect(fidelityPrompts).toHaveLength(0);
  });

  // 抓：约束提取时的 402 被包成 review_failed
  it('约束提取返回 402（gemini_billing）：原样抛出', async () => {
    const original = new AppError('gemini_billing');
    const err = await rejection(finalizeArticle(input({ requirements: Promise.reject(original) }), fakeModel().model, stages().onStage));
    expect(err).toBe(original);
    expect(err.message).toBe('Gemini 账户的预付额度已用完，暂时无法生成');
  });

  // 抓：客户端断开（ClientGone）被包成 review_failed，服务端还去发错误事件
  it('核对时客户端断开：ClientGone 原样抛出', async () => {
    const gone = new ClientGone('disconnected');
    const { model } = fakeModel({
      review: () => {
        throw gone;
      },
    });
    expect(await rejection(finalizeArticle(input(), model, stages().onStage))).toBe(gone);
  });
});

describe('groupSections', () => {
  // 抓：合并后的单元数超过上限，或者合并时丢了、重复了章节
  it('7 个单元、上限 6：相邻两两合并成 4 个，拼回去不变', () => {
    const sections = ['甲\n\n', '乙\n\n', '丙\n\n', '丁\n\n', '戊\n\n', '己\n\n', '庚'];
    expect(groupSections(sections, 6)).toEqual(['甲\n\n乙\n\n', '丙\n\n丁\n\n', '戊\n\n己\n\n', '庚']);
  });

  it('13 个单元、上限 6：每 3 个合并，5 个单元', () => {
    const sections = Array.from({ length: 13 }, (_, i) => `${i + 1};`);
    expect(groupSections(sections, 6)).toEqual(['1;2;3;', '4;5;6;', '7;8;9;', '10;11;12;', '13;']);
  });

  // 抓：没超过上限也合并，核对变粗
  it('不超过上限：原样返回', () => {
    expect(groupSections(['甲', '乙', '丙', '丁', '戊', '己'], 6)).toEqual(['甲', '乙', '丙', '丁', '戊', '己']);
  });
});
