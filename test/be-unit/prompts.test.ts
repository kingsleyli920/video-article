import { describe, expect, it } from 'vitest';
import { parseArticle } from '../../src/shared/article';
import { articlePrompt, summaryPrompt } from '../../src/worker/prompts';

const video = { id: 'abc', title: '标题', channel: '频道', description: '本期主持人 Alex Chen', lengthSeconds: 600 };

/** 从系统提示词里取出"人物身份与发言归属"整段规则（到下一个空行为止） */
function speakerRules(system: string): string {
  const start = system.indexOf('人物身份与发言归属：');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = system.indexOf('\n\n', start);
  return system.slice(start, end === -1 ? undefined : end);
}

describe('5W1H 提示词', () => {
  // 抓：5W1H 只写"按同一套规则"，模型实际看不到规则，于是凭外部知识补出主持人姓名
  it('系统提示词带上与文章生成完全相同的人物身份与发言归属规则全文，并对 who 字段单独约束', () => {
    const article = articlePrompt({ video, transcriptText: '[00:00] hi', instructions: '' });
    const chapter = parseArticle('# 标题\n\n## 第一章\n\n正文').chapters[0]!;
    const summary = summaryPrompt({ video, transcriptText: '[00:00] hi', instructions: '', chapterTitles: ['第一章'], chapter });

    const rules = speakerRules(article.system);
    expect(rules.split('\n').length).toBeGreaterThan(5);
    expect(speakerRules(summary.system)).toBe(rules);
    expect(summary.system).not.toContain('同一套规则');
    expect(summary.system).toContain('who 字段同样遵守上面的人物规则：写出的每个人名都要有字幕或本期元数据里的依据，不写字幕和本期元数据里都没有出现过的人名');
    // 补全姓名的规则依赖简介，5W1H 的用户消息里也要带上本期简介
    expect(summary.user).toContain('本期主持人 Alex Chen');
  });

  // 抓：输入里残缺数字换成了占位，提示词却还在说旧的标注，模型不知道占位是什么意思
  it('文章和 5W1H 的系统提示词都说明残缺数字占位的含义，5W1H 以字幕为准', () => {
    const article = articlePrompt({ video, transcriptText: '[00:00] hi', instructions: '' });
    const chapter = parseArticle('# 标题\n\n## 第一章\n\n正文').chapters[0]!;
    const summary = summaryPrompt({ video, transcriptText: '[00:00] hi', instructions: '', chapterTitles: ['第一章'], chapter });
    for (const system of [article.system, summary.system]) {
      expect(system).toContain('〔字幕此处数字不清，无法确定具体数量〕');
      expect(system).not.toContain('〔字幕数字残缺〕');
    }
    expect(summary.system).toContain('当前章节里即使给出了这里的具体数字，也以字幕为准');
  });
});

describe('文章提示词的篇幅规则', () => {
  // 补充验收 V08 抓：目标仍是"上限的九成"，术语和数字多的文章按统一口径超出上限（1,695 / 1,500）；或者计字口径从提示词里丢了
  it('给了上限时按七成分配初稿，为核对补回限定留空间，并保持硬上限与统一计字', () => {
    const { system } = articlePrompt({ video, transcriptText: '[00:00] hi', instructions: '最多1500字' });
    expect(system).toContain('文章标题和正文的所有非空白字符都算一个字，中文、英文、数字、标点都计入');
    expect(system).toContain('用户给了字数上限时，绝不能超过上限：动笔前先按上限的七成左右给各章分配篇幅，为核对补回来源和条件留空间');
    expect(system).toContain('英文术语、数字和标点同样计字');
    expect(system).not.toContain('九成');
  });
});
