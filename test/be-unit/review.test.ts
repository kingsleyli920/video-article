import { describe, expect, it } from 'vitest';
import { applyRevisions, fidelityReviewPrompt, normalizeEvidence, parseIssues, reviewPrompt, splitForReview, type ReviewIssue } from '../../src/worker/review';
import { geminiPurpose } from '../fixtures/upstream';

/** 整理后的字幕（和 prepareTranscript 的输出同一种形状：段首时间戳、换人标记 >>、弯引号原样） */
const TRANSCRIPT = [
  "[00:00] welcome back to the show, today I'm talking with Maria Lopez",
  '[00:12] >> I moved to Berlin in 2003. Over the next ten years the fund backed Alpha, Beta and Gamma',
  '[01:05] we’re at about five portfolio companies now and I expect that to grow to five or six',
  '[02:10] we raised $500 million for the second fund',
].join('\n\n');

describe('整篇语义限定复核输入', () => {
  it('保留完整文章、整段字幕、要求和目录，使用独立系统任务但保持review接口分类', () => {
    const markdown = '# 采访笔记\n\n## 现在\n\n当前大约五家。\n\n## 未来\n\n未来可能六家。';
    const input = {
      video: { id: 'mockvideo01', title: '采访', channel: '频道', description: '本期受访者 Maria Lopez', lengthSeconds: 120 },
      transcriptText: TRANSCRIPT,
      instructions: '保留说话人及不确定语气',
      outline: ['现在', '未来'],
      section: markdown,
    };
    const chapter = reviewPrompt(input);
    const fidelity = fidelityReviewPrompt(input);
    expect(fidelity.user).toBe(chapter.user);
    expect(fidelity.user).toContain(`<section>\n${markdown}\n</section>`);
    expect(fidelity.user).toContain(`<transcript>\n${TRANSCRIPT}\n</transcript>`);
    expect(fidelity.user).toContain(input.instructions);
    expect(fidelity.user).toContain('1. 现在\n2. 未来');
    expect(fidelity.user).toContain(input.video.description);
    expect(fidelity.system).not.toBe(chapter.system);
    for (const prompt of [chapter, fidelity]) {
      expect(geminiPurpose('/gemini/mock:generateContent', { systemInstruction: { parts: [{ text: prompt.system }] } })).toBe('review');
    }
  });
});

/** 一个核对单元：一章，两段嘉宾发言 */
const SECTION = '## 柏林岁月\n\n**嘉宾:** 2003 年那家基金投资了 Alpha、Beta 和 Gamma。\n\n**嘉宾:** 现在有五到六家被投公司，以后还会更多。\n\n**嘉宾:** 第二期基金募资 5 亿元。\n\n';

const TIME_ISSUE: ReviewIssue = {
  type: 'time',
  quote: '2003 年那家基金投资了 Alpha、Beta 和 Gamma。',
  evidence: 'I moved to Berlin in 2003. Over the next ten years the fund backed Alpha, Beta and Gamma',
  problem: '2003 年是嘉宾搬到柏林的时间，不是基金投资的时间',
  replacement: '我 2003 年搬到柏林，之后十年里那家基金先后投资了 Alpha、Beta 和 Gamma。',
};

const QUANTITY_ISSUE: ReviewIssue = {
  type: 'quantity',
  quote: '现在有五到六家被投公司',
  evidence: 'we’re at about five portfolio companies now and I expect that to grow to five or six',
  problem: '现在大约五家，五到六家是预期',
  replacement: '现在大约有五家被投公司，预计会增加到五到六家',
};

/** 以 QUANTITY_ISSUE 为底，只改给出的字段 */
const quantity = (patch: Partial<ReviewIssue>): ReviewIssue => ({ ...QUANTITY_ISSUE, ...patch });

describe('parseIssues', () => {
  // 抓：一条结构不对的条目让整次核对作废，或者把坏条目当成正常问题去替换
  it('结构不对的条目进 malformed，其余条目照常返回，problem 去掉首尾空白', () => {
    const raw = {
      issues: [
        TIME_ISSUE,
        { type: 'opinion', quote: '现在有五到六家被投公司', evidence: 'we’re at about five portfolio companies', problem: '措辞', replacement: '现在有五家' },
        { type: 'time', quote: '   ', evidence: 'I moved to Berlin in 2003', problem: '空引文', replacement: '我' },
        { type: 'quantity', quote: '五到六家', evidence: 56, problem: '证据不是字符串', replacement: '五家' },
        { type: 'quantity', quote: '五到六家', evidence: 'grow to five or six', problem: '缺 replacement' },
        null,
        '把 2003 年改成 2013 年',
        { type: 'language', quote: 'Alpha、Beta 和 Gamma', evidence: 'the fund backed Alpha, Beta and Gamma', problem: '  专名保留英文即可  ', replacement: '' },
      ],
    };
    expect(parseIssues(raw)).toEqual({
      issues: [
        TIME_ISSUE,
        { type: 'language', quote: 'Alpha、Beta 和 Gamma', evidence: 'the fund backed Alpha, Beta and Gamma', problem: '专名保留英文即可', replacement: '' },
      ],
      malformed: [
        { type: 'opinion', quote: '现在有五到六家被投公司', evidence: 'we’re at about five portfolio companies', problem: '措辞', replacement: '现在有五家' },
        { type: 'time', quote: '   ', evidence: 'I moved to Berlin in 2003', problem: '空引文', replacement: '我' },
        { type: 'quantity', quote: '五到六家', evidence: 56, problem: '证据不是字符串', replacement: '五家' },
        { type: 'quantity', quote: '五到六家', evidence: 'grow to five or six', problem: '缺 replacement' },
        null,
        '把 2003 年改成 2013 年',
      ],
    });
  });

  // 整体没有合法的问题列表，不能和“列表有效但个别建议坏了”混为一谈。
  it.each([[null], ['这不是 JSON'], [{}], [{ issues: null }], [{ issues: '没有问题' }], [[TIME_ISSUE]]])('整体结构不对（%j）：返回 null，调用方必须让核对失败', (raw) => {
    expect(parseIssues(raw)).toBeNull();
  });

  // 抓：空数组被当成格式错误
  it('issues 是空数组：没有问题，也没有 malformed', () => {
    expect(parseIssues({ issues: [] })).toEqual({ issues: [], malformed: [] });
  });
});

describe('applyRevisions：正常采用', () => {
  // 抓：有字幕依据、能唯一定位的修订没有被替换，或者 Revision 记录字段对不上
  it('一处修订：只替换 quote，其余文字一字不动，记录 before/after/reason/evidence', () => {
    const outcome = applyRevisions(SECTION, [{ ...TIME_ISSUE, evidence: `  ${TIME_ISSUE.evidence}  ` }], TRANSCRIPT);
    expect(outcome).toEqual({
      markdown: '## 柏林岁月\n\n**嘉宾:** 我 2003 年搬到柏林，之后十年里那家基金先后投资了 Alpha、Beta 和 Gamma。\n\n**嘉宾:** 现在有五到六家被投公司，以后还会更多。\n\n**嘉宾:** 第二期基金募资 5 亿元。\n\n',
      applied: [
        {
          type: 'time',
          before: '2003 年那家基金投资了 Alpha、Beta 和 Gamma。',
          after: '我 2003 年搬到柏林，之后十年里那家基金先后投资了 Alpha、Beta 和 Gamma。',
          reason: '2003 年是嘉宾搬到柏林的时间，不是基金投资的时间',
          evidence: 'I moved to Berlin in 2003. Over the next ten years the fund backed Alpha, Beta and Gamma',
        },
      ],
      rejected: [],
    });
  });

  // 抓：多处修订只生效第一处；后面的条目还在原稿上定位（被前一处改掉的句子照样被替换，或前一处造出的重复没被发现）
  it('同一单元多处依次替换：后面的条目在已经替换过的文章上定位', () => {
    // 第一处把"那家基金投资了"改成了"那家基金先后投资了"：这一条在原稿上找得到，在当前文章上找不到
    const removedByFirst = quantity({ quote: '那家基金投资了', replacement: '那家基金投了' });
    // "预计会增加到" 只出现在第二处的 replacement 里：原稿上找不到，当前文章上能找到
    const onlyAfterSecond = quantity({ quote: '预计会增加到五到六家', replacement: '他预计会增加到五到六家' });
    const outcome = applyRevisions(SECTION, [TIME_ISSUE, QUANTITY_ISSUE, removedByFirst, onlyAfterSecond], TRANSCRIPT);
    expect(outcome.markdown).toBe(
      '## 柏林岁月\n\n**嘉宾:** 我 2003 年搬到柏林，之后十年里那家基金先后投资了 Alpha、Beta 和 Gamma。\n\n**嘉宾:** 现在大约有五家被投公司，他预计会增加到五到六家，以后还会更多。\n\n**嘉宾:** 第二期基金募资 5 亿元。\n\n',
    );
    expect(outcome.applied.map((r) => r.before)).toEqual(['2003 年那家基金投资了 Alpha、Beta 和 Gamma。', '现在有五到六家被投公司', '预计会增加到五到六家']);
    expect(outcome.rejected).toEqual([{ issue: removedByFirst, reason: 'quote_not_found' }]);
  });

  // 抓：前一处修订造出第二个相同片段后，后一处仍然替换（可能改到别处）
  it('前一处修订让后一处的 quote 出现两次：后一处丢弃为 quote_not_unique', () => {
    const first = quantity({ quote: '第二期基金募资 5 亿元', replacement: '第二期基金募资 5 亿美元，以后还会更多', evidence: 'we raised $500 million for the second fund' });
    const second = quantity({ quote: '以后还会更多', replacement: '以后还会增加' });
    const outcome = applyRevisions(SECTION, [first, second], TRANSCRIPT);
    expect(outcome.markdown).toBe('## 柏林岁月\n\n**嘉宾:** 2003 年那家基金投资了 Alpha、Beta 和 Gamma。\n\n**嘉宾:** 现在有五到六家被投公司，以后还会更多。\n\n**嘉宾:** 第二期基金募资 5 亿美元，以后还会更多。\n\n');
    expect(outcome.rejected).toEqual([{ issue: second, reason: 'quote_not_unique' }]);
  });

  // 抓：用 String.replace 的字符串形式替换，replacement 里的 $& $1 $$ $` 被当成替换模式展开
  it('replacement 里有 $& $1 $$ $` 时按字面替换', () => {
    const issue = quantity({
      quote: '第二期基金募资 5 亿元',
      evidence: 'we raised $500 million for the second fund',
      replacement: '第二期基金募资 $500 million（$& 和 $1、$$、$` 都是原样）',
    });
    const outcome = applyRevisions(SECTION, [issue], TRANSCRIPT);
    expect(outcome.markdown).toBe(
      '## 柏林岁月\n\n**嘉宾:** 2003 年那家基金投资了 Alpha、Beta 和 Gamma。\n\n**嘉宾:** 现在有五到六家被投公司，以后还会更多。\n\n**嘉宾:** 第二期基金募资 $500 million（$& 和 $1、$$、$` 都是原样）。\n\n',
    );
    expect(outcome.applied).toHaveLength(1);
  });

  // 抓：标题行里的文字不许改（只该禁止去掉 # 标记）
  it('标题行内的文字可以改，只要 # 标记还在', () => {
    const issue = quantity({ quote: '## 柏林岁月', replacement: '## 在柏林的十年', evidence: 'I moved to Berlin in 2003. Over the next ten years' });
    const outcome = applyRevisions(SECTION, [issue], TRANSCRIPT);
    expect(outcome.markdown.startsWith('## 在柏林的十年\n\n**嘉宾:** 2003 年')).toBe(true);
    expect(outcome.rejected).toEqual([]);
  });

  // 抓：删掉一行里没有依据的半句也被当成"删空整行"拒绝
  it('replacement 为空、但只删掉一行里的半句：采用', () => {
    const issue = quantity({ type: 'unsupported', quote: '，以后还会更多', replacement: '' });
    const outcome = applyRevisions(SECTION, [issue], TRANSCRIPT);
    expect(outcome.markdown).toBe('## 柏林岁月\n\n**嘉宾:** 2003 年那家基金投资了 Alpha、Beta 和 Gamma。\n\n**嘉宾:** 现在有五到六家被投公司。\n\n**嘉宾:** 第二期基金募资 5 亿元。\n\n');
    expect(outcome.applied).toEqual([{ type: 'unsupported', before: '，以后还会更多', after: '', reason: '现在大约五家，五到六家是预期', evidence: QUANTITY_ISSUE.evidence }]);
  });
});

describe('applyRevisions：evidence 核对', () => {
  // 抓：模型把字幕里不相邻的两句拼在一起时整条被拒；" … " 分隔的两段没有分别核对
  it.each([
    ['" … " 分隔', 'I moved to Berlin in 2003 … the fund backed Alpha, Beta and Gamma'],
    ['"..." 分隔', 'I moved to Berlin in 2003...the fund backed Alpha, Beta and Gamma'],
  ])('evidence 用 %s 分两段，两段都在字幕里：采用', (_label, evidence) => {
    const outcome = applyRevisions(SECTION, [{ ...TIME_ISSUE, evidence }], TRANSCRIPT);
    expect(outcome.applied).toHaveLength(1);
    expect(outcome.rejected).toEqual([]);
  });

  // 抓：只核对第一段，第二段是模型编的也照样采用
  it('evidence 分两段，第二段不在字幕里：丢弃为 evidence_not_in_transcript', () => {
    const issue = { ...TIME_ISSUE, evidence: 'I moved to Berlin in 2003 … the fund backed Alpha, Beta, Gamma and Delta' };
    const outcome = applyRevisions(SECTION, [issue], TRANSCRIPT);
    expect(outcome.markdown).toBe(SECTION);
    expect(outcome.rejected).toEqual([{ issue, reason: 'evidence_not_in_transcript' }]);
  });

  // 抓：evidence 是模型改写或编造的（字幕里没有），修订照样被采用
  it('evidence 不在字幕里：丢弃，原文不动', () => {
    const issue = { ...TIME_ISSUE, evidence: 'The fund invested in Alpha, Beta and Gamma in 2003' };
    const outcome = applyRevisions(SECTION, [issue], TRANSCRIPT);
    expect(outcome).toEqual({ markdown: SECTION, applied: [], rejected: [{ issue, reason: 'evidence_not_in_transcript' }] });
  });

  // 抓：大小写、换行、多余空格、段首时间戳、>> 和弯引号不同就判成"不在字幕里"
  it('evidence 和字幕只差大小写、空白、时间戳、>> 和引号写法：能对上', () => {
    const issue = quantity({ evidence: "TALKING WITH   Maria Lopez\n[00:12] >> I moved to Berlin … We're at about FIVE portfolio companies now" });
    const outcome = applyRevisions(SECTION, [issue], TRANSCRIPT);
    expect(outcome.applied).toHaveLength(1);
    expect(outcome.rejected).toEqual([]);
  });

  // 抓：很短的片段在任何字幕里都找得到，起不到核对作用；或者把边界上的 12 个字符也拒了
  it.each([
    ['12 个字符', 'moved to Ber', true],
    ['11 个字符', 'moved to Be', false],
    ['一段够长、另一段太短', 'I moved to Berlin in 2003 … in 2003', false],
    ['空字符串', '', false],
    ['只有分隔符', ' … ', false],
  ])('evidence %s：采用 = %s', (_label, evidence, accepted) => {
    const issue = { ...TIME_ISSUE, evidence };
    const outcome = applyRevisions(SECTION, [issue], TRANSCRIPT);
    expect(outcome.rejected).toEqual(accepted ? [] : [{ issue, reason: 'evidence_not_in_transcript' }]);
    expect(outcome.applied).toHaveLength(accepted ? 1 : 0);
  });
});

describe('applyRevisions：丢弃原因', () => {
  // 抓：每一种不合格的修订都应该原文不动、记下原因；任何一种漏判都会改坏文章
  it.each<[string, ReviewIssue, string]>([
    ['replacement 和 quote 相同', quantity({ replacement: '现在有五到六家被投公司' }), 'no_change'],
    ['quote 不在这一章里', quantity({ quote: '现在有七家被投公司' }), 'quote_not_found'],
    ['quote 在这一章里出现两次', quantity({ quote: '**嘉宾:** ', replacement: '**Maria Lopez:** ', evidence: "today I'm talking with Maria Lopez" }), 'quote_not_unique'],
    ['quote 跨段落', quantity({ quote: 'Gamma。\n\n**嘉宾:** 现在有五到六家', replacement: 'Gamma。现在大约有五家' }), 'structure'],
    ['replacement 跨段落', quantity({ replacement: '现在大约有五家被投公司。\n\n预计会增加到五到六家' }), 'structure'],
    ['replacement 新增标题行', quantity({ replacement: '现在大约有五家被投公司\n### 以后的预期\n预计会增加到五到六家' }), 'structure'],
    ['去掉标题行的 # 标记', quantity({ quote: '## 柏林岁月', replacement: '柏林岁月' }), 'structure'],
    ['把整行删空', quantity({ type: 'unsupported', quote: '**嘉宾:** 现在有五到六家被投公司，以后还会更多。', replacement: '' }), 'structure'],
    ['把整行换成空白', quantity({ type: 'unsupported', quote: '**嘉宾:** 第二期基金募资 5 亿元。', replacement: '  ', evidence: 'we raised $500 million for the second fund' }), 'structure'],
    // quote "五到六家" 4 个字符：上限 max(8, 4 + 80) = 84
    ['replacement 85 个字符（上限 84）', quantity({ quote: '五到六家', replacement: '大约五家' + '这一点嘉宾说得很含糊'.repeat(8) + '。' }), 'too_long'],
  ])('%s：丢弃为 %s，文章不变', (_label, issue, reason) => {
    const outcome = applyRevisions(SECTION, [issue], TRANSCRIPT);
    expect(outcome).toEqual({ markdown: SECTION, applied: [], rejected: [{ issue, reason }] });
  });

  // 抓：长度上限算错一位，把正好在上限上的修订也拒了
  it('replacement 正好 84 个字符（上限）：采用', () => {
    const issue = quantity({ quote: '五到六家', replacement: '大约五家' + '这一点嘉宾说得很含糊'.repeat(8) });
    expect(applyRevisions(SECTION, [issue], TRANSCRIPT).applied).toHaveLength(1);
  });

  // 抓：上限只按一种算法算（只按 2 倍或只按 +80），两种情况里有一种上限错了
  it.each([
    // "2003 年那家基金投资了 Alpha、Beta 和 Gamma。" 33 个字符：max(66, 113) = 113
    ['quote 33 个字符，上限 113', TIME_ISSUE.quote, SECTION, 113],
    // 一句 35 个字符重复 3 次，105 个字符：max(210, 185) = 210
    ['quote 105 个字符，上限 210', '那家基金在之后十年里先后投资了 Alpha、Beta 和 Gamma，'.repeat(3), `## 基金\n\n**嘉宾:** ${'那家基金在之后十年里先后投资了 Alpha、Beta 和 Gamma，'.repeat(3)}都很成功。\n`, 210],
  ])('%s：正好上限采用，多一个字符丢弃为 too_long', (_label, quote, markdown, limit) => {
    expect(quote.length).toBe(limit === 113 ? 33 : 105);
    const at = { ...TIME_ISSUE, quote, replacement: '我'.repeat(limit) };
    const over = { ...TIME_ISSUE, quote, replacement: '我'.repeat(limit + 1) };
    expect(applyRevisions(markdown, [at], TRANSCRIPT).applied).toHaveLength(1);
    expect(applyRevisions(markdown, [over], TRANSCRIPT).rejected).toEqual([{ issue: over, reason: 'too_long' }]);
  });

  // 抓：一个单元的修订数没有上限，模型借"局部修订"把整章重写
  it('每单元最多采用 40 处，第 41 处丢弃为 limit', () => {
    const sentences = Array.from({ length: 41 }, (_, i) => `第${i + 1}句。`).join('');
    const markdown = `## 很多小错\n\n${sentences}\n`;
    const issues = Array.from({ length: 41 }, (_, i) => quantity({ type: 'language', quote: `第${i + 1}句。`, replacement: `第${i + 1}条。` }));
    const outcome = applyRevisions(markdown, issues, TRANSCRIPT);
    expect(outcome.applied).toHaveLength(40);
    expect(outcome.markdown.endsWith('第39条。第40条。第41句。\n')).toBe(true);
    expect(outcome.rejected).toEqual([{ issue: issues[40], reason: 'limit' }]);
  });
});

describe('splitForReview', () => {
  // 抓：切分丢字或重字，拼回去和原文不同，修订后保存的文章少了内容；标题和引言单独成一个单元
  it('标题、引言和第一章合成第一个单元，之后每章一个，首尾相接等于原文', () => {
    const markdown = '# 对话 Maria Lopez\n\n引言一段。\n\n## 柏林岁月\n\n第一章正文。\n\n## 基金\n\n第二章正文。\n\n## 展望\n\n第三章正文。';
    const sections = splitForReview(markdown);
    expect(sections).toEqual(['# 对话 Maria Lopez\n\n引言一段。\n\n## 柏林岁月\n\n第一章正文。\n\n', '## 基金\n\n第二章正文。\n\n', '## 展望\n\n第三章正文。']);
    expect(sections!.join('')).toBe(markdown);
  });

  // 抓：没有二级标题时返回一个单元，调用方以为切过了
  it('没有章节：返回 null', () => {
    expect(splitForReview('# 只有标题\n\n一段正文，没有二级标题。')).toBeNull();
  });

  // 抓：代码块、引用里的 "## " 被当成章节，切出的单元把代码块拆成两半
  it('代码块和引用里的 "## " 不算章节', () => {
    const markdown = '# 标题\n\n## 第一章\n\n```markdown\n## 这是代码里的示例\n```\n\n> ## 引用里的标题\n\n## 第二章\n\n正文。';
    expect(splitForReview(markdown)).toEqual(['# 标题\n\n## 第一章\n\n```markdown\n## 这是代码里的示例\n```\n\n> ## 引用里的标题\n\n', '## 第二章\n\n正文。']);
  });
});

describe('normalizeEvidence', () => {
  // 抓：归一规则漏掉时间戳（含小时）、换人标记、弯引号或大小写，模型逐字复制的 evidence 也对不上
  it('去掉时间戳和 >>，引号统一成直引号，空白压成一个，转小写', () => {
    expect(normalizeEvidence('[00:12] >> We’re  “Fine”\n\n[1:02:03] OK, ‘Really’  ')).toBe('we\'re "fine" ok, \'really\'');
  });

  // 抓：字幕正文里的方括号内容（不是时间戳）也被删掉
  it('不是时间戳的方括号原样保留', () => {
    expect(normalizeEvidence('[Music] [applause] AI')).toBe('[music] [applause] ai');
  });
});
