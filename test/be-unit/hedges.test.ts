/**
 * L1a 语气清单核对的纯函数：摘片段、分份、提示词、解析结论。
 * 期望值都是手写字面量；提示词只断言结构（编号、命中词、各块内容、开头分流），不整段比对措辞。
 */
import { describe, expect, it } from 'vitest';
import { chunkExcerpts, hedgedExcerpts, hedgeReviewPrompt, parseToneChecks, TONE_SCHEMA, type HedgedExcerpt } from '../../src/worker/hedges';
import { fidelityReviewPrompt, reconcilePrompt, reviewPrompt } from '../../src/worker/review';
import { geminiPurpose, toneListOf } from '../fixtures/upstream';

const VIDEO = { id: 'mockvideo01', title: '泥板与神庙', channel: '测试频道', description: '本期讲者 Irving Finkel', lengthSeconds: 600 };

/** 只看摘出的原文 */
const texts = (transcript: string) => hedgedExcerpts(transcript).excerpts.map((e) => e.text);

describe('hedgedExcerpts：命中与不命中', () => {
  // 抓：英文推测说法没被摘出来；命中词记录丢了
  it('seems / might / I think / probably 等英文说法命中，记下原文里的命中词', () => {
    expect(hedgedExcerpts('[00:00] And this seems to store the stipends for workers at a temple some few thousand years ago.')).toEqual({
      excerpts: [{ text: 'And this seems to store the stipends for workers at a temple some few thousand years ago.', markers: ['seems to', 'some few'] }],
      dropped: 0,
    });
    expect(texts('The vote might happen next week.\nI think the board will agree.\nThe deal probably closed already.')).toEqual([
      'The vote might happen next week.',
      'I think the board will agree.',
      'The deal probably closed already.',
    ]);
  });

  // 抓：may 一律当成推测（"你可以离开"也进清单，清单被无关条目撑长）；may be 这种推测反而漏掉
  it('may 后面跟 be 等推测用法才命中；表许可的 may leave 不命中', () => {
    expect(texts('You may leave the room once the meeting ends.')).toEqual([]);
    expect(hedgedExcerpts('It may be the largest fund in Europe.').excerpts).toEqual([{ text: 'It may be the largest fund in Europe.', markers: ['may'] }]);
  });

  // 抓：about 后面不是数量时也当约数（"talk about the fund" 是"关于"）
  it('about 后跟数字或数量词才命中；about the fund 不命中', () => {
    expect(texts('Let me tell you about the fund we started together.')).toEqual([]);
    expect(hedgedExcerpts('We have about five portfolio companies right now.').excerpts).toEqual([{ text: 'We have about five portfolio companies right now.', markers: ['about five'] }]);
    expect(texts('We raised about 300 million dollars last year.')).toEqual(['We raised about 300 million dollars last year.']);
  });

  // 抓：月份 May 被当成推测词
  it('月份 May 不命中', () => {
    expect(texts('The product launches in May and the team is ready.')).toEqual([]);
    expect(texts('We met in May. The contract was signed in June.')).toEqual([]);
  });

  // 抓：只按子串匹配，单词内部的 maybe / may / seem 也命中
  it('单词内部的 maybelline / dismay / seemingly 不命中', () => {
    expect(texts('She worked at maybelline for years, to her dismay, seemingly forever.')).toEqual([]);
  });

  // 抓：中文字幕里的推测说法一条都摘不出来
  it('中文的 可能 / 大概 / 我觉得 命中，同一句里的多个命中词合在一条里', () => {
    expect(hedgedExcerpts('[00:30] 这个功能大概要到下个月才上线').excerpts).toEqual([{ text: '这个功能大概要到下个月才上线', markers: ['大概'] }]);
    expect(hedgedExcerpts('[00:40] 我觉得可能还要再等一段时间').excerpts).toEqual([{ text: '我觉得可能还要再等一段时间', markers: ['我觉得', '可能'] }]);
  });

  // 抓：字幕里根本没有推测说法时也凑出条目（会白发一次语气请求）
  it('没有任何命中词：空清单', () => {
    expect(hedgedExcerpts('[00:00] We opened an office in Lisbon in 2019.\n\n[00:10] The team has twelve people.')).toEqual({ excerpts: [], dropped: 0 });
  });
});

describe('hedgedExcerpts：片段范围', () => {
  // 抓：片段没扩到整句（只有命中词附近几个字，模型没法对照文章）；或者扩过句号把前后句子都带进来
  it('英文按句号、问号、叹号加空白断句，引号收尾也算句末', () => {
    expect(texts('We met in Paris. It seems the deal closed early. Then we left.')).toEqual(['It seems the deal closed early.']);
    expect(texts('Was it worth it? Perhaps not for everyone! We moved on.')).toEqual(['Perhaps not for everyone!']);
    expect(texts('He said "it is likely." Then we left the room together.')).toEqual(['He said "it is likely."']);
  });

  // 抓：同一句里的两个命中词摘成两条重复的片段
  it('同一句里的多个命中词：合并成一条，命中词都记下', () => {
    expect(hedgedExcerpts('It seems we may be about five weeks late.').excerpts).toEqual([{ text: 'It seems we may be about five weeks late.', markers: ['seems', 'may', 'about five'] }]);
  });

  // 现状：句号加空格隔开的两句各成一条（不合并）。源码注释写的是"重叠或相邻的片段合并"，实际只合并重叠的
  it('句号隔开的相邻两句各自一条', () => {
    expect(texts('It seems cheap. Maybe it is not. We left early.')).toEqual(['It seems cheap.', 'Maybe it is not.']);
  });

  // 抓：片段跨过换行把下一段字幕（可能是另一个人）拼进来
  it('不跨段落：换行处截断，两段各一条', () => {
    expect(texts('[00:00] It seems the fund is closing soon\n\n[00:10] >> maybe the second one opens next year')).toEqual([
      'It seems the fund is closing soon',
      'maybe the second one opens next year',
    ]);
  });

  // 抓：段首的时间戳和换人标记进了片段（模型照抄成 evidence 时多了这些标记）
  it('去掉段首的 [mm:ss]、[h:mm:ss] 时间戳和 >> 换人标记', () => {
    expect(texts('[01:05] >> we are at about five companies now')).toEqual(['we are at about five companies now']);
    expect(texts('[1:02:03] >> I think we are done here today')).toEqual(['I think we are done here today']);
  });

  // 抓：只有一两个词的碎片也进清单（核对不出东西，白占条目）
  it('去掉标记后不到 12 个字符的片段丢弃', () => {
    expect(texts('[00:00] maybe so.')).toEqual([]);
    expect(texts('[00:00] maybe so, yes.')).toEqual(['maybe so, yes.']);
    // 按字符数算，中文 11 个字的完整句子也会被丢掉（见汇报）
    expect(texts('[00:30] 这个功能大概下个月上线')).toEqual([]);
  });

  // 抓：清单没有总长上限，超长字幕把语气请求撑爆；超出的条数没记下
  it('总长上限 120000 字符：正好到上限的都收下，再多的计入 dropped', () => {
    // 每段 100 字符、自成一条
    const line = `it seems ${'a'.repeat(91)}`;
    expect(line).toHaveLength(100);
    const result = hedgedExcerpts(Array.from({ length: 1203 }, () => line).join('\n\n'));
    expect(result.excerpts).toHaveLength(1200);
    expect(result.dropped).toBe(3);
    expect(result.excerpts[0]).toEqual({ text: line, markers: ['seems'] });
  });
});

describe('hedgedExcerpts：已知问题', () => {
  // 抓：中文句号后面没有空白，按现在的断句规则不算句末，片段会一直扩到换行或 220 字符，把前后无关的句子都带进来。
  // 抓：中文句末标点后面没有空白，断句不生效，整段都被摘进来
  it('中文句号断句：不带上后面的句子；命中的那句不足 12 个字符时往前多带一句', () => {
    expect(texts('第一句没有问题。这个数字可能偏高。第三句也没有问题。')).toEqual(['第一句没有问题。这个数字可能偏高。']);
    expect(texts('第一句没有问题。这个数字按我的印象可能偏高了不少。第三句也没有问题。')).toEqual(['这个数字按我的印象可能偏高了不少。']);
  });
});

describe('chunkExcerpts', () => {
  const list = (n: number): HedgedExcerpt[] => Array.from({ length: n }, (_, i) => ({ text: `片段 ${i + 1}`, markers: ['maybe'] }));
  const sizes = (n: number) => chunkExcerpts(list(n)).map((c) => c.length);

  // 抓：空清单也发一次请求；少量条目被拆成多次；超过 180 条时请求数不封顶
  it.each([
    [0, []],
    [1, [1]],
    [60, [60]],
    [61, [31, 30]],
    [180, [60, 60, 60]],
    [181, [61, 61, 59]],
  ])('%i 条 → 每份 %j', (n, expected) => {
    expect(sizes(n)).toEqual(expected);
  });

  // 抓：分份时丢了、重复了或打乱了条目（编号会对不上）
  it('分份后按顺序拼回去等于原清单', () => {
    const all = list(181);
    expect(chunkExcerpts(all).flat()).toEqual(all);
  });
});

describe('hedgeReviewPrompt', () => {
  const TRANSCRIPT = '[00:00] We opened an office in Lisbon in 2019.\n\n[00:10] It seems the fund is closing soon.\n\n[00:20] >> We have about five portfolio companies, maybe six.';
  const ARTICLE = '# 基金\n\n## 现状\n\n基金即将关闭，现有五到六家被投公司。';
  const { excerpts } = hedgedExcerpts(TRANSCRIPT);
  const prompt = hedgeReviewPrompt({ video: VIDEO, excerpts, first: 61, section: ARTICLE });

  it('前提：夹具字幕摘出两条', () => {
    expect(excerpts.map((e) => e.markers)).toEqual([['seems'], ['about five', 'maybe']]);
  });

  // 抓：第二份清单的编号又从 1 开始（和第一份撞号，解析时会对错条目）；命中词没列出来
  it('清单编号从 first 起连续，每行带命中词和片段原文', () => {
    expect(toneListOf(prompt.user)).toEqual([
      { index: 61, text: 'It seems the fund is closing soon.' },
      { index: 62, text: 'We have about five portfolio companies, maybe six.' },
    ]);
    expect(prompt.user).toContain('\n61. [seems] It seems the fund is closing soon.\n62. [about five / maybe] We have about five portfolio companies, maybe six.\n');
  });

  // 抓：把整段字幕也塞进语气请求（长视频白白多几万 token；依据只应是清单里的片段）
  it('带整篇文章和视频元数据，不带整段字幕', () => {
    expect(prompt.user).toContain(`<section>\n${ARTICLE}\n</section>`);
    expect(prompt.user).toContain('本期讲者 Irving Finkel');
    expect(prompt.user).not.toContain('<transcript>');
    expect(prompt.system).not.toContain('<transcript>');
    expect(prompt.user).not.toContain('Lisbon');
  });

  // 抓：语气请求被各层替身当成普通核对（review）或合并处理，场景没法单独给它返回结果；或者反过来把普通核对认成语气核对
  it('开头分流：语气核对分到 tone，两种核对仍是 review，合并处理仍是 reconcile', () => {
    const purpose = (system: string) => geminiPurpose('/gemini/mock:generateContent', { systemInstruction: { parts: [{ text: system }] } });
    expect(purpose(prompt.system)).toBe('tone');
    const input = { video: VIDEO, transcriptText: TRANSCRIPT, instructions: '', outline: ['现状'], section: ARTICLE };
    expect(purpose(reviewPrompt(input).system)).toBe('review');
    expect(purpose(fidelityReviewPrompt(input).system)).toBe('review');
    expect(purpose(reconcilePrompt({ video: VIDEO, article: ARTICLE, applied: [], pending: [] }).system)).toBe('reconcile');
  });

  // 抓：schema 没要求每条都有编号和结论，模型可以只返回有问题的几条
  it('schema 要求每条都有 index 和 status，status 只有三种', () => {
    expect(TONE_SCHEMA.required).toEqual(['checks']);
    expect(TONE_SCHEMA.properties.checks.items.required).toEqual(['index', 'status', 'type', 'quote', 'replacement', 'evidence', 'problem']);
    expect(TONE_SCHEMA.properties.checks.items.properties.status.enum).toEqual(['absent', 'kept', 'dropped']);
  });
});

describe('parseToneChecks', () => {
  const check = (patch: Record<string, unknown>) => ({ index: 3, status: 'kept', type: 'unsupported', quote: '', replacement: '', evidence: '', problem: '', ...patch });
  const DROPPED = check({
    index: 4,
    status: 'dropped',
    type: 'quantity',
    quote: '现有五到六家被投公司。',
    replacement: '现有大约五家被投公司，也许六家。',
    evidence: 'We have about five portfolio companies, maybe six.',
    problem: '  原话是约数，文章写成了确定的范围  ',
  });

  // 抓：有效结论被拒；dropped 没转成修订；problem 首尾空白没去掉；结论按数组顺序而不是 index 对号
  it('每条恰好一个结论：dropped 转成修订，kept / absent 不产生修订，顺序无关', () => {
    const expected = {
      issues: [{ type: 'quantity', quote: '现有五到六家被投公司。', replacement: '现有大约五家被投公司，也许六家。', evidence: 'We have about five portfolio companies, maybe six.', problem: '原话是约数，文章写成了确定的范围' }],
      malformed: [],
    };
    expect(parseToneChecks({ checks: [check({}), DROPPED] }, 3, 2)).toEqual(expected);
    expect(parseToneChecks({ checks: [DROPPED, check({ status: 'absent' })] }, 3, 2)).toEqual(expected);
  });

  // 抓：漏给、重复给、给了清单外编号的结论被当成"核对完了"，没核对的条目悄悄消失
  it.each<[string, unknown]>([
    ['缺条目', { checks: [check({})] }],
    ['空列表', { checks: [] }],
    ['编号重复', { checks: [check({}), check({})] }],
    ['编号重复且总数对得上', { checks: [check({}), check({}), DROPPED] }],
    ['编号小于 first', { checks: [check({ index: 2 }), DROPPED] }],
    ['编号超出范围', { checks: [check({}), check({ index: 5 })] }],
    ['编号不是整数', { checks: [check({ index: 3.5 }), DROPPED] }],
    ['编号是字符串', { checks: [check({ index: '3' }), DROPPED] }],
    ['status 无效', { checks: [check({ status: 'fixed' }), DROPPED] }],
    ['status 缺失', { checks: [check({ status: undefined }), DROPPED] }],
    ['条目不是对象', { checks: ['kept', DROPPED] }],
    ['条目是 null', { checks: [null, DROPPED] }],
    ['checks 不是数组', { checks: { 3: 'kept' } }],
    ['缺 checks', {}],
    ['整体是 null', null],
    ['整体是数组', [check({}), DROPPED]],
  ])('%s：null', (_label, raw) => {
    expect(parseToneChecks(raw, 3, 2)).toBeNull();
  });

  // 抓：dropped 而缺修订字段的条目让整份失败（应该只丢这一条），或者半截修订被当成可用
  it('dropped 但修订字段不全或 quote 为空：记 malformed，其余照常', () => {
    const noReplacement = { ...DROPPED, replacement: undefined };
    const emptyQuote = { ...DROPPED, index: 3, quote: '  ' };
    expect(parseToneChecks({ checks: [emptyQuote, noReplacement] }, 3, 2)).toEqual({ issues: [], malformed: [emptyQuote, noReplacement] });
  });

  // 抓：type 缺省或不在两种之内时原样透传，进了 Revision.type 页面上显示不出来
  it('type 缺省或不是 quantity：记 unsupported', () => {
    const parsed = parseToneChecks({ checks: [check({}), { ...DROPPED, type: undefined }] }, 3, 2);
    expect(parsed!.issues.map((i) => i.type)).toEqual(['unsupported']);
    expect(parseToneChecks({ checks: [check({}), { ...DROPPED, type: 'time' }] }, 3, 2)!.issues.map((i) => i.type)).toEqual(['unsupported']);
  });
});
