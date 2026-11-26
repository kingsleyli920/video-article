import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/worker/app-error';
import { checkRequirements, confirmRequirements, describeRequirements, NO_REQUIREMENTS, numbersIn, parseChineseNumber, parseRequirements, rewritePrompt, type Requirements } from '../../src/worker/requirements';

const req = (patch: Partial<Requirements>): Requirements => ({ ...NO_REQUIREMENTS, sectionTitles: [], ...patch });

/** 标题 2 字 + 章节标题 3 字 + 正文 15 字 = 20 字 */
const ARTICLE_20 = '# 标题\n\n## 第一章\n\n甲乙丙丁戊己庚辛壬癸子丑寅卯辰';

/**
 * 三章，56 字：标题"三章"2；第一章"背景"2 + 正文 16（两个小节名各 4、两句各 4）；
 * 第二章"过程"2 + 正文 8（一个小节）；第三章"结果"2 + 正文 24（两个小节，外加一个四级标题"更细的一层"5 和"细节。"3）。
 */
const ARTICLE_3 = [
  '# 三章',
  '## 背景',
  '### 核心观点',
  '观点一。',
  '### 原话依据',
  '依据一。',
  '## 过程',
  '### 核心观点',
  '观点二。',
  '## 结果',
  '### 核心观点',
  '观点三。',
  '### 原话依据',
  '依据三。',
  '#### 更细的一层',
  '细节。',
].join('\n\n');

describe('parseChineseNumber', () => {
  // 抓：中文数字的常见写法解析错，"一千五"被当成 1005 或 1000，"两千"不认识
  it.each([
    ['三', 3],
    ['十', 10],
    ['十二', 12],
    ['二十', 20],
    ['三百五', 350],
    ['一千五百', 1500],
    ['一千五', 1500],
    ['一千零五', 1005],
    ['两千', 2000],
    ['一万', 10000],
    ['一万五', 15000],
    ['十万', 100000],
  ])('%s → %i', (text, value) => {
    expect(parseChineseNumber(text)).toBe(value);
  });

  // 抓：夹着别的字或者是 0 时返回一个数，被当成约束的数值
  it.each([['三章'], ['零'], [''], ['字']])('%j 解析不了，返回 null', (text) => {
    expect(parseChineseNumber(text)).toBeNull();
  });
});

describe('numbersIn', () => {
  // 抓：用户常见的数字写法认不出来，真实的约束因为"数值不在 quote 里"被丢掉
  it.each([
    ['不超过 1500 字', [1500]],
    ['1,500 字以内', [1500]],
    // 全角逗号是断句，不是千分位：读成两个数，不会拼成 1500
    ['1500，3 章', [1500, 3]],
    ['控制在 1.5k 字', [1500]],
    ['1.5K', [1500]],
    ['800 到 1000 字', [800, 1000]],
    ['分三章', [3]],
    ['不超过一千五百字', [1500]],
    ['一千五字左右', [1500]],
    ['两千字以上', [2000]],
    ['一万五千字', [15000]],
    ['1500 字，分 3 章', [1500, 3]],
  ])('%j → %j', (text, numbers) => {
    expect(numbersIn(text)).toEqual(numbers);
  });

  // 抓："2千""3万"里的单位字被中文数字规则再读一遍，凭空多出 1000、10000，模型给的错误数值也能通过核对
  it.each([
    ['不超过2千字', [2000]],
    ['不超过 2 千字', [2000]],
    ['3万字以内', [30000]],
    ['1.5万字', [15000]],
  ])('%j → %j，不多出单位字本身的数', (text, numbers) => {
    expect(numbersIn(text)).toEqual(numbers);
  });

  // 抓：没有数字的要求被读出数值
  it('没有数字时返回空数组', () => {
    expect(numbersIn('写给投资人看，突出数字')).toEqual([]);
  });
});

describe('parseRequirements', () => {
  const INSTRUCTIONS = "写给投资人看，全文不超过 1500 字，分三章，每章都包含'核心观点''原话依据'两个小节";
  const FULL = {
    maxChars: 1500,
    minChars: 0,
    charsQuote: '全文不超过1500字',
    chaptersMin: 3,
    chaptersMax: 3,
    chaptersQuote: '分三章',
    sectionsPerChapter: 2,
    sectionTitles: ['核心观点', '原话依据'],
    sectionsQuote: "每章都包含'核心观点''原话依据'两个小节",
  };
  const NONE = { maxChars: 0, minChars: 0, charsQuote: '', chaptersMin: 0, chaptersMax: 0, chaptersQuote: '', sectionsPerChapter: 0, sectionTitles: [], sectionsQuote: '' };

  // 抓：quote 和用户原话只差空白时被丢弃；0 被当成"上限 0 字"
  it('正常提取：三类约束都有出处、数值对得上，全部采用（quote 忽略空白）', () => {
    expect(parseRequirements(FULL, INSTRUCTIONS)).toEqual({
      requirements: { maxChars: 1500, minChars: null, chaptersMin: 3, chaptersMax: 3, sectionsPerChapter: 2, sectionTitles: ['核心观点', '原话依据'] },
      dropped: [],
    });
  });

  // 抓：模型编出用户没写过的约束（quote 不在原话里）也被强制执行，好好的文章被判不合格
  it('quote 不在用户原话里：这一类约束丢弃，其他照常', () => {
    expect(parseRequirements({ ...FULL, charsQuote: '不超过 1200 字', maxChars: 1200 }, INSTRUCTIONS)).toEqual({
      requirements: { maxChars: null, minChars: null, chaptersMin: 3, chaptersMax: 3, sectionsPerChapter: 2, sectionTitles: ['核心观点', '原话依据'] },
      dropped: ['chars'],
    });
  });

  // 抓：quote 是对的，但模型给的数值和 quote 里的数字不一致（1500 写成 1200）也被采用
  it.each<[string, object, string]>([
    ['字数', { maxChars: 1200 }, 'chars'],
    ['字数（quote 为空）', { charsQuote: '' }, 'chars'],
    ['章节', { chaptersMin: 4, chaptersMax: 4 }, 'chapters'],
    ['小节数', { sectionsPerChapter: 3 }, 'sections'],
  ])('%s的数值不在 quote 里或没有 quote：丢弃并记进 dropped', (_label, patch, name) => {
    const { requirements, dropped } = parseRequirements({ ...FULL, ...patch }, INSTRUCTIONS);
    expect(dropped).toEqual([name]);
    if (name === 'chars') expect([requirements.maxChars, requirements.minChars]).toEqual([null, null]);
    if (name === 'chapters') expect([requirements.chaptersMin, requirements.chaptersMax]).toEqual([null, null]);
    if (name === 'sections') expect([requirements.sectionsPerChapter, requirements.sectionTitles]).toEqual([null, []]);
  });

  // 抓：用户没点名的小节名（模型自己加的"金句"）被强制每章都要有
  it('小节名不在用户原话里：小节约束整体丢弃', () => {
    const { requirements, dropped } = parseRequirements({ ...FULL, sectionTitles: ['核心观点', '金句'] }, INSTRUCTIONS);
    expect(requirements.sectionsPerChapter).toBeNull();
    expect(requirements.sectionTitles).toEqual([]);
    expect(dropped).toEqual(['sections']);
  });

  // 抓：上下限颠倒时仍然执行，任何文章都不可能满足，必然报 requirements_unmet
  it('上下限矛盾：字数、章节都不采用', () => {
    const instructions = '1000 到 2000 字，3 到 5 章';
    const raw = { ...NONE, maxChars: 1000, minChars: 2000, charsQuote: '1000 到 2000 字', chaptersMin: 5, chaptersMax: 3, chaptersQuote: '3 到 5 章' };
    expect(parseRequirements(raw, instructions).requirements).toEqual(NO_REQUIREMENTS);
  });

  // 抓：模型按约定用 0 和空串表示"没有"，却被当成约束（上限 0 字、正好 0 章）
  it('模型返回 0 和空串：没有任何约束，也不算丢弃', () => {
    expect(parseRequirements(NONE, INSTRUCTIONS)).toEqual({ requirements: NO_REQUIREMENTS, dropped: [] });
  });

  // 抓：模型返回的不是对象时抛异常；或者当成"用户没提约束"（dropped 为空），调用方不再重新提取，字数上限悄悄消失
  it.each([[null], ['不超过 1500 字'], [[1500]], [42]])('返回的不是对象（%j）：没有约束，dropped 记 format:整体', (raw) => {
    expect(parseRequirements(raw, INSTRUCTIONS)).toEqual({ requirements: NO_REQUIREMENTS, dropped: ['format:整体'] });
  });

  // 抓：负数、小数、字符串形式的数字被当成约束；或者被当成"没有约束"而不要求重新提取
  it('数值不是非负整数：没有约束，dropped 记第一个不合格的字段', () => {
    const raw = { ...NONE, maxChars: -1500, minChars: 1500.5, charsQuote: '全文不超过 1500 字', chaptersMin: '3', chaptersMax: '3', chaptersQuote: '分三章' };
    expect(parseRequirements(raw, INSTRUCTIONS)).toEqual({ requirements: NO_REQUIREMENTS, dropped: ['format:maxChars'] });
  });

  // 审查方反例一。抓：提取返回 {}（字段全缺）被当成"用户没提约束"，"不超过1500字"的要求被悄悄去掉
  // 其余各条抓：结构核对漏查某个字段或某种类型错误
  it.each<[string, unknown, string]>([
    ['{}', {}, 'format:maxChars'],
    ['缺 charsQuote', { maxChars: 0, minChars: 0, chaptersMin: 0, chaptersMax: 0, chaptersQuote: '', sectionsPerChapter: 0, sectionTitles: [], sectionsQuote: '' }, 'format:charsQuote'],
    ['缺 sectionTitles', { maxChars: 0, minChars: 0, charsQuote: '', chaptersMin: 0, chaptersMax: 0, chaptersQuote: '', sectionsPerChapter: 0, sectionsQuote: '' }, 'format:sectionTitles'],
    ['chaptersMin 是字符串', { ...NONE, chaptersMin: '3' }, 'format:chaptersMin'],
    ['maxChars 是负数', { ...NONE, maxChars: -1 }, 'format:maxChars'],
    ['minChars 是小数', { ...NONE, minChars: 1500.5 }, 'format:minChars'],
    ['sectionsPerChapter 是 null', { ...NONE, sectionsPerChapter: null }, 'format:sectionsPerChapter'],
    ['charsQuote 是数字', { ...NONE, charsQuote: 1500 }, 'format:charsQuote'],
    ['sectionTitles 不是数组', { ...NONE, sectionTitles: '核心观点' }, 'format:sectionTitles'],
    ['sectionTitles 里有非字符串', { ...NONE, sectionTitles: ['核心观点', 2] }, 'format:sectionTitles'],
  ])('结构不合格（%s）：没有约束，dropped 只记这个字段的 format 项', (_label, raw, dropped) => {
    expect(parseRequirements(raw, '不超过1500字')).toEqual({ requirements: NO_REQUIREMENTS, dropped: [dropped] });
  });

  // 抓：模型认出了这类要求（给了 quote）却没给数值，被当成"没有这类约束"放过
  it.each<[string, string, object, string]>([
    ['字数', '不超过1500字', { charsQuote: '不超过1500字' }, 'chars'],
    ['章节', '分三章', { chaptersQuote: '分三章' }, 'chapters'],
    ['小节', '每章两个小节', { sectionsQuote: '每章两个小节' }, 'sections'],
  ])('%s给了 quote、数值全是 0：dropped 记 %s', (_label, instructions, patch, name) => {
    expect(parseRequirements({ ...NONE, ...patch }, instructions)).toEqual({ requirements: NO_REQUIREMENTS, dropped: [name] });
  });

  // 审查方反例二。抓：maxChars=1600 和出处"不超过1500字"对不上时只丢掉约束、不报 dropped，1604 字的文章被当成满足要求
  it('maxChars=1600、charsQuote 是"不超过1500字"：不采用上限，dropped 记 chars', () => {
    expect(parseRequirements({ ...NONE, maxChars: 1600, charsQuote: '不超过1500字' }, '不超过1500字')).toEqual({ requirements: NO_REQUIREMENTS, dropped: ['chars'] });
  });

  // 抓："1.5k""一千五"这类写法在 quote 里认不出来，真实约束被丢掉；只有下限时上限被误填
  it.each([
    ['控制在 1.5k 字以内', { maxChars: 1500, charsQuote: '1.5k 字以内' }, { maxChars: 1500, minChars: null }],
    ['不超过一千五百字', { maxChars: 1500, charsQuote: '不超过一千五百字' }, { maxChars: 1500, minChars: null }],
    ['一千五字左右就行', { maxChars: 1500, charsQuote: '一千五字左右' }, { maxChars: 1500, minChars: null }],
    ['至少两千字', { minChars: 2000, charsQuote: '至少两千字' }, { maxChars: null, minChars: 2000 }],
    ['800 到 1000 字', { maxChars: 1000, minChars: 800, charsQuote: '800 到 1000 字' }, { maxChars: 1000, minChars: 800 }],
  ])('%j：采用', (instructions, patch, expected) => {
    const { requirements, dropped } = parseRequirements({ ...NONE, ...patch }, instructions);
    expect({ maxChars: requirements.maxChars, minChars: requirements.minChars }).toEqual(expected);
    expect(dropped).toEqual([]);
  });

  // 抓："不超过2千字"里多读出的 1000 让模型给错的上限（1000）也通过核对
  it('"不超过2千字" 但模型给了 1000：丢弃', () => {
    expect(parseRequirements({ ...NONE, maxChars: 1000, charsQuote: '不超过2千字' }, '写得精炼些，不超过2千字')).toEqual({ requirements: NO_REQUIREMENTS, dropped: ['chars'] });
  });

  // 抓：只点名小节、不限个数时被丢弃；小节名带的首尾空白让每章都"缺少"这个小节
  it('只点名小节、不限个数：小节名去掉首尾空白后采用', () => {
    const instructions = '每章都要有"原话依据"小节';
    const { requirements } = parseRequirements({ ...NONE, sectionTitles: [' 原话依据 ', ''], sectionsQuote: '每章都要有"原话依据"小节' }, instructions);
    expect(requirements).toEqual(req({ sectionTitles: ['原话依据'] }));
  });
});

describe('checkRequirements', () => {
  // 抓：边界算错一位：正好等于上限、下限的文章被判不满足
  it('字数正好等于上限或下限：满足', () => {
    expect(checkRequirements(ARTICLE_20, req({ maxChars: 20 }))).toEqual([]);
    expect(checkRequirements(ARTICLE_20, req({ minChars: 20 }))).toEqual([]);
    expect(checkRequirements(ARTICLE_20, req({ minChars: 20, maxChars: 20 }))).toEqual([]);
  });

  // 抓：超出 1 字、少 1 字没被发现；说明里没有实际字数和要求
  it('超出上限 1 字、少于下限 1 字：各报一条，带实际字数和要求', () => {
    expect(checkRequirements(ARTICLE_20, req({ maxChars: 19 }))).toEqual([{ kind: 'max_chars', message: '全文 20 字，要求不超过 19 字' }]);
    expect(checkRequirements(ARTICLE_20, req({ minChars: 21 }))).toEqual([{ kind: 'min_chars', message: '全文 20 字，要求至少 21 字' }]);
  });

  // 抓：字数按 Markdown 原文长度算（含 # 和空白），和页面显示的字数口径不一致；千分位没有
  it('字数按统一口径（标题和正文的非空白字符）计算，千位加逗号', () => {
    const article = `# 标题\n\n## 第一章\n\n${'字'.repeat(1496)}`;
    expect(checkRequirements(article, req({ maxChars: 1500 }))).toEqual([{ kind: 'max_chars', message: '全文 1,501 字，要求不超过 1,500 字' }]);
  });

  // 抓：章节数的区间判断写错（只判下限或上限、边界不含）
  it.each<[string, Partial<Requirements>, string | null]>([
    ['正好 3 章', { chaptersMin: 3, chaptersMax: 3 }, null],
    ['正好 4 章', { chaptersMin: 4, chaptersMax: 4 }, '全文 3 章，要求正好 4 章'],
    ['正好 2 章', { chaptersMin: 2, chaptersMax: 2 }, '全文 3 章，要求正好 2 章'],
    ['不超过 3 章', { chaptersMax: 3 }, null],
    ['不超过 2 章', { chaptersMax: 2 }, '全文 3 章，要求不超过 2 章'],
    ['至少 3 章', { chaptersMin: 3 }, null],
    ['至少 4 章', { chaptersMin: 4 }, '全文 3 章，要求至少 4 章'],
    ['3 到 5 章', { chaptersMin: 3, chaptersMax: 5 }, null],
    ['1 到 3 章', { chaptersMin: 1, chaptersMax: 3 }, null],
    ['4 到 6 章', { chaptersMin: 4, chaptersMax: 6 }, '全文 3 章，要求在 4 到 6 章之间'],
  ])('3 章的文章，要求%s', (_label, patch, message) => {
    expect(checkRequirements(ARTICLE_3, req(patch))).toEqual(message ? [{ kind: 'chapters', message }] : []);
  });

  // 抓：小节数把四级标题或代码块里的 ### 也算进去；按全文而不是按每章数
  it('每章小节数：只数这一章的三级标题，不数四级标题', () => {
    expect(checkRequirements(ARTICLE_3, req({ sectionsPerChapter: 2 }))).toEqual([{ kind: 'sections', message: '第 2 章有 1 个小节，要求每章 2 个' }]);
    expect(checkRequirements(ARTICLE_3, req({ sectionsPerChapter: 1 }))).toEqual([
      { kind: 'sections', message: '第 1 章有 2 个小节，要求每章 1 个' },
      { kind: 'sections', message: '第 3 章有 2 个小节，要求每章 1 个' },
    ]);
  });

  // 抓：点名的小节缺了没发现；小节名后面带补充说明（"核心观点：……"）被误判为缺少
  it('点名的小节：缺的报出来，标题里包含小节名就算有', () => {
    expect(checkRequirements(ARTICLE_3, req({ sectionTitles: ['核心观点', '原话依据'] }))).toEqual([{ kind: 'sections', message: '第 2 章缺少小节：原话依据' }]);
    const withSuffix = '# 标题\n\n## 一\n\n### 核心观点：AI 的位置\n\n正文。\n\n### 原话依据（字幕 03:12）\n\n正文。';
    expect(checkRequirements(withSuffix, req({ sectionsPerChapter: 2, sectionTitles: ['核心观点', '原话依据'] }))).toEqual([]);
  });

  it('一个合并标题不能同时充当三个指定小节', () => {
    const article = '# 标题\n\n## 一\n\n### 核心观点、原话依据、给你的启发\n\n正文。\n\n### 其他一\n\n正文。\n\n### 其他二\n\n正文。';
    expect(checkRequirements(article, req({ sectionsPerChapter: 3, sectionTitles: ['核心观点', '原话依据', '给你的启发'] }))).toEqual([
      { kind: 'sections', message: '第 1 章的小节须分别按顺序列出：核心观点、原话依据、给你的启发' },
    ]);
  });

  it('指定小节必须按要求的顺序出现，不仅是名称都存在', () => {
    const article = '# 标题\n\n## 一\n\n### 原话依据\n\n依据。\n\n### 核心观点\n\n观点。';
    expect(checkRequirements(article, req({ sectionTitles: ['核心观点', '原话依据'] }))).toEqual([
      { kind: 'sections', message: '第 1 章的小节须分别按顺序列出：核心观点、原话依据' },
    ]);
  });

  it('未限制小节数时允许其他小节，指定的小节仍各自独立且有序', () => {
    const article = '# 标题\n\n## 一\n\n### 背景\n\n背景。\n\n### 核心观点：例子\n\n观点。\n\n### 补充\n\n补充。\n\n### 原话依据（字幕）\n\n依据。';
    expect(checkRequirements(article, req({ sectionTitles: ['核心观点', '原话依据'] }))).toEqual([]);
  });

  it.each([
    ['空白', '   \n'],
    ['只有更低级标题', '#### 尚未填写'],
    ['只有注释和图片', '<!-- 待补正文 -->\n\n![示意图](https://example.com/image.png)'],
  ])('小节%s不算正文，不能靠空标题满足数量要求', (_name, body) => {
    const article = `# 标题\n\n## 一\n\n### 核心观点\n\n观点。\n\n### 原话依据\n\n${body}`;
    expect(checkRequirements(article, req({ sectionsPerChapter: 2, sectionTitles: ['核心观点', '原话依据'] }))).toEqual([
      { kind: 'sections', message: '第 1 章的第 2 个小节没有正文' },
    ]);
  });

  it('小节可以通过更低级标题组织正文，且逐章检查空小节', () => {
    const article = '# 标题\n\n## 一\n\n### 观点\n\n#### 说明\n\n有正文。\n\n## 二\n\n### 观点';
    expect(checkRequirements(article, req({ sectionsPerChapter: 1 }))).toEqual([
      { kind: 'sections', message: '第 2 章的第 1 个小节没有正文' },
    ]);
  });

  // 抓：代码块里的 "### 原话依据" 被当成小节
  it('代码块里的 ### 不算小节', () => {
    const article = '# 标题\n\n## 一\n\n### 核心观点\n\n正文。\n\n```\n### 原话依据\n```';
    expect(checkRequirements(article, req({ sectionTitles: ['原话依据'] }))).toEqual([{ kind: 'sections', message: '第 1 章缺少小节：原话依据' }]);
  });

  // 抓：多条同时违反时只报第一条，用户只看到一部分原因
  it('多条同时违反：按字数、章节、小节的顺序全部列出', () => {
    expect(checkRequirements(ARTICLE_3, req({ maxChars: 50, chaptersMin: 4, chaptersMax: 4, sectionsPerChapter: 2 }))).toEqual([
      { kind: 'max_chars', message: '全文 56 字，要求不超过 50 字' },
      { kind: 'chapters', message: '全文 3 章，要求正好 4 章' },
      { kind: 'sections', message: '第 2 章有 1 个小节，要求每章 2 个' },
    ]);
  });

  // 抓：没有约束时也报问题
  it('没有约束：不报任何问题', () => {
    expect(checkRequirements(ARTICLE_3, NO_REQUIREMENTS)).toEqual([]);
  });
});

describe('describeRequirements', () => {
  // 抓：给用户看的核对结果缺了实际数值，或者写法和约束类型对不上
  it.each<[string, Partial<Requirements>, string[]]>([
    ['上下限', { minChars: 50, maxChars: 1500 }, ['全文 56 字，要求 50 到 1,500 字']],
    ['只有上限', { maxChars: 1500 }, ['全文 56 字，上限 1,500 字']],
    ['只有下限', { minChars: 50 }, ['全文 56 字，下限 50 字']],
    ['正好 3 章', { chaptersMin: 3, chaptersMax: 3 }, ['共 3 章，要求正好 3 章']],
    ['不超过 5 章', { chaptersMax: 5 }, ['共 3 章，要求不超过 5 章']],
    ['至少 2 章', { chaptersMin: 2 }, ['共 3 章，要求至少 2 章']],
    ['2 到 4 章', { chaptersMin: 2, chaptersMax: 4 }, ['共 3 章，要求在 2 到 4 章之间']],
    ['小节数和小节名', { sectionsPerChapter: 2, sectionTitles: ['核心观点', '原话依据'] }, ['每章 2 个小节：核心观点、原话依据']],
    ['只有小节数', { sectionsPerChapter: 2 }, ['每章 2 个小节']],
    ['只有小节名', { sectionTitles: ['核心观点', '原话依据'] }, ['每章都有小节：核心观点、原话依据']],
    ['三类都有', { maxChars: 1500, chaptersMin: 3, chaptersMax: 3, sectionsPerChapter: 2 }, ['全文 56 字，上限 1,500 字', '共 3 章，要求正好 3 章', '每章 2 个小节']],
    ['没有约束', {}, []],
  ])('%s', (_label, patch, lines) => {
    expect(describeRequirements(ARTICLE_3, req(patch))).toEqual(lines);
  });
});


describe('rewritePrompt：原约束与内部预留', () => {
  const base = { video: { id: 'mockvideo01', title: '讲座', channel: '频道', description: '', lengthSeconds: 60 }, transcriptText: '原始字幕', instructions: '全文不超过50字，正好3章', markdown: ARTICLE_3 };

  it('真实违约仍用原上限检查；预留40字另列，原始要求、字幕、草稿不被改写', () => {
    const violations = checkRequirements(ARTICLE_3, req({ maxChars: 50, chaptersMin: 3, chaptersMax: 3 }));
    const prompt = rewritePrompt({ ...base, violations, reserveChars: 40 });
    expect(violations).toEqual([{ kind: 'max_chars', message: '全文 56 字，要求不超过 50 字' }]);
    expect(prompt.user).toContain('<unmet_requirements note="程序按统一口径算出来的，以它为准">\n- 全文 56 字，要求不超过 50 字\n</unmet_requirements>');
    expect(prompt.user).toContain('<review_headroom note="内部预留目标，不是用户硬性上限">\n请尽量将核对前全文压缩至不超过 40 字');
    expect(prompt.user).toContain(`<user_requirements>\n${base.instructions}\n</user_requirements>`);
    expect(prompt.user).toContain(`<transcript>\n${base.transcriptText}\n</transcript>`);
    expect(prompt.user).toContain(`<draft>\n${ARTICLE_3}\n</draft>`);
  });

  it('无真实违约时如实列无；未传内部目标的既有调用不生成预留块', () => {
    const violations = checkRequirements(ARTICLE_20, req({ maxChars: 50 }));
    const prompt = rewritePrompt({ ...base, markdown: ARTICLE_20, violations, reserveChars: 40 });
    expect(violations).toEqual([]);
    expect(prompt.user).toContain('<unmet_requirements note="程序按统一口径算出来的，以它为准">\n无\n</unmet_requirements>');
    expect(prompt.system).not.toContain('没有满足用户提出的硬性要求');
    expect(rewritePrompt({ ...base, violations }).user).not.toContain('<review_headroom');
  });
});

describe('confirmRequirements', () => {
  const INSTRUCTIONS = '不超过1500字';
  const NONE = { maxChars: 0, minChars: 0, charsQuote: '', chaptersMin: 0, chaptersMax: 0, chaptersQuote: '', sectionsPerChapter: 0, sectionTitles: [], sectionsQuote: '' };
  const GOOD = { ...NONE, maxChars: 1500, charsQuote: '不超过1500字' };
  const WRONG_VALUE = { ...NONE, maxChars: 1600, charsQuote: '不超过1500字' };

  /** 按顺序返回给定结果的提取替身，记下调用次数 */
  const extractor = (...results: unknown[]) => {
    const extract = vi.fn(async () => results[Math.min(extract.mock.calls.length - 1, results.length - 1)]);
    return extract;
  };

  // 抓：第一次就能确认时还多提取几次（白白多花两次模型调用）
  it('第一次就能确认：只提取一次，采用这次的结果', async () => {
    const extract = extractor(GOOD);
    expect(await confirmRequirements(INSTRUCTIONS, extract)).toEqual({ requirements: { ...NO_REQUIREMENTS, sectionTitles: [], maxChars: 1500 }, tries: [[]] });
    expect(extract).toHaveBeenCalledTimes(1);
  });

  // 抓：第一次坏了就直接失败（不重试），或者重试之后仍采用第一次的坏结果
  it.each<[string, unknown, string]>([
    ['{}', {}, 'format:maxChars'],
    ['maxChars=1600', WRONG_VALUE, 'chars'],
  ])('第一次 %s、第二次正确：提取两次，采用第二次的上限 1500', async (_label, bad, firstDropped) => {
    const extract = extractor(bad, GOOD);
    const { requirements, tries } = await confirmRequirements(INSTRUCTIONS, extract);
    expect(requirements.maxChars).toBe(1500);
    expect(tries).toEqual([[firstDropped], []]);
    expect(extract).toHaveBeenCalledTimes(2);
  });

  // 抓：确认不了时悄悄返回"没有约束"（修复前的行为），或者重试次数不是 3
  it.each<[string, unknown, string]>([
    ['{}', {}, '没能确认生成要求里的字数、章节等硬性约束，这次生成没有保存，请换一种说法重试（提取了 3 次，模型返回的格式都无效）'],
    ['maxChars=1600', WRONG_VALUE, '没能确认生成要求里的字数、章节等硬性约束，这次生成没有保存，请换一种说法重试（提取了 3 次，字数要求仍和原话对不上）'],
  ])('三次都是 %s：恰好提取三次，抛 requirements_unconfirmed', async (_label, bad, message) => {
    const extract = extractor(bad);
    const err = await confirmRequirements(INSTRUCTIONS, extract).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    expect({ code: (err as AppError).code, message: (err as AppError).message }).toEqual({ code: 'requirements_unconfirmed', message });
    expect(extract).toHaveBeenCalledTimes(3);
  });

  // 抓：没有要求时也调用模型；或者空要求被当成"确认不了"
  it.each([[''], ['   \n ']])('要求为空（%j）：不提取，没有约束', async (instructions) => {
    const extract = extractor(GOOD);
    expect(await confirmRequirements(instructions, extract)).toEqual({ requirements: NO_REQUIREMENTS, tries: [] });
    expect(extract).not.toHaveBeenCalled();
  });

  // 抓：结构完整、全 0 全空的合法"没有可计算约束"被当成确认不了，纯风格要求的生成全部失败
  it('纯风格要求（全 0 全空）：一次通过，没有约束', async () => {
    const extract = extractor(NONE);
    expect(await confirmRequirements('写得口语一点，面向初学者', extract)).toEqual({ requirements: NO_REQUIREMENTS, tries: [[]] });
    expect(extract).toHaveBeenCalledTimes(1);
  });

  // 抓：提取请求本身失败（繁忙、账单）被吞掉后重试，或者被改成 requirements_unconfirmed，用户看不出真实原因
  it('提取调用自身抛错：原样抛出，不再重试', async () => {
    const original = new AppError('gemini_billing');
    const extract = vi.fn(async () => {
      throw original;
    });
    await expect(confirmRequirements(INSTRUCTIONS, extract)).rejects.toBe(original);
    expect(extract).toHaveBeenCalledTimes(1);
  });
});
