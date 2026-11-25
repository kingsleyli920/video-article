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
});
